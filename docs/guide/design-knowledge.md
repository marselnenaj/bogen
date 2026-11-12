# Design playbooks and verification

Bogen includes its own design operating guidance, written for agents and directly usable without web research or external reading. Open **Settings → Design knowledge** to choose a playbook, search its decisions, browse compositions, edit your own `SKILL.md` or download it. [Settings](settings.md) shows the exact controls. Reference content is English; this does not change the language requested for a design.

There are 16 playbooks, 128 conditional decisions and 32 composition briefs: visual foundations, websites, mobile apps, desktop workspaces, forms, commerce, dashboards, pitch decks, social graphics, email, documentation, brands, motion, localization, OS themes and sidebar widgets. The content is authored guidance, not a claim of empirical proof, conversion uplift or an automatic taste score.

## What an agent reads first

Every skill opens with the same two short parts, before the decisions of its discipline, because an
agent follows the start of a long text best.

The **quality bar** says what decides whether work is accepted, with numbers: one message and one
primary action per screen, and two or three loud peaks on a long page; at most two font families and
five or six sizes from one declared scale; one spacing scale, with section gaps at least twice the gaps
inside a section; neutrals and one accent; the real product shown; copy from the customer's side with
nothing invented; neither the generated look (grotesk plus mono, glow, cards around everything, dot
grids, tilt, gradient text) nor its overcorrection (warm beige, a serif, forest green); the agent
decides and gives its reason instead of handing choices back; and nothing clipped, covered or too small
at the size the piece is really seen.

The **work loop** has six steps: brief and point of view (audience, the one carrying idea, the one
action, two or three real references of the class); the type scale, spacing scale and colours as tokens
before any screen; one section at a time with a screenshot after each; the real sizes; a review of the
whole artboard with `design_lint` and `design_review`; then the scored rubric, a repair of the lowest
criterion, and `design_verify`.

The MCP server instructions carry the same loop in five lines, at the same size as before.

## A working contract for the agent

Each playbook contains:

- Brief inputs that matter for that discipline. Read the request and existing work first; ask only if a missing answer blocks the task.
- Decisions in **WHEN / DO / CHECK / REPAIR / EXCEPTION** form. They change what the agent does and give it a concrete recovery path.
- Relevant states and deliverables, considered only when the actual task needs them.
- Three visual-review questions: priority, content and context.
- Alternative composition briefs. These are choices for the subject and medium, not a mandatory page skeleton.

The shared workflow is inspect, choose information order and states, build a representative part, adapt, inspect and measure, then repair the highest-impact failure. A finding identifies its priority, layer, observation, impact, specific change and recheck. A blocked task takes precedence over missing states, hierarchy and local visual polish.

Confirmed brand rules and the person’s brief override heuristic defaults. A redo stays in the existing file’s revision or branch; a new page or file needs an actual new deliverable. An agent must not invent product features, testimonials, numbers, URLs, platform support or verification results. Only the person accepts proposals and resolves threads.

## Automatic guidance for built-in runs

Before a built-in canvas run starts, the server supplies **one effective skill** in the runner's actual instructions. This includes a saved personal override. Selection uses a clear discipline in the request first, then the selected screen's recorded profile, then the file's declared kind. Ambiguous work starts with foundations; the agent can load a different relevant discipline when needed. The server does not attach all 16 skills or traverse the entire canvas.

This preparation is shared by prompt, comment, race and remote-host canvas runs, and supplies the current saved text again for a later run. Run details identify the delivered discipline, revision and Original/Custom status. This records what Bogen provided, not proof of what the model understood or whether its design is good. Repository Live runs keep their own repository instructions.

The built-in runner's provider receives this guidance along with the request, just as it receives screenshots and other tool results. Bogen adds no separate AI service or API key. [Privacy](privacy.md) describes the data flows.

## External agents and progressive loading

```text
design_knowledge action=catalog
design_knowledge action=playbook discipline=desktop-apps
design_knowledge action=rules discipline=desktop-apps query=panel
design_knowledge action=recipes discipline=desktop-apps
design_knowledge action=skill discipline=desktop-apps
design_knowledge action=original discipline=desktop-apps
design_knowledge action=rubric
design_knowledge action=style id=mono-decoration
```

An external MCP client receives Bogen's instructions and tools. It must still follow them: Bogen cannot force an independent client's reasoning or future tool calls. Re-run `bogen install claude-code` or `bogen install codex` after an upgrade to refresh Bogen's managed integration skill, then start a new client session. A skill file without Bogen's managed marker is left alone.

Load one relevant skill with `action=skill`, or use the one already supplied to a built-in run; `action=playbook` returns the same decisions as structured data together with that skill, at more than twice the size. Add another only for a real secondary deliverable. The playbook response includes the effective `skill.markdown`; personal instructions supersede conflicting shipped style defaults. `rules` provides searchable decisions and `recipes` alternative compositions. `skill` returns the effective Markdown and revision; `original` returns the unchanged shipped version.

The old `sources` action remains only for clients explicitly requesting historical references. It is not a dependency of current playbooks, skills or design runs.

## Personal skills

Choose a discipline under Settings → Design knowledge and click **Edit SKILL.md**. Saved overrides live at `$BOGEN_HOME/design-knowledge/<discipline>/SKILL.md`. Local users or their agents can also edit that text file directly. The next read sees the changed text. App upgrades preserve these files.

An agent can read `action: skill`, then call `design_knowledge_update` with the current revision, a reason and either complete Markdown or exact, unambiguous text replacements. `action: restore` removes the override and returns to the shipped original. Previous complete contents, actor and reason are backed up in that discipline's `history/` directory before a change. A stale revision is rejected instead of overwriting somebody else's changes. The editor keeps the draft for comparison.

Persist clear lasting preferences or repeated corrections, preserve unrelated guidance and tell the person what changed. A one-off project exception stays in its brief. Current explicit user instructions win over saved style guidance. Personal rules apply across that discipline on this host and are **not automatically synced**. Editing guidance cannot grant tool permissions, accept a proposal, resolve a thread or disable the server's completion checks.

## Anti-slop preferences

The shared guidance contains 41 authored style rules with alternatives and checks, grouped as hierarchy, type, surface, decoration, copy and proof, and direction. A skill names them by id; `design_knowledge action=style id=<id>` returns one with its replacement and check. Among them: avoid decorative glowing dots, unrequested sidebar skeletons, repeated kicker/headline/slogan copy, automatic neon or gradient styling, identical feature cards, empty bento boxes, fake proof, generic buzzwords and tiny unreadable supporting text. Use the content, task and confirmed identity to make a specific composition. These are contextual working preferences, not a scientific detector of AI authorship. A requested sidebar widget, print texture or deliberate art direction has a reason of its own.

## Craft checks

`design_lint` reports these per artboard as `craft` issues, with the check in `check` and the rubric
criterion it counts against in `criterion`. `design_review` reports the same findings with their rule
id, and needs no browser. Each is a warning to weigh against the brief and the brand, with a line that
can be tested:

| Check | Fires when |
| --- | --- |
| `font-families` | more than two named font families on one artboard |
| `decorative-mono` | two or more texts in a monospace face that are not code, a command or figures |
| `type-scale` | a literal size within 8% of a step of the file's type scale (three or more font-size tokens) without being on it |
| `loud-type` | more than three texts at 85% or more of the largest size, when that is 28px or more |
| `heavy-type` | more than two thirds of the words in weight 600 or heavier, from eight texts up |
| `all-caps` | three or more texts in capitals, or one longer than 30 characters; an acronym does not count |
| `eyebrow` | two or more headings with a label of 14px or less directly above them |
| `centred` | more than 70% of the texts centred, from six texts up |
| `primary-actions` | two links or buttons with different labels and the same fill inside one section |
| `boxes` | six or more bordered or shadowed boxes that are more than half of all groups |
| `nested-boxes` | two or more boxes inside another box |
| `glow` | a shadow with 8px blur or more in a saturated colour |
| `tilt` | a layer with words or a picture rotated by 0.5 to 30 degrees |
| `window-chrome` | exactly three round dots of 16px or less in a row |
| `pattern-background` | a gradient repeated as a tile of 64px or less, or a repeating radial gradient |
| `default-gradient` | a gradient whose saturated stops all lie between blue and pink, with a violet one and one that is not |
| `gradient-text` | text filled with a gradient |
| `text-on-image` | text over a background image or a picture laid behind it, with no scrim, panel or text shadow between |
| `viewing-size` | text under 9px where a social image (seen at 390px) or a slide (seen at 960px) is really seen; what the board or file declares decides, and the size is a guess only where nothing is declared |

`type-scale` is exact on purpose: a size within half a pixel of a step is on it, and 17px beside an 18px
token is a slip, not a nuance. The token costs nothing to use and keeps the scale one scale.

### What the checks read as something other than a page

Each of these follows an explicit marker or a declared kind, never a size, a name or a guess:

- **Counter-examples.** A frame a template marks `data-brand-example="dont"`, such as the brand
  system's wrong logo uses or the words to avoid, is wrong on purpose. Every check leaves it out, as
  `brand_check` does.
- **Specimens.** A frame marked `data-brand-example="specimen"` documents parts: every button variant,
  a field in a form card, each step of the type scale, a typeface's character set. Inside it,
  `primary-actions`, `boxes`, `nested-boxes`, `loud-type` and the count of font sizes do not count, and
  the copy check reads its words but not its punctuation and glyphs. Every other rule holds, and
  `brand_check` checks it as usual. Only templates write either mark: `html_write` and `layer_attrs`
  drop it, so an agent cannot exempt its own work.
- **Omarchy theme files.** A file that says it is an Omarchy theme previews the system's own screens,
  in its interface font, at the sizes its configuration sets. There `decorative-mono` is not checked,
  `design_review` asks for no h1 and no 4px grid and reads an app grid or gradient wallpapers as the
  system's, `design_lint` leaves out its grid rule, and the copy check reads the words but not key
  glyphs, status marks or terminal punctuation. A board's declared kind, a template's discipline or
  the theme, also decides `viewing-size`, so a 1080 x 1920 portrait monitor is not a story.

Some readings hold in every file. A text made only of private-use characters (a Nerd Font or logo
glyph) is an icon, not a type family. A file name or a link is a name, so "unlock" in `unlock.png` is
not hype. A question heading followed by its answer beside other such questions, as in an FAQ, is a
question a reader asks, not a rhetorical headline. A colour written as `var(--ink, #1d1b19)` is the
token, not a colour typed in, and sizes are read through a fallback where the file has no such token.
Spacing rhythm compares siblings of the same type, tag, component and layout (flex row, flex column,
grid of as many columns, or flow), so a two-column block is not held to the gap of a stack beside it.

They read styles, not pixels. They cannot see a picture's content, judge whether a product view is
real, or tell that a composition is lifeless: those stay with the rubric and with you.

## The rubric

Before it reports, an agent scores eight criteria from 1 to 5, each with what it sees in a fresh
screenshot as evidence: hierarchy, type, spacing, colour, content, craft, originality and fit.
`design_knowledge action=rubric` returns the questions and what a 5 and a 2 look like, and
`design_verify` returns them for whatever is still open.

The scores are passed as `rubric` to `design_verify`, and count as scored only when:

- all eight criteria have one score with evidence of 24 characters or more;
- none is 2 or lower;
- none is above 3 while measured findings stand against that criterion. An agent either fixes the
  findings or scores 3 and names the exception.

Under 32 of 40 the result says the work is adequate rather than strong, and asks for a repair of the
two lowest criteria or a second direction to compare. That is advice, not a block.

A built-in run does not complete until the rubric is scored. The scores are the agent's own
assessment: they are not a person's approval and not a measure of taste. The cap is what ties them to
something measured.

## Measured checks and repair

After the last edit, capture the complete affected artboard with `canvas_screenshot` and call `design_verify` for each affected artboard. Supply concrete observations for priority, content and context, and the scored rubric. Visual observations and scores are the agent’s self-assessment, separate from measured failures and the person’s decision.

The built-in completion gate checks affected work and requests corrections for measured errors, missing fresh inspection, incomplete review or a rubric that is not scored. It allows **at most two additional repair turns** with the chosen agent. A question without changes, read-only critique or live repository run does not enter this loop. A non-repairable environment failure stops without spending extra turns. Unresolved findings remain explicit. External standalone clients cannot be forced to keep running.

Checks are bounded to at most 1600 layers per reviewed artboard, four changed files per run, four newly measured artboards per file and automatic pass, and 200 retained reports/screenshots. A large file is not rendered in full to review one change. Rendering failures, memory pressure and unsupported scope stay unverified. Never disable a browser sandbox to obtain passing evidence.

Interactive/responsive work gets applicable accessibility and 320/768/1440 CSS-pixel layout probes. Fixed-format decks, social artwork, brand sheets, themes and storyboards stay at their intended format. A portrait theme needs an intentional composition, not an automatic landscape crop. The themes playbook does not invent an installation contract or authorize changes to an unrelated integration. Widgets describe host constraints, extension boundaries and honest data states; a design is not a working plugin SDK.

Measured checks do not establish complete accessibility conformance, native runtime behavior, real email-client compatibility, payment or legal compliance, factual data quality or artistic merit. State what was actually tested.

## Maintaining the guidance

`packages/server/src/design-knowledge/playbooks.ts` is the authored source for decisions, brief inputs, states and the shared workflow. Browsable rules and exported skills derive from it. The quality bar and work loop are `DESIGN_WORKFLOW.bar` and `.sequence` in the same file, the rubric lives in `rubric.ts`, and the craft checks in `packages/core/src/design-craft.ts` with their limits in `CRAFT_LIMITS`. Recipes live in `recipes.ts` and retain original Bogen compositions. Tests hold the size of the instructions and of each skill, so an addition has to pay for itself. An addition should improve a concrete decision or recovery path, rather than repeat generic advice. Preserve explicit user scope and authorization boundaries. Update the knowledge version when decisions change; existing design documents are not migrated just because the playbook changes.
