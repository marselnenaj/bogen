import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BogenDoc, Y } from '@bogen/core';
import type { RunEnd, RunObserver, RunRequest } from './agents.ts';
import type { Renderer } from './render.ts';
import type { RunHistory } from './run-history.ts';
import type { Rooms } from './sync.ts';
import { errorMessage } from './util.ts';

/**
 * What a run changed, for its reply: the layers it touched, by name, and a small picture of the top-level layer
 * most of them sit in, before and after. The state at the start of a run is kept in memory while it runs; the
 * pictures go next to the run history, under `run-shots/<fileId>/`, for the newest runs of each file.
 */

export interface NamedLayer { id: string; name: string; gone?: boolean }

const MAX_NAMED = 24;
const SHOT_SIDE = 320;
const KEEP_SHOTS = 60;
const STORE_KEY = /^[\w-]{1,80}$/;

/** Whether a layer differs between two states of a file. Added and removed count. */
function differs(before: BogenDoc, after: BogenDoc, id: string): boolean {
  const a = before.getNode(id);
  const b = after.getNode(id);
  if (!a || !b) return Boolean(a) !== Boolean(b);
  return JSON.stringify(a) !== JSON.stringify(b) || before.getChildren(id).map((n) => n.id).join() !== after.getChildren(id).map((n) => n.id).join();
}

/** The top-level layer of a page that holds a layer, or the layer itself at the top. */
function topOf(doc: BogenDoc, id: string): string | undefined {
  if (!doc.getNode(id)) return undefined;
  return [id, ...doc.ancestors(id)].at(-1);
}

/** The layers a run changed, with names, newest state first, and where most of them are. */
export function changedLayers(before: BogenDoc, after: BogenDoc, touched: string[]): { named: NamedLayer[]; top?: string } {
  const named: NamedLayer[] = [];
  const tops = new Map<string, number>();
  for (const id of touched) {
    if (!differs(before, after, id)) continue;
    const now = after.getNode(id);
    const then = before.getNode(id);
    if (named.length < MAX_NAMED) named.push({ id, name: (now ?? then)!.name, ...(now ? {} : { gone: true }) });
    const top = topOf(after, id) ?? topOf(before, id);
    if (top) tops.set(top, (tops.get(top) ?? 0) + 1);
  }
  const top = [...tops].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { named, ...(top ? { top } : {}) };
}

export class RunSummaries implements RunObserver {
  private starts = new Map<string, { fileId: string; state: Uint8Array }>();

  constructor(private readonly deps: { home: string; rooms: Rooms; renderer: Renderer; history: RunHistory }) {}

  private dir(fileId: string): string {
    if (!STORE_KEY.test(fileId)) throw new Error('Not a file key.');
    return join(this.deps.home, 'run-shots', fileId);
  }

  shotPath(fileId: string, runId: string, which: 'before' | 'after'): string {
    if (!STORE_KEY.test(runId)) throw new Error('Not a run id.');
    return join(this.dir(fileId), `${runId}-${which}.webp`);
  }

  started(runId: string, req: RunRequest): void {
    if (req.live) return;
    const room = this.deps.rooms.peek(req.fileId);
    if (room) this.starts.set(runId, { fileId: req.fileId, state: Y.encodeStateAsUpdate(room.doc.y) });
    else void this.deps.rooms.get(req.fileId).then((r) => this.starts.set(runId, { fileId: req.fileId, state: Y.encodeStateAsUpdate(r.doc.y) }), () => {});
  }

  event(): void {}

  ended(end: RunEnd): void {
    // After the history has its layers: activity reaches it as it happens, and this runs after the end is noted.
    const start = this.starts.get(end.runId);
    this.starts.delete(end.runId);
    if (start) void this.summarize(end, start.state).catch((e) => console.error(`bogen: no summary for run ${end.runId}: ${errorMessage(e)}`));
  }

  private async summarize(end: RunEnd, state: Uint8Array): Promise<void> {
    const { rooms, renderer, history } = this.deps;
    const record = await history.get(end.fileId, end.runId);
    if (!record?.layers.length) return;
    const room = await rooms.get(end.fileId);
    const before = new BogenDoc();
    Y.applyUpdate(before.y, state);
    const { named, top } = changedLayers(before, room.doc, record.layers);
    if (!named.length) return;
    history.noteSummary(end.fileId, end.runId, { named });
    if (!top) return;
    // Every touched layer is hidden before and after: nothing to see, whatever two renders of the same picture come out as.
    const unseen = (doc: BogenDoc, id: string) => !doc.getNode(id) || [id, ...doc.ancestors(id)].some((a) => doc.getNode(a)?.hidden);
    if (record.layers.every((id) => unseen(before, id) && unseen(room.doc, id))) return;
    let shots: { before?: Uint8Array; after?: Uint8Array } = {};
    try {
      const shoot = async (doc: BogenDoc) => (doc.getNode(top) && !doc.getNode(top)!.hidden ? (await renderer.screenshot(doc, { nodeIds: [top] }, { format: 'webp', scale: 1, maxDimension: SHOT_SIDE, quality: 80 })).bytes : undefined);
      shots = { before: await shoot(before), after: await shoot(room.doc) };
    } catch {
      // No browser here: the reply names the layers, without pictures.
      return;
    }
    // Nothing to see: the change was in a hidden layer, in a name, or out of the picture.
    if (!shots.before && !shots.after) return;
    if (shots.before && shots.after && Buffer.from(shots.before).equals(Buffer.from(shots.after))) return;
    await mkdir(this.dir(end.fileId), { recursive: true });
    if (shots.before) await writeFile(this.shotPath(end.fileId, end.runId, 'before'), shots.before, { mode: 0o600 });
    if (shots.after) await writeFile(this.shotPath(end.fileId, end.runId, 'after'), shots.after, { mode: 0o600 });
    history.noteSummary(end.fileId, end.runId, { shots: { nodeId: top, before: Boolean(shots.before), after: Boolean(shots.after) } });
    await this.prune(end.fileId);
  }

  /** Pictures of the newest runs stay. */
  private async prune(fileId: string): Promise<void> {
    const dir = this.dir(fileId);
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.length <= KEEP_SHOTS * 2) return;
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.at - a.at);
    await Promise.all(dated.slice(KEEP_SHOTS * 2).map((f) => rm(join(dir, f.name), { force: true })));
  }

  async shot(fileId: string, runId: string, which: 'before' | 'after'): Promise<Uint8Array | null> {
    return readFile(this.shotPath(fileId, runId, which)).catch(() => null);
  }

  async forget(fileId: string): Promise<void> {
    await rm(this.dir(fileId), { recursive: true, force: true }).catch(() => {});
  }
}
