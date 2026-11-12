import {
  colorsIn, normalizeColor, sanitizeSvgMarkup, svgAspect, upsertBrandItem, readBrand, type BogenDoc, type BogenNode, type BrandSection,
} from '@bogen/core';
import { parseCssVars } from './mcp/css-vars.ts';
import { resolveVars } from './brand-check.ts';
import type { Renderer, Target } from './render.ts';

/**
 * Reads what a brand already is from what exists: a file, CSS, a Tailwind config, or text. Each value carries how
 * often it was seen, and nothing here adds a value that was not in the source. The one guess is the role of a
 * colour, which is called a guess. All of it goes in as a suggestion, until someone confirms it.
 */

export interface ExtractedColor { value: string; usage: number; as: { text: number; background: number; border: number; vector: number }; role: string; name?: string; token?: string }
export interface ExtractedFamily { family: string; layers: number; characters: number; role: string; fallback?: string; weights: number[]; token?: string }
export interface ExtractedStep { size: number; layers: number; weight?: number; lineHeight?: string; tracking?: string; family?: string; name?: string; token?: string }
/** A step of a scale. `name` and `token` are there when the source names it, such as `--space-2`. */
export interface ExtractedSize { value: number; count: number; name?: string; token?: string }
export interface ExtractedLogo { node_id?: string; name: string; reason: string; svg?: string; src?: string; aspect?: number; width?: number }
export interface Extraction {
  source: string;
  colors: ExtractedColor[];
  families: ExtractedFamily[];
  typeScale: ExtractedStep[];
  spacing: ExtractedSize[];
  radius: ExtractedSize[];
  logos: ExtractedLogo[];
  shadows: number;
  gradients: number;
  notes: string[];
}

const MAX_COLORS = 16;
const MAX_STEPS = 14;
const MAX_SIZES = 14;
const MAX_LOGOS = 8;
const LOGO_WORD = /\b(logo|logotype|logomark|wordmark|brand)\b/i;
const MAX_LOGO_WIDTH = 320;

interface Seen {
  id: string; c: string; bg: string; bo: string[]; ff: string; fw: number; fs: number; lh: string; ls: string; pad: number[]; gap: number[]; rad: number[]; sh: boolean; gr: boolean; w: number; h: number; text: number; inBar: boolean;
}

/** Runs in the page, so it can only use its argument. */
function extractProbe(arg: { ids: string[] }): Seen[] {
  const wanted = new Set(arg.ids);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const hex = (css: string): string => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return '';
    const pair = (n: number) => n.toString(16).padStart(2, '0');
    return `#${pair(d[0]!)}${pair(d[1]!)}${pair(d[2]!)}`;
  };
  const px = (v: string) => Number.parseFloat(v) || 0;
  const out: Seen[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-bogen-id]')) {
    const id = el.dataset.bogenId!;
    if (!wanted.has(id)) continue;
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || !box.width || !box.height) continue;
    const own = [...el.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent?.trim() ?? '').join('');
    const st = s as unknown as Record<string, string>;
    out.push({
      id, c: own ? hex(s.color) : '', bg: hex(s.backgroundColor),
      bo: ['Top', 'Right', 'Bottom', 'Left'].flatMap((side) => (px(st[`border${side}Width`]!) > 0 && st[`border${side}Style`] !== 'none' ? [hex(st[`border${side}Color`]!)] : [])).filter(Boolean),
      ff: s.fontFamily, fw: Number(s.fontWeight) || 400, fs: px(s.fontSize), lh: s.lineHeight, ls: s.letterSpacing,
      pad: [px(s.paddingTop), px(s.paddingRight), px(s.paddingBottom), px(s.paddingLeft)], gap: s.display.includes('flex') || s.display.includes('grid') ? [px(s.rowGap), px(s.columnGap)] : [],
      rad: [px(s.borderTopLeftRadius), px(s.borderTopRightRadius), px(s.borderBottomLeftRadius), px(s.borderBottomRightRadius)],
      sh: s.boxShadow !== 'none' || s.textShadow !== 'none', gr: /gradient\(/.test(s.backgroundImage), w: box.width, h: box.height, text: own.length, inBar: Boolean(el.closest('nav,header,[role="banner"]')),
    });
  }
  return out;
}

function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function top<K>(map: Map<K, number>, n: number): [K, number][] {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** A guess, and called one: what a colour is mostly used for. */
function guessRoles(colors: ExtractedColor[]): void {
  const taken = new Set<string>();
  const pick = (role: string, list: ExtractedColor[]) => {
    const hit = list.find((c) => !taken.has(c.value));
    if (hit) {
      hit.role = role;
      taken.add(hit.value);
    }
  };
  const backgrounds = [...colors].filter((c) => c.as.background).sort((a, b) => b.as.background - a.as.background);
  const texts = [...colors].filter((c) => c.as.text).sort((a, b) => b.as.text - a.as.text);
  pick('background', backgrounds);
  pick('text', texts);
  const vivid = colors.filter((c) => !taken.has(c.value) && isVivid(c.value)).sort((a, b) => b.usage - a.usage);
  pick('primary', vivid);
  pick('accent', vivid);
  for (const c of colors) if (!c.role) c.role = c.as.background > c.as.text ? 'surface' : c.as.border > c.as.text ? 'border' : 'text';
}

function isVivid(hex: string): boolean {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) > 60;
}

/** A role the source states itself wins: `--font-display` is the display family, whatever else is guessed. */
function guessFamilyRoles(families: ExtractedFamily[], sizes: Map<string, number>, stated = new Map<string, string>()): void {
  for (const f of families) f.role = stated.get(f.family) ?? (/mono|code|consol|courier|menlo/i.test(f.family) ? 'mono' : '');
  const taken = new Set(families.map((f) => f.role));
  const proportional = families.filter((f) => !f.role);
  const body = taken.has('body') ? undefined : [...proportional].sort((a, b) => b.characters - a.characters)[0];
  if (body) body.role = 'body';
  const display = taken.has('display') ? undefined : proportional.filter((f) => f !== body).sort((a, b) => (sizes.get(b.family) ?? 0) - (sizes.get(a.family) ?? 0))[0];
  if (display) display.role = 'display';
  for (const f of families) if (!f.role) f.role = 'other';
}

/** What a variable or config key says a family is for, or nothing when it does not say. */
function familyRoleOf(name: string): string {
  const n = name.toLowerCase();
  if (/mono|code/.test(n)) return 'mono';
  if (/display|head|title|hero/.test(n)) return 'display';
  if (/body|text|base|sans|copy|prose|(^|-)ui(-|$)/.test(n)) return 'body';
  return '';
}

function logoCandidates(doc: BogenDoc, nodes: BogenNode[], seen: Map<string, Seen>): ExtractedLogo[] {
  const out: ExtractedLogo[] = [];
  const keys = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'svg' && n.type !== 'image') continue;
    const s = seen.get(n.id);
    const label = `${n.name} ${n.attrs?.alt ?? ''} ${n.attrs?.['aria-label'] ?? ''}`;
    const named = LOGO_WORD.test(label);
    const inBar = s?.inBar ?? [n.parent, ...doc.ancestors(n.id)].some((a) => /^(nav|header)$/.test(doc.getNode(a)?.tag ?? ''));
    const small = s ? s.w <= MAX_LOGO_WIDTH : true;
    if (!named && !(inBar && small)) continue;
    const svg = n.type === 'svg' && n.svg ? sanitizeSvgMarkup(n.svg) : undefined;
    const key = svg ?? n.src ?? n.id;
    if (keys.has(key)) continue;
    keys.add(key);
    const aspect = svg ? svgAspect(svg) : s && s.h ? s.w / s.h : undefined;
    out.push({
      node_id: n.id, name: n.name || 'Logo', reason: named ? 'named as a logo' : 'a small image in the top bar',
      ...(svg ? { svg } : {}), ...(n.src ? { src: n.src } : {}), ...(aspect ? { aspect } : {}), ...(s ? { width: Math.round(s.w) } : {}),
    });
    if (out.length >= MAX_LOGOS) break;
  }
  return out;
}

/** What a part of a file really uses, read from a render when one is possible and from the document otherwise. */
export async function extractFromDoc(doc: BogenDoc, renderer: Renderer, target: Target, nodes: BogenNode[], source: string): Promise<Extraction> {
  const notes: string[] = [];
  let seen: Seen[] = [];
  try {
    seen = await renderer.probe(doc, target, extractProbe, { ids: nodes.map((n) => n.id) });
  } catch (e) {
    notes.push(`Rendering failed (${(e as Error).message}), so this is only what the document declares.`);
    seen = staticSeen(doc, nodes);
  }
  const colors = new Map<string, ExtractedColor>();
  const color = (value: string, kind: keyof ExtractedColor['as'], by = 1) => {
    if (!value) return;
    const hit = colors.get(value) ?? { value, usage: 0, as: { text: 0, background: 0, border: 0, vector: 0 }, role: '' };
    hit.usage += by;
    hit.as[kind] += by;
    colors.set(value, hit);
  };
  const families = new Map<string, ExtractedFamily>();
  const sizes = new Map<number, { layers: number; weights: Map<number, number>; lh: Map<string, number>; ls: Map<string, number>; fams: Map<string, number> }>();
  const biggest = new Map<string, number>();
  const spacing = new Map<number, number>();
  const radius = new Map<number, number>();
  let shadows = 0;
  let gradients = 0;
  for (const s of seen) {
    color(s.c, 'text');
    // Colour by how much of the page it covers counts, or a full-bleed band would weigh as much as a tiny icon.
    color(s.bg, 'background', Math.max(1, Math.round((s.w * s.h) / 40_000)));
    for (const b of s.bo) color(b, 'border');
    if (s.sh) shadows++;
    if (s.gr) gradients++;
    for (const v of [...s.pad, ...s.gap]) if (v > 0) bump(spacing, Math.round(v * 2) / 2);
    for (const v of new Set(s.rad)) if (v > 0) bump(radius, Math.round(v * 2) / 2);
    if (s.text) {
      const family = firstFamily(s.ff);
      const f = families.get(family) ?? { family, layers: 0, characters: 0, role: '', weights: [] };
      f.layers++;
      f.characters += s.text;
      if (!f.weights.includes(s.fw)) f.weights.push(s.fw);
      const stack = s.ff.split(',').slice(1).join(',').trim();
      if (stack) f.fallback = stack;
      families.set(family, f);
      biggest.set(family, Math.max(biggest.get(family) ?? 0, s.fs));
      const size = Math.round(s.fs * 2) / 2;
      const step = sizes.get(size) ?? { layers: 0, weights: new Map(), lh: new Map(), ls: new Map(), fams: new Map() };
      step.layers++;
      bump(step.weights, s.fw);
      bump(step.lh, s.lh);
      bump(step.ls, s.ls);
      bump(step.fams, family);
      sizes.set(size, step);
    }
  }
  for (const n of nodes) {
    if (n.type === 'svg' && n.svg) for (const m of n.svg.replace(/<(mask|defs)\b[\s\S]*?<\/\1>/gi, '').matchAll(/\b(?:fill|stroke|stop-color)\s*[=:]\s*["']?\s*([#\w(][^"';>]*)/gi)) {
      const value = normalizeColor(m[1]!.trim());
      if (value) color(value, 'vector');
    }
  }
  const colorList = [...colors.values()].sort((a, b) => b.usage - a.usage).slice(0, MAX_COLORS);
  guessRoles(colorList);
  const familyList = [...families.values()].sort((a, b) => b.characters - a.characters);
  for (const f of familyList) f.weights.sort((a, b) => a - b);
  guessFamilyRoles(familyList, biggest);
  // The sizes used most, and not the largest: a type scale is what a page keeps coming back to.
  const stepList: ExtractedStep[] = [...sizes].sort((a, b) => b[1].layers - a[1].layers).slice(0, MAX_STEPS).sort((a, b) => b[0] - a[0]).map(([size, s]) => {
    const lh = top(s.lh, 1)[0]?.[0];
    const ls = top(s.ls, 1)[0]?.[0];
    return {
      size, layers: s.layers, weight: top(s.weights, 1)[0]?.[0],
      ...(lh && lh !== 'normal' ? { lineHeight: lh } : {}), ...(ls && ls !== 'normal' ? { tracking: ls } : {}), family: top(s.fams, 1)[0]?.[0],
    };
  });
  return {
    source, colors: colorList, families: familyList, typeScale: stepList,
    spacing: top(spacing, MAX_SIZES).map(([value, count]) => ({ value, count })).sort((a, b) => a.value - b.value),
    radius: top(radius, MAX_SIZES).map(([value, count]) => ({ value, count })).sort((a, b) => a.value - b.value),
    logos: logoCandidates(doc, nodes, new Map(seen.map((s) => [s.id, s]))), shadows, gradients, notes,
  };
}

function staticSeen(doc: BogenDoc, nodes: BogenNode[]): Seen[] {
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  const lengths = (v: string | undefined) => (v ?? '').split(/\s+/).flatMap((p) => {
    const m = /^(\d*\.?\d+)px$/.exec(p);
    return m ? [Number(m[1])] : [];
  });
  return nodes.map((n) => {
    const s = Object.fromEntries(Object.entries(n.style).map(([k, v]) => [k, resolveVars(v, tokens)]));
    return {
      id: n.id, c: n.text ? normalizeColor(s.color ?? '')?.slice(0, 7) ?? '' : '', bg: colorsIn(`${s.backgroundColor ?? ''} ${s.background ?? ''}`)[0]?.slice(0, 7) ?? '',
      bo: colorsIn(`${s.border ?? ''} ${s.borderColor ?? ''}`).map((c) => c.slice(0, 7)), ff: s.fontFamily ?? '', fw: Number(s.fontWeight) || 400, fs: Number.parseFloat(s.fontSize ?? '') || 0, lh: s.lineHeight ?? 'normal', ls: s.letterSpacing ?? 'normal',
      pad: lengths(s.padding), gap: lengths(s.gap), rad: lengths(s.borderRadius), sh: Boolean(s.boxShadow), gr: /gradient\(/.test(`${s.background ?? ''} ${s.backgroundImage ?? ''}`), w: Number.parseFloat(s.width ?? '') || 0, h: Number.parseFloat(s.height ?? '') || 0, text: n.text?.length ?? 0, inBar: false,
    };
  });
}

// ---------------------------------------------------------------- from text the agent read

const CONTEXT_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)/g;

function emptyExtraction(source: string): Extraction {
  return { source, colors: [], families: [], typeScale: [], spacing: [], radius: [], logos: [], shadows: 0, gradients: 0, notes: [] };
}

function pxLengths(value: string): number[] {
  return value.trim().split(/\s+/).flatMap((part) => {
    const m = /^(\d*\.?\d+)(px|rem)$/.exec(part);
    return m ? [m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1])] : [];
  });
}

interface FamilySeen { n: number; fallback: string; weights: Set<number>; role?: string; token?: string }
type ColorUse = keyof ExtractedColor['as'];
/** What the source calls its values: a step's variable by its value, and how each colour is used. */
interface Named { sizes?: Map<number, string>; spacing?: Map<number, string>; radius?: Map<number, string>; uses?: Map<string, ExtractedColor['as']> }

function finishCounts(out: Extraction, colors: Map<string, number>, namedColors: Map<string, string>, families: Map<string, FamilySeen>, sizes: Map<number, number>, spacing: Map<number, number>, radius: Map<number, number>, named: Named = {}): Extraction {
  out.colors = top(colors, MAX_COLORS).map(([value, usage]) => ({ value, usage, as: { text: 0, background: 0, border: 0, vector: 0, ...named.uses?.get(value) }, role: '', ...(namedColors.has(value) ? { name: namedColors.get(value)!, token: namedColors.get(value)! } : {}) }));
  for (const c of out.colors) {
    // The source's own name is the best statement of a role. Without one, how the colour is used is the only evidence.
    const most = (Object.entries(c.as) as [ColorUse, number][]).sort((a, b) => b[1] - a[1])[0]!;
    c.role = c.name ?? (most[1] > 0 && most[0] !== 'vector' ? most[0] : '');
  }
  out.families = top(new Map([...families].map(([k, v]) => [k, v.n])), 8).map(([family, n]) => {
    const f = families.get(family)!;
    return { family, layers: n, characters: 0, role: '', ...(f.fallback ? { fallback: f.fallback } : {}), weights: [...f.weights].sort((a, b) => a - b), ...(f.token ? { token: f.token } : {}) };
  });
  guessFamilyRoles(out.families, new Map(), new Map([...families].flatMap(([family, f]) => (f.role ? [[family, f.role] as [string, string]] : []))));
  const labelled = (names: Map<number, string> | undefined, value: number) => (names?.has(value) ? { name: names.get(value)!, token: names.get(value)! } : {});
  out.typeScale = top(sizes, MAX_STEPS).sort((a, b) => b[0] - a[0]).map(([size, layers]) => ({ size, layers, ...labelled(named.sizes, size) }));
  out.spacing = top(spacing, MAX_SIZES).map(([value, count]) => ({ value, count, ...labelled(named.spacing, value) })).sort((a, b) => a.value - b.value);
  out.radius = top(radius, MAX_SIZES).map(([value, count]) => ({ value, count, ...labelled(named.radius, value) })).sort((a, b) => a.value - b.value);
  return out;
}

/** Custom properties and literal values in a stylesheet, by how often they appear. */
export function extractFromCss(css: string, source = 'css'): Extraction {
  const out = emptyExtraction(source);
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const colors = new Map<string, number>();
  const named = new Map<string, string>();
  const families = new Map<string, FamilySeen>();
  const sizes = new Map<number, number>();
  const spacing = new Map<number, number>();
  const radius = new Map<number, number>();
  const vars = parseCssVars(clean);
  const tokens = new Map(vars.tokens.map((t) => [t.name, t.value]));
  const names: Required<Named> = { sizes: new Map(), spacing: new Map(), radius: new Map(), uses: new Map() };
  // A variable that holds one length names that step: `--space-2: 8px` is the 8px step, called space-2.
  const step = (map: Map<number, number>, labels: Map<number, string>, t: { name: string; value: string }) => {
    const values = pxLengths(resolveVars(t.value, tokens));
    for (const v of values) bump(map, v);
    if (values.length === 1 && !labels.has(values[0]!) && tokenFor(t.name, '') === t.name) labels.set(values[0]!, t.name);
  };
  for (const t of vars.tokens) {
    if (t.kind === 'color') {
      const value = normalizeColor(t.value);
      if (value) {
        bump(colors, value.slice(0, 7));
        if (!named.has(value.slice(0, 7))) named.set(value.slice(0, 7), t.name);
      }
    }
    if (t.kind === 'font-family') {
      const family = firstFamily(t.value);
      if (family && !/^(var|inherit|system-ui|ui-|sans-serif|serif|monospace)/.test(family)) {
        const f = families.get(family) ?? { n: 0, fallback: t.value.split(',').slice(1).join(',').trim(), weights: new Set<number>() };
        f.n++;
        // The first variable that names the family says what it is for, and is the token designs already use.
        if (!f.token && tokenFor(t.name, '') === t.name) {
          f.token = t.name;
          const role = familyRoleOf(t.name);
          if (role && ![...families.values()].some((x) => x !== f && x.role === role)) f.role = role;
        }
        families.set(family, f);
      }
    }
    if (t.kind === 'spacing') step(spacing, names.spacing, t);
    if (t.kind === 'radius') step(radius, names.radius, t);
    if (t.kind === 'font-size') step(sizes, names.sizes, t);
  }
  const use = (hex: string, kind: ColorUse) => {
    const as = names.uses.get(hex) ?? { text: 0, background: 0, border: 0, vector: 0 };
    as[kind]++;
    names.uses.set(hex, as);
  };
  for (const m of clean.matchAll(/(?:^|[;{\s])([a-zA-Z-]+)\s*:\s*([^;{}]+)/g)) {
    const prop = m[1]!.toLowerCase();
    if (prop.startsWith('--')) continue;
    const raw = m[2]!.trim();
    const value = resolveVars(raw, tokens);
    if (/^(color|background|background-color|border|border-color|border-top|border-bottom|border-left|border-right|outline|outline-color|fill|stroke)$/.test(prop)) {
      if (/gradient\(/.test(value)) out.gradients++;
      const kind: ColorUse = prop === 'color' ? 'text' : prop.startsWith('background') ? 'background' : prop === 'fill' || prop === 'stroke' ? 'vector' : 'border';
      for (const c of value.match(CONTEXT_COLOR) ?? []) {
        const hex = normalizeColor(c);
        if (hex) {
          bump(colors, hex.slice(0, 7));
          use(hex.slice(0, 7), kind);
        }
      }
    }
    if (prop === 'box-shadow' && value !== 'none') out.shadows++;
    if (prop === 'font-family' || prop === 'font') {
      const stack = prop === 'font' ? value.replace(/^.*?(?:\d+(?:\.\d+)?(?:px|rem|em|%)(?:\/[\d.]+\w*)?\s+)/, '') : value;
      const family = firstFamily(stack);
      if (family && /^[\p{L}"'][\p{L}\p{N} _.-]*$/u.test(family) && !/^(inherit|system-ui|sans-serif|serif|monospace|ui-monospace|ui-sans-serif)$/i.test(family)) {
        const f = families.get(family) ?? { n: 0, fallback: stack.split(',').slice(1).join(',').trim(), weights: new Set<number>() };
        f.n++;
        families.set(family, f);
      }
    }
    if (prop === 'font-weight') {
      const w = Number(value);
      if (w) for (const f of families.values()) f.weights.add(w);
    }
    if (prop === 'font-size') for (const v of pxLengths(value)) bump(sizes, v);
    if (/^(padding|margin|gap|row-gap|column-gap)/.test(prop)) for (const v of pxLengths(value)) if (v > 0) bump(spacing, v);
    if (prop === 'border-radius') for (const v of pxLengths(value)) if (v > 0) bump(radius, v);
  }
  if (vars.skipped.length) out.notes.push(`Variables in these blocks were left out, as they are alternatives: ${vars.skipped.map((s) => s.selector).slice(0, 8).join(', ')}.`);
  return finishCounts(out, colors, named, families, sizes, spacing, radius, names);
}

/** A Tailwind config as text: `theme.extend` and friends, without running it. Only literal values can be read this way. */
export function extractFromTailwind(config: string, source = 'tailwind'): Extraction {
  if (/@theme\b/.test(config)) return extractFromCss(config, source);
  const out = emptyExtraction(source);
  const colors = new Map<string, number>();
  const named = new Map<string, string>();
  const families = new Map<string, FamilySeen>();
  const sizes = new Map<number, number>();
  const spacing = new Map<number, number>();
  const radius = new Map<number, number>();
  const block = (key: string): string => {
    const at = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(config);
    if (!at) return '';
    let depth = 1;
    let i = at.index + at[0].length;
    const start = i;
    while (i < config.length && depth > 0) {
      if (config[i] === '{') depth++;
      if (config[i] === '}') depth--;
      i++;
    }
    return config.slice(start, i - 1);
  };
  for (const m of block('colors').matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
    const value = normalizeColor(m[2]!);
    if (value) {
      bump(colors, value.slice(0, 7));
      if (!named.has(value.slice(0, 7))) named.set(value.slice(0, 7), m[1]!);
    }
  }
  for (const m of block('fontFamily').matchAll(/['"]?([\w-]+)['"]?\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g)) {
    const names = [...m[2]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
    const family = names[0];
    if (family) {
      // The key is what the config calls it: `display: ['Fraunces']` is the display family, used as font-display.
      const role = familyRoleOf(m[1]!);
      const taken = role && [...families.values()].some((x) => x.role === role);
      families.set(firstFamily(family), { n: 1, fallback: names.slice(1).join(', '), weights: new Set(), ...(role && !taken ? { role } : {}) });
    }
  }
  for (const m of block('fontSize').matchAll(/['"]([\d.]+(?:px|rem))['"]/g)) for (const v of pxLengths(m[1]!)) bump(sizes, v);
  for (const m of block('spacing').matchAll(/['"]([\d.]+(?:px|rem))['"]/g)) for (const v of pxLengths(m[1]!)) bump(spacing, v);
  for (const m of block('borderRadius').matchAll(/['"]([\d.]+(?:px|rem))['"]/g)) for (const v of pxLengths(m[1]!)) bump(radius, v);
  if (!block('colors') && !block('fontFamily')) out.notes.push('No literal colors or fontFamily block was found in this text. A config that computes its values has to be read by you.');
  return finishCounts(out, colors, named, families, sizes, spacing, radius);
}

/** Text says too much to parse safely, so this only lifts literal colours. The agent structures the rest. */
export function extractFromText(text: string, source = 'text'): Extraction {
  const out = emptyExtraction(source);
  const colors = new Map<string, number>();
  for (const m of text.match(CONTEXT_COLOR) ?? []) {
    const hex = normalizeColor(m);
    if (hex) bump(colors, hex.slice(0, 7));
  }
  out.colors = top(colors, MAX_COLORS).map(([value, usage]) => ({ value, usage, as: { text: 0, background: 0, border: 0, vector: 0 }, role: '' }));
  out.notes.push('Only literal colours are read from text. Read the rest yourself and enter what it says with brand_update, one item per statement. Enter nothing it does not say. All of it stays a suggestion until the person confirms it.');
  return out;
}

function tokenFor(name: string, fallback: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return /^[a-z_]/.test(clean) ? clean : fallback;
}

/** Puts an extraction into a brand as suggestions, without repeating what is already there. Returns what was added. */
export function applyExtraction(doc: BogenDoc, ex: Extraction, origin: unknown): { added: Record<string, number>; ids: string[] } {
  const data = readBrand(doc);
  const added: Record<string, number> = {};
  const ids: string[] = [];
  const put = (section: BrandSection, patch: Record<string, unknown>) => {
    ids.push(upsertBrandItem(doc, section, { suggested: true, source: ex.source, ...patch }));
    added[section] = (added[section] ?? 0) + 1;
  };
  doc.transact(() => {
    for (const c of ex.colors) {
      if (data.colors.some((x) => x.value === c.value)) continue;
      const name = c.name ?? `${c.role || 'Colour'} ${c.value}`;
      put('colors', { value: c.value, name, role: c.role, token: tokenFor(c.token ?? name, `color-${c.value.slice(1)}`), usage: c.usage, note: c.role && !c.name ? 'The role is a guess from how it is used.' : undefined });
    }
    for (const f of ex.families) {
      if (data.families.some((x) => x.family.toLowerCase() === f.family.toLowerCase())) continue;
      const stated = Boolean(f.token) && familyRoleOf(f.token!) === f.role;
      put('families', { family: f.family, role: f.role, fallback: f.fallback ?? '', weights: f.weights, token: f.token ?? `font-${tokenFor(f.role || f.family, 'family')}`, note: stated ? undefined : 'The role is a guess from how it is used.' });
    }
    for (const t of ex.typeScale) {
      if (data.typeScale.some((x) => x.size === t.size)) continue;
      put('typeScale', { size: t.size, name: t.name ?? `${t.size}px`, ...(t.token ? { token: t.token } : {}), weight: t.weight ?? 0, lineHeight: t.lineHeight ?? '', tracking: t.tracking ?? '', family: t.family ?? '' });
    }
    for (const s of ex.spacing) {
      if (data.spacing.some((x) => x.value === s.value)) continue;
      put('spacing', { value: s.value, name: s.name ?? String(s.value), ...(s.token ? { token: s.token } : {}), usage: s.count });
    }
    for (const r of ex.radius) {
      if (data.radius.some((x) => x.value === r.value)) continue;
      put('radius', { value: r.value, name: r.name ?? String(r.value), ...(r.token ? { token: r.token } : {}), usage: r.count });
    }
    for (const l of ex.logos) {
      const isAsset = l.src?.startsWith('bogen-asset:');
      if (!l.svg && !isAsset) continue;
      if (data.logos.some((x) => (l.svg && x.svg === l.svg) || (isAsset && x.asset === l.src))) continue;
      // Whether a mark is drawn for light or dark cannot be read off the file with any confidence, so it is left open.
      put('logos', { name: l.name, ...(l.svg ? { svg: l.svg } : {}), ...(isAsset ? { asset: l.src } : {}), background: 'any', ...(l.aspect ? { aspect: l.aspect } : {}), minWidth: 0, clearSpace: 0, note: `A candidate: ${l.reason}. Its background, minimum size and clear space are not known yet.` });
    }
  }, origin);
  return { added, ids };
}
