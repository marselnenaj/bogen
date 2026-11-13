# Getting started

This page takes you from nothing to a running canvas, a first file and a first agent call.

## What you need

- **Node 22.18 or newer.** Check with `node --version`.
- **A Chromium-based browser:** Chromium, Chrome, Brave or Edge. Bogen finds it on your `PATH`. The server uses it, headless, for screenshots, exports and the
  checks your agent runs. Without one, the canvas and the MCP tools still work, but nothing can be
  rendered. Set `BOGEN_BROWSER` to its path if Bogen does not find it.

Optional:

- **ffmpeg**, for video export when the browser cannot encode, and for AVIF with transparency.
- **Claude Code or Codex**, for the chat beside the canvas and for `@claude` and `@codex` in comments.
- **Tailscale**, to [sync with your other devices](devices.md).

This release targets **Omarchy desktop on Arch Linux**. The phone is a companion to your own host, not a standalone mobile server; see the [FAQ](faq.md#what-does-it-run-on).

## 1. Install

### Availability

The [README](../../README.md#quickstart) has the install command for the published package. To run Bogen from source instead, use a checkout.

### From a checkout

In a checkout of the repository:

```sh
npm install
npm run build
```

The command is then `node packages/server/dist/cli.js`. The examples in these guides write `bogen`
for it; make an alias, or on Omarchy let `integrations/omarchy/install.sh` put a `bogen` wrapper in
`~/.local/bin` (see [Omarchy](omarchy.md)).

To make the npm package yourself, run `npm run release:npm`. It prints the path of a
`bogen-design-<version>.tgz`, which `npm i -g` installs.

## 2. Open the canvas

```sh
bogen open
```

This starts the server in the background if it is not running, and opens
`http://127.0.0.1:29990` in your browser. The server only listens on this machine.

Other ways to run it:

| Command | What it does |
| --- | --- |
| `bogen start` | Start the server in the background. |
| `bogen stop` | Stop it. |
| `bogen status` | Say whether it runs, its version, and which agents are active. |
| `bogen serve` | Run it in the foreground, until Ctrl+C. |

`--port` (or `BOGEN_PORT`) picks another port. When a user service for Bogen is installed, as on
Omarchy, `bogen start` and `bogen open` start that service instead of a second server.

Your files live in `~/.local/share/bogen`, or `$XDG_DATA_HOME/bogen`. Set `BOGEN_HOME` to use
another folder. The background server writes its log to `server.log` there.

## 3. Make a first file

The first time Bogen starts with an empty data folder, it makes one file, **Welcome to Bogen**. It
says in one page what Bogen is, how to connect your agent, how to ask it in a comment, what a brand
is, the keys to start with and how to use your phone. Delete it when you are done: it does not come
back by itself. `bogen welcome`, or **Help** (the question mark at the top right of the editor),
then **Welcome to Bogen**, opens it again, and makes a new one if it is gone.

On the home screen, choose **New file** (or press N). The file opens with one empty page.

- Press F and drag to draw a frame. A frame is a `<div>`; frames hold other layers.
- Press T and click to add text.
- Select a frame and press Shift+A to give it flex layout, so that what is inside lines up in a
  row or column.
- Press Ctrl+/ for every keyboard shortcut, and Ctrl+P for the command palette.

The right panel has the inspector (Design), the code of the selection (Code), Export, History,
comments, motion and the Agents tab. The left panel has layers, tokens, assets and the brand.

[Canvas](canvas.md) goes through all of it.

### Start from an example

**Start from an example** on the home screen makes a finished design to take apart or build on:

| Example | What it is |
| --- | --- |
| Couchette | A landing page for a sleeper train company, at 1440 and 390 |
| Crux | Four app screens of a bouldering logbook, at 393 x 852 |
| Laneway | A six-slide pitch deck for cargo bike deliveries, at 1920 x 1080 |
| Second Shelf | Social images for a used bookshop, at 1200 x 630 and 1080 x 1080 |

Each comes with a small brand of its own, made with the same tools as your brands: colours, type,
logo, rules and voice. Choosing one makes that brand under **Brands** (or uses the one it made
before) and a new file linked to it, drawn in the brand's tokens. The companies, prices and numbers
are made up. Your agent finds the same examples with `template_list` and makes one with
`template_use`.

## 4. Connect your agent

The install script ends with this step. To run it again, for instance after installing another agent:

```sh
bogen setup
```

It lists the agents it finds on this computer, says which ones have Bogen already, and asks to
connect each of the others (Enter means yes). Running it again is safe. Without a terminal it asks
nothing and prints the commands. `--agents claude-code,codex` (or `all`, or `none`), or the same in
`BOGEN_AGENTS`, connects those without asking. To connect one client by name:

```sh
bogen install claude-code     # or codex, cursor, vscode, opencode, gemini, zed, grok, hermes, omp, or --all
```

A session that was open before does not have Bogen's tools yet: restart the agent or start a new
session. In Claude Code and Codex, `/mcp` then lists `bogen`. Ask your agent, in its own window:
"Design a pricing page in Bogen." Keep the canvas open to watch it draw. [Agents](agents.md)
explains what it can do, and how to undo what it did.

If your agent installs Bogen for you, it runs the script with `BOGEN_AGENTS` set to its own client,
checks with `bogen doctor`, and asks you to restart the session. The steps it follows are at
[bogen.dev/agent](https://bogen.dev/agent).

If you have the `claude` or `codex` CLI installed, you can also stay in the canvas: press Ctrl+K,
type what you want, and Bogen runs your CLI with only Bogen's tools.

## 5. Check the setup

```sh
bogen doctor
```

This checks Node, the data folder, the service, the server and its version, the editor, the browser
(it renders a test image), Tailscale, the firewall, paired devices, the `claude` and `codex` CLIs
and each MCP client it finds. Every problem comes with the command that fixes it. It changes
nothing. See [Troubleshooting](troubleshooting.md).

## Updating and removing

- **Installed with the script:** `bogen update apply` checks the newer release's signature and installs it; running
  the install script again does the same. `rm -r ~/.local/share/bogen-app ~/.local/bin/bogen` removes it.
- **Checkout:** pull, then `npm install && npm run build`, and restart the server with
  `bogen stop && bogen start` (or `systemctl --user restart bogen` with the user service).
  `bogen status` says when the running server is another build than the command.

Removing Bogen leaves your designs in the data folder. To take Bogen out of an MCP client, run
`bogen uninstall <client>`.
