import { confirmed, voiceFindings, type BogenNode } from '@bogen/core';
import { copyIssues } from '../mcp/copy-check.ts';
import { BrandKit, h, t, type Style } from './kit.ts';

/**
 * Words for templates. A template takes the brand's own words where they fit the place, and otherwise writes a short
 * slot that says what goes there. Both have to pass what design_lint and brand_check say about copy, the brand's voice
 * included: a heading the brand wants at three to seven words gets three to seven words.
 */

/** Whether text passes the copy check and the brand's measurable voice as this tag. */
export function fits(k: BrandKit, text: string, tag = 'p'): boolean {
  if (!text.trim()) return false;
  const node = { id: 'draft', name: 'draft', type: 'text', tag, text, style: {} } as unknown as BogenNode;
  const avoid = confirmed(k.data.words).filter((w) => w.use === 'avoid').map((w) => ({ word: w.word, ...(w.instead ? { instead: w.instead } : {}) }));
  if (copyIssues([node], avoid).length) return false;
  return !voiceFindings(k.data, [{ id: 'draft', name: 'draft', tag, text }]).some((f) => f.rule !== 'voice.required');
}

/** The first of the brand's lines that fits, else the slot text. */
export function pick(k: BrandKit, candidates: (string | undefined)[], tag: string, slot: string): string {
  return candidates.find((c): c is string => Boolean(c) && fits(k, c!, tag)) ?? slot;
}

/** The brand's own good lines, shortest first, and the first sentence of its positioning. */
export function brandLines(k: BrandKit): string[] {
  const goods = k.data.voiceExamples.filter((e) => !e.suggested).map((e) => e.good).filter(Boolean).sort((a, b) => a.length - b.length);
  const first = k.data.fields.positioning.split(/(?<=[.!?])\s+/)[0];
  return [...goods, ...(first ? [first] : [])];
}

/** A link or button that people can hit: at least 24px each way. */
export function target(extra: Style = {}): Style {
  return { display: 'inline-flex', alignItems: 'center', minHeight: '24px', minWidth: '24px', ...extra };
}

/** Collects the slots a template writes, by layer name, once each. */
export class Slots {
  readonly list: { layer: string; hint: string }[] = [];
  add(layer: string, hint: string): string {
    if (!this.list.some((s) => s.layer === layer)) this.list.push({ layer, hint });
    return layer;
  }
}

/** A text element with a slot name. */
export function slotText(slots: Slots, tag: string, style: Style, text: string, layer: string, hint: string, attrs: Record<string, string> = {}): string {
  return h(tag, style, t(text), { 'data-name': slots.add(layer, hint), ...attrs });
}

