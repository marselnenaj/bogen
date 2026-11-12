# Capture and import

## Capture: a live page on the canvas

Capture opens a page in the headless browser and copies it onto the canvas as editable layers: real
text, images, vectors and CSS, laid out as the page was. Use it to start from an existing site, to
redesign it, or to [extract a brand](brand.md#bring-in-what-exists) from it.

### One page

```sh
bogen capture https://example.com
```

| Option | What it does |
| --- | --- |
| `--file <id>` | Add the artboard to this file. Without it, a new file named after the host. |
| `--page <name>` | The page in that file. |
| `--name <name>` | The artboard's name. |
| `--width <px>` | The viewport width, 200 to 4000. Default 1440. |
| `--height <px>` | The viewport height, 200 to 4000. Default 900. |
| `--scheme dark\|light` | The colour scheme the page sees. |
| `--no-fonts` | Do not keep the page's self-hosted fonts. |

It prints the result as JSON. Your agent does the same with `page_capture`.

### A whole site

```sh
bogen capture --site https://example.com --widths 1440,768,390 --schemes dark,light --limit 30
```

Bogen finds the routes through `robots.txt`, the sitemap and links on the same origin, and captures
one page per route, with one artboard per width and colour scheme. Links to anchors on the same page
keep working, with their targets. It prints its progress and ends with a report: what it captured,
the fonts it kept, and what it skipped or could not capture.

| Option | What it does |
| --- | --- |
| `--widths` | Widths, comma separated. Default 1440. |
| `--schemes` | `dark`, `light` or both. Default dark. |
| `--limit` | The most routes to capture. Default 30, at most 200. |
| `--file <id>` | Add to this file instead of a new one. |
| `--name <name>` | The name of the new file. |
| `--no-fonts` | Do not keep self-hosted fonts. |

Your agent uses `site_capture`, which takes at most 50 routes and answers with a job id when the
capture takes long; `site_capture_status` follows it.

### What may be captured

- Public addresses, from the command line and from your agent.
- Pages on this computer (`localhost`, `127.0.0.1`), such as your dev server: from the command line
  only.
- Addresses on your private network: not at all.

These are technical limits. Whether you may copy a page is a separate question: its text, images, layout and fonts
usually belong to someone, and a site's terms may forbid automated copying. Capture your own sites, sites you work on
for their owner, or pages whose licence allows it. For anything else, use the capture to study and measure, not to
republish.

### Fonts

Capture keeps the font files that the page's own style sheets declare for the families it uses: the
bytes the browser received, and other weights of those families from the same address. They are
stored in the document. A family the page declares but does not use stays out. They load on the canvas, in renders and in HTML, SVG and
`.bogen` exports, without a Google Fonts request for those families. Fonts the page takes from Google
Fonts stay as names. Each kept face records where it came from; your agent lists them with
`fonts_captured`.

Keeping a font does not change its licence. Whether you may use it in other work is up to the
licence. `--no-fonts` turns this off.

### Light and dark

Capture a page a second time in the other colour scheme, and Bogen fills in that theme mode's token
values instead of adding a second set of hard-coded colours. Both artboards then use tokens. It reads
the page's own CSS variables and compares the two captures.

This works for sites that switch with `prefers-color-scheme`. A site that switches themes with a class
gives no difference, and the result says so. Only colours are compared. For an artboard captured
before Bogen tracked this, your agent passes `pair_with`. It has been tried on a test page with a real
colour scheme switch, not yet on a live site.

### Hover and focus

Hover, focus and active rules of a captured page are kept apart, per artboard, with the layers they
match. They do not render on the canvas. Your agent reads them with `interaction_rules` when it
rebuilds the page in code, and can turn one into a `:hover` block on the layer with `layer_style`,
which then shows in preview mode and in exports. Captured `::before` and `::after` become child
layers; see [Pseudo-elements and conditions](pseudo-and-conditions.md#capture).

### Limits

- Motion is not captured.
- Content wider than a phone viewport is captured at the phone width, so captures at 390 differ more
  from the live page: 2.89% of the pixels on the home page of tomacco.dev, the maintainer's own site.
- There is no browser extension; Capture runs from the command line, from your agent and over
  HTTP.

On the seven pages of tomacco.dev at 1440 wide, dark, the capture differs from the live site by
0.07% of the pixels on the home page and 0.00% on the six text pages, with exact heights.

## Drift: compare a design with its live site

Once a design and its site have both moved on, Drift says where they went apart. Open an artboard's
**Drift** tab in the right panel, or run **Compare with the live site (Drift)** from the command
palette. The address is the one the artboard was captured from; type another for an artboard that was
not captured. **Compare** opens the page in the same sandboxed browser Capture uses, at the
artboard's width and colour scheme, and compares it twice:

- **By pixels**, like `visual_diff`: the share of pixels that differ, and an overlay with them in red
  over the artboard. **Show differences on the canvas** turns it on and off.
- **By structure**: layers are matched to the live page's elements by their words, role (heading,
  button, link, image, field and so on) and place, a child looked for where its parent went, so a
  banner added at the top does not make everything below it a drift.

Each drift names the layer, the live element's CSS selector, and the CSS value on both sides:

| Kind | What it means |
| --- | --- |
| spacing | Padding, margin or gap differ, such as `column-gap` 24px in the design and 32px live. |
| size | Width, height, border width or radius differ, when nothing inside explains it. |
| color | Text, background or border colour differ. In a file with a brand it says whether the live colour is in the brand. |
| font | Family, size, weight, line height or letter spacing differ, and whether the live family is in the brand. |
| text | The words changed. |
| missing | A layer the live page does not have. Its children are not listed again. |
| extra | An element only the live page has, shown as a dashed box on the artboard. |

Filter the list by layout, style, text or elements. A click on a drift selects its layer; for an
extra element, the layer it sits in, or its place on the artboard.

Your agent uses `drift_check`, which returns the same drifts as data and the overlay as a picture.
To fix a repository from them, it calls `code_get` on each drift's layer and changes the element its
selector names, with its own file tools; `guide_get code` has the steps. Which side is right is your
call: the site may be newer than the design.

The same rule as Capture holds: your agent can compare with public pages only. A page on this
computer, such as your dev server, can be compared from the editor on this computer. Addresses on
your private network are never opened. A drift check reads the design and changes nothing in it.

Only what is painted counts: the inside of a closed `<details>` and elements hidden by CSS are left
out on both sides, and so are the `::before` and `::after` layers Capture makes, which have no
element of their own on the live page.

The tomacco.dev home page, captured and then compared at once, shows 0.07% different pixels and no
drifts. A drift check also shows where Capture itself is not exact: on pages whose layout Capture
does not reproduce exactly, such as table layouts, it lists those differences too.

Limits: it compares one artboard with one page at a time; layers are matched by heuristics, so a
section that was rebuilt from scratch shows as missing and extra rather than as changes; hover states
and motion are not compared; pixels are compared down to 24000px; and at most 4000 elements per
side.

## Import from Figma

```sh
bogen import figma https://www.figma.com/design/<key>/... --token <your token>
```

Bogen reads the file through Figma's public REST API with your own personal access token. Make one in
Figma under Settings, Security, with the `file_content:read` scope.

| Option | What it does |
| --- | --- |
| `--token <t>` | Your token. `FIGMA_TOKEN` in the environment works too. |
| `--save-token` | Keep the token for later imports, in `config.json` in the data folder, readable by you only. |
| `--name <name>` | The name of the new file. |

It makes a new file and reports what did not come over exactly. The home screen has **Import from
Figma** too, and your agent has `figma_import`.

What comes over: frames, auto layout as flex (wrapping, absolute children with their constraints,
negative spacing, first on top) and grids with their tracks and spans, text with style ranges and
lists, fills, gradients, image fills with crops, tiles and adjustments, strokes on all or some sides,
effects, shape masks, vectors through Figma's SVG render or, when that fails, from the file's own
paths, and images. Components become components here: a component set becomes a variant set, text and
boolean properties become props, and instances stay linked to their main, with their property values,
swaps and changes as overrides.

Limits:

- An instance of a component that is not in the import (from a team library, or left out by a frame
  link) comes over as a plain frame. Instance swap and slot properties are not props: each instance
  keeps its own swap.
- Masks other than a plain rectangle, ellipse or frame stay plain layers. Diamond gradients are radial.
- Line height, letter case and gradient fills of a range of text, spacing between paragraphs and the
  indentation of nested list items are left out. List markers become characters in the text.
- Image adjustments are close, not equal. Temperature, tint, highlights, shadows and rotated image
  fills are left out.
- Fonts come by name. Google Fonts load; other fonts need to be on your machine.
- The report lists each of these when a file uses it.
- It has been built from Figma's public documentation and API types, and tested against recorded
  answers, not yet against the real API. Expect rough edges with real files.

Bogen does not read Figma's clipboard or `.fig` files, and that is not planned: only the public API.

## Other ways in

- **Paste** HTML with inline styles and style sheets, images, SVG or text onto the canvas.
- **Open** a `.bogen` file on the home screen.
- **Design folders:** `bogen import-folder <folder>` makes a file from a folder that
  `bogen export-folder` wrote; see [History](history.md#design-folders-and-git).
