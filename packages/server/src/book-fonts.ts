import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicFetch, UA } from './text-outline.ts';
import { atomicWrite } from './util.ts';

/**
 * The brand book opens in a frame without an origin of its own, so the browser neither shares nor keeps a cache for it:
 * a Google Fonts stylesheet in its head is fetched again on every open, and the page stays blank until it arrives.
 * This puts those stylesheets into the page itself, fetched once by the server and kept. The Latin files of the faces
 * the page uses go in as data, so the book shows in its own type at once; other scripts' files still come from
 * fonts.gstatic.com when a page needs them. A sheet that cannot be fetched stays a link, moved to the end of the body,
 * where it no longer holds up the pages above it.
 */
const kept = new Map<string, { css: string | null; at: number }>();
const files = new Map<string, string>();
const DAY = 24 * 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;
/** Fonts put into one page as data at most; past it the rest load from Google as before. */
const EMBED_BUDGET = 1_500_000;
const LINK = /<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/[^"]+)">/g;
const GSTATIC = /^https:\/\/fonts\.gstatic\.com\/[A-Za-z0-9/_.-]+\.woff2$/;

/** Pages after the first ones are laid out only when they come near the screen. */
const LAZY_PAGES = '<style>main > section { content-visibility: auto; contain-intrinsic-size: auto 800px; }</style>';

export interface BookFontSources {
  css: (href: string) => Promise<string>;
  /** A font file, already base64; null when it cannot be had. */
  file: (url: string) => Promise<string | null>;
}

async function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Google Fonts did not answer in time.')), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/** Google Fonts over the network, the files kept in `folder` so that a restarted server has them at once. */
export function googleBookFonts(folder: string): BookFontSources {
  return {
    css: async (href) => Buffer.from(await timed(publicFetch(href, { 'user-agent': UA }), 1500)).toString('utf8'),
    file: async (url) => {
      if (!GSTATIC.test(url)) return null;
      const hit = files.get(url);
      if (hit) return hit;
      const path = join(folder, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.woff2`);
      let bytes: Uint8Array | null = await readFile(path).catch(() => null);
      if (!bytes) {
        bytes = await timed(publicFetch(url), 2000).catch(() => null);
        if (!bytes || bytes.length < 4 || Buffer.from(bytes.slice(0, 4)).toString('latin1') !== 'wOF2') return null;
        await mkdir(folder, { recursive: true, mode: 0o700 }).then(() => atomicWrite(path, bytes!, 0o600)).catch(() => {});
      }
      const b64 = Buffer.from(bytes).toString('base64');
      if (files.size > 100) files.clear();
      files.set(url, b64);
      return b64;
    },
  };
}

/** Only @font-face rules whose files are on fonts.gstatic.com, and nothing that could end the style element. */
export function safeFontCss(css: string): string | null {
  const faces = css.match(/@font-face\s*{[^{}]*}/g) ?? [];
  const ok = faces.filter((f) => !/[<>\\]/.test(f) && [...f.matchAll(/url\(([^)]*)\)/g)].every((m) => /^['"]?https:\/\/fonts\.gstatic\.com\//.test(m[1]!.trim())));
  return ok.length ? ok.join('\n') : null;
}

async function sheet(href: string, get: BookFontSources['css']): Promise<string | null> {
  const hit = kept.get(href);
  if (hit && Date.now() - hit.at < (hit.css ? DAY : RETRY)) return hit.css;
  const css = await get(href).then(safeFontCss, () => null);
  if (kept.size > 200) kept.clear();
  kept.set(href, { css, at: Date.now() });
  return css;
}

const familyOf = (face: string) => /font-family:\s*['"]?([^;'"]+)/.exec(face)?.[1]?.trim().toLowerCase() ?? '';
/** Google's Latin block, the one every page of a Latin-script book needs. */
const isLatin = (face: string) => /unicode-range:\s*U\+0000-00FF[,;]/i.test(face);

/**
 * The Latin faces as data. A family that two sheets describe (the lenient one and the one with a width axis) is drawn
 * from the later sheet, whose faces win in the browser, so only those are put in.
 */
async function embedLatin(sheets: string[], file: BookFontSources['file']): Promise<string[]> {
  const last = new Map<string, number>();
  sheets.forEach((css, i) => { for (const f of css.match(/@font-face\s*{[^{}]*}/g) ?? []) last.set(familyOf(f), i); });
  let budget = EMBED_BUDGET;
  const out: string[] = [];
  for (const [i, css] of sheets.entries()) {
    const faces = css.match(/@font-face\s*{[^{}]*}/g) ?? [];
    const done = await Promise.all(faces.map(async (f) => {
      const url = /url\(['"]?(https:\/\/fonts\.gstatic\.com\/[^)'"]+)['"]?\)/.exec(f)?.[1];
      if (!url || !isLatin(f) || last.get(familyOf(f)) !== i) return f;
      const b64 = await file(url).catch(() => null);
      if (!b64 || b64.length > budget) return f;
      budget -= b64.length;
      return f.replace(/url\([^)]*\)\s*format\([^)]*\)|url\([^)]*\)/, `url(data:font/woff2;base64,${b64}) format('woff2')`);
    }));
    out.push(done.join('\n'));
  }
  return out;
}

export async function fastBookHtml(html: string, sources: BookFontSources): Promise<string> {
  const headEnd = html.indexOf('</head>');
  if (headEnd < 0) return html;
  const head = html.slice(0, headEnd);
  const links = [...head.matchAll(LINK)];
  const late: string[] = [];
  const fetched = await Promise.all(links.map((m) => sheet(m[1]!.replace(/&amp;/g, '&'), sources.css)));
  const inline: string[] = [];
  links.forEach((m, i) => (fetched[i] ? inline.push(fetched[i]!) : late.push(m[0])));
  const css = inline.length ? await embedLatin(inline, sources.file) : [];
  const newHead = head.replace(LINK, '') + (css.length ? `<style>${css.join('\n')}</style>` : '') + LAZY_PAGES;
  let rest = html.slice(headEnd);
  if (late.length) {
    const bodyEnd = rest.lastIndexOf('</body>');
    rest = bodyEnd < 0 ? rest + late.join('') : rest.slice(0, bodyEnd) + late.join('') + rest.slice(bodyEnd);
  }
  return newHead + rest;
}
