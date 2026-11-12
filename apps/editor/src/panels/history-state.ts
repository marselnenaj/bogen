import { useSyncExternalStore } from 'react';
import type { DesignContent } from '@bogen/core';
import type { VisualDiff } from '../lib/history-api.ts';

/** What the History panel shows on the stage. Only this editor sees it: the document stays as it is. */
export type StageView =
  | { kind: 'preview'; id: string; label: string; content: DesignContent }
  | { kind: 'compare'; from: string; to: string; fromLabel: string; toLabel: string; pageId: string; pageName: string; visual: VisualDiff | null; error?: string }
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
