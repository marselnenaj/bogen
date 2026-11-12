# Pseudo-elements and conditions

A layer's own style is its inline style. Some CSS cannot be said inline: a `::before` that draws an
arrow head, a `+` after a menu title that turns into `−` when the menu opens, a grid that stacks
when its container gets narrow, a colour under the pointer. A layer can hold these too, and they
render the same on the canvas, in your agent's screenshots, in exports and in code.

## What a layer can hold

Each layer has a list of blocks. A block is a pseudo-element, a condition, or both, with its own
properties:

| Block | Means |
| --- | --- |
| `::before`, `::after` | A box before or after the layer's content. It shows only with a `content` property; `content: ""` draws an empty box you style. |
| `::marker`, `::placeholder`, `::selection`, `::first-letter`, `::first-line` | The parts of a layer CSS gives these names. |
| `@container (max-width: 560px)` | Applies while the nearest container around the layer is at most 560px wide. `@container card (…)` asks the container named `card`. |
| `@media (max-width: 760px)` | Applies while the artboard is at most 760px wide. See below. |
| `:hover`, `:focus`, `:focus-visible`, `:focus-within`, `:active` | Applies in that state. |
| `[open]` | Applies while a `details` layer is open. |
| `parent:hover`, `parent[open]` | Applies while the parent is in that state. |

Parts combine: `@container (max-width: 560px) ::after`, `@media (max-width: 760px) :hover`,
`parent[open]::after`. A query can use a breakpoint token, as in `@media (max-width: var(--bp-md))`.

## In the inspector

The **Pseudo-elements and conditions** section lists a layer's blocks. The plus adds one: pick a
pseudo-element, type a condition, and write the first property, such as `content: "+"`. Each block
has its properties as text, edited like **Other styles**, and a bin to remove it. In the layers
panel, `::before` and `::after` show as rows under their layer, with their content. A click on one
selects the layer.

## Containers

A container query needs a container: a layer around it with `container-type: inline-size` (or
`size`) in its style, and `container-name` if you want to ask for it by name. On the canvas the
query answers to that layer's real width, so resizing the container, or the artboard it sits in,
shows the change at once.

## Media queries read the artboard

A web page's media queries ask about the browser window. On the canvas there is no window per
artboard, so Bogen reads a media width query against the artboard the layer is in: an artboard of
390 is a phone, whatever the size of your screen. The same goes for screenshots, video, PDF,
`responsive_check` and `layer_styles_computed` with a `width`, so your agent sees what you see.
Under the hood the artboard becomes a container named `bogen-artboard`, and the query a container
query on it.

- Only queries about the width are read this way. Height, orientation and aspect ratio queries,
  and others such as `prefers-reduced-motion`, ask the window you see the canvas in.
- `prefers-color-scheme: dark` applies inside a layer, artboard or page in the theme mode named
  `dark`, and `light` everywhere else.
- An artboard that hugs its content has no width of its own, so its media queries do not apply.
  Give it a fixed width.
- The artboard's own media blocks are read against its stored width, as a container query cannot
  ask about the element it is on. Preview mode at another width does not change those.
- In preview mode, the device widths and the W field change the artboard's width, which is the way
  to watch media and container conditions take effect.
- An exported HTML page writes the media queries as they are, so there they ask about the window
  again, which is what they mean on a real website.
- [Responsive variants](canvas.md#responsive-variants) write their narrower versions as these
  blocks, one per width. Running them again replaces the blocks with those same queries. They
  write nothing on the artboard itself, for the reason above: padding on an artboard stays.

## States

Hover, focus and active blocks apply in preview mode and in exported pages. While you edit, the
canvas leaves them out, so that pointing at layers does not change them. `[open]` blocks follow the
`open` attribute of a `details` layer, in editing too.

## From HTML

When your agent writes HTML with a `<style>` block, the rules land on the layers their selectors
match, as plain rules do:

```html
<style>
  pre[data-lang]::before { content: attr(data-lang); display: block }
  .menu > summary::after { content: "+" }
  .menu[open] > summary::after { content: "−" }
  .row { display: grid; grid-template-columns: repeat(3, 1fr) }
  .diagram { container-type: inline-size }
  @container (max-width: 560px) { .row { grid-template-columns: 1fr } }
</style>
```

- `attr()` of an attribute Bogen does not keep on a layer, such as `data-lang`, becomes its text.
  `attr()` of a kept one, such as `title`, stays live. `counter()` works with `counter-reset` and
  `counter-increment` in the layers' styles.
- `@supports` and `@layer` are read through.
- Not kept, and listed in a warning: a condition inside another condition, a state further up than
  the parent, a state inside `:not()` or `:has()`, `:visited`, and pseudo-elements outside the list
  above. Resets that apply to every element, such as `*::before { box-sizing: border-box }` or a
  focus ring on everything, stay with the page.

## Capture

A captured page keeps working as before: its `::before` and `::after` become child layers named
Before and After, or after their text, at the size the page had. Conditions are not captured, as a
capture is the page at one width. If you or your agent add a `::before` to a captured layer that
already has such a child, it shows twice, and `layer_style` says so. The page's hover and focus
rules stay a record your agent reads with `interaction_rules`; it can turn one into a `:hover` block
with `layer_style`.

## In exports and code

- **HTML** export and Copy as HTML put the rules in a `<style>` element, written for a class per
  layer such as `bgn-k3j4h5l6m7`. Importing that HTML again gives the same blocks.
- **React** with inline styles carries a `<style>` element in the component. **React with
  Tailwind** uses variants where one says the same: `before:content-['+']`, `hover:`,
  `max-[760px]:`, `@max-[560px]:`, `dark:`. A block with no variant, such as a parent's state, stays
  in the `<style>` element.
- **SVG** export keeps a layer with a pseudo-element as HTML inside the SVG, and the native vector
  export lists it as such.

## For agents

`layer_style` takes `pseudo` and `when`, and `clear_block` removes a block. `layer_tree` shows which
blocks a layer has, `layer_get` their properties, and `layer_styles_computed` reads a pseudo-element
or lays the artboard out at a width first. `design_lint` and `brand_check` look at colours, sizes and
fonts inside blocks too. See the [MCP tools](reference/mcp-tools.md).

Both measure contrast inside blocks as well:

- The words a `::before` or `::after` shows (a `content` with letters or digits in it) are measured
  as they render, in their own colour and on their own background or the layer's.
- A condition that changes a text's colour or what is behind it, on the layer or on a layer it sits
  in, is worked out from the styles: a dark mode block on the artboard that forgets the text, a
  container query, a `:hover`. A render at one width, in one scheme and with nothing hovered would not
  show these.

A finding says which block it is in, and its fix names that block, so that it goes in with
`layer_style` and that `when` or `pseudo`. Safe fixes go into the block by themselves: a colour a hair
off the palette snapped to it (`brand_check`), and a value written as the token it equals
(`design_lint`). A better contrast is never safe, as it changes how the design looks.

## Mobile viewport height checks

A mobile in-app browser can resize its viewport as its toolbars open and close,
including the sizes behind `svh`. Test the same width at different browser heights:

```json
{"node_id":"your-artboard","widths":[390],"viewport_heights":[664,760,600]}
```

`responsive_check` adds `viewport_stability`: the measured content height and changes
to layer positions, heights, visibility and positioning. A change is evidence to inspect,
not a reason to remove an intended sticky effect. The usual `ok` still reports horizontal
overflow and clipped text; the height comparison has its own `stable` result. It does not
simulate native Safari toolbars, touch momentum or scroll anchoring.

## Reusable checks

Open **Design checks** in the toolbar or command palette. Choose a built-in and
**Extend this check**, or start a new definition. Save widths, browser heights,
pixel tolerance and your own assertions for element sizes, computed CSS, attributes
or element counts. Run on an artboard and select a finding to locate its layer.
Built-ins remain available as starting points. Every custom definition has a stable id.

An agent uses `check_list`, `check_set`, `check_delete` and `check_run` on the same
file. Set `extends` to a built-in id (`builtin:responsive`, `builtin:mobile`,
`builtin:lint`, `builtin:a11y`) or another custom id. A definition with `a11y: true` runs the
[accessibility audit](agents.md#accessibility-audit). Rules with matching ids override inherited
rules; `enabled: false` disables a rule or check. Inheritance cycles and deletion
of a base still used by another check are refused. Saves and deletes are undoable.

Example `check_set` definition:

```json
{"id":"touch","name":"Touch targets","extends":"builtin:responsive","widths":[390],"rules":[{"id":"button-height","kind":"geometry","selector":"button","property":"height","operator":"min","value":44,"message":"Buttons need a 44px hit area.","severity":"warning"}]}
```

Rules support `geometry` (pixel sizes and coordinates relative to the artboard),
`style` (computed CSS), `attribute` and `count`. Numeric comparisons use `min`,
`max` or `equals`; CSS equality uses the computed browser syntax. Attribute rules
also support `present`, `absent` and `not-equals`. Selectors are scoped to the
artboard, including the artboard itself. Missing matches are findings; use a count
rule with a zero minimum when no matches are acceptable. Checks never fix designs.

Definitions are stored with the file, synchronize between people and devices,
and survive versions and design-folder export. **Import / export JSON** lets you
copy a definition to another file; import custom bases before their children.
Each check holds at most 32 own rules, 64 including inherited rules. A file holds
at most 50 custom checks. A run accepts up to eight checks and four widths; each
selector measures up to 2,000 matches and reports when that limit prevents a full
check. Disabled or empty checks are shown as skipped. Truncated results retain a
full finding count and at most 100 findings per check.

## Sync and older versions

Blocks are stored per property, so two people or devices changing different blocks, or different
properties of one block, both keep their change. The first block on a layer made before this
existed is the exception: if two devices each give that layer its first block while apart, one
side's first blocks are kept. A device running an older Bogen ignores blocks: it shows the layer
without them and leaves them in place.
