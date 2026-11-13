#!/usr/bin/env bash
# Installs the latest Bogen release for the current user.
#   curl -fsSL https://bogen.dev/install.sh | bash
# Add `-s -- --no-omarchy` to leave out the Omarchy integration (user service,
# launcher, keybinding and bar widget).
# At the end it offers to connect the coding agents it finds, asking on the terminal. To answer without
# being asked, as an agent installing for a person does, name them:
#   curl -fsSL https://bogen.dev/install.sh | BOGEN_AGENTS=claude-code bash
# (a comma-separated list, all, or none).
# It downloads the package from the GitHub release, checks it against its
# checksum and the release signature, and installs it into
# ~/.local/share/bogen-app with a `bogen` command in ~/.local/bin. It never
# uses sudo. Your designs live in ~/.local/share/bogen and are not touched.
set -euo pipefail

main() {
    REPOSITORY="marselnenaj/bogen"
    API="https://api.github.com/repos/$REPOSITORY/releases/latest"
    DOWNLOADS="https://github.com/$REPOSITORY/releases/download"
    # The public half of the release key, the same as in packages/server/src/release-key.ts.
    PUBLIC_KEY="VMw37sxKvTW71ViTFZJ8TwB2WYWjdr1r/CZ/tpbjVTc="
    NAME="bogen-design"
    NODE_MAJOR=22 NODE_MINOR=18
    PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/bogen-app"
    BIN="$HOME/.local/bin"
    MARK="Written by Bogen's install.sh"

    say() { printf '\033[1m%s\033[0m\n' "$*"; }
    fail() { printf 'Bogen: %s\n' "$*" >&2; exit 1; }

    omarchy=auto
    for argument in "$@"; do
        case "$argument" in
            --omarchy) omarchy=yes ;;
            --no-omarchy) omarchy=no ;;
            *) fail "unknown option $argument" ;;
        esac
    done

    [ "$(uname -s)" = Linux ] || fail "this release is made for Omarchy on Arch Linux."
    [ "$(id -u)" != 0 ] || fail "run this as your own user, not as root. It installs for one user."
    for tool in curl tar sha256sum base64 openssl; do
        command -v "$tool" >/dev/null 2>&1 || fail "please install $tool first."
    done

    # Node, with its full path: a user service has no mise shims to find it with.
    node="$(mise which node 2>/dev/null || command -v node || true)"
    node_hint="Bogen needs Node $NODE_MAJOR.$NODE_MINOR or newer. On Omarchy: omarchy install dev-env node. On Arch: sudo pacman -S nodejs npm."
    [ -n "$node" ] && [ -x "$node" ] || fail "$node_hint"
    "$node" -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > $NODE_MAJOR || (a === $NODE_MAJOR && b >= $NODE_MINOR) ? 0 : 1)" \
        || fail "this is Node $("$node" --version). $node_hint"
    npm="$(mise which npm 2>/dev/null || command -v npm || true)"
    [ -n "$npm" ] || fail "npm is missing; it comes with Node. $node_hint"

    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT

    # BOGEN_INSTALL_FROM names a folder with the release files instead of GitHub; it is for testing a release
    # before it is published. The checksum and the signature are checked all the same.
    from="${BOGEN_INSTALL_FROM:-}"
    if [ -n "$from" ]; then
        package="$(cd "$from" && ls $NAME-*.tgz | head -n 1)"
        [ -n "$package" ] || fail "no $NAME-*.tgz in $from."
        version="${package#"$NAME"-}"; version="${version%.tgz}"
        for file in "$package" "$package.sha256" "$package.sig"; do cp "$from/$file" "$work/$file"; done
    else
        say "Looking for the latest release"
        curl -fsSL "$API" -o "$work/release.json" 2>/dev/null || fail "no release found at github.com/$REPOSITORY."
        tag="$(sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' "$work/release.json" | head -n 1)"
        case "$tag" in
            v[0-9]*) ;;
            *) fail "the latest release has no usable version." ;;
        esac
        version="${tag#v}"
        package="$NAME-$version.tgz"
        say "Downloading $package"
        for file in "$package" "$package.sha256" "$package.sig"; do
            curl -fsSL --retry 3 "$DOWNLOADS/$tag/$file" -o "$work/$file" || fail "could not download $file."
        done
    fi

    say "Checking the package"
    (cd "$work" && sha256sum --check --status "$package.sha256") || fail "the package does not match its checksum. Nothing was installed."
    # An Ed25519 public key in DER: a fixed prefix, then the 32 raw bytes.
    { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; printf '%s' "$PUBLIC_KEY" | base64 -d; } > "$work/key.der"
    base64 -d "$work/$package.sig" > "$work/signature" || fail "the signature file is damaged. Nothing was installed."
    openssl pkeyutl -verify -rawin -pubin -keyform DER -inkey "$work/key.der" \
        -in "$work/$package" -sigfile "$work/signature" >/dev/null 2>&1 \
        || fail "the package's signature is not valid. Nothing was installed."

    say "Installing Bogen $version"
    mkdir -p "$PREFIX" "$BIN"
    PATH="$(dirname "$node"):$PATH" "$npm" install --global --prefix "$PREFIX" --no-fund --no-audit --loglevel=error "$work/$package" > "$work/npm.log" 2>&1 \
        || { cat "$work/npm.log" >&2; fail "npm could not install the package."; }
    cli="$PREFIX/lib/node_modules/$NAME/dist/cli.js"
    [ -f "$cli" ] || fail "the package was installed, but $cli is missing."

    # The command. A `bogen` that this script did not write is kept under another name.
    command="$BIN/bogen"
    if [ -e "$command" ] || [ -L "$command" ]; then
        if ! grep -q "$MARK" "$command" 2>/dev/null; then
            kept="$command.before-install-$(date +%Y%m%d-%H%M%S)"
            mv "$command" "$kept"
            printf 'There was a bogen command already; it is kept as %s\n' "$kept"
        fi
    fi
    cat > "$command.new" <<EOF
#!/bin/sh
# $MARK. The Node found at install time wins: a mise shim fails where no global version is set.
node='$node'
[ -x "\$node" ] || node=\$(command -v node)
exec "\$node" '$cli' "\$@"
EOF
    chmod 755 "$command.new"
    mv -f "$command.new" "$command"
    "$command" --version > /dev/null || fail "bogen was installed but does not start."

    if [ "$omarchy" = yes ] || { [ "$omarchy" = auto ] && command -v omarchy >/dev/null 2>&1 && [ -d "$HOME/.config/omarchy" ]; }; then
        say "Setting up the Omarchy integration"
        "$command" omarchy install > "$work/omarchy.log" 2>&1 \
            || { cat "$work/omarchy.log" >&2; printf 'The Omarchy integration stopped. Bogen itself is installed; run this to see why: bogen omarchy install\n' >&2; }
    fi

    say "Bogen $("$command" --version) is installed."
    case ":$PATH:" in
        *":$BIN:"*) ;;
        *)
            case "${SHELL##*/}" in
                fish) hint='fish_add_path ~/.local/bin' ;;
                zsh) hint="echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
                *) hint="echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc" ;;
            esac
            printf '~/.local/bin is not on your PATH. To use bogen from a terminal, run this and open a new one:\n  %s\n' "$hint"
            ;;
    esac

    # Connect the agents. Under `curl | bash` the script itself is on stdin, so a question goes to the terminal, and
    # only when there is one and BOGEN_AGENTS does not answer it already. Without either, setup says what to run.
    if ! "$command" help 2>/dev/null | grep -q 'bogen setup'; then
        printf 'Open the canvas with: bogen open\nConnect your agent with: bogen install claude-code   (or codex)\nCheck the setup with: bogen doctor\n'
        return
    fi
    printf '\n'
    if [ -z "${BOGEN_AGENTS:-}" ] && (: < /dev/tty) 2>/dev/null; then
        "$command" setup < /dev/tty || printf 'Bogen is installed. To connect your agents again: bogen setup\n' >&2
    else
        "$command" setup < /dev/null || printf 'Bogen is installed. To connect your agents again: bogen setup\n' >&2
    fi
}

main "$@"
