import { create } from 'zustand';
import type { DesignSource } from '../lib/code-api.ts';

/** Transient editor surfaces that come and go, apart from the document-facing state in store.ts. */
export interface GradientEdit { nodeId: string; fillIndex: number; stop: number }
export interface LightboxState { images: { src: string; name?: string }[]; index: number }
/** The pull request dialog: choosing what a new one is made from, or one draft. */
export type PullDialog = { start: DesignSource; label: string } | { draft: string };

interface UiState {
  paletteOpen: boolean;
  settingsOpen: boolean;
  /** The Publish or the Share for review dialog. */
  publishDialog: 'publish' | 'share' | null;
  /** The "like this site, in a brand" dialog. */
  restyleOpen: boolean;
  /** The export, install and apply dialog of an Omarchy theme file. */
  omarchyThemeOpen: boolean;
  checksOpen: boolean;
  complianceOpen: boolean;
  /** Find on canvas. With `replace`, it finds the words of text layers, on this page or all of them, and replaces them. */
  find: { open: boolean; query: string; index: number; replace?: boolean; with?: string; matchCase?: boolean; wholeWord?: boolean; allPages?: boolean };
  /** The dialog that renames several layers at once. */
  bulkRename: string[] | null;
  gradient: GradientEdit | null;
  /** The image layer being cropped with handles on the canvas. */
  crop: { nodeId: string } | null;
  lightbox: LightboxState | null;
  motionPaused: boolean;
  /** The line tool draws an arrow next. */
  arrowLine: boolean;
  pull: PullDialog | null;
  /** The dialog of the linked repository's tokens next to the file's. */
  repoTokensOpen: boolean;
  /** The width the inspector edits at: null is the base style, a number writes into @media (max-width: N px). */
  breakpoint: number | null;
  /** The artboard shown at several widths side by side, from the same file: its id, or null when closed. */
  sizesOf: string | null;
  /** A panel open over the canvas because the window has no room for it beside the canvas, or none. */
  drawer: 'left' | 'right' | null;
  /** The icon picker, which opens from the toolbar or from its More tools menu. */
  iconsOpen: boolean;
  /** A fit that holds while the window and panels change: the artboard and how it is fitted. Null after a pan or zoom. */
  autoFit: { id: string; mode: 'screen' | 'width' } | null;
  set: (patch: Partial<UiState>) => void;
}

export const useUi = create<UiState>((set) => ({
  paletteOpen: false,
  settingsOpen: false,
  publishDialog: null,
  restyleOpen: false,
  omarchyThemeOpen: false,
  checksOpen: false,
  complianceOpen: false,
  find: { open: false, query: '', index: 0 },
  bulkRename: null,
  gradient: null,
  crop: null,
  lightbox: null,
  motionPaused: false,
  arrowLine: false,
  pull: null,
  repoTokensOpen: false,
  breakpoint: null,
  sizesOf: null,
  drawer: null,
  iconsOpen: false,
  autoFit: null,
  set: (patch) => set(patch),
}));

export function ui(): UiState {
  return useUi.getState();
}
