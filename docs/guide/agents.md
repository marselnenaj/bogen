# Agents

Bogen has no model of its own. Your coding agent does the agent work, with the account and plan you
already have. There are two ways in:

- **Your agent connects to Bogen.** You work in Claude Code, Codex or another MCP client, and it
  draws through Bogen's MCP tools. It can work with no editor open.
- **Bogen starts your agent.** From the chat beside the canvas (Ctrl+K), or a comment that mentions `@claude` or
  `@codex` runs your own `claude` or `codex` CLI with only Bogen's tools.

## Connect a client

In the desktop inspector, **Agents** separates everyday work from setup:

- **Activity** shows the queue and Stop controls, changes, run history and reports.
- **Settings** holds model defaults, client connection commands and the optional real-agent check.
- **Devices** holds sync, agents on other computers and phone pairing.

The agents in the current file and the follow switch stay above these views. Opening a file or
switching views does not start an agent check or a model run. Inspector tabs wrap to stay reachable
in a narrow sidebar; use the arrow keys, Home or End while a tab has keyboard focus.

```sh
bogen setup
```

`bogen setup` finds the clients below on this computer, shows which ones have Bogen, and asks to
connect each of the others; Enter means yes. The install script runs it at the end. It asks only at a
terminal: elsewhere it prints the `bogen install` command for each client instead.
`--agents claude-code,codex`, `--agents all` (every client it finds) or `--agents none`, or the same
in `BOGEN_AGENTS`, answers without a question. It ends with what to do next. To connect one client
by name:

```sh
bogen install claude-code
```

A client reads its MCP servers when a session starts, so a session that was open before does not have
Bogen's tools: restart the client or start a new session. In Claude Code and Codex, `/mcp` then lists
`bogen`.

An agent that installs Bogen for a person runs the script with its own client named, then checks:

```sh
curl -fsSL https://bogen.dev/install.sh | BOGEN_AGENTS=claude-code bash
bogen doctor
```

and tells the person to restart the session, since its own session started before Bogen was there.

| Client | What `bogen install` does |
| --- | --- |
| `claude-code` | Runs `claude mcp add --scope user bogen`, or edits `~/.claude.json` when `claude` is not on the `PATH`. Writes the Bogen skill. |
| `codex` | Runs `codex mcp add bogen`, or edits `config.toml` in `$CODEX_HOME` (default `~/.codex`). Writes the Bogen skill. |
| `cursor` | Edits `~/.cursor/mcp.json`. |
| `vscode` | Runs `code --add-mcp`, or edits `Code/User/mcp.json` in your config folder. |
| `opencode` | Edits `~/.config/opencode/opencode.json`. |
| `gemini` | Runs `gemini mcp add --scope user bogen`, or edits `~/.gemini/settings.json`. |
| `zed` | Edits `~/.config/zed/settings.json`. |
| `grok` | Runs `grok --no-auto-update mcp add bogen -- bogen mcp`. Needs `grok` on the `PATH`. |
| `hermes` | Runs `hermes mcp add bogen --command bogen --args mcp`. Needs `hermes` on the `PATH`. Status reads `$HERMES_HOME/config.yaml` (default `~/.hermes`) and says "not known" for YAML it does not follow. |
| `omp` | Edits Oh My Pi's user `mcp.json` in `~/.omp/agent`, or in `PI_CODING_AGENT_DIR`. With a named profile (`OMP_PROFILE`) or only `PI_CONFIG_DIR` set it refuses rather than guess the folder. |

`bogen install --all` sets up every client it finds on this machine and skips the rest. Edits keep
the comments and formatting of your config files, and a file that cannot be read as JSON is left
alone. Running it again is safe.

Claude Code and Codex have been set up for real this way. For the other clients the entries follow
their documented config formats, but have not been tried with the apps themselves. Grok, Hermes and
Oh My Pi are tested against stand-in CLIs in a temporary home only.

Registering a client is about using Bogen from that client. Which CLIs Bogen starts itself, from the
canvas, is a separate list: see [Which agents Bogen runs](#which-agents-bogen-runs).

### Add to agent, in Settings

Settings (Ctrl+,) → **Agents** → **Add to agent** lists the clients `bogen setup` finds on this computer,
whether Bogen is in each, and the tool list each would get. **Connect** does what `bogen install
<client>` does, and the row says why when it could not; **Connect again** writes the entry and the
skill anew, as after an update. The clients that are not here are named below the list. It works only
from this computer: the server refuses these requests from a phone, a paired device or another site.

To take Bogen out again:

```sh
bogen uninstall claude-code
```

The client starts `bogen mcp`, which talks to the local server and starts it when it is not running.
If `bogen` is not on your `PATH`, the entry names Node and the exact script instead.

### Plugins

Instead of `bogen install`, Claude Code, Codex and Claude Desktop can take Bogen as a plugin. Each one
brings the MCP server entry and, for the two coding agents, the Bogen skill. None bundles Bogen itself:
install it first with the script above, and use either the plugin or `bogen install` for a client,
not both (`bogen uninstall <client>` takes the other out).

- **Claude Code.** `/plugin marketplace add marselnenaj/bogen`, then `/plugin install bogen@bogen`. The
  repository's `.claude-plugin/marketplace.json` lists the plugin in `integrations/claude-code`: its
  `.mcp.json` starts `bogen mcp` with the full tool list, and its skill is the one `bogen install`
  writes.
- **Codex.** `codex plugin marketplace add marselnenaj/bogen`, then `codex plugin add bogen@bogen`. The
  marketplace is `.agents/plugins/marketplace.json`, and the plugin in `integrations/codex` uses the
  portable Agent Plugins layout (`plugin.json`, `mcp.json`, `skills/`).
- **Claude Desktop.** Each release from this version on has `bogen-<version>.mcpb`, with a `.sha256`
  and a `.sig` like the other assets (`bogen verify` checks them). Open it with Claude Desktop. It
  starts `~/.local/bin/bogen mcp`, the command the install script writes, and its settings have a
  **Tool list** field for `full`, `compact` or `grouped`. `node scripts/build-mcpb.mjs` packs it from
  `integrations/claude-desktop`.

Every plugin starts the stdio command, which talks to the server on this computer only. The files are
written by `npx tsx scripts/gen-plugins.ts` from the server's own skill text and version. They pass
`claude plugin validate` (Claude Code 2.1.319), `mcpb validate` and `mcpb info` (`@anthropic-ai/mcpb`
2.1.2), and Codex 0.166 adds the marketplace, installs the plugin and lists its `bogen` server, in a
temporary `CODEX_HOME`. A real session through a plugin, and Claude Desktop opening the extension,
have not been tried yet. The extension is not signed with an MCPB certificate, so Claude Desktop
shows it as unsigned; the release's own signature covers it.

### Other clients

Any MCP client can connect in one of two ways:

- **stdio:** the command `bogen mcp`.
- **Streamable HTTP:** `http://127.0.0.1:29990/mcp`.

A server started with `--token` needs `Authorization: Bearer <token>` on HTTP, or `BOGEN_TOKEN` in
the environment of `bogen mcp`. `BOGEN_URL` points `bogen mcp` at a server elsewhere.

An agent shows up in Bogen under the name of its MCP client. A client can set its own with the
`X-Bogen-Agent` header.

### A shorter tool list

The full tool list is every tool with its whole schema. A client that sends every schema with each
request pays for that on every turn, and some stop at a number of tools. Pick a shorter list with
`bogen mcp --tools <mode>`, `BOGEN_MCP_TOOLS` in the server entry's environment, or, over HTTP,
`http://127.0.0.1:29990/mcp?tools=<mode>` or the `X-Bogen-Tools` header:

| Mode | Tools | `tools/list` response |
| --- | --- | --- |
| `full` (the default) | One per tool, 208, with every description. | about 270 KB |
| `compact` | One per tool, each description its first sentence, arguments without descriptions, and annotations equal to MCP's defaults left out. | about 117 KB |
| `grouped` | 19 area tools, such as `edit`, `brand` or `checks`. Each takes `operation`, a tool's name, and `arguments`, that tool's own arguments. Its description lists the area's tools with their required arguments, split into read-only, writes and destructive. | about 19 KB |

Sizes are of this version, measured by `packages/server/test/tool-modes.test.ts`. Nothing is taken
away: in `compact` and `grouped` there is also a `schema` tool that answers any tool's whole schema,
as does the resource `bogen://reference/{tool}`; calling a tool by its own name works in every mode;
`batch` steps and the guides use the same names. A grouped tool's annotations are its area's
strictest: `destructiveHint` when any of its tools deletes something, so a client that asks before
destructive tools asks for the whole area. An unknown value is the full list, with a warning on
standard error.

`bogen install` writes the list that suits each client:

| Client | Default | Why |
| --- | --- | --- |
| `claude-code` | `full` | Claude Code defers MCP tools and finds them with its tool search, so only the names cost context ([docs](https://code.claude.com/docs/en/mcp)). |
| `codex` | `full` | Codex uses tool search for MCP tools by default since 0.142.2, on the models that support it ([release](https://github.com/openai/codex/releases/tag/rust-v0.142.2)). On an older model or another provider, use `--tools compact`. |
| `opencode` | `compact` | OpenCode sends MCP tools to the model, by default through Code Mode, where the agent calls them by name from code; its docs warn that tools use context ([docs](https://opencode.ai/docs/mcp-servers/)). Every name stays, with short schemas. |
| `cursor` | `grouped` | Cursor keeps tool names in the prompt and reads descriptions on demand, but a limit on MCP tools is still shared between its CLI and editor ([blog](https://cursor.com/blog/dynamic-context-discovery)). |
| `vscode` | `grouped` | A chat request has at most 128 tools ([docs](https://code.visualstudio.com/docs/agents/run/tools)); 208 would set off its experimental virtual tools. |
| `gemini` | `grouped` | Gemini CLI registers every tool it finds ([docs](https://geminicli.com/docs/tools/mcp-server/)), and Gemini's function calling takes at most 128 declarations per request. |
| `zed`, `grok`, `hermes`, `omp` | `grouped` | Their docs describe registering every tool, and none describes loading schemas on demand. |

`bogen install <client> --tools <mode>` writes another one. These defaults follow each client's
documentation; only Claude Code and Codex have been run against Bogen.

**Reviewer profile.** `bogen mcp --profile reviewer` (or `BOGEN_MCP_PROFILE=reviewer`,
`?profile=reviewer`, `X-Bogen-Profile: reviewer`) gives a session the scope of a
[critique](#critique): the read-only tools, `comment_add` and `comment_reply`, and `design_lint`,
`brand_check` and `file_open` with fixes off, about 92 KB in full. A tool that changes the design is
not listed, and a call to one is refused with the reason, also through a grouped tool. It combines
with every mode, for a second agent that only reviews.

### Agents in the browser (WebMCP)

An agent built into your browser gets Bogen's tools through WebMCP while a file is open, with no setup.
Bogen follows the [WebMCP draft](https://webmachinelearning.github.io/webmcp/) of 2 November 2026: it
registers every MCP tool with `document.modelContext` (and with `navigator.modelContext` of earlier
drafts), with the same names, descriptions, input schemas and read-only hints as over MCP. Chromium 156
has WebMCP behind `--enable-features=WebMCP`. In a browser without it, nothing happens.

Each call goes to the same MCP server as any other agent, with your own sign-in, so the same rules
hold: brand rules, locked layers, a critique's scope, and undo per agent under the name `webmcp`. A tool
that deletes something, or that reaches past the file (exports, publishing and review links, captures
and imports from the web, a folder or program on this computer), asks you in a browser dialog before
every call, and does nothing on Cancel. These tools also say so over MCP, with `openWorldHint`. Only
Bogen's own pages offer the tools, and only for the file they show.

Turn it off in Settings (Ctrl+,) under **Privacy → Agents in this browser**. The phone does not offer the tools.

### The skill

After updating Bogen, re-run `bogen install claude-code` or `bogen install codex` to refresh its managed integration skill, then start a new client session. Unmanaged skill files are preserved. The 16 editable design skills are a separate library under [Settings](settings.md). Built-in canvas runs receive one relevant effective design skill before their CLI starts; an external client reads it through `design_knowledge`. [Design guidance and its limits](design-knowledge.md#automatic-guidance-for-built-in-runs).

For Claude Code and Codex, `bogen install` also writes a small skill, `skills/bogen/SKILL.md`, in
`~/.claude` or `$CODEX_HOME`. It is made from the same text as the server's own guides, so the two
agree. It tells the agent when to reach for Bogen and how to work well in it. `bogen uninstall`
removes it, and a file of that name that Bogen did not write is left alone. No model run has been
seen loading the skill yet.

## What your agent can do

Everything a person can do in a file, through the tools in the [MCP tool reference](reference/mcp-tools.md). Users and agents can define, extend and run the same saved design checks (`check_list`, `check_set`, `check_delete`, `check_run`). In short:

- **Look:** what you have open and selected (`context_get`), the layer tree, any layer's values,
  computed styles, and screenshots of a layer or page.
- **Draw:** artboards, real HTML written one section at a time (`html_write`), styles, text,
  attributes, images, icons, shaders, animations, and layers repeated from data. Bogen generates no
  images: the agent draws them as SVG or CSS, or makes them with its own image tool, and stores them
  with `asset_upload`.
- **Organise:** groups, flex wrappers, alignment, components with props, variants and slots, shared
  libraries, tokens, theme modes and text styles.
- **Check:** contrast, tokens, the 4px grid, overflow, alt text, small text, small targets, spacing
  rhythm, type hierarchy and copy, with safe fixes applied in one step (`design_lint`; see
  [Copy that does not sound generated](#copy-that-does-not-sound-generated)); widths and optional mobile browser height changes (`responsive_check`, `viewport_heights`); pixel differences (`visual_diff`); the brand
  (`brand_check`, whose `why.raise` says what would raise the score most and on which layers);
  accessibility (`a11y_audit`, see [Accessibility audit](#accessibility-audit), and `compliance_check`, see [Accessibility and legal check](#accessibility-and-legal-check)); drift
  from the live site (`drift_check`).
- **Adapt and prototype:** narrower versions of an artboard as media rules or linked artboards
  (`responsive_variant`), and prototypes with variables and interactions (`variable_set`,
  `interaction_set`, `prototype_get`).
- **Hand off:** code as HTML, React or React with Tailwind, with motion as CSS or Framer Motion,
  tokens as CSS or a Tailwind theme, and exports to files, a clickable prototype among them.
- **Prepare a publish:** make a version of an artboard as a static site and ask you to publish it or
  share it for review (`publish_prepare`, `share_prepare`). You decide in the editor; an agent cannot
  publish, make a review link or read what a client wrote. See [Sharing for review](sharing.md).
- **Work next to you:** read and answer comments, wait for what you do, select layers or bring them
  into your view, and make proposals for you to accept.

Every tool and its arguments are in the [MCP tool reference](reference/mcp-tools.md). When it
connects, your agent also gets short instructions, and `guide_get` has longer guides on design,
layout, tokens, components, shaders, code handoff, live work, checks, brands and publishing.

The tools an agent calls most (`context_get`, `file_open`, `file_create`, `artboard_create`,
`html_write`, `layer_get`, `layer_style`, `component_list`, `design_lint` and `agent_undo`) list an
output schema and return their result as fields too (`structuredContent`), so a client knows their
shape before it calls. Tools that reach past the file, such as exports, captures and imports, say so
with `openWorldHint`. An error says what was wrong and what to call or pass instead.

Clients that offer MCP prompts as commands get four: review this design, design with this brand,
implement the selection in my repo, and build from my repo's tokens. They are listed and rendered
correctly, but have not been run as slash commands in a real client yet.

Agents leave locked layers alone. Unlocking needs a tool call the instructions tell them to make
only when you ask.

## Scripts: many edits in one step

For work that would take an agent dozens of calls, such as renaming every button, binding every
button colour to a token or building a grid of cards from a list, the agent can write a short
JavaScript program and hand it to `script_run`. The script finds layers by name, text, kind, tag,
style or CSS selector, reads tokens and components, and changes styles, text, attributes and names,
creates layers from HTML, moves, removes and duplicates them.

```js
// Every button: a clear name, and its colours from the file's tokens.
bogen.find({ tag: "button" }).forEach((b, i) => bogen.rename(b, "Button / " + (i + 1)));
bogen.bind(bogen.find({ selector: "button" }), { backgroundColor: "accent", color: "on-accent" });
```

What it changes lands as one step, the way a `batch` does: all of it or nothing, and one undo (in the
Agents tab, or `agent_undo`) takes the whole script back. With `dry_run` the agent sees the planned
changes and the script's result first, and nothing is applied. If the script throws an error or hits a
limit, nothing is applied and the result names the error, with its line, or the limit.

### What a script can and cannot do

A script is untrusted code, whoever wrote it: an agent may have been steered by text in a captured
page or a comment. So it runs in a sandbox, and the sandbox is the whole of what it gets.

- **An engine of its own.** The script runs in QuickJS, a small JavaScript engine, compiled to
  WebAssembly, in a worker thread started for that one run and stopped after it. It has plain
  JavaScript (objects, strings, `JSON`, `Math`, `Date`) and nothing of Node or a browser: no `require`,
  `process`, `import`, `fetch`, timers, files or network. `Function` and `eval` exist, but only make
  more code inside the same engine. Nothing survives from one run to the next.
- **One way out.** The `bogen` object is the only thing that reaches the server. Each call crosses as
  JSON text and is answered as JSON text, so no function, object or prototype of the server ever
  reaches the script, and keys such as `__proto__` are dropped from what it sends. The server checks
  every call as it checks a tool call.
- **One file.** The script sees the file it was run on, as a private copy, and nothing else: no other
  file, no comments or conversations, no other agent's session, no data folder paths, no device-local
  settings such as linked code projects, and no stored assets beyond the names the file's layers
  already use. HTML it creates goes through the same sanitizer as `html_write`, so scripts, event
  handlers and script URLs are removed or refused, and images in that HTML are not fetched.
- **The same rules as any tool.** Locked layers are refused (renaming too), an open revision admits
  only its copies, a brand in strict mode refuses changes that break a hard rule (in a dry run as well),
  and a critique run, which only reads and comments, does not have `script_run` at all.
- **Limits.** 10 seconds of time by default (up to 30), 64 MB of memory, a nesting depth, 5,000
  `bogen` calls, 10,000 new layers, 4 MB of written data and 256 KB of return value per run. Time,
  calls and changes are counted by the server, and when one runs out the script is stopped where it
  is; catching the error does not let it go on. Memory and stack are watched from outside the engine
  too (a refused allocation, and a guard zone below the stack limit), so a script that catches its own
  out of memory or stack overflow error still fails with that limit. A worker that does not stop in
  time is ended.
- **A dry run promises only what applies.** It is refused for the same reasons the real run is: a
  limit, the brand, an open revision's scope, or the file switched to another branch since the agent
  started on it.

What a script can do is what the agent could already do with single tool calls on that file, faster
and in one undoable step. Its reach does not grow: it cannot run other tools, publish, export, capture
pages, upload files or start agents.

## Ask from the canvas: the chat

Each file has a chat with your agent, docked between the canvas and the inspector. Press **Ctrl+K**
to open it with the focus in its field, type what you want and press **Enter**; **Shift+Enter** adds
a line. **Ctrl+Alt+3** (or the sparkle button in the toolbar) shows or hides it, and the file
remembers whether it was open. Drag its left edge to make it wider or narrower; it follows the UI
scale and your Omarchy theme like the other panels. In a window too narrow for it beside the canvas it
opens over the canvas instead, and Esc closes it there. Bogen runs your own `claude` or `codex` CLI on
your plan, with no API key. The run sees your file, page and selection.

- What you select goes with the message, as chips above the field. A chip's cross leaves that layer
  out of this message; selecting something else brings the selection back.
- Paste, drop or attach up to four images, and they go with the message for the agent to look at.
  The layers button on an image's chip rebuilds it as layers instead (see
  [Rebuild an image as layers](#rebuild-an-image-as-layers)).
- The answer arrives as the CLI writes it, a block at a time, with the steps it takes as they happen
  and **Stop** with the time the run has taken. It is shown as markdown: paragraphs, lists, code,
  bold and links (web links only; HTML in an answer stays text). The list follows new words until you
  scroll up to read; then **Jump to the latest** brings you back.
- Under an answer: what the run changed (see [What a run changed](#what-a-run-changed)), its steps,
  **Copy**, and on the last one **Ask again** and **Edit your message**. Up in an empty field also takes
  your last message back. A failed run says why, with **Try again** and **Edit the message**.
- The microphone speaks instead of typing; see [Speak instead of typing](#speak-instead-of-typing).
- Pick the runner, the model and the effort in the chat. The model list comes from the CLI itself
  (`claude --help`, `codex debug models`). Your choice is remembered.
- Pick where the work lands: **Change it** works on the layers, **Propose** works on a copy for
  you to accept, **3 directions** races several runs side by side (see [A race of agents](#a-race-of-agents)),
  and **Critique** only leaves comments (see [Critique](#critique)). With **Propose** and
  **Directions**, a row above the field sets how many copies, how far they go and what they vary (see
  [Variations: a range and aspects](#variations-a-range-and-aspects)).
- Type **/** for the design playbooks and your own saved skills: the one you pick goes with every
  message of the chat as a chip (**Skill: Websites**), and the run gets that skill instead of the one
  Bogen would pick from the words. The last entry, with an artboard selected, is **Save these decisions
  as a skill** (see [Save these decisions as a skill](#save-these-decisions-as-a-skill)).
- Type **@** for the layers on the page, the file's components and its tokens. The one you pick goes
  into the message as `@Hero` or `@--accent`, and the run gets its id with it, so it does not have to
  search for what you meant. A mention you delete from the text goes with it.
- Under a finished answer, the download button saves the run's trace (see
  [The trace of a run](#the-trace-of-a-run)).
- When the chat has a branch in a linked repository, a line above the field says where it is (ready to
  push, pushed and waiting for the merge) with **Review and push**; once the branch is merged the chat
  says it is closed and offers **New chat** (see
  [A pull request from a design change](export-and-code.md#a-pull-request-from-a-design-change)).
- The CLI gets the Bogen tools and nothing else: no shell, no file access, none of your own MCP
  servers. With Codex, your user config and rules are left out too. Codex keeps its built-in image
  generation and can hand the file it saved to `asset_upload` by path. Checked once with the same
  flags: the tool works and reports where it saved the image. A whole run that places one has not
  been tried.
- One run per file at a time, and at most sixteen at once.

Runs of both CLIs have been made for real through the same route the chat uses. On 2 November 2026 a
real Codex run in **Propose** mode took 16 s and changed only the copy, which was then accepted. The
chat itself has been tested against stand-in CLIs (`apps/editor/test/e2e/chat-panel.ts`), never with a
real model.

### Speak instead of typing

The microphone in the chat and in every comment box records you, and your computer writes it out with
a speech model you installed. The words land in the field; nothing is sent until you check them and
press Enter. While it records you see the time and the level; **Write it out** (it has the focus, so
Enter or Space stops) ends the recording, the cross or Esc throws it away, and it stops by itself after
three minutes.

The recording goes to Bogen's server on this computer and nowhere else: no speech service, no Bogen
server, no other device. Bogen finds a model by looking, never by installing or downloading one, in this
order: a command of your own in `BOGEN_TRANSCRIBER`, whisper.cpp with a model file, Voxtype (Omarchy's
dictation, with a Whisper model it already downloaded, always run locally whatever its own settings say),
and faster-whisper with a cached model. See [Privacy](privacy.md#voice-notes).

- **No model yet:** the chat says so and how to get one, and records nothing, since an agent cannot
  hear a recording. On Omarchy, pick Voxtype in the Omarchy menu under Setup, Defaults, Dictation, or run
  `omarchy-install-dictation-voxtype`; then **Check again**. In a comment the recording is kept as a voice
  note that plays on this computer; add a line if an agent should act on it.
- **Microphone blocked:** allow it for Bogen in the browser's site settings and try again. The editor runs
  on `127.0.0.1`, which the browser treats as a secure page, so it can ask.

The chat and the comment boxes are tested with a stand-in model and Chromium's made-up microphone. The
Voxtype path was run once on 13 November 2026, on an Omarchy machine with Voxtype's `ggml-base.en`: an
8-second English clip (WebM, as the browser records) was written out in 0.9 s, word for word except for
the names, which came out as "Bogan" and "Omarchi". That model only reads English; a multilingual one
(`base` or `small`) reads other languages. A real microphone in the editor has not been tried.

Claude model names come from the installed CLI's SDK metadata: the picker shows a version such as **Opus 5.5**, rather than just Opus. Provider aliases remain aliases, so selecting `opus` follows the version that your CLI resolves; a full model id pins a particular model. When metadata is unavailable, Bogen keeps the CLI aliases without inventing a version. Reading this catalog sends no prompt and starts no model turn.

### Which agents Bogen runs

| Agent | Bogen runs it | How it is kept to Bogen's tools |
| --- | --- | --- |
| Claude Code (`claude`) | Yes, also on live projects and with images | `--strict-mcp-config`, `--tools ''`, only `mcp__bogen__*` allowed. |
| Codex (`codex`) | Yes, also on live projects and with images | Your user config and rules left out, shell disabled, only the Bogen server. |
| OpenCode (`opencode`) | Yes, without images or live projects | `--pure` (no external plugins), and an agent made for the one run, chosen with `--agent`, whose own rules deny every tool and then allow only the tools of the run's own MCP server. Model ids are `provider/model`, from `opencode models`. |
| Grok (`grok`) | No | Grok limits its built-in tools only in headless mode (`--tools`, `--disallowed-tools`), and that mode still keeps its always-on MCP tools and imports other apps' MCP servers; its ACP mode has no such limit. |
| Hermes (`hermes`) | No | `hermes chat` takes MCP servers only from your own `config.yaml`, and `--safe-mode` turns MCP off; its ACP mode documents no per-session limit for its built-in tools. |
| Oh My Pi (`omp`) | No | `--no-tools` removes only the built-in tools; it still loads your own MCP servers and those it finds in other apps' settings, with no switch for one run. |

The three that Bogen does not run are listed in the chat as not available, with the reason in
Settings. Bogen does not fall back to another agent for them, since that would spend another plan.
`bogen install grok`, `hermes` or `omp` connects them the other way round, so that you use Bogen from
them.

About OpenCode: it merges your own configuration in, so MCP servers you configured may still start,
but their tools are denied to the run's agent, and so are those of a `bogen` server you registered
with `bogen install opencode`. A managed configuration an administrator installed comes after the
one Bogen passes and may change permissions; that is their policy, and Bogen does not override it.
Comments and the phone take OpenCode like the others; its model is the one set for it, or OpenCode's
own default. The newer agents are only looked up on the `PATH` when the chat or Settings list them;
their version, options and models are asked when you pick one. OpenCode runs have been tested with
a stand-in CLI only, never with a real model.

### From another device

The CLI need not be on the device you sit at. With two paired devices (see [Device sync](devices.md)), the
MacBook can ask `claude` or `codex` on the PC:

1. On the PC, in the Agents tab under **Other devices**, tick **MacBook may ask agents here**. This only
   works at the PC itself; until then the PC refuses the MacBook's requests.
2. On the MacBook, the runner list in the chat now has **Claude Code on PC** and **Codex on PC**. The chat
   says where it runs: "runs on PC, its plan, and comes back by sync".
3. The run happens on the PC, in the PC's copy of the file, with the PC's model choice for the prompt and on the
   PC owner's plan. Its steps and its reply stream back to the chat, **Stop** stops it there, and its changes
   come back through device sync like any other edit. The PC's run history records it with who asked.
   What it changed and **Undo this run** work from the MacBook too, through the PC.

The file must have synced to the PC first; if not, the chat says so. Comments that mention `@claude` on the
MacBook still run on the MacBook, or not at all when it has no CLI: a comment is part of the document, and
nothing in a document starts a run on another device. Conversations live on the device that ran them, so after
a reload the MacBook's chat does not show a conversation held on the PC.

## Conversations that remember

Every run starts a fresh CLI, which on its own knows nothing of the message before. So Bogen keeps the
conversation and tells each run what came before:

- The chat and Ask on the phone send each message with a conversation id, kept per file on the
  device. The server keeps every turn in `conversations/<fileId>.json` in the data folder, next to the
  run history: what you said, what the agent answered at the end, which CLI it was, and the layers the
  run created or changed.
- The next run in that conversation gets a short transcript ahead of your message: the last 8 turns,
  at most 6000 characters, newest kept, each with the layer ids it touched. It does not matter which
  CLI ran a turn, so you can switch from Claude to Codex in the middle and Codex knows what Claude did.
- The conversation survives a reload and a restart of the server. The chat and the phone show it again
  when they open. **New chat** (at the top of the chat, at the top of the thread on the phone)
  starts a new one, and the agent forgets the old one.
- The chat's title (or the clock button next to it) lists the file's earlier chats, the one talked in last
  first, with who answered and how long each is. Open one and the next message continues it. A file keeps
  its last 40.
- A phone and a computer share a conversation only when they use the same id. Each device keeps its
  own by default.
- **Run this again** in the run history runs a turn again in its conversation.

What is not passed on: the tool results of earlier runs, such as screenshots and layer trees. The
agent reads the layers again. Bogen could instead resume the CLI's own session, which would carry all
of that, but it would leave a session file in your CLI's history for every run, and it would only work
while you stay on one CLI. The transcript costs a few thousand characters of prompt instead.

## A race of agents

**3 directions** in the chat starts several runs on the same request at once, with runners you
pick: Claude and Codex, or two models of one CLI. Each lane has a runner and a model; add up to sixteen
lanes with **+ Runner**. The bar says how many runs it starts, each on your own plan.

- Select the one layer the directions are for (or have one artboard on the page). Bogen makes one
  copy of it per lane, next to the original, before any run starts.
- Each run works in its own copy, live, under its own name (`claude`, `codex`, `claude opus`, a
  second `claude 2`) with its own cursor and colour. The copy's outline, its bar and the cursor share
  that colour, and each lane undoes on its own in the Agents tab.
- A bar on each copy says what its lane is doing: waiting, the tool it is on, done with its time, or
  failed. **Stop** stops one lane, **Stop all** in the tray at the top stops them all. A lane that is
  still waiting just does not start.
- **Compare** fits the original and every copy on screen. **Accept** on one copy stops whatever still
  runs, puts that copy into the original as one undo step and discards the others. Tick **Keep the
  others as a branch** first to keep every copy in a branch inside the same file, taken before the
  accept, so nothing is lost; open it from the branch menu next to the file name.
- Concurrency is per runner: in the Agents tab, under each runner, **In a race** sets how many of its
  runs go at once (two by default, one to sixteen). They share your plan and its limits; the rest wait
  their turn. The server supports up to sixteen runs and lanes. Increase a runner's limit explicitly when you want more of its lanes to work at once; the rest stay queued.
- While a race runs, no other run starts on the file. Races are kept while the server runs; after a
  restart the copies stay on the canvas as ordinary proposals.

Tested with stand-in CLIs, in the server tests and in the editor in a real browser. Never with two
real CLIs at once.

### Split the page

Tick **Split the page: each run takes sections** under **Directions** to have the lanes work on one
page together instead of a copy each of all of it. The selected layer's visible children are its
sections, shared out in order (four sections over three runs: two, one and one), and the line under
the toggle says which run takes which. Each lane gets a copy of each of its sections and is told
which sections the others have, so it keeps to the page's tokens and spacing. **Accept** on a lane
takes its sections in and leaves the other lanes' copies where they are; the race is decided once
every lane is accepted or discarded. A layer with fewer sections than runs is refused before anything
is made.

## Variations: a range and aspects

**Propose** and **Directions** take three more choices, in the row above the field:

- **Copies** (Propose only): one to six copies from one run, side by side. Accepting one discards the
  others.
- **Range:** how far the copies go. **Refine** keeps the structure and the idea and makes it better;
  **Explore** asks for clearly different takes, each a real option; **Reimagine** starts over in what
  varies.
- **Vary:** **Layout**, **Colour**, **Type** and **Copy** (the words). Pick some and the rest is held:
  the run is told to keep those values exactly as the original has them. Pick none to let anything
  change.

The run gets the range and the aspects as a brief, and each copy keeps them, so `proposal_list` reports
under `held` what a copy changed in an aspect it was to hold, with the layer and the values, for the
agent to put back before it finishes. Agents can ask for the same thing themselves: `proposal_create`
takes `count`, `range` and `vary`, and a race takes `range`, `vary` and `split`.

## Critique

**Critique** in the chat asks an agent to review the selection or the page, and change nothing.
Type what to look at, or just press Enter.

- The run checks with `brand_check` (when the file has a brand), `design_lint`, `responsive_check` at
  390, 768 and 1440, and good practice for hierarchy, spacing, contrast, copy and states.
- It leaves at most ten comments, pinned to layers, each with a concrete suggestion and where it comes
  from (Brand, Lint, Widths, Practice). The Comments tab shows them under the critique's name.
- Its session only gets tools that read and comment. Tools that change a layer are not listed at
  all, the checks run with their fixes off, and the server refuses a write from it even if a client
  tried one. This is decided on the server by the run, not by what the CLI was told.
- The same scope is there for a client of your own: the [reviewer profile](#a-shorter-tool-list).
- **Fix it** under a note hands its suggestion to a fix run: a reply that asks the agent that wrote it,
  which then works like any [comment run](#ask-in-a-comment-claude-and-codex) and leaves the thread open for you.

Tested with stand-in CLIs that tried to write and to fix; never with a real model.

## Rebuild an image as layers

Right-click an image layer and choose **Rebuild as layers**, or paste an image into the chat and press
the layers button on its chip (what you typed goes along as a note). The image is placed on the canvas
first, since the run compares against it.

- The run gets the image attached. Codex takes it as `-i <file>`. Claude has no image flag in print
  mode, so the request goes in as one stream-json message (`--input-format stream-json`) with the
  image as a content block.
- The image is sent as stored when it is a PNG, JPEG, WebP or GIF under about 3.7 MB, else as a PNG
  rendered from the canvas at most 1568 px on its long side.
- The agent builds a new artboard of the same size next to the image, as real HTML and CSS in the
  file's brand, then compares the two with `visual_diff`, fixes the biggest differences and compares
  again, at most three rounds. The image itself stays as it was.
- **Run this again** in the run history attaches the image again.

One real run on 2 November 2026: `claude` on `haiku` got a 460 by 170 screenshot of the former prompt bar,
described what it showed, rebuilt it as seven layers next to it with tokens for its colours, and
stopped after three rounds of `visual_diff` at 22.5% different pixels, mostly text a few pixels off.
69 s. Codex's `-i` path is tested with a stand-in CLI only.

## Ask in a comment: @claude and @codex

Press C, click a layer, and write a comment that mentions `@claude` or `@codex`. The CLI starts with
the thread and the layer as context and answers in the thread. Only you resolve or reopen a thread, in
the editor or on the phone: an agent cannot, also not when its run ends, and a reply leaves a thread as
it is. If it needs something from you, it asks in the thread.

- The microphone in the comment box speaks instead of typing, as in the chat (see
  [Speak instead of typing](#speak-instead-of-typing)). Without a local speech model the recording stays
  on the comment as a voice note that plays on this computer; an agent asked in the thread does not hear it.
- One run per file at a time; up to five more mentions wait in line. A file can start at most 20
  runs from comments in ten minutes. Waiting mentions of all files form one queue: see
  [The queue](#the-queue).
- While it works, the thread shows what it does, step by step in words ("Read the layers", "Changed
  styles (3)"), in the Comments tab and in the comment sheet on the phone. An editor or a phone that opens
  the file midway gets the steps so far. **Stop** ends the run: its process and everything it started get
  a stop signal, then a kill after three seconds, and the thread says after how many steps it stopped.
  What it changed until then stays, and [Undo this run](#undo-this-run) takes it back. A mention still
  waiting has **Cancel** instead, and the thread says who took it out of the queue.
- Comment runs start on the cheapest model each CLI offers, at low effort (for Claude, `haiku`).
  Change that in the Agents tab, or under a new comment. Replies then keep the thread's model: see
  [Conversations](#conversations-replies-go-to-the-same-agent).
- Only you, on this device, start runs. A comment that arrives from a paired device, that an agent
  writes, or that comes with an imported file never starts anything.
- The run gets the thread (its last 24,000 characters) and what earlier runs on the thread did: the
  layers they changed, their tools and how they ended. Asked again, it builds on that.
- Files attached to the thread go along. Images (paste, drop or the paperclip) reach both CLIs as
  images, the same way as for [Rebuild as layers](#rebuild-an-image-as-layers): PNG, JPEG, WebP and GIF as
  they are, SVG, AVIF and large photos as a PNG drawn from them. Text, Markdown, CSV and JSON files, and the
  text of a PDF, go into the request as text, marked as material rather than instructions. The message that
  asked comes first, then the earlier ones, newest first: at most 4 images and 4 files, 20,000 characters
  per file and 40,000 in all. Voice notes stay out, since their words are in the message.
- A PDF is read without a PDF library: the text of its pages, as office programs, browsers and pdf-lib
  write it for Latin script. A scanned PDF, or one in a font without a text mapping (most Chinese,
  Japanese and Korean), has no text to read, and the run is told that it was attached but could not be
  read. What was left out, and why, is in the request.
- A request is a request even when it is phrased as a question: "kannst du das größer machen?" or
  "can you tighten this?" gets the change, not agreement. Only a question that asks for information,
  such as "which font is this?", gets an answer without changes.
- Before it says a fact is missing, the run is told to look for it: the layer and page, then other Bogen
  files and brands whose names relate to the request, read by their id so that its writes stay in this file.
  It never makes up product descriptions, URLs or product screenshots; if a source really is not there, it
  says what it looked at and asks one specific question.

### Conversations: replies go to the same agent

A thread you asked an agent in is a conversation. You do not need to mention the agent again:

- **A reply without a mention goes to the thread's agent,** with the model and effort of the last request in
  that thread, on the desktop and on the phone. The composer always shows where a message goes, such as
  **To Claude · Opus · High**. Open it to choose **Claude**, **Codex** or **Comment only**, and a model and
  effort, for this one message. A mention in the text always wins; mentioning the same agent again keeps the
  thread's model rather than dropping to the cheaper one set for comments. After a successful send the
  choice is gone and the next reply follows the thread again.
- **Comment only** writes the message without starting anything. A thread no agent was asked in stays a
  plain comment thread, and a new comment without a mention starts nothing.
- The server records each thread's target when it accepts a request, also one still waiting in the queue,
  in `$BOGEN_HOME/reply-targets/<file id>.json`, next to the files and never in the document. After a restart
  a reply follows the last request you addressed, even if its run never started; threads from before this
  existed follow their last comment run in the run history.
- **A bare `@claude`** under what you wrote ("this description makes no sense", then `@claude`) answers what
  you wrote: the human messages no agent has answered yet. A progress reply from an older run does not
  count as an answer to what you wrote after that run was asked, a request whose own run is still waiting
  or working is not asked twice, and a request an agent already answered is not run again. Files attached
  to those messages go along as files. What you write in the message itself always wins.
- Only your send starts a run: a message arriving from a paired device or a teammate, an agent's own reply,
  a note from Bogen, a client's thread and an imported file never do, and a run never resolves a thread.

In the Comments tab each conversation is a compact header with its title, newest message and time, the
agent and model it goes to, and whether an agent is working, a request is waiting, there is something new
or you left a draft. Click a header (or press Enter) to open it, again to close it; arrow keys, Home and End
move between headers, and R resolves or reopens the focused one. One conversation is open at a time; a long
one shows its newest messages, with the rest one click away. A pin on the canvas, the queue or a
notification opens its conversation, shown even where your search or filter would hide it. What you were
writing stays with each thread and file while the editor is open, through closing, switching and resizing.
On the phone the comment sheet lists the page's conversations the same way, opens one with its newest
messages and the same **To** chooser, and **All comments on this page** goes back to the list.

Both have run for real, on 2 November 2026, through the route the editor uses. `@codex` on a button
(`gpt-6-luna`) changed its colour and label and answered in the thread in 12 s. `@claude`
(`haiku`) did the same in 6 s, 8 s from posting the comment to the answer. (Agents resolved threads
then; they no longer can.) Undoing that one
Codex step through its row in Activity put the button back, and left the reply and everything else
alone.

## When an agent only agrees

Agents are told to do the work first and then reply in one or two plain sentences on what changed: no
"you're right", no praise for the request, no apology, no promise of later work. Some still answer a
request with agreement and stop.

Bogen notices. When a prompt run or a comment run was asked for a change and ends without changing the
document (a reply does not count), Bogen continues it once with what it was asked,
what it replied and this note: "You replied without changing anything. If the person asked for a
change, make it now; if it truly was only a question, say so in one sentence." The bar shows a line
when that happens, and the run history says so on the run, with what it said the first time.

- Whether you asked for a change is a guess from your words, in English and German. "Mach größer",
  "make it bolder", "kannst du...?", "could you...?", "bitte..." and "too small" count; "which font is
  this?", "warum ist das so?", "thanks", "antworte nur mit dem Text", "tell me which" and "ändere nichts" do
  not.
- A critique never gets a second go, nor does live site mode, and no run gets more than one.
- The second go is part of the same run: one entry in the run history, and one commit.

Tested with stand-in CLIs that only agree, for both Claude and Codex, in the chat and in comments. With
real models, [the check](#check-the-agents) has seen both do a polite request on the first try, and the guard
leave a pure question alone once "ändere nichts" and "antworte nur" were understood as asking for no change.

## Check the agents

`bogen agents check`, or **Check the agents** in the Agents tab, runs your real `claude` and `codex` on a
throwaway file, in a throwaway server with its own data folder, and reports per runner:

- **Polite request:** "kannst du die Überschrift größer machen?" must make the heading bigger, measured in
  the browser, not agree that it should be.
- **Pure question:** "Wie lautet der Text auf dem Button? Antworte nur mit dem Text, und ändere nichts." must
  answer "Jetzt buchen" and change nothing.
- **Two-turn chat:** after "Ändere den Text des Absatzes zu 'Tickets ab Samstag.'", the message "Mach ihn jetzt
  fett." must make that paragraph bold, which only the turn before says.

It also says when a run was nudged once. It uses your plan: four small runs per CLI on the cheap model
comments use. Nothing reaches your files, your devices or your run history.

Run for real on 4 November 2026, `claude` 2.1.316 on `haiku` and `codex` 0.166.0 on `gpt-6-luna`, both at low
effort: all six cases passed, in 82 s. It also showed that the guard took the question for a request ("und
ändere nichts" read as an order to change) and nudged both runners once for nothing; with that fixed, a second
real run passed all six with no nudge, in 73 s.

### The repository round trip

`bogen agents check --repo [--runner claude|codex] [--model <m>] [--keep]` runs the design-to-pull-request
round trip once, for real, with nothing reaching the network or your data: a throwaway Git repository
with a bare repository next to it as its remote, a small page served on `127.0.0.1` as its dev server,
and a throwaway Bogen server with its own data folder on a spare port. Your own CLI makes the change,
logged in as it is, with only the file tools of the working folder (`--mcp-config` with
`--strict-mcp-config`, no built-in tools). The eight steps: link the repository, open its page as a
canvas on a design branch (the capture and its components), accept a proposal that turns the title red,
make the pull request in the chat's working folder, push with the confirmed digest (to the bare
repository: no `gh`), merge it there as a reviewer would, and see the chat close. It prints the path of
the run's trace, kept as the transcript; `--keep` keeps the folder.

Run for real on 13 November 2026 with `claude` 2.1.319 on `haiku`: all eight steps passed in 10 s, the
run 7 s. The agent searched for the title, read `src/Hero.tsx` and `index.html` and changed the colour in
both. Two things were fixed before that run, found by the same check with a stand-in CLI: a captured
page kept `-webkit-text-fill-color` as a copy of every text colour, so changing a colour on the canvas
did not show and the code the agent got still said the old one; and a remote that is a folder made
Bogen call `gh pr create` after the push, which fails there.

## Copy that does not sound generated

The design guide and the Bogen skill tell agents how to write: plain, specific, short sentences from the
customer's side; facts only from the file, the brand or you; no filler, no exclamation marks, no
rhetorical questions as headlines, no emoji; and the brand's voice when it has one.

`design_lint`, which agents run before they finish, checks the text layers for it. Each finding names
the layer, quotes the phrase and says what to write instead:

- filler in English and German, such as elevate, unlock, seamless, supercharge, game-changer,
  revolutionize, empower, next-level, "in today's fast-paced world", "whether you're X or Y", "not just
  X, it's Y", "the future of", nahtlos, "nicht nur X, sondern Y";
- the words the file's brand avoids, with what the brand says instead, and its measurable voice: du
  or Sie, sentence, paragraph and heading length, number format and the brand's spelling of its terms,
  each with the brand's own example (see [Brands](brand.md#voice); `voice_check` checks a draft first);
- exclamation marks, a heading that is a question, and three one-word claims in a row;
- emoji, and the arrows, copyright and trademark signs that phones draw as emoji;
- hedges such as "aims to" and "may help", test-report language such as "all checks passed" or
  "successfully verified", and a heading chopped into fragments ("No setup. No fees.");
- lorem ipsum and placeholder names such as John Doe or Acme.

It is a list of words and patterns. It does not judge tone, and it cannot tell an invented number from
a real one: that part is up to the agent's instructions and to you.

## Accessibility audit

`a11y_audit` checks a page or a layer the way a screen reader and a keyboard meet it, and lists what
it finds per layer, the worst first, each with its WCAG 2.2 success criterion and a fix:

| Check | What it finds |
| --- | --- |
| Heading order | A page without an h1, a second h1, a level skipped on the way down, such as an h4 after an h2. |
| Landmarks | A page without a main, two mains (also a board made as a main that holds a captured page's own main), several navs without names. |
| Names | Links, buttons and fields with no name, such as an icon button; a field named only by its placeholder. |
| Alt text | An image without alt, an alt that is a file name, an alt that starts with "image of". |
| Link text | Links that say nothing out of context: click here, learn more, read more, hier, mehr, weiterlesen. |
| Target size | Links, buttons and fields under 24 by 24 pixels, unless they sit in a line of text or have room around them. |
| Focus | Focus removed with nothing in its place; a `:focus-visible` ring under 3:1 against what is around it, or thinner than 2px. |
| Motion | Layers that animate or move with a transition and have no `@media (prefers-reduced-motion: reduce)` block. A fade does not count. |

Names, sizes and colours come from a render. Focus and motion come from the layer's own
`:focus-visible` and reduced-motion blocks, which a render shows neither focused nor with motion
reduced.

With `fix: true` the safe fixes go in as one undo step: a `:focus-visible` ring in a colour that
stands out from what is around it, a reduced-motion block that stops the motion, an alt without "image
of", a field named by its placeholder, a board made a main element. They change nothing for anyone who
did not ask for them. The rest, such as a heading level or words for a link, need a person or an
agent to choose.

A saved check with `a11y: true`, or the built-in `builtin:a11y`, runs the same audit in
**Design checks** and through `check_run`. Text contrast stays with `design_lint` and
`brand_check`.

## Accessibility and legal check

`compliance_check` checks a page or an artboard against a profile, criterion by criterion:
`en-301-549` (EN 301 549 V3.2.1, the version the Official Journal cites), `wcag-2.2-aa`,
`wcag-2.1-aa`, `eaa-bafg` (European Accessibility Act and the Austrian BaFG) and `wzg` (Austrian
public bodies). It runs axe-core, `a11y_audit`, text and non-text contrast, reflow at 320 CSS px, the
text spacing override, the language of the page and its parts, and form labels, errors and
autocomplete, and gives every A and AA criterion as failed (with layers and fixes), passed, not
applicable, or needing a person (with a short test). A failure a check found cannot be marked away.
What only a person can decide stays open until the person marks it in the editor's **Accessibility
and legal check** (command palette, or **Design checks**); marks are stored in the file with their
name and the date. The status never says conformant while anything failed or is open, and the
automated pass rate is reported apart from it. `legal: true` adds reminders of other duties a design
can show, each with its source, as findings and checklist items, never as a block. `export` writes
the report as HTML or PDF, and `compliance_statement` drafts the Erklärung zur Barrierefreiheit in
German and English with the fields a person fills in marked.

It is a technical aid, not legal advice or a certification. What the laws and standards ask, with
sources, and the map of every criterion: [Accessibility and other legal requirements](compliance-law.md).

## Save these decisions as a skill

Once an artboard is where you want it, select it, type **/** in the chat and pick **Save these
decisions as a skill**. Bogen drafts a section for one playbook's personal `SKILL.md`: what the
artboard settled on, read from its layers (type families and sizes, weights, the colours and spacing it
uses most, corner radius, layout, the tokens it relies on), the proposals you accepted on it with what
each asked for, and the requests that shaped it. The skill is the one you chose with **/**, or the one
Bogen would pick for the artboard, and you can choose another. **Review and edit** opens the skill
editor with the section appended; nothing is saved until you save it there, and the previous version is
kept in the skill's history as with any edit. See [Design playbooks](design-knowledge.md).

## Proposals: review before it counts

When your agent changes something you care about, it can work in a proposal: a marked copy next to
the original, with **Accept** and **Discard** on the canvas. Accepting puts the copy into the
original as one undo step. The original and every layer inside it keep their ids, so comments pinned
to them, prototype links and selections stay where they were; comments and links made on the copy
move over. With three directions, accepting one discards the others. The agent hears your decision
through `wait_for_event`.

If you edited the original while the proposal was open, your edits stay wherever the proposal left
that layer alone. Where both changed the same layer, **Accept** lists those layers instead of
replacing anything, and you pick **Use the proposal's** or **Keep my edits**.

One limit: page exports and thumbnails include open proposals.

## Redo without a mess: revisions

Select a screen and click **Redo this screen…** in the Design inspector, or right-click the screen or one of its children and choose that action. It opens the chat scoped to that artboard. Add optional feedback and choose your runner/model, then Send. Opening or cancelling it starts no run. Sending starts a new conversation, so it cannot accidentally resume another screen’s draft. Follow-up messages continue that revision in the same file; an Omarchy theme redo uses its internal branch. The original remains available for review. This is a design redo, not a page/file duplication action.

"Make this page again, I don't like it" used to end up as another page next to the first. Now it
becomes a **revision**: a named draft copy of the page's artboards (or the ones you selected) next to
the originals, with the file committed first so there is always a way back.

As you type, the chat says what your message will do: **Redo** goes into a revision, a request
for a new page makes one, anything else changes the layers in place. One click switches to the other
choice for that message. When a request arrives without that choice, from the phone, a comment or
another client, the server reads it the same way.

While a revision is open, the run and the next messages of the same chat work only on its copies: the
server refuses writes to the originals, new pages, and changes to tokens, text styles or keyframes,
which would change the original too (a colour can change on the copy itself, as a custom property).
The bar over the copies says **Revision: <name>**; **Accept** puts every artboard of it into its
original at once, with the same identity and conflict rules as a proposal, and **Discard** removes the
copies but keeps the revision and its commit in `revision_list`. If the commit cannot be written, no
revision is started and nothing changes.

## Screens in another language

The **design language** is the language of the words inside your screens. It has nothing to do with
the language Bogen's interface is in, your operating system, or the language you write to the agent in,
and Bogen never guesses it from any of those.

The button with the language icon next to Send shows the language a request will use, as a short tag
such as `de` or `ar`. In its popover:

- **This request** picks a language for this one message: one of the listed ones, or any other
  language tag (`fr-CA`, `pt-BR`, `zh-Hant-TW`). It overrides the file's language and is gone after Send.
- **What to do with it**: *Write new text in it* (new and changed copy is in that language), *Translate
  in place* (the same screens, layers, ids and styles; only the words change), or *Add a language version*.
- A quick instruction, such as "Translate this page into German.", goes into your message for you to
  edit. Nothing starts until you press Send.
- **File default** is kept in the file (`meta.contentLanguage`), synced to your devices and part of
  downloads and design folders. Not set is the default, and a file without one works as before. The
  primary language of the file's brand is used as a soft default while the file sets none.

**Add a language version** never copies the file or adds a page. It opens a branch inside the same file
named after the language, such as **German (de)**, from the version that is checked out, sets the
language on that branch only, and the run translates there. The original stays as it was, with its own
language; switch between them in the branch menu next to the file name and keep both. Asking for the
same language again continues that branch. A failed or stopped run that changed nothing but the
language withdraws the branch again. Proposals, races, critiques, image rebuilds and live site runs
cannot hold such a branch, so they refuse it with a reason instead of translating the original.

### Keeping language versions up to date

A language version follows its original. The file keeps a **translation memory**: each text of the
original and its translation, per language, shared by every branch of the file and synced with it.
When the original changes, the agent is asked only for the text that is new or changed; Bogen brings
the version up to date and fills in everything it already knows. What a version was translated into
before, by an agent or by hand, is learned from it. Bogen translates nothing itself and calls no
translation service: your own agent does the translating.

Under **Language versions** in the language popover:

- each version says how many texts it still needs, or that it is up to date;
- **Included** (translated and kept up to date), **Untranslated** (it shows the original's words and
  asks for nothing) or **Hidden** (left out of translation work; the
  [check before publishing](export-and-code.md#publish) warns before it goes out);
- **Translate what changed** puts an instruction into your message for the agent;
- **Never translate** lists brand and product names that stay as they are in every language. Code,
  addresses, numbers, layers inside `code` or `pre`, and layers with `translate="no"` stay as they are
  anyway.

Bringing a version up to date takes the original's new and changed screens and layers into it, keeps
the version's own fixes (a font size for a longer German word, say), and is one change with a commit
before it. Where a layer changed in both, the original's side comes in and its text is filled from the
memory or translated again. Text ranges with their own style are not carried over into a translation.
Agents use `translation_status`, `translation_apply` and `translation_rules_set`.

Every run gets the language: the chat, comments (the file default), the phone, races, runs on a
paired device and reruns. The agent is told to translate visible copy, button labels, placeholders, alt
text and aria labels; to keep brand and product names, URLs, identifiers and prices as they are; to make
longer text fit instead of cutting it off; and to set `lang` and `dir` on each artboard it writes or
translates, so a right-to-left language gets `dir="rtl"` and a translation back gets `dir="ltr"`. If your
message clearly names another target language than a default, it follows the message and says so; if it
contradicts the language you chose for the request, it asks. External agents read the language in
`file_open` and `context_get` (`content_language`).

Brand checks stay honest. A brand can speak several languages ([Languages](brand.md#languages)), and
copy is judged in the one it is written in, with that language's words, examples and text rules. Copy
in a language the brand does not speak gets no du/Sie check and no number format that was only inferred
from the brand's language, while hard rules, terms, required words and an explicitly set number format
still apply. A run in another of the brand's languages is told so. Bogen does not check the grammar or
spelling of any language.

## Web craft

Tools that help an agent build pages that hold up on the web, not only in a screenshot:

- `type_scale_set` gives the file one fluid type and spacing scale (`--type-h1`, `--space-l`, …) as
  `clamp()` in rem, with text styles per role, so a heading needs no separate size per breakpoint.
- `grid_set` makes a grid that fits as many columns as there is room for and never overflows a phone;
  `container_queries` makes a component respond to its own width instead of the page's.
- `section_list` and `section_insert` add website sections that work natively in the canvas, the
  preview and an export: a header whose navigation folds into a popover menu, an editorial hero, proof
  with sources, an accordion that keeps one answer open, a dialog, and a footer.
- `design_review`, `focus_order`, `font_audit` and `content_stress` measure hierarchy, line length,
  keyboard order, synthesized fonts, and what breaks with longer text or missing images, without
  touching the file. `motion_preset` adds motion with a reduced-motion alternative.

`design_lint` and `design_review` also report craft findings: the habits that make a page look
generated or unfinished, each with a stated line and the layers it concerns.
[Design playbooks and verification](design-knowledge.md#craft-checks) lists them.

Layers keep the attributes a real site needs, such as `id`, `aria-*`, `popover`, `popovertarget`,
`<details name>` and `tabindex`, and an HTML export gives images their own size, lazy loading after
the first one and asynchronous decoding.

## Undo what an agent did

- **Agents tab:** each agent working in the file has an undo button for its last edit. Its own
  steps only: what you and other agents did stays.
- **Activity:** in the Agents tab, every step an agent took is a row. A row jumps to its layers, shows
  them before and after as pictures and values, and undoes that one step, also out of order. This lasts while the file
  stays loaded on the server.
- **Your agent itself** can call `agent_undo`, with redo.
- **Any change, any time:** [History](history.md) can revert a single change or a whole run, also
  after a restart.

Ctrl+Z in the editor undoes your own edits, not an agent's.

### Undo this run

**Undo this run** takes back everything one run changed, as one step. It is under the agent's reply in
the chat, under the thread a comment run answered, on the run in the run history, and on the phone
under an answer in Ask and in the comment sheet.

- It reverts the run's own entries in the [timeline](history.md) together, in one change by you, which
  History lists and can itself revert.
- What someone changed since in the same place stays, and the reply says which values stayed. Other
  people's and other agents' edits are never touched.
- The conversation stays: the agent's reply is what was said, not what was done.
- A run that is still going has to be stopped first. A run is taken back once, and then says who did it.

## What a run changed

When a run ends, its reply in the chat and in the thread says what changed: the layers it changed,
by name, as links that select them and bring them into view (a removed layer is struck through), and a
small picture of the top-level layer most of them sit in, before and after. The picture is left out when
nothing visible changed, such as a hidden layer or a name. Pictures of the newest 60 runs per file are
kept in `run-shots/<fileId>/` in the data folder; the names stay in the run history.

## Let agents show you things

An agent can select layers in your editor or bring them into view, to point at what it means. It
waits while you drag or type. Turn **Let agents show me things** off in the Agents tab to stop it.

### Layer links

`selection_set` and `view_focus` also answer with `link`, an address that opens the editor with those
layers selected and in view, such as
`http://127.0.0.1:29990/#/file/<file>?page=<page>&select=<layer>,<layer>`. An agent prints it when
nobody has the file open, or in a report. From a terminal:

```sh
bogen open "Landing page#Hero"
```

opens the file, by id or name, with the layer selected and in view, by its id or its name (any case,
on the page in view first). That is `#/file/<file>?layer=<id or name>`. A link opened while the file
is already open in the tab moves the selection and the view without a reload.

## Run settings and run history

The Agents tab keeps:

- **Run settings:** model and effort per runner, for the prompt and for comments, and how many runs
  of each runner a race starts at once. They are saved in `run-settings.json` in the data folder.
- **Run history:** per file, every run with its prompt, runner, model, effort, tools, duration,
  result, layers touched and status, with **Stop** and **Run this again**. It survives a restart. A run
  that was asked once more to make the change says so.
- **Run reports:** when the file has a brand, a run ends with its brand score and what is still
  open. See [Brands](brand.md).

### The trace of a run

Every run Bogen starts keeps a trace, for a bug report: the request, the conversation before it and the
instructions the CLI got; every tool call with its arguments and result (cut at a few thousand
characters), when it started in milliseconds from the start of the run and how long it took; what the
CLI said; and the layers and repository files it touched. Secrets are masked by pattern (tokens, keys,
cookies, bearer headers), your home folder shows as `~`, and the contents of files outside Bogen are
left out with their size: what a run on a repository read or wrote, and what `code_get` read from your
project. Read it before you share it.

Download it with the button under an answer in the chat, with `bogen agents trace <run id> [--output
<file>]`, or have an agent read it with `trace_get` (without a run id it lists the file's latest runs;
`save` writes it into the export folder). The latest 200 traces are kept in `traces/` in the data
folder. Runs of an MCP client you started yourself have none.

## The queue

**Queue** at the top of the Agents tab shows what runs on this computer and what waits, over all files:

- Runs going, with their file, where they came from (the prompt, a comment, a race, a live site), how
  long they have run and the step they are on, each with **Stop**.
- Mentions waiting, in the order they will start, each with what it waits for: the run going on its
  file, an earlier comment in its file, or a free slot when sixteen runs are already going. The arrows move
  one up or down the queue, which counts over all files; the cross takes it out, and its thread says so.
- Lanes of a race that wait for a free slot of their runner, with the cross to take one out of its race.

A waiting mention starts when its file has no run going and the server has a free slot. Before, a
comment that came while four runs were going failed with a note in its thread; now it waits. Runs from
the prompt still start at once or are refused, since the person waits for them in the chat.

## Waiting for you: events

Most clients only act when they call a tool. `wait_for_event` lets an agent wait until you comment,
select something, change page, edit a layer, or a run ends, and then act. The log of events is kept
in memory per file; after a server restart the agent is told to catch up.

Clients that show MCP resource updates can subscribe to a file's selection, tokens, layer tree and
comments instead. These work in tests with the MCP SDK; no client that shows them to its model has
been tried yet.

## Live site mode

Live site mode edits the source of your own web project instead of the canvas:

```sh
bogen live http://localhost:5173 --dir ~/Work/my-site
```

It opens your dev server in Bogen through a proxy on its own local port, with hot reload. Point at
an element and click it, then ask `claude` or `codex` for a change. The CLI gets the element's
selector, HTML, computed styles and, where React, Vue, Svelte or a data attribute exposes it, its
source location. Its only tools are six file tools that stay inside the project folder: no shell and
none of its built-in tools. It starts in an empty folder, so hooks in the project's settings do not
run.

The dev server must be plain http on `localhost` or `127.0.0.1`. You can also open live site mode
in the editor at `#/live`.

This has run with a Vite project and a real `claude` run. Codex was only tried with a stand-in, and
the source locations for React, Vue and Svelte follow their documentation without a run against
those frameworks.
