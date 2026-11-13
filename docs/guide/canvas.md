# Canvas

Everything on the canvas is an HTML element with CSS. A frame is a `<div>` (or a `section`, `nav`,
`button` and so on), text is a text element, and layout is real flexbox and grid. What you draw is
what your agent reads, what the code panel shows and what you export.

Press Ctrl+/ for every shortcut. Many Figma shortcuts work as aliases.

## Moving around

- **Pan:** hold Space and drag, drag with the middle mouse button, or use the hand tool (H).
- **Zoom:** Ctrl and the mouse wheel, pinch, the zoom tool (Z), or + and -. Shift+0 is 100%,
  Shift+1 shows all screens of the page, Shift+2 fits the selection. From 600% a pixel grid shows.
- **Fit the screen you work on**, from the zoom percentage in the toolbar (or More in a small window):
  - **Fit screen** (Shift+3) shows one artboard whole: the selected one, the one around the selected layer,
    or the one most in view when nothing is selected. Never every artboard of a large file; Fit selection
    with nothing selected does the same.
  - **Fit width** (Shift+4) fills the canvas with the artboard's width and starts at its top, for a tall web
    page that would be unreadable whole.
  - Both keep holding while the window, the panels, a drawer or the prompt change size, and the zoom
    percentage is underlined meanwhile. Panning or zooming yourself lets go; an agent writing elsewhere does
    not move the view. In a text field these keys type as usual.
- A file opens with its page fitted. Each page remembers its view on this device.
- New artboards that land off screen are brought into view.

## Tools

| Key | Tool |
| --- | --- |
| V | Move |
| H | Hand |
| F | Frame |
| R | Rectangle |
| O | Ellipse |
| L | Line |
| Shift+L | Arrow |
| T | Text |
| P | Pen |
| Shift+P | Pencil |
| I | Place image |
| C | Comment |
| S | Shader |
| Z | Zoom |

The selected tool is remembered on this device when you switch files or reopen Bogen. Holding Space temporarily to pan does not change that preference.

The toolbar also has an icon picker with the Lucide set, 2015 icons placed as editable vectors in
the text colour. Search goes by name and a short list of synonyms.

Agents reach more sets with `icon_search` and its `set`: Phosphor (regular), Tabler Icons (outline),
Heroicons (outline and solid) and Material Symbols (outlined), or `all` to search them together. Their
names carry the set, such as `tabler:home`, and `icon_insert` places them like Lucide's: stroked sets
take a stroke width, filled ones fill with the colour. None of the sets has the logos of other
companies. The picker in the toolbar shows Lucide only. See [Licences](licences.md) for why Remix Icon
is not among them.

## Selecting

- Click to select, Shift+click to add, drag a marquee. Ctrl+A selects all.
- Double-click drills into a group. Enter selects a child, or starts editing text. Shift+Enter or
  `\` selects the parent. Tab and Shift+Tab move between siblings, N and Shift+N between frames.
- Esc steps out to the parent, then clears the selection.
- **Select matching layers** (Ctrl+Alt+A, or the context menu) selects every layer on the page that looks
  like the selection: the same kind of layer, element, component, text style, the rest of its style and
  the same shape inside, whatever its position, size or words. Use it to change all the cards at once.
- Ctrl+F finds on the canvas. The layers panel (Alt+1) has search and filters.

## Moving, resizing, arranging

- Drag to move. Eight handles resize; Shift keeps the ratio, Alt resizes from the centre. Rotate
  from outside a corner. Shift+H and Shift+V flip. Alt-drag duplicates.
- Smart guides snap to pixels, siblings and rotated layers, also while you resize a rotated layer, and
  to the columns and rows of a [layout grid](#layout-grids). Hold Alt to measure distances.
- **Spacing:** select two or more layers side by side, such as a row of cards placed freely. When the gaps
  between them are even, a handle sits in each gap: drag one and every gap changes, the first layer
  staying put, as one undo step. The inspector shows the spacing under the align buttons, for each
  direction, and sets it from the keyboard; uneven gaps show as mixed there. Set horizontal spacing and Set
  vertical spacing in the palette put the cursor in that field. Layers in a flex or grid layout use the
  layout's gap instead.
- Arrow keys nudge by 1, with Shift by 10.
- Group (Ctrl+G), ungroup (Ctrl+Shift+G), wrap in a frame (Ctrl+Alt+G). Align with Alt+A, Alt+H,
  Alt+D, Alt+W, Alt+V, Alt+S; distribute with Alt+Shift+H and Alt+Shift+V; tidy with Ctrl+Alt+T.
- Ctrl+] and Ctrl+[ bring forward and send back. Lock with Ctrl+Shift+L, hide with Ctrl+Shift+H.
- Cut, copy and paste, paste on top (Ctrl+Shift+V), paste to replace (Ctrl+Shift+R), copy and paste
  styles (Ctrl+Alt+C, Ctrl+Alt+V). Pasted layers land clear of what is already there.
- Layers get names from their role, element, class and text. Ctrl+R renames.
- **Rename in bulk:** Ctrl+R with several layers selected, or Rename layers in bulk in the palette and the
  context menu, renames them all as one undo step. In the name, `$&` is the current name, `$n` counts
  up from the start number, `$N` counts down, and `$nn` or `$NN` pad with zeros, so `Card $n` gives Card 1,
  Card 2, Card 3. Find and With replace text inside the names first. Numbers follow reading order on the
  canvas: rows from the top, then left to right. A preview lists the new names before you press Enter.

## Artboards, frames and pages

An artboard is a top-level frame on a page: the screen you design in. Common widths are 1440, 768 and
390. Leave its height to the content, as a web page does, or fix it for slides and posters. Pages
separate flows or explorations; several sizes of one flow belong side by side on one page.

**Sizes:** with the frame tool (F) the inspector lists sizes by kind: desktop, tablet, phone, watch,
social, slides and print, such as MacBook Air, iPad mini, iPhone 16 Pro Max, Pixel 9 or A4. Click one to
place an artboard of that size. Phone and tablet sizes are the CSS viewport of the device, which is what a
page is laid out at. **New artboard:** with the name of a size in the palette does the same from the
keyboard. With an artboard selected, the field under W and H names its size, or says Custom size; pick
another to resize it, and the button next to it swaps width and height, from portrait to landscape and
back (Swap width and height in the palette). There are no device frames around artboards yet.

## Layout grids

A frame can carry layout grids: columns, rows or a square grid drawn over it on the canvas, to place
things on and to snap to. They are a guide for the design only and no export writes them.

- Select a frame and press **+** in the Layout grid section of the inspector, or run **Add layout grid:
  columns** (or rows, or square grid) in the palette. Columns start at what suits the frame's width: 12
  with a 24 gutter and an 80 margin on a desktop, 8 on a tablet, 4 on a phone.
- Open a grid's row to set the count, the gutter, and whether the tracks stretch between the margins or
  keep a width at the start, the centre or the end. A square grid has a cell size. Each grid can have its
  own colour and be hidden on its own; a frame holds up to eight.
- Moving and resizing a layer inside the frame snaps to the edges of its columns and rows.
- **Ctrl+Shift+4** shows or hides every layout grid on this device. Grids sync with the file like
  everything else, and each change is one undo step.
- Agents set them with `layout_grid_set`, and see them in `layer_tree` and `layer_get`.

Limits: a grid is drawn over the frame's box on the page, so in a rotated frame it does not turn with it.

## Layout

Select a frame and press Shift+A to add flex layout. The inspector then sets:

- **Flex:** direction, wrap, gap (negative too), padding and alignment. Gap and padding have handles
  on the canvas, and you reorder flex children by dragging them.
- **Grid:** CSS Grid on any frame.
- **Absolute position** inside a frame, with constraints for children of a frame without layout:
  left, right, both, centre or scale. They are written as plain CSS and kept through moves and
  resizes.
- **Size:** fixed, hug or fill, with min and max, and an aspect ratio lock held by CSS
  `aspect-ratio`.
- **Overflow** and scrolling.

## Responsive variants

Select an artboard with a fixed width, such as 1440, and open **Responsive** in the inspector, or run
**Make responsive variants, 768 and 390** from the command palette. It makes the narrower versions in
one undo step, in one of two ways:

- **Media rules** (the default): `@media (max-width: …)` blocks on the same layers, one per width,
  halfway to the next wider one or on a breakpoint token there. The page adapts in the browser and
  in code, and the canvas reads the blocks against the artboard's width.
- **Linked artboards:** one artboard per width next to the source, with the changes in their own
  style. Run it again after you change the source and they are rebuilt in place, keeping where you
  moved them.

What changes, as the section lists it before you run it:

| Layers | At 768 and 390 |
| --- | --- |
| Flex rows | Rows of short items wrap; rows of columns wrap in pairs, or stack on a phone and where two columns do not fit. A header bar stays a row and wraps. |
| Grids | Fewer columns: 3 become 2 and then 1; spans shrink with them. |
| Type | Large type steps down the type scale: the brand's, the file's font-size tokens and text styles, or a default scale. Body text stays at 16. |
| Padding and gap | Step down the spacing tokens, or a default scale, and are written as the token when there is one. |
| Images | Keep their aspect ratio and fit the width. |
| Navigation | A row of three or more links collapses into a menu button on a phone, and a row of six or more on a tablet too. |
| Fixed widths | Wider than the screen, they become 100% with the old width as a maximum. |

Afterwards Bogen lays each width out and lists what still sticks out or is cut off, by how much.
Click a row to select that layer and fix it, by hand or with your agent's `responsive_check`. Grid
areas and absolutely placed layers are left alone, with a note. Your agent makes the same variants
with `responsive_variant`.

### Editing at a breakpoint

Under the layer's name the inspector shows **Base** and the file's breakpoints (its breakpoint
tokens, or 1024, 768 and 390), plus a field for any other width. With **Base** chosen a change applies
at every width. With a breakpoint chosen, every change in the inspector goes into that width's
`@media (max-width: …)` block on the layer, and the fields show the layer as it is at that width. The
bar lists what that width overrides, each with what it replaces and where that comes from (the base
style or a wider breakpoint), and a cross that brings the inherited value back. The canvas keeps
showing the base design; **Sizes** shows the others.

### Sizes

**Sizes** in the breakpoint bar, **See it at several widths** in Responsive, or the command palette
show the artboard at its width and its breakpoints side by side, from the same file: no copies and
no extra page. Each frame is the page as it is exported, laid out by the browser at that width, so
media and container queries, grids and native popovers behave as they will on the web; frames follow
your edits a moment later. **Longer text**, **Missing images** and the list switch (one item, twice as
many) show the page with harder content on a throwaway copy, without touching the file. Each width
says whether it fits or what sticks out; click a layer there to close Sizes and select it.

### Fluid sizes, grids and containers

- **Fluid sizes.** Under a font size and under a gap, **Make it fluid** turns the value into one that
  grows with the screen: the px on a 360 px phone and on a 1280 px screen, written as `clamp()` in
  rem. Type keeps at least 10 px; space shrinks in proportion. A size from a token says so and is
  changed in the token.
- **Grids.** A grid's columns are a **Count**, or **Auto-fit** or **Auto-fill** at a minimum column
  width, written as `repeat(auto-fit, minmax(min(16rem, 100%), 1fr))` so a phone gets one column
  instead of overflowing.
- **Containers.** A container query reaches only the layers inside a container, never the container
  itself. **Content follows this frame's width** makes a frame a container, so the layers inside it
  read its width, not the page's, and the same card works in a sidebar and in a full row. **Stack at**
  makes the rows inside stack and the grids inside drop to one column when the frame is at most that
  wide. **Make its media rules follow …** turns the frame's media rules, and those of the layers in
  it, into container rules of the frame it sits in, scaled to that frame's width.
- **Web page.** In Responsive, **Web page** marks an artboard that is a website: its export grows with
  the window up to the artboard's width and gets a viewport, its language, its name as the title and
  its description. App screens, posters and slides stay off and keep their size.
- The image section says whether a picture is sharp on 2× screens, blurry, or far heavier than it
  needs to be (an SVG is a vector and sharp at any size), and running text shows its characters per line, with **Limit to 65ch** when the lines
  are too long to read well.

## Style

- **Fills:** solid colours, linear, radial and conic gradients, and images, several layered and
  reordered by dragging. Linear and radial gradients have handles on the canvas; drag, add and
  delete stops there. Colours in hex, named, OKLCH, P3, LCH and LAB, and an eyedropper. Conic
  gradients have no canvas handles. CSS keeps a linear gradient's line through the centre, so its
  far handle slides along the colour band.
- **Borders**, outline, radius per corner, shadows (several, inset, reordered by dragging), opacity,
  blend modes, filters, backdrop filters and clipping.
- **Other styles:** any CSS property, grouped and filterable. **Simplify styles** removes what does
  not change the rendering, by trying it on the real element and comparing before and after.
- **Pseudo-elements and conditions:** `::before` and `::after`, and style that applies under
  `@container`, `@media` or a state such as `:hover`. See
  [Pseudo-elements and conditions](pseudo-and-conditions.md).

## Text

- Every Google Fonts family works by name, and so do fonts installed on your machine.
- Line height, tracking, case, decoration, truncation, OpenType features, text gradients and text
  strokes. Variable font axes work for local variable fonts.
- **Rich text:** select part of a text and change its weight, style, colour, size or link. Bold,
  italic, underline, strike, code and links in pasted HTML become ranges too; other inline elements
  stay layers of their own.
- Two people or an agent can type in the same text layer at once; the edits merge per character.
- **Text styles** are named bundles of family, size, weight, line height and tracking. Apply one from
  the inspector; changing it changes every layer that uses it. They export as CSS classes.
- **Find and replace:** Ctrl+H (or Ctrl+Alt+F, or Find and replace
  text in the palette) opens the find bar
  with a second field. It finds the words of text layers, on this page or, with **All pages**, in the whole
  file, matching case with **Aa** and whole words with **Word**. Enter in the replace field replaces in the
  selected match and goes on to the next; **All** or Ctrl+Enter replaces every match as one undo step. The
  new words take the look of the words they replace, bold or coloured ranges included. Locked layers are
  left alone and counted. Text inside an instance comes from its main, so replace it there. Agents use
  `text_replace`, with a dry run to list the matches first.

## Vectors

- The pen (P) draws paths. Edit nodes and curves, paste SVG, and edit fills and strokes.
- **Shape to path** (Ctrl+Shift+O) and the boolean operations union (Ctrl+Alt+U), subtract
  (Ctrl+Alt+Shift+S), intersect (Ctrl+Alt+I) and exclude (Ctrl+Alt+X) make ordinary paths, editable
  node by node.
- Arrow caps are real markers. Strokes can sit inside or outside.

Limits: there are no vector networks and no shape builder. A gradient fill becomes its first colour
when a shape turns into a path, an outside stroke needs a fill, and a boolean result replaces its
sources (undo brings them back). An image becomes a vector with **Vectorize**, under Images below.

A page of glyph cells is a font: the vectors in its cells are the outlines, and **Build font** turns them
into a font the file can use. [Fonts of your own](fonts.md) explains it.

## Images and media

- Place images with I, or paste or drop them. PNG, JPEG, GIF, WebP and AVIF upload, fit and crop. HEIC
  and HEIF upload too; they have not been tried.
- **Crop:** the Image section has aspect presets (free, original, 1:1, 4:3, 3:2, 16:9, 9:16, 4:5) and
  **Crop on canvas**. On the canvas the whole image shows dimmed around the layer, with the crop box
  bright over it: drag a handle to change what is cropped (Shift on a corner keeps the shape), drag
  inside to move the image, and press Enter or Esc when done. A preset keeps the layer's width and sets
  its height, so the crop is never stretched. **Reset** shows the whole image again. A crop is plain
  CSS (the image as a background, sized and placed in percentages), so it follows the layer when it is
  resized and every export keeps it. Agents use `image_crop`.
- **Filters:** brightness, contrast, saturation, blur and grayscale, as sliders in the Image section.
  They are the layer's CSS `filter`, so exports keep them; other filter functions you wrote, such as a
  drop shadow, stay. Double-click a slider to reset it. Agents use `image_filter`.
- **Vectorize:** the Image section turns the image into an editable SVG layer beside it, with at most
  the number of colours you choose and low, medium or high detail. It runs on this computer with
  imagetracerjs, in a worker on the server, and the result is sanitized like any SVG. It works for
  images stored in Bogen. Logos, icons and flat illustrations come out clean; a photo makes many paths
  and a large layer. Agents use `image_vectorize`.
- Video and iframe embeds are layers too.
- **Image placeholder** in the command palette places an empty image of 400 by 300. An image with no
  source shows as a dashed frame with its alt text and size, in the colour and font around it, so a draft
  can hold the space. Select it and choose **Upload image** in the Image section to fill it.
- Bogen has no image generator. Your agent makes images itself: as inline SVG or CSS, which stay
  editable, or with its own image tool, such as Codex's built-in image generation or an image MCP server
  you added. It stores the file with `asset_upload`, which reads it from a path on this computer.
  `bogen-gen:` sources from older prompts do nothing; html_write says so and leaves a placeholder.

## Shaders

The shader tool (S) places real-time WebGL effects from `@paper-design/shaders` as layers, with
presets and every control in the inspector. At most eight run live at once: the selected one first,
then the largest on screen. The rest show a still frame.

## Designs from data

A design can show real records: products, people, rows of a table. One layer is the template, such as
a card, and Bogen makes one copy of it per record, right after it, with each layer filled from the
record's fields. The copies are the live preview; refresh to make them again from new data.

1. **Add a source** in the Data panel (Alt+4): paste JSON or CSV, upload a `.json` or `.csv` file, or
   give a URL that returns one of them. A JSON object with a list inside works too; say where the
   list is, such as `data.items`, when there are several. The panel lists each source with its number
   of records, where it came from, when it was read, its fields, and a **Refresh**.
2. **Bind the layers.** Select a layer of the card. The **Data** section of the inspector picks its
   source and binds the layer's text, image, alt text and visibility to fields, and on an instance its
   props and variant axes. Visible shows a layer only when its field holds something: empty, `0`,
   `false` and `no` hide it. A variant binding picks the member of the variant set whose value the
   record holds, such as a gold or silver badge. You can also write `{{field}}` yourself in text,
   image sources, attributes and styles; `{{price.amount}}` reaches inside.
3. **Repeat.** Select the card and choose **Repeat this layer**. In a flex or grid parent the copies
   lay out like any children, and the template stays hidden. **List** makes a copy per record;
   **Record** shows one record, such as a profile page, and **Show** picks which.
4. **Refresh** in the section or the panel reads the source again and makes the copies again, for
   every template bound to it, as one undo step.

Records are kept in the file, so a design shows its data offline and on your other devices. A source
holds up to 2,000 records and 2 MB; a repeat makes up to 500 copies. Values that would escape a style
or a URL are refused and reported. Change the template, not a copy: the copies are made again on each
run.

**Addresses.** A URL is fetched by the Bogen server, with a size and time limit. Only public
addresses are fetched. To read from this computer or its network, such as a dev server or a NAS,
tick **Allow this computer's network (only from this device)** when you add the source. That works
only for a request made on this computer itself, by you in the editor: never for an agent, a paired
device, a phone or anyone else with the link, and the permission stays on the device where you gave it.
Agents add sources and bind layers with `data_source_set`, `layer_bind` and `layer_repeat`, and only
reach public addresses.

## Tokens and theme modes

Tokens are CSS variables that belong to the file: colour, radius, spacing, container, breakpoint,
font family, weight, size, line height and tracking. Use them as `var(--name)` in any style; change
one and every layer that uses it follows. Open them with Alt+2.

A file can have theme modes, such as light, dark or compact. A token holds one value per mode, and an
artboard, layer or page says which mode it shows. Switch it in the inspector or the Tokens panel.

On Omarchy, a button in the Tokens panel brings the active Omarchy palette in as tokens.

**Renaming a token** (edit its name in the Tokens panel, or `tokens_rename` from your agent) changes
every `var(--name)` that refers to it, also one with a fallback such as `var(--name, 4px)`: layer styles,
pseudo-elements and conditions, attributes, drawings, text ranges, instance overrides, components, text
styles, other tokens and keyframes. Its values in every mode come along. It is one undo step, and a
name that is taken is refused rather than merged. When the file publishes a library or is a brand, the
files that use it get the rename as an update (see [Shared libraries](components.md#shared-libraries)).

Swatches in the inspector show a colour token's value, also through a token that names another one, so a
fill of `var(--surface)` shows its colour rather than an empty square.

With a repository linked, a button in the Tokens panel shows its tokens next to the file's, to pull
them in or push the file's as a pull request. See
[Tokens and the repository](export-and-code.md#tokens-and-the-repository). Your agent can also read
CSS variables and Tailwind themes into tokens, and write tokens out as CSS or a Tailwind theme block.

## Prototype and preview

The **Prototype** section of the inspector sets where a click on a layer goes, the transition and its
duration, and styles while hovering. Ctrl+Alt+Enter opens the preview: click through artboards, try
device widths, and go full screen to present. A preview has its own URL, which opens by itself.
At another device width, media and container conditions take effect, and hover and focus blocks
apply under the pointer.

A prototype can have state:

- **Variables:** with nothing selected, the inspector lists the file's variables, a boolean, a number
  or a text each, with the value a prototype starts from and how many layers use it.
- **Interactions:** on click, hover or submit (on a form), a list of actions: set, toggle or add to a
  variable, show, hide or show-or-hide a layer, set an instance's variant, go to an artboard with a
  transition, or go back. What a hover did is undone when the pointer leaves.
- **Depends on a variable:** a layer shows only while a condition holds (is, is not, above, below,
  contains, is empty, is filled); an instance takes the variant a text variable names; a form field
  reads and writes a variable; a text layer shows one.

The preview runs it. The bar shows the variables as they are, and Restart starts again from the
first screen and the starting values. Clicking around in a preview writes nothing into the file. The
same prototype exports as one clickable HTML file; see
[Export and code](export-and-code.md#clickable-prototype). Your agent sets it up with `variable_set`,
`interaction_set` and `prototype_get`.

There is no smart animate, and the hover styles of this section and links stay out of the HTML export
(the prototype export has them). Hover blocks made under Pseudo-elements and conditions go into every
export.

## Motion

The motion panel (Alt+M) has a keyframes editor, timing, looping and presets. Scrub an artboard's
timeline, or play and pause all motion with Alt+P. Exports to video render animations frame by
frame, and the Code tab writes motion as clean CSS or as Framer Motion; see
[Export and code](export-and-code.md#motion-as-code).

## Comments and other people

- Press C and click to comment on a layer. Threads have image attachments, @mentions of people and
  agents, resolve, search and filter. Alt+C shows them.
- A comment that mentions `@claude` or `@codex` starts that agent; see
  [Agents](agents.md#ask-in-a-comment-claude-and-codex).
- People in the same file see each other's cursors and selections, can follow each other, and can
  chat at the cursor with `/`.

## The window

- **Command palette** (Ctrl+P) over commands, layers, pages, files and tokens.
- With several layers selected, a field whose value differs between them says Mixed; typing a value sets
  it on all of them, including the columns and rows of grid frames.
- **Minimal UI** (Ctrl+\\) hides the panels. Panels resize.
- **Small windows.** The panels and the toolbar follow the window's width and height at your interface size:
  - Both panels sit beside the canvas while they leave it at least 360 px. Narrower, the inspector stays beside
    the canvas, drawn narrower if it must, and layers, pages and assets open as a drawer over the canvas from the
    button left of the file name. Narrower still, the inspector is a drawer too, from the button at the right.
  - The chat with your agent (**Ctrl+Alt+3**) sits between the canvas and the inspector while the canvas keeps
    its 360 px, putting layers into a drawer first if it must; narrower, it opens over the canvas. See
    [the chat](agents.md#ask-from-the-canvas-the-chat).
  - **Ctrl+Alt+1** and **Ctrl+Alt+2** show or hide those drawers; a drawer takes the keyboard focus, **Esc**
    closes it and puts the focus back on its button. Show layers, a comment pin or History open the drawer they
    belong to. When the window grows, the panels go back beside the canvas at the widths you dragged them to:
    folding never changes those widths.
  - The toolbar moves what does not fit into two menus and keeps the file name readable: **More tools** next to
    the tools, and **More** at the right, which starts with the whole file name and has Preview, Design checks,
    History, Hide panels, Settings and Help, and in the smallest windows zoom, undo and redo. Sync shows as its dot,
    with the details in its tooltip.
  - In a low window, dialogs start near the top and scroll inside, with their buttons in view; the prompt stays
    inside the canvas and scrolls. Home stacks its folders above the files in a narrow window.
  - A window with a mouse stays the desktop editor however narrow it is; the phone layout is for touch screens.
- **Settings** (Ctrl+,): language, nudge size, zoom direction and interface size, from 90% to 200%. Until you
  pick a size, a large screen at a scale of 1, such as a 4K monitor, starts at 150%.
- **Language**: the interface in any of Omarchy's 50 languages, or **Automatic**, which follows Omarchy's
  language (Setup > Language) on this computer, else the browser's languages, else English. The choice is this
  device's only; designs, chats, comments and other devices keep their own words. Arabic, Persian, Hebrew and
  Urdu read right to left in the panels, menus and dialogs, while the canvas, the design on it, code and
  shortcuts stay left to right. The translated editor interface has complete catalogs for all 49 languages besides
  English. The translations were made with a language model and have not been reviewed by native speakers.
  Server messages, the standalone preview controls and bootstrap fallback messages still use English;
  a message a language lacks also shows in English.
  **Agents in this browser** lets or stops a browser agent using the tools ([WebMCP](agents.md#agents-in-the-browser-webmcp)).
- F6 moves between the areas of the window. Tooltips show shortcuts.
- The chrome respects reduced motion. Text in it has at least 4.5:1 contrast in the built-in light
  and dark themes.

## Home screen

Recent files, nested folders, search, sort, grid and list, duplicate, multi-select, and moving files
by menu or by dragging. Thumbnails are rendered. **Download .bogen** saves a file, and **Open** brings
a `.bogen` file back. Folders are kept per device and do not sync yet.

- **Settings** (the gear at the top right, or Ctrl+,) open here as in the editor, without a file: language, interface
  size, wheel and zoom, nudge, browser agents, and what this Bogen is: its version and any update, the
  agent CLIs it found and the devices it syncs with.
- **Kinds**, under the folders, group files by what they are a design for: Websites, Apps (iOS, Android,
  Desktop; one file can be for several), Themes (Omarchy Desktop, Omarchy Mobile), Omarchy plugins,
  Omasidebar widgets, Brand systems and Other designs. Kinds, folders, search and sort work together; the
  counts are of what the folder and search leave, and a line above the files says what is shown, with
  **Show all**. With a folder, a kind or a search chosen, the files come first: the examples, brands and
  themes galleries make room, and come back with All files. Themes shows the installed themes below its
  files, and Brand systems the brands made with the brand tools, which are records of their own: the Brand
  systems kind lists the design files you mark as one.
- A file's kind is what you set with **More**, **Kind and platforms**, or what the file records itself: an
  Omarchy theme and its target, or artboards marked as web pages. Bogen does not guess from names or sizes,
  so anything else is Other designs until you say. Your answer is kept in the file and travels with it.
  Home reads kinds from the file list; it never opens files to sort them, so a file Bogen has not opened
  since this version keeps its kind unknown until it is opened or you set it.
- Plugins and widgets here are the designs of their screens and assets. Bogen does not build or install
  them.

## Limits

Large pages keep every screen's box and show actual cached screen images in the overview. Bogen loads nearby readable screens as editable content according to their expanded layer cost, rather than stopping at four screens. Selecting a screen, focusing a layer, editing text or opening its comment loads the required content. **Fit everything** can show all cached screens without mounting every layer.

Previews fill in asynchronously the first time. Unchanged images are reused on this device; changed screens are captured again. Background capture pauses when memory is low and yields to foreground rendering. Existing images remain visible while zooming, panning and refreshing. Replacements decode before display, and nearby editable screens prepare earlier. A first-time screen without a cached image shows **Loading** until its content or image is ready. The cache stays on each device and is limited to 128MiB / 1,024 records. It is not a live view of external embeds.

Fixed clipped screens retain their exact boxes. Content-driven clipped screens use fresh preview geometry when available, otherwise local measurements or an approximate initial box. Document styles never change to match a proxy. Flow-dependent, overflowing and transformed screens retain complete rendering. Preview/export render the complete design; explicit bulk operations can require more memory. Search, sync and undo retain the full document, so this bounds canvas rendering rather than file size.

A sandboxed Chromium 156 desktop test on 9 November 2026 opened a generated 25-screen file with 8,538 stored and 17,346 expanded layers. First editable content appeared in 736ms with 763 mounted layers; first-time preview generation took 20.8 seconds in the background, and a subsequent overview loaded all 25 real images in 707ms. An edit refreshed its image; unchanged reloads reused the cache. Another 20-screen fixture rendered all 20 simple screens live. On the Linux ARM64 MacBook, the same test showed editable content in 2.91 seconds, cold background previews in 63.5 seconds and a warm overview in 2.27 seconds under explicit CPU and memory limits. These controlled results are not a guarantee for every machine or file. See [loading details](../design/large-file-loading.md) and the dated release assessment for qualification limits.

The older benchmark below describes a different fixture and rendering version; its numbers are not a direct before/after comparison.

A big file was
measured on 2 November 2026: nine artboards, eight of them landing pages with navigation, a hero,
cards, quotes, a 140-row table, pricing, questions and a footer, made the way an agent makes them.
That is 3,618 stored layers, 10,354 layers on the canvas once instances are drawn, 20,393 DOM nodes,
and eight PNG images. The machine was an Intel i9-13900K with Chromium 155, headless, through a real
server in a temporary data folder. Under "4x" the browser's CPU was slowed four times, as for a
laptop on battery. Each number is the median of five cold loads, or of 10 to 15 writes.

| What | This machine | CPU 4x slower |
| --- | --- | --- |
| Opening the file until the first layer is painted | 0.47 to 0.49 s | 1.8 s |
| Until all 10,354 layers are in the page and painted | 0.51 to 0.54 s | 1.8 s |
| An agent's `html_write` of a small section, until the call returns | 7 ms (was 10 to 12 ms) | 7 ms (was 11 ms) |
| The same write, until it is painted in the open editor | 28 ms, at most 40 ms | 44 ms |
| `design_lint` of the whole page | 0.47 s (was 0.9 s) | 0.47 s (was 0.93 s) |
| `canvas_screenshot` of one landing page | 0.25 s | 0.25 s |
| The editor tab's JavaScript heap | 44 MB | 44 MB |
| The server's memory, with the file open | 283 MB, of which about 155 MB before any file | |

In that older nine-artboard measurement the first layer and the last one painted in the same frame. A
write shows a frame or two after the call returns. Two hot spots were fixed: after every write the
server read every layer whole to answer which layers belong to which parent, and `design_lint`
worked out each text's colours and backgrounds again for every text. Most of the remaining time to
open is React making the elements (about 40% of it), then style and layout.

To measure a file of your own size, see [building](../building.md#browser-suites):
`scripts/gen-perf-fixture.ts` makes the file and `perf-big.ts` measures it.

## Organize a multi-screen canvas

New screens can join a planned section immediately through `artboard_create` with `section_id` and `lane_title`. After filling the screens, the agent finishes their placement with `canvas_plan_set`. Built-in runs that create three or more screens on one page are checked for missing groups or a pending arrangement before completion. Existing unrelated screens remain outside this requirement. See [the organization workflow](../design/canvas-organization.md).

Ask the agent to group screens by task, with named sections and lanes for the main path, states or alternatives. The canvas map opens a list of those sections; click one to fit that part of the canvas in the window. Section headings and optional, explicitly named flow connections belong to the editor and do not become layers in exported screens.

Agents use `canvas_plan_get` and `canvas_plan_set` to read, preview and apply the arrangement. A plan may start with empty lanes before any screens exist. Applying it moves the named screens in one undoable step, preserving their IDs, contents, comments and component references. Locked or transformed screens and collisions with untouched layers stop the operation. Hugging screens require measured bounds. A revision token prevents an agent from silently replacing a plan changed by another editor.

The right inspector uses eight icon tabs with tooltips, keyboard navigation and a title for the active section. Its controls wrap into fewer columns at narrow widths. The project-kind selector beside the title is available whenever you need to change the classification. An unclassified file asks “What are you designing?” and offers the same Website, App, Theme and other choices as the Home screen. A palette alone does not classify an app or website as an operating-system theme.

## File covers

Home uses a single useful screen as the cover, preferring populated artboards near 16:9 over a whole canvas of tiny screens, empty placeholders or palette/process boards. It looks across the file's pages. Theme files retain their wallpaper default. Cards show the complete image at 16:9, with 640-pixel previews; older cached pictures rebuild lazily through the bounded background queue.

To choose a different cover, select its screen or a layer inside it and enable **Cover** beside **Redo this screen…** in Design. Click Cover again to return to automatic selection. The choice belongs to the document and its design branch, and can be undone. A deleted or hidden cover falls back to automatic selection.
