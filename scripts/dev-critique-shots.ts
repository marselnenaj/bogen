/**
 * Screenshots of Review like a designer in the editor, against a copy of a data folder that holds a critique.
 *   BOGEN_DEV_HOME=<copy> BOGEN_SHOTS=<out> node --import tsx scripts/dev-critique-shots.ts <fileId> [dark|light]
 * Opens the file, opens the dialog from the command palette, and shoots it at 1440 and 390. Nothing leaves the machine.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from '../apps/editor/test/e2e/craft-harness.ts';

const home = process.env.BOGEN_DEV_HOME;
const out = process.env.BOGEN_SHOTS ?? 'shots';
if (!home) throw new Error('Set BOGEN_DEV_HOME.');
mkdirSync(out, { recursive: true });
const [fileId, scheme = 'dark'] = process.argv.slice(2);
const ROOT = resolve(import.meta.dirname, '..');
const port = 29100 + Math.floor(Math.random() * 800);
const child = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(port)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', BOGEN_EDITOR_DIR: join(ROOT, 'apps/editor/dist') }, stdio: 'ignore', detached: true });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* not up */ }
  if (i > 160) throw new Error('The server did not start.');
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await launch(port);
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.setViewport({ width, height: width < 600 ? 860 : 900, deviceScaleFactor: 1 });
    await page.goto(`${base}/#/file/${fileId}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 2500));
    await page.keyboard.down('Control'); await page.keyboard.press('p'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 400));
    await page.keyboard.type('Review like a designer');
    await new Promise((r) => setTimeout(r, 400));
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="critique-dialog"]', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 1200));
    const name = join(out, `critique-${scheme}-${width}.png`);
    await page.screenshot({ path: name });
    console.log(name);
    await page.close();
  }
} finally {
  await browser.close();
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
}
process.exit(0);
