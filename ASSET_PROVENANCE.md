# Asset provenance

This inventory records asset origins separately from the application license in LICENSE. Dependency licenses and required notices are in THIRD_PARTY_NOTICES.md. It is a provenance check, not a trademark, copyright or exclusivity certification.

## Twenty included art directions

Licence of this artwork: to the extent the maintainer holds rights in the 40 wallpaper masters and their thumbnails, they are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Themes made from them may be published under any terms. This is separate from the GNU GPL that covers the program.

The 40 wallpaper masters in `dist/omarchy-collection/` are AI-generated artwork made with OpenAI image_gen, as recorded in `docs/design/collection-art-20261109.json` in the source distribution. They are not documentary photographs or scans of existing physical artworks. The generation inventory records prompts, original image sizes and final master hashes. Landscape and portrait compositions were generated independently. Delivery dimensions are 3840×2160 and 2160×3840 after resampling; the images are not native 4K generations.

`dist/omarchy-collection/provenance.json` lists the 40 masters and 40 derived WebP thumbnails with SHA-256 hashes and their relationships. The source equivalent is `packages/server/assets/omarchy-collection/provenance.json`. Run `node scripts/check-asset-provenance.mjs` in a source checkout to verify coverage and hashes against the generation inventory. This catalog contains Bogen's art directions; it does not bundle community-theme repositories or grant rights to their marks.

OpenAI's [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/) describe output ownership as between the account holder and OpenAI, subject to applicable law, and explain that output may not be unique. API/business use follows the linked business agreement. These terms do not replace review of applicable account terms or third-party rights. No blanket legal clearance is implied by the generator label.

## Editor fonts and icons

- Source Sans 3 is supplied through the locked `@fontsource-variable/source-sans-3` package under SIL OFL 1.1; its notice is included in THIRD_PARTY_NOTICES.md.
- Lucide icons are supplied through the locked `lucide-react` package under ISC; its notice is included in THIRD_PARTY_NOTICES.md.
- Bogen's app icon and wordmark are project assets. References to other products identify integrations and do not imply endorsement or convey their trademark rights.

## Your own content

User-imported designs, images, fonts and themes retain their own provenance; this inventory does not clear them for redistribution.
