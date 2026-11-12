import * as Y from 'yjs';
import {
  BogenDoc, markBrandDoc, publishBrandVersion, readBrand, setBrandField, upsertBrandItem, type BrandData, type BrandFields, type BrandRuleCheck, type BrandRuleTopic,
} from '@bogen/core';
import type { BrandKit } from './kit.ts';

/**
 * A small brand written down as data, for the welcome file and the examples. It goes into a brand document through the
 * same functions brand_create and brand_update use, so what comes out is an ordinary brand a person can open and edit.
 */
export interface BrandSpec {
  name: string;
  positioning: string;
  audience?: string;
  tone?: string;
  fields?: Partial<Pick<BrandFields, 'container' | 'minContrast' | 'gradients' | 'shadows' | 'layoutNotes'>>;
  colors: { name: string; role: string; value: string; token: string; note?: string }[];
  /** By token. */
  pairings?: { fg: string; bg: string; verdict: 'allow' | 'forbid'; note?: string }[];
  families: { family: string; role: string; fallback: string; weights: number[]; token: string; license?: string }[];
  typeScale: { name: string; role: string; size: number; lineHeight: string; weight: number; tracking?: string; family: string; token: string }[];
  spacing: number[];
  radius: number[];
  logos: { name: string; background: string; svg: string; minWidth: number; clearSpace: number }[];
  rules: { text: string; kind: 'do' | 'dont'; severity: 'hard' | 'soft'; topic: BrandRuleTopic; check?: BrandRuleCheck }[];
  words?: { word: string; use: 'use' | 'avoid'; instead?: string }[];
  voice: { good: string; bad: string }[];
}

/** Writes a spec into a brand document, confirmed, as one transaction. Logos keep their SVG; `asset` is filled in when one is stored. */
export function writeBrandSpec(doc: BogenDoc, spec: BrandSpec, origin: unknown, logoAssets: string[] = []): void {
  doc.transact(() => {
    markBrandDoc(doc);
    if (!doc.getPages().length) doc.createPage('Examples');
    setBrandField(doc, 'name', spec.name);
    setBrandField(doc, 'positioning', spec.positioning);
    if (spec.audience) setBrandField(doc, 'audience', spec.audience);
    if (spec.tone) setBrandField(doc, 'tone', spec.tone);
    for (const [key, value] of Object.entries(spec.fields ?? {})) setBrandField(doc, key as keyof BrandFields, value as never);
    for (const c of spec.colors) upsertBrandItem(doc, 'colors', { ...c });
    for (const p of spec.pairings ?? []) upsertBrandItem(doc, 'pairings', { ...p });
    for (const f of spec.families) upsertBrandItem(doc, 'families', { ...f, assets: [] });
    for (const s of spec.typeScale) upsertBrandItem(doc, 'typeScale', { ...s, tracking: s.tracking ?? '0' });
    for (const v of spec.spacing) upsertBrandItem(doc, 'spacing', { name: String(v), value: v, token: `space-${v}` });
    for (const v of spec.radius) upsertBrandItem(doc, 'radius', { name: v ? String(v) : 'none', value: v, token: v ? `radius-${v}` : 'radius-none' });
    spec.logos.forEach((l, i) => upsertBrandItem(doc, 'logos', { ...l, ...(logoAssets[i] ? { asset: logoAssets[i] } : {}) }));
    for (const r of spec.rules) upsertBrandItem(doc, 'rules', { ...r });
    for (const w of spec.words ?? []) upsertBrandItem(doc, 'words', { ...w, severity: 'soft' });
    for (const v of spec.voice) upsertBrandItem(doc, 'voiceExamples', { ...v });
    publishBrandVersion(doc, { note: 'Made by Bogen for an example', by: 'Bogen' });
  }, origin);
}

/** The brand of a spec as data, without a brand document anywhere: for the welcome file and for previews. */
export function brandDataOf(spec: BrandSpec): BrandData {
  const doc = new BogenDoc(new Y.Doc());
  try {
    writeBrandSpec(doc, spec, 'bogen:spec');
    return readBrand(doc);
  } finally {
    doc.y.destroy();
  }
}

/** Colours and families of a kit by their token, as the file holds them: var(--token) where it has that token. */
export class Paint {
  constructor(readonly k: BrandKit) {}

  c(token: string): string {
    const color = this.k.data.colors.find((c) => c.token === token);
    if (!color) throw new Error(`Template error: the brand has no colour ${token}.`);
    return this.k.c(color);
  }

  /** The raw value, for SVG attributes, which take no variables. */
  hex(token: string): string {
    const color = this.k.data.colors.find((c) => c.token === token);
    if (!color) throw new Error(`Template error: the brand has no colour ${token}.`);
    return this.k.hex(color);
  }

  f(token: string): string {
    return this.k.stack(this.k.data.families.find((f) => f.token === token));
  }
}
