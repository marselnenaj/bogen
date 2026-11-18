/**
 * The brand book as people see it: every page of every brand's book, rendered from the server's own sheet.html in
 * secure-chromium (its sandbox on), measured for geometry defects that a reader would notice.
 *
 *   BOGEN_HOME=<data folder> node --import tsx scripts/check-brand-book-render.ts [--shots <dir>] [brand id...]
 *     starts a server from this checkout on that data folder.
 *   BOGEN_CHECK_URL=http://127.0.0.1:29990 BOGEN_CHECK_TOKEN=<token> node --import tsx scripts/check-brand-book-render.ts
 *     measures a server that is already running.
 *
 * A defect is one of:
 *   outside    a box or line of text that reaches past the page's edge (clipped or not)
 *   chrome     body text that runs into the running head or the folio
 *   clipped    text cut by its box (overflow hidden, a line clamp) or ending in an ellipsis
 *   tiny       text set below 11px
 *   overlap    two lines of different text that cover each other, each line taken at its line height
 *   rule       the page breaks a rule of the brand's own (bookPolicy): a colour it never sets as a field set as one, a caps-only face set in lower case, a face whose
 *              headlines are italic set upright, a shadow or a dashed line in a brand that has none, a display line
 *              not at the brand's display width, a screenshot cropped or a portrait in colour against its rules
 *   misuse     a logo on a ground other than the one it is made for (its own misuse page crosses that out)
 *   heading    a heading-sized line (28px and more, bold) in a face that is neither the display nor the heading face
 *   double     a rule drawn right under the running head's own rule, so that two lines show
 *   negation   a double negative ("Never Do not", "Nie Keine")
 *   quote      a quotation mark opened and not closed in one block of text
 *   upscaled   a raster picture shown larger than it is, so that it looks soft
 *   margin     a box that reaches past the page's margins (its outline and hard offset shadow counted), outside the cover
 *   grid       a full-width grid whose columns do not start on the book's twelve-column grid (--bb-grid: free is exempt)
 *   head       a running head of another height or place than the book's own, so that two head systems show
 *   straight   a straight quotation mark or apostrophe in text, outside code
 *   hexcase    a hex value in lower case, where the book sets them in capitals
 *   glyph      a quotation mark standing alone as an ornament, opened and never closed
 *   shot-text  a captured picture whose smallest text is shown under 9px (--bb-min-text)
 *   caption    a caption that repeats the heading over it
 *   flow       a column of a list that goes on from the column before without its heading (--bb-flow)
 *   voice      a sample of the brand's copy (--bb-sample) that fails the brand's own voice rules (bookVoice, voice_check)
 *   colophon   the colophon counts another number of chapters than the contents lists
 * Drawn examples of what not to do (--bb-kind: demo, the misuse tiles), specimens of a face (--bb-kind: specimen) and colour
 * swatches (--bb-kind: swatch) are exempt from the rules they show; the book marks them with custom properties, the only marks that survive its import into a document.
 * Nothing leaves the machine.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from '../apps/editor/test/e2e/craft-harness.ts';
import { BOOK_GRID, bookPolicy, bookVoice } from '../packages/core/src/brand-book-html.ts';
import type { BrandData } from '../packages/core/src/brand.ts';

const args = process.argv.slice(2);
const shotsAt = args.indexOf('--shots');
const shots = shotsAt >= 0 ? args.splice(shotsAt, 2)[1] : undefined;
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const ROOT = resolve(import.meta.dirname, '..');

let base = process.env.BOGEN_CHECK_URL;
let child: ChildProcess | undefined;
const headers: Record<string, string> = process.env.BOGEN_CHECK_TOKEN ? { Authorization: `Bearer ${process.env.BOGEN_CHECK_TOKEN}` } : {};
if (!base) {
  const home = process.env.BOGEN_HOME;
  if (!home) throw new Error('Set BOGEN_HOME (a data folder to serve) or BOGEN_CHECK_URL.');
  const port = 29100 + Math.floor(Math.random() * 800);
  child = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(port)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', BOGEN_EDITOR_DIR: join(ROOT, 'apps/editor/dist') }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout?.on('data', (d: Buffer) => { log += d; });
  child.stderr?.on('data', (d: Buffer) => { log += d; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* not up yet */ }
    if (i > 200) { console.log(log); process.exit(1); }
    await new Promise((r) => setTimeout(r, 250));
  }
}
const port = Number(new URL(base).port);

interface Defect { page: number; kind: string; text: string }
const brands = (await (await fetch(`${base}/api/brands`, { headers })).json()) as { id: string; name: string }[] | { brands: { id: string; name: string }[] };
const list = (Array.isArray(brands) ? brands : brands.brands).filter((b) => !args.length || args.includes(b.id));
const browser = await launch(port);
const report: { id: string; name: string; pages: number; defects: Defect[]; ms: number }[] = [];
let thinTotal = 0;
try {
  for (const b of list) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    await page.setExtraHTTPHeaders(headers);
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    const t0 = Date.now();
    await page.goto(`${base}/api/brands/${b.id}/sheet.html?check=${Date.now()}`, { waitUntil: 'load', timeout: 120_000 });
    const ms = Date.now() - t0;
    await page.addStyleTag({ content: '*{content-visibility:visible!important}' });
    // The page is sandboxed without scripts, so timers in it never fire: wait from here, for fonts to come in.
    for (let i = 0; i < 20 && (await page.evaluate('document.fonts.status')) !== 'loaded'; i++) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 300));
    const brandData = ((await (await fetch(`${base}/api/brands/${b.id}`, { headers })).json()) as { data: BrandData }).data;
    const policy0 = bookPolicy(brandData);
    const displayFamily = brandData.families.find((f) => /display|head/i.test(f.role))?.family ?? brandData.families[0]?.family;
    // A display family that is also the text face is display only at its display weights.
    const displayFam = brandData.families.find((f) => /display|head/i.test(f.role));
    const shared = !!displayFam && brandData.families.some((x) => x !== displayFam && x.family === displayFam.family);
    const displayMinWeight = shared && displayFam!.weights.length ? Math.min(...displayFam!.weights) : 0;
    const policy = { ...policy0, faces: [displayFamily, policy0.headingFamily].filter((x): x is string => !!x), grid: BOOK_GRID, displayMinWeight };
    const found = (await page.evaluate((policy: { upperFamily?: string; italicFamily?: string; noShadow: boolean; noDashed: boolean; displayStretch?: number; uncroppedScreens: boolean; grayscale?: string; noField: string[]; displayMinWeight: number; faces: string[]; grid: { left: number; width: number; gutter: number; columns: number } }) => {
      const out: { page: number; kind: string; text: string }[] = [];
      const samples: { page: number; kind: string; text: string }[] = [];
      const heads: { page: number; key: string }[] = [];
      const thin: { page: number; fill: number }[] = [];
      const pages = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return Math.abs(r.width - 1280) < 1 && Math.abs(r.height - 800) < 1; });
      const inside = (a: DOMRect, b: DOMRect, tol = 1) => a.left >= b.left - tol && a.right <= b.right + tol && a.top >= b.top - tol && a.bottom <= b.bottom + tol;
      const meets = (a: DOMRect, b: DOMRect, tol = 1) => a.left < b.right - tol && a.right > b.left + tol && a.top < b.bottom - tol && a.bottom > b.top + tol;
      const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 70);
      const kindOf = (e: Element) => getComputedStyle(e).getPropertyValue('--bb-kind').trim();
      const ownGround = (e: Element) => { const v = getComputedStyle(e).getPropertyValue('--bb-ground').trim(); return v && (!e.parentElement || getComputedStyle(e.parentElement).getPropertyValue('--bb-ground').trim() !== v) ? v : ''; };
      pages.forEach((pg, i) => {
        const n = i + 1;
        const pr = pg.getBoundingClientRect();
        const kids = [...pg.children];
        const head = kids.length >= 3 ? kids[0]! : null;
        const foot = kids.length >= 3 ? kids[kids.length - 1]! : null;
        const chrome = [head, foot].filter((x): x is Element => !!x);
        const lines: { node: Text; rect: DOMRect; el: Element }[] = [];
        const walker = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
          if (!t.data.trim()) continue;
          const el = t.parentElement!;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"]')) continue;
          const range = document.createRange();
          range.selectNodeContents(t);
          // A line's box is its line height, not the glyphs' content area: a display face set at 0.9 has a content area
          // taller than the line, which is how it is meant to sit, so lines are compared at their line height.
          const fs = parseFloat(cs.fontSize);
          const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
          for (const r of range.getClientRects()) {
            if (r.width <= 0.5 || r.height <= 0.5) continue;
            const trim = Math.max(0, (r.height - lh) / 2);
            lines.push({ node: t, rect: new DOMRect(r.x, r.y + trim, r.width, r.height - 2 * trim), el });
          }
          if (parseFloat(cs.fontSize) < 11) out.push({ page: n, kind: 'tiny', text: `${cs.fontSize} ${short(t.data)}` });
          const code = !!el.closest('code,pre,kbd,samp') || /mono/i.test(cs.fontFamily);
          if (!code && /['"]/.test(t.data)) out.push({ page: n, kind: 'straight', text: short(t.data) });
          if ((t.data.match(/#[0-9a-fA-F]{6}\b/g) ?? []).some((h) => /[a-f]/.test(h))) out.push({ page: n, kind: 'hexcase', text: short(t.data) });
          if (/(\.\.\.|…)\s*$/.test(t.data) && !/\b(etc|usw)\.\.\.$/.test(t.data)) out.push({ page: n, kind: 'clipped', text: `ellipsis: ${short(t.data.slice(-60))}` });
        }
        // How far down its body a page's content reaches: a page that stops at half its height reads as empty.
        // The body is the middle child of a page with a running head and a folio (class names do not survive export).
        const bodyEl = pg.children.length >= 3 ? pg.children[1]! : null;
        if (bodyEl) {
          const br = bodyEl.getBoundingClientRect();
          let bottom = br.top;
          for (const e of bodyEl.querySelectorAll('*')) { const cs = getComputedStyle(e); if (e.children.length && cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none') continue; const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && (e.textContent?.trim() || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderTopWidth !== '0px' || /^(IMG|SVG|svg|SPAN)$/.test(e.tagName))) bottom = Math.max(bottom, Math.min(r.bottom, br.bottom)); }
          const fill = (bottom - br.top) / br.height;
          if (fill < 0.6) thin.push({ page: n, fill: Math.round(fill * 100) });
        }
        const seen = new Set<Text>();
        for (const l of lines) {
          if (!inside(l.rect, pr) && !seen.has(l.node)) { seen.add(l.node); out.push({ page: n, kind: 'outside', text: short(l.node.data) }); }
          for (const c of chrome) if (!c.contains(l.node) && meets(l.rect, c.getBoundingClientRect(), 0) && !seen.has(l.node)) { seen.add(l.node); out.push({ page: n, kind: 'chrome', text: short(l.node.data) }); }
        }
        // Boxes past the page edge: swatches, tiles and pictures that the page's clipping hides. Only the innermost such
        // box is named, and only when no line of text in it was named already.
        const all = [...pg.querySelectorAll('*')];
        const rect = new Map(all.map((e) => [e, e.getBoundingClientRect()] as const));
        const out2 = new Set(all.filter((e) => { const r = rect.get(e)!; return r.width >= 2 && r.height >= 2 && !inside(r, pr, 2) && !e.closest('[aria-hidden="true"]'); }));
        const named = new Set([...seen].map((t) => t.parentElement));
        for (const e of out2) {
          if ([...e.children].some((k) => out2.has(k))) continue;
          if ([...named].some((x) => x && (e.contains(x) || x.contains(e)))) continue;
          const r = rect.get(e)!;
          out.push({ page: n, kind: 'outside', text: `box ${Math.round(r.bottom - pr.bottom)}px below, ${Math.round(r.right - pr.right)}px right: ${short(e.textContent ?? '') || e.tagName.toLowerCase()}` });
        }
        for (const e of all) {
          if (!e.firstChild || !e.textContent?.trim() || e.closest('[aria-hidden="true"]')) continue;
          const cs = getComputedStyle(e);
          const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
          if (clips && !e.querySelector('img,svg') && (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2)) out.push({ page: n, kind: 'clipped', text: short(e.textContent) });
        }
        // One running head on every page: the same height, at the same place.
        if (head) { const hr = head.getBoundingClientRect(); heads.push({ page: n, key: `${head.tagName} ${Math.round(hr.top - pr.top)} ${Math.round(hr.height)}` }); }
        // Boxes past the margins, outlines counted; the cover bleeds on purpose, drawn misuse is exempt.
        // The body: between the running head and the folio, or, on a page without a head (an opener), before the folio.
        const bodyBox = pg.children.length >= 3 ? pg.children[1]! : pg.children.length === 2 ? pg.children[0]! : null;
        if (bodyBox && !pg.hasAttribute('data-cover')) {
          let reported = 0;
          for (const e of bodyBox.querySelectorAll('*')) {
            if (reported >= 3 || e.closest('[style*="--bb-kind: demo"],[style*="--bb-kind:demo"]') || kindOf(e) === 'demo') continue;
            const r = rect.get(e) ?? e.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            const cs = getComputedStyle(e);
            // Inline text hangs its trailing space past the line's end; text past the page is the outside check's.
            if (cs.display === 'inline') continue;
            const o = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? parseFloat(cs.outlineWidth) + (parseFloat(cs.outlineOffset) || 0) : 0;
            // A hard offset shadow counts as part of the box: it is drawn, not a blur.
            let sx = 0;
            if (cs.boxShadow !== 'none') for (const part of cs.boxShadow.split(/,(?![^(]*\))/)) { if (/inset/.test(part)) continue; const nums = (part.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat); if (nums.length >= 2 && (nums[2] ?? 0) === 0) sx = Math.max(sx, nums[0]! + (nums[3] ?? 0)); }
            const left = pr.left + policy.grid.left, right = left + policy.grid.width;
            if (r.left - o < left - 1 || r.right + o + sx > right + 1) { reported++; out.push({ page: n, kind: 'margin', text: `${e.tagName.toLowerCase()} ${Math.round(r.left - o - pr.left)} to ${Math.round(r.right + o - pr.left)}: ${short(e.textContent ?? '').slice(0, 40)}` }); }
          }
        }
        // Full-width grids keep their columns on the book's grid.
        const G = policy.grid, colW = (G.width - (G.columns - 1) * G.gutter) / G.columns;
        const lines12 = Array.from({ length: G.columns }, (_, j) => G.left + j * (colW + G.gutter));
        for (const e of all) {
          const cs = getComputedStyle(e);
          if (cs.display !== 'grid' || cs.getPropertyValue('--bb-grid').trim() === 'free') continue;
          const r = rect.get(e)!;
          if (Math.abs(r.width - G.width) > 1.5 || Math.abs(r.left - pr.left - G.left) > 1.5) continue;
          const tracks = cs.gridTemplateColumns.split(/\s+/).map(parseFloat).filter((x) => Number.isFinite(x));
          if (tracks.length < 2) continue;
          const gap = parseFloat(cs.columnGap) || 0;
          let x = G.left;
          for (let k = 0; k < tracks.length; k++) {
            if (!lines12.some((l) => Math.abs(l - x) <= 1.5)) { out.push({ page: n, kind: 'grid', text: `column ${k + 1} at ${Math.round(x)}: ${short(e.textContent ?? '').slice(0, 40)}` }); break; }
            x += tracks[k]! + gap;
          }
        }
        // Ornamental quotation marks that open and never close; captured pictures with unreadable text; captions that say
        // the heading again; list columns without their heading; samples of the brand's copy, for the voice check.
        const headings = [...pg.querySelectorAll('h1,h2,h3')].map((h) => (h.textContent ?? '').trim().toLowerCase()).filter((x) => x.length >= 4);
        for (const e of all) {
          const text = (e.textContent ?? '').trim();
          if (!e.children.length && /^[»«„“”"'‚‘’›‹]+$/.test(text)) out.push({ page: n, kind: 'glyph', text });
          const cs = getComputedStyle(e);
          const minText = parseFloat(cs.getPropertyValue('--bb-min-text'));
          if (e.tagName === 'IMG' && minText < 9) out.push({ page: n, kind: 'shot-text', text: `${(e as HTMLImageElement).alt.slice(0, 50)} at ${minText}px` });
          if (e.tagName === 'FIGCAPTION' || (e.tagName === 'P' && parseFloat(cs.fontSize) <= 13 && e.parentElement?.querySelector('img,[role="img"]'))) {
            const lower = text.toLowerCase();
            const h = headings.find((x) => lower.startsWith(x) || lower.includes(`${x}.`));
            if (h) out.push({ page: n, kind: 'caption', text: short(text) });
          }
          if (cs.getPropertyValue('--bb-flow').trim() === 'column' && (!e.parentElement || getComputedStyle(e.parentElement).getPropertyValue('--bb-flow').trim() !== 'column') && e.firstElementChild && getComputedStyle(e.firstElementChild).getPropertyValue('--bb-flow-head').trim() !== '1') out.push({ page: n, kind: 'flow', text: short(text).slice(0, 50) });
          const sample = cs.getPropertyValue('--bb-sample').trim();
          if (sample && (!e.parentElement || getComputedStyle(e.parentElement).getPropertyValue('--bb-sample').trim() !== sample)) samples.push({ page: n, kind: sample, text: text.replace(/^[„“"»«]+|[“”"«»]+$/g, '') });
        }
        // A rule right under the running head's own rule: two lines where one is meant.
        if (head) {
          const hb = head.getBoundingClientRect().bottom;
          for (const e of all) {
            if (head.contains(e)) continue;
            const cs = getComputedStyle(e);
            const w = parseFloat(cs.borderTopWidth);
            const r = rect.get(e)!;
            if (w > 0 && cs.borderTopStyle !== 'none' && r.width > pr.width * 0.25 && r.top >= hb - 1 && r.top - hb < 44) { out.push({ page: n, kind: 'double', text: `${e.tagName.toLowerCase()} ${Math.round(r.top - hb)}px under the head: ${short(e.textContent ?? '').slice(0, 40)}` }); break; }
          }
        }
        // Blocks of text: double negatives and quotes left open.
        for (const e of all) {
          if (!/^(P|H1|H2|H3|H4|LI|FIGCAPTION|DD|BLOCKQUOTE)$/.test(e.tagName) || e.closest('[aria-hidden="true"]')) continue;
          const text = (e.textContent ?? '').replace(/\s+/g, ' ');
          if (/\b(nie|never|nicht|not)\s+(kein\w*|nicht|nie|do not|don't|never|no)\b/i.test(text)) out.push({ page: n, kind: 'negation', text: short(text) });
          const c = (re: RegExp) => (text.match(re) ?? []).length;
          const open = c(/„/g) ? c(/„/g) - c(/“/g) : c(/“/g) - c(/”/g);
          if (open !== 0 || c(/«/g) !== c(/»/g) || c(/"/g) % 2) out.push({ page: n, kind: 'quote', text: short(text) });
        }
        // Logos on a ground they are not made for, outside the drawn examples of misuse.
        const bgOf = (e: Element): string => { for (let x: Element | null = e.parentElement; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; } return 'rgb(255, 255, 255)'; };
        const rgbOf = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const hex = (h: string) => { const m = /^#?([0-9a-f]{6})/i.exec(h.trim()); return m ? [0, 2, 4].map((k) => parseInt(m[1]!.slice(k, k + 2), 16)) : null; };
        for (const e of pg.querySelectorAll('*')) {
          const g = ownGround(e);
          if (!g || kindOf(e) === 'demo') continue;
          const want = hex(g);
          const have = rgbOf(bgOf(e));
          if (want && have.length === 3 && Math.hypot(want[0]! - have[0]!, want[1]! - have[1]!, want[2]! - have[2]!) > 48) out.push({ page: n, kind: 'misuse', text: `${e.getAttribute('aria-label') ?? e.getAttribute('alt') ?? 'logo'} made for ${g} on ${bgOf(e)}` });
        }
        // Heading-sized bold lines in the body face; specimens of a face are exempt.
        for (const e of all) {
          if (e.closest('[aria-hidden="true"]') || /specimen|demo/.test(kindOf(e))) continue;
          const own = [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim());
          if (!own) continue;
          const cs = getComputedStyle(e);
          const fam = cs.fontFamily.split(',')[0]!.replace(/["']/g, '').trim();
          if (parseFloat(cs.fontSize) >= 28 && Number(cs.fontWeight) >= 600 && policy.faces.length && !policy.faces.includes(fam) && !/mono/i.test(fam)) out.push({ page: n, kind: 'heading', text: `${fam} ${cs.fontSize}: ${short(e.textContent ?? '')}` });
        }
        // Raster pictures shown larger than they are.
        for (const e of pg.querySelectorAll('img')) {
          const img = e as HTMLImageElement;
          if (!img.naturalWidth || /svg/i.test(img.src.slice(0, 40)) || /\.svg(\?|$)/i.test(img.src)) continue;
          const r = rect.get(img) ?? img.getBoundingClientRect();
          const fit = getComputedStyle(img).objectFit;
          const k = fit === 'cover' ? Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight) : fit === 'contain' ? Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) : Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight);
          if (k > 1.15) out.push({ page: n, kind: 'upscaled', text: `${img.alt.slice(0, 50)} at ${k.toFixed(2)}x (${img.naturalWidth}x${img.naturalHeight})` });
        }
        // Lines of different text over each other: a sweep down the page, so only lines that share a band are compared.
        lines.sort((p, q) => p.rect.top - q.rect.top);
        for (let a = 0; a < lines.length; a++) for (let b2 = a + 1; b2 < lines.length && lines[b2]!.rect.top < lines[a]!.rect.bottom; b2++) {
          const x = lines[a]!, y = lines[b2]!;
          if (x.node === y.node) continue;
          const w = Math.min(x.rect.right, y.rect.right) - Math.max(x.rect.left, y.rect.left);
          const h = Math.min(x.rect.bottom, y.rect.bottom) - Math.max(x.rect.top, y.rect.top);
          if (w > 3 && h > Math.min(x.rect.height, y.rect.height) * 0.35) out.push({ page: n, kind: 'overlap', text: `${short(x.node.data).slice(0, 34)} / ${short(y.node.data).slice(0, 34)}` });
        }
      });
      // The brand's own rules, on every page.
      const family = (cs: CSSStyleDeclaration) => cs.fontFamily.split(',')[0]!.replace(/["']/g, '').trim();
      pages.forEach((pg, i) => {
        const n = i + 1;
        for (const e of pg.querySelectorAll('*')) {
          if (kindOf(e) === 'demo') continue;
          const cs = getComputedStyle(e);
          const own = [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim());
          if (own && policy.displayStretch && policy.faces[0] && family(cs) === policy.faces[0] && parseFloat(cs.fontSize) >= 40 && Number(cs.fontWeight) >= policy.displayMinWeight && parseFloat(cs.fontStretch) < policy.displayStretch - 1) out.push({ page: n, kind: 'rule', text: `display line at ${cs.fontStretch}, not ${policy.displayStretch}%: ${short(e.textContent ?? '')}` });
          if (e.tagName === 'IMG') {
            // The book says what each picture is (--bb-kind): a screenshot, a portrait or a photo.
            const what = `${(e as HTMLImageElement).alt}`;
            const kind = kindOf(e);
            if (policy.uncroppedScreens && kind === 'screen' && cs.objectFit === 'cover') out.push({ page: n, kind: 'rule', text: `screenshot cropped: ${what.slice(0, 50)}` });
            if ((policy.grayscale === 'portraits' && kind === 'portrait' || policy.grayscale === 'photos' && /portrait|photo/.test(kind)) && !/grayscale/.test(cs.filter)) out.push({ page: n, kind: 'rule', text: `picture in colour: ${what.slice(0, 50)}` });
          }
          if (own && policy.upperFamily && family(cs) === policy.upperFamily && cs.textTransform !== 'uppercase' && /\p{Ll}/u.test(e.textContent ?? '')) out.push({ page: n, kind: 'rule', text: `${policy.upperFamily} in lower case: ${short(e.textContent ?? '')}` });
          if (own && policy.italicFamily && family(cs) === policy.italicFamily && cs.fontStyle !== 'italic' && parseFloat(cs.fontSize) >= 24) out.push({ page: n, kind: 'rule', text: `${policy.italicFamily} upright: ${short(e.textContent ?? '')}` });
          if (policy.noShadow && cs.boxShadow !== 'none' && !/inset/.test(cs.boxShadow)) out.push({ page: n, kind: 'rule', text: `shadow on ${e.tagName.toLowerCase()} ${short(e.textContent ?? '')}` });
          if (policy.noField.length && kindOf(e) !== 'swatch' && cs.backgroundColor.startsWith('rgb')) {
            const hexOf = '#' + (cs.backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Math.round(Number(v)).toString(16).padStart(2, '0')).join('');
            const r = e.getBoundingClientRect();
            if (policy.noField.includes(hexOf) && r.width * r.height > 40_000) out.push({ page: n, kind: 'rule', text: `${hexOf} as a field ${Math.round(r.width)}x${Math.round(r.height)}` });
          }
          if (policy.noDashed && [cs.borderTopStyle, cs.borderBottomStyle, cs.borderLeftStyle, cs.borderRightStyle, cs.outlineStyle].includes('dashed')) out.push({ page: n, kind: 'rule', text: `dashed line on ${e.tagName.toLowerCase()}` });
        }
      });
      // The colophon counts the chapters the contents lists (the appendix is not a chapter).
      const contents = pages[1];
      const colophon = pages.at(-1);
      if (contents && colophon) {
        const listed = [...contents.querySelectorAll('li')].filter((li) => (li.firstElementChild?.textContent ?? '').trim() !== 'A').length;
        const m = /(?:\bof|\bvon|\bAll|\bAlle)\s+(\d+)\s+(?:chapters|Kapitel)/.exec(colophon.textContent ?? '');
        if (m && Number(m[1]) !== listed) out.push({ page: pages.length, kind: 'colophon', text: `says ${m[1]} chapters, the contents list ${listed}` });
      }
      const common = [...heads.reduce((m2, h) => m2.set(h.key, (m2.get(h.key) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
      for (const h of heads) if (h.key !== common) out.push({ page: h.page, kind: 'head', text: `${h.key}, the book's is ${common}` });
      return { pages: pages.length, out, thin, samples };
    }, policy)) as { pages: number; out: Defect[]; thin: { page: number; fill: number }[]; samples: { page: number; kind: string; text: string }[] };
    const voice = bookVoice(brandData);
    for (const x of found.samples) {
      const ok = x.kind === 'copy' ? voice.copyOk(x.text) : x.kind === 'letter' ? voice.copyOk(x.text) && voice.letterOk(x.text) : voice.headlineOk(x.text, x.kind === 'home');
      if (!ok) found.out.push({ page: x.page, kind: 'voice', text: `${x.kind}: ${x.text.slice(0, 60)}` });
    }
    // One defect per page, kind and text.
    const uniq = [...new Map(found.out.map((d) => [`${d.page}|${d.kind}|${d.text}`, d])).values()];
    report.push({ id: b.id, name: b.name, pages: found.pages, defects: uniq, ms });
    if (shots) {
      mkdirSync(shots, { recursive: true });
      const rects = await page.evaluate(() => [...document.querySelectorAll('body *')].map((e) => e.getBoundingClientRect()).filter((r) => Math.abs(r.width - 1280) < 1 && Math.abs(r.height - 800) < 1).map((r) => ({ x: r.left + scrollX, y: r.top + scrollY })));
      for (const [i, r] of rects.entries()) await page.screenshot({ path: join(shots, `${b.id}-p${String(i + 1).padStart(2, '0')}.png`), clip: { x: r.x, y: r.y, width: 1280, height: 800 }, captureBeyondViewport: true });
    }
    await page.close();
    const counts = Object.entries(uniq.reduce<Record<string, number>>((m, d) => ({ ...m, [d.kind]: (m[d.kind] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`${b.name} (${b.id}): ${found.pages} pages, ${uniq.length} defects${counts ? ` (${counts})` : ''}, ${found.thin.length} thin${found.thin.length ? ` (${found.thin.map((x) => `p${x.page} ${x.fill}%`).join(', ')})` : ''}, ${ms} ms`);
    thinTotal += found.thin.length;
    for (const d of uniq.slice(0, Number(process.env.SAMPLES ?? 6))) console.log(`    p${d.page} ${d.kind}: ${d.text}`);
  }
} finally {
  await browser.close();
  if (child) try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
}
const total = report.reduce((s, r) => s + r.defects.length, 0);
console.log(`\n${report.length} brands, ${report.reduce((s, r) => s + r.pages, 0)} pages, ${total} defects, ${thinTotal} pages under 60% full`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
process.exit(0);
