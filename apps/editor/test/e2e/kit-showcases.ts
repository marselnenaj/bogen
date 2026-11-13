/**
 * A screenshot of each kit's showcase as the browser draws it: a real server from source in a temp BOGEN_HOME makes
 * the kit's library file, exports its page as HTML, and secure-chromium (sandbox on) renders it.
 *
 *   node --import tsx apps/editor/test/e2e/kit-showcases.ts [kit ...]
 *
 * Writes <TMPDIR>/bogen-kit-showcases/<kit>.png and prints the paths. With no kits named, it takes the second batch.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshPage, launch, startRealServer } from './craft-harness.ts';

const kits = process.argv.slice(2).length ? process.argv.slice(2) : ['mantine', 'carbon', 'uswds', 'daisyui', 'web-awesome', 'pico'];
const out = join(process.env.TMPDIR ?? tmpdir(), 'bogen-kit-showcases');
mkdirSync(out, { recursive: true });

const server = await startRealServer();
const browser = await launch(server.port);
try {
  for (const kit of kits) {
    const made = await fetch(`${server.base}/api/kits/${kit}/library`, { method: 'POST' });
    if (!made.ok) throw new Error(`${kit}: ${made.status} ${await made.text()}`);
    const { fileId } = await made.json() as { fileId: string };
    const exported = await fetch(`${server.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, format: 'html' }) });
    if (!exported.ok) throw new Error(`${kit}: export ${exported.status} ${await exported.text()}`);
    const html = await exported.text();
    writeFileSync(join(out, `${kit}.html`), html);
    const page = await freshPage(browser);
    await page.setViewport({ width: 3100, height: 1200 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const file = join(out, `${kit}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await page.close();
    console.log(file);
  }
} finally {
  await browser.close();
  await server.close();
}
