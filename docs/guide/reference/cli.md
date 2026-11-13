# Command line

Every `bogen` command, from `bogen --help` and the code behind it. From a checkout the command is
`node packages/server/dist/cli.js`.

Commands that talk to the server (`open`, `mcp`, `capture`, `import`, `export`, `export-folder`,
`import-folder`, `git`, `live`, `phone`, `publish`, `share`, and `peer` except `deploy`) start it in the background when it is not running, unless
`BOGEN_URL` points elsewhere. `--port` (or `-p`) picks the port for any of them, and `--token` the
token of a server that needs one.

## Running the server

### bogen serve

```text
bogen serve [--port 29990] [--host <addr> --token <secret>] [--tailnet]
```

Runs the server in the foreground until Ctrl+C. Prints its address and data folder.

| Option | What it does |
| --- | --- |
| `--port`, `-p` | The port. Default 29990, or `BOGEN_PORT`. |
| `--host <addr>` | Listen on this address instead of `127.0.0.1`. Any address beyond this machine needs a token. |
| `--token <secret>` | Require `Authorization: Bearer <secret>` (or `/?token=<secret>` once in a browser). `BOGEN_TOKEN` works too. |
| `--tailnet` | Also listen on this machine's Tailscale address, for [device sync](../devices.md). |
| `--insecure-allow-any-host` | Let `peer pair` and `peer add` use addresses outside the tailnet. For testing. |
| `--dev` | For working on Bogen itself, with the editor's development server. |

### bogen start, stop, status

```text
bogen start [--port 29990] [--host <addr>]
bogen stop
bogen status
```

`start` runs the server in the background and prints its version, address and process id. When a
user service `bogen.service` is installed, it starts that service instead. `stop` stops the background
server. `status` prints the address, version, process id, number of files and active agents, and says
when the running server is another build than the command or a paired device runs another version.
It exits 3 when the server is not running.

### bogen open

Opens the editor in your browser, starting the server if needed. With a token, the address carries it.

### bogen welcome

Opens the "Welcome to Bogen" file, starting the server if needed. If you deleted it, this makes a new
one. Bogen makes it by itself only once, on the first start of an empty data folder.

### bogen mcp

MCP over stdio, for agents. It relays to the server's `/mcp`, starts the server if needed, and keeps
calls going across a reconnect. This is the command `bogen install` registers.

## Agents

### bogen setup

```text
bogen setup [--agents <client>,... | all | none]
```

Finds the MCP clients on this computer, says for each whether Bogen is connected, and connects the
ones you pick, then prints what to do next. At a terminal it asks for each client found without
Bogen, and Enter means yes; a client already connected is not asked about. Without a terminal it
asks nothing and prints the `bogen install` commands. `--agents` (or `BOGEN_AGENTS`) answers ahead:
a comma-separated list of clients, which are connected again even when they are already, `all` for
every client found, or `none`. `claude` is accepted for `claude-code`. The install script runs it at
the end. Exits 1 if a client could not be connected.

### bogen install

```text
bogen install <claude-code|codex|cursor|vscode|opencode|gemini|zed|grok|hermes|omp>... | --all
```

Adds Bogen to MCP clients, and for Claude Code and Codex writes the Bogen skill. `--all` (or `all`)
sets up every client found on this machine and skips the rest. Grok and Hermes are registered with their own
`grok mcp add` and `hermes mcp add` commands, so they must be on PATH; Oh My Pi gets an entry in its user
`mcp.json` (`~/.omp/agent`, or `PI_CODING_AGENT_DIR`; with a named profile or only `PI_CONFIG_DIR` set it
refuses instead of guessing the folder). Registering a client lets it use Bogen in its own sessions; which
CLIs Bogen runs itself is a separate matter, see [Agents](../agents.md). Prints one line per client: `ok`,
`skip` or `FAIL`, and exits 1 if one failed. See [Agents](../agents.md#connect-a-client).

### bogen uninstall

```text
bogen uninstall <client>...
```

Takes Bogen out of the named clients, skill included. A skill file Bogen did not write stays.

### bogen live

```text
bogen live <dev server url> --dir <project folder>
```

Opens a dev server on this machine in [live site mode](../agents.md#live-site-mode): pick elements and
have `claude` or `codex` edit the project's source. The address must be plain http on `localhost` or
`127.0.0.1`, and `--dir` the folder of one project.

### bogen agents check

```text
bogen agents check [--runner claude|codex] [--model <m>] [--json]
```

Runs your real `claude` and `codex` on a throwaway file: a polite request phrased as a question, a pure
question and a two-turn chat, and reports per runner whether it changed something, answered correctly and
remembered. It uses your plan: four small runs per CLI on the cheap model comments use, unless `--model` says
otherwise. It runs in a throwaway server with its own data folder, so it needs no running Bogen and leaves no
file, run or sync behind. Exits 0 when every case passed. See [Check the agents](../agents.md#check-the-agents).

## Checking the setup

### bogen doctor

```text
bogen doctor [--json]
```

Checks the whole setup and prints the fix for each problem. Changes nothing. Exits 1 when a check
failed. With the phone on, it also checks the phone listener, its port in `tailscale serve`, the allowed
logins, and whether the tailnet policy lets each of your phones reach that port. See [Troubleshooting](../troubleshooting.md).

### bogen report

```text
bogen report [--output <file>] [--no-doctor] [--json]
```

Writes a bundle for a bug report, a `.tar.gz` readable by you only, and sends nothing. By default it goes to
`reports/bogen-report-<time>.tar.gz` in the data folder; `--output` picks the file. It holds:

| File | What it is |
| --- | --- |
| `version.json` | Version and build, how Bogen was installed, Node, the system, the desktop. |
| `doctor.json` | What `bogen doctor` checks. `--no-doctor` leaves it out, and with it the test render in the browser. |
| `status.json` | The running server's status, when it runs. |
| `server.log`, `journal.log` | The last 64 KB of `server.log` in the data folder, and the last 400 lines of the user service's journal when there is a service. |
| `runs.json` | The ten latest agent runs that failed or were cut off, with their errors and the start of their prompts. |
| `peers.json`, `phone.json` | Paired devices with their addresses, state and version; the phone listener and paired phones. Never their tokens or the pairing code. |

Tokens, keys, cookies, passwords and `Authorization` headers of known shapes are replaced by `[redacted]`,
Tailscale logins and e-mail addresses by `[login]`, the tailnet's name in `*.ts.net` names by `[tailnet]`, and your
home folder by `~`. Masking recognises known shapes only, so read the files before you attach them to an issue.

## Releases and updates

### bogen verify

```text
bogen verify <file> [--sig <file.sig>] [--sha256 <file.sha256>] [--json]
```

Checks a release file against its `.sha256` and its Ed25519 `.sig`, which it looks for beside the file, with the
release keys built into this `bogen`. A provenance statement (`*-provenance.intoto.json`) also has each file it lists
checked, when that file lies beside it, and an SBOM (`*.cdx.json`) the package it names. Exits 0 only when the file
is verified. See [Checking a release](https://github.com/marselnenaj/bogen/blob/main/SECURITY.md#checking-a-release).

### bogen update

```text
bogen update                     # the settings and the last check
bogen update check [--json]
bogen update apply [--json]
bogen update on | off
bogen update source <url> | default
```

| Command | What it does |
| --- | --- |
| `check` | Fetches `bogen-release.json` from the latest GitHub release and says whether it is newer. Exits 1 when it could not ask. |
| `apply` | For an npm install: downloads the manifest, the package and their signatures, and installs the package with `npm install --global` into the prefix this `bogen` came from, only when both signatures verify and the package matches the signed digest. A system package, a checkout and a deployed copy are refused with the way to update them. Restart a running server afterwards. |
| `on`, `off` | Turns the server's daily check on or off. `check` still works when it is off. |
| `source` | Fetches releases from another folder URL, `https` only; `default` goes back to GitHub. |

The editor and the Omarchy bar widget show one quiet line when the daily check found a newer release.
[Privacy](../privacy.md#update-checks) shows the exact request.

## Capture and import

### bogen capture

```text
bogen capture <url> [--file <id>] [--page <name>] [--name <artboard>] [--width 1440] [--height 900] [--scheme dark|light] [--no-fonts]
bogen capture --site <url> [--widths 1440,768,390] [--schemes dark,light] [--limit 30] [--file <id>] [--name <file name>] [--no-fonts]
```

Copies a page, or a whole site with one page per route, onto the canvas as editable layers. A single
page prints its result as JSON; a site prints its progress and a report, and exits 1 when it failed.
See [Capture](../capture-and-import.md).

| Option | What it does |
| --- | --- |
| `--file <id>` | Add to this file. Without it, a new file. |
| `--page <name>` | One page: the page in that file. |
| `--name <name>` | One page: the artboard's name. A site: the new file's name. |
| `--width`, `--height` | One page: the viewport, 200 to 4000. Defaults 1440 and 900. |
| `--scheme dark\|light` | One page: the colour scheme. |
| `--site <url>` | Capture the whole site. |
| `--widths` | A site: widths, comma separated. Default 1440. |
| `--schemes` | A site: `dark`, `light` or both. Default dark. |
| `--limit` | A site: the most routes. Default 30, at most 200. |
| `--no-fonts` | Do not keep the page's self-hosted fonts. |

### bogen export, bogen import

```text
bogen export <file or brand, id or name> [<file.bogen>] [--no-brand] [--force]
bogen import <file.bogen>
```

Writes a `.bogen` file, by default `<name>.bogen` here, with the brand the file links to unless
`--no-brand`; a brand is written on its own. `--force` replaces a file that is there. `import` opens a
`.bogen` file as a new file and adds the brand it carries, or keeps the one this device has and says
when they differ. See [A .bogen file](../export-and-code.md#a-bogen-file).

### bogen import figma

```text
bogen import figma <file url> [--token <figma token>] [--save-token] [--name <file name>]
```

Imports a Figma file or frame through Figma's REST API with your personal access token, from
`--token`, `FIGMA_TOKEN`, or one saved before. `--save-token` keeps it in `config.json`, readable by you
only. See [Import from Figma](../capture-and-import.md#import-from-figma).

## Design folders and Git

### bogen export-folder, import-folder, diff

```text
bogen export-folder <file id or name> <folder> [--no-brand]
bogen import-folder <folder> [--name <name>]
bogen diff <folder A> <folder B> [--json]
```

Write a file as a folder of text, with its brand in `brand/`, make a new file from such a folder, and
show what changed between two folders. See [History](../history.md#design-folders-and-git).

### bogen replay

```text
bogen replay <file id or name> [--page <name>] [--format mp4|webm|gif] [--speed 2] [--max-idle 1.5]
             [--from <change>] [--to <change>] [--run <id>] [--width 1920] [--height 1080] [--fps 30]
             [--camera auto|grow|fit|follow] [--no-captions] [--no-cursors] [-o <file>]
```

Films how a page was built, step by step, from its history, and writes the video here. The format
follows the name given with `-o`, else MP4. `--from` and `--to` take change ids from the timeline,
commit ids or times; `--max-idle` is in seconds. See [Replay](../history.md#replay).

### bogen git

```text
bogen git init <file> <dir>
bogen git commit <file> [<dir>] [--message <text>]
bogen git log <file> [<dir>] [--limit <n>]
bogen git restore <file> [<dir>] [--rev <commit>]
```

Keeps a file's design folder in a real Git repository. `init` makes or uses the repository and binds
the file to it; afterwards `<dir>` can be left out. `-m` is short for `--message`. `log` shows 50
commits unless `--limit` says otherwise. Bogen runs no prompts or hooks and never pushes.

## Devices

### bogen peer

```text
bogen peer pair [--name <this device>] [--json]
bogen peer add <url> --token <t> [--name <n>]
bogen peer list [--json]
bogen peer status [--json]
bogen peer remove <id>
bogen peer tailnet <on|off>
bogen peer deploy <ssh-host> [--dry-run] [--port <port>]
```

| Command | What it does |
| --- | --- |
| `pair` | Turns on the Tailscale listener and prints what the other device runs to pair with this one. `--name` names this device. |
| `add` | Pairs with another device, both ways. The token can come from `BOGEN_PEER_TOKEN` instead of `--token`. |
| `list` | Paired devices with their ids. |
| `status` | This device and each paired one: state, last sync, pending changes, bytes in and out, last error, version, and who has a file open there. |
| `remove` | Stops syncing with a device. |
| `tailnet` | Turns the Tailscale listener on or off, and saves it. |
| `deploy` | Copies this build to another Omarchy device over ssh, installs it, restarts it and reports its version. `--dry-run` changes nothing. |

See [Devices](../devices.md).

### bogen phone

```text
bogen phone on [--login <a,b>] [--https-port 29443] [--phone-port 29991] [--json]
bogen phone off
bogen phone pair [--json]
bogen phone list [--json]
bogen phone remove <id>
bogen phone status [--json]
```

| Command | What it does |
| --- | --- |
| `on` | Starts the phone listener on 127.0.0.1:29991 and saves that, so the service starts it again after a restart. Runs `tailscale serve --bg --https=29443 http://127.0.0.1:29991` unless that port already goes there, and leaves it alone if another app uses it. Prints the address, a QR code of it, and what your tailnet policy has to allow. `--login` sets which Tailscale logins may connect; by default only the owner of this computer. `--https-port` and `--phone-port` pick other ports. |
| `off` | Stops the listener, saves that, and takes this one port out of `tailscale serve`. Paired phones stay paired. |
| `pair` | Makes a pairing code that works once, for ten minutes, and prints it with a QR code of the address. |
| `list` | Paired phones with their ids and when each was last seen. |
| `remove` | Revokes a phone. Its token stops working and its open connections close at once. |
| `status` | On or off, the address, `tailscale serve`, the allowed logins, the paired phones, and whether the tailnet policy lets your phones in. |

See [iPhone and iPad](../devices.md#iphone-and-ipad).

## Publishing and review links

### bogen publish and bogen share

```text
bogen publish status [--file <file>] [--json]
bogen publish prepare <file> [<artboard id>] [--page <id>] [--name <title>] [--json]
bogen publish unpublish <site> [listener|folder]
bogen publish remove <site>
bogen publish off
bogen share list [--json]
bogen share revoke <id>
bogen share off
```

| Command | What it does |
| --- | --- |
| `publish status` | Both static listeners, each site with where it is live and its last versions, and how many agents' requests and client comments wait in the editor. `list` is the same. |
| `publish prepare` | Makes a version of an artboard, or of a page with `--page` or of the first page, and prints what was left out. `--name` is the title of the first page. Publishes nothing. |
| `publish unpublish` | Takes a site off Bogen's site or out of its folder, or both. Taking it off GitHub Pages pushes a commit, so that is done in the editor, where you see what it removes. |
| `publish remove` | Forgets a site and its versions, once it is live nowhere and no working review link shows it. |
| `publish off`, `share off` | Turns the site listener or the review listener off, saves that, and takes its one port out of `tailscale serve` or Funnel. |
| `share list` | Review links with their ids, version, state, views and expiry. Never the link itself. |
| `share revoke` | Stops a link at once. |

Publishing, turning a listener or Funnel on, and making a review link happen in the editor only;
`bogen publish on` and `bogen share create` say so and change nothing. See
[Publish](../export-and-code.md#publish) and [Sharing for review](../sharing.md).

## Omarchy

```text
bogen omarchy install [--dry-run] [--no-service] [--no-plugin] [--no-hypr] [--tailnet]
bogen omarchy uninstall [--dry-run]
```

Runs the Omarchy installer or uninstaller that comes with this build. See [Omarchy](../omarchy.md).

## Other

| Command | What it does |
| --- | --- |
| `bogen version`, `--version`, `-v` | Prints the version with its build, such as `0.1.0+4448e40`. |
| `bogen help`, `--help`, `-h`, or no command | Prints the usage. |

## Environment

| Variable | What it does |
| --- | --- |
| `BOGEN_HOME` | The data folder. Default `$XDG_DATA_HOME/bogen`, else `~/.local/share/bogen`. |
| `BOGEN_PORT` | The port. Default 29990. |
| `BOGEN_URL` | For `mcp`, `status` and `open`: use a server elsewhere, without starting one. |
| `BOGEN_TOKEN` | Bearer token, instead of `--token`. |
| `BOGEN_BROWSER` | Path to a Chromium-based browser. |
| `BOGEN_WELCOME` | `0` stops `bogen serve` from making the welcome file in an empty data folder. |
| `BOGEN_NO_SANDBOX` | `1` starts the browser without its sandbox, for containers without user namespaces. Capture and screenshots then load pages, including pages from the web, in an unsandboxed browser: use it only inside a container. |
| `BOGEN_FFMPEG` | Path to ffmpeg for video and AVIF, or `none` to use only the browser. |
| `BOGEN_EXPORT_DIR` | Where `export_file` writes. Default `~/Downloads/Bogen`. |
| `BOGEN_TOMACCOCTL` | Path to `tomaccoctl` for app screens, or `none` to never call it. Default: found on `PATH`. |
| `BOGEN_TRANSCRIBER` | A command that writes out a voice note, given the audio's path, or `off`. Default: whisper.cpp or faster-whisper when installed. |
| `BOGEN_WHISPER_MODEL`, `BOGEN_FASTER_WHISPER_MODEL` | The model for whisper.cpp (a `ggml-*.bin` file) or faster-whisper, when not in the usual places. |
| `BOGEN_ALLOWED_ORIGINS` | Extra browser origins the server accepts, comma separated. |
| `BOGEN_UPDATE_CHECK` | `off` turns every update check off, also `bogen update check`. |
| `BOGEN_UPDATE_URL` | Where releases are fetched from, an `https` folder URL. Default the latest GitHub release. |
| `FIGMA_TOKEN` | For `import figma`: your Figma personal access token. |
| `BOGEN_PEER_TOKEN` | For `peer add`: the other device's token, to keep it off the command line. |
| `CODEX_HOME` | Where `install` and `uninstall` find Codex's config and skill. Default `~/.codex`. |
