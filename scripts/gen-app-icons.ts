/**
 * Renders the home screen icons of the phone app into apps/editor/public/icons, from the sheet mark of the
 * Bogen brand (the site's favicon: the dog-eared sheet with `>_`) on paper.
 * Run: npx tsx scripts/gen-app-icons.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const PAPER = '#f4f2ec';
const MARK = '<path fill="#2b3df2" d="M10 4H66L92 30V96H10Z"/><path fill="#1b27a8" d="M66 4V30H92Z"/><path d="M26 48 48 64 26 80" fill="none" stroke="#f4f2ec" stroke-width="10.5" stroke-miterlimit="8"/><rect fill="#f4f2ec" x="55" y="73" width="25" height="10.5"/>';

/** The mark fills `share` of the square, centred on its own box of 82 by 92. */
function icon(share: number): string {
  const box = 100 / share;
  const offset = (box - 100) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-offset + 1} ${-offset} ${box} ${box}"><rect x="${-offset + 1}" y="${-offset}" width="${box}" height="${box}" fill="${PAPER}"/>${MARK}</svg>`;
}

// iOS rounds the corners itself and wants no transparency. A maskable icon may be cut to a circle of 80 %.
const outputs = [
  { file: 'apple-touch-icon.png', size: 180, share: 0.72 },
  { file: 'icon-192.png', size: 192, share: 0.72 },
  { file: 'icon-512.png', size: 512, share: 0.72 },
  { file: 'icon-maskable-512.png', size: 512, share: 0.54 },
];

const dir = resolve(import.meta.dirname, '..', 'apps/editor/public/icons');
mkdirSync(dir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.BOGEN_BROWSER ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  for (const { file, size, share } of outputs) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${icon(share).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    writeFileSync(resolve(dir, file), await page.screenshot({ type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log(`${file} ${size}x${size}`);
  }
  writeFileSync(resolve(dir, 'icon.svg'), `${icon(0.72)}\n`);
} finally {
  await browser.close();
}
