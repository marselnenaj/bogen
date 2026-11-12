# Agents

Bogen has no model of its own. Your coding agent does the agent work, with the account and plan you
already have. There are two ways in:

- **Your agent connects to Bogen.** You work in Claude Code, Codex or another MCP client, and it
  draws through Bogen's MCP tools. It can work with no editor open.
- **Bogen starts your agent.** From the canvas, Ctrl+K or a comment that mentions `@claude` or
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
bogen install claude-code
```

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

To take Bogen out again:

```sh
bogen uninstall claude-code
```

The client starts `bogen mcp`, which talks to the local server and starts it when it is not running.
If `bogen` is not on your `PATH`, the entry names Node and the exact script instead.

### Other clients

Any MCP client can connect in one of two ways:

- **stdio:** the command `bogen mcp`.
- **Streamable HTTP:** `http://127.0.0.1:29990/mcp`.

A server started with `--token` needs `Authorization: Bearer <token>` on HTTP, or `BOGEN_TOKEN` in
the environment of `bogen mcp`. `BOGEN_URL` points `bogen mcp` at a server elsewhere.

An agent shows up in Bogen under the name of its MCP client. A client can set its own with the
`X-Bogen-Agent` header.

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
  accessibility (`a11y_audit`, see [Accessibility audit](#accessibility-audit)); drift
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

## Ask from the canvas: Ctrl+K

Press Ctrl+K, type what you want and press Enter. Bogen runs your own `claude` or `codex` CLI on
your plan, with no API key. The run sees your file, page and selection.

- Pick the runner, the model and the effort in the bar. The model list comes from the CLI itself
  (`claude --help`, `codex debug models`). Your choice is remembered.
- Pick where the work lands: **Change it** works on the layers, **Propose** works on a copy for
  you to accept, **3 directions** races several runs side by side (see [A race of agents](#a-race-of-agents)),
  and **Critique** only leaves comments (see [Critique](#critique)).
- The CLI gets the Bogen tools and nothing else: no shell, no file access, none of your own MCP
  servers. With Codex, your user config and rules are left out too. Codex keeps its built-in image
  generation and can hand the file it saved to `asset_upload` by path. Checked once with the same
  flags: the tool works and reports where it saved the image. A whole run that places one has not
  been tried.
- One run per file at a time, and at most sixteen at once.

Runs of both CLIs have been made for real through the same route the bar uses. On 2 November 2026 a
real Codex run in **Propose** mode took 16 s and changed only the copy, which was then accepted. The
bar itself has been tested against stand-in CLIs.

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

The three that Bogen does not run are listed in the bar as not available, with the reason in
Settings. Bogen does not fall back to another agent for them, since that would spend another plan.
`bogen install grok`, `hermes` or `omp` connects them the other way round, so that you use Bogen from
them.

About OpenCode: it merges your own configuration in, so MCP servers you configured may still start,
but their tools are denied to the run's agent, and so are those of a `bogen` server you registered
with `bogen install opencode`. A managed configuration an administrator installed comes after the
one Bogen passes and may change permissions; that is their policy, and Bogen does not override it.
Comments and the phone take OpenCode like the others; its model is the one set for it, or OpenCode's
own default. The newer agents are only looked up on the `PATH` when the bar or Settings list them;
their version, options and models are asked when you pick one. OpenCode runs have been tested with
a stand-in CLI only, never with a real model.

### From another device

The CLI need not be on the device you sit at. With two paired devices (see [Device sync](devices.md)), the
MacBook can ask `claude` or `codex` on the PC:

1. On the PC, in the Agents tab under **Other devices**, tick **MacBook may ask agents here**. This only
   works at the PC itself; until then the PC refuses the MacBook's requests.
2. On the MacBook, the runner list in the Ctrl+K bar now has **Claude Code on PC** and **Codex on PC**. The bar
   says where it runs: "runs on PC, its plan, and comes back by sync".
3. The run happens on the PC, in the PC's copy of the file, with the PC's model choice for the prompt and on the
   PC owner's plan. Its steps and its reply stream back to the bar, **Stop** stops it there, and its changes
   come back through device sync like any other edit. The PC's run history records it with who asked.
   What it changed and **Undo this run** work from the MacBook too, through the PC.

The file must have synced to the PC first; if not, the bar says so. Comments that mention `@claude` on the
MacBook still run on the MacBook, or not at all when it has no CLI: a comment is part of the document, and
nothing in a document starts a run on another device. Conversations live on the device that ran them, so after
a reload the MacBook's bar does not show a chat held on the PC.

## Conversations that remember

Every run starts a fresh CLI, which on its own knows nothing of the message before. So Bogen keeps the
conversation and tells each run what came before:

- The Ctrl+K bar and Ask on the phone send each message with a conversation id, kept per file on the
  device. The server keeps every turn in `conversations/<fileId>.json` in the data folder, next to the
  run history: what you said, what the agent answered at the end, which CLI it was, and the layers the
  run created or changed.
- The next run in that conversation gets a short transcript ahead of your message: the last 8 turns,
  at most 6000 characters, newest kept, each with the layer ids it touched. It does not matter which
  CLI ran a turn, so you can switch from Claude to Codex in the middle and Codex knows what Claude did.
- The conversation survives a reload and a restart of the server. The bar and the phone show it again
  when they open. **New chat** (next to the mode in the bar, at the top of the thread on the phone)
  starts a new one, and the agent forgets the old one.
- A phone and a computer share a conversation only when they use the same id. Each device keeps its
  own by default.
- **Run this again** in the run history runs a turn again in its conversation.

What is not passed on: the tool results of earlier runs, such as screenshots and layer trees. The
agent reads the layers again. Bogen could instead resume the CLI's own session, which would carry all
of that, but it would leave a session file in your CLI's history for every run, and it would only work
while you stay on one CLI. The transcript costs a few thousand characters of prompt instead.

## A race of agents

**3 directions** in the Ctrl+K bar starts several runs on the same request at once, with runners you
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

## Critique

**Critique** in the Ctrl+K bar asks an agent to review the selection or the page, and change nothing.
Type what to look at, or just press Enter.

- The run checks with `brand_check` (when the file has a brand), `design_lint`, `responsive_check` at
  390, 768 and 1440, and good practice for hierarchy, spacing, contrast, copy and states.
- It leaves at most ten comments, pinned to layers, each with a concrete suggestion and where it comes
  from (Brand, Lint, Widths, Practice). The Comments tab shows them under the critique's name.
- Its session only gets tools that read and comment. Tools that change a layer are not listed at
  all, the checks run with their fixes off, and the server refuses a write from it even if a client
  tried one. This is decided on the server by the run, not by what the CLI was told.
- **Fix it** under a note hands its suggestion to a fix run: a reply that asks the agent that wrote it,
  which then works like any [comment run](#ask-in-a-comment-claude-and-codex) and leaves the thread open for you.

Tested with stand-in CLIs that tried to write and to fix; never with a real model.

## Rebuild an image as layers

Right-click an image layer and choose **Rebuild as layers**, or paste an image into the Ctrl+K bar
(what you typed goes along as a note). A pasted image is placed on the canvas first, since the run
compares against it.

- The run gets the image attached. Codex takes it as `-i <file>`. Claude has no image flag in print
  mode, so the request goes in as one stream-json message (`--input-format stream-json`) with the
  image as a content block.
- The image is sent as stored when it is a PNG, JPEG, WebP or GIF under about 3.7 MB, else as a PNG
  rendered from the canvas at most 1568 px on its long side.
- The agent builds a new artboard of the same size next to the image, as real HTML and CSS in the
  file's brand, then compares the two with `visual_diff`, fixes the biggest differences and compares
  again, at most three rounds. The image itself stays as it was.
- **Run this again** in the run history attaches the image again.

One real run on 2 November 2026: `claude` on `haiku` got a 460 by 170 screenshot of the Ctrl+K bar,
described what it showed, rebuilt it as seven layers next to it with tokens for its colours, and
stopped after three rounds of `visual_diff` at 22.5% different pixels, mostly text a few pixels off.
69 s. Codex's `-i` path is tested with a stand-in CLI only.

## Ask in a comment: @claude and @codex

Press C, click a layer, and write a comment that mentions `@claude` or `@codex`. The CLI starts with
the thread and the layer as context and answers in the thread. Only you resolve or reopen a thread, in
the editor or on the phone: an agent cannot, also not when its run ends, and a reply leaves a thread as
it is. If it needs something from you, it asks in the thread.

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

Tested with stand-in CLIs that only agree, for both Claude and Codex, in the bar and in comments. With
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

Select a screen and click **Redo this screen…** in the Design inspector, or right-click the screen or one of its children and choose that action. It opens the existing agent prompt scoped to that artboard. Add optional feedback and choose your runner/model, then Send. Opening or cancelling it starts no run. Sending starts a new conversation, so it cannot accidentally resume another screen’s draft. Follow-up messages continue that revision in the same file; an Omarchy theme redo uses its internal branch. The original remains available for review. This is a design redo, not a page/file duplication action.

"Make this page again, I don't like it" used to end up as another page next to the first. Now it
becomes a **revision**: a named draft copy of the page's artboards (or the ones you selected) next to
the originals, with the file committed first so there is always a way back.

As you type, the prompt bar says what your message will do: **Redo** goes into a revision, a request
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

Every run gets the language: the prompt bar, comments (the file default), the phone, races, runs on a
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
the Ctrl+K bar, under the thread a comment run answered, on the run in the run history, and on the phone
under an answer in Ask and in the comment sheet.

- It reverts the run's own entries in the [timeline](history.md) together, in one change by you, which
  History lists and can itself revert.
- What someone changed since in the same place stays, and the reply says which values stayed. Other
  people's and other agents' edits are never touched.
- The conversation stays: the agent's reply is what was said, not what was done.
- A run that is still going has to be stopped first. A run is taken back once, and then says who did it.

## What a run changed

When a run ends, its reply in the Ctrl+K bar and in the thread says what changed: the layers it changed,
by name, as links that select them and bring them into view (a removed layer is struck through), and a
small picture of the top-level layer most of them sit in, before and after. The picture is left out when
nothing visible changed, such as a hidden layer or a name. Pictures of the newest 60 runs per file are
kept in `run-shots/<fileId>/` in the data folder; the names stay in the run history.

## Let agents show you things

An agent can select layers in your editor or bring them into view, to point at what it means. It
waits while you drag or type. Turn **Let agents show me things** off in the Agents tab to stop it.

## Run settings and run history

The Agents tab keeps:

- **Run settings:** model and effort per runner, for the prompt and for comments, and how many runs
  of each runner a race starts at once. They are saved in `run-settings.json` in the data folder.
- **Run history:** per file, every run with its prompt, runner, model, effort, tools, duration,
  result, layers touched and status, with **Stop** and **Run this again**. It survives a restart. A run
  that was asked once more to make the change says so.
- **Run reports:** when the file has a brand, a run ends with its brand score and what is still
  open. See [Brands](brand.md).

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
the prompt still start at once or are refused, since the person waits for them in the bar.

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
