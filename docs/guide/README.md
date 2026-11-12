# Bogen documentation

Bogen is an open source design canvas where every design is real HTML and CSS. You draw on it in
the browser, and your own coding agent draws on it too, through Bogen's MCP server. Claude Code and
Codex run on the plan you already pay for. There is no account, no subscription and no usage cap.

These guides describe version 0.1.0. Where a feature works only in part,
the page says what is missing.

## How the pieces fit

| Piece | What it does |
| --- | --- |
| `bogen` | One command-line program. It runs the server, sets up your agents and does imports and exports from the terminal. |
| The server | Runs on your machine at `http://127.0.0.1:29990`. It keeps your files in a data folder, serves the editor, and renders screenshots and exports in a headless Chromium browser. |
| The editor | The canvas, in your browser. Several windows, people and agents can have one file open at the same time. |
| The MCP server | Tools, resources and prompts, all listed in the [MCP tool reference](reference/mcp-tools.md), at `bogen mcp` (stdio) or `/mcp` (HTTP). Your agent uses them with no editor open. |
| Device sync | Optional. Two of your own machines keep the same files over Tailscale. |
| Omarchy integration | Optional. Bar widget, theme following, a designer for your own Omarchy themes, launcher, keys and a user service. |

A design is a tree of layers, and each layer is an HTML element with CSS. What you see on the canvas,
what your agent sees in a screenshot and what you export come from the same rendering.

## Where to start

| I want to... | Read |
| --- | --- |
| Install Bogen and make a first file | [Getting started](getting-started.md) |
| See the welcome file again, or start from an example | [Getting started](getting-started.md#3-make-a-first-file) |
| Connect Claude Code, Codex or another MCP client | [Agents](agents.md) |
| Set up this device and edit your design skills | [Settings](settings.md) |
| Learn the canvas: frames, layout, text, vectors, tokens, preview, motion | [Canvas](canvas.md) |
| Use `::before`, `::after`, container and media queries, hover and other states | [Pseudo-elements and conditions](pseudo-and-conditions.md) |
| Reuse things: components, variants, slots, shared libraries, code components | [Components](components.md) |
| Set up a brand, and check designs against it | [Brands](brand.md) |
| Use and customize design playbooks, skills and bounded verification | [Design knowledge](design-knowledge.md) |
| Copy a live website onto the canvas, or import from Figma | [Capture and import](capture-and-import.md) |
| Export images, PDF, video, SVG or code | [Export and code](export-and-code.md) |
| Publish a design as a static website | [Export and code](export-and-code.md#publish) |
| Send a client a review link, and read their comments | [Sharing for review](sharing.md) |
| See who changed what, go back, branch, replay how a page was built, or keep a design in Git | [History](history.md) |
| Keep my files on two machines | [Devices](devices.md) |
| Bring a real app screen in from Tomacco, or compare a design with the app | [Tomacco](tomacco.md) |
| Use Bogen on Omarchy | [Omarchy](omarchy.md) |
| Design your own Omarchy theme | [Omarchy, Design a theme](omarchy.md#design-a-theme) |
| Fix something | [Troubleshooting](troubleshooting.md) |
| Get short answers: cost, which agents, what it runs on, Figma | [FAQ](faq.md) |
| See what leaves my machine | [Privacy](privacy.md) |
| Look up a command, a tool or an HTTP route | [Reference](reference/README.md) |
| See what is in this version | [Changelog](changelog.md) |

Bogen is free software under the GNU General Public License, version 3 or later. It is an independent project and is not affiliated with Figma or Paper.

This release targets **Omarchy desktop**. Standalone mobile releases are separate work. Omarchy Mobile theme packaging remains experimental.
