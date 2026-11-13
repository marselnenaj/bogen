/**
 * Builds the browser extension: `node --import tsx integrations/browser-extension/build.ts`.
 * Writes dist/chromium and dist/firefox (load either unpacked) and a zip of each next to them. The capture script is
 * the server's own (CAPTURE and SHEET_SCAN), so a page reads the same in the tab as it does headless.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { RESET_CSS } from '@bogen/core';
import { CAPTURE } from '../../packages/server/src/capture.ts';
import { SHEET_SCAN } from '../../packages/server/src/capture-sheets.ts';
import { makeZip } from '../../packages/server/src/zip.ts';

const HERE = import.meta.dirname;
const SRC = join(HERE, 'src');
const OUT = resolve(process.argv[2] ?? join(HERE, 'dist'));
const VERSION = (JSON.parse(readFileSync(join(HERE, '../../package.json'), 'utf8')) as { version: string }).version.replace(/[^0-9.]/g, '') || '0.0.0';

/** A square PNG of the Bogen sheet: a blue sheet with a light rule across its top. */
function icon(size: number): Buffer {
  const row = size * 4 + 1;
  const raw = Buffer.alloc(row * size);
  const edge = Math.max(1, Math.round(size / 16));
  const band = Math.round(size * 0.28);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * row + 1 + x * 4;
      const inside = x >= edge && x < size - edge && y >= edge && y < size - edge;
      const rule = inside && y >= band && y < band + edge * 1.5;
      const [r, g, b, a] = !inside ? [0, 0, 0, 0] : rule ? [244, 242, 236, 255] : [43, 61, 242, 255];
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

function build(target: 'chromium' | 'firefox'): string {
  const dir = join(OUT, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'icons'), { recursive: true });
  for (const name of ['shared.js', 'background.js', 'collect.js', 'picker.js', 'popup.html', 'popup.css', 'popup.js']) writeFileSync(join(dir, name), readFileSync(join(SRC, name)));
  writeFileSync(join(dir, 'page-capture.js'), `// Generated from packages/server/src/capture.ts and capture-sheets.ts by build.ts. Do not edit.\n'use strict';\nglobalThis.__bogenReset = ${JSON.stringify(RESET_CSS)};\nglobalThis.__bogenCapture = ${CAPTURE};\nglobalThis.__bogenSheetScan = ${SHEET_SCAN};\n`);
  for (const size of [16, 32, 48, 128]) writeFileSync(join(dir, 'icons', `icon-${size}.png`), icon(size));
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  manifest.version = VERSION;
  if (target === 'firefox') {
    manifest.background = { scripts: ['shared.js', 'background.js'] };
    manifest.browser_specific_settings = { gecko: { id: 'capture@bogen.design', strict_min_version: '128.0' } };
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  const zip = join(OUT, `bogen-capture-${target}-${VERSION}.zip`);
  writeFileSync(zip, makeZip(files(dir).sort().map((f) => ({ name: relative(dir, f), bytes: readFileSync(f) }))));
  return zip;
}

for (const target of ['chromium', 'firefox'] as const) console.log(`${target}: ${join(OUT, target)} and ${build(target)}`);
