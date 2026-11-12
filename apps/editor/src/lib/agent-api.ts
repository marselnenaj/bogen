import type { RunLanguageChoice } from '@bogen/core';
/** The parts of the API that the agent loop and the device panels use. */

import type { TextSpan } from '@bogen/core';
import { t } from '../i18n/store.ts';

export type RunScope = 'prompt' | 'comment';
export interface RunChoiceValue { model?: string; effort?: string }
export interface RunnerModel { id: string; label: string; resolvedId?: string; description?: string; efforts?: string[]; defaultEffort?: string }
/**
 * What a CLI offers. `entry`: models come from the list, are typed by the person, or are only the CLI's own
 * default. `problem`: why this runner cannot run here now.
 */
export interface RunnerCatalog { id: string; defaultModel?: string; models: RunnerModel[]; efforts: string[]; cheap: RunChoiceValue; source: 'cli' | 'built-in'; entry?: 'catalog' | 'free' | 'cli-default'; problem?: string }
export interface RunSettings { runners: Record<string, Record<RunScope, RunChoiceValue>>; shareCursors: boolean; limits?: Record<string, number> }
export interface RunSettingsAnswer { settings: RunSettings; catalogs: Record<string, RunnerCatalog> }

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted';
export interface RunRecord {
  id: string; fileId: string; prompt: string; title?: string; runner: string; model?: string; effort?: string; actualModel?: string; knowledge?: { discipline: string; revision: string; customized: boolean };
  source: 'prompt' | 'comment' | 'live'; threadId?: string; pageId?: string; nodeIds: string[]; review?: string; race?: { id: string; lane: string; agent: string }; rebuildOf?: string;
  conversationId?: string; nudged?: boolean; firstReply?: string;
  startedAt: number; endedAt?: number; durationMs?: number; status: RunStatus; result?: string; error?: string;
  tools: { name: string; count: number }[]; layers: string[]; files?: string[];
}

export type LaneStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';
export interface RaceLane {
  id: string; runner: string; model?: string; effort?: string; agent: string; color: string; proposalId: string; status: LaneStatus;
  waiting?: string; runId?: string; tool?: string; startedAt?: number; endedAt?: number; error?: string; decision?: 'accepted' | 'discarded';
}
export interface Race { id: string; fileId: string; pageId: string; nodeId: string; prompt: string; at: number; lanes: RaceLane[]; decided?: { laneId?: string; at: number; branch?: { id: string; name: string } } }
export interface LaneChoice { runner: string; model?: string; effort?: string }

export interface DesignFeatures { layers: number; gradient: boolean; shadow: boolean; uppercase: boolean; radius: number | null; spacing: number | null; contrast: number | null; fonts: number; colors: number }
export interface Decision { id: string; fileId: string; brandId?: string; decision: 'accepted' | 'discarded'; at: number; by: string; runner?: string; model?: string; request?: string; note?: string; features: DesignFeatures | null }
export interface MemorySuggestion { id: string; why: string; text: string; evidence: { accepted: number; discarded: number } }
export interface MemoryView { decisions: number; accepted: number; discarded: number; files: number; suggestions: MemorySuggestion[]; recent: Decision[]; summary: string | null }

export interface FieldChange { field: string; before?: unknown; after?: unknown }
export interface LayerChange { nodeId: string; name: string; kind: 'added' | 'removed' | 'changed'; fields: FieldChange[] }
export interface AgentStep { id: string; agent: string; tool: string; at: number; runId?: string; pageId?: string; changes: LayerChange[]; undone: boolean }

export interface AwayNote { changes: number; from: Record<string, number>; firstAt: number; lastAt: number }
export interface TextVersion { text: string; spans?: TextSpan[] }
/** `texts`: a text layer both devices edited while apart, with both whole texts. `ours` is this device's. */
export interface SyncConflict { id: string; fileId: string; kind: 'layer' | 'token'; nodeId?: string; name: string; field: string; ours: string; theirs: string; device: string; kept: 'ours' | 'theirs'; at: number; texts?: { ours: TextVersion; theirs: TextVersion } }

export interface PeerDetail {
  id: string; name: string; state: 'connected' | 'offline'; lastSyncAt: number | null; pending: number; error?: string;
  version?: string; versionMismatch?: boolean; bytesIn?: number; bytesOut?: number; lastError?: string; lastErrorAt?: number;
  here?: { fileId: string; people: { name: string; selection: number }[] }[];
}

export interface LiveSiteInfo { id: string; target: string; dir: string; proxyUrl: string; historyKey: string }
export interface PickedElement {
  selector: string; tag?: string; text?: string; html: string; styles: Record<string, string>;
  source?: { file?: string; line?: number; column?: number; via?: string } | null; url?: string; box?: { x: number; y: number; width: number; height: number };
}

export interface InstalledTheme { name: string; title: string; source: 'stock' | 'user' | 'overlay'; mode: 'dark' | 'light'; swatches: string[]; backgrounds: number; current: boolean; fromRepo: boolean }
export interface ApplyState { applied?: string; previous?: string | null; at?: number; current: string | null }
export interface ThemeInfo {
  name: string; slug: string | null; mode: 'dark' | 'light'; icons: string; iconsFollowAccent: boolean; from?: string;
  target: 'desktop' | 'mobile'; host: 'desktop' | 'mobile'; profile?: { id: string; device: string; logical: string }; shellRoles: number;
  coverage?: { surface: string; status: 'themed' | 'generated' | 'unverified' | 'not-themable'; via: string; note?: string }[];
  videos: { kind: 'intro' | 'loop'; name: string; still?: string; durationS?: number; hasAudio?: boolean; advice: string[] }[];
  installed: string | null; overStock: boolean; installedFromRepo: boolean;
  backgrounds: { name: string; width: number; height: number; kept: boolean }[];
  previews: { desktop: boolean; unlock: boolean; boot: boolean };
  displays: ThemeDisplay[]; wallpapers: ThemeWallpaper[];
  generated: string[]; problems: string[]; notes: string[]; apply: ApplyState; keys: number;
  /** The portrait background plugin on this machine, for a desktop theme with compositions. */
  portrait?: PortraitPlugin;
}
export interface PortraitPlugin { state: 'not-installed' | 'installed' | 'enabled' | 'foreign' | 'unknown'; available: boolean; enabled: boolean; summary: string; next: string[] }
export interface DisplayRuntime {
  plugin: PortraitPlugin;
  screens: { name: string; width: number; height: number; orientation: string; shows: string; reason?: string }[];
  ready: string[]; incomplete: { aspect: string; status: WallpaperStatus }[];
}
export interface ThemeDisplay { width: number; height: number; orientation: string; label: string; source?: string; monitor?: string; wallpaper: string; boards: { id: string; name: string }[] }
export type WallpaperStatus = 'artwork' | 'composed' | 'needs-design' | 'mismatch' | 'unverified' | 'missing';
export interface ThemeWallpaper { aspect: string; orientation: string; component: string; board?: { id: string; name: string; width: number; height: number }; status: WallpaperStatus; reason: string }
export interface DisplayChoices {
  presets: { id: string; label: string; note: string; present: boolean }[];
  monitors: { name: string; label: string; width: number; height: number; usable: boolean; reason?: string; present: boolean }[];
}
export type DisplayRequest = { preset: string } | { monitor: string } | { width: number; height: number };
export interface ThemeWritten { dir: string; files: string[]; git?: string | null; archive?: boolean; generated: string[]; problems: string[] }
export interface ThemeInstalled { name: string; dir: string; replaced: boolean; overStock: boolean; files: string[]; generated: string[]; problems: string[] }

async function asJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Reported below.
  }
  if (!res.ok) throw new Error((parsed as { error?: string } | null)?.error ?? t('The server answered {status}.', { status: res.status }));
  return parsed as T;
}

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

export const agentApi = {
  runSettings: async () => asJson<RunSettingsAnswer>(await fetch('/api/run-settings?catalogs=loaded')),
  /** One runner's catalog, asked when someone picks it: the server probes that CLI then, and only that one. */
  runnerCatalog: async (runner: string) => asJson<RunnerCatalog>(await fetch(`/api/run-settings/catalog/${encodeURIComponent(runner)}`)),
  saveRunSetting: async (patch: { runner?: string; scope?: RunScope; model?: string | null; effort?: string | null; shareCursors?: boolean; limit?: number }) => asJson<RunSettings>(await fetch('/api/run-settings', send('PATCH', patch))),
  races: async (fileId: string) => asJson<Race[]>(await fetch(`/api/races?fileId=${encodeURIComponent(fileId)}`)),
  startRace: async (body: { fileId: string; pageId?: string; nodeId: string; prompt: string; lanes: LaneChoice[]; who: string; language?: RunLanguageChoice }) => asJson<Race>(await fetch('/api/races', send('POST', body))),
  stopRace: async (raceId: string, laneId?: string) => asJson<{ stopped: string[] }>(await fetch(`/api/races/${raceId}/stop`, send('POST', laneId ? { laneId } : {}))),
  acceptRace: async (raceId: string, laneId: string, keep: 'discard' | 'branch', who: string) => asJson<{ nodeId: string; discarded: string[]; branch?: { id: string; name: string } }>(await fetch(`/api/races/${raceId}/accept`, send('POST', { laneId, keep, who }))),
  discardRace: async (raceId: string, laneId: string, who: string) => asJson<{ ok: boolean }>(await fetch(`/api/races/${raceId}/discard`, send('POST', { laneId, who }))),
  rebuild: async (body: { fileId: string; nodeId: string; runner: string; model?: string; effort?: string; prompt?: string }) => asJson<{ runId: string }>(await fetch('/api/runs/rebuild', send('POST', body))),
  memory: async (brandId: string) => asJson<MemoryView>(await fetch(`/api/brands/${brandId}/memory`)),
  memoryAction: async (brandId: string, suggestionId: string, action: 'add' | 'dismiss', by: string) => asJson<Record<string, string>>(await fetch(`/api/brands/${brandId}/memory/${encodeURIComponent(suggestionId)}`, send('POST', { action, by }))),
  runs: async (fileId: string) => asJson<RunRecord[]>(await fetch(`/api/runs?fileId=${encodeURIComponent(fileId)}`)),
  rerun: async (fileId: string, id: string) => asJson<{ runId: string }>(await fetch(`/api/runs/${id}/rerun`, send('POST', { fileId }))),
  steps: async (fileId: string) => asJson<AgentStep[]>(await fetch(`/api/agents/steps?fileId=${encodeURIComponent(fileId)}`)),
  undoStep: async (fileId: string, stepId: string) => asJson<{ undone: boolean }>(await fetch('/api/agents/steps/undo', send('POST', { fileId, stepId }))),
  stepPreview: (fileId: string, stepId: string, which: 'before' | 'after') => `/api/agents/steps/${stepId}/preview?fileId=${encodeURIComponent(fileId)}&which=${which}`,
  away: async (fileId: string) => asJson<{ away: AwayNote | null }>(await fetch(`/api/files/${fileId}/away`)),
  conflicts: async (fileId: string) => asJson<SyncConflict[]>(await fetch(`/api/files/${fileId}/conflicts`)),
  dismissConflict: async (fileId: string, id: string) => asJson<{ ok: boolean }>(await fetch(`/api/files/${fileId}/conflicts/${id}`, send('DELETE'))),
  branchConflict: async (fileId: string, id: string) => asJson<{ id: string; name: string }>(await fetch(`/api/files/${fileId}/conflicts/${id}/branch`, send('POST', {}))),
  palette: async () => asJson<{ name: string | null; tokens: { name: string; kind: string; value: string }[] }>(await fetch('/api/omarchy/palette')),
  importPalette: async (fileId: string) => asJson<{ imported: number; name?: string }>(await fetch('/api/omarchy/palette', send('POST', { fileId }))),
  omarchyThemes: async () => asJson<{ onOmarchy: boolean; themes: InstalledTheme[]; apply: ApplyState; screens: { width: number; height: number }[] }>(await fetch('/api/omarchy/themes')),
  createTheme: async (body: { from?: string; name?: string; target?: 'desktop' | 'mobile'; copy?: boolean }) => asJson<{ file_id: string; name: string; left: string[]; reused?: boolean }>(await fetch('/api/omarchy/themes', send('POST', body))),
  themeInfo: async (fileId: string) => asJson<{ theme: ThemeInfo | null; candidate?: boolean }>(await fetch(`/api/omarchy/theme/${fileId}`)),
  adoptTheme: async (fileId: string, body: { name: string; target: 'desktop' | 'mobile' }) => asJson<{ theme: ThemeInfo | null }>(await fetch(`/api/omarchy/theme/${fileId}/adopt`, send('POST', body))),
  updateTheme: async (fileId: string, patch: { name?: string; mode?: 'dark' | 'light'; icons?: string | null }) => asJson<{ theme: ThemeInfo | null }>(await fetch(`/api/omarchy/theme/${fileId}`, send('PATCH', patch))),
  exportThemeTar: async (fileId: string) => {
    const res = await fetch(`/api/omarchy/theme/${fileId}/export`, send('POST', { to: 'tar' }));
    if (!res.ok) await asJson(res);
    return res.blob();
  },
  exportThemeFiles: async (fileId: string) => asJson<{ slug: string; files: { path: string; data: string }[]; generated: string[]; problems: string[] }>(await fetch(`/api/omarchy/theme/${fileId}/export`, send('POST', { to: 'files' }))),
  exportThemeFolder: async (fileId: string, dir: string, git: boolean) => asJson<ThemeWritten>(await fetch(`/api/omarchy/theme/${fileId}/export`, send('POST', { to: 'folder', dir, git }))),
  themeDisplays: async (fileId: string) => asJson<DisplayChoices & { displays: ThemeDisplay[]; wallpapers: ThemeWallpaper[]; runtime?: DisplayRuntime }>(await fetch(`/api/omarchy/theme/${fileId}/displays`)),
  addThemeDisplays: async (fileId: string, add: DisplayRequest[]) => asJson<{ added: { width: number; height: number }[]; skipped: { width: number; height: number; reason: string }[]; wallpapers: { component: string }[] }>(await fetch(`/api/omarchy/theme/${fileId}/displays`, send('POST', { add }))),
  assignDisplayArtwork: async (fileId: string, body: { aspect: string; src: string; name?: string }) => asJson<{ wallpaper: ThemeWallpaper }>(await fetch(`/api/omarchy/theme/${fileId}/displays/artwork`, send('POST', body))),
  installTheme: async (fileId: string, overwrite: boolean) => asJson<ThemeInstalled>(await fetch(`/api/omarchy/theme/${fileId}/install`, send('POST', { overwrite }))),
  applyTheme: async (name: string) => asJson<{ applied: string; previous: string | null }>(await fetch('/api/omarchy/apply', send('POST', { name }))),
  undoApplyTheme: async () => asJson<{ restored: string }>(await fetch('/api/omarchy/undo-apply', send('POST', {}))),
  liveSites: async () => asJson<{ sites: LiveSiteInfo[]; recent: { url: string; dir: string; at: number }[] }>(await fetch('/api/live/sites')),
  openLive: async (url: string, dir: string) => asJson<LiveSiteInfo>(await fetch('/api/live/sites', send('POST', { url, dir }))),
  closeLive: async (id: string) => asJson<{ closed: boolean }>(await fetch(`/api/live/sites/${id}`, send('DELETE'))),
  askLive: async (id: string, body: { prompt: string; runner: string; model?: string; effort?: string; element?: PickedElement }) => asJson<{ runId: string }>(await fetch(`/api/live/sites/${id}/runs`, send('POST', body))),
};
