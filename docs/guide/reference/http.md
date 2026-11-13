# HTTP and WebSocket

The server's own interface, used by the editor, the CLI, the Omarchy widget and paired devices. The
default address is `http://127.0.0.1:29990`. Agents should use [MCP](mcp-tools.md) instead; it is the
supported interface for them.

This page follows the contracts in `docs/SPEC.md`. Bodies are JSON unless the route says otherwise.

## Access

- Without a token the server answers only on `127.0.0.1` or `localhost` at its own port, and refuses
  foreign `Origin` and `Host` headers and cross-site requests.
- With `--token`, every request needs `Authorization: Bearer <token>`. A browser can open
  `/?token=<token>` once instead. WebSocket upgrades may carry `?token=`.
- Routes marked **this machine** answer only a direct request from this computer: not a team member
  with the token, not a paired device, not a request through a proxy.
- On the Tailscale listener, everything needs the device token, and these answer nothing, token or
  not, since they configure this machine or start programs on it: `/api/peers`, `/api/runs`, `/api/races`,
  `/api/run-settings`, `/api/comments`, `/api/omarchy`, `/api/live`, `/live-mcp`,
  `/api/notifications`, `/api/brands`, `/api/libraries`, `/api/code`, `/api/agents/steps`, `/api/voice`,
  `/api/tomacco`, `/api/publish`, `/api/shares`, and
  `/api/files/:id/` `away`, `conflicts`, `libraries`, `proposals`, `drift`, `restyle` and `brand`.
- Routes marked **editor** answer only the editor on this machine: a browser's request from the
  editor's own origin, with `Sec-Fetch-Site: same-origin`. MCP clients and the CLI get 403.

## Status and files

| Route | What it does |
| --- | --- |
| `GET /` | The editor. |
| `GET /api/status` | `{ version, port, files, agents: [{ name, fileId, fileName, status: 'working'\|'idle', lastTool, at }], update }`. `update` is `{ version, current, notes?, how }` when the daily check found a newer release, else `null`. |
| `GET /api/files` | `[{ id, name, updatedAt, thumbnail? }]` |
| `POST /api/files {name?}` | Makes a file: `{ id, name }`. |
| `PATCH /api/files/:id {name}` | Renames it. |
| `DELETE /api/files/:id` | Deletes it. |
| `POST /api/files/:id/duplicate` | Copies it. |
| `WS /sync/:fileId` | The y-websocket protocol (sync and awareness). Works with the stock `WebsocketProvider`. |

## Events

`WS /events` sends JSON messages:

| Message | When |
| --- | --- |
| `{t:'files'}` | The list of files changed. |
| `{t:'activity', fileId, agent, tool, nodeIds, at}` | An agent changed something. |
| `{t:'agent', runId, fileId, kind:'text'\|'tool'\|'done'\|'error', text?, tool?}` | Progress of a run. |
| `{t:'theme', theme}` | The Omarchy theme changed. |
| `{t:'comment-run', fileId, threadId, runner, status, runId?, tool?}` | A run from a comment: `queued`, `working`, `done`, `failed` or `stopped`. |
| `{t:'run-history', fileId}` | The run history of a file changed. |
| `{t:'sync-conflicts', fileId}` | Conflict notes changed. |
| `{t:'brand', id}`, `{t:'brand-report', fileId, runId, score, ...}` | A brand changed; a run ended with a brand report. |
| `{t:'library', id}` | A library was published, here or on another device. |
| `{t:'peers'}` | Paired devices changed. |

## Assets

| Route | What it does |
| --- | --- |
| `POST /api/assets` | Raw body with its `Content-Type`. Returns `{ name, src: 'bogen-asset:<name>', url: '/assets/<name>' }`. Up to 64 MB for images and fonts, 512 MB for video. |
| `GET /assets/:name` | The asset. Answers `Range`, `If-Range`, `If-None-Match` and `HEAD`. |

Asset URLs in documents are `bogen-asset:<name>`. An image with no `src` is a placeholder.

## Export

| Route | What it does |
| --- | --- |
| `POST /api/export {fileId, nodeIds, format, scale?, duration?, fps?, encoder?, svgMode?}` | The file's bytes. `format` is `png`, `jpg`, `webp`, `avif`, `svg`, `pdf`, `html`, `mp4` or `webm`. The report is in the `X-Bogen-Export-Report` header, URI-encoded JSON. |
| `POST /api/export/presets {fileId, nodeIds, presets:[{format, scale?\|width?, suffix?}]}` | A zip of several sizes. |

## Capture, import and data

| Route | What it does |
| --- | --- |
| `POST /api/capture/site {url, fileId?, widths?, schemes?, limit?, captureFonts?}` | NDJSON progress, ending with `{t:'done', report}`. |
| `POST /api/import/figma {url, token?, saveToken?, fileId?, name?}` | The import report. |
| `GET\|DELETE /api/config/figma` | The saved Figma token. This machine. |
| `POST /api/data/fetch {url, path?, format?}` | `{ records }` from a public JSON or CSV address. |
| `GET /api/tomacco/devices` | The devices `tomaccoctl` sees. This machine. |
| `GET /api/tomacco/status[?fresh=1]` | Whether a screen can be taken now: `state` `missing`, `no-device` or `ready`, the devices, `doctor`'s next steps and `fix`, the command to show. This machine. |
| `POST /api/tomacco/screen {source}` | Reads a screen export: `{ screenId, summary, png }`. `source` is `{device, platform?}` or `{path}` (this machine), or `{json, png}` with the PNG in base64. |
| `POST /api/tomacco/import {fileId, screenId? \| source?, pageId?, text?, frame?, screenshot?, name?, beside?, plan?}` | Places the screen as an artboard, beside the artboard of the layer `beside` when given. See [Tomacco](../tomacco.md). |
| `POST /api/tomacco/compare {fileId, nodeId, screenId? \| source?}` | Design versus app: pixels, matched elements, pictures in base64. |

## History

| Route | What it does |
| --- | --- |
| `GET /api/files/:id/timeline` | Commits and changes in one list. |
| `POST\|GET /api/files/:id/commits`, `GET .../commits/:cid` | Make and list commits; one commit. |
| `GET .../compare?from&to`, `GET .../compare/render?from&to&page` | Compare two versions, as data or as a picture. |
| `POST .../changes/plan {ids?\|run?}` | What a revert would take back, and its conflicts. |
| `GET\|POST .../branches`, `POST .../branches/:b/merge`, `DELETE .../branches/:b` | Branches. |
| `POST .../git {action, dir?, message?, rev?}` | The Git layer. This machine. |
| `GET .../folder`, `POST /api/files/import-folder` | Design folders. |
| `POST /api/files/:id/compliance/run {pageId, nodeId?, profile, legal?}` | The accessibility and legal check of a page or an artboard: every criterion with its status, evidence and test, the score, and legal reminders. `compliance_check` |
| `POST /api/files/:id/compliance/statement {pageId, profile, language?, fields?}` | A draft accessibility statement, `{markdown, html, open_fields}`. `compliance_statement` |
| `POST /api/files/:id/compliance/export {pageId, nodeId?, profile, legal?, format, statement?, language?, fields?}` | The check as an HTML or PDF report. |
| `GET /api/files/:id/away` | What changed while nobody had the file open, once. |
| `GET /api/files/:id/conflicts`, `DELETE /api/files/:id/conflicts/:cid?` | Conflict notes from sync. |
| `POST /api/files/:id/replay {pageId? \| page?, from?, to?, run?, scale?}` | NDJSON progress of rebuilding a replay, ending with `{t:'done', replay}`: its steps, pictures' places and frame. |
| `GET /api/files/:id/replay/:rid/shot/:n.png` | One picture of a kept replay, for 15 minutes. |
| `POST /api/files/:id/replay/export {format, pageId? \| page?, from?, to?, run?, speed?, maxIdleMs?, width?, height?, fps?, camera?, captions?, cursors?, fromStep?, toStep?}` | The film's bytes, MP4, WebM or GIF, with the report in `X-Bogen-Export-Report`. `bogen replay` |

## Agents and runs

| Route | What it does |
| --- | --- |
| `GET /api/runners` | `[{ id: 'claude'\|'codex', available, version? }]` |
| `POST /api/runs {fileId, pageId, nodeIds, prompt, runner, model?, effort?, review?, conversationId?}` | `review` is `direct`, `proposal`, `directions` or `critique`, which only reads and comments. `conversationId` makes the run a turn of that chat: it gets the earlier turns ahead of `prompt`. Starts a run: `{ runId }`, progress over `/events`. One run per file; a second gets 409. This machine. |
| `POST /api/runs/:id/stop` | Stops it, also a run asked of another device. |
| `POST /api/runs {..., device}` | With `device`, a paired device that allows it runs it: `{ runId, device }`, and its events come over `/events` as if it ran here. The owner only. |
| `GET /api/runs/remote` | Paired devices that let this one ask their agents: `[{ deviceId, device, allowed, runners }]`. The owner only. |
| `GET /api/runs/remote/allow`, `POST /api/runs/remote/allow {deviceId, allow}` | Which paired devices may ask agents here. Only from this machine itself. |
| `GET /api/runs/queue` | Runs going and comments waiting over all files: `{ limit, running: [...], queued: [{ kind: 'comment'\|'race', id, fileId, fileName, runner, title, reason }] }`. |
| `POST /api/runs/queue/move {id, to}`, `POST /api/runs/queue/cancel {id, who}` | Moves a waiting comment in the queue, or takes it or a race lane (`raceId.laneId`) out. The owner only. |
| `POST /api/runs/:id/undo {fileId, who}` | Undo this run: reverts everything it changed as one change, leaving the thread and what changed since. `{ reverted, clean, conflicts, changes }`. The owner only. |
| `GET /api/runs/:id/summary?fileId=`, `GET /api/runs/:id/shot?fileId=&which=before\|after` | What a run changed: `{ layers: [{ id, name, gone? }], shots?, undone? }`, and its pictures as WebP. |
| `POST /api/agents/check {runners?, model?}`, `GET /api/agents/check[/:id]` | The smoke test of both CLIs, in a throwaway server: starts it (202), or the last one with its cases. An `agents-check` event on `/events` says it moved. The owner only. |
| `POST /api/runs/rebuild {fileId, nodeId, runner, model?, effort?, prompt?}` | Rebuilds an image layer as layers next to it, with the image attached: `{ runId }`. This machine. |
| `POST /api/races {fileId, pageId?, nodeId, prompt, lanes:[{runner, model?, effort?}], who}` | A race: one proposal and one run per lane, 2 to 4. Returns the race with its lanes. This machine. |
| `GET /api/races?fileId=` | Races of a file while the server runs, newest first, with each lane's status. A `race` event on `/events` says one changed. |
| `POST /api/races/:id/stop {laneId?}`, `POST /api/races/:id/accept {laneId, keep:'discard'\|'branch', who}`, `POST /api/races/:id/discard {laneId, who}` | Stop one lane or all; accept one lane, which stops the others and discards them or branches the file first; drop one lane's copy. This machine. |
| `GET /api/runs?fileId=`, `GET /api/runs/recent?limit=`, `POST /api/runs/:id/rerun {fileId}` | Run history. |
| `GET /api/runs/conversations?fileId=` | The chats of a file, the one talked in last first: `[{ id, title, startedAt, updatedAt, turns, runners, running }]`, where `title` is the first message on one line. |
| `GET /api/runs/conversations/:id?fileId=` | The turns of one chat: `{ id, turns: [{ runId, at, runner, message, reply?, layers, status, review?, nudged? }] }`, oldest first; none for an id the server does not know. |
| `GET /api/run-settings`, `PATCH /api/run-settings {runner, scope:'prompt'\|'comment', model?, effort?, shareCursors?, limit?}` | Model and effort choices, and `limit`: how many runs of a runner a race starts at once (1 to 4). `null` clears; `default` means no flag. |
| `POST /api/agents/undo {fileId, agent}` | Undoes an agent's last step. |
| `GET /api/agents/steps?fileId=`, `POST /api/agents/steps/undo {fileId, stepId}`, `GET /api/agents/steps/:id/preview?fileId=&which=before\|after` | The activity feed: steps, undo of one step, before and after pictures. |
| `POST /api/comments {fileId, text, author, threadId? \| pageId?, nodeId?, x?, y?, model?}` | Writes a comment: `{ threadId, messageId, started, refused? }`. A mention starts or queues a run only for a direct request from this machine. |
| `GET /api/voice/status[?fresh=1]` | Whether this computer can write out voice notes, and with what (`transcriber: { kind, name }` or null); `fresh=1` looks again at once instead of after a minute. The owner only. |
| `POST /api/voice?fileId=&duration=` | A recording as the raw body with its audio `Content-Type`, up to 10 MB: `{ transcript }`, or `{ transcript: null, reason, attachment }` when it is kept as a voice note. The owner only: this machine or a paired phone. |
| `GET\|DELETE /api/voice/:id.:ext` | A kept voice note. The owner only. See [Privacy](../privacy.md#voice-notes). |
| `GET /api/comments/runs?fileId=` | Runs from comments in progress and waiting, with `steps` so far, `queueId` and the `reason` one waits. |

Comments that a client writes into the document itself never start a run.

## Live site mode

| Route | What it does |
| --- | --- |
| `GET\|POST /api/live/sites`, `DELETE /api/live/sites/:id` | Open and close live sites. |
| `POST /api/live/sites/:id/runs {prompt, runner, model?, effort?, element?}` | A run on the project. |
| `/live-mcp/<token>` | The file tools of one run; stops working when it ends. |

## Brands

`GET|POST /api/brands`, `GET|PUT /api/brands/default`, `GET|PATCH|DELETE /api/brands/:id`,
`POST /api/brands/:id/duplicate`, `POST /api/brands/:id/versions`, `GET /api/brands/:id/diff?from=&to=`,
`GET /api/brands/:id/impact`, `POST /api/brands/:id/apply`, `GET /api/brands/:id/brief`,
`GET /api/brands/:id/sheet.html|sheet.png|guide.md|guide.pdf`, `GET|PUT /api/files/:id/brand`,
`POST /api/files/:id/brand/check`, `POST|DELETE /api/files/:id/brand/waivers`,
`GET /api/brands/:id/memory` (decisions and rule suggestions), `POST /api/brands/:id/memory/:suggestion {action:'add'|'dismiss', by}` (this machine).

## Code components and libraries

| Route | What it does |
| --- | --- |
| `GET /api/code/projects`, `POST /api/code/projects {dir, fileId?}`, `DELETE /api/code/projects/:id` | Linked projects. Linking is from this machine only. |
| `GET /api/code/:project/components` | Its components and props. |
| `POST /api/code/:project/measure` | Measures a component. |
| `GET /api/code/:project/frame?file=&name=` | The sandboxed frame, with a CSP sandbox. |
| `GET /api/libraries`, `GET /api/libraries/:id`, `GET /api/files/:id/libraries` | Shared libraries. |

## Omarchy and notifications

| Route | What it does |
| --- | --- |
| `GET /api/theme` | `{ name, mode:'dark'\|'light', vars: { '--ui-bg': '#...', ... }, font? }`, or `null` when not on Omarchy. |
| `POST /api/omarchy/reload` | Reads the theme again and broadcasts it. The theme hook calls this. |
| `GET\|POST /api/omarchy/palette` | The active palette as tokens. |
| `GET /api/omarchy/themes` | `{ onOmarchy, themes, apply, screens }`: the installed themes, what Undo apply would restore, and the screen sizes. |
| `POST /api/omarchy/themes` | `{ from?, name? }`: a new theme file, from an installed theme or from nothing. |
| `GET\|PATCH /api/omarchy/theme/:fileId` | A theme file's name, mode, icons, files and problems; PATCH sets `name`, `mode` or `icons`. |
| `POST /api/omarchy/theme/:fileId/export` | `{ to: 'tar' }` answers a .tar.gz, `{ to: 'files' }` the files as base64, `{ to: 'folder', dir, git? }` writes a new or empty folder. |
| `POST /api/omarchy/theme/:fileId/install` | `{ overwrite? }`: into `~/.config/omarchy/themes/<name>`. 409 when that theme exists and `overwrite` is not set. |
| `POST /api/omarchy/apply`, `POST /api/omarchy/undo-apply` | `{ name }`: runs `omarchy theme set`, noting the theme in use; undo goes back to it. Only on a click in the editor. |
| `GET /api/notifications?since=` | `{ seq, items }`, for the bar widget. |

## Publishing and review links

All of these are **this machine** only, and answer neither on the Tailscale listener nor the phone
listener. See [Publish](../export-and-code.md#publish) and [Sharing for review](../sharing.md).

| Route | What it does |
| --- | --- |
| `GET /api/publish[?fileId=]` | `{ sites, requests, shares, inbox, listeners: { site, review }, funnelPolicy }`. A site is `{ id, fileId, pageId, nodeId?, name, versions, live: { listener?, folder?, github? } }`; requests are agents' asks; shares come without their tokens. |
| `POST /api/publish/prepare {fileId, pageId?, nodeId?, title?, fit?}` | Makes a version: `{ site, version }`. Publishes nothing. |
| `GET /api/publish/versions/:version/files` | `[{ path, bytes }]` of a version. |
| `POST /api/publish/sites/:site/publish {version, target, path?, repo?, branch?, allowForeign?, fingerprint?}` | **Editor.** Sends a version to `listener`, `folder` (with `path`) or `github` (with `repo`, `branch` and the `fingerprint` of the plan you saw). 409 when a folder or branch holds files Bogen did not write and `allowForeign` is not set, or when a branch changed since the plan. |
| `POST /api/publish/sites/:site/github-plan {version?, repo, branch}` | What a push would send, remove and leave alone, with its `fingerprint`. Changes nothing. |
| `POST /api/publish/sites/:site/unpublish {target?}` | Takes the site back from one target, or from the listener and the folder when there is none. **Editor** for `github`, which pushes a commit. |
| `DELETE /api/publish/sites/:site` | Forgets a site and its versions, once it is live nowhere and no working link shows it. |
| `DELETE /api/publish/requests/:id` | Dismisses an agent's request. |
| `POST /api/publish/listeners/site\|review {on, public?, httpsPort?}` | Turns a static listener on or off, and Funnel. **Editor** to turn on or make public; off works from anywhere on this machine. `{ status, outcome }`. |
| `POST /api/shares {siteId, versionId, label, days?, maxViews?, comments}` | **Editor.** Makes a review link: `{ share, url, token }`, shown this once. |
| `DELETE /api/shares/:id` | Revokes a link. |
| `POST /api/shares/inbox/:id/accept` | **Editor.** Puts a client's comment into the file as a thread marked `client`. |
| `DELETE /api/shares/inbox/:id` | Deletes a client's comment. |

The static listeners have no API. The site listener answers `GET` and `HEAD` of the published files.
The review listener answers `GET` and `HEAD` under `/r/<token>/`, and one `POST`:
`/r/<token>/_review/comments`, an `application/x-www-form-urlencoded` form with `name`, `text`, `page`
and `at.x`, `at.y`, from a page of that origin only. It answers `303` back to the page.

## Device sync

Paired devices use `/api/peer/...` routes and a live link, among them `GET /api/peer/timeline`,
`.../timeline/:id/changes?device&after` and `.../timeline/:id/commit/:cid`. Every request and socket
carries `X-Bogen-Version` and `X-Bogen-Features`. These are for Bogen servers, not for scripts.

## Also served

Routes the CLI and the editor use that the spec does not list:

| Route | Used by |
| --- | --- |
| `POST /api/capture {url, fileId?, pageId?, pageName?, name?, width?, height?, colorScheme?, captureFonts?}` | `bogen capture <url>` |
| `GET\|POST /api/peers`, `POST /api/peers/pair`, `POST /api/peers/tailnet`, `DELETE /api/peers/:id` | `bogen peer` |
| `GET /api/fonts?q=` | The font picker |
| `GET\|POST\|PATCH\|DELETE /api/folders` | Folders on the home screen |
| `POST /api/files/import`, `GET /api/files/:id/download[?brand=0]` | Opening and downloading `.bogen` files. A download includes the linked brand unless `brand=0`, and says what it did in `X-Bogen-Brand`; an import answers with what became of the brand under `brand` |
| `GET /api/files/:id/folder[?brand=0]`, `POST /api/files/import-folder {name, content, brand?}` | `bogen export-folder` and `import-folder`, with the linked brand as a folder of its own |
| `GET /api/files/:id/thumbnail` | Thumbnails on the home screen |
| `GET /api/brands/templates`, `POST /api/brands/:id/template` | Brand templates |
| `GET /api/examples`, `POST /api/examples/:id` | Start from an example on the home screen |
| `POST /api/welcome` | `bogen welcome`, and Help, Welcome to Bogen |
| `POST\|GET\|DELETE /mcp` | MCP over Streamable HTTP |
