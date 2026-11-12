import { exportDocument, exportPrototype, fontFaceAssets, protoReach, type BogenDoc } from '@bogen/core';
import { encodeAvif } from './avif.ts';
import { imageSize } from './image-raster.ts';
import { fontLinkTags, shaderParamsTag, shaderRuntime, type RasterFormat, type Renderer, type Target } from './render.ts';
import type { Storage } from './storage.ts';
import { exportVideo } from './video.ts';
import { makeZip } from './zip.ts';

export type ExportFormat = RasterFormat | 'avif' | 'svg' | 'pdf' | 'html' | 'prototype' | 'mp4' | 'webm';

/** Anything the person should know about the result, sent along with it. */
export interface ExportReport {
  /** SVG: layers that stayed HTML in a `foreignObject`, and native elements written. */
  fallbacks?: { id: string; name: string; reason: string }[];
  native?: number;
  /** Video and AVIF: what made it. */
  encoder?: string;
  codec?: string;
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  notes?: string[];
}

export interface Exported { bytes: Uint8Array; mime: string; ext: string; report?: ExportReport }

export interface ExportExtras {
  /** Video: seconds and frames per second. */
  duration?: number;
  fps?: number;
  encoder?: 'ffmpeg' | 'webcodecs';
  /** SVG: `foreignObject` keeps exact browser rendering, as one HTML block per layer. */
  svgMode?: 'vector' | 'foreignObject';
}

const TEXT_ENCODER = new TextEncoder();
const MAX_INLINE_BYTES = 96 * 1024 * 1024;

/** Assets of these layers as data URLs, so that one file is the whole page. */
async function inlineAssets(doc: BogenDoc, storage: Storage, rootIds: string[], sizes?: Map<string, { width: number; height: number }>): Promise<(src: string) => string> {
  const inlined = new Map<string, string>();
  const names = new Set<string>();
  const scan = (value: string | undefined) => {
    for (const m of value?.matchAll(/bogen-asset:([\w.-]+)/g) ?? []) names.add(m[1]!);
  };
  const visit = (id: string) => {
    const n = doc.getNode(id);
    if (!n) return;
    scan(n.src);
    scan(n.attrs?.image);
    Object.values(n.style).forEach(scan);
    doc.getChildren(id).forEach((c) => visit(c.id));
  };
  rootIds.forEach(visit);
  for (const name of fontFaceAssets(doc)) names.add(name);
  for (const name of names) {
    const asset = await storage.readAsset(name);
    // A long video is no use inside an HTML file, and could not be read back into one string anyway.
    if (asset && asset.bytes.length <= MAX_INLINE_BYTES) inlined.set(name, `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString('base64')}`);
    // The picture's own size, read from its header, so the page reserves its box before it loads.
    const size = asset && sizes && asset.mime.startsWith('image/') ? imageSize(asset.bytes) : null;
    if (size) sizes!.set(`bogen-asset:${name}`, size);
  }
  return (src: string) => (src.startsWith('bogen-asset:') ? inlined.get(src.slice('bogen-asset:'.length)) ?? src : src);
}

/** A standalone document: assets inlined, fonts linked, and the shader runtime only if shaders are used. */
async function exportHtml(doc: BogenDoc, storage: Storage, rootIds: string[]): Promise<string> {
  const sizes = new Map<string, { width: number; height: number }>();
  const resolve = await inlineAssets(doc, storage, rootIds, sizes);
  const params = shaderParamsTag(doc, resolve);
  const runtime = params ? `<script>${(await shaderRuntime()).replace(/<\/script/gi, '<\\/script')}</script>` : '';
  return exportDocument(doc, rootIds, { indent: true, ids: Boolean(params), resolve, images: { size: (src) => sizes.get(src) }, fluidRoot: true, webHead: true, extraHead: fontLinkTags(doc) + params + runtime });
}

export async function exportTarget(doc: BogenDoc, renderer: Renderer, storage: Storage, target: Target, format: ExportFormat, scale?: number, transparent?: boolean, extras: ExportExtras = {}): Promise<Exported> {
  if (format === 'mp4' || format === 'webm') {
    const out = await exportVideo(doc, renderer, target, { format, scale, duration: extras.duration, fps: extras.fps, encoder: extras.encoder });
    return { bytes: out.bytes, mime: out.mime, ext: out.ext, report: { encoder: out.encoder, codec: out.codec, frames: out.frames, fps: out.fps, width: out.width, height: out.height, ...(out.notDeterministic.length ? { notes: out.notDeterministic } : {}) } };
  }
  if (format === 'avif') {
    const shot = await renderer.screenshot(doc, target, { format: 'png', scale, transparent });
    const out = await renderer.withBrowser((browser) => encodeAvif(browser, shot.bytes, { alpha: transparent }));
    return {
      bytes: out.bytes, mime: 'image/avif', ext: 'avif',
      report: { encoder: out.encoder, width: shot.width, height: shot.height, ...(transparent && !out.alpha ? { notes: ['Transparency needs ffmpeg, so this came out on white.'] } : {}) },
    };
  }
  if (format === 'pdf') {
    const targets: Target[] = target.nodeIds?.length ? target.nodeIds.map((id) => ({ nodeIds: [id] })) : [{ pageId: target.pageId }];
    return { bytes: await renderer.pdf(doc, targets), mime: 'application/pdf', ext: 'pdf' };
  }
  if (format === 'svg') {
    if (extras.svgMode === 'foreignObject') return { bytes: TEXT_ENCODER.encode(await renderer.svg(doc, target)), mime: 'image/svg+xml', ext: 'svg', report: { notes: ['Everything is HTML in a foreignObject, which vector tools do not show.'] } };
    const out = await renderer.vectorSvg(doc, target);
    return { bytes: TEXT_ENCODER.encode(out.svg), mime: 'image/svg+xml', ext: 'svg', report: { fallbacks: out.fallbacks, native: out.native } };
  }
  if (format === 'html') {
    const pageId = target.pageId ?? doc.getPages()[0]?.id;
    const roots = target.nodeIds?.length ? target.nodeIds : doc.getChildren(pageId ?? '').map((n) => n.id);
    return { bytes: TEXT_ENCODER.encode(await exportHtml(doc, storage, roots)), mime: 'text/html; charset=utf-8', ext: 'html' };
  }
  if (format === 'prototype') {
    const pageId = target.pageId ?? doc.getPages()[0]?.id;
    // A layer inside an artboard stands for its artboard: a prototype is made of screens.
    const top = (id: string) => {
      let n = doc.getNode(id);
      while (n && doc.getNode(n.parent)) n = doc.getNode(n.parent);
      return n?.id;
    };
    const roots = target.nodeIds?.length ? [...new Set(target.nodeIds.flatMap((id) => top(id) ?? []))] : doc.getChildren(pageId ?? '').filter((n) => n.artboard || n.type === 'frame').map((n) => n.id);
    if (!roots.length) throw new Error('The page is empty, so there is nothing to export.');
    // A prototype carries the screens its links lead to, and the assets they show.
    const resolve = await inlineAssets(doc, storage, protoReach(doc, roots));
    const out = exportPrototype(doc, roots, { indent: true, resolve, extraHead: fontLinkTags(doc), title: 'Prototype' });
    const notes = [`${out.model.screens.length} screen${out.model.screens.length === 1 ? '' : 's'}, ${Object.keys(out.model.variables).length} variable${Object.keys(out.model.variables).length === 1 ? '' : 's'}, one script of ${Math.round(out.script.length / 100) / 10} kB that asks no network.`];
    return { bytes: TEXT_ENCODER.encode(out.html), mime: 'text/html; charset=utf-8', ext: 'html', report: { notes } };
  }
  const shot = await renderer.screenshot(doc, target, { format, scale, transparent });
  return { bytes: shot.bytes, mime: shot.mime, ext: format };
}

export interface ExportPreset {
  format: ExportFormat;
  scale?: number;
  /** Width of the result in pixels, instead of a scale. */
  width?: number;
  /** Goes after the layer's name in the file name, such as `@2x`. */
  suffix?: string;
}

function safeFileName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._@-]+/gu, '-').replace(/^[-.\s]+|[-.\s]+$/g, '').slice(0, 80) || 'export';
}

/** Every preset of every target, in one zip, with a report of what happened to each file. */
export async function exportPresets(doc: BogenDoc, renderer: Renderer, storage: Storage, targets: { target: Target; name: string }[], presets: ExportPreset[]): Promise<{ zip: Buffer; files: { name: string; bytes: number; report?: ExportReport }[] }> {
  const entries: { name: string; bytes: Uint8Array }[] = [];
  const files: { name: string; bytes: number; report?: ExportReport }[] = [];
  const taken = new Set<string>();
  const unique = (base: string, ext: string) => {
    let name = `${base}.${ext}`;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}.${ext}`;
    taken.add(name);
    return name;
  };
  for (const { target, name } of targets) {
    for (const preset of presets) {
      let scale = preset.scale;
      if (preset.width) {
        const id = target.nodeIds?.[0];
        const boxes = id ? await renderer.layout(doc, target, [id]) : [];
        const current = boxes[0]?.width;
        if (current) scale = preset.width / current;
      }
      const out = await exportTarget(doc, renderer, storage, target, preset.format, scale);
      const suffix = preset.suffix ?? (preset.width ? `-${preset.width}w` : scale && scale !== 1 ? `@${scale}x` : '');
      const file = unique(safeFileName(`${name}${suffix}`), out.ext);
      entries.push({ name: file, bytes: out.bytes });
      files.push({ name: file, bytes: out.bytes.length, ...(out.report ? { report: out.report } : {}) });
    }
  }
  return { zip: makeZip(entries), files };
}

/** A report in a header: small enough to pass any proxy, and readable by `decodeURIComponent`. */
export function reportHeader(report: ExportReport | undefined): string | undefined {
  if (!report) return undefined;
  const fallbacks = report.fallbacks ?? [];
  let text = JSON.stringify(report);
  if (text.length > 6000) text = JSON.stringify({ ...report, fallbacks: fallbacks.slice(0, 30), notes: [...(report.notes ?? []), `${fallbacks.length} layers fell back in all.`] });
  return encodeURIComponent(text);
}
