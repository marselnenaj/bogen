# Canvas organization for agent-created screens

Organize by what the person is trying to do. Geometry follows that structure.

## The hierarchy

- File: one product, site, brand or theme, with alternatives inside its branches.
- Page: a substantially different area or deliverable, when a single canvas becomes difficult to navigate.
- Section: a named task, journey or exploration, with one sentence explaining its purpose.
- Lane: an ordered main path, error states, responsive variants or alternatives within that section.
- Screen: a concrete state, with a meaningful name. Use a label such as “Verify email” rather than “Screen 3”.

Section titles, lane labels and flow connections are editing annotations. They do not become text layers in exported screens. The canvas map focuses a section without changing its contents.

## Plan, draw, arrange, review

1. Read `canvas_plan_get` and the existing page. Preserve the person's organization.
2. Decide the tasks and state groups before drawing multiple screens. `canvas_plan_set` accepts empty named lanes, so the plan can exist first.
3. Supply `section_id` and `lane_title` to `artboard_create` to attach each new screen to the plan immediately. The tool uses an existing, uniquely named lane; it never invents a generic section name for the agent.
4. Fill the screens, then inspect actual bounds. A grouping is marked `layout_pending` until `canvas_plan_set` reflows it. Preview with `dry_run`, send the current revision token and apply. Do not fix a hugging screen's height merely to arrange it.
5. Review the headings, transitions and gaps at a readable overview zoom. Keep genuine alternatives and responsive versions near their canonical screen. Draw connectors only for actual journeys; arrows are not decoration and do not create prototype interactions.

For built-in runs, the server snapshots the existing screens at launch. If the run creates at least three screens on one page, completion checks require those touched new screens to belong to a plan with a finished arrangement. Missing structure triggers the existing bounded repair loop, at most two turns. Unchanged pre-existing screens and screens created by another session but not touched by this run do not trigger this requirement. The server does not automatically move any design to satisfy the check.

External MCP clients receive the same planning tools and guidance. Bogen does not control when an external coding agent ends its own conversation, so it cannot enforce that client's final turn in the same way. Structured metadata and visible annotations are shared by both paths.

## Recipes

For an app, use separate task sections such as Create account, Find an item and Complete a purchase. Within a section, put the main path in reading order; give recovery states a lane of their own and name the transition that leads there. Keep desktop/mobile variants beside the state they represent.

For a website, group the canonical pages by visitor goal. Keep responsive versions and alternative hero directions local to the relevant page. A long page remains one hugging screen; do not create new pages or files to represent every edit.

For a deck, use chapters as sections and preserve slide order within each chapter. For a theme, distinguish environment previews, palette work and artwork, with landscape/portrait variants named explicitly. For a gallery of independent assets, a labeled grid can be the correct composition. A single grid should not replace the information architecture of an app flow.

## Reference points

[Figma sections](https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections) provide labeled canvas areas for related work. [Penpot flows](https://help.penpot.dev/user-guide/prototyping-testing/prototyping/) distinguish starting points and connected screen journeys. These public product descriptions informed the distinction between spatial grouping and actual navigation; no implementation code was consulted. Bogen keeps its existing layer hierarchy and represents organization as document metadata.
