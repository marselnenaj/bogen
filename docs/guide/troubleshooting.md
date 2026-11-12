# Troubleshooting

Symptom, cause, fix. The messages are the ones Bogen prints.

**Start here.** This checks the whole setup and prints the exact fix for each problem. It changes
nothing:

```sh
bogen doctor          # --json for the same as JSON
```

It looks at Node, the data folder, the user service, the server and whether it is the same build as
the command, the editor, the browser (by rendering a test image), Tailscale and its listener, ufw,
each paired device and its version, the `claude` and `codex` CLIs, and each MCP client installed here.
It exits 1 when something failed. Notes are not failures.

The background server logs to `server.log` in the data folder (`~/.local/share/bogen`). With the
user service, read `journalctl --user -u bogen`.

**Reporting a bug.** `bogen report` puts the version, `doctor`, the end of both logs, recent runs that
failed, and the state of paired devices and phones into one `.tar.gz` on your computer, with tokens,
keys, cookies and Tailscale logins masked. It sends nothing. Read it, then attach it to the
[issue](https://github.com/marselnenaj/bogen/issues/new?template=bug_report.yml). See
[the command line](reference/cli.md#bogen-report).

## Starting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Port 29990 is in use. If that is Bogen already, run bogen status.` | Something else, or Bogen itself, holds the port. | `bogen status`. Otherwise stop the other program, or use `--port`. |
| `The Bogen server did not start. See .../server.log` | The background server exited. | Read `server.log`. A port taken by another program is the common cause. |
| `Running on ..., version X` followed by `This command is Y, so that server runs another build. Restart it.` | You rebuilt or updated, and the old server still runs. | `bogen stop && bogen start`, or `systemctl --user restart bogen`. |
| `Listening beyond this machine needs a token` | `--host` with an address other than this machine, and no token. | Add `--token <secret>`, or set `BOGEN_TOKEN`. |
| `bogen: command not found` from a checkout | The checkout has no `bogen` on the `PATH`. | Use `node packages/server/dist/cli.js`, an alias, or the Omarchy installer's wrapper. |
| The browser shows `The editor is not built`, or `bogen doctor` says `Editor: not built, MCP still works` | `npm run build` did not build the editor. | Run `npm run build` in the checkout. |
| `This Host is not allowed.` in the browser | You opened Bogen by a name or address other than `127.0.0.1` or `localhost`, on a server without a token. | Use `http://127.0.0.1:29990`. To reach it from elsewhere, run it with `--host` and `--token`. |
| `A valid token is required.` | The server runs with a token. | Open `/?token=<token>` once in the browser, or send `Authorization: Bearer <token>`. `bogen open` does this for you with `BOGEN_TOKEN` set. |

## Rendering, screenshots and exports

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Chromium-based browser was found.` | No Chromium, Chrome, Brave or Edge on the `PATH` or in the usual places. | Install one, or set `BOGEN_BROWSER` to its path. |
| `Could not start ...: ... In a container without user namespaces, set BOGEN_NO_SANDBOX=1.` | The browser's sandbox cannot start. | In a container, set `BOGEN_NO_SANDBOX=1` for the server. Elsewhere, check that the browser starts at all. |
| `The page is empty, so there is nothing to render. Add an artboard first.` | Nothing is on the page. | Draw something, or point at another page. |
| `Nothing to capture: the layer is hidden or has no size.` | The layer is hidden or zero in size. | Show it, or give it a size. |
| A font looks wrong in a render, or falls back | The family is neither installed here nor on Google Fonts, or there was no network for Google Fonts. | Install the font, or use one from Google Fonts. Fonts kept by Capture travel in the file. |
| `AVIF needs an AV1 encoder, and neither this browser nor an ffmpeg on the PATH has one.` | No AV1 encoder. | Install ffmpeg with AV1, or set `BOGEN_FFMPEG` to one. |
| `There is no ffmpeg on this machine. Leave the encoder out to use the browser.` | ffmpeg was asked for and is missing. | Leave out the encoder, or install ffmpeg. |
| `This ffmpeg has no H.264 encoder.` (or VP9, AV1) | Your ffmpeg build lacks it. | Use another format, another ffmpeg, or `BOGEN_FFMPEG=none` for the browser's encoder. |
| `An image of ...px is more than the browser can encode as webp (16383px at most each way).` | WebP is limited to 16383 pixels on a side. | Use PNG, or a lower scale. |
| `Nothing was exported. ... already exists. Pass overwrite true ...` | `export_file` never replaces a file by itself. | Choose another name, or ask your agent to overwrite. |
| `Nothing was exported. ... is in a hidden folder.` / `is outside your home folder` / `is a protected folder` | `export_file` only writes under your home folder, not into hidden or key folders. | Pick another folder. Hidden folders need you to say so to your agent. |

## Agents

| Symptom | Cause | Fix |
| --- | --- | --- |
| Your agent does not list Bogen's tools | It is not registered, or the client needs a restart. | `bogen install <client>`, restart the client, then `bogen doctor` (its `MCP` lines). |
| `ok` lines from `bogen install`, but nothing in Cursor, VS Code, OpenCode, Gemini or Zed | These entries follow the documented formats and have not been tried with the apps. | Check the entry in the file `bogen install` names, and compare with your client's docs. |
| `... could not be read as JSON, so it was left alone` | The client's config file has something Bogen cannot parse. | Fix the file by hand, or add the entry yourself (see [other clients](agents.md#other-clients)). |
| `There are no files yet. Call file_create.` / `No file is open. Call file_list and then file_open, or pass file_id.` | The agent has no current file. | Open a file in the editor, or tell your agent which file to use. |
| `Layer ... is locked` | You locked the layer, or a parent of it. | Unlock it, or tell your agent it may. |
| `Layer ... is part of a copy of a shared library component.` | Copies from a library are read only in the files that use them. | Change the component in the library's file, publish, and accept the update. |
| `This session has ended. Start a new one.` | The MCP session is gone, after a server restart or a long pause. | Reconnect the client. `bogen mcp` reconnects by itself. |
| Ctrl+K: `The claude CLI was not found on this machine.` (or `codex`) | The CLI is not on the `PATH` of the server. | Install it. With the user service, the service's `PATH` counts, not your shell's. |
| `A run is already going on this file. Wait for it to finish, or stop it.` | One run per file. | Wait, or stop it in the Agents tab. |
| `4 runs are already going. Wait for one to finish.` | At most four runs at once. | Wait. |
| A comment says `5 comments are already waiting for an agent in this file.` | The queue per file is full. | Mention it again once those are done. |
| A comment says the file has started 20 runs from comments in the last 10 minutes | The limit per file. | Wait a while. |
| A mention in a comment starts nothing | The comment came from another device, an agent, or an import. Only you, on this device, start runs. | Write the mention in the editor on the device that runs the agent. |
| `bogen-gen: does nothing, so those images were left empty.` | A prompt or an agent asked Bogen to generate an image. Bogen has no image generator. | The agent makes the image itself, as SVG or CSS or with its own image tool, and stores it with `asset_upload`. The empty image stays as a placeholder until then. |
| `path works only on a server that listens on this machine alone.` | `asset_upload` with `path` on a server bound to another address. | Send the file as `data_base64`, or run the server on 127.0.0.1. |
| `wait_for_event` returns `reset` | The server restarted, and its event log is in memory. | The agent catches up with `comments_list` and `layer_tree`. |

## Capture and import

| Symptom | Cause | Fix |
| --- | --- | --- |
| `... is a private address and is not captured.` | Addresses on your private network are never captured. | Capture a public address, or run the site on this computer. |
| `Pages on this computer can only be captured from the command line, not by an agent.` | Your agent asked for `localhost`. | Run `bogen capture http://localhost:...` yourself. |
| `A Figma personal access token is needed.` | No token was passed, set or saved. | Make one in Figma under Settings, Security, with the `file_content:read` scope, and pass `--token`. |
| `Figma refused this token for this file.` | Wrong token, missing scope, or no access to the file. | Check the token, its `file_content:read` scope, and that you can open the file. |
| `Figma is rate limiting this token.` | Too many requests. | Wait and try again. |
| `That is not a Figma file URL.` | The link is not a file or frame link. | Copy the link of the file or frame from Figma. |

## Devices

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No Tailscale address here. Start Tailscale (tailscale up) and try again.` | Tailscale is not up. | `sudo tailscale up`. |
| `bogen doctor`: `... answers Tailscale ping but not TCP 29990` | The firewall there, or your tailnet policy, is in the way. | On that device: `sudo ufw allow in on tailscale0 to any port 29990 proto tcp comment bogen-sync`, and allow tcp:29990 between the devices in the Tailscale access controls. |
| `bogen doctor`: `... is up, and nothing listens on 29990 there` | Bogen there is stopped, or its listener is off. | On that device: `bogen peer tailnet on`, or `systemctl --user start bogen.service`. |
| `bogen doctor`: `... does not answer` | The device is off or not on the tailnet. | Check `tailscale status`. |
| `The server at ... is older than this command.` | The server predates the peer commands. | Restart it with the new build. |
| A device `runs <version>, which differs` | The two run different builds. | `bogen peer deploy <its ssh host>`, or update it by hand. |
| `bogen peer add` prints `Not connected yet. It keeps trying` | The other side is not reachable yet. | Check the two items above, then `bogen peer status`. |
| `This install has no integrations/omarchy/deploy.sh to deploy with.` | `peer deploy` runs from a checkout, or an install that carries `integrations/omarchy`. | Run it from a checkout. |

## Omarchy

| Symptom | Cause | Fix |
| --- | --- | --- |
| `This is for Omarchy, and the omarchy command is not here.` | The installer only runs on Omarchy. | Use Bogen without it; nothing else needs it. |
| `Missing: jq` or `Missing: curl` | The installer needs both. | Install them. |
| `... is not built. Run this in ... first: npm run build` | The checkout has no build. | `npm run build`, then run the installer again. |
| `This build came without integrations/omarchy.` | `bogen omarchy` found no installer next to this build. | Run `integrations/omarchy/install.sh` from a checkout. |
| The installer warns `something already answers on ...` | Another server, such as a dev server, holds the port. | The service is enabled but not started. Stop the other server, then `systemctl --user start bogen`. |
| `doctor`: `bogen.service runs, but is not enabled` | It will not start at login. | `systemctl --user enable bogen.service`. |
