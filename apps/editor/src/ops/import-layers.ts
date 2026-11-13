import type { NewNode } from '@bogen/core';
import { flushSync } from 'react-dom';
import type { Vec } from '../canvas/geometry.ts';
import { session } from '../doc/session.ts';
import { fmtPx } from '../lib/css-values.ts';
import { editor } from '../state/store.ts';
import { pageId } from './ops.ts';
import { t } from '../i18n/store.ts';

/**
 * A PDF or SVG dropped on the canvas comes in as layers: the server reads it (pdf.js for a PDF, the SVG sanitized) and
 * answers with the layers, which go onto the page here as one undo step of the person's own, side by side from where
 * the file was dropped.
 */

interface ImportAnswer {
  kind: 'pdf' | 'svg';
  specs: NewNode[];
  pages: { pictures: { reason: string }[] }[];
}

export function isLayerFile(file: File): boolean {
  return file.type === 'application/pdf' || file.type === 'image/svg+xml' || /\.(pdf|svg)$/i.test(file.name);
}

async function fetchLayers(file: File): Promise<ImportAnswer> {
  const res = await fetch('/api/layers/import', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Bogen-Filename': encodeURIComponent(file.name) }, body: file });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // A plain text answer stays as it is.
    }
    throw new Error(message || String(res.status));
  }
  return (await res.json()) as ImportAnswer;
}

/** What the import did, as the person reads it in a toast. */
function summary(name: string, out: ImportAnswer): string {
  if (out.kind === 'svg') return t('{name}: one vector layer.', { name });
  const pictures = out.pages.flatMap((p) => p.pictures);
  const pages = t.n(out.pages.length, '{name}: {count} page as layers.', '{name}: {count} pages as layers.', { name });
  if (!pictures.length) return pages;
  const reasons = [...new Set(pictures.map((p) => p.reason))].join(', ');
  return `${pages} ${t.n(pictures.length, '{count} part became a picture: {reasons}.', '{count} parts became pictures: {reasons}.', { reasons })}`;
}

export async function dropLayerFile(file: File, at: Vec): Promise<void> {
  try {
    const out = await fetchLayers(file);
    const s = session();
    const parent = pageId();
    const ids: string[] = [];
    let x = at.x;
    flushSync(() => {
      s.tx(() => {
        for (const spec of out.specs) {
          ids.push(s.doc.insert(parent, { ...spec, ...(spec.type === 'frame' ? { artboard: true } : {}), style: { ...spec.style, position: 'absolute', left: fmtPx(x), top: fmtPx(at.y) } }));
          x += (Number.parseFloat(spec.style?.width ?? '') || 400) + 40;
        }
      });
    });
    editor().set({ selection: ids, tool: 'move' });
    editor().showToast(summary(file.name, out));
  } catch (err) {
    editor().showToast(t('Could not import {name}. {error}', { name: file.name, error: (err as Error).message }));
  }
}
