# Bogen portrait background

An Omarchy shell plugin, `bogen.portrait-background`: Omarchy's own background, with the current
theme's designed portrait composition on each portrait screen. Every other screen keeps the theme
background.

This folder is not installed as it is. `bogen omarchy portrait install --apply` builds the plugin in
`~/.config/omarchy/plugins/bogen.portrait-background/` from:

| File | What |
|---|---|
| `Background.qml` | derived at install time from this machine's `$OMARCHY_PATH/shell/plugins/background/Background.qml` by a patch at marked lines (`// bogen.portrait-background`); refused when the stock file no longer fits the patch |
| `PortraitMapping.qml` | per-frame maps, the fixed argv scripts that read and check the theme, status over IPC |
| `PortraitRuntime.js` | the pure part: manifest checks, header measuring, which screen shows what; Bogen's tests load this same file |
| `manifest.json` | `omarchy.clonedFrom: omarchy.background`, so `omarchy plugin enable` swaps it in for the stock plugin and `disable` puts the stock plugin back |

## What it reads

`~/.local/state/omarchy/current/theme/displays/portrait-runtime.json`, written by Bogen's export. It
is data only and untrusted: at most 64 KB and 6 compositions; only `artwork` and `composed` are
shown; each file must be a PNG, JPEG or WebP directly in `displays/`, no link anywhere on its path, at
most 48 MB, with the sha256, byte count and pixel size the manifest names. The checked file is
copied to `~/.cache/bogen/portrait-background/<sha256>.<ext>` and the copy is what is drawn, so a file
swapped after the check is never shown. Nothing from a theme is run, and no theme value reaches a
shell: every path goes to the fixed scripts as an argument.

## What each screen shows

- A screen whose logical shape (mode, turned and mirrored as mounted, divided by the scale) matches a
  verified composition within 1.5 %: that composition, decoded at the screen's size.
- Any other screen, a landscape one, a video background (OWE owns those), a picture you chose from
  outside the theme's `backgrounds/`, a composition that fails to load: the global background, as
  stock Omarchy draws it.
- During a theme switch each frame keeps the map it started with; the reveal waits at most 1.5 s for
  the new theme's map, and a portrait screen falls back to the global background meanwhile.

`omarchy-shell background portraitStatus` prints the state as JSON, and `portraitRefresh` reads the
theme again.
