#!/bin/bash
# Installs the Bogen integration for Omarchy. Safe to run again. Asks nothing,
# overwrites nothing it did not write without a backup, and `--dry-run` only prints.

set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)
source "$HERE/lib.sh"

WITH_SERVICE=1 WITH_PLUGIN=1 WITH_HYPR=1 WITH_TAILNET=0
while (($#)); do
  case $1 in
  --dry-run) DRY_RUN=1 ;;
  --no-service) WITH_SERVICE=0 ;;
  --no-plugin) WITH_PLUGIN=0 ;;
  --no-hypr) WITH_HYPR=0 ;;
  --tailnet) WITH_TAILNET=1 ;;
  -h | --help)
    say "Usage: install.sh [--dry-run] [--no-service] [--no-plugin] [--no-hypr] [--tailnet]"
    exit 0
    ;;
  *)
    say "Unknown option: $1" >&2
    exit 2
    ;;
  esac
  shift
done

command -v omarchy >/dev/null || { say "This is for Omarchy, and the omarchy command is not here." >&2; exit 1; }
for tool in jq curl; do
  command -v "$tool" >/dev/null || { say "Missing: $tool" >&2; exit 1; }
done

((DRY_RUN)) && say "Dry run. Nothing will change."
((SANDBOX)) && say "HOME is $HOME, not $REAL_HOME: files go there, and the live session is left alone."

# ---------------------------------------------------------------- CLI

# An existing `bogen` wins and is never replaced. Otherwise a small wrapper runs
# this checkout: a user service has no mise shims to find node with.
step "CLI"
WRAPPER="$BIN_DIR/bogen"
CLI_JS=${BOGEN_CLI_JS:-}
if [[ -z $CLI_JS ]]; then
  # A checkout builds into packages/server, and a deployed copy has dist/ right next to integrations/.
  CLI_JS=$REPO/packages/server/dist/cli.js
  [[ ! -f $CLI_JS && -f $REPO/dist/cli.js ]] && CLI_JS=$REPO/dist/cli.js
fi
BOGEN_BIN=""
if [[ -x $WRAPPER ]] && ! grep -q "$MANAGED" -- "$WRAPPER" 2>/dev/null; then
  BOGEN_BIN=$WRAPPER
elif ! grep -q "$MANAGED" -- "$WRAPPER" 2>/dev/null; then
  BOGEN_BIN=$(command -v bogen 2>/dev/null || true)
fi

if [[ -n $BOGEN_BIN ]]; then
  say "  using $BOGEN_BIN"
else
  if [[ ! -f $CLI_JS ]]; then
    if ((DRY_RUN)); then
      warn "$CLI_JS is not built yet. A real run stops here until you run: npm run build"
    else
      say "$CLI_JS is not built. Run this in $REPO first: npm run build" >&2
      exit 1
    fi
  fi
  node_bin=${BOGEN_NODE:-$(mise which node 2>/dev/null || command -v node || true)}
  [[ -n $node_bin ]] || { say "Missing: node" >&2; exit 1; }
  BOGEN_BIN=$WRAPPER
  write_file "$WRAPPER" 755 "#!/bin/sh
# $MANAGED integrations/omarchy.
# The path found at install time wins: a mise shim on PATH fails when no global version is set.
node='$node_bin'
[ -x \"\$node\" ] || node=\$(command -v node)
exec \"\$node\" '$CLI_JS' \"\$@\""
fi
case :$PATH: in
*":$BIN_DIR:"*) ;;
*) warn "$BIN_DIR is not on your PATH" ;;
esac

step "Helper scripts"
for script in bogen-launch bogen-place-screenshot; do
  write_file "$BIN_DIR/$script" 755 "$(<"$HERE/bin/$script")"
done

# ---------------------------------------------------------------- service

if ((WITH_SERVICE)); then
  step "User service"
  # A second run without the flag does not take --tailnet back out.
  bogen_args=""
  if ((WITH_TAILNET)) || grep -q -- 'serve --tailnet' "$UNIT" 2>/dev/null; then
    bogen_args=" --tailnet"
  fi
  unit=$(sed -e "s|@BOGEN_BIN@|$BOGEN_BIN|" -e "s|@BOGEN_ARGS@|$bogen_args|" "$HERE/systemd/bogen.service.in")
  write_file "$UNIT" 644 "$unit"
  live systemctl --user daemon-reload
  # Someone else answering on the port, a dev server say, is not ours to fight.
  if curl -fsS -m 1 -o /dev/null "$BOGEN_URL/api/status" 2>/dev/null &&
    ! systemctl --user -q is-active "$SERVICE" 2>/dev/null; then
    warn "something already answers on $BOGEN_URL, so the service is enabled but not started"
    live systemctl --user enable "$SERVICE" || failed "enable $SERVICE"
  else
    live systemctl --user enable --now "$SERVICE" || failed "start $SERVICE"
  fi
fi

# ---------------------------------------------------------------- launcher

# Omarchy's ufw refuses everything incoming, so another device could never reach this one.
if ((WITH_TAILNET)) && systemctl is-active --quiet ufw 2>/dev/null; then
  step "Firewall"
  ufw_rule=(allow in on tailscale0 to any port 29990 proto tcp comment bogen-sync)
  if ((DRY_RUN)); then
    say "  would run: sudo ufw ${ufw_rule[*]}"
  elif { sudo -n true 2>/dev/null && sudo -n ufw "${ufw_rule[@]}" >/dev/null; } ||
    { [[ -t 0 ]] && sudo ufw "${ufw_rule[@]}"; }; then
    say "  port 29990 is open on Tailscale only"
  else
    # Without a terminal or passwordless sudo, ufw can be neither read nor changed. The rule may well be there.
    warn "Could not check the firewall without sudo. If other devices cannot reach this one, run: sudo ufw ${ufw_rule[*]}"
  fi
fi

step "Launcher"
if [[ -e $DESKTOP_FILE ]] && ! grep -q bogen-launch -- "$DESKTOP_FILE"; then
  backup "$DESKTOP_FILE"
fi
run omarchy webapp install "$DESKTOP_NAME" "$BOGEN_URL" "$HERE/assets/bogen.png" \
  "$BIN_DIR/bogen-launch %f" "$MIME;" || failed "omarchy webapp install"
((DRY_RUN)) || say "  wrote: $DESKTOP_FILE, $ICON_FILE"

step "File type"
write_file "$MIME_FILE" 644 "$(<"$HERE/mime/bogen.xml")"
run update-mime-database "$MIME_DIR" >/dev/null 2>&1
run update-desktop-database "$APPS_DIR" >/dev/null 2>&1
current_default=$(xdg-mime query default "$MIME" 2>/dev/null || true)
if [[ -z $current_default || $current_default == "$DESKTOP_NAME.desktop" ]]; then
  if [[ $current_default != "$DESKTOP_NAME.desktop" ]]; then
    backup "$MIMEAPPS"
    run xdg-mime default "$DESKTOP_NAME.desktop" "$MIME" || failed "xdg-mime default"
  else
    say "  unchanged: .bogen opens with $current_default"
  fi
else
  say "  left alone: .bogen already opens with $current_default"
fi

# ---------------------------------------------------------------- hooks

step "Theme and font hooks"
for hook in theme-set font-set; do
  target="$HOOKS_DIR/$hook.d/bogen-reload"
  if [[ -f $target ]] && cmp -s "$target" "$HERE/hooks/bogen-reload"; then
    say "  unchanged: $target"
  else
    run omarchy hook install "$hook" "$HERE/hooks/bogen-reload" || failed "hook $hook"
  fi
done

# ---------------------------------------------------------------- bar widget

install_plugin_files() {
  local stage="$PLUGINS_DIR/.$PLUGIN_ID.tmp.$$"
  if [[ -d $PLUGIN_DIR/.git ]]; then
    say "  git checkout, managed by: omarchy plugin update $PLUGIN_ID"
    return 0
  fi
  if [[ -d $PLUGIN_DIR ]] && diff -rq "$HERE/plugin" "$PLUGIN_DIR" >/dev/null 2>&1; then
    say "  unchanged: $PLUGIN_DIR"
    return 0
  fi
  if ((DRY_RUN)); then
    say "  would copy $HERE/plugin to $PLUGIN_DIR"
    return 0
  fi
  # The shell reloads on any write under plugins/, so the new copy lands in one move.
  mkdir -p "$PLUGINS_DIR"
  rm -rf "$stage"
  cp -r "$HERE/plugin" "$stage"
  if ! omarchy-plugin-validate "$stage"; then
    rm -rf "$stage"
    failed "the plugin did not validate"
    return 1
  fi
  if [[ -e $PLUGIN_DIR ]]; then
    backup "$PLUGIN_DIR"
    rm -rf "$PLUGIN_DIR"
  fi
  mv "$stage" "$PLUGIN_DIR"
  say "  copied to $PLUGIN_DIR"
}

enable_plugin() {
  local listed attempt
  live omarchy-shell shell rescanPlugins >/dev/null
  can_go_live || { live omarchy plugin enable "$PLUGIN_ID"; return 0; }
  for ((attempt = 0; attempt < 40; attempt++)); do
    listed=$(omarchy-shell shell listPlugins 2>/dev/null | jq -r --arg id "$PLUGIN_ID" '.[] | select(.id == $id) | .enabled')
    [[ -n $listed ]] && break
    sleep 0.1
  done
  case $listed in
  true) say "  already enabled in the bar" ;;
  false)
    backup "$SHELL_JSON"
    omarchy plugin enable "$PLUGIN_ID" || failed "omarchy plugin enable"
    ;;
  *) failed "the shell does not list $PLUGIN_ID; try: omarchy-shell shell rescanPlugins" ;;
  esac
}

if ((WITH_PLUGIN)); then
  step "Bar widget"
  install_plugin_files && enable_plugin
fi

# ---------------------------------------------------------------- Hyprland

# bind_taken <modmask> <key>. Our own earlier binds don't count, so a second run
# lands on the same keys.
bind_taken() {
  jq -e --argjson mask "$1" --arg key "$2" '
    any(.[]; .modmask == $mask and (.key | ascii_upcase) == $key
             and ((.description // "") | startswith("Bogen") | not))
  ' <<<"$BINDS" >/dev/null
}

CANDIDATES=("SUPER + SHIFT + D:65:D" "SUPER + SHIFT + ALT + D:73:D" "SUPER + CTRL + SHIFT + D:69:D" "SUPER + SHIFT + ALT + B:73:B")

pick_key() {
  local candidate spec mask key
  for candidate in "${CANDIDATES[@]}"; do
    spec=${candidate%%:*}
    mask=${candidate#*:} mask=${mask%%:*}
    key=${candidate##*:}
    [[ $spec == "${TAKEN_SPEC:-}" ]] && continue
    bind_taken "$mask" "$key" || { printf '%s\n' "$spec"; return 0; }
  done
  return 1
}

if ((WITH_HYPR)); then
  step "Hyprland"
  if [[ ! -f $HYPR_MAIN ]]; then
    warn "$HYPR_MAIN is missing, skipping Hyprland"
  else
    BINDS=$(hyprctl binds -j 2>/dev/null) || BINDS='[]'
    jq -e 'type == "array"' <<<"$BINDS" >/dev/null 2>&1 || BINDS='[]'

    bindings=""
    TAKEN_SPEC=""
    if open_key=$(pick_key); then
      say "  open Bogen: $open_key"
      bindings+="o.bind(\"$open_key\", \"Bogen\", bogen_bin .. \"bogen-launch\")"$'\n'
      TAKEN_SPEC=$open_key
    else
      warn "no free key to open Bogen, leaving it out"
    fi
    if shot_key=$(pick_key); then
      say "  place the newest screenshot: $shot_key"
      bindings+="o.bind(\"$shot_key\", \"Bogen: place screenshot\", bogen_bin .. \"bogen-place-screenshot\")"
    else
      warn "no free key to place screenshots, leaving it out"
    fi

    snippet=$(B=$bindings awk '$0 == "@BINDINGS@" { print ENVIRON["B"]; next } { print }' "$HERE/hypr/bogen.lua.in")

    # Measured against what the compositor reported before we started, and taken
    # back out if our change added an error.
    errors_before=$(can_go_live && hyprctl configerrors 2>/dev/null)
    write_file "$HYPR_SNIPPET" 644 "$snippet"
    if grep -qF -- "$MARKER_BEGIN" "$HYPR_MAIN"; then
      say "  unchanged: $HYPR_MAIN already loads it"
    else
      backup "$HYPR_MAIN"
      if ((DRY_RUN)); then
        say "  would append a marked block to: $HYPR_MAIN"
      else
        cat >>"$HYPR_MAIN" <<LUA

$MARKER_BEGIN
do local path = os.getenv("HOME") .. "/.config/hypr/bogen.lua"; local file = io.open(path, "r"); if file then file:close(); dofile(path) end end
$MARKER_END
LUA
        say "  appended a marked block to: $HYPR_MAIN"
      fi
    fi

    live hyprctl reload >/dev/null
    if can_go_live; then
      sleep 0.5
      errors_after=$(hyprctl configerrors 2>/dev/null)
      if [[ $errors_after != "$errors_before" ]]; then
        failed "Hyprland reports new config errors, undoing:"
        printf '%s\n' "$errors_after" >&2
        strip_hypr_block
        rm -f "$HYPR_SNIPPET"
        hyprctl reload >/dev/null
      else
        say "  hyprctl configerrors: nothing new"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- done

step "Summary"
if ((DRY_RUN)); then
  say "Dry run finished. Nothing changed."
elif ((FAILURES)); then
  say "Finished with $FAILURES failure(s), listed above."
else
  say "Done. Undo with: $HERE/uninstall.sh"
fi
[[ -d $BACKUP_DIR ]] && say "Backups: $BACKUP_DIR"
((FAILURES == 0))
