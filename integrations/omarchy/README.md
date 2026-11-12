# Bogen on Omarchy

Makes Bogen feel native on [Omarchy](https://omarchy.org): the editor takes its
colours and font from your theme, the bar shows when an agent is drawing, and
Bogen has a launcher, keys and a user service.

## Install

Build first, then run the installer from a checkout:

```bash
npm install && npm run build
integrations/omarchy/install.sh --dry-run   # prints every step, changes nothing
integrations/omarchy/install.sh
```

It asks nothing and is safe to run again. Anything it replaces that it did not
write goes to `~/.local/state/bogen/backups/` first. Skip parts with
`--no-service`, `--no-plugin` or `--no-hypr`. `--tailnet` makes the service listen on
this machine's Tailscale address too, for [device sync](#syncing-with-another-device).

| What | Where |
|------|-------|
| `bogen` wrapper, if you have no `bogen` yet | `~/.local/bin/bogen` |
| `bogen-launch`, `bogen-place-screenshot` | `~/.local/bin/` |
| User service running `bogen serve` | `~/.config/systemd/user/bogen.service` |
| Launcher and icon, through `omarchy webapp install` | `~/.local/share/applications/Bogen.desktop` |
| `.bogen` file type | `~/.local/share/mime/packages/bogen.xml` |
| Theme and font hooks | `~/.config/omarchy/hooks/{theme-set,font-set}.d/bogen-reload` |
| Bar widget | `~/.config/omarchy/plugins/dev.bogen.bogen/` |
| Window rules and keys | `~/.config/hypr/bogen.lua`, loaded by a marked block at the end of `hyprland.lua` |

Keys are checked against `hyprctl binds` and never replace a binding. Open Bogen
gets the first free one of Super+Shift+D, Super+Shift+Alt+D, Super+Ctrl+Shift+D and
Super+Shift+Alt+B, and placing the newest screenshot gets the next. The installer
prints which. On a stock Omarchy, Super+Shift+D is Docker, so Bogen moves along.

If Hyprland reports a new config error after the change, the installer takes its
block back out.

## Portrait monitors

Not part of `install.sh`: the portrait background replaces Omarchy's background plugin, so it is a
step of its own, planned first.

```bash
bogen omarchy portrait status
bogen omarchy portrait install           # plan
bogen omarchy portrait install --apply   # ~/.config/omarchy/plugins/bogen.portrait-background
bogen omarchy portrait enable --apply    # omarchy plugin enable; disable puts omarchy.background back
```

See [portrait-background/README.md](portrait-background/README.md) and the guide's
[portrait background plugin](../../docs/guide/omarchy.md#the-portrait-background-plugin).

## Sync between devices

Two things can stand between two Bogen instances, and both need the owner of the machine or the tailnet:

1. **Your Tailscale policy.** A tailnet with its own access rules has to allow TCP port 29990 between the devices, in the access controls of the admin console.
2. **The firewall.** Omarchy's ufw refuses everything incoming. On each device: `sudo ufw allow in on tailscale0 to any port 29990 proto tcp comment bogen-sync`. `install.sh --tailnet` offers to do this.

Then run `bogen peer pair` on one device and the `bogen peer add` line it prints on the other.

## Uninstall

```bash
integrations/omarchy/uninstall.sh --dry-run
integrations/omarchy/uninstall.sh
```

Your designs in `~/.local/share/bogen` stay where they are.

## The bar widget

Left click opens the panel, middle click makes a new file, right click opens Bogen.
In the panel: `N` new file, `O` open, `S` start or stop the server, `R` refresh,
arrows and Enter to move through it.

The icon is muted when the server is stopped and turns the accent colour, with a
slow pulse, while an agent works. The pulse stays off when Hyprland animations are
off. You get a notification when an agent finishes, when a comment arrives and when a
run from a comment ends, and clicking one opens the file. All of it can be turned off in
the widget's settings. The panel also lists the last runs over all files.

The widget talks to the server over HTTP without starting a process: every 5 seconds
when the server runs, every 15 when it does not, faster only while the panel is open
or an agent works.

## Syncing with another device

Bogen on this PC and another device (a laptop, say)
can hold the same files and merge edits made on either, also when one was offline.
They talk over Tailscale only.

```bash
integrations/omarchy/install.sh --tailnet      # or: bogen serve --tailnet
systemctl --user restart bogen                 # picks up a rebuilt server
bogen peer pair                                # prints the command for the other device
```

Run the printed `bogen peer add ...` on the other device. One command pairs both ways.
`bogen peer pair` also turns the Tailscale listener on and saves that, so the service
keeps it without the flag; `bogen peer tailnet off` turns it off again. If Tailscale
comes up after the service, the listener follows.

The listener binds only to the address from `tailscale ip -4`, and everything on it
needs the device's token. Check with `bogen peer status`. The panel of the bar widget
shows the other device next to the file count.

## Updating another device

```bash
integrations/omarchy/deploy.sh <ssh-host> --dry-run   # says what it would do, changes nothing
integrations/omarchy/deploy.sh <ssh-host>             # or: bogen peer deploy <ssh-host>
```

This copies the current build and this folder to `~/.local/share/bogen-app` there, finds
Node (`mise where node`, and installs it through mise only if there is none), runs
`install.sh --tailnet` with the session's variables read from the running shell, restarts
the service, and reports the version that answers. It is safe to run again. Paired devices
tell each other their version, and `bogen peer status`, `bogen doctor` and the sync indicator
in the editor say so when they differ.

## Screenshots

`bogen-place-screenshot` puts the newest screenshot on the canvas. With `--pick` you choose
one in Omarchy's image picker, from your screenshot folder or the folder you name.

## Publishing the plugin

`omarchy plugin add <git-url>` wants `manifest.json` at the root of the repository
and takes no subfolder, so `integrations/omarchy/plugin/` is laid out as that root.
Publish it as its own repository, which also keeps the whole monorepo out of
`~/.config/omarchy/plugins`:

```bash
git subtree split --prefix=integrations/omarchy/plugin -b omarchy-plugin
git push <plugin-repo-url> omarchy-plugin:main
```

People then install the widget alone with
`omarchy plugin add <plugin-repo-url> --enable`, and `omarchy plugin update` follows
new pushes. The installer leaves a plugin that came through git to that command.
