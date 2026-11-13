import { parseDocument } from 'htmlparser2';
import { Element, isTag, type ChildNode } from 'domhandler';

/**
 * The check before a site goes out, on the files a publish would send: what search engines and link previews read
 * (title, description, language, canonical address, social picture and its size, icon), links and anchors that lead
 * nowhere inside the site, and images that weigh a lot or reserve no box. It reads only the files it is given, so it
 * works offline and sends nothing anywhere; links to other sites are counted, never visited.
 *
 * Only what is objectively broken is an error: a page without a language, and a link, anchor or file of the site that
 * is not there. Everything else is a warning or a note, for the person to weigh. Nothing here stops a publish.
 */

export type PublishLevel = 'error' | 'warning' | 'note';

export interface PublishFinding {
  level: PublishLevel;
  /** What was checked, stable for tools: title, description, lang, canonical, og-image, favicon, link, anchor, image-missing, image-weight, image-size, site-weight. */
  check: string;
  /** The HTML file it is about. */
  page?: string;
  /** The site path it is about, for an image or a link target. */
  path?: string;
  message: string;
  /** How to put it right, with the tool an agent would use. */
  fix?: string;
}

export interface CheckedPage {
  file: string;
  title: string;
  lang: string | null;
  description: string | null;
  canonical: string | null;
  ogImage: string | null;
  favicon: string | null;
  links: { internal: number; anchors: number; external: number };
  images: number;
}

export interface PublishCheckReport {
  ok: boolean;
  counts: { errors: number; warnings: number; notes: number };
  findings: PublishFinding[];
  pages: CheckedPage[];
  bytes: number;
}

export interface SiteFileInput { path: string; bytes: Uint8Array; type?: string }

export interface PublishCheckOptions {
  /** Pixel size from an image's header. */
  imageSize?: (bytes: Uint8Array) => { width: number; height: number } | null;
  /** Above this an image is a warning. */
  heavyImage?: number;
  /** Above this an image is a note. */
  largeImage?: number;
}

const HEAVY = 500 * 1024;
const LARGE = 200 * 1024;
const OG_MIN = { width: 1200, height: 630 };
const OG_MAX_BYTES = 5 * 1024 * 1024;
const SITE_HEAVY = 5 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|svg|ico)$/i;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function walk(nodes: ChildNode[], visit: (el: Element) => void): void {
  for (const n of nodes) {
    if (!isTag(n)) continue;
    visit(n);
    walk(n.children, visit);
  }
}

/** The declarations of each class in a published style sheet: cleanPublishedPage writes one class per element style. */
function classDeclarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(?:^|[}\s])\.([A-Za-z][\w-]*)\s*\{([^{}]*)\}/g)) out.set(m[1]!, `${out.get(m[1]!) ?? ''};${m[2]!}`);
  return out;
}

/** Whether CSS gives a box both a width and a height, or a ratio, before its picture arrives. */
function sizedByCss(decls: string): boolean {
  const value = (prop: string) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(decls)?.[1]?.trim();
  const real = (v: string | undefined) => Boolean(v && !/^(auto|fit-content|max-content|min-content)$/i.test(v));
  if (real(value('aspect-ratio'))) return true;
  return real(value('width')) && real(value('height'));
}

/** The site path of an address that is either relative or on the page's own origin, or null. */
function ownPath(address: string, canonical: string | null, page: string): { path: string; hash: string } | null {
  if (!/^https?:\/\//i.test(address)) return sitePath(address, page);
  if (!canonical) return null;
  try {
    const url = new URL(address);
    const base = new URL(canonical);
    if (url.origin !== base.origin) return null;
    // Relative to the folder the canonical page is in, which is where the site's files are.
    const folder = base.pathname.replace(/[^/]*$/, '');
    if (!url.pathname.startsWith(folder)) return null;
    return { path: decodeURIComponent(url.pathname.slice(folder.length)) || 'index.html', hash: url.hash.slice(1) };
  } catch {
    return null;
  }
}

/** A site path from a link on a page, or null for one that leaves the site. */
function sitePath(href: string, page: string): { path: string; hash: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  try {
    const url = new URL(href, `https://site.invalid/${page}`);
    if (url.host !== 'site.invalid') return null;
    let path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!path || path.endsWith('/')) path += 'index.html';
    return { path, hash: url.hash.slice(1) };
  } catch {
    return null;
  }
}

export function checkPublishedSite(files: SiteFileInput[], options: PublishCheckOptions = {}): PublishCheckReport {
  const heavy = options.heavyImage ?? HEAVY;
  const large = options.largeImage ?? LARGE;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const decoder = new TextDecoder();
  const text = (f: SiteFileInput) => decoder.decode(f.bytes);
  const findings: PublishFinding[] = [];
  const add = (f: PublishFinding) => findings.push(f);
  const htmlFiles = files.filter((f) => f.path.endsWith('.html') && !f.path.startsWith('frames/'));
  const parsed = new Map<string, { root: ChildNode[]; ids: Set<string> }>();
  for (const f of htmlFiles) {
    const dom = parseDocument(text(f));
    const ids = new Set<string>();
    walk(dom.children, (el) => { if (el.attribs.id) ids.add(el.attribs.id); });
    parsed.set(f.path, { root: dom.children, ids });
  }
  const pages: CheckedPage[] = [];
  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  for (const f of htmlFiles) {
    const page = f.path;
    const { root, ids } = parsed.get(page)!;
    let title = '' as string;
    let lang = null as string | null;
    let description = null as string | null;
    let canonical = null as string | null;
    let ogImage = null as string | null;
    let favicon = null as string | null;
    let stylesheet = null as string | null;
    const anchors: { href: string; text: string }[] = [];
    const imgs: Element[] = [];
    walk(root, (el) => {
      const name = el.name.toLowerCase();
      const a = el.attribs;
      if (name === 'html') lang = a.lang?.trim() || null;
      else if (name === 'title') title = el.children.map((c) => ('data' in c ? String(c.data) : '')).join('').trim();
      else if (name === 'meta' && a.name === 'description') description = a.content?.trim() || null;
      else if (name === 'meta' && a.property === 'og:image') ogImage = a.content?.trim() || null;
      else if (name === 'link' && /\bcanonical\b/i.test(a.rel ?? '')) canonical = a.href?.trim() || null;
      else if (name === 'link' && /\bicon\b/i.test(a.rel ?? '')) favicon = a.href?.trim() || null;
      else if (name === 'link' && /\bstylesheet\b/i.test(a.rel ?? '')) stylesheet = a.href ?? null;
      else if (name === 'a' && a.href !== undefined) anchors.push({ href: a.href, text: '' });
      else if (name === 'img') imgs.push(el);
    });

    // What search engines and link previews read.
    if (!title) add({ level: 'warning', check: 'title', page, message: 'The page has no title.', fix: 'Name the artboard, or set title with web_page_set.' });
    else if (title.length > 60) add({ level: 'note', check: 'title', page, message: `The title has ${title.length} characters; search results cut it at about 60.`, fix: 'A shorter title with web_page_set.' });
    if (title) titles.set(title, [...(titles.get(title) ?? []), page]);
    if (!lang) add({ level: 'error', check: 'lang', page, message: 'The page says no language, so screen readers guess how to pronounce it and browsers cannot hyphenate.', fix: 'Set lang with web_page_set, or the file\'s design language.' });
    if (!description) add({ level: 'warning', check: 'description', page, message: 'No meta description. Search results then show any text of the page.', fix: 'One or two sentences with web_page_set description.' });
    else {
      if (description.length < 50) add({ level: 'note', check: 'description', page, message: `The description is short (${description.length} characters); 50 to 160 reads best in results.` });
      if (description.length > 160) add({ level: 'note', check: 'description', page, message: `The description has ${description.length} characters; results cut it at about 160.` });
      descriptions.set(description, [...(descriptions.get(description) ?? []), page]);
    }
    if (!canonical) add({ level: 'warning', check: 'canonical', page, message: 'No canonical address, so copies of the page on other addresses compete with it, and the social picture has no full address.', fix: 'Set canonical with web_page_set to the full address the site will have.' });
    else if (!/^https?:\/\//i.test(canonical)) add({ level: 'warning', check: 'canonical', page, message: `The canonical address "${canonical}" is not a full http(s) address.` });
    else if (/^http:/i.test(canonical)) add({ level: 'note', check: 'canonical', page, message: 'The canonical address uses http, not https.' });
    if (!ogImage) add({ level: 'warning', check: 'og-image', page, message: 'No social picture (og:image). A shared link shows no preview picture.', fix: 'Upload one of 1200x630 px with asset_upload and set og_image with web_page_set.' });
    else {
      const local = ownPath(ogImage, canonical, page);
      const file = local ? byPath.get(local.path) : undefined;
      if (!/^https?:\/\//i.test(ogImage)) add({ level: 'warning', check: 'og-image', page, path: ogImage, message: 'The social picture has no full address; link previews need one.', fix: 'Set canonical with web_page_set, which makes it full.' });
      if (local && !file && !/^https?:\/\//i.test(ogImage)) add({ level: 'error', check: 'og-image', page, path: local.path, message: `The social picture ${local.path} is not a file of the site.` });
      if (file) {
        const size = options.imageSize?.(file.bytes);
        if (size && (size.width < OG_MIN.width || size.height < OG_MIN.height)) add({ level: 'warning', check: 'og-image', page, path: file.path, message: `The social picture is ${size.width}x${size.height} px; previews want at least ${OG_MIN.width}x${OG_MIN.height}.`, fix: 'A larger picture with asset_upload, then web_page_set og_image.' });
        else if (size && Math.abs(size.width / size.height - 1.91) > 0.25) add({ level: 'note', check: 'og-image', page, path: file.path, message: `The social picture is ${size.width}x${size.height} px; previews crop to about 1.91:1.` });
        if (file.bytes.length > OG_MAX_BYTES) add({ level: 'warning', check: 'og-image', page, path: file.path, message: `The social picture weighs ${kb(file.bytes.length)}; some sites refuse pictures over 5 MB.` });
      }
    }
    if (!favicon) add({ level: 'warning', check: 'favicon', page, message: 'No icon for the browser tab and bookmarks.', fix: 'Upload a square PNG or SVG and set favicon with web_page_set.' });
    else {
      const local = sitePath(favicon, page);
      if (local && !byPath.has(local.path)) add({ level: 'error', check: 'favicon', page, path: local.path, message: `The icon ${local.path} is not a file of the site.` });
    }

    // Links: inside the site they must lead somewhere; outside it they are counted, not visited.
    const links = { internal: 0, anchors: 0, external: 0 };
    const broken = new Set<string>();
    for (const { href } of anchors) {
      const h = href.trim();
      if (!h) {
        add({ level: 'warning', check: 'link', page, message: 'A link has an empty address.' });
        continue;
      }
      if (h.startsWith('#')) {
        links.anchors++;
        const id = decodeURIComponent(h.slice(1));
        if (id && id !== 'top' && !ids.has(id) && !broken.has(h)) {
          broken.add(h);
          add({ level: 'error', check: 'anchor', page, path: h, message: `A link goes to ${h}, which is not on the page.`, fix: `Give the layer it means id="${id}" with layer_attrs, or change the link.` });
        }
        continue;
      }
      const local = sitePath(h, page);
      if (!local) {
        links.external++;
        continue;
      }
      links.internal++;
      const target = parsed.get(local.path);
      const file = byPath.get(local.path) ?? byPath.get(`${local.path}.html`) ?? byPath.get(`${local.path}/index.html`);
      if (!file && !broken.has(h)) {
        broken.add(h);
        add({ level: 'error', check: 'link', page, path: h, message: `A link goes to ${local.path}, which is not a page or file of this site.`, fix: 'Publish the whole page so that every artboard is a page, or change the link.' });
      } else if (target && local.hash && local.hash !== 'top' && !target.ids.has(local.hash) && !broken.has(h)) {
        broken.add(h);
        add({ level: 'error', check: 'anchor', page, path: h, message: `A link goes to ${h}, but ${local.path} has no #${local.hash}.` });
      }
    }

    // Images: there, not too heavy, and with a box reserved before they load.
    const css = stylesheet ? byPath.get(sitePath(stylesheet, page)?.path ?? '') : undefined;
    const classes = css ? classDeclarations(text(css)) : new Map<string, string>();
    let unsized = 0;
    for (const img of imgs) {
      const src = img.attribs.src?.trim();
      if (!src) continue;
      const local = sitePath(src, page);
      if (local && !byPath.has(local.path)) {
        add({ level: 'error', check: 'image-missing', page, path: local.path, message: `An image ${local.path} is not a file of the site.` });
        continue;
      }
      const hasSize = (img.attribs.width && img.attribs.height) || (img.attribs.class ?? '').split(/\s+/).some((c) => sizedByCss(classes.get(c) ?? ''));
      if (!hasSize) unsized++;
    }
    if (unsized) add({ level: 'warning', check: 'image-size', page, message: unsized === 1 ? 'An image has no width and height, so the page jumps when it loads.' : `${unsized} images have no width and height, so the page jumps when they load.`, fix: 'Set width and height with layer_attrs, or a fixed size or aspect-ratio with layer_style.' });
    pages.push({ file: page, title, lang, description, canonical, ogImage, favicon, links, images: imgs.length });
  }
  for (const [title, on] of titles) if (on.length > 1) add({ level: 'note', check: 'title', message: `${on.length} pages share the title "${title}": ${on.join(', ')}.` });
  for (const [, on] of descriptions) if (on.length > 1) add({ level: 'note', check: 'description', message: `${on.length} pages share one description: ${on.join(', ')}.` });

  // Weight of every picture of the site, once each, also those only a style sheet uses.
  for (const f of files) {
    if (!IMAGE_EXT.test(f.path)) continue;
    if (f.bytes.length > heavy) add({ level: 'warning', check: 'image-weight', path: f.path, message: `${f.path} weighs ${kb(f.bytes.length)}. Under ${kb(LARGE)} loads much faster on a phone.`, fix: 'A smaller or more compressed picture (WebP or AVIF), uploaded again with asset_upload.' });
    else if (f.bytes.length > large) add({ level: 'note', check: 'image-weight', path: f.path, message: `${f.path} weighs ${kb(f.bytes.length)}.` });
  }
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  if (bytes > SITE_HEAVY) add({ level: 'note', check: 'site-weight', message: `The site weighs ${kb(bytes)} in all.` });

  const order: Record<PublishLevel, number> = { error: 0, warning: 1, note: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const counts = { errors: 0, warnings: 0, notes: 0 };
  for (const f of findings) counts[f.level === 'error' ? 'errors' : f.level === 'warning' ? 'warnings' : 'notes']++;
  return { ok: counts.errors === 0, counts, findings, pages, bytes };
}
