# Arch package

`PKGBUILD` installs the release tarball `bogen-design-<version>.tgz` into `/usr/lib/node_modules` with `bogen` on the path. It is for people who package Bogen themselves; it is not published to the AUR. Most people use the [install script](../../README.md#quickstart).

To build it from a local tarball instead of the GitHub release:

```bash
npm run release:npm                      # prints the path of release/npm/bogen-design-<version>.tgz
mkdir /tmp/bogen-pkg && cp integrations/arch/PKGBUILD release/npm/bogen-design-*.tgz /tmp/bogen-pkg
cd /tmp/bogen-pkg && makepkg -si
```

makepkg finds the tarball next to the PKGBUILD and skips the download.

`npm run release` writes `release/v<version>/PKGBUILD`: this file with `pkgver` and the real `sha256sums` of the very tarball the GitHub release carries. `--update-pkgbuild` writes the same into this file. `npm run version:set` sets `pkgver`, puts `pkgrel` back to 1 and the checksum back to `SKIP`.

The package gives you the CLI and the server. For the bar widget, launcher entry, keybinding and user service, run `bogen omarchy install` as your own user afterwards.
