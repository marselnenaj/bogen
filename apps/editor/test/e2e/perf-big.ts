/**
 * A big file end to end: load into the editor, first canvas paint, a remote html_write until it shows, and memory.
 * A real server from source in a temp copy of the fixture's data folder, on a spare port, and a real Chromium.
 *   npx tsx scripts/gen-perf-fixture.ts /tmp/bogen-perf
 *   BOGEN_EDITOR_DIR=apps/editor/dist npx tsx apps/editor/test/e2e/perf-big.ts /tmp/bogen-perf
 * PERF_RUNS (3) cold loads, PERF_WRITES (12) writes, PERF_THROTTLE (1) CPU slowdown, PERF_PROFILE=mount|write (by function),
 * PERF_TRACE=mount|write (by trace event, native work included).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Browser, Page } from 'puppeteer-core';
import { BogenDoc, Y } from '@bogen/core';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';

const round = (n: number) => Math.round(n * 10) / 10;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
const p95 = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0; };

/** Resident memory of the server: node running cli.ts in its process group, not npx and not the Chromium it renders with. */
function serverRssMb(pgid: number): number {
  let best = 0;
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== pgid || !readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('cli.ts')) continue;
      const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (rss) best = Math.max(best, Number(rss[1]) / 1024);
    } catch { /* gone */ }
  }
  return round(best);
}

/** With PERF_TRACE=mount or write: where the main thread's time went, by trace event, the native work included. */
async function traced<T>(page: Page, stage: string, run: () => Promise<T>): Promise<T> {
  if (process.env.PERF_TRACE !== stage) return run();
  await page.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc'] });
  const out = await run();
  const raw = await page.tracing.stop();
  const events = (JSON.parse(new TextDecoder().decode(raw)) as { traceEvents: { name: string; ph: string; dur?: number; tid: number; pid: number; args?: { name?: string } }[] }).traceEvents;
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const total = new Map<string, number>();
  for (const e of events) if (main && e.tid === main.tid && e.pid === main.pid && e.ph === 'X' && e.dur) total.set(e.name, (total.get(e.name) ?? 0) + e.dur / 1000);
  console.error([...total].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
  return out;
}

async function profiled<T>(page: Page, stage: string, run: () => Promise<T>): Promise<T> {
  if (process.env.PERF_TRACE === stage) return traced(page, stage, run);
  if (process.env.PERF_PROFILE !== stage) return run();
  const cdp = await page.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const out = await run();
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map<string, number>();
  const dt = profile.timeDeltas ?? [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  (profile.samples ?? []).forEach((id, i) => {
    const n = byId.get(id)!;
    const name = `${n.callFrame.functionName || '(anon)'} @${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    self.set(name, (self.get(name) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.error([...self].sort((x, y) => y[1] - x[1]).slice(0, 35).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
  // With PERF_INCLUSIVE: time per function with what it called, which shows the subsystems.
  if (process.env.PERF_INCLUSIVE) {
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const incl = new Map<string, number>();
    (profile.samples ?? []).forEach((id, i) => {
      const seen = new Set<string>();
      for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
        const f = byId.get(cur)!.callFrame;
        const name = `${f.functionName || '(anon)'} @${f.url.split('/').pop()}:${f.lineNumber}`;
        if (seen.has(name)) continue;
        seen.add(name);
        incl.set(name, (incl.get(name) ?? 0) + (dt[i] ?? 0) / 1000);
      }
    });
    console.error([...incl].sort((x, y) => y[1] - x[1]).slice(0, 60).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
  }
  // PERF_CALLERS=<function>: the call stacks that time in that function came from.
  const target = process.env.PERF_CALLERS;
  if (target) {
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const stacks = new Map<string, number>();
    (profile.samples ?? []).forEach((id, i) => {
      if (byId.get(id)!.callFrame.functionName !== target) return;
      const names: string[] = [];
      for (let cur: number | undefined = parent.get(id); cur !== undefined && names.length < 12; cur = parent.get(cur)) names.push(byId.get(cur)!.callFrame.functionName || '(anon)');
      const key = names.join(' < ');
      stacks.set(key, (stacks.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    console.error([...stacks].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
  }
  return out;
}

interface Load { firstPaintMs: number; loadMs: number; layers: number; heapMb: number; domNodes: number; /** Of the load, in the tab's main thread. */ scriptMs: number; styleMs: number; layoutMs: number; appReadyMs: number }

/** A cold tab: from navigation start to the first layer painted, and to every layer of the page in the DOM and painted. */
async function load(browser: Browser, base: string, fileId: string, pageId: string, expected: number): Promise<{ page: Page; result: Load }> {
  const page = await freshPage(browser);
  const throttle = Number(process.env.PERF_THROTTLE ?? 1);
  if (throttle > 1) await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.evaluateOnNewDocument((fid: string, pid: string) => {
    try { localStorage.setItem(`bogen-page-${fid}`, pid); } catch { /* fine */ }
    const w = window as unknown as { __firstLayer: number };
    w.__firstLayer = 0;
    new MutationObserver((_, obs) => {
      if (w.__firstLayer || !document.querySelector('.bogen-world [data-bogen-id]')) return;
      obs.disconnect();
      // Painted: the frame after the one it was added in.
      requestAnimationFrame(() => requestAnimationFrame(() => { w.__firstLayer = performance.now(); }));
    }).observe(document, { childList: true, subtree: true });
  }, fileId, pageId);
  const result = await profiled(page, 'mount', async () => {
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForFunction((n: number) => document.querySelectorAll('.bogen-world [data-bogen-id]').length >= n, { timeout: 180000, polling: 50 }, expected);
    const loadMs = await page.evaluate(() => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now())))));
    const firstPaintMs = await page.evaluate(() => (window as unknown as { __firstLayer: number }).__firstLayer);
    const layers = await page.evaluate(() => document.querySelectorAll('.bogen-world [data-bogen-id]').length);
    const appReadyMs = await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.loadEventEnd ?? 0);
    const m = await page.metrics();
    const ms = (v: number | undefined) => round((v ?? 0) * 1000);
    return { firstPaintMs: round(firstPaintMs), loadMs: round(loadMs), layers, heapMb: 0, domNodes: 0, scriptMs: ms(m.ScriptDuration), styleMs: ms(m.RecalcStyleDuration), layoutMs: ms(m.LayoutDuration), appReadyMs: round(appReadyMs) };
  });
  await sleep(1500);
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.collectGarbage');
  const m = await page.metrics();
  result.heapMb = round((m.JSHeapUsedSize ?? 0) / 1048576);
  result.domNodes = m.Nodes ?? 0;
  return { page, result };
}

/** An agent over MCP writes a section; from sending the call to its text being painted in the open editor. */
type Split = { script: number; style: number; layout: number; task: number };
async function writes(page: Page, base: string, boardId: string, count: number): Promise<{ callMs: number[]; visibleMs: number[]; split: Split[]; tools: Record<string, number> }> {
  const client = new Client({ name: 'perf-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const callMs: number[] = [];
  const visibleMs: number[] = [];
  const split: Split[] = [];
  await call(client, 'file_list', {});
  for (let i = 0; i < count; i++) {
    const marker = `Remote write ${i} ${Date.now()}`;
    await page.evaluate((text: string) => {
      const w = window as unknown as { __seen: number };
      w.__seen = 0;
      // Only what was added is looked at: a query over the whole page would cost more than the write.
      new MutationObserver((records, obs) => {
        const hit = records.some((r) => [...r.addedNodes].some((n) => n.textContent?.includes(text)));
        if (!hit) return;
        obs.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => { w.__seen = performance.timeOrigin + performance.now(); }));
      }).observe(document.querySelector('.bogen-world')!, { childList: true, subtree: true, characterData: true });
    }, marker);
    const before = await page.metrics();
    await profiled(page, 'write', async () => {
      const t0 = Date.now();
      await call(client, 'html_write', { target_id: boardId, html: `<section style="display:flex;gap:16px;padding:32px 64px"><h2 style="margin:0;font:700 28px Inter">${marker}</h2><p style="margin:0;font:400 15px Inter">A line under it, with a <a href="#">link</a>.</p><x-instance component="Button" prop-label="Write ${i}"></x-instance></section>` });
      callMs.push(Date.now() - t0);
      await page.waitForFunction(() => (window as unknown as { __seen: number }).__seen > 0, { timeout: 30000, polling: 'raf' });
      visibleMs.push(round((await page.evaluate(() => (window as unknown as { __seen: number }).__seen)) - t0));
    });
    const after = await page.metrics();
    const d = (k: 'ScriptDuration' | 'RecalcStyleDuration' | 'LayoutDuration' | 'TaskDuration') => round(((after[k] ?? 0) - (before[k] ?? 0)) * 1000);
    split.push({ script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration'), task: d('TaskDuration') });
    await sleep(150);
  }
  // What an agent reads back on a big page, timed in the same session.
  const timed = async (name: string, args: Record<string, unknown>) => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await call(client, name, args);
      runs.push(Date.now() - t);
    }
    return median(runs);
  };
  const tools = {
    layerTreeMs: await timed('layer_tree', {}),
    designLintPageMs: await timed('design_lint', {}),
    screenshotArtboardMs: await timed('canvas_screenshot', { node_id: boardId }),
  };
  await client.close();
  return { callMs, visibleMs, split, tools };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function cli(): Promise<void> {
  const home = process.argv[2];
  if (!home) throw new Error('Usage: perf-big.ts <fixture data folder from scripts/gen-perf-fixture.ts>');
  const fileId = JSON.parse(readFileSync(join(home, 'index.json'), 'utf8')).files[0].id as string;
  const y = new Y.Doc();
  Y.applyUpdate(y, new Uint8Array(readFileSync(join(home, 'files', `${fileId}.ydoc`))));
  const doc = new BogenDoc(y);
  const pageId = doc.getPages()[0]!.id;
  let rendered = 0;
  let stored = 0;
  const walk = (id: string) => { for (const k of doc.getChildren(id)) { rendered++; walk(k.id); } };
  const walkStored = (id: string) => { for (const k of doc.rawKids(id)) { stored++; walkStored(k); } };
  walk(pageId);
  walkStored(pageId);
  const boards = doc.getChildren(pageId);
  const board = boards.at(-1)!.id;

  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR, homeFrom: home });
  let browser: Browser | null = null;
  try {
    const rssIdle = serverRssMb(server.pid);
    browser = await launch(server.port);
    const loads: Load[] = [];
    let last: Page | null = null;
    for (let i = 0; i < Number(process.env.PERF_RUNS ?? 3); i++) {
      await last?.close();
      const { page, result } = await load(browser, server.base, fileId, pageId, Math.floor(rendered * 0.98));
      loads.push(result);
      last = page;
    }
    const rssOpen = serverRssMb(server.pid);
    const w = await writes(last!, server.base, board, Number(process.env.PERF_WRITES ?? 12));
    const rssAfter = serverRssMb(server.pid);
    const cdp = await last!.createCDPSession();
    await cdp.send('HeapProfiler.collectGarbage');
    const after = await last!.metrics();
    console.log(JSON.stringify({
      fixture: { stored, rendered, artboards: boards.length, throttle: Number(process.env.PERF_THROTTLE ?? 1) },
      load: { firstPaintMs: median(loads.map((l) => l.firstPaintMs)), loadMs: median(loads.map((l) => l.loadMs)), runs: loads },
      write: { callMedianMs: median(w.callMs), visibleMedianMs: median(w.visibleMs), visibleP95Ms: p95(w.visibleMs), callMs: w.callMs, visibleMs: w.visibleMs, tabMainThread: w.split },
      tools: w.tools,
      memory: { tabHeapMb: median(loads.map((l) => l.heapMb)), tabHeapAfterWritesMb: round((after.JSHeapUsedSize ?? 0) / 1048576), domNodes: loads[0]!.domNodes, serverRssIdleMb: rssIdle, serverRssOpenMb: rssOpen, serverRssAfterWritesMb: rssAfter },
    }, null, 1));
  } finally {
    await browser?.close();
    await server.close();
  }
}

if (process.argv[1]?.endsWith('perf-big.ts')) void cli().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
