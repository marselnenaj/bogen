import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';
import { Element, isTag, isText, type ChildNode } from 'domhandler';
import { escapeAttr, escapeHtml, parseStyle, styleToCss } from './css.ts';
import { KEPT_ATTRS, safeUrl } from './html-import.ts';

/**
 * The last pass over a page before it is published as a website or shared with a client. It takes the
 * page `exportDocument` wrote with `ids`, and gives back HTML and one style sheet that a browser can show
 * under `default-src 'none'` with styles, images and fonts from the site itself:
 *
 * - no scripts, event handlers, comments, `data-*` attributes (but `data-mode`, which theme modes need),
 *   layer ids or rule classes named after them;
 * - every inline style moved into the style sheet as a class, since `style-src 'self'` refuses inline styles;
 * - every image, video and font address turned into a file of the site, or dropped;
 * - hidden layers and proposals left out, shaders shown as their still, code components in sandboxed frames
 *   of the site, and embeds of other sites left out.
 *
 * Nothing here trusts the document: stored values were checked when they were written, and are checked again.
 */

export interface PublishLayer {
  /** Left out: hidden layers, proposals, a brand guideline's counter-examples. */
  drop?: boolean;
  /** A shader, shown as this picture. A path of the site. */
  still?: string;
  /** A code component, shown by this frame of the site. A path. */
  frame?: string;
}

export interface CleanOptions {
  title: string;
  /** What each layer becomes, by the id `exportDocument` wrote with `ids`. */
  layer: (id: string) => PublishLayer;
  /** A site path for an image, video or font address, or null to drop it. Called with what `publishUrls` found. */
  url: (url: string) => string | null;
  /** The path of the style sheet, relative to the page. */
  stylesheet: string;
  /** `fluid` lets the top-level layers fill the window's width; `fixed` keeps the drawn size, centred. */
  fit?: 'fluid' | 'fixed';
  /** The page's own CSP as a meta element, for hosts that send no headers. Off for none. */
  csp?: string | null;
  /** Ids that must not be in the result: every layer, page and file id of the document. */
  forbidden?: Iterable<string>;
}

export interface CleanedPage {
  html: string;
  css: string;
  /** What was left out or changed, for the person to read. */
  notes: string[];
}

const DROPPED = new Set(['script', 'noscript', 'template', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'portal', 'frame', 'frameset', 'title', 'head']);
const URL_ATTRS = new Set(['src', 'poster']);
/** What renderSpec writes besides `KEPT_ATTRS`, and nothing that runs. */
const EXTRA_ATTRS = new Set(['src', 'playsinline', 'loading', 'id', 'lang', 'dir', 'width', 'height']);
const ANCHOR_ID = /^[A-Za-z][\w-]{0,100}$/;
const MODE = /^[A-Za-z][\w-]{0,40}$/;
const POSITION = ['position', 'left', 'top', 'right', 'bottom', 'inset'];
const UNSAFE_CSS = /expression\s*\(|javascript:|@import|<\/?style|behavior\s*:|-moz-binding/i;

/** Addresses of images, videos and fonts that a page uses, so that the caller can make files of them first. */
export function publishUrls(html: string): string[] {
  const found = new Set<string>();
  const doc = parseDocument(html);
  const visit = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isTag(n)) continue;
      for (const [k, v] of Object.entries(n.attribs)) {
        const name = k.toLowerCase();
        if (URL_ATTRS.has(name) || ((name === 'href' || name === 'xlink:href') && n.name.toLowerCase() === 'image')) found.add(v.trim());
        if (name === 'style') for (const u of cssUrls(v)) found.add(u);
      }
      if (n.name.toLowerCase() === 'style') for (const c of n.children) if (isText(c)) for (const u of cssUrls(c.data)) found.add(u);
      visit(n.children);
    }
  };
  visit(doc.children);
  return [...found].filter((u) => u && !u.startsWith('#'));
}

const URL_IN_CSS = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi;

function cssUrls(css: string): string[] {
  return [...css.matchAll(URL_IN_CSS)].map((m) => m[2]!.trim()).filter(Boolean);
}

/** Every `url()` in a piece of CSS through `map`; one that maps to nothing becomes `none`, which is still valid CSS. */
function rewriteCssUrls(css: string, map: (url: string) => string | null): string {
  return css.replace(URL_IN_CSS, (_all, _q, raw: string) => {
    const to = raw.trim().startsWith('#') ? raw.trim() : map(raw.trim());
    return to ? `url("${to.replace(/["\\\n]/g, '')}")` : 'none';
  });
}

/** CSS without its comments, leaving strings alone. */
export function stripCssComments(css: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < css.length) out += css[++i];
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else out += c;
  }
  return out;
}

/** Drops whole statements that could reach outside the sheet, such as `@import`. */
function safeSheet(css: string): string {
  return css.split('\n').filter((line) => !UNSAFE_CSS.test(line)).join('\n');
}

/** An inline style as declarations a class can carry: nothing that could close the block or run anything. */
function cleanDeclarations(style: string): string {
  if (!/[{}<]/.test(style) && !UNSAFE_CSS.test(style)) return style.trim().replace(/;\s*$/, '');
  const parsed = parseStyle(style);
  for (const [k, v] of Object.entries(parsed)) if (/[{}<]/.test(v) || UNSAFE_CSS.test(v)) delete parsed[k];
  return styleToCss(parsed);
}

/** A top-level layer as a page of its own: in the flow, and as wide as the window when fluid. */
function rootStyle(style: string, fit: 'fluid' | 'fixed'): { style: string; background?: string } {
  const parsed = parseStyle(style);
  for (const k of POSITION) delete parsed[k];
  const background = parsed.backgroundColor ?? (parsed.background && !/url\(/i.test(parsed.background) ? parsed.background : undefined);
  if (fit === 'fluid') {
    parsed.width = '100%';
    if (parsed.height && /^\d+(\.\d+)?px$/.test(parsed.height)) {
      parsed.minHeight = parsed.height;
      delete parsed.height;
    }
    parsed.margin = '0';
  } else parsed.margin = '0 auto';
  parsed.position = 'relative';
  return { style: styleToCss(parsed), ...(background && !/[{}<;]/.test(background) ? { background } : {}) };
}

function attrValue(v: string): string {
  return escapeAttr(v);
}

/** The cleaned page, or an error when something that must not leave the machine is still in it. */
export function cleanPublishedPage(source: string, options: CleanOptions): CleanedPage {
  const notes = new Set<string>();
  const fit = options.fit ?? 'fluid';
  const doc = parseDocument(source);
  const sheets: string[] = [];
  const ruleClasses = new Map<string, string>();
  const styleClasses = new Map<string, string>();
  const ruleName = (cls: string) => {
    let name = ruleClasses.get(cls);
    if (!name) ruleClasses.set(cls, (name = `r${ruleClasses.size + 1}`));
    return name;
  };
  const styleClass = (decls: string) => {
    let name = styleClasses.get(decls);
    if (!name) styleClasses.set(decls, (name = `s${styleClasses.size + 1}`));
    return name;
  };
  let pageBackground: string | undefined;

  const mapUrl = (raw: string): string | null => {
    if (raw.startsWith('#')) return raw;
    return options.url(raw);
  };

  const clean = (el: Element, depth: number, inSvg: boolean) => {
    const name = el.name.toLowerCase();
    const svg = inSvg || name === 'svg';
    const id = el.attribs['data-bogen-id'];
    const info = id ? options.layer(id) : {};
    const attrs: Record<string, string> = {};
    let style = el.attribs.style ?? '';
    if (depth === 0 && id) {
      const root = rootStyle(style, fit);
      style = root.style;
      pageBackground ??= root.background;
    }
    if (info.still) style = `${style.replace(/;\s*$/, '')};background:url("${info.still}") center / 100% 100% no-repeat`;
    for (const [k, raw] of Object.entries(el.attribs)) {
      const key = k.toLowerCase();
      const v = raw ?? '';
      if (key === 'style' || key.startsWith('on')) continue;
      if (key.startsWith('data-')) {
        if (key === 'data-mode' && MODE.test(v)) attrs[key] = v;
        continue;
      }
      if (key === 'class') {
        const kept = v.split(/\s+/).filter(Boolean).flatMap((c) => (c.startsWith('bgn-') ? [ruleName(c)] : /^ts-[\w-]+$/.test(c) ? [c] : []));
        if (kept.length) attrs.class = kept.join(' ');
        continue;
      }
      if (key === 'id') {
        if (ANCHOR_ID.test(v)) attrs.id = v;
        continue;
      }
      if (svg && name !== 'svg' && !URL_ATTRS.has(key) && key !== 'href' && key !== 'xlink:href') {
        // Drawing attributes, already through the SVG sanitiser on every read.
        if (!/[<>]/.test(v) && !/javascript:/i.test(v)) attrs[k] = v;
        continue;
      }
      if (URL_ATTRS.has(key) || ((key === 'href' || key === 'xlink:href') && name === 'image')) {
        const to = mapUrl(v.trim());
        if (to) attrs[key] = to;
        else notes.add('An image or video that could not be made part of the site was left out.');
        continue;
      }
      if (key === 'href') {
        const url = safeUrl(v);
        if (url && !/^bogen-asset:|^data:/i.test(url)) attrs.href = url;
        continue;
      }
      if (svg && name === 'svg') {
        if (!/[<>]/.test(v) && !/javascript:/i.test(v)) attrs[k] = v;
        continue;
      }
      if (KEPT_ATTRS.has(key) || EXTRA_ATTRS.has(key) || /^aria-[a-z]+$/.test(key)) attrs[key] = v;
    }
    if (name === 'iframe') {
      if (!info.frame) {
        // A page of another site in a frame: refused by the site's policy, so not written at all.
        notes.add('Embeds of other sites are left out: a published page loads nothing from elsewhere.');
        el.name = 'div';
        delete attrs.src;
        delete attrs.loading;
        delete attrs.sandbox;
      } else {
        const hash = (el.attribs.src ?? '').split('#')[1];
        attrs.src = info.frame + (hash ? `#${hash}` : '');
        attrs.sandbox = 'allow-scripts';
        attrs.loading = 'lazy';
        attrs.referrerpolicy = 'no-referrer';
      }
    }
    if (style.trim()) {
      const decls = rewriteCssUrls(cleanDeclarations(style), mapUrl);
      if (decls) attrs.class = [attrs.class, styleClass(decls)].filter(Boolean).join(' ');
    }
    el.attribs = attrs;
    el.children = el.children.filter((c) => {
      if (isText(c)) return true;
      if (!isTag(c)) return false;
      const child = c.name.toLowerCase();
      if (child === 'style') {
        for (const t of c.children) if (isText(t)) sheets.push(t.data);
        return false;
      }
      if (DROPPED.has(child)) return false;
      const childId = c.attribs['data-bogen-id'];
      return !(childId && options.layer(childId).drop);
    });
    for (const c of el.children) if (isTag(c)) clean(c, depth + 1, svg);
  };

  const html = doc.children.find((c): c is Element => isTag(c) && c.name.toLowerCase() === 'html');
  const head = html?.children.find((c): c is Element => isTag(c) && c.name.toLowerCase() === 'head');
  const body = html?.children.find((c): c is Element => isTag(c) && c.name.toLowerCase() === 'body');
  if (!body) throw new Error('The export has no body.');
  for (const s of head?.children ?? []) {
    if (isTag(s) && s.name.toLowerCase() === 'style') for (const t of s.children) if (isText(t)) sheets.push(t.data);
  }
  body.children = body.children.filter((c) => {
    if (isText(c)) return true;
    if (!isTag(c)) return false;
    if (c.name.toLowerCase() === 'style') {
      for (const t of c.children) if (isText(t)) sheets.push(t.data);
      return false;
    }
    if (DROPPED.has(c.name.toLowerCase())) return false;
    const id = c.attribs['data-bogen-id'];
    return !(id && options.layer(id).drop);
  });
  for (const c of body.children) if (isTag(c)) clean(c, 0, false);

  let css = rewriteCssUrls(safeSheet(stripCssComments(sheets.join('\n'))), mapUrl);
  // Rule classes name a layer's id; every one of them gets a short name, also for rules of layers that were left out.
  css = css.replace(/\.bgn-[A-Za-z0-9_-]+/g, (cls) => `.${ruleName(cls.slice(1))}`);
  if (/\[data-bogen-id/.test(css)) css = css.replace(/\[data-bogen-id="[^"]*"\]/g, ':not(*)');
  const own = [...styleClasses].map(([decls, cls]) => `.${cls}{${decls}}`);
  const page = `html,body{margin:0}${pageBackground ? `html{background:${pageBackground}}` : ''}${fit === 'fixed' ? 'body{overflow-x:auto}' : ''}`;
  // After the design's own rules: an inline style beat them before, as the last class of equal weight it still does.
  css = [css.trim(), page, ...own].filter(Boolean).join('\n');

  const meta = options.csp ? `<meta http-equiv="Content-Security-Policy" content="${attrValue(options.csp)}">` : '';
  const out = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${meta}<meta name="referrer" content="no-referrer"><title>${escapeHtml(options.title)}</title><link rel="stylesheet" href="${attrValue(options.stylesheet)}"></head><body>${render(body.children, { encodeEntities: 'utf8' })}</body></html>`;
  assertClean(out, css, options.forbidden);
  return { html: out, css, notes: [...notes] };
}

/** A last look at what leaves the machine. Throws rather than publish a layer id, an asset address or a script. */
export function assertClean(html: string, css: string, forbidden: Iterable<string> = []): void {
  const both = `${html}\n${css}`;
  if (/<script|\son[a-z]+\s*=|javascript:/i.test(html)) throw new Error('A script survived the export, so nothing was published.');
  if (/<!--/.test(html)) throw new Error('A comment survived the export, so nothing was published.');
  if (/\sdata-bogen|bogen-asset:|(?:src|href)="\/api\/|url\("?\/api\/|class="[^"]*\bbgn-|\.bgn-/i.test(both)) throw new Error('Something internal to Bogen survived the export, so nothing was published.');
  for (const id of forbidden) {
    if (id.length < 6) continue;
    const at = both.indexOf(id);
    if (at < 0) continue;
    const re = new RegExp(`(?<![0-9A-Za-z_])${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![0-9A-Za-z_])`);
    if (re.test(both)) throw new Error('A layer id survived the export, so nothing was published. Does a text of the design quote one?');
  }
}

/** A name for a file of the site: lower case, letters, digits and dashes. */
export function publishSlug(name: string, taken: Set<string>): string {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
  let slug = base === 'index' ? 'index-1' : base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}
