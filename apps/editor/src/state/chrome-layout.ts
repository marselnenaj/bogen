import { useSyncExternalStore } from 'react';

/**
 * How the editor's own chrome fits the window: which panels sit beside the canvas, which open over it as drawers,
 * and how much of the toolbar shows. It reads the window's size and the UI scale and nothing else, so the same window
 * always gets the same layout, and it never writes the panel widths a person dragged to: a panel that does not fit is
 * drawn narrower or moved into a drawer, and gets its own width back when the window grows again.
 */

/** The narrowest canvas, in window pixels, that the panels may leave. Below it a panel moves into a drawer. */
export const CANVAS_MIN = 360;
/** The narrowest a docked panel is drawn, in UI pixels (before the UI scale). */
export const PANEL_MIN = 200;
/** What a drawer leaves of the canvas beside it, in window pixels, so a click there closes it. */
export const DRAWER_GAP = 40;
/** Below this many UI pixels of height, dialogs and panels use the room more tightly. */
export const SHORT_HEIGHT = 600;

/** How much of the toolbar shows, from everything to the essentials; what is left out is in its menus. */
export type ToolbarLevel = 'full' | 'tight' | 'compact' | 'mini' | 'micro';
export type Dock = 'docked' | 'drawer';

export interface ChromeInput {
  /** Window size in CSS pixels. */
  width: number;
  height: number;
  /** The UI scale: 1, 1.25 or 1.5. */
  scale: number;
  /** The panel widths a person chose, in UI pixels. */
  leftWidth: number;
  rightWidth: number;
}

export interface ChromeLayout {
  mode: 'wide' | 'compact' | 'narrow';
  left: Dock;
  right: Dock;
  /** Widths in window pixels: as docked, or as a drawer. */
  leftPx: number;
  rightPx: number;
  toolbar: ToolbarLevel;
  /** A low window: dialogs start near the top and scroll. */
  short: boolean;
}

/** The toolbar's levels by its width in UI pixels (the toolbar is drawn at the UI scale). */
export function toolbarLevel(uiWidth: number): ToolbarLevel {
  if (uiWidth >= 1120) return 'full';
  if (uiWidth >= 900) return 'tight';
  if (uiWidth >= 700) return 'compact';
  if (uiWidth >= 560) return 'mini';
  return 'micro';
}

const LEVELS: readonly ToolbarLevel[] = ['full', 'tight', 'compact', 'mini', 'micro'];

/**
 * What the toolbar holds at each level beyond its optional parts, in UI pixels, as chrome.css draws it: padding and
 * column gaps, Home, the file name at its smallest (FILE_NAME_MIN), the branch button as its icon, the tools shown
 * inline (28 px each), and the right side's fixed buttons (26 px each, Me 22, the separator, the zoom button 48).
 *   full     28 + (26 + 160 + 26 + 4) + 15 tools 434 + (Me, sep, undo, redo, agent, 5 views, help, zoom) 335
 *   tight    28 + (26 + 140 + 26 + 4) + 15 tools 434 + (Me, sep, undo, redo, agent, more, zoom) 195
 *   compact  28 + (26 + 120 + 26 + 4) + 7 tools and more 231 + the same 195
 *   mini     16 + (26 + 96 + 26 + 4) + 3 tools and more 115 + (Me, sep, undo, redo, agent, more) 141
 *   micro    16 + (26 + 72 + 26 + 4) + more 28 + (agent, more) 54: Me, the panels and history are in More
 * Each with 8 px to spare for the people's empty row and rounding.
 */
const TOOLBAR_NEED: Record<ToolbarLevel, number> = { full: 1021, tight: 861, compact: 638, mini: 432, micro: 234 };
/** The file name's own minimum at each level, in UI pixels (chrome.css). */
export const FILE_NAME_MIN: Record<ToolbarLevel, number> = { full: 160, tight: 140, compact: 120, mini: 96, micro: 72 };
/** The widest the parts that come and go may be drawn at each level (chrome.css caps them), in UI pixels. */
const SYNC_MAX: Record<ToolbarLevel, number> = { full: 200, tight: 140, compact: 110, mini: 18, micro: 18 };
/** At the smallest level the follow pill is Stop following in More, and the More button shows the colour followed. */
const FOLLOW_MAX: Record<ToolbarLevel, number> = { full: 180, tight: 160, compact: 120, mini: 96, micro: 0 };
const BRANCH_LABEL_MAX: Record<ToolbarLevel, number> = { full: 160, tight: 120, compact: 0, mini: 0, micro: 0 };
/** How many people the toolbar shows at each level; the rest are a "+n". */
export const PEERS_SHOWN: Record<ToolbarLevel, number> = { full: 6, tight: 3, compact: 3, mini: 1, micro: 0 };

/** The toolbar's parts that come and go with the file, the people in it and the window. */
export interface ToolbarContent {
  /** Panels in drawers have their buttons in the toolbar (in More at the smallest level). */
  leftDrawer: boolean;
  rightDrawer: boolean;
  /** Another device this Bogen syncs with: its state shows in the toolbar. */
  sync: boolean;
  /** Other people and agents in the file. */
  peers: number;
  /** Following someone: a pill says so and stops it. */
  following: boolean;
  /** The file has branches: their button shows the current one by name where there is room. */
  branchNamed: boolean;
}

/** The width in UI pixels the toolbar needs at a level with this content. */
export function toolbarNeed(level: ToolbarLevel, c: ToolbarContent): number {
  const drawers = level === 'micro' ? 0 : (c.leftDrawer ? 28 : 0) + (c.rightDrawer ? 28 : 0);
  const shown = Math.min(c.peers, PEERS_SHOWN[level]);
  const peers = shown * 24 + (c.peers > shown ? 24 : 0);
  return TOOLBAR_NEED[level] + drawers + peers
    + (c.sync ? SYNC_MAX[level] + 2 : 0)
    + (c.following && FOLLOW_MAX[level] ? FOLLOW_MAX[level] + 2 : 0)
    + (c.branchNamed && BRANCH_LABEL_MAX[level] ? BRANCH_LABEL_MAX[level] + 4 : 0);
}

/**
 * The fullest level, at most the window's own, whose controls fit the toolbar's width with this content. It reads
 * no layout, so it never feeds back into itself: the same window and content always get the same toolbar.
 */
export function fitToolbar(uiWidth: number, content: ToolbarContent, most: ToolbarLevel = toolbarLevel(uiWidth)): ToolbarLevel {
  for (const level of LEVELS.slice(LEVELS.indexOf(most))) if (toolbarNeed(level, content) <= uiWidth) return level;
  return 'micro';
}

export function chromeLayout({ width, height, scale, leftWidth, rightWidth }: ChromeInput): ChromeLayout {
  const s = scale > 0 ? scale : 1;
  const left = leftWidth * s;
  const right = rightWidth * s;
  const drawer = (px: number) => Math.round(Math.max(Math.min(px, width - DRAWER_GAP), Math.min(PANEL_MIN * s, width)));
  const toolbar = toolbarLevel(width / s);
  const short = height / s < SHORT_HEIGHT;
  // Both panels at the widths chosen, with room for the canvas.
  if (width - left - right >= CANVAS_MIN) return { mode: 'wide', left: 'docked', right: 'docked', leftPx: Math.round(left), rightPx: Math.round(right), toolbar, short };
  // The inspector stays beside the canvas, as wide as it can be up to its chosen width; layers and the rest open as a drawer.
  const fit = Math.min(right, width - CANVAS_MIN);
  if (fit >= PANEL_MIN * s) return { mode: 'compact', left: 'drawer', right: 'docked', leftPx: drawer(left), rightPx: Math.round(fit), toolbar, short };
  // Too narrow for any panel beside the canvas: both open over it.
  return { mode: 'narrow', left: 'drawer', right: 'drawer', leftPx: drawer(left), rightPx: drawer(right), toolbar, short };
}

// ---------------------------------------------------------------- the window, as React reads it

function subscribe(fn: () => void): () => void {
  window.addEventListener('resize', fn);
  return () => window.removeEventListener('resize', fn);
}

/** A string compares by value, so the snapshot stays the same until the window's size changes. */
const readSize = () => `${window.innerWidth}x${window.innerHeight}`;

/** The window's size in CSS pixels, re-rendering when it changes. */
export function useWindowSize(): { width: number; height: number } {
  const key = useSyncExternalStore(subscribe, readSize, () => '1440x900');
  const [w, h] = key.split('x').map(Number);
  return { width: w!, height: h! };
}
