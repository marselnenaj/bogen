/**
 * Memory with big files open as tabs: copies of the three biggest files of a Bogen data folder (read only, into a
 * temporary BOGEN_HOME), opened one after the other in tabs, then the tabs left behind put to sleep.
 * Prints the renderer's JS heap after a garbage collection, and the resident memory of Chromium's renderers.
 *
 *   (cd apps/editor && npx vite build)
 *   BOGEN_MEASURE_FROM=~/.local/share/bogen node --import tsx apps/editor/test/e2e/file-tabs-memory.ts
 */
import { readdirSync, readFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { freshPage, launch } from './craft-harness.ts';

const from = process.env.BOGEN_MEASURE_FROM;
if (!from) throw new Error('Set BOGEN_MEASURE_FROM to a Bogen data folder.');
const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-tabs-memory-'));
const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port));

const biggest = readdirSync(join(from, 'files')).filter((f) => f.endsWith('.ydoc')).map((f) => ({ f, size: statSync(join(from, 'files', f)).size })).sort((a, b) => b.size - a.size).slice(0, 3);
const ids: { id: string; mb: number }[] = [];
for (const [i, { f, size }] of biggest.entries()) {
  const id = f.replace(/\.ydoc$/, '');
  await server.storage.writeDoc(id, new Uint8Array(readFileSync(join(from, 'files', f))));
  server.storage.create(`Big file ${i + 1}`, id);
  ids.push({ id, mb: Math.round(size / 1e5) / 10 });
}

function rendererRssMb(): number {
  const pid = browser.process()?.pid;
  if (!pid) return NaN;
  let total = 0;
  for (const p of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8');
      if (!cmd.includes('--type=renderer')) continue;
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${p}/status`, 'utf8'))?.[1];
      if (rss) total += Number(rss);
    } catch { /* gone */ }
  }
  return Math.round(total / 1024);
}

async function measure(page: Page, label: string): Promise<void> {
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Performance.enable');
  const m = await cdp.send('Performance.getMetrics');
  const heap = m.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0;
  const awake = await page.evaluate(() => (window as unknown as { __bogenTabs: { parkedFiles: () => string[] } }).__bogenTabs.parkedFiles().length);
  console.log(`${label.padEnd(44)} JS heap ${String(Math.round(heap / 1048576)).padStart(5)} MB   renderer RSS ${String(rendererRssMb()).padStart(5)} MB   tabs awake behind: ${awake}`);
  await cdp.detach();
}

const ready = (page: Page, id: string) => page.waitForFunction((f) => location.hash.startsWith(`#/file/${f}`) && Boolean(document.querySelector('[data-testid="editor"]')) && !document.querySelector('[data-testid="loading"]'), { timeout: 240_000, polling: 200 }, id);

try {
  const page = await freshPage(browser);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${base}/#/`);
  await page.waitForSelector('[data-testid="home"]');
  console.log(`files: ${ids.map((f) => `${f.id} (${f.mb} MB)`).join(', ')}`);
  await measure(page, 'Home, nothing open');
  for (const [i, f] of ids.entries()) {
    const t0 = Date.now();
    await page.evaluate((id) => { location.hash = `#/file/${id}`; }, f.id);
    await ready(page, f.id);
    await new Promise((r) => setTimeout(r, 3000));
    await measure(page, `${i + 1} tab${i ? 's' : ''} open (opened in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  // Back to the first: awake, so instant.
  const t1 = Date.now();
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, ids[1]!.id);
  await ready(page, ids[1]!.id);
  console.log(`back to tab 2 (awake): ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  await page.evaluate(() => (window as unknown as { __bogenTabs: { sleepAll: () => void } }).__bogenTabs.sleepAll());
  await new Promise((r) => setTimeout(r, 2000));
  await measure(page, 'the tabs behind put to sleep');
  const t2 = Date.now();
  await page.evaluate((id) => { location.hash = `#/file/${id}`; }, ids[0]!.id);
  await ready(page, ids[0]!.id);
  console.log(`back to tab 1 (asleep, loads again): ${((Date.now() - t2) / 1000).toFixed(1)} s`);
} finally {
  await browser.close();
  await server.close();
}
