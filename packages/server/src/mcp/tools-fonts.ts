import {
  boundsOf, compileGlyphPage, createGlyphFontPage, DEFAULT_METRICS, emPx, evenOddToNonzero, FAMILY_NAME, fontToCell, getFontFaces, getGlyphFont, getGlyphFonts,
  glyphCells, glyphFontHash, glyphFontOfPage, glyphFontStack, guideLines, kerningSide, luminance, metricsProblems, newId, parseD, readCell, relayoutGlyphCells,
  resolveGlyphRef, setGlyphFont, SPECIMEN_ATTR, specimenSpec, svgFilledShapes, transformPaths, upsertBrandItem, writeGlyph, addFontFaces,
  type BogenDoc, type GlyphFont, type GlyphFontMetrics, type KerningPair, type SubPath,
} from '@bogen/core';
import { z } from 'zod';
import { BASIC_LATIN, buildGlyphFontInto, openLicenseOf, readSourceFont, renameProblem } from '../glyph-font-build.ts';
import { readLocalImage } from '../images.ts';
import { OFL_1_1 } from '../ofl.ts';
import type { Room } from '../sync.ts';
import { fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/**
 * Fonts drawn in a file: a page of glyph cells, written from SVG path data, built into OTF and WOFF2 and used by
 * text in the file at once. guide_get fonts says how to draw a face that holds together.
 */

const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);
const MAX_FONT_FILE = 30 * 1024 * 1024;
const OFL_NOTICE = 'This Font Software is licensed under the SIL Open Font License, Version 1.1.';
const OFL_URL = 'https://openfontlicense.org';

const metricsArg = z.object({
  units_per_em: z.number().int().min(16).max(16384).optional(),
  ascender: z.number().int().min(1).max(16384).optional(),
  cap_height: z.number().int().min(1).max(16384).optional(),
  x_height: z.number().int().min(1).max(16384).optional(),
  descender: z.number().int().min(-16384).max(0).optional().describe('Below the baseline, so 0 or negative, such as -200.'),
}).describe('Font units. Default: 1000 per em, ascender 800, cap height 700, x-height 500, descender -200.');

const fontIdArg = z.string().optional().describe('The font. Defaults to the font of the page you are on, then the only font in the file. fonts_made lists them.');

function toMetrics(given: z.infer<typeof metricsArg> | undefined, base: GlyphFontMetrics = DEFAULT_METRICS): GlyphFontMetrics {
  const m: GlyphFontMetrics = {
    unitsPerEm: given?.units_per_em ?? base.unitsPerEm, ascender: given?.ascender ?? base.ascender, capHeight: given?.cap_height ?? base.capHeight,
    xHeight: given?.x_height ?? base.xHeight, descender: given?.descender ?? base.descender,
  };
  const problems = metricsProblems(m);
  if (problems.length) throw new Error(`Those metrics do not work: ${problems.join(' ')}`);
  return m;
}

function guidesOut(font: GlyphFont) {
  const g = guideLines(font.metrics);
  return {
    coordinates: `SVG in font units, y down, 0 on the ascender line: draw each glyph between x 0 and its advance. Baseline y ${g.baseline}, cap height y ${g.capHeight}, x-height y ${g.xHeight}, descender y ${g.descender}.`,
    y: { ascender: g.ascender, cap_height: g.capHeight, x_height: g.xHeight, baseline: g.baseline, descender: g.descender },
  };
}

/** The font a call means: given, the one of the page in use, or the only one. */
function fontFor(ctx: ToolContext, room: Room, fontId?: string): GlyphFont {
  const fonts = getGlyphFonts(room.doc);
  if (fontId) {
    const f = getGlyphFont(room.doc, fontId);
    if (!f) throw new Error(`No font with id ${fontId} in this file.${fonts.length ? ` There are: ${fonts.map((x) => `${x.family} (${x.id})`).join(', ')}.` : ' Make one with font_create.'}`);
    return f;
  }
  const page = ctx.session.pageByFile.get(room.id) ?? room.humans().find((h) => h.pageId)?.pageId;
  const onPage = page ? glyphFontOfPage(room.doc, page) : undefined;
  if (onPage) return onPage;
  if (fonts.length === 1) return fonts[0]!;
  if (!fonts.length) throw new Error('There is no font in this file yet. Make one with font_create.');
  throw new Error(`This file has ${fonts.length} fonts: ${fonts.map((x) => `${x.family} (${x.id})`).join(', ')}. Pass font_id.`);
}

function useFont(ctx: ToolContext, room: Room, font: GlyphFont): void {
  ctx.page(room, font.pageId);
}

/** Refuses a font page where page_create would be refused: in a revision, or in a run asked to change existing work. */
function assertMayAddPage(ctx: ToolContext, room: Room): void {
  const rev = ctx.revision(room);
  if (rev && rev.intent !== 'new_page') throw new Error(`This conversation works in the revision "${rev.name}" (${rev.id}). A font needs a page of its own; the person asks for one with New page, or after accepting the revision.`);
  const intent = ctx.runIntent();
  const hasWork = room.doc.getPages().some((p) => room.doc.getChildren(p.id).length > 0);
  if (intent && intent !== 'new_page' && hasWork) throw new Error('This run was asked to change the existing design, and a font needs a page of its own, so font_create is refused. Say in your reply that a new font is ready to be made: the person asks for it with New page in the prompt bar.');
}

async function fontBytes(ctx: ToolContext, from: { path?: string; src?: string }): Promise<Uint8Array> {
  if (Boolean(from.path) === Boolean(from.src)) throw new Error('from_font needs either path or src.');
  if (from.path) {
    if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('path works only on a server that listens on this machine alone. Use a font the file already holds: fonts_captured lists them with their src.');
    return readLocalImage(from.path, MAX_FONT_FILE);
  }
  const name = /^bogen-asset:([a-f0-9]{64}\.(woff2|woff|ttf|otf))$/.exec(from.src!)?.[1];
  if (!name) throw new Error('src must be a font Bogen stores, such as bogen-asset:<hash>.woff2 from fonts_captured.');
  const asset = await ctx.app.storage.readAsset(name);
  if (!asset) throw new Error(`There is no stored font ${from.src}.`);
  return asset.bytes;
}

function summary(doc: BogenDoc, font: GlyphFont) {
  const cells = glyphCells(doc, font);
  const drawn = cells.filter((c) => readCell(doc, font, c.id).contours.length).length;
  const current = font.build ? font.build.hash === glyphFontHash(doc, font) : false;
  return {
    font_id: font.id, family: font.family, style: font.style, weight: font.weight, italic: font.italic, page_id: font.pageId,
    glyphs: cells.length, drawn, kerning_pairs: font.kerning.length, metrics: font.metrics, origin: font.origin,
    build: font.build ? { at: new Date(font.build.at).toISOString(), glyphs: font.build.glyphs, otf: font.build.otf, woff2: font.build.woff2, current } : null,
    css: `font-family: ${glyphFontStack(font)}`,
  };
}

/** The darkest fill of a traced image: the ink, with the paper behind it left out. */
function inkOf(shapes: { fill: string }[]): string | undefined {
  let best: string | undefined;
  let low = Infinity;
  for (const s of shapes) {
    const l = luminance(s.fill === 'currentcolor' ? '#000' : s.fill);
    if (l < low) { low = l; best = s.fill; }
  }
  return best;
}

export function registerFontTools(define: ToolDefiner): void {
  define('font_create', { description: 'Start a font of your own: a page of glyph cells on one em grid, with guides for the ascender, cap height, x-height, baseline and descender. Each cell is one glyph, named by its character; its width is the advance and its vector layers are the outline, which people can edit with the vector tools. Then draw with font_glyphs_set, build with font_build and judge it with font_specimen. With from_font it starts from an open font instead, copying the outlines, metrics and kerning of the characters you name: only a font file whose own licence allows changes (SIL Open Font License, Apache 2.0 or MIT), and under a new family name that keeps clear of its Reserved Font Names. A proprietary font is refused. Read guide_get fonts before you draw.' }, {
    family: z.string().min(1).max(60).describe('The family name text will use, such as "Quire Display". Letters, digits, spaces and _ . + -.'),
    style: z.string().min(1).max(40).default('Regular'),
    weight: z.number().int().min(100).max(900).default(400),
    italic: z.boolean().default(false),
    metrics: metricsArg.optional(),
    designer: z.string().max(200).optional(),
    license: z.string().max(400).optional().describe('For a font from scratch: OFL-1.1 to put it under the SIL Open Font License, or a short licence sentence. Leave out when the person has not said.'),
    from_font: z.object({
      path: z.string().min(1).max(4096).optional().describe('A font file on this computer (OTF, TTF, WOFF or WOFF2), as an absolute path under the home or temp folder.'),
      src: z.string().optional().describe('Or a font the file holds, such as a src from fonts_captured.'),
      characters: z.string().max(2000).optional().describe('Which characters to copy. Default: printable ASCII.'),
    }).optional().describe('Start from an open font the person may change.'),
    file_id: fileIdArg,
  }, async ({ family, style, weight, italic, metrics, designer, license, from_font, file_id }, ctx) => {
    if (!FAMILY_NAME.test(family.trim())) throw new Error(`"${family}" cannot be a family name: letters, digits, spaces and _ . + - only, at most 60.`);
    family = family.trim();
    const room = await ctx.room(file_id);
    assertMayAddPage(ctx, room);
    const taken = [...getGlyphFonts(room.doc).map((f) => f.family), ...getFontFaces(room.doc).map((f) => f.family)];
    if (taken.some((f) => f.toLowerCase() === family.toLowerCase())) throw new Error(`This file already has a font called ${family}. Pick another family name, or work on that one: fonts_made lists the fonts made here.`);
    const id = newId();
    const year = new Date().getFullYear();
    if (!from_font) {
      const m = toMetrics(metrics);
      const ofl = license && /^(OFL|OFL-1\.1|SIL OFL)/i.test(license.trim());
      const font = ctx.write(room, () => createGlyphFontPage(room.doc, {
        id, family, style, weight, italic, metrics: m, designer, origin: { kind: 'scratch' },
        ...(designer ? { copyright: `Copyright ${year} ${designer}` } : {}),
        ...(ofl ? { license: OFL_NOTICE, licenseUrl: OFL_URL } : license ? { license } : {}),
      }));
      useFont(ctx, room, font);
      ctx.touch([font.rootId]);
      return { font_id: font.id, family, page_id: font.pageId, root_id: font.rootId, metrics: font.metrics, ...guidesOut(font), scale: `${font.scale} px on the canvas per font unit`, next: 'Draw glyphs with font_glyphs_set, a few at a time: H, O, n and o first, as they set the stems, rounds and spacing for the rest. guide_get fonts has the method.' };
    }

    if (ctx.dryRun) throw new Error('font_create with from_font reads a font file, so it does not run in a dry run.');
    const source = await readSourceFont(await fontBytes(ctx, from_font), from_font.characters ?? BASIC_LATIN);
    const open = openLicenseOf(source);
    const problem = renameProblem(family, source.family, open.reservedNames);
    if (problem) throw new Error(problem);
    if (!source.glyphs.length) throw new Error(`${source.family} has none of those characters.`);
    const m = toMetrics(metrics, source.metrics);
    if (m.unitsPerEm !== source.metrics.unitsPerEm) throw new Error(`The outlines are drawn on ${source.metrics.unitsPerEm} units per em, so the new font keeps that. Leave units_per_em out.`);
    const copyright = [source.copyright, `Modifications copyright ${year}${designer ? ` ${designer}` : ''}.`].filter(Boolean).join('\n');
    const licenseFields = open.license === 'OFL-1.1'
      ? { license: OFL_NOTICE, licenseUrl: OFL_URL, text: `${copyright}\n\n${OFL_NOTICE}\nThis license is copied below, and is also available with a FAQ at: ${OFL_URL}\n\n${OFL_1_1}\n` }
      : { license: source.license, licenseUrl: source.licenseUrl, text: `${copyright}\n\n${source.license}\n${source.licenseUrl}\n` };
    const text = await ctx.app.storage.putAsset(new TextEncoder().encode(licenseFields.text), 'text/plain');
    const kerning: KerningPair[] = source.kerning;
    const font = ctx.write(room, () => {
      const f = createGlyphFontPage(room.doc, {
        id, family, style, weight, italic, metrics: m, designer, copyright, license: licenseFields.license, licenseUrl: licenseFields.licenseUrl, licenseText: text.src, kerning,
        origin: { kind: 'derived', from: source.family, license: open.license, reservedNames: open.reservedNames },
      });
      for (const g of source.glyphs) writeGlyph(room.doc, f, { name: g.name, unicodes: g.unicodes, advance: g.advance, paths: fontToCell(g.contours, m) });
      return f;
    });
    useFont(ctx, room, font);
    ctx.touch([font.rootId]);
    return {
      font_id: font.id, family, page_id: font.pageId, root_id: font.rootId, from: source.family, license: open.license,
      ...(open.reservedNames.length ? { reserved_font_names: open.reservedNames } : {}),
      glyphs: source.glyphs.length, kerning_pairs: kerning.length, ...(source.missing.length ? { missing: source.missing.join('') } : {}),
      license_text: text.src, metrics: font.metrics, ...guidesOut(font),
      next: `The outlines of ${source.family} are on the page, under its licence, kept with the font. Change them with font_glyphs_set, then font_build.`,
    };
  });

  define('font_glyphs_set', { description: 'Write glyphs of a font from SVG path data, up to 200 at a time. Each one is named by char (such as "A") or name (such as "A.alt"), with its advance and d, the outline in cell coordinates: font units, y down, 0 on the ascender line, so the baseline is at y = ascender (font_create says the numbers). A glyph you name again is replaced; leaving d out keeps its outline and changes only what you give. Outlines are filled, not stroked: draw a stem as a shape. With fill_rule evenodd a shape inside another cuts a counter; with the default nonzero, draw the counter the other way round. from_layer takes the outline of an svg layer instead, such as one image_vectorize traced, fitted to the cap height on the baseline. Each glyph comes back with its bounds and notes on holes that fill in or parts outside the cell.' }, {
    font_id: fontIdArg,
    glyphs: z.array(z.object({
      char: z.string().min(1).max(4).optional(),
      name: z.string().min(1).max(63).optional().describe('A glyph name, for one without a character of its own or to name it differently.'),
      unicode: z.union([z.string().max(12), z.number().int()]).optional().describe('Hex, such as "00C4", for a name that is not a character.'),
      advance: z.number().min(0).max(16384).optional().describe('Font units. Default for a new glyph: the outline\'s width plus its left side bearing.'),
      d: z.string().max(40000).optional().describe('SVG path data. An empty string clears the outline, as for a space.'),
      fill_rule: z.enum(['nonzero', 'evenodd']).default('nonzero'),
      coordinates: z.enum(['cell', 'font']).default('cell').describe('cell: y down from the ascender line (default). font: y up from the baseline, as in a font file.'),
      from_layer: z.string().optional().describe('An svg layer to take the outline from, instead of d.'),
      fit: z.enum(['cap_height', 'x_height', 'ascender_to_descender']).default('cap_height').describe('With from_layer: the height its outline is scaled to.'),
      side_bearing: z.number().min(-2000).max(2000).optional().describe('With from_layer: space left and right, in font units. Default 6% of the em.'),
    })).min(1).max(200),
    file_id: fileIdArg,
  }, async ({ font_id, glyphs, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const font = fontFor(ctx, room, font_id);
    useFont(ctx, room, font);
    const doc = room.doc;
    const m = font.metrics;
    const prepared = glyphs.map((g, i) => {
      const where = `glyph ${i + 1}${g.char ? ` (${g.char})` : g.name ? ` (${g.name})` : ''}`;
      let ref: { name: string; unicodes: number[] };
      try {
        ref = resolveGlyphRef(g);
      } catch (e) {
        throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`);
      }
      let paths: SubPath[] | undefined;
      let advance = g.advance;
      let fillRule = g.fill_rule;
      if (g.from_layer !== undefined && g.d !== undefined) throw new Error(`${where}: give d or from_layer, not both.`);
      if (g.from_layer) {
        const layer = doc.getNode(g.from_layer);
        if (!layer || layer.type !== 'svg' || !layer.svg) throw new Error(`${where}: ${g.from_layer} is not an svg layer. image_vectorize makes one from an image.`);
        const w = parseFloat(layer.style.width ?? '') || 100;
        const h = parseFloat(layer.style.height ?? '') || 100;
        const { shapes } = svgFilledShapes(layer.svg, w, h);
        const ink = inkOf(shapes);
        const own = shapes.filter((s) => s.fill === ink).flatMap((s) => (s.evenodd ? evenOddToNonzero(s.paths) : s.paths));
        if (!own.length) throw new Error(`${where}: ${layer.name} has no filled shapes.`);
        const b = boundsOf(own);
        const target = g.fit === 'x_height' ? m.xHeight : g.fit === 'ascender_to_descender' ? m.ascender - m.descender : m.capHeight;
        const top = g.fit === 'x_height' ? m.ascender - m.xHeight : g.fit === 'ascender_to_descender' ? 0 : m.ascender - m.capHeight;
        const k = target / (b.h || 1);
        const sb = g.side_bearing ?? Math.round(m.unitsPerEm * 0.06);
        paths = transformPaths(own, [k, 0, 0, k, sb - b.x * k, top - b.y * k]);
        advance ??= Math.round(b.w * k + 2 * sb);
        fillRule = 'nonzero';
      } else if (g.d !== undefined) {
        paths = parseD(g.d).map((p) => ({ ...p, closed: true })).filter((p) => p.points.length > 1);
        if (g.d.trim() && !paths.length) throw new Error(`${where}: d has no shape in it. Write path data such as "M60 100H180V800H60Z".`);
        if (g.coordinates === 'font') paths = fontToCell(paths, m);
      }
      return { ref, paths, advance, fillRule };
    });
    const names = prepared.map((p) => p.ref.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`${dup} is in the list twice. Give each glyph once.`);
    const written = ctx.write(room, () => prepared.map((p) => ({ p, out: writeGlyph(doc, font, { name: p.ref.name, unicodes: p.ref.unicodes, advance: p.advance, paths: p.paths, fillRule: p.fillRule }) })));
    ctx.touch(written.map((w) => w.out.cellId));
    const compiled = new Map(compileGlyphPage(doc, font).glyphs.map((g) => [g.name, g]));
    return {
      font_id: font.id,
      glyphs: written.map(({ p, out }) => {
        const g = compiled.get(p.ref.name);
        const b = g?.contours.length ? boundsOf(g.contours) : null;
        return {
          name: p.ref.name, ...(p.ref.unicodes[0] !== undefined ? { char: String.fromCodePoint(p.ref.unicodes[0]) } : {}), cell_id: out.cellId, created: out.created, advance: out.advance,
          ...(b ? { bounds: { left: Math.round(b.x), right: Math.round(b.x + b.w), bottom: Math.round(b.y), top: Math.round(b.y + b.h), right_side_bearing: Math.round(out.advance - b.x - b.w) } } : { empty: true }),
          ...(g?.notes.length ? { notes: g.notes } : {}),
        };
      }),
      note: 'bounds are in font units, y up from the baseline.',
      next: 'Look at the cells with canvas_screenshot node_id root, then font_build and font_specimen to see them set as text.',
    };
  });

  define('font_kerning_set', { description: 'Set kerning pairs of a font: how much closer (negative) or further apart two glyphs sit, in font units, such as {"left":"A","right":"V","value":-60}. Name sides by character or glyph name. Value 0 takes a pair away; replace true starts from none. Space glyphs well first, then kern the pairs that still look wrong, such as AV, LT, To, P.' }, {
    font_id: fontIdArg,
    pairs: z.array(z.object({ left: z.string().min(1).max(63), right: z.string().min(1).max(63), value: z.number().int().min(-2000).max(2000) })).max(2000),
    replace: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ font_id, pairs, replace, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const font = fontFor(ctx, room, font_id);
    const map = new Map((replace ? [] : font.kerning).map((k) => [`${k.left} ${k.right}`, k]));
    for (const p of pairs) {
      const left = kerningSide(p.left), right = kerningSide(p.right);
      if (p.value) map.set(`${left} ${right}`, { left, right, value: p.value });
      else map.delete(`${left} ${right}`);
    }
    const kerning = [...map.values()];
    ctx.write(room, () => setGlyphFont(room.doc, { ...(getGlyphFont(room.doc, font.id) ?? font), kerning }));
    const names = new Set(glyphCells(room.doc, font).map((c) => c.name));
    const unknown = [...new Set(kerning.flatMap((k) => [k.left, k.right]).filter((n) => !names.has(n)))];
    return { font_id: font.id, kerning_pairs: kerning.length, ...(unknown.length ? { note: `No cell yet for ${unknown.slice(0, 12).join(', ')}: those pairs wait until the glyphs exist.` } : {}), next: 'font_build, then font_specimen to see them.' };
  });

  define('font_update', { description: 'Change the names or metrics of a font: family, style, weight, italic, designer, version, licence, and ascender, cap height, x-height or descender. New metrics redraw the guides of every cell and keep outlines where they sit on the baseline. Units per em are fixed once glyphs are drawn. A derived font keeps clear of its source\'s name and Reserved Font Names here too.' }, {
    font_id: fontIdArg,
    family: z.string().min(1).max(60).optional(),
    style: z.string().min(1).max(40).optional(),
    weight: z.number().int().min(100).max(900).optional(),
    italic: z.boolean().optional(),
    designer: z.string().max(200).optional(),
    version: z.string().regex(/^\d{1,3}\.\d{1,3}$/).optional().describe('Such as 1.001.'),
    license: z.string().max(400).optional(),
    metrics: metricsArg.optional(),
    file_id: fileIdArg,
  }, async ({ font_id, family, style, weight, italic, designer, version, license, metrics, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const font = fontFor(ctx, room, font_id);
    const doc = room.doc;
    if (family !== undefined) {
      family = family.trim();
      if (!FAMILY_NAME.test(family)) throw new Error(`"${family}" cannot be a family name: letters, digits, spaces and _ . + - only, at most 60.`);
      if (font.origin.kind === 'derived') {
        const problem = renameProblem(family, font.origin.from ?? '', font.origin.reservedNames ?? []);
        if (problem) throw new Error(problem);
      }
    }
    if (font.origin.kind === 'derived' && license !== undefined) throw new Error(`This font is derived from ${font.origin.from} and stays under its licence (${font.origin.license}).`);
    const m = metrics ? toMetrics(metrics, font.metrics) : font.metrics;
    const drawn = glyphCells(doc, font).some((c) => readCell(doc, font, c.id).contours.length);
    if (m.unitsPerEm !== font.metrics.unitsPerEm && drawn) throw new Error('Units per em are fixed once glyphs are drawn: the outlines are in those units. Leave units_per_em out.');
    const ofl = license && /^(OFL|OFL-1\.1|SIL OFL)/i.test(license.trim());
    const next: GlyphFont = {
      ...font, metrics: m, ...(m.unitsPerEm !== font.metrics.unitsPerEm ? { scale: emPx(font) / (m.ascender - m.descender) } : {}),
      ...(family !== undefined ? { family } : {}), ...(style !== undefined ? { style } : {}), ...(weight !== undefined ? { weight } : {}), ...(italic !== undefined ? { italic } : {}),
      ...(designer !== undefined ? { designer } : {}), ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? (ofl ? { license: OFL_NOTICE, licenseUrl: OFL_URL } : { license, licenseUrl: undefined }) : {}),
    };
    ctx.write(room, () => {
      if (JSON.stringify(m) !== JSON.stringify(font.metrics)) relayoutGlyphCells(doc, font, next);
      if (family !== undefined && family !== font.family) {
        doc.renamePage(font.pageId, `${family} glyphs`);
        doc.updateFields(font.rootId, { name: `${family} glyphs` });
      }
      setGlyphFont(doc, next);
    });
    useFont(ctx, room, next);
    return { ...summary(doc, next), ...guidesOut(next), next: 'font_build makes the font again with the new names and metrics.' };
  });

  define('font_build', { description: 'Build a font from its glyph page: an OpenType file with CFF outlines and a WOFF2, with the family and style names, metrics, kerning and licence fields. It becomes a font of this file at once: text in the file can use it as font-family, and screenshots and exports carry it. brand true also gives it to the brand the file links to, as a suggested family the person confirms. Returns the files, a CSS value to use and notes on glyphs worth fixing.' }, {
    font_id: fontIdArg,
    brand: z.boolean().default(false).describe('Also add it to the linked brand, as a suggestion.'),
    file_id: fileIdArg,
  }, async ({ font_id, brand, file_id }, ctx) => {
    if (ctx.dryRun) throw new Error('font_build writes font files, so it does not run in a dry run.');
    const room = await ctx.room(file_id);
    const font = fontFor(ctx, room, font_id);
    const { font: built, built: out } = await buildGlyphFontInto(ctx.app.storage, room.doc, font, (fn) => ctx.write(room, fn), ctx.agent);
    let brandOut: Record<string, unknown> | undefined;
    if (brand) {
      const found = await ctx.app.brands.forRoom(room);
      if (!found?.doc) brandOut = { added: false, note: 'This file links to no brand on this device, so only the file has the font.' };
      else {
        const brandRoom = await ctx.app.brands.room(found.link.id);
        const existing = found.data?.families.find((f) => f.family.toLowerCase() === built.family.toLowerCase());
        ctx.write(brandRoom, () => {
          addFontFaces(brandRoom.doc, [{ family: built.family, src: built.build!.woff2, weight: String(built.weight), style: built.italic ? 'italic' : 'normal', display: 'swap', from: 'Built in a linked file' }]);
          upsertBrandItem(brandRoom.doc, 'families', {
            ...(existing ? { id: existing.id } : {}), family: built.family, role: existing?.role ?? 'display', fallback: existing?.fallback ?? 'sans-serif',
            weights: [...new Set([...(existing?.weights ?? []), built.weight])], license: built.license ?? '', assets: [built.build!.woff2], suggested: existing ? existing.suggested : true,
          });
        });
        brandOut = { added: true, brand_id: found.link.id, note: existing ? 'The brand\'s family has the new build.' : 'Added to the brand as a suggested family: the person confirms it in the brand.' };
      }
    }
    return {
      font_id: built.id, family: built.family, css: `font-family: ${glyphFontStack(built)}`, glyphs: out.glyphs, kerning_pairs: out.kerning,
      otf: built.build!.otf, woff2: built.build!.woff2, otf_kb: Math.round(out.otf.length / 102.4) / 10, woff2_kb: Math.round(out.woff2.length / 102.4) / 10,
      ...(out.notes.length ? { notes: out.notes } : {}), ...(out.glyphNotes.length ? { glyph_notes: out.glyphNotes } : {}), ...(out.empty.length ? { empty: out.empty } : {}),
      ...(brandOut ? { brand: brandOut } : {}),
      next: 'font_specimen sets it as text to look at. Use it in the file with layer_style {"fontFamily": ' + JSON.stringify(glyphFontStack(built)) + '}.',
    };
  });

  define('fonts_made', { description: 'Fonts made in this file: each with its glyph page, how many glyphs are drawn, its last build and whether the glyphs changed since.', readOnly: true }, {
    file_id: fileIdArg,
  }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return getGlyphFonts(room.doc).map((f) => summary(room.doc, f));
  });

  define('font_specimen', { description: 'Set a font as text on a specimen artboard beside its glyphs, to judge it: the name and metrics, a waterfall from large to small, a pangram, the person\'s own words, spacing strings with control characters (HOHOH, nonon) and its kerning pairs, and the whole character set. It builds the font first when the glyphs changed since the last build. Look at it with canvas_screenshot: uneven colour, stems of different weight, letters that crowd or fall apart show up here.' }, {
    font_id: fontIdArg,
    words: z.string().max(200).optional().describe('The person\'s own words, such as their headline.'),
    sizes: z.array(z.number().min(6).max(400)).max(8).optional().describe('px. Default 96, 64, 40, 24, 16.'),
    file_id: fileIdArg,
  }, async ({ font_id, words, sizes, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    let font = fontFor(ctx, room, font_id);
    const doc = room.doc;
    let rebuilt = false;
    if (!font.build || font.build.hash !== glyphFontHash(doc, font)) {
      if (ctx.dryRun) throw new Error('The font needs a build first, which does not run in a dry run.');
      font = (await buildGlyphFontInto(ctx.app.storage, doc, font, (fn) => ctx.write(room, fn), ctx.agent)).font;
      rebuilt = true;
    }
    const chars = glyphCells(doc, font).flatMap((c) => c.unicodes.map((u) => String.fromCodePoint(u))).join('');
    const root = doc.getNode(font.rootId);
    const x = (parseFloat(root?.style.left ?? '0') || 0) + (parseFloat(root?.style.width ?? '1280') || 1280) + 120;
    const y = parseFloat(root?.style.top ?? '0') || 0;
    const old = doc.getChildren(font.pageId).find((n) => n.attrs?.[SPECIMEN_ATTR] === font.id);
    const spec = specimenSpec(font, { chars, words, sizes, x: old ? parseFloat(old.style.left ?? `${x}`) || x : x, y: old ? parseFloat(old.style.top ?? `${y}`) || y : y });
    const id = ctx.write(room, () => {
      if (old) doc.delete([old.id]);
      return doc.insert(font.pageId, spec);
    });
    ctx.page(room, font.pageId);
    ctx.touch([id]);
    return { id, font_id: font.id, built: rebuilt, next: `canvas_screenshot node_id ${id} to look at it. Fix glyphs with font_glyphs_set, then call font_specimen again.` };
  });
}

