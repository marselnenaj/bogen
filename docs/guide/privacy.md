# Privacy

Bogen runs on your machine. It has no account, no server of its own and no cloud service. **It sends no
telemetry, usage statistics or crash reports.** Once a day it fetches one public file to see whether a
new release is out, which you can turn off: [update checks](#update-checks) shows the exact request.
Otherwise it connects to the network when a design or an action you start needs it. The table lists
those.

## What leaves your machine, and when

| When | Destination | What is sent |
| --- | --- | --- |
| A design uses a Google Fonts family, in the editor or in a render | `fonts.googleapis.com`, `fonts.gstatic.com` | Requests for that family's style sheet and font files. Fonts installed here, and fonts kept by Capture, are not requested. |
| A design references an image or other resource on a public URL, such as `<img src="https://...">` written by your agent | That address | An ordinary download. Images written that way are stored with the file, so later renders use the copy. |
| You or your agent copy in a page or site with [Capture](capture-and-import.md), or extract a brand from a URL | The site, and the hosts its pages load from | What a browser sends when it opens the page, plus requests for `robots.txt` and the sitemap for a whole site. |
| A layer repeats from data at a URL (Repeat, `layer_repeat`) | That address | An ordinary request for the JSON or CSV. |
| You capture with the [browser extension](#the-browser-extension) | Bogen on this computer, at `127.0.0.1` or `localhost` | The captured layers, the tab's picture and the files the tab could read. The extension connects nowhere else. |
| You import from Figma | `api.figma.com`, and the image addresses Figma's API returns | Your personal access token, and the file's key. See [Import from Figma](capture-and-import.md#import-from-figma). |
| Device sync is on | Your paired devices, over Tailscale only | Your files, assets, brands, libraries, change logs, named commits, and who has a file open there. Every request carries the device token. |
| `bogen peer deploy` | The host you name, over ssh | The build and the integration scripts. |
| The server's daily update check, or `bogen update check` | `github.com`, then GitHub's download host | One `GET` of `bogen-release.json`, with nothing about you or this installation. See [Update checks](#update-checks). |
| `bogen update apply` | The same | `GET`s of the manifest, the package and their signatures. |
| You publish a version to Bogen's site, or make a review link | Whoever opens it: people on your tailnet, or anyone with the address while Funnel is on | The files of that one frozen version. A review link also gets the comments clients send back. See [Published sites and review links](#published-sites-and-review-links). |
| You publish to GitHub Pages | GitHub, through your own `gh` | The files of the version, as one commit on the branch you named. The site is public there. |
| A version is made and the design uses Google Fonts or images on public URLs | Those hosts | One download of each, so that the site serves them itself. |
| An agent works in Bogen | Your MCP client, and from there its provider | The request, conversation and brand context, the effective design skill supplied to built-in canvas runs, and what tools return: layers, comments, screenshots and brand data. Personal skill text reaches that chosen provider; Bogen does not filter it. |
| You record a voice note on your phone | Your computer, through `tailscale serve` | The recording, to be written out there. Nothing else receives it. See [Voice notes](#voice-notes). |
| You turn on notifications on your phone | Your phone's push service: for an iPhone or iPad, Apple's (`web.push.apple.com`) | Per message: what happened, the file's name and a link inside the app, encrypted so that only your phone can read it. See [Notifications on the phone](#notifications-on-the-phone). |
| You take or pick a photo on your phone | Your computer, through `tailscale serve` | JPEG and HEIC photos are scaled down and sent as JPEG without location and camera data. Small PNG, WebP and GIF files retain their original data. It becomes an asset of the file, so it syncs like any image. See [Photos from the phone](#photos-from-the-phone). |
| You choose **Update the other device** in the sync indicator | The ssh host you type, over ssh | The same as `bogen peer deploy`: the build and the integration scripts. |

Addresses that come from designs, captured pages and data go through a guard that refuses private and
local addresses. Pages on this computer can be captured from the command line and the browser
extension only, and pages on your private network only by the extension, which reads what your own
browser already shows.

## What stays local

- **The server** listens on `127.0.0.1:29990` and refuses requests that come from another site or
  name another host. It listens beyond this machine only with `--host` and a token, or on your
  Tailscale address with `--tailnet` or `bogen peer pair`, where every request needs the device
  token.
- **Your designs** live in the data folder, `~/.local/share/bogen` by default:

  | What | Where |
  | --- | --- |
  | Files and brands | `files/<id>.ydoc`, with the list in `index.json` |
  | Images, fonts and other assets, by content hash | `assets/` |
  | Change logs and commits | `history/<id>/` |
  | Thumbnails | `thumbs/` |
  | Run history, per file | `runs/<id>.json` |
  | Personal design instructions and their previous versions, on this host only | `design-knowledge/<discipline>/SKILL.md` and `design-knowledge/<discipline>/history/` |
  | Model and effort choices | `run-settings.json` |
  | Linked code projects, per device | `code-projects.json` |
  | Your reference board, per device | `references.json` |
  | Paired browser extensions (only a hash of each token) | `extension-pairings.json`, readable by you only |
  | Keys, a saved Figma token, device and pairing settings | `config.json`, readable by you only |
  | The background server's log | `server.log` |
  | Update settings, and what the last check found | `update-settings.json`, `update-check.json` |
  | Bug-report bundles you made with `bogen report` | `reports/` |
  | Voice notes from the phone that could not be written out | `voice/`, readable by you only |
  | One notification key pair per paired phone, and where its push service is | `push.json`, readable by you only |
  | The ssh host last used to update each paired device | `peer-deploy.json`, readable by you only |
  | Published versions, and where each is live | `publish/` |
  | Review links (only a hash of each token), and comments from clients | `review/` |

Proposal decisions also leave small receipts inside the design file: proposal/source layer ids, accepted or discarded, and the time. They contain no screenshots, layer text or person names and follow normal file sync and export. Each decision operation retains at most 500 receipts; concurrent peers can temporarily merge more until the next decision prunes them. These receipts distinguish an unchanged acceptance from a discard. The measured preference history and inferred suggestions remain local to each host.

- **`bogen report`** writes a bundle for a bug report into `reports/`, readable by you only, and sends
  nothing. You decide whether to attach it to an issue; read it first.

- **Code components** from your projects are bundled on this machine and run in a sandboxed frame
  with no network access and an origin of its own.
- **Nothing in a document starts a process.** Comments, brands and files from other devices, from
  agents or from imports never start an agent run.

## The browser extension

The Bogen capture extension ([how to load and pair it](capture-and-import.md#from-your-browser-the-extension))
sees a page only when you open it on that tab: it asks for `activeTab`, `scripting` and `storage`, and
no host permissions. On that tab it reads what the page shows (its elements and their computed styles,
its style sheets, its text including anything you are signed in to see) and the images and font files
the tab may load, and takes a picture of the visible window. It changes nothing on the page; an element
you pick carries a marker attribute until the capture ends.

It sends all of this to Bogen on this computer and to nothing else: the extension's own content
security policy allows connections only to `127.0.0.1` and `localhost`, and the address you give it
must be one of those. Bogen stores the result in your data folder like any capture. Images and fonts
the tab could not read are downloaded from the same public addresses the page used, as with
`bogen capture`; private addresses are never fetched.

Pairing: the extension asks, the editor shows the same code, and you allow it. Bogen keeps only a hash
of the extension's token, with its name and origin, in `extension-pairings.json`, readable by you only.
The token works from that extension's origin, on a server that listens only on this computer, for
adding captures and nothing else. Revoke it in **Settings**, **Privacy**. The extension keeps the token
and Bogen's address in its own extension storage in your browser profile.

## Published sites and review links

Nothing is published until you publish it, in the editor. Agents can only prepare a version and ask.

- **What is public** is exactly the files of the version you sent: HTML, CSS, images, fonts and code
  component frames. No layer ids, comments, history, agent or brand data, hidden layers, proposals,
  tokens or anything of other files. You see the file list in the Publish dialog before you send it.
- **Who can open it.** On the tailnet only, which is the default, people and devices of your tailnet.
  With [Tailscale Funnel](sharing.md#public-on-the-internet) on, anyone on the internet who has the
  address. A review link also needs its token, so only whoever you gave the link to, until it expires
  or you revoke it.
- **Funnel traffic passes through Tailscale.** Visitors connect to Tailscale's relay servers, which
  pass the encrypted connection on to this computer, where `tailscale serve` ends TLS. Tailscale sees
  that a connection was made and its size and timing, and the visitor's address. Bogen sees the visitor's
  address too, from `X-Forwarded-For`, and uses it only in memory, to limit comments.
- **What Bogen keeps** of visitors: a view count and the time of the last view per review link, and the
  comments a client sends, with the name they typed. No address and no cookie. Comments stay in the
  inbox on this machine until you accept or delete them.
- **A folder or GitHub Pages** is yours from then on. What GitHub does with visitors of a Pages site is
  GitHub's business.
- **You answer for what you share.** Towards the people who open a link or a site, you are the one responsible:
  tell clients that their name and comment are stored on your computer, and give a published site its own legal
  notice and privacy information where the law asks for one. Bogen adds none.
- **An HTML export is not a published version.** It links Google Fonts families from Google's servers, so a visitor's
  browser contacts Google. Publish bundles the fonts instead; see
  [What an export contains](export-and-code.md#what-an-export-contains).

## Update checks

The server checks for a new release a minute after it starts, and then at most once a day (six hours
after a check that failed). `bogen update check` checks when you run it. The check is this one request,
and nothing else:

```http
GET /marselnenaj/bogen/releases/latest/download/bogen-release.json HTTP/1.1
Host: github.com
Connection: keep-alive
User-Agent: bogen
Accept: */*
Accept-Language: *
Sec-Fetch-Mode: cors
Accept-Encoding: gzip, deflate
```

GitHub answers with a redirect to its download host, `release-assets.githubusercontent.com`, and the
same request goes there. `Connection` and the last three headers are the ones Node's `fetch` adds to
every request. There
is no cookie, no token, no identifier and no version of yours in it: the answer is the same public file
for everyone, and Bogen compares the version in it with its own on your machine. GitHub sees what any
web server sees, your IP address and the time. The result is kept in `update-check.json` in the data
folder.

When a newer release is out, the editor's home screen and the Omarchy bar widget's panel show one quiet
line, "Bogen 0.2.0 is available", and nothing else changes. `bogen update apply` then downloads the
package and the signatures from the same place and checks them. npm prepares its locked dependency tree in a separate folder; Bogen checks the new CLI before activation and keeps the previous app for `bogen update rollback`. Failed preparation or activation preserves the installed app. Neither operation changes design documents or restarts a running server. Updates never run by themselves.

To turn the daily check off:

```sh
bogen update off              # saved in update-settings.json; `bogen update check` still works
BOGEN_UPDATE_CHECK=off        # in the server's environment: no check at all, not even when you ask
```

`BOGEN_UPDATE_URL`, or `bogen update source <url>`, fetches releases from another folder instead, such
as a mirror. It must be an `https` URL.

## Images

Bogen sends nothing to an AI provider. It has no image generator and holds no AI keys. Images come from
your agent, which draws them as SVG or CSS or makes them with its own image tool; that tool's requests
are between the agent and its provider, under the agent's account. Codex's built-in image generation,
for example, runs on your ChatGPT plan and keeps a copy under `~/.codex/generated_images`. When the agent
stores the file with `asset_upload` and a path, the Bogen server reads that one file on this computer,
and only an image under your home or temp folder.

Older versions could generate images with an OpenAI or Gemini key. A `config.json` that still has
`openaiApiKey`, `geminiApiKey` or `imageProvider` loads as before; those fields are ignored, and you can
delete them.

## Voice notes

The microphone in the phone's comment sheet records on the phone and sends the recording to your computer, over
the phone listener, as a paired phone. The microphone in the editor's chat and comment boxes records in the editor
and sends it to the server on the same computer. Nothing else gets it: no speech service, no Bogen server, no other
device.

- **Up to 10 MB**, and the recording stops after three minutes.
- **Written out on your computer**, only by a speech model you installed yourself: whisper.cpp (`whisper-cli` or
  `whisper-cpp` with a `ggml-*.bin` model, set `BOGEN_WHISPER_MODEL` if it is not in a usual folder), Voxtype with a
  Whisper model it already downloaded to `~/.local/share/voxtype/models` (always run with its local Whisper engine,
  whatever its own settings say, so a remote or cloud engine configured there is never used), faster-whisper with a
  model already downloaded (run offline, so it never fetches one), or a command of your own in
  `BOGEN_TRANSCRIBER`. Bogen never installs or downloads a model. The text goes into the field, where you can
  change it before you send it, and the recording is deleted right away.
- **The chat without a model** records nothing and says how to set one up: an agent cannot hear a recording.
- **Without a model**, the recording is attached to the comment as a voice note and kept in `voice/` in the data
  folder, readable by you only. It is not an asset, so it does not sync to your other devices: there the comment
  says which computer has it. It is deleted when you take it off the comment or cancel the comment, when its file
  is deleted, and 30 days after it was recorded.
- **Dictation** with the microphone key of the iPhone's keyboard is the keyboard's own: it works in the field as in
  any app, and goes wherever your keyboard's settings send it, not through Bogen.

`BOGEN_TRANSCRIBER=off` turns transcription off, so every recording is kept as a voice note instead.

## Notifications on the phone

Notifications are off until you turn them on, in the phone app's Settings. They need the app on the Home Screen,
and on an iPhone or iPad iOS 16.4 or later.

- **Apple delivers them.** Web Push goes through the push service of the phone's browser. For Safari and the Home
  Screen app on an iPhone or iPad that is Apple's, at `web.push.apple.com`: your computer sends each message there,
  and Apple passes it on to the phone. Bogen cannot choose another service, and has none of its own.
- **What a message says.** What happened ("Claude finished", "Codex has a proposal ready", "Claude answered a
  comment", "A client commented"), the name of the file, and a link inside the app. Never the words of a comment,
  a prompt or an agent's answer, and nothing from a design.
- **What Apple can see.** The message is encrypted for your phone (RFC 8291), with keys the phone made, so Apple
  cannot read it. Apple does see that a message of some size went from your computer's public address to your
  phone, and when. The sender's key is one Bogen makes for each paired phone; the claim that names the sender says
  `https://github.com/marselnenaj/bogen`, not your computer (`BOGEN_PUSH_SUBJECT` sets another).
- **Where it is kept.** `push.json` in the data folder, readable by you only: each phone's key pair, the address
  its push service gave and which kinds of message it wants. Turning notifications off, or removing the phone,
  deletes that phone's address; removing the phone also deletes its keys.
- **Which addresses.** Bogen sends only to known push services (Apple's, Google's, Mozilla's and Microsoft's), so a
  page cannot make your computer send requests elsewhere.

## Photos from the phone

A photo you take or pick in the phone app goes to your computer only, over the phone listener. Before it leaves the
phone it is scaled to 2048 pixels on its long side. A JPEG, or an iPhone's HEIC, is drawn again as a JPEG, which
leaves its metadata behind: where it was taken, the camera, the time. A PNG, WebP or GIF that is small enough goes as
it is. On the computer it is an asset like any image: placed on a board, attached to a comment, or shown to the agent
you ask, and synced to your other devices with the file. A photo attached to Ask, or to a comment that mentions
@claude or @codex, goes with the request to that agent's CLI, which sends it to its provider as part of the request.

## AI agents

When you connect an MCP client, everything Bogen's tools return goes to that client: the structure and
text of your designs, screenshots, comments and brand data. The client may send it on to its AI
provider. The same goes for runs started from Ctrl+K and comments, which use your own `claude` or
`codex` CLI and its account. Only connect clients you trust with the files.

## Removing your data

Delete the data folder. `bogen uninstall <client>` takes Bogen out of an MCP client, and on Omarchy
`bogen omarchy uninstall` removes the integration; neither touches your designs.
