import type { BogenDoc } from './doc.ts';
import type { BrandData, BrandFields, BrandRule } from './brand.ts';
import type { BrandBookChapterId } from './brand-book.ts';

/**
 * A designed edition of a brand book: a Bogen file in which an agent art-directed the brand's guidelines as editable
 * pages, next to the book Bogen generates from the data. The file keeps which brand it shows and what each part of the
 * brand held when the edition was made, as a short fingerprint per part, so that the brand page can say which parts
 * changed since and which pages to refresh. Nothing of the brand itself is copied into the record.
 */

/** The parts of a brand a book shows, in the book's order. */
export const EDITION_PARTS = ['identity', 'logo', 'colour', 'type', 'layout', 'voice', 'imagery', 'applications', 'rules'] as const;
export type EditionPart = typeof EDITION_PARTS[number];
/** The English names of the parts, as a book and an agent call them. The editor translates them. */
export const EDITION_PART_NAMES: Record<EditionPart, string> = {
  identity: 'Idea and positioning', logo: 'Logo', colour: 'Colour', type: 'Type', layout: 'Layout and space',
  voice: 'Voice', imagery: 'Imagery', applications: 'Applications', rules: 'Rules',
};

/** On the edition file: which brand it shows and the brand's parts as they were. */
export const EDITION_META = 'brandEdition';
/** On the brand: the newest designed edition. */
export const BRAND_EDITION_META = 'designedEdition';

export interface BrandEditionRecord {
  brandId: string;
  brandName: string;
  /** When the edition was made, or last refreshed. */
  at: number;
  /** A fingerprint per part of the brand as the edition shows it. */
  parts: Record<EditionPart, string>;
  /** The page the book is on, and the page with the generated book as a reference. */
  pageId: string;
  referencePageId?: string;
  /** The run that made it or refreshes it now. */
  runId?: string;
  /** Review rounds a run on it may take: one unless the person asked for more. */
  rounds?: number;
  /** A refresh that has not finished: its fingerprints count once its run is done. */
  pending?: { runId: string; parts: Record<EditionPart, string>; at: number };
}

const FIELD_PART: Partial<Record<keyof BrandFields, EditionPart>> = {
  name: 'identity', positioning: 'identity', audience: 'identity',
  tone: 'voice', language: 'voice', languages: 'voice', address: 'voice', sentenceWords: 'voice', paragraphSentences: 'voice', headingMinWords: 'voice', headingMaxWords: 'voice', numberFormat: 'voice',
  layoutNotes: 'layout', grid: 'layout', container: 'layout',
  minContrast: 'colour', pairingDefault: 'colour', offPalette: 'colour',
  license: 'rules', shadows: 'rules', gradients: 'rules',
};
const RULE_PART: Record<BrandRule['topic'], EditionPart> = { general: 'rules', color: 'colour', type: 'type', layout: 'layout', imagery: 'imagery', iconography: 'imagery', logo: 'logo', voice: 'voice' };
const CHAPTER_PART: Record<BrandBookChapterId, EditionPart> = {
  strategy: 'identity', audience: 'identity', architecture: 'identity', principles: 'identity', logo: 'logo', color: 'colour', type: 'type',
  layout: 'layout', imagery: 'imagery', icons: 'imagery', voice: 'voice', motion: 'applications', data: 'applications', applications: 'applications',
  accessibility: 'rules', governance: 'rules',
};
/** What changes on its own or says nothing about how the brand looks or speaks. */
const IGNORE = new Set(['id', 'usage', 'source', 'order']);

/** FNV-1a, 32 bits, as hex: the same in the browser and on the server, and short. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function plain(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([k]) => !IGNORE.has(k)));
}

/** The brand's parts as fingerprints. Two brands that print the same book have the same ones. */
export function brandEditionParts(data: BrandData): Record<EditionPart, string> {
  const parts = Object.fromEntries(EDITION_PARTS.map((p) => [p, [] as unknown[]])) as Record<EditionPart, unknown[]>;
  for (const [key, part] of Object.entries(FIELD_PART) as [keyof BrandFields, EditionPart][]) parts[part].push([key, data.fields[key] ?? null]);
  for (const c of data.colors) parts.colour.push(plain(c));
  for (const p of data.pairings) parts.colour.push(plain(p));
  for (const l of data.logos) parts.logo.push(plain(l));
  for (const f of data.families) parts.type.push(plain(f));
  for (const s of data.typeScale) parts.type.push(plain(s));
  for (const s of data.spacing) parts.layout.push(plain(s));
  for (const r of data.radius) parts.layout.push(plain(r));
  for (const r of data.rules) parts[RULE_PART[r.topic] ?? 'rules'].push(plain(r));
  for (const w of data.words) parts.voice.push(plain(w));
  for (const v of data.voiceExamples) parts.voice.push(plain(v));
  for (const a of data.artboards) parts.applications.push(plain(a));
  for (const a of data.assets) parts[a.kind === 'font' ? 'type' : 'imagery'].push(plain(a));
  for (const t of data.treatments) parts.imagery.push(plain(t));
  for (const d of data.devices ?? []) parts.imagery.push(plain(d));
  for (const c of data.book?.chapters ?? []) {
    const part = CHAPTER_PART[c.id as BrandBookChapterId];
    if (part) parts[part].push({ id: c.id, status: c.status, markdown: c.markdown, questions: c.questions, lang: c.lang ?? null });
  }
  return Object.fromEntries(EDITION_PARTS.map((p) => [p, hash(JSON.stringify(parts[p]))])) as Record<EditionPart, string>;
}

/** The parts of the brand that changed since the edition was made, in the book's order. */
export function changedEditionParts(record: Pick<BrandEditionRecord, 'parts'>, data: BrandData): EditionPart[] {
  const now = brandEditionParts(data);
  return EDITION_PARTS.filter((p) => record.parts[p] !== now[p]);
}

const PART_SET = new Set<string>(EDITION_PARTS);
function cleanParts(raw: unknown): Record<EditionPart, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Partial<Record<EditionPart, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (PART_SET.has(k) && typeof v === 'string' && /^[0-9a-f]{8}$/.test(v)) out[k as EditionPart] = v;
  return EDITION_PARTS.every((p) => out[p]) ? out as Record<EditionPart, string> : null;
}

/** The record on an edition file, checked: it syncs from other devices, so nothing in it is trusted as it comes. */
export function readBrandEdition(doc: BogenDoc): BrandEditionRecord | null {
  const raw = doc.meta.get(EDITION_META) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const parts = cleanParts(raw.parts);
  if (typeof raw.brandId !== 'string' || !/^[0-9a-z]{4,40}$/.test(raw.brandId) || !parts || typeof raw.pageId !== 'string') return null;
  const pending = raw.pending as Record<string, unknown> | undefined;
  const pendingParts = pending && typeof pending === 'object' ? cleanParts(pending.parts) : null;
  return {
    brandId: raw.brandId, brandName: typeof raw.brandName === 'string' ? raw.brandName.slice(0, 200) : '', at: typeof raw.at === 'number' ? raw.at : 0, parts, pageId: raw.pageId,
    ...(typeof raw.referencePageId === 'string' ? { referencePageId: raw.referencePageId } : {}),
    ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
    ...(typeof raw.rounds === 'number' && Number.isInteger(raw.rounds) && raw.rounds >= 1 && raw.rounds <= 5 ? { rounds: raw.rounds } : {}),
    ...(pending && pendingParts && typeof pending.runId === 'string' ? { pending: { runId: pending.runId, parts: pendingParts, at: typeof pending.at === 'number' ? pending.at : 0 } } : {}),
  };
}

export function writeBrandEdition(doc: BogenDoc, record: BrandEditionRecord, origin?: unknown): void {
  doc.transact(() => doc.meta.set(EDITION_META, JSON.parse(JSON.stringify(record))), origin);
}

/** The newest designed edition of a brand, as the brand records it: the file's id. */
export function brandEditionFileOf(brandDoc: BogenDoc): string | null {
  const raw = brandDoc.meta.get(BRAND_EDITION_META) as { fileId?: unknown } | undefined;
  return raw && typeof raw === 'object' && typeof raw.fileId === 'string' && /^[0-9a-z]{4,40}$/.test(raw.fileId) ? raw.fileId : null;
}

export function setBrandEditionFile(brandDoc: BogenDoc, fileId: string, origin?: unknown): void {
  brandDoc.transact(() => brandDoc.meta.set(BRAND_EDITION_META, { fileId, at: Date.now() }), origin);
}
