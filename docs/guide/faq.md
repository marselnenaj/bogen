# Frequently asked questions

Short answers, each from a guide that goes into detail.

## What is Bogen?

An open source design canvas where every design is real HTML and CSS. You draw on it in the browser,
and your own coding agent draws on it through an MCP server. See the [overview](README.md).

## What does it cost?

Nothing. Bogen is free software under the GNU GPL, version 3 or later, with no account, subscription or usage cap. Agent work runs on the
plan you already have for Claude Code or Codex, or whatever your own MCP client uses. The one thing
that can cost money is the usage of your agent's plan, which you start.

## Which agents work with it?

Any MCP client. `bogen install` sets up Claude Code, Codex, Cursor, VS Code, OpenCode, Gemini CLI and
Zed. Claude Code and Codex have been set up and run for real; the others follow their documented config
formats and have not been tried with the apps yet. Any other client connects to `bogen mcp` or to
`http://127.0.0.1:29990/mcp`. See [Agents](agents.md).

The chat beside the canvas (Ctrl+K) and mentions in comments start Claude Code or Codex, the two CLIs Bogen knows
how to run.

## Do I need an API key?

No. Bogen calls no model itself, and has no image generator. The chat and comment runs use
your logged-in `claude` or `codex` CLI.

## Where do images come from?

From your agent. It draws them as inline SVG or CSS, or makes them with its own image tool, such as
Codex's built-in image generation or an image MCP server you added, and stores the file with
`asset_upload`. You can also place, paste or drop your own. For a draft, an image with no source
shows as a placeholder frame with its size. See [Images and media](canvas.md#images-and-media).

## Does it work offline?

Yes, for everything on your machine: the canvas, your files, your agent's tools, renders and exports.
Fonts from Google Fonts need the network; without it, text in those fonts falls back to another
font. Fonts installed on your machine, and fonts Capture kept in a file, need none. Your agent itself needs whatever its provider needs. See
[Privacy](privacy.md).

## Does it send my designs anywhere?

Files are stored in your data folder and Bogen sends no telemetry. Your chosen agent provider receives the request, effective design guidance and the tool results it needs, including screenshots. Sync and publishing are optional; the server listens on this machine unless you enable another connection. [Privacy](privacy.md) lists every network request Bogen makes and
when.

## What does it run on?

**Arch Linux with Omarchy desktop.** That is what this release is built for and tested on.

The phone companion connects to Bogen on your own computer; it is not a standalone mobile design server. Omarchy Mobile themes and independent plugin/widget runtimes remain experimental and are not required for the desktop release.

## Can my team use it together?

Several people can work in one file at the same time, with cursors, selections, comments and follow.
For that they reach your server: `bogen serve --host <address> --token <secret>` makes it listen
beyond this machine, with one shared token. There are no accounts, roles, per-file permissions, share
links or single sign-on yet.

Between your own devices, [device sync](devices.md) keeps the same files on each.

## Where are my files?

In `~/.local/share/bogen` (or `$XDG_DATA_HOME/bogen`, or `$BOGEN_HOME`). Each file is a document in
`files/`, images and fonts in `assets/`, history in `history/`. To take one with you, download it as a
`.bogen` file from the home screen, or write it as a [design folder](history.md#design-folders-and-git)
for Git.

## How does it relate to Figma?

They are different tools. Figma has its own document format; in Bogen every layer is an HTML element
with CSS. Bogen can [import a Figma file](capture-and-import.md#import-from-figma) through Figma's
public REST API with your own token, and many Figma keyboard shortcuts work as aliases. It does not
read Figma's clipboard or `.fig` files.

## How does it relate to Paper?

Paper is a separate design tool. Bogen is written from scratch, with its own tool names, schemas and
formats. Its shader layers use the `@paper-design/shaders` library, which is Apache-2.0 licensed.

Bogen is an independent project, not affiliated with Figma or Paper.

## How finished is it?

Version 0.1.0 is the first version. The guides say where a feature works only in part, and the
[changelog](changelog.md) lists what is in this version.

## Is there a browser extension for Capture?

No. Capture runs from the command line, from your agent and over HTTP. See
[Capture](capture-and-import.md).

## Can an agent do something I did not ask for?

An agent can do what its tools allow in your files, as it could in your editor. Bogen limits the rest:
runs started from the canvas get Bogen's tools only, with no shell or file access; nothing written in a
document, a comment or a brand starts a process; agents leave locked layers alone; and every agent
step can be undone on its own. Work you want to review first can go into a
[proposal](agents.md#proposals-review-before-it-counts).
