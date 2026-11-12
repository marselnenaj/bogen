/**
 * Portrait desktop monitors in an Omarchy theme, end to end in the built editor and a sandboxed Chromium
 * (~/.local/bin/secure-chromium, its sandbox on, over a pipe, reaching only the one loopback port it is given):
 * the Displays section of the theme dialog, a portrait composition marked as needing its own design for a theme of
 * landscape pictures, adding a display without touching what is there, refusing a landscape picture as portrait
 * artwork, taking one of the right shape, real renders of the portrait previews, and the export.
 *
 * Nothing of the person's is read or written: HOME is a temp folder, `hyprctl` reports a stand-in desk of a 4K
 * landscape and a 4K turned 270° (as `hyprctl monitors -j` prints it), `omarchy` is a stand-in that only records
 * calls (and must record none), and the stock theme is a fixture.
 *
 * Needs the built editor (npm run build). Run:
 *   BOGEN_BROWSER=$HOME/.local/bin/secure-chromium npx tsx apps/editor/test/e2e/omarchy-portrait.ts
 * Renders and screenshots go to $BOGEN_SHOTS, or a new temp folder.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync, gunzipSync } from 'node:zlib';
import puppeteer, { type Page } from 'puppeteer-core';

const CHROMIUM = resolve(process.env.HOME ?? '', '.local/bin/secure-chromium');
if (process.env.BOGEN_NO_SANDBOX === '1') throw new Error('This test runs only with the browser sandbox on. Unset BOGEN_NO_SANDBOX.');
if (process.env.BOGEN_BROWSER && process.env.BOGEN_BROWSER !== CHROMIUM) throw new Error(`BOGEN_BROWSER is ${process.env.BOGEN_BROWSER}; this test renders only with ${CHROMIUM}.`);
if (!existsSync(CHROMIUM)) throw new Error(`There is no ${CHROMIUM}.`);
// The server's renderer uses the same sandboxed browser.
process.env.BOGEN_BROWSER = CHROMIUM;

const SHOTS = process.env.BOGEN_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-portrait-shots-'));
mkdirSync(SHOTS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'bogen-portrait-e2e-'));
const home = join(work, 'home');
const omarchyPath = join(work, 'omarchy');
const bin = join(work, 'bin');
const log = join(work, 'omarchy.log');
const transfer = join(work, 'transfer');

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

/** A grey PNG of a size: only its shape matters here. */
function png(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 140)]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const pngSize = (b: Uint8Array) => ({ width: Buffer.from(b).readUInt32BE(16), height: Buffer.from(b).readUInt32BE(20) });

function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const out = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    out.set(prefix ? `${prefix}/${name}` : name, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ---------------------------------------------------------------- the fixture machine

const DESK = JSON.stringify([
  { name: 'DP-3', width: 3840, height: 2160, transform: 0, scale: 1, disabled: false, mirrorOf: 'none' },
  { name: 'DP-5', width: 3840, height: 2160, transform: 3, scale: 1, disabled: false, mirrorOf: 'none' },
]);
mkdirSync(join(omarchyPath, 'themes', 'wide', 'backgrounds'), { recursive: true });
writeFileSync(join(omarchyPath, 'themes', 'wide', 'colors.toml'), 'mode = "dark"\naccent = "#89b4fa"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\n');
writeFileSync(join(omarchyPath, 'themes', 'wide', 'backgrounds', '1-wide.png'), png(384, 216));
mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
mkdirSync(join(home, '.config', 'omarchy', 'themes'), { recursive: true });
writeFileSync(join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'), 'wide\n');
mkdirSync(bin);
writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '${DESK}'\n`);
writeFileSync(join(bin, 'omarchy'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
chmodSync(join(bin, 'hyprctl'), 0o755);
chmodSync(join(bin, 'omarchy'), 0o755);
mkdirSync(transfer);
const widePicture = join(transfer, 'wide-3840x2160.png');
const tallPicture = join(transfer, 'tall-1080x1920.png');
writeFileSync(widePicture, png(384, 216));
writeFileSync(tallPicture, png(216, 384));
process.env.HOME = home;
process.env.OMARCHY_PATH = omarchyPath;
process.env.PATH = `${bin}:${process.env.PATH}`;

const { BogenServer } = await import('../../../../packages/server/src/http/server.ts');

async function dialogNote(page: Page): Promise<string> {
  await page.waitForFunction(() => document.querySelector('[data-testid="omarchy-displays-note"], [data-testid="omarchy-displays-error"]'), { timeout: 60_000 });
  const text = await page.$eval('[data-testid="omarchy-displays-note"], [data-testid="omarchy-displays-error"]', (e) => `${e.getAttribute('data-testid')}: ${e.textContent ?? ''}`);
  return text;
}

async function main(): Promise<void> {
  const server = new BogenServer({ home: join(work, 'bogen'), port: 0 });
  await server.listen();
  const base = server.localUrl();
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() as any : Buffer.from(await res.arrayBuffer()) };
  };
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM, pipe: true, headless: true, env: { ...process.env, SECURE_BROWSER_TRANSFER_DIR: transfer },
    args: [`--secure-local-port=${server.port}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1500, height: 1000 },
  });
  try {
    const made = await api('/api/omarchy/themes', { from: 'wide', name: 'Wide Desk' });
    check('a theme from landscape pictures is made', made.status === 201, made.body);
    const id = made.body.file_id as string;
    const names: string[] = made.body.boards.map((b: { name: string }) => b.name);
    check('it has the turned monitor\'s four previews and a portrait composition', ['Preview · desktop · portrait 2160 × 3840', 'Preview · launcher · portrait 2160 × 3840', 'Preview · lock screen · portrait 2160 × 3840', 'Preview · boot unlock · portrait 2160 × 3840', 'Portrait background · 9:16 · 2160 × 3840'].every((n) => names.includes(n)), names);
    const room = await server.rooms.get(id);
    const nodeIds = () => new Set(room.doc.getPages().flatMap((p) => room.doc.getChildren(p.id)).flatMap((b) => [b.id, ...room.doc.descendants(b.id).filter((n) => !n.virtual).map((n) => n.id)]));
    const original = nodeIds();

    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String((e as Error).message).slice(0, 500)));
    await page.goto(`${base}/#/file/${id}`);
    await page.waitForSelector('[data-testid="omarchy-theme-banner"]', { timeout: 30_000 });
    await page.click('[data-testid="omarchy-theme-open"]');
    await page.waitForSelector('[data-testid="omarchy-theme-displays"]', { timeout: 15_000 });
    const section = await page.$eval('[data-testid="omarchy-theme-displays"]', (e) => e.textContent ?? '');
    check('the dialog has a Displays section that says previews do not change the monitors', /do not change your monitors or what Omarchy shows/.test(section), section);
    check('it lists the 1920 x 1080 previews and the portrait monitor', section.includes('Landscape 1920 × 1080') && section.includes('Portrait 2160 × 3840 (DP-5)'), section);
    const status = await page.$eval('[data-testid="omarchy-wallpaper"][data-aspect="9:16"]', (e) => e.getAttribute('data-status'));
    check('the portrait composition of a theme of landscape pictures needs its own design, not shown as done', status === 'needs-design', status);
    // What a portrait monitor would show at runtime. This fixture has no Omarchy shell plugins, so the portrait
    // background plugin cannot run here, and the 9:16 composition is not designed: DP-5 keeps the theme background.
    await page.waitForSelector('[data-testid="omarchy-display-runtime-screens"] [data-screen="DP-5"]', { timeout: 15_000 });
    const runtime = await page.$eval('[data-testid="omarchy-displays-runtime"]', (e) => ({ plugin: e.getAttribute('data-plugin'), text: e.textContent ?? '' }));
    const screen = (name: string) => page.$eval(`[data-testid="omarchy-display-runtime-screens"] [data-screen="${name}"]`, (e) => e.textContent ?? '');
    check('it says the portrait background plugin cannot be installed on this machine', runtime.plugin === 'not-installed' && /background plugin is not on this machine.*cannot be installed here/.test(runtime.text), runtime);
    check('it offers no install command where the plugin cannot run', !/bogen omarchy portrait/.test(runtime.text), runtime.text);
    const dp3 = await screen('DP-3');
    check('the landscape monitor shows the theme background', /^DP-3 \(3840 × 2160\): shows the theme background$/.test(dp3.trim()), dp3);
    const dp5 = await screen('DP-5');
    check('the portrait monitor keeps the theme background, cropped, because 9:16 needs its own design', /^DP-5 \(2160 × 3840\): shows the theme background, cropped\./.test(dp5.trim()) && /9:16 composition needs its own design: it is never shown until it is designed/.test(dp5), dp5);
    check('it names no tool or protocol', !/omarchy_theme|assign_artwork|asset_upload/.test(section), section);
    const fileProblems = await page.$eval('[data-testid="omarchy-theme-files"]', (e) => e.textContent ?? '');
    check('the folder details do not repeat the wallpaper state', !/background needs its own design/.test(fileProblems), fileProblems);
    await page.screenshot({ path: join(SHOTS, 'omarchy-portrait-dialog.png') as `${string}.png` });

    // A landscape picture as portrait artwork is refused, and nothing changes.
    const before = nodeIds().size;
    const [wideChooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="omarchy-wallpaper-artwork"]')]);
    await wideChooser.accept([widePicture]);
    const refused = await dialogNote(page);
    check('a landscape picture is refused as portrait artwork', refused.startsWith('omarchy-displays-error') && /not taken/.test(refused), refused);
    check('and the file is as it was', nodeIds().size === before);

    // A 9:16 picture is taken, shown, and is the composition's own artwork.
    const [tallChooser] = await Promise.all([page.waitForFileChooser(), page.click('[data-testid="omarchy-wallpaper-artwork"]')]);
    await tallChooser.accept([tallPicture]);
    const taken = await dialogNote(page);
    check('a 9:16 picture is taken as portrait artwork', taken.startsWith('omarchy-displays-note'), taken);
    await page.waitForFunction(() => document.querySelector('[data-testid="omarchy-wallpaper"][data-aspect="9:16"]')?.getAttribute('data-status') === 'artwork', { timeout: 15_000 });
    check('its state becomes Own artwork', true);
    // Designed now, the composition would still not reach DP-5 here: the plugin cannot run on this machine, so the
    // screen keeps the theme background and says why, rather than claiming the artwork is on the monitor.
    const designed = await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid="omarchy-display-runtime-screens"] [data-screen="DP-5"]')?.textContent ?? '';
      return /9:16 composition is designed/.test(t) ? t : null;
    }, { timeout: 15_000 }).then((h) => h.jsonValue() as Promise<string>).catch(() => '');
    check('with artwork, DP-5 still keeps the theme background where the plugin cannot run, and says why', /shows the theme background, cropped\. The 9:16 composition is designed, but the portrait background plugin cannot run here/.test(designed), designed);

    // Add a display of a new shape: below the design, nothing that was there changed.
    await page.select('[data-testid="omarchy-display-pick"]', 'preset:portrait-1200x1920');
    await page.click('[data-testid="omarchy-display-add"]');
    const added = await dialogNote(page);
    check('adding a 1200 x 1920 display says what it added', /Added previews at 1200 × 1920/.test(added), added);
    const after = nodeIds();
    check('every layer that was there is still there', [...original].every((n) => after.has(n)), [...original].filter((n) => !after.has(n)).length);
    check('no page was made', room.doc.getPages().length === 1);
    await page.waitForSelector('[data-testid="omarchy-wallpaper"][data-aspect="10:16"][data-status="needs-design"]', { timeout: 15_000 });
    check('the new shape gets a composition that needs its own design', true);
    await page.select('[data-testid="omarchy-display-pick"]', 'custom');
    await page.$eval('[data-testid="omarchy-display-width"]', (e) => { (e as HTMLInputElement).value = ''; });
    await page.type('[data-testid="omarchy-display-width"]', '1200');
    await page.$eval('[data-testid="omarchy-display-height"]', (e) => { (e as HTMLInputElement).value = ''; });
    await page.type('[data-testid="omarchy-display-height"]', '1920');
    const count = nodeIds().size;
    await page.click('[data-testid="omarchy-display-add"]');
    const again = await dialogNote(page);
    check('adding the same size again adds nothing', /already/.test(again) && nodeIds().size === count, again);
    await page.screenshot({ path: join(SHOTS, 'omarchy-portrait-dialog-after.png') as `${string}.png` });

    // Real renders of the portrait previews, through the server's renderer in the same sandboxed browser.
    const board = (name: string) => room.doc.getPages().flatMap((p) => room.doc.getChildren(p.id)).find((n) => n.name === name)!;
    for (const name of ['Preview · desktop · portrait 2160 × 3840', 'Preview · lock screen · portrait 1200 × 1920', 'Portrait background · 10:16 · 2400 × 3840']) {
      const node = board(name);
      if (!node) {
        check(`renders ${name}`, false, 'no such board');
        continue;
      }
      const shot = await server.renderer.screenshot(room.doc, { nodeIds: [node.id] }, { format: 'png', scale: 0.5 });
      writeFileSync(join(SHOTS, `${name.replace(/[^\w]+/g, '-')}.png`), shot.bytes);
      const size = pngSize(shot.bytes);
      check(`renders ${name} at its own shape`, size.height > size.width, size);
    }

    const tar = await api(`/api/omarchy/theme/${id}/export`, { to: 'tar' });
    const files = untar(tar.body as Buffer);
    const paths = [...files.keys()].filter((p) => !p.endsWith('/')).map((p) => p.replace(/^wide-desk\//, ''));
    check('the export keeps backgrounds/ to the theme\'s own landscape picture', paths.filter((p) => p.startsWith('backgrounds/')).join() === 'backgrounds/1-wide.png', paths);
    check('the portrait artwork goes out byte for byte under displays/', Boolean(files.get('wide-desk/displays/background-portrait-9x16.png')?.equals(readFileSync(tallPicture))), paths);
    check('each display has its preview under displays/', ['displays/preview-portrait-2160x3840.png', 'displays/preview-portrait-1200x1920.png'].every((p) => paths.includes(p)), paths);
    const preview = files.get('wide-desk/preview.png');
    check('preview.png is still the 1920 x 1080 desktop at 1800 x 1012', Boolean(preview) && JSON.stringify(pngSize(preview!)) === JSON.stringify({ width: 1800, height: 1012 }), preview && pngSize(preview));
    check('nothing ran omarchy', !existsSync(log) || readFileSync(log, 'utf8').trim() === '');
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    await server.close();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed.length} checks passed. Shots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
