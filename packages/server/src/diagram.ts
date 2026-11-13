import { readFile } from 'node:fs/promises';
import { googleFontsHrefs, type Token } from '@bogen/core';
import type { Renderer } from './render.ts';
import { vendorPath } from './vendor-files.ts';

/**
 * Mermaid as layers. Mermaid (MIT) parses the text and lays the diagram out with its own layout, in a page of the
 * render browser; what it drew is then read back as geometry: nodes with their shapes and labels, connectors as paths
 * with their arrowheads, groups, and every other line or label. That becomes plain frames, text and SVG layers in the
 * file's tokens, which stay editable like anything drawn by hand. Nothing of Mermaid's SVG or styles is kept.
 */

const ORIGIN = 'https://diagram.bogen.invalid';
export const MAX_DIAGRAM_SOURCE = 50_000;
const MAX_ITEMS = 1500;

export interface DiagramBox { x: number; y: number; w: number; h: number }
export interface DiagramText { lines: string[]; size: number; weight: number; anchor: 'start' | 'middle' | 'end' }
export interface DiagramNode extends DiagramBox {
  id: string;
  label: DiagramText | null;
  /** rect (with rx), ellipse, or svg for any other outline, with its markup in node coordinates. */
  shape: 'rect' | 'ellipse' | 'svg';
  rx: number;
  svg?: string;
  filled: boolean;
  /** The outline is drawn with the accent: a start or end state. */
  solid: boolean;
}
export interface DiagramEdge {
  id: string;
  d: string;
  box: DiagramBox;
  dashed: boolean;
  thick: boolean;
  end: 'arrow' | 'circle' | 'cross' | null;
  start: 'arrow' | 'circle' | 'cross' | null;
  /** The last and first segment's direction, for drawing the heads. */
  endAt: [number, number, number];
  startAt: [number, number, number];
}
export interface DiagramLabel extends DiagramBox { text: DiagramText; kind: 'edge' | 'cluster' | 'free' }
export interface DiagramShape extends DiagramBox { svg: string; kind: 'line' | 'box' | 'shape'; filled: boolean }
export interface DiagramModel {
  type: string;
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  labels: DiagramLabel[];
  clusters: DiagramBox[];
  shapes: DiagramShape[];
}

let mermaidSource: Promise<string> | null = null;
/** Mermaid's browser bundle, a file of its own next to the CLI (vendor-files.ts), read on first use. */
function mermaidBundle(): Promise<string> {
  mermaidSource ??= (async () => readFile(vendorPath('mermaid'), 'utf8'))();
  mermaidSource.catch(() => (mermaidSource = null));
  return mermaidSource;
}

/** Runs in the page: Mermaid renders, then the drawing is read back as plain geometry. */
async function layoutInPage(args: { source: string; font: string; size: number }): Promise<DiagramModel | { error: string }> {
  const mermaid = (globalThis as unknown as { mermaid: { initialize: (c: unknown) => void; parse: (t: string) => Promise<{ diagramType: string } | false>; render: (id: string, t: string) => Promise<{ svg: string }> } }).mermaid;
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base', htmlLabels: false, fontFamily: args.font, maxTextSize: 60000, maxEdges: 2000,
    themeVariables: { fontFamily: args.font, fontSize: `${args.size}px` },
    flowchart: { htmlLabels: false, useMaxWidth: false, padding: 12 }, sequence: { useMaxWidth: false }, state: { useMaxWidth: false }, class: { htmlLabels: false, useMaxWidth: false },
  });
  let type = 'diagram';
  try {
    const parsed = await mermaid.parse(args.source);
    if (parsed) type = parsed.diagramType;
    await document.fonts.ready;
    const { svg } = await mermaid.render('bogen-diagram', args.source);
    document.getElementById('out')!.innerHTML = svg;
  } catch (e) {
    return { error: String((e as Error)?.message ?? e).split('\n').slice(0, 6).join('\n') };
  }
  const root = document.querySelector('#out svg') as SVGSVGElement;
  const vb = root.viewBox.baseVal;
  root.setAttribute('width', String(vb.width));
  root.setAttribute('height', String(vb.height));
  root.style.maxWidth = 'none';
  const origin = root.getBoundingClientRect();
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const claimed = new Set<Element>();
  const inDefs = (el: Element) => Boolean(el.closest('defs, marker, symbol, clipPath, mask, pattern, style'));
  const boxOf = (el: Element) => {
    const b = el.getBoundingClientRect();
    return { x: r1(b.left - origin.left), y: r1(b.top - origin.top), w: r1(b.width), h: r1(b.height) };
  };
  const painted = (el: Element) => {
    const cs = getComputedStyle(el);
    const fill = cs.fill !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(cs.fill) && cs.fillOpacity !== '0';
    const stroke = cs.stroke !== 'none' && !/rgba\(0, 0, 0, 0\)/.test(cs.stroke) && cs.strokeOpacity !== '0' && Number.parseFloat(cs.strokeWidth) > 0;
    return { fill, stroke, dashed: (cs.strokeDasharray.match(/\d*\.?\d+/g) ?? []).some((v) => Number(v) > 0), width: Number.parseFloat(cs.strokeWidth) || 1, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' };
  };
  // A path in page pixels: every point through the element's own transform.
  const absolute = (el: SVGGraphicsElement, d: string) => {
    const m = el.getScreenCTM()!;
    const tf = (x: number, y: number) => {
      const p = new DOMPoint(x, y).matrixTransform(m);
      return `${r1(p.x - origin.left)} ${r1(p.y - origin.top)}`;
    };
    const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
    let i = 0;
    let cmd = '';
    let cx = 0, cy = 0, sx = 0, sy = 0;
    const out: string[] = [];
    const num = () => Number(tokens[i++]);
    while (i < tokens.length) {
      if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === 'Z') {
        out.push('Z');
        cx = sx; cy = sy;
        continue;
      }
      if (C === 'M' || C === 'L' || C === 'T') {
        const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0);
        out.push(`${C === 'T' ? 'T' : C} ${tf(x, y)}`);
        if (C === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
        cx = x; cy = y;
      } else if (C === 'H' || C === 'V') {
        const v = num();
        if (C === 'H') cx = v + (rel ? cx : 0); else cy = v + (rel ? cy : 0);
        out.push(`L ${tf(cx, cy)}`);
      } else if (C === 'C') {
        const p = [num(), num(), num(), num(), num(), num()].map((v, k) => v + (rel ? (k % 2 ? cy : cx) : 0));
        out.push(`C ${tf(p[0]!, p[1]!)} ${tf(p[2]!, p[3]!)} ${tf(p[4]!, p[5]!)}`);
        cx = p[4]!; cy = p[5]!;
      } else if (C === 'S' || C === 'Q') {
        const p = [num(), num(), num(), num()].map((v, k) => v + (rel ? (k % 2 ? cy : cx) : 0));
        out.push(`${C} ${tf(p[0]!, p[1]!)} ${tf(p[2]!, p[3]!)}`);
        cx = p[2]!; cy = p[3]!;
      } else if (C === 'A') {
        const [rx, ry, rot, large, sweep] = [num(), num(), num(), num(), num()];
        const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0);
        out.push(`A ${r1(rx * Math.hypot(m.a, m.b))} ${r1(ry * Math.hypot(m.c, m.d))} ${rot} ${large} ${sweep} ${tf(x, y)}`);
        cx = x; cy = y;
      } else i++;
    }
    return out.join(' ');
  };
  const geometryOf = (el: SVGGraphicsElement): string | null => {
    const tag = el.tagName.toLowerCase();
    const n = (a: string) => Number(el.getAttribute(a) ?? 0) || 0;
    if (tag === 'path') return el.getAttribute('d');
    if (tag === 'line') return `M ${n('x1')} ${n('y1')} L ${n('x2')} ${n('y2')}`;
    if (tag === 'polyline' || tag === 'polygon') {
      const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M ${pts[0]} ${pts[1]}`;
      for (let k = 2; k + 1 < pts.length; k += 2) d += ` L ${pts[k]} ${pts[k + 1]}`;
      return tag === 'polygon' ? `${d} Z` : d;
    }
    if (tag === 'rect') {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      return w > 0 && h > 0 ? `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z` : null;
    }
    if (tag === 'circle' || tag === 'ellipse') {
      const cx = n('cx'), cy = n('cy'), rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
      return rx > 0 ? `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z` : null;
    }
    return null;
  };
  const textOf = (el: SVGTextElement): DiagramText | null => {
    const rows = [...el.querySelectorAll('tspan.text-outer-tspan, tspan.row')];
    let lines = rows.length ? rows.map((r) => r.textContent ?? '') : [];
    if (!lines.length) {
      const spans = [...el.children].filter((c) => c.tagName.toLowerCase() === 'tspan' && (c.hasAttribute('dy') || c.hasAttribute('y')));
      lines = spans.length > 1 ? spans.map((s) => s.textContent ?? '') : [el.textContent ?? ''];
    }
    lines = lines.map((l) => l.replace(/\s+/g, ' ').trim());
    if (!lines.some(Boolean)) return null;
    const cs = getComputedStyle(el);
    const anchor = (el.getAttribute('text-anchor') ?? cs.textAnchor ?? 'start') as DiagramText['anchor'];
    return { lines, size: r1(Number.parseFloat(cs.fontSize) || args.size), weight: Number(cs.fontWeight) || 400, anchor: anchor === 'middle' || anchor === 'end' ? anchor : 'start' };
  };
  const SHAPES = 'rect, circle, ellipse, polygon, path, line, polyline';
  const nodes: DiagramNode[] = [];
  const markup = (els: SVGGraphicsElement[], box: { x: number; y: number }) => els.flatMap((el) => {
    const d = geometryOf(el);
    if (!d) return [];
    const p = painted(el);
    const local = absolute(el, d).replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${r1(Number(x) - box.x)} ${r1(Number(y) - box.y)}`);
    return [{ d: local, fill: p.fill, stroke: p.stroke, dashed: p.dashed, width: p.width }];
  });
  const addNode = (group: Element, shapes: SVGGraphicsElement[], texts: SVGTextElement[], solid = false) => {
    const visible = shapes.filter((s) => painted(s).visible && (painted(s).fill || painted(s).stroke));
    if (!visible.length && !texts.length) return;
    for (const s of shapes) claimed.add(s);
    for (const t of texts) claimed.add(t);
    const box = boxOf(visible[0] && visible.length === 1 ? visible[0] : group);
    if (box.w < 1 && box.h < 1) return;
    const label = texts.map(textOf).find(Boolean) ?? null;
    if (label && texts.length > 1) label.lines = texts.flatMap((t) => textOf(t)?.lines ?? []);
    const only = visible.length === 1 ? visible[0]! : null;
    const tag = only?.tagName.toLowerCase();
    const filled = visible.some((s) => painted(s).fill);
    const id = (group.getAttribute('id') ?? '').replace(/^bogen-diagram-/, '') || `n${nodes.length + 1}`;
    if (only && tag === 'rect') nodes.push({ id, ...box, label, shape: 'rect', rx: Number(only.getAttribute('rx') ?? 0) || 0, filled, solid });
    else if (only && (tag === 'circle' || tag === 'ellipse')) nodes.push({ id, ...box, label, shape: 'ellipse', rx: 0, filled, solid });
    else {
      const parts = markup(visible, box);
      nodes.push({ id, ...box, label, shape: 'svg', rx: 0, svg: JSON.stringify(parts), filled, solid });
    }
  };
  const shapesIn = (g: Element) => [...g.querySelectorAll(SHAPES)].filter((s) => !inDefs(s) && !s.closest('g.label, .label, text')) as SVGGraphicsElement[];
  // Flowchart, state, class and ER boxes.
  for (const g of root.querySelectorAll('g.node')) {
    if (inDefs(g)) continue;
    const solid = /state-start|state-end|end-state|start-state|fork|join/.test(g.getAttribute('class') ?? '') || /_start|_end|root_start|root_end/.test(g.getAttribute('id') ?? '');
    addNode(g, shapesIn(g), [...g.querySelectorAll('text')] as SVGTextElement[], solid);
  }
  // Sequence participants, notes and activations.
  for (const rect of root.querySelectorAll('rect.actor, rect.note, rect[class^="activation"]')) {
    if (claimed.has(rect)) continue;
    const g = rect.parentElement!;
    const cls = rect.getAttribute('class') ?? '';
    const texts = (cls.includes('activation') ? [] : [...g.querySelectorAll(cls.includes('note') ? 'text.noteText' : 'text.actor')].filter((t) => !claimed.has(t))) as SVGTextElement[];
    addNode(rect, [rect as SVGGraphicsElement], texts.slice(0, cls.includes('note') ? 20 : 1));
  }
  // Stick figures and other drawn participants.
  for (const g of root.querySelectorAll('g.actor-man')) {
    if (claimed.has(g)) continue;
    addNode(g, shapesIn(g), [...g.querySelectorAll('text')] as SVGTextElement[]);
  }
  const clusters: DiagramBox[] = [];
  const labels: DiagramLabel[] = [];
  for (const g of root.querySelectorAll('g.cluster')) {
    const rect = g.querySelector(':scope > rect, :scope > path') as SVGGraphicsElement | null;
    if (!rect) continue;
    claimed.add(rect);
    clusters.push(boxOf(rect));
    for (const t of g.querySelectorAll('text')) {
      const text = textOf(t as SVGTextElement);
      claimed.add(t);
      if (text) labels.push({ ...boxOf(t), text, kind: 'cluster' });
    }
  }
  // Connectors: links, transitions, relations and messages, and any path that ends in a marker.
  const edges: DiagramEdge[] = [];
  const headOf = (url: string | null): DiagramEdge['end'] => {
    if (!url || url === 'none') return null;
    const id = /#([^)"']+)/.exec(url)?.[1] ?? '';
    if (/circle/i.test(id)) return 'circle';
    if (/cross/i.test(id)) return 'cross';
    return 'arrow';
  };
  const EDGE = 'path.flowchart-link, path.transition, path.relation, path[class*="messageLine"], line[class*="messageLine"], path.relationshipLine, path[marker-end], line[marker-end], path[marker-start], line[marker-start]';
  for (const el of root.querySelectorAll(EDGE)) {
    if (claimed.has(el) || inDefs(el)) continue;
    const g = el as SVGGeometryElement;
    const raw = geometryOf(g);
    if (!raw) continue;
    claimed.add(el);
    const p = painted(el);
    const len = g.getTotalLength();
    const m = g.getScreenCTM()!;
    const at = (l: number) => {
      const q = g.getPointAtLength(Math.max(0, Math.min(len, l))).matrixTransform(m);
      return [q.x - origin.left, q.y - origin.top] as [number, number];
    };
    const e1 = at(len), e0 = at(len - 2), s1 = at(0), s0 = at(2);
    const cs = getComputedStyle(el);
    edges.push({
      id: el.getAttribute('id') ?? `e${edges.length + 1}`, d: absolute(g, raw), box: boxOf(el), dashed: p.dashed || /edge-pattern-dotted|edge-pattern-dashed|messageLine1/.test(el.getAttribute('class') ?? ''),
      thick: /thick/.test(el.getAttribute('class') ?? '') || p.width >= 3.5,
      end: headOf(el.getAttribute('marker-end') ?? cs.markerEnd), start: headOf(el.getAttribute('marker-start') ?? cs.markerStart),
      endAt: [r1(e1[0]), r1(e1[1]), Math.atan2(e1[1] - e0[1], e1[0] - e0[0])], startAt: [r1(s1[0]), r1(s1[1]), Math.atan2(s1[1] - s0[1], s1[0] - s0[0])],
    });
  }
  // Labels on edges, then every other text.
  for (const t of root.querySelectorAll('text')) {
    if (claimed.has(t) || inDefs(t)) continue;
    claimed.add(t);
    const text = textOf(t as SVGTextElement);
    if (!text) continue;
    labels.push({ ...boxOf(t), text, kind: t.closest('g.edgeLabel, .edgeLabel') ? 'edge' : 'free' });
  }
  // Whatever else is drawn: lifelines, loop frames, dividers.
  const shapes: DiagramShape[] = [];
  for (const el of root.querySelectorAll(SHAPES)) {
    if (claimed.has(el) || inDefs(el) || el.closest('g.edgeLabel, .edgeLabel')) continue;
    const p = painted(el);
    if (!p.visible || (!p.fill && !p.stroke)) continue;
    const box = boxOf(el);
    if (box.w < 0.5 && box.h < 0.5) continue;
    const d = geometryOf(el as SVGGraphicsElement);
    if (!d) continue;
    const tag = el.tagName.toLowerCase();
    const pad = Math.ceil(p.width) + 1;
    const frame = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
    const parts = markup([el as SVGGraphicsElement], frame);
    shapes.push({ ...frame, svg: JSON.stringify(parts), kind: tag === 'line' || tag === 'polyline' ? 'line' : tag === 'rect' ? 'box' : 'shape', filled: p.fill });
  }
  const count = nodes.length + edges.length + labels.length + shapes.length + clusters.length;
  if (count > 1500) return { error: `The diagram has ${count} parts, over the limit of 1500. Split it into smaller diagrams.` };
  return { type, width: r1(vb.width), height: r1(vb.height), nodes, edges, labels, clusters, shapes };
}

/** Mermaid's layout of a diagram, read back as geometry. Throws the parser's message for text it cannot read. */
export async function layoutDiagram(renderer: Renderer, source: string, options: { font: string; family?: string; size?: number }): Promise<DiagramModel> {
  if (source.length > MAX_DIAGRAM_SOURCE) throw new Error(`The diagram is ${source.length} characters, over the limit of ${MAX_DIAGRAM_SOURCE}.`);
  const bundle = await mermaidBundle();
  const links = options.family ? googleFontsHrefs(options.family).map((href) => `<link rel="stylesheet" href="${href.replace(/&/g, '&amp;').replace(/"/g, '%22')}">`).join('') : '';
  const html = `<!doctype html><html><head><meta charset="utf-8">${links}<style>body{margin:0;background:#fff}#out{position:absolute;left:0;top:0}</style><script src="${ORIGIN}/mermaid.js"></script></head><body><div id="out"></div></body></html>`;
  return renderer.withBrowser(async (browser) => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (url === `${ORIGIN}/`) void req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
        else if (url === `${ORIGIN}/mermaid.js`) void req.respond({ status: 200, contentType: 'text/javascript', body: bundle });
        else if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url) || url.startsWith('data:')) void req.continue();
        else void req.abort('blockedbyclient');
      });
      await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
      await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 20_000 });
      const out = await Promise.race([
        page.evaluate(layoutInPage, { source, font: options.font, size: options.size ?? 14 }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The diagram took more than 20 seconds to lay out.')), 20_000).unref()),
      ]);
      if ('error' in out) throw new Error(`Mermaid could not read the diagram: ${out.error}`);
      return out;
    } finally {
      await context.close().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------- layers

/** The file's tokens a diagram is drawn with, by what they are for, each with a value to fall back on. */
export interface DiagramPaint { surface: string; text: string; line: string; accent: string; canvas: string; font: string; radius: string; used: Record<string, string> }

const pickToken = (tokens: Token[], kind: Token['kind'], patterns: RegExp[]): Token | undefined => {
  const own = tokens.filter((t) => t.kind === kind);
  for (const p of patterns) {
    const hit = own.find((t) => p.test(t.name));
    if (hit) return hit;
  }
  return undefined;
};

export function diagramPaint(tokens: Token[], bodyFont?: string | null): DiagramPaint {
  const used: Record<string, string> = {};
  const use = (role: string, t: Token | undefined, fallback: string) => {
    if (!t) return fallback;
    used[role] = t.name;
    return `var(--${t.name})`;
  };
  const surface = pickToken(tokens, 'color', [/^(surface|card|panel)$/, /^(surface|card|panel)[-_]/, /^(bg|background)[-_](subtle|raised|muted|alt|2)$/, /^(bg|background|paper|base)$/]);
  const canvas = pickToken(tokens, 'color', [/^(bg|background|paper|canvas|page)$/, /^(bg|background)[-_]?(default|base)?$/]);
  const text = pickToken(tokens, 'color', [/^(text|fg|foreground|ink|on-surface|body|copy)$/, /^(text|fg|foreground|ink)[-_](default|primary|strong|1)$/, /^(text|fg|ink)/]);
  const line = pickToken(tokens, 'color', [/^(border|line|stroke|outline|rule|divider)$/, /^(border|line|stroke|outline)[-_]/, /^(muted|text-muted|fg-muted|subtle)$/]);
  const accent = pickToken(tokens, 'color', [/^(accent|primary|brand)$/, /^(accent|primary|brand)[-_]/]);
  const font = pickToken(tokens, 'font-family', [/^(font-)?(body|sans|text|ui|base)$/, /body|sans|text/, /./]);
  const radius = pickToken(tokens, 'radius', [/^(radius-)?(md|base|default|2)$/, /^radius$/, /(sm|small)$/, /./]);
  return {
    surface: use('surface', surface ?? canvas, '#ffffff'), canvas: use('background', canvas, '#ffffff'), text: use('text', text, '#1c1c1c'), line: use('line', line ?? text, '#7d7d7d'),
    accent: use('accent', accent ?? text, '#1c1c1c'), font: use('font', font, bodyFont || 'system-ui, sans-serif'), radius: use('radius', radius, '6px'), used,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const px = (n: number) => `${Math.round(n * 10) / 10}px`;

function textHtml(t: DiagramText, paint: DiagramPaint, extra: string, name: string): string {
  const align = t.anchor === 'middle' ? 'center' : t.anchor === 'end' ? 'right' : 'left';
  return `<p data-name="${esc(name)}" style="margin:0;font-family:${paint.font};font-size:${px(t.size)};font-weight:${t.weight};line-height:1.25;color:${paint.text};text-align:${align};white-space:nowrap;${extra}">${t.lines.map(esc).join('<br>')}</p>`;
}

function shapeSvg(parts: { d: string; fill: boolean; stroke: boolean; dashed: boolean; width: number }[], w: number, h: number, paint: DiagramPaint, fill: string, name: string, extra = ''): string {
  const paths = parts.map((p) => `<path d="${esc(p.d)}" style="fill:${p.fill ? fill : 'none'};stroke:${p.stroke ? paint.line : 'none'};stroke-width:${Math.max(1, Math.min(4, p.width))}${p.dashed ? ';stroke-dasharray:4 3' : ''}"></path>`).join('');
  return `<svg data-name="${esc(name)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, Math.round(w * 10) / 10)} ${Math.max(1, Math.round(h * 10) / 10)}" style="position:absolute;left:0;top:0;width:${px(w)};height:${px(h)};overflow:visible;${extra}">${paths}</svg>`;
}

function head(kind: 'arrow' | 'circle' | 'cross', [x, y, a]: [number, number, number], size: number, color: string): string {
  const c = Math.cos(a), s = Math.sin(a);
  const p = (dx: number, dy: number) => `${Math.round((x + dx * c - dy * s) * 10) / 10} ${Math.round((y + dx * s + dy * c) * 10) / 10}`;
  if (kind === 'circle') return `<circle cx="${Math.round((x - size / 2 * c) * 10) / 10}" cy="${Math.round((y - size / 2 * s) * 10) / 10}" r="${size / 2.4}" style="fill:${color}"></circle>`;
  if (kind === 'cross') return `<path d="M ${p(-size, -size / 2)} L ${p(0, size / 2)} M ${p(-size, size / 2)} L ${p(0, -size / 2)}" style="fill:none;stroke:${color};stroke-width:1.5"></path>`;
  return `<path d="M ${p(0, 0)} L ${p(-size, -size / 2.2)} L ${p(-size * 0.8, 0)} L ${p(-size, size / 2.2)} Z" style="fill:${color};stroke:none"></path>`;
}

/** The diagram as one frame of layers, in the file's tokens. */
export function diagramHtml(model: DiagramModel, paint: DiagramPaint, options: { name: string; padding: number; background: boolean }): string {
  const pad = options.padding;
  const parts: string[] = [];
  const at = (b: DiagramBox) => `position:absolute;left:${px(b.x + pad)};top:${px(b.y + pad)};width:${px(b.w)};height:${px(b.h)};`;
  model.clusters.forEach((c, i) => parts.push(`<div data-name="Group ${i + 1}" style="${at(c)}box-sizing:border-box;border:1px dashed ${paint.line};border-radius:${paint.radius}"></div>`));
  for (const s of model.shapes) {
    const svg = JSON.parse(s.svg) as Parameters<typeof shapeSvg>[0];
    parts.push(`<div data-name="${s.kind === 'line' ? 'Line' : s.kind === 'box' ? 'Box' : 'Shape'}" style="${at(s)}">${shapeSvg(svg, s.w, s.h, paint, paint.surface, s.kind === 'line' ? 'Line' : 'Shape')}</div>`);
  }
  model.edges.forEach((e) => {
    const size = e.thick ? 12 : 9;
    const m = size + 4;
    const box = { x: e.box.x - m, y: e.box.y - m, w: e.box.w + m * 2, h: e.box.h + m * 2 };
    const local = (d: string) => d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${Math.round((Number(x) - box.x) * 10) / 10} ${Math.round((Number(y) - box.y) * 10) / 10}`);
    const shift = (p: [number, number, number]): [number, number, number] => [p[0] - box.x, p[1] - box.y, p[2]];
    const heads = [e.end ? head(e.end, shift(e.endAt), size, paint.line) : '', e.start ? head(e.start, shift([e.startAt[0], e.startAt[1], e.startAt[2] + Math.PI]), size, paint.line) : ''].join('');
    const stroke = `fill:none;stroke:${paint.line};stroke-width:${e.thick ? 3 : 1.5};stroke-linecap:round;stroke-linejoin:round${e.dashed ? ';stroke-dasharray:5 4' : ''}`;
    parts.push(`<svg data-name="Connector" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(box.w * 10) / 10} ${Math.round(box.h * 10) / 10}" style="${at(box)}overflow:visible"><path d="${esc(local(e.d))}" style="${stroke}"></path>${heads}</svg>`);
  });
  for (const n of model.nodes) {
    const name = n.label ? n.label.lines.join(' ').slice(0, 60) : 'Node';
    const fill = n.solid ? paint.accent : paint.surface;
    const label = n.label ? textHtml({ ...n.label, anchor: 'middle' }, paint, 'position:relative;', 'Label') : '';
    const centre = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;';
    if (n.shape === 'rect') parts.push(`<div data-name="${esc(name)}" style="${at(n)}${centre}background:${n.filled ? fill : 'transparent'};border:1px solid ${paint.line};border-radius:${n.rx >= Math.min(n.w, n.h) / 2 - 1 ? '999px' : n.rx > 0 ? paint.radius : '2px'}">${label}</div>`);
    else if (n.shape === 'ellipse') parts.push(`<div data-name="${esc(name)}" style="${at(n)}${centre}background:${n.filled ? fill : 'transparent'};border:1px solid ${n.solid ? fill : paint.line};border-radius:50%">${label}</div>`);
    else parts.push(`<div data-name="${esc(name)}" style="${at(n)}${centre}">${shapeSvg(JSON.parse(n.svg!), n.w, n.h, paint, fill, 'Outline')}${label}</div>`);
  }
  for (const l of model.labels) {
    const chip = l.kind === 'edge' ? `background:${paint.canvas};padding:1px 4px;` : '';
    const box = l.kind === 'edge' ? { x: l.x - 4, y: l.y - 1, w: l.w + 8, h: l.h + 2 } : l;
    parts.push(`<div data-name="${l.kind === 'edge' ? 'Connector label' : 'Label'}" style="${at(box)}display:flex;align-items:center;justify-content:${l.text.anchor === 'middle' || l.kind === 'edge' ? 'center' : l.text.anchor === 'end' ? 'flex-end' : 'flex-start'};${chip}box-sizing:border-box">${textHtml(l.kind === 'edge' ? { ...l.text, anchor: 'middle' } : l.text, paint, '', l.text.lines.join(' ').slice(0, 60))}</div>`);
  }
  const w = model.width + pad * 2;
  const h = model.height + pad * 2;
  return `<div data-name="${esc(options.name)}" style="position:relative;width:${px(w)};height:${px(h)};flex:none;overflow:visible;${options.background ? `background:${paint.canvas};` : ''}">${parts.join('')}</div>`;
}
