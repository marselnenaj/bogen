# Building and testing

For people changing Bogen. To only use it, [getting started](guide/getting-started.md) is enough. How the code is
laid out is in [architecture](architecture.md).

## Requirements

- **Node 22.18 or newer** (`engines` in `package.json`; `bogen doctor` checks it too) and npm.
- **Chromium** for the render tests and the browser suites. The browser suites launch `/usr/bin/chromium`; the server
  finds any Chromium-based browser, or the one `BOGEN_BROWSER` names.
- Optional: **ffmpeg** and **ffprobe** for the video and AVIF tests, and `xmllint` for an SVG check. Tests that need
  one of them and do not find it skip that part.

## Build

```sh
npm install
npm run build
```

`npm run build` builds the editor with Vite into `apps/editor/dist`, then bundles the server with esbuild
(`packages/server/scripts/build.mjs`) into `packages/server/dist`:

| File | What it is |
| --- | --- |
| `dist/cli.js` | The whole `bogen` command and server in one file. `puppeteer-core` and `esbuild` stay outside, as npm dependencies. |
| `dist/shader-runtime.js` | The script that draws shader layers in headless renders. |
| `dist/editor/` | A copy of the built editor, which the server serves. |
| `dist/omarchy-collection/` | The Bogen collection's wallpapers, copied from `packages/server/assets/omarchy-collection/`, so a packaged CLI can offer the desktop presets offline. |

The build stamps a build id into the version: the short commit, plus a hash when there are uncommitted changes, such as
`0.1.0+66d2d79`. `bogen status`, `bogen doctor`, paired devices and the editor use it to say when two builds differ.
`BOGEN_DIST_DIR` builds elsewhere and leaves `packages/server/dist` alone.

Then `node packages/server/dist/cli.js` is the `bogen` command. After a rebuild, restart a running server:
`bogen stop && bogen start`, or `systemctl --user restart bogen` with the user service.

The runtime package pins its direct dependencies and includes a runtime-only `npm-shrinkwrap.json` from the same reviewed repository lock used for notices and the SBOM. It does not resolve a different dependency tree at packing time. CI repeats source hygiene, type/build/doc checks, core/editor/distribution contracts and packaging. Real device/desktop lifecycle qualification remains separate.

## Recovery after an npm update

`bogen update apply` verifies the manifest/package signatures and checksum, stages dependencies beside the installed app, probes the new CLI and retains one previous installation. `bogen update rollback` restores that saved app explicitly, without network requests or changes to documents. Restart an idle server afterwards. System-package installations continue to use their package manager; checkouts continue to use Git.

An updater lock prevents concurrent changes. A hard power loss during the directory switch can leave `.bogen-update-lock` and a `.bogen-design-previous` directory next to the installed npm package. Inspect both before removing the lock. If the current package directory is missing, the previous directory is the recovery copy; restore it to `bogen-design` before restarting. Do not delete a backup or staged directory until a working installation is confirmed. This is recoverable staging, not a claim of a crash-atomic filesystem transaction.

For data backups, stop Bogen first and archive the complete Bogen data folder, including assets, history, personal skills and configuration. Keep backups owner-readable: configuration can contain pairing credentials. Restore into an empty folder and verify it in an isolated server before replacing a live data folder. Sync is not a backup. The release lifecycle rehearsal checks a stopped-folder backup/restore and preserves its hashes.

## Develop

The server runs from source with `tsx`, and Vite serves the editor with hot reload. Use a spare port and a temporary
data folder, so that your own Bogen and its files stay out of it:

```sh
BOGEN_HOME=$(mktemp -d) npx tsx packages/server/src/cli.ts serve --dev --port 29997
BOGEN_API=http://127.0.0.1:29997 npm run dev     # the editor at http://localhost:5173
```

`--dev` lets loopback pages on any port through the Origin check, for Vite. Vite forwards `/api`, `/assets`, `/mcp`,
`/sync` and `/events` to `BOGEN_API` (default `http://127.0.0.1:29990`). `BOGEN_EDITOR_DIR` makes the server serve a
built editor from another folder.

## Test

```sh
npm run check:release-source # tracked-tree hygiene, never prints matched credentials
npm test            # Vitest: packages/*/test and apps/*/test
npm run typecheck   # tsc for core, server and editor
```

On the development host (i9-13900K, Arch Linux) on 2 November 2026, `npm test` ran 760 tests in 42 files in about
31 s, and `npm run typecheck` took about 9 s. The server tests start real servers on free ports, each in a temporary data
folder they remove afterwards, and connect real MCP clients (`packages/server/test/helpers.ts`). Agent runs in tests use
stand-in CLIs, so no test needs a login or uses a plan.

One file or one test:

```sh
npx vitest run packages/server/test/phone.test.ts
npx vitest run -t "pairs a phone"
```

### Browser suites

Real mouse and keyboard in Chromium, against the built editor. They are not part of `npm test`; run them one at a time,
after `npm run build`. Each uses a temporary data folder and a spare port, and none touches a running Bogen.

| Suite | What it covers | Run |
| --- | --- | --- |
| `run.ts` | The editor against a mock server that speaks the contract; sections can be named | `npx tsx apps/editor/test/e2e/run.ts [section…]` |
| `real-server.ts` | A smoke test of the built editor against the real server | `npx tsx apps/editor/test/e2e/real-server.ts` |
| `craft.ts` | Canvas craft, in numbered sections that can be named | `BOGEN_EDITOR_DIR=apps/editor/dist npx tsx apps/editor/test/e2e/craft.ts [section…]` |
| `design-system.ts` | Components, overrides, variants, slots, modes, two browsers, a synced peer, 500 instances | `npx tsx apps/editor/test/e2e/design-system.ts` |
| `library.ts` | Shared libraries: publish, update banner, accept, paste between files | `npx tsx apps/editor/test/e2e/library.ts` |
| `brand.ts` | Brands in the editor | `npx tsx apps/editor/test/e2e/brand.ts` |
| `drift.ts` | Drift against a fixture site, and the restyle in a brand, in the editor | `npx tsx apps/editor/test/e2e/drift.ts` |
| `code-components.ts` | A fixture Vite, React and Tailwind 4 project in the sandboxed frame | `npx tsx apps/editor/test/e2e/code-components.ts` |
| `code-pulls.ts` | Storybook import, token sync and a pull request through its preview, with a fixture repository and stand-ins for `claude` and `gh` | `npx tsx apps/editor/test/e2e/code-pulls.ts` |
| `agents.ts` | A comment that mentions an agent, and an agent showing you something | `npx tsx apps/editor/test/e2e/agents.ts` |
| `agent-loop.ts` | The agent loop and devices with real servers | `BOGEN_EDITOR_DIR=apps/editor/dist npx tsx apps/editor/test/e2e/agent-loop.ts` |
| `transfer.ts` | Getting work in and out through the UI | `npx tsx apps/editor/test/e2e/transfer.ts apps/editor/dist [screenshot folder]` |
| `integration.ts` | The built product with the real CSP; `--agent` adds a real coding agent run, which uses your plan | `npx tsx apps/editor/test/e2e/integration.ts <out-dir> [--agent]` |
| `perf-measure.ts` | Mount, pan, selection and the layer tree on a big document you give it | `BOGEN_EDITOR_DIR=apps/editor/dist npx tsx apps/editor/test/e2e/perf-measure.ts <file.ydoc> <pageId>` |
| `perf-big.ts` | A big file end to end: first layer painted, every layer painted, an agent's `html_write` until it is painted, `design_lint` and `canvas_screenshot` on the page, the tab's heap and the server's memory. Make the file first with `npx tsx scripts/gen-perf-fixture.ts <folder>` (about 10,000 layers; `--artboards` and `--rows` change it). `PERF_THROTTLE=4` slows the CPU, `PERF_PROFILE` and `PERF_TRACE` say where the time went | `BOGEN_EDITOR_DIR=apps/editor/dist npx tsx apps/editor/test/e2e/perf-big.ts <folder>` |

Most suites take `BOGEN_EDITOR_DIR` for a build elsewhere and `E2E_SHOTS=<folder>` for screenshots. The scripts say
what they do at the top.

The browser suites use `~/.local/bin/secure-chromium` by default and keep the Chromium sandbox enabled. `BOGEN_BROWSER` may name another installation of that wrapper. It keeps
the browser off the network, is driven over a pipe and given the test server's port with `--secure-local-port`. Sections
50 to 56 cover layout grids, find and replace, renaming in bulk, frame presets, matching layers, spacing and token swatches.

## Documentation checks

```sh
npm run check:docs
```

It runs three checks, each of which also runs alone:

| Check | What it does |
| --- | --- |
| `npx tsx scripts/gen-docs-reference.ts --check` | Fails when [the MCP tool reference](guide/reference/mcp-tools.md) differs from what a server lists. Without `--check` it rewrites the page. It starts a server in the same process, on a free port, with a temporary data folder. |
| `node scripts/check-doc-links.mjs` | Fails when a relative link or an anchor in a tracked Markdown file does not resolve. Add `--include-untracked` to inspect local drafts and evidence too. |
| `node scripts/gen-third-party-notices.mjs --check` | Fails when [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) is out of date with `package-lock.json`. Without `--check` it rewrites it. |

Run the first after a change to a tool, and the last after a change to the dependencies. The website builds its
documentation pages from `docs/guide`, so links in the guide stay inside `docs/guide`.

## Packages

### npm

```sh
npm run release:npm              # builds, then packs
node scripts/release-npm.mjs --no-build
```

`scripts/release-npm.mjs` lays out the package in `release/npm` (ignored by Git) and prints the path of
`bogen-design-<version>.tgz`. The package holds `dist/`, `integrations/omarchy` for `bogen omarchy install`, the README,
the license and the third-party notices. Its only dependencies are what the bundle leaves out: `puppeteer-core`,
`esbuild` and `tailwindcss`. `npm i -g <path to the .tgz>` installs it. This script publishes nothing.
A release packs it through `npm run release`, below.

## Making a release

```sh
npm run release -- --dry-run                                     # the whole rehearsal, with a throwaway key
BOGEN_RELEASE_KEY_FILE=~/keys/bogen-release.pem npm run release  # a release, from a clean checkout of its tag
```

`scripts/release.mjs` makes a release on this computer and publishes nothing:

1. It checks that every file states the same version (`npm run version:set -- --check`), that the tree is clean and
   HEAD is the tag `v<version>`, that `docs/guide/changelog.md` has a `## <version>` section not marked unreleased,
   and that the signing key belongs to a public key in `packages/server/src/release-key.ts`.
2. `npm run build`, `npm run typecheck` and `npm run check:docs`.
3. It packs the npm tarball with `scripts/release-npm.mjs`, installs it into a temporary prefix with
   `npm install --global --prefix`, and runs `bogen --version`, `bogen serve` (on a free port, until `/api/status`
   answers and the editor is served) and `bogen doctor --json` from it against a temporary `BOGEN_HOME`. Node, the
   data folder, the server and the editor must pass; what fails only because of this machine, such as Tailscale,
   is listed.
4. It writes into `release/v<version>/assets/`, with a `.sha256` and an Ed25519 `.sig` for each: the tarball;
   `bogen-design-<version>.cdx.json`, a CycloneDX 1.6 SBOM of what ships, from `package-lock.json` through
   `scripts/shipped-packages.mjs` (the same list as `THIRD_PARTY_NOTICES.md`); `bogen-release.json`, the manifest
   that `bogen update` reads; and `bogen-design-<version>-provenance.intoto.json`, an in-toto statement with the
   commit, the lock file, the builder's tools and the SHA-256 of every other file. Then it checks every digest and
   signature again with the public key alone.
5. It writes `release/v<version>/notes.md` from the changelog section (`npm run release:notes -- <version>` does that
   alone, with links into the tag) and `release/v<version>/PKGBUILD` with the tarball's checksum.

A dry run says what a real release would refuse, goes on, and writes into `release/dry-run-v<version>/`; without a
key it signs with a throwaway key it deletes afterwards, and it ends by running `bogen verify` from source on the
provenance with that key. `--no-build`, `--no-checks` and `--no-smoke` leave steps out (a real release refuses the
last two). `--update-pkgbuild` also fills in `integrations/arch/PKGBUILD`.

The key: `npm run release:keygen -- <path>` writes a new Ed25519 key, PKCS#8 PEM with mode 600, to a path outside
the repository, never over an existing file, and prints only the public key. The release script reads the private
key from the file `BOGEN_RELEASE_KEY_FILE` (or `--key`) names, refuses it inside the repository or readable by
others, and never prints or copies it. The public key goes into `RELEASE_PUBLIC_KEYS`, which `bogen verify` and
`bogen update apply` use; a second entry there is the next key while the key is being replaced.

The version lives in one command: `npm run version:set -- 0.2.0` writes it into the four `package.json` files,
`package-lock.json`, the Omarchy plugin's manifest, the PKGBUILD and the README badge.

Replacing the key: make a new one, add its public key as the second entry of `RELEASE_PUBLIC_KEYS` and release with
the old key, so installed copies trust both. Some releases later, sign with the new key, move it first and drop the
old entry. `scripts/release-key-backup.mjs` (`create`, `verify`, `restore`) makes an encrypted recovery copy of the
private key with a separate recovery code; all of its paths must lie outside the repository.

Publishing is a separate step that a person takes: the script ends by printing the `git push` and `gh release`
commands for the files it made. The release carries the tarball file itself, so the copy people download has the
SHA-256 that the signature, the manifest and the PKGBUILD name. `install.sh` at the top of the repository, served as
`https://bogen.dev/install.sh`, installs from that release after checking both.

### Arch

`integrations/arch/PKGBUILD` installs that npm tarball into `/usr/lib/node_modules` with `bogen` on the path. To
build it from a local tarball instead of the GitHub release:

```sh
npm run release:npm
mkdir /tmp/bogen-pkg && cp integrations/arch/PKGBUILD release/npm/bogen-design-*.tgz /tmp/bogen-pkg
cd /tmp/bogen-pkg && makepkg -si
```

`npm run release` writes a copy with the real checksum of the released tarball, `release/v<version>/PKGBUILD`. [integrations/arch](../integrations/arch/README.md)
has the details.

### Omarchy and other devices

From a checkout, `integrations/omarchy/install.sh` installs the integration against the build in that checkout, and
`integrations/omarchy/deploy.sh <ssh-host>` copies the build to another Omarchy machine. Both take `--dry-run`. See
[Omarchy](guide/omarchy.md) and [Devices](guide/devices.md#update-another-device).

## Other scripts

| Script | What it does |
| --- | --- |
| `npx tsx scripts/gen-icons.ts` | Writes `packages/core/src/icons-data.json` from the installed `lucide-react`. |
| `npx tsx scripts/gen-app-icons.ts` | Renders the phone app's Home Screen icons into `apps/editor/public/icons`, from the Bogen mark kept in the script. |
| `npx tsx scripts/capture-fidelity.ts <out-dir> <url>…` | Captures pages and measures how far the rendered layers are from the page, in different pixels. |

Agent integration guidance: [efficient context](design/agent-context.md) and [canvas organization](design/canvas-organization.md).
