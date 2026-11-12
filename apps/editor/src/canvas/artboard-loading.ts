import { startTransition } from 'react';
import type { BogenNode } from '@bogen/core';
import { camera } from '../state/camera.ts';
import { maybeSession } from '../doc/session.ts';

export function usesArtboardLoading(roots: number, layers: number): boolean {
  return roots >= 12 && layers >= 1000;
}

/** Only defer clipped, explicitly sized artboards: their children cannot change the outer box. */
export function canDeferArtboard(node: BogenNode | undefined, tokens: ReadonlyMap<string, string>): boolean {
  if (!node?.artboard || node.type !== 'frame' || node.hidden || node.rules || !/^(hidden|clip)$/.test(node.style.overflow ?? '')) return false;
  if (['transform', 'rotate', 'scale'].some(key => node.style[key] && node.style[key] !== 'none')) return false;
  if (node.style.display === 'contents' || ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].some((key) => /(?:min|max|fit)-content/.test(node.style[key] ?? ''))) return false;
  const fixed = (value: string | undefined, seen = new Set<string>()): boolean => {
    if (!value) return false;
    if (/^\d*\.?\d+px$/.test(value.trim())) return Number.parseFloat(value) > 0;
    const name = /^var\(--([\w-]+)\)$/.exec(value.trim())?.[1];
    if (!name || seen.has(name) || seen.size > 8) return false;
    seen.add(name);
    return fixed(tokens.get(name), seen);
  };
  return fixed(node.style.width) && fixed(node.style.height);
}

/** Absolute hug screens may use an explicitly approximate local box until their real content is mounted. */
export function estimatedArtboardHeight(node: BogenNode | undefined, tokens: ReadonlyMap<string, string>): number | undefined {
  if (!node?.artboard || node.type !== 'frame' || node.hidden || node.rules || node.style.position !== 'absolute' || ['transform', 'rotate', 'scale'].some(key => node.style[key] && node.style[key] !== 'none') || !/^(hidden|clip)$/.test(node.style.overflow ?? '') || !/^(auto|fit-content)$/.test(node.style.height ?? 'auto')) return;
  if (node.style.display === 'contents' || ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].some((k) => /(?:min|max|fit)-content/.test(node.style[k] ?? ''))) return;
  const px = (value: string | undefined, seen = new Set<string>()): number | undefined => {
    if (!value) return;
    if (/^\d*\.?\d+px$/.test(value.trim())) return Number.parseFloat(value);
    const key = /^var\(--([\w-]+)\)$/.exec(value.trim())?.[1]; if (!key || seen.has(key) || seen.size > 8) return;
    seen.add(key); return px(tokens.get(key), seen);
  };
  const width = px(node.style.width); if (!width || width <= 0) return;
  return Math.max(px(node.style.minHeight) ?? 0, Math.min(1200, width * 9 / 16));
}

export const MAX_MEASUREMENT_ARTBOARDS = 4;
export function shouldPrepareScreen(width: number, height: number, active: boolean): boolean { return Math.min(width, height) >= (active ? 48 : 64); }
export function canvasPreviewPixelBudget(deviceMemory = 4): number { return deviceMemory <= 4 ? 1_500_000 : 3_000_000; }
export function canvasLayerBudget(deviceMemory = 4): number { return deviceMemory <= 4 ? 1800 : 3600; }
export function nearestArtboards<T extends { distance: number; active: boolean; cost?: number }>(candidates: readonly T[], budget = canvasLayerBudget()): T[] {
  const selected: T[] = []; let remaining = budget;
  for (const candidate of [...candidates].sort((a,b) => Math.round(a.distance / 32) - Math.round(b.distance / 32) || Number(b.active) - Number(a.active))) {
    const cost = Math.max(1, candidate.cost ?? 1500);
    if (cost <= remaining) { selected.push(candidate); remaining -= cost; }
  }
  return selected;
}

const requests = new Map<string, () => void>();

export function registerArtboardRequest(id: string, request: () => void): () => void {
  requests.set(id, request);
  return () => { if (requests.get(id) === request) requests.delete(id); };
}

/** Navigation may target a child not mounted yet. Give its artboard time to mount before reading layout. */
export function prepareLayerMeasurements(ids: readonly string[], forceAll = false): void {
  const snap = maybeSession()?.snap;
  if (!snap) return;
  const roots = new Set(ids.map((id) => snap.ancestors(id).at(-1) ?? id));
  // A fit-all request needs overview boxes, not the entire document DOM at once.
  if (!forceAll && roots.size > MAX_MEASUREMENT_ARTBOARDS) return;
  for (const root of roots) requests.get(root)?.();
}

/** Keep nearby DOM bounded even when an overview puts every screen inside the viewport. */
export class ArtboardLoader {
  private observer: IntersectionObserver | null = null;
  private entries = new Map<Element, { ready: (visible: boolean, large: boolean) => void; cost: number; near: boolean; active: boolean; large: boolean }>();
  private frame = 0;
  private offCamera: (() => void) | null = null;
  private viewport: Element | null = null;

  observe(el: HTMLElement, ready: (visible: boolean, large: boolean) => void, cost = 1500): () => void {
    if (!this.observer) {
      this.viewport = el.closest('[data-testid="canvas"]');
      this.observer = new IntersectionObserver((changes) => {
        for (const change of changes) { const entry = this.entries.get(change.target); if (entry) entry.near = change.isIntersecting; }
        this.schedule();
      }, { root: this.viewport, rootMargin: '900px', threshold: [0, 0.25, 0.75, 1] });
      this.offCamera = camera.subscribe(() => this.schedule());
    }
    this.entries.set(el, { ready, cost, near: false, active: false, large: false }); this.observer.observe(el);
    return () => { this.observer?.unobserve(el); this.entries.delete(el); if (!this.entries.size) this.close(); else this.schedule(); };
  }

  private schedule(): void {
    if (this.frame || !this.entries.size) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const view = this.viewport?.getBoundingClientRect(); if (!view) return;
      const cx = view.x + view.width / 2, cy = view.y + view.height / 2;
      const candidates = [...this.entries].flatMap(([el, entry]) => {
        if (!entry.near) return [];
        const r = el.getBoundingClientRect();
        const dx = Math.max(r.left - cx, 0, cx - r.right), dy = Math.max(r.top - cy, 0, cy - r.bottom);
        return [{ el, ...entry, large: Math.max(r.width, r.height) > 128, readable: shouldPrepareScreen(r.width, r.height, entry.active), previewCost: 768 * 768 * Math.min(r.width / Math.max(1,r.height), r.height / Math.max(1,r.width)), distance: Math.hypot(dx, dy) }];
      });
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
      const active = new Set(nearestArtboards(candidates.filter(c => c.readable), canvasLayerBudget(memory)).map(c => c.el));
      const sharp = new Set(nearestArtboards(candidates.filter(c => c.large).map(c => ({ ...c, cost: c.previewCost })), canvasPreviewPixelBudget(memory)).map(c => c.el));
      const sizes = new Map(candidates.map(c => [c.el, sharp.has(c.el)]));
      startTransition(() => {
        for (const [el, entry] of this.entries) {
          const next = active.has(el), large = sizes.get(el) ?? false; if (entry.active === next && entry.large === large) continue;
          entry.active = next; entry.large = large; entry.ready(next, large);
        }
      });
    });
  }

  private close(): void {
    this.observer?.disconnect(); this.observer = null;
    this.offCamera?.(); this.offCamera = null;
    cancelAnimationFrame(this.frame); this.frame = 0;
  }
}
