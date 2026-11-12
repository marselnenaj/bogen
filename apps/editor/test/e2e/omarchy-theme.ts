/**
 * Designing an Omarchy theme in the built editor against the real server: the home section, the theme file with its
 * banner and dialog, export, install with the overwrite question, apply and undo. Run after `npm run build`:
 *   npx tsx apps/editor/test/e2e/omarchy-theme.ts
 *
 * The desktop is never touched: HOME is a temp folder, `omarchy` and `hyprctl` are stand-ins first on PATH, and the
 * stock themes are a fixture. E2E_REAL_STOCK=1 reads the machine's stock themes instead, which are only ever read.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { sleep, watchErrors, SHOTS } from './harness.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const OUT = resolve(import.meta.dirname, '../../.out');
mkdirSync(OUT, { recursive: true });
const root = mkdtempSync(resolve(OUT, 'omarchy-'));
const home = resolve(root, 'home');
const bin = resolve(root, 'bin');
const log = resolve(root, 'omarchy.log');
const realStock = process.env.E2E_REAL_STOCK === '1' && existsSync('/usr/share/omarchy/themes');
const omarchyPath = realStock ? '/usr/share/omarchy' : resolve(root, 'omarchy');

const COLORS = `mode = "dark"

accent = "#89b4fa"
selection = "#45475a"
muted = "#585b70"

background = "#1e1e2e"
dark_background = "#161622"
darker_background = "#101019"
lighter_background = "#313244"

foreground = "#cdd6f4"
dark_foreground = "#6c7086"
light_foreground = "#bac2de"
bright_foreground = "#cdd6f4"

red = "#f38ba8"
yellow = "#f9e2af"
orange = "#f6b6ab"
green = "#a6e3a1"
cyan = "#94e2d5"
blue = "#89b4fa"
magenta = "#f5c2e7"
brown = "#7b5b55"

bright_red = "#f38ba8"
bright_yellow = "#f9e2af"
bright_green = "#a6e3a1"
bright_cyan = "#94e2d5"
bright_blue = "#89b4fa"
bright_magenta = "#f5c2e7"
`;

mkdirSync(resolve(home, '.local/state/omarchy/current'), { recursive: true });
mkdirSync(resolve(home, '.config/omarchy/themes'), { recursive: true });
writeFileSync(resolve(home, '.local/state/omarchy/current/theme.name'), 'catppuccin\n');
if (!realStock) {
  mkdirSync(resolve(omarchyPath, 'themes/catppuccin/backgrounds'), { recursive: true });
  writeFileSync(resolve(omarchyPath, 'themes/catppuccin/colors.toml'), COLORS);
}
mkdirSync(bin);
writeFileSync(resolve(bin, 'omarchy'), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = theme ] && [ "$2" = set ]; then printf '%s\\n' "$3" > "$HOME/.local/state/omarchy/current/theme.name"; fi\n`);
writeFileSync(resolve(bin, 'hyprctl'), `#!/bin/sh\necho '[{"width":2560,"height":1600,"transform":0}]'\n`);
chmodSync(resolve(bin, 'omarchy'), 0o755);
chmodSync(resolve(bin, 'hyprctl'), 0o755);

const PORT = 29000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${PORT}`;
const server = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, HOME: home, OMARCHY_PATH: omarchyPath, PATH: `${bin}:${process.env.PATH}`, BOGEN_HOME: resolve(root, 'bogen'), BOGEN_WELCOME: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d: Buffer) => { const t = String(d); if (!/ExperimentalWarning|trace-warnings/.test(t)) process.stdout.write(`[server] ${t}`); });

let ok = 0;
let bad = 0;
const check = (name: string, pass: boolean, detail?: unknown) => {
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${!pass && detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
/** The dialog's note or error after an action, whichever comes. */
async function outcome(page: import('puppeteer-core').Page, prefix: string): Promise<string> {
  await page.waitForFunction((p) => document.querySelector('[data-testid="omarchy-note"]')?.textContent?.startsWith(p) || document.querySelector('[data-testid="omarchy-error"]'), { timeout: 120000 }, prefix);
  return page.$eval('[data-testid="omarchy-note"], [data-testid="omarchy-error"]', (e) => e.textContent ?? '');
}
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

async function main(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, userDataDir: resolve(OUT, `profiles/omarchy${Date.now()}`), args: ['--no-sandbox', '--window-size=1500,960', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 960 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument('window.__name = (f) => f');
    const errors: string[] = [];
    watchErrors(page, errors);
    await page.goto(`${base}/#/`);
    await page.waitForSelector('[data-testid="omarchy-themes"]', { timeout: 15000 });
    const rows = await page.$$eval('[data-testid="omarchy-theme-from"]', (els) => els.map((e) => e.getAttribute('data-theme')));
    check('home lists the installed themes to start from', rows.includes('catppuccin'), rows);
    const hint = await page.$eval('[data-testid="omarchy-themes"]', (e) => e.textContent ?? '');
    check('home names the screen sizes of the backgrounds', hint.includes('2560 × 1600'), hint);
    await page.screenshot({ path: resolve(SHOTS, 'omarchy-home.png') as `${string}.png` });

    await page.click('[data-testid="omarchy-theme-from"][data-theme="catppuccin"]');
    await page.waitForSelector('[data-testid="omarchy-theme-banner"]', { timeout: 30000 });
    check('starting from a theme opens a theme file with its banner', true);
    await page.click('[data-testid="omarchy-theme-open"]');
    await page.waitForSelector('[data-testid="omarchy-theme-dialog"]');
    // A theme started from catppuccin is Catppuccin Custom, so that installing it does not go over the stock one.
    const name = await page.$eval('[data-testid="omarchy-theme-name"]', (el) => (el as HTMLInputElement).value);
    check('a theme started from another gets a name of its own', name === 'Catppuccin Custom', name);
    await page.focus('[data-testid="omarchy-theme-name"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('[data-testid="omarchy-theme-name"]', 'Mocha Night');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="omarchy-theme-dialog"] code')?.textContent === 'mocha-night', { timeout: 10000 });
    check('renaming it renames its folder', true);
    const files = await page.$eval('[data-testid="omarchy-theme-files"]', (e) => e.textContent ?? '');
    check('the dialog says what the folder holds', files.includes('colors.toml') && files.includes('25 keys'), files);
    await page.screenshot({ path: resolve(SHOTS, 'omarchy-dialog.png') as `${string}.png` });

    // Export into a folder typed in the dialog, as a Git repository.
    const dest = resolve(root, 'export', 'omarchy-mocha-night-theme');
    await page.focus('[data-testid="omarchy-export-dir"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('[data-testid="omarchy-export-dir"]', dest);
    await page.click('[data-testid="omarchy-export-folder"]');
    const wrote = await outcome(page, 'Wrote');
    const exported = existsSync(dest) ? readdirSync(dest).sort() : [];
    check('export writes a theme folder', ['.git', 'README.md', 'colors.toml', 'icons.theme', 'preview-unlock.png', 'preview.png', 'unlock.png'].every((f) => exported.includes(f)), { wrote, exported });

    // Install, then install again: the second asks before it replaces anything.
    await page.click('[data-testid="omarchy-install"]');
    const first = await outcome(page, 'Installed');
    const installed = resolve(home, '.config/omarchy/themes/mocha-night');
    check('install writes the theme into the themes folder', existsSync(resolve(installed, 'colors.toml')), first);
    writeFileSync(resolve(installed, 'mine.txt'), 'kept until the person says yes');
    await page.waitForFunction(() => document.querySelector('[data-testid="omarchy-install"]')?.textContent?.includes('again'));
    await page.click('[data-testid="omarchy-install"]');
    await page.waitForSelector('[data-testid="omarchy-confirm"]');
    check('installing over a theme asks first', existsSync(resolve(installed, 'mine.txt')));
    await page.screenshot({ path: resolve(SHOTS, 'omarchy-confirm.png') as `${string}.png` });
    await page.click('[data-testid="omarchy-confirm-keep"]');
    check('keeping it changes nothing', existsSync(resolve(installed, 'mine.txt')));
    await page.click('[data-testid="omarchy-install"]');
    await page.click('[data-testid="omarchy-confirm-replace"]');
    const replaced = await outcome(page, 'Replaced');
    check('replacing it on a yes', !existsSync(resolve(installed, 'mine.txt')), replaced);

    check('nothing ran omarchy before Apply', calls().length === 0, calls());
    await page.click('[data-testid="omarchy-apply"]');
    await page.waitForSelector('[data-testid="omarchy-undo-apply"]', { timeout: 30000 });
    check('Apply runs omarchy theme set once', calls().join('|') === 'theme set mocha-night', calls());
    await page.click('[data-testid="omarchy-undo-apply"]');
    await outcome(page, 'Back to');
    check('Undo apply goes back to the theme from before', calls().at(-1) === 'theme set catppuccin', calls());
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`\n${ok}/${ok + bad} checks passed`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
