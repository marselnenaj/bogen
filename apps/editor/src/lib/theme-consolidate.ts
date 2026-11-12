import { t } from '../i18n/store.ts';

/**
 * Bringing copies of one theme together: the person picks the copy to keep as the project, reviews the server's
 * read-only plan, and confirms it. The other copies come in as branches of the kept one; their files stay as they are.
 * Same contract as `POST /api/omarchy/consolidate/plan` and `POST /api/omarchy/consolidate`.
 */

export interface PlanFile {
  file_id: string;
  name: string;
  theme: { name: string; target: 'desktop' | 'mobile'; profile?: string; from?: string } | null;
  updatedAt: number;
  layers: number;
  tokens: number;
  comments: number;
  assets: number;
  hash: string;
  /** Someone has it open and is editing it right now. */
  active: boolean;
  identicalTo?: string;
  alreadyImported?: string;
}
export interface PlanSource extends PlanFile { action: 'import' | 'comments' | 'skip'; branchName?: string; branchId?: string; reason?: string }
export interface ConsolidationPlan { target: PlanFile; sources: PlanSource[]; problems: string[]; ok: boolean; plan_hash: string; note: string }
export interface ConsolidationResult { imported: { file_id: string; branch_id: string; name: string; comments: number; history: string }[]; skipped: string[]; checkpoint: string; sources_kept: true }

/** Copies one plan takes besides the kept one. */
export const MAX_SOURCES = 11;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Reported below.
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? t('The server answered {status}.', { status: res.status }));
  return data as T;
}

export const consolidation = {
  /** Read-only: what would happen. */
  plan: (target: string, sources: string[]) => post<ConsolidationPlan>('/api/omarchy/consolidate/plan', { target, sources }),
  /** Does what the plan of that hash said, or nothing (409) when a file changed since or the plan has problems. */
  run: (target: string, sources: string[], planHash: string) => post<ConsolidationResult>('/api/omarchy/consolidate', { target, sources, plan_hash: planHash }),
};

// ---------------------------------------------------------------- pure: the steps

export type ConsolidateStep =
  | { step: 'pick'; target: string | null }
  | { step: 'review'; target: string; plan: ConsolidationPlan | null };
/** After a confirmed plan: the kept project and how many copies came in. */
export interface ConsolidatedNote { target: string; targetName: string; imported: number }

/** The first step: nothing chosen. The newest, the one in use or any other is never chosen for the person. */
export const startPick = (): ConsolidateStep => ({ step: 'pick', target: null });

/**
 * The copies to show for picking, in an order that says nothing about which to keep: by file id. Not by last edit,
 * not by status.
 */
export function pickOrder<T extends { file_id: string }>(copies: readonly T[]): T[] {
  return [...copies].sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0));
}

/** The copies that come in as branches: every copy of the group but the kept one. */
export function sourcesFor(copyIds: readonly string[], target: string): string[] {
  return [...new Set(copyIds)].filter((id) => id !== target);
}

/** Whether the person may go on to the review: a copy picked, and between one and eleven others. */
export function canReview(copyIds: readonly string[], target: string | null): boolean {
  if (!target || !copyIds.includes(target)) return false;
  const n = sourcesFor(copyIds, target).length;
  return n >= 1 && n <= MAX_SOURCES;
}

/** Copies the plan brings in as branches. */
export function importCount(plan: Pick<ConsolidationPlan, 'sources'>): number {
  return plan.sources.filter((s) => s.action !== 'skip').length;
}

/** Whether the person may confirm: the server says the plan is sound, it has no problems, and it brings something in. */
export function canConfirm(plan: ConsolidationPlan | null): boolean {
  return Boolean(plan && plan.ok && !plan.problems.length && plan.plan_hash && importCount(plan) > 0);
}

/**
 * The facts of each copy for the pick, from a read-only plan of the group: layers, tokens and comments are not in the
 * library's compact index. Which copy that plan was asked about as its target means nothing for the person.
 */
export function statsOf(plan: Pick<ConsolidationPlan, 'target' | 'sources'> | null): Map<string, PlanFile> {
  return new Map(plan ? [plan.target, ...plan.sources].map((f) => [f.file_id, f]) : []);
}
