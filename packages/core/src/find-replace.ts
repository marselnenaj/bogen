import type { BogenDoc, BogenNode, TextSpan } from './doc.ts';

/**
 * Find and replace text across a file. Only text layers of their own are changed: the words inside an
 * instance come from its main, so replacing in the main reaches every instance. Each replacement is a
 * small edit of the layer's CRDT text, so that ranges of weight or colour around it stay where they were
 * and somebody typing in the same layer keeps their words.
 */

export interface TextSearch {
  query: string;
  caseSensitive?: boolean;
  /** Only where the match is not part of a longer word. */
  wholeWord?: boolean;
}

export interface TextHit {
  id: string;
  pageId: string;
  name: string;
  text: string;
  /** Offsets of each match in `text`, in UTF-16. */
  at: number[];
  locked: boolean;
}

const WORD = /[\p{L}\p{N}_]/u;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Offsets where the search matches in a text, left to right, never overlapping. */
export function matchOffsets(text: string, search: TextSearch): number[] {
  const { query } = search;
  if (!query) return [];
  const re = new RegExp(escape(query), search.caseSensitive ? 'gu' : 'giu');
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const at = m.index;
    if (search.wholeWord) {
      const before = at > 0 ? text[at - 1]! : '';
      const after = text[at + m[0].length] ?? '';
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue;
    }
    out.push(at);
  }
  return out;
}

/** The length a match has at `at`: the query's, as matching ignores case but not length. */
function matchLength(search: TextSearch): number {
  return search.query.length;
}

/** The look of one character: the styles and link of the ranges over it. */
function lookAt(spans: readonly TextSpan[], at: number): { style: Record<string, string>; href: string | undefined } {
  const style: Record<string, string> = {};
  let href: string | undefined;
  for (const s of spans) {
    if (s.start > at || s.end <= at) continue;
    Object.assign(style, s.style ?? {});
    if (s.href) href = s.href;
  }
  return { style, href };
}

/** Layers whose text matches, in page order and then in layer order. Hidden layers count too. */
export function findText(doc: BogenDoc, search: TextSearch, scope?: { pageId?: string; within?: string[] }): TextHit[] {
  if (!search.query) return [];
  const out: TextHit[] = [];
  const locked = (n: BogenNode) => n.locked || doc.ancestors(n.id).some((a) => doc.rawNode(a)?.locked);
  const visit = (pageId: string, nodes: readonly BogenNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text' && typeof n.text === 'string' && n.instanceOf === undefined) {
        const at = matchOffsets(n.text, search);
        if (at.length) out.push({ id: n.id, pageId, name: n.name, text: n.text, at, locked: locked(n) });
      }
      // Inside an instance everything is computed from its main: not stored, not replaced here.
      if (n.instanceOf === undefined) visit(pageId, doc.rawChildren(n.id));
    }
  };
  const roots = scope?.within?.length ? scope.within.flatMap((id) => (doc.rawNode(id) ? [{ id, pageId: doc.pageOf(id) ?? '' }] : [])) : null;
  if (roots) for (const r of roots) visit(r.pageId, [doc.rawNode(r.id)!]);
  else for (const p of doc.getPages()) if (!scope?.pageId || scope.pageId === p.id) visit(p.id, doc.rawChildren(p.id));
  return out;
}

export interface ReplaceResult {
  /** How many matches were replaced. */
  replaced: number;
  /** The layers that changed. */
  layers: string[];
  /** Matches left alone, and why. */
  skipped: { id: string; reason: 'locked' }[];
}

/**
 * Replaces every match, or only those in `only`, in one transaction: one undo step. Locked layers and layers
 * inside locked frames are left alone and reported.
 */
export function replaceText(doc: BogenDoc, search: TextSearch, replacement: string, options: { pageId?: string; within?: string[]; only?: string[]; origin?: unknown } = {}): ReplaceResult {
  const hits = findText(doc, search, { pageId: options.pageId, within: options.within }).filter((h) => !options.only || options.only.includes(h.id));
  const result: ReplaceResult = { replaced: 0, layers: [], skipped: [] };
  const length = matchLength(search);
  doc.transact(() => {
    for (const hit of hits) {
      if (hit.locked) {
        result.skipped.push({ id: hit.id, reason: 'locked' });
        continue;
      }
      // From the last match back, so that earlier offsets still hold. Each step is one small edit.
      let text = hit.text;
      const spans = doc.getNode(hit.id)?.spans ?? [];
      for (const at of [...hit.at].reverse()) {
        const next = text.slice(0, at) + replacement + text.slice(at + length);
        text = doc.editText(hit.id, text, next);
        result.replaced++;
        // New words take the look of what they replace, not of the letter before them.
        if (replacement && spans.length) {
          const own = lookAt(spans, at);
          const left = at > 0 ? lookAt(spans, at - 1) : { style: {}, href: undefined };
          const patch: Record<string, string | null> = { ...own.style };
          for (const k of Object.keys(left.style)) if (!(k in patch)) patch[k] = null;
          const href = own.href !== left.href ? own.href ?? null : undefined;
          if (Object.keys(patch).length || href !== undefined) doc.formatText(hit.id, at, at + replacement.length, patch, href);
        }
      }
      result.layers.push(hit.id);
    }
  }, options.origin);
  return result;
}
