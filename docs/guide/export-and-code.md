# Export and code

Exports are rendered by the same headless browser that draws your screenshots, so what you export is
what the canvas shows.

## Export files

Select layers, or nothing for the whole page, and open the Export tab (Shift+E).

| Format | Notes |
| --- | --- |
| PNG, JPG, WebP | At any scale from 0.1 to 4. Large images are captured in tiles and joined; WebP stops at 16383 pixels on a side, with a clear error. |
| AVIF | Encoded by the browser, or by ffmpeg. Transparency needs ffmpeg. |
| SVG | Real vector elements; see [SVG](#svg). |
| PDF | One page per layer, or several layers merged into one document. |
| HTML | A page that plays its animations and shaders. |
| Clickable prototype | One HTML file that runs the prototype; see [Clickable prototype](#clickable-prototype). |
| MP4, WebM | Video; see [Video](#video). |
| Exact app | Experimental, from your agent only: a folder per layer; see [An Exact app](#an-exact-app-experimental). |

**Several sizes as a zip:** the Export tab has preset sets, and you can add your own rows:

| Set | Files |
| --- | --- |
| Web | WebP at 1x and 2x, AVIF at 2x, PNG at 1x |
| iOS | PNG at 1x, 2x and 3x |
| Android | PNG at mdpi, hdpi, xhdpi, xxhdpi and xxxhdpi |
| Social | PNG 1200 wide, JPG 1080 wide, WebP 640 wide |
| Vector | SVG and PDF |

### From your agent

`export_file` writes to `~/Downloads/Bogen` (set `BOGEN_EXPORT_DIR` for another folder), or to a
`path` you give it: an absolute path under your home folder, or a folder ending in `/`. It never
replaces a file unless told to overwrite. It refuses hidden folders unless you asked for one, and
never writes into protected folders or Bogen's own data.

### SVG

SVG export writes rectangles, paths, text with a position per line, images, native gradients, outer
and inner shadows, text shadows, clipping, masks made of one gradient, `::before` and `::after` whose
content is text or an attribute, dashed borders spaced as the browser draws them, and transforms, all
as real SVG. What cannot be expressed stays HTML inside a `foreignObject`, and the export report says
which layers and why: blend modes, image masks or masks of several layers, conic gradients,
pseudo-elements that show counters, quotes or images, filters other than one blur, and form controls.
A cropped image is an `<image>` clipped to its box.

Text keeps its font names, so another machine needs the fonts. Each kind of layer is checked in a test:
the SVG is drawn by rsvg-convert (librsvg, which shows no `foreignObject` at all) and by Chromium, and
compared with Bogen's own render. Gradients, masks, shadows, clips, borders and transforms differ in
under 0.1 % of pixels, pseudo-elements in under 0.7 %, and text in under 4.5 % in rsvg-convert, which
smooths glyph edges differently (under 0.5 % in Chromium). Not yet opened in Illustrator, Figma or
Inkscape.

### Clickable prototype

The **Clickable prototype** format writes one static HTML file of the selected artboards (a layer
stands for its artboard) and of every artboard their links and interactions lead to, with the
variables, interactions, conditions, bound fields and variants of the
[prototype](canvas.md#prototype-and-preview). It opens from disk, with no server:

- One small script runs it, the same state machine the preview runs. It is written inline and asks
  no network: the file's Content Security Policy forbids connections, form posts, workers and frames,
  and a form only runs its interaction.
- Each other variant an instance can switch to is written out next to it, hidden until the state
  picks it.
- The screen it shows is in the address as `#artboard-id`, so a link can open a later screen.
- Screen transitions follow `prefers-reduced-motion`.

Fonts are linked as in the HTML export. Your agent writes it with `export_file` and
`format: "prototype"`.

### Video

Any frame exports as MP4 or WebM, at no cost. Bogen renders frame by frame at exact times, so CSS
animations, SVG animations, videos and shaders land where they should. It uses ffmpeg when there is
one, and the browser's own encoder otherwise. Set `BOGEN_FFMPEG` to a path, or to `none` to use only
the browser. Give a duration (up to 120 seconds) and a frame rate (up to 60).

A GIF or an embed runs on its own clock, and the report says so. There is no audio.

### What an export contains

- **Fonts.** An HTML export links Google Fonts families from Google's servers. If you put such a page online, every
  visitor's browser contacts Google. In the EU that normally needs the visitor's consent, and site owners in Austria
  and Germany have received legal claims over it. Use [Publish](#publish), which bundles the font files, or host the
  fonts yourself before the page goes live.
- **Licence.** The code Bogen writes into an export is yours to use under terms of your choice; see the
  [exception for exported work](../../LICENSE-EXCEPTION.md). An export that uses shader layers contains code from
  `@paper-design/shaders` under the Apache License 2.0, whose notice is in
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Publish

An artboard or a whole page can go out as a static website. Open the Export tab and click
**Publish**, or run Publish as a website from Ctrl+K.

1. **What.** The selected artboard, or the whole page with one HTML file per top-level layer. The
   first is `index.html`.
2. **Make a version.** A version is a frozen copy of the design as it is now: HTML, one style sheet
   per page, and the images, fonts and code component frames it uses as files. Media queries are
   read against the window, the top-level layer fills the window's width, and nothing is loaded from
   elsewhere. The dialog lists the files and what was left out or changed.
3. **Where.** Pick one target, and click **Publish**:

| Target | What happens |
| --- | --- |
| Bogen site | Bogen's own static listener serves it, on your tailnet at `https://<this computer>.ts.net:10000/`. One site at a time. Public on the internet only with [Funnel](sharing.md#public-on-the-internet). |
| A folder | The files are written into a folder under your home folder, such as `~/Sites/couchette`, for any web server or host. Bogen replaces only files it wrote there; a folder with other files needs your yes. |
| GitHub Pages | One commit on the branch you name, through your own `gh`. Click **Show what gets pushed** first: the plan lists every file sent, removed or left alone, and nothing is pushed if the branch changed since. Turn on Pages for that branch in the repository's settings. |

**Versions.** Every publish keeps its version. Pick an older one and publish it again to roll back.
**Unpublish** takes the site off the target you picked: the listener stops serving it, a folder loses
the files Bogen wrote, and GitHub gets a commit that removes them. Bogen keeps the last 20 versions
of each site, and every version that is live somewhere or that a review link shows.

**What is never in it.** No script, event handler, comment, layer id, `data-*` attribute, inline
style, hidden layer, proposal, Bogen address, history, agent or brand data. If any id of the document
is still found anywhere in a page, the version is not made. Shaders are shown as a still picture,
code components run in sandboxed frames, and embeds of other sites are left out.

**From your agent.** `publish_prepare` makes a version and asks you to publish it. You see the
request in the Publish dialog, marked with the agent's name, and decide. An agent cannot publish.

**From the terminal.** `bogen publish prepare <file> [<artboard id>]` makes a version, `bogen
publish status` lists sites and where they are live, and `bogen publish unpublish <site>` takes one
back. Publishing itself happens in the editor. See [the CLI reference](reference/cli.md#bogen-publish-and-bogen-share).

To send a version to a client for comments instead, see [Sharing for review](sharing.md).

## Copy as code

The Code tab (Shift+C) shows the selection as code, live as you edit:

- **HTML** with inline styles;
- **React** with inline styles;
- **Tailwind:** React with Tailwind classes;
- **Exact:** experimental, the files of an [Exact app](#an-exact-app-experimental) for each selected
  layer.

Components come out as React components with typed props, a union and one branch per variant, slots
as `ReactNode`, and instances as usages. An instance with changes on its inner layers is written out
in full, and says so. [Code components](components.md#code-components-from-your-repo) come out as a
usage of your own component with its import.

Components from a [kit](components.md#component-kits), and components of your own with a handoff, come
out as a usage of their code library rather than written out: the import, such as
`import { Button } from "@/components/ui/button"` or `import { Button } from "@mui/material"`, and the
variant values and text props in that library's own names, such as `<Button variant="outlined">` for
Material's outlined button in MUI. A value that is the library's default is left out. Components made of
several parts, such as a Card with its header or a Select with its items, are written from a template
of those parts. The kit's own code is never written into the export, so the library has to be
installed in the project.

A [design from data](canvas.md#designs-from-data) comes out as code that maps over its records:
`{products.map((item, i) => ( ... ))}` with `item.name` where the text was bound, `src={item.image}`
for an image, `{item.inStock && ( ... )}` for a visible binding, and `tier={item.tier}` on a component
whose variant comes from the data. The records the design shows are written as a constant above the
component, at most the first 50, for you to replace with your app's own loading. A template showing
one record writes that record as one constant. The copies on the canvas are not written out.

A cropped image comes out as one element with the image as its background, sized and placed in
percentages (`background-size: 200% 100%; background-position: 50% 0%`) and with `role="img"` and its
alt text as `aria-label`. It needs no wrapper and follows its box at any size. Image filters stay the
layer's `filter` style. PNG, JPG, WebP, AVIF, PDF and video show both as the canvas does.

Pseudo-elements and conditions come along: HTML and React carry a `<style>` element for them, and
Tailwind uses variants such as `before:`, `hover:` and `@max-[560px]:` where one says the same. See
[Pseudo-elements and conditions](pseudo-and-conditions.md#in-exports-and-code).

The generated React type-checks in strict mode, also with `noUnusedLocals` as in Vite's template, and
builds with Vite. Built with Tailwind 4 and its preflight, the Tailwind output renders pixel for pixel
as the canvas does. Because preflight changes browser defaults, the exported root gets
`leading-[normal]`, and headings and `small` get their browser sizes where the design does not set
them. A `max-width` condition comes out as its own query, such as `[@media(max-width:_640px)]:`,
because Tailwind's `max-[640px]` leaves out 640 itself. A component takes its line height from where
it is used, as on the canvas: in a Tailwind app that is 1.5 unless the page sets it. HTML and inline
React come with the base styles the canvas draws on; leave them out if your project has its own
reset.

### Motion as code

Under the format, **Motion** says how keyframes, animations and transitions come out:

- **CSS** (the default): the `@keyframes` the code uses, and `animation` and `transition` on a class
  per moving layer, such as `.motion-title`, inside `@media (prefers-reduced-motion: no-preference)`,
  so that a person who asked for less motion sees the layers at rest. The layers lose those
  properties from their inline style.
- **Framer:** React only. A moving layer becomes `motion.div` (or its own tag) with `initial`,
  `animate` and `transition`: keyframe stops become value arrays with `times`, transforms become `x`,
  `y`, `scale` and `rotate`, iterations become `repeat`, alternate becomes `repeatType: "reverse"`. A
  `:hover` block on a layer with a transition becomes `whileHover`. The component is wrapped in
  `<MotionConfig reducedMotion="user">`, and the module imports `motion` and `MotionConfig` from
  `framer-motion`.
- **Inline:** as stored, in the style attribute.

Your agent asks for the same with `code_get` and `motion: "css" | "framer" | "inline"`. An easing
Framer Motion has no name for runs linear, and a missing `@keyframes` is named in a note.

## An Exact app (experimental)

[Exact](https://github.com/expo/exact) is Expo's cross-platform runtime: an app's interface is written
in its Contract language, its data in TypeScript or Rust, and the same app runs on the web and
natively on several platforms. Bogen can write a layer as a minimal Exact app, so that a screen
designed here can be run and tested as a native app.

Exact is pre-1.0 and changes daily, without compatibility from one day to the next. Bogen's export is
written and checked against one commit of it,
[`57c86055b5c4`](https://github.com/expo/exact/commit/57c86055b5c4c41ef7db310fdaf63bc7900963a7)
(10 November 2026). A newer Exact may refuse something it writes; Exact's compiler then says what, with
the line and the fix.

Choose **Exact** in the Code tab, ask your agent for `code_get` with `format: "exact"`, or have it
write the app to a folder with `export_file` and `format: "exact"` (one folder per layer, or per
top-level layer of the page, with the pictures copied in). The app has:

| File | What is in it |
| --- | --- |
| `app.contract` | The layer as a Contract view: frames as `column`, `row` or `view` (grid as `view display="grid"`), text as `text` with its style, headings as `text role="heading"`, images as `image`, SVG layers as Contract's own SVG elements, buttons and links. Each CSS property keeps its name, as Contract writes CSS. Text styles become `style` blocks. Variables and simple click interactions become `state` and an `action`. |
| `app.tamber` | The file's tokens that the screen uses, as Exact's design file, read as `var(--name)` as on the canvas. A colour with a dark mode becomes `light-dark()`. |
| `app.ts` | An empty data module, ready for the sources the screen will need. |
| `app.json` | The manifest: the app's name and a placeholder id, `com.example.<name>`. |
| `app.test.contract` | A test that the screen and its first text show, and, when a button counts something a text shows, one tap. |
| `assets/` | The pictures of image layers. |

The artboard's fixed width becomes its most width and its height its least height, so the screen also
fits a smaller window, and scrolls.

What Contract cannot say is left out where it would be, with a `// Left out of "…"` comment at that
spot and an entry at the end of the Code tab's text (and in `export_file`'s result, as data): motion,
pseudo-elements, hover and other state styles, media and container conditions, image fills and crops,
blend modes and filters Contract lacks, hidden layers, shaders, videos and embeds, and navigation
between artboards, variants and hover or submit interactions. A value Contract writes differently is
written approximately and listed too, such as `inline-flex` as `flex`, `position: fixed` as `absolute`,
or a `clamp()` font size as its smallest size. Components come out written in full, not as Contract
components. Fonts are named but not bundled: declare each with a Contract `font` block and its files
to ship it.

To run the result, with an Exact checkout and its tools (Bun and Rust, as its README says):

```sh
bun ~/exact/scripts/exact.mjs new ~/apps/ticket-screen
# copy app.contract, app.ts, app.test.contract, app.tamber and assets/ over the new app's own
cd ~/apps/ticket-screen
bun exact.mjs contract build app.contract --json   # what the compiler says
bun exact.mjs web                                  # the dev loop in a browser
bun exact.mjs test web                             # app.test.contract
```

Keep the `app.json` that `exact new` wrote, with its schema path, and take the name from Bogen's if
you like. [Tomacco](tomacco.md#exact-apps) does not run Exact apps yet; it is planned to build, run
and test them too.

## Hand off to your repo

Your agent reads a design with `code_get` (`html`, `react-inline` or `react-tailwind`, with motion as
CSS or Framer Motion, or the experimental `exact`), one section at a time, and treats it as an exact specification: it reuses your repo's own components and tokens
instead of copying inline styles. The `implement_selection` prompt walks it through this.

No MCP tool writes into a repository. Your agent writes with its own file tools, or you open a pull
request from Bogen.

## A pull request from a design change

With the repository linked in Assets (see
[Code components](components.md#code-components-from-your-repo)), Bogen can turn a design change into
a pull request:

1. Start it from what changed:
   - **An accepted proposal:** right-click the layer and choose **Open a pull request**. The change is
     the proposal against the layer as it was before.
   - **Selected layers:** the same menu, with **Selected layers** chosen. The change is those layers as
     they are now, against the last version.
   - **Two versions:** compare two versions in the History panel, then the pull request button in the
     comparison.
2. Choose `claude` or `codex`, a title, the branch it goes into, and the folder for the pictures
   (`docs/design` unless you say otherwise), then **Start**.
3. Bogen makes a Git worktree of the repository on a new branch, such as `bogen/red-hero-title`, in its
   own data folder. Your checkout and its changes stay as they are. Your CLI runs there with only six
   file tools rooted in that folder: no shell, no built-in tools, and nothing outside it, the same
   limits as [live site mode](agents.md#live-site-mode). It gets the list of what changed and the
   design as code from `code_get`.
4. When the run ends, Bogen adds before and after pictures under
   `docs/design/<branch>/before.png` and `after.png`, and commits as you if Git knows who you are.
5. The dialog shows what would be pushed: the branch, the commit, the remote, every file with its
   lines, the diff, both pictures and the description. You can change the title and the description.
   The description has your agent's summary, the pictures, and a link back to the Bogen version, which
   opens that version on the stage.
6. **Push and open** pushes that one branch, never with force, and runs `gh pr create` with your own
   `gh`. Bogen checks that what it pushes is exactly what you were shown: after a change to the title,
   the description or the branch, it asks again.

Until then nothing leaves your machine. **Discard** removes the working folder and the branch. A
draft waits under **Pull requests** in Assets when you close the dialog, and a run that ends without
changing a file fails and says so.

Limits:

- Pull requests are made only on the machine with the repository, not from a phone or another device.
- `gh` has to be installed and signed in. Without it Bogen still prepares the branch, and the dialog
  says that it cannot open the pull request. A remote that is not on GitHub gets the branch, but the
  picture links in the description are paths, not addresses.
- Git hooks do not run, also not on commit and push, and commits are not signed.
- Tried with a fixture repository, a bare repository as its remote and stand-ins for `claude`,
  `codex` and `gh`. Not yet with a real GitHub repository.

## Tokens

- `tokens_export` returns the file's tokens as CSS (a `:root` block, one block per theme mode, the text
  styles as classes), as CSS plus a Tailwind 4 `@theme inline` block, or as a Tailwind 3
  `theme.extend` object.
- `design_system_css` returns tokens and text styles as one style sheet.
- `tokens_from_css` goes the other way: it reads custom properties from your repo's CSS or Tailwind
  theme into the file, and with `mode` into a theme mode.

### Tokens and the repository

With the repository linked, the Tokens panel has a button with its name. It opens the repository's
tokens next to the file's, by name: **Changed**, **Only in the file**, **Only in the repository** and
**Same**, with the values of each theme mode. Bogen reads:

- CSS variables in `:root` and `html`, and theme mode blocks such as `.dark`, `.theme-dark` or
  `[data-theme="dark"]`;
- Tailwind 4 `@theme` blocks, where `--color-brand` becomes the colour token `brand`;
- a Tailwind 3 `tailwind.config.js` or `.ts`, read as text and never run;
- DTCG files (the W3C Design Tokens format): `tokens.json`, `design-tokens.json`, `*.tokens.json` and
  JSON in a `tokens` folder, with groups, inherited `$type`, aliases such as `{color.brand}`, and
  dimension and colour objects.

Pick the rows you want, then:

- **Pull into the file** takes the repository's values, with their modes, as one undo step.
- **Push as a pull request** writes the file's values into the repository's token file, in place:
  a CSS variable keeps its line, a new one goes at the end of its block, and a DTCG token keeps its
  group and description. It opens the same pull request dialog, and nothing is pushed before you
  confirm it there.

DTCG works both ways: what Bogen writes keeps each token's kind in `$extensions`, so that reading it
back gives the same tokens. A Tailwind 3 config is code, so Bogen reads it but pushes into CSS or a
`tokens.json` instead. Values with no kind Bogen knows, such as shadows, are listed and left out.

Agents use `tokens_repo_diff` and `tokens_repo_pull`. Pushing stays with you.

The Tailwind 4 output has been built with Tailwind 4: `bg-accent`, `rounded-md`, `text-sm`, `p-4` and
the like read the file's own variables. Breakpoints and containers are written as their values,
because media and container queries cannot read a variable, and a size token does not bring
Tailwind's own line height for that size. The Tailwind 3 object has not been built.

## Live site mode

To change the source of a running site rather than a design, see
[Live site mode](agents.md#live-site-mode).
