# Devices

Bogen on two of your machines, say a desktop and a laptop, can hold the same files and merge what you
change on either, also while one of them is asleep or offline. They talk over Tailscale only. There is
no Bogen cloud in between.

## What syncs

- Files: new ones, renames and deletes. A delete that meets an edit made on the other side at the same
  time keeps the edit and brings the file back.
- Every edit, merged per value; text merges per character, except when both sides changed the same
  words while apart (see below).
- Assets, checked by hash and size.
- Brands, libraries, change logs and named commits. Automatic commits stay on the device that made
  them.
- Who has a file open on the other device and what they select. Cursors only when you turn that on
  in the Agents tab.

Agents and their runs stay on the device where they run. Home screen folders, the list of older
copy-branches and code project links are per device too. Branches inside a file sync with it ([History](history.md#branches)).

When both sides changed the same value while apart, Bogen keeps one and writes a conflict note. The
Sync section of the Agents tab shows both values, with **Use the other** and **Dismiss**.

Text is the same, with one exception. When both sides changed the words of the same text layer while
apart, Bogen keeps one side's whole text, never a mix of the two, and both devices note it. The note
shows this device's text and the other device's, with **Use the other**, **Keep both as a branch** and
**Dismiss**. Keep both as a branch leaves the file as it is and makes a branch of it, named
"text from" and the device, whose layer has the text that was not kept. Merge it back or discard it
in the History panel, under Older copies ([History](history.md#older-copies)). Both devices keep the same text: the one the layer's `text`
field keeps, by the CRDT's own rule, as for every other value. The two machines' clocks never decide.

Edits from both sides still merge, with no note, when they are in different words and do not touch:

- The text both had before is cut into words at spaces and line breaks.
- An edit touches a word when it deletes a letter of it, or types next to it with no space in between.
  Typing at the end of `world` touches `world`; inserting `brave ` in front of it does not.
- Two edits clash when they touch the same word, or sit next to each other with nothing unchanged in
  between.

So one side changing the start of a sentence and the other its end merges: `Welcome to Bogen` with
`Hi, welcome to Bogen` on one side and `Welcome to Bogen today` on the other becomes
`Hi, welcome to Bogen today`. Both changing one word (`Price 100` to `105` and to `200`), both typing at
the same place, or both rewriting the whole text keeps one side and writes the note. When both typed the
same words, the text keeps them once, and there is no note.

Typing on both devices while they are connected never counts: it merges per character, as it does
between two people. Only a catch-up after the link was down settles text, and only when one of the two
changed the file while it was down. A device on an older build gets the settled text but shows no note,
and when the older build catches up first, the text merges per character as it did before.

When a file changed while nobody had it open, a banner says once what changed, and also how many texts
kept one side's words.

## What you need

- Tailscale, signed in on both machines.
- Bogen on both, ideally the same build. Each tells the other its version, and `bogen status`,
  `bogen peer status`, `bogen doctor` and the sync indicator in the editor's top bar say when they
  differ.
- TCP port 29990 open between the two over Tailscale. See [Firewall and tailnet
  policy](#firewall-and-tailnet-policy).

## Pair two devices

On the first device:

```sh
bogen peer pair --name Desktop
```

This turns on the Tailscale listener, saves that, and prints a command:

```text
On the other device, run:
  bogen peer add http://100.x.y.z:29990 --token <token> --name 'Desktop'
```

Run that line on the second device. One command pairs both ways. To keep the token off the command
line, put it in `BOGEN_PEER_TOKEN` and leave out `--token`.

The listener binds only to the address from `tailscale ip -4`, and everything on it needs the device's
token. If Tailscale comes up after Bogen, the listener follows. Files sync through their own link
there; the HTTP routes that start agent runs or post comments, and those for brands, libraries, live
site mode and code projects, are closed on it.

## Manage paired devices

| Command | What it does |
| --- | --- |
| `bogen peer list` | Paired devices, with their ids. |
| `bogen peer status` | This device, the tailnet address, and per device: state, last sync, pending changes, bytes in and out, the last error, its version, and who has a file open there. |
| `bogen peer remove <id>` | Stop syncing with a device. Run it on that device too. When no devices are left, this one gets a new token. |
| `bogen peer tailnet on\|off` | Turn the Tailscale listener on or off now, and save that. Off also drops the links that came in on it. A service started with `--tailnet` turns it on again at its next start. |

`--json` gives the output of `list`, `status` and `pair` as JSON.

Each device dials the other, and one connection is enough for both directions. So turning the
listener off on one device does not stop sync: the other still reaches it through its own
connection. To keep two devices apart for a while, turn it off on both.

`bogen serve --tailnet` also listens on the Tailscale address, for that run. On Omarchy,
`integrations/omarchy/install.sh --tailnet` (or `bogen omarchy install --tailnet`) makes the user
service do so.

## Firewall and tailnet policy

Two things can stand between your devices, and both need the owner of the machine or the tailnet:

1. **The firewall.** Omarchy's ufw refuses everything incoming. On each device:

   ```sh
   sudo ufw allow in on tailscale0 to any port 29990 proto tcp comment bogen-sync
   ```

   The Omarchy installer with `--tailnet` offers to do this.

2. **Your Tailscale policy.** A tailnet with its own access rules has to allow TCP port 29990 between
   the devices, in the access controls of the Tailscale admin console.

`bogen doctor` tells these apart where it can: a device that answers Tailscale ping but not TCP on
29990 has a firewall or a policy in the way; one that refuses the connection has nothing listening.
ufw's rules can only be read as root, so without passwordless sudo it prints the rule instead.

## Update another device

From a checkout on one Omarchy machine:

```sh
bogen peer deploy my-laptop --dry-run   # says what it would do, changes nothing
bogen peer deploy my-laptop
```

Over ssh, this copies the current build and the Omarchy integration to `~/.local/share/bogen-app`
there, finds Node (through mise, and installs it with mise only if there is none), runs the installer
with `--tailnet`, restarts the service, and reports the version that answers. It is safe to run again,
and it does not touch your designs. `integrations/omarchy/deploy.sh` is the same script.

### From the editor

When a paired device runs another build, the sync indicator in the editor's top bar says
**MacBook: other version** with **Update the other device** next to it (the Sync section of the Agents tab
has the same as **Update MacBook**). It opens a dialog that:

1. Names both builds, and says which is newer when this computer's checkout can tell. If the other
   device has the newer one, it says so: updating would put the older build there, so update this
   computer from that one instead.
2. Asks for the ssh host, filled in from the device's address, such as `me@100.64.0.12` or a `Host`
   from `~/.ssh/config`. ssh runs without asking for a password, so it needs a key, and the server's
   environment needs your ssh agent (a user service may not have it; `systemctl --user import-environment
   SSH_AUTH_SOCK` gives it).
3. Runs the dry run first and shows its output. **Update MacBook** only works after a dry run for that same
   host, within 15 minutes.
4. Runs `bogen peer deploy <host>` and shows its output.

Only the person at this computer can do this. The phone app, the tailnet listener and anything behind a
proxy cannot; the phone says to update it from the computer. This install needs the deploy script, which
a checkout and the Omarchy install have; an install from npm says which command to run instead.

It has updated a real second device, the MacBook Air described under [Limits](#limits), several
times on 2 November 2026: 3 to 6 s each, ending with both devices reporting the same version. The
tests also run it against stand-ins for ssh and systemd.

## iPhone and iPad

Your phone does not run Bogen. It opens the Bogen on your computer, through Tailscale, as an app on
its Home Screen. Files you open there are also stored on the phone, so you can look at them and edit
them without the computer. The edits merge when it is back. With two computers, each is its own app on
the Home Screen: see [A second computer](#a-second-computer).

### What you need

- Tailscale on the phone, signed in with the same login as the computer.
- Bogen running on the computer, as the user service or with `bogen start`.

### Set it up

1. On the computer:

   ```sh
   bogen phone on
   ```

   This starts a listener on 127.0.0.1:29991, saves that so it comes back after a restart, and runs
   `tailscale serve --bg --https=29443 http://127.0.0.1:29991`. It touches no other port of
   `tailscale serve`. It prints the address, such as `https://omarchy.tail1234.ts.net:29443/`, with a
   QR code.

2. Let the phone through your tailnet policy. A tailnet with its own access rules has to allow TCP
   port 29443 from your phone to the computer. Only you can change that, in the access controls of the
   Tailscale admin console. `bogen phone on` prints a rule to add, for example:

   ```json
   {"src": ["you@example.com"], "dst": ["100.x.y.z"], "ip": ["tcp:29443"]}
   ```

   If a rule already lets your phone reach the computer on other ports, add `tcp:29443` to it.
   `bogen doctor` reads the rules Tailscale gives the computer and says, per phone, whether it gets
   in.

3. Pair the phone:

   ```sh
   bogen phone pair
   ```

   or, in the editor on the computer, open the Agents tab and choose **Pair a phone** under Phone.
   You get a code like `K7QM-3XTP` and a QR code.

4. On the phone, scan the QR code with the camera and open the link in Safari. Tap Share, then
   **Add to Home Screen**, then **Add**.

5. Open Bogen from the Home Screen and type the code. The code works once, for ten minutes.

The app on the Home Screen keeps its own storage, apart from Safari, which is why the code is typed
there and not in Safari. To use Bogen in Safari instead, choose **Use Bogen in Safari instead** on
the page the QR code opens.

### Who gets in

Three things have to hold for every request:

- It comes through `tailscale serve`, from a Tailscale login on the allow list. By default that is
  only the login that owns the computer. A device shared into your tailnet from another login does
  not get in. `bogen phone on --login a@example.com,b@example.com` sets the list.
- It is for the computer's own `ts.net` name on the HTTPS port, and a page's Origin is that same
  address. That keeps other sites, and other apps behind `tailscale serve` on the same name, out.
- It carries the token of a paired phone. Each phone has its own, kept in a cookie that pages
  cannot read. `bogen phone remove <id>`, or **Remove** in the Agents tab, ends it at once.

A paired phone counts as you in person: it can start agents, comment for them, and accept or
discard their proposals. It cannot reach the computer itself: no files on its disk, no linking of
code projects, no live site mode, no captures of addresses on its local network, no MCP, and no
settings of devices or phones.

### On the phone

On a phone, Bogen has four tabs:

- **Inbox**: what waits for you. Proposals your agents made, comment threads that are still open, and
  agent runs that finished. Tap a proposal to compare before and after with a slider, then accept or
  discard it, or ask for changes.
- **Files**: your files. **Keep** stores a file and its images on the phone.
- **Ask**: ask Claude or Codex on the computer for a change to a file. While it works you watch the
  canvas and its steps, and can stop it. What it makes comes back as a proposal you can accept or
  discard right in the thread.
- **Settings**: [notifications](#notifications), the computers this app can use (see
  [A second computer](#a-second-computer)), and what waits on the phone for the computer.

Tapping a file opens it in a screen made for touch:

- **The top bar**: **‹ Files** goes back, the file's name is in the middle, and the current page is on
  the right. Tap the page to see every page with how many boards it has, and the boards of the current
  page as small pictures with their widths. Tap a page to switch to it, and a board to put it on the
  screen.
- **The canvas**: pinch to zoom, drag to look around. Under it, where you are (page, board, zoom),
  **‹** and **›** to step to the board before or after, and **−** and **+** to zoom. A quick sideways
  flick with one finger also steps between boards, while the board fits across the screen; zoomed in, a
  sideways drag only pans. Undo and redo appear in the corner once you have changed something, and take
  back only your own changes.
- **The tools at the bottom**, each a sheet over the canvas, which stays in view above it. Drag a sheet
  down by its handle to close it, or tap its tool again.
  - **Layers**: the layers of the board, 44 px rows. Tap one to select it and bring it into view, then
    **Edit ›**.
  - **Edit**: **Text** to change a layer's words in a plain field; **Fill** for colours from the file's
    tokens and the brand's palette; **Layout** for width, height, padding and gap, stepped along the
    spacing tokens; **Type** for the file's text styles and the brand's type scale. Every change is one
    step of undo. **Done** closes it.
  - **Comment**: tap a pin to read its thread and reply, or **Resolve** it. With the sheet open, tap a
    spot or a layer to place a new comment. Mentioning @claude or @codex starts that agent on the
    computer, as on the desktop. To speak instead of typing, see [Voice comments](#voice-comments).
  - **Photo**: take a photo, or choose one from the library, and it goes on the board in view as an
    image layer. See [Photos](#photos).
  - **Ask**: ask Claude or Codex about the selection, or the board in view, with quick suggestions.
    The answer comes back in the sheet as a proposal to accept or discard. The picture button left of the
    field attaches a photo, which the agent sees with the request.

An iPad, or any touch screen that comes through the phone listener, gets the same screen. From 700 px wide,
an iPad either way round or a phone on its side, the sheets are a panel at the right instead of over the
bottom: the canvas keeps its full height and takes the rest of the width, and a board that fitted the screen
fits the narrower canvas again. A panel closes with the **×** in its head, or by tapping its tool again; there
is no handle to drag. Below 700 px nothing changes. The lists of the tabs keep a readable width in the middle.
Choose **View → Touch view / Full workspace** in a file's top bar, the page list, or phone **Settings**.
Touch view is the initial choice; Full workspace opens the complete file browser and responsive editor,
including folders, project kinds and the panel menus. The choice is remembered on this device. Switching
inside an open file keeps its document connection, selection and undo history. An open touch sheet is hidden
while in Full workspace and returns with its unsent text and attachments when you switch back. It is not a
shared conversation composer: the touch Ask sheet and the full editor's agent prompt remain separate.
Existing `#/file/<id>/edit` links still open Full workspace, with the same visible way back to Touch view.
Choosing a view does not grant phone access to host administration, MCP or device deployment.

In Touch view, the camera follows changes to the actual canvas area, including app-window resizing and
switching between compact and wide sheet layouts. A width-fitted board stays fitted; manual zoom keeps its
scale and reading center, and a selected layer remains reachable. The document, open sheet and unsent Ask
draft stay in place. This web behavior is not native iPhone Duo reserved-region or hinge support; those
features need a native implementation and device validation.

Fields are 16 px or more, so iOS does not zoom into them, and the page itself can still be zoomed. While
the keyboard is up, the field of a sheet stays right above it.

### Notifications

In **Settings**, **Notify me on this phone** turns on notifications for:

- **An agent finished**: a run you started, or one from a comment, ended. Not when you stopped it.
- **A comment for you**: an agent answered, or a client commented through a review link. Not your own
  comments, on any of your devices.
- **A proposal is ready**: an agent made one to accept or discard.

Each can be turned off on its own, and **Send a test** sends one now. A run that makes a proposal or answers
a comment is told once, when it ends. A tap opens the file, the thread or the proposal.

They work in the app on the Home Screen, on iOS 16.4 or later; Safari in a tab cannot get them, and the
switch says so. iOS asks once for permission. If you said no, turn notifications on for the app in the
iPhone's Settings, Notifications.

The messages go from your computer to Apple's push service, which delivers them. Each says only what happened
and the file's name, encrypted for this phone. See [Privacy](privacy.md#notifications-on-the-phone).

### Photos

The **Photo** tool takes a photo with the camera (**Take a photo**) or picks one (**Choose a photo**, where
iOS also offers the camera and Files) and places it on the board in view: in its flow when the board lays out
its children, else in the middle of what you see, at most 80 % of the board's width. The picture button in the
comment field and in Ask attaches one instead: in a comment it shows in the thread, and with Ask, or a comment
that mentions @claude or @codex, the agent gets it as an image with the request.

Before it leaves the phone a photo is scaled to 2048 px on its long side, and a JPEG or HEIC is drawn again as a
JPEG, usually well under 2 MB, which leaves its location and camera data behind. A small PNG, WebP or GIF goes as
it is. The phone takes files up to 40 MB and sends at most 6 MB; an agent gets up to four images of 8 MB each.
Photos need the computer: offline the buttons say so.

### A second computer

With Bogen on two computers that sync, such as a PC and a MacBook, the phone can use either. Each computer has
its own phone listener, so each is its own app on your Home Screen, with its own pairing and its own copies of
files on the phone. They show the same designs, because the computers sync with each other. The app is named
after its computer, such as **Bogen omarchy** and **Bogen MacBook** (you can rename it when you add it), and
**Settings**, **Computers** says which computer this app is.

To add the MacBook:

1. On the MacBook, `bogen phone on`, and let the phone through the tailnet policy as for the first.
   Over ssh is fine: `ssh macbook bogen phone on`.
2. In the first app, **Settings**, **Computers** lists the MacBook with its address once it has its phone
   app on. **Copy its address**, open it in Safari, then Share, **Add to Home Screen**.
3. On the MacBook, `bogen phone pair` (also over ssh) gives a code to type in the new app.

When the PC is off, open the MacBook's app. The offline banner in the first app's Files names it. What you
changed in an app while its computer was away waits in that app until that computer is back; it does not move
to the other app.

### Voice comments

There are two ways to speak a comment:

- **Dictation.** The microphone key on the iPhone's keyboard writes what you say into the comment field,
  as in any app. The line under the field says so.
- **The microphone button** left of the field records a voice note. While it records you see the time
  and a level meter, with **Stop** and a button to cancel; it stops by itself after three minutes. The
  recording goes to your computer only, never to a speech service. Bogen asks the microphone the first
  time; if you refuse, or the browser cannot record, the button puts the cursor in the field for
  dictation instead.

On the computer, a speech model you installed writes the recording out: whisper.cpp with a model file,
faster-whisper with a model it already has, or a command of your own in `BOGEN_TRANSCRIBER` (see
[Privacy](privacy.md#voice-notes)). Bogen looks for one and never installs or downloads it. The text
lands in the field, where you can change it before you send it, and the recording is deleted. A
mention of @claude or @codex in it starts that agent, as when you type it.

Without a model, the recording is attached to the comment as "Voice note, 0:12", and the line under the
field says that transcription is unavailable on the computer. You can still add text; with none, the
comment says "Voice note". The thread plays it on the computer that has it, in the editor there and on
the phone; another of your devices shows the comment and says which computer keeps the recording. Remove
it with the cross on the chip before you send. Kept recordings go when their file is deleted, and after
30 days.

### What works offline

- The app itself, once it has been opened online.
- Every file you opened on the phone, as it was when you last had it open. You can view and edit
  it. A line at the top says that the computer cannot be reached, how many changes wait for it, and when
  the file was last in sync: "Offline. 2 changes wait for omarchy. Last synced 12 min ago."
- When the computer can be reached again, the waiting changes go to it first, before the file connects
  again, and the computer compares them with what changed there in the meantime. Separate changes merge.
  A value both sides set, such as a fill changed on the phone and on the computer, keeps one side, by the
  same rule as between two computers; a note at the top of the file says so: "One value was set on both
  sides while apart". **Review** shows both values, whose each is and which stayed, with **Use mine** (or
  the computer's) to put the other one back and **Keep it** to dismiss the note. The computer's Sync section
  lists the same note, from the iPhone. Text both sides changed follows the rules under
  [What syncs](#what-syncs).
- Files with waiting changes that are not open go too, once the computer is back. **Settings**, **On this
  phone** counts what waits and has **Send them now**. A file with waiting changes is never removed to make
  room.
- The list of files says per file when it last synced, how many changes wait, and how many conflict notes
  it has. The inbox and the list of files say how many changes wait in all.
- The list of files on the home screen, as it was when you last saw it. Files that are not on the
  phone are dimmed.
- Files you keep, with their images and fonts, also when you never opened them on the phone. Choose
  **Keep** in Files (or **Keep on this phone** in a file's menu in the full editor's home screen). A
  kept file stays; the twelve most recently opened other files stay too, and older ones make room.
- The inbox as it was when you last saw it.

Nothing that needs the computer works offline: agents, comments to agents, voice notes, exports,
captures, history and thumbnails.

### Turn it off

```sh
bogen phone off
```

This stops the listener and takes port 29443 out of `tailscale serve`. Paired phones keep their
pairing for when you turn it on again; remove them with `bogen phone remove <id>`.

## Limits

- The view switch, connection continuity, selection, Undo/Redo, an unsent Ask draft and the unchanged host
  access guards were checked through real HTTPS pairing in sandboxed Chromium at 320 × 568, 390 × 844,
  844 × 390 and 820 × 1180 (`apps/editor/test/e2e/phone-workspace.ts`). This does not verify Safari or a
  physical iPhone, and Full workspace is the responsive web editor, not a finished native mobile app.
- Used on a real iPhone by the maintainer on 2 November 2026. The iPad screen has been tried only in
  Chromium, at an iPad's size with touch, through a stand-in for `tailscale serve`. How the keyboard
  and the sheets behave in iOS in particular has not been checked.
- Notifications, photos, the second computer, the iPad panel, offline changes with their conflict notes and
  **Update the other device** have been tried only in a sandboxed headless Chromium at 393 x 852 and
  820 x 1180 with touch, through a TLS stand-in for `tailscale serve`, with two real servers paired as
  devices (`apps/editor/test/e2e/phone-devices.ts`). Headless Chromium has no push service: the subscription
  was a stand-in at Apple's address, the messages were decrypted by the test with the phone's key, and the
  service worker was given a message through the browser's debugging protocol. Nothing has gone through
  Apple's push service yet, the iOS permission prompt and HEIC photos from a real camera are untried, and the
  deploy ran a stand-in script.
- A removed phone keeps the files it stored until the app is deleted from it.
- Voice comments have been tried in tests with a stand-in transcriber and a stand-in for whisper.cpp,
  not yet with a real model, and not yet on a real iPhone, where only MP4 recording is expected to work.
- Sync has run between two real machines over Tailscale: an x86_64 PC and an M1 MacBook Air, both on
  Omarchy (the MacBook on Arch Linux ARM), and the same file rendered the same on both. Measured on
  2 November 2026, each time including one look-up on the other side:
  - A new file showed up on the other device in 0.05 s, an edit in 0.04 s from the PC and 0.03 s
    from the MacBook.
  - Apart for a minute, with the listener off on both, and both sides editing the same file: the
    link was down 0.5 s after `bogen peer tailnet off`, and 8 to 10 s after `on` both had the same
    file. Separate edits all merged. A colour both had set differently kept one value and left a
    conflict note on both. Text both had changed merged per character then, which is now settled
    as described under [What syncs](#what-syncs).
  - The same check for text, with `bogen peer tailnet off` on both and one text layer edited on each
    (`Title, from the PC` and `Title cut`): 1 s after `on` both showed `Title, from the PC` and had a
    note with both texts; the same words typed on both appeared once, and a start and an end edited
    apart merged. Keep both as a branch made "text from MacBook" with `Title cut`, and the branch
    reached the MacBook as a file. The buttons were used through the API, not clicked in a browser.
  - The MacBook's service restarted while the PC kept editing: it had the PC's last edit 0.24 s after
    it answered again.
  - The MacBook's service stopped for two minutes while the PC made 12 edits, 3 layers and a file: 0.6
    s after it started again it had all of them. The PC's sync indicator took 16 s longer to say
    connected, since its own dial waits between tries.
  A laptop going to sleep has been simulated, not tried.
- An open editor counts as someone being there, so the "while nobody had it open" banner does not
  show for files that stayed open.
- A paired device on an older build does not get presence (who has a file open), since it would drop
  the connection over a message it does not know.
