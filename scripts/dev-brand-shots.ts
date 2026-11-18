/**
 * Screenshots of Home and brand pages against a data folder, for working on the brand book.
 *   BOGEN_DEV_HOME=<folder> BOGEN_SHOTS=<out> node --import tsx scripts/dev-brand-shots.ts <route>[@width] ...
 * A route is a hash such as "#/" or "#/brand/<id>"; the width defaults to 1440. Nothing leaves the machine.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch } from '../apps/editor/test/e2e/craft-harness.ts';

const home = process.env.BOGEN_DEV_HOME;
const out = process.env.BOGEN_SHOTS ?? 'shots';
if (!home) throw new Error('Set BOGEN_DEV_HOME.');
mkdirSync(out, { recursive: true });
const ROOT = resolve(import.meta.dirname, '..');
const port = 29100 + Math.floor(Math.random() * 800);
const child = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(port)], { cwd: ROOT, env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', BOGEN_EDITOR_DIR: join(ROOT, 'apps/editor/dist') }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = '';
child.stdout?.on('data', (d: Buffer) => { log += d; });
child.stderr?.on('data', (d: Buffer) => { log += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* not up */ }
  if (i > 160) { console.log(log); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
const browser = await launch(port);
try {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('/api/')) {
      const res = await fetch(`${base}${arg}`);
      const name = join(out, arg.replace(/[^a-z0-9.]+/gi, '_'));
      writeFileSync(name, Buffer.from(await res.arrayBuffer()));
      console.log(res.status, name);
      continue;
    }
    const [route, w] = arg.split('@');
    const width = Number(w ?? 1440);
    const page = await browser.newPage();
    await page.setViewport({ width, height: width < 600 ? 860 : 900, deviceScaleFactor: 1 });
    await page.goto(`${base}/${route}`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 2500));
    const name = `${route.replace(/[^a-z0-9]+/gi, '_')}-${width}.png`;
    await page.screenshot({ path: join(out, name), fullPage: process.env.FULL === '1' });
    console.log(join(out, name));
    await page.close();
  }
} finally {
  await browser.close();
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
}
