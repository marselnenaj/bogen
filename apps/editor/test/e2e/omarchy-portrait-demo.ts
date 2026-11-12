/**
 * A Bogen of its own with one generic Omarchy theme for a portrait desk, to look at and edit by hand: a new theme
 * from Bogen's default palette (no installed theme is read), designed for a 4K landscape and a 4K monitor turned 270°.
 * Nothing of the person's is touched: HOME and BOGEN_HOME are temp folders, `hyprctl` is a stand-in reporting that
 * desk, and `omarchy` is a stand-in that only records calls. It prints the file's URL and runs until Ctrl+C.
 *
 * Needs the built editor (npm run build). Run:
 *   BOGEN_BROWSER=$HOME/.local/bin/secure-chromium npx tsx apps/editor/test/e2e/omarchy-portrait-demo.ts [--port 29210]
 * Open the URL in a sandboxed browser (secure-chromium with --secure-local-port=<port>).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'bogen-portrait-demo-'));
const home = join(work, 'home');
const bin = join(work, 'bin');
const DESK = JSON.stringify([
  { name: 'DP-3', width: 3840, height: 2160, transform: 0, scale: 1, disabled: false, mirrorOf: 'none' },
  { name: 'DP-5', width: 3840, height: 2160, transform: 3, scale: 1, disabled: false, mirrorOf: 'none' },
]);
mkdirSync(join(home, '.config', 'omarchy', 'themes'), { recursive: true });
mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
mkdirSync(join(work, 'omarchy', 'themes'), { recursive: true });
mkdirSync(bin);
writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '${DESK}'\n`);
writeFileSync(join(bin, 'omarchy'), `#!/bin/sh\necho "$@" >> "${join(work, 'omarchy.log')}"\n`);
chmodSync(join(bin, 'hyprctl'), 0o755);
chmodSync(join(bin, 'omarchy'), 0o755);
process.env.HOME = home;
process.env.OMARCHY_PATH = join(work, 'omarchy');
process.env.PATH = `${bin}:${process.env.PATH}`;
if (process.env.BOGEN_NO_SANDBOX === '1') throw new Error('The demo renders only with the browser sandbox on. Unset BOGEN_NO_SANDBOX.');

const { BogenServer } = await import('../../../../packages/server/src/http/server.ts');
const at = process.argv.indexOf('--port');
const server = new BogenServer({ home: join(work, 'bogen'), port: at > 0 ? Number(process.argv[at + 1]) : 0 });
await server.listen();
const res = await fetch(`${server.localUrl()}/api/omarchy/themes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Portrait Demo' }) });
const made = await res.json() as { file_id: string; boards: { name: string }[] };
console.log(`Portrait demo theme: ${server.localUrl()}/#/file/${made.file_id}`);
console.log(`Boards: ${made.boards.map((b) => b.name).join(', ')}`);
console.log(`Temp folder (removed on exit): ${work}`);
const stop = async () => {
  await server.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
