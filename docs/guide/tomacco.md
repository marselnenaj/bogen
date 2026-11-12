# Tomacco

[Tomacco](https://tomacco.dev) is a sibling project by the same author that builds, runs and tests Android and
iOS apps on Linux. Neither needs the other. Bogen reads the
screens it exports, so a real app screen can come onto the canvas as an artboard you can edit, and a
design can be checked against the screen the app really shows.

Bogen only reads Tomacco's documented export format and, when it is installed, asks `tomaccoctl` for
a screen. It installs nothing, changes nothing on the device and needs nothing from Tomacco beyond
that format. Bogen does not build, install or start apps: that is Tomacco's work, and your agent can
do both in one loop ([Build and run with Tomacco](#build-and-run-with-tomacco)).

## The export

A screen export is a folder with two files, written by `tomaccoctl call screen.export`:

| File | What it holds |
| --- | --- |
| `screen.png` | The screenshot at full resolution. |
| `screen.json` | Format `tomacco.screen`, version 1: the device, the display with its size in pixels and in dp or points, the system bars, the theme, the app, and every element on the screen with its bounds, text, role and state. |

Bogen reads version 1 and ignores fields it does not know. It refuses another format, a newer
version, a `screen.json` over 8 MB and a `screen.png` over 40 MB. When the export does not say how
many pixels make a dp or point, as an older iPhone export may not, Bogen takes the likely scale and
says so.

## Import an app screen

Click the phone button in the toolbar, **Import an app screen** in the command palette (Ctrl+P), or
**Import an app screen** under **The app on a device** in the Export tab, and pick where the screen
comes from:

- **From a device**: the screen a running emulator, Android device or iPhone shows now. Bogen lists
  the devices `tomaccoctl` sees and takes the screen with it. Without `tomaccoctl`, or with no device
  running, it says what to do next ([When Tomacco is not ready](#when-tomacco-is-not-ready)).
- **From an export**: a folder of an export on this computer, or its two files chosen by hand.

Then choose:

- **Text as editable text**, on by default. Off keeps text as pictures, exactly as on the screen.
- **Device frame**: a dark frame with rounded corners around the screen.
- **Keep the screenshot under the layers**, on by default, locked at the bottom as a reference.

**Import as artboard** places one artboard at the device's size in dp (Android) or points (iOS). With
an artboard selected, it goes to the right of that artboard at the same top, past whatever is already
there, and **Compare with ... afterwards** (on by default) opens Design versus app on the same
capture, so the screen is taken once. With nothing selected, it goes after the last artboard. Above the screenshot, every element of the UI tree is a layer, nested as in the
app: text as real text in the colour it has on the screen and at about its size; pictures, icons and
controls as crops of the screenshot, which look right and can be moved; the status and navigation
bars as their own layers. The whole import is one undo step.

Font sizes and weights are read off the pixels and are estimates: check them, and swap in your own
text styles.

## Design versus app

Select a design artboard and choose **Design versus app** in the command palette or in the Export
tab. Pick the app's
screen the same way. Bogen renders the artboard at the screen's pixel size and shows:

- **Side by side**, **Overlay** with the app's opacity on a slider, or **Difference**, with the pixels
  that differ in red, and the share of pixels that differ.
- **Matched elements**: each text and leaf layer paired with an element of the app, by the same
  words first and then by place, with how far it is off in dp or points and whether the text differs.
  Hover a pair to see both on the picture.
- What is **only in the app** and **only in the design**.

The artboard should be the screen's width. An artboard made by an import with a frame is compared by
its screen, without the frame.

## When Tomacco is not ready

Before a screen is taken, Bogen asks Tomacco what it can do now, with three calls that only read:
`tomaccoctl --version`, `tomaccoctl call device.list` and, only when no device is running,
`tomaccoctl call doctor`. The answer is kept for a minute; **Look again** asks again.

| State | What the editor shows |
| --- | --- |
| Tomacco is not installed | That `tomaccoctl` is not on this computer, and Tomacco's install line, `curl -fsSL https://tomacco.dev/install.sh \| bash`, to copy. |
| Installed, no device running | The first of `doctor`'s next steps, its command to copy (such as `tomaccoctl setup --yes`) and Tomacco's own words about it, such as that it downloads about 5 GB. |
| A device is running | Nothing extra: pick the device and take the screen. |

Bogen shows these commands and never runs them. Steps that Tomacco marks `ask_first`, such as an
SDK download or loading a kernel module with `sudo`, are for you to decide.

## Build and run with Tomacco

Bogen takes the screen of an app that already runs; it does not build or start one. When your coding
agent has both MCP servers, Bogen's and Tomacco's (`tomaccoctl mcp`), it can go from design to the
running app and back in one loop. Tomacco's tools carry the names of its operations (`project.run`),
or in its `grouped` tool list one tool per area (`project`, with `operation`).

1. Design in Bogen, then hand it off: `code_get` for the artboard, written into your app's repository.
2. In Tomacco: `project.inspect` with the repository's path, for its kinds (Flutter, Gradle,
   React Native, Expo, xtool, ...) and platforms; `device.list` or `capabilities` for a running
   device. Starting an emulator is Tomacco's too (`android.avd_start`), with your agreement.
3. `project.run` with `path`, `platform` and `device`: it answers a job. `job.wait` until it ends
   (a plain Gradle install) or reports the phase `ready` (a Flutter session); `job.logs` says why
   when it fails. `job.cancel` stops it.
4. Back in Bogen: `tomacco_status`, then `tomacco_import` with that `device` and `beside` set to the
   design artboard, then `tomacco_compare` with the artboard and the same `device`.
5. Change the code, reload (`job.send` for Flutter hot reload), and compare again.

The person sees the import and the comparison on the canvas, and each is one undo step. Builds run in
Tomacco under its own agent policy, which can ask before destructive steps.

### Exact apps

Bogen writes an artboard as an experimental [Exact](export-and-code.md#an-exact-app-experimental)
app. Tomacco 1.5.0 does not build or run Exact apps yet: `project.inspect` does not recognise an
Exact folder. Until it does, follow the steps in
[An Exact app](export-and-code.md#an-exact-app-experimental) to run it with Exact's own tools, and
take its screen into Bogen from an Android emulator through Tomacco as above.

## For your agent

- `tomacco_status`: `ready` with the devices, `no-device` with `doctor`'s next steps, or `missing`
  with the install line. Reads only.
- `tomacco_import` with `bundle` (the folder or its `screen.json`) or `device` (an id from the
  device list), and `text`, `frame`, `screenshot`, `name`, and `beside`, a design artboard to put the
  screen next to. With neither `bundle` nor `device`, it lists the devices.
- `tomacco_compare` with `node_id` and the same `bundle` or `device`: the share of differing pixels,
  the matched elements and what is only on one side.

Both read the computer the server runs on. See the [tool reference](reference/mcp-tools.md).

## Privacy and limits

- Bogen calls only `tomaccoctl` operations that read (`device.list`, `doctor`) and `screen.export`,
  which writes the export into a temporary folder that is removed afterwards.
- Devices and folders are read only for a request from this computer. From a paired phone, the two
  files can be uploaded, and a device or a folder cannot be named.
- `BOGEN_TOMACCOCTL` gives the path of `tomaccoctl`, or `none` to never call it. Otherwise Bogen looks
  for it on `PATH`.
- The screenshot is stored as an asset of the file, like any image.
- Tried with Android and iPhone exports in the documented format and with a stand-in for
  `tomaccoctl`. Not yet with a real device.
