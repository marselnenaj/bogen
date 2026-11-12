import { colorsIn, contrastRatio, fileKeyframes, normalizeColor, parseBlock, parseTransitions, type BogenDoc, type BogenNode } from '@bogen/core';
import type { Renderer, Target } from './render.ts';

/**
 * A page-level accessibility audit: heading order, landmarks, focusable elements without a name, alt text, link text
 * that says nothing on its own, target sizes, focus that stays visible, and motion for people who asked for less.
 * Names, sizes and colours come from a render; focus and motion come from the layer's styles and its `:focus-visible`
 * and `@media (prefers-reduced-motion)` blocks, which a render without focus or with motion allowed does not show.
 * Each issue names its layer and its success criterion, and fixes that change nothing for anyone who did not ask for
 * them, a focus ring that shows only on keyboard focus or motion stopped only for reduced motion, are safe.
 */

export type A11yRule = 'heading-order' | 'landmarks' | 'name' | 'alt' | 'link-text' | 'target-size' | 'focus-visible' | 'reduced-motion';
export const A11Y_RULES: readonly A11yRule[] = ['heading-order', 'landmarks', 'name', 'alt', 'link-text', 'target-size', 'focus-visible', 'reduced-motion'];

export interface A11yFix {
  description: string;
  /** Safe fixes change nothing for someone who did not ask for them; `a11y_audit` with fix applies only these. */
  safe: boolean;
  style?: Record<string, string | null>;
  /** The block the style goes in, such as `:focus-visible`. */
  block?: string;
  attrs?: Record<string, string | null>;
  tag?: string;
}

export interface A11yIssue {
  rule: A11yRule;
  severity: 'error' | 'warning';
  node_id: string;
  layer: string;
  message: string;
  /** The WCAG 2.2 success criterion, such as `1.1.1 Non-text Content`. */
  wcag: string;
  fix?: A11yFix;
}

export interface A11yReport {
  ok: boolean;
  counts: Record<A11yRule, number>;
  /** Issues grouped per layer, the worst first. */
  layers: { node_id: string; layer: string; issues: A11yIssue[] }[];
  checked: { boards: number; layers: number; headings: number; focusable: number; images: number; moving: number };
  not_checked: string[];
}

interface Probed {
  id: string; tag: string; role: string; level: number; focusable: boolean; name: string; nameFrom: string; text: string;
  x: number; y: number; w: number; h: number; inline: boolean; href: string | null; alt: string | null; image: boolean;
  color: string; bg: string; outside: string | null; landmark: string;
}

/** Runs in the page, so it can only use its argument. */
function probe(arg: { ids: string[] }): Probed[] {
  const wanted = new Set(arg.ids);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string): number[] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
  };
  const hex = (c: number[]) => `#${c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
  const over = (top: number[], bottom: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
  const backdrop = (el: Element | null): number[] | null => {
    const layers: number[][] = [];
    for (let cur = el; cur; cur = cur.parentElement) {
      const s = getComputedStyle(cur);
      if (s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (c[3]! > 0) {
        layers.push(c);
        if (c[3]! >= 1) break;
      }
    }
    let base = [255, 255, 255, 1];
    for (const l of layers.reverse()) base = over(l, base);
    return base;
  };
  const FOCUSABLE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
  const ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|option|slider|textbox|combobox)$/;
  const textOf = (el: Element): string => {
    let out = '';
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out += c.textContent ?? '';
      else if (c instanceof Element) {
        if (c.getAttribute('aria-hidden') === 'true') continue;
        if (c.tagName === 'IMG') out += ` ${c.getAttribute('alt') ?? ''} `;
        else if (c.getAttribute('aria-label')) out += ` ${c.getAttribute('aria-label')} `;
        else if (c.tagName.toLowerCase() === 'svg') out += ` ${c.querySelector('title')?.textContent ?? ''} `;
        else out += ` ${textOf(c)} `;
      }
    }
    for (const p of ['::before', '::after']) {
      const m = /^"((?:\\.|[^"])*)"$/.exec(getComputedStyle(el, p).content ?? '');
      if (m) out = p === '::before' ? `${m[1]} ${out}` : `${out} ${m[1]}`;
    }
    return out.replace(/\s+/g, ' ').trim();
  };
  const out: Probed[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-bogen-id]')) {
    const id = el.dataset.bogenId!;
    if (!wanted.has(id)) continue;
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') ?? '';
    const focusable = (FOCUSABLE.test(el.tagName) && !(el.tagName === 'A' && !el.hasAttribute('href')) && !(el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden')) || ROLES.test(role);
    let name = '';
    let nameFrom = '';
    const label = el.getAttribute('aria-label')?.trim();
    if (label) [name, nameFrom] = [label, 'aria-label'];
    else if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const wrapping = el.closest('label');
      const text = wrapping ? textOf(wrapping) : '';
      if (text) [name, nameFrom] = [text, 'label'];
      else if (el.getAttribute('title')) [name, nameFrom] = [el.getAttribute('title')!, 'title'];
      else if (el.getAttribute('placeholder')) [name, nameFrom] = [el.getAttribute('placeholder')!, 'placeholder'];
      else if (el.tagName === 'INPUT' && /^(submit|button|reset)$/.test((el as HTMLInputElement).type)) [name, nameFrom] = [(el as HTMLInputElement).value || '', 'value'];
    } else if (el.tagName === 'IMG') [name, nameFrom] = [el.getAttribute('alt') ?? '', 'alt'];
    else {
      const text = textOf(el);
      if (text) [name, nameFrom] = [text, 'content'];
      else if (el.getAttribute('title')) [name, nameFrom] = [el.getAttribute('title')!, 'title'];
    }
    const heading = /^h([1-6])$/.exec(tag);
    const back = backdrop(el);
    const outside = backdrop(el.parentElement);
    const landmark = role || ({ main: 'main', nav: 'navigation', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', search: 'search' } as Record<string, string>)[tag] || (tag === 'section' && el.getAttribute('aria-label') ? 'region' : '');
    out.push({
      id, tag, role, level: heading ? Number(heading[1]) : role === 'heading' ? Number(el.getAttribute('aria-level') ?? 2) : 0, focusable, name: name.slice(0, 200), nameFrom, text: textOf(el).slice(0, 200),
      x: box.left, y: box.top, w: box.width, h: box.height, inline: s.display === 'inline', href: el.getAttribute('href'), alt: el.getAttribute('alt'), image: el.tagName === 'IMG' || role === 'img',
      color: hex(rgba(s.color)), bg: back ? hex(back) : '', outside: outside ? hex(outside) : null, landmark,
    });
  }
  return out;
}

/** Link text that says nothing out of context, in English and German. */
const VAGUE_LINKS = new Set(['click here', 'here', 'click', 'read more', 'more', 'learn more', 'see more', 'more info', 'more information', 'details', 'link', 'this', 'this link', 'go', 'continue',
  'hier', 'hier klicken', 'klicken sie hier', 'klick hier', 'mehr', 'mehr erfahren', 'weiterlesen', 'weiter', 'mehr lesen', 'details ansehen', 'link', 'dieser link']);
const FILE_NAME = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?)$|^(?:img|image|dsc|pxl|photo|screenshot|bildschirmfoto)[-_ ]?\d/i;
const ALT_PREFIX = /^(?:an? )?(?:image|picture|photo|photograph|graphic|icon) of\s+|^(?:ein )?(?:bild|foto|grafik|abbildung|symbol) (?:von|vom|der|des)\s+/i;
const MIN_TARGET = 24;
const MOTION_PROPS = /\b(?:all|transform|translate|scale|rotate|left|top|right|bottom|margin|inset|width|height|offset)/;

/**
 * WCAG 2.5.8's spacing exception: a target under 24px still passes when a circle of 24px around its centre touches no
 * other target, and no such circle of another small target.
 */
function crowded(p: Probed, all: Probed[]): boolean {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const r = MIN_TARGET / 2;
  for (const o of all) {
    if (o === p || !o.focusable || o.inline || !o.w || !o.h) continue;
    if (o.x <= p.x && o.y <= p.y && o.x + o.w >= p.x + p.w && o.y + o.h >= p.y + p.h) continue;
    if (p.x <= o.x && p.y <= o.y && p.x + p.w >= o.x + o.w && p.y + p.h >= o.y + o.h) continue;
    const nx = Math.max(o.x, Math.min(cx, o.x + o.w));
    const ny = Math.max(o.y, Math.min(cy, o.y + o.h));
    if (Math.hypot(cx - nx, cy - ny) < r) return true;
    if ((o.w < MIN_TARGET || o.h < MIN_TARGET) && Math.hypot(cx - (o.x + o.w / 2), cy - (o.y + o.h / 2)) < MIN_TARGET) return true;
  }
  return false;
}

function outlineGone(style: Record<string, string> | undefined): boolean {
  if (!style) return false;
  const o = (style.outline ?? '').trim().toLowerCase();
  return o === 'none' || o === '0' || /^0(?:px)?\b/.test(o) || /\bnone\b/.test(o) || (style.outlineStyle ?? '').trim() === 'none' || /^0(?:px)?$/.test((style.outlineWidth ?? '').trim());
}

/** What a focus block shows: an outline with a width, a ring as a shadow, or a change of border or background. */
function indicator(style: Record<string, string> | undefined, tokens: Map<string, string>): { shows: boolean; outlineColor?: string; width?: number } {
  if (!style) return { shows: false };
  const resolve = (v: string) => v.replace(/var\(\s*--([\w-]+)[^)]*\)/g, (_, n: string) => tokens.get(n) ?? '');
  const o = resolve(style.outline ?? '');
  const width = Number(/(\d*\.?\d+)px/.exec(o)?.[1] ?? /(\d*\.?\d+)px/.exec(style.outlineWidth ?? '')?.[1] ?? (o && !outlineGone(style) ? 1 : 0));
  const outlineColor = colorsIn(resolve(`${o} ${style.outlineColor ?? ''}`))[0];
  const ring = Boolean(style.boxShadow && style.boxShadow.trim() !== 'none');
  const change = Boolean(style.border || style.borderColor || style.background || style.backgroundColor || style.textDecoration);
  return { shows: (width > 0 && !outlineGone(style)) || ring || change, ...(outlineColor ? { outlineColor } : {}), ...(width ? { width } : {}) };
}

function blockKeys(node: BogenNode, test: (key: string) => boolean): string[] {
  return Object.keys(node.rules ?? {}).filter((k) => {
    const b = parseBlock(k);
    return b !== null && test(k);
  });
}

/** Audits a page or a layer. */
export async function auditA11y(doc: BogenDoc, renderer: Renderer, scope: { nodeId: string } | { pageId: string }): Promise<A11yReport> {
  const nodes = 'nodeId' in scope ? [doc.getNode(scope.nodeId)!, ...doc.descendants(scope.nodeId)] : doc.descendants(scope.pageId);
  const own = nodes.filter((n) => n && !n.hidden && !n.virtual);
  const target: Target = 'nodeId' in scope ? { nodeIds: [scope.nodeId] } : { pageId: scope.pageId };
  const probed = own.length ? await renderer.probe(doc, target, probe, { ids: own.map((n) => n.id) }) : [];
  const seen = new Map(probed.map((p) => [p.id, p]));
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  const keyframes = fileKeyframes(doc);
  const issues: A11yIssue[] = [];
  const nameOf = (id: string) => doc.getNode(id)?.name ?? '';
  const add = (id: string, issue: Omit<A11yIssue, 'node_id' | 'layer'>) => issues.push({ node_id: id, layer: nameOf(id), ...issue });
  const notChecked: string[] = [];

  // Boards: each top-level layer stands for a page.
  const boardOf = (id: string): string => {
    const up = doc.ancestors(id);
    const page = doc.pageOf(id);
    const chain = [id, ...up].filter((a) => a !== page && doc.getNode(a));
    return chain.at(-1) ?? id;
  };
  const boards = new Map<string, Probed[]>();
  for (const n of own) {
    const p = seen.get(n.id);
    if (!p) continue;
    const b = boardOf(n.id);
    boards.set(b, [...(boards.get(b) ?? []), p]);
  }

  let headingCount = 0;
  for (const [board, list] of boards) {
    // Headings in document order: one h1, and no level skipped on the way down.
    const headings = list.filter((p) => p.level > 0 && p.text);
    headingCount += headings.length;
    const h1s = headings.filter((h) => h.level === 1);
    if (headings.length && !h1s.length) add(headings[0]!.id, { rule: 'heading-order', severity: 'warning', wcag: '1.3.1 Info and Relationships', message: `This board has headings but no h1. The first heading, "${headings[0]!.text.slice(0, 50)}", is an h${headings[0]!.level}.`, fix: { description: 'Make the main heading of the page an h1.', safe: false, tag: 'h1' } });
    for (const extra of h1s.slice(1)) add(extra.id, { rule: 'heading-order', severity: 'warning', wcag: '1.3.1 Info and Relationships', message: `A second h1, "${extra.text.slice(0, 50)}". A page has one h1, its main heading.`, fix: { description: 'Make it an h2.', safe: false, tag: 'h2' } });
    let prev = 0;
    for (const h of headings) {
      if (prev && h.level > prev + 1) add(h.id, { rule: 'heading-order', severity: 'error', wcag: '1.3.1 Info and Relationships', message: `"${h.text.slice(0, 50)}" is an h${h.level} after an h${prev}: level ${prev + 1} is skipped, so a screen reader's outline has a gap.`, fix: { description: `Make it an h${prev + 1}, and set its size with a style rather than with the level.`, safe: false, tag: `h${prev + 1}` } });
      prev = h.level;
    }

    // Landmarks: one main, named when there are several of a kind, and the content inside them.
    const node = doc.getNode(board);
    const pageLike = list.length >= 8 && list.some((p) => p.level > 0);
    // A board made with artboard_create is a main itself; a page captured into it brings its own main as well.
    const boardIsMain = list.find((p) => p.id === board)?.landmark === 'main';
    const inner = list.filter((p) => p.landmark === 'main' && p.id !== board);
    if (boardIsMain && inner.length) add(board, { rule: 'landmarks', severity: 'error', wcag: '1.3.1 Info and Relationships', message: `The board is a main element, and it holds another main, "${nameOf(inner[0]!.id).slice(0, 40)}". A page has one main.`, fix: { description: 'Make the board a div, and keep the main inside. It looks the same.', safe: true, tag: 'div' } });
    const mains = boardIsMain && inner.length ? inner : list.filter((p) => p.landmark === 'main');
    if (pageLike && !mains.length) {
      const plain = node && ['div', 'section'].includes(node.tag) && node.type === 'frame';
      add(board, { rule: 'landmarks', severity: 'error', wcag: '1.3.1 Info and Relationships', message: 'This page has no main landmark, so a screen reader cannot jump to its content.', fix: plain ? { description: 'Make the board a main element. It looks the same.', safe: true, tag: 'main' } : { description: 'Wrap the content in a main element.', safe: false } });
    }
    for (const extra of mains.slice(1)) add(extra.id, { rule: 'landmarks', severity: 'error', wcag: '1.3.1 Info and Relationships', message: 'A second main landmark. A page has one.', fix: { description: 'Make it a section, or the board a div.', safe: false, tag: 'section' } });
    const navs = list.filter((p) => p.landmark === 'navigation');
    if (navs.length > 1) {
      for (const nav of navs) {
        if (!doc.getNode(nav.id)?.attrs?.['aria-label']) add(nav.id, { rule: 'landmarks', severity: 'warning', wcag: '1.3.1 Info and Relationships', message: `One of ${navs.length} navigation landmarks without a name, so they cannot be told apart.`, fix: { description: 'Name it with aria-label, such as "Main" or "Footer".', safe: false, attrs: { 'aria-label': 'Name it' } } });
      }
    }

    // Names, link text, alt text, target sizes and focus, per element.
    for (const p of list) {
      const n = doc.getNode(p.id)!;
      if (p.focusable) {
        const what = p.tag === 'a' ? 'link' : /^(input|select|textarea)$/.test(p.tag) ? 'field' : p.tag === 'summary' ? 'disclosure' : p.role || p.tag;
        if (!p.name.trim()) {
          const icon = doc.descendants(p.id).find((c) => c.type === 'svg' || c.type === 'image');
          const guess = icon?.name.replace(/^(?:icon|logo|image)\s*[:/-]?\s*/i, '').trim();
          add(p.id, { rule: 'name', severity: 'error', wcag: p.tag === 'a' ? '2.4.4 Link Purpose' : '4.1.2 Name, Role, Value', message: `This ${what} has no name: a screen reader says only "${p.tag === 'a' ? 'link' : what}".`, fix: { description: guess ? `Name it with aria-label, such as "${guess}".` : 'Give it words, or name it with aria-label.', safe: false, ...(guess ? { attrs: { 'aria-label': guess } } : {}) } });
        } else if (p.nameFrom === 'placeholder') {
          add(p.id, { rule: 'name', severity: 'warning', wcag: '3.3.2 Labels or Instructions', message: `This field is named only by its placeholder "${p.name.slice(0, 40)}", which disappears as soon as someone types.`, fix: { description: 'Put a visible label around it, or name it with aria-label.', safe: true, attrs: { 'aria-label': p.name } } });
        }
        if (p.tag === 'a' && VAGUE_LINKS.has(p.name.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim())) {
          add(p.id, { rule: 'link-text', severity: 'warning', wcag: '2.4.4 Link Purpose', message: `The link says "${p.name}", which says nothing out of context: a list of links read aloud is a list of "${p.name}".`, fix: { description: 'Say where it goes, such as "Read the pricing" or "Download the guide (PDF)".', safe: false } });
        }
        // Hidden until focused, as a skip link is, it is no target for a pointer; and a small target with room around it passes.
        const hiddenAway = p.w <= 2 && p.h <= 2;
        if (!p.inline && !hiddenAway && p.w && p.h && (p.w < MIN_TARGET || p.h < MIN_TARGET) && crowded(p, list)) {
          add(p.id, { rule: 'target-size', severity: 'error', wcag: '2.5.8 Target Size (Minimum)', message: `This ${what} is ${Math.round(p.w)}x${Math.round(p.h)}px, under ${MIN_TARGET}x${MIN_TARGET}px that people can reliably hit.`, fix: { description: `Make it at least ${MIN_TARGET}px each way, with padding so that it looks the same size.`, safe: false, style: { minWidth: `${MIN_TARGET}px`, minHeight: `${MIN_TARGET}px` } } });
        }
        // Focus: removed without a replacement, or a ring that does not stand out from what is around it.
        const focusBlocks = blockKeys(n, (k) => /(?:^|\s):focus(?:-visible)?$/.test(k));
        const shown = focusBlocks.map((k) => ({ key: k, ...indicator(n.rules?.[k], tokens) }));
        const removed = outlineGone(n.style) || focusBlocks.some((k) => outlineGone(n.rules?.[k]) && !indicator(n.rules?.[k], tokens).shows);
        const ringColor = [p.color, p.bg].find((c) => c && p.outside && contrastRatio(c, p.outside) >= 3) ?? (p.outside && contrastRatio('#000000', p.outside) >= contrastRatio('#ffffff', p.outside) ? '#000000' : '#ffffff');
        const ringFix: A11yFix = { description: `Add a :focus-visible ring that shows only on keyboard focus: outline 2px solid ${ringColor}, offset 2px.`, safe: true, block: ':focus-visible', style: { outline: `2px solid ${ringColor}`, outlineOffset: '2px' } };
        if (removed && !shown.some((b) => b.shows)) {
          add(p.id, { rule: 'focus-visible', severity: 'error', wcag: '2.4.7 Focus Visible', message: `This ${what} removes its focus outline and shows nothing in its place, so a keyboard user cannot see where they are.`, fix: ringFix });
        } else {
          const visible = shown.find((b) => b.key.endsWith(':focus-visible') && b.shows);
          if (visible?.outlineColor && p.outside) {
            const ratio = contrastRatio(normalizeColor(visible.outlineColor)?.slice(0, 7) ?? visible.outlineColor, p.outside);
            if (ratio < 3) add(p.id, { rule: 'focus-visible', severity: 'warning', wcag: '1.4.11 Non-text Contrast', message: `The focus ring in ${visible.key} has a contrast of ${ratio}:1 against what is around it, under 3:1.`, fix: { ...ringFix, description: `Use ${ringColor} for the ring in :focus-visible, which reaches ${contrastRatio(ringColor, p.outside)}:1.`, style: { outlineColor: ringColor } } });
          }
          if (visible?.width !== undefined && visible.width > 0 && visible.width < 2) add(p.id, { rule: 'focus-visible', severity: 'warning', wcag: '2.4.13 Focus Appearance', message: `The focus ring in ${visible.key} is ${visible.width}px wide; 2px is easier to see.`, fix: { description: 'Make the ring 2px wide.', safe: true, block: visible.key, style: { outlineWidth: '2px' } } });
        }
      }
      // Alt as the document holds it: a render writes alt="" for a missing one, which would hide the difference.
      const alt = n.type === 'image' ? (n.attrs?.alt ?? null) : null;
      if (n.type === 'image') {
        if (alt === null) add(p.id, { rule: 'alt', severity: 'error', wcag: '1.1.1 Non-text Content', message: 'This image has no alt text, so a screen reader reads its file name or nothing.', fix: { description: 'Say what it shows in alt, or set alt="" if it is decorative.', safe: false } });
        else if (FILE_NAME.test(alt.trim())) add(p.id, { rule: 'alt', severity: 'error', wcag: '1.1.1 Non-text Content', message: `The alt text "${alt}" is a file name.`, fix: { description: 'Say what the image shows, or set alt="" if it is decorative.', safe: false } });
        else if (ALT_PREFIX.test(alt.trim())) {
          const rest = alt.trim().replace(ALT_PREFIX, '');
          add(p.id, { rule: 'alt', severity: 'warning', wcag: '1.1.1 Non-text Content', message: `The alt text starts with "${alt.trim().slice(0, alt.trim().length - rest.length).trim()}"; a screen reader already says it is an image.`, fix: { description: `Say "${rest[0]?.toUpperCase() ?? ''}${rest.slice(1)}".`, safe: true, attrs: { alt: `${rest[0]?.toUpperCase() ?? ''}${rest.slice(1)}` } } });
        } else if (alt.length > 250) add(p.id, { rule: 'alt', severity: 'warning', wcag: '1.1.1 Non-text Content', message: `The alt text is ${alt.length} characters. Keep it to what the image adds, and put a long description in the page.`, fix: { description: 'Shorten it to a sentence or two.', safe: false } });
      }
    }
  }
  if (!probed.length && own.length) notChecked.push('Nothing rendered, so names, sizes and colours were not measured.');

  // Motion, from the styles: what moves, and whether it stops for people who asked for reduced motion.
  let moving = 0;
  for (const n of own) {
    const reduce = blockKeys(n, (k) => /prefers-reduced-motion:\s*reduce/.test(k));
    const stopped = reduce.some((k) => /none/.test(`${n.rules?.[k]?.animation ?? ''}${n.rules?.[k]?.animationName ?? ''}${n.rules?.[k]?.transition ?? ''}`));
    const style = n.style;
    const animated = (style.animation || style.animationName) && !/^none$/.test((style.animationName ?? style.animation ?? '').trim());
    let moves = false;
    const what: string[] = [];
    if (animated) {
      const names = `${style.animationName ?? style.animation ?? ''}`.split(',').map((a) => a.trim().split(/\s+/).find((w) => keyframes.has(w))).filter(Boolean) as string[];
      // A fade moves nothing; keyframes that change place, size or rotation do.
      const motion = names.length ? names.some((name) => keyframes.get(name)!.stops.some((s) => MOTION_PROPS.test(s.css))) : true;
      if (motion) {
        moves = true;
        what.push(`the animation ${names.join(', ') || style.animation}`);
      }
    }
    const transitions = parseTransitions(style).filter((t) => t.duration > 0 && MOTION_PROPS.test(t.property));
    if (transitions.length) {
      moves = true;
      what.push(`a transition of ${transitions.map((t) => t.property).join(', ')}`);
    }
    if (!moves) continue;
    moving++;
    if (stopped) continue;
    const fix: Record<string, string> = {};
    if (animated) fix.animation = 'none';
    if (transitions.length) fix.transition = 'none';
    add(n.id, { rule: 'reduced-motion', severity: 'warning', wcag: '2.3.3 Animation from Interactions', message: `This layer moves (${what.join(' and ')}) and has no @media (prefers-reduced-motion: reduce) block, so it moves for people who asked their system for less motion.`, fix: { description: 'Add a @media (prefers-reduced-motion: reduce) block that stops it. Nothing changes for anyone else.', safe: true, block: '@media (prefers-reduced-motion: reduce)', style: fix } });
  }

  const order = (i: A11yIssue) => (i.severity === 'error' ? 0 : 1);
  const byLayer = new Map<string, A11yIssue[]>();
  for (const i of [...issues].sort((a, b) => order(a) - order(b))) byLayer.set(i.node_id, [...(byLayer.get(i.node_id) ?? []), i]);
  const counts = Object.fromEntries(A11Y_RULES.map((r) => [r, issues.filter((i) => i.rule === r).length])) as Record<A11yRule, number>;
  return {
    ok: !issues.some((i) => i.severity === 'error'), counts,
    layers: [...byLayer].map(([id, list]) => ({ node_id: id, layer: nameOf(id), issues: list })).sort((a, b) => order(a.issues[0]!) - order(b.issues[0]!) || b.issues.length - a.issues.length),
    checked: { boards: boards.size, layers: probed.length, headings: headingCount, focusable: probed.filter((p) => p.focusable).length, images: probed.filter((p) => doc.getNode(p.id)?.type === 'image').length, moving },
    not_checked: [...notChecked, 'Reading order follows the layers; a layout that moves things around visually is not compared with it.', 'Colour contrast of text is in design_lint and brand_check.'],
  };
}

/** Puts the safe fixes in, in one transaction. Locked layers are left alone. */
export function applyA11yFixes(doc: BogenDoc, issues: A11yIssue[], origin: unknown): { node_id: string; rule: A11yRule; what: string }[] {
  const done: { node_id: string; rule: A11yRule; what: string }[] = [];
  const taken = new Set<string>();
  doc.transact(() => {
    for (const i of issues) {
      const fix = i.fix;
      if (!fix?.safe || !doc.rawNode(i.node_id)) continue;
      if ([i.node_id, ...doc.ancestors(i.node_id)].some((a) => doc.getNode(a)?.locked)) continue;
      const key = `${i.node_id}|${fix.block ?? ''}|${Object.keys(fix.style ?? {}).join()}|${Object.keys(fix.attrs ?? {}).join()}|${fix.tag ?? ''}`;
      if (taken.has(key)) continue;
      taken.add(key);
      if (fix.style && fix.block) doc.updateRules(i.node_id, fix.block, fix.style);
      else if (fix.style) doc.updateStyle(i.node_id, fix.style);
      if (fix.attrs) {
        const attrs: Record<string, string> = { ...(doc.getNode(i.node_id)!.attrs ?? {}) };
        for (const [k, v] of Object.entries(fix.attrs)) {
          if (v === null) delete attrs[k];
          else attrs[k] = v;
        }
        doc.updateFields(i.node_id, { attrs });
      }
      if (fix.tag) doc.updateFields(i.node_id, { tag: fix.tag });
      done.push({ node_id: i.node_id, rule: i.rule, what: fix.description });
    }
  }, origin);
  return done;
}
