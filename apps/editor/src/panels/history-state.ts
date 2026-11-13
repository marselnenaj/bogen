import { useSyncExternalStore } from 'react';
import type { DesignContent } from '@bogen/core';
import { history, type VisualDiff } from '../lib/history-api.ts';

export interface CompareScreen { id: string; name: string; pageId: string }
export type CompareView = Extract<StageView, { kind: 'compare' }>;

/** What the History panel shows on the stage. Only this editor sees it: the document stays as it is. */
export type StageView =
  | { kind: 'preview'; id: string; label: string; content: DesignContent }
  | {
    kind: 'compare'; from: string; to: string; fromLabel: string; toLabel: string; pageId: string; pageName: string; visual: VisualDiff | null; error?: string;
    /** One screen of the page instead of the whole page. */
    screenId?: string;
    /** The screens to step through with Previous and Next, such as those a merge changes. */
    screens?: CompareScreen[];
    /** Two layers of the live file instead of two versions: a proposal or race lane and its original. */
    layers?: { a: string; b: string };
  }
  | { kind: 'replay'; fileId: string; pageId: string };

let view: StageView | null = null;
let focusCommit = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function setStageView(next: StageView | null): void {
  view = next;
  notify();
}

export function useStageView(): StageView | null {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, () => view);
}

/** Ctrl+Alt+S: opens the panel, and puts the cursor in the message field. */
export function askForCommit(): void {
  focusCommit++;
  notify();
}

export function useCommitFocus(): number {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, () => focusCommit);
}

/**
 * Puts a comparison on the stage and fetches its pictures: two versions of a page or a screen, or two layers. Shown at
 * once with no pictures, so that the stage says it is rendering; a newer comparison wins over one still loading.
 */
let asked = 0;
export async function showCompare(fileId: string, spec: Omit<CompareView, 'kind' | 'visual' | 'error'>): Promise<void> {
  const ticket = ++asked;
  const base: CompareView = { kind: 'compare', ...spec, visual: null };
  setStageView(base);
  try {
    const visual = spec.layers ? await history.layers(fileId, spec.layers.a, spec.layers.b) : await history.render(fileId, spec.from, spec.to, spec.pageId, spec.screenId);
    if (ticket === asked) setStageView({ ...base, visual });
  } catch (e) {
    if (ticket === asked) setStageView({ ...base, error: (e as Error).message });
  }
}

/** The comparison mode the person chose last, kept on this device. */
export type CompareMode = 'side' | 'overlay' | 'swipe' | 'diff';
const MODE_KEY = 'bogen-compare-mode';
export function compareMode(): CompareMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'overlay' || v === 'swipe' || v === 'diff' ? v : 'side';
  } catch {
    return 'side';
  }
}
export function rememberCompareMode(mode: CompareMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private mode: it stays for this view only.
  }
}
