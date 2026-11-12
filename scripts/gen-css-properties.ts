/**
 * Makes packages/core/src/css-properties.json: every CSS property name the installed Chromium parses, so that html_write
 * can tell a misspelt property from a real one without starting a browser on every write.
 * Run: npx tsx scripts/gen-css-properties.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { findBrowser } from '../packages/server/src/render.ts';

const root = resolve(import.meta.dirname, '..');
const executablePath = findBrowser();
if (!executablePath) throw new Error('No Chromium found. Set BOGEN_CHROMIUM.');
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  // A string, so that what the TypeScript loader adds to functions does not reach the page.
  const { names } = await page.evaluate(`(() => {
    const kebab = (p) => p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/^webkit-/, '-webkit-');
    const style = document.documentElement.style;
    const found = new Set();
    for (const key in style) {
      if (typeof style[key] !== 'string' || key.includes('-')) continue;
      const name = kebab(key);
      if (CSS.supports(name, 'inherit')) found.add(name);
    }
    return { names: [...found].sort() };
  })()`) as { names: string[] };
  const version = (await browser.version()).replace(/^\D*\//, '');
  writeFileSync(resolve(root, 'packages/core/src/css-properties.json'), `${JSON.stringify({ source: `Chromium ${version}`, properties: names })}\n`);
  console.log(`${names.length} properties from Chromium ${version}`);
} finally {
  await browser.close();
}
