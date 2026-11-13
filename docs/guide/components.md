# Components

A component is something you build once and use many times. Change the main, and every instance
follows, on every page, in every open editor and on your synced devices.

## Make a component

1. Build it once, as ordinary layers.
2. Select it and press Ctrl+Alt+K. It becomes the **main**, in place: it stays where it is, and you
   keep editing it like any layer.
3. Drag it from the Assets panel (Alt+3) onto the canvas to place an **instance**. The Assets panel
   shows rendered previews, search and variant sets. Double-click an asset to go to its main.

An instance is one linked layer. What is inside it is computed from the main, not copied, so a change
to the main reaches every instance at once.

Your agent does the same with `component_create` and `instance_create`, or with
`<x-instance component="Button" prop-label="Buy">` in the HTML it writes. Its guide tells it to
check the components of a file before it builds anything that repeats, and `design_lint` points at
structures it wrote twice.

## Change one instance

Select a layer inside an instance and change it. That is an **override**, on this instance only:

- text, style, image source, and hiding a child, also inside nested instances;
- the inspector lists the overrides of an instance, and resets one or all of them;
- two people changing different fields of one instance merge;
- each change is one undo step.

You cannot add or reorder layers inside an instance, except in a slot. For that, change the main,
add a prop or a slot, or detach the instance (Ctrl+Alt+B) to turn it into ordinary layers that no
longer follow the main.

Overriding an image source has been tried through MCP only, not with the mouse.

## Props

Props expose what varies, with controls in the inspector:

- **text** drives the words of a layer, such as a button label;
- **boolean** shows or hides a layer, such as an icon;
- **image** drives an image source.

A prop that is not set shows what the main shows, so editing the main keeps working.

## Variants

Mains with the same set name are variants of one component, such as a Button with
`size: sm | lg` and `state: default | hover`. On an instance, a variant is a control like a prop.
Switching variants keeps your overrides on layers of the same name.

## Slots

Mark a frame in the main as a slot. Each instance can then put its own layers in it: drop or paste
them in, or let your agent pass children. Slots of nested instances can be reached by path through
MCP only.

## Shared libraries

A file, or a [brand](brand.md), can offer its components to other files:

1. In the file with the components, choose **Publish** in the Assets panel.
2. In another file, choose **Link** in the Assets panel and pick the library. Place its components
   like your own.
3. When the library publishes a change, linked files show a banner. **Accept** takes the update as
   one undo step, and your overrides stay.

A file keeps a copy of what it uses from a library, so its instances render where the library is
missing: on another device, or after the library is gone. Pasting an instance into another file
keeps the link. Copies stay through commits, restores and design folders.

Limits:

- Change library components in the library's own file. Neither you nor an agent edits the copies.
- A duplicated library file publishes under the same name as the original.
- Code components inside a library component are dropped.
- Token changes in a library are not offered as updates.

Agents use `library_publish`, `library_link`, `library_updates` and `library_accept`.

## Component kits

A kit is a ready library of components for one design system, with:

- components with variants, props and slots, such as a Button with `variant` and `size`;
- tokens as CSS variables in the kit's own names, such as shadcn's `--primary` or Material's
  `--md-sys-color-primary`, with a light and a dark mode;
- for each component, how code uses it: the import, the component name and its props in that library.

Choose **Use** next to a kit under Kits in the Assets panel (Alt+3), or let your agent call `kit_list`
and `kit_use`; `template_list` lists the kits too. The first use on a device makes a file named after
the kit, such as "shadcn/ui kit", which publishes the components as a library. Its page is the kit's
showcase: every member of every component on a light board, and one instance of each on a dark one.
Using the kit links that library into your file and adds the tokens and the dark mode, as one undo
step. Place its components from Assets like any library component, and switch their variants in the
inspector.

| Kit | For | Components | Code it hands off to | Licence |
| --- | --- | --- | --- | --- |
| shadcn/ui | Web | 27, among them Button, Card, Dialog, Tabs, Table and the form controls | `@/components/ui/*`, as `npx shadcn add` writes them | MIT (shadcn) |
| shadcn/ui (Base UI) | Web | The same 27, drawn the same, with the same tokens | `@/components/ui/*` of a project made with `npx shadcn init --base base`, in Base UI's API | MIT (shadcn) |
| Radix Themes | Web | 18, with the Radix Colors scales in indigo and gray | `@radix-ui/themes` | MIT (WorkOS); Radix Colors MIT |
| Bootstrap 5 | Web | 17, in every theme colour | `react-bootstrap` | Bootstrap MIT (The Bootstrap Authors); React Bootstrap MIT |
| Material 3 | Phone, 412 wide | 19, among them the top app bar, navigation bar, FAB and chips | `@mui/material` | Material Design 3 Apache-2.0 (Google); MUI MIT; Roboto Apache-2.0 |
| Ionic, iOS mode | Phone, 393 wide | 14, among them grouped lists, the toolbar, the tab bar and the action sheet | `@ionic/react` | MIT (Drifty Co.) |
| Mantine | Web | 17, among them the segmented control, notification and nav link | `@mantine/core` | MIT (Vitaly Rtishchev) |
| Carbon | Web, dense | 16, among them a data table, the overflow menu, inline notifications and tiles, in the White and Gray 100 themes | `@carbon/react` | Apache-2.0 (IBM); IBM Plex OFL |
| USWDS | Web, public services | 16, among them alerts, the step indicator, the summary box and tile checkboxes; light only, as USWDS has no dark theme | markup with `usa-*` classes | Public domain and CC0-1.0 (GSA); Public Sans OFL |
| daisyUI | Web, Tailwind CSS | 16, among them stats, menu and navbar, in five styles of each colour | markup with daisyUI classes | MIT (Pouya Saadeghi) |
| Web Awesome | Web components | 17, among them the rating, slider, callout and details | markup with `wa-*` elements and their imports | MIT (Fonticons, Inc.), free package only |
| Pico CSS | Web, classless | 18, plain semantic HTML: buttons, forms, `article`, `details`, `dialog`, tables | the HTML itself, with Pico's stylesheet imported | MIT (Pico) |

Bogen draws every kit itself, from the public documentation and how the components behave, with no
source code copied. The token values are read from each library's published package. The iOS-mode kit
uses no assets, fonts or names of any platform vendor; its font is Inter. No kit ships a project's or
company's logo, and the USWDS kit has no government banner, flag or seal. Paid kits such as Tailwind
Plus and platform vendors' own UI kits are not included, and nor is anything whose licence is
unclear. [Licences](licences.md) says what may ship of each candidate system and why; the licences
are listed in `THIRD_PARTY_NOTICES.md` too.

**Markup kits.** daisyUI, USWDS, Pico CSS and Web Awesome are markup rather than React components, so
their code is the markup their docs write: `<button class="btn btn-primary">`, `<input aria-invalid="true">`,
`<wa-button variant="brand">` with `import "@awesome.me/webawesome/dist/components/button/button.js"`.
The variant classes join the component's own in one class attribute. In React it is JSX
(`className`, `htmlFor`, `defaultChecked`); in Vue, Svelte and HTML the same markup works as it is.
Your project loads the library's stylesheet (and for USWDS its script) as the library's docs say.

**Your brand on a kit.** The kit's tokens have roles such as primary, background, border, the body
font and the radius. `kit_use` with `from_brand` sets them from the file's [brand](brand.md), and
`theme` sets them by name, such as `{"primary": "var(--brand-blue)", "radius": "0px"}`. A brand colour
is one value for both modes unless you name a mode.

**In code.** Copy as code, `code_get` and the Code panel write a kit component as a usage of its
library rather than writing it out, with the variant values and text props in that library's names:

```tsx
import { Button } from "@/components/ui/button";

<Button variant="outline" size="sm">Save</Button>
```

**shadcn/ui on Radix or on Base UI.** `shadcn init` makes a project on Radix (`--base radix`) or on Base
UI (`--base base`, what `--defaults` picks). The components have the same names and files, but some
props differ, so there is a kit for each. Use the one your project's `components.json` names: a
`style` that starts with `base-` is Base UI. On Base UI, a trigger takes another element through
`render` instead of `asChild`, as in `<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>`,
and an accordion's open items are a list, `defaultValue={["item-1"]}`. On Radix, a Tooltip comes
inside a `TooltipProvider`, which Radix needs.

Every member of both kits was handed off into a real project of its base, made with
`npx shadcn@4.23.0 init -t vite -p nova` and `shadcn add` of all 27 components: the code type-checks
in strict mode, builds with Vite and renders in Chromium without an error, and the kit's tokens are the
light and dark values that `init` writes. The drawings follow shadcn's classic look (Inter, 36 pixel
controls), closest to its Vega style. The newer styles that `init` offers (Nova, Maia, Lyra, Mira and
the rest) have other sizes, radii and fonts, and have no kit of their own.

A component of your own can say which code component it stands for in the same way, with
`component_update` and `handoff: {from, name, props}`.

**A kit from your repository.** With a [code project](#code-components-from-your-repo) linked,
`kit_use` with `from_code: true` makes a kit of its React components: their enum props, such as cva's
`variant` and `size`, become variant axes, each member is rendered by your own code, and the handoff is
the component's own import. It is built onto a page of your file, as a library cannot hold code
components. Kits made elsewhere, such as from a Storybook, register with the server the same way
(`registerKit` in `packages/server/src/kits/index.ts`).

Limits: the kits draw closed states only, so a dialog, a menu or a select shows open as a static
picture, and overlays do not open in the preview. Usages with several parts are templates, so a Select
always lists the same two items in code. Icons in the drawings are Lucide; in code, Material uses
`@mui/icons-material` and shadcn and Mantine `lucide-react`. A markup kit's variant can add one
attribute, so an error state marks the input and not its group (USWDS's `usa-form-group--error`), and
some states only show after input in the real library, such as Web Awesome's invalid field. A newer version of a kit in a later Bogen comes as a
new library file, and files keep the version they linked.

## Code components from your repo

Place components from your own React project on the canvas, rendered by the project's own code and
CSS:

1. Link the project folder in the Assets panel (or your agent calls `code_project_link`). The link is
   per device; Bogen keeps only an id in the file.
2. Bogen lists the project's React components, with props read from their TypeScript source: unions,
   booleans, defaults, cva variants and element props.
3. Place one. It renders in a sandboxed frame with no network and its own origin, with the project's
   Tailwind 4 CSS. Change its props in the inspector, or your agent uses `code_component_update`. It
   is measured to fit.
4. Screenshots and PNG exports show it. JSX and `code_get` write it as a usage with its import, such
   as `<Button variant="ghost">Save</Button>`.

Limits: React only, with Tailwind 4. Tailwind JS plugins and config files are skipped, and classes
that appear only in prop values are not generated. HTML export keeps the frame's URL, and SVG export
falls back to HTML for it. A checkout at another path on another device needs linking again. It has
been tried with a Vite, React and Tailwind 4 project, not yet with a real shadcn repository.

### A code component as a main

A main can itself be a code component. Every instance then shows that component, and a prop can
drive one of its props: a prop that targets `code.tone` on the main sets `tone` on the component.
`code_get` writes such an instance as a usage of your own component with its import, not as a
component Bogen writes around it.

### Storybook stories

If the project has Storybook stories, choose **Import stories** under Storybook in the Assets panel,
or your agent calls `storybook_import`:

- Each component with stories becomes a variant set on a page called Storybook, in a frame of its
  own, with one main per story. The variant is called `story`, such as `story: Primary`.
- Each main is a code component with the story's args as its props, rendered by the project's own
  build as above.
- The meta's `argTypes` and the args become the set's props: a select or radio control is a
  variant, a boolean control a switch, a string a text prop. Each drives the component's own prop.
  Numbers and objects stay as each story has them. Functions such as `fn()`, JSX and values from
  elsewhere are left to the component's own defaults.
- Place a story like any component, then switch stories or change its props on the instance.

Stories are read as text and never run: CSF 3 objects with `args`, `argTypes` and `name`, a meta
given by name with `satisfies Meta`, CSF 2 with `Template.bind({})`, `.args` and `.storyName`, and
`excludeStories`. A story file whose component cannot be found is listed with its reason.

While the file is open, Bogen keeps the sets in step with the story files: changed args reach the
mains and their instances, a new story becomes a new main, and a story that is gone goes too, unless
an instance uses it. Then it stays, marked as gone from Storybook. **Import again** does the same by
hand.

Limits: stories whose args are made in code, decorators, loaders and `render` functions are not
followed; the story shows the component with the args Bogen could read. Tried with a fixture
project with CSF 2 and 3 stories, not yet with a real Storybook.

## Sizes and older devices

One main edit with 500 instances on a page updates them in tens of milliseconds. Nesting stops at 8
levels, and a component that contains itself stops there too.

A paired device that runs an older build keeps the component data, and shows an instance as an empty
frame of its own. That follows from how the data is stored; it has not been tried with an older build.
