# Bogen

**Give your agent a canvas.**

Bogen is an open-source design tool where you and your coding agent edit the same canvas. Every layer is real
HTML and CSS. Connect Claude Code, Codex or another MCP client, then work on a website, an app interface or an
Omarchy theme together.

It runs on your machine and uses your existing agent plan. Bogen adds no subscription or MCP usage quota;
your agent provider's billing and limits still apply. **The first release is made for Omarchy desktop.**

[Website](https://bogen.dev) · [Quickstart](#quickstart) · [Documentation](docs/guide/README.md) ·
[What's new](docs/guide/changelog.md)

<img src="assets/readme/editor.png" alt="Bogen's editor showing an editable brand system, with the colour palette selected and its layout and styles in the inspector." width="100%">

## Quickstart

On Omarchy, with **Node 22.18 or newer** and a Chromium-based browser installed:

```sh
curl -fsSL https://bogen.dev/install.sh | bash
bogen install claude-code    # For Codex, use: bogen install codex
bogen open
```

The installer verifies the release checksum and signature, installs for your user, and sets up the Omarchy
launcher, bar widget and background service. It never uses `sudo`. [Read the script](install.sh), or pass
`--no-omarchy` to skip the desktop integration.

Start a new session in your connected agent and ask:

```text
Design a pricing page in Bogen. Check the desktop and phone layouts.
```

Keep the canvas open to see the work and edit it yourself. Or press **Ctrl+K** in Bogen to run your installed
Claude Code or Codex from the canvas. A comment mentioning `@claude` or `@codex` can start a run too.

**Want your agent to handle setup?** Give it this:

> Set up Bogen for me: https://bogen.dev/agent

If something is missing, `bogen doctor` checks the setup and prints the fix without changing anything.
You can also explore four example designs and 20 theme templates by hand, without an agent login.
[Getting started](docs/guide/getting-started.md) walks through the first file.

<details>
<summary>Build from source</summary>

```sh
git clone https://github.com/marselnenaj/bogen.git
cd bogen
npm install
npm run build
alias bogen="node $PWD/packages/server/dist/cli.js"
bogen open
```

See [Building](docs/building.md) for development servers and [Contributing](CONTRIBUTING.md) for checks.

</details>

## Work on the same design

Your agent connects through MCP and works on the actual layers. You can move things, edit text or change styles
while it works. It can take screenshots of the result and run design checks before handing it back.

For a larger change, the agent can place a proposal beside the current design. Compare the two and decide what
stays. Agent edits have their own undo, so reverting an agent's work does not undo yours.

Claude Code and Codex have been tested with real runs. Other MCP clients can use `bogen mcp` over stdio or connect
to `http://127.0.0.1:29990/mcp`. The [agent guide](docs/guide/agents.md) lists the setup commands and which clients
have been tried. The [MCP reference](docs/guide/reference/mcp-tools.md) lists the tools.

## Keep a brand book your agents can use

A brand in Bogen holds the logo, visual rules and voice of a product. Its brand book records the decisions behind
those rules, with sources and open questions. Agents can read it before starting another screen.

Link designs to the brand to share its tokens, fonts and rules. Review an agent's suggested changes before making
them binding. The book can be exported as editable Markdown; the PDF contains the visual foundation and chapter
index. [Brands and brand books](docs/guide/brand.md)

The agent's design guidance is editable too. Bogen includes **16 design playbooks** for different kinds of work.
Change their `SKILL.md` files in Settings when you want your agents to follow different instructions. Built-in
canvas runs receive the relevant playbook before they start; external agents can read it through MCP.
[Design guidance](docs/guide/design-knowledge.md)

## Check responsive layouts and export the layers

Preview the same design at desktop and phone widths, side by side. Edit its breakpoints and use the checks to find
overflow, clipped content or text that is too small. Because the layers are HTML and CSS, the previews use real
browser layout, including media and container queries. [Responsive design](docs/guide/canvas.md#responsive-variants)

Export a screen or a selected layer as **HTML, React or React with Tailwind**. Image, SVG, PDF and video exports are
available too. Your development tools build and run the application. [Export and code](docs/guide/export-and-code.md)

## Design an Omarchy theme

Open **Themes → Omarchy Desktop** on the home screen. Start a new theme, use an installed theme as a starting
point, or pick one of **20 included Bogen templates**. These are Bogen's own templates, with AI-generated artwork
for landscape and portrait displays; community-theme repositories are not bundled. The artwork is provided under
CC0. [Asset origins](ASSET_PROVENANCE.md)

With an agent connected, try:

```text
Make an Omarchy theme in Bogen, starting from the theme I have installed.
```

The palette and desktop previews stay together on the canvas. Changing a colour token updates the previews.
Landscape and portrait wallpapers have their own compositions.

Install the finished theme from the theme dialog, then choose when to apply it. **Undo apply** returns to your
previous theme. You can also export a standard Omarchy theme folder or Git repository to share.
[Theme workflow and installation](docs/guide/omarchy.md#design-a-theme)

## Pick up the work on another computer

Pair your desktop and laptop over **Tailscale** to sync designs, brands and assets directly between them. There is
no Bogen cloud in between. Changes made offline sync when the devices reconnect, with conflicting text kept for
review.

Start pairing on one computer:

```sh
bogen peer pair --name Desktop
```

Run the command it prints on the other computer. Both need Bogen and Tailscale installed. Agent runs and personal
design-skill overrides stay on their own device. [Device sync](docs/guide/devices.md)

A phone can act as a companion for reviewing proposals and leaving comments on the Bogen server running on your
computer. [Phone setup](docs/guide/devices.md#iphone-and-ipad)

## Compare a design with the running app

[Tomacco](https://tomacco.dev) is a sibling project that builds, runs and tests Android and iOS apps on Linux.
Bogen can import a screen from a running app as editable layers and compare it with a design using a side-by-side
view, overlay or difference view.

An agent connected to both tools can work from the design to the app and bring the screen back for comparison.
Neither tool requires the other. [Bogen and Tomacco](docs/guide/tomacco.md)

## More ways to work

| Task | Guide |
| --- | --- |
| Bring a live website onto the canvas as editable layers | [Capture and import](docs/guide/capture-and-import.md) |
| Reuse components across designs | [Components and libraries](docs/guide/components.md) |
| Review changes, branch a design or keep it in Git | [History](docs/guide/history.md) |
| Share a design for review | [Sharing](docs/guide/sharing.md) |
| Find a command or troubleshoot setup | [CLI reference](docs/guide/reference/cli.md), [Troubleshooting](docs/guide/troubleshooting.md) |

The [documentation index](docs/guide/README.md) lists every guide.

## How it runs

`bogen` is one Node program. It stores your designs in `~/.local/share/bogen`, serves the browser editor at
`http://127.0.0.1:29990`, and exposes the MCP tools. Your installed Chromium-based browser renders screenshots and
exports.

## Requirements

| | |
| --- | --- |
| System | Linux. Developed and tested on Arch Linux with Omarchy, on x86_64 and aarch64. |
| Node | 22.18 or newer |
| Browser | Chromium, Chrome, Brave or Edge on your `PATH`, or its path in `BOGEN_BROWSER`. Without one the canvas and MCP tools work, but nothing can be rendered or exported. |
| Optional | `ffmpeg` for video and AVIF export; the `claude` or `codex` CLI for agent runs; Tailscale for device sync and the phone |
| For `bogen omarchy install` | `omarchy`, `jq` and `curl` |

<details>
<summary>Install locations and desktop changes</summary>

- The install script adds the package in `~/.local/share/bogen-app` and the `bogen` command in `~/.local/bin`. On
  Omarchy it then runs `bogen omarchy install`, described below.
- Your files live in `~/.local/share/bogen` (or `$XDG_DATA_HOME/bogen`, or `BOGEN_HOME`).
- `bogen install <client>` adds one MCP entry to that client's config, and a skill file for Claude Code and Codex.
- `bogen omarchy install` writes into `~/.config/hypr`, `~/.config/omarchy`, `~/.config/systemd/user` and
  `~/.local/bin`: a user service, a launcher entry, a bar widget, theme and font hooks, a `.bogen` file type, and
  window rules and keys for Hyprland. Keys are checked against `hyprctl binds` and never replace an existing
  binding. Anything it replaces that it did not write is backed up to `~/.local/state/bogen/backups/` first, and
  `--dry-run` prints every step without changing anything. It does not use `sudo` unless you pass `--tailnet`,
  which offers to open the firewall for device sync. The [Omarchy guide](docs/guide/omarchy.md#install) lists
  every path.

</details>

<details>
<summary>Uninstall Bogen</summary>

Three steps, in this order. The first two need the `bogen` command, so the package goes last.

```sh
bogen uninstall claude-code codex    # 1. every client you connected
bogen omarchy uninstall              # 2. only if you ran bogen omarchy install; --dry-run shows the steps
bogen stop                           # 3. stop the server, then remove the package and the command:
rm -r ~/.local/share/bogen-app ~/.local/bin/bogen
```

What stays behind, on purpose:

- your designs in `~/.local/share/bogen`,
- the installer's backups in `~/.local/state/bogen/backups/`,
- caches in `~/.cache/bogen/`,
- any themes you installed into `~/.config/omarchy/themes`,
- the firewall rule, if you opened one for device sync. `bogen omarchy uninstall` prints the `ufw` command that
  removes it.

Delete those yourself if you want them gone.

</details>

## Security and privacy

- **Local only.** The server listens on `127.0.0.1:29990`. There is no login for your own user: any program you run
  can use it. Other users of the machine, other web pages and DNS rebinding are refused.
- **An agent acts as you inside Bogen.** A connected agent can change every Bogen file and export files under your
  home folder. It can install a theme, but it cannot apply or replace one, start agent runs or publish anything.
  Every agent change can be undone.
- **No telemetry.** Bogen sends no usage statistics or crash reports. Once a day the server fetches one public file
  from GitHub to see whether a newer release exists; `bogen update off` turns that off.

[Privacy](docs/guide/privacy.md) lists every network request Bogen makes. [SECURITY.md](SECURITY.md) describes each
listener and how to report a vulnerability privately.

## Status

Bogen 0.1.0 is the first release. It is developed and tested on Arch Linux with Omarchy, on x86_64 and aarch64.

<details>
<summary>Known limits and untested integrations</summary>

Bogen 0.1.0 is the first version. It is maintained by one person.

- **Tested on Arch Linux with Omarchy only.** The server and editor need nothing from Omarchy and may run on other
  Linux systems, but that has not been tried.
- **Agents:** Claude Code and Codex are tested with real runs. The other clients follow their documented config
  formats and have not been tried with the apps.
- **Themes:** the portrait background plugin for rotated monitors is experimental. Bogen does not create intro
  videos for a theme; it keeps the ones a theme already has.
- **Figma import** was built from Figma's public API documentation and has not run against the real API.
- **Phone:** the phone is a companion to Bogen on your computer, reached over Tailscale; it does not run Bogen
  itself. Tried on an iPhone, not on an iPad or Android.
- **Device sync** between two machines works over Tailscale; both sides editing while disconnected has been tested
  on one machine only.
- **Not there:** team accounts and roles, a desktop app, a browser extension for Capture, `.fig` files.

Each guide says where a feature works only in part, and the [feature matrix](docs/SPEC.md#feature-matrix) marks
every item as done, partly there or open.

</details>

## Contributing

Issues and pull requests are welcome; for a larger change, open an issue first. [CONTRIBUTING.md](CONTRIBUTING.md)
has the build and test commands and the rules for changes, and [Architecture](docs/architecture.md) explains how
the packages fit together. A report of what happened when you tried Bogen on a system or client listed above as
untested is a useful contribution.

## License

Copyright (C) 2026 Marsel Nenaj and Bogen contributors.

Bogen is free software: you can redistribute it and modify it under the terms of the **GNU General Public License,
version 3 or (at your option) any later version**; see [LICENSE](LICENSE). Designs, code and themes you make with
Bogen are yours: the [exception for exported work](LICENSE-EXCEPTION.md) lets you use the code Bogen writes into your
exports under terms of your choice. The Omarchy bar plugin in
`integrations/omarchy/plugin` and the portrait background files Bogen derives from Omarchy stay under the MIT
license, like Omarchy itself. The bundled theme artwork is dedicated to the public domain under CC0 1.0, so themes
made from it can be published under any terms. Third-party packages keep their own licenses,
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Asset origins and generated-art disclosure are in [ASSET_PROVENANCE.md](ASSET_PROVENANCE.md).

<details>
<summary>Legal notice and third-party components</summary>

- **Independent.** Bogen is an independent project. It is not affiliated with, endorsed by or sponsored by Paper
  (Lost Coast Labs) or Figma, and is independent of Omarchy. Names identify compatible tools.
- **Clean room.** Bogen is written from scratch, from public documentation, web standards and permissively licensed
  packages, with its own MCP tool names, schemas and file format. The Paper Desktop app and its bundles, and any
  reverse engineered clone of a design tool, were never read, copied or used as a source. The rule is in the
  [spec](docs/SPEC.md#clean-room-rule).
- **Shaders.** Shader layers use `@paper-design/shaders` and `@paper-design/shaders-react`, under the Apache License
  2.0. Their license and NOTICE are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Figma import** uses Figma's public REST API with your own personal access token.
- **No warranty.** Bogen is supplied without warranty, as the GNU General Public License states.

</details>
