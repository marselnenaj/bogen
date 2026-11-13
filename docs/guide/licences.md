# Licences of kits, icons and export targets

What Bogen may ship of other people's design systems, icon sets and frameworks, and what it may not.
Bogen is GPL-3.0-or-later. It re-draws a design system's components in its own markup, ships the
system's token values as CSS variables, and ships icons as SVG data. Code it hands off imports the
real library, which the person installs under that library's own licence.

Checked on 13 November 2026 from the published packages (`npm pack`, the licence file inside) and the
projects' own licence, brand and trademark pages. Where a line says *not verified*, the source could
not be read and Bogen does not rely on it.

## How to read it

- **Tokens**: the colour, radius and font values, under the system's own variable names.
- **Drawing**: Bogen's own markup with inline styles, drawn from the public docs. No source copied.
- **Icons**: the SVG path data, in `packages/core/src/icon-sets/`.
- A code licence covers code. None grants rights to a name or a logo (Apache-2.0 says so in its
  section 6). Bogen names a system only to say which library the code is for, as in "Carbon" or
  "Ionic (iOS mode)", and ships no project's or company's logo. No kit says or suggests that its
  project endorses Bogen.
- A font name in a font stack, such as `"Segoe UI"`, is a name. Restricted font files are never
  shipped.

## Design systems and component libraries

| System | Package checked | Code | Ships in Bogen | Why, and what not |
| --- | --- | --- | --- | --- |
| Mantine | @mantine/core 9.8.0 | MIT | Yes: kit `mantine` | MIT, no brand rules found. Handoff to `@mantine/core`. |
| Carbon | @carbon/react 1.120.0, @carbon/styles 1.119.0, @carbon/themes 11.85.0 | Apache-2.0 | Yes: kit `carbon` | Tokens from the White and Gray 100 themes. IBM Plex is OFL-1.1 with "Plex" as reserved name: the name is used, the font is not changed or shipped. No IBM logo: IBM allows its logos only with written permission (ibm.com/legal/copytrade). |
| USWDS | @uswds/uswds 3.14.0 | Public domain in the US, CC0-1.0 worldwide; fonts OFL, icons Apache-2.0 | Yes: kit `uswds` | CC0 asks not to imply endorsement, and the ".gov" banner is only for government sites: the kit has no banner, flag or seal and says it is not a government service. Public Sans is OFL. |
| daisyUI | daisyui 5.8.0 | MIT | Yes: kit `daisyui` | MIT, no brand page found. The paid Figma library and the logo are not used. Handoff is markup with its classes. |
| Web Awesome | @awesome.me/webawesome 3.14.0 (free) | MIT | Yes: kit `web-awesome` | Free package only. "Web Awesome" is a trademark of Fonticons, Inc., used only to name the library. Pro themes, components and Font Awesome icons are not used (Pro terms forbid sharing Pro assets). |
| Pico CSS | @picocss/pico 2.1.1 | MIT; docs CC BY-SA 4.0 | Yes: kit `pico` | Its brand page allows the name in open source, non-commercial projects and forbids the logo. Bogen is open source; the name only says which library the code is for, no logo, and "Pico" is in no name of a Bogen product. |
| Shoelace | @shoelace-style/shoelace 2.20.1 | MIT | Allowed, not built | Superseded by Web Awesome. Its bundled icons are Bootstrap Icons, *not verified* here. |
| Ant Design | antd 6.7.0 | MIT | Allowed, not built yet | MIT, no brand page found. Its icon package was not checked. |
| Fluent 2 | @fluentui/react-components 9.75.2 | MIT | Allowed, not built yet | Code MIT, but Segoe UI, the Office and Fabric icons fall under the Microsoft Fabric Assets License, only for apps that use a Microsoft service: none of those may ship. Fluent UI System Icons are MIT. |
| Primer | @primer/react 38.45.0, @primer/primitives 11.10.0 | MIT | Allowed, not built yet | GitHub's logo policy forbids its marks as a project's logo or in a way that suggests endorsement: Octicons ship only without `mark-github`, no Octocat. |
| GOV.UK Frontend | govuk-frontend 6.6.0 | MIT; docs Crown copyright, OGL 3.0 | Allowed with care, not built | Outside GOV.UK a service must not use the crown, the GOV.UK logotype or the GDS Transport font, which the package bundles: a kit would draw it with the Arial fallback and no crest, for GOV.UK teams. |
| Chakra UI | @chakra-ui/react 3.38.0 | MIT | Allowed, not built yet | MIT, no brand page found. |
| Park UI | @park-ui/panda-preset 0.43.1 | MIT | Allowed, not built yet | MIT in the repository; the tarball has no licence file. |
| HeroUI | @heroui/react 3.2.7 | Apache-2.0 (v3 tarball; v2 and the repository say MIT) | Allowed, not built yet | The licences disagree between versions; follow the package's own. HeroUI Pro is paid and not used. |
| Flowbite (core) | flowbite 4.0.2 | MIT | Allowed, core only | The name and logos are Bergside's trademarks. Flowbite Pro is under its own EULA, which could not be read, and the Figma kits are unclear: neither is used. |
| Open Props | open-props 1.7.23 | MIT | Allowed, not built yet | Tokens only, no components. |

## Icon sets

| Set | Package checked | Licence | Ships | Icons and bytes in Bogen |
| --- | --- | --- | --- | --- |
| Lucide | lucide-react (already shipped) | ISC, with an MIT part for the icons from Feather | Yes, the default | 2015 icons, 418,415 bytes (`icons-data.json`) |
| Phosphor (regular) | @phosphor-icons/core 2.1.1 | MIT | Yes: `phosphor:` | 1434 icons, 618,540 bytes. The 79 `*-logo` icons are other companies' marks and are left out. |
| Tabler Icons (outline) | @tabler/icons 3.51.0 | MIT | Yes: `tabler:` | 4855 icons, 1,125,002 bytes. The 378 `brand-*` icons are left out. |
| Heroicons (24 outline, 24 solid) | heroicons 2.2.0 | MIT (Tailwind Labs) | Yes: `heroicons:`, `heroicons-solid:` | 324 + 324 icons, 110,631 + 165,475 bytes. This is not Tailwind Plus. |
| Material Symbols (outlined, weight 400) | @material-symbols/svg-400 0.49.0 | Apache-2.0 | Yes: `material-symbols:` | 3945 icons, 1,785,860 bytes; the filled variants are left out for size. |
| Remix Icon | remixicon 4.9.1 | Remix Icon License v1.0 (from 4.9.0, January 2026; its package.json still says Apache-2.0) | **No** | It forbids using the icons as a logo or brand mark and in "a competing icon library or icon set", and says it may not suit copyleft projects. A design tool cannot keep people from drawing logos with it, and an icon picker could read as an icon set. 4.8.0 was Apache-2.0, but a frozen old set is not worth it. |
| Fluent UI System Icons | @fluentui/react-icons 2.0.345 | MIT | Allowed, not added yet | |
| Octicons | @primer/octicons 19.42.0 | MIT | Allowed without `mark-github`, not added yet | |
| Carbon icons | @carbon/icons 11.92.0 | Apache-2.0 (from npm metadata, *not verified* from the file) | Not until verified | |

The five new sets add 3,805,508 bytes of JSON (1,044,014 gzipped). They are data files next to the CLI
(`dist/icon-sets/` in the installed package), not part of its bundle, and the server reads a set the
first time a search or an insert asks for it. `BOGEN_ICON_SETS_DIR` points at another folder of them. The
editor's icon picker still loads only Lucide.

## Export targets

| Target | What Bogen writes | Licence question |
| --- | --- | --- |
| Vue 3 SFC | `.vue` files with `<script setup lang="ts">` | Vue is MIT. The code Bogen writes is the person's, under LICENSE-EXCEPTION.md. `@vue/compiler-sfc` (MIT) is a test-only dependency. |
| Svelte 5 | `.svelte` files with runes | Svelte is MIT. `svelte` (MIT) is a test-only dependency. |
| SwiftUI | `.swift` files for iOS 17 and macOS 14 | SwiftUI is Apple's framework, which the person's Xcode provides. Bogen ships nothing of Apple's: no SF Symbols, no SF fonts, no Apple Design Resources. Icons are written as the set's SVGs for the asset catalog. |
| Jetpack Compose | not yet | Compose is Apache-2.0. Material Symbols map onto `Icons.Outlined`. |

## Must not use

| What | Why |
| --- | --- |
| Tailwind Plus (Tailwind UI) | Paid. Its licence page is behind a login; the FAQ says the components may not be repackaged into other component libraries or builders. Nothing of it is a source for Bogen. |
| Untitled UI (paid) | Forbids making "a UI kit, library, theme, template, design system" with it, and builders that include it, even modified (untitledui.com/license). |
| Apple Design Resources | Only for mock-ups of interfaces that run on Apple's platforms, and may not be embedded in other software (licence of 21 June 2023). |
| SF Symbols, SF fonts | Not for logos or trademarked use, symbols of Apple products cannot be changed, and the fonts have their own licence. The iOS-mode kit uses Inter and Lucide instead. |
| Segoe UI, GDS Transport, the GOV.UK crown | Restricted fonts and marks; see the rows above. |
| Logos of companies in any icon set | Trademarks, which no icon licence grants. |
| Pro or paid tiers: Web Awesome Pro, HeroUI Pro, Flowbite Pro and its Figma kits | Paid, or terms that could not be read. |
| Remix Icon 4.9.0 and later | See the icon table. |
| Anything whose terms are unclear | Left out until they are clear. |

See also [Components](components.md) for the kits, [Export and code](export-and-code.md) for the
targets, and `THIRD_PARTY_NOTICES.md` and `ASSET_PROVENANCE.md` for what ships.
