import { create } from 'zustand';
import { api } from '../lib/api.ts';
import { collabApi } from '../lib/collab-api.ts';
import { onEventsReconnect, onServerEvent } from '../lib/events.ts';
import { onSessionsChanged, parkedFiles, parkedSession, sleep, sleepAll, sleepPolicy, watchPending } from '../doc/session-cache.ts';
import { maybeSession, type Session } from '../doc/session.ts';
import type { LeftTab, RightTab } from '../state/store.ts';

/**
 * Files open as tabs in this window, Home first. The list lives in this browser (all Bogen windows of it share it),
 * the open tab is the address: `#/file/<id>`. Opening a file anywhere (Home, a link, `bogen open`) adds its tab.
 */

/** `folder` and `kept` (a kept theme copy) tell look-alike names apart (tab-names.ts). */
export interface FileTab { id: string; name: string; folder?: string; kept?: boolean }
/** What a tab remembers of how it was left, beyond the page and view the editor keeps per file anyway. */
export interface TabView { selection: string[]; leftTab: LeftTab; rightTab: RightTab; activeThreadId: string | null }
/** What happens in a file, for its tab. */
export interface TabMarks {
  /** An agent works in it: who, when known. */
  working?: string;
  /** Its live session lost the server. */
  offline?: boolean;
  /** Edits wait for the server. */
  pending?: boolean;
  /** Another person or device in it: the first letter, and who. */
  peer?: { letter: string; name: string };
  /** The file is loaded (in view, or awake behind another tab). */
  awake?: boolean;
}

interface TabsState {
  tabs: FileTab[];
  /** The tab in view: a file id, or null for Home and other screens. */
  active: string | null;
  marks: Record<string, TabMarks>;
}

const KEY = 'bogen-tabs';
const ID = /^[\w-]{1,64}$/;

function readStored(): FileTab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.flatMap((t) => {
      const id = typeof t?.id === 'string' && ID.test(t.id) ? canonicalId(t.id as string) : null;
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{
        id, name: typeof t.name === 'string' ? t.name.slice(0, 200) : '',
        ...(typeof t.folder === 'string' && t.folder ? { folder: t.folder.slice(0, 200) } : {}),
        ...(t.kept === true ? { kept: true } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function store(tabs: FileTab[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(tabs)); } catch { /* private mode: tabs last for this window only */ }
}

export const useTabs = create<TabsState>(() => ({ tabs: readStored(), active: null, marks: {} }));
const set = (patch: Partial<TabsState>) => useTabs.setState(patch);
const get = () => useTabs.getState();

function setTabs(tabs: FileTab[]): void {
  set({ tabs });
  store(tabs);
}

/**
 * File ids are made of lower-case letters and digits (`newId`), so an address that spells one in capitals means the
 * same file and the same tab.
 */
function canonicalId(id: string): string {
  return id.toLowerCase();
}

/**
 * The file a hash opens in the editor, or null: the one tab key of every route into a file (`#/file/<id>`, with
 * `?page=`, `?select=`, `?layer=`, `?version=`, `/thread/<id>` or a trailing slash). A full-screen preview is not a
 * tab of its own.
 */
export function fileOfHash(hash: string): string | null {
  if (/^#\/file\/[\w-]+\/preview/.test(hash)) return null;
  const id = /^#\/file\/([\w-]+)(?=$|[/?#])/.exec(hash)?.[1];
  return id && ID.test(id) ? canonicalId(id) : null;
}

/** The same address with the file id spelled as the tab key spells it, or null when it already is. */
export function canonicalHash(hash: string): string | null {
  const m = /^#\/file\/([\w-]+)/.exec(hash);
  if (!m || m[1] === canonicalId(m[1]!)) return null;
  return `#/file/${canonicalId(m[1]!)}${hash.slice(m[0].length)}`;
}

/** Adds a file's tab after the open one, or at the end, if it is not there yet. */
export function ensureTab(id: string, name = ''): void {
  if (!ID.test(id)) return;
  id = canonicalId(id);
  const { tabs, active } = get();
  const at = tabs.findIndex((t) => t.id === id);
  if (at >= 0) {
    if (name && tabs[at]!.name !== name) setTabs(tabs.map((t) => (t.id === id ? { ...t, name } : t)));
    return;
  }
  const after = active ? tabs.findIndex((t) => t.id === active) : -1;
  const next = [...tabs];
  next.splice(after >= 0 ? after + 1 : next.length, 0, { id, name });
  setTabs(next);
  // A tab opened after the names were fetched (a link, the call moving files, a new file) asks for its name.
  if (!name) scheduleNames();
}

// ---------------------------------------------------------------- names

/** What the tabs need of a file: its name, and what tells it from another of the same name. */
export interface FileFacts { id: string; name: string; folder?: string; theme?: { consolidatedInto?: { fileId: string } } }

let lookup: (() => Promise<FileFacts[]>) | null = null;
let namesTimer: ReturnType<typeof setTimeout> | null = null;

/** Where the file names come from: the server's file list in the app, a stand-in in tests. */
export function setFileLookup(fn: (() => Promise<FileFacts[]>) | null): void {
  lookup = fn;
}

/** Brings every tab's name up to date and drops tabs of deleted files, unless the file is the one in view. */
export async function refreshTabNames(): Promise<void> {
  if (!lookup) return;
  try {
    const files = await lookup();
    const byId = new Map(files.map((f) => [f.id, f]));
    const facts = (t: FileTab): FileTab => {
      const f = byId.get(t.id);
      if (!f) return t;
      const into = f.theme?.consolidatedInto?.fileId;
      return { id: t.id, name: f.name, ...(f.folder ? { folder: f.folder } : {}), ...(into && into !== f.id && byId.has(into) ? { kept: true } : {}) };
    };
    const { tabs } = get();
    const kept = tabs.filter((t) => byId.has(t.id) || t.id === get().active).map(facts);
    if (JSON.stringify(kept) !== JSON.stringify(tabs)) setTabs(kept);
  } catch { /* offline: the stored names stay */ }
}

function scheduleNames(): void {
  if (!lookup || namesTimer) return;
  namesTimer = setTimeout(() => { namesTimer = null; void refreshTabNames(); }, 50);
}

/** Opens a file in its tab. */
export function openTab(id: string): void {
  ensureTab(id);
  if (fileOfHash(location.hash) !== id) location.hash = `#/file/${id}`;
}

export function openHome(): void {
  if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
}

/** Closes a tab: its file stops loading at once. The tab in view goes to its right-hand neighbour, else left, else Home. */
export function closeTab(id: string): void {
  const { tabs, active } = get();
  const at = tabs.findIndex((t) => t.id === id);
  if (at < 0) return;
  const next = tabs.filter((t) => t.id !== id);
  setTabs(next);
  forgetView(id);
  sleep(id);
  if (active === id) {
    const neighbour = next[at] ?? next[at - 1];
    if (neighbour) location.hash = `#/file/${neighbour.id}`;
    else location.hash = '#/';
  }
}

/** Closes every tab but one. */
export function closeOthers(id: string): void {
  for (const t of get().tabs) if (t.id !== id) closeTab(t.id);
}

/** Moves a tab to a place in the list (0 is the first file tab). */
export function moveTab(id: string, to: number): void {
  const tabs = [...get().tabs];
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab!);
  setTabs(tabs);
}

/** Moves the open tab one place left or right. */
export function nudgeActive(step: -1 | 1): void {
  const { tabs, active } = get();
  const at = tabs.findIndex((t) => t.id === active);
  if (at < 0) return;
  moveTab(active!, at + step);
}

/** Every tab in order, Home first, as ids (null for Home). */
function order(): (string | null)[] {
  return [null, ...get().tabs.map((t) => t.id)];
}

function go(id: string | null): void {
  if (id) openTab(id);
  else openHome();
}

/** The next or previous tab, round. */
export function cycleTab(step: -1 | 1): void {
  const all = order();
  const at = Math.max(0, all.indexOf(get().active));
  go(all[(at + step + all.length) % all.length]!);
}

/** The tab at a place, 1 being Home; 9 is always the last. */
export function tabAt(n: number): void {
  const all = order();
  go(n >= 9 || n > all.length ? all[all.length - 1]! : all[n - 1]!);
}

// ---------------------------------------------------------------- the view each tab keeps

const views = new Map<string, TabView>();

export function saveView(fileId: string, view: TabView): void {
  views.set(fileId, view);
}

export function takeView(fileId: string): TabView | undefined {
  const v = views.get(fileId);
  views.delete(fileId);
  return v;
}

function forgetView(fileId: string): void {
  views.delete(fileId);
}

// ---------------------------------------------------------------- what happens in each file

const runs = new Map<string, string>();
const lastActivity = new Map<string, { at: number; agent: string }>();
const ACTIVITY_MS = 4000;

function mark(fileId: string, patch: Partial<TabMarks>): void {
  const marks = get().marks;
  const prev = marks[fileId] ?? {};
  const next = { ...prev, ...patch };
  for (const k of Object.keys(next) as (keyof TabMarks)[]) if (next[k] === undefined || next[k] === false) delete next[k];
  if (JSON.stringify(prev) === JSON.stringify(next)) return;
  set({ marks: { ...marks, [fileId]: next } });
}

function refreshWorking(): void {
  const now = Date.now();
  const files = new Set<string>([...get().tabs.map((t) => t.id), ...Object.keys(get().marks)]);
  for (const id of files) {
    const run = runs.get(id);
    const act = lastActivity.get(id);
    const who = run ?? (act && now - act.at < ACTIVITY_MS ? act.agent : undefined);
    mark(id, { working: who });
  }
}

async function loadRuns(): Promise<void> {
  try {
    const q = await collabApi.queue();
    runs.clear();
    for (const r of q.running) runs.set(r.fileId, r.agent ?? r.runner);
    refreshWorking();
  } catch { /* no server: nothing works anywhere */ }
}

/** Live sessions: the one in view and the parked ones, watched for connection, pending edits and other people. */
const watched = new Map<Session, () => void>();

function watchSession(s: Session): () => void {
  const fileId = s.fileId;
  const onStatus = () => mark(fileId, { offline: !s.provider.wsconnected && s.provider.shouldConnect });
  const offPending = watchPending(s, (pending) => mark(fileId, { pending }));
  const onPeers = () => {
    const mine = s.y.clientID;
    let peer: TabMarks['peer'];
    for (const [id, st] of s.provider.awareness.getStates()) {
      const user = (st as { user?: { name?: string; agent?: boolean; device?: string } }).user;
      if (id === mine || !user?.name || user.agent) continue;
      const name = user.device ? `${user.name} (${user.device})` : user.name;
      peer = { letter: (user.device ?? user.name).trim()[0]?.toUpperCase() ?? '?', name };
      break;
    }
    mark(fileId, { peer });
  };
  s.provider.on('status', onStatus);
  s.provider.awareness.on('change', onPeers);
  onStatus();
  onPeers();
  return () => {
    s.provider.off('status', onStatus);
    s.provider.awareness.off('change', onPeers);
    offPending();
  };
}

function syncWatched(): void {
  const live = new Set<Session>();
  const cur = maybeSession();
  if (cur) live.add(cur);
  for (const id of parkedFiles()) {
    const s = parkedSession(id);
    if (s) live.add(s);
  }
  for (const [s, off] of watched) {
    if (!live.has(s)) {
      off();
      watched.delete(s);
      mark(s.fileId, { offline: undefined, pending: undefined, peer: undefined });
    }
  }
  for (const s of live) if (!watched.has(s)) watched.set(s, watchSession(s));
  const awake = new Set([...live].map((s) => s.fileId));
  for (const t of get().tabs) mark(t.id, { awake: awake.has(t.id) });
}

/** Called by the editor when its session changes, so the marks follow it. */
export function sessionsChanged(): void {
  queueMicrotask(syncWatched);
}

// ---------------------------------------------------------------- names and the address

let started = false;

/** Follows the address, names and agents. Once per window. */
export function startTabs(): () => void {
  if (started) return () => {};
  started = true;
  const onHash = () => {
    // One spelling per file: this listener runs before the app reads the address, so the editor mounts once, as the tab.
    const canonical = canonicalHash(location.hash);
    if (canonical) history.replaceState(history.state, '', canonical);
    const id = fileOfHash(location.hash);
    if (id) ensureTab(id);
    set({ active: id });
  };
  onHash();
  window.addEventListener('hashchange', onHash);
  // Other windows of this browser change the list too.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    const tabs = readStored();
    const active = get().active;
    if (active && !tabs.some((t) => t.id === active)) tabs.push({ id: active, name: get().tabs.find((t) => t.id === active)?.name ?? '' });
    set({ tabs });
  };
  window.addEventListener('storage', onStorage);

  setFileLookup(() => api.files());
  const names = refreshTabNames;
  void names();
  void loadRuns();
  const offEvents = onServerEvent((e) => {
    if (e.t === 'files') void names();
    else if (e.t === 'run-queue') void loadRuns();
    else if (e.t === 'agent' && (e.kind === 'done' || e.kind === 'error')) void loadRuns();
    else if (e.t === 'agent' && !runs.has(e.fileId)) void loadRuns();
    else if (e.t === 'activity') {
      lastActivity.set(e.fileId, { at: e.at || Date.now(), agent: e.agent });
      refreshWorking();
    }
  });
  // What was sent while the socket was down (a restart of the server) is read anew: names, and who still runs.
  const offReconnect = onEventsReconnect(() => { void names(); void loadRuns(); });
  const tick = window.setInterval(() => { if (lastActivity.size) refreshWorking(); }, 1000);
  const offSessions = onSessionsChanged(syncWatched);
  syncWatched();
  // A narrow door for tests and memory measurements: how long left tabs stay awake, and which are.
  (window as unknown as { __bogenTabs?: unknown }).__bogenTabs = { sleepPolicy, parkedFiles, sleepAll };
  return () => {
    started = false;
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('storage', onStorage);
    offEvents();
    offReconnect();
    offSessions();
    clearInterval(tick);
  };
}
