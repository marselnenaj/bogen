#!/bin/bash
# Copies this build and integration to another Omarchy device over ssh, restarts it there and
# says which version answers. Safe to run again, and --dry-run changes nothing on either side.
#
#   integrations/omarchy/deploy.sh <ssh-host> [--dry-run] [--port 29990] [--dist <dir>]
#
# There it keeps to ~/.local/share/bogen-app and what install.sh writes. Your designs are not touched.

set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/../.." && pwd)

# BOGEN_DEPLOY_DIST names the build when --dist does not, as BOGEN_DEPLOY_SSH names ssh.
HOST="" DRY_RUN=0 PORT=29990 DIST="${BOGEN_DEPLOY_DIST:-}"
while (($#)); do
  case $1 in
  --dry-run) DRY_RUN=1 ;;
  --port) PORT=$2; shift ;;
  --dist) DIST=$2; shift ;;
  -h | --help)
    sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  -*)
    printf 'Unknown option: %s\n' "$1" >&2
    exit 2
    ;;
  *) HOST=$1 ;;
  esac
  shift
done
[[ -n $HOST ]] || { printf 'Usage: deploy.sh <ssh-host> [--dry-run] [--port 29990] [--dist <dir>]\n' >&2; exit 2; }

if [[ -z $DIST ]]; then
  DIST=$REPO/packages/server/dist
  [[ -f $DIST/cli.js ]] || DIST=$REPO/dist
fi
[[ -f $DIST/cli.js ]] || { printf 'No build at %s. Run: npm run build\n' "$DIST" >&2; exit 1; }
[[ -d $DIST/editor ]] || printf 'warning: %s has no editor in it, so that device would serve no canvas. Run: npm run build\n' "$DIST" >&2

SSH_CMD=${BOGEN_DEPLOY_SSH:-ssh}
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
APP=.local/share/bogen-app

say() { printf '%s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
die() { printf 'failed: %s\n' "$*" >&2; exit 1; }
remote() { "$SSH_CMD" "${SSH_OPTS[@]}" "$HOST" "$@"; }

local_node=$(command -v node || mise which node 2>/dev/null || true)
[[ -n $local_node ]] || die "no node here to read the version of this build"
LOCAL_VERSION=$("$local_node" "$DIST/cli.js" --version 2>/dev/null) || die "$DIST/cli.js does not run here"
# What scripts/build.mjs leaves out of the bundle, or what reads its own files at run time.
RUNTIME_DEPS=(puppeteer-core esbuild tailwindcss)
DEPS_JSON=$("$local_node" -e '
const fs = require("fs"), [repo, ...names] = process.argv.slice(1), deps = {};
for (const n of names) { try { deps[n] = JSON.parse(fs.readFileSync(`${repo}/node_modules/${n}/package.json`, "utf8")).version; } catch { deps[n] = "*"; } }
process.stdout.write(JSON.stringify(deps));' "$REPO" "${RUNTIME_DEPS[@]}")

((DRY_RUN)) && say "Dry run. Nothing will change on either device."
say "Deploying Bogen $LOCAL_VERSION from $DIST to $HOST"

# ---------------------------------------------------------------- what is there

step "Looking at $HOST"
# Read only. A non-interactive ssh shell has a short PATH and none of the session's variables.
probe_script='
set -u
export PATH="$HOME/.local/bin:$PATH"
mise=$(command -v mise || true)
node=""
if [ -n "$mise" ]; then
  where=$("$mise" where node 2>/dev/null || true)
  [ -n "$where" ] && [ -x "$where/bin/node" ] && node=$where/bin/node
fi
if [ -z "$node" ]; then
  for candidate in "$HOME"/.local/share/mise/installs/node/*/bin/node; do
    [ -x "$candidate" ] && node=$candidate
  done
fi
# A mise shim is on PATH too, and fails when no version is set, so only one that answers counts.
if [ -z "$node" ] && command -v node >/dev/null && node --version >/dev/null 2>&1; then node=$(command -v node); fi
printf "MISE=%s\n" "$mise"
printf "NODE=%s\n" "$node"
[ -n "$node" ] && printf "NODE_VERSION=%s\n" "$("$node" --version 2>/dev/null)"
printf "RSYNC=%s\n" "$(command -v rsync || true)"
printf "HAVE_APP=%s\n" "$([ -d "$HOME/'"$APP"'/dist" ] && echo 1)"
printf "HAVE_INSTALLER=%s\n" "$([ -f "$HOME/'"$APP"'/integrations/omarchy/install.sh" ] && echo 1)"
printf "HAVE_HYPR=%s\n" "$([ -f "$HOME/.config/hypr/bogen.lua" ] && echo 1)"
pkg="$HOME/'"$APP"'/dist/node_modules/puppeteer-core/package.json"
[ -f "$pkg" ] && [ -n "$node" ] && printf "PUPPETEER=%s\n" "$("$node" -p "JSON.parse(require(\"fs\").readFileSync(\"$pkg\",\"utf8\")).version" 2>/dev/null)"
if command -v curl >/dev/null; then
  # The first version is that of the server itself. Its paired devices list theirs after it.
  printf "RUNNING=%s\n" "$(curl -fsS -m 2 "http://127.0.0.1:'"$PORT"'/api/status" 2>/dev/null | grep -o "\"version\":\"[^\"]*\"" | head -n1 | cut -d\" -f4)"
fi
'
PROBE=$(remote "$probe_script") || die "could not reach $HOST over ssh. Check: ssh $HOST true"
value() { sed -n "s/^$1=//p" <<<"$PROBE" | head -n1; }
R_MISE=$(value MISE) R_NODE=$(value NODE) R_RSYNC=$(value RSYNC) R_RUNNING=$(value RUNNING) R_PUPPETEER=$(value PUPPETEER)
say "  node:    ${R_NODE:-none} $(value NODE_VERSION)"
say "  running: ${R_RUNNING:-nothing answers on $PORT}"

# ---------------------------------------------------------------- node

if [[ -z $R_NODE ]]; then
  step "Node"
  [[ -n $R_MISE ]] || die "$HOST has neither node nor mise. Install mise there first."
  if ((DRY_RUN)); then
    say "  would run there: mise use -g node@24"
    R_NODE='(what mise installs)'
  else
    remote "PATH=\"\$HOME/.local/bin:\$PATH\" mise use -g node@24 >/dev/null" || die "mise could not install node on $HOST"
    PROBE=$(remote "$probe_script") || die "lost $HOST"
    R_NODE=$(value NODE)
    [[ -n $R_NODE ]] || die "mise ran, and there is still no node on $HOST"
    say "  installed through mise: $R_NODE"
  fi
fi

# ---------------------------------------------------------------- files

copy() {
  local from=$1 to=$2 name=$3
  shift 3
  if command -v rsync >/dev/null && [[ -n $R_RSYNC ]]; then
    local flags=(-rlptz --delete --delay-updates -e "$SSH_CMD ${SSH_OPTS[*]}")
    ((DRY_RUN)) && flags+=(-n -i)
    local changes
    changes=$(rsync "${flags[@]}" "$@" --out-format='%i %n' "$from/" "$HOST:$to/") || die "could not copy $name"
    changes=$(grep -vE '^\.d' <<<"$changes" | grep -c . || true)
    if ((DRY_RUN)); then
      say "  $name: would change $changes file(s)"
    elif ((changes)); then
      say "  $name: $changes file(s) changed"
    else
      say "  $name: unchanged"
    fi
  elif ((DRY_RUN)); then
    say "  $name: would copy with tar, since rsync is missing on one side"
  else
    local excludes=()
    for arg in "$@"; do
      [[ $arg == --exclude=* ]] && excludes+=("$arg")
    done
    tar -C "$from" "${excludes[@]}" -cf - . | remote "mkdir -p '$to' && tar -C '$to' -xf -" || die "could not copy $name"
    say "  $name: copied"
  fi
}

step "Copying"
((DRY_RUN)) || remote "mkdir -p $APP/dist $APP/integrations/omarchy" || die "could not make $APP on $HOST"
copy "$DIST" "$APP/dist" "program" --exclude=node_modules --exclude=/package.json
copy "$HERE" "$APP/integrations/omarchy" "integration"

# ---------------------------------------------------------------- what the bundle needs next to it

step "Runtime modules"
PACKAGE_JSON="{\"name\":\"bogen-app\",\"private\":true,\"type\":\"module\",\"dependencies\":$DEPS_JSON}"
if remote "cd $APP/dist 2>/dev/null && [ \"\$(cat package.json 2>/dev/null)\" = '$PACKAGE_JSON' ] && for d in ${RUNTIME_DEPS[*]}; do [ -f node_modules/\$d/package.json ] || exit 1; done"; then
  say "  ${RUNTIME_DEPS[*]} are there"
elif ((DRY_RUN)); then
  say "  would install $DEPS_JSON there with npm"
else
  node_dir=$(dirname -- "$R_NODE")
  remote "cd $APP/dist && printf '%s\n' '$PACKAGE_JSON' > package.json && PATH='$node_dir':\"\$HOME/.local/bin:\$PATH\" npm install --omit=dev --no-audit --no-fund --loglevel=error" ||
    die "npm could not install ${RUNTIME_DEPS[*]} on $HOST"
  say "  installed $DEPS_JSON"
fi

# ---------------------------------------------------------------- installer and service

step "Installing there"
install_flags=(--tailnet)
[[ -n $(value HAVE_HYPR) ]] && install_flags+=(--no-hypr)
if ((DRY_RUN)); then
  if [[ -n $(value HAVE_INSTALLER) ]]; then
    remote "cd \$HOME/$APP && BOGEN_NODE='$R_NODE' BOGEN_CLI_JS=\"\$HOME/$APP/dist/cli.js\" bash integrations/omarchy/install.sh --dry-run ${install_flags[*]}" | sed 's/^/  /'
  else
    say "  would run integrations/omarchy/install.sh ${install_flags[*]} there"
  fi
  say "  would restart bogen.service there"
else
  # lib.sh reads the session's variables from the running shell, so none need to be set here.
  remote "cd \$HOME/$APP && BOGEN_NODE='$R_NODE' BOGEN_CLI_JS=\"\$HOME/$APP/dist/cli.js\" bash integrations/omarchy/install.sh ${install_flags[*]}" | sed 's/^/  /'
  ((PIPESTATUS[0] == 0)) || say "warning: the installer reported problems, see above. Continuing with the service."

  step "Restarting"
  restart='export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; systemctl --user daemon-reload; systemctl --user restart bogen.service'
  remote "$restart" || die "could not restart bogen.service on $HOST. See there: journalctl --user -u bogen -n 50"
  say "  restarted bogen.service"
fi

# ---------------------------------------------------------------- report

step "Result"
if ((DRY_RUN)); then
  say "Dry run finished. Nothing changed. $HOST runs ${R_RUNNING:-nothing yet}, this build is $LOCAL_VERSION."
  exit 0
fi
ANSWER=""
for _ in $(seq 1 60); do
  # The first version is the server's own: a paired device that runs this build is listed after it.
  ANSWER=$(remote "curl -fsS -m 2 http://127.0.0.1:$PORT/api/status" 2>/dev/null | grep -o '"version":"[^"]*"' | head -n1 | cut -d'"' -f4)
  [[ -n $ANSWER ]] && break
  sleep 0.5
done
[[ -n $ANSWER ]] || die "$HOST does not answer on port $PORT after the restart. See there: journalctl --user -u bogen -n 50"
say "$HOST runs Bogen $ANSWER"
if [[ $ANSWER == "$LOCAL_VERSION" ]]; then
  say "That is this build."
else
  printf 'failed: %s runs %s, and this build is %s. An older server may still hold the port.\n' "$HOST" "$ANSWER" "$LOCAL_VERSION" >&2
  exit 1
fi
