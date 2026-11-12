import { useEffect, useState } from 'react';
import { aspectRatioOf, CROP_ATTR, croppedHeight, cropToAspect, formatCrop, parseCrop, withImageFilters, type BogenNode, type Crop, type CropAspect, type ImageFilterKey } from '@bogen/core';
import { measure } from '../canvas/measure.ts';
import { resolveAsset } from '../lib/api.ts';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** Crop, filters and vectorizing of image layers, for the Image section and the crop handles on the canvas. */

export interface Size { width: number; height: number }

const sizes = new Map<string, Promise<Size | null>>();

/** The image's own size in pixels, loaded once per source. */
export function naturalSize(src: string): Promise<Size | null> {
  let p = sizes.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null);
      img.onerror = () => resolve(null);
      img.src = resolveAsset(src);
    });
    sizes.set(src, p);
  }
  return p;
}

export function useNaturalSize(src: string | undefined): Size | null {
  const [size, setSize] = useState<{ src: string; size: Size | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    void naturalSize(src).then((s) => { if (alive) setSize({ src, size: s }); });
    return () => { alive = false; };
  }, [src]);
  return size && size.src === src ? size.size : null;
}

export const WHOLE: Crop = { x: 0, y: 0, w: 1, h: 1 };

export function cropOf(node: BogenNode): Crop {
  return parseCrop(node.attrs?.[CROP_ATTR]) ?? WHOLE;
}

function attrsWithCrop(node: BogenNode, crop: Crop | null): Record<string, string> | undefined {
  const attrs = { ...(node.attrs ?? {}) };
  const value = crop ? formatCrop(crop) : '';
  if (crop && parseCrop(value)) attrs[CROP_ATTR] = value;
  else delete attrs[CROP_ATTR];
  return Object.keys(attrs).length ? attrs : undefined;
}

/**
 * Writes a crop as one undo step. `size` is the layer's new size in canvas px, or by default the height that shows
 * the crop undistorted at the layer's width, unless `keepSize`. `move` shifts an absolutely placed layer, for a crop from its left or top.
 */
export function writeCrop(id: string, crop: Crop | null, natural: Size | null, options: { size?: Size; keepSize?: boolean; move?: { dx: number; dy: number } } = {}): void {
  const s = session();
  const node = s.snap.nodes.get(id);
  if (!node) return;
  const style: Record<string, string | null> = {};
  if (options.size) {
    // A width that is not in px (fill, a percentage) is the layout's to decide: only the height follows.
    if (!node.style.width || /px$/.test(node.style.width)) style.width = `${Math.round(options.size.width)}px`;
    style.height = `${Math.round(options.size.height)}px`;
  } else if (natural && !options.keepSize) {
    const width = measure(id)?.box.w;
    if (width) style.height = `${croppedHeight(width, crop ?? WHOLE, natural)}px`;
  }
  if (options.move && node.style.position === 'absolute') {
    const left = /^(-?[\d.]+)px$/.exec(node.style.left ?? '')?.[1];
    const top = /^(-?[\d.]+)px$/.exec(node.style.top ?? '')?.[1];
    if (left !== undefined && options.move.dx) style.left = `${Math.round(Number(left) + options.move.dx)}px`;
    if (top !== undefined && options.move.dy) style.top = `${Math.round(Number(top) + options.move.dy)}px`;
  }
  s.tx(() => {
    s.doc.updateFields(id, { attrs: attrsWithCrop(node, crop) });
    if (Object.keys(style).length) s.doc.updateStyle(id, style);
  });
}

/** The largest centred crop of a preset's shape inside the current crop. `free` changes nothing. */
export function applyAspect(node: BogenNode, aspect: CropAspect, natural: Size): void {
  const ratio = aspectRatioOf(aspect, natural);
  if (ratio === null) return;
  const current = parseCrop(node.attrs?.[CROP_ATTR]);
  // The image's own shape is the whole image, not a crop of the current one.
  writeCrop(node.id, aspect === 'original' ? null : cropToAspect(current, ratio, natural), natural);
}

/** The preset a crop has, by the shape it shows. */
export function aspectOf(crop: Crop, natural: Size | null, presets: readonly CropAspect[]): CropAspect | null {
  if (!natural) return null;
  if (crop.w >= 0.9999 && crop.h >= 0.9999) return 'original';
  const ratio = (crop.w * natural.width) / (crop.h * natural.height);
  return presets.find((p) => {
    const r = aspectRatioOf(p, natural);
    return p !== 'original' && r !== null && Math.abs(r - ratio) / r < 0.01;
  }) ?? 'free';
}

export function setImageFilter(ids: string[], key: ImageFilterKey, value: number | null): void {
  const s = session();
  s.tx(() => {
    for (const id of ids) {
      const node = s.snap.nodes.get(id);
      if (node) s.doc.updateStyle(id, { filter: withImageFilters(node.style.filter, { [key]: value }) });
    }
  });
}

export interface Vectorized { svg: string; width: number; height: number; colors: number; paths: number; bytes: number }

/** Traces the image on the server and puts the vector beside it, selected, as one undo step. */
export async function vectorizeImage(node: BogenNode, colors: number, detail: 'low' | 'medium' | 'high'): Promise<Vectorized> {
  const res = await fetch('/api/assets/vectorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src: node.src, colors, detail }) });
  const body = await res.json().catch(() => ({})) as Vectorized & { error?: string };
  if (!res.ok || !body.svg) throw new Error(body.error ?? t('Vectorizing failed with {status}.', { status: res.status }));
  const s = session();
  const width = measure(node.id)?.box.w ?? Math.min(body.width, 800);
  const height = Math.round((width * body.height) / Math.max(1, body.width));
  const style: Record<string, string> = { width: `${Math.round(width)}px`, height: `${height}px`, flexShrink: '0' };
  if (node.style.position === 'absolute') {
    style.position = 'absolute';
    if (node.style.top) style.top = node.style.top;
    const left = /^(-?[\d.]+)px$/.exec(node.style.left ?? '')?.[1];
    if (left !== undefined) style.left = `${Math.round(Number(left) + width + 24)}px`;
  }
  const id = s.tx(() => {
    const siblings = s.doc.getChildren(node.parent);
    const at = siblings.findIndex((c) => c.id === node.id);
    return s.doc.insert(node.parent, { type: 'svg', tag: 'svg', name: `${node.name} (vector)`, svg: body.svg, style, ...(node.attrs?.alt ? { attrs: { 'aria-label': node.attrs.alt } } : {}) }, at + 1);
  });
  editor().set({ selection: [id] });
  return body;
}
