import type { BogenDoc } from '@bogen/core';
import type { Renderer } from './render.ts';

/**
 * Lays an artboard out at several widths and says what breaks: layers sticking out past its edges, and
 * text cut off by its own box or a parent. `responsive_check`, `responsive_variant` and the editor's
 * responsive section all use it.
 */
const MAX_REPORTED = 30;

interface WidthIssue { kind: 'overflow' | 'clipped_text'; id: string; by?: number; side?: string; text?: string; clipped_by?: string; fixed_width?: string }

/** Runs in the page, so it can only use its argument. */
function widthProbe(arg: { root: string; limit: number }): { issues: WidthIssue[]; scroll_width: number; client_width: number } {
  const root = document.querySelector<HTMLElement>(`[data-bogen-id="${arg.root}"]`);
  if (!root) return { issues: [], scroll_width: 0, client_width: 0 };
  const rootBox = root.getBoundingClientRect();
  const issues: WidthIssue[] = [];
  const over = new Set<Element>();

  for (const el of root.querySelectorAll<HTMLElement>('[data-bogen-id]')) {
    const id = el.dataset.bogenId!;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || !box.width) continue;

    const right = box.right - rootBox.right;
    const left = rootBox.left - box.left;
    if (right > 1 || left > 1) {
      // The outermost layer that sticks out is the one to fix.
      if (!(el.parentElement && over.has(el.parentElement))) {
        const fixed = /^\d/.test(el.style.width) && el.style.width.endsWith('px') ? { fixed_width: el.style.width } : {};
        issues.push({ kind: 'overflow', id, by: Math.round(Math.max(right, left)), side: right > left ? 'right' : 'left', ...fixed });
      }
      over.add(el);
    }

    const hasText = [...el.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim());
    if (!hasText) continue;
    const text = (el.textContent ?? '').trim().slice(0, 60);
    if ((el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible') || (el.scrollHeight > el.clientHeight + 1 && style.overflowY !== 'visible')) {
      issues.push({ kind: 'clipped_text', id, text, clipped_by: id });
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const ink = range.getBoundingClientRect();
    for (let cur = el.parentElement; cur; cur = cur === root ? null : cur.parentElement) {
      const parentStyle = getComputedStyle(cur);
      if (parentStyle.overflowX === 'visible' && parentStyle.overflowY === 'visible') continue;
      const clip = cur.getBoundingClientRect();
      if (ink.right > clip.right + 1 || ink.left < clip.left - 1 || ink.bottom > clip.bottom + 1 || ink.top < clip.top - 1) {
        issues.push({ kind: 'clipped_text', id, text, clipped_by: cur.dataset.bogenId ?? '' });
        break;
      }
    }
  }
  return { issues: issues.slice(0, arg.limit), scroll_width: root.scrollWidth, client_width: root.clientWidth };
}

export interface WidthReport {
  width: number;
  height: number;
  ok: boolean;
  content_wider_by: number;
  overflow: (Omit<WidthIssue, 'kind'> & { name: string })[];
  clipped_text: (Omit<WidthIssue, 'kind'> & { name: string })[];
}

export interface WidthCheck { report: { node: string; ok: boolean; widths: WidthReport[] }; shots: Uint8Array[] }

export async function checkWidths(doc: BogenDoc, renderer: Renderer, nodeId: string, widths: number[], options: { shots?: boolean; maxDimension?: number } = {}): Promise<WidthCheck> {
  const node = doc.getNode(nodeId);
  if (!node) throw new Error(`No layer with id ${nodeId}.`);
  const results = await renderer.atWidths(doc, nodeId, widths, widthProbe, { root: nodeId, limit: MAX_REPORTED }, { shots: options.shots, maxDimension: options.maxDimension });
  const named = (issue: WidthIssue) => ({ ...issue, name: doc.getNode(issue.id)?.name ?? '' });
  const report = results.map((r) => {
    const overflow = r.result.issues.filter((i) => i.kind === 'overflow').map(named).map(({ kind: _kind, ...rest }) => rest);
    const clipped = r.result.issues.filter((i) => i.kind === 'clipped_text').map(named).map(({ kind: _kind, ...rest }) => rest);
    return { width: r.width, height: r.height, ok: !overflow.length && !clipped.length && r.result.scroll_width <= r.result.client_width + 1, content_wider_by: Math.max(0, r.result.scroll_width - r.result.client_width), overflow, clipped_text: clipped };
  });
  return { report: { node: node.name, ok: report.every((r) => r.ok), widths: report }, shots: results.flatMap((r) => (r.shot ? [r.shot] : [])) };
}
