import { VARIATION_ASPECTS, VARIATION_RANGES, type VariationAspect, type VariationRange } from '@bogen/core';
import { msg } from '../i18n/core.ts';
import { formatList } from '../i18n/format.ts';
import { t } from '../i18n/store.ts';

/** What the chat's new controls decide, without React: tested on its own. See ChatExtras.tsx. */

export interface VariationChoice { count: number; range: VariationRange; vary: VariationAspect[]; split: boolean }
const VARIATION_KEY = 'bogen-prompt-variation';
const DEFAULT_VARIATION: VariationChoice = { count: 1, range: 'explore', vary: [], split: false };
export const RANGE_WORDS: Record<VariationRange, string> = { refine: msg('Refine'), explore: msg('Explore'), reimagine: msg('Reimagine') };
export const RANGE_TITLES: Record<VariationRange, string> = { refine: msg('Small changes to the same design'), explore: msg('Clearly different takes, each a real option'), reimagine: msg('Start over in what varies') };
export const ASPECT_WORDS: Record<VariationAspect, string> = { layout: msg('Layout'), colour: msg('Colour'), type: msg('Type'), copy: msg('Copy') };

export function loadVariation(): VariationChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(VARIATION_KEY) ?? 'null') as Partial<VariationChoice> | null;
    if (!raw) return DEFAULT_VARIATION;
    return {
      count: Math.min(6, Math.max(1, Number(raw.count) || 1)), range: VARIATION_RANGES.includes(raw.range as VariationRange) ? raw.range as VariationRange : 'explore',
      vary: VARIATION_ASPECTS.filter((a) => raw.vary?.includes(a)), split: raw.split === true,
    };
  } catch {
    return DEFAULT_VARIATION;
  }
}

export function saveVariation(v: VariationChoice): void {
  try {
    localStorage.setItem(VARIATION_KEY, JSON.stringify(v));
  } catch {
    // It lasts for this tab then.
  }
}

/** What goes with a Propose message: nothing when the controls are as they start, so the run keeps its usual brief. */
export function proposalVariation(v: VariationChoice): { count: number; range: VariationRange; vary: VariationAspect[] } | undefined {
  return v.count === 1 && v.range === 'explore' && !v.vary.length ? undefined : { count: v.count, range: v.range, vary: v.vary };
}

/** What goes with a race: the range and aspects when set, and the split. */
export function raceVariation(v: VariationChoice): { range?: VariationRange; vary?: VariationAspect[]; split?: boolean } {
  return { ...(v.range !== 'explore' || v.vary.length ? { range: v.range, ...(v.vary.length ? { vary: v.vary } : {}) } : {}), ...(v.split ? { split: true } : {}) };
}

/** "Varies layout. Holds colour, type and copy." */
export function heldLine(vary: VariationAspect[]): string {
  if (!vary.length || vary.length === VARIATION_ASPECTS.length) return t('Varies anything. Pick what to vary to hold the rest.');
  const words = (list: VariationAspect[]) => formatList(list.map((a) => t(ASPECT_WORDS[a])));
  return t('Varies: {vary}. Holds: {held}.', { vary: words(vary), held: words(VARIATION_ASPECTS.filter((a) => !vary.includes(a))) });
}

/** The sections each run takes in a split, as the server shares them out. */
export function splitHint(sectionNames: string[], runs: number): string | null {
  if (sectionNames.length < runs) return t('Needs a layer with at least {count} sections.', { count: runs });
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < runs; i++) {
    const size = Math.floor(sectionNames.length / runs) + (i < sectionNames.length % runs ? 1 : 0);
    parts.push(t('Run {n}: {sections}.', { n: i + 1, sections: sectionNames.slice(at, at + size).join(', ') }));
    at += size;
  }
  return parts.join(' ');
}

export interface Mention { kind: 'layer' | 'component' | 'token'; id: string; name: string }

/** The `/word` or `@word` the caret is at the end of, and where it starts. */
export function pickerQuery(text: string, caret: number): { trigger: '/' | '@'; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([/@])([^\s/@]{0,40})$/.exec(before);
  if (!m) return null;
  return { trigger: m[2] as '/' | '@', query: m[3]!, start: before.length - m[3]!.length - 1 };
}

/** The mentions whose @name is still in the message: one taken out of the text goes with it. */
export function keptMentions(text: string, mentions: Mention[]): Mention[] {
  return mentions.filter((m) => text.includes(`@${m.name}`));
}
