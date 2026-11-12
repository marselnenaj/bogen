import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  applyReplayWrites, autoCamera, rebuildHistory, replayClock, replayColor, replayDoc, replayFrameAt, stepLayers, stepTouchesPage,
  type BogenDoc, type ReplayClock, type ReplayEntry, type ReplayFrame, type ReplayRect, type ReplayStepInfo, type ReplayTiming, type ReplayView,
} from '@bogen/core';
import type { Page } from 'puppeteer-core';
import type { BogenServer } from './http/server.ts';
import { findFfmpeg, withEncoderPage } from './media.ts';
import { HttpError } from './util.ts';
import { ffmpegSink, webCodecsSink, type FrameSink } from './video.ts';

/**
 * Replays of how a page was built, from its timeline. The server rebuilds each state of the page (core's
 * `rebuildHistory`), renders the ones that show on it in one browser tab, and keeps the pictures for a while,
 * so that the editor can play them and the export can film them. Both use core's `replayFrameAt`, so what the
 * editor plays is what the video shows.
 */

export interface ReplayQuery {
  pageId?: string;
  /** A change id, a commit id, a time in milliseconds or ISO 8601. The first step is the first change at or after it. */
  from?: string;
  /** The same. The last step is the last change at or before it. */
  to?: string;
  /** One agent run: from its first change to its last, with whatever else happened in between. */
  run?: string;
}

export interface ReplayPlan {
  id: string;
  fileId: string;
  pageId: string;
  pageName: string;
  steps: ReplayStepInfo[];
  /** Pictures in page coordinates: 0 is the page before the first step, k + 1 after step k. Null: the page was empty. */
  shots: (ReplayRect | null)[];
  /** Everything the replay shows, with some room around it. */
  frame: ReplayRect;
  /** Pixel density the pictures were taken at. */
  scale: number;
  notes: string[];
  createdAt: number;
}

export interface KeptReplay { plan: ReplayPlan; pictures: (Uint8Array | null)[]; key: string; at: number }

export const MAX_REPLAY_STEPS = 800;
export const MAX_REPLAY_SECONDS = 600;
const KEEP_MS = 15 * 60_000;
const KEEP_COUNT = 3;
const SHOT_LIMIT = 8000;
const kept = new WeakMap<BogenServer, Map<string, KeptReplay>>();
const building = new WeakMap<BogenServer, Map<string, Promise<KeptReplay>>>();

function store(app: BogenServer): Map<string, KeptReplay> {
  let map = kept.get(app);
  if (!map) kept.set(app, (map = new Map()));
  const now = Date.now();
  for (const [id, k] of map) if (now - k.at > KEEP_MS) map.delete(id);
  return map;
}

/** A kept replay, by the id its plan carries. */
export function keptReplay(app: BogenServer, fileId: string, id: string): KeptReplay | null {
  const found = store(app).get(id);
  return found && found.plan.fileId === fileId ? found : null;
}

/** Where a bound of the range falls in the timeline. */
async function boundIndex(app: BogenServer, fileId: string, entries: ReplayEntry[], value: string, side: 'from' | 'to'): Promise<number> {
  const byId = entries.findIndex((e) => e.id === value);
  if (byId >= 0) return byId;
  let at: number | null = null;
  if (/^\d{10,}$/.test(value)) at = Number(value);
  else if (/^\d{4}-\d\d-\d\d/.test(value) && Number.isFinite(Date.parse(value))) at = Date.parse(value);
  else {
    const commit = (await app.commits.list(fileId)).find((c) => c.id === value);
    if (commit) at = commit.at;
  }
  if (at === null) throw new HttpError(400, `"${value}" is neither a change, a commit nor a time. Use an id from change_list or commit_list, or a time.`);
  if (side === 'from') {
    const i = entries.findIndex((e) => e.at >= at!);
    return i < 0 ? entries.length : i;
  }
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.at <= at) return i;
  return -1;
}

const union = (rects: ReplayRect[]): ReplayRect | null => {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};

/** Runs in the state tab: boxes of the roots and of the layers asked for, in page coordinates. */
function measure(roots: string[], wanted: string[]): { roots: ReplayRect | null; boxes: Record<string, ReplayRect> } {
  const box = (id: string) => {
    const el = document.querySelector(`[data-bogen-id="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width || r.height ? { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } : null;
  };
  const all = roots.map(box).filter((r): r is ReplayRect => Boolean(r));
  const boxes: Record<string, ReplayRect> = {};
  for (const id of wanted) {
    const r = box(id);
    if (r) boxes[id] = r;
  }
  if (!all.length) return { roots: null, boxes };
  const x = Math.min(...all.map((r) => r.x));
  const y = Math.min(...all.map((r) => r.y));
  return { roots: { x, y, width: Math.max(...all.map((r) => r.x + r.width)) - x, height: Math.max(...all.map((r) => r.y + r.height)) - y }, boxes };
}

/** Runs in the state tab: a soft shadow under each board, and the area moved to the origin. */
function stageForShot(roots: string[], area: ReplayRect): void {
  // Transparent around the boards, so that the editor's canvas and the film's both show through.
  document.body.style.background = 'transparent';
  for (const id of roots) {
    const el = document.querySelector(`[data-bogen-id="${CSS.escape(id)}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const shadow = document.createElement('div');
    shadow.style.cssText = `position:absolute;left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px;box-shadow:0 1px 3px rgb(0 0 0/12%),0 6px 24px rgb(0 0 0/7%);pointer-events:none`;
    document.body.prepend(shadow);
  }
  document.body.style.transform = `translate(${-area.x}px,${-area.y}px)`;
}

const SHADOW_ROOM = 32;

async function shoot(page: Page, roots: string[], rect: ReplayRect, scale: number): Promise<{ png: Uint8Array; rect: ReplayRect }> {
  const area = { x: Math.floor(rect.x - SHADOW_ROOM), y: Math.floor(rect.y - SHADOW_ROOM), width: Math.ceil(rect.width + SHADOW_ROOM * 2), height: Math.ceil(rect.height + SHADOW_ROOM * 2) };
  const s = Math.min(scale, SHOT_LIMIT / Math.max(area.width, area.height));
  await page.evaluate(stageForShot, roots, area);
  await page.setViewport({ width: Math.max(1, Math.min(SHOT_LIMIT, area.width)), height: Math.max(1, Math.min(SHOT_LIMIT, area.height)), deviceScaleFactor: s });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: area.width, height: area.height }, captureBeyondViewport: false, omitBackground: true });
  return { png: new Uint8Array(png), rect: area };
}

/**
 * Rebuilds and renders a replay, or gives the one already made for the same range of the same timeline.
 * `scale` is the density of the pictures: 1 to look at, more for a video that comes close.
 */
export async function planReplay(app: BogenServer, fileId: string, query: ReplayQuery, options: { scale?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<KeptReplay> {
  app.requireFile(fileId);
  const room = await app.rooms.get(fileId);
  await app.timeline.flush(fileId);
  const entries = (await app.timeline.all(fileId)) as ReplayEntry[];
  if (!entries.length) throw new HttpError(400, 'Nothing has been recorded for this file yet, so there is nothing to replay.');
  let from = 0;
  let to = entries.length - 1;
  if (query.run) {
    const ofRun = entries.flatMap((e, i) => (e.run === query.run ? [i] : []));
    if (!ofRun.length) throw new HttpError(404, `Nothing recorded for run ${query.run}.`);
    from = ofRun[0]!;
    to = ofRun.at(-1)!;
  }
  if (query.from) from = Math.max(from, await boundIndex(app, fileId, entries, query.from, 'from'));
  if (query.to) to = Math.min(to, await boundIndex(app, fileId, entries, query.to, 'to'));
  if (from > to) throw new HttpError(400, 'The range holds no changes.');

  const scale = Math.min(3, Math.max(0.25, options.scale ?? 1));
  const pageId = query.pageId ?? pickPage(room.doc, entries.slice(from, to + 1));
  if (!pageId) throw new HttpError(404, 'This file has no pages.');
  const key = `${fileId}|${pageId}|${from}|${to}|${scale}|${entries.at(-1)!.id}`;
  const cache = store(app);
  for (const k of cache.values()) {
    if (k.key === key) {
      k.at = Date.now();
      return k;
    }
  }
  let jobs = building.get(app);
  if (!jobs) building.set(app, (jobs = new Map()));
  const running = jobs.get(key);
  if (running) return running;
  const job = buildReplay(app, room.doc, fileId, pageId, entries, from, to, scale, key, options.onProgress).finally(() => jobs!.delete(key));
  jobs.set(key, job);
  return job;
}

/** The page most of the range happened on, by the layers it names as they are now; else the first page. */
function pickPage(doc: BogenDoc, entries: ReplayEntry[]): string | undefined {
  const count = new Map<string, number>();
  for (const e of entries) {
    for (const id of e.layers.slice(0, 20)) {
      const page = doc.pageOf(id);
      if (page) count.set(page, (count.get(page) ?? 0) + 1);
    }
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ?? doc.getPages()[0]?.id;
}

async function buildReplay(app: BogenServer, live: BogenDoc, fileId: string, pageId: string, entries: ReplayEntry[], from: number, to: number, scale: number, key: string, onProgress?: (done: number, total: number) => void): Promise<KeptReplay> {
  const rebuilt = rebuildHistory(live, entries, from, to);
  const notes: string[] = [];
  if (rebuilt.thinnedAt && !rebuilt.steps.length) throw new HttpError(400, 'These changes are too old: their details were thinned out, so the page cannot be rebuilt as it was. Replay a later range.');
  if (rebuilt.thinnedAt) notes.push('Older changes were thinned out, so the replay starts after them.');
  const doc = replayDoc(rebuilt.start);
  if (!live.pages.has(pageId) && !doc.pages.has(pageId)) throw new HttpError(404, `No page ${pageId} in this file.`);
  const pageName = String(live.pages.get(pageId)?.get('name') ?? doc.pages.get(pageId)?.get('name') ?? 'Page');
  // Which steps show on the page, decided before rendering, so that progress can be counted.
  const visible: { index: number; layers: string[] }[] = [];
  {
    const probe = replayDoc(rebuilt.start);
    rebuilt.steps.forEach((step, index) => {
      const before = stepTouchesPage(probe, step.writes, pageId);
      applyReplayWrites(probe, step.writes);
      if (before || stepTouchesPage(probe, step.writes, pageId)) visible.push({ index, layers: stepLayers(step.writes) });
    });
  }
  const hidden = rebuilt.steps.length - visible.length;
  if (hidden) notes.push(`${hidden} change${hidden === 1 ? '' : 's'} in the range did not touch this page and play along without a step of their own.`);
  if (!visible.length) throw new HttpError(400, 'Nothing in this range changed this page. Pick another page or range.');
  if (visible.length > MAX_REPLAY_STEPS) throw new HttpError(400, `That is ${visible.length} steps, more than the ${MAX_REPLAY_STEPS} one replay holds. Replay a shorter range with from and to.`);

  const roots = () => doc.getChildren(pageId).filter((n) => !n.hidden).map((n) => n.id);
  const shots: (ReplayRect | null)[] = [];
  const pictures: (Uint8Array | null)[] = [];
  const steps: ReplayStepInfo[] = [];
  const total = visible.length + 1;
  await app.renderer.withStatePage(async (load) => {
    let known: Record<string, ReplayRect> = {};
    const take = async (wanted: string[]): Promise<Record<string, ReplayRect>> => {
      const ids = roots();
      if (!ids.length) {
        shots.push(null);
        pictures.push(null);
        return {};
      }
      const page = await load(doc, ids);
      const measured = await page.evaluate(measure, ids, wanted);
      if (!measured.roots) {
        shots.push(null);
        pictures.push(null);
        return measured.boxes;
      }
      const shot = await shoot(page, ids, measured.roots, scale);
      shots.push(shot.rect);
      pictures.push(shot.png);
      return measured.boxes;
    };
    known = await take(visible[0]!.layers);
    onProgress?.(1, total);
    let applied = 0;
    for (let v = 0; v < visible.length; v++) {
      const { index, layers } = visible[v]!;
      // Changes that did not touch the page land with the next step that did.
      for (; applied <= index; applied++) applyReplayWrites(doc, rebuilt.steps[applied]!.writes);
      const next = visible[v + 1]?.layers ?? [];
      const boxes = await take([...new Set([...layers, ...next])]);
      const entry = rebuilt.steps[index]!.entry;
      // A layer that is gone is found where it was.
      const focus = union(layers.map((id) => boxes[id] ?? known[id]).filter((r): r is ReplayRect => Boolean(r)));
      steps.push({ id: entry.id, at: entry.at, actor: entry.actor, source: entry.source, ...(entry.tool ? { tool: entry.tool } : {}), summary: entry.summary, focus });
      known = { ...known, ...boxes };
      onProgress?.(v + 2, total);
    }
  });

  const all = union([...shots.filter((r): r is ReplayRect => Boolean(r)), ...steps.flatMap((s) => (s.focus ? [s.focus] : []))]);
  if (!all) throw new HttpError(400, 'The page stays empty in this range, so there is nothing to show.');
  const room = Math.max(24, Math.round(Math.max(all.width, all.height) * 0.03));
  const frame = { x: all.x - room, y: all.y - room, width: all.width + room * 2, height: all.height + room * 2 };
  const plan: ReplayPlan = { id: randomBytes(8).toString('hex'), fileId, pageId, pageName, steps, shots, frame, scale, notes, createdAt: Date.now() };
  const k: KeptReplay = { plan, pictures, key, at: Date.now() };
  const cache = store(app);
  cache.set(plan.id, k);
  while (cache.size > KEEP_COUNT) cache.delete(cache.keys().next().value!);
  return k;
}

// Film

export interface ReplayFilmOptions {
  format: 'mp4' | 'webm' | 'gif';
  speed?: number;
  /** The longest a pause may last, in milliseconds before the speed. */
  maxIdleMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  captions?: boolean;
  cursors?: boolean;
  camera?: 'fit' | 'grow' | 'follow' | 'auto';
  /** Only steps from this index to this one (both included), of the plan's steps. */
  fromStep?: number;
  toStep?: number;
  encoder?: 'ffmpeg' | 'webcodecs';
  onFrame?: (done: number, total: number) => void;
}

export interface ReplayFilm {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  report: { frames: number; fps: number; width: number; height: number; seconds: number; steps: number; camera: 'fit' | 'grow' | 'follow'; encoder: string; codec: string; notes?: string[] };
}

/** The clock, the view and the steps a film or a player uses, from a plan and its options. */
export function replaySetup(plan: ReplayPlan, options: { speed?: number; maxIdleMs?: number; width: number; height: number; camera?: 'fit' | 'grow' | 'follow' | 'auto'; fromStep?: number; toStep?: number }): { steps: ReplayStepInfo[]; offset: number; clock: ReplayClock; view: ReplayView } {
  const first = Math.max(0, Math.min(plan.steps.length - 1, options.fromStep ?? 0));
  const last = Math.max(first, Math.min(plan.steps.length - 1, options.toStep ?? plan.steps.length - 1));
  const steps = plan.steps.slice(first, last + 1);
  const timing: Partial<ReplayTiming> = { ...(options.speed ? { speed: options.speed } : {}), ...(options.maxIdleMs !== undefined ? { maxIdleMs: options.maxIdleMs } : {}) };
  const clock = replayClock(steps, timing);
  const camera = !options.camera || options.camera === 'auto' ? autoCamera(plan.frame, options.width, options.height, true) : options.camera;
  // The pictures of the slice: the page before its first step, then after each of its steps.
  const extents = plan.shots.slice(first, last + 2);
  return { steps, offset: first, clock, view: { frame: plan.frame, aspect: options.width / options.height, camera, minWidth: Math.max(1280, options.width * 0.75), extents } };
}

function evenSize(n: number): number {
  const v = Math.max(16, Math.round(n));
  return v + (v % 2);
}

/** The size a film gets: as asked, or 1920 by 1080 (half for a GIF), turned upright for a frame taller than wide. */
export function filmSize(plan: ReplayPlan, options: { format: string; width?: number; height?: number }): { width: number; height: number } {
  const upright = plan.frame.height > plan.frame.width * 1.15;
  const long = options.format === 'gif' ? 960 : 1920;
  const short = options.format === 'gif' ? 540 : 1080;
  let width = options.width;
  let height = options.height;
  if (width && !height) height = upright ? width * (16 / 9) : width * (9 / 16);
  else if (height && !width) width = upright ? height * (9 / 16) : height * (16 / 9);
  width ??= upright ? short : long;
  height ??= upright ? long : short;
  const big = Math.max(width, height);
  if (big > 3840) {
    width *= 3840 / big;
    height *= 3840 / big;
  }
  return { width: evenSize(width), height: evenSize(height) };
}

let uiFont: Promise<Uint8Array | null> | null = null;

/** Bogen's own type, Archivo with its width axis, for names and captions, when this build has it; the system's otherwise. */
function replayFont(): Promise<Uint8Array | null> {
  uiFont ??= (async () => {
    try {
      const path = createRequire(import.meta.url).resolve('@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2');
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  })();
  return uiFont;
}

const STAGE_ORIGIN = 'http://bogen.replay';

/**
 * The film is Bogen's own picture, so it wears the brand: the page on ink, agents in tomato (the one place the
 * brand allows it), people in blue, square names and captions. The editor's player keeps the canvas's colours.
 */
const FILM = { stage: '#0e0e0c', ink: '#0e0e0c', paper: '#f4f2ec', agent: '#f2361f', person: '#2b3df2' };

/** The film's colour for each actor of a plan, by whether it is an agent. */
function filmColors(steps: ReplayStepInfo[]): Record<string, { fill: string; text: string }> {
  const out: Record<string, { fill: string; text: string }> = {};
  for (const s of steps) out[s.actor] ??= s.source === 'agent' ? { fill: FILM.agent, text: FILM.ink } : { fill: FILM.person, text: FILM.paper };
  return out;
}

function stageHtml(width: number, height: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Replay UI";src:url(/font.woff2) format("woff2");font-weight:100 900;font-stretch:62% 125%}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${FILM.stage}}
body{font-family:"Replay UI",Archivo,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
#world img{position:absolute;display:block}
#mark{position:absolute;left:0;top:0;box-sizing:border-box;display:none}
.cur{position:absolute;left:0;top:0;display:flex;flex-direction:column;align-items:flex-start}
.cur svg{display:block;filter:drop-shadow(0 1px 1.5px rgb(0 0 0/30%))}
.name{margin-top:var(--g);margin-left:calc(var(--u)*13px);padding:calc(var(--u)*3px) calc(var(--u)*8px);font-weight:700;font-stretch:112%;font-size:calc(var(--u)*14px);line-height:1.2;white-space:nowrap}
.cap{margin-top:var(--g);margin-left:calc(var(--u)*13px);display:flex;gap:calc(var(--u)*9px);align-items:baseline;max-width:calc(var(--u)*560px);padding:calc(var(--u)*6px) calc(var(--u)*10px);background:${FILM.ink};color:${FILM.paper};font-size:calc(var(--u)*14px);line-height:1.25;box-shadow:0 0 0 1px rgb(244 242 236/14%)}
.cap code{font:600 calc(var(--u)*13px)/1.2 "JetBrains Mono",ui-monospace,"DejaVu Sans Mono",monospace;color:${FILM.paper};white-space:nowrap}
.cap span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
</style></head><body><div id="world"></div><div id="mark"></div><div id="over"></div></body></html>`;
}

interface StageState {
  frame: ReplayFrame;
  shots: (ReplayRect | null)[];
  width: number;
  height: number;
  captions: boolean;
  cursors: boolean;
  colors: Record<string, { fill: string; text: string }>;
}

/** Runs in the stage tab: puts one frame on the screen. Pictures load once and stay. */
async function showFrame(state: StageState): Promise<void> {
  const { frame, shots, width, captions, cursors, colors } = state;
  const w = window as unknown as { __imgs?: Map<number, HTMLImageElement> };
  const imgs = (w.__imgs ??= new Map());
  const world = document.getElementById('world')!;
  const scale = width / frame.camera.width;
  world.style.transform = `translate(${-frame.camera.x * scale}px,${-frame.camera.y * scale}px) scale(${scale})`;
  const want = [frame.under, frame.top].filter((i): i is number => i !== null && Boolean(shots[i]));
  for (const [i, img] of imgs) {
    if (!want.includes(i)) {
      img.remove();
      imgs.delete(i);
    }
  }
  for (const i of want) {
    let img = imgs.get(i);
    if (!img) {
      img = new Image();
      img.src = `/shot/${i}.png`;
      const r = shots[i]!;
      img.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
      await img.decode().catch(() => {});
      imgs.set(i, img);
    }
    // The page before fades out over the page after, so that what a step adds is there at once, on the page's
    // own ground, and only what it changed blends. Fading the new page in would show the stage through it.
    img.style.opacity = i === frame.top ? '1' : String(1 - frame.fade);
    img.style.zIndex = i === frame.top ? '1' : '2';
    world.append(img);
  }
  const u = Math.max(0.5, Math.min(2.5, state.height / 1080 * 1.15));
  document.body.style.setProperty('--u', String(u));
  document.body.style.setProperty('--g', `${3 * u}px`);
  const toScreen = (x: number, y: number) => ({ x: (x - frame.camera.x) * scale, y: (y - frame.camera.y) * scale });
  const mark = document.getElementById('mark')!;
  if (cursors && frame.highlight) {
    const a = toScreen(frame.highlight.rect.x, frame.highlight.rect.y);
    mark.style.display = 'block';
    mark.style.left = `${a.x - 3 * u}px`;
    mark.style.top = `${a.y - 3 * u}px`;
    mark.style.width = `${frame.highlight.rect.width * scale + 6 * u}px`;
    mark.style.height = `${frame.highlight.rect.height * scale + 6 * u}px`;
    mark.style.border = `${Math.max(1.5, 2 * u)}px solid ${colors[frame.highlight.actor]?.fill ?? frame.highlight.color}`;
    mark.style.opacity = String(frame.highlight.opacity);
  } else mark.style.display = 'none';
  const over = document.getElementById('over')!;
  over.textContent = '';
  if (!cursors) return;
  for (const c of frame.cursors) {
    const p = toScreen(c.x, c.y);
    const el = document.createElement('div');
    el.className = 'cur';
    const press = 1 - c.pressed * 0.14;
    el.style.transform = `translate(${p.x}px,${p.y}px)`;
    el.style.opacity = String(c.opacity);
    const size = 22 * u;
    const color = colors[c.actor] ?? { fill: c.color, text: '#fff' };
    el.innerHTML = `<svg width="${size}" height="${size * 1.12}" viewBox="0 0 20 22" style="transform:scale(${press});transform-origin:0 0"><path d="M1.5 1.5 18 10.2l-7.6 2.1-3.4 7.6z" fill="${color.fill}" stroke="#f4f2ec" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    const name = document.createElement('div');
    name.className = 'name';
    name.style.background = color.fill;
    name.style.color = color.text;
    name.textContent = c.actor;
    el.append(name);
    if (captions && frame.caption && frame.caption.actor === c.actor) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.style.opacity = String(frame.caption.opacity);
      if (frame.caption.tool) {
        const code = document.createElement('code');
        code.textContent = frame.caption.tool;
        cap.append(code);
      }
      const text = document.createElement('span');
      text.textContent = frame.caption.summary;
      cap.append(text);
      el.append(cap);
    }
    over.append(el);
  }
}

/** Films a replay through the same encoders as the video export: ffmpeg when there is one, the browser otherwise. GIF needs ffmpeg. */
export async function filmReplay(app: BogenServer, kept: KeptReplay, options: ReplayFilmOptions): Promise<ReplayFilm> {
  const { plan, pictures } = kept;
  const size = filmSize(plan, options);
  const fps = Math.round(Math.max(1, Math.min(60, options.fps ?? (options.format === 'gif' ? 15 : 30))));
  const setup = replaySetup(plan, { ...options, ...size });
  const seconds = setup.clock.duration / 1000;
  if (seconds > MAX_REPLAY_SECONDS) throw new HttpError(400, `At this speed the replay lasts ${Math.round(seconds)} s, more than ${MAX_REPLAY_SECONDS} s. Raise the speed, lower the cap on idle gaps, or pick a shorter range.`);
  const ffmpeg = options.encoder === 'webcodecs' ? null : findFfmpeg();
  if (options.encoder === 'ffmpeg' && !ffmpeg) throw new HttpError(400, 'There is no ffmpeg on this machine. Leave the encoder out to use the browser.');
  if (options.format === 'gif' && !ffmpeg) throw new HttpError(400, 'A GIF needs ffmpeg, and there is none on this machine. Export MP4 or WebM, which the browser can make.');
  const total = Math.max(1, Math.ceil(seconds * fps));
  const font = await replayFont();
  const captions = options.captions !== false;
  const cursors = options.cursors !== false;
  const colors = filmColors(setup.steps);
  // Step indices of the slice, as pictures of the whole plan: the slice's step j is the plan's step offset + j.
  const shotFor = (i: number | null) => (i === null ? null : i + setup.offset);
  return app.renderer.withBrowser(async (browser) => {
    const page = await browser.newPage();
    try {
      await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
      await page.setRequestInterception(true);
      const html = stageHtml(size.width, size.height);
      page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.origin !== STAGE_ORIGIN) return void req.abort('blockedbyclient').catch(() => {});
        if (url.pathname === '/') return void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html }).catch(() => {});
        if (url.pathname === '/font.woff2' && font) return void req.respond({ status: 200, contentType: 'font/woff2', body: Buffer.from(font) }).catch(() => {});
        const shot = /^\/shot\/(\d+)\.png$/.exec(url.pathname);
        const bytes = shot ? pictures[Number(shot[1])] : null;
        if (bytes) return void req.respond({ status: 200, contentType: 'image/png', body: Buffer.from(bytes) }).catch(() => {});
        return void req.respond({ status: 404, body: '' }).catch(() => {});
      });
      await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
      await page.goto(`${STAGE_ORIGIN}/`, { waitUntil: 'load', timeout: 20_000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const run = async (sink: FrameSink): Promise<{ bytes: Uint8Array; codec: string }> => {
        try {
          let last = '';
          let lastPng: Uint8Array | null = null;
          for (let i = 0; i < total; i++) {
            const f = replayFrameAt(setup.steps, setup.clock, setup.view, (i * 1000) / fps);
            const frame: ReplayFrame = { ...f, top: shotFor(f.top)!, under: shotFor(f.under) };
            const { t: _t, ...rest } = frame;
            const sig = JSON.stringify(rest);
            // A still moment is the same picture again, without asking the browser.
            if (sig !== last || !lastPng) {
              await page.evaluate(showFrame, { frame, shots: plan.shots, width: size.width, height: size.height, captions, cursors, colors });
              lastPng = new Uint8Array(await page.screenshot({ type: 'png', captureBeyondViewport: false, optimizeForSpeed: true }));
              last = sig;
            }
            await sink.push(lastPng, i);
            options.onFrame?.(i + 1, total);
          }
          return await sink.finish();
        } catch (e) {
          sink.abort();
          throw e;
        }
      };
      const out = ffmpeg
        ? await run(await ffmpegSink(ffmpeg, { format: options.format, fps }))
        : await withEncoderPage(browser, async (encoderPage) => {
          const sink = await webCodecsSink(encoderPage, { format: options.format as 'mp4' | 'webm', width: size.width, height: size.height, fps });
          await page.bringToFront();
          return run(sink);
        });
      const mime = options.format === 'gif' ? 'image/gif' : options.format === 'mp4' ? 'video/mp4' : 'video/webm';
      return {
        bytes: out.bytes, mime, ext: options.format,
        report: {
          frames: total, fps, width: size.width, height: size.height, seconds: Math.round(seconds * 10) / 10, steps: setup.steps.length, camera: setup.view.camera,
          encoder: ffmpeg ? 'ffmpeg' : 'webcodecs', codec: out.codec, ...(plan.notes.length ? { notes: plan.notes } : {}),
        },
      };
    } finally {
      await page.close().catch(() => {});
    }
  });
}

/** For a film, pictures dense enough that a camera coming close stays sharp. */
export function filmScale(width: number): number {
  return Math.min(2, Math.max(1, width / 1280));
}

/** Plans and films in one go, for the export route, the tool and the command line. */
export async function exportReplay(app: BogenServer, fileId: string, options: ReplayQuery & ReplayFilmOptions): Promise<ReplayFilm> {
  const kept = await planReplay(app, fileId, options, { scale: filmScale(options.width ?? (options.format === 'gif' ? 960 : 1920)) });
  return filmReplay(app, kept, options);
}

/** What the editor needs to play a plan: everything but the pictures, which it loads one by one. */
export function planForClient(plan: ReplayPlan): ReplayPlan & { colors: Record<string, string> } {
  const colors: Record<string, string> = {};
  for (const s of plan.steps) colors[s.actor] = replayColor(s.actor);
  return { ...plan, colors };
}
