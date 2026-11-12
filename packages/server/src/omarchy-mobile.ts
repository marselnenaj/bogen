// Omarchy Mobile themes: the device profile a theme is made for, what it can and cannot style there, the manifest
// that says so, and the package a person copies to the phone and installs with its own script. Pure: no files, no
// processes. Building the package from a file is in omarchy-themes.ts.
//
// Sources, read only: the Komodo (Pixel 9 Pro XL) checkout of omarchy-mobile at 2caa95b with its uncommitted files
// (device/komodo, packages/omamobile-shell), and Omarchy 4.0's shell (`Commons/Color.qml`, `Commons/Style.qml`,
// `default/themed/shell.toml.tpl`). The phone runs Omarchy's own shell under Hyprland with the omamobile plugins; a
// theme reaches it through `omarchy-theme-set`, exactly as on a computer. Nothing here is an Android launcher theme.

import { createHash } from 'node:crypto';

/** Bumped when the package layout or the installer's contract changes in a way an older installer cannot read. */
export const MOBILE_ADAPTER_VERSION = 1;
/** Version of bogen-theme.json. */
export const MANIFEST_FORMAT = 1;

export interface MobileProfile {
  id: string;
  device: string;
  /** The panel in device pixels, portrait. */
  panel: { width: number; height: number };
  /** Hyprland's monitor scale on the device. */
  scale: number;
  /** What layouts see: panel / scale. */
  logical: { width: number; height: number };
  /** Rounded display corners, in logical px. */
  cornerRadius: number;
  /** The home pill's strip over an app, and the strip the launcher reserves, in logical px. */
  pillStrip: number;
  launcherStrip: number;
  /** Width of the edge strips the back gesture listens on. */
  backEdge: number;
  /** squeekboard's panel and its bottom strip, logical px. */
  keyboard: { width: number; height: number; strip: number };
  /** Smallest touch target the device's own UI uses. */
  touchMin: number;
  /** What the shell is, for the manifest's compatibility line. */
  shell: string;
  /** How the installer recognises the device: the panel mode Hyprland reports, or the device tree's model. */
  detect: { mode: string; model: RegExp };
}

/**
 * Komodo, the Pixel 9 Pro XL, as its checkout documents it: 1344 x 2992 at Hyprland scale 3.2, so 420 x 935 logical
 * (2992 / 3 is not whole, so not 448 x 997). Keyboard 420 x 276 after the 1.407 squeekboard scale, corner arc 47.8.
 */
export const KOMODO: MobileProfile = {
  id: 'komodo',
  device: 'Pixel 9 Pro XL',
  panel: { width: 1344, height: 2992 },
  scale: 3.2,
  logical: { width: 420, height: 935 },
  cornerRadius: 47.8,
  pillStrip: 32,
  launcherStrip: 44,
  backEdge: 64,
  keyboard: { width: 420, height: 276, strip: 42 },
  touchMin: 44,
  shell: 'Omarchy shell 4 with omamobile-shell 0.2 plugins (Quickshell, Hyprland)',
  detect: { mode: '1344x2992', model: /komodo|Pixel 9 Pro XL/i },
};

export const MOBILE_PROFILES: Record<string, MobileProfile> = { komodo: KOMODO };

export function mobileProfile(id: string | undefined): MobileProfile {
  const p = MOBILE_PROFILES[id ?? 'komodo'];
  if (!p) throw new Error(`There is no mobile profile "${id}". Known: ${Object.keys(MOBILE_PROFILES).join(', ')}.`);
  return p;
}

// ---------------------------------------------------------------- coverage

export type CoverageStatus = 'themed' | 'generated' | 'unverified' | 'not-themable';

export interface CoverageEntry {
  surface: string;
  status: CoverageStatus;
  /** Which file of the theme carries it, or which part of the system does. */
  via: string;
  note?: string;
}

/**
 * What a theme package changes on the phone, said plainly. `themed`: this theme's own files set it. `generated`: Omarchy
 * or omamobile writes it from colors.toml when the theme is applied. `not-themable`: a theme cannot change it, and the
 * package does not pretend to.
 */
export const MOBILE_COVERAGE: readonly CoverageEntry[] = [
  { surface: 'Status bar', status: 'themed', via: 'shell.toml [bar]' },
  { surface: 'Lock screen and PIN', status: 'themed', via: 'shell.toml [lock]', note: 'pixel.lock reads Color.lock.*.' },
  { surface: 'Home screens and dock', status: 'themed', via: 'colors.toml, backgrounds/', note: 'Wallpaper and accent; widget tiles follow the palette names.' },
  { surface: 'App drawer and search', status: 'themed', via: 'shell.toml [menu] [launcher] [popups]' },
  { surface: 'Quick settings', status: 'themed', via: 'shell.toml [popups] [menu]', note: 'Colours and type scale. Corner radius and gaps come from Hyprland, not from the theme.' },
  { surface: 'Notifications', status: 'themed', via: 'shell.toml [notifications]' },
  { surface: 'Recent apps (switcher)', status: 'themed', via: 'shell.toml [menu]' },
  { surface: 'Password and permission dialogs', status: 'themed', via: 'shell.toml [polkit]' },
  { surface: 'Image and theme picker', status: 'themed', via: 'shell.toml [image-picker], preview.png' },
  { surface: 'Shell type scale', status: 'themed', via: 'shell.toml [font] base-size', note: 'A machine\'s ~/.config/omarchy/shell.toml (omarchy display text size) still wins.' },
  { surface: 'On-screen keyboard colours', status: 'generated', via: 'omamobile-keyboard-theme from colors.toml', note: 'Rewritten by the theme-set hook, with a squeekboard restart.' },
  { surface: 'Terminal (foot) and Omarchy apps', status: 'generated', via: 'Omarchy templates from colors.toml' },
  { surface: 'Pixel services app', status: 'generated', via: 'Commons.Color from colors.toml', note: 'Its Geist font is the app\'s own, not the theme\'s.' },
  { surface: 'Theme intro video', status: 'unverified', via: 'backgrounds/intros/<still>.mp4', note: 'Omarchy 4.5 plays it through OWE on a desktop. The Komodo snapshot runs an Omarchy 4.0 shell with its own wallpaper path; whether it plays there is not established, so the package carries the file and promises nothing.' },
  { surface: 'Keyboard key shapes and sizes', status: 'not-themable', via: '~/.config/squeekboard/*.css', note: 'The user\'s own override comes after the theme\'s stylesheet.' },
  { surface: 'Interface font family', status: 'not-themable', via: 'omarchy-font-set', note: 'A setting of the person, not of a theme.' },
  { surface: 'Window corner radius and gaps', status: 'not-themable', via: 'Hyprland decoration:rounding, general:gaps_out', note: 'A theme would need hyprland.lua, which runs code; Bogen does not ship it.' },
  { surface: 'Third-party apps (browser pages, Telegram, …)', status: 'not-themable', via: 'their own styles' },
];

// ---------------------------------------------------------------- manifest

export interface ManifestFile { path: string; sha256: string; bytes: number }

export interface ThemeManifest {
  format: number;
  kind: 'omarchy-theme';
  name: string;
  slug: string;
  target: 'mobile' | 'desktop';
  mode: 'dark' | 'light';
  /** A short hash of everything the theme ships, so two exports of the same design compare equal. */
  revision: string;
  profile?: { id: string; device: string; panel: string; logical: string; scale: number };
  adapter?: { id: 'omamobile'; version: number; installer: 'install.sh'; requires: string[] };
  files: ManifestFile[];
  fonts: { family: string; role: string; shipped: boolean; license?: string; note: string }[];
  coverage: readonly CoverageEntry[];
  /**
   * A desktop theme's other displays: the preview and the composition shipped under displays/ for each. Stock Omarchy
   * does not read them; `runtime` says what shows each one.
   */
  displays?: ManifestDisplay[];
  made_with: string;
}

export interface ManifestDisplay {
  size: string;
  orientation: string;
  preview?: string;
  background?: string;
  /** artwork, composed, needs-design, mismatch, unverified, missing, or landscape. */
  wallpaper: string;
  /**
   * Who shows it: a landscape display the theme's own backgrounds (stock Omarchy), a designed composition Bogen's
   * portrait background plugin, and anything not designed nobody (the screen keeps the theme background).
   */
  runtime: 'theme-backgrounds' | 'bogen.portrait-background' | 'not-shown';
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function themeManifest(input: {
  name: string; slug: string; target: 'mobile' | 'desktop'; mode: 'dark' | 'light'; profile?: MobileProfile;
  files: { path: string; bytes: Uint8Array }[]; version: string; displays?: ManifestDisplay[];
}): ThemeManifest {
  const files = input.files.filter((f) => f.path !== 'bogen-theme.json').map((f) => ({ path: f.path, sha256: sha256(f.bytes), bytes: f.bytes.length }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const revision = createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex').slice(0, 12);
  const p = input.profile;
  return {
    format: MANIFEST_FORMAT,
    kind: 'omarchy-theme',
    name: input.name,
    slug: input.slug,
    target: input.target,
    mode: input.mode,
    revision,
    ...(p ? {
      profile: { id: p.id, device: p.device, panel: `${p.panel.width}x${p.panel.height}`, logical: `${p.logical.width}x${p.logical.height}`, scale: p.scale },
      adapter: { id: 'omamobile' as const, version: MOBILE_ADAPTER_VERSION, installer: 'install.sh' as const, requires: ['omarchy-theme-set', 'sha256sum', 'tar', '/usr/share/omamobile or $OMAMOBILE_PATH'] },
    } : {}),
    files,
    fonts: [
      { family: 'The person\'s Omarchy font', role: 'Shell text', shipped: false, note: 'Set with omarchy-font-set; a theme does not change it.' },
      ...(p ? [{ family: 'Geist', role: 'Pixel services app', shipped: false, license: 'OFL-1.1', note: 'Bundled with that app, not with the theme. Previews fall back to the system sans when it is missing.' }] : []),
    ],
    coverage: p ? MOBILE_COVERAGE : [],
    ...(input.displays?.length ? { displays: input.displays } : {}),
    made_with: `Bogen ${input.version}`,
  };
}

// ---------------------------------------------------------------- the installer

/**
 * The script that ships in the package and runs on the phone, as the phone's user. POSIX sh, no network, no root.
 *
 * Contract, after Omalauncher's managed files: every file it writes is recorded with its hash. Installing again (an
 * update) replaces a file only while it is unchanged since the last install; a file the person edited is kept and
 * listed, unless --replace-edited. Before writing it snapshots the theme folder, and --rollback puts that snapshot
 * back and re-applies the theme that was in use. It writes only under ~/.config/omarchy/themes/<slug> and its own
 * state under ~/.local/state/bogen-themes/<slug>. Applying is a separate --apply, through `omarchy-theme-set`, the same
 * command the phone's own dark-mode tile runs.
 */
export function installScript(manifest: ThemeManifest, profile: MobileProfile): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# ${manifest.name}: an Omarchy Mobile theme for ${profile.device} (${profile.id}), made with ${manifest.made_with}.
# Usage: ./install.sh [--dry-run] [--apply] [--replace-edited] [--any-device]
#        ./install.sh --rollback
#        ./install.sh --check
# Writes only ~/.config/omarchy/themes/${manifest.slug} and ~/.local/state/bogen-themes/${manifest.slug}.
set -eu

SLUG=${q(manifest.slug)}
REVISION=${q(manifest.revision)}
ADAPTER=${MOBILE_ADAPTER_VERSION}
PROFILE=${q(profile.id)}
PANEL=${q(profile.detect.mode)}
MODEL_RE=${q(profile.detect.model.source)}

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$HERE/theme/$SLUG"
THEMES="\${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/themes"
DEST="$THEMES/$SLUG"
STATE="\${XDG_STATE_HOME:-$HOME/.local/state}/bogen-themes/$SLUG"
CURRENT="\${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/current/theme.name"
OMAMOBILE="\${OMAMOBILE_PATH:-/usr/share/omamobile}"

DRY=0 APPLY=0 REPLACE=0 ANY=0 ACTION=install
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --apply) APPLY=1 ;;
    --replace-edited) REPLACE=1 ;;
    --any-device) ANY=1 ;;
    --rollback) ACTION=rollback ;;
    --check) ACTION=check ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\\n' "$*"; }
fail() { code=$1; shift; printf 'install.sh: %s\\n' "$*" >&2; exit "$code"; }

# OMARCHY_THEME_WAIT=1: Omarchy 4.5 otherwise finishes app retints in the background; here it waits and reports them.
theme_set() {
  if command -v omarchy-theme-set >/dev/null 2>&1; then OMARCHY_THEME_WAIT=1 omarchy-theme-set "$1"
  elif [ -x "\${OMARCHY_PATH:-/usr/share/omarchy}/bin/omarchy-theme-set" ]; then OMARCHY_THEME_WAIT=1 "\${OMARCHY_PATH:-/usr/share/omarchy}/bin/omarchy-theme-set" "$1"
  else fail 5 "omarchy-theme-set is not here, so the theme cannot be applied."
  fi
}

check_package() {
  [ -d "$SRC" ] || fail 3 "The package has no theme/$SLUG folder."
  command -v sha256sum >/dev/null 2>&1 || fail 3 "sha256sum is missing."
  ( cd "$HERE" && sha256sum -c --quiet checksums.sha256 ) || fail 3 "The package's files do not match checksums.sha256: it is damaged or was changed."
  case "$SLUG" in *[!a-z0-9._+-]*|.*|'') fail 3 "$SLUG is not a theme name Omarchy accepts." ;; esac
  find "$SRC" -type l | grep -q . && fail 3 "The package holds a symbolic link; it is not installed."
  return 0
}

check_device() {
  [ -d "$OMAMOBILE" ] || fail 4 "This is not Omarchy Mobile ($OMAMOBILE is missing). This theme is for a phone; on a computer, use a desktop theme."
  [ "$ANY" = 1 ] && { say "Device check skipped (--any-device)."; return 0; }
  found=""
  if [ -n "\${BOGEN_THEME_DEVICE:-}" ]; then found="$BOGEN_THEME_DEVICE"
  elif [ -r /sys/firmware/devicetree/base/model ]; then found=$(tr -d '\\000' </sys/firmware/devicetree/base/model)
  fi
  if printf '%s' "$found" | grep -Eqi "$MODEL_RE"; then say "Device: $found ($PROFILE)."; return 0; fi
  if command -v hyprctl >/dev/null 2>&1 && hyprctl monitors 2>/dev/null | grep -q "$PANEL"; then say "Device: a $PANEL panel ($PROFILE)."; return 0; fi
  fail 4 "This theme is made for $PROFILE ($PANEL). This device is \${found:-unknown}. Pass --any-device to install it anyway."
}

# How a file compares: new, same, update (unchanged since Bogen wrote it), edited (changed by the person).
state_of() {
  rel=$1
  [ -f "$DEST/$rel" ] || { echo new; return; }
  want=$(sha256sum "$SRC/$rel" | cut -d' ' -f1)
  have=$(sha256sum "$DEST/$rel" | cut -d' ' -f1)
  [ "$want" = "$have" ] && { echo same; return; }
  was=$(grep "  $rel\\$" "$STATE/installed.sha256" 2>/dev/null | cut -d' ' -f1 || true)
  if [ -n "$was" ] && [ "$was" = "$have" ]; then echo update; elif [ -z "$was" ] && [ ! -f "$STATE/installed.sha256" ]; then echo replace; else echo edited; fi
}

files() { ( cd "$SRC" && find . -type f | sed 's|^\\./||' | LC_ALL=C sort ); }

install() {
  check_package
  check_device
  edited=0
  say "Theme $SLUG, revision $REVISION, adapter $ADAPTER:"
  for rel in $(files); do
    s=$(state_of "$rel")
    if [ "$s" = edited ] && [ "$REPLACE" = 0 ]; then edited=$((edited + 1)); say "  keep    $rel (changed on this phone)"; else say "  $s $rel"; fi
  done
  if [ -d "$DEST" ] && [ ! -f "$STATE/installed.sha256" ]; then say "  A theme named $SLUG is here already and Bogen did not install it: it is snapshotted and replaced."; fi
  [ "$DRY" = 1 ] && { say "Dry run: nothing was written."; return 0; }

  mkdir -p "$THEMES" "$STATE"
  [ -L "$DEST" ] && fail 6 "$DEST is a link to somewhere else; remove it or rename the theme."
  stamp=$(date +%Y%m%d-%H%M%S)
  if [ -d "$DEST" ]; then tar -C "$THEMES" -cf "$STATE/snapshot-$stamp.tar" "$SLUG"; else : >"$STATE/snapshot-$stamp.none"; fi
  [ -f "$CURRENT" ] && head -n1 "$CURRENT" >"$STATE/previous-theme" || true
  stage="$THEMES/.$SLUG.bogen-new"
  rm -rf "$stage"; mkdir -p "$stage"
  [ -d "$DEST" ] && cp -a "$DEST/." "$stage/"
  for rel in $(files); do
    s=$(state_of "$rel")
    [ "$s" = edited ] && [ "$REPLACE" = 0 ] && continue
    mkdir -p "$stage/$(dirname "$rel")"
    cp "$SRC/$rel" "$stage/$rel"
  done
  old="$THEMES/.$SLUG.bogen-old"
  rm -rf "$old"
  [ -d "$DEST" ] && mv "$DEST" "$old"
  mv "$stage" "$DEST"
  rm -rf "$old"
  ( cd "$SRC" && for rel in $(files); do sha256sum "$rel"; done ) >"$STATE/installed.sha256"
  printf '%s\\n' "$REVISION" >"$STATE/revision"
  say "Installed in $DEST."
  [ "$edited" -gt 0 ] && say "$edited file(s) you changed on this phone were kept; --replace-edited replaces them."
  if [ "$APPLY" = 1 ]; then theme_set "$SLUG"; say "Applied with omarchy-theme-set. Undo: ./install.sh --rollback"; else say "Apply it with: omarchy-theme-set $SLUG (or ./install.sh --apply)"; fi
}

rollback() {
  last=$(ls -1 "$STATE" 2>/dev/null | grep -E '^snapshot-' | LC_ALL=C sort | tail -n1 || true)
  [ -n "$last" ] || fail 7 "There is nothing to roll back: no snapshot in $STATE."
  [ -L "$DEST" ] && fail 6 "$DEST is a link; not touched."
  rm -rf "$DEST"
  case "$last" in
    *.tar) tar -C "$THEMES" -xf "$STATE/$last"; say "Restored $SLUG as it was before $last." ;;
    *.none) say "Removed $SLUG, which was not here before." ;;
  esac
  rm -f "$STATE/$last" "$STATE/installed.sha256" "$STATE/revision"
  now=$(head -n1 "$CURRENT" 2>/dev/null || true)
  prev=$(head -n1 "$STATE/previous-theme" 2>/dev/null || true)
  if [ "$now" = "$SLUG" ] && [ -n "$prev" ] && [ "$prev" != "$SLUG" ]; then theme_set "$prev"; say "Applied $prev again."; fi
}

case "$ACTION" in
  check) check_package; check_device; say "The package and the device check pass." ;;
  rollback) rollback ;;
  install) install ;;
esac
`;
}

/** The package's README: what it changes, what it cannot, and the commands. */
export function packageReadme(manifest: ThemeManifest, profile: MobileProfile): string {
  const rows = (s: CoverageStatus) => manifest.coverage.filter((c) => c.status === s).map((c) => `- ${c.surface}: ${c.via}${c.note ? `. ${c.note}` : ''}`);
  return [
    `# ${manifest.name}`,
    '',
    `An Omarchy Mobile theme for the ${profile.device} (${profile.id}, ${profile.panel.width} x ${profile.panel.height} at scale ${profile.scale}). ${manifest.mode === 'dark' ? 'Dark' : 'Light'}, revision ${manifest.revision}. Made with ${manifest.made_with}.`,
    '',
    'This is a theme for Omarchy\'s own shell on the phone, applied with `omarchy-theme-set`. It is not an Android launcher theme.',
    '',
    '## Install on the phone',
    '',
    '```sh',
    'tar -xzf ' + `${manifest.slug}-mobile.tar.gz && cd ${manifest.slug}-mobile`,
    './install.sh --dry-run     # what it would change, nothing written',
    './install.sh               # install into ~/.config/omarchy/themes',
    `omarchy-theme-set ${manifest.slug}   # or ./install.sh --apply`,
    './install.sh --rollback    # back to how it was, and the theme in use before',
    '```',
    '',
    'Installing again updates the files you have not edited and keeps the ones you have. It never writes outside the theme folder and its own state folder, and it does not touch plugins, the keyboard layout or system files.',
    '',
    '## What it changes',
    '',
    ...rows('themed'),
    '',
    '## Written for it when applied',
    '',
    ...rows('generated'),
    '',
    ...(rows('unverified').length ? ['## Carried, not verified on this phone', '', ...rows('unverified'), ''] : []),
    '## What a theme cannot change',
    '',
    ...rows('not-themable'),
    '',
  ].join('\n');
}

/** `sha256sum -c` input for every file of the package but the list itself. */
export function checksums(files: { path: string; bytes: Uint8Array }[]): string {
  return files.filter((f) => f.path !== 'checksums.sha256').map((f) => `${sha256(f.bytes)}  ${f.path}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n') + '\n';
}
