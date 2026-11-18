import type { BogenDoc } from './doc.ts';

/**
 * A design critique: what an independent reviewer, a fresh model session that only saw pictures of the screens, the
 * brand and a studio brief, found. Kept on the file, one entry per round, so the person sees the history.
 */
export const CRITIQUE_DIMENSIONS = ['state', 'consistency', 'hierarchy', 'copy', 'layout', 'brand'] as const;
export type CritiqueDimension = typeof CRITIQUE_DIMENSIONS[number];
export const CRITIQUE_KINDS = ['state', 'consistency', 'copy', 'colour', 'brand', 'layout', 'hierarchy', 'naming', 'generated', 'craft'] as const;
export type CritiqueKind = typeof CRITIQUE_KINDS[number];

export interface CritiqueFinding {
  /** 1-based screen numbers as the reviewer was shown them. */
  screens: number[];
  kind: CritiqueKind;
  title: string;
  /** What in the picture proves it: the visible words, a colour, a count. */
  evidence: string;
  fix: string;
  /** Visible text of the element it is about, as the reviewer quoted it. */
  quote?: string;
  /** The layer it resolved to, or the screen's artboard. */
  nodeId?: string;
  /** The thread it was pinned as. */
  threadId?: string;
  /** When an agent run was started to fix it. The next round's reviewer checks whether it really was. */
  addressed?: number;
}

export interface CritiqueNote { title: string; detail: string; screens?: number[]; /** When a fix run took it on. */ addressed?: number }

/** What the next reviewer saw of a finding the maker says it fixed. */
export interface CritiqueRecheck { title: string; fixed: boolean }

export interface CritiqueRecord {
  id: string;
  at: number;
  /** The artboards, in the order the reviewer saw them. */
  screens: { id: string; name: string }[];
  pageId?: string;
  /** Rounds of one loop share a series; a lone review is a series of one. */
  series: string;
  round: number;
  maxRounds: number;
  until?: number;
  reviewer: string;
  score: number;
  dimensions: Partial<Record<CritiqueDimension, number>>;
  verdict: string;
  defects: CritiqueFinding[];
  taste: CritiqueNote[];
  keep: string[];
  /** The findings of the round before that a fix run took on, as this round's reviewer judged them. */
  rechecked?: CritiqueRecheck[];
  /** What the rule checks found first, handed to the reviewer as input. */
  ruleFindings: number;
  durationMs: number;
  tokens?: { input: number; output: number };
  costUsd?: number;
}

const PREFIX = 'critique:';
/** Older rounds beyond this are dropped from the file. */
export const MAX_CRITIQUES = 30;

export function getCritiques(doc: BogenDoc): CritiqueRecord[] {
  const out: CritiqueRecord[] = [];
  for (const [key, value] of doc.meta) {
    if (!key.startsWith(PREFIX) || typeof value !== 'string') continue;
    try {
      const r = JSON.parse(value) as CritiqueRecord;
      if (r && typeof r.id === 'string' && typeof r.score === 'number' && Array.isArray(r.defects)) out.push(r);
    } catch { /* A damaged entry is skipped. */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function addCritique(doc: BogenDoc, record: CritiqueRecord, origin?: unknown): void {
  const all = getCritiques(doc);
  doc.transact(() => {
    doc.meta.set(PREFIX + record.id, JSON.stringify(record));
    for (const old of all.slice(MAX_CRITIQUES - 1)) doc.meta.delete(PREFIX + old.id);
  }, origin);
}

export function updateCritique(doc: BogenDoc, id: string, change: (r: CritiqueRecord) => CritiqueRecord, origin?: unknown): CritiqueRecord | null {
  const raw = doc.meta.get(PREFIX + id);
  if (typeof raw !== 'string') return null;
  const next = change(JSON.parse(raw) as CritiqueRecord);
  doc.transact(() => doc.meta.set(PREFIX + id, JSON.stringify(next)), origin);
  return next;
}

/** The rounds before this one in the same loop, oldest first. */
export function critiqueSeries(doc: BogenDoc, series: string): CritiqueRecord[] {
  return getCritiques(doc).filter((r) => r.series === series).sort((a, b) => a.round - b.round);
}

/** Whether a round meets its loop's bar: no objective defect left and, with a target, the score at or above it. */
export function critiqueMet(r: Pick<CritiqueRecord, 'defects' | 'score' | 'until'>): boolean {
  return r.defects.length === 0 && (r.until === undefined || r.score >= r.until);
}

const clamp = (n: unknown, lo: number, hi: number): number | undefined => {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 10) / 10)) : undefined;
};
const text = (v: unknown, max = 600): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const screensOf = (v: unknown, count: number): number[] => {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return [...new Set(list.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x >= 1 && x <= count))];
};

/** The JSON object in a reviewer's answer: a fenced block, or the outermost braces. */
export function critiqueJson(answer: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer);
  const body = fenced ? fenced[1]! : answer;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The reviewer answered without the JSON result.');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * The reviewer's answer as a critique, checked and trimmed: unknown kinds become craft, screens out of range are
 * dropped, a finding without evidence is not a defect (it moves to taste), and the score stays within 0 to 10.
 */
export function parseCritique(answer: string, screenCount: number): Pick<CritiqueRecord, 'score' | 'dimensions' | 'verdict' | 'defects' | 'taste' | 'keep' | 'rechecked'> {
  const raw = critiqueJson(answer) as Record<string, unknown>;
  const score = clamp(raw.score, 0, 10);
  if (score === undefined) throw new Error('The reviewer gave no score.');
  const dims: Partial<Record<CritiqueDimension, number>> = {};
  const rawDims = (raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : {}) as Record<string, unknown>;
  for (const d of CRITIQUE_DIMENSIONS) { const v = clamp(rawDims[d], 0, 10); if (v !== undefined) dims[d] = v; }
  const defects: CritiqueFinding[] = [];
  const taste: CritiqueNote[] = [];
  for (const f of Array.isArray(raw.defects) ? raw.defects : []) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const title = text(o.title, 200);
    if (!title) continue;
    const evidence = text(o.evidence);
    const screens = screensOf(o.screens ?? o.screen, screenCount);
    if (!evidence) { taste.push({ title, detail: text(o.fix), ...(screens.length ? { screens } : {}) }); continue; }
    const kind = (CRITIQUE_KINDS as readonly string[]).includes(String(o.kind)) ? o.kind as CritiqueKind : 'craft';
    const quote = text(o.quote, 200);
    defects.push({ screens, kind, title, evidence, fix: text(o.fix), ...(quote ? { quote } : {}) });
  }
  for (const n of Array.isArray(raw.taste) ? raw.taste : []) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const title = text(o.title, 200);
    if (title) { const screens = screensOf(o.screens, screenCount); taste.push({ title, detail: text(o.detail ?? o.fix), ...(screens.length ? { screens } : {}) }); }
  }
  const keep = (Array.isArray(raw.keep) ? raw.keep : []).map((k) => text(typeof k === 'object' && k ? (k as { title?: unknown }).title : k, 300)).filter(Boolean);
  const rechecked: CritiqueRecheck[] = [];
  for (const r of Array.isArray(raw.rechecked) ? raw.rechecked : []) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const title = text(o.title, 200);
    if (title && typeof o.fixed === 'boolean') rechecked.push({ title, fixed: o.fixed });
  }
  return {
    score, dimensions: dims, verdict: text(raw.verdict, 800), defects: defects.slice(0, 40), taste: taste.slice(0, 16), keep: keep.slice(0, 12),
    ...(rechecked.length ? { rechecked: rechecked.slice(0, 40) } : {}),
  };
}
