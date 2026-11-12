# Omarchy

On [Omarchy](https://omarchy.org), Bogen takes its colours and font from your theme, the bar shows
when an agent is drawing, and Bogen gets a launcher, keys and a user service.

## Install

```sh
bogen omarchy install --dry-run   # prints every step, changes nothing
bogen omarchy install
```

From a checkout, `integrations/omarchy/install.sh` is the same script; build first with
`npm install && npm run build`. It needs `omarchy`, `jq` and `curl`, asks nothing, and is safe to run
again. Anything it replaces that it did not write goes to `~/.local/state/bogen/backups/` first.

| Option | What it does |
| --- | --- |
| `--dry-run` | Print every step and change nothing. |
| `--no-service` | Leave out the user service. |
| `--no-plugin` | Leave out the bar widget. |
| `--no-hypr` | Leave out the window rules and keys. |
| `--tailnet` | Make the service also listen on this machine's Tailscale address, for [device sync](devices.md), and offer to open the firewall for it. |

What it adds:

| What | Where |
| --- | --- |
| `bogen` wrapper, only if you have no `bogen` yet | `~/.local/bin/bogen` |
| `bogen-launch`, `bogen-place-screenshot` | `~/.local/bin/` |
| User service running `bogen serve` | `~/.config/systemd/user/bogen.service` |
| Launcher and icon, through `omarchy webapp install` | `~/.local/share/applications/Bogen.desktop` |
| `.bogen` file type | `~/.local/share/mime/packages/bogen.xml` |
| Theme and font hooks | `~/.config/omarchy/hooks/{theme-set,font-set}.d/bogen-reload` |
| Bar widget | `~/.config/omarchy/plugins/dev.bogen.bogen/` |
| Window rules and keys | `~/.config/hypr/bogen.lua`, loaded from a marked block at the end of `hyprland.lua` |

If Hyprland reports a new config error after the change, the installer takes its block back out.
The [install script](../../README.md#quickstart) runs `bogen omarchy install` for you. With a package you built
yourself, run it as your own user.

## Keys

Keys are checked against `hyprctl binds` and never replace a binding. **Open Bogen** gets the first
free one of Super+Shift+D, Super+Shift+Alt+D, Super+Ctrl+Shift+D and Super+Shift+Alt+B, and **place
the newest screenshot** gets the next. The installer prints which. On a stock Omarchy, Super+Shift+D
is Docker, so Bogen moves along.

## Theme and font

The editor's chrome takes its colours from your theme's `colors.toml` and its font from your system
font, and follows `omarchy theme set` and font changes live. The canvas itself is never themed: your
designs keep their own colours. A monospaced system font is ignored on purpose.

The Tokens panel has a button that brings the active palette into a file as tokens, such as
`omarchy-accent` and `omarchy-font`.

## Design a theme

Bogen can design a whole Omarchy theme: its palette, its backgrounds and its previews, on one canvas.
When it is right, export it as a theme folder or install it on this computer.

### Start

On the home screen, choose **Themes → Omarchy Desktop**. Your saved theme projects and the 20 bundled
starting points share the ordinary file grid and list view, with the same search and sorting. A bundled
starting point is marked **Template**; opening one starts its normal theme project. Once that project is
visible, its real file replaces the template card, including after a rename. Reopening keeps the same
project and its branches. Only a newly created project is moved into the folder you chose; an existing
project stays where it is. Templates are not empty design files and are excluded from file bulk actions.
The scope line counts actual files and templates separately.

The existing **Themes** controls still list your projects under **Your themes**, with **Draft**,
**Installed** or **In use** from what is installed and applied here, plus the installed themes to start
from. They follow the folder, search and Desktop or Mobile filter; in a theme scope they follow the
file grid rather than putting a separate bundled collection before it.

- **Start from an installed theme** lists the themes installed here, the one in use first. A theme that
  already has a project opens that project. Otherwise its `colors.toml` and its backgrounds are copied
  into a new project, called after it with Custom on the end, such as Tokyo Night Custom; a theme Bogen
  made keeps its name and its designed portrait compositions (those `displays/portrait-runtime.json`
  lists and whose bytes still match), never a placeholder. The theme you start from is only read, never
  changed.
- **Bundled templates** appear alongside the other desktop themes, rather than in a separate section. Each has its own
  palette and two wallpapers composed for it, a 16:9 landscape and a 9:16 portrait. Some are vector
  artwork (op art, linocut, modernist colour, architecture at night, cartography, risograph, leaded glass,
  farmland from the air, a transit diagram, basalt, woven twill, terrazzo) and some are paintings,
  photographs and collage. Opening its card makes a project through the ordinary theme path:
  the palette becomes its tokens, the landscape becomes Background 1 and the portrait becomes its 9:16
  composition, which counts as designed. Vector art arrives as editable layers. Once a project exists,
  the project opens from its ordinary file card. The bundled catalog is not a set of files: listing it makes
  nothing. Starting a project never installs or applies it; Export, Install and Apply remain separate actions. It is
  offered only on an Omarchy desktop, not on an Omarchy Mobile phone. A project
  from the collection stays a **Draft** until you install it yourself.

  The collection contains ten dark and ten light themes. Each has a landscape and a portrait wallpaper, generated
  as independent AI images (see [ASSET_PROVENANCE.md](../../ASSET_PROVENANCE.md)) and resampled to
  3840 × 2160 and 2160 × 3840; they are not native 4K generations. The artwork is dedicated under CC0 1.0, so a
  theme made from it can be published under any terms. All artwork and thumbnails total about
  15.6 MB. Home uses only small thumbnails and creates a file only when its template card is opened. Agents can edit the
  resulting project normally; choosing a collection preset directly through `omarchy_theme_create` is
  not yet exposed.
- **New theme** and **New mobile theme** start a separate project with a palette of its own.

One theme is one project. Starting from the same theme again, with or without its name, opens the same
project rather than another copy. When several projects could be meant, Bogen says so and lists them:
open the one to continue, or choose **New separate theme**. An agent works the same way with
`omarchy_theme_create`: it reopens the project, or answers with the candidates and makes nothing, and
makes a separate theme only with `new_project: true` when you asked for one. `omarchy_theme_projects`
lists your projects and their branches. An alternative or a redo is a branch inside the project, never
another file ([Branches](history.md#branches)).

### Copies of one theme

Themes made before this could end up as several files, such as four "Tokyo Night Custom". **Your
themes** shows such files as one row, **Not consolidated**, which unfolds into the copies, each with
**Open**. None of them counts as the theme until you choose:

1. **Bring these together…**, then pick the copy to keep as the project. Nothing is picked for you, and
   the newest is not assumed to be the one.
2. **Review** shows what happens to each other copy: it becomes a branch of the project with its whole
   design, its comments and its pictures, or is skipped when it holds nothing new. A copy that someone
   has open or changed in the last ten minutes, a copy for another device type, or a copy with branches
   of its own is named as a problem, and nothing can be confirmed until it is resolved.
3. Confirm. A commit of the project is taken first, and each copy's content is also kept in the
   project's History.

The other files are not deleted, renamed or moved. Each keeps its design, its comments and its History,
and now points to the project: it is listed under it, folded behind "*N* copies kept", with
**Open**, on Home and in the library, and an agent's `file_list` names it under the project
(`include_copies` lists it on its own). Starting from that theme again opens the project. An agent cannot
keep writing into such a copy; if you edit one, it shows **Changed since**, and bringing the copies
together again takes in what changed, without writing over replies or resolutions made in the project.
Archive or delete the copies yourself once you are sure.

### The file

- **Tokens.** The Tokens tab holds one token per key of `colors.toml`: `--omarchy-accent`,
  `--omarchy-background`, `--omarchy-dark-background`, `--omarchy-foreground`, `--omarchy-red` and
  the other hues, each with its `bright_` one, and the two window borders,
  `--omarchy-hyprland-active-border` and `--omarchy-hyprland-inactive-border`. A border takes a
  colour, another token or a `linear-gradient`, which becomes a Hyprland gradient such as
  `rgba(26a269ee) rgba(2ec27eee) 45deg`.
- **Previews.** Every colour on them is one of those tokens, so a token change shows everywhere at
  once. **Preview · desktop** has the bar, two terminals with sample output, an editor, window
  borders and gaps, and a notification. **Preview · launcher** has the Omarchy menu,
  **Preview · lock screen** the password field over the blurred background, and
  **Preview · boot unlock** the screen you type your disk password into. They follow the stock
  shell's sizes: a 26 px bar at the 12 px base font, gaps of 5 and 10, 2 px borders. Where Omarchy's
  fonts are installed, the bar and the menu use the same glyphs the real ones do.
- **Backgrounds.** One artboard per landscape screen, named **Background 1 · 3840 × 2160** and so
  on, at the sizes `hyprctl monitors` reports. Without Hyprland they are 3840 × 2160 and 2560 × 1600.
  A portrait screen gets its own composition instead (see [Portrait monitors](#portrait-monitors)). A new theme's is a plain field of its background colours, with no text on it, since Omarchy shows it on your desktop; the theme dialog and agents list it as a problem until you design it from the theme's identity. Design on Background 1: the
  others are instances of its Wallpaper and follow it. Any artboard whose name starts with
  Background is a background, so add more the same way. A theme you started from brings its own
  images, one artboard each, at each image's own shape. Background 1, the Wallpaper the landscape
  previews show, is the theme's first landscape image.
- **Unlock logo** is `unlock.png`, the logo of the boot unlock screen, shown at its own size.
- **Shell surfaces.** A theme made now also designs the shell itself, one token per surface that
  `shell.toml` styles: `--omarchy-shell-lock-background`, `--omarchy-shell-launcher-selected-text`,
  `--omarchy-shell-notifications-border` and the rest for the bar, popups, tooltips, notifications,
  launcher, menus, the password dialog, the lock screen and the image picker, plus
  `--omarchy-shell-font-base-size`. They start at Omarchy's own defaults, written as references to the
  palette (`color-mix(in srgb, var(--omarchy-background) 80%, transparent)` for the lock field), so a
  palette change still flows through. A surface's alpha is its token's alpha. Previews draw with the
  same tokens the export writes.
- **Videos (Omarchy 4.5).** A theme you start from brings its intro videos
  (`backgrounds/intros/<name>.mp4`, played once when the theme is switched to, then handed back to the
  still of the same name) and its looping wallpapers (videos directly in `backgrounds/`). Bogen keeps
  each intro paired with its Background artboard, shows its length and size, and says when it runs
  outside Omarchy's five to seven seconds, has a sound track, or does not match its still. Bogen never
  makes a video, and the editor never plays one on its own.

A file whose tokens merely include the Omarchy palette is not a theme until you say what it is for:
the banner offers **Make it a desktop theme** or **Make it a mobile theme**. Nothing is exported or
installed from three tokens alone.

### Portrait monitors

A monitor turned on its side runs the same Omarchy desktop, with the same bar, tiled windows,
launcher, lock and boot screens. Bogen treats it as a desktop display, never as a phone. Whether a
theme is for a desktop or a phone is its target, which you choose. Every new desktop theme has two
sets of previews:

- **Preview · desktop**, **launcher**, **lock screen** and **boot unlock** at 1920 × 1080, as before.
  `preview.png` is made from these.
- The same four for each portrait monitor of this computer, such as
  **Preview · desktop · portrait 2160 × 3840** for a 4K monitor at scale 1 turned 270°. Without one,
  for example on a laptop, you get **portrait 1080 × 1920**. Sizes are what the desktop lays
  out in: the mode, turned as mounted (Hyprland transforms 1, 3, 5 and 7, mirrored or not), divided
  by the scale. The previews are laid out for that size, not stretched. The bar and the shell keep
  their pixel sizes. The windows tile the way dwindle splits a tall screen, with the editor across
  the width and two terminals under it.

Each shape that is not landscape has its own **wallpaper composition** on an artboard such as
**Portrait background · 9:16 · 2160 × 3840**. It is the component **Wallpaper · portrait 9:16**,
which the portrait previews show. Until someone designs it, it holds a quiet placeholder: the
theme's background colour and a note, "Portrait composition not designed yet". Design it from the
theme's own identity (its pictures, logo, type and accent), composed for its shape, rather than a
crop of the landscape picture or a generic pattern. Keep the subject and any text clear of the bar
and the lock field.

The theme dialog's **Displays** section lists the displays and the state of each composition:

| State | Means |
|---|---|
| Composed for this shape | it has layers someone made for it, a picture shown whole inside the layout included; exported as a render of the composition |
| Own artwork | one picture of exactly its ratio fills it, exported byte for byte |
| Needs its own design | it is still Bogen's placeholder, or the palette arcs files made before November 2026 have, however recoloured |
| Picture of another shape, cropped | a picture of another ratio fills the whole composition, such as the landscape wallpaper laid over it; it is not exported |
| Picture of unknown size | a picture fills it whose size Bogen cannot read (it reads PNG, JPEG, WebP and GIF) |

Only the first two count as done. The others are listed as problems in the dialog, to agents and in
the export, are never exported as the shape's background, and are never shown on a screen. A
landscape picture placed whole in a band of a portrait field (`object-fit: contain`, or a box of its
own ratio) is a composition, not a crop: the export renders the portrait, never the picture's own
bytes.

- **Add 9:16 layout** asks an agent to compose the 9:16 composition for you. It shows while the theme
  has no 9:16 shape, or while that composition is not done. It is a real run, the same as one from the
  prompt: it uses the agent and model chosen for the prompt, and the dialog names them before you click.
  First a checkpoint goes into the file's History. If the theme has no 9:16 shape, it is added. Then
  one run works on the existing 9:16 board in the same file, with no copy, page or new file. Its brief
  is to compose from the theme's palette and artwork, never to crop a landscape picture. The run shows
  in the prompt and the queue as "Add 9:16 layout". Stop it there or in the dialog, and undo it from
  the History. When it ends, the dialog shows the composition's real state, which may still need
  work. The run never installs or applies the theme. It asks only an agent on this computer: if the
  agent chosen in the prompt is not here, or runs on another device, choose one in the prompt first.
  Clicking again while it runs does nothing, and a file with a run going is left as it is.
- **Use portrait artwork…** takes a PNG, JPEG, WebP or GIF of the composition's ratio. A picture of
  another shape is refused and nothing changes. The composition it covers is hidden, not deleted.
- **Add previews** adds the four previews of another display to a theme that exists: one of this
  computer's monitors, a preset (portrait 1080 × 1920, 1200 × 1920, 1440 × 2560, 2160 × 3840,
  landscape 2560 × 1440, 3840 × 2160) or a custom size. They go below the design. Nothing on the
  canvas is changed, moved or recoloured, and no page is made. A size the theme has already is
  skipped. A new shape gets a composition marked as needing design. Undo it from the file's History.
  Themes are never changed in bulk. A theme made before displays has none until you add them. Mobile
  themes have no desktop displays.
- Bogen draws previews for displays from 600 px on the short side up to 7680 px, 8K in pixels and
  4:1. That is a limit of the previews, not a statement about your monitor.

Agents do the same with `omarchy_theme_displays` (list, add, assign_artwork).

**What Omarchy does with it.** Stock Omarchy shows one background on every screen and crops it to
fill each one, so a portrait monitor shows the middle of the current background. The export ships
each designed composition in `displays/`, outside `backgrounds/`, so Omarchy does not cycle through
them, and `displays/portrait-runtime.json` says which are ready. To have a portrait monitor show
them, install the portrait background plugin (next section). Plymouth
draws `unlock.png` at its own size on every screen. If the logo is wider than a display, the theme
says so, and the boot preview shows it cut at the edges as it would be.

### The portrait background plugin

`bogen.portrait-background` is a clone of Omarchy's own background plugin, made the way
`omarchy plugin clone` makes one, so the theme switch, intros, OWE's video backgrounds, clicks and
`omarchy-shell background …` keep talking to it. Its `Background.qml` is derived from the one this
machine's Omarchy ships, by a small patch at marked lines; where that file changed so the patch no
longer fits, nothing is derived and the stock background stays. On each background change it reads
the current theme's `displays/portrait-runtime.json`, checks each picture (inside the theme's
`displays/`, no links, at most 48 MB, its sha256, and its size read from its own header), copies it to
`~/.cache/bogen/portrait-background`, and draws it on every screen of that shape. Every other screen,
and any screen whose composition is missing, not designed or fails to load, keeps the theme
background, so no screen is ever left blank. A picture you chose yourself, a video, or a theme
without the file keeps Omarchy's behaviour.

```bash
bogen omarchy portrait status            # the plugin, the current theme's map, each monitor
bogen omarchy portrait install           # plan; add --apply to write ~/.config/omarchy/plugins/bogen.portrait-background
bogen omarchy portrait enable --apply    # omarchy plugin enable; omarchy.background comes back on disable
bogen omarchy portrait disable --apply
bogen omarchy portrait rollback --apply  # the previous version of its files
bogen omarchy portrait remove --apply    # only when disabled
bogen omarchy portrait audit             # every installed theme: what a portrait screen shows, what would change it
bogen omarchy portrait upgrade <theme>   # adds displays/portrait-runtime.json from verified artwork; plan unless --apply
```

Every action only plans until `--apply`. Install never writes over a folder of that name that is
not Bogen's, refuses to replace files you edited unless `--force`, and backs up what it replaces in
`~/.local/state/bogen/portrait-background/backups`. Enable is refused beside another clone of the
background plugin, and when `omarchy.background` is disabled because something else draws your
wallpaper. After an `omarchy update`, `status` says when the plugin was derived from an older stock
file; `install --apply` derives it again. `status --live` asks the running shell
(`omarchy-shell background portraitStatus`), which reports the plugin version it is running. Omarchy reloads a
plugin when its files change, but can keep QML it has already imported: when the running version differs from the
installed one, `status --live` says so, and `omarchy restart shell` loads the new one. Only then is a restart needed. A phone cannot run the plugin; Bogen there
still designs, exports and lists portrait compositions.

### Export

The banner over the canvas, the Tokens tab and the command palette open the theme's dialog. There
you set the name, which also gives the folder name (Dusk Night is `dusk-night`), the mode, and the
icon theme, which by default follows the accent the way the stock themes pick it.

- **Download .tar.gz** gives you the theme as an archive.
- **Choose a folder…** writes it into a folder you pick, where the browser allows it.
- **Export** writes it to the folder in the field, by default `~/omarchy-<name>-theme`. With **Git
  repository** checked, the folder becomes a repository with one commit, of its own even inside
  another repository. Nothing is pushed. An export never writes into a folder that has files in it.

The folder holds what a stock theme ships:

| File | From |
|---|---|
| `colors.toml` | the tokens, in the order and groups of the stock files |
| `backgrounds/` | the Background artboards, rendered at full size as PNG; an image from the theme you started from goes out as it was |
| `preview.png` | Preview · desktop at 1800 × 1012, for the theme picker; always the 1920 × 1080 one |
| `displays/` | each other display's desktop preview, up to 1800 on its long side, each designed portrait composition (`background-portrait-9x16.png`, a render, or the artwork as it was), and `portrait-runtime.json`, which lists the designed ones with their size and sha256 and names the rest as not designed; stock Omarchy does not read it |
| `unlock.png` | the Unlock logo, with transparency |
| `preview-unlock.png` | Preview · boot unlock at 1920 × 1080, for the boot screen switcher |
| `icons.theme` | the icon theme |
| `shell.toml` | the shell surface tokens, in the dialect the shell reads; left out for a file from before them |
| `backgrounds/intros/` | the intro videos, each named after its still |
| `bogen-theme.json` | what the theme is for (desktop or mobile), a revision hash, the files with their checksums |
| `README.md` | the name, the preview and how to install it |

The other files an app reads, such as `alacritty.toml`, `btop.theme`, `neovim.lua` and
`hyprland.lua`, are not in it. Omarchy writes each of them from `colors.toml` when the theme is
applied, from the templates in `$OMARCHY_PATH/default/themed`, and a theme installed from a
repository may not ship most of them anyway. The dialog names them. A machine's own
`~/.config/omarchy/shell.toml` (for instance the text size set with `omarchy display text size`)
still wins over the theme's.

### Mobile themes

A mobile theme is made for a phone running Omarchy Mobile, not for this computer. Pick
**New mobile theme** on the home screen, or ask an agent for `omarchy_theme_create` with
`target: "mobile"`. The profile so far is the Pixel 9 Pro XL (komodo): 1344 × 2992 at Hyprland scale
3.2, so 420 × 935 logical pixels, a 420 × 276 keyboard, a 47.8 px corner arc and a 32 px strip for the
home pill.

The file draws the phone's own shell from the theme's tokens: the lock screen with its PIN pad, home
with widget tiles and the search dock, the app drawer with the keyboard open, quick settings and
notifications, the password dialog over recent apps, and the native Pixel services app.
**Guide · safe areas** marks the corners, the back-gesture edges, the pill strip and the keyboard; it is
not exported. Backgrounds are drawn at the panel's own 1344 × 2992.

Exporting a mobile theme gives a package, `<name>-mobile.tar.gz`, not a bare theme folder:

| Part | What it is |
|---|---|
| `theme/<name>/` | the theme: `colors.toml`, `shell.toml`, backgrounds, `preview.png`, `bogen-theme.json` |
| `install.sh` | the installer, run on the phone as your user |
| `bogen-theme.json` | the profile, the adapter version, every file with its checksum, and what the theme covers |
| `README.md` | what it changes, what Omarchy writes from it, and what no theme can change |
| `checksums.sha256` | checked before anything is written |

On the phone:

```sh
tar -xzf dusk-mobile.tar.gz && cd dusk-mobile
./install.sh --dry-run     # what it would change; writes nothing
./install.sh               # installs into ~/.config/omarchy/themes/dusk
./install.sh --apply       # or: omarchy-theme-set dusk
./install.sh --rollback    # back to how it was, and the theme in use before
```

The installer refuses a computer (no `/usr/share/omamobile`), another phone (pass `--any-device` to
install anyway) and a package whose checksums do not match. It snapshots the theme folder before
writing. Installing again updates the files you have not edited on the phone and keeps the ones you
have, unless you pass `--replace-edited`. It writes only the theme folder and its own state in
`~/.local/state/bogen-themes/<name>`: no plugins, keyboard layouts, system files or settings.
Applying runs `omarchy-theme-set`, the same command the phone's dark-mode tile uses, and waits for the
apps to retint (`OMARCHY_THEME_WAIT=1`).

What a theme can and cannot reach on the phone, as the package README lists it: the status bar, lock
screen, drawer and search, quick settings, notifications, recent apps, password dialogs and the
picker take the theme through `shell.toml`; the keyboard's colours, the terminal and the Pixel
services app are written from `colors.toml` when it is applied. Key shapes, the interface font,
window corners and gaps, and third-party apps are not something a theme can change, and the package
does not pretend otherwise. Intro videos are carried but not verified on the phone's shell.

Bogen on a computer never installs or applies a mobile theme, and Bogen on a phone never installs a
desktop one: both are refused before anything is written.

### Install and apply

**Install** copies the theme to `~/.config/omarchy/themes/<name>`, where the theme picker and
`omarchy theme set` find it. Nothing is written anywhere else. When a theme of that name is there
already, Bogen asks before it replaces it, and says so when it came from a repository. If the name is
a stock theme's, your copy is the one Omarchy then uses under that name; the stock theme's own files are not changed. An agent can install a theme, but never replace one.

**Apply** runs `omarchy theme set <name>`, and only when you click it: an agent cannot apply a theme.
Bogen first notes the theme in use, and **Undo apply** goes back to it. Applying twice in a row still
goes back to the theme from before the first.

### Share a theme as a repository

1. Export with **Git repository** checked. The folder is named `omarchy-<name>-theme`, which is the
   name `omarchy theme install` reads the theme's name from.
2. Make an empty repository of that name on GitHub or anywhere else, and push:

   ```sh
   cd ~/omarchy-dusk-theme
   git remote add origin git@github.com:you/omarchy-dusk-theme.git
   git push -u origin HEAD
   ```

3. Anyone installs and applies it with:

   ```sh
   omarchy theme install https://github.com/you/omarchy-dusk-theme
   ```

   and gets your later changes with `omarchy theme update`.

To change it later, open the file in Bogen, export into a new folder, copy the files over your
repository's and commit. The README in the folder already shows the preview and the install line.

Omarchy treats a theme cloned from a repository differently from your own: it leaves out anything
that runs code, which is every `*.lua` file, `alacritty.toml`, `foot.ini`, `ghostty.conf`,
`kitty.conf` and `vscode.json`, and writes those from `colors.toml` instead. A theme from Bogen ships
none of them, so it looks the same cloned as installed.

## The bar widget

The icon is muted while the server is stopped. While an agent works, it turns the accent colour with a
slow pulse; the pulse stays off when Hyprland animations are off.

- Left click opens the panel, middle click makes a new file, right click opens Bogen.
- In the panel: N new file, O open, S start or stop the server, R refresh, arrows and Enter to move.
- The panel lists open files, agent activity and the last runs over all files, and, with device
  sync, the other device and its state. It warns when that device runs another version.

The widget talks to the server over HTTP and starts no process: every 5 seconds while the server
runs, every 15 while it does not, and faster only while the panel is open or an agent works.

## Notifications

You get a notification when an agent finishes, when a comment arrives, and when a run started from a
comment ends. Clicking one opens the file. Each kind can be turned off in the widget's settings.

## Screenshots to the canvas

`bogen-place-screenshot` puts the newest screenshot from `omarchy capture` into the Bogen file you are
working on. With `--pick` you choose one in Omarchy's image picker, from your screenshot folder or a
folder you name. The installer binds a key to it (see [Keys](#keys)).

## Uninstall

```sh
bogen omarchy uninstall --dry-run
bogen omarchy uninstall
```

Your designs in `~/.local/share/bogen` stay where they are.

## Limits

All of this has run on a real Omarchy desktop (Hyprland 0.56, two 4K screens) on 2 November 2026:

- The installer, run for real: 23 s, no new Hyprland config errors. The Bogen window's class is
  `chrome-127.0.0.1__-Default`, which the window rules match: it tiles, at full opacity.
- The bar widget in the real bar: the panel opens, N makes a file and opens it, O brings the open
  Bogen window forward instead of opening a second one, and S stops and starts the server. After S,
  the server answered in 0.3 s and the panel showed it running within 3 s. **Pair a phone** showed a
  code and a QR code that reads as the phone link. The icon pulsed in the accent colour, about once
  every two seconds, while an agent worked, and went back to normal after.
- Notifications from real `codex` and `claude` runs started by comments: one when the comment arrived,
  one for the agent's reply, one when the run ended and one when the agent finished.
- Theme following with a real `omarchy theme set`, from one stock theme to another and back: the
  editor's chrome had the new colours by the time the command returned, 0.6 to 0.8 s. This was
  measured in an editor page in Chromium, not in the app window.
- `bogen-place-screenshot` with an image: placed at its real width in the open file, in under 0.1 s.

Applying a theme made with Bogen was checked again on Omarchy 4.5.0 on 10 November 2026: `omarchy theme set` on an
installed collection theme and back to the earlier theme both succeeded, with the app files staged and the
background linked. Installing from a published git repository and the 4.5 theme intros were not part of that check.

Designing a theme, on the same desktop with Omarchy 4.0:

- Themes made from New theme, Tokyo Night, Catppuccin and the theme in use, with their previews
  compared to the real bar (`grim` of the top of a screen) and to the stock `preview-unlock.png`
  files: the bar's glyphs, slots and spacing, and the boot screen's logo, entry and lock, match.
- A real export of a new theme into a temp folder: `colors.toml` with the 25 keys of a stock theme in
  their order, two backgrounds at 3840 × 2160 and 2160 × 3840, `preview.png` at 1800 × 1012, and a
  repository with one commit, in 1.5 s.
- Install, the overwrite question, Apply and Undo apply in the built editor, against a temp home and a
  stand-in for `omarchy`.

Not checked yet:

- `omarchy theme set` with a theme from Bogen on a real desktop, and so the boot unlock screen and
  the generated app files with it;
- the image picker of `bogen-place-screenshot --pick`;
- the keys themselves, and the left, middle and right clicks, which were reached through the panel
  and its keyboard instead;
- with two screens there is one widget per screen; after a start from the panel on one, the icon on
  the other can take up to 15 s to follow.

The widget is not published as its own plugin repository yet, so `omarchy plugin add` cannot install
it alone.
