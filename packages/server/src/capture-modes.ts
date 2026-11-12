import { createMode, getModes, setTokenMode, Y, type BogenDoc, type NewNode, type TokenKind } from '@bogen/core';

/**
 * A second capture of a site in another colour scheme fills in a theme mode instead of a second set
 * of hard-coded colours. The page's own variables give the mode's values for tokens by name. Where the
 * page has none, the two captures are walked side by side, and what differs between them becomes a
 * token with one value in each mode, in both artboards.
 */
export interface ModePlan {
  mode: string;
  baseName: string;
  /** The artboard of the other colour scheme, if there is one. */
  counterpart?: string;
}

export interface ModeReport {
  mode: string;
  base: string;
  pair: string | null;
  /** Tokens whose value in this mode comes from the page's variables. */
  from_variables: number;
  /** Tokens made or filled from comparing the two captures. */
  from_comparison: number;
  /** Layer values that are tokens now instead of hard-coded colours. */
  layers_tokenized: number;
  note?: string;
}

const MAP = 'snapshotSources';

interface CaptureRecord { url: string; colorScheme: string }

function records(doc: BogenDoc): Y.Map<CaptureRecord> {
  return doc.y.getMap(MAP);
}

export function recordCapture(doc: BogenDoc, nodeId: string, url: string, colorScheme: string, origin: unknown): void {
  doc.transact(() => records(doc).set(nodeId, { url, colorScheme }), origin);
}

/** Where an artboard was captured from, if it was. */
export function recordedCapture(doc: BogenDoc, nodeId: string): CaptureRecord | null {
  const r = records(doc).get(nodeId);
  return r && typeof r === 'object' && typeof r.url === 'string' ? r : null;
}

const sameSite = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return a === b;
  }
};

/** Decides before a capture whether it is meant to fill a mode: asked for, or the same site in another scheme. */
export function planModeCapture(doc: BogenDoc, options: { url: string; colorScheme?: string; mode?: string; pairWith?: string }): ModePlan | null {
  const scheme = options.colorScheme ?? 'dark';
  if (options.pairWith && !doc.getNode(options.pairWith)) throw new Error(`No layer with id ${options.pairWith} to compare with.`);
  let counterpart = options.pairWith;
  if (!counterpart) {
    const known: [string, CaptureRecord][] = [];
    records(doc).forEach((r, id) => { if (doc.nodes.has(id) && r && typeof r === 'object') known.push([id, r]); });
    counterpart = known.reverse().find(([, r]) => r.colorScheme !== scheme && sameSite(r.url, options.url))?.[0];
  }
  if (!counterpart && !options.mode) return null;
  const mode = options.mode ?? scheme;
  const recorded = counterpart ? records(doc).get(counterpart)?.colorScheme : undefined;
  const baseName = getModes(doc).find((m) => m.base)?.name ?? (recorded && recorded !== mode ? recorded : mode === 'light' ? 'dark' : 'light');
  return { mode, baseName, ...(counterpart ? { counterpart } : {}) };
}

const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)/gi;
const COLOR_PROPS = /^(color|background|backgroundColor|backgroundImage|border|border\w*Color|border(Top|Right|Bottom|Left)|outline|outlineColor|boxShadow|textShadow|textDecorationColor|WebkitTextFillColor|WebkitTextStrokeColor|fill|stroke)$/;
const WHOLE_VAR = /^var\(--([\w-]+)\)$/;

function roleOf(prop: string): string {
  if (prop === 'color' || /Text/.test(prop)) return 'text';
  if (/^background/.test(prop)) return 'surface';
  if (/^border|^outline/.test(prop)) return 'border';
  if (/Shadow/.test(prop)) return 'shadow';
  return 'color';
}

interface Pairing {
  doc: BogenDoc;
  mode: string;
  base: string;
  tokenized: number;
  filled: Set<string>;
  byPair: Map<string, string>;
  counters: Map<string, number>;
  /** Layers in the first artboard to rewrite, once all is known. */
  rewrites: Map<string, Record<string, string>>;
}

function tokenFor(p: Pairing, prop: string, a: string, b: string): string {
  const pair = `${a}\u0000${b}`;
  const known = p.byPair.get(pair);
  if (known) return known;
  const tokens = p.doc.getTokens();
  const norm = (v: string) => v.trim().toLowerCase();
  const existing = tokens.find((t) => norm(t.value) === norm(a) && (t.modes?.[p.mode] === undefined || norm(t.modes[p.mode]!) === norm(b)));
  let name: string;
  if (existing) name = existing.name;
  else {
    const role = roleOf(prop);
    let n = p.counters.get(role) ?? 0;
    do {
      n++;
      name = `${role}-${n}`;
    } while (p.doc.tokens.has(name));
    p.counters.set(role, n);
    p.doc.setToken(name, 'color' as TokenKind, a);
  }
  setTokenMode(p.doc, name, p.mode, b);
  p.filled.add(name);
  p.byPair.set(pair, name);
  return name;
}

/** The colours in a value, with what surrounds them, if both sides have the same shape. */
function pairedColors(a: string, b: string): { pairs: [string, string][]; rewrite: (names: string[]) => string } | null {
  const ca = a.match(COLOR) ?? [];
  const cb = b.match(COLOR) ?? [];
  if (!ca.length || ca.length !== cb.length) return null;
  const shape = (v: string) => v.replace(COLOR, '\u0001');
  if (shape(a) !== shape(b)) return null;
  const parts = a.split(COLOR);
  return {
    pairs: ca.map((c, i) => [c, cb[i]!] as [string, string]),
    rewrite: (names) => parts.map((part, i) => (i < names.length ? `${part}var(--${names[i]})` : part)).join(''),
  };
}

function compareStyles(p: Pairing, id: string, styleA: Record<string, string>, styleB: Record<string, string>): void {
  for (const prop of Object.keys(styleB)) {
    if (!COLOR_PROPS.test(prop)) continue;
    const a = styleA[prop];
    const b = styleB[prop]!;
    if (a === undefined || a === b) continue;
    const varA = WHOLE_VAR.exec(a)?.[1];
    const varB = WHOLE_VAR.exec(b)?.[1];
    // This capture read the page's variables live, so a variable on this side is already right.
    if (varB) continue;
    if (varA) {
      if (!p.doc.tokens.has(varA)) continue;
      const whole = b.match(COLOR);
      if (whole?.length === 1 && whole[0] === b) {
        const has = p.doc.getTokens().find((t) => t.name === varA)?.modes?.[p.mode];
        if (has === undefined || has === b) {
          setTokenMode(p.doc, varA, p.mode, b);
          p.filled.add(varA);
          styleB[prop] = a;
          p.tokenized++;
        }
      }
      continue;
    }
    const paired = pairedColors(a, b);
    if (!paired || paired.pairs.every(([x, y]) => x === y)) continue;
    // Colours that stay the same stay as they are, but only whole values can skip tokens altogether.
    const names = paired.pairs.map(([x, y]) => tokenFor(p, prop, x, y));
    const value = paired.rewrite(names);
    styleB[prop] = value;
    const rewrites = p.rewrites.get(id) ?? {};
    rewrites[prop] = value;
    p.rewrites.set(id, rewrites);
    p.tokenized += 2;
  }
}

function walk(p: Pairing, id: string, spec: NewNode): void {
  const a = p.doc.rawNode(id);
  if (!a) return;
  if (spec.style) compareStyles(p, id, a.style, spec.style);
  const kids = p.doc.rawKids(id);
  const specs = spec.children ?? [];
  // A part that is built differently in the two schemes cannot be compared layer by layer.
  if (kids.length !== specs.length) return;
  kids.forEach((kid, i) => {
    const other = p.doc.rawNode(kid);
    if (other && other.tag === (specs[i]!.tag ?? other.tag) && other.type === specs[i]!.type) walk(p, kid, specs[i]!);
  });
}

/** Called with a finished capture, before it is placed. Changes the capture and the file. */
export function fillMode(doc: BogenDoc, plan: ModePlan, capture: { root: NewNode; tokens: { name: string; kind: TokenKind; value: string }[] }, origin: unknown): ModeReport {
  let fromVariables = 0;
  const pairing: Pairing = { doc, mode: plan.mode, base: plan.baseName, tokenized: 0, filled: new Set(), byPair: new Map(), counters: new Map(), rewrites: new Map() };
  doc.transact(() => {
    createMode(doc, plan.mode, { baseName: plan.baseName });
    if (plan.mode !== getModes(doc).find((m) => m.base)?.name) {
      const had = new Map(doc.getTokens().map((t) => [t.name, t]));
      for (const t of capture.tokens) {
        const token = had.get(t.name);
        if (!token) {
          doc.setToken(t.name, t.kind, t.value);
          continue;
        }
        if (token.value.trim().toLowerCase() === t.value.trim().toLowerCase()) continue;
        setTokenMode(doc, t.name, plan.mode, t.value);
        fromVariables++;
      }
    }
    if (plan.counterpart) {
      walk(pairing, plan.counterpart, capture.root);
      for (const [id, patch] of pairing.rewrites) doc.updateStyle(id, patch);
      const first = doc.rawNode(plan.counterpart);
      if (first && !first.mode) doc.updateFields(plan.counterpart, { mode: plan.baseName });
    }
    capture.root.mode = plan.mode;
  }, origin);
  const report: ModeReport = { mode: plan.mode, base: plan.baseName, pair: plan.counterpart ?? null, from_variables: fromVariables, from_comparison: pairing.filled.size, layers_tokenized: pairing.tokenized };
  if (!fromVariables && !pairing.filled.size) report.note = 'Nothing differs between the two captures. The site may switch themes with a class or a setting rather than with prefers-color-scheme, which is the only thing a capture changes.';
  return report;
}
