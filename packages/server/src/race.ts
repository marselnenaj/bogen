import { LANE_COLORS } from '@bogen/core';
import type { RunLanguageChoice } from '@bogen/core';
import { acceptProposal, createProposals, discardProposal, listProposals, newId, rectFromStyle, variationNote, type Variation } from '@bogen/core';
import type { RunEnd, RunnerId, Runs } from './agents.ts';
import type { EventHub } from './events.ts';
import { copiedIds, proposalBoxes } from './mcp/tools-proposals.ts';
import type { Renderer } from './render.ts';
import type { RunChoice } from './run-settings.ts';
import type { Storage } from './storage.ts';
import type { Rooms } from './sync.ts';
import { errorMessage, HttpError } from './util.ts';

/** One colour per lane, the same on its label, its outline and its cursor. */
export { LANE_COLORS } from '@bogen/core';
const MIN_LANES = 2;
/** Races kept per file, for an editor that opens midway. They are notes about runs, not part of the document. */
const KEEP_PER_FILE = 10;
const STOP_WAIT_MS = 5000;

export interface LaneSpec { runner: RunnerId; model?: string; effort?: string }
export type LaneStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';

export interface Lane {
  id: string;
  runner: RunnerId;
  model?: string;
  effort?: string;
  /** The name it works under: its cursor, its undo in the Agents tab, the label on its copy. */
  agent: string;
  color: string;
  proposalId: string;
  status: LaneStatus;
  /** Why it waits, while it is queued. */
  waiting?: string;
  runId?: string;
  tool?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** What the person did with its copy. */
  decision?: 'accepted' | 'discarded';
  /** In a split race: the sections of the page this lane works on, each with its copy. */
  sections?: { original: string; proposalId: string; name: string }[];
}

export interface Race {
  id: string;
  fileId: string;
  pageId: string;
  nodeId: string;
  prompt: string;
  at: number;
  /** The design language the person chose for this race. */
  language?: RunLanguageChoice;
  /** How far the lanes go, and which aspects they change. */
  variation?: Variation;
  /** The lanes take sections of the page instead of a copy each of all of it. */
  split?: boolean;
  lanes: Lane[];
  /** Set once the person picked a lane, or dropped them all. */
  decided?: { laneId?: string; at: number; branch?: { id: string; name: string; fileId?: string; internal?: boolean } };
}

export interface RaceStart {
  fileId: string; pageId?: string; nodeId: string; prompt: string; lanes: LaneSpec[]; who: string;
  /** The design content language every lane writes in, over the file's. */ language?: RunLanguageChoice;
  /** The range and the aspects every lane keeps to. */ variation?: Variation;
  /** Each lane takes sections of the layer (its visible children) instead of a copy of all of it. */ split?: boolean;
}

/** The sections of a page, in order, shared out over the lanes in runs next to each other: 5 over 3 is 2, 2 and 1. */
export function splitSections<T>(sections: T[], lanes: number): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < lanes; i++) {
    const size = Math.floor(sections.length / lanes) + (i < sections.length % lanes ? 1 : 0);
    out.push(sections.slice(at, at + size));
    at += size;
  }
  return out;
}

interface Deps {
  rooms: Rooms;
  runs: Runs;
  hub: EventHub;
  storage: Storage;
  renderer: Renderer;
  /** What a lane really runs with: what was picked, then the saved choice for the prompt. */
  choice: (runner: RunnerId, asked: RunChoice) => Promise<RunChoice>;
  /** How many runs of one runner may go at once, from the run settings. */
  limit: (runner: RunnerId) => number;
  /** Keeps the copies that were not picked, as a branch inside the file (not a file of its own). */
  branch: (fileId: string, name: string) => Promise<{ id: string; name: string; fileId?: string; internal?: boolean }>;
  /** The request goes with the decision about each copy. */
  noteOrigin: (fileId: string, proposalId: string, origin: { request: string; runner: string; model?: string }) => void;
  /** Measures the copies for the record of the decision, before the decision removes them. */
  beforeDecision: (fileId: string) => void;
}

/** Names an agent can go by: they reach headers and awareness. */
function cleanName(raw: string): string {
  return raw.replace(/[^\w .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'agent';
}

/** `claude sonnet`, `codex gpt-6`; a second lane of the same gets ` 2`. */
export function laneNames(specs: LaneSpec[]): string[] {
  const names: string[] = [];
  for (const spec of specs) {
    const base = cleanName(`${spec.runner}${spec.model ? ` ${spec.model}` : ''}`).slice(0, 36);
    let name = base;
    for (let n = 2; names.includes(name); n++) name = `${base} ${n}`;
    names.push(name);
  }
  return names;
}

const live = (lane: Lane): boolean => lane.status === 'queued' || lane.status === 'working';

/**
 * Several runs on one request at the same time, each in its own proposal next to the original. The person
 * compares them and accepts one, which discards the others, or keeps them in a branch.
 */
export class Races {
  private races = new Map<string, Race>();
  private closed = false;
  private pumping: Promise<void> = Promise.resolve();

  constructor(private readonly deps: Deps) {}

  list(fileId: string): Race[] {
    return [...this.races.values()].filter((r) => r.fileId === fileId).sort((a, b) => b.at - a.at);
  }

  /** Races over all files, newest first. */
  all(): Race[] {
    return [...this.races.values()].sort((a, b) => b.at - a.at);
  }

  get(raceId: string): Race | undefined {
    return this.races.get(raceId);
  }

  async start(input: RaceStart): Promise<Race> {
    const { rooms, runs, storage } = this.deps;
    if (input.lanes.length < MIN_LANES) throw new HttpError(400, `A race needs at least ${MIN_LANES} runs.`);
    // Each lane works in its own copy, so none of them can add a language version: say so before any copy exists.
    if (input.language?.mode === 'add') throw new HttpError(400, 'A race of directions cannot add a language version: that is a branch of the whole design, made by Change it. Nothing was started. Choose Translate to translate in each copy, or Change it to add the version.');
    if (input.lanes.length > runs.limit) throw new HttpError(400, `At most ${runs.limit} runs can go at once, so a race has at most ${runs.limit} lanes.`);
    if (runs.activeFor(input.fileId)) throw new HttpError(409, 'A run is already going on this file. Wait for it to finish, or stop it.');
    if (this.list(input.fileId).some((r) => r.lanes.some((l) => l.status === 'queued' || l.status === 'working'))) throw new HttpError(409, 'A race is already going on this file. Stop it, or wait for it.');
    const entry = storage.get(input.fileId);
    if (!entry) throw new HttpError(404, 'No such file.');
    const room = await rooms.get(input.fileId);
    const { doc } = room;
    const node = doc.getNode(input.nodeId);
    if (!node) throw new HttpError(400, `No layer with id ${input.nodeId}.`);
    if (node.locked) throw new HttpError(400, 'That layer is locked.');
    const pageId = doc.pageOf(input.nodeId);
    if (!pageId) throw new HttpError(400, 'That layer is not on a page.');

    const raceId = newId(8);
    const names = laneNames(input.lanes);
    const lanes: Omit<Lane, 'proposalId'>[] = input.lanes.map((spec, i) => ({
      id: `l${i + 1}`, runner: spec.runner, ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}),
      agent: names[i]!, color: LANE_COLORS[i % LANE_COLORS.length]!, status: 'queued',
    }));
    const variation = input.variation;
    const note = (agent: string) => (variation ? `${agent} · ${variationNote(variation)}` : agent);
    let ids: string[];
    let sections: Lane['sections'][] | undefined;
    if (input.split) {
      const parts = doc.getChildren(input.nodeId).filter((n) => !n.hidden);
      if (parts.length < lanes.length) throw new HttpError(400, `"${node.name}" has ${parts.length} section${parts.length === 1 ? '' : 's'}, fewer than the ${lanes.length} runs. Start fewer runs, or race copies of the whole page.`);
      const shares = splitSections(parts, lanes.length);
      // Each section's copy goes next to the page, clear of the copies made before it.
      const boxes = new Map<string, Awaited<ReturnType<typeof proposalBoxes>>>();
      for (const part of parts) boxes.set(part.id, await proposalBoxes(this.deps.renderer, room, part.id, pageId));
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      try {
        sections = doc.transact(() => shares.map((share, i) => share.map((part) => {
          const lane = lanes[i]!;
          const box = boxes.get(part.id) ?? {};
          const others = box.others ? [...box.others, ...placed] : undefined;
          const [id] = createProposals(doc, part.id, { by: lane.agent, count: 1, notes: [note(lane.agent)], lanes: [{ by: lane.agent, race: { id: raceId, lane: lane.id, color: lane.color } }], ...(variation ? { variation } : {}), ...(box.rect ? { rect: box.rect } : {}), ...(others ? { others } : {}) });
          const made = doc.getNode(id!);
          if (made) placed.push(rectFromStyle(made));
          return { original: part.id, proposalId: id!, name: part.name };
        })), `person:${input.who}`);
      } catch (e) {
        throw new HttpError(400, errorMessage(e));
      }
      ids = sections.map((list) => list![0]!.proposalId);
    } else {
      const measured = await proposalBoxes(this.deps.renderer, room, input.nodeId, pageId);
      try {
        ids = doc.transact(() => createProposals(doc, input.nodeId, {
          by: lanes[0]!.agent, count: lanes.length, notes: lanes.map((l) => note(l.agent)),
          lanes: lanes.map((l) => ({ by: l.agent, race: { id: raceId, lane: l.id, color: l.color } })),
          ...(variation ? { variation } : {}),
          ...measured, ...(measured.rect ? {} : { rect: rectFromStyle(node) }),
        }), `person:${input.who}`);
      } catch (e) {
        throw new HttpError(400, errorMessage(e));
      }
    }
    const race: Race = {
      id: raceId, fileId: input.fileId, pageId, nodeId: input.nodeId, prompt: input.prompt, at: Date.now(), ...(input.language ? { language: input.language } : {}),
      ...(variation ? { variation } : {}), ...(input.split ? { split: true } : {}),
      lanes: lanes.map((l, i) => ({ ...l, proposalId: ids[i]!, ...(sections ? { sections: sections[i]! } : {}) })),
    };
    for (const lane of race.lanes) {
      rooms.agentColors.set(lane.agent, lane.color);
      for (const id of lane.sections?.map((x) => x.proposalId) ?? [lane.proposalId]) this.deps.noteOrigin(input.fileId, id, { request: input.prompt, runner: lane.runner, ...(lane.model ? { model: lane.model } : {}) });
    }
    this.races.set(raceId, race);
    this.trim(input.fileId);
    this.changed(race);
    await this.pump();
    return race;
  }

  /** Starts what can start: a lane waits while its runner, or the server, has no free slot. One pass at a time. */
  pump(): Promise<void> {
    this.pumping = this.pumping.then(() => this.pumpNow(), () => this.pumpNow());
    return this.pumping;
  }

  private async pumpNow(): Promise<void> {
    if (this.closed) return;
    const { runs } = this.deps;
    for (const race of [...this.races.values()].sort((a, b) => a.at - b.at)) {
      for (const lane of race.lanes) {
        if (lane.status !== 'queued') continue;
        const limit = this.deps.limit(lane.runner);
        const waiting = runs.count() >= runs.limit ? `Waiting: ${runs.limit} runs are going` : runs.count(lane.runner) >= limit ? `Waiting for a free ${lane.runner}: ${limit} at once` : undefined;
        if (waiting) {
          if (lane.waiting !== waiting) {
            lane.waiting = waiting;
            this.changed(race);
          }
          continue;
        }
        await this.startLane(race, lane);
      }
    }
  }

  private async startLane(race: Race, lane: Lane): Promise<void> {
    lane.status = 'working';
    delete lane.waiting;
    lane.startedAt = Date.now();
    this.changed(race);
    try {
      const room = await this.deps.rooms.get(race.fileId);
      if (!room.doc.getNode(lane.proposalId)) throw new Error('Its copy is gone.');
      const choice = await this.deps.choice(lane.runner, { ...(lane.model ? { model: lane.model } : {}), ...(lane.effort ? { effort: lane.effort } : {}) });
      const others = race.lanes.length - 1;
      const copies = lane.sections ?? [{ original: race.nodeId, proposalId: lane.proposalId, name: '' }];
      const layers = Object.assign({}, ...copies.map((x) => copiedIds(room.doc, x.original, x.proposalId))) as Record<string, string>;
      const otherSections = lane.sections ? race.lanes.filter((l) => l.id !== lane.id).flatMap((l) => (l.sections ?? []).map((x) => `"${x.name}"`)) : undefined;
      const runId = await this.deps.runs.start({
        fileId: race.fileId, fileName: this.deps.storage.get(race.fileId)?.name ?? race.fileId, pageId: race.pageId, nodeIds: copies.map((x) => x.proposalId),
        prompt: race.prompt, title: race.prompt, runner: lane.runner, agent: lane.agent, review: 'directions',
        race: { raceId: race.id, laneId: lane.id, proposalId: lane.proposalId, layers, others, ...(lane.sections ? { sections: lane.sections, otherSections: otherSections! } : {}) },
        ...(race.language ? { language: race.language } : {}), ...(race.variation ? { variation: race.variation } : {}),
        ...choice,
      }, { onTool: (_id, tool) => { lane.tool = tool; this.changed(race); } });
      // A stop that came while it was starting.
      if (lane.status !== 'working') this.deps.runs.stop(runId);
      lane.runId = runId;
    } catch (e) {
      lane.status = 'failed';
      lane.error = errorMessage(e);
      lane.endedAt = Date.now();
    }
    this.changed(race);
  }

  /** Every run on the server ends here: a lane is done, and its slot may let another start. */
  runEnded(end: RunEnd): void {
    if (this.closed) return;
    for (const race of this.races.values()) {
      const lane = race.lanes.find((l) => l.runId === end.runId);
      if (!lane) continue;
      lane.status = end.status;
      lane.endedAt = Date.now();
      delete lane.tool;
      if (end.error) lane.error = end.error.slice(0, 500);
      this.changed(race);
      this.releaseColors(race);
    }
    void this.pump();
  }

  /** Once its lanes are over, their names go back to their usual cursor colour, unless another race still uses one. */
  private releaseColors(race: Race): void {
    if (race.lanes.some(live)) return;
    const inUse = new Set([...this.races.values()].flatMap((r) => r.lanes.filter(live).map((l) => l.agent)));
    for (const lane of race.lanes) if (!inUse.has(lane.agent)) this.deps.rooms.agentColors.delete(lane.agent);
  }

  /** Stops one lane, or all of them. A lane that has not started yet just does not start. */
  stop(raceId: string, laneId?: string): Lane[] {
    const race = this.require(raceId);
    const stopped: Lane[] = [];
    for (const lane of race.lanes) {
      if (laneId && lane.id !== laneId) continue;
      if (lane.status === 'queued') {
        lane.status = 'stopped';
        lane.endedAt = Date.now();
        stopped.push(lane);
      } else if (lane.status === 'working') {
        if (lane.runId) this.deps.runs.stop(lane.runId);
        else lane.status = 'stopped';
        stopped.push(lane);
      }
    }
    if (laneId && !stopped.length && !race.lanes.some((l) => l.id === laneId)) throw new HttpError(404, 'No such lane in this race.');
    this.changed(race);
    this.releaseColors(race);
    return stopped;
  }

  /**
   * The person's pick. Every lane still working stops first, the picked one included, so that nothing writes
   * into the original after its copy went in. With `keep: 'branch'` the file is branched before, with all copies in it.
   */
  async accept(raceId: string, laneId: string, options: { keep: 'discard' | 'branch'; who: string }): Promise<{ nodeId: string; discarded: string[]; branch?: { id: string; name: string; fileId?: string; internal?: boolean } }> {
    const race = this.require(raceId);
    const lane = race.lanes.find((l) => l.id === laneId);
    if (!lane) throw new HttpError(404, 'No such lane in this race.');
    const room = await this.deps.rooms.get(race.fileId);
    if (!listProposals(room.doc).some((p) => p.id === lane.proposalId)) throw new HttpError(409, 'That copy is gone: accepted, discarded, or deleted.');
    if (race.split) return this.acceptSections(race, lane, options.who);
    this.stop(raceId);
    await this.settled(race);
    this.deps.beforeDecision(race.fileId);
    const branch = options.keep === 'branch' ? await this.deps.branch(race.fileId, `race: ${race.prompt.replace(/\s+/g, ' ').slice(0, 48)} · ${race.id}`.slice(0, 80)) : undefined;
    let result: { sourceId: string; discarded: string[] };
    try {
      result = room.doc.transact(() => acceptProposal(room.doc, lane.proposalId), `person:${options.who}`);
    } catch (e) {
      throw new HttpError(409, errorMessage(e));
    }
    for (const l of race.lanes) l.decision = l.id === laneId ? 'accepted' : result.discarded.includes(l.proposalId) ? 'discarded' : l.decision;
    race.decided = { laneId, at: Date.now(), ...(branch ? { branch } : {}) };
    this.changed(race);
    return { nodeId: result.sourceId, discarded: result.discarded, ...(branch ? { branch } : {}) };
  }

  /**
   * In a split race the lanes made different sections, so taking one lane's sections in leaves the others: that
   * lane stops first, each of its copies goes into its section, and the race is decided once every lane is.
   */
  private async acceptSections(race: Race, lane: Lane, who: string): Promise<{ nodeId: string; discarded: string[] }> {
    this.stop(race.id, lane.id);
    await this.settled(race);
    this.deps.beforeDecision(race.fileId);
    const room = await this.deps.rooms.get(race.fileId);
    const open = new Set(listProposals(room.doc).map((p) => p.id));
    let nodeId = '';
    try {
      room.doc.transact(() => {
        for (const part of lane.sections ?? []) {
          if (!open.has(part.proposalId)) continue;
          const { sourceId } = acceptProposal(room.doc, part.proposalId);
          nodeId ||= sourceId;
        }
      }, `person:${who}`);
    } catch (e) {
      throw new HttpError(409, errorMessage(e));
    }
    lane.decision = 'accepted';
    if (race.lanes.every((l) => l.decision)) race.decided = { at: Date.now() };
    this.changed(race);
    return { nodeId: nodeId || race.nodeId, discarded: [] };
  }

  /** Drops one lane's copy, stopping its run first. */
  async discard(raceId: string, laneId: string, who: string): Promise<void> {
    const race = this.require(raceId);
    const lane = race.lanes.find((l) => l.id === laneId);
    if (!lane) throw new HttpError(404, 'No such lane in this race.');
    this.stop(raceId, laneId);
    const room = await this.deps.rooms.get(race.fileId);
    this.deps.beforeDecision(race.fileId);
    const copies = lane.sections?.map((x) => x.proposalId) ?? [lane.proposalId];
    room.doc.transact(() => { for (const id of copies) if (room.doc.getNode(id)) discardProposal(room.doc, id); }, `person:${who}`);
    lane.decision = 'discarded';
    if (race.split ? race.lanes.every((l) => l.decision) : race.lanes.every((l) => l.decision === 'discarded')) race.decided = { at: Date.now() };
    this.changed(race);
  }

  /** Waits a moment for stopped runs to end. */
  private async settled(race: Race): Promise<void> {
    const until = Date.now() + STOP_WAIT_MS;
    while (race.lanes.some((l) => l.status === 'working' && l.runId && this.deps.runs.isActive(l.runId)) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private require(raceId: string): Race {
    const race = this.races.get(raceId);
    if (!race) throw new HttpError(404, 'No such race. Races are kept while the server runs; the copies stay on the canvas as proposals.');
    return race;
  }

  private trim(fileId: string): void {
    for (const old of this.list(fileId).slice(KEEP_PER_FILE)) this.races.delete(old.id);
  }

  private changed(race: Race): void {
    this.deps.hub.broadcast({ t: 'race', fileId: race.fileId, raceId: race.id });
  }

  forget(fileId: string): void {
    for (const race of this.list(fileId)) this.races.delete(race.id);
  }

  close(): void {
    this.closed = true;
  }
}
