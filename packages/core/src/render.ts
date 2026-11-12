import { BogenDoc, type BogenNode } from './doc.ts';
import { escapeAttr, escapeHtml, kebabCss, styleToCss } from './css.ts';
import { effectiveMode, getModes, getTextStyles, isModeName, overrideFamilies, textStyleClass, textStylesCss, themeCss } from './design-system.ts';
import { fontFacesCss, hostedFamilies } from './font-faces.ts';
import { keptAttr, keyframesName, safeTag, safeUrl, sanitizeSvgMarkup } from './html-import.ts';
import { runsToHtml, textRuns, type TextRun } from './rich-text.ts';
import { codeComponentName, codeFrameUrl } from './code-components.ts';
import { layerRulesCss, ruleScopeClass, type RulesCssOptions } from './layer-rules.ts';
import type { MotionHandoff } from './motion.ts';
import { CROP_ATTR, cropStyle, parseCrop } from './image-crop.ts';

// Here and not in index.ts, which other work changes often: the rules model is part of rendering.
export * from './layer-rules.ts';

/**
 * The one place that decides how a layer becomes an element. The canvas, headless screenshots
 * and exports all go through it, so what you see is what ships.
 */
export interface RenderSpec {
  tag: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  text?: string;
  /** Sanitized markup, already safe to inject. */
  html?: string;
  /** A text layer with ranges: `html` is these as markup, and `text` is not set. */
  runs?: TextRun[];
}

const NO_NATIVE_ATTRS = new Set(['type', 'colors']);

/** Rewrites `bogen-asset:<name>` to a URL the context can load. */
export type AssetResolver = (src: string) => string;
const identity: AssetResolver = (s) => s;

export function renderSpec(node: BogenNode, resolve: AssetResolver = identity): RenderSpec {
  const style: Record<string, string> = { ...node.style };
  if (resolve !== identity) {
    // Image fills and masks refer to assets from inside a CSS value.
    for (const [k, v] of Object.entries(style)) {
      if (v.includes('bogen-asset:')) style[k] = v.replace(/bogen-asset:[^"')\s]+/g, (src) => resolve(src));
    }
  }
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    if (node.type === 'shader' && NO_NATIVE_ATTRS.has(k)) continue;
    // An anchor target of a captured page, so that same-page links keep working in an export.
    if (k === 'id') {
      if (node.type !== 'shader' && /^[A-Za-z][\w-]{0,100}$/.test(v)) attrs.id = v;
      continue;
    }
    // Documents arrive from other people's files and peers, so stored fields are never trusted.
    if (node.type === 'shader' || !keptAttr(k, v)) continue;
    if (k === 'href' || k === 'poster') {
      const url = safeUrl(v);
      if (url) attrs[k] = url;
    } else attrs[k] = v;
  }
  const src = safeUrl(node.src);
  if (node.hidden) style.display = 'none';
  // Both are stored text that ends up in attributes, and both are checked against what they can be.
  if (node.mode && isModeName(node.mode)) attrs['data-mode'] = node.mode;
  const textClass = node.textStyle ? textStyleClass(node.textStyle) : undefined;
  // The class that the layer's pseudo-elements and conditional styles are written for. A hidden layer shows none of them.
  const rulesClass = node.rules && !node.hidden ? ruleScopeClass(node.id) : undefined;
  if (textClass || rulesClass) attrs.class = [textClass, rulesClass].filter(Boolean).join(' ');

  switch (node.type) {
    case 'text':
      if (!style.whiteSpace) style.whiteSpace = 'pre-wrap';
      if (node.spans?.length) {
        const runs = textRuns(node.text ?? '', node.spans);
        if (runs.some((r) => r.href || Object.keys(r.style).length)) return { tag: safeTag(node.tag), style, attrs, runs, html: runsToHtml(runs) };
      }
      return { tag: safeTag(node.tag), style, attrs, text: node.text ?? '' };
    case 'image':
      if (!src) return imagePlaceholder(style, attrs);
      {
        const crop = parseCrop(attrs[CROP_ATTR]);
        if (crop) {
          // One element with the image as its background: plain CSS, the same in every export. See image-crop.ts.
          // The crop itself is in the style now, so the attribute stays in the document and out of exports.
          const { alt, [CROP_ATTR]: _crop, ...rest } = attrs;
          delete style.objectFit;
          delete style.objectPosition;
          return {
            tag: 'span',
            style: { ...style, display: style.display ?? 'block', ...cropStyle(resolve(src), crop) },
            attrs: { ...rest, role: 'img', 'aria-label': alt ?? '' },
          };
        }
      }
      if (!style.objectFit) style.objectFit = 'cover';
      attrs.src = resolve(src);
      if (!attrs.alt) attrs.alt = '';
      return { tag: 'img', style, attrs };
    case 'video':
      if (src) attrs.src = resolve(src);
      return { tag: 'video', style, attrs: { muted: '', loop: '', autoplay: '', playsinline: '', ...attrs } };
    case 'embed':
      // The person's own component: its code runs only inside the sandbox, with no access to this origin.
      if (node.code) return { tag: 'iframe', style: { display: 'block', border: '0', ...style }, attrs: { ...attrs, src: codeFrameUrl(node.code), sandbox: 'allow-scripts', title: node.name, 'data-bogen-code': codeComponentName(node.code) } };
      if (src) attrs.src = resolve(src);
      return { tag: 'iframe', style, attrs: { ...attrs, sandbox: 'allow-scripts', loading: 'lazy' } };
    case 'svg':
      // A span: an svg layer may sit in a <p>, and a div there would end the paragraph on parsing.
      return { tag: 'span', style: { display: 'block', ...style }, attrs, html: sanitizeSvgMarkup(node.svg ?? '', node.id) };
    case 'shader':
      return { tag: 'div', style, attrs: { 'data-shader': node.attrs?.type ?? '' } };
    default:
      return { tag: safeTag(node.tag), style, attrs };
  }
}

/**
 * An image with no src yet, for a draft: a plain frame that says what goes there and its size, in the colour and
 * font of what is around it, so that it follows the brand. A span, as an img would be, so it may sit in a <p>.
 */
function imagePlaceholder(style: Record<string, string>, attrs: Record<string, string>): RenderSpec {
  const px = (v: string | undefined) => (v && /^\d+(\.\d+)?px$/.test(v) ? Math.round(parseFloat(v)) : undefined);
  const width = px(style.width);
  const height = px(style.height);
  const label = [attrs.alt?.trim() || 'Image', width && height ? `${width} × ${height}` : ''].filter(Boolean).join(', ');
  // The stand-in is a span: an image's own attributes mean nothing on it, and a typed project refuses them.
  for (const k of ['alt', 'loading', 'decoding', 'fetchpriority', 'width', 'height']) delete attrs[k];
  return {
    tag: 'span',
    style: {
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      border: '1px dashed color-mix(in srgb, currentColor 35%, transparent)',
      color: 'color-mix(in srgb, currentColor 65%, transparent)',
      fontSize: '12px',
      lineHeight: '1.3',
      minHeight: '24px',
      ...style,
      display: style.display === 'none' ? 'none' : 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      boxSizing: 'border-box',
      overflow: 'hidden',
    },
    attrs: { ...attrs, role: 'img', 'aria-label': label },
    text: label,
  };
}

const PHRASING = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'del', 'dfn', 'em', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'video', 'wbr']);
const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

export interface HtmlOptions {
  resolve?: AssetResolver;
  /** Adds `data-bogen-id` so headless Chromium can find layers. */
  ids?: boolean;
  /** Skips the root's own position, for handing a layer to code. */
  stripRootPosition?: boolean;
  indent?: boolean;
  /** For `nodeToHtml`: the layers' pseudo-elements and conditional styles as a `<style>` before the root. On unless false. */
  ruleStyles?: boolean;
  /** Motion written as classes instead of inline (motion.ts). Its CSS goes wherever the caller puts it. */
  motion?: MotionHandoff;
  /**
   * For a page people load over a network: images get their intrinsic width and height (so the layout does not jump
   * while they load), `decoding="async"`, and `loading="lazy"` after the first `eager` ones, the very first with
   * `fetchpriority="high"`. Attributes a layer already has win. Off for screenshots, which need every image now.
   */
  images?: { size?: (src: string) => { width: number; height: number } | undefined; eager?: number; seen?: number };
  /** For a page that goes on the web: an artboard root grows with the window up to its design width (fluidPageStyle). */
  fluidRoot?: boolean;
}

const POSITION_KEYS = ['position', 'left', 'top', 'right', 'bottom'];

/** Marks an artboard as a web page: in an export it is as wide as the window, up to its design width. */
export const WEB_PAGE_ATTR = 'data-web';

export function isWebPage(node: Pick<BogenNode, 'artboard' | 'attrs'>): boolean {
  return Boolean(node.artboard && node.attrs?.[WEB_PAGE_ATTR] === 'page');
}

/**
 * A web page handed to code: on the canvas an artboard is as wide as its design, on the web the page is as wide as the
 * window. Only an artboard marked as a web page (`data-web="page"`, set by section_insert and web_page_set) changes:
 * its fixed width becomes the most it grows to (width 100%, max-width, centred) and a fixed height the least it takes
 * (min-height), so its own grids, container and media queries meet real widths. Every other artboard, an app screen,
 * a poster, a slide, keeps the size it was designed at.
 */
export function fluidPageStyle(node: Pick<BogenNode, 'artboard' | 'attrs'>, style: Record<string, string>): Record<string, string> {
  if (!isWebPage(node)) return style;
  const width = /^\d+(\.\d+)?px$/.test(style.width ?? '') ? style.width! : undefined;
  if (!width) return style;
  const out: Record<string, string> = { ...style, width: '100%', maxWidth: style.maxWidth ?? width, marginInline: style.marginInline ?? 'auto' };
  if (/^\d+(\.\d+)?px$/.test(style.height ?? '')) {
    out.minHeight = style.minHeight ?? style.height!;
    delete out.height;
  }
  return out;
}

/** An attribute that is present without a value, in a form JSX and React's types accept: popover means popover="auto". */
export function jsxBooleanAttr(name: string): string | null {
  return name === 'popover' ? 'auto' : null;
}

/** A layer and its descendants as HTML with inline styles. */
export function nodeToHtml(doc: BogenDoc, id: string, options: HtmlOptions = {}, depth = 0): string {
  const node = doc.getNode(id);
  if (!node) return '';
  const spec = renderSpec(node, options.resolve);
  const style = { ...spec.style };
  if (options.stripRootPosition && depth === 0) for (const k of POSITION_KEYS) delete style[k];
  if (options.fluidRoot && depth === 0) {
    const fluid = fluidPageStyle(node, style);
    for (const k of Object.keys(style)) if (!(k in fluid)) delete style[k];
    Object.assign(style, fluid);
  }
  const moving = options.motion?.layers.get(id);
  if (moving) {
    for (const k of moving.strip) delete style[k];
    if (moving.className) spec.attrs.class = [spec.attrs.class, moving.className].filter(Boolean).join(' ');
  }
  const pad = options.indent ? '  '.repeat(depth) : '';
  const nl = options.indent ? '\n' : '';
  if (depth === 0 && options.ruleStyles !== false) {
    const css = rulesCss(doc, [id]);
    if (css) return `${pad}<style>${nl}${css}${nl}${pad}</style>${nl}${nodeToHtml(doc, id, { ...options, ruleStyles: false }, depth)}`;
  }
  // A part of a page keeps the mode it has there, in an export or a screenshot of only that part.
  if (depth === 0 && !spec.attrs['data-mode']) {
    const mode = effectiveMode(doc, id);
    if (mode && isModeName(mode)) spec.attrs['data-mode'] = mode;
  }
  if (spec.tag === 'img' && options.images && spec.attrs.src) {
    const state = options.images;
    state.seen = (state.seen ?? 0) + 1;
    spec.attrs.decoding ??= 'async';
    spec.attrs.loading ??= state.seen <= (state.eager ?? 1) ? 'eager' : 'lazy';
    if (state.seen === 1) spec.attrs.fetchpriority ??= 'high';
    const size = node.src ? state.size?.(node.src) : undefined;
    if (size && spec.attrs.width === undefined && spec.attrs.height === undefined) {
      spec.attrs.width = String(size.width);
      spec.attrs.height = String(size.height);
    }
  }
  let attrs = Object.entries(spec.attrs).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)).join('');
  if (options.ids) attrs += ` data-bogen-id="${id}"`;
  const css = styleToCss(style);
  if (css) attrs += ` style="${escapeAttr(css)}"`;
  // The DOM allows blocks inside a <p> but the HTML parser closes the paragraph at the first one,
  // which would make exports and screenshots differ from the canvas.
  const breaksParagraph = spec.tag === 'p' && spec.text === undefined && doc.getChildren(id).some((c) => !PHRASING.has(renderSpec(c).tag));
  if (breaksParagraph) spec.tag = 'div';
  const open = `${pad}<${spec.tag}${attrs}>`;
  if (VOID.has(spec.tag)) return open;
  if (spec.html !== undefined) return `${open}${spec.html}</${spec.tag}>`;
  if (spec.text !== undefined) return `${open}${escapeHtml(spec.text).replace(/\n/g, '<br>')}</${spec.tag}>`;
  const children = doc.getChildren(id).map((c) => nodeToHtml(doc, c.id, options, depth + 1)).join(nl);
  return children ? `${open}${nl}${children}${nl}${pad}</${spec.tag}>` : `${open}</${spec.tag}>`;
}

/**
 * The style sheet of every layer's rules under these roots, through `layerRulesCss`. Media queries stay
 * as written unless `media` is `artboard`, which reads them against each layer's top-level layer.
 */
export function rulesCss(doc: BogenDoc, rootIds: string[], options: Omit<RulesCssOptions, 'artboard' | 'token'> = {}): string {
  const tokens = new Map(doc.getTokens().map((t) => [t.name, t.value]));
  const out: string[] = [];
  const done = new Set<string>();
  for (const root of rootIds) {
    const topId = doc.ancestors(root).at(-1) ?? root;
    const top = doc.getNode(topId);
    const visit = (n: BogenNode) => {
      if (n.rules && !n.hidden) {
        const artboard = top ? { id: top.id, style: top.style, self: n.id === top.id } : undefined;
        const css = layerRulesCss(n.id, n.rules, { ...options, token: (name) => tokens.get(name), ...(artboard ? { artboard } : {}) });
        if (css) out.push(css);
      }
      for (const c of doc.getChildren(n.id)) visit(c);
    };
    const node = doc.getNode(root);
    if (node && !done.has(root)) {
      done.add(root);
      visit(node);
    }
  }
  // The rule that makes an artboard a container comes once per artboard, however many layers ask for it.
  return [...new Set(out.join('\n').split('\n'))].join('\n');
}

export function tokensCss(doc: BogenDoc, selector = ':root'): string {
  return themeCss(doc.getTokens(), getModes(doc), { selector });
}

export function keyframesCss(doc: BogenDoc): string {
  const kf = doc.meta.get('keyframes');
  // Stored fields are never trusted: this text goes into a style element.
  return Array.isArray(kf) ? kf.filter((k): k is string => typeof k === 'string' && keyframesName(k) !== null).join('\n') : '';
}

/**
 * Base rules a canvas world needs. `box-sizing` and `margin` differ from browser defaults so that
 * layers measure what the inspector says; `exportDocument` emits the same rules.
 */
export const RESET_CSS = '*,*::before,*::after{box-sizing:border-box}body,h1,h2,h3,h4,h5,h6,p,ul,ol,li,figure,blockquote,dl,dd{margin:0;padding:0}ul,ol{list-style:none}button{font:inherit;color:inherit;background:none;border:0;padding:0}a{color:inherit;text-decoration:none}img,svg,video{display:block}';

export function fontLinks(doc: BogenDoc): string[] {
  const families = new Set<string>();
  const visit = (n: BogenNode) => {
    const f = n.style.fontFamily;
    if (f) families.add(f.split(',')[0]!.trim().replace(/^["']|["']$/g, ''));
    for (const o of overrideFamilies(n)) families.add(o.split(',')[0]!.trim().replace(/^["']|["']$/g, ''));
    // A pseudo-element or a condition can use a font of its own, which has to load like any other.
    for (const style of Object.values(n.rules ?? {})) if (style.fontFamily) families.add(style.fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, ''));
  };
  for (const s of getTextStyles(doc)) {
    const f = s.style.fontFamily;
    if (f) families.add(f.split(',')[0]!.trim().replace(/^["']|["']$/g, ''));
  }
  doc.nodes.forEach((_, id) => {
    const n = doc.getNode(id);
    if (n) visit(n);
  });
  const hosted = hostedFamilies(doc);
  return [...families].filter((f) => f && !GENERIC_FAMILIES.has(f.toLowerCase()) && !f.startsWith('var(') && !hosted.has(f.toLowerCase()));
}

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'inherit', 'initial']);

/** Complete standalone document for one page or layer. Used for screenshots and HTML export. */
export function exportDocument(doc: BogenDoc, rootIds: string[], options: HtmlOptions & { title?: string; extraHead?: string; background?: string; media?: RulesCssOptions['media']; webHead?: boolean } = {}): string {
  const body = rootIds.map((id) => nodeToHtml(doc, id, { ...options, ruleStyles: false })).join(options.indent ? '\n' : '');
  const css = [fontFacesCss(doc, options.resolve), RESET_CSS, tokensCss(doc), textStylesCss(getTextStyles(doc)), keyframesCss(doc), rulesCss(doc, rootIds, { media: options.media ?? 'viewport' })].filter(Boolean).join('\n');
  const bg = options.background ? `<style>html,body{background:${escapeAttr(options.background)}}</style>` : '';
  const head = options.webHead ? webHead(doc, rootIds) : { html: '', title: undefined, lang: undefined };
  const lang = head.lang ? ` lang="${escapeAttr(head.lang)}"` : '';
  return `<!doctype html><html${lang}><head><meta charset="utf-8">${head.html}<title>${escapeHtml(options.title ?? head.title ?? 'Bogen')}</title><style>${css}</style>${bg}${options.extraHead ?? ''}</head><body>${body}</body></html>`;
}

/**
 * The head a page needs on the web, from a root marked as a web page: a viewport that follows the device (without it a
 * phone lays the page out 980 px wide and shrinks it), the page's language for screen readers and hyphenation, its
 * name as the title, and its description. Nothing for an artboard that is not a web page.
 */
function webHead(doc: BogenDoc, rootIds: string[]): { html: string; title?: string; lang?: string } {
  const page = rootIds.map((id) => doc.getNode(id)).find((n) => n && isWebPage(n));
  if (!page) return { html: '' };
  const description = page.attrs?.['data-description'];
  return {
    html: `<meta name="viewport" content="width=device-width, initial-scale=1">${description ? `<meta name="description" content="${escapeAttr(description)}">` : ''}`,
    title: page.name,
    ...(page.attrs?.lang ? { lang: page.attrs.lang } : {}),
  };
}

export { kebabCss };
