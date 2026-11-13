# Fonts of your own

Ask your agent for a typeface, and it draws one in your file: a display face for a headline, a logotype
that types, a set of figures for a poster. Bogen builds it into a real font, OTF and WOFF2, and text in
the file can use it at once. Exports carry it.

- [How a font is kept](#how-a-font-is-kept)
- [Asking an agent](#asking-an-agent)
- [The glyph page in the editor](#the-glyph-page-in-the-editor)
- [Where to start from](#where-to-start-from)
- [Using the font](#using-the-font)
- [Licences](#licences)
- [Limits](#limits)

## How a font is kept

A font lives on a page of its own, named after it, such as **Quire Display glyphs**. On that page:

- An artboard holds one **cell** per glyph. A cell is a frame named by its character (A, 0, a full stop)
  or by a glyph name (`A.alt`). Its width is the glyph's **advance**.
- Every cell has the same em grid with five guides: ascender, cap height, x-height (dashed), baseline
  and descender. The guides are locked, and the build ignores them.
- The **vector layers** in a cell are the outline. They are ordinary vectors: select one and edit its
  nodes with the pen, or replace it.

The font's names, metrics and kerning are kept with the file, beside the page. Undo takes back a change
to the glyphs like any other.

Coordinates in a cell are font units, y down, with 0 on the ascender line. With the default metrics
(1000 units per em, ascender 800, cap height 700, x-height 500, descender -200) the baseline is at y 800
and the cap height at y 100. This is how agents write glyphs, and how the canvas draws them.

## Asking an agent

Say what the face is for and how it should feel: "a heavy squared display face for our posters, capitals
and figures". The agent works in a loop it reads in `guide_get fonts`:

1. `font_create` makes the page with the metrics.
2. `font_glyphs_set` writes glyphs from SVG path data, up to 200 at a time. It starts with H, O, n and o,
   which set the stems, rounds and spacing for the rest, and answers with each glyph's bounds and side
   bearings, and with notes such as a counter that fills in.
3. `font_build` makes the font; `font_specimen` sets it on a specimen artboard beside the glyphs: a
   waterfall, a pangram, your own words, spacing strings (HOHOH, nonon) and the kerning pairs. The agent
   looks at it with a screenshot and fixes what does not hold together.
4. `font_kerning_set` kerns the pairs that spacing cannot fix, such as AV and LT. `font_update` changes
   names and metrics; the guides of every cell follow, and outlines stay on the baseline.

`fonts_made` lists the fonts made in the file and whether the glyphs changed since the last build. The
[MCP tool reference](reference/mcp-tools.md#making-fonts) has every argument.

## The glyph page in the editor

Open the font's page. With nothing selected, the **Font** panel on the right shows:

- **Build font**, and when the last build was, with how many glyphs and kerning pairs. If the glyphs
  changed since, it says so. **Download OTF** and **Download WOFF2** save the built files.
- **Preview**: type a line and see it in the current build, at a size you pick.
- **Metrics**, in font units, with the colour of each guide.
- **Glyphs**: every glyph at a glance. A dashed one has no outline yet. Click one to go to its cell.

With a cell or an outline selected, **Build font** stays at the top of the inspector, above the layer's
own sections. To change a glyph's advance, change the cell's width.

## Where to start from

- **From scratch.** `font_create`, then draw.
- **From a drawing.** Upload a picture of a letter with `asset_upload`, trace it into a vector with
  `image_vectorize`, then `font_glyphs_set` with `from_layer`: it takes the darkest shapes, scales them
  to the cap height on the baseline and adds side bearings.
- **From an open font.** `font_create` with `from_font` (a font file on this computer, or a font the file
  holds) copies the outlines, metrics and kerning of the characters you name. See [Licences](#licences).

## Using the font

After a build, the font is a font of the file: in the inspector's font list it comes first, marked
**Made here**. Agents set it with `"Quire Display", sans-serif` as the font family. Screenshots,
exports and published pages load it from the file, never from Google Fonts.

`font_build` with `brand: true` also adds the font to the brand the file links to, as a suggested family
that the person confirms in the brand. Files linked to the brand then get it too.

## Licences

A font you draw from scratch is yours. Say which licence it has, if any, with `license`: `OFL-1.1` puts
it under the SIL Open Font License and writes the licence fields into the font.

Starting from someone else's font is allowed only when the font file itself says it may be changed:

- Its licence field must name the SIL Open Font License, Apache 2.0 or MIT. A font without such a
  licence is refused, whoever says it may be used. Bogen never starts from a proprietary font.
- The new font needs a family name of its own. It may not be the source's name, and it may not contain
  any of the source's **Reserved Font Names**, which an OFL font declares in its copyright line. Renaming
  later is held to the same rule.
- The source's copyright stays in the new font, with a line for the changes, and the licence goes with
  it: for an OFL font, the full licence text is kept as a file next to the font.

## Limits

- Outlines are filled shapes. A stroke on a vector is not part of the font: draw the stem as a shape.
- The build writes OpenType with CFF outlines (`.otf`) and WOFF2. It does not write TrueType (`.ttf`)
  or variable fonts, and it adds no hinting.
- Kerning is pairs of glyphs. There are no kerning classes, ligatures or other OpenType features yet.
- An outline layer rotated or skewed with CSS is left out of the build, with a note; transforms inside
  the SVG are fine.
- One font per page, one style per font. A bold and a regular are two fonts with the same family name
  and different weights.
