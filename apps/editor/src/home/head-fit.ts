/**
 * How much of Home's header shows at a width: everything; or Live site, the imports and the update note in a More
 * menu; or that and the new-file button as its icon. It is decided from the header's own labels, measured as text
 * (in any language) and never from the laid-out header, so it cannot feed back into itself.
 */
export type HomeHeadLevel = 'full' | 'menu' | 'tight';

/** The text widths of the header's labels, in UI pixels at the header's own fonts. */
export interface HomeHeadText {
  brand: number;
  live: number;
  figma: number;
  open: number;
  newFile: number;
  /** The note that a newer Bogen is out, 0 without one. */
  update: number;
}

/** UI pixels, as app.css draws the header: 12 px padding each side, 12 px gaps (8 px when tight), 28 px buttons. */
const PAD = 24;
const SETTINGS = 26;
const MORE = 26;
const ICON = 20; // a 14 px icon and the 6 px gap after it
const BTN = 20; // a button's padding
export const SEARCH_MIN: Record<HomeHeadLevel, number> = { full: 160, menu: 120, tight: 100 };

export function homeHeadNeed(level: HomeHeadLevel, w: HomeHeadText): number {
  const brand = 16 + 6 + w.brand;
  if (level === 'full') {
    const items = [brand, w.update, w.live, SEARCH_MIN.full, w.figma + BTN, ICON + w.open + BTN, ICON + w.newFile + BTN, SETTINGS].filter((x) => x > 0);
    return PAD + items.reduce((a, b) => a + b, 0) + 12 * (items.length - 1);
  }
  if (level === 'menu') return PAD + brand + SEARCH_MIN.menu + ICON + w.newFile + BTN + SETTINGS + MORE + 8 * 4;
  return PAD + 16 + SEARCH_MIN.tight + 28 + SETTINGS + MORE + 8 * 4;
}

export function homeHeadLevel(uiWidth: number, w: HomeHeadText): HomeHeadLevel {
  if (homeHeadNeed('full', w) <= uiWidth) return 'full';
  if (homeHeadNeed('menu', w) <= uiWidth) return 'menu';
  return 'tight';
}

let ctx: CanvasRenderingContext2D | null | undefined;

/**
 * The width of a label in UI pixels, with a margin for the font still loading and for rounding. Canvas text metrics:
 * no element is laid out for it.
 */
export function textWidth(text: string, size: number, weight = 400): number {
  if (!text) return 0;
  if (ctx === undefined) ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  const family = typeof document === 'undefined' ? 'sans-serif' : getComputedStyle(document.body).fontFamily || 'sans-serif';
  if (!ctx) return text.length * size * 0.6;
  ctx.font = `${weight} ${size}px ${family}`;
  return Math.ceil(ctx.measureText(text).width * 1.08) + 2;
}
