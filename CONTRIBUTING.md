# Contributing

Issues and pull requests are welcome. Larger changes are best discussed in an issue first.

[docs/architecture.md](docs/architecture.md) explains how the packages fit together, how a document is stored, who
may do what on which listener, and how to add an MCP tool. [docs/SPEC.md](docs/SPEC.md) has the feature matrix and
the contracts between the packages. Please follow the [code of conduct](CODE_OF_CONDUCT.md).

## Good places to start

- An item marked `[~]` (partly there) in the [feature matrix](docs/SPEC.md#feature-matrix): its note says what is
  missing.
- Something the guides say has not been tried for real, such as `bogen install` for Cursor, VS Code, OpenCode, Gemini
  CLI or Zed, or the phone app on an iPad or an Android phone. A report of what happened is a contribution too.
- A clearer error message, or a guide that left you guessing.
- A test for something that has only been checked by hand.

Everything except the agent runs works without a Claude or Codex login. Tests use stand-in CLIs.

## Build and test

You need Node 22.18 or newer and Chromium. From a fresh clone:

```sh
git clone https://github.com/marselnenaj/bogen.git
cd bogen
npm install
npm run build
npm test
npm run typecheck
```

`node packages/server/dist/cli.js` is then the `bogen` command. To work on the editor with hot reload, run a server
from source on a spare port with a temporary data folder, so your own files stay out of it; [building](docs/building.md#develop)
shows how. On the development host, `npm test` takes about 31 s and the typecheck about 9 s.

Before a pull request, also run:

```sh
npm run check:docs
```

It checks that the [MCP tool reference](docs/guide/reference/mcp-tools.md) matches what the server lists, that every
relative link and anchor in the Markdown resolves, and that [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) matches
the lock file. After a change to a tool, run `npx tsx scripts/gen-docs-reference.ts`; after a change to the
dependencies, `node scripts/gen-third-party-notices.mjs`.

For a change you can see in the editor, run the browser suite that covers it. [docs/building.md](docs/building.md)
lists them, with the other build, test and packaging commands.

## Pull requests

- One topic per pull request, on a branch from `main`.
- The subject line says what changes for the user or the agent, as a plain statement; the body says why and what was
  run.
- Add a line to [the changelog](docs/guide/changelog.md) for anything a user or an agent notices.
- Update the guide page the change belongs to, and the [feature matrix](docs/SPEC.md#feature-matrix) if it moves an item.
- Run the checks above locally. CI (`.github/workflows/ci.yml`) runs the source hygiene check, the typecheck, the
  build, `npm run check:docs` and part of the test suite on every pull request; it runs no browser suites, so say
  in the pull request what else you ran.

## Rules for changes

- **Clean room.** Never read, copy or derive from the Paper Desktop app or its bundles, or any reverse
  engineered clone of a design tool, and do not link to them. Use public documentation, web standards
  and permissively licensed packages. Bogen keeps its own tool names, schemas and messages. See the
  [spec](docs/SPEC.md#clean-room-rule).
- **Honest claims.** A claim in the documentation states what was measured or run. When something was tried only
  against a stand-in, or not at all, the page says so.
- **Additive documents.** New document fields are additive, so that an older build can open a newer file and keep what
  it does not understand. Sync between devices on different builds depends on it.
- **Nothing in a document starts a process.** Comments, brands and files from other devices, from agents or from
  imports must never start a run or a program.
- **Content is not trusted.** HTML, CSS, SVG and rules that reach a style element are checked where they are rendered,
  not only where they come in. See [SECURITY.md](SECURITY.md).
- **Tools are written for a model.** A new MCP tool says what it is for and when to use it, and its errors say what to
  do next.
- **New dependencies** need a license that is compatible with the GNU GPL, version 3 or later (MIT, BSD, ISC, Apache-2.0 and MPL-2.0
  are; GPL-2.0-only is not); the notices list it after you
  regenerate them.

By contributing you agree that your contribution is licensed under the licence of the files you change: the GNU General
Public License, version 3 or later, including the project's [exception for exported work](LICENSE-EXCEPTION.md), or the
MIT licence for files under `integrations/omarchy/plugin` and `integrations/omarchy/portrait-background`. You also
certify the [Developer Certificate of Origin 1.1](https://developercertificate.org): add a `Signed-off-by` line to each
commit (`git commit -s`). Do not contribute code written by an AI tool from sources you cannot name, or code you copied
from a project under an incompatible licence.
