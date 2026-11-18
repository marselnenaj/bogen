import { libraryLinks, type BogenDoc, type BogenNode } from '@bogen/core';
import type { Renderer } from '../render.ts';
import type { LintIssue } from './lint.ts';

/**
 * Checks for phone app screens, measured on the rendered artboard. Each finding is hard only where it is objective:
 * a 1 to 3px slip between edges, gaps or paddings that are meant to be equal (nobody means 14px next to 16px), text
 * and controls under the status bar or in the home indicator strip, a real control under the 24px WCAG minimum. What
 * is a platform convention rather than a defect (44pt and 48dp targets, the tab bar's size, a large empty band, no
 * platform kit) is advisory, with the numbers and why.
 */

export type AppPlatform = 'ios' | 'android';
export interface AppBoard { id: string; platform: AppPlatform; width: number; height: number; statusBar: number; homeIndicator: number; target: number }

/** The numbers the checks and the guidance quote, in one place. */
export const APP_LIMITS = {
  /** A slip: two values that differ by more than this and at most `slipMax` px are meant to be one value. */
  slipMin: 0.75, slipMax: 3, paddingSlipMax: 3,
  /** Display type at least this big may take less padding above it, to make up for its leading. */
  opticalPx: 28,
  /** A button's label this far off its vertical centre. */
  offCentre: 2,
  /** WCAG 2.5.8: the least size of a target. Under it is hard. */
  wcagTarget: 24,
  iosTarget: 44, androidTarget: 48,
  /** An empty band at least this tall and this many times the median gap of its stack. */
  emptyBandPx: 96, emptyBandRatio: 3,
  /** The tab bar of iOS: 49pt of bar over the 34pt home indicator inset, labels at 10pt. */
  iosTabBar: 49, iosTabBarTotal: 83, iosTabItemsMax: 5,
  /** Material's navigation bar: 80dp, 3 to 5 destinations. */
  androidNavBar: 80,
  /** Sentences on a phone read at 15pt or more; HIG body is 17pt, Material body large 16sp. */
  minSentencePx: 15, paragraphWords: 12, minFootnotePx: 13, sentenceWords: 6,
} as const;

/** The status bar height and home indicator inset of the iPhone sizes Bogen knows, by artboard height. */
const IOS_INSETS: Record<number, [number, number]> = {
  667: [20, 0], 736: [20, 0], 812: [44, 34], 844: [47, 34], 926: [47, 34], 852: [54, 34], 932: [54, 34], 874: [62, 34], 956: [62, 34],
};

const PHONE_WIDTH = [320, 440] as const;
/** How far a box may reach into a safe area before it counts: leading and hit areas, not collisions. */
const SAFE_SLACK = 4;
const IOS_WORDS = /\b(ios|iphone|ipados|swiftui|cupertino|ionic)\b/i;
const ANDROID_WORDS = /\b(android|material|pixel|galaxy|compose|m3)\b/i;
const IOS_KIT = /ionic|ios/i;
const ANDROID_KIT = /material/i;

function px(value: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? '');
  return m ? Number(m[1]) : null;
}

/** The platform kits linked into the file, by platform. */
export function linkedPlatformKits(doc: BogenDoc): { ios: boolean; android: boolean } {
  const names = libraryLinks(doc).map((l) => l.name);
  return { ios: names.some((n) => IOS_KIT.test(n)), android: names.some((n) => ANDROID_KIT.test(n)) };
}

/**
 * A phone app screen: an artboard 320 to 440px wide and taller than wide. Its platform comes from the names of the
 * artboard, its page and the file (iOS, iPhone, Android, Material), then from a linked platform kit, then from its
 * width (360, 384 and 412 are Android widths).
 */
export function appBoardOf(doc: BogenDoc, nodeId: string, hints: { fileName?: string; height?: number } = {}): AppBoard | null {
  const board = [nodeId, ...doc.ancestors(nodeId)].map((id) => doc.getNode(id)).find((n): n is BogenNode => !!n?.artboard);
  if (!board) return null;
  const width = px(board.style.width);
  const height = px(board.style.height) ?? hints.height ?? null;
  if (width === null || width < PHONE_WIDTH[0] || width > PHONE_WIDTH[1] || (height !== null && height < width * 1.3)) return null;
  const page = doc.getPages().find((p) => p.id === board.parent);
  const words = `${board.name} ${page?.name ?? ''} ${hints.fileName ?? ''}`;
  const kits = linkedPlatformKits(doc);
  const platform: AppPlatform = IOS_WORDS.test(words) ? 'ios' : ANDROID_WORDS.test(words) ? 'android'
    : kits.ios && !kits.android ? 'ios' : kits.android && !kits.ios ? 'android'
    : [360, 384, 411, 412].includes(width) ? 'android' : 'ios';
  const h = height ?? 852;
  const [statusBar, homeIndicator] = platform === 'android' ? [24, 24] : IOS_INSETS[h] ?? (h >= 800 ? [47, 34] : [20, 0]);
  return { id: board.id, platform, width, height: h, statusBar, homeIndicator, target: platform === 'android' ? APP_LIMITS.androidTarget : APP_LIMITS.iosTarget };
}

/** One rendered layer of an artboard, relative to the artboard's top left. */
export interface AppEl {
  id: string; parent: string | null; tag: string; role: string;
  x: number; y: number; w: number; h: number;
  display: string; position: string; flexDirection: string; alignItems: string; alignSelf: string; justifyContent: string; textAlign: string;
  autoMargin: boolean; pad: [number, number, number, number];
  /** A background, border or shadow: an edge a reader sees. */
  box: boolean; text: string; fontSize: number; inline: boolean;
  /** It or an ancestor below the artboard is positioned absolute or fixed: out of the flow the checks read. */
  floating: boolean; svg: boolean;
}

/** Runs in the page: the geometry and the few computed styles the checks read, for every layer of one artboard. */
export function appProbe(arg: { root: string }): { board: { w: number; h: number; style: Partial<AppEl> }; els: AppEl[] } {
  const root = document.querySelector<HTMLElement>(`[data-bogen-id="${CSS.escape(arg.root)}"]`);
  if (!root) return { board: { w: 0, h: 0, style: {} }, els: [] };
  const r0 = root.getBoundingClientRect();
  const rs = getComputedStyle(root);
  const style: Partial<AppEl> = { display: rs.display, flexDirection: rs.flexDirection, alignItems: rs.alignItems, justifyContent: rs.justifyContent, textAlign: rs.textAlign, pad: [rs.paddingTop, rs.paddingRight, rs.paddingBottom, rs.paddingLeft].map((v) => Number.parseFloat(v) || 0) as [number, number, number, number] };
  const els: AppEl[] = [];
  const transparent = (c: string) => c === 'transparent' || /rgba?\([^)]*,\s*0(\.0+)?\)$/.test(c) || /\/\s*0%?\)$/.test(c);
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('[data-bogen-id]')) {
    const id = el.getAttribute('data-bogen-id')!;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const parentEl = el.parentElement?.closest('[data-bogen-id]');
    let floating = false;
    for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
      const p = getComputedStyle(a).position;
      if (p === 'absolute' || p === 'fixed') { floating = true; break; }
    }
    const own = [...el.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => Number.parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && !transparent(s.getPropertyValue(`border-${side.toLowerCase()}-color`)) && s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none');
    els.push({
      id, parent: parentEl ? parentEl.getAttribute('data-bogen-id') : null, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '',
      x: b.left - r0.left, y: b.top - r0.top, w: b.width, h: b.height,
      display: s.display, position: s.position, flexDirection: s.flexDirection, alignItems: s.alignItems, alignSelf: s.alignSelf, justifyContent: s.justifyContent, textAlign: s.textAlign,
      autoMargin: s.marginLeft === 'auto' || (el as HTMLElement).style?.marginLeft === 'auto' || (el as HTMLElement).style?.margin?.includes('auto') === true,
      pad: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map((v) => Number.parseFloat(v) || 0) as [number, number, number, number],
      box: !transparent(s.backgroundColor) || s.backgroundImage !== 'none' || border || s.boxShadow !== 'none',
      text: own.slice(0, 80), fontSize: Number.parseFloat(s.fontSize) || 0, inline: s.display === 'inline',
      floating, svg: el instanceof SVGElement,
    });
  }
  return { board: { w: r0.width, h: r0.height, style }, els };
}

const CONTROL_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const CONTROL_ROLES = new Set(['button', 'link', 'tab', 'switch', 'checkbox', 'radio', 'menuitem', 'slider', 'option', 'combobox', 'searchbox']);
const isControl = (e: AppEl) => (CONTROL_TAGS.has(e.tag) || CONTROL_ROLES.has(e.role)) && !e.inline;
const TIME = /^\d{1,2}:\d{2}$/;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => `${Math.round(n * 10) / 10}px`;
export const edgeSlip = (a: number, b: number, max: number = APP_LIMITS.slipMax) => { const d = Math.abs(a - b); return d > APP_LIMITS.slipMin && d <= max; };

/** The layers that draw the system: the status bar (a time at the very top) and the home indicator (a pill at the bottom). */
function systemChrome(board: AppBoard, els: AppEl[], doc: BogenDoc): Set<string> {
  const byId = new Map(els.map((e) => [e.id, e]));
  const chrome = new Set<string>();
  const named = (e: AppEl) => /status\s*bar|home\s*indicator|dynamic\s*island|system\s*bar|gesture/i.test(doc.getNode(e.id)?.name ?? '');
  for (const e of els) {
    let top: AppEl | undefined;
    if (named(e)) top = e;
    else if (TIME.test(e.text) && e.y < board.statusBar + 8) {
      // The time's row: the outermost ancestor that still sits in the status bar.
      top = e;
      for (let p = e.parent ? byId.get(e.parent) : undefined; p && p.y >= -1 && p.y + p.h <= board.statusBar + 12; p = p.parent ? byId.get(p.parent) : undefined) top = p;
    } else if (e.y > board.height - 40 && e.w >= 100 && e.w <= 160 && e.h <= 6) top = e;
    if (top) chrome.add(top.id);
  }
  // Everything inside a chrome layer is chrome too.
  for (const e of els) for (let p: AppEl | undefined = e; p; p = p.parent ? byId.get(p.parent) : undefined) if (chrome.has(p.id)) { chrome.add(e.id); break; }
  return chrome;
}

/** The bottom bar of tabs: full width, in the lowest 120px, holding three to six items side by side. */
function tabBarOf(board: AppBoard, els: AppEl[]): { bar: AppEl; items: AppEl[] } | null {
  const children = new Map<string, AppEl[]>();
  for (const e of els) if (e.parent) children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
  const candidates = els.filter((e) => e.w >= board.width * 0.9 && e.y + e.h >= board.height - 40 && e.y >= board.height - 130 && e.h >= 40);
  for (const bar of candidates.sort((a, b) => a.h - b.h)) {
    // The items are the widest set of siblings in a row inside the bar.
    let best: AppEl[] = [];
    const walk = (id: string) => {
      const kids = (children.get(id) ?? []).filter((k) => !k.floating || k.position === 'absolute');
      const row = kids.filter((k) => k.w < board.width / 2.5 && k.w >= 40);
      if (row.length >= 3 && row.length <= 7 && new Set(row.map((k) => Math.round(k.y / 8))).size === 1 && row.length > best.length) best = row;
      for (const k of kids) walk(k.id);
    };
    walk(bar.id);
    // Tabs have an icon and a label each; a row of footer links has no icons.
    const within = (t: AppEl, i: AppEl) => t.y >= i.y - 1 && t.y + t.h <= i.y + i.h + 1 && t.x >= i.x - 1 && t.x + t.w <= i.x + i.w + 1;
    const iconLike = (t: AppEl) => t.svg || (!t.text && t.w >= 12 && t.w <= 40 && t.h >= 12 && t.h <= 40);
    if (best.length >= 3 && best.every((i) => els.some((t) => t.id !== i.id && iconLike(t) && within(t, i))) && best.some((i) => els.some((t) => t.text && within(t, i)))) return { bar, items: best };
  }
  return null;
}

export interface AppCheckOptions { hasKit: boolean; boardStyle?: Partial<AppEl> }

const BOARD_EL: AppEl = { id: '', parent: null, tag: 'main', role: '', x: 0, y: 0, w: 0, h: 0, display: 'flex', position: 'absolute', flexDirection: 'column', alignItems: 'stretch', alignSelf: 'auto', justifyContent: 'normal', textAlign: 'start', autoMargin: false, pad: [0, 0, 0, 0], box: true, text: '', fontSize: 16, inline: false, floating: false, svg: false };

/** The findings for one app artboard from its rendered layers. Pure, so it is tested without a browser. */
export function appIssuesFrom(doc: BogenDoc, board: AppBoard, els: AppEl[], options: AppCheckOptions, exempt?: Set<string>): LintIssue[] {
  const out: LintIssue[] = [];
  const nameOf = (id: string) => doc.getNode(id)?.name ?? '';
  const chrome = systemChrome(board, els, doc);
  const byId = new Map(els.map((e) => [e.id, e]));
  if (!byId.has(board.id)) byId.set(board.id, { ...BOARD_EL, ...options.boardStyle, id: board.id, w: board.width, h: board.height });
  const kids = new Map<string, AppEl[]>();
  for (const e of els) if (e.parent) kids.set(e.parent, [...(kids.get(e.parent) ?? []), e]);
  const live = els.filter((e) => !chrome.has(e.id) && e.id !== board.id);
  const add = (issue: Omit<LintIssue, 'name'>) => out.push({ ...issue, name: nameOf(issue.nodeId) });
  const ancestorsOf = (e: AppEl) => { const list: AppEl[] = []; for (let p = e.parent ? byId.get(e.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) list.push(p); return list; };
  const insideControl = (e: AppEl) => ancestorsOf(e).some((a) => a.id !== board.id && isControl(a));
  const isWords = (e: AppEl) => e.text.length > 0 && !e.svg;
  const tab = tabBarOf(board, live);
  const inTab = new Set<string>();
  if (tab) for (const e of live) if ([e, ...ancestorsOf(e)].some((a) => a.id === tab.bar.id)) inTab.add(e.id);
  // A tab bar's labels are 10pt on iOS by the platform's design, not small text to fix.
  if (exempt) for (const id of inTab) if ((byId.get(id)?.fontSize ?? 0) >= 10) exempt.add(id);

  // Safe areas. Words and controls under the status bar, or in the home indicator strip, collide with the system.
  // A box that reaches a few pixels in is leading or a hit area, not a collision: it counts from SAFE_SLACK on.
  const reported = new Set<string>();
  const top: AppEl[] = [], bottom: AppEl[] = [];
  const edge = board.height - board.homeIndicator;
  for (const e of live) {
    if (!(isWords(e) || isControl(e))) continue;
    if (insideControl(e) && !isControl(e)) continue;
    if (ancestorsOf(e).some((a) => reported.has(a.id))) continue;
    if (e.y < board.statusBar - SAFE_SLACK && e.y + e.h > SAFE_SLACK) { reported.add(e.id); top.push(e); }
    else if (board.homeIndicator && e.y + e.h > edge + SAFE_SLACK && e.y < board.height) { reported.add(e.id); bottom.push(e); }
  }
  const named = (list: AppEl[]) => list.slice(0, 6).map((e) => `${e.id}${e.text ? ` "${e.text.slice(0, 24)}"` : ''}`).join(', ');
  if (top.length) add({ rule: 'platform', check: 'safe-area', severity: 'hard', criterion: 'craft', nodeId: top[0]!.id, message: `${top.length} text or control layer${top.length === 1 ? ' starts' : 's start'} under the ${board.platform === 'ios' ? 'status bar and the Dynamic Island' : 'status bar'}, which ends at ${board.statusBar}px on a ${board.width}x${board.height} ${board.platform === 'ios' ? 'iPhone' : 'phone'}: ${named(top)} (the highest at y=${fmt(Math.min(...top.map((e) => e.y)))}). Start content at ${board.statusBar}px or lower, with a navigation bar or the screen's padding-top.` });
  if (bottom.length) add({ rule: 'platform', check: 'safe-area', severity: 'hard', criterion: 'craft', nodeId: bottom[0]!.id, message: `${bottom.length} text or control layer${bottom.length === 1 ? ' reaches' : 's reach'} into the ${board.homeIndicator}px ${board.platform === 'ios' ? 'home indicator' : 'gesture'} strip below ${edge}px, where a swipe goes home: ${named(bottom)} (the lowest ends at y=${fmt(Math.max(...bottom.map((e) => e.y + e.h)))}). End them at ${edge}px or higher: give the screen, or its tab bar, padding-bottom ${board.homeIndicator}px, and let only backgrounds reach the edge.` });

  // Targets. Under 24px a real control fails WCAG 2.5.8; under the platform's 44pt or 48dp it is hard to hit.
  for (const e of live) {
    if (!isControl(e) || insideControl(e)) continue;
    const small = Math.min(e.w, e.h);
    if (small < APP_LIMITS.wcagTarget) {
      add({ rule: 'target', check: 'target-minimum', severity: 'hard', criterion: 'craft', nodeId: e.id, message: `This ${e.tag === 'a' ? 'link' : 'control'} is ${Math.round(e.w)}x${Math.round(e.h)}px, under the ${APP_LIMITS.wcagTarget}px minimum of WCAG 2.5.8. Give it min-height and min-width ${board.target}px (padding, not a bigger glyph).` });
    } else if (small < board.target - 0.5 && !((e.role === 'switch' || e.role === 'tab') && e.h >= 28)) {
      add({ rule: 'target', check: 'platform-target', severity: 'advisory', criterion: 'craft', why: `${board.platform === 'ios' ? 'Apple asks for 44x44pt' : 'Material asks for 48x48dp'} hit areas: smaller targets get missed with a thumb.`, nodeId: e.id, message: `This ${e.tag === 'a' ? 'link' : 'control'} is ${Math.round(e.w)}x${Math.round(e.h)}px, under ${board.target}x${board.target}. Pad it to ${board.target}px; a segmented control or a switch may stay at its native ${board.platform === 'ios' ? '32 and 31pt' : '40dp'}.` });
    }
  }
  // Something that is drawn as a button but is not one has no role for a screen reader and no hit area of its own.
  const looksTappable = live.filter((e) => !isControl(e) && !insideControl(e) && e.box && !e.svg && e.h >= 28 && e.h <= 64 && e.w >= 44 && e.w <= board.width
    && /button|btn|cta|continue|start|next|done|cancel|close|subscribe|buy|try|save|open|skip|retry|restore/i.test(nameOf(e.id))
    && (kids.get(e.id) ?? []).length <= 4 && words(e.text || (kids.get(e.id) ?? []).map((k) => k.text).join(' ')) <= 6);
  if (looksTappable.length) {
    add({ rule: 'platform', check: 'not-a-button', severity: 'advisory', criterion: 'fit', why: 'A tappable shape drawn as a div has no role, no focus and no handoff as a control; code and the critique read it as decoration.', nodeId: looksTappable[0]!.id, message: `${looksTappable.length} layer${looksTappable.length === 1 ? ' is' : 's are'} drawn as a button but not written as one (${looksTappable.slice(0, 5).map((e) => `${e.id} "${nameOf(e.id).slice(0, 24)}"`).join(', ')}). Write them as <button> or <a>, or place the kit's Button.` });
  }

  // Edges that slip by 1 to 3px. Only layers anchored to the screen's left edge count: each one starts its parent's
  // content (or up to 3px past it, the slip itself), in a parent that is anchored too. A value at the end of a row,
  // a second grid column or a centred label starts wherever its text ends, and says nothing about alignment.
  const anchoredMemo = new Map<string, boolean>();
  const anchored = (e: AppEl): boolean => {
    const known = anchoredMemo.get(e.id);
    if (known !== undefined) return known;
    let ok = false;
    const p = e.parent ? byId.get(e.parent) : undefined;
    if (p && !e.floating && !e.inline && !e.svg && !e.autoMargin) {
      const inset = e.x - (p.x + p.pad[3]);
      const flex = /flex/.test(p.display);
      const start = flex && /column/.test(p.flexDirection) ? !/center|end|right/.test(e.alignSelf === 'auto' ? p.alignItems : e.alignSelf)
        : flex ? (kids.get(p.id) ?? []).filter((k) => !k.floating)[0]?.id === e.id && !/center|end|right|space-around|space-evenly/.test(p.justifyContent)
        : !/center|right|end/.test(p.textAlign);
      ok = start && inset >= -0.5 && inset <= APP_LIMITS.slipMax && (p.id === board.id || anchored(p));
    }
    anchoredMemo.set(e.id, ok);
    return ok;
  };
  // A shape drawn just inside another (a segment's pill in its track, a fill in a bar) sits at the track's padding.
  const inShape = (e: AppEl) => { const p = e.parent ? byId.get(e.parent) : undefined; return !!p && p.id !== board.id && p.box && e.x - p.x <= APP_LIMITS.slipMax; };
  const startAligned = (e: AppEl) => (e.box || isWords(e)) && !chrome.has(e.id) && !inTab.has(e.id) && !inShape(e) && anchored(e);
  const edges = new Map<number, AppEl[]>();
  for (const e of live) if (startAligned(e)) { const k = Math.round(e.x * 2) / 2; edges.set(k, [...(edges.get(k) ?? []), e]); }
  const lines = [...edges.keys()].sort((a, b) => a - b);
  const seenPairs = new Set<string>();
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const [a, b] = [lines[i]!, lines[j]!];
    if (!edgeSlip(a, b)) continue;
    const [many, few] = edges.get(a)!.length >= edges.get(b)!.length ? [a, b] : [b, a];
    // A layer inside another sits at its padding on purpose (a segment in its track); a slip is between branches.
    const related = (x: AppEl, y: AppEl) => ancestorsOf(x).includes(y) || ancestorsOf(y).includes(x);
    if (!edges.get(few)!.some((x) => edges.get(many)!.some((y) => !related(x, y)))) continue;
    const key = `${few}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const off = edges.get(few)!;
    add({ rule: 'spacing', check: 'edge-slip', severity: 'hard', criterion: 'spacing', nodeId: off[0]!.id, message: `${off.length === 1 ? 'This layer starts' : `${off.length} layers start`} at x=${fmt(few)} (${off.slice(0, 5).map((e) => e.id).join(', ')}), ${fmt(Math.abs(many - few))} from the line at x=${fmt(many)} that ${edges.get(many)!.length} layers share (${edges.get(many)!.slice(0, 4).map((e) => e.id).join(', ')}). An edge that slips by ${Math.round(Math.abs(many - few))}px reads as a mistake: put both on one line, usually by giving the containers the same padding.` });
  }

  // Gaps in one stack that slip by 1 to 3px, and an empty band far larger than the stack's rhythm.
  for (const [parentId, list] of kids) {
    const p = byId.get(parentId);
    if (!p || chrome.has(parentId) || inTab.has(parentId)) continue;
    const flow = list.filter((k) => !k.floating && !k.inline && !k.svg && !chrome.has(k.id));
    if (flow.length < 3) continue;
    const column = (/flex/.test(p.display) && /column/.test(p.flexDirection)) || (!/flex|grid/.test(p.display) && flow.every((k) => !/inline/.test(k.display)));
    const row = /flex/.test(p.display) && !/column/.test(p.flexDirection) && /normal|flex-start|start|left/.test(p.justifyContent);
    if (!column && !row) continue;
    const sorted = [...flow].sort((a, b) => (column ? a.y - b.y : a.x - b.x));
    const gaps = sorted.slice(1).map((k, i) => ({ after: sorted[i]!, before: k, gap: column ? k.y - (sorted[i]!.y + sorted[i]!.h) : k.x - (sorted[i]!.x + sorted[i]!.w) })).filter((g) => g.gap >= 0);
    if (gaps.length < 2) continue;
    // Gaps under 4px are hairlines and touching rows, drawn that way on purpose; they are not a rhythm.
    const values = [...new Set(gaps.map((g) => Math.round(g.gap * 2) / 2))].filter((v) => v >= 4);
    const count = (v: number) => gaps.filter((g) => Math.round(g.gap * 2) / 2 === v).length;
    for (const v of values) {
      const partner = values.filter((w) => w !== v && edgeSlip(v, w)).sort((x, y) => count(y) - count(x))[0];
      if (partner === undefined || count(partner) < count(v) || (count(partner) === count(v) && partner < v)) continue;
      const odd = gaps.find((g) => Math.round(g.gap * 2) / 2 === v)!;
      add({ rule: 'spacing', check: 'gap-slip', severity: 'hard', criterion: 'spacing', nodeId: odd.before.id, message: `The gap before this layer is ${fmt(v)}, and the other gaps of its stack (${parentId}) are ${fmt(partner)}. ${Math.round(Math.abs(v - partner) * 10) / 10}px is not a difference anyone means: make it ${fmt(partner)}, or a full step of the spacing scale apart if it starts a new group.` });
    }
    if (column && p.h >= board.height * 0.5) {
      const median = [...gaps.map((g) => g.gap)].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
      const band = gaps.reduce((a, b) => (b.gap > a.gap ? b : a));
      if (band.gap >= APP_LIMITS.emptyBandPx && band.gap >= APP_LIMITS.emptyBandRatio * Math.max(median, 8)) {
        add({ rule: 'platform', check: 'empty-band', severity: 'advisory', criterion: 'spacing', why: 'A hole between the content and its action reads as unfinished, and the action looks detached from what it acts on.', nodeId: band.before.id, message: `${fmt(band.gap)} of empty space between "${(band.after.text || nameOf(band.after.id)).slice(0, 30)}" and "${(band.before.text || nameOf(band.before.id)).slice(0, 30)}" (${r1(band.gap / board.height * 100)}% of the screen), where the stack's middle gap is ${fmt(median)}. Move the content down to sit above the action, centre it in the space, or fill it with the thing the screen is about.` });
      }
    }
  }

  // Paddings of a drawn box that slip, and a button label that sits off its centre.
  for (const e of live) {
    if (!e.box || e.svg || chrome.has(e.id) || !(kids.get(e.id) ?? []).length) continue;
    const [t, r, b, l] = e.pad;
    // Less padding over large display type makes up for its leading on purpose.
    const first = (kids.get(e.id) ?? []).filter((k) => !k.floating).sort((x, y) => x.y - y.y)[0];
    const optical = !!first && (first.fontSize >= APP_LIMITS.opticalPx || (kids.get(first.id) ?? []).some((k) => k.fontSize >= APP_LIMITS.opticalPx));
    const vertical = edgeSlip(t, b, APP_LIMITS.paddingSlipMax) && !optical;
    if (vertical || edgeSlip(l, r)) {
      const which = vertical ? `top ${fmt(t)} and bottom ${fmt(b)}` : `left ${fmt(l)} and right ${fmt(r)}`;
      add({ rule: 'spacing', check: 'padding-slip', severity: 'hard', criterion: 'spacing', nodeId: e.id, message: `This ${isControl(e) ? 'control' : 'box'} has padding ${which}: a slip, not a choice. Make them equal.` });
      continue;
    }
    if ((isControl(e) || e.tag === 'button') && e.h <= 72) {
      const inner = (kids.get(e.id) ?? []).filter((k) => !k.floating);
      if (!inner.length) continue;
      const top = Math.min(...inner.map((k) => k.y)) - e.y, bottom = e.y + e.h - Math.max(...inner.map((k) => k.y + k.h));
      if (Math.abs(top - bottom) > APP_LIMITS.offCentre) add({ rule: 'spacing', check: 'off-centre', severity: 'hard', criterion: 'craft', nodeId: e.id, message: `The label sits ${fmt(Math.abs(top - bottom) / 2)} off the vertical centre of this ${Math.round(e.h)}px control (${fmt(top)} above, ${fmt(bottom)} below). Centre it with align-items: center and equal padding.` });
    }
  }

  // Type on a phone: sentences under 15pt, and two sizes so close that they read as one.
  const texts = live.filter((e) => isWords(e) && !inTab.has(e.id));
  // Running text under 15, or any sentence under 13 (a footnote or a list footer at 13 is the platform's own).
  const small = texts.filter((e) => (words(e.text) >= APP_LIMITS.paragraphWords && e.fontSize < APP_LIMITS.minSentencePx - 0.25) || (words(e.text) >= APP_LIMITS.sentenceWords && e.fontSize < APP_LIMITS.minFootnotePx - 0.25));
  if (small.length) add({ rule: 'platform', check: 'sentence-size', severity: 'advisory', criterion: 'type', why: `${board.platform === 'ios' ? 'iOS body text is 17pt and callout 16pt' : 'Material body text is 14 to 16sp'}; sentences under 15 are read at arm's length with effort.`, nodeId: small[0]!.id, message: `${small.length} sentence${small.length === 1 ? ' is' : 's are'} set under ${APP_LIMITS.minSentencePx}px (${small.slice(0, 4).map((e) => `${e.id} at ${fmt(e.fontSize)}`).join(', ')}). Set running text at ${board.platform === 'ios' ? '15 to 17' : '14 to 16'}px; keep 12 and 13 for captions and footnotes.` });

  // The tab bar: a platform's own size and count.
  if (tab) {
    // Measured to the bottom of the screen, so a home indicator drawn as its own layer under the bar counts in.
    const barHeight = Math.round(board.height - tab.bar.y);
    const { items } = tab;
    if (items.length > APP_LIMITS.iosTabItemsMax) add({ rule: 'platform', check: 'tab-bar', severity: 'advisory', criterion: 'fit', why: 'Both platforms show three to five destinations in the bottom bar; more crowd the labels and the targets.', nodeId: tab.bar.id, message: `The tab bar holds ${items.length} items. Keep three to five; put the rest behind a More tab or in a screen.` });
    const want = board.platform === 'ios' ? APP_LIMITS.iosTabBar + board.homeIndicator : APP_LIMITS.androidNavBar + board.homeIndicator;
    if (Math.abs(barHeight - want) > 6) add({ rule: 'platform', check: 'tab-bar', severity: 'advisory', criterion: 'fit', why: board.platform === 'ios' ? 'An iOS tab bar is 49pt over the 34pt home indicator inset (83pt), with 10pt labels under 24 to 28pt icons; a different size reads as a web page dressed as an app.' : 'A Material navigation bar is 80dp over the gesture inset, with 12sp labels under 24dp icons.', nodeId: tab.bar.id, message: `The tab bar is ${barHeight}px tall; the platform's is ${want}px (${board.platform === 'ios' ? `${APP_LIMITS.iosTabBar} + ${board.homeIndicator}` : `${APP_LIMITS.androidNavBar} + ${board.homeIndicator}`}). The kit's Tab bar has the size built in.` });
    const content = live.filter((e) => !inTab.has(e.id) && !e.floating && (e.box || isWords(e)) && e.y < tab.bar.y && e.y + e.h > tab.bar.y - 8 && e.w < board.width * 0.98);
    const tight = content.find((e) => e.y + e.h > tab.bar.y - 8);
    if (tight && !content.some((e) => e.y + e.h > tab.bar.y + 1)) add({ rule: 'platform', check: 'tab-bar', severity: 'advisory', criterion: 'spacing', why: 'Content that touches the tab bar looks cut off rather than scrolled.', nodeId: tight.id, message: `This layer ends ${fmt(tab.bar.y - (tight.y + tight.h))} above the tab bar. Leave at least the gap of its stack, or let it run under the bar as scrolled content.` });
  }

  // No platform kit: every bar, row and control is drawn by hand.
  if (!options.hasKit) {
    add({ rule: 'platform', check: 'platform-kit', severity: 'advisory', criterion: 'fit', why: 'Hand-drawn bars, rows and buttons drift from the platform: tab bars at 77 to 98px, 22px chips, labels off centre. A kit has the sizes built in.', nodeId: board.id, message: `This ${board.platform === 'ios' ? 'iPhone' : 'Android'} screen uses no platform kit. kit_use ${board.platform === 'ios' ? 'ionic-ios' : 'material-3'} with from_brand or theme gives the status bar, navigation bar, list rows, tab bar, sheet, segmented control and buttons at the platform's sizes, in your colours and fonts; guide_get apps has the recipe.` });
  }
  const once = new Set<string>();
  return out.filter((i) => { const k = `${i.nodeId}|${i.check}|${i.message}`; if (once.has(k)) return false; once.add(k); return true; });
}

/** design_lint's app checks for every phone artboard among the checked layers. */
export async function appIssues(doc: BogenDoc, renderer: Renderer, nodes: BogenNode[], fileName?: string): Promise<{ issues: LintIssue[]; boards: string[]; exempt: Set<string> }> {
  const ids = new Set(nodes.map((n) => n.id));
  const boards = new Set<string>();
  for (const n of nodes) {
    const board = [n.id, ...doc.ancestors(n.id)].find((id) => doc.getNode(id)?.artboard);
    // Only an artboard checked as a whole: its edges and bars are about the whole screen.
    if (board && ids.has(board)) boards.add(board);
  }
  const out: LintIssue[] = [];
  const checked: string[] = [];
  const exempt = new Set<string>();
  const kits = linkedPlatformKits(doc);
  for (const id of [...boards].slice(0, 24)) {
    const first = appBoardOf(doc, id, fileName ? { fileName } : {});
    if (!first) continue;
    let probed: { board: { w: number; h: number; style: Partial<AppEl> }; els: AppEl[] };
    try { probed = await renderer.probe(doc, { nodeIds: [id] }, appProbe, { root: id }); } catch { continue; }
    const board = appBoardOf(doc, id, { ...(fileName ? { fileName } : {}), height: Math.round(probed.board.h) }) ?? first;
    const hasKit = board.platform === 'ios' ? kits.ios : kits.android;
    out.push(...appIssuesFrom(doc, { ...board, height: Math.round(probed.board.h) || board.height }, probed.els, { hasKit, boardStyle: probed.board.style }, exempt));
    checked.push(id);
  }
  return { issues: out, boards: checked, exempt };
}

/**
 * design_review's view of a phone app screen, from the layers alone: which platform it is drawn for, whether it is
 * built from that platform's kit, and how many type sizes it uses against the five an app screen needs.
 */
export function appReview(doc: BogenDoc, nodeId: string, sizes: number, fileName?: string): { aspect: string; message: string; layers: string[]; numbers?: Record<string, number> }[] | null {
  const board = appBoardOf(doc, nodeId, fileName ? { fileName } : {});
  if (!board) return null;
  const kits = linkedPlatformKits(doc);
  const hasKit = board.platform === 'ios' ? kits.ios : kits.android;
  const scope = [doc.getNode(board.id)!, ...doc.descendants(board.id)];
  const instances = scope.filter((n) => n.instanceOf !== undefined && !n.virtual).length;
  const out: { aspect: string; message: string; layers: string[]; numbers?: Record<string, number> }[] = [{
    aspect: 'platform',
    message: `A ${board.width}x${board.height} ${board.platform === 'ios' ? 'iPhone' : 'Android'} screen: status bar ${board.statusBar}px, home indicator ${board.homeIndicator}px, targets ${board.target}px. ${hasKit ? `Built with the ${board.platform === 'ios' ? 'iOS' : 'Material 3'} kit linked, ${instances} instance${instances === 1 ? '' : 's'} on it.` : `No platform kit is linked: kit_use ${board.platform === 'ios' ? 'ionic-ios' : 'material-3'} gives the bars, rows, sheets and controls at these sizes (guide_get apps).`} design_lint measures the safe areas, targets and slips on it.`,
    layers: [board.id], numbers: { instances, kit: hasKit ? 1 : 0 },
  }];
  if (sizes > 5) out.push({ aspect: 'scale', message: `${sizes} font sizes on one phone screen. Five from the platform's ramp (34, 28, 22, 17, 13 on iOS) make the levels read; merge sizes closer than 1.2 times.`, layers: [board.id], numbers: { sizes } });
  return out;
}
