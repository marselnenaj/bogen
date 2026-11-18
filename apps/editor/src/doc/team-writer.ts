import type { Y } from '@bogen/core';
import { onServerEvent } from '../lib/events.ts';

/**
 * The Yjs id this tab writes a team file with (teams-1, N6). Members accept a change only when the id it was
 * written with derives from the device that signs it, so the computer hands each tab its own id (and a spare for
 * the next time, kept here, so a phone that opens the file offline still writes with one of this device's ids).
 * When teams are on, the computer also hands out a spare for every team file ahead of time, so a team file the
 * phone has never opened still has one offline. For a file in no team, or with teams off, nothing changes: Yjs's
 * own random id stays.
 */

const spareKey = (file: string) => `bogen.writer.${file}`;
const TEAM_FILES_KEY = 'bogen.teamfiles';
let teamsOn: Promise<boolean> | null = null;
let sparesAsked: Promise<void> | null = null;

function enabled(): Promise<boolean> {
  teamsOn ??= fetch('/api/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { features?: unknown } | null) => Array.isArray(s?.features) && s!.features.includes('teams-1'))
    .catch(() => false);
  return teamsOn;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: the next open asks the computer.
  }
}

function takeSpare(file: string): number | null {
  const raw = read(spareKey(file));
  if (raw === null) return null;
  write(spareKey(file), null);
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function keepSpare(file: string, id: number | null): void {
  write(spareKey(file), id === null ? null : String(id));
}

/** Team files this browser has been told about, so a team file opened offline is known as one. */
function knownTeamFiles(): Set<string> {
  try {
    const list = JSON.parse(read(TEAM_FILES_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : []);
  } catch {
    return new Set();
  }
}
function rememberTeamFile(file: string): void {
  const known = knownTeamFiles();
  if (known.has(file)) return;
  known.add(file);
  write(TEAM_FILES_KEY, JSON.stringify([...known].slice(-2000)));
}

/** A spare for every team file, asked once per page: a team file opened offline later writes with one of them. */
export function fetchSpares(): Promise<void> {
  sparesAsked ??= (async () => {
    if (!(await enabled())) return;
    try {
      const res = await fetch('/api/teams/spares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) return;
      const { spares } = (await res.json()) as { spares?: Record<string, unknown> };
      const files = Object.keys(spares ?? {});
      write(TEAM_FILES_KEY, JSON.stringify(files.slice(-2000)));
      for (const file of files) {
        const id = spares![file];
        if (read(spareKey(file)) === null && typeof id === 'number' && Number.isSafeInteger(id)) keepSpare(file, id);
      }
    } catch {
      // Offline: what was kept last time stays.
    }
  })();
  return sparesAsked;
}

async function ask(file: string): Promise<{ clientID: number | null; spare: number | null; unsent?: number } | null> {
  if (!(await enabled())) return null;
  try {
    const res = await fetch('/api/teams/writer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    if (!res.ok) return null;
    return (await res.json()) as { clientID: number | null; spare: number | null; unsent?: number };
  } catch {
    return null;
  }
}

/** What the editor shows about a team file: changes the computer kept unsent, or a phone that cannot sign yet. */
export interface TeamWriteState {
  /** Changes to this file the computer could not sign and keeps, unsent. */
  unsent: number;
  /** A team file open without one of this device's ids (offline, no spare): edits here wait, unsigned. */
  noId: boolean;
}

let state: { file: string; value: TeamWriteState } | null = null;
const stateListeners = new Set<() => void>();
const EMPTY: TeamWriteState = Object.freeze({ unsent: 0, noId: false });
function setState(file: string, patch: Partial<TeamWriteState>): void {
  const prev = state?.file === file ? state.value : EMPTY;
  const value = { ...prev, ...patch };
  if (prev.unsent === value.unsent && prev.noId === value.noId && state?.file === file) return;
  state = { file, value };
  for (const l of stateListeners) l();
}
export function teamWriteState(file: string | null): TeamWriteState {
  return file && state?.file === file ? state.value : EMPTY;
}
export function onTeamWriteState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => void stateListeners.delete(listener);
}

/** Tries kept changes again (written anew as this device's), or lets them go. */
export async function resolveUnsent(file: string, action: 'retry' | 'drop'): Promise<void> {
  const res = await fetch('/api/teams/unsent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, action }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const { unsent } = (await res.json()) as { unsent: number };
  setState(file, { unsent });
}

export interface TeamWriter {
  /** Settles once this tab knows whether the file is a team file, and has its id if it is. */
  ready: Promise<void>;
  /** Called with the old and new id whenever this tab switches the id it writes with (presence follows). */
  onSwitch(listener: (from: number, to: number) => void): () => void;
  destroy(): void;
}

export function bindTeamWriter(file: string, y: Y.Doc): TeamWriter {
  const assigned = new Set<number>();
  const switchListeners = new Set<(from: number, to: number) => void>();
  let team = knownTeamFiles().has(file);
  let asking: Promise<void> | null = null;
  const use = (id: number) => {
    const from = y.clientID;
    if (from === id) return;
    y.clientID = id;
    for (const l of switchListeners) l(from, id);
  };
  // Before the first transaction: a spare from last time, when there is one.
  const spare = takeSpare(file);
  if (spare !== null) {
    y.clientID = spare;
    assigned.add(spare);
  }
  const refresh = (): Promise<void> => {
    asking ??= ask(file).then((got) => {
      asking = null;
      if (!got) {
        // Offline, or the computer did not answer: a known team file without one of this device's ids cannot be
        // signed yet. Say so; the edits wait on this device and the computer keeps them until they can be.
        if (team && !assigned.has(y.clientID)) setState(file, { noId: true });
        return;
      }
      if (got.clientID === null) {
        team = false;
        setState(file, { noId: false, unsent: 0 });
        return;
      }
      team = true;
      rememberTeamFile(file);
      if (!assigned.has(y.clientID)) use(got.clientID);
      assigned.add(got.clientID);
      if (got.spare !== null) {
        assigned.add(got.spare);
        keepSpare(file, got.spare);
      }
      setState(file, { noId: false, unsent: got.unsent ?? 0 });
      void fetchSpares();
    });
    return asking;
  };
  const ready = refresh();
  // Yjs picks a random id when a remote change advances this tab's own (its "client-id" warning): back to one of
  // this device's.
  const onCleanup = () => {
    if (!team || assigned.has(y.clientID)) return;
    const next = takeSpare(file);
    if (next !== null && assigned.has(next)) use(next);
    void refresh();
  };
  y.on('afterTransactionCleanup', onCleanup);
  const off = onServerEvent((e) => {
    // A file that becomes a team file while open: ask again.
    if (e.t === 'files' && !team) void refresh();
    if (e.t === 'team-unsent' && e.fileId === file) setState(file, { unsent: e.count });
  });
  return {
    ready,
    onSwitch: (listener) => {
      switchListeners.add(listener);
      return () => void switchListeners.delete(listener);
    },
    destroy: () => {
      y.off('afterTransactionCleanup', onCleanup);
      off();
    },
  };
}
