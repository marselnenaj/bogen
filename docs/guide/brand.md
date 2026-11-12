# Brands

A brand says what a design may use: logos, a palette, fonts and a type scale, spacing and radius,
voice, and rules. Link a file to a brand, and your agent designs within it, Bogen checks the result,
and a change to the brand can be carried into every linked file.

A brand is a document of its own. It syncs to your devices, has undo and history, and can have
several people in it, like any file. You can have several brands, one per client.

## Create a brand

On the home screen, under **Brands**, choose **New brand**. It opens at `#/brand/<id>`, the brand
panel. In a design file, the Brand tab in the left panel shows its brand and the check.

A brand holds:

| Section | What goes in |
| --- | --- |
| Identity | Name, positioning, audience, tone. |
| Logos | Variants, each with the background it is for, a minimum width and clear space. |
| Palette | Colours with roles and tokens, and pairings of text and background, allowed or forbidden, with their contrast computed. |
| Type | Families with their roles (display, body, mono), weights, licence note and font files; a type scale with sizes, line heights, weights and tracking. |
| Layout | Spacing scale, radius, grid, container width, minimum contrast. |
| Imagery and iconography | Rules for each. |
| Languages | The language the brand speaks first, and the others it speaks. See [Languages](#languages). |
| Voice | Words to use and to avoid, with replacements, and good and bad examples, each in one of the brand's languages. |
| Rules | Do and don't rules, each hard (must) or soft (should). |
| Examples | Artboards on the brand's own canvas, marked good or bad. |

The panel edits all of this with undo, shows a brand sheet generated from the data, and downloads the
brand guide as Markdown or PDF. Colour values per theme mode are set by your agent with
`brand_update`; the panel has no field for them yet. An empty brand's sheet is bare. When an export, an
upload or an edit does not go through, the page says why in its header. The PDF and the sheet are
rendered by a Chromium-based browser on this machine, and need one.

## Build a usable brandbook

The **Brandbook** tab opens first. It keeps sixteen chapters in the brand itself: purpose and positioning, audience, architecture, principles, logo, colour, typography and languages, responsive layout, imagery, icons, voice, motion, data, applications, accessibility and governance. Each chapter has editable Markdown, its source, open questions and a review state. Save explicitly; undo and redo work like other brand edits. A synchronized change to the same chapter refuses a stale save and keeps your local draft.

Agents read `brand_book_get` for an outline or one complete chapter and write proposals with `brand_book_update`. Only you confirm a sourced chapter or mark it not applicable with a reason. Resolve open questions before confirming. Reopen a confirmed chapter before asking an agent to revise it. Draft chapters do not override confirmed tokens or rules. Documentation coverage is not a design score, accessibility test or licence clearance; leave unknown facts open.

Chapters are written in whatever language you write them in, and Bogen does not translate them. A chapter is taken to be in the brand's primary language; when you write one in another, choose it under **Language** while you edit it, and an agent passes `lang` to `brand_book_update`. The page marks each chapter's text with its language, so it is read, hyphenated and spell-checked as that language, whatever language Bogen's own interface is in. The chapter names and prompts are Bogen's and stay in English.

Markdown export contains the full editable book, sources and questions. PDF contains the visual foundation and chapter index. **Brand system file** opens the existing linked visual guideline, creating one only when no destination exists. Revisions belong in that file; the seven-board visual template alone is not a full brandbook. See [the model and review behavior](../design/brandbook.md) for technical details.

## Bring in what exists

Your agent fills a brand from what is already there, with `brand_extract`:

- a design file or a layer in Bogen;
- a live web page, copied in with [Capture](capture-and-import.md) and kept as an example;
- your repository's CSS, or a Tailwind config as text;
- pasted guide text, from which only literal colours are read. Your agent enters the rest by hand.

It goes by what is really used: colours by how often they appear, with a guess at their role, fonts
and the type scale, spacing, radius, and logo candidates. Nothing comes in that the source does not
have, and gaps stay empty.

From CSS, the names your stylesheet already uses are kept. A variable such as `--space-2: 8px` or
`--radius-s: 4px` becomes that step with that token, so a design written with `var(--space-2)` resolves
in a linked file. `--font-display` and `--font-body` say which family is which, and a Tailwind
`fontFamily` key does the same. A colour without a name gets its role from how it is used: as text,
background or border.

Your agent looks first and applies second. With a live page, the first call copies the page onto the
brand's Reference page, and the second uses that copy again rather than capturing the page twice.

Values given in `vw` come out as their size at the width of the capture, so spacing and sizes from a
live page need a look from you. A Tailwind config that computes its values cannot be read.

## Languages

A brand speaks one or more languages: a **primary** language and any number of others, each as a
language tag such as `en`, `de-AT` or `pt-BR`. Set them at the top of the Voice tab: choose the
primary, add others from the list or type a tag. Your agent sets `language` (the primary) and
`languages` (the others) with `brand_update`.

Words to use and to avoid, voice examples and rules that check text (**Text must say**, **Text must
not say**) each belong to one language. Without one they belong to the primary, so a brand that
speaks one language needs nothing more. Once a brand speaks more than one, each of these rows has a
language choice, with **All languages** for what holds everywhere, such as a product name.

Copy is judged in the language it is written in:

- Its language is the `lang` of its layer or its artboard, else the file's design language (or the
  language of the run), else what its words show, else the brand's primary. The guess from the words
  tells only German from English, and only overrides a declared language where the words clearly say
  the other of the two.
- It gets the words, examples and text rules of that language. A language of the brand without words
  or examples of its own uses those of the primary, and so does copy in a language the brand does not
  speak. Text a rule requires or forbids is required or forbidden only in that rule's language.
- du or Sie is checked in German copy only. Numbers are written the way the copy's language writes
  them where Bogen knows it (German and English); a number format set on the brand holds for its
  primary language and for languages it does not speak.

`brand_check`, `design_lint` and `voice_check` all judge copy this way, and each voice finding says
the language it was judged in. `voice_check` also says how many texts it checked in which language,
and which of them the brand does not speak.

An agent learns the languages without asking: `brand_get` and the brief a run gets say which
languages the brand speaks and which one to write in. That is the language of the request or the
file when the brand speaks it, and the primary otherwise. A request in a language the brand does not
speak is still written in it, with the primary's words as the guide. A brand's primary language is
also the soft default for the design language of a linked file that sets none.

When another language becomes the primary, words, examples and rules that belonged to the old
primary keep it, and the old primary stays among the brand's languages. Setting a primary for the
first time changes nothing about them: they are in it.

The brandbook is not translated: each chapter keeps the language it is written in (see above). The
panel's own labels follow Bogen's interface language as everywhere else.

Older Bogen versions on another device read a primary other than German or English as not set, and
ignore the other languages and an item's language. The values stay in the brand and come back on a
device with this version.

## Suggestions and confirmation

Everything extracted, and everything an agent adds on its own, is a **suggestion**. Suggestions are
allowed in designs but not enforced. In the panel they carry a mark: **Confirm** one, confirm them
all, or edit one, which confirms it. Your agent can confirm only when you tell it to.

That holds for settings as well as for items. If an agent proposes strict mode, no gradients or
another contrast minimum, the check, strict mode and the brief agents get keep going by the value of
the latest version, or the default where there is none, until you confirm. Publishing a version
records what binds and confirms nothing.

In the panel, a setting shows the value that binds, and a proposal sits beside it as **Proposed:**
with the proposed value, a confirm button and a dismiss button, as in **Review suggestions**. The
**Strict** box, for instance, stays clear while strict mode is only proposed. Dismissing puts back the
value of the latest version. Changing the setting yourself replaces the proposal.

What an agent sends is checked before any of it is written. A value that is not one of a setting's
choices, such as a rule of kind "don't" where the choices are `do` and `dont`, or a pairing of colours
the brand does not have, is refused with the reason, and the brand stays as it was.

**Review suggestions** on the brand's page shows each suggestion beside the confirmed value, field by
field, with its source. New values, edits to a published value and second takes on a confirmed value
are marked separately. Confirming a second take updates the confirmed item without keeping a duplicate;
dismissing an edit restores the last published value. Confirm or dismiss one, a section, or all as
one undo step. With the list focused, j/k or the arrows move, c confirms, d dismisses, e opens its
section, and Shift+C or Shift+D act on all. Ctrl+Z undoes.

## Link a file

A file links to one brand. Linking brings the brand's tokens and fonts into the file, its type scale
as text styles, and its colour values per theme mode. A brand can be the default for new files.

A file whose brand was deleted, or has not arrived from your other device yet, keeps its layers and the
brand's tokens. Its Brand tab and every brand tool say that the brand is not on this device, and the
check waits until you link another brand or choose **No brand**. Deleting a brand lists the files that
still point at it.

Once a file is linked, your agent learns about the brand without asking: opening the file gives it a
short summary, and runs started from Bogen (Ctrl+K, comments) carry the whole brand in their prompt.
Hard rules, the palette and the fonts are requirements to it. What a brand says is treated as data
about a design: it cannot give an agent other orders. Rules that try to are flagged, shown to you and
left out of what binds.

## Memory from decisions

Bogen keeps what you decide about proposals in files linked to a brand: each copy you accept or
discard, with the request it was made for, its note, the runner and model, and what it looks like
measured from its styles: gradients, shadows, all-caps text, corner radius, spacing (lower is denser),
the lowest text contrast, and how many fonts and colours it uses. Nothing else: no layer text, no
pictures, no names of people. It lives in `memory/` in the data folder, on this device only, and does
not sync. A file with no brand keeps its own.

From patterns that repeat, Bogen suggests rules. For example: "You discarded 4 of 4 proposals with
gradients", rule **No gradients**. Others come from radius, spacing, contrast and fonts, where the
accepted and the discarded ones clearly differ. A pattern needs at least three decisions.

- The suggestions show in the Brand panel, under the brand in a linked file and on the brand's
  Rules tab. **Add rule** adds it as a soft rule (a contrast suggestion sets the minimum contrast),
  marked as coming from your decisions. **Dismiss** keeps it from coming back.
- Nothing is applied by itself, and agents cannot add these rules.
- Agents get a short summary through `brand_get`: how many proposals were decided and the patterns
  seen, marked as a preference rather than a rule.

Tested with real proposals through the server and the MCP tools, and the panel in a real browser.
Measuring is from stored styles, so a look that only a browser computes is not seen.

## Check a design

`brand_check`, or the Brand tab of a file, checks a layer, a page or the whole file. It renders the
design, so inherited fonts and colours count. Each violation names the layer, the rule, how severe it
is and a concrete fix. Safe fixes, such as a near colour snapped to its token, a font swapped for the
brand's or a shadow removed, apply as one undo step.

What it checks:

- colours off the palette, forbidden pairs and contrast;
- fonts, weights, sizes, spacing, radius, shadows and gradients;
- logos on the wrong background, too small, stretched, crowded, or not one of the brand's (a logo
  captured from a page is recognised by its shapes);
- words to avoid (`design_lint` flags them too, next to generic filler; see
  [Copy that does not sound generated](agents.md#copy-that-does-not-sound-generated));
- rules that have a machine check, such as no gradients, no uppercase or at most two families;
- drift from the brand's tokens.

Rules no machine can check come back as a checklist, to judge by eye. Text over an image or drawing is
not measured for contrast, and the result says so.

Contrast counts inside pseudo-elements and conditions too: the words a `::before` shows, and text under
a dark mode block, a container query or a hover state, each against the brand's minimum. A colour a
hair off the palette inside such a block is snapped in that block as a safe fix. See
[Pseudo-elements and conditions](pseudo-and-conditions.md#for-agents).

### Voice

Beyond words to avoid, the check measures what a brand says about its voice where it can be measured:

| Measure | What is checked |
| --- | --- |
| Address | In German copy, du or Sie as the brand says, and the two never side by side. Sie counts in the middle of a sentence, where its capital shows it is formal; a text about the forms, such as "Du und Sie nie mischen", is left alone. |
| Sentence length | Sentences longer than the brand allows. "Short sentences" with no number counts as at most 20 words. |
| Text length | Texts with more sentences than the brand allows in a paragraph. |
| Heading length | h1 and h2 headings with fewer or more words than the brand says. |
| Number format | 10,000 or 4.5 % in German copy, 4,5 % or €9,99 in English copy. Code values such as 10.5px are left alone. |
| Terms | The brand's words to use in the copy's language, spelled another way: IT und Recht for IT & Recht, Followup for Follow-up. |
| Required text | A rule checked as **Text must say** names words that must appear in the copy in its language. |

Each measure comes from the brand's **Measured in text** settings in the Voice tab. When one is empty,
Bogen reads it from the brand's own words where they state it plainly: a voice rule "Website und
eigene Kanäle sprechen Du.", "Absätze höchstens zwei Sätze", "Überschriften mit 3 bis 7 Wörtern", and
the language the brand is written in for the number format. The tab shows what it read and from
where, and a setting overrides it.

A finding quotes the words, says what to do, and carries the brand's own good and bad example that
fits it best, such as its good sentence in du for a text that says Sie. `brand_check` counts the
findings under voice, `design_lint` lists them as copy, and `voice_check` checks a draft before an
agent writes it. Tone itself is not judged.

### The score

The score runs from 0 to 100 and explains itself:

- **60% conformance:** per category, the share of checks that passed, a near miss counting half.
  Categories and their weights: colour 25, type 20, contrast 10, spacing 10, shape 10, voice 10,
  rules 10, logo 5, tokens 5.
- **40% quality:** type hierarchy, spacing rhythm, the palette's roles with the accent showing, and
  brand tokens, logo and components in use.
- **Less a penalty:** 2 per distinct hard problem, and up to 30 for the share of layers with one, at
  most 25 in all.

Fluid values count at the width of their artboard: `clamp(16px, 3vw, 48px)` on a 390 artboard is
16px. Checklist items are never counted. A page with nothing drawn has no score.

Quality is a heuristic; it does not judge taste. Work that keeps every value but is flat, with one
size, one gap and no accent, scores in the sixties.

The Brand tab of a file shows how the score is made, under the number:

- **What would raise it most**, largest gain first: each kind of violation, such as colours off the
  palette or spacing off the scale, and each part of quality that is short of full, with the points it
  is worth, how many of its fixes are safe, and what to do. A kind of violation is worth the score
  worked out again without it, the penalty for its hard problems included; a part of quality is worth
  the score with that part at full marks.
- **Parts of the score**: conformance per category, with its weight and how many checks failed, and
  each part of quality with what it measured.

Click a row to select the layers it is about. `brand_check` returns the same in `why`: `categories`
and `quality_parts` with their `node_ids`, and `raise`.

### Waivers

Only a person can waive a rule, per layer and with a reason: in the Brand tab of the file, choose
**Waive for this layer** on a violation. Waived layers are listed and can be taken back. No tool can
waive.

### Strict mode

An agent's writes in a linked file come back with brand warnings from quick static checks, at most
eight at a time. Turn on **Strict** in the brand panel, and a write that adds a hard violation is
refused instead, with the fix, and nothing of it stays.

At the end of a run, its output and the Agents tab show the score and the open violations. Quiet
markers on the canvas show where problems are; they come from the last check, and a toggle hides
them.

## Drift across linked files

On a brand's **Across files** tab, **Check all linked files** renders and checks every linked
file. Files are listed worst first, with their score, hard and soft findings and links to their worst
layers. A link opens the file with that layer selected. Agents can use `brand_drift` for the same check.
The summary is the mean of files with something drawn; empty files do not count.

Whole-file checks from the editor, agents, completed runs and drift checks keep a score history on this
device, in `brand-scores/`. The brand page and each file's Brand tab show the trend. Unchanged file
checks within a minute share one point; each full drift check adds a summary point. The history keeps
at most 200 points per series and does not sync between devices.

## Change a brand

- **Publish version** records the brand as it is. In the panel a version is compared with now; your
  agent compares any two with `brand_diff`. Publishing with nothing changed still makes a version, and
  `brand_publish` says so.
- Before you apply a change, the panel shows its impact: which linked files and layers it touches,
  published or not.
- **Apply to linked files** carries tokens, fonts and old values into each file as one undo step per
  file, made by `brand`. With no linked file to carry it into, nothing is applied or published, and
  files named that are not linked to the brand are listed as skipped.
- Linked files offer a newer version, and agents working in them hear `brand_changed`.

**Duplicate** on the home screen, or `brand_duplicate`, makes a new brand from an existing one, as a
start for a sub-brand or another client. The copy has everything the original has, and none of its
versions: it starts at version 0, not published yet. Its page and `brand_get` say which brand and
version it was duplicated from. It is not the default, and files linked to the original stay linked to
the original. A setting that is still a suggestion in the original comes over as the value that binds
there, since that came from the original's versions; suggested items stay suggestions.

## Logos and assets

Logos, fonts and images are stored by content and sync with the brand, in a library with tags. Your
agent places a logo with `brand_asset_use`, which picks the variant for the background, keeps the
minimum size and adds the clear space.

`brand_template_use` copies an example artboard or component of the brand into a file. The copy does
not follow the brand later. For components that stay live, publish them from the brand as a
[shared library](components.md#shared-libraries).

## Templates

A template lays out a whole file from a brand's data in one step, as ordinary editable layers with the
brand's tokens, fonts, logos and type scale, and components where something repeats:

| Template | What it makes |
| --- | --- |
| `brand-system` | A brand guideline on seven boards: cover, logo, colour, type, layout and spacing, components, voice. |
| `landing-page` | A page skeleton at 1440 and 390. |
| `social-images` | Open Graph (1200 x 630) and square (1080 x 1080). |
| `pitch-deck` | Ten slides at 1920 x 1080: title, problem, solution, how it works, product, traction, market, business model, team, the ask. |
| `app-store-screenshots` | Three screenshots for iPhone 6.9 inch (1320 x 2868) and three for Android (1080 x 1920): a caption over a phone drawn in CSS, with the screen as an image to fill. No maker's artwork. |
| `email` | A 600 wide email in table-safe HTML: preheader, logo, headline, text, a button made as a coloured cell around a link, footer with address and unsubscribe. Brand values are written out, since mail clients do not read CSS variables. |
| `docs-page` | A docs page at 1440 and 390: header, a sidebar of the section's pages, an article with h1 to h3, a code block, a note, a table and links to the previous and next page. |
| `pricing-page` | A pricing page at 1440 and 390: three plans as a Plan component set with a featured variant, a comparison table, questions as disclosures, footer. |

On the home screen, a brand's menu has **New brand system file**, **New landing page file** and
**New social images file**; the brand panel has **Brand system file**. Your agent uses `template_list`
and `template_use` for all of them, and can make only some parts.

A template never invents brand values. Where the brand has a gap, the board says how to fill it, and
the result lists the gaps. It is a start: look at it and refine it.

The texts of the newer templates are the brand's own lines where they fit, such as its shortest good
example as a headline, and otherwise short slots that say what goes there, such as "Who this plan is
for." No lorem ipsum, and no invented names, numbers or prices. Each candidate line is run through the
copy check and the brand's voice check before it is used, so a German brand that asks for headings of
three to seven words gets them. `template_use` returns the slots with their layer ids and a hint each,
so an agent can find and fill them. The boards pass the accessibility audit as made: one h1, headings
in order, header, nav, main and footer on the docs and pricing pages, names on every link and button,
targets of at least 24 pixels.

## Like this site, but in your brand

**Like this site, in a brand** in the command palette captures a page and redraws its layout in a
brand, as a new artboard. Choose the brand, the width and the colour scheme the page sees.

- Colours go onto the brand's palette by lightness and by what they do: the page's darkest text
  becomes the brand's darkest text colour, its page background the brand's background, its borders
  the brand's border colour, its most used accent the brand's main accent.
- Fonts go onto the brand's families: headings to the display family, code to the mono family, the
  rest to the body family.
- Font sizes, weights, spacing and radii snap to the brand's scales, as the brand's tokens. Shadows
  and gradients go when the brand has none.
- This uses the same replacement as **Apply to linked files**, and the file is linked to the brand.
  A file that already follows another brand is left alone, and the artboard goes into a new file.
- Where two colours of the page land on one brand colour, or text ends up on a background it no
  longer stands out from, the text takes the palette colour that reads best there.
- Then it runs the brand check and shows the score.

The site's text and images become placeholders, so that only the structure comes over. **Keep the
site's text** and **Keep the site's images** keep the originals. This is for structure and
inspiration: the layout comes from someone else's site, and you need the right to use any of its
content you keep, such as text, images or logos.

Your agent uses `site_restyle`, for public pages. A page on this computer can be restyled from the
editor on this computer. The whole restyle is one undo step, made by `restyle` in the editor or by
the agent that ran it.

## Tools for agents

Every brand tool, by what it is for. The [MCP tool reference](reference/mcp-tools.md) has the arguments.

| Step | Tools |
| --- | --- |
| Find and manage brands | `brand_list`, `brand_create`, `brand_rename`, `brand_duplicate`, `brand_delete`, `brand_default` |
| Fill a brand | `brand_extract`, `brand_update`, `brand_asset_add`, `brand_book_get`, `brand_book_update` |
| Confirm | `brand_confirm`, only when you say so |
| Read a brand | `brand_get`, `brand_asset_list`, `brand_example_get`, `brand_sheet`, and the resource `bogen://brand/<id>` |
| Use it in a file | `brand_link`, `brand_asset_use`, `brand_template_use`, `template_list`, `template_use` |
| Check | `brand_check`, `voice_check`, `brand_drift` |
| Change it | `brand_publish`, `brand_versions`, `brand_diff`, `brand_impact`, `brand_apply` |

No tool can waive a rule, confirm a brandbook chapter or mark one not applicable: those are yours.

## Safety

What a brand says reaches agents, so Bogen treats it as untrusted data: rules that talk to agents are
flagged and left out, a brief sits in a block its content cannot close, SVG is sanitised on every
read, and colours and font names are checked before they reach CSS. A brand that arrives from another
device starts nothing, and the brand routes are closed on the tailnet listener.
