import { useEffect, useSyncExternalStore } from 'react';
import { agentApi, type Race, type RaceLane } from '../lib/agent-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** The races of the open file, as the server keeps them, and the person's choice for the copies not picked. */
interface RaceState { fileId: string | null; races: Race[]; keepBranch: boolean }

let state: RaceState = { fileId: null, races: [], keepBranch: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<RaceState>) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
};

function load(fileId: string): void {
  void agentApi.races(fileId).then((races) => {
    if (editor().fileId === fileId) set({ fileId, races });
  }, () => {});
}

let watching = 0;
let stopWatching: (() => void) | null = null;

/** Races for the file that is open, kept current from `/events`. */
export function useRaces(): RaceState {
  const fileId = useEditor((s) => s.fileId);
  useEffect(() => {
    if (!fileId) return;
    if (state.fileId !== fileId) {
      set({ fileId, races: [] });
      load(fileId);
    }
    watching++;
    stopWatching ??= onServerEvent((e) => {
      if (e.t === 'race' && e.fileId === editor().fileId) load(e.fileId);
    });
    return () => {
      if (--watching === 0) {
        stopWatching?.();
        stopWatching = null;
      }
    };
  }, [fileId]);
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, () => state);
}

export function setKeepBranch(on: boolean): void {
  set({ keepBranch: on });
}

export function raceOf(raceId: string): Race | undefined {
  return state.races.find((r) => r.id === raceId);
}

export function laneOfRun(runId: string): RaceLane | undefined {
  for (const race of state.races) for (const lane of race.lanes) if (lane.runId === runId) return lane;
  return undefined;
}

export function laneLive(lane: RaceLane): boolean {
  return lane.status === 'queued' || lane.status === 'working';
}

export function elapsed(lane: RaceLane, now = Date.now()): string {
  if (!lane.startedAt) return '';
  const s = Math.max(0, Math.round(((lane.endedAt ?? now) - lane.startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What a lane is doing, in a few words. */
export function laneStatus(lane: RaceLane): string {
  if (lane.status === 'queued') return lane.waiting ?? t('Waiting');
  if (lane.status === 'working') return lane.tool ? t('Working · {tool}', { tool: lane.tool }) : t('Starting');
  if (lane.status === 'done') return t('Done · {time}', { time: elapsed(lane) });
  if (lane.status === 'failed') return lane.error ? t('Failed: {error}', { error: lane.error.slice(0, 80) }) : t('Failed');
  return t('Stopped');
}

export async function acceptLane(race: Race, lane: RaceLane): Promise<void> {
  try {
    const out = await agentApi.acceptRace(race.id, lane.id, state.keepBranch ? 'branch' : 'discard', session().user.name);
    editor().set({ selection: [out.nodeId] });
    editor().showToast(out.branch ? t('Accepted {agent}. The others are kept in the branch {branch} of this file: open it from the branch menu next to the file name.', { agent: lane.agent, branch: out.branch.name }) : t('Accepted {agent}. The others were discarded.', { agent: lane.agent }));
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

export async function discardLane(race: Race, lane: RaceLane): Promise<void> {
  try {
    await agentApi.discardRace(race.id, lane.id, session().user.name);
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

export async function stopRace(race: Race, lane?: RaceLane): Promise<void> {
  try {
    await agentApi.stopRace(race.id, lane?.id);
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}
