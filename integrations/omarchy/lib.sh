# Shared by install.sh and uninstall.sh. Sourced, not run.

PLUGIN_ID=dev.bogen.bogen
SERVICE=bogen.service
DESKTOP_NAME=Bogen
BOGEN_URL=http://127.0.0.1:29990
MIME=application/x-bogen
MARKER_BEGIN='-- >>> bogen (managed by integrations/omarchy)'
MARKER_END='-- <<< bogen'
MANAGED='Managed by Bogen'

DRY_RUN=0
FAILURES=0

# Dry-run lines must show even for commands whose own output is silenced.
exec 3>&1

# Omarchy hard-codes these under $HOME, so a custom XDG path would only split our
# files from its own. It also keeps a HOME=<tmp> test run out of the real ones.
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"

BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$SERVICE"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$APPS_DIR/$DESKTOP_NAME.desktop"
ICON_FILE="$HOME/.local/share/icons/hicolor/256x256/apps/bogen.png"
MIME_DIR="$HOME/.local/share/mime"
MIME_FILE="$MIME_DIR/packages/bogen.xml"
MIMEAPPS="$HOME/.config/mimeapps.list"
HOOKS_DIR="$HOME/.config/omarchy/hooks"
PLUGINS_DIR="$HOME/.config/omarchy/plugins"
PLUGIN_DIR="$PLUGINS_DIR/$PLUGIN_ID"
SHELL_JSON="$HOME/.config/omarchy/shell.json"
HYPR_MAIN="$HOME/.config/hypr/hyprland.lua"
HYPR_SNIPPET="$HOME/.config/hypr/bogen.lua"
BACKUP_DIR="$HOME/.local/state/bogen/backups/$(date +%Y%m%d-%H%M%S)"

# With HOME pointing elsewhere, file changes land in that HOME, but systemctl,
# hyprctl and shell IPC would still reach the real session through
# XDG_RUNTIME_DIR. Those are skipped.
REAL_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
if [[ $HOME == "$REAL_HOME" ]]; then SANDBOX=0; else SANDBOX=1; fi

# Over ssh, or from a user service, none of the session's variables are set, and the
# omarchy commands are not on PATH. The running shell has them all, so they are read
# from there. What is already set stays. Prints nothing.
adopt_session_env() {
  local name pid line key value
  local wanted=" OMARCHY_PATH HYPRLAND_INSTANCE_SIGNATURE XDG_RUNTIME_DIR WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP "
  for name in quickshell qs omarchy-shell Hyprland; do
    while read -r pid; do
      [[ -n $pid && -r /proc/$pid/environ ]] || continue
      while IFS= read -r -d '' line; do
        key=${line%%=*}
        value=${line#*=}
        if [[ $wanted == *" $key "* && -z ${!key:-} ]]; then
          export "$key=$value"
        fi
      done </proc/"$pid"/environ
    done < <(pgrep -u "$(id -u)" -x "$name" 2>/dev/null)
    [[ -n ${OMARCHY_PATH:-} ]] && break
  done
  [[ -n ${XDG_RUNTIME_DIR:-} ]] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  if [[ -z ${OMARCHY_PATH:-} ]]; then
    for dir in "$HOME/.local/share/omarchy" /usr/share/omarchy; do
      if [[ -d $dir/bin ]]; then
        export OMARCHY_PATH=$dir
        break
      fi
    done
  fi
  [[ -n ${OMARCHY_PATH:-} && -d $OMARCHY_PATH/bin ]] && export PATH="$OMARCHY_PATH/bin:$PATH"
  case :$PATH: in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
  esac
  return 0
}

say() { printf '%s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
failed() {
  printf 'failed: %s\n' "$*" >&2
  FAILURES=$((FAILURES + 1))
}

# Runs a command that changes this HOME.
run() {
  if ((DRY_RUN)); then
    say "  would run: $*" >&3
  else
    "$@"
  fi
}

# Runs a command that reaches the live session.
live() {
  if ((DRY_RUN)); then
    say "  would run: $*" >&3
  elif ((SANDBOX)); then
    say "  skipped, HOME is not your real home: $*" >&3
  else
    "$@"
  fi
}

can_go_live() { ((!DRY_RUN && !SANDBOX)); }

backup() {
  local path=$1 relative
  [[ -e $path || -L $path ]] || return 0
  relative=${path#"$HOME"/}
  if ((DRY_RUN)); then
    say "  would back up: $path"
    return 0
  fi
  mkdir -p "$BACKUP_DIR/$(dirname -- "$relative")"
  cp -a -- "$path" "$BACKUP_DIR/$relative"
  say "  backed up to $BACKUP_DIR/$relative"
}

# write_file <path> <mode> <content>. Leaves identical files alone and backs up
# anything it did not write itself before replacing it.
write_file() {
  local path=$1 mode=$2 content=$3
  if [[ -f $path ]] && [[ $(<"$path") == "$content" ]]; then
    say "  unchanged: $path"
    return 0
  fi
  if [[ -e $path ]] && ! grep -q "$MANAGED" -- "$path" 2>/dev/null; then
    backup "$path"
  fi
  if ((DRY_RUN)); then
    say "  would write: $path"
    return 0
  fi
  mkdir -p "$(dirname -- "$path")"
  printf '%s\n' "$content" >"$path"
  chmod "$mode" "$path"
  say "  wrote: $path"
}

# Deletes a file only if it carries our marker.
remove_managed() {
  local path=$1
  [[ -e $path ]] || return 0
  if ! grep -q "$MANAGED" -- "$path" 2>/dev/null; then
    say "  left in place, not ours: $path"
    return 0
  fi
  run rm -f -- "$path"
  ((DRY_RUN)) || say "  removed: $path"
}

# Takes out our block and the blank line install.sh put before it, nothing else.
strip_hypr_block() {
  [[ -f $HYPR_MAIN ]] && grep -qF -- "$MARKER_BEGIN" "$HYPR_MAIN" || return 1
  local stage="$HYPR_MAIN.bogen-tmp"
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 == b { skip = 1; blank = 0; next }
    skip { if ($0 == e) skip = 0; next }
    { if (blank) print ""; blank = 0 }
    $0 == "" { blank = 1; next }
    { print }
    END { if (blank) print "" }
  ' "$HYPR_MAIN" >"$stage" && cat "$stage" >"$HYPR_MAIN"
  rm -f "$stage"
}

adopt_session_env
