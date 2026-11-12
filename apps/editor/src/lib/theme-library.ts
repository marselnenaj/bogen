import type { ApplyState, InstalledTheme } from './agent-api.ts';
import type { FileEntry } from './api.ts';
import { t } from '../i18n/store.ts';

/**
 * The theme library on Home: the person's Bogen theme projects (drafts too) and the themes installed on this computer,
 * from one compact request (`GET /api/omarchy/library`) that reads the file index, never the theme documents.
 */

export type ThemeStatus = 'draft' | 'installed' | 'in-use';
export interface ThemeProject {
  file_id: string;
  file_name: string;
  name: string;
  slug: string | null;
  target: 'desktop' | 'mobile';
  profile?: string;
  from?: string;
  project_id?: string;
  folder?: string;
  updatedAt: number;
  thumbnail?: string;
  status: ThemeStatus;
  branch: { current: string; current_name?: string; open: { id: string; name: string }[] };
  group?: string;
  /** Files brought into this project as branches: kept, recoverable, no projects of their own. */
  merged_copies?: { file_id: string; name: string; branch_id: string; at: number; changed_after: boolean }[];
}
export interface ThemeGroup { key: string; label: string; file_ids: string[]; reason: string }
export interface ThemeLibrary {
  onOmarchy: boolean;
  host?: string;
  apply?: ApplyState;
  current: string | null;
  screens: { width: number; height: number }[];
  projects: ThemeProject[];
  groups: ThemeGroup[];
  installed: (InstalledTheme & { project_file_ids: string[] })[];
}
/** A project that could be the theme asked for, when several could. */
export interface ThemeCandidate { file_id: string; name: string; from?: string; target: 'desktop' | 'mobile'; profile?: string; updatedAt: number; folder?: string; branch?: string | { current?: string; current_name?: string } }
export type StartAnswer = { file_id: string; reused: boolean } | { choose: ThemeCandidate[]; message?: string };
export interface StartTheme { from?: string; name?: string; target?: 'desktop' | 'mobile'; file_id?: string; new_project?: boolean; preset?: string }

/** A preset of the Bogen collection as Home lists it: words and colours; its pictures load on their own, lazily. */
export interface CollectionPreset {
  id: string;
  name: string;
  description: string;
  mode: 'dark' | 'light';
  medium: 'vector' | 'raster';
  swatches: string[];
  /** All its art is in this build. A preset still waiting for its art is not offered. */
  ready: boolean;
}
export interface Collection { available: boolean; presets: CollectionPreset[] }

/** The collection, or null from a server without one. Metadata only: nothing is made or rendered for it. */
export async function fetchCollection(): Promise<Collection | null> {
  const res = await fetch('/api/omarchy/collection');
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw new Error(t('The server answered {status}.', { status: res.status }));
  return (await res.json()) as Collection;
}

/** What a theme project started from a preset records as where it came from. */
export const presetSource = (id: string): string => `collection/${id}`;

/** A preset's small picture: the SVG itself for vector art, a WebP copy for raster. */
export const presetThumb = (id: string, orientation: 'landscape' | 'portrait'): string => `/api/omarchy/collection/${encodeURIComponent(id)}/${orientation}?v=4`;

/** The person's desktop projects started from a preset: one opens again, several are a choice. */
export function presetProjects(projects: readonly ThemeProject[], id: string): ThemeProject[] {
  const from = presetSource(id);
  return projects.filter((p) => p.target === 'desktop' && p.from === from);
}

/**
 * The presets Home offers: only those whose art is all here, only for desktop (a Mobile filter leaves none), narrowed
 * by a search on name and description.
 */
export function collectionRows(presets: readonly CollectionPreset[], query: string, platform: string | null = null): CollectionPreset[] {
  if (!inPlatform('desktop', platform)) return [];
  const q = query.trim().toLowerCase();
  return presets.filter((p) => p.ready && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
}

/** One card per desktop theme: a visible project takes the place of its bundled starting point. */
export function unrepresentedPresets(presets: readonly CollectionPreset[], visibleFiles: readonly Pick<FileEntry, 'theme'>[], query: string, platform: string | null): CollectionPreset[] {
  const represented = new Set(visibleFiles.filter((f) => f.theme?.target === 'desktop').map((f) => f.theme?.from));
  return collectionRows(presets, query, platform).filter((p) => !represented.has(presetSource(p.id)));
}

/** The library, or null from a server that has none yet: Home then shows the installed themes only, as before. */
export async function fetchLibrary(): Promise<ThemeLibrary | null> {
  const res = await fetch('/api/omarchy/library');
  if (res.status === 404 || res.status === 405) return null;
  if (!res.ok) throw new Error(t('The server answered {status}.', { status: res.status }));
  return (await res.json()) as ThemeLibrary;
}

/** Opens or starts a theme project. A 409 asks the person to pick one of several candidates, and makes nothing. */
export async function startTheme(body: StartTheme): Promise<StartAnswer> {
  const res = await fetch('/api/omarchy/themes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Reported below.
  }
  if (res.status === 409 && data && typeof data === 'object' && Array.isArray((data as { choose?: unknown }).choose)) {
    const d = data as { choose: ThemeCandidate[]; message?: string };
    return { choose: d.choose, ...(d.message ? { message: d.message } : {}) };
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? t('The server answered {status}.', { status: res.status }));
  return { file_id: (data as { file_id: string }).file_id, reused: res.status === 200 };
}

// ---------------------------------------------------------------- pure: what the library lists

const RANK: Record<ThemeStatus, number> = { 'in-use': 2, installed: 1, draft: 0 };

/**
 * One logical theme as the library shows it: a project, or several copies of one theme kept until consolidated. A row
 * of copies opens none of them by itself: none is the canonical one until the person consolidates them.
 */
export interface LibraryRow {
  key: string;
  /** The project a row of one opens; for copies, only the first listed (in use, else installed, else latest edited). */
  lead: ThemeProject;
  /** Every copy, the lead first. One for a theme without duplicates. */
  copies: ThemeProject[];
  status: ThemeStatus;
  group?: ThemeGroup;
}

/** Whether a folder path is the folder or inside it. Null is every folder. */
export function inFolder(path: string | undefined, folder: string | null): boolean {
  if (folder === null) return true;
  const p = path ?? '';
  if (!folder) return !p;
  return p === folder || p.startsWith(`${folder}/`);
}

/** Home's kind platform for themes: 'desktop' or 'mobile' narrows to that target, anything else leaves all. */
export function inPlatform(target: 'desktop' | 'mobile', platform: string | null | undefined): boolean {
  return platform !== 'desktop' && platform !== 'mobile' ? true : target === platform;
}

/**
 * Like Home's file list: a search looks everywhere, by theme or file name; else the chosen folder and its subfolders.
 * Either way only the chosen platform's themes, when Home's kind filter names one.
 */
export function filterProjects(projects: readonly ThemeProject[], folder: string | null, query: string, platform: string | null = null): ThemeProject[] {
  const q = query.trim().toLowerCase();
  const mine = projects.filter((p) => inPlatform(p.target, platform));
  if (q) return mine.filter((p) => p.name.toLowerCase().includes(q) || p.file_name.toLowerCase().includes(q));
  return mine.filter((p) => inFolder(p.folder, folder));
}

const byLead = (a: ThemeProject, b: ThemeProject) => RANK[b.status] - RANK[a.status] || b.updatedAt - a.updatedAt;

/**
 * The rows of "Your themes": drafts included, copies the server grouped as one theme shown as one row (only those the
 * filter leaves), nothing hidden or left out. In use first, then installed, then by last edit.
 */
export function libraryRows(lib: Pick<ThemeLibrary, 'projects' | 'groups'>, folder: string | null, query: string, platform: string | null = null): LibraryRow[] {
  const shown = filterProjects(lib.projects, folder, query, platform);
  const groupOf = new Map<string, ThemeGroup>();
  for (const g of lib.groups) for (const id of g.file_ids) groupOf.set(id, g);
  const byKey = new Map(lib.groups.map((g) => [g.key, g]));
  const rows = new Map<string, ThemeProject[]>();
  for (const p of shown) {
    const g = groupOf.get(p.file_id) ?? (p.group ? byKey.get(p.group) : undefined);
    const key = g ? `group:${g.key}` : `file:${p.file_id}`;
    rows.set(key, [...(rows.get(key) ?? []), p]);
  }
  const out: LibraryRow[] = [];
  for (const [key, list] of rows) {
    const copies = [...list].sort(byLead);
    const lead = copies[0]!;
    const g = key.startsWith('group:') && copies.length > 1 ? byKey.get(key.slice(6)) : undefined;
    out.push({ key, lead, copies, status: lead.status, ...(g ? { group: g } : {}) });
  }
  return out.sort((a, b) => byLead(a.lead, b.lead));
}

/**
 * Installed themes for "Start from an installed theme": a search narrows them by title; in use, then the person's own.
 * They are this computer's desktop themes, so a Mobile filter leaves none.
 */
export function installedRows<T extends InstalledTheme>(installed: readonly T[], query: string, platform: string | null = null): T[] {
  if (!inPlatform('desktop', platform)) return [];
  const q = query.trim().toLowerCase();
  return installed
    .filter((i) => !q || i.title.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(b.source !== 'stock') - Number(a.source !== 'stock') || a.title.localeCompare(b.title));
}

/** Open branches besides main. */
export function branchCount(p: Pick<ThemeProject, 'branch'>): number {
  return p.branch.open.filter((b) => b.id !== 'main').length;
}

/** The candidates for the projects an installed theme already has, when there are several to pick from. */
export function candidatesFor(projects: readonly ThemeProject[], ids: readonly string[]): ThemeCandidate[] {
  const known = new Map(projects.map((p) => [p.file_id, p]));
  return ids.map((id) => known.get(id)).filter((p): p is ThemeProject => Boolean(p)).map((p) => ({
    file_id: p.file_id, name: p.file_name || p.name, target: p.target, updatedAt: p.updatedAt,
    ...(p.from ? { from: p.from } : {}), ...(p.profile ? { profile: p.profile } : {}), ...(p.folder ? { folder: p.folder } : {}),
    ...(p.branch.current !== 'main' ? { branch: { current: p.branch.current, ...(p.branch.current_name ? { current_name: p.branch.current_name } : {}) } } : {}),
  }));
}

/** Every copy of a group the library knows, whatever Home's filters leave: bringing them together takes them all. */
export function groupCopies(projects: readonly ThemeProject[], group: ThemeGroup): ThemeProject[] {
  const ids = new Set(group.file_ids);
  return projects.filter((p) => ids.has(p.file_id) || p.group === group.key);
}

/**
 * The files Home lists: a theme copy that was brought into another theme project (as a branch, by consolidation) is
 * part of that project, not a file of its own in the grid, the folders or the counts. It stays a real file, listed on
 * its project as a kept copy, as long as that project is here; without it, it lists as before.
 */
export function canonicalFiles<T extends { id: string; theme?: { consolidatedInto?: { fileId: string } } }>(files: readonly T[]): (T & { keptCopies?: T[] })[] {
  const ids = new Set(files.map((f) => f.id));
  const kept = new Map<string, T[]>();
  for (const f of files) {
    const into = f.theme?.consolidatedInto?.fileId;
    if (into && into !== f.id && ids.has(into)) kept.set(into, [...(kept.get(into) ?? []), f]);
  }
  return files.filter((f) => !(f.theme?.consolidatedInto?.fileId && f.theme.consolidatedInto.fileId !== f.id && ids.has(f.theme.consolidatedInto.fileId)))
    .map((f) => (kept.has(f.id) ? { ...f, keptCopies: kept.get(f.id)! } : f));
}
