import type { BogenDoc } from './doc.ts';

/**
 * What a person found when they tested a criterion that a design check cannot decide, such as "every function works
 * with the keyboard". Kept in the file, one meta entry per page and criterion, so that marks made on two devices merge,
 * travel with the file and say who marked what and when. A mark is a person's statement, never Bogen's.
 */
export type ComplianceResult = 'pass' | 'fail' | 'na';
export interface ComplianceMark {
  result: ComplianceResult;
  /** Who marked it: the person's name as the editor knows it. */
  by: string;
  /** When, in milliseconds since 1970. */
  at: number;
  note?: string;
}

const PREFIX = 'compliance:';
/** `wcag:1.4.3`, `en:9.6`, `proc:wzg-statement`, `legal:imprint`. */
const KEY = /^(?:wcag|en|proc|legal):[a-z0-9.-]{1,40}$/;
const SCOPE = /^(?:file|[0-9a-zA-Z_-]{1,64})$/;
const MAX_NOTE = 1000;
const MAX_NAME = 120;

export function isComplianceKey(key: string): boolean {
  return KEY.test(key);
}

function parseMark(value: unknown): ComplianceMark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.result !== 'pass' && v.result !== 'fail' && v.result !== 'na') return null;
  if (typeof v.by !== 'string' || !v.by.trim() || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
  const mark: ComplianceMark = { result: v.result, by: v.by.slice(0, MAX_NAME), at: v.at };
  if (typeof v.note === 'string' && v.note.trim()) mark.note = v.note.slice(0, MAX_NOTE);
  return mark;
}

/** The marks of one page, or of the whole file with scope `file`, by criterion key. */
export function getComplianceMarks(doc: BogenDoc, scope: string): Record<string, ComplianceMark> {
  const out: Record<string, ComplianceMark> = {};
  const head = `${PREFIX}${scope}:`;
  for (const [key, value] of doc.meta) {
    if (!key.startsWith(head)) continue;
    const criterion = key.slice(head.length);
    const mark = KEY.test(criterion) ? parseMark(value) : null;
    if (mark) out[criterion] = mark;
  }
  return out;
}

/** Records a person's result, or clears it with null. */
export function setComplianceMark(doc: BogenDoc, scope: string, criterion: string, mark: { result: ComplianceResult; by: string; note?: string; at?: number } | null, origin?: unknown): ComplianceMark | null {
  if (!SCOPE.test(scope)) throw new Error('A mark belongs to a page id or to file.');
  if (!KEY.test(criterion)) throw new Error(`"${criterion.slice(0, 50)}" is not a criterion key such as wcag:1.4.3.`);
  const key = `${PREFIX}${scope}:${criterion}`;
  if (mark === null) {
    doc.transact(() => doc.meta.delete(key), origin);
    return null;
  }
  const clean = parseMark({ ...mark, by: mark.by.trim(), at: mark.at ?? Date.now(), note: mark.note?.trim() });
  if (!clean) throw new Error('A mark needs a result of pass, fail or na, and the name of the person who tested.');
  doc.transact(() => doc.meta.set(key, { ...clean }), origin);
  return clean;
}
