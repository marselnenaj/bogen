import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { brandLinkOf, contrastRatio, listProposals, normalizeColor, proposalDecision, proposalMark, type BogenDoc, type BrandData, type BrandRule, type ProposalInfo, Y } from '@bogen/core';
import type { EventHub } from './events.ts';
import type { Room } from './sync.ts';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * What a person decided about proposals, per brand (or per file without one), and what the accepted ones have in
 * common against the discarded ones. Repeated patterns become suggestions for brand rules, which only a person
 * adds. Only design data is kept: the request and note of a proposal and measured features, no layer text,
 * no names of people and no pictures. It lives in `$BOGEN_HOME/memory/`, on this device, and does not sync.
 */

export interface DesignFeatures {
  layers: number;
  gradient: boolean;
  shadow: boolean;
  uppercase: boolean;
  /** Median corner radius in px, of layers that set one. */
  radius: number | null;
  /** Median gap and padding in px. Lower is denser. */
  spacing: number | null;
  /** The lowest contrast of text against the fill behind it, where both are plain colours. */
  contrast: number | null;
  fonts: number;
  colors: number;
}

export interface Decision {
  id: string;
  fileId: string;
  brandId?: string;
  decision: 'accepted' | 'discarded';
  at: number;
  /** The agent that made the proposal. */
  by: string;
  runner?: string;
  model?: string;
  /** What the run was asked, clipped. */
  request?: string;
  note?: string;
  features: DesignFeatures | null;
}

export type SuggestionAction = { rule: Pick<BrandRule, 'text' | 'kind' | 'severity' | 'topic' | 'check'> } | { field: { minContrast: number } };

export interface MemorySuggestion {
  id: string;
  /** What was seen, such as "You discarded 4 of 4 proposals with gradients." */
  why: string;
  /** The rule it would add, as a person reads it. */
  text: string;
  action: SuggestionAction;
  evidence: { accepted: number; discarded: number };
}

export interface MemoryView { decisions: number; accepted: number; discarded: number; files: number; suggestions: MemorySuggestion[]; recent: Decision[]; summary: string | null }

interface Book { decisions: Decision[]; dismissed: string[] }
interface Seen { info: ProposalInfo; features: DesignFeatures | null; children: string[]; look: string }

/** Where a layer sits is the original's to keep when a copy goes in, so it is left out. */
const PLACEMENT = /^(position|left|top|right|bottom|inset|zIndex|margin\w*|alignSelf|justifySelf|grid(Area|Column|Row)|order|translate|width|height)$/;

/** What a layer looks like, to recognise which copy went into the original. */
function lookOf(doc: BogenDoc, id: string): string {
  const node = doc.getNode(id);
  if (!node) return '';
  const style = Object.entries(node.style).filter(([k]) => !PLACEMENT.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify([node.tag, node.text ?? '', node.src ?? '', style]);
}
interface Origin { runId?: string; request?: string; runner?: string; model?: string }

const MAX_DECISIONS = 500;
const REQUEST_LIMIT = 300;
const NOTE_LIMIT = 140;
/** A pattern counts once it was seen this many times. */
const MIN_EVIDENCE = 3;
const SETTLE_MS = 400;
const KEY = /^[\w-]{1,80}$/;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
};

const PX = /(-?\d+(?:\.\d+)?)px/;
const firstPx = (v: string | undefined): number | null => {
  if (!v) return null;
  if (/^0(?:\s|$)/.test(v.trim())) return 0;
  const m = PX.exec(v);
  return m ? Number(m[1]) : null;
};

/** Resolves var(--name) through the file's tokens, a few levels deep. */
function resolver(doc: BogenDoc): (v: string | undefined) => string | undefined {
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  return (v) => {
    let out = v;
    for (let i = 0; out && i < 4 && out.includes('var('); i++) {
      out = out.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fallback?: string) => tokens.get(name) ?? fallback ?? '');
    }
    return out;
  };
}

/** Measures what a layer and everything inside it look like, from stored styles. No browser needed. */
export function designFeatures(doc: BogenDoc, rootId: string): DesignFeatures | null {
  const root = doc.getNode(rootId);
  if (!root) return null;
  const nodes = [root, ...doc.descendants(rootId)];
  const resolve = resolver(doc);
  const radii: number[] = [];
  const spacing: number[] = [];
  const fonts = new Set<string>();
  const colors = new Set<string>();
  let gradient = false;
  let shadow = false;
  let uppercase = false;
  let contrast: number | null = null;
  const fill = (id: string): string | null => {
    const node = doc.getNode(id);
    if (!node) return null;
    const bg = resolve(node.style.backgroundColor) ?? resolve(node.style.background);
    const c = bg ? normalizeColor(bg.trim()) : null;
    return c && c.length === 7 ? c : null;
  };
  for (const node of nodes) {
    const st = node.style;
    const bg = `${resolve(st.background) ?? ''} ${resolve(st.backgroundImage) ?? ''}`;
    if (/gradient\(/i.test(bg)) gradient = true;
    for (const key of ['boxShadow', 'textShadow'] as const) {
      const v = resolve(st[key])?.trim();
      if (v && v !== 'none') shadow = true;
    }
    if (/drop-shadow\(/i.test(resolve(st.filter) ?? '')) shadow = true;
    if (resolve(st.textTransform)?.trim() === 'uppercase') uppercase = true;
    const r = firstPx(resolve(st.borderRadius));
    if (r !== null) radii.push(r);
    for (const key of ['gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'] as const) {
      const v = firstPx(resolve(st[key]));
      if (v !== null && v > 0) spacing.push(v);
    }
    const family = resolve(st.fontFamily)?.split(',')[0]?.replace(/["']/g, '').trim().toLowerCase();
    if (family) fonts.add(family);
    for (const key of ['color', 'backgroundColor', 'borderColor'] as const) {
      const c = normalizeColor(resolve(st[key])?.trim());
      if (c) colors.add(c.slice(0, 7));
    }
    if (node.type === 'text') {
      const fg = normalizeColor(resolve(st.color)?.trim() ?? '') ?? [...doc.ancestors(node.id)].map((a) => normalizeColor(resolve(doc.getNode(a)?.style.color)?.trim() ?? '')).find(Boolean);
      const behind = [node.id, ...doc.ancestors(node.id)].map(fill).find(Boolean) ?? '#ffffff';
      if (fg) {
        const ratio = contrastRatio(fg.slice(0, 7), behind);
        contrast = contrast === null ? ratio : Math.min(contrast, ratio);
      }
    }
  }
  return { layers: nodes.length, gradient, shadow, uppercase, radius: median(radii), spacing: median(spacing), contrast, fonts: fonts.size, colors: colors.size };
}

const BOOLEAN_RULES: { feature: 'gradient' | 'shadow' | 'uppercase'; label: string; rule: NonNullable<BrandRule['check']>; text: string; topic: BrandRule['topic']; field?: 'gradients' | 'shadows' }[] = [
  { feature: 'gradient', label: 'gradients', rule: { type: 'no-gradient' }, text: 'No gradients', topic: 'color', field: 'gradients' },
  { feature: 'shadow', label: 'shadows', rule: { type: 'no-shadow' }, text: 'No shadows', topic: 'layout', field: 'shadows' },
  { feature: 'uppercase', label: 'all-caps text', rule: { type: 'no-uppercase' }, text: 'No all-caps text', topic: 'type' },
];

/** Patterns in decisions, as rules a person may add. Nothing here is applied. */
export function suggestRules(decisions: Decision[], brand: BrandData | null, dismissed: string[] = []): MemorySuggestion[] {
  const out: MemorySuggestion[] = [];
  const measured = decisions.filter((d) => d.features);
  const accepted = measured.filter((d) => d.decision === 'accepted');
  const discarded = measured.filter((d) => d.decision === 'discarded');
  const hasCheck = (type: string) => brand?.rules.some((r) => r.check?.type === type) ?? false;
  const add = (s: MemorySuggestion) => {
    if (!dismissed.includes(s.id)) out.push(s);
  };

  for (const b of BOOLEAN_RULES) {
    const withIt = measured.filter((d) => d.features![b.feature]);
    const gone = withIt.filter((d) => d.decision === 'discarded').length;
    if (gone < MIN_EVIDENCE || gone / withIt.length < 0.8) continue;
    if (hasCheck(b.rule.type) || (b.field && brand?.fields[b.field] === 'none')) continue;
    add({ id: `no-${b.feature}`, why: `You discarded ${gone} of ${withIt.length} proposals with ${b.label}.`, text: b.text, action: { rule: { text: b.text, kind: 'dont', severity: 'soft', topic: b.topic, check: b.rule } }, evidence: { accepted: withIt.length - gone, discarded: gone } });
  }

  const values = (list: Decision[], key: 'radius' | 'spacing' | 'contrast') => list.flatMap((d) => (d.features![key] === null ? [] : [d.features![key] as number]));
  const enough = (a: number[], d: number[]) => a.length >= 2 && d.length >= 2 && a.length + d.length >= MIN_EVIDENCE + 1;

  const ra = values(accepted, 'radius');
  const rd = values(discarded, 'radius');
  if (enough(ra, rd)) {
    const maxA = Math.max(...ra);
    const minA = Math.min(...ra);
    const medD = median(rd)!;
    if (medD >= maxA + 8) {
      const text = maxA === 0 ? 'Keep corners square: no radius' : `Keep corner radius at ${maxA}px or less`;
      add({ id: `radius-max-${maxA}`, why: `Accepted proposals ${maxA === 0 ? 'had square corners' : `keep corners at ${maxA}px or less`}; discarded ones had ${medD}px.`, text, action: { rule: { text, kind: 'do', severity: 'soft', topic: 'layout' } }, evidence: { accepted: ra.length, discarded: rd.length } });
    }
    else if (minA >= medD + 8) add({ id: `radius-min-${minA}`, why: `Accepted proposals have corners of ${minA}px or more; discarded ones had ${medD}px.`, text: `Use corner radius of ${minA}px or more`, action: { rule: { text: `Use corner radius of ${minA}px or more`, kind: 'do', severity: 'soft', topic: 'layout' } }, evidence: { accepted: ra.length, discarded: rd.length } });
  }

  const sa = values(accepted, 'spacing');
  const sd = values(discarded, 'spacing');
  if (enough(sa, sd)) {
    const medA = median(sa)!;
    const medD = median(sd)!;
    if (medA >= medD * 1.5) {
      const floor = Math.min(...sa);
      add({ id: `spacing-min-${floor}`, why: `Accepted proposals space things at ${medA}px on average, discarded ones at ${medD}px: you chose the airier ones.`, text: `Keep spacing generous: gaps and padding of ${floor}px or more`, action: { rule: { text: `Keep spacing generous: gaps and padding of ${floor}px or more`, kind: 'do', severity: 'soft', topic: 'layout' } }, evidence: { accepted: sa.length, discarded: sd.length } });
    } else if (medD >= medA * 1.5) {
      const ceiling = Math.max(...sa);
      add({ id: `spacing-max-${ceiling}`, why: `Accepted proposals space things at ${medA}px on average, discarded ones at ${medD}px: you chose the denser ones.`, text: `Keep layouts compact: gaps and padding up to ${ceiling}px`, action: { rule: { text: `Keep layouts compact: gaps and padding up to ${ceiling}px`, kind: 'do', severity: 'soft', topic: 'layout' } }, evidence: { accepted: sa.length, discarded: sd.length } });
    }
  }

  const ca = values(accepted, 'contrast');
  const cd = values(discarded, 'contrast');
  const minContrast = brand?.fields.minContrast ?? 4.5;
  if (enough(ca, cd)) {
    const floor = Math.floor(Math.min(...ca) * 2) / 2;
    const lowGone = cd.filter((c) => c < floor).length;
    if (floor >= minContrast + 1 && lowGone >= MIN_EVIDENCE - 1) add({ id: `contrast-${floor}`, why: `Every accepted proposal kept text at ${floor}:1 or more; ${lowGone} discarded ones went under it.`, text: `Text contrast of at least ${floor}:1`, action: { field: { minContrast: floor } }, evidence: { accepted: ca.length, discarded: lowGone } });
  }

  const manyFonts = discarded.filter((d) => d.features!.fonts > 2).length;
  if (manyFonts >= MIN_EVIDENCE && accepted.every((d) => d.features!.fonts <= 2) && !hasCheck('max-families')) {
    add({ id: 'fonts-max-2', why: `You discarded ${manyFonts} proposals that used more than two font families, and accepted none.`, text: 'Use at most two font families', action: { rule: { text: 'Use at most two font families', kind: 'do', severity: 'soft', topic: 'type', check: { type: 'max-families', value: 2 } } }, evidence: { accepted: 0, discarded: manyFonts } });
  }
  return out;
}

/** Two short lines for agents: what the person chose, which is not a rule. */
export function memorySummary(decisions: Decision[], suggestions: MemorySuggestion[]): string | null {
  if (!decisions.length) return null;
  const accepted = decisions.filter((d) => d.decision === 'accepted').length;
  const parts = [`${decisions.length} proposals decided in linked files: ${accepted} accepted, ${decisions.length - accepted} discarded.`];
  if (suggestions.length) parts.push(`Seen: ${suggestions.slice(0, 3).map((s) => s.why.replace(/\.$/, '')).join('; ')}.`);
  parts.push('A preference, not a rule: only rules bind.');
  return parts.join(' ').slice(0, 600);
}

interface Deps {
  home: string;
  hub: EventHub;
  /** The request of a run, from the run history. */
  request: (fileId: string, runId: string) => Promise<{ request?: string; runner?: string; model?: string } | undefined>;
}

export class DecisionMemory {
  private books = new Map<string, Promise<Book>>();
  private writes = new Map<string, Promise<void>>();
  private origins = new Map<string, Origin>();
  private refreshers = new Map<string, () => void>();

  constructor(private readonly deps: Deps) {}

  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('Not a memory key.');
    return join(this.deps.home, 'memory', `${key}.json`);
  }

  private book(key: string): Promise<Book> {
    let book = this.books.get(key);
    if (!book) {
      book = readFile(this.path(key), 'utf8').then((raw) => {
        const parsed = JSON.parse(raw) as Partial<Book>;
        return { decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [], dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.filter((s): s is string => typeof s === 'string') : [] };
      }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') console.error(`bogen: memory ${key} was unreadable, starting it again: ${errorMessage(e)}`);
        return { decisions: [], dismissed: [] };
      });
      this.books.set(key, book);
    }
    return book;
  }

  private save(key: string, book: Book): Promise<void> {
    const body = `${JSON.stringify(book, null, 1)}\n`;
    const write = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(dirname(this.path(key)), { recursive: true });
      await atomicWrite(this.path(key), body, 0o600);
    });
    this.writes.set(key, write);
    return write;
  }

  static keyOf(fileId: string, brandId?: string): string {
    return brandId ?? `file-${fileId}`;
  }

  /** Where a proposal came from: the run that made it, or the request of a race. */
  noteOrigin(fileId: string, proposalId: string, origin: Origin): void {
    this.origins.set(`${fileId}:${proposalId}`, origin);
  }

  /** Follows a file's proposals: their features while open, the decision when they go. */
  watch(room: Room): void {
    const { doc } = room;
    const cache = new Map<string, Seen>();
    const measure = (p: ProposalInfo) => cache.set(p.id, { info: p, features: designFeatures(doc, p.id), children: doc.getChildren(p.id).map((c) => c.id), look: lookOf(doc, p.id) });
    for (const p of listProposals(doc)) measure(p);
    let timer: NodeJS.Timeout | null = null;
    const remeasure = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const p of listProposals(doc)) measure(p);
    };
    this.refreshers.set(room.id, remeasure);
    const onNodes = (events: Y.YEvent<any>[], tx: Y.Transaction) => {
      const top = events.find((e) => e.path.length === 0);
      const gone: Seen[] = [];
      for (const [id, { action }] of top?.changes.keys ?? []) {
        if (action === 'add') {
          if (proposalMark(doc, id)) {
            const info = listProposals(doc).find((p) => p.id === id);
            if (info) measure(info);
          }
        } else if (action === 'delete' && cache.has(id)) {
          gone.push(cache.get(id)!);
          cache.delete(id);
        }
      }
      const changed = tx.changed as Map<unknown, unknown>;
      for (const of of new Set(gone.map((g) => g.info.of))) {
        const group = gone.filter((g) => g.info.of === of);
        const source = doc.nodes.get(of);
        const style = source?.get('style') as Y.Map<string> | undefined;
        // As in file-events: the original changed in the same step, so a copy's content went into it. Accepting one
        // direction removes the others in that same step: the one that went in took its children, or its look.
        const touched = Boolean(source && (changed.has(source) || (style && changed.has(style)) || events.some((e) => e.path[0] === of)));
        const explicit = group.filter((g) => proposalDecision(doc, g.info.id)?.source === of);
        let winner = explicit.find((g) => proposalDecision(doc, g.info.id)?.decision === 'accepted');
        // Older clients have no receipt; keep the existing inference as a compatibility fallback.
        if (!explicit.length && touched) {
          const now = lookOf(doc, of);
          winner = group.find((g) => g.children.some((c) => doc.getNode(c)?.parent === of)) ?? group.find((g) => g.look === now) ?? (group.length === 1 ? group[0] : undefined);
        }
        for (const entry of group) {
          const accepted = entry === winner;
          void this.record(room.id, doc, entry.info, accepted ? 'accepted' : 'discarded', accepted ? designFeatures(doc, of) : entry.features);
        }
      }
      if (cache.size && !timer) {
        timer = setTimeout(remeasure, SETTLE_MS);
        timer.unref();
      }
    };
    doc.nodes.observeDeep(onNodes);
  }

  /** Measures open proposals now, before a decision that the server makes: a discarded copy is gone afterwards. */
  refresh(fileId: string): void {
    this.refreshers.get(fileId)?.();
  }

  private async record(fileId: string, doc: BogenDoc, info: ProposalInfo, decision: Decision['decision'], features: DesignFeatures | null): Promise<void> {
    try {
      const brandId = brandLinkOf(doc)?.id;
      const origin = this.origins.get(`${fileId}:${info.id}`);
      this.origins.delete(`${fileId}:${info.id}`);
      const fromRun = origin?.runId ? await this.deps.request(fileId, origin.runId) : undefined;
      const request = (origin?.request ?? fromRun?.request)?.replace(/\s+/g, ' ').trim().slice(0, REQUEST_LIMIT);
      const runner = origin?.runner ?? fromRun?.runner;
      const model = origin?.model ?? fromRun?.model;
      const entry: Decision = {
        id: info.id, fileId, ...(brandId ? { brandId } : {}), decision, at: Date.now(), by: info.by.slice(0, 40),
        ...(runner ? { runner } : {}), ...(model ? { model } : {}), ...(request ? { request } : {}), ...(info.note ? { note: info.note.slice(0, NOTE_LIMIT) } : {}), features,
      };
      const key = DecisionMemory.keyOf(fileId, brandId);
      const book = await this.book(key);
      book.decisions = [entry, ...book.decisions.filter((d) => d.id !== entry.id)].slice(0, MAX_DECISIONS);
      await this.save(key, book);
      this.deps.hub.broadcast({ t: 'memory', fileId, ...(brandId ? { brandId } : {}) });
    } catch (e) {
      console.error(`bogen: could not remember a decision in ${fileId}: ${errorMessage(e)}`);
    }
  }

  async view(key: string, brand: BrandData | null): Promise<MemoryView> {
    const book = await this.book(key);
    const suggestions = suggestRules(book.decisions, brand, book.dismissed);
    const accepted = book.decisions.filter((d) => d.decision === 'accepted').length;
    return {
      decisions: book.decisions.length, accepted, discarded: book.decisions.length - accepted,
      files: new Set(book.decisions.map((d) => d.fileId)).size, suggestions, recent: book.decisions.slice(0, 12),
      summary: memorySummary(book.decisions, suggestions),
    };
  }

  /** The decisions about these proposals, as kept: what was asked for each and its note. */
  async decisionsOf(key: string, proposalIds: string[]): Promise<Decision[]> {
    const wanted = new Set(proposalIds);
    return (await this.book(key)).decisions.filter((d) => wanted.has(d.id));
  }

  async dismiss(key: string, suggestionId: string): Promise<void> {
    const book = await this.book(key);
    if (!book.dismissed.includes(suggestionId)) book.dismissed = [...book.dismissed, suggestionId].slice(-200);
    await this.save(key, book);
  }

  /** Waits for what is being written, for tests and for a clean exit. */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }
}
