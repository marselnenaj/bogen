import { msg } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';
import type { DisplayChoices, DisplayRequest, RunnerCatalog, RunSettings, ThemeInfo, ThemeWallpaper, WallpaperStatus } from '../lib/agent-api.ts';

/**
 * "Add 9:16 layout" in the theme dialog: one click asks an agent to compose the portrait wallpaper of a desktop theme
 * in the file that is open, through the same run route, runner choice and model settings as the prompt. Pure, apart
 * from what is passed in, so the choice of agent, what the agent is told and the one-run guard can be tested without
 * a browser or a CLI.
 */

export const PORTRAIT_ASPECT = '9:16';
/** What the run is called in the prompt, the queue, the run list and the History. The full request stays with the agent. */
export const PORTRAIT_TITLE = 'Add 9:16 layout';
/** The shape added when the theme has no 9:16 display and this computer has no 9:16 monitor to take it from. */
export const PORTRAIT_PRESET = 'portrait-1080x1920';

const DONE = new Set<WallpaperStatus>(['artwork', 'composed']);

/** Whether the action is offered: a desktop theme without a designed 9:16 composition, the 9:16 shape missing included. */
export function portraitNeed(info: Pick<ThemeInfo, 'target' | 'wallpapers'>): { show: boolean; wallpaper?: ThemeWallpaper } {
  if (info.target !== 'desktop') return { show: false };
  const wallpaper = info.wallpapers.find((w) => w.aspect === PORTRAIT_ASPECT);
  if (!wallpaper) return { show: true };
  return { show: !DONE.has(wallpaper.status), wallpaper };
}

export const isDesigned = (status: WallpaperStatus | undefined): boolean => Boolean(status && DONE.has(status));

const nineBySixteen = (w: number, h: number) => h > w && Math.abs((w / h) / (9 / 16) - 1) < 0.01;

/** The 9:16 display to add: a 9:16 monitor of this computer the theme has no previews for, else the 1080 x 1920 preset. */
export function shapeRequest(choices: DisplayChoices | null): DisplayRequest {
  const monitor = choices?.monitors.find((m) => m.usable && !m.present && nineBySixteen(m.width, m.height));
  return monitor ? { monitor: monitor.name } : { preset: PORTRAIT_PRESET };
}

// ---------------------------------------------------------------- who is asked

export type RunnerId = 'claude' | 'codex';
export type AgentChoice = { ok: true; runner: RunnerId; name: string; label: string } | { ok: false; why: string };

const RUNNER_NAMES: Record<RunnerId, string> = { claude: 'Claude Code', codex: 'Codex' };
const isRunner = (id: string): id is RunnerId => id === 'claude' || id === 'codex';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Claude Code · Opus · High", from the model and effort set for the prompt, as the run will use them. */
export function agentLabel(runner: RunnerId, settings: RunSettings | null | undefined, catalogs: Record<string, RunnerCatalog> | null | undefined): string {
  const { model, effort } = settings?.runners[runner]?.prompt ?? {};
  const named = model && model !== 'default' ? catalogs?.[runner]?.models.find((m) => m.id === model)?.label ?? model : 'CLI default';
  return `${RUNNER_NAMES[runner]} · ${named}${effort && effort !== 'default' ? ` · ${cap(effort)}` : ''}`;
}

/**
 * The agent the prompt would ask, on this computer: the one last chosen in the prompt while it is here, or the only
 * one found, or the first one found when none was chosen yet (as the prompt does; the dialog names it before the
 * click). A chosen agent that is not found here, or one on another device, is never swapped for another: the person
 * chooses in the prompt.
 */
export function chooseAgent(saved: string | null, runners: readonly { id: string; available: boolean }[]): { ok: true; runner: RunnerId } | { ok: false; why: string } {
  if (saved?.includes('@')) return { ok: false, why: t('Your agent is set to run on another device. Choose one on this computer in the prompt.') };
  if (saved && isRunner(saved)) {
    // The last agent chosen is the one asked, or none: never another one in its place.
    return runners.some((r) => r.id === saved && r.available) ? { ok: true, runner: saved } : { ok: false, why: t('{agent} is not available on this computer. Choose another agent in the prompt.', { agent: RUNNER_NAMES[saved] }) };
  }
  const found = runners.filter((r) => r.available && isRunner(r.id));
  if (!found.length) return { ok: false, why: t('No agent was found on this computer. Choose one in the prompt.') };
  return { ok: true, runner: found[0]!.id as RunnerId };
}

// ---------------------------------------------------------------- what the agent is told

export interface PortraitTarget {
  theme: string;
  board: { id: string; name: string };
  component: string;
  status?: WallpaperStatus;
  /** The server's own words about the composition's state. */
  reason?: string;
  /** Set when the 9:16 display was added for this request. */
  added?: string;
}

/** The request, for the agent only: the person sees PORTRAIT_TITLE. */
export function portraitPrompt(t: PortraitTarget): string {
  const state = t.status === 'missing'
    ? `The component "${t.component}" is gone. Make it again with exactly that name, as a frame component filling the board, so the portrait previews show it.`
    : t.reason ? `Its state now: ${t.reason}` : '';
  return [
    `Add the 9:16 layout of the Omarchy desktop theme "${t.theme}" in this file: compose its portrait wallpaper, for a desktop monitor turned on its side.`,
    `Where: the board "${t.board.name}" (id ${t.board.id}), which holds the component "${t.component}" that the portrait previews show. Work inside that board, in this file.${t.added ? ` Bogen has just added the ${t.added} display for this.` : ''}${state ? `\n${state}` : ''}`,
    'How: compose a real design for the tall shape from what the theme already is: its palette tokens (use them, do not change their values), its landscape backgrounds, logo, type and accent, and any original artwork or brand in the file. Lay it out for 9:16. Never crop, stretch or rotate a landscape picture to fill the shape, and use no generic rainbow, gradient or pattern; a landscape picture may appear whole as one part of the layout. Keep the subject and any text clear of the bar at the top and the lock field in the middle. Hide Bogen\'s placeholder note rather than delete it.',
    'Keep: every other page, board, layer, token and component as it is, with its id. Make no new file, page, board, copy or "Custom" variant, and rename nothing.',
    `Check: omarchy_theme_displays with action list must report the ${PORTRAIT_ASPECT} composition as composed or artwork. Look at the board with canvas_screenshot.`,
    'Do not export, install or apply the theme, change anything on this computer or its desktop, or reply to, resolve or close comment threads. The person installs and applies the theme.',
    'End with one or two sentences on what you made.',
  ].join('\n\n');
}

// ---------------------------------------------------------------- one request at a time

export type Phase =
  | { at: 'idle' }
  | { at: 'starting' }
  | { at: 'choose'; why: string }
  | { at: 'running'; runId: string; agent: string }
  | { at: 'ended'; runId: string; agent: string; outcome: 'done' | 'stopped' | 'failed'; error?: string }
  | { at: 'failed'; error: string };

/** The state of a file with no request: shared and frozen, so that reading it twice gives the same snapshot. */
export const IDLE: Phase = Object.freeze({ at: 'idle' as const });

/** The server's own words when a file has a run going. */
const BUSY = msg('A run is already going on this file. Wait for it to finish, or stop it.');

export interface RunStart { fileId: string; pageId?: string; nodeIds: string[]; prompt: string; title: string; runner: RunnerId; intent: 'edit'; conversationId?: string }

/** What a request needs from the app. The editor passes the real API; tests pass stand-ins. */
export interface PortraitDeps {
  /** The prompt's runner, as last chosen there. */
  savedRunner: () => string | null;
  /** Whether a run is going in this file already, from the prompt or anywhere else: one run per file. */
  fileBusy: (fileId: string) => Promise<boolean>;
  runners: () => Promise<{ id: string; available: boolean }[]>;
  runSettings: () => Promise<{ settings: RunSettings; catalogs: Record<string, RunnerCatalog> } | null>;
  /** A commit in the file's History, before anything changes. */
  checkpoint: (fileId: string, message: string) => Promise<unknown>;
  addDisplays: (fileId: string, add: DisplayRequest[]) => Promise<{ added: { width: number; height: number }[]; skipped: { reason: string }[] }>;
  displays: (fileId: string) => Promise<{ wallpapers: ThemeWallpaper[]; displays?: { width: number; height: number }[] } & DisplayChoices>;
  /** A board of this name in the file, for a composition whose component is gone. */
  findBoard: (namePrefix: string) => { id: string; name: string } | undefined;
  pageOf: (nodeId: string) => string | undefined;
  conversationId: (fileId: string) => string | undefined;
  /** Shows the request as running in the prompt, before the run is asked for, as the prompt itself does. */
  beforeStart: (fileId: string, nodeIds: string[], title: string) => void;
  startRun: (body: RunStart) => Promise<{ runId: string }>;
  /** The run did not start: the prompt says so and stops showing it as running. */
  startFailed: (fileId: string, message: string) => void;
  stopRun: (runId: string) => Promise<void>;
}

/**
 * The state of the request in each file, kept outside the dialog so that closing and opening it again shows the run
 * that is going, and so that a second click while one is starting or running asks for nothing.
 */
export function portraitRequests(deps: PortraitDeps) {
  const phases = new Map<string, Phase>();
  const listeners = new Set<() => void>();
  /** Ends of runs seen while a request was waiting for its run id. */
  const early = new Map<string, { kind: 'done' | 'error'; text?: string }>();
  const set = (fileId: string, phase: Phase) => {
    phases.set(fileId, phase);
    for (const fn of listeners) fn();
  };
  // One object for every idle file: React's useSyncExternalStore needs the same snapshot until something changes.
  const get = (fileId: string): Phase => phases.get(fileId) ?? IDLE;
  const busy = (fileId: string) => ['starting', 'running'].includes(get(fileId).at);

  /** Who would be asked, for the line under the button before anyone clicks. */
  async function preview(): Promise<AgentChoice> {
    const [runners, settings] = await Promise.all([deps.runners(), deps.runSettings().catch(() => null)]);
    const pick = chooseAgent(deps.savedRunner(), runners);
    return pick.ok ? { ...pick, name: RUNNER_NAMES[pick.runner], label: agentLabel(pick.runner, settings?.settings, settings?.catalogs) } : pick;
  }

  async function start(fileId: string, info: Pick<ThemeInfo, 'name' | 'target' | 'wallpapers'>, choices: DisplayChoices | null): Promise<void> {
    if (busy(fileId)) return;
    if (!portraitNeed(info).show) return;
    set(fileId, { at: 'starting' });
    let shown = false;
    try {
      // Before the checkpoint and the shape: nothing changes for a request that could not run.
      if (await deps.fileBusy(fileId)) return set(fileId, { at: 'failed', error: t(BUSY) });
      const agent = await preview();
      if (!agent.ok) return set(fileId, { at: 'choose', why: agent.why });
      await deps.checkpoint(fileId, 'Before adding the 9:16 layout');
      let added: string | undefined;
      if (!info.wallpapers.some((w) => w.aspect === PORTRAIT_ASPECT)) {
        const out = await deps.addDisplays(fileId, [shapeRequest(choices)]);
        if (out.added[0]) added = `${out.added[0].width} × ${out.added[0].height}`;
      }
      const now = (await deps.displays(fileId)).wallpapers.find((w) => w.aspect === PORTRAIT_ASPECT);
      if (!now) throw new Error(t('The theme has no 9:16 shape to design, and Bogen could not add one.'));
      if (isDesigned(now.status)) return set(fileId, IDLE);
      const board = now.board ?? deps.findBoard(`Portrait background · ${PORTRAIT_ASPECT}`);
      if (!board) throw new Error(t('The 9:16 board is gone. Bring it back from the file\'s History first.'));
      const prompt = portraitPrompt({ theme: info.name, board, component: now.component, status: now.status, reason: now.reason, ...(added ? { added } : {}) });
      const pageId = deps.pageOf(board.id);
      const conversationId = deps.conversationId(fileId);
      deps.beforeStart(fileId, [board.id], PORTRAIT_TITLE);
      shown = true;
      const { runId } = await deps.startRun({ fileId, ...(pageId ? { pageId } : {}), nodeIds: [board.id], prompt, title: PORTRAIT_TITLE, runner: agent.runner, intent: 'edit', ...(conversationId ? { conversationId } : {}) });
      set(fileId, { at: 'running', runId, agent: agent.name });
      // A short run can end before its start is answered: its end was kept for this moment.
      const end = early.get(runId);
      early.clear();
      if (end) ended(fileId, runId, end.kind, end.text);
    } catch (e) {
      const error = (e as Error).message || t('The request did not start.');
      if (shown) deps.startFailed(fileId, error);
      set(fileId, { at: 'failed', error });
    }
  }

  /** A run's end, from the server's events. Only the run this request started counts. */
  function ended(fileId: string, runId: string, kind: 'done' | 'error', text?: string): void {
    const now = get(fileId);
    if (now.at === 'starting') early.set(runId, { kind, ...(text ? { text } : {}) });
    if (now.at !== 'running' || now.runId !== runId) return;
    const outcome = kind === 'error' ? 'failed' : text === 'Stopped.' ? 'stopped' : 'done';
    set(fileId, { at: 'ended', runId, agent: now.agent, outcome, ...(kind === 'error' && text ? { error: text } : {}) });
  }

  async function stop(fileId: string): Promise<void> {
    const now = get(fileId);
    if (now.at === 'running') await deps.stopRun(now.runId);
  }

  return {
    get, start, ended, stop, preview,
    reset: (fileId: string) => { if (!busy(fileId)) set(fileId, IDLE); },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type PortraitRequests = ReturnType<typeof portraitRequests>;
