import * as Y from 'yjs';
import type { BogenDoc, BogenNode } from './doc.ts';

/**
 * Renaming a token, with every reference to it. A token is a CSS variable, so a reference is `var(--name)` in any
 * value the file stores: layer styles, rules for states and conditions, attributes, drawings, text ranges, instance
 * props and overrides, component mains (which are layers too), text styles, other tokens, keyframes and captured
 * interaction states. A reference with a fallback, `var(--name, 4px)`, counts as well.
 *
 * Each rename is noted in the file's meta (`tokenRenames`), so that a library or a brand that publishes the file's
 * design system can carry it to the files that use it, where `applyTokenRenames` makes the same rename.
 */

export interface TokenRename { from: string; to: string; at: number }
export const TOKEN_RENAMES_KEY = 'tokenRenames';
const MAX_RENAMES = 64;
const TOKEN_NAME = /^[a-zA-Z_][\w-]*$/;

/** Where a rename found references, by what holds them. */
export interface TokenRenameReport {
  from: string;
  to: string;
  /** Layers whose style, rules, attributes, drawing, text ranges, props or overrides named it. */
  layers: number;
  /** Of those, layers inside a component main. */
  components: number;
  /** Other tokens that read it, such as an alias. */
  tokens: number;
  textStyles: number;
  /** Keyframes and captured interaction states. */
  other: number;
  /** Every reference rewritten. */
  references: number;
}

/** `var(--name`, also with spaces, and never a longer name that only begins with it. */
function varPattern(name: string): RegExp {
  return new RegExp(`var\\(\\s*--${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
}

/** A string, array or plain object with every reference swapped, and how many there were. */
function swapDeep(value: unknown, re: RegExp, to: string): { value: unknown; count: number } {
  if (typeof value === 'string') {
    let count = 0;
    const out = value.replace(re, () => {
      count++;
      return `var(--${to}`;
    });
    return { value: count ? out : value, count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((v) => {
      const r = swapDeep(v, re, to);
      count += r.count;
      return r.value;
    });
    return { value: count ? out : value, count };
  }
  if (value && typeof value === 'object' && !(value instanceof Y.AbstractType) && !(value instanceof Uint8Array)) {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = swapDeep(v, re, to);
      count += r.count;
      out[k] = r.value;
    }
    return { value: count ? out : value, count };
  }
  return { value, count: 0 };
}

function swapMap(map: Y.Map<unknown>, re: RegExp, to: string): number {
  let count = 0;
  for (const [key, value] of [...map.entries()] as [string, unknown][]) {
    if (value instanceof Y.Map) {
      count += swapMap(value as Y.Map<unknown>, re, to);
      continue;
    }
    if (value instanceof Y.AbstractType) continue;
    const r = swapDeep(value, re, to);
    if (r.count) {
      map.set(key, r.value);
      count += r.count;
    }
  }
  return count;
}

/** The renames a file has made, oldest first. Stored values are checked: they may come from another device. */
export function tokenRenames(doc: BogenDoc): TokenRename[] {
  return cleanTokenRenames(doc.meta.get(TOKEN_RENAMES_KEY));
}

/** A list of renames as stored or published, checked. */
export function cleanTokenRenames(raw: unknown): TokenRename[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is TokenRename => Boolean(r) && typeof r === 'object' && typeof r.from === 'string' && typeof r.to === 'string' && typeof r.at === 'number' && TOKEN_NAME.test(r.from) && TOKEN_NAME.test(r.to));
}

/**
 * Where each old name ended up after the renames made after `since` (all of them by default): a to b, then b to c
 * gives a to c, and b to c. A name renamed back to itself drops out.
 */
export function resolveRenames(renames: readonly TokenRename[], since = 0): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of renames) {
    if (r.at <= since) continue;
    for (const [from, to] of out) if (to === r.from) out.set(from, r.to);
    out.set(r.from, r.to);
  }
  for (const [from, to] of [...out]) if (from === to) out.delete(from);
  return out;
}

/** Points every reference to `from` at `to`, leaving the tokens themselves alone. Inside the caller's transaction. */
function remapReferences(doc: BogenDoc, from: string, to: string, report: TokenRenameReport): void {
  const re = varPattern(from);
  const inMain = (id: string) => {
    let cur: string | undefined = id;
    for (let guard = 0; cur && guard < 500; guard++) {
      const m = doc.nodes.get(cur);
      if (!m) return false;
      if (m.get('component') !== undefined) return true;
      cur = m.get('parent') as string | undefined;
    }
    return false;
  };
  const withSpans: string[] = [];
  doc.nodes.forEach((m, id) => {
    let count = 0;
    for (const key of ['style', 'overrides', 'rules', 'props', 'attrs', 'svg', 'component']) {
      const v = m.get(key);
      if (v === undefined) continue;
      if (v instanceof Y.Map) count += swapMap(v as Y.Map<unknown>, re, to);
      else if (!(v instanceof Y.AbstractType)) {
        const r = swapDeep(v, re, to);
        if (r.count) {
          m.set(key, r.value);
          count += r.count;
        }
      }
    }
    if (m.get('spans') !== undefined || m.get('rich') !== undefined) withSpans.push(id);
    if (count) {
      report.layers++;
      if (inMain(id)) report.components++;
      report.references += count;
    }
  });
  // Text ranges also live in the layer's rich text, so they are written through the text model.
  for (const id of withSpans) {
    const spans = doc.getNode(id)?.spans;
    if (!spans?.length) continue;
    const r = swapDeep(spans, re, to);
    if (!r.count) continue;
    doc.updateFields(id, { spans: r.value as BogenNode['spans'] });
    report.references += r.count;
    report.layers++;
    if (inMain(id)) report.components++;
  }
  doc.textStyles.forEach((m) => {
    if (!(m instanceof Y.Map)) return;
    const n = swapMap(m as Y.Map<unknown>, re, to);
    if (n) {
      report.textStyles++;
      report.references += n;
    }
  });
  doc.tokens.forEach((m) => {
    const n = swapMap(m as Y.Map<unknown>, re, to);
    if (n) {
      report.tokens++;
      report.references += n;
    }
  });
  const keyframes = doc.meta.get('keyframes');
  if (Array.isArray(keyframes)) {
    const r = swapDeep(keyframes, re, to);
    if (r.count) {
      doc.meta.set('keyframes', r.value);
      report.other += r.count;
      report.references += r.count;
    }
  }
  const states = doc.y.getMap<unknown>('interactionStates');
  for (const [key, value] of [...states.entries()]) {
    const r = swapDeep(value, re, to);
    if (r.count) {
      states.set(key, r.value);
      report.other += r.count;
      report.references += r.count;
    }
  }
}

const emptyReport = (from: string, to: string): TokenRenameReport => ({ from, to, layers: 0, components: 0, tokens: 0, textStyles: 0, other: 0, references: 0 });

/**
 * A token under a new name, in one transaction (one undo step): its values in all modes come along, and every
 * reference follows. Refuses a name that is taken, so that two tokens never fold into one by accident.
 */
export function renameToken(doc: BogenDoc, from: string, to: string, origin?: unknown, options: { record?: boolean } = {}): TokenRenameReport {
  const token = doc.getTokens().find((t) => t.name === from);
  if (!token) throw new Error(`There is no token "${from}".`);
  if (!TOKEN_NAME.test(to)) throw new Error(`"${to.slice(0, 60)}" cannot name a token. Use letters, digits, dashes and underscores, starting with a letter.`);
  const report = emptyReport(from, to);
  if (from === to) return report;
  if (doc.tokens.has(to)) throw new Error(`There is a token "${to}" already. Delete or rename it first, or pick another name.`);
  doc.transact(() => {
    doc.setToken(to, token.kind, token.value);
    for (const [mode, value] of Object.entries(token.modes ?? {})) doc.tokens.get(to)!.set(`mode:${mode}`, value);
    doc.deleteToken(from);
    remapReferences(doc, from, to, report);
    if (options.record !== false) doc.meta.set(TOKEN_RENAMES_KEY, [...tokenRenames(doc), { from, to, at: Date.now() }].slice(-MAX_RENAMES));
  }, origin);
  return report;
}

/** What renaming would touch, without changing anything. */
export function previewTokenRename(doc: BogenDoc, from: string, to: string): TokenRenameReport {
  if (!doc.tokens.has(from)) throw new Error(`There is no token "${from}".`);
  if (!TOKEN_NAME.test(to)) throw new Error(`"${to.slice(0, 60)}" cannot name a token. Use letters, digits, dashes and underscores, starting with a letter.`);
  if (from !== to && doc.tokens.has(to)) throw new Error(`There is a token "${to}" already. Delete or rename it first, or pick another name.`);
  const re = varPattern(from);
  const report = emptyReport(from, to);
  const count = (v: unknown): number => (v instanceof Y.Map ? [...(v as Y.Map<unknown>).values()].reduce<number>((n, x) => n + count(x), 0) : v instanceof Y.AbstractType ? 0 : swapDeep(v, re, to).count);
  doc.nodes.forEach((m, id) => {
    let n = 0;
    for (const key of ['style', 'overrides', 'rules', 'props', 'attrs', 'svg', 'component']) n += count(m.get(key));
    n += count(doc.getNode(id)?.spans ?? []);
    if (n) {
      report.layers++;
      report.references += n;
    }
  });
  doc.textStyles.forEach((m) => { const n = count(m); if (n) { report.textStyles++; report.references += n; } });
  doc.tokens.forEach((m, name) => { if (name === from) return; const n = count(m); if (n) { report.tokens++; report.references += n; } });
  const other = count(doc.meta.get('keyframes')) + count(doc.y.getMap<unknown>('interactionStates'));
  report.other = other;
  report.references += other;
  return report;
}

/**
 * Takes renames made by a library or a brand this file uses: each old token becomes the new one with everything that
 * refers to it. Where the file has the new name already (the update brought it), references move to that token and
 * the old one goes. Names the file does not have are passed over. Not noted as the file's own renames.
 */
export function applyTokenRenames(doc: BogenDoc, renames: ReadonlyMap<string, string>, origin?: unknown): TokenRenameReport[] {
  const out: TokenRenameReport[] = [];
  doc.transact(() => {
    for (const [from, to] of renames) {
      if (from === to || !doc.tokens.has(from) || !TOKEN_NAME.test(to)) continue;
      if (doc.tokens.has(to)) {
        const report = emptyReport(from, to);
        doc.deleteToken(from);
        remapReferences(doc, from, to, report);
        out.push(report);
      } else out.push(renameToken(doc, from, to, undefined, { record: false }));
    }
  }, origin);
  return out;
}
