/** guide_get fonts: what the font tools let you do, and what makes a display face hold together. */
export const FONTS_GUIDE = `Making a font

You can draw a real font in a file. It lives on its own page as glyph cells: each cell is one glyph, a frame named by its character, as wide as the glyph's advance, on one em grid with guides for the ascender, cap height, x-height, baseline and descender. The vector layers in a cell are the outline, so the person can edit what you drew with the vector tools, and you can read back what they changed. A build turns the page into OTF and WOFF2 that text in the file uses at once and exports carry.

What the tools give you:
- font_create: a glyph page with the metrics you choose, answering with the y values of the guides. With from_font it starts from an open font instead: its outlines, metrics and kerning for the characters you name.
- font_glyphs_set: glyphs from SVG path data, up to 200 at a time, each with its advance. It answers with every glyph's bounds and side bearings, and notes such as a counter that fills in or a part past the advance. from_layer takes the shapes of an svg layer, such as one image_vectorize traced from a drawing, fitted to the cap height on the baseline.
- font_kerning_set: pairs by character or glyph name, in font units.
- font_update: names, weight and metrics; the guides of every cell follow, and outlines stay on the baseline.
- font_build: the OTF and WOFF2, a CSS value to use, and notes on glyphs worth another look. brand true offers it to the linked brand.
- font_specimen: the font set as text beside the glyphs: waterfall, pangram, the person's words, spacing strings, kerning pairs and the character set. With canvas_screenshot it shows you the face the way a reader sees it, which is where unevenness shows.
- fonts_made: the fonts of the file and whether the glyphs changed since their last build.

Coordinates are font units, y down, 0 on the ascender line, as the cell is drawn. With the default metrics (1000 per em, ascender 800, cap height 700, x-height 500, descender -200) the baseline is y 800, the cap height y 100, the x-height y 300 and the descender line y 1000; x runs from 0 to the advance. coordinates "font" takes y up from the baseline, as in a font file.

How outlines come out:
- A font has filled shapes only. A stem drawn as a stroke is left out; drawn as a shape, it is in.
- A counter (O, A, B, e) cuts a hole when it runs the other way round from the outline around it, or when the glyph uses fill_rule evenodd.
- Overlapping parts are kept and fill as one; fewer, cleaner contours still render and edit better.
- Points on the extremes of a curve, with handles level or upright there, keep rounds even.
- One unit is the finest step a font keeps.

What makes a display face hold together:
- H, O, n and o carry the system: stem weight, the rounds and the spacing that the rest repeat. Drawing them first and judging them on a specimen saves redrawing the rest.
- One stem weight on every vertical. Horizontals look as heavy at about 85 to 90 percent of it; diagonals look as heavy a little above it.
- Overshoot: rounds (O, C, G, S) about 1 to 2 percent of the em past the cap height and baseline, points (A, V) further, flat letters exactly on the lines.
- Crossbars and middle strokes a little above the true middle; the top of B, S, 8 and 3 a little narrower than the bottom.
- Strokes thinned towards a join (A, M, N, V, W, K), so the crotch stays open.
- One corner radius or curve tension throughout.
- Proportions by family: rounds wide, E F L narrow, H N U between; figures on one advance, so they line up.
- Colour by area, seen from far: a letter darker or lighter than its neighbours stands out on the specimen even when every stem measures right.

Spacing and kerning:
- Control strings show spacing: HOH and HHOHH for capitals, nnonn and nonon for lowercase. Round sides get about 60 to 80 percent of the space between straight sides, open and diagonal sides (A, V, T, L) almost none.
- Side bearings are the outline's start and the advance minus its end; font_glyphs_set reports both.
- Display sizes read best tighter than text, set in the font itself.
- Kerning is for what spacing cannot fix: AV, AT, AW, AY, LT, LV, LY, P., T., V., Y., To, Vo, F.

Starting points and licences: from scratch; from a drawing (asset_upload, image_vectorize, then from_layer); or from an open font whose own file states the SIL Open Font License, Apache 2.0 or MIT. A derived font gets a family name of its own, clear of the source's name and its Reserved Font Names, and keeps its copyright and licence; font_create checks both and refuses a proprietary font.

Using it: after font_build, "Family", sans-serif works as fontFamily in layer_style or as a token, and the inspector lists the font first for the person.`;
