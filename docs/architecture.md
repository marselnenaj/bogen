# Architecture

How the repository fits together, for someone about to change it. To only use Bogen, the
[user guide](guide/README.md) is enough. How to build and test is in [building](building.md). The full contract
between the packages, with every route and field, is in the [spec](SPEC.md#contracts-between-packages).

## The one idea

A design is a **Yjs document**, and everyone who changes it is a peer of that document: the editor in your browser,
another person, an agent over MCP, and another of your devices. Multiplayer, agents and device sync are therefore not
special cases. The server holds one replica per open file, saves it, and renders it in headless Chromium with the same
rules the editor and the exports use, so canvas, screenshot and export agree.

```text
   editor (browser)        agents (MCP)           other devices          your phone
  y-websocket, /events    stdio relay or /mcp    tailnet peer link       tailscale serve
          \                      |                      |                     /
           `------------ packages/server: one Room per open file -----------'
                          |            |              |             |
                    Storage (disk)  Renderer     Timeline,      Runs: your own
                    files/, assets/ (Chromium)   commits        claude / codex
                          |
                    packages/core: the document model, HTML import, render rules, exports
```

## Where things live

| Path | What it is |
| --- | --- |
| `packages/core` | The document model (`doc.ts`, class `BogenDoc`), HTML import and its sanitiser (`html-import.ts`), render rules (`render.ts`), layer rules for pseudo-elements and conditions (`layer-rules.ts`), components (`components.ts`), responsive variants (`responsive.ts`), prototypes and their state machine (`prototype.ts`), motion as CSS and Framer Motion (`motion.ts`), libraries, rich text (`text-model.ts`), and the HTML, JSX and Tailwind exports. No Node and no DOM APIs: the server and the editor both import it as source. |
| `packages/server` | The `bogen` command and package `bogen-design`. `cli.ts` parses commands; `http/server.ts` is `BogenServer`; `sync.ts` holds the rooms; `storage.ts` the data folder; `render.ts` and `exporter.ts` render and export; `mcp/` the MCP server; `peers.ts` device sync; `phone.ts` the phone listener; `agents.ts` and `comment-runs.ts` start your CLI. |
| `packages/server/src/mcp` | `gateway.ts` serves Streamable HTTP at `/mcp`, one MCP server per session; `relay.ts` is `bogen mcp` over stdio; `kit.ts` defines tools; `tools-*.ts` the tools by area; `guide.ts` the server instructions and `guide_get`; `resources.ts` and `prompts.ts`. |
| `apps/editor` | The React editor, built by Vite and served by the server. `canvas/` draws and edits layers, `panels/` the inspector and the other panels, `doc/` the Yjs session and offline storage, `phone/` the phone layout, `pwa/` the service worker. |
| `integrations/omarchy` | The installer, bar widget (`plugin/`), Hyprland rules, theme hooks, user service and `deploy.sh`. |
| `integrations/arch` | The Arch `PKGBUILD`. |
| `scripts/` | Generators and checks: the MCP reference, icons, app icons, third-party notices, the link check, the npm release, Capture fidelity. |
| `docs/guide` | The user guide, which the website also builds. `docs/SPEC.md` is the feature matrix and the contracts. |

## The document

A file is one `Y.Doc` with these top-level maps (`packages/core/src/doc.ts`):

| Map | Holds |
| --- | --- |
| `nodes` | Every layer by id, each a `Y.Map` of its fields: `type`, `parent`, `order` (a fractional index), `tag`, `style`, `text`, `attrs` and so on. A layer's parent is another layer or a page. |
| `pages` | Pages and their order. |
| `tokens`, `modes`, `textStyles` | The design system: tokens with a value per theme mode, the modes, and text styles. |
| `comments` | Threads pinned to layers or places. |
| `meta` | The file's kind (`brand` for a brand document), linked brand, code project and library. The file's name is in the data folder's `index.json`. |

Further maps are additive: brands keep `brandFields`, `brandItems` and `brandVersions`; libraries add
`libraryPublished` and `libraries`; Capture adds `snapshotSources`; prototypes add `variables`, with what a layer
does in its `proto` field (`prototype.ts`). A text layer's words are a `Y.Text` under `rich`,
mirrored into `text` and `spans` in the same transaction for older builds. Instances of components are one stored
layer: what is inside them is computed by `components.ts`, and their ids are `<instance>/<layer in main>`.

**Rule for changes:** new fields are additive. An older build must be able to open a newer document and keep what it
does not understand. The spec lists every field under
[contracts between packages](SPEC.md#contracts-between-packages).

**Who changed what.** Every transaction has an origin: `agent:<name>` for MCP, `peer:<id>` for another device,
`person:<name>` for a comment through the API, and the socket for an editor. The timeline (`timeline.ts`) logs each
change per device with the values before and after, and undo per agent (`Y.UndoManager` per origin in `sync.ts`) uses
the same origins.

## The server

`BogenServer` (`packages/server/src/http/server.ts`) owns storage, the rooms, the renderer, MCP, runs, brands,
libraries, history and peers. A `Room` (`sync.ts`) is one open file: its document, awareness, connected sockets and
undo managers. Rooms load on demand and save through `Storage` (`storage.ts`).

### Storage

The data folder (`$BOGEN_HOME`, by default `~/.local/share/bogen`) holds:

| Path | What | Written |
| --- | --- | --- |
| `files/<id>.ydoc` | The last full save of a document, one Yjs update (V1) | Whole, atomically, fsynced |
| `files/<id>.updates` | The updates since that full save, for a file over 1 MB (`doc-log.ts`): length, CRC-32 and bytes per record | Appended and fsynced per batch, 400 ms after an edit, at most 3 s later |
| `files/<id>.ydoc.bak` | The full save before the last, kept while the next one replaces it | By the full save |
| `index.json` | The list of files and folders, as compact JSON | Soon after a rename, move or new file; within 5 s for a change of edit time alone |
| `history/<id>/` | The timeline (`changes-<device>.jsonl`, thinned by age and size), versions, commits, and `recent-edits.json` for Home | Per change |
| `assets/<sha256>.<ext>`, `thumbs/<id>.webp` | Content-addressed assets, previews | Atomically |

A small file is saved whole after each burst of edits. A big one appends each update to its log instead, so that a
small edit costs what it changes and not what the file weighs; the log is folded into a full save when edits have
paused for 15 s and it holds 4 MB or an eighth of the full save, at once past 64 MB, when the file is unloaded and
when the server stops. A full save writes the new file and fsyncs it, moves the old one to `.bak`, puts the new one in
place and then removes the log; a crash between those steps loads from `.bak` and the log, and replaying a log that a
full save already holds changes nothing. Reading stops at the first log record that does not check out, so a torn
append loses only that record. Read documents with `Storage.loadDoc` or `readDoc` (full save and log together) and
replace one with `Storage.writeDoc`, never through `docPath` directly. Temporary files of interrupted writes are
removed on start once they are ten minutes old.

### Listeners and who may do what

| Listener | Address | Who gets in | Code |
| --- | --- | --- | --- |
| Main | `127.0.0.1:29990`, or `--host` with a token | Loopback Host and same-origin Origin; with a token, the token | `http/security.ts`, `checkRequest` |
| Tailnet | port 29990 on the `tailscale ip -4` address | The device token as Bearer only; local-only routes closed | `peers.ts`, `tailnet.ts` |
| Phone | `127.0.0.1:29991`, behind `tailscale serve` on 29443 | `ts.net` Host, same Origin, allowed `Tailscale-User-Login`, a paired phone's token | `phone.ts`, `Phone.check` |

Before any of this, `pathRefusal` (`http/security.ts`) refuses a path in any spelling but its plain one (empty or dot
segments, backslashes, encoded slashes, dots or NUL), on every listener and for upgrades, since the closed-route lists
match the path as written while routing splits it into segments.

Inside a route, two questions decide the rest:

- `fromThisDevice(req, guard)`: a request from this machine directly, not through a proxy, the tailnet or the phone.
  Needed for anything that uses the machine: its disk, its local network, code projects, live site mode, Git, the
  Figma token, phone settings, pairing devices and the tailnet listener (`/api/peers`).
- `fromOwner(req, guard)`: this machine, or a paired phone. Needed to start agent runs, comment for agents, decide on
  proposals and waive brand rules.

[SECURITY.md](../SECURITY.md) describes the threat model in full.

## MCP

`bogen mcp` is a small relay (`mcp/relay.ts`): it starts the server if needed, then passes messages between stdio and
`/mcp`, holding them across a reconnect. All tools run in the server, on the room's document, with the origin
`agent:<client name>`.

A tool is defined with `define(name, meta, schema, handler)` from `mcp/kit.ts`. `define` adds what every tool needs:
uniform errors, the agent's presence on the canvas, the activity feed, the brand checks after a write, and the MCP
annotations (`readOnlyHint`, `destructiveHint`).

### Adding a tool

1. Pick the area's file in `packages/server/src/mcp/tools-*.ts`, or add one and call its `register…Tools(define)` from
   `registerAllTools` in `mcp/tools.ts`.
2. Call `define` with a name in the style of the others (mostly `area_verb`, such as `layer_rename`), a description written for a model (what it is for, when
   to use it, what it returns), `readOnly: true` if it changes nothing, and a Zod schema. Take `file_id` and `page_id`
   as optional arguments like the other tools.
3. In the handler, get the file with `ctx.room(file_id)`, change it inside `ctx.write(room, () => …)` so that it is one
   undo step for this agent, and report the layers it touched with `ctx.touch(ids)`.
4. If an agent should know when to use it, say so in `mcp/guide.ts`. The Bogen skill is made from the same text
   (`skill.ts`).
5. Add it to a group at the top of `scripts/gen-docs-reference.ts` and run `npx tsx scripts/gen-docs-reference.ts`, which
   rewrites [the MCP tool reference](guide/reference/mcp-tools.md). Update the tool count in the README, the guide and
   the changelog.
6. Test it in `packages/server/test/` with `startServer` and `connectAgent` from `test/helpers.ts`, which start a real
   server in a temporary data folder and connect a real MCP client.

## Render paths

There is one set of rules for turning a layer into HTML and CSS: `renderSpec` and `layerRulesCss` in `packages/core`.

- **The editor** (`apps/editor/src/canvas/NodeView.tsx`) renders each layer as a real element from those rules, and
  draws selection, handles and guides on top.
- **Screenshots and exports** (`packages/server/src/render.ts`) write the page with `exportDocument` from core and load
  it in one shared headless Chromium through `puppeteer-core`. PNG, JPG, WebP, PDF and `canvas_screenshot` come from
  there; video is rendered frame by frame at exact times; SVG is converted to vector elements in `svg-vector.ts`.
  The browser reaches the network only through the proxy in `egress-proxy.ts` (unless it is the `secure-chromium`
  wrapper, which brings its own), which resolves each name once and refuses private addresses.
- **Code** (`export.ts`, `react-export.ts`) writes HTML, React and Tailwind from the same rules.

Shader layers run `@paper-design/shaders` in the editor, and in renders through `dist/shader-runtime.js`. Code
components render in a sandboxed frame from `/api/code/:project/frame` (`code-build.ts`).

## Voice calls

`speech/` serves a call with the agent at `/api/call/*`: `status`, `install` (this computer only, downloads a voice
or the listening model into `$BOGEN_HOME/speech/` and keeps it only when its SHA-256 matches `speech/catalog.ts`),
`say` (one sentence to WAV) and `listen` (one utterance to text). The routes are for the owner, like voice notes,
and closed on the tailnet. Speech out is a `TtsEngine` (`speech/tts.ts`): Piper voices in ONNX Runtime's
WebAssembly build with eSpeak NG compiled to WebAssembly for the phonemes, and, the default English voice,
tiny-voca (two speakers in one 21 MB ONNX model) read through `speech/dizione/`, a TypeScript port of its
phonemizer dizione that test/dizione-golden.test.ts holds to the Python output; so no native binary. Speech in is
NVIDIA Parakeet TDT 0.6B v3 kept loaded on the CPU through sherpa-onnx-node (`ResidentParakeet` in `speech/hear.ts`),
with the open file's names as hotwords (modified beam search; sherpa-onnx turns them into tokens with a vocabulary
written from Parakeet's tokens.txt); a line in neither German nor English is dropped. Whisper large-v3-turbo on the
GPU through whisper.cpp (@fugood/whisper.node) is a choice (`?engine=whisper`), primed with the same names
(`speech/context.ts`); Whisper base through Voxtype is the last resort. What the voice says comes from `@bogen/core`'s `CallBrain` (`call-brain.ts`): each turn is answered here
from the screen and the call so far, asked back when it is too vague, or handed to the agent; the agent's text is
retold, never read out, unless the agent ended with a `<say>` block for the call. The call is the host: a request is
collected into a draft until the person is quiet (`draftQuietMs`) or says go, read back when it took several turns,
holds a correction or redoes a lot, and sent as a brief (`briefMessage`: the talking layer's goal and constraints,
the person's words marked as speech recognition, corrections, and what else was said to the voice). Only work
(`asksForWork`: a change or a look at the design) reaches the agent; questions about progress and small questions
are answered by the voice, and remarks and thanks are only kept as context. The talking layer (`speech/persona.ts`) is Claude Code on the person's plan when it is signed
in (one session to decide turns, one to word lines), else a small local model, else rules; `/api/call/talk` adds the
file, page, artboards and selection by name, and the file's runs as the server records them (`runTruth`: whether the
agent works comes from that record, also for runs the call did not start). With Claude Code, `turnModel` is on: the
talking layer decides and words every turn in one answer (`kind: 'turn'`, an `@action` line and the words below it,
read by `parseTurn`), so its first sentence is spoken while the rest is written; work still goes through the draft,
steer and queue paths above, a named file through the file switch. The rules (`routeByRules`) then only act when it
does not answer within `turnTimeoutMs`, and even then never hand chat to the agent. `/api/call/log` keeps every heard and spoken line with the chat
(`Conversation.call`), with the engine that heard each person's line and, for a stretch taken for noise, why. Before
Whisper, `listen` runs Silero VAD v6.2.0 through whisper.cpp (`ResidentVad`, CPU, a few ms) and does not transcribe
a stretch with under 250 ms of speech; `@bogen/core`'s `call-noise.ts` then drops Whisper's known made-up lines when
little speech was behind them, and `CallBrain` ignores the call's own recent lines heard back. While the agent works,
a change to the task is collected for `steerQuietMs` and steered (`BrainSinks.steer`): the editor stops the run with
`?gentle=1` (SIGINT, which ends Claude Code's turn cleanly) and sends the brief with `call.steer`; `Runs` keeps one
Claude Code session per call conversation (`callSessions`, an empty folder per conversation as its working
directory, `--resume` instead of `--no-session-persistence`), so the next run continues it without the transcript.
A follow-up in the same file and conversation (call or chat, `sessionKey`) resumes it too while that session holds
the conversation's latest turn, on the same model, within `RESUME_WINDOW_MS`; a session that is gone falls back to a
fresh run with the transcript. Codex starts afresh with the transcript, as before. At a run's end the call keeps the
whole answer as points (`call-result.ts`), speaks the gist and top points, and tells the next points for "the rest". A call run's system prompt (`callLines`) tells the agent about
the call and the `<say>` block; a task marked for later is queued; "keep me updated" turns on short
progress lines from the agent's latest tool or words. The editor's `call/` keeps the mic (echo cancellation on, an
energy detector that cuts utterances) and the voice queue; barge-in stops the voice and spoken commands stop or undo
the run.
A new engine is a new `engine` value and catalogue entries; the panel lists the
catalogue.

## Sync

- **Editors** connect to `WS /sync/:fileId` with the stock y-websocket protocol, and to `WS /events` for JSON events
  (files, activity, runs, theme).
- **Devices** (`peers.ts`) exchange state vectors and diffs per file over a WebSocket link per peer, catch up fully on
  every connect and periodically, pull assets by hash, send deletes as tombstones, and pass the timeline and commits
  on (`timeline-sync.ts`). Every request says `X-Bogen-Version` and `X-Bogen-Features`, so a newer build only sends
  what the other side understands.
- **Conflicts** (`sync-conflicts.ts`) are found when a catch-up applies: values both sides set while apart, from
  each Y.Map key's chain of writes. Text layers merge per character in their `Y.Text`, unless the link was down
  (`apart` in the sync request and answer) and both sides' edits touch one word or each other (`textsClash`); then
  the device that merges first gives the layer a fresh `Y.Text` with the kept side's text (`replaceLayerText`) and
  sends the other its note. Two devices doing so at once converge, since the layer's map keeps one `Y.Text`.
- **The phone** uses the same y-websocket and event sockets through its own listener, and keeps files in IndexedDB
  (`apps/editor/src/doc/offline.ts`).

## Tests

| Where | What | Needs |
| --- | --- | --- |
| `packages/core/test` | The document model, import, rules, components, text | Node |
| `packages/server/test` | The server, MCP, sync between two real servers, brands, exports, Capture against local fixtures | Node, and Chromium for render tests |
| `apps/editor/test/*.test.ts` | Geometry, render rules, offline storage, touch, the service worker | Node |
| `apps/editor/test/e2e` | Real mouse and keyboard in Chromium against the built editor, with a mock or a real server | A built editor and `/usr/bin/chromium` |

`npm test` runs the first three with Vitest. The browser suites run one at a time; [building](building.md#browser-suites)
lists them. Agents in tests are stand-in CLIs, so no test uses a plan, and no test touches your data folder or a
running Bogen.
