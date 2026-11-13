import { importHtml, sanitizeSvgMarkup, type NewNode } from '@bogen/core';
import { dropInvalidCss } from '@bogen/core/css-check';
import { pageHtml, readPdf, type PageReport } from './pdf-import.ts';
import type { Renderer } from './render.ts';
import type { Storage } from './storage.ts';

/**
 * Files turned into layers: a PDF page by page (pdf-import.ts), an SVG as one editable vector. Used by pdf_import and
 * by a PDF or SVG dropped on the canvas, so that both give the same layers and the same report.
 */

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export interface LayerImport {
  kind: 'pdf' | 'svg';
  specs: NewNode[];
  /** Per page of a PDF: how many text, vector and image layers it made, and which parts became pictures and why. */
  pages: PageReport[];
  total: number;
  title: string | null;
  notes: string[];
}

export function sniffLayerFile(bytes: Uint8Array, name = ''): 'pdf' | 'svg' | null {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head) || (/\.svg$/i.test(name) && /<svg[\s>]/i.test(head))) return 'svg';
  return null;
}

/** A PDF's pages as boards of layers. `pages` are 1-based. */
export async function importPdf(storage: Storage, renderer: Renderer | null, bytes: Uint8Array, options: { pages?: number[]; name?: string } = {}): Promise<LayerImport> {
  const read = await readPdf(bytes, renderer, { pages: options.pages?.map((p) => p - 1) });
  const base = (options.name || read.title || 'PDF').slice(0, 120);
  const specs: NewNode[] = [];
  const reports: PageReport[] = [];
  for (const page of read.pages) {
    const name = read.total > 1 ? `${base}, page ${page.index + 1}` : base;
    const { html, report } = await pageHtml(page, name, async (png) => (await storage.putAsset(png, 'image/png')).src);
    const { nodes } = importHtml(html);
    dropInvalidCss(nodes);
    specs.push(...nodes);
    reports.push(report);
  }
  return { kind: 'pdf', specs, pages: reports, total: read.total, title: read.title, notes: read.notes };
}

/** An SVG as one vector layer, sanitized like any inline SVG, at the size it says. */
export function importSvg(bytes: Uint8Array, name = 'Vector'): LayerImport {
  const clean = sanitizeSvgMarkup(Buffer.from(bytes).toString('utf8'));
  if (!clean) throw new Error('This is not an SVG image.');
  const attr = (n: string) => new RegExp(`<svg\\b[^>]*\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(clean)?.[1];
  const box = (attr('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const len = (v: string | undefined) => (v && /^\d*\.?\d+(px)?$/.test(v.trim()) ? Number.parseFloat(v) : undefined);
  const w = len(attr('width')) ?? (box.length === 4 && box[2]! > 0 ? box[2] : undefined) ?? 300;
  const h = len(attr('height')) ?? (box.length === 4 && box[3]! > 0 ? box[3] : undefined) ?? 150;
  const notes: string[] = [];
  if (/<image\b/i.test(clean)) notes.push('Pictures inside the SVG stay part of it.');
  if (/<text\b/i.test(clean)) notes.push('Text inside the SVG stays SVG text: edit it in the vector.');
  const spec: NewNode = { type: 'svg', name: name.replace(/\.svg$/i, '').slice(0, 120) || 'Vector', svg: clean, style: { width: `${Math.round(w * 100) / 100}px`, height: `${Math.round(h * 100) / 100}px` } };
  return { kind: 'svg', specs: [spec], pages: [], total: 1, title: null, notes };
}

/** A short line of what happened, for a person: pages, and what became a picture. */
export function importSummary(out: LayerImport): string {
  if (out.kind === 'svg') return 'The SVG came in as one vector layer.';
  const pictures = out.pages.flatMap((p) => p.pictures);
  const counts = (k: 'text' | 'vectors' | 'images') => out.pages.reduce((n, p) => n + p[k], 0);
  return `${out.pages.length} page${out.pages.length === 1 ? '' : 's'}: ${counts('text')} text, ${counts('vectors')} vector and ${counts('images')} image layers${pictures.length ? `, and ${pictures.length} part${pictures.length === 1 ? ' as a picture' : 's as pictures'} (${[...new Set(pictures.map((p) => p.reason))].join('; ')})` : ''}.`;
}
