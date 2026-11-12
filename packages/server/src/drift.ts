import { colorAlpha, colorDistance, confirmed, normalizeColor, type BogenDoc, type BrandData } from '@bogen/core';
import { joinShot, shootLivePage, withLivePage } from './capture.ts';
import { recordedCapture } from './capture-modes.ts';
import type { BogenServer } from './http/server.ts';
import type { Renderer } from './render.ts';
import type { Storage } from './storage.ts';

/**
 * Drift: a design compared with the live page it stands for. The live page is opened the way Capture opens it, at
 * the artboard's width and colour scheme, and compared twice: pixel by pixel, and element by element, where layers
 * are matched to live elements by their words, role and place, and what differs is listed with the CSS values of
 * both sides.
 */
export type DriftKind = 'spacing' | 'size' | 'color' | 'font' | 'text' | 'missing' | 'extra';

export interface LiveElement { selector: string; tag: string; text?: string; box: Box }
interface Box { x: number; y: number; width: number; height: number }

export interface Drift {
  kind: DriftKind;
  /** The layer in the design. None for an element only the live page has. */
  layer_id?: string;
  layer?: string;
  /** The CSS property, as CSS writes it. */
  property?: string;
  design?: string;
  live?: string;
  /** For colours and fonts of a file with a brand: whether each side is in it. */
  brand?: { design: boolean; live: boolean; live_name?: string };
  live_element?: LiveElement;
  design_box?: Box;
}

export interface DriftReport {
  node_id: string;
  url: string;
  width: number;
  color_scheme: 'light' | 'dark';
  pixels: { different_percent: number; bounds: Box | null; design_size: { width: number; height: number }; live_size: { width: number; height: number }; overlay: { url: string; src: string; width: number; height: number }; live: string };
  layers_compared: number;
  live_elements: number;
  matched: number;
  counts: Record<DriftKind, number>;
  drifts: Drift[];
  more?: number;
  notes: string[];
  at: number;
}

export interface DriftOptions {
  nodeId: string;
  url?: string;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
  allowLocal: boolean;
  brand?: BrandData | null;
  limit?: number;
}

/** What the probe reports for one element, in both pages. Boxes are relative to the root. */
interface Entry {
  k: string;
  tag: string;
  role: string;
  text: string;
  /** The words are this element's own, rather than a summary of what is inside it. */
  own: boolean;
  /** A run of text with no element of its own on the live page. */
  run?: boolean;
  /** On the live page: it has a ::before or ::after, which Capture makes a layer of its own, so its box is not the layer's. */
  ps?: boolean;
  box: [number, number, number, number];
  parent: number;
  sel?: string;
  s: Record<string, string>;
}

interface Probed { items: Entry[]; width: number; height: number; cut: boolean }

const MAX_ENTRIES = 4000;
const PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'row-gap', 'column-gap', 'border-top-width', 'border-top-style', 'border-top-color', 'border-top-left-radius', 'display'];

// A string, so that it reaches both browsers exactly as written. `design` is true on Bogen's own render, where only
// layers count and `meta` says what the document knows about each.
const PROBE = String.raw`(args) => {
  const root = args.design ? document.querySelector('[data-bogen-id="' + args.root + '"]') : document.body;
  if (!root) return { items: [], width: 0, height: 0, cut: false };
  const base = root.getBoundingClientRect();
  const items = [];
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ATOMIC = /^(img|svg|picture|video|canvas|iframe|input|select|textarea|button|object|embed)$/;
  const ROLES = { h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', a: 'link', button: 'button', img: 'image', svg: 'image', picture: 'image', video: 'image', canvas: 'image', iframe: 'image', input: 'field', textarea: 'field', select: 'field', ul: 'list', ol: 'list', li: 'item', header: 'landmark', nav: 'landmark', main: 'landmark', footer: 'landmark', aside: 'landmark', section: 'landmark', article: 'landmark', form: 'landmark', table: 'table' };
  const idOf = (el) => args.design ? el.getAttribute('data-bogen-id') : null;
  const tagOf = (el) => { const id = idOf(el); return (id && args.meta[id] && args.meta[id].tag) || el.tagName.toLowerCase(); };
  const roleOf = (el, tag) => {
    const id = idOf(el);
    if (id && args.meta[id] && args.meta[id].image) return 'image';
    const r = (el.getAttribute('role') || '').toLowerCase();
    if (r === 'heading' || r === 'button' || r === 'link') return r;
    if (r === 'img') return 'image';
    if (tag === 'input' && /^(submit|button|reset)$/i.test(el.getAttribute('type') || '')) return 'button';
    return ROLES[tag] || 'box';
  };
  const inlineText = (el, depth) => {
    if (depth > 6) return false;
    const tag = el.tagName.toLowerCase();
    if (ATOMIC.test(tag) || el instanceof SVGElement) return false;
    const id = idOf(el);
    if (id && args.meta[id] && args.meta[id].image) return false;
    const d = getComputedStyle(el).display;
    if (d !== 'inline' && d !== 'contents') return false;
    for (const c of el.children) if (!inlineText(c, depth + 1)) return false;
    return true;
  };
  const visual = (cs) => {
    if (cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    const bg = cs.backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return true;
    if (cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0) return true;
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) if (parseFloat(cs[p]) > 0) return true;
    if (/flex|grid/.test(cs.display) && (parseFloat(cs.rowGap) > 0 || parseFloat(cs.columnGap) > 0)) return true;
    return false;
  };
  const pick = (cs) => { const out = {}; for (const p of args.props) out[p] = cs.getPropertyValue(p); return out; };
  const boxOf = (r) => [Math.round((r.left - base.left) * 10) / 10, Math.round((r.top - base.top) * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const selectorOf = (el) => {
    const parts = [];
    for (let cur = el, n = 0; cur && cur !== document.documentElement && n < 4; cur = cur.parentElement, n++) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + esc(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const classes = [...cur.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 40).slice(0, 2);
      if (classes.length) part += '.' + classes.map(esc).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1 && !classes.length) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      if (cur === document.body) break;
    }
    return parts.join(' > ');
  };
  let cut = false;
  const walk = (el, parent, inBlock) => {
    if (items.length >= args.limit) { cut = true; return; }
    const tag = el.tagName.toLowerCase();
    if (/^(script|style|noscript|template|head|meta|link|title|base)$/.test(tag)) return;
    if (args.design && el !== root && !idOf(el)) {
      // Markup inside a layer, such as the runs of a text or the drawing of a vector, belongs to that layer.
      return;
    }
    // A ::before or ::after that Capture made a layer has no element on the live page to match.
    if (args.design && el !== root && args.meta[idOf(el)] && args.meta[idOf(el)].pseudo) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    // Not painted, such as the inside of a closed details. An element with display: contents has no box of its own.
    if (cs.display !== 'contents' && el.checkVisibility && !el.checkVisibility()) return;
    const r = el.getBoundingClientRect();
    let me = parent;
    if (el !== root && !inBlock) {
      const role = roleOf(el, tagOf(el));
      const image = role === 'image';
      // innerText is what shows: not the inside of a closed details, not what CSS hides.
      const text = image ? '' : norm(el instanceof HTMLElement ? el.innerText : el.textContent).slice(0, 300);
      const block = !image && text !== '' && [...el.children].every((c) => inlineText(c, 0));
      const own = block && !ATOMIC.test(tag);
      const shown = cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      const wanted = shown && (role !== 'box' || own || visual(cs));
      if (wanted) {
        const id = idOf(el);
        const alt = image ? norm((id && args.meta[id] && args.meta[id].alt) || el.getAttribute('alt') || el.getAttribute('aria-label') || '') : '';
        const ps = !args.design && ['::before', '::after'].some((p) => !/^(none|normal)$/.test(getComputedStyle(el, p).content));
        items.push({ k: id || String(items.length), tag: tagOf(el), role, text: image ? alt : text, own: image ? Boolean(alt) : own || (role === 'button' || role === 'link' || role === 'heading') && text !== '' && [...el.children].every((c) => inlineText(c, 0)), box: boxOf(r), parent, ...(args.design ? {} : { sel: selectorOf(el) }), ...(ps ? { ps: true } : {}), s: pick(cs) });
        me = items.length - 1;
      }
      if (image || block) return;
      // Words straight inside a box that also holds blocks have no element on the live page; Capture makes them a layer.
      if (!args.design && !/^(svg)$/.test(tag)) {
        for (const n of el.childNodes) {
          if (n.nodeType !== 3 || !norm(n.data)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const rr = range.getBoundingClientRect();
          if (!rr.width || !rr.height) continue;
          items.push({ k: String(items.length), tag: '#text', role: 'box', text: norm(n.data).slice(0, 300), own: true, run: true, box: boxOf(rr), parent: me, sel: selectorOf(el), s: pick(cs) });
        }
      }
    }
    if (el instanceof SVGElement) return;
    for (const c of el.children) walk(c, me, false);
  };
  walk(root, -1, false);
  return { items, width: Math.round(base.width), height: Math.round(Math.max(base.height, args.design ? 0 : document.documentElement.scrollHeight)), cut };
}`;

const roleGroup = (e: Entry) => (e.run ? 'text' : e.own && e.role === 'box' ? 'text' : e.role);

function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Dice coefficient over words, so that one changed number in a sentence still matches it. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return (2 * both) / (a.size + b.size);
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = x * y;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Pairs design entries with live ones. Each pass goes through the design in document order, so a parent is matched
 * before its children, and a child is then looked for where its parent went: a banner added above everything moves
 * the whole page, not each element on its own.
 */
export function matchEntries(design: Entry[], live: Entry[]): Int32Array {
  const dl = new Int32Array(design.length).fill(-1);
  const ld = new Int32Array(live.length).fill(-1);
  const dWords = design.map((e) => words(e.text));
  const lWords = live.map((e) => words(e.text));
  const shift = (i: number): [number, number, number] => {
    for (let p = design[i]!.parent; p >= 0; p = design[p]!.parent) {
      const m = dl[p]!;
      if (m >= 0) return [live[m]!.box[0] - design[p]!.box[0], live[m]!.box[1] - design[p]!.box[1], m];
    }
    return [0, 0, -1];
  };
  const under = (l: number, ancestor: number) => {
    if (ancestor < 0) return true;
    for (let p = live[l]!.parent; p >= 0; p = live[p]!.parent) if (p === ancestor) return true;
    return false;
  };
  const distance = (i: number, l: number, s: [number, number, number]) => {
    const a = design[i]!.box;
    const b = live[l]!.box;
    return Math.hypot(a[0] + a[2] / 2 + s[0] - (b[0] + b[2] / 2), a[1] + a[3] / 2 + s[1] - (b[1] + b[3] / 2));
  };
  const pair = (i: number, l: number) => {
    dl[i] = l;
    ld[l] = i;
  };
  const byRole = new Map<string, number[]>();
  live.forEach((e, l) => {
    const key = roleGroup(e);
    const list = byRole.get(key) ?? [];
    list.push(l);
    byRole.set(key, list);
  });
  const exact = new Map<string, number[]>();
  live.forEach((e, l) => {
    if (!e.text) return;
    const key = `${roleGroup(e)}|${e.role === 'box' && !e.own ? e.tag : ''}|${e.text}`;
    const list = exact.get(key) ?? [];
    list.push(l);
    exact.set(key, list);
  });

  // Same role and the same words.
  design.forEach((e, i) => {
    if (!e.text) return;
    const list = exact.get(`${roleGroup(e)}|${e.role === 'box' && !e.own ? e.tag : ''}|${e.text}`);
    if (!list) return;
    const s = shift(i);
    let best = -1;
    let bestScore = Infinity;
    for (const l of list) {
      if (ld[l]! >= 0) continue;
      const score = distance(i, l, s) + (under(l, s[2]) ? 0 : 400);
      if (score < bestScore) {
        best = l;
        bestScore = score;
      }
    }
    if (best >= 0 && (bestScore < 1200 || list.length === 1)) pair(i, best);
  });

  // Same role and mostly the same words: a changed price, a reworded heading.
  design.forEach((e, i) => {
    if (dl[i]! >= 0 || !e.text) return;
    const s = shift(i);
    let best = -1;
    let bestScore = 0;
    for (const l of byRole.get(roleGroup(e)) ?? []) {
      if (ld[l]! >= 0 || !live[l]!.text) continue;
      const sim = similarity(dWords[i]!, lWords[l]!);
      if (sim < 0.5) continue;
      const d = distance(i, l, s);
      if (d > 900) continue;
      const score = sim * 0.7 + 0.3 * Math.max(0, 1 - d / 900) + (under(l, s[2]) ? 0.1 : 0);
      if (score > bestScore) {
        best = l;
        bestScore = score;
      }
    }
    if (best >= 0) pair(i, best);
  });

  // Same role in the same place: images, fields, boxes whose contents changed.
  design.forEach((e, i) => {
    if (dl[i]! >= 0) return;
    const s = shift(i);
    const moved: [number, number, number, number] = [e.box[0] + s[0], e.box[1] + s[1], e.box[2], e.box[3]];
    let best = -1;
    let bestScore = 0;
    for (const l of byRole.get(roleGroup(e)) ?? []) {
      if (ld[l]! >= 0) continue;
      if (e.role === 'box' && live[l]!.tag !== e.tag && e.text && live[l]!.text) continue;
      const overlap = iou(moved, live[l]!.box);
      const inside = under(l, s[2]) && s[2] >= 0;
      if (overlap < (inside ? 0.3 : 0.5)) continue;
      const score = overlap + (inside ? 0.2 : 0);
      if (score > bestScore) {
        best = l;
        bestScore = score;
      }
    }
    if (best >= 0) pair(i, best);
  });
  return dl;
}

const firstFamily = (value: string) => (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();

function colorOf(value: string | undefined): string | null {
  if (!value) return null;
  const hex = normalizeColor(value);
  if (!hex) return null;
  return colorAlpha(value) <= 0.01 ? null : hex;
}

const hexOf = (value: string) => normalizeColor(value) ?? value;

function sameLength(a: string | undefined, b: string | undefined, tolerance = 0.5): boolean {
  if (a === b) return true;
  if (!a || !b || !/\d/.test(a) || !/\d/.test(b)) return a === b;
  return Math.abs(px(a) - px(b)) <= tolerance;
}

function brandColor(data: BrandData | null | undefined): ((hex: string) => string | null) | null {
  if (!data?.colors.length) return null;
  const colors = data.colors.flatMap((c) => [c, ...Object.values(c.modes ?? {}).map((value) => ({ ...c, value }))]);
  return (hex: string) => {
    let best: { name: string; d: number } | null = null;
    for (const c of colors) {
      const d = colorDistance(c.value, hex.slice(0, 7));
      if (!best || d < best.d) best = { name: c.name, d };
    }
    return best && best.d <= 2.5 ? best.name : null;
  };
}

function brandFamilies(data: BrandData | null | undefined): Set<string> | null {
  const list = data ? (confirmed(data.families).length ? confirmed(data.families) : data.families) : [];
  return list.length ? new Set(list.map((f) => f.family.toLowerCase())) : null;
}

const SPACING = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'];

/** The differences between a design entry and the live element it stands for. */
function compare(d: Entry, l: Entry, brand: BrandData | null | undefined): Omit<Drift, 'layer_id' | 'layer' | 'live_element' | 'design_box'>[] {
  const out: Omit<Drift, 'layer_id' | 'layer' | 'live_element' | 'design_box'>[] = [];
  const onBrand = brandColor(brand);
  const families = brandFamilies(brand);
  const color = (property: string, a: string | undefined, b: string | undefined) => {
    const x = colorOf(a);
    const y = colorOf(b);
    if (!x && !y) return;
    if (x && y && colorDistance(x, y) <= 2 && Math.abs(colorAlpha(a!) - colorAlpha(b!)) < 0.05) return;
    const live = y ? hexOf(b!) : 'transparent';
    const named = y && onBrand ? onBrand(y) : null;
    out.push({ kind: 'color', property, design: x ? hexOf(a!) : 'transparent', live, ...(onBrand ? { brand: { design: x ? Boolean(onBrand(x)) : true, live: y ? Boolean(named) : true, ...(named ? { live_name: named } : {}) } } : {}) });
  };
  if (d.own && l.own && d.role !== 'image') {
    if (d.text !== l.text) out.push({ kind: 'text', design: d.text, live: l.text });
    const fa = firstFamily(d.s['font-family'] ?? '');
    const fb = firstFamily(l.s['font-family'] ?? '');
    if (fa && fb && fa !== fb) out.push({ kind: 'font', property: 'font-family', design: d.s['font-family']!, live: l.s['font-family']!, ...(families ? { brand: { design: families.has(fa), live: families.has(fb) } } : {}) });
    for (const p of ['font-size', 'line-height', 'letter-spacing']) {
      if (sameLength(d.s[p], l.s[p])) continue;
      // A line height that keeps its ratio to a changed size is that size changing, not a second drift.
      if (p === 'line-height' && Math.abs(px(d.s[p]) / (px(d.s['font-size']) || 1) - px(l.s[p]) / (px(l.s['font-size']) || 1)) < 0.01) continue;
      out.push({ kind: 'font', property: p, design: d.s[p]!, live: l.s[p]! });
    }
    if (d.s['font-weight'] !== l.s['font-weight']) out.push({ kind: 'font', property: 'font-weight', design: d.s['font-weight']!, live: l.s['font-weight']! });
    color('color', d.s.color, l.s.color);
  }
  if (d.run || l.run) return out;
  color('background-color', d.s['background-color'], l.s['background-color']);
  const borderA = d.s['border-top-style'] !== 'none' && px(d.s['border-top-width']) > 0;
  const borderB = l.s['border-top-style'] !== 'none' && px(l.s['border-top-width']) > 0;
  if (borderA || borderB) {
    if (!sameLength(borderA ? d.s['border-top-width'] : '0px', borderB ? l.s['border-top-width'] : '0px')) out.push({ kind: 'size', property: 'border-width', design: borderA ? d.s['border-top-width']! : '0px', live: borderB ? l.s['border-top-width']! : '0px' });
    else color('border-color', d.s['border-top-color'], l.s['border-top-color']);
  }
  if (!sameLength(d.s['border-top-left-radius'], l.s['border-top-left-radius'])) out.push({ kind: 'size', property: 'border-radius', design: d.s['border-top-left-radius']!, live: l.s['border-top-left-radius']! });
  for (const p of SPACING) if (!sameLength(d.s[p], l.s[p], 1)) out.push({ kind: 'spacing', property: p, design: d.s[p]!, live: l.s[p]! });
  const layout = (e: Entry) => /flex|grid/.test(e.s.display ?? '');
  if (layout(d) && layout(l)) {
    for (const p of ['row-gap', 'column-gap']) if (!sameLength(d.s[p] === 'normal' ? '0px' : d.s[p], l.s[p] === 'normal' ? '0px' : l.s[p], 1)) out.push({ kind: 'spacing', property: p === 'row-gap' ? 'row-gap' : 'column-gap', design: d.s[p]!, live: l.s[p]! });
  }
  return out;
}

const box = (b: [number, number, number, number]): Box => ({ x: b[0], y: b[1], width: b[2], height: b[3] });
const liveOf = (l: Entry): LiveElement => ({ selector: l.sel ?? l.tag, tag: l.run ? 'text' : l.tag, ...(l.text ? { text: l.text.slice(0, 120) } : {}), box: box(l.box) });

/** Every drift between two probed pages. Sizes that the drifts inside an element explain are left out. */
export function diffEntries(doc: BogenDoc, design: Entry[], live: Entry[], brand?: BrandData | null): { drifts: Drift[]; matched: number } {
  const dl = matchEntries(design, live);
  const matchedLive = new Set<number>();
  dl.forEach((l) => { if (l >= 0) matchedLive.add(l); });
  const name = (e: Entry) => doc.getNode(e.k)?.name ?? e.tag;
  const perEntry: Drift[][] = design.map(() => []);
  // Whether anything inside a design entry already drifts, so its own size change follows from that.
  const explained = new Uint8Array(design.length);
  const mark = (i: number) => {
    for (let p = design[i]!.parent; p >= 0 && !explained[p]; p = design[p]!.parent) explained[p] = 1;
  };

  design.forEach((d, i) => {
    const l = dl[i]!;
    if (l < 0) {
      const parent = d.parent;
      // Only the outermost of what is missing: its children went with it.
      if (parent < 0 || dl[parent]! >= 0) perEntry[i]!.push({ kind: 'missing', layer_id: d.k, layer: name(d), design_box: box(d.box) });
      mark(i);
      return;
    }
    const found = compare(d, live[l]!, brand);
    if (found.length) mark(i);
    perEntry[i]!.push(...found.map((f) => ({ ...f, layer_id: d.k, layer: name(d), live_element: liveOf(live[l]!), design_box: box(d.box) })));
  });

  const extra: Drift[] = [];
  live.forEach((l, i) => {
    if (matchedLive.has(i)) return;
    const parent = l.parent;
    if (parent >= 0 && !matchedLive.has(parent)) return;
    const owner = parent >= 0 ? dl.indexOf(parent) : -1;
    if (owner >= 0) {
      explained[owner] = 1;
      mark(owner);
    }
    extra.push({ kind: 'extra', live_element: liveOf(l), ...(owner >= 0 ? { layer_id: design[owner]!.k, layer: name(design[owner]!) } : {}) });
  });

  // Parents come first, so a box whose parent changed its layout or size is known to follow it.
  const resized = new Uint8Array(design.length);
  design.forEach((d, i) => {
    const l = dl[i]!;
    if (l < 0) return;
    if (live[l]!.ps) return;
    const b = live[l]!.box;
    const changed = (['width', 'height'] as const).filter((_, n) => Math.abs(d.box[2 + n]! - b[2 + n]!) > Math.max(1.5, d.box[2 + n]! * 0.01));
    if (!changed.length) return;
    resized[i] = 1;
    const p = d.parent;
    const follows = p >= 0 && (resized[p] || perEntry[p]!.some((x) => x.kind === 'spacing'));
    if (follows || explained[i] || perEntry[i]!.some((x) => x.kind === 'text' || x.kind === 'font' || x.kind === 'spacing')) return;
    for (const property of changed) {
      const n = property === 'width' ? 2 : 3;
      perEntry[i]!.push({ kind: 'size', property, design: `${d.box[n]}px`, live: `${b[n]}px`, layer_id: d.k, layer: name(d), live_element: liveOf(live[l]!), design_box: box(d.box) });
    }
  });

  const drifts = [...perEntry.flat(), ...extra].sort((a, b) => (a.design_box?.y ?? a.live_element?.box.y ?? 0) - (b.design_box?.y ?? b.live_element?.box.y ?? 0));
  return { drifts, matched: matchedLive.size };
}

const ALL_KINDS: DriftKind[] = ['spacing', 'size', 'color', 'font', 'text', 'missing', 'extra'];

function artboardOf(doc: BogenDoc, nodeId: string): string {
  const node = doc.getNode(nodeId);
  if (!node) throw new Error(`No layer with id ${nodeId}. Call layer_tree to see what exists.`);
  const page = doc.pageOf(nodeId);
  const top = [nodeId, ...doc.ancestors(nodeId)].find((id) => doc.getNode(id)?.parent === page);
  return top ?? nodeId;
}

/** What a drift check of this layer would use, without running it: for the editor's form. */
export function driftDefaults(doc: BogenDoc, nodeId: string): { node_id: string; name: string; url: string | null; width: number | null; color_scheme: 'light' | 'dark' } {
  const id = artboardOf(doc, nodeId);
  const node = doc.getNode(id)!;
  const record = recordedCapture(doc, id);
  const width = /^\d+(\.\d+)?px$/.test(node.style.width ?? '') ? Math.round(px(node.style.width)) : null;
  const mode = node.mode === 'light' || node.mode === 'dark' ? node.mode : undefined;
  return { node_id: id, name: node.name, url: record?.url ?? null, width, color_scheme: (record?.colorScheme === 'light' || record?.colorScheme === 'dark' ? record.colorScheme : mode) ?? 'dark' };
}

// As tall as a render goes. Scaled pictures differ at every edge, so a page is compared at full size while it can be.
const DIFF_RENDER_DIMENSION = 24_000;

/** Compares an artboard with the live page. Reads the document only: the pictures go to the asset store. */
export async function driftCheck(renderer: Renderer, storage: Storage, doc: BogenDoc, options: DriftOptions): Promise<{ report: DriftReport; picture: Uint8Array }> {
  const defaults = driftDefaults(doc, options.nodeId);
  const nodeId = defaults.node_id;
  const url = options.url ?? defaults.url;
  if (!url) throw new Error('This artboard was not captured from a page, so give the address to compare with.');
  const notes: string[] = [];
  const layout = defaults.width ? null : (await renderer.layout(doc, { nodeIds: [nodeId] }, [nodeId]))[0];
  const width = options.width ?? defaults.width ?? Math.round(layout?.width ?? 1440);
  const colorScheme = options.colorScheme ?? defaults.color_scheme;
  const meta: Record<string, { tag?: string; image?: boolean; alt?: string; pseudo?: boolean }> = {};
  for (const n of [doc.getNode(nodeId)!, ...doc.descendants(nodeId)]) {
    const image = n.type === 'image' || n.type === 'svg' || n.type === 'video' || n.type === 'embed';
    meta[n.id] = { tag: n.type === 'svg' ? 'svg' : n.tag, ...(image ? { image: true, ...(n.attrs?.alt ? { alt: n.attrs.alt } : {}) } : {}), ...(n.style.content ? { pseudo: true } : {}) };
  }
  const limit = MAX_ENTRIES;
  const designArgs = JSON.stringify({ design: true, root: nodeId, meta, props: PROPS, limit });
  const designProbe = await renderer.probeScript<Probed>(doc, { nodeIds: [nodeId] }, `(${PROBE})(${designArgs})`);
  const designShot = await renderer.screenshot(doc, { nodeIds: [nodeId] }, { format: 'png', scale: 1, maxDimension: DIFF_RENDER_DIMENSION });
  if (designShot.scale < 1) notes.push(`The artboard is taller than ${DIFF_RENDER_DIMENSION}px, so the pixel comparison is scaled.`);

  const live = await withLivePage(renderer, { url, width, height: options.height ?? 900, colorScheme, allowLocal: options.allowLocal }, async ({ page, status }) => {
    if (status && status >= 400) notes.push(`The page answered with status ${status}.`);
    // The artboard is the body, so a page shorter than the window ends where the body does.
    const bottom = await page.evaluate('Math.ceil(document.body.getBoundingClientRect().bottom + scrollY)') as number;
    const full = await page.evaluate('document.documentElement.scrollHeight') as number;
    const end = bottom > 0 && bottom < full ? bottom : full;
    const height = Math.min(end, DIFF_RENDER_DIMENSION);
    if (height < end) notes.push(`The live page is ${end}px tall; its pixels are compared down to ${height}px.`);
    const tiles = await shootLivePage(page, width, height);
    const probed = await page.evaluate(`(${PROBE})(${JSON.stringify({ design: false, meta: {}, props: PROPS, limit })})`) as Probed;
    return { tiles, height, probed };
  });
  const liveShot = await joinShot(renderer, live.tiles, width, live.height);
  if (designProbe.cut || live.probed.cut) notes.push(`Only the first ${limit} elements of each side were compared.`);

  // A tall artboard renders scaled, so the live page is compared at the same scale.
  const scale = designShot.scale;
  const diff = await renderer.compareImages({ bytes: designShot.bytes, mime: 'image/png' }, { bytes: liveShot, mime: 'image/png' }, { threshold: 0.1, fit: false, maxDimension: 2000, maxBytes: 2_500_000, overlay: true, scaleB: scale });
  const unscaled = (n: number) => Math.round(n / scale);
  const overlay = await storage.putAsset(diff.overlayPng ?? diff.png, 'image/png');
  const liveAsset = await storage.putAsset(liveShot, 'image/png');
  const { drifts, matched } = diffEntries(doc, designProbe.items, live.probed.items, options.brand);
  const counts = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<DriftKind, number>;
  for (const d of drifts) counts[d.kind]++;
  const max = options.limit ?? 200;
  const report: DriftReport = {
    node_id: nodeId, url, width, color_scheme: colorScheme,
    pixels: {
      different_percent: diff.total ? Math.round((diff.different / diff.total) * 10000) / 100 : 0,
      bounds: diff.bounds && { x: unscaled(diff.bounds.x), y: unscaled(diff.bounds.y), width: unscaled(diff.bounds.width), height: unscaled(diff.bounds.height) },
      design_size: { width: unscaled(diff.sizeA.width), height: unscaled(diff.sizeA.height) }, live_size: diff.sizeB,
      overlay: { url: overlay.url, src: overlay.src, width: Math.max(unscaled(diff.sizeA.width), diff.sizeB.width), height: Math.max(unscaled(diff.sizeA.height), diff.sizeB.height) },
      live: liveAsset.url,
    },
    layers_compared: designProbe.items.length, live_elements: live.probed.items.length, matched,
    counts, drifts: drifts.slice(0, max), ...(drifts.length > max ? { more: drifts.length - max } : {}), notes, at: Date.now(),
  };
  // The faded design with the differences in red, for an agent to look at.
  return { report, picture: diff.png };
}

/** A drift check of a layer in a file, against the file's brand if it has one. */
export async function driftOfFile(app: BogenServer, fileId: string, options: Omit<DriftOptions, 'brand'>): Promise<{ report: DriftReport; picture: Uint8Array }> {
  const room = await app.rooms.get(fileId);
  const brand = await app.brands.forRoom(room);
  return driftCheck(app.renderer, app.storage, room.doc, { ...options, brand: brand?.data ?? null });
}
