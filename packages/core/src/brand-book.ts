import * as Y from 'yjs';
import { normalizeLanguageTag } from './content-language.ts';
import { newId, type BogenDoc } from './doc.ts';
import type { BrandData } from './brand.ts';

/** Stable chapter IDs are shared by editor, MCP, exports and synchronized brand documents. */
export const BRAND_BOOK_CHAPTERS = [
  { id: 'strategy', title: 'Purpose and positioning', prompt: 'What does this brand do, for whom and why choose it? Separate existing evidence from proposed positioning; leave unsupported claims open.' },
  { id: 'audience', title: 'Audience and contexts', prompt: 'Primary tasks, needs, constraints, languages and channels. Name secondary audiences and exclusions only when known. Do not invent personas or research.' },
  { id: 'architecture', title: 'Brand architecture', prompt: 'Product names, parent/sub-brands, naming, co-branding and attribution. Explain which identity owns each application.' },
  { id: 'principles', title: 'Personality and principles', prompt: 'A few distinct principles with an observable design consequence, a good example and a counterexample. Avoid interchangeable adjectives.' },
  { id: 'logo', title: 'Logo and marks', prompt: 'Approved originals and variants, light/dark placement, clear space, minimum size, small-use fallback, prohibited alterations and rights. Never redraw an existing mark.' },
  { id: 'color', title: 'Colour system', prompt: 'Semantic roles, hierarchy and accent usage; actual token references, light/dark pairs and measured contrast. State failures and non-colour cues, not an assumed accessibility pass.' },
  { id: 'type', title: 'Typography and language', prompt: 'Approved families, fallbacks and rights; hierarchy, weights, line length, leading, narrow screens, large text and supported scripts. Use real strings, not decorative filler.' },
  { id: 'layout', title: 'Layout and responsive behavior', prompt: 'Grid, containers, spacing rhythm, density, breakpoints and content-driven reflow. Include long copy, keyboard order and narrow/portrait contexts.' },
  { id: 'imagery', title: 'Imagery and art direction', prompt: 'Subject, composition, lighting, crop and image treatment; portrait/landscape rules, alt text, source/usage rights and examples to avoid.' },
  { id: 'icons', title: 'Icons and illustration', prompt: 'One coherent family, optical size, stroke, filled/outline rules, labels and metaphor. Identify source and licence; never mix arbitrary emoji with UI icons.' },
  { id: 'voice', title: 'Voice and content', prompt: 'Language, address, terminology and tone by situation. Show specific good/bad headlines, actions, errors, empty states and sensitive messages without invented promises.' },
  { id: 'motion', title: 'Motion and interaction', prompt: 'Purposeful transitions, duration/easing guidance, feedback and loading behavior. Include reduced motion, interruption and an explicit reason if motion is not applicable.' },
  { id: 'data', title: 'Data and information', prompt: 'Units, number/date formats, chart hierarchy, categorical/semantic colour, labels, uncertainty and empty/no-data states. State when charts are outside scope.' },
  { id: 'applications', title: 'Applications and components', prompt: 'Priority channels and reusable patterns: product UI, website, docs, social, decks, email, print where relevant. Include default, narrow, long, error, empty and disabled states, not just a hero.' },
  { id: 'accessibility', title: 'Accessibility and quality', prompt: 'Contrast evidence, readable hierarchy, non-colour cues, focus, keyboard, text zoom, touch targets, screen-reader names and reduced motion. Distinguish inspected evidence from tests still required.' },
  { id: 'governance', title: 'Assets and governance', prompt: 'Canonical asset locations, owner/reviewer, licence/source evidence, version/change notes, exceptions, release checklist and unresolved decisions. Do not invent ownership or legal clearance.' },
] as const;
export type BrandBookChapterId = typeof BRAND_BOOK_CHAPTERS[number]['id'];
export type BrandBookStatus = 'open' | 'draft' | 'confirmed' | 'not-applicable';
/**
 * A chapter is written in whatever language its author writes in, and is never translated. `lang` says which, as a
 * tag, when it is not the brand's primary language (brand-language.ts, chapterLanguage).
 */
export interface BrandBookChapter {
  id: BrandBookChapterId; markdown: string; source: string; questions: string;
  status: BrandBookStatus; revision: string; by: string; at: number; lang?: string;
}
export interface BrandBook { version: 1; chapters: BrandBookChapter[] }
export const BRAND_BOOK_MAP = 'brandBook';
export const BRAND_BOOK_TEXT_LIMIT = 12000;
const IDS = new Set<string>(BRAND_BOOK_CHAPTERS.map((c) => c.id));
const STATUSES = new Set<string>(['open', 'draft', 'confirmed', 'not-applicable']);
export const brandBookMap = (doc: BogenDoc): Y.Map<unknown> => doc.y.getMap(BRAND_BOOK_MAP);

function cleanChapter(raw: unknown): BrandBookChapter | undefined {
  if (!raw || typeof raw !== 'object') return;
  const c = raw as Record<string, unknown>;
  if (!IDS.has(String(c.id)) || !STATUSES.has(String(c.status))) return;
  for (const [key, limit] of Object.entries({ markdown: BRAND_BOOK_TEXT_LIMIT, source: 2000, questions: 4000, revision: 64, by: 80 })) {
    if (typeof c[key] !== 'string' || (c[key] as string).length > limit) return;
  }
  if (c.status === 'confirmed' && !(c.source as string).trim()) return;
  if (typeof c.at !== 'number' || !Number.isFinite(c.at) || c.at < 0) return;
  if ((c.status === 'confirmed' || c.status === 'not-applicable') && (!(c.markdown as string).trim() || (c.questions as string).trim())) return;
  // A language that is not a tag is no reason to lose the chapter: it is read as the brand's primary.
  const lang = normalizeLanguageTag(c.lang);
  return { id: c.id as BrandBookChapterId, markdown: c.markdown as string, source: c.source as string, questions: c.questions as string, status: c.status as BrandBookStatus, revision: c.revision as string, by: c.by as string, at: c.at, ...(lang ? { lang } : {}) };
}
export function coerceBrandBook(raw: unknown): BrandBook | undefined {
  if (!raw || typeof raw !== 'object') return;
  const b = raw as Record<string, unknown>;
  if (b.version !== 1 || !Array.isArray(b.chapters) || b.chapters.length > BRAND_BOOK_CHAPTERS.length) return;
  const chapters = b.chapters.map(cleanChapter);
  if (chapters.some((c) => !c) || new Set(chapters.map((c) => c!.id)).size !== chapters.length) return;
  return { version: 1, chapters: chapters as BrandBookChapter[] };
}
export function readBrandBook(doc: BogenDoc): BrandBook | undefined {
  const map = brandBookMap(doc);
  if (map.get('version') !== 1) return;
  const chapters: BrandBookChapter[] = [];
  for (const def of BRAND_BOOK_CHAPTERS) {
    if (!map.has(def.id)) continue;
    const chapter = cleanChapter(map.get(def.id));
    if (chapter && chapter.id === def.id) chapters.push(chapter);
  }
  return { version: 1, chapters };
}
export function initializeBrandBook(doc: BogenDoc): void {
  const map = brandBookMap(doc);
  if (!map.size) map.set('version', 1);
  else if (map.get('version') !== 1) throw new Error('Unsupported brandbook format. Nothing was changed.');
}
/**
 * One atomic entry per chapter: simultaneous edits to other chapters survive sync. Same-chapter edits require a fresh
 * revision. `lang` is the language the chapter is written in: left out, it stays what it was; null or empty, the
 * brand's primary.
 */
export function updateBrandBookChapter(doc: BogenDoc, input: {
  id: BrandBookChapterId; markdown: string; source: string; questions: string; status: BrandBookStatus; expectedRevision: string | null; lang?: string | null;
}, by: string, person = false): BrandBookChapter {
  if (!IDS.has(input.id)) throw new Error('Unknown brandbook chapter.');
  const lang = input.lang ? normalizeLanguageTag(input.lang) : null;
  if (input.lang && !lang) throw new Error(`"${String(input.lang).slice(0, 40)}" is not a language tag such as en, de-AT or pt-BR. Nothing was changed.`);
  if (!person && (input.status === 'confirmed' || input.status === 'not-applicable')) throw new Error('Only the person can confirm a brandbook chapter or mark it not applicable.');
  const map = brandBookMap(doc);
  if (map.size && map.get('version') !== 1) throw new Error('Unsupported brandbook format. Nothing was changed.');
  const raw = map.get(input.id);
  const prior = raw === undefined ? undefined : cleanChapter(raw);
  if (raw !== undefined && !prior) throw new Error('This chapter is damaged. Nothing was changed.');
  if ((prior?.revision ?? null) !== input.expectedRevision) throw new Error('This chapter changed. Read the latest revision before saving; your draft has not been applied.');
  // An agent cannot silently replace confirmed guidance. Its replacement becomes a draft, visible for review.
  if (!person && (prior?.status === 'confirmed' || prior?.status === 'not-applicable')) throw new Error('This chapter is confirmed. Propose the change to the person; they can reopen it as a draft.');
  const kept = input.lang === undefined ? prior?.lang : lang ?? undefined;
  const { lang: _asked, ...fields } = input;
  const result = cleanChapter({ ...fields, markdown: input.markdown.trim(), source: input.source.trim(), questions: input.questions.trim(), revision: newId(), by: by.slice(0, 80), at: Date.now(), ...(kept ? { lang: kept } : {}) });
  if (!result) throw new Error('Invalid brandbook chapter: check text limits, status and review rationale.');
  initializeBrandBook(doc);
  map.set(input.id, result);
  return result;
}
export function brandBookOutline(book?: BrandBook) {
  return BRAND_BOOK_CHAPTERS.map((def) => {
    const c = book?.chapters.find((c) => c.id === def.id);
    return { ...def, status: c?.status ?? 'open', revision: c?.revision ?? null, has_content: !!c?.markdown, has_questions: !!c?.questions, ...(c?.lang ? { lang: c.lang } : {}) };
  });
}
export function brandBookReadiness(data: BrandData) {
  const outline = brandBookOutline(data.book);
  const confirmed = outline.filter((c) => c.status === 'confirmed').length;
  const notApplicable = outline.filter((c) => c.status === 'not-applicable').length;
  const gaps = [(!data.fields.positioning || data.suggestedFields.includes('positioning')) && 'Positioning', (!data.fields.audience || data.suggestedFields.includes('audience')) && 'Audience', !data.logos.some((c) => !c.suggested) && 'Logo assets', !data.colors.some((c) => !c.suggested) && 'Colour roles', !data.families.some((c) => !c.suggested) && 'Typography'].filter((x): x is string => !!x);
  return { confirmed, draft: outline.filter((c) => c.status === 'draft').length, open: outline.filter((c) => c.status === 'open').length, notApplicable, total: outline.length, questions: outline.filter((c) => c.has_questions).map((c) => c.id), foundationGaps: gaps, ready: confirmed + notApplicable === outline.length && !gaps.length && !outline.some((c) => c.has_questions) };
}
export function brandBookMarkdown(book?: BrandBook): string {
  return ['## Brandbook', 'Drafts are proposals, not confirmed brand rules. Open questions and missing evidence remain visible.', ...BRAND_BOOK_CHAPTERS.flatMap((def) => {
    const c = book?.chapters.find((c) => c.id === def.id);
    return [`### ${def.title} (${c?.status ?? 'open'})`, c?.markdown || `Open: ${def.prompt}`, ...(c?.source ? [`Source: ${c.source}`] : []), ...(c?.questions ? [`Open questions:\n${c.questions}`] : [])];
  })].join('\n\n');
}
