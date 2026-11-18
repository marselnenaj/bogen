import * as Y from 'yjs';
import type { BogenDoc } from '@bogen/core';
import type { ImageResult } from './image-search.ts';

/**
 * Credits for images a file uses that came from image_search: author, licence and source per stored asset, kept in
 * the file's own document so they travel with it to other devices and in .bogen files. Read leniently, since a
 * document can come from anywhere.
 */
export interface ImageCredit {
  asset: string;
  title: string;
  author: string;
  license: string;
  licenseName: string;
  licenseUrl: string;
  source: string;
  provider: string;
  id: string;
  credit: string;
  at: number;
}

const MAP = 'imageCredits';
const text = (v: unknown, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');

export function creditsMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(MAP);
}

export function setImageCredit(doc: BogenDoc, asset: string, r: ImageResult, origin?: unknown): void {
  doc.transact(() => {
    creditsMap(doc).set(asset, { title: r.title, author: r.author, license: r.license, licenseName: r.licenseName, licenseUrl: r.licenseUrl, source: r.source, provider: r.provider, id: r.id, credit: r.credit, at: Date.now() });
  }, origin);
}

/** Credits by asset name, for the assets given, or all of them. */
export function readImageCredits(doc: BogenDoc, only?: Set<string>): ImageCredit[] {
  const out: ImageCredit[] = [];
  creditsMap(doc).forEach((raw, asset) => {
    if (only && !only.has(asset)) return;
    if (!raw || typeof raw !== 'object') return;
    const c = raw as Record<string, unknown>;
    out.push({
      asset, title: text(c.title), author: text(c.author), license: text(c.license, 40), licenseName: text(c.licenseName, 80), licenseUrl: text(c.licenseUrl, 2000),
      source: text(c.source, 2000), provider: text(c.provider, 40), id: text(c.id, 120), credit: text(c.credit, 2400), at: typeof c.at === 'number' ? c.at : 0,
    });
  });
  return out.sort((a, b) => a.at - b.at);
}

/** The credits as a block to paste into a site footer, a deck's last slide or a README. */
export function creditsText(credits: ImageCredit[]): string {
  if (!credits.length) return '';
  return ['Image credits', ...credits.map((c) => `- ${c.credit}`)].join('\n');
}
