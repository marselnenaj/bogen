import {
  BRAND_FIELD_DEFAULTS, BRAND_SECTIONS, brandItemsMap, confirmBrandItems, deleteBrandItem, markBrandFields, setBrandField, upsertBrandItem,
  type BrandData, type BrandFields, type BrandItemBase, type BrandSection,
} from './brand.ts';
import type { BogenDoc } from './doc.ts';

/**
 * Reviewing suggestions in bulk: each unconfirmed value next to what binds now, field by field, with where it came
 * from, and what confirming or dismissing it does. A suggestion is one of three things:
 *
 * - new: nothing binding says the same thing; confirming makes it bind, dismissing removes it;
 * - an edit of a value that was confirmed in the last version, such as an agent correcting a colour; confirming keeps
 *   the edit, dismissing puts the confirmed value back;
 * - a second take on a confirmed value with the same name or token, as an extraction makes; confirming writes the
 *   suggested values into the confirmed one and removes the suggestion, so that no duplicate is left, and dismissing
 *   removes the suggestion.
 */

export interface SuggestionChange { field: string; from: string | null; to: string }

export interface SuggestionRow {
  /** The item id, or `field:<name>` for a field such as tone. */
  key: string;
  section: BrandSection | 'fields';
  name: string;
  source?: string;
  note?: string;
  status: 'new' | 'edit' | 'replaces';
  /** For `replaces`: the confirmed item it would be written into. */
  target?: string;
  changes: SuggestionChange[];
}

export const REVIEW_SECTION_LABELS: Record<BrandSection | 'fields', string> = {
  fields: 'Identity and settings', colors: 'Colours', pairings: 'Pairs', logos: 'Logos', families: 'Font families', typeScale: 'Type scale', spacing: 'Spacing',
  radius: 'Radius', rules: 'Rules', words: 'Words', voiceExamples: 'Voice examples', artboards: 'Examples', assets: 'Assets',
};

/** The fields worth comparing per section, in the order a person reads them. */
const SHOWN: Record<BrandSection, string[]> = {
  colors: ['value', 'name', 'role', 'token', 'modes'], pairings: ['fg', 'bg', 'verdict'], logos: ['name', 'asset', 'svg', 'background', 'minWidth', 'clearSpace', 'aspect'],
  families: ['family', 'role', 'weights', 'fallback', 'license', 'assets', 'token'], typeScale: ['size', 'weight', 'lineHeight', 'tracking', 'family', 'role', 'name', 'token'],
  spacing: ['value', 'name', 'token'], radius: ['value', 'name', 'token'], rules: ['text', 'kind', 'severity', 'topic', 'check', 'lang'], words: ['word', 'use', 'instead', 'severity', 'lang'],
  voiceExamples: ['good', 'bad', 'lang'], artboards: ['nodeId', 'name', 'verdict', 'template'], assets: ['asset', 'name', 'kind', 'tags', 'alt'],
};

/** What makes two items of a section the same thing, so that a suggestion can say which confirmed value it competes with. */
const SAME: Record<BrandSection, (item: Record<string, unknown>) => string[]> = {
  colors: (i) => [`token:${i.token}`, `name:${String(i.name).toLowerCase()}`], pairings: (i) => [`${i.fg}|${i.bg}`], logos: (i) => [`name:${String(i.name).toLowerCase()}`],
  families: (i) => [`${String(i.family).toLowerCase()}|${String(i.role).toLowerCase()}`], typeScale: (i) => [`token:${i.token}`, `name:${String(i.name).toLowerCase()}`],
  spacing: (i) => [`token:${i.token}`, `value:${i.value}`], radius: (i) => [`token:${i.token}`, `value:${i.value}`], rules: (i) => [`${String(i.text).toLowerCase()}|${i.lang ?? ''}`],
  // The same word in two languages is two words: "Team" may be right in English and in German.
  words: (i) => [`${String(i.word).toLowerCase()}|${i.lang ?? ''}`], voiceExamples: (i) => i.good ? [`good:${String(i.good).toLowerCase()}|${i.lang ?? ''}`] : i.bad ? [`bad:${String(i.bad).toLowerCase()}|${i.lang ?? ''}`] : [], artboards: (i) => [String(i.nodeId)], assets: (i) => [String(i.asset)],
};

const OPTIONAL = ['source', 'note', 'instead', 'check', 'template', 'svg', 'usage', 'aspect', 'modes', 'lang'];

function show(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function nameOf(section: BrandSection, item: Record<string, unknown>): string {
  return String(item.name ?? item.family ?? item.word ?? item.text ?? item.good ?? (section === 'pairings' ? `${item.fg} on ${item.bg}` : item.id)).slice(0, 120);
}

/** Every suggestion, with what binds now beside it. `previous` is the last published version, where there is one. */
export function brandSuggestions(data: BrandData, previous?: BrandData): SuggestionRow[] {
  const out: SuggestionRow[] = [];
  for (const key of data.suggestedFields as (keyof BrandFields)[]) {
    if (!(key in BRAND_FIELD_DEFAULTS)) continue;
    const before = previous ? previous.fields[key] : BRAND_FIELD_DEFAULTS[key];
    out.push({ key: `field:${key}`, section: 'fields', name: key, status: show(before) === null ? 'new' : 'edit', changes: [{ field: key, from: show(before), to: show(data.fields[key]) ?? '' }] });
  }
  for (const section of BRAND_SECTIONS) {
    const items = data[section] as unknown as (BrandItemBase & Record<string, unknown>)[];
    const bound = items.filter((i) => !i.suggested);
    const bySame = new Map<string, BrandItemBase & Record<string, unknown>>();
    for (const b of bound) for (const k of SAME[section](b)) if (!bySame.has(k)) bySame.set(k, b);
    const was = new Map(((previous?.[section] ?? []) as unknown as (BrandItemBase & Record<string, unknown>)[]).filter((i) => !i.suggested).map((i) => [i.id, i]));
    for (const item of items) {
      if (!item.suggested) continue;
      const earlier = was.get(item.id);
      const rival = earlier ? undefined : SAME[section](item).map((k) => bySame.get(k)).find(Boolean);
      const against = earlier ?? rival;
      const all = SHOWN[section].map((field) => ({ field, from: against ? show(against[field]) : null, to: show(item[field]) ?? '' }));
      const changes = against ? all.filter((c) => c.from !== (c.to || null)) : all.filter((c) => c.to !== '');
      out.push({
        key: item.id, section, name: nameOf(section, item), ...(item.source ? { source: item.source } : {}), ...(item.note ? { note: item.note } : {}),
        status: earlier ? 'edit' : rival ? 'replaces' : 'new', ...(rival ? { target: rival.id } : {}),
        changes: changes.length ? changes : [{ field: SHOWN[section][0]!, from: against ? show(against[SHOWN[section][0]!]) : null, to: show(item[SHOWN[section][0]!]) ?? '' }],
      });
    }
  }
  return out;
}

/** Makes these suggestions bind. A suggestion that replaces a confirmed value is written into it. Returns how many. */
export function confirmSuggestions(doc: BogenDoc, rows: SuggestionRow[], origin?: unknown): number {
  let n = 0;
  doc.transact(() => {
    const plain = rows.filter((r) => r.status !== 'replaces').map((r) => (r.section === 'fields' ? r.key.slice('field:'.length) : r.key));
    if (plain.length) n += confirmBrandItems(doc, plain);
    const items = brandItemsMap(doc);
    for (const r of rows.filter((x) => x.status === 'replaces' && x.target && x.section !== 'fields')) {
      const m = items.get(r.key);
      if (!m || !items.get(r.target!)) continue;
      const patch: Record<string, unknown> = { id: r.target };
      // Include empty optional fields too: a new SVG must not silently keep the old SVG or asset.
      for (const field of SHOWN[r.section as BrandSection]) patch[field] = m.get(field);
      for (const field of ['source', 'note']) if (m.has(field)) patch[field] = m.get(field);
      upsertBrandItem(doc, r.section as BrandSection, patch);
      deleteBrandItem(doc, r.key);
      n++;
    }
  }, origin);
  return n;
}

/** Takes these suggestions back: new ones and second takes go, edits return to the last version's value. Returns how many. */
export function dismissSuggestions(doc: BogenDoc, rows: SuggestionRow[], previous?: BrandData, origin?: unknown): number {
  let n = 0;
  doc.transact(() => {
    for (const r of rows) {
      if (r.section === 'fields') {
        const key = r.key.slice('field:'.length) as keyof BrandFields;
        if (!(key in BRAND_FIELD_DEFAULTS)) continue;
        setBrandField(doc, key, (previous ? previous.fields[key] : BRAND_FIELD_DEFAULTS[key]) as never);
        markBrandFields(doc, [key], false);
        n++;
        continue;
      }
      const old = r.status === 'edit' ? ((previous?.[r.section] ?? []) as unknown as (BrandItemBase & Record<string, unknown>)[]).find((i) => i.id === r.key) : undefined;
      if (old) {
        // Back to exactly what the version held: what the suggestion added goes too.
        const cleared = Object.fromEntries(OPTIONAL.map((k) => [k, undefined]));
        upsertBrandItem(doc, r.section, { ...cleared, ...old, suggested: undefined });
      } else deleteBrandItem(doc, r.key);
      n++;
    }
  }, origin);
  return n;
}
