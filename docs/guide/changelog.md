# Changelog

## 0.1.0

The first version. Everything below is new. [The canvas](canvas.md) and the other guides say where a
feature works only in part.

### Design guidance for agents

- Every design skill, the MCP instructions and the design guide open with a quality bar and a six-step work loop: brief and point of view, tokens and scales, sections with screenshots, whole-artboard review, scored rubric, report. The instructions kept their size.
- `design_lint` and `design_review` report nineteen craft findings for the habits that make work look generated or unfinished, such as more than two font families, decorative monospace, equally loud type, competing filled actions, glow, tilt, drawn window dots and text on a picture without a scrim. [Design playbooks and verification](design-knowledge.md#craft-checks) lists each line.
- `design_verify` takes a scored rubric of eight criteria. A score above 3 does not hold while measured findings stand against that criterion, and built-in runs do not complete without the rubric.
- `design_lint` also finds hedges, test-report language and headings chopped into fragments.
- The checks read what a template shows rather than designs by its mark: counter-examples are left out, and specimens such as every button variant or the type scale are spared only the rules about composing one screen. An Omarchy theme file is read as a preview of the system, so its monospace bar, key glyphs and portrait monitors are not judged as a web page or a story. FAQ questions, file names, icon-font glyphs, `var()` fallbacks and unlike siblings no longer raise findings. [What the checks read as something other than a page](design-knowledge.md#what-the-checks-read-as-something-other-than-a-page) has each rule.

### Large files

- All cached screens remain visible in large canvas overviews. Actual WebP previews replace empty offscreen boxes after background capture; unchanged previews survive restarts.
- Automatic live rendering follows expanded layer cost and device memory instead of a fixed four-screen limit. Selecting a screen still opens its editable content.
- Preview capture runs one screen at a time, pauses under memory pressure and closes its browser context after every capture. The device-local cache has explicit size and record limits.
- Canvas maps list unassigned screens even before a page has sections. External agents receive fresh organization status in file and context responses; text headings alone do not count as assigned sections.

### Proposal decisions

- An unchanged accepted proposal is recorded as accepted, including decisions synced from another editor. Changes inside a screen preserve layer ids without confusing the result.
- Choosing one direction reports the other directions as discarded; an unrelated original edit cannot turn a discard into an acceptance.
- Small decision receipts share the same undo step as the decision; the local preference history remains separate.
- Completion checks stay inside an assigned revision/race copy when no layer ids changed. Creating an empty page does not recheck unrelated older screens; actual visual changes still require screenshot and verification.

### Updates, packaging and checks

- Large canvases show real cached previews and budget live screens by expanded layer cost. Short isolated render batches reuse one page for at most four screens; tiny thumbnails are derived from the completed raster. This also supports absolute clipped hug-height layouts. Offscreen proxies avoid retaining wallpaper/effects; geometry edits hydrate their real content before measurement. An aarch64 laptop passed the bounded 25-screen opening, focus, pan and edit fixture.

- npm updates prepare and check a separate installation, retain the previous app and support explicit offline rollback. Preparation/activation failures preserve the current app and documents.
- The packed runtime uses exact top-level versions and a shrinkwrap derived from the reviewed dependency lock, consistent with dependency notices and the SBOM.
- Normal editor settings reads no longer start model catalogs. Opening a model picker still queries the selected CLI.
- CI checks source hygiene, types, builds, documentation, core/editor contracts and signed-update recovery. Test examples use fictitious device identities.
- Canonical sixteen-chapter brandbooks, sources/open questions and human review; a branch tree/list/checkpoint overview; canvas-only arrangement no longer expands quality checks to unchanged screen content.

### The canvas

- An infinite canvas where every layer is an HTML element with CSS: frames, flex and grid, absolute
  position with constraints, fixed, hug and fill sizes.
- Tools for frames, shapes, lines and arrows, text, the pen and pencil, images, comments and shaders.
- Smart guides, snapping, measuring, gap and padding handles, reordering flex children by dragging.
- Fills with layered gradients and handles on the canvas; borders, shadows, filters, blend modes; any
  CSS property under Other styles, and Simplify styles.
- Rich text ranges, Google Fonts and local fonts with variable axes; text that merges per character
  when several people type.
- Vector editing, shape to path and boolean operations.
- Lucide icons, shader layers, video and iframe embeds.
- Images: crop with aspect presets and handles on the canvas, brightness, contrast, saturation, blur
  and grayscale as CSS filters, both kept by every export, and Vectorize, which traces an image into an
  editable SVG layer on this computer.
- Designs from data: data sources of JSON or CSV, pasted, uploaded or read from a URL, kept in the
  file; layers bound to fields for text, image, visibility, props and variant, for a list or a single
  record; refresh with live copies on the canvas; code export that maps over the records. This
  computer's own network only when you allow it on this device.
- Prototype links, hover styles and transitions, a preview with present mode, and a motion panel with
  keyframes.
- Prototypes with state: boolean, number and text variables; interactions on click, hover and submit
  that set variables, show and hide layers, switch variants and navigate; layers, variants, fields and
  text that follow variables. The preview runs it without writing to the file.
- Responsive variants: a 1440 artboard becomes 768 and 390 versions as media rules on the same
  layers or as linked artboards, then a check lists what still sticks out.
- Command palette, find on canvas, layer search, settings, minimal UI, and a shortcuts dialog.
- Comments with attachments and mentions; cursors, presence, follow and cursor chat.
- A home screen with folders, search and thumbnails.
- Measured with a file of about 10,000 layers: it opens and paints in about half a second, and an
  agent's write shows in the open editor about 30 ms after it is sent ([Limits](canvas.md#limits)).
- A welcome file on the first start, made once and never again once deleted (`bogen welcome` and
  Help open it), and four examples to start from, each with a small brand of its own.

### Design systems

- Tokens as CSS variables, theme modes with one value per mode, and text styles.
- Components with instances, overrides, props, variants and slots.
- Component kits: shadcn/ui, Radix Themes, Bootstrap 5, and Material 3 and Ionic in iOS mode as phone
  kits, each with variants, props and slots, tokens in the kit's own names with light and dark modes, a
  showcase page, and code that imports from the kit's library. A brand maps onto a kit's tokens, and a
  kit can be made from a linked repository's components. Kits under Assets, `kit_list` and `kit_use`.
- Shared libraries between files, with updates you accept.
- Code components: React components from your own project, rendered by its own code, and its
  Storybook stories as variant sets that stay in step.

### Brands

- Brands as documents of their own, synced, with logos, palette, type, layout, voice and rules.
- Extraction from files, live pages, CSS and Tailwind configs, as suggestions you confirm.
- The brand check with a score that explains itself, waivers by a person, and strict mode.
- Versions, impact on linked files, and applying a change as one undo step per file.
- Templates that lay out a brand system, a landing page or social images from a brand.
- Memory from decisions: what you accepted and discarded, measured, turns into rule suggestions in
  the Brand panel that you add or dismiss, and a short summary for agents in `brand_get`.
- Like this site, in a brand: a captured page redrawn in a brand's colours, fonts and scales, with
  placeholders for its text and images, then checked against the brand (`site_restyle`).
- A setting an agent proposes for a brand, such as strict mode or no gradients, binds nobody until you
  confirm it, like any other suggestion, and publishing a version confirms nothing. `brand_update`
  refuses a value that is not one of a setting's choices instead of reading it as the default, and
  writes nothing of a call that fails.
- A brand read from CSS keeps the stylesheet's own variable names as tokens and takes family roles from
  names such as `--font-display`. Looking at a live page and then applying it captures the page once.
- A file whose brand was deleted says so with the way out, in the Brand tab and in every brand tool. The
  brand page says why an export, an upload or an edit did not go through.
- Brand languages: a brand speaks a primary language and any others, as tags such as `de-AT` or
  `pt-BR`. Words, examples and text rules belong to one of them. `brand_check`, `design_lint` and
  `voice_check` judge copy in the language it is written in, and agents are told which languages the
  brand speaks and which one to write in. Brandbook chapters keep the language they are written in and
  are marked with it; they are not translated. A brand with one language works as before.
- The Brand panel shows the value of a setting that binds, with an agent's proposal beside it to
  confirm or dismiss. The Strict box no longer looks set while strict mode is only proposed.
- A duplicated brand is a new brand: it starts at version 0 with no versions of the original, and says
  which brand and version it came from.
- `PATCH /api/brands/:id/book` is gone. Nothing used it: the editor writes chapters into the brand
  document, and agents use `brand_book_update`.

### Your agent

- One relevant effective design skill supplied before every built-in canvas run, with the delivered discipline and revision recorded in run details. External clients receive explicit setup guidance.
- Personal SKILL.md editing in Settings: direct Edit, copy/download, immutable original, restore with backup, persistent tab drafts and concurrent-edit protection. Sixteen playbooks, 128 decisions, 32 composition briefs and 28 contextual anti-slop preferences.
- Redo this screen from its right-click menu or the Design inspector, with optional feedback and the existing revision/branch safeguards. Opening the prompt starts no run.
- A quiet Reload notification when an open desktop window has an older editor than its server. No automatic reload during editing.

- An MCP server with tools, resources with subscriptions, four prompts and guides, over stdio and
  HTTP, working with no editor open.
- `bogen install` for Claude Code, Codex, Cursor, VS Code, OpenCode, Gemini CLI and Zed, with a Bogen
  skill for Claude Code and Codex.
- Ctrl+K runs your own `claude` or `codex` with only Bogen's tools; `@claude` and `@codex` in a
  comment start a run that answers in the thread.
- Comment threads are conversations: a reply without a mention goes to the thread's agent with its
  model and effort, the composer shows where it goes (**To Claude · Opus**) with **Comment only** and a
  choice per message, a bare `@claude` answers what you wrote before it, and threads are compact headers
  that open and close, with drafts kept per thread, on the desktop and the phone
  ([Conversations](agents.md#conversations-replies-go-to-the-same-agent)).
- Images come from your agent: inline SVG or CSS, or its own image tool, such as Codex's built-in
  image generation, stored with `asset_upload`, which reads the file by path. Bogen has no image
  generator and calls no AI provider. An image with no source is a placeholder of its size.
- Model and effort per runner, run history, proposals to accept or discard, events to wait for,
  agents that point at things, and undo per agent and per step.
- A race of agents: **3 directions** runs several CLIs or models at once, each in its own copy with
  its own cursor and colour, with a concurrency limit per runner; you compare, accept one, and drop
  the rest or keep them in a branch inside the file.
- Critique: a run that only reads and comments leaves notes pinned to layers, each with a suggestion
  that **Fix it** hands to a fix run.
- Rebuild as layers: an image layer, or an image pasted into Ctrl+K, goes to the run attached, which
  rebuilds it next to it in the brand and compares with `visual_diff`.
- Live site mode: pick an element on your running dev server and have your agent edit the source.
- Custom design checks: create, extend, disable and run saved checks in the Design checks dialog or with `check_list`, `check_set`, `check_delete` and `check_run`. Rules cover rendered CSS, geometry, attributes and element counts, alongside lint and responsive checks. Definitions sync, undo and export with the file.
- `responsive_check` can compare the same mobile width at several browser heights (`viewport_heights`), reporting changes to content height, layer positions, visibility and sticky positioning. Results are measurements to review while preserving the intended scroll effect.
- `design_lint` checks spacing rhythm and type hierarchy as well as contrast, tokens and sizes, and
  applies its safe fixes as one undo step.
- `html_write` keeps the white space of `<pre>` and `white-space: pre`, and says which CSS it dropped
  because a browser would ignore it; `layer_move` takes layers to another page; `layer_find` compares
  style values as CSS.
- A design language per file and per request, apart from Bogen's own language: write new copy in it,
  translate screens in place, or add a language version as a branch inside the same file. Every run
  and `file_open`/`context_get` get it, with `lang` and `dir` on the artboards an agent translates.
  [Screens in another language](agents.md#screens-in-another-language).

### Getting things in and out

- Capture copies a live page, or a whole site, onto the canvas as editable layers, keeps self-hosted
  fonts, and fills in a second colour scheme as theme mode values.
- Drift compares an artboard with its live site, by pixels with an overlay and by structure: spacing,
  sizes, colours and fonts (in the brand or not), changed words, and missing or extra elements, with
  the CSS values of both sides. In the Drift tab and as `drift_check`.
- Import from Figma through the REST API with your own token.
- Export to PNG, JPG, WebP, AVIF, SVG with real vectors, PDF, HTML, MP4 and WebM, with size presets
  to a zip, and a clickable prototype as one HTML file with one small script that asks no network.
- Code as HTML, React or React with Tailwind, with components as typed React components.
- Experimental: a layer as a minimal [Exact](https://github.com/expo/exact) app in its Contract
  language, in the Code tab, `code_get` and `export_file`, written against Exact `57c86055b5c4`, with
  what Contract cannot say left out and listed ([An Exact app](export-and-code.md#an-exact-app-experimental)).
- Motion as code: keyframes, animations and transitions as CSS that honours
  `prefers-reduced-motion`, or as Framer Motion in the React export.
- Tokens out as CSS or a Tailwind theme, and in from your repo's CSS.
- App screens from Tomacco come in as editable artboards, with an optional device frame, and Design
  versus app compares a design with the real screen: pixels and matched elements
  ([Tomacco](tomacco.md)). From the Export tab or the toolbar, the screen lands beside the selected
  artboard and opens the comparison on the same capture. When Tomacco is missing or no device runs,
  the editor and `tomacco_status` show the next step from `tomaccoctl doctor` with its command; Bogen
  never runs it.
- The linked repository's tokens next to the file's, from CSS, Tailwind or DTCG, pulled in or pushed
  as a pull request.
- A pull request from a design change: your agent implements it in a working folder of its own, with
  before and after pictures and a link back, and nothing is pushed until you confirm the preview.
- Publish an artboard or a page as a static website, in versions with rollback and unpublish: on
  Bogen's own site on your tailnet, in a folder, or on GitHub Pages through your own `gh`. The files
  carry no script, layer ids or anything else internal, and only you publish, in the editor; agents
  prepare and ask.
- Review links for clients: one frozen version under an unguessable link that expires, can be revoked
  and can have a view limit, with an optional plain comment form whose comments wait in your inbox
  and never start an agent.
- Tailscale Funnel for the site and review links, off by default, on its own port, after a warning.

### History

- Every change on a timeline, revertable on its own or as a whole agent run.
- Commits, compare with a visual difference, restore, and branches: versions of the whole design inside
  the file (tokens, records, components, layers), that sync and go with a `.bogen` file; you review and
  merge them with a choice per conflict, discard, restore or undo a merge, and an agent can only start
  and work in one ([Branches](history.md#branches)). Older copy-branches are listed under Older copies.
- Design folders that diff well, and a Git mirror that never pushes.
- Replay plays back how a page was built, every step with each person's and agent's cursor, and films
  it as MP4, WebM or GIF, also with `bogen replay` and `replay_export` ([Replay](history.md#replay)).

### Devices and desktop

- The first public release targets Omarchy desktop. Five collection presets have recomposed landscape/portrait vector artwork; five multicolour active borders are replaced by single accents, and muted text in every preset meets 4.5:1 against its base background. Existing personal theme projects retain their saved artwork.

- The interface in Omarchy's 50 languages, chosen per device under Settings, or Automatic from Omarchy's language
  on this computer and the browser's elsewhere; right to left for Arabic, Persian, Hebrew and Urdu with the canvas
  kept left to right. Machine translated, not yet reviewed by native speakers
  ([Settings](canvas.md#the-window)).

- Sync between your own machines over Tailscale, with conflict notes and version checks.
- Voice comments on the phone: the microphone records a note that a speech model on your computer
  writes out, or that stays attached when there is none; nothing goes to a speech service
  ([Voice comments](devices.md#voice-comments)).
- Text that both devices edited while apart keeps one side's whole text, with a note on both that has
  both texts and offers Use the other, Keep both as a branch and Dismiss. Edits in different words
  still merge.
- `bogen doctor` checks the whole setup and prints the fix for each problem.
- `bogen peer deploy` updates another Omarchy machine over ssh.
- Omarchy integration: theme following, bar widget, notifications, launcher, keys, a user service and
  screenshots to the canvas.
- Design an Omarchy theme: a file whose tokens are the keys of `colors.toml`, with previews of the
  bar, terminals, windows, launcher, notification, lock and boot screens drawn from them, and
  backgrounds at the sizes of your screens. Start from nothing or from an installed theme, export a
  theme folder, a Git repository or a .tar.gz, install it, and apply it with Undo
  ([Design a theme](omarchy.md#design-a-theme)).
- Portrait desktop monitors in Omarchy themes: previews of the desktop, launcher, lock and boot
  screens laid out for a monitor turned on its side (detected from `hyprctl`, or 1080 × 1920), a
  wallpaper composition of its own shape instead of the landscape one cropped, a Displays section and
  `omarchy_theme_displays` to add displays to a theme that exists and to give a composition artwork of
  its ratio, and the portrait previews and compositions under `displays/` in the export
  ([Portrait monitors](omarchy.md#portrait-monitors)).
- Portrait monitors show a theme's own portrait composition with the portrait background plugin
  (`bogen omarchy portrait install`, then `enable`), a clone of Omarchy's background derived from the
  one on the machine; every other screen keeps the theme background. Only designed compositions are
  shown or exported: new and imported themes start with a quiet placeholder instead of palette arcs,
  a landscape picture shown whole in a portrait layout counts as composed and exports as a render,
  and `bogen omarchy portrait audit` says for every installed theme what a portrait screen shows
  ([The portrait background plugin](omarchy.md#the-portrait-background-plugin)).
- **Add 9:16 layout** in the theme dialog asks an agent to compose a desktop theme's 9:16 composition.
  It is one real run, with the agent and model chosen for the prompt. It starts after a checkpoint in
  the History, adds the 9:16 shape only if it is missing, and works on the existing board in the same
  file. It shows in the prompt and the queue under that name, with Stop. When it ends, the dialog
  shows the composition's real state. It uses agents on this computer only, never swaps in another
  agent, and never installs or applies the theme
  ([Portrait monitors](omarchy.md#portrait-monitors)).
- One project per theme: starting from the same installed theme again, with or without a name, opens
  its project; several possible ones are listed for you to choose, never another copy. **Themes** on
  the home screen shows your projects with drafts, Draft, Installed and In use, and their branches.
  Older copies of one theme come together as branches of the project you pick; the copies stay as
  kept files under it ([Copies of one theme](omarchy.md#copies-of-one-theme)). A theme Bogen made keeps
  its designed portrait compositions.
- An npm package, `bogen-design`, and an Arch `PKGBUILD`.

### Releases and support

- Signed releases: each file has a SHA-256 and an Ed25519 signature, with a CycloneDX SBOM and a
  provenance statement. `bogen verify` checks them against the key built into Bogen.
- `bogen update check` and `bogen update apply` for an npm install; `apply` installs only a package
  whose signature verifies. The editor and the bar widget say quietly when a new version is out, and
  the daily check can be turned off. See [privacy](privacy.md#update-checks).
- `bogen report` writes a bug-report bundle on your computer, with tokens, keys, cookies and Tailscale
  logins masked. It sends nothing.
