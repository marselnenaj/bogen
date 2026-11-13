import type { BogenDoc } from '@bogen/core';
import type { Page } from 'puppeteer-core';
import type { Renderer, Target } from './render.ts';
import type { Storage } from './storage.ts';

/**
 * Slides as a PowerPoint file, with PptxGenJS (MIT). Each slide artboard is rendered, and every layer is read back with
 * its measured box and computed style: text becomes an editable text box with its runs (font, size, weight, colour),
 * a picture from Bogen's assets is placed as itself, and a frame with a plain fill, border and radius is a native
 * rectangle. What PowerPoint cannot hold (vectors, gradients, shadows, filters, transforms, shaders, video, code
 * components) is rendered alone and placed as a picture, and the report names each of those layers and why.
 */

const PX_PER_IN = 96;
const PT_PER_PX = 0.75;
const MAX_SLIDES = 200;
const PICTURE_SCALE = 2;
const NATIVE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif']);

export interface PptxReport { native: number; pictures: { id: string; name: string; reason: string }[]; notes: string[]; slides: number }

interface Run { text: string; font: string; size: number; weight: number; italic: boolean; color: string; alpha: number; underline: boolean; strike: boolean; breakBefore: boolean }
interface Probe {
  id: string;
  tag: string;
  x: number; y: number; w: number; h: number;
  hidden: boolean;
  opacity: number;
  /** Why this layer cannot be native, when it cannot. */
  complex: string | null;
  /** Whether its own box paints something (fill, border, a pseudo-element). */
  paints: boolean;
  fill: string | null; fillAlpha: number;
  border: { width: number; color: string; alpha: number; dashed: boolean } | null;
  /** Borders on some sides only, each drawn as a line. */
  sides: { side: 'top' | 'right' | 'bottom' | 'left'; width: number; color: string; alpha: number; dashed: boolean }[];
  radius: number;
  src: string | null;
  fit: string;
  text: { runs: Run[]; align: string; lineHeight: number | null; letterSpacing: number; padding: [number, number, number, number]; lines: number } | null;
  clipped: boolean;
}

/** Runs in the page: every layer of the root, in paint order, with what the export needs of it. */
function probeInPage(args: { root: string; types: Record<string, string> }): Probe[] {
  const root = document.querySelector(`[data-bogen-id="${CSS.escape(args.root)}"]`) as HTMLElement | null;
  if (!root) return [];
  const origin = root.getBoundingClientRect();
  const parse = (c: string): { hex: string; alpha: number } | null => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(c);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    const hex = [m[1], m[2], m[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('');
    return { hex, alpha: a };
  };
  const out: Probe[] = [];
  const els = [root, ...root.querySelectorAll<HTMLElement>('[data-bogen-id]')];
  for (const el of els) {
    const id = el.getAttribute('data-bogen-id')!;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const type = args.types[id] ?? (el.tagName === 'IMG' ? 'image' : el.tagName.toLowerCase() === 'svg' ? 'svg' : el.tagName === 'VIDEO' ? 'video' : el.tagName === 'IFRAME' ? 'embed' : 'frame');
    const hidden = cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || r.width < 0.5 || r.height < 0.5;
    const reasons: string[] = [];
    if (cs.transform !== 'none') reasons.push('a transform');
    if (cs.filter !== 'none' || cs.backdropFilter !== 'none' && cs.backdropFilter) reasons.push('a filter');
    if (cs.boxShadow !== 'none') reasons.push('a shadow');
    if (cs.backgroundImage !== 'none') reasons.push(/gradient/.test(cs.backgroundImage) ? 'a gradient' : 'a background picture');
    if (cs.clipPath !== 'none' || (cs.maskImage && cs.maskImage !== 'none')) reasons.push('a clip or mask');
    if (cs.mixBlendMode !== 'normal') reasons.push('a blend mode');
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(el, pseudo);
      if (p.content && p.content !== 'none' && p.content !== 'normal') reasons.push(`a ${pseudo} element`);
    }
    if (type === 'svg') reasons.push('a vector');
    if (type === 'shader') reasons.push('a shader');
    if (type === 'video') reasons.push('a video');
    if (type === 'embed' || el.tagName === 'IFRAME') reasons.push('an embed or code component');
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({ w: Number.parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0, style: cs.getPropertyValue(`border-${s.toLowerCase()}-style`), color: cs.getPropertyValue(`border-${s.toLowerCase()}-color`) }));
    const live = sides.filter((s) => s.w > 0 && s.style !== 'none' && s.style !== 'hidden');
    let border: Probe['border'] = null;
    const lines: Probe['sides'] = [];
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => Number.parseFloat(v) || 0);
    if (radii.some((v) => v !== radii[0]) || [cs.borderTopLeftRadius].some((v) => /%|\s/.test(v) && !/^50%$/.test(v))) reasons.push('corners of different radii');
    if (live.length) {
      const same = live.length === 4 && live.every((s) => s.w === live[0]!.w && s.color === live[0]!.color && s.style === live[0]!.style);
      const c = parse(live[0]!.color);
      const plain = live.every((s) => /solid|dashed|dotted/.test(s.style) && parse(s.color));
      if (same && c && plain) border = { width: live[0]!.w, color: c.hex, alpha: c.alpha, dashed: live[0]!.style !== 'solid' };
      else if (plain && radii.every((v) => v < 0.5)) {
        sides.forEach((s, k) => {
          const sc = parse(s.color);
          if (s.w > 0 && s.style !== 'none' && s.style !== 'hidden' && sc) lines.push({ side: (['top', 'right', 'bottom', 'left'] as const)[k]!, width: s.w, color: sc.hex, alpha: sc.alpha, dashed: s.style !== 'solid' });
        });
      } else reasons.push('a border PowerPoint cannot draw');
    }
    const fill = parse(cs.backgroundColor);
    const paintsFill = Boolean(fill && fill.alpha > 0);
    let text: Probe['text'] = null;
    if (type === 'text') {
      const runs: Run[] = [];
      let lastBlock: Element | null = null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      let breakNext = false;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeType === Node.ELEMENT_NODE) {
          if ((n as Element).tagName === 'BR') breakNext = true;
          continue;
        }
        const value = n.nodeValue ?? '';
        if (!value) continue;
        const parent = n.parentElement!;
        const ps = getComputedStyle(parent);
        if (ps.backgroundImage !== 'none' && /text/.test(ps.backgroundClip ?? '')) reasons.push('text filled with a gradient');
        if (ps.textShadow !== 'none') reasons.push('a text shadow');
        const c = parse(ps.color) ?? { hex: '000000', alpha: 1 };
        const block = parent.closest('p, div, li, h1, h2, h3, h4, h5, h6');
        const breakBefore = breakNext || (runs.length > 0 && block !== lastBlock && block !== el);
        breakNext = false;
        lastBlock = block;
        let t = value;
        if (!/pre/.test(ps.whiteSpace)) t = t.replace(/\s+/g, ' ');
        if (ps.textTransform === 'uppercase') t = t.toUpperCase();
        else if (ps.textTransform === 'lowercase') t = t.toLowerCase();
        runs.push({ text: t, font: ps.fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, ''), size: Number.parseFloat(ps.fontSize) || 16, weight: Number(ps.fontWeight) || 400, italic: ps.fontStyle !== 'normal', color: c.hex, alpha: c.alpha, underline: /underline/.test(ps.textDecorationLine), strike: /line-through/.test(ps.textDecorationLine), breakBefore });
      }
      if (runs.length) {
        runs[0]!.text = runs[0]!.text.replace(/^\s+/, '');
        runs[runs.length - 1]!.text = runs[runs.length - 1]!.text.replace(/\s+$/, '');
      }
      const lh = Number.parseFloat(cs.lineHeight);
      const lineHeight = Number.isFinite(lh) ? lh : null;
      const pad = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => Number.parseFloat(v) || 0) as [number, number, number, number];
      const inner = r.height - pad[0] - pad[2];
      const align = /center/.test(cs.textAlign) ? 'center' : /right|end/.test(cs.textAlign) ? 'right' : /justify/.test(cs.textAlign) ? 'justify' : 'left';
      text = { runs, align, lineHeight, letterSpacing: Number.parseFloat(cs.letterSpacing) || 0, padding: pad, lines: Math.max(1, Math.round(inner / (lineHeight ?? (Number.parseFloat(cs.fontSize) || 16) * 1.2))) };
    }
    const parentClip = el.parentElement?.closest('[data-bogen-id]') as HTMLElement | null;
    let clipped = false;
    if (parentClip && el !== root) {
      const ps = getComputedStyle(parentClip);
      if (ps.overflow !== 'visible') {
        const pr = parentClip.getBoundingClientRect();
        clipped = r.left < pr.left - 1 || r.top < pr.top - 1 || r.right > pr.right + 1 || r.bottom > pr.bottom + 1;
      }
    }
    out.push({
      id, tag: el.tagName.toLowerCase(), x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height, hidden, opacity: Number(cs.opacity),
      complex: reasons.length ? [...new Set(reasons)].join(', ') : null,
      paints: paintsFill || Boolean(border) || lines.length > 0 || reasons.some((x) => /::|shadow|gradient|background picture|border/.test(x)),
      fill: paintsFill ? fill!.hex : null, fillAlpha: fill?.alpha ?? 0, border, sides: lines, radius: /^50%$/.test(cs.borderTopLeftRadius) ? Math.min(r.width, r.height) / 2 : radii[0]!,
      src: type === 'image' ? (el as HTMLImageElement).currentSrc || el.getAttribute('src') : null, fit: cs.objectFit, text, clipped,
    });
  }
  return out;
}

/** Renders one layer alone into a PNG: with or without what is inside it, everything else hidden. */
async function shot(page: Page, id: string, box: { x: number; y: number; w: number; h: number }, origin: { x: number; y: number }, withChildren: boolean, margin: number): Promise<Uint8Array> {
  await page.evaluate((target: string, inner: boolean) => {
    document.documentElement.classList.add('pptx-shot');
    const el = document.querySelector(`[data-bogen-id="${CSS.escape(target)}"]`)!;
    el.classList.add(inner ? 'pptx-target-all' : 'pptx-target');
  }, id, withChildren);
  try {
    return await page.screenshot({ type: 'png', omitBackground: true, clip: { x: origin.x + box.x - margin, y: origin.y + box.y - margin, width: box.w + margin * 2, height: box.h + margin * 2, scale: PICTURE_SCALE }, captureBeyondViewport: true });
  } finally {
    await page.evaluate((target: string) => {
      document.documentElement.classList.remove('pptx-shot');
      document.querySelector(`[data-bogen-id="${CSS.escape(target)}"]`)?.classList.remove('pptx-target', 'pptx-target-all');
    }, id);
  }
}

const SHOT_CSS = `html.pptx-shot, html.pptx-shot body { background: transparent !important; }
html.pptx-shot [data-bogen-id] { visibility: hidden !important; }
html.pptx-shot .pptx-target, html.pptx-shot .pptx-target-all, html.pptx-shot .pptx-target-all * { visibility: visible !important; }
html.pptx-shot .pptx-target, html.pptx-shot .pptx-target * { color: transparent !important; text-shadow: none !important; }`;

const px2in = (v: number) => Math.round((v / PX_PER_IN) * 10000) / 10000;

/** The artboards a pptx export makes slides of: the layers given, or the page's boards in reading order. */
export function slideRoots(doc: BogenDoc, target: Target): string[] {
  if (target.nodeIds?.length) return target.nodeIds;
  const pageId = target.pageId ?? doc.getPages()[0]?.id ?? '';
  const n = (v: string | undefined) => Number.parseFloat(v ?? '') || 0;
  const boards = doc.getChildren(pageId).filter((c) => !c.hidden && (c.artboard || c.type === 'frame'));
  return boards.sort((a, b) => (Math.abs(n(a.style.top) - n(b.style.top)) > 40 ? n(a.style.top) - n(b.style.top) : n(a.style.left) - n(b.style.left))).map((c) => c.id);
}

export async function exportPptx(doc: BogenDoc, renderer: Renderer, storage: Storage, target: Target, title: string): Promise<{ bytes: Uint8Array; report: PptxReport }> {
  const roots = slideRoots(doc, target).slice(0, MAX_SLIDES);
  if (!roots.length) throw new Error('The page is empty, so there is nothing to export.');
  for (const id of roots) if (!doc.getNode(id)) throw new Error(`No layer with id ${id}.`);
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.title = title;
  pptx.company = '';
  const report: PptxReport = { native: 0, pictures: [], notes: [], slides: roots.length };
  const types: Record<string, string> = {};
  for (const id of roots) for (const n of [doc.getNode(id)!, ...doc.descendants(id)]) types[n.id] = n.type;
  const nameOf = (id: string) => doc.getNode(id)?.name ?? id;
  let size: { w: number; h: number } | null = null;
  let clippedCount = 0;
  let unsupported = 0;
  for (const root of roots) {
    await renderer.withLivePage(doc, { nodeIds: [root] }, async (page, _browser, rect) => {
      await page.addStyleTag({ content: SHOT_CSS });
      const probes = await page.evaluate(probeInPage, { root, types });
      const board = probes[0];
      if (!board) return;
      if (!size) {
        size = { w: board.w, h: board.h };
        pptx.defineLayout({ name: 'BOGEN', width: px2in(board.w), height: px2in(board.h) });
        pptx.layout = 'BOGEN';
      } else if (Math.abs(size.w - board.w) > 1 || Math.abs(size.h - board.h) > 1) report.notes.push(`"${nameOf(root)}" is ${Math.round(board.w)} x ${Math.round(board.h)}, and the slides are ${Math.round(size.w)} x ${Math.round(size.h)}: it was scaled to fit.`);
      const k = Math.min(size.w / board.w, size.h / board.h);
      const dx = (size.w - board.w * k) / 2, dy = (size.h - board.h * k) / 2;
      const pos = (p: { x: number; y: number; w: number; h: number }) => ({ x: px2in(dx + p.x * k), y: px2in(dy + p.y * k), w: px2in(p.w * k), h: px2in(p.h * k) });
      const slide = pptx.addSlide();
      const origin = { x: rect.x, y: rect.y };
      const skip = new Set<string>();
      const inside = new Map<string, string[]>();
      for (const p of probes) {
        const el = p.id;
        const parent = doc.getNode(el)?.parent;
        if (parent) inside.set(parent, [...(inside.get(parent) ?? []), el]);
      }
      const skipTree = (id: string) => {
        skip.add(id);
        for (const c of inside.get(id) ?? []) skipTree(c);
      };
      const picture = async (p: Probe, withChildren: boolean, reason: string) => {
        const margin = /shadow|filter/.test(reason) ? 48 : 1;
        const png = await shot(page, p.id, p, origin, withChildren, margin);
        slide.addImage({ data: `image/png;base64,${Buffer.from(png).toString('base64')}`, ...pos({ x: p.x - margin, y: p.y - margin, w: p.w + margin * 2, h: p.h + margin * 2 }) });
        report.pictures.push({ id: p.id, name: nameOf(p.id), reason });
      };
      for (const p of probes) {
        if (skip.has(p.id)) continue;
        if (p.hidden) {
          skipTree(p.id);
          continue;
        }
        if (p.clipped) clippedCount++;
        const isRoot = p.id === root;
        const type = types[p.id] ?? 'frame';
        const leaf = type === 'svg' || type === 'shader' || type === 'video' || type === 'embed' || p.tag === 'iframe' || p.tag === 'canvas';
        if (leaf) {
          skipTree(p.id);
          await picture(p, true, p.complex ?? 'a vector');
          continue;
        }
        if (p.opacity < 1 && !isRoot && (inside.get(p.id)?.length ?? 0) > 0) {
          // A see-through group has no form in PowerPoint: the whole group is one picture.
          skipTree(p.id);
          await picture(p, true, 'a see-through group');
          continue;
        }
        if (type === 'image') {
          const asset = p.src && /\/assets\/([\w.-]+)$/.exec(p.src)?.[1];
          const stored = asset ? await storage.readAsset(asset) : null;
          if (stored && NATIVE_IMAGES.has(stored.mime) && !p.complex && p.radius < 0.5 && !p.border && p.opacity >= 1) {
            const box = pos(p);
            slide.addImage({ data: `${stored.mime};base64,${Buffer.from(stored.bytes).toString('base64')}`, ...box, ...(p.fit === 'cover' || p.fit === 'contain' ? { sizing: { type: p.fit, w: box.w, h: box.h } } : {}) });
            report.native++;
          } else if (p.src || p.complex) await picture(p, true, p.complex ?? (stored ? `a ${stored.mime.split('/')[1]} picture, which PowerPoint does not take, or one with rounded corners or a border` : 'a picture from outside Bogen'));
          else unsupported++;
          continue;
        }
        // Text that PowerPoint cannot set is one picture, its box with it.
        if (type === 'text' && p.complex && /text shadow|text filled|transform|filter|blend|clip|::/.test(p.complex)) {
          skipTree(p.id);
          await picture(p, true, p.complex);
          continue;
        }
        // The layer's own box: native when plain, else a picture of it alone with what is inside kept apart.
        if (p.paints) {
          if (p.complex) await picture(p, false, p.complex);
          else if (isRoot && p.fill && !p.border) slide.background = { color: p.fill, ...(p.fillAlpha < 1 ? { transparency: Math.round((1 - p.fillAlpha) * 100) } : {}) };
          else {
            for (const l of p.sides) {
              const w = l.width;
              const at = l.side === 'top' ? { x: p.x, y: p.y + w / 2, w: p.w, h: 0 } : l.side === 'bottom' ? { x: p.x, y: p.y + p.h - w / 2, w: p.w, h: 0 } : l.side === 'left' ? { x: p.x + w / 2, y: p.y, w: 0, h: p.h } : { x: p.x + p.w - w / 2, y: p.y, w: 0, h: p.h };
              slide.addShape(pptx.ShapeType.line, { ...pos(at), line: { color: l.color, width: Math.max(0.25, w * PT_PER_PX * k), ...(l.dashed ? { dashType: 'dash' } : {}), ...(l.alpha < 1 ? { transparency: Math.round((1 - l.alpha) * 100) } : {}) } });
              report.native++;
            }
            const radius = Math.min(p.radius, p.w / 2, p.h / 2);
            const ellipse = radius >= Math.min(p.w, p.h) / 2 - 0.5 && Math.abs(p.w - p.h) < 1;
            if (p.fill || p.border) slide.addShape(ellipse ? pptx.ShapeType.ellipse : radius > 0.5 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
              ...pos(p), ...(radius > 0.5 && !ellipse ? { rectRadius: px2in(radius * k) } : {}),
              fill: p.fill ? { color: p.fill, ...(p.fillAlpha * p.opacity < 1 ? { transparency: Math.round((1 - p.fillAlpha * p.opacity) * 100) } : {}) } : { type: 'none' },
              line: p.border ? { color: p.border.color, width: Math.max(0.25, p.border.width * PT_PER_PX * k), ...(p.border.dashed ? { dashType: 'dash' } : {}), ...(p.border.alpha < 1 ? { transparency: Math.round((1 - p.border.alpha) * 100) } : {}) } : { type: 'none' },
            });
            if (p.fill || p.border) report.native++;
          }
        }
        if (type === 'text' && p.text?.runs.length) {
          const t = p.text;
          const runs = t.runs.filter((r) => r.text).map((r) => ({
            text: r.text,
            options: {
              fontFace: r.font, fontSize: Math.round(r.size * PT_PER_PX * k * 10) / 10, bold: r.weight >= 600, italic: r.italic, color: r.color,
              ...(r.alpha * p.opacity < 1 ? { transparency: Math.round((1 - r.alpha * p.opacity) * 100) } : {}),
              ...(r.underline ? { underline: { style: 'sng' as const } } : {}), ...(r.strike ? { strike: 'sngStrike' as const } : {}), ...(r.breakBefore ? { softBreakBefore: true } : {}),
            },
          }));
          if (!runs.length) continue;
          const single = t.lines <= 1;
          slide.addText(runs, {
            ...pos({ x: p.x, y: p.y, w: p.w + (single ? Math.max(4, p.w * 0.04) : 0), h: p.h }), margin: t.padding.map((v) => Math.round(v * PT_PER_PX * k * 10) / 10) as [number, number, number, number],
            align: t.align as 'left' | 'center' | 'right' | 'justify', valign: 'top', wrap: !single, fit: 'none',
            ...(t.lineHeight ? { lineSpacing: Math.round(t.lineHeight * PT_PER_PX * k * 10) / 10 } : {}), ...(t.letterSpacing ? { charSpacing: Math.round(t.letterSpacing * PT_PER_PX * k * 10) / 10 } : {}),
          });
          report.native++;
        }
      }
    });
  }
  if (clippedCount) report.notes.push(`${clippedCount} layer${clippedCount === 1 ? ' reaches' : 's reach'} outside a frame that cuts them off in Bogen. PowerPoint shows them whole.`);
  if (unsupported) report.notes.push(`${unsupported} image placeholder${unsupported === 1 ? ' has' : 's have'} no picture yet and ${unsupported === 1 ? 'was' : 'were'} left out.`);
  report.notes.push('Fonts are named, not embedded: PowerPoint uses them when they are installed, and a stand-in when not.');
  const bytes = (await pptx.write({ outputType: 'nodebuffer', compression: true })) as Buffer;
  return { bytes: new Uint8Array(bytes), report };
}
