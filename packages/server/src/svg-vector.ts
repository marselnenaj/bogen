import { getFontFaces, type BogenDoc } from '@bogen/core';

/**
 * Real SVG: rectangles, text with positions, images, paths and gradients that a vector tool can open.
 * Whatever SVG has no way to say stays HTML inside a `foreignObject`, and the report names each such
 * layer and why, so nobody finds out in the other tool.
 */
export interface VectorFallback { id: string; name: string; reason: string }
export interface VectorSvg {
  svg: string;
  /** Layers exported as HTML in a `foreignObject`. */
  fallbacks: VectorFallback[];
  /** Native SVG elements written. */
  native: number;
}

export interface VectorArgs {
  ids: string[];
  /** Reset and tokens, for the parts that stay HTML. */
  css: string;
  /** `@font-face` rules with the files inline. */
  faces: string;
  origin: string;
}

/** The document's stored fonts as rules with the files inline, as an SVG cannot load them from us. */
export async function embedFontFaces(doc: BogenDoc, readAsset: (name: string) => Promise<{ bytes: Uint8Array; mime: string } | null>): Promise<string> {
  const { fontFacesCss } = await import('@bogen/core');
  const inlined = new Map<string, string>();
  for (const face of getFontFaces(doc)) {
    const name = face.src?.slice('bogen-asset:'.length);
    if (!name || inlined.has(name)) continue;
    const asset = await readAsset(name);
    if (asset) inlined.set(name, `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString('base64')}`);
  }
  return fontFacesCss(doc, (src) => inlined.get(src.slice('bogen-asset:'.length)) ?? src);
}

/** Runs in the rendered page, so it can only use its argument. */
export async function vectorizeInPage(args: VectorArgs): Promise<VectorSvg> {
  const fallbacks: VectorFallback[] = [];
  let native = 0;
  let nextId = 0;
  const defs: string[] = [];
  const fresh = (prefix: string) => `${prefix}${++nextId}`;
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = (n: number) => String(Math.round(n * 1000) / 1000);
  const px = (v: string) => parseFloat(v) || 0;
  const probe = document.createElement('canvas').getContext('2d')!;

  // Colours as sRGB, the form every vector tool reads. A canvas does the conversion from oklch and friends.
  const paint = (value: string): { color: string; alpha: number } | null => {
    const v = value.trim();
    if (!v || v === 'transparent' || v === 'none' || v === 'rgba(0, 0, 0, 0)') return null;
    let plain = v;
    if (!/^(#|rgba?\()/.test(v)) {
      probe.fillStyle = '#000';
      probe.fillStyle = v;
      plain = String(probe.fillStyle);
    }
    const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(plain);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (a <= 0) return null;
      const hex = (x: string) => Math.round(parseFloat(x)).toString(16).padStart(2, '0');
      return { color: `#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`, alpha: a };
    }
    return { color: plain, alpha: 1 };
  };
  /** Channels and alpha, also for a colour with no alpha, which `paint` drops. Null for what a canvas cannot read. */
  const channels = (value: string): { rgb: [number, number, number]; alpha: number } | null => {
    const v = value.trim();
    if (v === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
    let plain = v;
    if (!/^rgba?\(/.test(v)) {
      probe.fillStyle = '#010203';
      probe.fillStyle = v;
      plain = String(probe.fillStyle);
      if (plain === '#010203' && v !== '#010203') return null;
    }
    const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(plain);
    if (hex) return { rgb: [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)], alpha: 1 };
    const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(plain);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!)], alpha: a };
  };
  const fillAttrs = (value: string, attr = 'fill') => {
    const p = paint(value);
    if (!p) return `${attr}="none"`;
    return `${attr}="${p.color}"${p.alpha < 1 ? ` ${attr}-opacity="${num(p.alpha)}"` : ''}`;
  };

  const splitTop = (text: string, separator: string) => {
    const out: string[] = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const c of text) {
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && c === separator) {
        out.push(current.trim());
        current = '';
        continue;
      }
      current += c;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };

  interface Box { x: number; y: number; w: number; h: number; radii: [number, number, number, number] }

  const boxOf = (r: DOMRect, cs: CSSStyleDeclaration): Box => {
    const radius = (name: string) => {
      const value = cs.getPropertyValue(name).split(' ')[0] ?? '0';
      return value.endsWith('%') ? (parseFloat(value) / 100) * Math.min(r.width, r.height) : px(value);
    };
    const scaleDown = (values: [number, number, number, number]): [number, number, number, number] => {
      const f = Math.min(1, r.width / (values[0] + values[1] || 1), r.height / (values[1] + values[2] || 1), r.width / (values[2] + values[3] || 1), r.height / (values[3] + values[0] || 1));
      return values.map((v) => v * f) as [number, number, number, number];
    };
    return { x: r.left, y: r.top, w: r.width, h: r.height, radii: scaleDown([radius('border-top-left-radius'), radius('border-top-right-radius'), radius('border-bottom-right-radius'), radius('border-bottom-left-radius')]) };
  };

  /** The outline of a box with its corners, as path data. */
  const outlineOf = (b: Box) => {
    const [tl, tr, br, bl] = b.radii;
    const right = b.x + b.w;
    const bottom = b.y + b.h;
    const arc = (r: number, x: number, y: number) => (r ? `A${num(r)} ${num(r)} 0 0 1 ${num(x)} ${num(y)}` : '');
    return [`M${num(b.x + tl)} ${num(b.y)}`, `H${num(right - tr)}`, arc(tr, right, b.y + tr), `V${num(bottom - br)}`, arc(br, right - br, bottom), `H${num(b.x + bl)}`, arc(bl, b.x, bottom - bl), `V${num(b.y + tl)}`, arc(tl, b.x + tl, b.y), 'Z'].join('');
  };

  /** A rectangle when the corners allow, a path when they differ. Gives element markup without the paint. */
  const shape = (b: Box, attrs: string) => {
    native++;
    const [tl, tr, br, bl] = b.radii;
    if (tl === tr && tr === br && br === bl) {
      return `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}"${tl ? ` rx="${num(tl)}" ry="${num(tl)}"` : ''} ${attrs}/>`;
    }
    return `<path d="${outlineOf(b)}" ${attrs}/>`;
  };

  /** The box inside the borders, where backgrounds clip for overflow and inner shadows paint. */
  const paddingBox = (b: Box, cs: CSSStyleDeclaration): Box => {
    const side = (name: string) => (cs.getPropertyValue(`border-${name}-style`) === 'none' ? 0 : px(cs.getPropertyValue(`border-${name}-width`)));
    const [top, right, bottom, left] = [side('top'), side('right'), side('bottom'), side('left')];
    if (!top && !right && !bottom && !left) return b;
    const [tl, tr, br, bl] = b.radii;
    return {
      x: b.x + left, y: b.y + top, w: Math.max(0, b.w - left - right), h: Math.max(0, b.h - top - bottom),
      radii: [Math.max(0, tl - Math.max(top, left)), Math.max(0, tr - Math.max(top, right)), Math.max(0, br - Math.max(bottom, right)), Math.max(0, bl - Math.max(bottom, left))],
    };
  };

  /** A clip path, without counting it as a drawn element. */
  const clipTo = (d: string, evenOdd = false) => {
    const id = fresh('c');
    defs.push(`<clipPath id="${id}"><path d="${d}"${evenOdd ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
    return id;
  };

  /**
   * Stops for a CSS gradient. CSS mixes colours premultiplied by their alpha, SVG does not: a fade to
   * `transparent` (black at no alpha) turns grey in SVG. So where the alpha changes between two stops,
   * the colours in between are written as stops of their own. For a mask, every stop is white and
   * only its alpha counts, as a luminance mask of white reads alpha.
   */
  const stops = (parts: string[], lengthForPx: number, forMask = false): string | null => {
    const out: { rgb: [number, number, number]; alpha: number; at: number | null }[] = [];
    for (const part of parts) {
      const m = /^(.*?)(?:\s+(-?[\d.]+)(%|px))?(?:\s+(-?[\d.]+)(%|px))?$/.exec(part);
      if (!m) return null;
      // A bare position is a colour hint, which SVG cannot say.
      if (!m[1]!.trim()) return null;
      const color = channels(m[1]!.trim());
      if (!color) return null;
      const at = (value?: string, unit?: string) => (value === undefined ? null : unit === '%' ? parseFloat(value) / 100 : parseFloat(value) / lengthForPx);
      out.push({ ...color, at: at(m[2], m[3]) });
      if (m[4] !== undefined) out.push({ ...color, at: at(m[4], m[5]) });
    }
    if (out.length < 2) return null;
    if (out[0]!.at === null) out[0]!.at = 0;
    if (out.at(-1)!.at === null) out.at(-1)!.at = 1;
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i]!.at !== null) continue;
      let j = i + 1;
      while (out[j]!.at === null) j++;
      const from = out[i - 1]!.at!;
      const to = out[j]!.at!;
      for (let k = i; k < j; k++) out[k]!.at = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    }
    // A stop placed before an earlier one sits at the earlier one, as in CSS.
    for (let i = 1; i < out.length; i++) out[i]!.at = Math.max(out[i]!.at!, out[i - 1]!.at!);
    const written: { rgb: [number, number, number]; alpha: number; at: number }[] = [];
    for (let i = 0; i < out.length; i++) {
      const s = out[i] as { rgb: [number, number, number]; alpha: number; at: number };
      const next = out[i + 1] as typeof s | undefined;
      written.push(s);
      if (!next || forMask || s.alpha === next.alpha || next.at === s.at) continue;
      const steps = 8;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const alpha = s.alpha + (next.alpha - s.alpha) * t;
        const rgb = [0, 1, 2].map((c) => (alpha ? (s.rgb[c]! * s.alpha * (1 - t) + next.rgb[c]! * next.alpha * t) / alpha : 0)) as [number, number, number];
        written.push({ rgb, alpha, at: s.at + (next.at - s.at) * t });
      }
    }
    // A stop with no alpha takes its colour from its neighbours, which is what premultiplying does.
    for (let i = 0; i < written.length; i++) {
      if (written[i]!.alpha > 0) continue;
      const near = written.slice(i + 1).find((s) => s.alpha > 0) ?? written.slice(0, i).reverse().find((s) => s.alpha > 0);
      if (near) written[i] = { ...written[i]!, rgb: near.rgb };
    }
    const hex = (rgb: [number, number, number]) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
    return written.map((s) => `<stop offset="${num(Math.min(1, Math.max(0, s.at)))}" stop-color="${forMask ? '#ffffff' : hex(s.rgb)}"${s.alpha < 1 ? ` stop-opacity="${num(s.alpha)}"` : ''}/>`).join('');
  };

  /** A native gradient for a CSS one, in the box's coordinates. Null for what has no SVG form. */
  const gradient = (value: string, b: Box, forMask = false): string | null => {
    const linear = /^(repeating-)?linear-gradient\((.*)\)$/s.exec(value);
    if (linear) {
      if (linear[1]) return null;
      const parts = splitTop(linear[2]!, ',');
      let angle = 180;
      const first = parts[0]!;
      const deg = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(first);
      const side = /^to\s+(.+)$/.exec(first);
      if (deg) {
        const n = parseFloat(deg[1]!);
        angle = deg[2] === 'deg' ? n : deg[2] === 'turn' ? n * 360 : deg[2] === 'rad' ? (n * 180) / Math.PI : n * 0.9;
        parts.shift();
      } else if (side) {
        const words = side[1]!.split(/\s+/);
        const dx = words.includes('right') ? b.h : words.includes('left') ? -b.h : 0;
        const dy = words.includes('bottom') ? b.w : words.includes('top') ? -b.w : 0;
        angle = words.length === 1 ? ({ top: 0, right: 90, bottom: 180, left: 270 } as Record<string, number>)[words[0]!] ?? 180 : (Math.atan2(dx, -dy) * 180) / Math.PI;
        parts.shift();
      }
      const rad = (angle * Math.PI) / 180;
      const length = Math.abs(b.w * Math.sin(rad)) + Math.abs(b.h * Math.cos(rad));
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dx = (Math.sin(rad) * length) / 2;
      const dy = (Math.cos(rad) * length) / 2;
      const body = stops(parts, length || 1, forMask);
      if (!body) return null;
      const id = fresh('g');
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(cx - dx)}" y1="${num(cy + dy)}" x2="${num(cx + dx)}" y2="${num(cy - dy)}">${body}</linearGradient>`);
      return id;
    }
    const radial = /^radial-gradient\((.*)\)$/s.exec(value);
    if (radial) {
      const parts = splitTop(radial[1]!, ',');
      let cx = 0.5;
      let cy = 0.5;
      let circle = false;
      if (/^(circle|ellipse|closest|farthest|at\s|\d)/.test(parts[0]!)) {
        const head = parts.shift()!;
        circle = /circle/.test(head);
        if (/closest|\dpx|\d%/.test(head.split(' at ')[0]!)) return null;
        const at = /at\s+(-?[\d.]+)(%|px)\s+(-?[\d.]+)(%|px)/.exec(head);
        if (at) {
          cx = at[2] === '%' ? parseFloat(at[1]!) / 100 : parseFloat(at[1]!) / b.w;
          cy = at[4] === '%' ? parseFloat(at[3]!) / 100 : parseFloat(at[3]!) / b.h;
        } else if (/ at /.test(head) && !/at\s+center/.test(head)) return null;
      }
      const fx = Math.max(cx, 1 - cx) * b.w;
      const fy = Math.max(cy, 1 - cy) * b.h;
      // Farthest corner, the CSS default. An ellipse keeps the ratio of the sides it passes through.
      const rx = circle ? Math.hypot(fx, fy) : fx * Math.SQRT2;
      const ry = circle ? rx : fy * Math.SQRT2;
      const body = stops(parts, rx || 1, forMask);
      if (!body) return null;
      const id = fresh('g');
      const px0 = b.x + cx * b.w;
      const py0 = b.y + cy * b.h;
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${num(px0)} ${num(py0)}) scale(${num(rx)} ${num(ry)})">${body}</radialGradient>`);
      return id;
    }
    return null;
  };

  const toDataUrl = async (src: string): Promise<string> => {
    if (src.startsWith('data:')) return src;
    try {
      const blob = await (await fetch(src)).blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('read'));
        reader.readAsDataURL(blob);
      });
    } catch {
      return src;
    }
  };

  /**
   * The one gradient a mask is made of, when it can be an SVG mask: a single linear or radial gradient
   * over the border box, as written with nothing but `mask-image`. Null when there is no mask.
   */
  const maskGradient = (cs: CSSStyleDeclaration): string | null | 'other' => {
    const image = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image');
    if (!image || image === 'none') return null;
    const layers = splitTop(image, ',');
    if (layers.length !== 1 || !/^(linear|radial)-gradient\(/.test(layers[0]!) || / in (oklch|oklab|hsl|lab|lch)/.test(layers[0]!)) return 'other';
    const plain: Record<string, RegExp> = {
      'mask-size': /^auto( auto)?$/, 'mask-position': /^0% 0%$|^left top$/, 'mask-repeat': /^repeat( repeat)?$/,
      'mask-clip': /^border-box$/, 'mask-origin': /^border-box$/, 'mask-composite': /^add$/, 'mask-mode': /^(match-source|alpha)$/,
    };
    for (const [prop, ok] of Object.entries(plain)) {
      const v = cs.getPropertyValue(prop);
      if (v && !ok.test(v)) return 'other';
    }
    return layers[0]!;
  };

  /** Why this element cannot be written natively, or null when it can. */
  const blocker = (el: Element, cs: CSSStyleDeclaration): string | null => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'iframe') return 'an embedded page';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'a form control';
    // Pseudo-elements this export can write were made real elements before the walk; these are the rest.
    for (const which of ['::before', '::after']) {
      const content = getComputedStyle(el, which).getPropertyValue('content');
      if (content && content !== 'none' && content !== 'normal') return `a ${which} pseudo-element with ${content.slice(0, 30)}`;
    }
    if (cs.getPropertyValue('backdrop-filter') !== 'none') return 'backdrop-filter';
    if (cs.getPropertyValue('mix-blend-mode') !== 'normal') return `blend mode ${cs.getPropertyValue('mix-blend-mode')}`;
    const mask = maskGradient(cs);
    if (mask === 'other') return 'a mask image other than one gradient';
    if (mask) {
      // A trial run, taken back: whether the mask's gradient has an SVG form.
      const kept = defs.length;
      const ok = gradient(mask, { x: 0, y: 0, w: 100, h: 100, radii: [0, 0, 0, 0] }, true);
      defs.length = kept;
      if (!ok) return 'a mask gradient with no SVG form';
    }
    if (cs.getPropertyValue('clip-path') !== 'none') return 'clip-path';
    if (cs.getPropertyValue('writing-mode') !== 'horizontal-tb') return 'vertical text';
    if (cs.getPropertyValue('outline-style') !== 'none' && px(cs.getPropertyValue('outline-width')) > 0) return 'an outline';
    const filter = cs.getPropertyValue('filter');
    if (filter !== 'none' && !/^blur\([\d.]+px\)$/.test(filter)) return `filter ${filter.slice(0, 40)}`;
    const clip = cs.getPropertyValue('background-clip');
    if (clip === 'text') return 'a gradient in text';
    const bg = cs.getPropertyValue('background-image');
    if (bg !== 'none') {
      for (const layer of splitTop(bg, ',')) {
        // An empty layer, as the colour at the end of a `background` list leaves.
        if (layer === 'none') continue;
        if (layer.startsWith('url(')) {
          if (cs.getPropertyValue('background-repeat').includes('round') || cs.getPropertyValue('background-repeat').includes('space')) return 'a background image pattern';
          continue;
        }
        if (!/^(linear|radial)-gradient\(/.test(layer) || /^linear-gradient\(\s*(?:from|in)\b/.test(layer) || / in (oklch|oklab|hsl|lab|lch)/.test(layer)) return `${layer.split('(')[0]}`;
      }
    }
    const shader = el.getAttribute('data-shader');
    if (shader !== null && !el.querySelector('img')) return 'a shader that did not render';
    return null;
  };

  const foreign = async (el: HTMLElement, r: DOMRect, reason: string): Promise<string> => {
    const id = el.getAttribute('data-bogen-id') ?? '';
    fallbacks.push({ id, name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || el.tagName.toLowerCase(), reason });
    const clone = el.cloneNode(true) as HTMLElement;
    for (const img of clone.querySelectorAll('img')) img.setAttribute('src', await toDataUrl(img.src));
    for (const n of [clone, ...clone.querySelectorAll('[data-bogen-id]')]) {
      n.removeAttribute('data-bogen-id');
      n.removeAttribute('data-shader');
    }
    clone.style.position = 'relative';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.margin = '0';
    clone.style.width = `${r.width}px`;
    clone.style.height = `${r.height}px`;
    return `<foreignObject x="${num(r.left)}" y="${num(r.top)}" width="${num(Math.ceil(r.width))}" height="${num(Math.ceil(r.height))}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${num(r.width)}px;height:${num(r.height)}px">${new XMLSerializer().serializeToString(clone)}</div></foreignObject>`;
  };

  /** One text node as `<text>` elements, one per line, placed from where the browser laid it out. */
  const textOf = (node: Text, cs: CSSStyleDeclaration): string => {
    const data = node.data;
    if (!data.trim() && !/^pre/.test(cs.getPropertyValue('white-space'))) return '';
    probe.font = `${cs.getPropertyValue('font-style')} ${cs.getPropertyValue('font-weight')} ${cs.getPropertyValue('font-size')} ${cs.getPropertyValue('font-family')}`;
    const metrics = probe.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    const range = document.createRange();
    const lines: { text: string; x: number; top: number; height: number }[] = [];
    const transform = cs.getPropertyValue('text-transform');
    const change = (t: string, atWordStart: boolean) => (transform === 'uppercase' ? t.toUpperCase() : transform === 'lowercase' ? t.toLowerCase() : transform === 'capitalize' && atWordStart ? t.toUpperCase() : t);
    let wordStart = true;
    for (let i = 0; i < data.length; i++) {
      // Keeps surrogate pairs in one piece.
      const size = data.codePointAt(i)! > 0xffff ? 2 : 1;
      range.setStart(node, i);
      range.setEnd(node, i + size);
      const rect = range.getClientRects()[0];
      const char = data.slice(i, i + size);
      i += size - 1;
      if (!rect || rect.width === 0) {
        // Collapsed space or a line break: it starts a new word and draws nothing.
        wordStart = true;
        continue;
      }
      const last = lines.at(-1);
      const shown = /\s/.test(char) ? ' ' : change(char, wordStart);
      wordStart = /\s/.test(char);
      if (last && Math.abs(last.top - rect.top) < 1) last.text += shown;
      else if (shown !== ' ') lines.push({ text: shown, x: rect.left, top: rect.top, height: rect.height });
    }
    const weight = cs.getPropertyValue('font-weight');
    const style = cs.getPropertyValue('font-style');
    const spacing = cs.getPropertyValue('letter-spacing');
    const decoration = cs.getPropertyValue('text-decoration-line');
    const fillColor = cs.getPropertyValue('-webkit-text-fill-color') || cs.getPropertyValue('color');
    const stroke = px(cs.getPropertyValue('-webkit-text-stroke-width'));
    const shared = [
      `font-family="${esc(cs.getPropertyValue('font-family').replace(/"/g, "'"))}"`,
      `font-size="${num(px(cs.getPropertyValue('font-size')))}"`,
      weight !== '400' ? `font-weight="${esc(weight)}"` : '',
      style !== 'normal' ? `font-style="${esc(style)}"` : '',
      spacing !== 'normal' && px(spacing) ? `letter-spacing="${num(px(spacing))}"` : '',
      decoration !== 'none' ? `text-decoration="${esc(decoration)}"` : '',
      fillAttrs(fillColor),
      stroke ? `${fillAttrs(cs.getPropertyValue('-webkit-text-stroke-color'), 'stroke')} stroke-width="${num(stroke)}"` : '',
    ].filter(Boolean).join(' ');
    native += lines.length;
    const texts = (attrs: string) => lines.map((line) => {
      const inner = line.height - (ascent + descent);
      const y = line.top + inner / 2 + ascent;
      return `<text xml:space="preserve" x="${num(line.x)}" y="${num(y)}" ${attrs}>${esc(line.text.replace(/\s+$/, ''))}</text>`;
    }).join('');
    // Text shadows paint under the text, the first one written on top: copies of the lines, moved and blurred.
    const shadowValue = cs.getPropertyValue('text-shadow');
    let under = '';
    if (shadowValue && shadowValue !== 'none' && lines.length) {
      for (const one of splitTop(shadowValue, ',').reverse()) {
        const color = /^(rgba?\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|color\([^)]*\)|#\w+)/.exec(one)?.[1] ?? fillColor;
        const [dx = 0, dy = 0, blur = 0] = one.replace(color, '').trim().split(/\s+/).map(px);
        if (!paint(color)) continue;
        const base = shared.replace(/(^| )fill="[^"]*"( fill-opacity="[^"]*")?/, '').replace(/ ?stroke="[^"]*"( stroke-opacity="[^"]*")? stroke-width="[^"]*"/, '');
        let filter = '';
        if (blur) {
          const id = fresh('t');
          defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${num(blur / 2)}"/></filter>`);
          filter = ` filter="url(#${id})"`;
        }
        native += lines.length;
        under += `<g transform="translate(${num(dx)} ${num(dy)})"${filter}>${texts(`${base} ${fillAttrs(color)}`)}</g>`;
      }
    }
    return under + texts(shared);
  };

  const borders = (b: Box, cs: CSSStyleDeclaration): string | 'mixed' => {
    const sides = ['top', 'right', 'bottom', 'left'].map((side) => ({
      side,
      width: cs.getPropertyValue(`border-${side}-style`) === 'none' ? 0 : px(cs.getPropertyValue(`border-${side}-width`)),
      color: cs.getPropertyValue(`border-${side}-color`),
      style: cs.getPropertyValue(`border-${side}-style`),
    }));
    const visible = sides.filter((s) => s.width > 0 && paint(s.color));
    if (!visible.length) return '';
    const uniform = visible.length === 4 && sides.every((s) => s.width === sides[0]!.width && s.color === sides[0]!.color && s.style === sides[0]!.style);
    // Dashes as Chromium draws them on a side: a dash of 2 (or 3, under 3px) times the width, and the gap
    // stretched so that the side starts and ends with a dash.
    const dash = (s: { style: string; width: number }, length?: number) => {
      if (s.style !== 'dashed' && s.style !== 'dotted') return '';
      const on = s.style === 'dotted' ? s.width : s.width * (s.width >= 3 ? 2 : 3);
      let off = s.style === 'dotted' ? s.width : s.width * (s.width >= 3 ? 1 : 2);
      if (length && length > on) {
        const fewer = Math.floor((length + off) / (on + off));
        const gapFor = (n: number) => (n > 1 ? (length - n * on) / (n - 1) : length);
        const [a, b2] = [gapFor(fewer), gapFor(fewer + 1)];
        off = b2 <= 0 || Math.abs(a - off) < Math.abs(b2 - off) ? a : b2;
      }
      return ` stroke-dasharray="${num(on)} ${num(Math.max(0, off))}"`;
    };
    const patterned = sides.some((s) => s.style === 'dashed' || s.style === 'dotted');
    if (uniform && !(patterned && !b.radii.some(Boolean))) {
      const s = sides[0]!;
      const inset: Box = { x: b.x + s.width / 2, y: b.y + s.width / 2, w: b.w - s.width, h: b.h - s.width, radii: b.radii.map((r) => Math.max(0, r - s.width / 2)) as Box['radii'] };
      return shape(inset, `fill="none" ${fillAttrs(s.color, 'stroke')} stroke-width="${num(s.width)}"${dash(s)}`);
    }
    if (b.radii.some(Boolean)) return 'mixed';
    native += visible.length;
    return visible.map((s) => {
      const half = s.width / 2;
      const coords = s.side === 'top' ? [b.x, b.y + half, b.x + b.w, b.y + half]
        : s.side === 'bottom' ? [b.x, b.y + b.h - half, b.x + b.w, b.y + b.h - half]
          : s.side === 'left' ? [b.x + half, b.y, b.x + half, b.y + b.h]
            : [b.x + b.w - half, b.y, b.x + b.w - half, b.y + b.h];
      return `<line x1="${num(coords[0]!)}" y1="${num(coords[1]!)}" x2="${num(coords[2]!)}" y2="${num(coords[3]!)}" ${fillAttrs(s.color, 'stroke')} stroke-width="${num(s.width)}"${dash(s, s.side === 'top' || s.side === 'bottom' ? b.w : b.h)}/>`;
    }).join('');
  };

  /** A blur over a region, as CSS blurs a shadow: a standard deviation of half the blur radius. */
  const blurFilter = (blur: number, area: Box) => {
    const id = fresh('s');
    const margin = blur * 2;
    defs.push(`<filter id="${id}" filterUnits="userSpaceOnUse" x="${num(area.x - margin)}" y="${num(area.y - margin)}" width="${num(area.w + margin * 2)}" height="${num(area.h + margin * 2)}"><feGaussianBlur stdDeviation="${num(blur / 2)}"/></filter>`);
    return ` filter="url(#${id})"`;
  };

  /**
   * Box shadows, outer or inner. An outer shadow paints only outside the box, as in CSS, so a see-through
   * background does not show it; an inner one paints inside the borders, around a hole the shape of the
   * box moved by the offset and shrunk by the spread.
   */
  const shadows = (b: Box, cs: CSSStyleDeclaration, inset: boolean): string => {
    const value = cs.getPropertyValue('box-shadow');
    if (value === 'none') return '';
    const grow = (box: Box, by: number, dx = 0, dy = 0): Box => ({ x: box.x + dx - by, y: box.y + dy - by, w: Math.max(0, box.w + by * 2), h: Math.max(0, box.h + by * 2), radii: box.radii.map((r) => (r ? Math.max(0, r + by) : 0)) as Box['radii'] });
    const out: string[] = [];
    for (const raw of splitTop(value, ',').reverse()) {
      const isInset = /\binset\b/.test(raw);
      if (isInset !== inset) continue;
      const one = raw.replace(/\binset\b/, '').trim();
      const color = /^(rgba?\([^)]*\)|oklch\([^)]*\)|lab\([^)]*\)|color\([^)]*\)|#\w+)/.exec(one)?.[1] ?? 'rgba(0,0,0,0.5)';
      const lengths = one.replace(color, '').trim().split(/\s+/).map(px);
      const [dx = 0, dy = 0, blur = 0, spread = 0] = lengths;
      const reach = blur * 2 + Math.abs(spread) + Math.abs(dx) + Math.abs(dy) + 1;
      if (!inset) {
        const box = grow(b, spread, dx, dy);
        const around = grow(b, reach);
        const outside = clipTo(`${outlineOf({ ...around, radii: [0, 0, 0, 0] })}${outlineOf(b)}`, true);
        out.push(`<g clip-path="url(#${outside})">${shape(box, `${fillAttrs(color)}${blur ? blurFilter(blur, box) : ''}`)}</g>`);
        continue;
      }
      const inner = paddingBox(b, cs);
      const hole = grow(inner, -spread, dx, dy);
      const around = grow(inner, reach);
      const inside = clipTo(outlineOf(inner));
      native++;
      out.push(`<g clip-path="url(#${inside})"><path d="${outlineOf({ ...around, radii: [0, 0, 0, 0] })}${hole.w && hole.h ? outlineOf(hole) : ''}" fill-rule="evenodd" ${fillAttrs(color)}${blur ? blurFilter(blur, around) : ''}/></g>`);
    }
    return out.join('');
  };

  const backgroundImages = async (el: HTMLElement, b: Box, cs: CSSStyleDeclaration): Promise<string> => {
    const value = cs.getPropertyValue('background-image');
    if (value === 'none') return '';
    let out = '';
    const layers = splitTop(value, ',');
    const positions = splitTop(cs.getPropertyValue('background-position'), ',');
    for (let k = layers.length - 1; k >= 0; k--) {
      const layer = layers[k]!;
      if (layer.startsWith('url(')) {
        const src = /^url\(["']?(.*?)["']?\)$/.exec(layer)?.[1] ?? '';
        const img = new Image();
        img.src = src;
        await img.decode().catch(() => {});
        const href = await toDataUrl(src);
        const size = cs.getPropertyValue('background-size');
        const naturalW = img.naturalWidth || b.w;
        const naturalH = img.naturalHeight || b.h;
        const repeat = cs.getPropertyValue('background-repeat');
        if (size === 'cover' || size === 'contain') {
          const clipId = fresh('c');
          defs.push(`<clipPath id="${clipId}">${shape(b, '')}</clipPath>`);
          native++;
          out += `<image href="${esc(href)}" x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" preserveAspectRatio="xMidYMid ${size === 'cover' ? 'slice' : 'meet'}" clip-path="url(#${clipId})"/>`;
          continue;
        }
        const [sw, sh] = size === 'auto' ? [naturalW, naturalH] : size.split(' ').map((v, i) => (v === 'auto' ? (i === 0 ? naturalW : naturalH) : v.endsWith('%') ? (parseFloat(v) / 100) * (i === 0 ? b.w : b.h) : px(v)));
        const patternId = fresh('p');
        const w = sw ?? naturalW;
        const h = sh ?? (naturalH / naturalW) * w;
        const tile = repeat !== 'no-repeat';
        if (!tile) {
          // One image placed as background-position says, clipped to the box: how a cropped image layer is drawn.
          const [px0 = '0%', py0 = '0%'] = (positions[k] ?? positions[0] ?? '0% 0%').trim().split(/\s+/);
          const offset = (v: string, room: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * room : px(v));
          const clipId = fresh('c');
          defs.push(`<clipPath id="${clipId}">${shape(b, '')}</clipPath>`);
          native++;
          out += `<image href="${esc(href)}" x="${num(b.x + offset(px0, b.w - w))}" y="${num(b.y + offset(py0, b.h - h))}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none" clip-path="url(#${clipId})"/>`;
          continue;
        }
        defs.push(`<pattern id="${patternId}" patternUnits="userSpaceOnUse" x="${num(b.x)}" y="${num(b.y)}" width="${num(tile ? w : b.w)}" height="${num(tile ? h : b.h)}"><image href="${esc(href)}" x="0" y="0" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/></pattern>`);
        out += shape(b, `fill="url(#${patternId})"`);
      } else {
        const id = gradient(layer, b);
        if (id) out += shape(b, `fill="url(#${id})"`);
      }
    }
    return out;
  };

  const inlineSvg = (root: SVGSVGElement, r: DOMRect): string => {
    const clone = root.cloneNode(true) as SVGSVGElement;
    const prefix = fresh('v');
    // Ids must stay unique across the whole file, and references must follow them.
    const ids = new Map<string, string>();
    for (const n of clone.querySelectorAll('[id]')) {
      const id = `${prefix}-${n.id}`;
      ids.set(n.id, id);
      n.id = id;
    }
    for (const n of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of [...n.attributes]) {
        if (!attr.value.includes('#')) continue;
        attr.value = attr.value.replace(/url\(\s*["']?#([^"')\s]+)["']?\s*\)/g, (m, id: string) => (ids.has(id) ? `url(#${ids.get(id)})` : m)).replace(/^#(.+)$/, (m, id: string) => (ids.has(id) ? `#${ids.get(id)}` : m));
      }
    }
    if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    clone.setAttribute('x', num(r.left));
    clone.setAttribute('y', num(r.top));
    clone.setAttribute('width', num(r.width));
    clone.setAttribute('height', num(r.height));
    clone.removeAttribute('style');
    native++;
    return new XMLSerializer().serializeToString(clone);
  };

  const paintOrder = (kids: Element[]): Element[] => {
    const level = (el: Element) => {
      const s = getComputedStyle(el);
      const z = s.getPropertyValue('z-index');
      if (z !== 'auto' && parseInt(z, 10) < 0) return parseInt(z, 10) - 1_000_000;
      if (z !== 'auto') return parseInt(z, 10) + 1;
      return s.getPropertyValue('position') === 'static' && s.getPropertyValue('float') === 'none' ? 0 : 1;
    };
    return kids.map((el, i) => ({ el, i, z: level(el) })).sort((a, b) => a.z - b.z || a.i - b.i).map((k) => k.el);
  };

  const convert = async (el: Element): Promise<string> => {
    if (el.tagName.toLowerCase() === 'br' || el.tagName.toLowerCase() === 'wbr') return '';
    const cs = getComputedStyle(el);
    if (cs.getPropertyValue('display') === 'none' || cs.getPropertyValue('visibility') === 'hidden') return '';
    const html = el as HTMLElement;

    // Reads the layout without this element's transform. Its group gets the transform back, once.
    const transform = cs.getPropertyValue('transform');
    const individual = ['rotate', 'scale', 'translate'].filter((p) => cs.getPropertyValue(p) !== 'none');
    const restores: (() => void)[] = [];
    let matrix = '';
    if (transform !== 'none' || individual.length) {
      const m = new DOMMatrix(transform === 'none' ? '' : transform);
      const props = ['transform', ...individual];
      for (const p of props) {
        const value = html.style.getPropertyValue(p);
        const priority = html.style.getPropertyPriority(p);
        html.style.setProperty(p, 'none', 'important');
        restores.push(() => {
          if (value) html.style.setProperty(p, value, priority);
          else html.style.removeProperty(p);
        });
      }
      const r0 = html.getBoundingClientRect();
      const [ox = 0, oy = 0] = cs.getPropertyValue('transform-origin').split(' ').map(px);
      const originX = r0.left + ox;
      const originY = r0.top + oy;
      matrix = `translate(${num(originX)} ${num(originY)}) matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((n) => Math.round(n * 1e6) / 1e6).join(' ')}) translate(${num(-originX)} ${num(-originY)})`;
    }

    try {
      const r = html.getBoundingClientRect();
      const reason = blocker(el, cs);
      if (reason) return await wrap(await foreign(html, r, reason), cs, matrix, null, false);
      const b = boxOf(r, cs);
      const tag = el.tagName.toLowerCase();
      // The element's own paint, in CSS order: outer shadows, background, inner shadows, borders. Then its content.
      let own = '';
      let content = '';
      if (cs.getPropertyValue('display') !== 'inline' || r.width) {
        own += shadows(b, cs, false);
        const bgColor = paint(cs.getPropertyValue('background-color'));
        if (bgColor) own += shape(b, fillAttrs(cs.getPropertyValue('background-color')));
        own += await backgroundImages(html, b, cs);
        own += shadows(b, cs, true);
      }
      const edge = borders(b, cs);
      if (edge === 'mixed') return await wrap(await foreign(html, r, 'different borders on rounded corners'), cs, matrix, b, false);
      own += edge;
      if (tag === 'img') {
        const img = el as HTMLImageElement;
        if (img.currentSrc || img.src) {
          const fit = cs.getPropertyValue('object-fit');
          const aspect = fit === 'contain' ? 'xMidYMid meet' : fit === 'fill' ? 'none' : fit === 'none' ? 'xMidYMid slice' : 'xMidYMid slice';
          let clip = '';
          if (b.radii.some(Boolean)) {
            const id = fresh('c');
            defs.push(`<clipPath id="${id}">${shape(b, '')}</clipPath>`);
            clip = ` clip-path="url(#${id})"`;
          }
          native++;
          content += `<image href="${esc(await toDataUrl(img.currentSrc || img.src))}" x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" preserveAspectRatio="${aspect}"${clip}/>`;
        }
      } else if (tag === 'video') {
        const video = el as HTMLVideoElement;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 1;
          canvas.height = video.videoHeight || 1;
          canvas.getContext('2d')!.drawImage(video, 0, 0);
          native++;
          content += `<image href="${canvas.toDataURL('image/png')}" x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" preserveAspectRatio="xMidYMid slice"/>`;
          fallbacks.push({ id: el.getAttribute('data-bogen-id') ?? '', name: 'Video', reason: 'a video becomes a picture of its first frame' });
        } catch {
          return await wrap(await foreign(html, r, 'a video that could not be drawn'), cs, matrix, b, false);
        }
      } else {
        const svg = el.querySelector(':scope > svg');
        if (svg && el.hasAttribute('data-bogen-id') && el.children.length === 1) content += inlineSvg(svg as SVGSVGElement, r);
        else {
          const kids: Node[] = [...el.childNodes];
          const elements = paintOrder(kids.filter((n): n is Element => n.nodeType === 1));
          // Text of this element paints before positioned children, after plain ones. Reading order is close.
          for (const n of kids) if (n.nodeType === 3) content += textOf(n as Text, cs);
          const childOut: string[] = [];
          for (const child of elements) childOut.push(await convert(child));
          content += childOut.join('');
        }
      }
      // Overflow clips the content to the box inside the borders, not the element's own shadows.
      const overflow = cs.getPropertyValue('overflow-x') !== 'visible' || cs.getPropertyValue('overflow-y') !== 'visible';
      if (overflow && content) content = `<g clip-path="url(#${clipTo(outlineOf(paddingBox(b, cs)))})">${content}</g>`;
      return await wrap(own + content, cs, matrix, b, true);
    } finally {
      for (const restore of restores) restore();
    }
  };

  /** Opacity, the transform, a blur and a mask, on one group around what an element drew. */
  const wrap = async (body: string, cs: CSSStyleDeclaration, matrix: string, b: Box | null, masks: boolean): Promise<string> => {
    if (!body) return '';
    const opacity = parseFloat(cs.getPropertyValue('opacity'));
    const attrs: string[] = [];
    if (opacity < 1) attrs.push(`opacity="${num(opacity)}"`);
    if (matrix) attrs.push(`transform="${matrix}"`);
    const filter = /^blur\(([\d.]+)px\)$/.exec(cs.getPropertyValue('filter'));
    if (filter) {
      const id = fresh('b');
      defs.push(`<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${num(parseFloat(filter[1]!))}"/></filter>`);
      attrs.push(`filter="url(#${id})"`);
    }
    const layer = masks && b ? maskGradient(cs) : null;
    if (layer && layer !== 'other' && b) {
      // A luminance mask of white: what shows is the gradient's alpha, over the border box only.
      const gradientId = gradient(layer, { ...b, radii: [0, 0, 0, 0] }, true);
      if (gradientId) {
        const id = fresh('m');
        defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}"><rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" fill="url(#${gradientId})"/></mask>`);
        attrs.push(`mask="url(#${id})"`);
      }
    }
    return attrs.length ? `<g ${attrs.join(' ')}>${body}</g>` : body;
  };

  /** The text a computed `content` value shows, or null for what is more than strings and attributes. */
  const contentText = (value: string, host: Element): string | null => {
    let out = '';
    let rest = value.trim();
    while (rest) {
      const str = /^"((?:[^"\\]|\\.)*)"\s*/.exec(rest);
      if (str) {
        out += str[1]!.replace(/\\([\da-fA-F]{1,6})\s?|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch!));
        rest = rest.slice(str[0].length);
        continue;
      }
      const attr = /^attr\(\s*([\w-]+)\s*\)\s*/.exec(rest);
      if (attr) {
        out += host.getAttribute(attr[1]!) ?? '';
        rest = rest.slice(attr[0].length);
        continue;
      }
      return null;
    }
    return out;
  };

  /**
   * `::before` and `::after` made into real elements for the walk: a span with the pseudo-element's
   * computed style and its text, while a rule hides the pseudo-element itself, so the layout stays as it
   * was. Content other than strings and attributes (counters, quotes, images) stays a pseudo-element, and
   * its layer goes over as HTML. Gives a function that puts everything back.
   */
  const materializePseudo = (roots: Element[]): (() => void) => {
    const made: Element[] = [];
    const hosts: Element[] = [];
    const sheet = document.createElement('style');
    sheet.textContent = '[data-bogen-pseudo-off~="before"]::before,[data-bogen-pseudo-off~="after"]::after{content:none!important}';
    const skip = /^(img|input|textarea|select|video|iframe|canvas|svg|br|wbr|hr|object|embed)$/i;
    const plan: { host: Element; which: 'before' | 'after'; style: [string, string][]; text: string }[] = [];
    // All of it is read before anything is changed, so one span cannot move what the next one reads.
    for (const root of roots) {
      for (const host of [root, ...root.querySelectorAll('*')]) {
        if (skip.test(host.tagName) || host.closest('svg')) continue;
        for (const which of ['before', 'after'] as const) {
          const pcs = getComputedStyle(host, `::${which}`);
          const content = pcs.getPropertyValue('content');
          if (!content || content === 'none' || content === 'normal') continue;
          if (pcs.getPropertyValue('display') === 'none') continue;
          const text = contentText(content, host);
          if (text === null) continue;
          const style: [string, string][] = [];
          for (let i = 0; i < pcs.length; i++) {
            const name = pcs[i]!;
            if (name === 'content' || name.startsWith('--')) continue;
            style.push([name, pcs.getPropertyValue(name)]);
          }
          plan.push({ host, which, style, text });
        }
      }
    }
    if (!plan.length) return () => {};
    document.head.appendChild(sheet);
    for (const { host, which, style, text } of plan) {
      const span = document.createElement('span');
      span.setAttribute('data-bogen-pseudo', which);
      for (const [name, value] of style) span.style.setProperty(name, value);
      if (text) span.textContent = text;
      if (which === 'before') host.insertBefore(span, host.firstChild);
      else host.appendChild(span);
      made.push(span);
      const off = host.getAttribute('data-bogen-pseudo-off');
      host.setAttribute('data-bogen-pseudo-off', off ? `${off} ${which}` : which);
      hosts.push(host);
    }
    return () => {
      for (const span of made) span.remove();
      for (const host of hosts) host.removeAttribute('data-bogen-pseudo-off');
      sheet.remove();
    };
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const parts: string[] = [];
  const roots = args.ids.map((id) => document.querySelector(`[data-bogen-id="${id}"]`)).filter((el): el is Element => Boolean(el));
  const putBack = materializePseudo(roots);
  try {
    for (const el of roots) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right);
      maxY = Math.max(maxY, r.bottom);
      parts.push(await convert(el));
    }
  } finally {
    putBack();
  }
  if (minX === Infinity) throw new Error('Nothing to export: the target is hidden or has no size.');
  const w = Math.ceil(maxX - minX);
  const h = Math.ceil(maxY - minY);
  const css = `${args.faces}\n${args.css}`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const head = `<defs><style>${css}</style>${defs.join('')}</defs>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${num(minX)} ${num(minY)} ${w} ${h}">${head}${parts.join('')}</svg>`;
  return { svg, fallbacks, native };
}
