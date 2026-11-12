import * as Y from 'yjs';
import { cloneEncoded, decodeValue, encodeKey, LABEL_KEY, rootNames, writePath, type ChangeOp, type Encoded } from './changes.ts';
import { BogenDoc } from './doc.ts';

/**
 * Replay: how a page was built, step by step, from its change timeline. Two halves, both pure, so the editor
 * and the video export play the same thing:
 *
 * - Rebuilding the states. Every change records each field before and after, but a whole layer that was added
 *   keeps only a fingerprint of its value. So the walk goes backwards from the document as it is now, putting
 *   the values before back one change at a time, and notes for each change what it left behind. Going forward
 *   is then a matter of writing those values in order. A change whose details were thinned out stops the walk:
 *   nothing before it can be told.
 * - The clock and the frames. Each step lands at a moment of the replay: the real gap to the step before, at
 *   least a short beat and at most the idle cap, divided by the speed. Around that moment the cursor of whoever
 *   made it travels to the layers it touched, presses, the page takes the new state with a short cross-fade,
 *   and a caption says which tool it was. Everything is a function of the time, so a frame is the same however
 *   it is reached.
 */

export interface ReplayRect { x: number; y: number; width: number; height: number }

/** A change as the timeline stores it. */
export interface ReplayEntry {
  id: string;
  at: number;
  source: 'person' | 'agent' | 'peer' | 'system';
  actor: string;
  tool?: string;
  run?: string;
  summary: string;
  layers: string[];
  deviceName?: string;
  ops?: ChangeOp[];
  thinned?: boolean;
}

export interface RebuiltHistory {
  /** Every root and key of the document as it was before the first step, encoded. */
  start: Map<string, Encoded>;
  /** For each step, what it left in each root and key it touched. Undefined: it was gone afterwards. */
  steps: { entry: ReplayEntry; writes: [string, Encoded][] }[];
  /** The walk stopped at this change, whose details were thinned out. */
  thinnedAt?: string;
}

const TOP = (root: string, key: string) => `${root}\u0000${key}`;

function topsOf(ops: ChangeOp[]): string[] {
  const out = new Set<string>();
  for (const op of ops) {
    const [root, key] = op.p;
    if (!root || key === undefined || (root === 'meta' && key === LABEL_KEY)) continue;
    out.add(TOP(root, key));
  }
  return [...out];
}

/**
 * The states of a document over `entries` (oldest first, the whole timeline), with the steps from index `from`
 * to index `to`. Changes after `to` are walked back through and left out of the steps.
 */
export function rebuildHistory(doc: BogenDoc, entries: ReplayEntry[], from = 0, to = entries.length - 1): RebuiltHistory {
  const state = new Map<string, Encoded>();
  for (const root of rootNames(doc)) doc.y.getMap(root).forEach((_, key) => state.set(TOP(root, key), cloneEncoded(encodeKey(doc, root, key))));
  const steps: RebuiltHistory['steps'] = [];
  let thinnedAt: string | undefined;
  for (let i = entries.length - 1; i >= Math.max(0, from); i--) {
    const entry = entries[i]!;
    if (!entry.ops) {
      thinnedAt = entry.id;
      // Past this one nothing can be told, and a range behind it has nothing to show.
      if (i > to) steps.length = 0;
      break;
    }
    if (i <= to) steps.push({ entry, writes: topsOf(entry.ops).map((id) => [id, cloneEncoded(state.get(id))]) });
    for (const op of [...entry.ops].reverse()) {
      const [root, key, ...rest] = op.p;
      if (!root || key === undefined || (root === 'meta' && key === LABEL_KEY)) continue;
      const id = TOP(root, key);
      if (!rest.length) {
        if (op.b === undefined) state.delete(id);
        else state.set(id, cloneEncoded(op.b));
        continue;
      }
      const written = writePath(state.get(id), rest, cloneEncoded(op.b));
      if (written.ok) state.set(id, written.tree);
    }
  }
  steps.reverse();
  return { start: state, steps, ...(thinnedAt ? { thinnedAt } : {}) };
}

/** A document holding these encoded roots and keys. It is a private copy: nothing in it syncs. */
export function replayDoc(state: Map<string, Encoded>): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  doc.transact(() => applyReplayWrites(doc, [...state]));
  return doc;
}

/** Moves a replay document one step on. */
export function applyReplayWrites(doc: BogenDoc, writes: [string, Encoded][]): void {
  doc.transact(() => {
    for (const [id, value] of writes) {
      const at = id.indexOf('\u0000');
      const map = doc.y.getMap(id.slice(0, at));
      const key = id.slice(at + 1);
      if (value === undefined) map.delete(key);
      else map.set(key, decodeValue(cloneEncoded(value)));
    }
  });
}

/** Roots whose changes show on every page. */
const SHARED_ROOTS = new Set(['tokens', 'modes', 'textStyles', 'fontFaces']);

/**
 * Whether a step touches a page in this state of the document: a layer there, or something every page uses.
 * Ask before and after the step, since a layer can leave the page or arrive on it.
 */
export function stepTouchesPage(doc: BogenDoc, writes: [string, Encoded][], pageId: string): boolean {
  for (const [id] of writes) {
    const at = id.indexOf('\u0000');
    const root = id.slice(0, at);
    const key = id.slice(at + 1);
    if (SHARED_ROOTS.has(root) || (root === 'meta' && key === 'keyframes')) return true;
    if (root === 'pages' && key === pageId) return true;
    if (root === 'nodes' && doc.pageOf(key) === pageId) return true;
  }
  return false;
}

/** The layers a step wrote, by id. */
export function stepLayers(writes: [string, Encoded][]): string[] {
  return writes.flatMap(([id]) => (id.startsWith('nodes\u0000') ? [id.slice('nodes\u0000'.length)] : []));
}

// The clock

export interface ReplayTiming {
  /** 2 plays twice as fast. */
  speed: number;
  /** The longest a real pause between two steps may last in the replay, before the speed. */
  maxIdleMs: number;
  /** The shortest beat a step gets, before the speed, so that a burst stays readable. */
  minStepMs: number;
  /** The page as it was, before the first step. */
  headMs: number;
  /** The finished page, at the end. */
  tailMs: number;
}

export const REPLAY_TIMING: ReplayTiming = { speed: 1, maxIdleMs: 1500, minStepMs: 700, headMs: 900, tailMs: 1800 };

export interface ReplayClock {
  /** When each step lands, in milliseconds of the replay. */
  at: number[];
  /** How long the replay gives each step before it lands. */
  gaps: number[];
  duration: number;
  timing: ReplayTiming;
}

export function replayTiming(options: Partial<ReplayTiming> = {}): ReplayTiming {
  const t = { ...REPLAY_TIMING, ...Object.fromEntries(Object.entries(options).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) };
  t.speed = Math.min(64, Math.max(0.1, t.speed));
  t.minStepMs = Math.max(40, t.minStepMs);
  t.maxIdleMs = Math.max(t.minStepMs, t.maxIdleMs);
  t.headMs = Math.max(0, t.headMs);
  t.tailMs = Math.max(0, t.tailMs);
  return t;
}

export function replayClock(steps: { at: number }[], options: Partial<ReplayTiming> = {}): ReplayClock {
  const timing = replayTiming(options);
  const at: number[] = [];
  const gaps: number[] = [];
  let t = timing.headMs;
  steps.forEach((step, k) => {
    const real = k ? step.at - steps[k - 1]!.at : timing.minStepMs;
    const gap = Math.min(timing.maxIdleMs, Math.max(timing.minStepMs, real)) / timing.speed;
    t += gap;
    at.push(t);
    gaps.push(gap);
  });
  return { at, gaps, duration: (at.at(-1) ?? timing.headMs) + timing.tailMs, timing };
}

/** The step showing at a moment: the last one that has landed, -1 before the first. */
export function replayStepAt(clock: ReplayClock, t: number): number {
  let lo = 0;
  let hi = clock.at.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (clock.at[mid]! <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// The frames

export interface ReplayStepInfo {
  id: string;
  at: number;
  actor: string;
  source: string;
  tool?: string;
  summary: string;
  /** The layers it touched, in the replay's frame. Null when it touched nothing on the page with a place, such as a token. */
  focus: ReplayRect | null;
}

export interface ReplayCursor { actor: string; color: string; x: number; y: number; opacity: number; pressed: number }

export interface ReplayFrame {
  t: number;
  /** The last step that has landed, -1 before the first. */
  step: number;
  /** Pictures: `top`, and `under` over it at `1 - fade` opacity while it gives way. Picture 0 is the page before the first step, k + 1 the page after step k. */
  top: number;
  under: number | null;
  fade: number;
  cursors: ReplayCursor[];
  /** What is being done, next to the cursor of whoever does it. */
  caption: { step: number; actor: string; color: string; tool?: string; summary: string; x: number; y: number; opacity: number } | null;
  /** The layers of the current step, outlined in the colour of whoever touched them. */
  highlight: { rect: ReplayRect; actor: string; color: string; opacity: number } | null;
  /** The part of the frame in view. */
  camera: ReplayRect;
}

export interface ReplayView {
  /** Everything the replay can show, in page coordinates. */
  frame: ReplayRect;
  /** The shape of the picture it is shown in, width over height. */
  aspect: number;
  /**
   * `fit` shows the whole frame throughout. `grow` shows the page as far as it is built, and widens as it grows,
   * so the first sections are not lost in the room the last will need. `follow` keeps close to where the work is,
   * and starts and ends on the whole.
   */
  camera: 'fit' | 'grow' | 'follow';
  /** Following or growing, the camera never shows less than this much of the page across. Default 1280. */
  minWidth?: number;
  /** For `grow`: where each picture lies, as the plan's shots (0 before the first step, k + 1 after step k). */
  extents?: (ReplayRect | null)[];
}

const REPLAY_COLORS = ['#e5484d', '#f76b15', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#ad7f58'];

/** The same colour for the same name, from the palette agents have on the canvas. */
export function replayColor(name: string): string {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return REPLAY_COLORS[Math.abs(hash) % REPLAY_COLORS.length]!;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
const mix = (a: number, b: number, p: number) => a + (b - a) * p;
const mixRect = (a: ReplayRect, b: ReplayRect, p: number): ReplayRect => ({ x: mix(a.x, b.x, p), y: mix(a.y, b.y, p), width: mix(a.width, b.width, p), height: mix(a.height, b.height, p) });

/** Where a cursor clicks on a box: its middle, or near the start of a big one, as a person would. */
function clickPoint(r: ReplayRect): { x: number; y: number } {
  return { x: r.x + Math.min(r.width / 2, 140), y: r.y + Math.min(r.height / 2, 56) };
}

/** The whole frame in a picture of this shape, centred. */
export function fitCamera(frame: ReplayRect, aspect: number): ReplayRect {
  const width = Math.max(frame.width, frame.height * aspect);
  const height = width / aspect;
  return { x: frame.x + (frame.width - width) / 2, y: frame.y + (frame.height - height) / 2, width, height };
}

/** Close to a box, wide enough to see what is around it, inside the frame where it can be. */
function closeCamera(focus: ReplayRect, frame: ReplayRect, aspect: number, minWidth: number): ReplayRect {
  const whole = fitCamera(frame, aspect);
  const width = Math.min(whole.width, Math.max(focus.width * 1.5, focus.height * 1.5 * aspect, Math.min(frame.width, minWidth)));
  const height = width / aspect;
  const cx = focus.x + focus.width / 2;
  const cy = focus.y + focus.height / 2;
  const place = (centre: number, size: number, start: number, length: number) => (size >= length ? start + (length - size) / 2 : Math.min(start + length - size, Math.max(start, centre - size / 2)));
  return { x: place(cx, width, frame.x, frame.width), y: place(cy, height, frame.y, frame.height), width, height };
}

/**
 * The page as built so far, in a picture of this shape: across the middle of it, from its top while it is shorter
 * than the picture, inside the frame, and never closer than `minWidth` of the page across.
 */
function growCamera(extent: ReplayRect, frame: ReplayRect, aspect: number, minWidth: number): ReplayRect {
  const whole = fitCamera(frame, aspect);
  const room = Math.max(24, Math.round(Math.max(extent.width, extent.height) * 0.03));
  const padded = { x: extent.x - room, y: extent.y - room, width: extent.width + room * 2, height: extent.height + room * 2 };
  const width = Math.min(whole.width, Math.max(padded.width, padded.height * aspect, Math.min(frame.width, minWidth)));
  const height = width / aspect;
  const place = (start: number, size: number, frameStart: number, length: number) => (size >= length ? frameStart + (length - size) / 2 : Math.min(frameStart + length - size, Math.max(frameStart, start)));
  return { x: place(padded.x + (padded.width - width) / 2, width, frame.x, frame.width), y: place(padded.y, height, frame.y, frame.height), width, height };
}

/**
 * Which camera suits a frame in a picture of this size: the page as it grows, unless the whole of it would be too
 * small to read; then close to the work. Without the pictures' places, the whole page.
 */
export function autoCamera(frame: ReplayRect, width: number, height: number, growing = false): 'fit' | 'grow' | 'follow' {
  if (Math.min(width / Math.max(1, frame.width), height / Math.max(1, frame.height)) < 0.5) return 'follow';
  return growing ? 'grow' : 'fit';
}

/** One frame of the replay at `t` milliseconds. */
export function replayFrameAt(steps: ReplayStepInfo[], clock: ReplayClock, view: ReplayView, t: number): ReplayFrame {
  const k = replayStepAt(clock, t);
  const after = k + 1 < steps.length ? clock.gaps[k + 1]! : clock.timing.tailMs;
  const fadeMs = Math.max(1, Math.min(240, after * 0.6));
  const fade = k < 0 ? 1 : clamp01((t - clock.at[k]!) / fadeMs);
  const travel = (j: number) => Math.min(650, clock.gaps[j]! * 0.75);
  const startsAt = (j: number) => clock.at[j]! - travel(j);

  // Each person and agent has a cursor, which goes to the next thing it does and rests on the last.
  const cursors: ReplayCursor[] = [];
  const byActor = new Map<string, number[]>();
  steps.forEach((s, j) => {
    const list = byActor.get(s.actor) ?? [];
    list.push(j);
    byActor.set(s.actor, list);
  });
  const positions = new Map<string, { x: number; y: number }>();
  for (const [actor, list] of byActor) {
    const color = replayColor(actor);
    const firstPlaced = list.find((j) => steps[j]!.focus);
    if (firstPlaced === undefined) continue;
    if (t < startsAt(list[0]!)) continue;
    const entry = clickPoint(steps[firstPlaced]!.focus!);
    let from = { x: entry.x + 90, y: entry.y + 70 };
    let position = from;
    let pressed = 0;
    let opacity = 1;
    for (const j of list) {
      const focus = steps[j]!.focus;
      const target = focus ? clickPoint(focus) : from;
      const begin = startsAt(j);
      if (t < begin) break;
      const p = ease((t - begin) / Math.max(1, clock.at[j]! - begin));
      position = { x: mix(from.x, target.x, p), y: mix(from.y, target.y, p) };
      if (j === list[0]) opacity = clamp01((t - begin) / Math.max(1, travel(j) * 0.6));
      pressed = Math.max(pressed, 1 - Math.min(1, Math.abs(t - clock.at[j]!) / 130));
      from = target;
    }
    positions.set(actor, position);
    cursors.push({ actor, color, x: position.x, y: position.y, opacity, pressed });
  }

  // The step under way: from the moment its cursor sets off until the next one does.
  let current = -1;
  for (let j = Math.max(0, k); j < steps.length && j <= k + 1; j++) if (t >= startsAt(j)) current = j;
  let caption: ReplayFrame['caption'] = null;
  let highlight: ReplayFrame['highlight'] = null;
  if (current >= 0) {
    const s = steps[current]!;
    const color = replayColor(s.actor);
    const until = current + 1 < steps.length ? startsAt(current + 1) : clock.duration - clock.timing.tailMs * 0.4;
    const at = positions.get(s.actor);
    const begin = startsAt(current);
    const opacity = Math.min(clamp01((t - begin) / 160), clamp01((until - t) / 160));
    if (at && opacity > 0) caption = { step: current, actor: s.actor, color, ...(s.tool ? { tool: s.tool } : {}), summary: s.summary, x: at.x, y: at.y, opacity };
    if (s.focus) {
      const land = clock.at[current]!;
      const rise = clamp01((t - (land - travel(current) * 0.35)) / Math.max(1, travel(current) * 0.35));
      const hold = Math.min(520, (current + 1 < steps.length ? clock.gaps[current + 1]! : clock.timing.tailMs) * 0.8);
      const fall = 1 - clamp01((t - land - hold) / 200);
      const o = Math.min(rise, fall);
      if (o > 0) highlight = { rect: s.focus, actor: s.actor, color, opacity: o };
    }
  }

  // The camera: the whole frame, the page as far as it is built, or close to the step under way, eased from the one before.
  const whole = fitCamera(view.frame, view.aspect);
  let camera = whole;
  if (view.camera === 'grow' && view.extents?.some(Boolean)) {
    const extents = view.extents;
    // A picture with nothing in it keeps the place of the next one that has something, then of the one before.
    const extentAt = (i: number): ReplayRect => {
      for (let j = i; j < extents.length; j++) if (extents[j]) return extents[j]!;
      for (let j = i; j >= 0; j--) if (extents[j]) return extents[j]!;
      return view.frame;
    };
    const shot = (i: number) => growCamera(extentAt(Math.min(i, extents.length - 1)), view.frame, view.aspect, view.minWidth ?? 1280);
    // Each step makes room as its cursor sets off and settles just after it lands. Moves that overlap at speed
    // blend into one another, since each eases from wherever the one before has got to.
    camera = shot(0);
    for (let j = 0; j < steps.length; j++) {
      const begin = clock.at[j]! - travel(j) * 0.6;
      if (t < begin) break;
      const settle = clock.at[j]! + Math.min(420, (j + 1 < steps.length ? clock.gaps[j + 1]! : clock.timing.tailMs) * 0.7);
      camera = mixRect(camera, shot(j + 1), ease((t - begin) / Math.max(1, settle - begin)));
    }
  } else if (view.camera === 'follow' && steps.length) {
    const shotOf = (j: number): ReplayRect => {
      for (let i = j; i >= 0; i--) if (steps[i]!.focus) return closeCamera(steps[i]!.focus!, view.frame, view.aspect, view.minWidth ?? 1280);
      return whole;
    };
    const tailStart = clock.duration - clock.timing.tailMs;
    if (t >= tailStart) camera = mixRect(shotOf(steps.length - 1), whole, ease((t - tailStart) / Math.max(1, clock.timing.tailMs * 0.6)));
    else {
      const next = Math.min(steps.length - 1, k + 1);
      const begin = startsAt(next);
      const reach = clock.at[next]! - travel(next) * 0.2;
      const was = k >= 0 ? shotOf(k) : whole;
      camera = next > k && t >= begin ? mixRect(was, shotOf(next), ease((t - begin) / Math.max(1, reach - begin))) : was;
    }
  }

  return { t, step: k, top: k + 1, under: fade < 1 && k >= 0 ? k : null, fade, cursors, caption, highlight, camera };
}

/** Every frame at `fps`, from the start to the end. */
export function replayFrames(steps: ReplayStepInfo[], clock: ReplayClock, view: ReplayView, fps: number): ReplayFrame[] {
  const count = Math.max(1, Math.ceil((clock.duration / 1000) * fps));
  const out: ReplayFrame[] = [];
  for (let i = 0; i < count; i++) out.push(replayFrameAt(steps, clock, view, (i * 1000) / fps));
  return out;
}
