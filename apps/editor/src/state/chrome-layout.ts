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
/** Below this window width the chat opens across the whole window. */
export const PHONE_CHAT_FULL = 600;
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
  if (uiWidth >= 1220) return 'full';
  if (uiWidth >= 900) return 'tight';
  if (uiWidth >= 700) return 'compact';
  if (uiWidth >= 560) return 'mini';
  return 'micro';
}

const LEVELS: readonly ToolbarLevel[] = ['full', 'tight', 'compact', 'mini', 'micro'];

/**
 * What the toolbar holds at each level beyond its optional parts, in UI pixels, as chrome.css draws it: padding and
 * column gaps, Home, the file name at its smallest (FILE_NAME_MIN), the branch button as its icon, the tools shown
 * inline (28 px each, in groups with a separator between them where all of them show), and the right side's fixed
 * buttons (26 px each, Me 24, the separators, the zoom button 48).
 *   tight    28 + (26 + 140 + 26 + 4) + 15 tools in 6 groups 464 + (Me, sep, undo, redo, more, zoom, agent) 197
 *   compact  28 + (26 + 120 + 26 + 4) + 7 tools and more 231 + the same 197
 *   mini     16 + (26 + 96 + 26 + 4) + 3 tools and more 115 + (Me, sep, undo, redo, more, agent) 143
 *   micro    16 + (26 + 72 + 26 + 4) + more 28 + (more, agent) 54: Me, the panels and history are in More
 * Each with 8 px to spare for the people's empty row and rounding. The full level is not a sum: see fullNeed.
 */
const TOOLBAR_NEED: Record<Exclude<ToolbarLevel, 'full'>, number> = { tight: 893, compact: 640, mini: 434, micro: 234 };
/**
 * The full toolbar keeps its tools in the middle of the window, so both sides get the room of the wider one:
 *   left    Home, the file name at its smallest, the branch button: 26 + 160 + 26 + 4
 *   tools   15 in 6 groups: 15 x 28, 5 separators of 9, and 19 gaps of 1
 *   right   Me, sep, undo, redo, sep, 4 views, help, zoom, Preview and Ask agent as icons: 346 with their gaps
 */
const FULL_PAD = 28 + 8;
const FULL_LEFT = 216;
const FULL_TOOLS = 484;
const FULL_RIGHT = 346;
/** The file name's own minimum at each level, in UI pixels (chrome.css). */
export const FILE_NAME_MIN: Record<ToolbarLevel, number> = { full: 160, tight: 140, compact: 120, mini: 96, micro: 72 };
/** The widest the parts that come and go may be drawn at each level (chrome.css caps them), in UI pixels. */
const SYNC_MAX: Record<ToolbarLevel, number> = { full: 260, tight: 220, compact: 110, mini: 24, micro: 24 };
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

/**
 * How Preview and Ask agent show in the full toolbar: with their words and the shortcut, with their words, Ask agent
 * alone with its words, or both as icons.
 */
export type ToolbarLabels = 'keys' | 'text' | 'primary' | 'none';
/** The text widths of those labels in this language, in UI pixels (textWidth in home/head-fit.ts). */
export interface ToolbarLabelText { preview: number; agent: number; keys: number }

/** What the labels add to the two buttons: the gap after the icon, the words, and the padding a labelled button has. */
function labelsNeed(labels: ToolbarLabels, w: ToolbarLabelText): number {
  if (labels === 'none') return 0;
  if (labels === 'primary') return 19 + w.agent;
  return 19 + w.preview + 19 + w.agent + (labels === 'keys' ? 14 + w.keys : 0);
}

function fullNeed(c: ToolbarContent, labels = 0): number {
  const left = FULL_LEFT + (c.leftDrawer ? 28 : 0) + (c.sync ? SYNC_MAX.full + 2 : 0) + (c.branchNamed ? BRANCH_LABEL_MAX.full + 4 : 0);
  const shown = Math.min(c.peers, PEERS_SHOWN.full);
  const right = FULL_RIGHT + (c.rightDrawer ? 28 : 0) + shown * 26 + (c.peers > shown ? 26 : 0) + (c.following ? FOLLOW_MAX.full + 2 : 0) + labels;
  return FULL_PAD + FULL_TOOLS + 2 * Math.max(left, right);
}

/** The most the full toolbar can say on Preview and Ask agent at this width; below the full level they are icons. */
export function toolbarLabels(uiWidth: number, level: ToolbarLevel, c: ToolbarContent, w: ToolbarLabelText): ToolbarLabels {
  if (level !== 'full') return 'none';
  for (const labels of ['keys', 'text', 'primary'] as const) if (fullNeed(c, labelsNeed(labels, w)) <= uiWidth) return labels;
  return 'none';
}

/** The width in UI pixels the toolbar needs at a level with this content. */
export function toolbarNeed(level: ToolbarLevel, c: ToolbarContent): number {
  if (level === 'full') return fullNeed(c);
  const drawers = level === 'micro' ? 0 : (c.leftDrawer ? 28 : 0) + (c.rightDrawer ? 28 : 0);
  const shown = Math.min(c.peers, PEERS_SHOWN[level]);
  const peers = shown * 26 + (c.peers > shown ? 26 : 0);
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

export type ChatDock = 'docked' | 'drawer' | 'closed';
export interface ChatChrome extends ChromeLayout {
  chat: ChatDock;
  /** The chat's width in window pixels, docked or as a drawer. */
  chatPx: number;
}

/**
 * The layout with the chat panel. Open, it sits between the canvas and the inspector when the canvas keeps its
 * minimum: first with everything docked, then with layers in a drawer, as the inspector does. When even that leaves
 * too little canvas, the chat opens over the canvas as a drawer at its right edge and the rest stays as it was.
 * Closed, the layout is exactly the one without it.
 */
export function chatLayout(input: ChromeInput & { chatOpen: boolean; chatWidth: number }): ChatChrome {
  const base = chromeLayout(input);
  const s = input.scale > 0 ? input.scale : 1;
  const want = input.chatWidth * s;
  if (!input.chatOpen) return { ...base, chat: 'closed', chatPx: Math.round(want) };
  const { width } = input;
  if (base.mode === 'wide' && width - base.leftPx - base.rightPx - want >= CANVAS_MIN) return { ...base, chat: 'docked', chatPx: Math.round(want) };
  if (base.right === 'docked') {
    const right = input.rightWidth * s;
    if (width - right - want >= CANVAS_MIN) return { ...base, mode: 'compact', left: 'drawer', right: 'docked', rightPx: Math.round(right), chat: 'docked', chatPx: Math.round(want) };
  }
  const room = width - (base.right === 'docked' ? base.rightPx : 0);
  // At phone width a strip of canvas beside the chat is too narrow to use: the chat takes the whole width.
  if (width < PHONE_CHAT_FULL) return { ...base, chat: 'drawer', chatPx: Math.round(room) };
  const px = Math.round(Math.max(Math.min(want, room - DRAWER_GAP), Math.min(PANEL_MIN * s, room)));
  return { ...base, chat: 'drawer', chatPx: px };
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
