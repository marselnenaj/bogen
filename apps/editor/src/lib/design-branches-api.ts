import { t } from '../i18n/store.ts';

/**
 * Branches inside one file: named versions of the whole design (layers, components, tokens, the file's records such
 * as a theme's palette and name) kept in the same document. One is checked out and is the live design. Same server
 * contract as `packages/server/src/http/branch-routes.ts`. Kind-neutral: any design, an Omarchy or a Mac theme alike.
 *
 * Merging, discarding, restoring and taking a merge back are the person's decisions: only their clicks call them.
 */

export type BranchStatus = 'open' | 'merged' | 'discarded';
export interface DesignBranchRow {
  id: string;
  name: string;
  parent: string | null;
  status: BranchStatus;
  current: boolean;
  changed: boolean;
  by: string;
  at: string | null;
  note?: string;
  imported?: { fileId: string; name: string; at: number };
  canRestore?: boolean;
  /** Edits from a device that came back after a checkout, kept as they came: they could not be laid on safely. */
  held?: HeldUpdate[];
}
export interface HeldUpdate { id: string; /** ISO time, as the server writes it. */ at: string; from: string; bytes: number; layers: string[]; inFile: boolean; path?: string }
export interface BranchSummary { current: string; branches: DesignBranchRow[]; decided: DesignBranchRow[] }
export type BranchSide = 'branch' | 'primary';
export type BranchResolve = BranchSide | Record<string, BranchSide>;
export interface BranchConflict { key: string; kind: string; label: string; primary: 'changed' | 'removed' | 'added'; branch: 'changed' | 'removed' | 'added' }
export interface MergePreview { branch: DesignBranchRow; into: DesignBranchRow; conflicts: BranchConflict[]; parent_changed: boolean; branch_changed: boolean }
export type MergeAnswer =
  | ({ merged: DesignBranchRow; into: DesignBranchRow; checkpoint: string } & BranchSummary)
  | ({ merged: null; conflicts: BranchConflict[] } & BranchSummary);

export const MAIN = 'main';

async function call<T>(path: string, init?: RequestInit, accept409 = false): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Reported below.
  }
  if (res.ok || (accept409 && res.status === 409 && body && typeof body === 'object' && 'conflicts' in body)) return body as T;
  throw new Error((body as { error?: string } | null)?.error ?? t('The server answered {status}.', { status: res.status }));
}

const send = (method: string, data: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const base = (fileId: string) => `/api/files/${encodeURIComponent(fileId)}/design-branches`;
const one = (fileId: string, id: string) => `${base(fileId)}/${encodeURIComponent(id)}`;

export const designBranches = {
  list: (fileId: string) => call<BranchSummary>(base(fileId)),
  create: (fileId: string, body: { name: string; from?: string; checkout?: boolean; note?: string }) => call<{ branch: DesignBranchRow; reused: boolean } & BranchSummary>(base(fileId), send('POST', { ...body, by: 'person' })),
  switchTo: (fileId: string, id: string) => call<{ branch: DesignBranchRow } & BranchSummary>(`${one(fileId, id)}/switch`, send('POST', { by: 'person' })),
  rename: (fileId: string, id: string, name: string) => call<{ branch: DesignBranchRow } & BranchSummary>(one(fileId, id), send('PATCH', { name, by: 'person' })),
  preview: (fileId: string, id: string) => call<MergePreview>(`${one(fileId, id)}/merge`),
  /** The person's merge. A 409 with conflicts is an answer, not an error: nothing was merged. */
  merge: (fileId: string, id: string, resolve?: BranchResolve) => call<MergeAnswer>(`${one(fileId, id)}/merge`, send('POST', { ...(resolve ? { resolve } : {}), by: 'person' }), true),
  undoMerge: (fileId: string, id: string) => call<{ branch: DesignBranchRow } & BranchSummary>(`${one(fileId, id)}/undo-merge`, send('POST', { by: 'person' })),
  discard: (fileId: string, id: string) => call<BranchSummary>(`${one(fileId, id)}/discard`, send('POST', { by: 'person' })),
  restore: (fileId: string, id: string) => call<{ branch: DesignBranchRow } & BranchSummary>(`${one(fileId, id)}/restore`, send('POST', { by: 'person' })),
};

// ---------------------------------------------------------------- the person's answers to a merge's conflicts

/** What the person chose so far, conflict by conflict. */
export type Choices = Readonly<Record<string, BranchSide>>;

/** Every conflict to one side. */
export function chooseAll(conflicts: readonly BranchConflict[], side: BranchSide): Record<string, BranchSide> {
  return Object.fromEntries(conflicts.map((c) => [c.key, side]));
}

/** The conflicts still without an answer. */
export function unresolved(conflicts: readonly BranchConflict[], choices: Choices): BranchConflict[] {
  return conflicts.filter((c) => choices[c.key] !== 'branch' && choices[c.key] !== 'primary');
}

/**
 * The `resolve` a merge sends: nothing without conflicts, one side when every answer is that side, else the answer per
 * conflict. Null while a conflict has no answer: the merge waits for the person. Answers to conflicts that are no
 * longer there are left out.
 */
export function resolvePayload(conflicts: readonly BranchConflict[], choices: Choices): BranchResolve | undefined | null {
  if (!conflicts.length) return undefined;
  if (unresolved(conflicts, choices).length) return null;
  const sides = new Set(conflicts.map((c) => choices[c.key]!));
  if (sides.size === 1) return [...sides][0]!;
  return Object.fromEntries(conflicts.map((c) => [c.key, choices[c.key]!]));
}

/** Keeps the answers that still apply after the conflicts changed, for instance after a 409 with new ones. */
export function keepChoices(conflicts: readonly BranchConflict[], choices: Choices): Record<string, BranchSide> {
  const keys = new Set(conflicts.map((c) => c.key));
  return Object.fromEntries(Object.entries(choices).filter(([k]) => keys.has(k)));
}

/** Whether a summary has anything besides main, open or decided: then the control shows the branch by name. */
export function hasBranches(summary: BranchSummary | null): boolean {
  return Boolean(summary && (summary.branches.some((b) => b.id !== MAIN) || summary.decided.length));
}

/** Held-back updates of a branch, one line per device that sent them, in the order they first came. */
export function heldLines(held: readonly HeldUpdate[] | undefined): { from: string; count: number }[] {
  const out = new Map<string, number>();
  for (const h of [...(held ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) out.set(h.from, (out.get(h.from) ?? 0) + 1);
  return [...out].map(([from, count]) => ({ from, count }));
}
