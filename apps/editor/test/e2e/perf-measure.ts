/**
 * Measures a big real document through a real browser: initial mount, pan, selection and the layer
 * tree while an agent writes a lot. Usable alone, against any build:
 *   BOGEN_EDITOR_DIR=<dist> npx tsx apps/editor/test/e2e/perf-measure.ts <file.ydoc> <pageId>
 */
import { readFileSync } from 'node:fs';
import type { Browser, Page } from 'puppeteer-core';
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { BogenDoc, Y } from '@bogen/core';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';

export interface PerfResult { layers: number; mountMs: number; panFrameAvg: number; panFrameP95: number; panScriptMs: number; selectMs: number; selectP95: number; agentTx: number; agentFrameAvg: number; agentFrameP95: number; agentLongestMs: number; agentSettleMs: number; agentScriptMs: number }

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** With PERF_PROFILE=pan or agent or select: where the time of that stage went, by function. */
async function profiled(page: Page, stage: string, run: () => Promise<void>): Promise<void> {
  if (process.env.PERF_PROFILE !== stage) return run();
  const cdp = await page.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await run();
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map<string, number>();
  const dt = profile.timeDeltas ?? [];
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  (profile.samples ?? []).forEach((id, i) => {
    const n = byId.get(id)!;
    const name = `${n.callFrame.functionName || '(anon)'} @${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    self.set(name, (self.get(name) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.error([...self].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n'));
  return undefined;
}

async function frames(page: Page, run: () => Promise<void>): Promise<{ avg: number; p95: number; longest: number; scriptMs: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const before = await page.metrics();
  await run();
  const after = await page.metrics();
  const list = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
  const avg = list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
  if (process.env.PERF_METRICS) console.error(`style ${(((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000).toFixed(0)} layout ${(((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000).toFixed(0)} task ${(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000).toFixed(0)} script ${(((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000).toFixed(0)} frames ${list.length}`);
  return { avg: round(avg), p95: round(percentile(list, 0.95)), longest: round(Math.max(0, ...list)), scriptMs: round(((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000) };
}

export async function measureFile(browser: Browser, base: string, fileId: string, pageId: string, layers: number): Promise<PerfResult> {
  // Initial mount: a cold page, from navigation until every layer of the page is in the DOM and painted.
  const page = await freshPage(browser);
  // A laptop on battery, rather than this machine: differences show, and budgets mean something.
  const throttle = Number(process.env.PERF_THROTTLE ?? 4);
  if (throttle > 1) await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.evaluateOnNewDocument((fid: string, pid: string) => { try { localStorage.setItem(`bogen-page-${fid}`, pid); } catch { /* fine */ } }, fileId, pageId);
  const t0 = Date.now();
  await profiled(page, 'mount', async () => {
    await page.goto(`${base}/#/file/${fileId}`);
    await page.waitForFunction((n: number) => document.querySelectorAll('.bogen-world [data-bogen-id]').length >= n, { timeout: 120000, polling: 50 }, Math.floor(layers * 0.9));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  });
  const mountMs = Date.now() - t0;
  await sleep(800);

  // Pan with the middle mouse button.
  const box = await page.$eval('[data-testid="canvas"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const pan = await frames(page, () => profiled(page, 'pan', async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'middle' });
    for (let i = 0; i < 90; i++) await page.mouse.move(cx + Math.sin(i / 10) * 160, cy + Math.cos(i / 10) * 120);
    await page.mouse.up({ button: 'middle' });
  }));
  await sleep(300);

  // Selection: from the press on a layer to the frame the selection box is painted in.
  const latencies: number[] = [];
  await profiled(page, 'select', async () => { for (let i = 0; i < 14; i++) {
    const x = box.x + box.w * (0.25 + 0.04 * i);
    const y = box.y + box.h * (0.3 + 0.03 * (i % 7));
    await page.mouse.move(x, y);
    await page.evaluate(() => {
      const w = window as unknown as { __press: number; __lat: number };
      w.__lat = 0;
      window.addEventListener('pointerdown', () => {
        const t = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => { w.__lat = performance.now() - t; }));
      }, { once: true, capture: true });
    });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => (window as unknown as { __lat: number }).__lat > 0, { polling: 'raf' });
    latencies.push(await page.evaluate(() => (window as unknown as { __lat: number }).__lat));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await sleep(60);
  } });

  // An agent writing a lot: a sync peer inserting and restyling, as fast as an agent's batches arrive.
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
  await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
  const doc = new BogenDoc(y);
  const top = doc.getChildren(pageId);
  const target = top[0]!.id;
  const AGENT_TX = 400;
  const before = await page.$$eval('[data-testid="layer-row"]', (e) => e.length);
  let lastInsert = '';
  const agent = await frames(page, () => profiled(page, 'agent', async () => {
    for (let i = 0; i < AGENT_TX; i++) {
      doc.transact(() => {
        lastInsert = doc.insert(target, { type: 'frame', name: `Agent ${i}`, style: { position: 'absolute', left: `${i * 2}px`, top: `${i}px`, width: '40px', height: '40px', backgroundColor: '#123456' } });
        doc.updateStyle(top[1 % top.length]!.id, { opacity: String(0.9 + (i % 10) / 100) });
      }, 'agent:perf');
      if (i % 4 === 3) await sleep(10);
    }
    const last = lastInsert;
    await page.waitForFunction((id: string) => document.querySelector(`.bogen-world [data-bogen-id="${id}"]`) !== null, { timeout: 60000, polling: 50 }, last);
  }));
  const t1 = Date.now();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const settle = Date.now() - t1;
  void before;
  provider.destroy();
  y.destroy();
  await page.close();
  return {
    layers, mountMs,
    panFrameAvg: pan.avg, panFrameP95: pan.p95, panScriptMs: pan.scriptMs,
    selectMs: round(latencies.reduce((a, b) => a + b, 0) / latencies.length), selectP95: round(percentile(latencies, 0.95)),
    agentTx: AGENT_TX, agentFrameAvg: agent.avg, agentFrameP95: agent.p95, agentLongestMs: agent.longest, agentSettleMs: settle, agentScriptMs: agent.scriptMs,
  };
}

async function cli(): Promise<void> {
  const [path, pageId] = process.argv.slice(2);
  if (!path || !pageId) throw new Error('Usage: perf-measure.ts <file.ydoc> <pageId>');
  const y = new Y.Doc();
  Y.applyUpdate(y, new Uint8Array(readFileSync(path)));
  const doc = new BogenDoc(y);
  let layers = 0;
  const walk = (id: string) => { for (const k of doc.getChildren(id)) { layers++; walk(k.id); } };
  walk(pageId);
  const fileId = 'perfdoc00a';
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR, seed: [{ id: fileId, name: 'Perf', ydocPath: path }] });
  let browser: Browser | null = null;
  try {
    browser = await launch();
    const runs: PerfResult[] = [];
    const n = Number(process.env.PERF_RUNS ?? 1);
    for (let i = 0; i < n; i++) runs.push(await measureFile(browser, server.base, fileId, pageId, layers));
    console.log(JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 1));
  } finally {
    await browser?.close();
    await server.close();
  }
}

if (process.argv[1]?.endsWith('perf-measure.ts')) void cli().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
