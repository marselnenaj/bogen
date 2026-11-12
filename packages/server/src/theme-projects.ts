// Theme projects: one Bogen file per logical Omarchy theme, found again by what it is (target, profile, the theme it
// started from, its stable project id and name), never by a title suffix alone, and never by loading every theme.
//
// Each theme file's identity and branches are kept in its index entry (FileEntry.theme), refreshed by brand-store as
// rooms load and change. Entries from before the index are read lazily and boundedly, one at a time into a document
// that is thrown away, and then indexed for good.

import { createHash } from 'node:crypto';
import { BogenDoc, branchContent, canonicalJson, commentsToContent, currentBranchId, designHash, docToContent, type DesignContent, getDesignBranch, listDesignBranches, MAIN_BRANCH, MAX_OPEN_BRANCHES, Y } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { META_KEY, themeSlug, type ThemeTarget } from './omarchy-theme.ts';
import type { FileEntry, Storage, ThemeIndex } from './storage.ts';
import { errorMessage } from './util.ts';

const SUFFIX: Record<ThemeTarget, string> = { desktop: ' · Omarchy theme', mobile: ' · Omarchy mobile theme' };
const PROFILE_RE = /^[a-z0-9-]{1,32}$/;
const PROJECT_RE = /^[0-9a-z]{4,40}$/;
/** Old entries read per library request when they have no index yet. */
export const LIBRARY_FALLBACK = 8;
/** Old entries read per create request: finding the right project matters more there, and creating is rare. */
export const RESOLVE_FALLBACK = 48;

type Identity = Pick<ThemeIndex, 'name' | 'slug' | 'from' | 'target' | 'profile' | 'project'>;

/** The identity a theme record gives, or null when it is not one. */
export function themeIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string') return null;
  const target: ThemeTarget = m.target === 'mobile' ? 'mobile' : 'desktop';
  const profile = target === 'mobile' ? (typeof m.profile === 'string' && PROFILE_RE.test(m.profile) ? m.profile : 'komodo') : undefined;
  return {
    name: m.name, slug: themeSlug(m.name), target, ...(profile ? { profile } : {}),
    ...(typeof m.from === 'string' && m.from ? { from: m.from } : {}),
    ...(typeof m.project === 'string' && PROJECT_RE.test(m.project) ? { project: m.project } : {}),
  };
}

function identityOf(index: ThemeIndex): Identity {
  return { name: index.name, slug: index.slug, target: index.target, ...(index.profile ? { profile: index.profile } : {}), ...(index.from ? { from: index.from } : {}), ...(index.project ? { project: index.project } : {}) };
}

/**
 * A theme file's index record. Its identity is main's: while another branch is checked out the previous identity
 * stays and only the branch fields move, so a branch renaming its theme never renames the project.
 */
export function themeIndexOf(doc: BogenDoc, previous?: ThemeIndex): ThemeIndex | undefined {
  const branch = currentBranchId(doc);
  let identity: Identity | null = null;
  if (branch === MAIN_BRANCH) identity = themeIdentity(doc.meta.get(META_KEY));
  else if (previous) identity = identityOf(previous);
  else {
    try {
      identity = themeIdentity(branchContent(doc, MAIN_BRANCH).extra?.meta?.[META_KEY]);
    } catch {
      identity = null;
    }
    identity ??= themeIdentity(doc.meta.get(META_KEY));
  }
  if (!identity) return undefined;
  const branches = listDesignBranches(doc).filter((b) => b.status === 'open').slice(0, MAX_OPEN_BRANCHES + 1).map((b) => ({ id: b.id, name: b.name }));
  let branchName = branches.find((b) => b.id === branch)?.name;
  if (!branchName) {
    try {
      branchName = getDesignBranch(doc, branch).name;
    } catch {
      branchName = undefined;
    }
  }
  const into = consolidationMark(doc);
  return { ...identity, branch, ...(branchName ? { branchName } : {}), branches, ...(into ? { consolidatedInto: { fileId: into.fileId, branchId: into.branchId, at: into.at, changed: changedSinceMark(doc, into) } } : {}) };
}

/** Where a file was brought in as a branch, from its own record (theme-consolidate.ts). */
export const CONSOLIDATED_KEY = 'consolidatedInto';
export interface ConsolidationMark { fileId: string; branchId: string; at: number; hash?: string; commentsHash?: string }
export function consolidationMark(doc: BogenDoc): ConsolidationMark | undefined {
  const m = doc.meta.get(CONSOLIDATED_KEY) as Partial<ConsolidationMark> | undefined;
  return m && typeof m.fileId === 'string' && typeof m.branchId === 'string' && typeof m.at === 'number'
    ? { fileId: m.fileId, branchId: m.branchId, at: m.at, ...(typeof m.hash === 'string' ? { hash: m.hash } : {}), ...(typeof m.commentsHash === 'string' ? { commentsHash: m.commentsHash } : {}) }
    : undefined;
}

/** A file's design without its own consolidation record, so that writing the record is not a change of the design. */
export function designWithoutMark(doc: BogenDoc): DesignContent {
  const content = docToContent(doc);
  const meta = content.extra?.meta;
  if (meta && CONSOLIDATED_KEY in meta) {
    const { [CONSOLIDATED_KEY]: _mark, ...rest } = meta;
    content.extra = { ...content.extra, meta: rest };
  }
  return content;
}

/** A fingerprint of every comment thread, every message, for telling whether the conversation changed. */
export function commentsFingerprint(doc: BogenDoc): string {
  return createHash('sha256').update(canonicalJson(commentsToContent(doc))).digest('hex').slice(0, 16);
}

/**
 * Whether a source changed after it was brought in: its design or comments differ from what was brought, by content,
 * not by clock, so an edit a moment later or on a device with another time is seen. Read only for consolidated files.
 */
function changedSinceMark(doc: BogenDoc, mark: ConsolidationMark): boolean {
  if (!mark.hash) return false;
  return designHash(designWithoutMark(doc)) !== mark.hash || (mark.commentsHash !== undefined && commentsFingerprint(doc) !== mark.commentsHash);
}

export const changedAfterConsolidation = (entry: FileEntry) => Boolean(entry.theme?.consolidatedInto?.changed);

/** Puts a document's theme record in its index entry. True when it changed. */
export function refreshThemeIndex(storage: Storage, id: string, doc: BogenDoc): boolean {
  const entry = storage.get(id);
  if (!entry) return false;
  const next = themeIndexOf(doc, entry.theme);
  if (JSON.stringify(next) === JSON.stringify(entry.theme)) return false;
  storage.update(id, { theme: next });
  return true;
}

// ---------------------------------------------------------------- the list

export interface ThemeProjectBranch { current: string; current_name: string; open: { id: string; name: string }[] }

export interface ThemeProjectRow {
  file_id: string;
  file_name: string;
  name: string;
  slug: string | null;
  target: ThemeTarget;
  profile?: string;
  from?: string;
  project_id?: string;
  folder?: string;
  updatedAt: number;
  thumbnail?: string;
  status: 'draft' | 'installed' | 'in-use';
  branch: ThemeProjectBranch;
  group?: string;
  /** Files brought into this project as branches: kept as they were, recoverable, no projects of their own. */
  merged_copies?: { file_id: string; name: string; branch_id: string; at: number; changed_after: boolean }[];
}

export interface ThemeProjectGroup { key: string; label: string; file_ids: string[]; reason: string }

/** Could be a theme file: its index says so, or its kind does, or it has the name Bogen gives a theme file. */
function themeLike(e: FileEntry): boolean {
  return Boolean(e.theme) || e.project?.type === 'omarchy-theme' || e.name.endsWith(SUFFIX.desktop) || e.name.endsWith(SUFFIX.mobile);
}

/** Entries read and found not to be themes, by the updatedAt they were read at, so they are not read on every call. */
const notThemes = new WeakMap<Storage, Map<string, number>>();

/** Reads one stored file's theme record without loading it into a room, and keeps it in the index. */
async function indexStored(app: BogenServer, entry: FileEntry): Promise<boolean> {
  const live = app.rooms.peek(entry.id);
  if (live) return refreshThemeIndex(app.storage, entry.id, live.doc) || Boolean(app.storage.get(entry.id)?.theme);
  const state = await app.storage.readDoc(entry.id).catch(() => null);
  if (!state) return false;
  const probe = new BogenDoc(new Y.Doc());
  try {
    Y.applyUpdate(probe.y, state);
    refreshThemeIndex(app.storage, entry.id, probe);
    return Boolean(app.storage.get(entry.id)?.theme);
  } catch (e) {
    console.error(`bogen: could not read theme ${entry.id}: ${errorMessage(e)}`);
    return false;
  } finally {
    probe.y.destroy();
  }
}

/**
 * Indexes up to `limit` theme-like entries that have no index yet, those `first` prefers before the newest. Returns
 * how many are still unread.
 */
async function fillIndex(app: BogenServer, limit: number, first?: (e: FileEntry) => boolean): Promise<number> {
  const skip = notThemes.get(app.storage) ?? new Map<string, number>();
  notThemes.set(app.storage, skip);
  const missing = app.storage.list().filter((e) => !e.theme && themeLike(e) && skip.get(e.id) !== e.updatedAt);
  if (first) missing.sort((a, b) => Number(first(b)) - Number(first(a)));
  let read = 0;
  for (const entry of missing) {
    if (read >= limit) break;
    read++;
    if (!(await indexStored(app, entry))) skip.set(entry.id, entry.updatedAt);
  }
  return Math.max(0, missing.length - read);
}

function nameOfFile(entry: FileEntry): { name: string; target: ThemeTarget } {
  for (const target of ['mobile', 'desktop'] as const) if (entry.name.endsWith(SUFFIX[target])) return { name: entry.name.slice(0, -SUFFIX[target].length), target };
  return { name: entry.name, target: entry.project?.platforms?.includes('mobile') ? 'mobile' : 'desktop' };
}

export interface StatusOf { (row: { slug: string | null; target: ThemeTarget }): ThemeProjectRow['status'] }

function rowOf(entry: FileEntry, status: StatusOf): ThemeProjectRow {
  const t = entry.theme;
  const fallback = t ? null : nameOfFile(entry);
  const name = t?.name ?? fallback!.name;
  const target = t?.target ?? fallback!.target;
  const slug = t ? t.slug : themeSlug(name);
  const branch: ThemeProjectBranch = t
    ? { current: t.branch, current_name: t.branchName ?? (t.branch === MAIN_BRANCH ? 'Main' : t.branch), open: t.branches }
    : { current: MAIN_BRANCH, current_name: 'Main', open: [{ id: MAIN_BRANCH, name: 'Main' }] };
  return {
    file_id: entry.id, file_name: entry.name, name, slug, target, ...(t?.profile ? { profile: t.profile } : target === 'mobile' ? { profile: 'komodo' } : {}),
    ...(t?.from ? { from: t.from } : {}), ...(t?.project ? { project_id: t.project } : {}), ...(entry.folder ? { folder: entry.folder } : {}),
    updatedAt: entry.updatedAt, ...(entry.thumbnail ? { thumbnail: entry.thumbnail } : {}), status: status({ slug, target }), branch,
  };
}

const lower = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Groups of files that look like versions of one logical theme: the same target, profile, starting theme and name,
 * or copies of one project (the same project id). For the person to consolidate; never merged by Bogen.
 */
export function groupProjects(rows: ThemeProjectRow[]): ThemeProjectGroup[] {
  const groups: ThemeProjectGroup[] = [];
  const byName = new Map<string, ThemeProjectRow[]>();
  for (const r of rows) {
    const key = `name:${r.target}:${r.profile ?? ''}:${r.from ?? ''}:${r.slug ?? lower(r.name)}`;
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    const r = list[0]!;
    groups.push({ key, label: r.from ? `${r.name} (from ${r.from})` : r.name, file_ids: list.map((x) => x.file_id), reason: `${list.length} files with the same name, ${r.target === 'mobile' ? `mobile (${r.profile})` : 'desktop'} target and ${r.from ? `starting theme ${r.from}` : 'no starting theme'}: likely versions of one theme. Nothing is merged automatically.` });
    for (const x of list) x.group ??= key;
  }
  const byProject = new Map<string, ThemeProjectRow[]>();
  for (const r of rows) if (r.project_id && !r.group) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
  for (const [id, list] of byProject) {
    if (list.length < 2) continue;
    const key = `project:${id}`;
    groups.push({ key, label: list[0]!.name, file_ids: list.map((x) => x.file_id), reason: `${list.length} files are copies of one theme project (${id}). Nothing is merged automatically.` });
    for (const x of list) x.group = key;
  }
  return groups;
}

/** Every theme project, newest first, from the index; at most `fallback` old entries are read to index them. */
export async function themeProjects(app: BogenServer, status: StatusOf, fallback = LIBRARY_FALLBACK): Promise<{ projects: ThemeProjectRow[]; groups: ThemeProjectGroup[]; unindexed: number }> {
  const unindexed = await fillIndex(app, fallback);
  const all = app.storage.list().filter((e) => e.theme || (themeLike(e) && e.project?.type !== 'design' && !notThemes.get(app.storage)?.has(e.id)));
  // A file brought into another project is one of that project's sources now: listed with it, never on its own, as
  // long as that project is there.
  const isSource = (e: FileEntry) => Boolean(e.theme?.consolidatedInto && app.storage.get(e.theme.consolidatedInto.fileId));
  const projects = all.filter((e) => !isSource(e)).map((e) => rowOf(e, status));
  for (const e of all.filter(isSource)) {
    const row = projects.find((p) => p.file_id === e.theme!.consolidatedInto!.fileId);
    if (!row) continue;
    (row.merged_copies ??= []).push({ file_id: e.id, name: e.name, branch_id: e.theme!.consolidatedInto!.branchId, at: e.theme!.consolidatedInto!.at, changed_after: changedAfterConsolidation(e) });
  }
  const groups = groupProjects(projects);
  return { projects, groups, unindexed };
}

// ---------------------------------------------------------------- finding the project a request means

export interface ResolveInput {
  from?: string;
  /** The installed theme `from` names was made by Bogen: then the file it came from is its own project too. */
  fromBogen?: boolean;
  name?: string;
  /** The name a new file would get when no name is given, such as "Tokyo Night Custom". */
  defaultName?: string;
  target: ThemeTarget;
  profile?: string;
}

export type Resolution =
  | { kind: 'reuse'; row: ThemeProjectRow }
  | { kind: 'choose'; candidates: ThemeProjectRow[]; reason: string }
  | { kind: 'create'; unindexed: number };

/**
 * Which existing project a create request means. Exactly one strong match is reused; several plausible ones, or a new
 * name beside projects from the same starting theme, are a choice for the caller; none is a new theme. Never picks
 * the newest of several. The caller holds the creation lock.
 */
export async function resolveThemeProject(app: BogenServer, input: ResolveInput): Promise<Resolution> {
  const wantSlug = input.name ? themeSlug(input.name) : null;
  const defaultSlug = input.defaultName ? themeSlug(input.defaultName) : null;
  const named = (name: string) => {
    const slug = themeSlug(name);
    return (wantSlug && slug === wantSlug) || (input.name && lower(name) === lower(input.name)) || (!input.name && defaultSlug && slug === defaultSlug);
  };
  const unindexed = await fillIndex(app, RESOLVE_FALLBACK, (e) => named(nameOfFile(e).name) || Boolean(input.from && e.name.toLowerCase().includes(input.from.replace(/-/g, ' '))));
  const none = () => 'draft' as const;
  const profile = input.target === 'mobile' ? input.profile ?? 'komodo' : undefined;
  const rows = app.storage.list().filter((e) => e.theme && !(e.theme.consolidatedInto && app.storage.get(e.theme.consolidatedInto.fileId))).map((e) => rowOf(e, none))
    .filter((r) => r.target === input.target && (r.profile ?? undefined) === profile);
  const sameSource = (r: ThemeProjectRow) => Boolean(input.from) && (r.from === input.from || (Boolean(input.fromBogen) && r.slug === input.from));
  if (input.name) {
    const byName = rows.filter((r) => named(r.name));
    if (byName.length === 1) return { kind: 'reuse', row: byName[0]! };
    if (byName.length > 1) return { kind: 'choose', candidates: byName, reason: `${byName.length} theme files are named ${input.name}.` };
    const fromSource = rows.filter(sameSource);
    if (fromSource.length) return { kind: 'choose', candidates: fromSource, reason: `No theme is named ${input.name}, but ${fromSource.length === 1 ? 'a theme' : `${fromSource.length} themes`} started from ${input.from} already: continue one of them, or make a separate new theme on purpose.` };
    return { kind: 'create', unindexed };
  }
  if (input.from) {
    // An installed theme Bogen made came from the file that installs under its name: that file is the project.
    const own = input.fromBogen ? rows.filter((r) => r.slug === input.from) : [];
    if (own.length === 1) return { kind: 'reuse', row: own[0]! };
    const fromSource = rows.filter((r) => sameSource(r) || (!r.from && named(r.name)));
    if (fromSource.length === 1) return { kind: 'reuse', row: fromSource[0]! };
    if (fromSource.length > 1) return { kind: 'choose', candidates: fromSource, reason: `${fromSource.length} theme files started from ${input.from}.` };
    return { kind: 'create', unindexed };
  }
  const sourceless = rows.filter((r) => !r.from);
  if (sourceless.length) return { kind: 'choose', candidates: sourceless.slice(0, 20), reason: `Neither a starting theme nor a name was given, and ${sourceless.length === 1 ? 'a theme' : `${sourceless.length} themes`} of your own exist${sourceless.length === 1 ? 's' : ''}: continue one, or make a separate new theme on purpose.` };
  return { kind: 'create', unindexed };
}

/** What a needs-choice answer lists of each candidate. */
export function candidateOf(r: ThemeProjectRow) {
  return { file_id: r.file_id, name: r.name, ...(r.from ? { from: r.from } : {}), target: r.target, ...(r.profile ? { profile: r.profile } : {}), updatedAt: r.updatedAt, ...(r.folder ? { folder: r.folder } : {}), branch: r.branch };
}

// ---------------------------------------------------------------- one creation at a time

const locks = new WeakMap<object, Promise<unknown>>();

/** Runs theme creations of one server one after another, so that concurrent identical requests make one file. */
export function serialized<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}
