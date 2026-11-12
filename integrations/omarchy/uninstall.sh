#!/bin/bash
# Removes what install.sh added. Asks nothing, leaves your Bogen files alone, and
# `--dry-run` only prints.

set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$HERE/lib.sh"

while (($#)); do
  case $1 in
  --dry-run) DRY_RUN=1 ;;
  -h | --help)
    say "Usage: uninstall.sh [--dry-run]"
    exit 0
    ;;
  *)
    say "Unknown option: $1" >&2
    exit 2
    ;;
  esac
  shift
done

((DRY_RUN)) && say "Dry run. Nothing will change."
((SANDBOX)) && say "HOME is $HOME, not $REAL_HOME: files go there, and the live session is left alone."

step "Bar widget"
if [[ -e $PLUGIN_DIR ]]; then
  if can_go_live; then
    backup "$SHELL_JSON"
    omarchy plugin remove "$PLUGIN_ID" --yes || failed "omarchy plugin remove"
  elif ((DRY_RUN)); then
    say "  would run: omarchy plugin remove $PLUGIN_ID --yes"
  else
    backup "$PLUGIN_DIR"
    rm -rf "$PLUGIN_DIR"
    say "  removed: $PLUGIN_DIR"
  fi
else
  say "  not installed"
fi

step "Hyprland"
if [[ -f $HYPR_MAIN ]] && grep -qF -- "$MARKER_BEGIN" "$HYPR_MAIN"; then
  backup "$HYPR_MAIN"
  if ((DRY_RUN)); then
    say "  would remove the marked block from: $HYPR_MAIN"
  else
    strip_hypr_block
    say "  removed the marked block from: $HYPR_MAIN"
  fi
fi
remove_managed "$HYPR_SNIPPET"
live hyprctl reload >/dev/null

step "Theme and font hooks"
for hook in theme-set font-set; do
  remove_managed "$HOOKS_DIR/$hook.d/bogen-reload"
done

step "File type"
remove_managed "$MIME_FILE"
if [[ -f $MIMEAPPS ]] && grep -q "^$MIME=$DESKTOP_NAME.desktop" "$MIMEAPPS"; then
  backup "$MIMEAPPS"
  run sed -i "\|^$MIME=$DESKTOP_NAME.desktop|d" "$MIMEAPPS"
fi
[[ -d $MIME_DIR ]] && run update-mime-database "$MIME_DIR" >/dev/null 2>&1

step "Launcher"
if [[ -f $DESKTOP_FILE ]]; then
  if grep -q bogen-launch -- "$DESKTOP_FILE"; then
    run rm -f -- "$DESKTOP_FILE"
    run rm -f -- "$ICON_FILE"
    ((DRY_RUN)) || say "  removed: $DESKTOP_FILE, $ICON_FILE"
    run update-desktop-database "$APPS_DIR" >/dev/null 2>&1
  else
    say "  left in place, not ours: $DESKTOP_FILE"
  fi
fi

step "User service"
if [[ -f $UNIT ]]; then
  live systemctl --user disable --now "$SERVICE"
  remove_managed "$UNIT"
  live systemctl --user daemon-reload
fi

step "CLI and helper scripts"
for script in bogen bogen-launch bogen-place-screenshot; do
  remove_managed "$BIN_DIR/$script"
done

if systemctl is-active --quiet ufw 2>/dev/null; then
  say "If you opened the firewall for sync, close it with: sudo ufw delete allow in on tailscale0 to any port 29990 proto tcp"
fi
step "Summary"
if ((DRY_RUN)); then
  say "Dry run finished. Nothing changed."
else
  say "Removed. Your designs in ${BOGEN_HOME:-$XDG_DATA_HOME/bogen} were not touched."
fi
[[ -d $BACKUP_DIR ]] && say "Backups: $BACKUP_DIR"
((FAILURES == 0))
