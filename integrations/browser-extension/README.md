# Bogen capture, the browser extension

Captures the tab you are on, a region or an element, and sends it to Bogen on this computer as editable
layers. Manifest V3, for Chromium browsers and Firefox 128 or later, from the same source.

```sh
node --import tsx integrations/browser-extension/build.ts   # writes dist/chromium, dist/firefox and a zip of each
```

Load `dist/chromium` unpacked at `chrome://extensions` (Developer mode), or `dist/firefox/manifest.json` at
`about:debugging#/runtime/this-firefox`, then pair it from its popup and allow it in the Bogen editor.
[Capture and import](../../docs/guide/capture-and-import.md#from-your-browser-the-extension) has the steps, and
[Privacy](../../docs/guide/privacy.md#the-browser-extension) says what it can see.

| File | What it does |
| --- | --- |
| `src/manifest.json` | Permissions: `activeTab`, `scripting`, `storage`. No host permissions; connections to `127.0.0.1` and `localhost` only. |
| `src/popup.*` | Pairing and the three capture buttons. |
| `src/background.js` | Runs the capture in the tab, takes its picture, sends both to Bogen with the pairing token. |
| `src/collect.js` | In the tab: Bogen's capture script, then the images, fonts and style sheets the tab may read. |
| `src/picker.js` | In the tab: the overlay to drag a region or pick an element, and the note with the result. |
| `page-capture.js` | Written by `build.ts` from `packages/server/src/capture.ts` and `capture-sheets.ts`. |

Test: `BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/browser-extension.ts [screenshot dir]` loads the
built extension in the sandboxed browser and pairs, captures a page behind a login, an element and a region.
