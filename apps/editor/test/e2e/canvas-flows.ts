/**
 * Canvas flows: a page's organisation (section frames and titles, lane titles, connections between screens) stays
 * clean at every zoom. At each tested zoom, in dark and light: no label that is shown overlaps another label, a
 * screen, a screen's name or a section title, and no connection runs across a screen that is not one of its ends.
 * On a page of 120 screens it measures what a frame of zooming costs.
 *
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/canvas-flows.ts
 * FLOWS_SHOTS=<folder> also saves a capture of every zoom. FLOWS_HOME=<a copy of a data folder, never the live one>
 * with FLOWS_PAGES=<file>:<page>,... runs the same checks on real files, FLOWS_PERF=<file>:<page> times one of them.
 * FLOWS_ZOOMS and FLOWS_THEMES narrow the run; FLOWS_DUMP=<folder> saves each page's screens and connections.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket as NodeWs } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { applyCanvasPlan, BogenDoc, prepareCanvasPlan, readCanvasPlan, Y, type CanvasConnection, type CanvasSection } from '@bogen/core';
import type { Page } from 'puppeteer-core';
import { freshPage, launch, sleep, startRealServer, type RealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

const ZOOMS = process.env.FLOWS_ZOOMS ? process.env.FLOWS_ZOOMS.split(',').map(Number) : [0.08, 0.15, 0.3, 0.6, 1];
const THEMES = (process.env.FLOWS_THEMES ? process.env.FLOWS_THEMES.split(',') : ['dark', 'light']) as ('dark' | 'light')[];
type Box = { x: number; y: number; w: number; h: number };
type Target = { file: string; page: string; name: string; connections: CanvasConnection[] };

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 900)}` : ''}`);
};

async function connect(server: RealServer, id: string): Promise<{ doc: BogenDoc; close: () => void }> {
  const y = new Y.Doc();
  const provider = new WebsocketProvider(`${server.base.replace('http', 'ws')}/sync`, id, y, { WebSocketPolyfill: NodeWs as never, disableBc: true });
  provider.awareness.setLocalState(null);
  await new Promise<void>((ok) => provider.on('sync', (s: boolean) => { if (s) ok(); }));
  return { doc: new BogenDoc(y), close: () => provider.destroy() };
}

function screen(doc: BogenDoc, page: string, name: string, w: number, h: number): string {
  const id = doc.insert(page, { type: 'frame', name, artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: `${w}px`, height: `${h}px`, backgroundColor: '#ffffff', overflow: 'hidden' } } as never);
  doc.insert(id, { type: 'text', name: 'Title', text: name, style: { fontSize: '28px', color: '#111111', padding: '24px' } } as never);
  return id;
}

/** Phones in rows, a wrapped lane, desktops; neighbours, a step that skips a screen, a step back, row to row. */
function buildFlows(doc: BogenDoc, page: string): void {
  const phones = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => screen(doc, page, `${prefix} ${i + 1}`, 390, 844));
  const invite = phones('Invitation', 4); const account = phones('Account', 4); const feed = phones('Feed', 6);
  const admin = [screen(doc, page, 'Admin overview', 1440, 900), screen(doc, page, 'Admin members', 1440, 900)];
  const sections: CanvasSection[] = [
    { id: 'join', title: 'Joining a community', purpose: 'From an invitation link to the first community, for someone who has never used the app before.', lanes: [{ title: 'Invitation', node_ids: invite }, { title: 'Account and profile', node_ids: account }] },
    { id: 'daily', title: 'Daily use', purpose: 'Reading, posting and answering, the screens people come back to.', lanes: [{ title: 'Feed and threads', node_ids: feed }] },
    { id: 'admin', title: 'Administration', purpose: 'For the person who runs the community.', lanes: [{ title: 'Desktop', node_ids: admin }] },
  ];
  const c = (a: string, b: string, label: string): CanvasConnection => ({ from: a, to: b, label });
  const connections = [
    c(invite[0]!, invite[1]!, 'Open the invitation'), c(invite[1]!, invite[2]!, 'Check it'), c(invite[2]!, invite[1]!, 'Back'),
    c(invite[2]!, invite[3]!, 'Join the community and pick a name for yourself'), c(invite[0]!, invite[2]!, 'Skip when signed in'),
    c(invite[3]!, account[0]!, 'Create the account'), c(account[0]!, account[1]!, 'Continue'), c(account[1]!, account[3]!, 'Skip the photo'),
    c(account[3]!, feed[0]!, 'Done'), c(feed[0]!, feed[1]!, 'Open a thread'), c(feed[2]!, feed[3]!, 'Next page'), c(feed[0]!, feed[5]!, 'Jump to settings'),
    c(feed[5]!, admin[0]!, 'Open on desktop'), c(admin[0]!, admin[1]!, 'Members'),
  ];
  const prepared = prepareCanvasPlan(doc, page, { sections, connections, expected_revision: 0, columns: 4 });
  applyCanvasPlan(doc, page, prepared);
  // The daily lane wraps after three screens, as a narrower plan does.
  const wrapped = prepareCanvasPlan(doc, page, { sections, connections, expected_revision: 1, expected_revision_id: readCanvasPlan(doc, page).revision_id, columns: 3 });
  applyCanvasPlan(doc, page, wrapped);
}

/** 120 screens in six lanes of twenty, with sixty connections, for the cost of a frame. */
function buildLarge(doc: BogenDoc, page: string): void {
  const lanes = Array.from({ length: 6 }, (_, l) => ({ title: `Lane ${l + 1}`, node_ids: Array.from({ length: 20 }, (_, i) => screen(doc, page, `Screen ${l + 1}.${i + 1}`, 390, 844)) }));
  const sections: CanvasSection[] = [0, 1, 2].map((s) => ({ id: `s${s}`, title: `Section ${s + 1}`, purpose: 'Many screens, to see what a frame costs.', lanes: lanes.slice(s * 2, s * 2 + 2) }));
  const connections = lanes.flatMap((l) => Array.from({ length: 10 }, (_, i) => ({ from: l.node_ids[i * 2]!, to: l.node_ids[i * 2 + 1]!, label: `Step ${i + 1}` })));
  applyCanvasPlan(doc, page, prepareCanvasPlan(doc, page, { sections, connections, expected_revision: 0, columns: 6, max_row_width: 30_000 }));
}

async function open(page: Page, base: string, t: Target, theme: string, view?: { x: number; y: number; z: number }): Promise<void> {
  await page.goto(`${base}/#/`);
  await page.evaluate((key: string, theme: string, view: string | null) => {
    localStorage.setItem('bogen-language', 'en');
    localStorage.setItem('bogen-settings', JSON.stringify({ appearance: theme }));
    if (view) localStorage.setItem(key, view); else localStorage.removeItem(key);
  }, `bogen-view-${t.file}-${t.page}`, theme, view ? JSON.stringify(view) : null);
  await page.goto(`${base}/#/file/${t.file}?page=${t.page}`);
  await page.reload();
  await page.waitForSelector('[data-testid="canvas"] [data-testid="canvas-section"]', { timeout: 30000 });
  await sleep(1200);
  // Screens that hug their content take their real height once loaded or previewed; wait until the frames settle.
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await page.$$eval('[data-testid="canvas-section"]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }).join());
    if (now === last) break;
    last = now; await sleep(500);
  }
  await sleep(400);
}

/** The camera as the world element shows it, and every screen of the page in world coordinates. */
async function worldOf(page: Page): Promise<{ canvas: Box; boxes: Record<string, Box>; frames: Box[] }> {
  return page.evaluate(() => {
    const world = document.querySelector('.bogen-world') as HTMLElement;
    const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(world.style.transform)!;
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const c = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const l of document.querySelectorAll('[data-frame-label]')) {
      const id = l.getAttribute('data-frame-label')!;
      const r = document.querySelector(`.bogen-world [data-bogen-id="${id}"]`)?.getBoundingClientRect();
      if (r) boxes[id] = { x: (r.left - c.left - x) / z, y: (r.top - c.top - y) / z, w: r.width / z, h: r.height / z };
    }
    const frames = [...document.querySelectorAll('[data-testid="canvas-section"]')].map((f) => { const r = f.getBoundingClientRect(); return { x: (r.left - c.left - x) / z, y: (r.top - c.top - y) / z, w: r.width / z, h: r.height / z }; });
    return { canvas: { x: c.left, y: c.top, w: c.width, h: c.height }, boxes, frames };
  });
}

const union = (bs: Box[]): Box => {
  const x = Math.min(...bs.map((b) => b.x)); const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
};

/** Far out, the whole plan; close in, the stretch of the flow with the most connections. */
function viewFor(z: number, canvas: Box, boxes: Record<string, Box>, t: Target): { x: number; y: number; z: number } {
  const all = Object.values(boxes);
  let focus = union(all);
  if (z >= 0.6 && t.connections.length) {
    // Close in: the two nearest screens a connection joins, and the gap between them.
    const gap = (c: CanvasConnection) => { const a = boxes[c.from]; const b = boxes[c.to]; return a && b ? Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h)) : Infinity; };
    const c = [...t.connections].sort((p, q) => gap(p) - gap(q))[0]!;
    if (boxes[c.from] && boxes[c.to]) focus = union([boxes[c.from]!, boxes[c.to]!]);
  } else if (z >= 0.3 && t.connections.length) {
    const ends = t.connections.flatMap((c) => [boxes[c.from], boxes[c.to]].filter((b): b is Box => !!b));
    const busiest = ends.map((b) => ({ b, n: ends.filter((o) => Math.hypot(o.x - b.x, o.y - b.y) < 1400).length })).sort((a, b) => b.n - a.n)[0];
    if (busiest) focus = union(ends.filter((o) => Math.hypot(o.x - busiest.b.x, o.y - busiest.b.y) < 1400));
  }
  const cx = focus.x + focus.w / 2; const cy = focus.y + focus.h / 2;
  return { x: canvas.w / 2 - cx * z, y: canvas.h / 2 - cy * z, z };
}

interface Report { shown: number; hidden: number; overlaps: string[]; crossings: string[]; names: string[] }

/** Everything measured on the screen, as a person sees it. */
async function inspect(page: Page, t: Target): Promise<Report> {
  return page.evaluate((conns: { from: string; to: string; label: string }[]) => {
    const c = document.querySelector('[data-testid="canvas"]')!.getBoundingClientRect();
    const shown = (el: Element) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      let o = 1;
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o >= 0.5;
    };
    type R = { x: number; y: number; w: number; h: number; what: string };
    const rect = (el: Element, what: string): R => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, what }; };
    const visible = (r: R) => r.w > 0 && r.h > 0 && r.x < c.right && r.x + r.w > c.left && r.y < c.bottom && r.y + r.h > c.top;
    const hit = (a: R, b: R) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
    const screens: (R & { id: string })[] = [];
    const names: R[] = [];
    for (const l of document.querySelectorAll('[data-frame-label]')) {
      const id = l.getAttribute('data-frame-label')!;
      const el = document.querySelector(`.bogen-world [data-bogen-id="${id}"]`);
      if (!el) continue;
      screens.push({ ...rect(el, `screen ${l.textContent}`), id });
      if (shown(l)) names.push(rect(l, `name ${l.textContent}`));
    }
    const sectionTitles = [...document.querySelectorAll('.canvas-section-title')].filter(shown).map((e) => rect(e, `section ${e.querySelector('strong')?.textContent}`)).filter(visible);
    const laneTitles = [...document.querySelectorAll('.canvas-lane-title span')].filter(shown).map((e) => rect(e, `lane ${e.textContent}`)).filter(visible);
    const flowEls = [...document.querySelectorAll('.canvas-flow-label, .canvas-connections text')];
    const flowLabels = flowEls.filter(shown).map((e) => rect(e, `label ${e.textContent}`)).filter((r) => visible(r) && r.w > 0);
    const overlaps: string[] = [];
    const against = (list: R[], others: R[], same: boolean) => list.forEach((a, i) => others.forEach((b, j) => { if ((!same || j > i) && hit(a, b)) overlaps.push(`${a.what} / ${b.what}`); }));
    against(flowLabels, flowLabels, true); against(flowLabels, [...laneTitles, ...sectionTitles, ...names, ...screens], false);
    against(laneTitles, laneTitles, true); against(laneTitles, [...sectionTitles, ...names, ...screens], false);
    against(sectionTitles, sectionTitles, true); against(sectionTitles, [...names, ...screens], false);
    // Routes: sample each path on the screen and look for a point inside a screen that is not one of its ends.
    let paths = [...document.querySelectorAll<SVGPathElement>('.canvas-connections path[data-route]')];
    if (!paths.length) paths = [...document.querySelectorAll<SVGPathElement>('.canvas-connections g > g > path')];
    const crossings: string[] = [];
    const throughNames = new Set<string>();
    // Frame edges never cut through a screen's name.
    for (const f of document.querySelectorAll('[data-testid="canvas-section"]')) {
      const r = f.getBoundingClientRect();
      for (const n of names) if (n.y + 1 < r.top && n.y + n.h - 1 > r.top && n.x < r.right && n.x + n.w > r.left) throughNames.add(`frame edge through ${n.what}`);
    }
    const frames = [...document.querySelectorAll('[data-testid="canvas-section"]')].map((f) => f.getBoundingClientRect());
    /** Within 3 px of a frame's edge, along it. */
    const onEdge = (x: number, y: number) => frames.some((f) => ((Math.abs(y - f.top) < 3 || Math.abs(y - f.bottom) < 3) && x > f.left && x < f.right) || ((Math.abs(x - f.left) < 3 || Math.abs(x - f.right) < 3) && y > f.top && y < f.bottom));
    paths.forEach((p, i) => {
      let along = 0; let longest = 0;
      const from = p.getAttribute('data-from') ?? conns[i]?.from; const to = p.getAttribute('data-to') ?? conns[i]?.to;
      const ctm = p.getScreenCTM(); if (!ctm) return;
      const len = p.getTotalLength(); const n = Math.min(600, Math.max(20, Math.ceil(len * ctm.a / 3)));
      const crossed = new Set<string>();
      for (let k = 0; k <= n; k++) {
        const q = p.getPointAtLength((len * k) / n);
        const s = new DOMPoint(q.x, q.y).matrixTransform(ctm);
        for (const r of screens) if (r.id !== from && r.id !== to && s.x > r.x + 2 && s.x < r.x + r.w - 2 && s.y > r.y + 2 && s.y < r.y + r.h - 2) crossed.add(r.what);
        along = onEdge(s.x, s.y) ? along + 1 : 0; longest = Math.max(longest, along);
        for (const r of names) if (s.x > r.x + 1 && s.x < r.x + r.w - 1 && s.y > r.y + 1 && s.y < r.y + r.h - 1) throughNames.add(`${conns.find((x) => x.from === from && x.to === to)?.label ?? i} through ${r.what}`);
      }
      // About 24 px or more along a frame's edge reads as the edge itself.
      if (longest * (len * ctm.a / n) > 24) throughNames.add(`${conns.find((x) => x.from === from && x.to === to)?.label ?? i} runs along a frame edge`);
      if (crossed.size) crossings.push(`${conns.find((x) => x.from === from && x.to === to)?.label ?? i} crosses ${[...crossed].join(', ')}`);
    });
    return { shown: flowLabels.length, hidden: flowEls.filter((e) => !shown(e)).length, overlaps, crossings, names: [...throughNames] };
  }, t.connections);
}

/** Zooms with the wheel across a range and reads how long each frame took, and the placement inside it. */
async function timeZooming(page: Page): Promise<{ frames: number[]; place: number[]; route: number[] }> {
  const c = (await worldOf(page)).canvas;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean; __bogenFlows?: { times: number[]; routeTimes: number[] } };
    w.__frames = []; w.__stop = false; if (w.__bogenFlows) { w.__bogenFlows.times.length = 0; w.__bogenFlows.routeTimes.length = 0; }
    let last = performance.now();
    const step = (now: number) => { w.__frames.push(now - last); last = now; if (!w.__stop) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
  await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 40; i++) { await page.mouse.wheel({ deltaY: i < 20 ? 40 : -40 }); await sleep(16); }
  await page.keyboard.up('Control');
  await sleep(200);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean; __bogenFlows?: { times: number[]; routeTimes?: number[] } };
    w.__stop = true;
    return { frames: w.__frames.slice(2), place: [...(w.__bogenFlows?.times ?? [])], route: [...(w.__bogenFlows?.routeTimes ?? [])] };
  });
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 100) / 100 : 0; };

async function main(): Promise<void> {
  const real = process.env.FLOWS_HOME;
  const shots = process.env.FLOWS_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR, ...(real ? { homeFrom: real } : {}) });
  const browser = await launch(server.port);
  const targets: Target[] = [];
  let perf: Target | null = null;
  const closers: (() => void)[] = [];
  try {
    if (real) {
      const load = (spec: string): Target => {
        const [file, page] = spec.split(':') as [string, string];
        const y = new Y.Doc(); Y.applyUpdate(y, readFileSync(join(real, 'files', `${file}.ydoc`)));
        const doc = new BogenDoc(y);
        return { file, page, name: `${file}-${page}`, connections: readCanvasPlan(doc, page).connections };
      };
      targets.push(...(process.env.FLOWS_PAGES ?? '').split(',').filter(Boolean).map(load));
      if (process.env.FLOWS_PERF) perf = load(process.env.FLOWS_PERF);
    } else {
      const make = async (name: string, build: (doc: BogenDoc, page: string) => void): Promise<Target> => {
        const res = await fetch(`${server.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const { id } = (await res.json()) as { id: string };
        const { doc, close } = await connect(server, id); closers.push(close);
        const page = doc.getPages()[0]!.id;
        build(doc, page);
        await sleep(300);
        return { file: id, page, name, connections: readCanvasPlan(doc, page).connections };
      };
      targets.push(await make('flows', buildFlows));
      perf = await make('large', buildLarge);
    }
    const page = await freshPage(browser);
    const errors: string[] = [];
    watchErrors(page, errors);
    for (const t of targets) {
      await open(page, server.base, t, 'dark');
      // Far out, screens that hug their content are drawn at the height of their rendered preview: wait for those, so
      // that the first capture shows what every later one does.
      for (let i = 0; i < 180; i++) {
        let pending = false; let offset: number | null = 0;
        while (offset !== null) {
          const batch = (await (await fetch(`${server.base}/api/files/${t.file}/screen-previews?page=${t.page}&offset=${offset}`)).json()) as { screens: { state: string }[]; next: number | null };
          pending ||= batch.screens.some((x) => x.state === 'pending'); offset = batch.next ?? null;
        }
        if (!pending) break;
        await sleep(1000);
      }
      await open(page, server.base, t, 'dark');
      const { canvas, boxes, frames } = await worldOf(page);
      if (process.env.FLOWS_DUMP) writeFileSync(join(process.env.FLOWS_DUMP, `${t.name}.json`), JSON.stringify({ boxes, frames, connections: t.connections }));
      for (const theme of THEMES) for (const z of ZOOMS) {
        await open(page, server.base, t, theme, viewFor(z, canvas, boxes, t));
        const shown = await page.$eval('[data-testid="zoom-level"]', (e) => e.textContent ?? '');
        const r = await inspect(page, t);
        const tag = `${t.name} ${theme} ${Math.round(z * 100)}%`;
        console.log(`info  ${tag}: zoom shows ${shown}, ${r.shown} labels shown, ${r.hidden} hidden`);
        check(`${tag}: no label overlaps a label, a screen or a title`, r.overlaps.length === 0, r.overlaps);
        check(`${tag}: no connection runs across another screen`, r.crossings.length === 0, r.crossings);
        check(`${tag}: no connection or frame edge runs through a screen's name, and no connection along a frame's edge`, r.names.length === 0, r.names);
        if (shots) await page.screenshot({ path: join(shots, `${t.name}-${theme}-z${String(Math.round(z * 100)).padStart(3, '0')}.png`) as `${string}.png`, clip: { x: canvas.x, y: canvas.y, width: canvas.w, height: canvas.h } });
      }
    }
    if (perf) {
      await open(page, server.base, perf, 'dark');
      const { canvas, boxes } = await worldOf(page);
      await open(page, server.base, perf, 'dark', viewFor(0.15, canvas, boxes, { ...perf, connections: [] }));
      const opened = await page.evaluate(() => [...((window as unknown as { __bogenFlows?: { routeTimes: number[] } }).__bogenFlows?.routeTimes ?? [])]);
      const { frames, place, route } = await timeZooming(page);
      console.log(`info  ${perf.name}: routing when the page opens or screens move, max ${pct(opened, 1)} ms over ${opened.length} passes`);
      console.log(`info  ${perf.name}: ${Object.keys(boxes).length} screens, ${perf.connections.length} connections; frame p50 ${pct(frames, 0.5)} ms, p95 ${pct(frames, 0.95)} ms, max ${pct(frames, 1)} ms; placement p50 ${pct(place, 0.5)} ms, p95 ${pct(place, 0.95)} ms, max ${pct(place, 1)} ms over ${place.length} passes; routing max ${pct(route, 1)} ms over ${route.length} zoom steps`);
      if (!real) check('placing the labels of 120 screens takes under 4 ms at the 95th percentile', place.length > 0 && pct(place, 0.95) < 4, { place: place.length, p95: pct(place, 0.95) });
    }
    check('no page errors', errors.length === 0, errors);
  } finally {
    for (const close of closers) close();
    await browser.close();
    await server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}

void main();
