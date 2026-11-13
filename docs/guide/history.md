# History

Bogen records every change to a file: who made it (you, another person, an agent, another of your
devices), when, with which tool, and which layers it touched. On top of that you make commits, named
points to come back to. Both travel with the file to your paired devices.

Open the History tab from the toolbar. Changes and commits are one list.

## Find the latest work

**Recent changes** above the canvas shows where the latest recorded edit happened, including its page
and screen. Open the list to see who changed what and jump to an affected screen. Opening a file keeps
your saved page; work on another page is visible here without moving your canvas until you choose it.

The page lists in the desktop editor and Touch view show when each page was last touched within the
recent window. The file browser shows the latest known page/screen below a file; its link opens that
location directly. The compact phone Files list includes the same location. Clicking an ordinary History
change now switches to its affected page as well as selecting and framing its surviving layers.

The compact index keeps the latest 40 recorded edits per file and up to 16 locations per edit, with a
representative of each affected page first. The menu shows three locations per entry and offers History
for more. Global edits may have no canvas location; deleted screens fall back to their surviving page,
and a deleted page is not recreated. Older logs are enriched when that file opens and surviving layers
identify their location. Until then the file list may have no page hint; missing information is not guessed.
These hints do not mark changes as read or accepted. They do not create pages, revisions or screenshots.

## Changes

Every change is a row. From a row you can:

- **Revert this change**, also one that is not the last;
- **Revert everything this run did**, for a whole agent run.

A revert turns a value back only if it still holds what the change left there. What someone changed
since stays, and is listed as a conflict with the reason; the rest still goes back. A layer that gained
children since stays; a layer whose parent is gone cannot come back. A revert is itself a change, can
be reverted, and in the editor is one Ctrl+Z.

This works after a restart and from another device. Your agent uses `change_list` and
`change_revert`, with `dry_run` to look first.

How long changes are kept, per file and device: the last 30 days in full, up to 32 MB. Older changes
lose their details, oldest first, but keep who, when, which tool and which layers, up to 50,000
entries. A thinned change can no longer be reverted, and says so.

## Replay

**Replay** in the History tab, or **Replay how this page was built** in the command palette (Ctrl+P), plays
back how the page in view came about: every step by every person and agent, in order, from the timeline.
Whoever made a step has a cursor with their name, which moves to the layers the step touched; the layers get
an outline in that colour, the page takes the new state, and a caption says which tool it was, such as
`html_write`, and what it did.

- **Play** and **Pause** (Space), **‹** and **›** for the step before and after (Left and Right), and the
  scrubber, with a mark per step in the colour of whoever made it.
- **Speed**: 0.5x to 8x. A real pause between two steps lasts at most 1.5 s in the replay (before the speed),
  and a quick burst still gets a short beat per step, so an afternoon of work plays in a minute or two.
- **Captions** shows or hides the tool and what it did.
- **Export** films the replay as MP4, WebM or GIF on this computer: the range of steps (**From here** starts
  at the step on screen), the size (1920 by 1080, 1280 by 720, upright 1080 by 1920, square, or 960 by 540),
  the speed you play at, the cap on idle gaps, the camera, and whether cursors, names and captions show. The
  camera can show the page as far as it is built and widen as it grows (**As it grows**), show the whole page
  throughout, or follow the work and pull back at the end. By default it grows, and follows when the whole
  page would be too small to read, such as a long landing page in a wide video. The film goes through the
  same encoders as the video export: ffmpeg when it is installed, the browser otherwise. A GIF needs ffmpeg.
- The film wears Bogen's own look, whatever the page: the page on ink, agents' cursors in tomato and people's
  in blue, with names and captions in Archivo. The player in the editor keeps the colours of the canvas.
- **Back to now** (Esc) closes it. The file itself is never changed by a replay.

Your agent uses `replay_export`, with `from` and `to` (a change id from `change_list`, a commit id, or a
time), or `run` for one agent run. On the command line:

```sh
bogen replay "Pricing page" --page Home -o pricing.mp4            # file id or name
bogen replay "Pricing page" --format gif --speed 2 --max-idle 1    # a quick GIF
bogen replay "Pricing page" --from <change id> --to <change id> --camera follow --no-captions
bogen replay "Pricing page" --width 1080 --height 1920 --speed 1.5             # upright, for a phone
```

How it works, and its limits:

- The server rebuilds each state of the file from the timeline, walking back from the file as it is now, so
  the replay needs the timeline's details: changes thinned out after 30 days stop it, and it starts after
  them. It renders each state that changes the page in one browser tab, once, and keeps the pictures for 15
  minutes.
- Changes that did not touch the page play along with the next step that did. A change on another page that
  shows here through an instance of a component appears with the next step on this page.
- At most 800 steps and 10 minutes of film; for more, pick a range or a higher speed.
- Comments are not shown, and a person's drag is one step, as in the timeline.

## Commits

Press Ctrl+Alt+S, or **Commit** in the History tab, and give a message. A commit holds the whole
design.

- **Look at this version on the canvas** previews a commit.
- **Compare with now** shows two versions side by side with a visual difference.
- **Restore this version** brings the design back to a commit as one change. What is there now is
  committed first, so nothing is lost. Layers, pages, tokens, keyframes and other document data go
  back; comments stay as they are. Fonts are only ever added.

Bogen also commits by itself: when an agent run finishes, before a restore, and every few minutes
while you work. **Show automatic commits** lists the timed ones.

How long commits are kept: named commits by people and agents, for good. Commits from runs and
restore points, until a file's commits pass 256 MB, oldest first. Automatic commits thin out to the
latest 24, then one per hour for a day, then one per day for a month.

Your agent uses `commit_create`, `commit_list`, `commit_diff` and `commit_restore`.

## Branches

A branch is a version of the whole design kept inside the same file: its pages and layers, components,
tokens, theme modes and text styles, and the file's own records, such as an Omarchy theme's palette,
name and displays. It is never a file of its own, and it does not show on the home screen as one.
Pictures are shared, so a branch costs no copy of them.

The branch menu next to the file name says which version is checked out, **Main** or a branch, and
lists the others:

- **New branch…** starts one from the version that is checked out, under the name you give, and checks
  it out. Main stays as it was. **Branch** in the History panel does the same.
- Click a branch, or Main, to switch to it. What was live is kept as its own branch, so nothing is
  lost. Undo starts afresh after a switch, so it never writes a step from one branch into another.
- **Review and merge** on a branch shows what it and the version it started from each changed, and
  lists the screens the merge would change, added, removed or changed. **Compare** next to a screen
  opens it as it is now next to how it would be after the merge (see [Compare](#compare)). Where
  both changed the same token, layer or setting differently, you choose per item which side keeps it,
  or **All from** one side; **Merge** waits until every conflict has an answer. A commit is taken
  first, and **Undo this merge** under **Decided** takes it back while the other side is still as the
  merge left it.
- **Discard** asks first. A discarded branch is kept in the file's History as a named commit, and
  **Restore** under **Decided** opens it again.

Only you merge, discard, restore or undo a merge. An agent can start a branch (`design_branch_create`,
or its older name `branch_create`), work in it and switch (`design_branch_switch`), never merge it. A
request to redo a theme, such as "make it again", runs in a branch of the same file, and the next message
of that conversation continues it.

### Compare

A comparison fills the canvas with two pictures of the same screen or page, rendered on this computer:

- **Side by side**, with **Scroll together** on, so that a long page stays aligned on both sides.
- **Overlay**: the second over the first, with its opacity on a slider, and **Highlight differences**
  marking every changed pixel in red.
- **Swipe**: drag across the picture, or use the slider, to wipe from one version to the other.
- **Difference**: the changed pixels alone.

The bar says how many pixels differ, and **Previous screen** and **Next screen** step through the screens
a merge changes. Your choice of mode is kept on this device. **Back to now** returns to the canvas.

The same view opens from **Compare with now** on a commit, from a page in a comparison of two
versions, from **Review and merge** on a branch, and from the compare button on a proposal or a race
lane, which sets the copy next to the original it would replace. Your agent sees the same with
`design_branch_compare`: the screens a merge would change, and for one of them the share of pixels
that differ and a picture of where. It can look; only you merge.

One branch is live at a time. If the file is switched while an agent works on another branch, its
writes are refused rather than mixed in, and an agent cannot switch the file away from another agent
that is working on it. Two agents cannot work on two branches of one file at the same moment.

Branches are part of the file: they sync to your other devices and the phone, and go with a `.bogen`
download, pictures included. A device that edited while away, before it saw a switch, gets its edits
put onto the branch it was editing, not the one live now. Text it typed against the switch cannot be
merged back safely, so that update is held as it came and shown in the branch menu, never mixed in.

### Older copies

Older versions of Bogen made a branch as a copy listed as its own file, and **Keep both as a branch**
for a text both devices edited while apart ([Devices](devices.md)) still does. The History panel lists
such copies under **Older copies**, where you compare, merge or discard them. Merging one applies the
copy through the same mechanism that merges edits from several people, so when both sides changed one
value, the later edit wins; there is no three-way view. The list of older copies stays on the device
that made them, though the copies sync as files.

## Design folders and Git

A design folder is a design written out as text: sorted keys, parents before children, assets as
files. It diffs well, and writing it back gives the same bytes.

```sh
bogen export-folder "Pricing page" ~/Work/site/design     # file id or name
bogen import-folder ~/Work/site/design --name "Pricing page"
bogen diff ~/Work/site/design ~/Work/old/design            # --json for a machine-readable diff
```

`export-folder` writes the brand the file links to as a design folder of its own, in `brand/`, and
`import-folder` brings it in the same way a `.bogen` file does: added if the device does not have it,
kept as it is if it does. `--no-brand` leaves it out. A brand made from a folder is a new copy of its
document rather than the same one, so on a device that also gets the brand from a paired device, both
merge field by field. `bogen git` commits write the design only, without `brand/`.

To keep a design folder in a real Git repository:

```sh
bogen git init "Pricing page" ~/Work/site/design      # makes or uses the repository, binds the file
bogen git commit "Pricing page" -m "Tighter hero"     # writes the folder and commits it
bogen git log "Pricing page"
bogen git restore "Pricing page" --rev <commit>       # brings the file back to that commit
```

Once a file is bound, a commit made in Bogen, by you or by an agent with `commit_create`, is mirrored
to the repository as a real Git commit. Bogen runs no prompts or hooks, and never pushes. Restoring
commits what it replaces first, like a restore in the History tab.

Change logs and commits are not part of `.bogen` files or design folders: those hold the design as it
is.
