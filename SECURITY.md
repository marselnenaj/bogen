# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub's security advisories](https://github.com/marselnenaj/bogen/security/advisories/new),
not in a public issue. Without a GitHub account, write to <hello@bogen.dev>. Say which version or commit you used (`bogen status` shows both) and how to reproduce the
problem. Bogen is maintained by one person, so there is no guaranteed response time, but a report is answered as soon
as it has been looked at.

## Supported versions

Only the latest release gets fixes. Fixes land on `main` first.

## What is in scope

- The server and its listeners: everything a web page, another device, a paired phone, a visitor of a published
  site or review link, or a local process can make it do beyond what the documentation says.
- Publishing and review links: anything internal in a published file, a way past the static listeners' rules, a
  review link that works when it should not, or a client's comment that reaches an agent or the file on its own.
- The MCP server: a tool that reaches further than its description, or a way for document content to start a process.
- The sanitising of imported and synced content: HTML, CSS, SVG, layer rules, keyframes, brand data.
- The sandbox of code components, live site mode's file tools, and the address guard of Capture and data fetches.
- The handling of secrets: device and phone tokens, image provider keys, the Figma token.
- `bogen install`, the Omarchy installer, and the npm package.
- Releases and updates: a way to make `bogen verify` or `bogen update apply` accept a file the release key did not
  sign, and secrets that `bogen report` lets through in a shape it should have masked.

## The listeners

Bogen's server can listen in five places. Each has its own rules, in `packages/server/src/http/security.ts`,
`packages/server/src/peers.ts`, `packages/server/src/phone.ts` and `packages/server/src/static-listener.ts`.

### This machine: 127.0.0.1:29990

The default. There is no login for your own user: any program you run can use the API, the editor and MCP.

- **Your user only.** On Linux, a connection from another user of the machine is closed before a byte of it is read:
  the server looks up who owns the other end in `/proc/net/tcp` and lets in only its own user and root. A server
  started with `--token` skips this, since it may sit behind a proxy that runs as another user, and the token
  decides instead. The phone listener and live site mode's proxy check the same way.
- **The data folder** (`~/.local/share/bogen`, or `BOGEN_HOME`) is made owner-only (0700) at every start, and a
  folder that belongs to another user is refused.

- **Host check.** Without a token, the `Host` header must be `127.0.0.1`, `localhost` or `[::1]` on the server's own
  port. That stops DNS rebinding, where a web page points its own name at 127.0.0.1.
- **Origin check.** A browser's `Origin` must be the same origin as the `Host`, in every mode. A request marked
  `Sec-Fetch-Site: cross-site` is refused, and so is `same-site` (a page on another port of this machine). WebSockets
  and simple POSTs get no CORS protection, so this is what keeps other web pages out.
- **No Origin.** The CLI and MCP clients send no `Origin`, and pass.
- **What counts as this machine.** Some routes act on the machine itself: reading a folder on disk, linking a code
  project, live site mode, Git, the Figma token, phone settings, capturing `localhost`. They answer only a request
  whose socket comes from a loopback address and that carries no `X-Forwarded-For`, `Forwarded` or `X-Real-IP`
  header, so a request through a local proxy does not count.

### With a token: `--host` and `--token`

`bogen serve --host <address>` refuses to start without a token (`--token` or `BOGEN_TOKEN`). With a token, the token
replaces the Host check, so a server behind a proxy can be reached by its own name; the Origin check stays. The token
is accepted as `Authorization: Bearer`, as an `HttpOnly`, `SameSite=Strict` cookie that opening `/?token=<token>`
sets once, or in the query of a WebSocket upgrade, since browsers cannot set headers there. Tokens are compared in
constant time. `BOGEN_ALLOWED_ORIGINS` adds exact origins for a proxy in front.

This is one shared secret. There are no accounts, roles or per-file permissions: everyone with the token can do what
the person at the machine can do over HTTP, except the routes that need this machine.

### Paired devices: the tailnet listener

`bogen peer pair`, `bogen serve --tailnet` or `bogen peer tailnet on` add a second listener on port 29990 of the
address from `tailscale ip -4`, and only there.

- **Strict token.** Every request needs this device's token as `Authorization: Bearer`. No cookie and no query token
  are accepted. Without a token the listener answers 503.
- **Closed routes.** Whatever the token, it answers nothing on the routes that start agent runs, post comments, or
  touch brands, libraries, live site mode, code projects, run settings, the inbox, notifications, voice notes, app screens,
  Omarchy, phones or other peers, and it answers nothing on `/mcp` and `/live-mcp` (`isLocalOnlyPath` in `peers.ts`). Files sync
  through their own peer link. The rest of the API answers a request with the token: a paired device is trusted
  with your files, but an agent there uses its own Bogen, not yours.
- **Peer addresses.** A peer must be in `100.64.0.0/10`, `fd7a:115c:a1e0::/48` or `*.ts.net`. Only a server started
  with `--insecure-allow-any-host` accepts others.
- **Incoming documents** are checked for shape, assets for hash and size, and messages have size limits.
- **Asking this device's agents.** A paired device can ask for an agent run here through `/api/peer/runs` on the
  peer link, with the token and its device id, only after you allowed that device at this machine (Agents tab,
  Other devices; `remote-runs.json`, changed only by a request from this machine itself, never by the token or a
  phone). Until then it is refused with 403, and the offer it can read lists no runners. On the asking device only
  its owner in person can send the request (`fromOwner`). The run is an ordinary run here: Bogen tools only, on
  this machine's CLI and plan, in this machine's copy of the file. A comment synced from that device still starts
  nothing.

### Your phone: 127.0.0.1:29991 behind `tailscale serve`

`bogen phone on` starts a third listener on 127.0.0.1:29991 and has `tailscale serve` put it on port 29443 of the
computer's `ts.net` name over HTTPS. Every request must pass all of these:

- **Host.** The computer's own `ts.net` name on the HTTPS port.
- **Origin.** A browser's `Origin` must be that same `https://` origin. `cross-site` and `same-site` requests are
  refused, so another app behind `tailscale serve` on the same name stays out.
- **Login.** A `Tailscale-User-Login` header, which `tailscale serve` sets, on the allow list. By default that is the
  login that owns this node; a device shared in from another login does not get in.
- **Phone token.** The token of a paired phone, in a `__Host-` cookie the page cannot read, and bound to the login
  that paired it. Only the app shell and `/api/phone/pair` and `/api/phone/me` do without it.

Pairing uses an 8-letter code that works once, for ten minutes, and dies after five wrong tries. Only a hash of each
phone token is stored, in `phone.json` (mode 600). `bogen phone remove <id>` revokes a token at once and closes its
sockets.

A paired phone counts as the owner in person: it can start agent runs, comment for agents, accept and discard
proposals, change run settings and waive brand rules. It cannot reach the machine: MCP, live site mode, Git, peers,
phone settings, Omarchy, the config routes, pull requests, Storybook and repository tokens, publishing and review
links are refused on this listener (`phoneRefusedPath`), and the routes that
need this machine refuse it again.

A phone's own routes, besides pairing, are `/api/phone/forget`, `/api/phone/push` and `/api/phone/push/test`
(its notifications) and `/api/phone/hosts` (the computers it can use). Each needs that phone's token and acts only
for that phone. The rest of `/api/phone` stays this machine's.

The app shell on this listener carries two `<meta>` tags, `bogen-listener` and `bogen-host`, so the app knows it is
the phone app and which computer it talks to. They only steer the layout and the offline copies in the page; none of
the server's checks read them.

### Notifications on the phone

Web Push, implemented with `node:crypto` in `packages/server/src/push.ts`:

- **Keys.** One VAPID key pair (P-256) per paired phone, made on the first request of that phone, in `push.json`
  (mode 600). A phone's subscription is used only with its own keys. Removing the phone deletes its record.
- **Where it sends.** Only to the address a paired phone gave for itself, and only to a known push service: an
  `https` URL on the default port, no user info, host `*.push.apple.com`, `fcm.googleapis.com`,
  `*.push.services.mozilla.com` or `*.notify.windows.com` (`pushHostAllowed`), with redirects refused. Anything else
  is refused when the phone subscribes and again before every send, so the phone listener is no way to make the
  computer send requests to a host of a page's choosing.
- **What it sends.** RFC 8291 aes128gcm, encrypted for the phone's key and secret. The plaintext is
  `{title, body, url, tag, kind}`: a fixed sentence with the agent's name, the file's name, a route inside the app.
  No comment, prompt, answer or design content. The service worker shows only plain text of a bounded length and
  opens only a route of the app (`pushNotice` in `apps/editor/src/pwa/sw-rules.ts`).
- **When.** A run that ended (not stopped), a comment by an agent or a client (not by the person, on any device),
  a proposal by an agent. What a run makes while it goes is told once, when it ends. At most 20 messages per phone
  in ten minutes. A `404` or `410` from the push service drops that subscription.

### Offline changes from the phone

`POST /api/files/:id/catch-up` takes the Yjs update a phone made while it could not reach the computer, with its
state vector, and `GET` on the same path gives the computer's state vector. Owner only (`fromOwner`), closed on the
tailnet listener (`isLocalOnlyPath`). The update is applied to a copy first and checked with `assertWellFormed`;
it is then compared with the file as `peers.ts` does after two devices were apart (`compareSync`), and the notes go
into the same `sync-conflicts.json`. Up to 128 MB per request. Code: `packages/server/src/phone-sync.ts`.

### Photos from the phone

Photos are uploaded as assets with `POST /api/assets`, with its limits and content types. A run or a comment run
gets them as images only by asset name (`bogen-asset:<sha256>.<ext>`), read from this machine's asset folder, PNG,
JPEG, WebP or GIF, at most 8 MB each and four per request (`packages/server/src/run-images.ts`). A URL or a path is
refused.

### Updating another device

`GET` and `POST /api/peers/:id/deploy` run `integrations/omarchy/deploy.sh` for a paired device, which is what
`bogen peer deploy` runs (`packages/server/src/peer-deploy.ts`). Only from this machine (`fromThisDevice`: no proxy
headers, loopback, not the phone or tailnet listener), and like every route on this listener, a browser's request
must be same-origin. The ssh host must look like `user@host` or a Host alias, never like an option (no leading `-`),
and goes to `bash` as one argument with no shell in between. The real run needs the plan of a successful dry run for
the same host, made in the last 15 minutes, and used once. One run at a time, ten minutes at most, output capped at
200 KB. The host used is saved per device in `peer-deploy.json` (mode 600). ssh runs with `BatchMode=yes`, so it
never asks for a password; it uses the keys and agent the server's environment has.

### Voice notes

The microphone in the phone's comment sheet records audio and sends it to `POST /api/voice` on the phone listener,
so it passes every check above, and the route itself answers only the owner (`fromOwner`): this machine or a paired
phone. It is closed on the tailnet listener and with `--host` and a token. Code: `packages/server/src/voice.ts`.

- **Limit.** 10 MB per recording, counted while it streams in, with 413 beyond and the connection closed; an empty
  body is refused. Only audio types are accepted (`audio/mp4`, `aac`, `webm`, `ogg`, `mpeg`, `wav`; 415 otherwise),
  and the file must exist. The phone stops recording by itself after three minutes.
- **Where it goes.** `$BOGEN_HOME/voice/<random id>.<ext>`, mode 600 in a folder of mode 700, with an index in
  `voice/index.json`. Never in `assets/`, so it is never synced to other devices, never in a `.bogen` file or design
  folder, and never sent to a third party.
- **Transcription.** Only by a program already on this machine: `BOGEN_TRANSCRIBER` (a command given the file's
  path), whisper.cpp (`whisper-cli` or `whisper-cpp` with a `ggml-*.bin` model from `BOGEN_WHISPER_MODEL` or the
  usual model folders, after ffmpeg makes it 16 kHz WAV), or faster-whisper with a model already in the Hugging Face
  cache, run with `HF_HUB_OFFLINE=1`. Bogen never installs or downloads one. Arguments are passed without a shell,
  with timeouts.
- **Deletion.** After a transcript, the recording is deleted at once. Without one, it is kept as a voice note on the
  comment: served back only to the owner by `GET /api/voice/<id>.<ext>` (names of exactly that shape, `nosniff`,
  `no-store`), and deleted by `DELETE /api/voice/<id>.<ext>` (removing it from the comment or cancelling the comment
  does this), when its file is deleted, and 30 days after it was recorded. A sweep at the first use and every six
  hours removes expired notes, those of files that are gone, and leftovers the index does not list.
- **In the document** a comment only names the note (`bogen-voice:<id>.<ext>`, kind `audio`, length, device name);
  the comment routes accept no other shape. Another device that syncs the comment cannot play it and says where it is.

### Published sites and review links: 127.0.0.1:29992 and 29993

The site listener serves the one version you published to Bogen's site, and the review listener serves review links.
Both are off until you turn them on in the editor, and stay off after a restart unless you did. Each is an HTTP
server of its own on loopback, which `tailscale serve` puts on an HTTPS port of the computer's `ts.net` name: 10000
for the site, 8443 for review links. They share nothing with the other listeners: no route of the API, no MCP, no
WebSocket, no session and no cookie, set or read.

- **Static files only.** GET and HEAD of the files of one version, which sit in Bogen's data folder under
  `publish/versions/<id>/site` and are checked against the version's manifest and its SHA-256 sums before they are
  sent. A path is decoded once and refused if anything in it is still encoded, or if it holds `..`, `.`, an empty or
  hidden segment, a backslash, a NUL or an encoded slash (`safeSegments`). A path that is not a file of the version
  is a 404, whatever it names.
- **No WebSocket.** An upgrade is answered 403 and closed before anything reads it.
- **POST** is taken only on a review link's comment form, at `/r/<token>/_review/comments`. Everything else is 405.
- **Host.** The computer's own `ts.net` name on the HTTPS port, which stops DNS rebinding.
- **On the tailnet only**, which is the default, a request must carry the `Tailscale-User-Login` header that
  `tailscale serve` sets, so anything that did not come through it is refused.
- **Your user only.** Connections from other users of the machine are closed before a byte is read, as on the
  main listener.
- **Headers.** Every page has `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self';
  font-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, with
  `frame-src 'self'` only when the site has code components, and `form-action 'self'` only on a review link that
  takes comments. Every answer has `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (`same-origin`
  on a review page with the form, since under `no-referrer` a browser sends the form with `Origin: null`),
  `Strict-Transport-Security`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and a
  `Permissions-Policy` that turns off camera, microphone, location, payment and USB. Every page also carries its
  policy as a meta element, for a folder or GitHub Pages that send no headers.
- **Code components** run only in frames of the site with `sandbox="allow-scripts"` and no `allow-same-origin`, and
  each frame file is served with its own CSP that sandboxes it again, so it has an opaque origin even when opened on
  its own. Their one inline script is allowed by hash; they have no network.
- **Errors** never echo the path, which on the review listener holds a link's token.

### Tailscale Funnel

Funnel puts one of the two listeners on the internet. It is off by default, and only you can turn it on, in the
editor, after a warning that says what public means. It needs the `funnel` node attribute in your tailnet policy and
one of Funnel's ports (443, 8443 or 10000). Bogen adds and removes only its own port's entry, with
`tailscale funnel --bg --https=<port>` and `tailscale funnel --https=<port> off`, and leaves an entry it did not make
alone, on that port or any other, as it does for the phone listener. Funnel traffic carries no login, so with Funnel
on the login check is off for that listener and everything else above still holds. Visitors' traffic passes through
Tailscale's relays; see [Privacy](docs/guide/privacy.md#published-sites-and-review-links).

## Publishing and review links

- **What is published.** A version is a frozen static export: HTML, one style sheet per page, and the images, fonts
  and code component frames it uses as files of the site. Before a version is written, the pages are cleaned
  (`cleanPublishedPage` in `packages/core/src/publish-clean.ts`): no script, event handler, HTML comment, `data-*`
  attribute but `data-mode`, layer id, rule class named after one, inline style, `bogen-asset:` address or `/api/`
  address, and no hidden layer, proposal, comment, agent or history data. `assertClean` then refuses the whole
  version if any id the document knows still appears anywhere in it. Images and fonts from elsewhere are fetched once,
  through the address guard, and become files of the site; embeds of other sites are left out.
- **Who publishes.** An agent can prepare a version and ask (`publish_prepare`, `share_prepare`); the CLI can prepare
  one, look, and take things back. Sending a version anywhere, turning a listener or Funnel on, making a review link
  and accepting a client's comment answer only the editor on this machine: a request from loopback, with no
  forwarding header, an `Origin` of the editor and `Sec-Fetch-Site: same-origin`. MCP clients and the CLI send
  neither. None of these routes answer on the tailnet or phone listeners. This keeps out agents through MCP, other
  devices, phones and web pages; a program you run yourself can still do what the editor does, as it can everywhere
  on loopback.
- **A folder.** Only under your home folder, not your home folder itself, not a hidden folder, not a key folder or
  Bogen's data, and not through a link. Bogen writes a `.bogen-publish.json` listing what it wrote with SHA-256 sums.
  A file it did not write is never overwritten or removed, and a folder that holds any needs your yes in the dialog.
- **GitHub Pages.** Through your own `gh api`; Bogen never sees a token. You see the plan first: files sent, removed,
  unchanged, and files on the branch Bogen did not write, which stay. The push is made again from the branch as it is
  then and refused if that differs from the plan you saw, or if it would overwrite a file Bogen did not write.
- **Review links.** The token is 128 random bits in the path, shown once when you make the link. Bogen keeps only
  its SHA-256 and never logs a path of the review listener. A link expires (14 days by default, 90 at most), can be
  revoked, and can have a view limit; an expired, revoked, used up or guessed token gets the same 404. Each serves one
  frozen version with `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- **Client comments** are a plain HTML form, with no script. A POST must carry an `Origin` that is the review
  listener's own, and no `Sec-Fetch-Site` but `same-origin`, which stops forms on other sites; there is no cookie to
  steal. Bodies are at most 8 KB, a comment 2000 characters and a name 80, and each is turned into plain text: markup,
  control and direction characters go, and every `@` of a mention is taken out. Five comments per address in ten
  minutes and twenty per link an hour, and the inbox holds 500 at most.
- **Quarantine.** Comments wait in an inbox in your editor, marked as from a client, and never reach the document,
  an agent or MCP on their own. Accepting one puts it into the file as a thread marked `client`; deleting drops it. A
  client's thread never starts an agent run, not even from your own reply in it with a mention, and agents see it
  marked as feedback, never instructions.

## Content from others

Documents can come from paired devices, imports, Capture, pasted HTML and agents. Bogen does not trust what is
stored, and checks it again where it is rendered.

- **Nothing in a document starts a process.** A comment from a paired device, an agent, a y-websocket client or an
  imported file never starts an agent run. Only a request from a person on this machine, or a paired phone, does,
  or an explicit request from a paired device you allowed to ask agents here (see above).
- **HTML.** Import drops `script`, `noscript`, `template`, `object`, `applet`, `meta`, `link`, `base` and the like,
  keeps a short list of attributes, and allows only `http(s):`, `mailto:`, `tel:`, relative, `bogen-asset:` and
  image or video `data:` URLs. Event handlers do not survive.
- **CSS.** Values with `expression(`, `javascript:` or `@import` are dropped. Keyframes must be a well-formed
  `@keyframes` block.
- **Layer rules** (`::before`, `@media`, `:hover` and so on) are written into a style element, so their values are held
  to more: nothing that can close the block, open another or end the style element (`cleanRuleValue` in
  `packages/core/src/layer-rules.ts`). A rule cannot leave its own layer.
- **SVG** is sanitised on every read, not only on import: allowed elements only, no event handlers, no comments or
  CDATA, links only to `#` fragments or image `data:` URLs, and no animation of `href`.
- **Brands.** Rules that talk to agents are flagged and shown as data. A brand brief sits in a block its content
  cannot close, and colours and font names are checked before they reach CSS.
- **Assets** are served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
  `nosniff`, so an uploaded SVG never runs as a page of Bogen. Images an agent uploads with `asset_upload` are checked
  by their magic bytes.
- **The editor** is served with `script-src 'self'` and `frame-ancestors 'none'`.

## Code components

Linking a project folder (`code_project_link`, the Assets panel) lets Bogen read its React components and bundle them
with esbuild. The project's code runs only in a frame served with a CSP sandbox: `sandbox allow-scripts`, so an opaque
origin, `default-src 'none'`, only its own inline script by hash, and no network. Tailwind 4 CSS is compiled; the
project's Tailwind JS plugins and configs are skipped, because they would run the project's code outside the sandbox.

## Live site mode

`bogen live <url> --dir <project>` proxies a dev server on `localhost` or `127.0.0.1` through its own port on
127.0.0.1, and the main server refuses requests from that proxy's origin. A run gets six file tools rooted in the
project folder and nothing else: no shell and none of the CLI's built-in tools.

- Paths are resolved through symlinks and must stay in the folder.
- `.git`, `node_modules`, `.env*`, `.ssh`, `.aws`, keys, `.pem` files and `credentials` or `secrets` files are
  neither listed nor read.
- Files that run code later cannot be written: `package.json`, lock files, `*.config.*`, `.claude`, `.codex`,
  `.github`, `.vscode`, `.mcp.json`, shell scripts, Makefiles and Dockerfiles.
- The CLI starts in an empty folder, so the project's own agent settings and hooks do not load.
- The run's MCP endpoint, `/live-mcp/<token>`, answers only this machine, without an `Origin`, while the run lasts.

## Capture and data from URLs

Capture of a page or a whole site, `layer_repeat` from a URL, brand extraction and images written into designs go through
an address guard (`packages/server/src/net-guard.ts`). It refuses private, loopback, link-local, CGNAT and reserved
ranges, `localhost`, `.local` and `.internal` names, and URLs with credentials. It checks the resolved address when
the connection is made, so a DNS answer that changes cannot slip through, and the headless browser's own requests are
checked the same way.

Pages on this computer, such as your dev server, can be captured only by a request from this machine outside MCP:
`bogen capture http://localhost:5173` from your shell. An agent over MCP cannot capture them. Addresses on your
private network cannot be captured at all.

## Secrets

- **`config.json`** in the data folder holds the device token and a Figma token you chose to save. It is written with
  mode 600, and an existing one with wider permissions is tightened. Image keys an older version kept there are
  ignored.
- **The Figma token** is stored only with `--save-token` or the box in the import dialog. Reading or deleting it
  (`/api/config/figma`) works only from this machine.
- **The temporary MCP config** handed to `claude` or `codex` for a run is written with mode 600.
- Run history, settings, phone settings, change logs and commits are written with mode 600.

## An agent with Bogen's tools

An MCP client connected to `bogen mcp` or `/mcp` acts as you, in your files. It can:

- **Read and change every file** in Bogen, and every page, layer, token, brand and comment in them. Agents leave
  locked layers alone unless they unlock them, which the instructions say to do only when you ask.
- **Write files on your disk.** `export_file` writes under your home folder or the export folder: not into hidden
  folders unless it passes `allow_hidden`, never into key folders or Bogen's own data, and never over an existing file
  without `overwrite`.
- **Read code.** `code_project_link` links any folder it names, which Bogen then reads and bundles for the sandbox.
- **Read images.** `asset_upload` with `path` stores an image file from this computer, such as one the agent's own
  image tool saved: only on a server that listens on this machine alone, only under your home or temp folder and not
  in key folders, and only bytes that are a PNG, JPEG, WebP, GIF or AVIF image, or an SVG it sanitizes.
- **Reach the network.** Capture and `layer_repeat` fetch public addresses through the guard above; `figma_import`
  calls Figma with a token you saved. Bogen calls no AI provider itself.
- **Show you things.** Select layers in your editor and bring them into view, which you can turn off.
- **Read app screens.** `tomacco_import`, `tomacco_compare` and `tomacco_status` call `tomaccoctl`, only on a server
  that listens on this machine alone, and only its operations that read (`device.list`, `doctor`, `--version`) and
  `screen.export`, which writes into a temporary folder that is removed afterwards. Arguments go as an array, never
  through a shell, and answers are bounded. Bogen shows `doctor`'s commands to you and never runs them.

It cannot start agent runs, capture pages on this computer or your network, change phone or device settings, build,
install or start an app, or bind Git. For publishing it can prepare a version and ask for it to be published or shared, and list what there is; it
cannot publish, make a review link, turn a listener or Funnel on, or read what a client wrote. Every write is an
undo step for that agent, and the timeline can revert a whole run.

Runs that Bogen starts itself, from Ctrl+K or a comment, give `claude` or `codex` Bogen's tools only, with
`--strict-mcp-config` for Claude: no shell, no file access and none of your other MCP servers. Codex keeps its
built-in image generation, which saves into its own `~/.codex/generated_images`.

## Checking a release

Each release file comes with a `.sha256` and a detached Ed25519 signature, `.sig`: base64 of the 64 signature bytes
over the whole file. `bogen update apply` checks the signatures before it installs anything. To check a file you
downloaded yourself:

```sh
bogen verify bogen-design-0.1.0.tgz
```

It reads `FILE.sha256` and `FILE.sig` beside the file (`--sha256` and `--sig` name others), checks the signature
against the release keys built into `bogen` (`packages/server/src/release-key.ts`), and exits 0 only when the file is
verified; `--json` prints the result as JSON. Without Bogen, OpenSSL 3 checks the same signature with the public key
from that file, base64 of the raw 32 bytes:

```sh
printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00' > release.der   # the SPKI header of an Ed25519 key
printf '%s' '<public key>' | base64 -d >> release.der
base64 -d bogen-design-0.1.0.tgz.sig > tgz.sig
openssl pkeyutl -verify -rawin -pubin -keyform DER -inkey release.der -in bogen-design-0.1.0.tgz -sigfile tgz.sig
```

Each release also has a CycloneDX software bill of materials, `bogen-design-VERSION.cdx.json`, signed the same way,
which lists the third-party packages that ship or run with Bogen, with their versions, licenses and digests, as
`package-lock.json` pins them; `bogen verify` on it also checks the package it names when that lies beside it. The
release's provenance, `bogen-design-VERSION-provenance.intoto.json`, an in-toto statement with a SLSA provenance,
records the commit, the lock file, the builder and the SHA-256 of every release file; `bogen verify` on it checks
its signature and every listed file in the same directory. The provenance is signed by the maintainer's key on the
maintainer's computer: no third party attests to the build.

`bogen-release.json`, also signed, is what update checks read: the version, the package's name, size and SHA-256.
`bogen update apply` installs a package only when the manifest's signature verifies, the package matches the
SHA-256 in it, and the package's own signature verifies, all against a key built into the running `bogen`. A build
run from source accepts a test key in `BOGEN_RELEASE_TEST_PUBLIC_KEY` for the tests; a built bundle has no way to
accept another key. How the key is made and replaced is in [Building](docs/building.md#making-a-release).

The install script (`install.sh`, served as `https://bogen.dev/install.sh`) checks the package it downloads against
its SHA-256 file and against the release key before anything is installed, with `openssl` and the public key written
into the script. The three runtime dependencies (`puppeteer-core`, `esbuild`, `tailwindcss`) come from the npm
registry at the versions and integrity hashes the package's shrinkwrap pins. To install a file you downloaded
yourself: `bogen verify` it, then `npm i -g ./bogen-design-VERSION.tgz`.

## What is not in scope

- **Programs of your own user.** The loopback listener has no login for your own user: any program you run can use
  the API and MCP, as it could read your files directly.
- **Other users on a system without `/proc/net/tcp`.** On Linux, a loopback connection from another user is closed
  before it is read (`packages/server/src/local-user.ts` asks `/proc/net/tcp` who owns the other end; root is let in).
  Where that table does not exist, another user of the machine can reach 127.0.0.1:29990. Use `--token` on such a
  shared machine.
- **An agent with a shell.** An agent that can run commands as you can run `bogen capture` on `localhost`, read
  `config.json` or edit your files directly. Bogen's limits apply to what agents do through its tools; they are not a
  sandbox.
- **What your MCP client sends on.** Everything Bogen's tools return goes to the client, and from there to its AI
  provider. See [privacy](docs/guide/privacy.md).
- **The token on a team server.** With `--host` and `--token`, anyone with the token has the person's rights over HTTP.
  Bogen serves plain HTTP; put TLS in front of it.
- **Your tailnet.** Device sync and the phone trust Tailscale for who a device and a login are. A tailnet policy that
  lets others reach the ports, or a compromised Tailscale account, is outside what Bogen can check.
- **Fonts and captured content.** Capture stores what a public page served. Whether you may reuse its fonts or
  images is a matter of their licences.
