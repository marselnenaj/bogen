import * as Y from 'yjs';
import type { BogenDoc } from './doc.ts';
import type { AssetResolver } from './render.ts';

/**
 * Self-hosted fonts of a captured page, stored in the document so that canvas, renders and exports
 * load the same files. One entry per `@font-face`, in a shared map of its own: older clients ignore
 * the map and keep it, and two captures of one file merge instead of overwriting each other.
 *
 * Documents come from other people, so nothing here is trusted: `fontFacesCss` writes only values
 * that pass the checks below, and drops the rest.
 */
export interface StoredFontFace {
  family: string;
  /** `bogen-asset:<sha256>.<woff2|woff|ttf|otf>`. Absent for a face that only names a local font. */
  src?: string;
  /** A font on the viewer's system, for metric-matched fallbacks such as `local("Arial")`. */
  local?: string;
  weight?: string;
  style?: string;
  stretch?: string;
  unicodeRange?: string;
  display?: string;
  ascentOverride?: string;
  descentOverride?: string;
  lineGapOverride?: string;
  sizeAdjust?: string;
  featureSettings?: string;
  variationSettings?: string;
  /** Where the page served this file from. Shown to agents, never loaded. */
  from?: string;
}

const MAP_NAME = 'fontFaces';
const FAMILY = /^[\p{L}\p{N} _.+-]{1,120}$/u;
const ASSET_SRC = /^bogen-asset:[a-f0-9]{64}\.(woff2|woff|ttf|otf)$/;
const LOCAL_NAME = /^[\p{L}\p{N} _.+-]{1,120}$/u;
const FORMATS: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

const DESCRIPTORS: [keyof StoredFontFace, string, RegExp][] = [
  ['weight', 'font-weight', /^(normal|bold|\d{1,4}(\.\d+)?)( \d{1,4}(\.\d+)?)?$/],
  ['style', 'font-style', /^(normal|italic|oblique( -?\d{1,3}(\.\d+)?deg){0,2})$/],
  ['stretch', 'font-stretch', /^(normal|(ultra-|extra-|semi-)?(condensed|expanded)|\d{1,4}(\.\d+)?%( \d{1,4}(\.\d+)?%)?)$/],
  ['unicodeRange', 'unicode-range', /^(U\+[0-9a-fA-F?]{1,6}(-[0-9a-fA-F]{1,6})?)(, ?U\+[0-9a-fA-F?]{1,6}(-[0-9a-fA-F]{1,6})?)*$/],
  ['display', 'font-display', /^(auto|block|swap|fallback|optional)$/],
  ['ascentOverride', 'ascent-override', /^(normal|\d{1,4}(\.\d+)?%)$/],
  ['descentOverride', 'descent-override', /^(normal|\d{1,4}(\.\d+)?%)$/],
  ['lineGapOverride', 'line-gap-override', /^(normal|\d{1,4}(\.\d+)?%)$/],
  ['sizeAdjust', 'size-adjust', /^\d{1,4}(\.\d+)?%$/],
  ['featureSettings', 'font-feature-settings', /^(normal|"[a-zA-Z0-9]{4}"( (\d{1,4}|on|off))?(, ?"[a-zA-Z0-9]{4}"( (\d{1,4}|on|off))?)*)$/],
  ['variationSettings', 'font-variation-settings', /^(normal|"[a-zA-Z0-9]{4}" -?\d{1,5}(\.\d+)?(, ?"[a-zA-Z0-9]{4}" -?\d{1,5}(\.\d+)?)*)$/],
];

function faceMap(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(MAP_NAME);
}

/** The same face from two captures gets one entry. */
export function fontFaceKey(face: StoredFontFace): string {
  return [face.family.toLowerCase(), face.weight ?? '', face.style ?? '', face.stretch ?? '', face.unicodeRange ?? ''].join('|');
}

function isFace(value: unknown): value is StoredFontFace {
  return Boolean(value) && typeof value === 'object' && typeof (value as StoredFontFace).family === 'string';
}

export function getFontFaces(doc: BogenDoc): StoredFontFace[] {
  const out: [string, StoredFontFace][] = [];
  faceMap(doc).forEach((value, key) => {
    if (isFace(value)) out.push([key, value]);
  });
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, face]) => face);
}

/** Adds faces, or replaces a face with the same family, weight, style, stretch and range. */
export function addFontFaces(doc: BogenDoc, faces: StoredFontFace[], origin?: unknown): void {
  if (!faces.length) return;
  const map = faceMap(doc);
  doc.transact(() => {
    for (const face of faces) map.set(fontFaceKey(face), { ...face });
  }, origin);
}

export function observeFontFaces(doc: BogenDoc, listener: () => void): () => void {
  const map = faceMap(doc);
  map.observe(listener);
  return () => map.unobserve(listener);
}

/** Families that load from the document. Nothing should ask Google Fonts for these. */
export function hostedFamilies(doc: BogenDoc): Set<string> {
  const out = new Set<string>();
  for (const face of getFontFaces(doc)) if (face.src) out.add(face.family.toLowerCase());
  return out;
}

export function fontFaceAssets(doc: BogenDoc): string[] {
  return getFontFaces(doc).flatMap((face) => (face.src && ASSET_SRC.test(face.src) ? [face.src.slice('bogen-asset:'.length)] : []));
}

function faceRule(face: StoredFontFace, resolve: AssetResolver): string | null {
  if (!FAMILY.test(face.family)) return null;
  const sources: string[] = [];
  if (typeof face.src === 'string' && ASSET_SRC.test(face.src)) {
    const ext = face.src.split('.').pop()!;
    const url = resolve(face.src);
    // A resolver gives a URL or a data URI. Neither may close the string it goes into.
    if (/["'\\<>\s]/.test(url)) return null;
    sources.push(`url("${url}") format("${FORMATS[ext]}")`);
  }
  if (typeof face.local === 'string' && LOCAL_NAME.test(face.local)) sources.push(`local("${face.local}")`);
  if (!sources.length) return null;
  const parts = [`font-family:"${face.family}"`, `src:${sources.join(',')}`];
  for (const [key, property, valid] of DESCRIPTORS) {
    const value = face[key];
    if (typeof value === 'string' && valid.test(value)) parts.push(`${property}:${value}`);
  }
  return `@font-face{${parts.join(';')}}`;
}

/** `@font-face` rules for what the document holds, under the same checks whoever wrote it. */
export function fontFacesCss(doc: BogenDoc, resolve: AssetResolver = (s) => s): string {
  return getFontFaces(doc).flatMap((face) => faceRule(face, resolve) ?? []).join('\n');
}
