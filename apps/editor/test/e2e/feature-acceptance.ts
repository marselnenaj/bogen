/**
 * Acceptance of run intent, revisions, mobile themes and exported web sections through the real editor, a real
 * server and a sandboxed browser:
 *
 *   A. The prompt bar says what a message will do (redo, edit, new page), the override works, and a sent redo opens a
 *      revision instead of a page.
 *   B. A redo asked in a comment goes into a revision; accepting it after the original was edited shows the conflict
 *      and keeps the original layers' ids and the comment's pin.
 *   C. A palette-only file asks desktop or mobile; a mobile theme shows its coverage and offers the phone package,
 *      never install; the package's install.sh dry-runs against a Komodo fixture; home offers New mobile theme.
 *   D. The native web sections, exported as HTML, at 1440 and 390: navigation folds into a popover menu that opens and
 *      closes with the keyboard, the accordion keeps one answer open, the dialog opens, nothing overflows.
 *   E. The same artboard as React, compiled with esbuild against the repo's react and react-dom and rendered: the
 *      same behaviour, no page errors.
 *
 * Deterministic: a temporary home, a fixture OMARCHY_PATH, no phone (OMAMOBILE_PATH points nowhere), and stand-in
 * CLIs on PATH, so no plan is spent. Needs `npm run build` first and BOGEN_BROWSER pointing at a browser with its
 * sandbox on, such as ~/.local/bin/secure-chromium:
 *
 *   BOGEN_BROWSER=~/.local/bin/secure-chromium node --import tsx apps/editor/test/e2e/feature-acceptance.ts
 *
 * Screenshots go to the folder printed at the end, for a person to look at.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import puppeteer, { type Page } from 'puppeteer-core';
import { importHtml, listRevisions, resolveInstanceRefs, toReact, type NewNode } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { exportTarget } from '../../../../packages/server/src/exporter.ts';
import { SECTIONS } from '../../../../packages/server/src/templates/web-sections.ts';
import { fake, writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const browserPath = process.env.BOGEN_BROWSER;
if (!browserPath) throw new Error('Set BOGEN_BROWSER to a browser with its sandbox on, such as ~/.local/bin/secure-chromium.');

// ---------------------------------------------------------------- an isolated world

const root = mkdtempSync(join(tmpdir(), 'bogen-acceptance-'));
const shots = join(root, 'shots');
const bin = join(root, 'bin');
const omarchy = join(root, 'omarchy');
const phone = join(root, 'phone-omamobile');
for (const d of [shots, bin, join(omarchy, 'themes', 'catppuccin'), join(root, 'home', '.local', 'state', 'omarchy', 'current')]) mkdirSync(d, { recursive: true });
writeFileSync(join(omarchy, 'themes', 'catppuccin', 'colors.toml'), 'mode = "dark"\naccent = "#89b4fa"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\n');
writeFakeClis(bin, join(root, 'cli.log'));
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(root, 'home');
process.env.OMARCHY_PATH = omarchy;
process.env.OMAMOBILE_PATH = join(root, 'no-omamobile');

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
await server.listen();
const base = server.localUrl();
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, pipe: true, args: [`--secure-local-port=${new URL(base).port}`], defaultViewport: { width: 1440, height: 900 } });

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    passed++;
    console.log(`pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ''}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function openPage(path: string): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  page.on('pageerror', (e) => errors.push(`${path}: ${String(e)}`));
  await page.goto(`${base}/${path}`);
  return page;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
async function clearPrompt(page: Page): Promise<void> {
  await page.focus('[data-testid="prompt-input"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
}

/** A file with one landing artboard: a heading the tests edit and a comment can pin to. */
async function landing(name: string) {
  const entry = server.storage.create(name);
  const room = await server.rooms.get(entry.id);
  const { doc } = room;
  const pageId = doc.getPages()[0]!.id;
  const board = doc.insert(pageId, { type: 'frame', name: 'Landing', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '960px', height: '540px', display: 'flex', flexDirection: 'column', padding: '48px', gap: '16px', background: '#f7f4ef' } });
  const heading = doc.insert(board, { type: 'text', name: 'Heading', tag: 'h1', text: 'Chairs, made slowly', style: { fontSize: '56px', color: '#1d1b19' } });
  doc.invalidate();
  return { id: entry.id, room, doc, pageId, board, heading };
}

try {
  // ---------------------------------------------------------------- A. intent in the prompt bar
  {
    const f = await landing('Intent');
    const page = await openPage(`#/file/${f.id}`);
    await page.waitForSelector('[data-testid="canvas"]');
    await wait(300);
    await page.keyboard.down('Control');
    await page.keyboard.press('k');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="prompt-input"]');
    await page.type('[data-testid="prompt-input"]', "make the page again, I don't like it");
    check('A: a redo is announced before it is sent', await until(() => exists(page, '[data-testid="prompt-intent"][data-intent="revise"]'), 3000));
    await page.screenshot({ path: join(shots, 'a-intent-redo.png') });
    await page.click('[data-testid="prompt-intent-switch"]');
    check('A: one click changes it in place instead', await until(async () => (await page.$eval('[data-testid="prompt-intent"]', (e) => e.textContent ?? '').catch(() => '')).includes('in place'), 3000));
    await clearPrompt(page);
    await page.type('[data-testid="prompt-input"]', 'Why did you redo it?');
    check('A: a question about a redo is not a redo', !(await exists(page, '[data-testid="prompt-intent"]')));
    await clearPrompt(page);
    const pages = f.doc.getPages().length;
    await page.type('[data-testid="prompt-input"]', `start over with this page ${fake({ tools: [{ name: 'page_create', args: { name: 'Landing v2' } }] })}`);
    await page.keyboard.press('Enter');
    check('A: the sent redo opens a revision', await until(() => listRevisions(f.doc).some((r) => r.status === 'draft'), 10_000));
    await until(() => server.runs.list().length === 0, 15_000);
    f.doc.invalidate();
    check('A: and no new page', f.doc.getPages().length === pages);
    check('A: the canvas marks the draft as a revision', await until(() => exists(page, '[data-testid="revision-label"]'), 5000));
    await page.screenshot({ path: join(shots, 'a-revision-on-canvas.png') });
    await page.click('[data-testid="proposal-discard"]');
    check('A: discarding keeps the record and removes the copy', await until(() => listRevisions(f.doc).every((r) => r.status === 'discarded'), 5000));
    await page.close();
  }

  // ---------------------------------------------------------------- B. comment redo, conflict, identity
  {
    const f = await landing('Comment redo');
    const res = await fetch(`${base}/api/comments`, json({ fileId: f.id, author: 'Lena', pageId: f.pageId, nodeId: f.heading, text: `@claude make this again ${fake({ thread: 'resolve', reply: 'Drafted.' })}` }));
    const { threadId } = await res.json() as { threadId: string };
    check('B: a redo in a comment opens a revision', await until(() => listRevisions(f.doc).some((r) => r.conversation === `thread:${threadId}`), 10_000));
    await until(() => server.runs.list().length === 0, 15_000);
    const rev = listRevisions(f.doc).find((r) => r.conversation === `thread:${threadId}`)!;
    const copy = rev.copies[0]!;
    f.doc.invalidate();
    const copyHeading = f.doc.getChildren(copy).find((n) => n.name === 'Heading')!.id;
    // Both sides change the heading: the person in the original, the draft in its copy.
    f.doc.editText(f.heading, 'Chairs, made slowly', 'Chairs, made slowly in Graz');
    f.doc.updateFields(copyHeading, { text: 'Chairs that last' });
    const page = await openPage(`#/file/${f.id}`);
    await page.waitForSelector('[data-testid="revision-label"]');
    await page.click('[data-testid="proposal-accept"]');
    check('B: accepting shows what changed on both sides', await until(() => exists(page, '[data-testid="proposal-conflicts"]'), 3000));
    await page.screenshot({ path: join(shots, 'b-conflict.png') });
    await page.click('[data-testid="conflict-keep-proposal"]');
    await until(async () => !(await exists(page, '[data-testid="proposal-bar"]')), 5000);
    f.doc.invalidate();
    check('B: the original heading keeps its id and takes the chosen text', f.doc.getNode(f.heading)?.text === 'Chairs that last');
    check('B: the comment is still pinned to it', f.doc.getComments().find((t) => t.id === threadId)?.nodeId === f.heading);
    await page.close();
  }

  // ---------------------------------------------------------------- C. theme candidates and the mobile package
  {
    const entry = server.storage.create('Phone palette');
    const room = await server.rooms.get(entry.id);
    room.doc.transact(() => {
      room.doc.setToken('omarchy-background', 'color', '#141414');
      room.doc.setToken('omarchy-foreground', 'color', '#e8e3d9');
      room.doc.setToken('omarchy-accent', 'color', '#c7a34b');
    });
    const page = await openPage(`#/file/${entry.id}`);
    check('C: a palette-only file asks what it is for', Boolean(await page.waitForSelector('[data-testid="omarchy-theme-candidate"]', { timeout: 5000 }).catch(() => null)));
    await page.click('[data-testid="omarchy-adopt-mobile"]');
    check('C: it becomes a mobile theme', Boolean(await page.waitForSelector('[data-testid="omarchy-theme-banner"][data-target="mobile"]', { timeout: 5000 }).catch(() => null)));
    await page.click('[data-testid="omarchy-theme-open"]');
    await page.waitForSelector('[data-testid="omarchy-theme-dialog"]');
    check('C: the dialog lists what it reaches on the phone', await exists(page, '[data-testid="omarchy-theme-coverage"]'));
    check('C: this desktop offers the package, not install', (await exists(page, '[data-testid="omarchy-theme-elsewhere"]')) && !(await exists(page, '[data-testid="omarchy-install"]')));
    await page.screenshot({ path: join(shots, 'c-mobile-dialog.png') });
    await page.close();

    const made = await (await fetch(`${base}/api/omarchy/themes`, json({ target: 'mobile', name: 'Pocket Dusk' }))).json() as { file_id: string };
    const view = await openPage(`#/file/${made.file_id}`);
    await view.waitForSelector('[data-testid="canvas"]');
    await wait(1500);
    await view.screenshot({ path: join(shots, 'c-mobile-boards.png') });
    await view.close();
    const tar = await fetch(`${base}/api/omarchy/theme/${made.file_id}/export`, json({ to: 'tar' }));
    check('C: the phone package downloads', tar.status === 200 && /pocket-dusk-mobile\.tar\.gz/.test(tar.headers.get('content-disposition') ?? ''));
    const out = join(root, 'package');
    mkdirSync(out);
    writeFileSync(join(out, 'p.tar.gz'), Buffer.from(await tar.arrayBuffer()));
    execFileSync('tar', ['-xzf', 'p.tar.gz'], { cwd: out });
    const pkg = join(out, 'pocket-dusk-mobile');
    check('C: it holds install.sh, the manifest and checksums', ['README.md', 'bogen-theme.json', 'checksums.sha256', 'install.sh', 'theme'].every((f) => readdirSync(pkg).includes(f)));
    mkdirSync(phone, { recursive: true });
    const dry = spawnSync('sh', ['install.sh', '--dry-run'], { cwd: pkg, env: { PATH: '/usr/bin:/bin', HOME: join(root, 'phone-home'), OMAMOBILE_PATH: phone, BOGEN_THEME_DEVICE: 'Google Pixel 9 Pro XL (komodo)' }, encoding: 'utf8' });
    check('C: install.sh dry-runs on a Komodo fixture and writes nothing', dry.status === 0 && /Dry run: nothing was written/.test(dry.stdout), dry.stderr);
    const desk = spawnSync('sh', ['install.sh', '--dry-run'], { cwd: pkg, env: { PATH: '/usr/bin:/bin', HOME: join(root, 'phone-home'), OMAMOBILE_PATH: join(root, 'nowhere') }, encoding: 'utf8' });
    check('C: and refuses a computer', desk.status === 4);
    const home = await openPage('#/');
    check('C: home offers New mobile theme', Boolean(await home.waitForSelector('[data-testid="omarchy-theme-new-mobile"]', { timeout: 5000 }).catch(() => null)));
    await home.close();
  }

  // ---------------------------------------------------------------- F. switching files in the same tab: A → B → A
  {
    const a = await landing('Switch A');
    const b = await landing('Switch B');
    b.doc.updateFields(b.heading, { text: 'This is file B' });
    const consoleErrors: string[] = [];
    const page = await openPage(`#/file/${a.id}`);
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    const shows = (id: string) => page.waitForSelector(`.bogen-world [data-bogen-id="${id}"]`, { timeout: 8000 }).then(() => true, () => false);
    check('F: file A opens', await shows(a.heading));
    await page.evaluate((id) => { location.hash = `#/file/${id}`; }, b.id);
    check('F: the hash moves to file B and its canvas shows B', await shows(b.heading));
    await page.evaluate((id) => { location.hash = `#/file/${id}`; }, a.id);
    check('F: and back to A', await shows(a.heading));
    await wait(300);
    // Edits still reach the file shown: the session is A's, not a destroyed one or B's.
    a.doc.updateFields(a.heading, { text: 'A, after the round trip' });
    check('F: A is live after the round trip', await until(async () => (await page.$eval(`.bogen-world [data-bogen-id="${a.heading}"]`, (e) => e.textContent ?? '').catch(() => '')).includes('round trip'), 5000));
    check('F: no "No file is open" or other errors on the way', !consoleErrors.some((e) => /No file is open/.test(e)) && !errors.some((e) => /No file is open/.test(e)), consoleErrors.join(' | '));
    await page.close();
  }

  // ---------------------------------------------------------------- G. inspector at a breakpoint, fluid, grid, container, sizes
  {
    const entry = server.storage.create('Responsive controls');
    const room = await server.rooms.get(entry.id);
    const { doc } = room;
    const pageId = doc.getPages()[0]!.id;
    const board = doc.insert(pageId, { type: 'frame', name: 'Page', artboard: true, attrs: { 'data-web': 'page' }, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', display: 'flex', flexDirection: 'column', gap: '24px', padding: '48px', background: '#ffffff' } });
    const heading = doc.insert(board, { type: 'text', name: 'Heading', tag: 'h1', text: 'Plates thrown by hand', style: { fontSize: '64px', margin: '0' } });
    const cards = doc.insert(board, { type: 'frame', name: 'Cards', style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '16px' } });
    for (let i = 0; i < 3; i++) doc.insert(cards, { type: 'frame', name: `Card ${i + 1}`, style: { height: '80px', background: '#eeeeee' } });
    const card = doc.insert(board, { type: 'frame', name: 'Feature', style: { width: '480px', padding: '0px' } });
    const featureRow = doc.insert(card, { type: 'frame', name: 'Feature row', style: { display: 'flex', gap: '16px' } });
    const partA = doc.insert(featureRow, { type: 'frame', name: 'Part A', style: { width: '120px', height: '40px', flexShrink: '0', background: '#dddddd' } });
    const partB = doc.insert(featureRow, { type: 'frame', name: 'Part B', style: { width: '120px', height: '40px', flexShrink: '0', background: '#bbbbbb' } });
    const wide = doc.insert(board, { type: 'frame', name: 'Too wide', style: { width: '700px', height: '40px', background: '#cccccc' } });
    doc.invalidate();
    // A 600 px raster photo shown 800 px wide, a small SVG logo shown large, and running text set 1000 px wide.
    const raster = await server.storage.putAsset(solidPng(600, 400), 'image/png');
    const photo = doc.insert(board, { type: 'image', name: 'Photo', src: raster.src, attrs: { alt: 'Plates on a shelf' }, style: { width: '800px', height: '533px', objectFit: 'cover' } });
    const vector = await server.storage.putAsset(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#7a5c3e"/></svg>'), 'image/svg+xml');
    const logo = doc.insert(board, { type: 'image', name: 'Logo', src: vector.src, attrs: { alt: 'Studio mark' }, style: { width: '400px', height: '400px' } });
    const body = doc.insert(board, { type: 'text', name: 'Body', tag: 'p', text: 'Every plate is thrown on the wheel, trimmed the next morning and fired twice, first to bisque and then to 1,260 degrees with a glaze we mix in small batches, so no two plates come out of the kiln quite alike.', style: { width: '1000px', fontSize: '16px', margin: '0' } });
    doc.invalidate();
    const open = async (select: string) => {
      const page = await openPage(`#/file/${entry.id}?select=${select}`);
      await page.waitForSelector('[data-testid="inspector"]', { timeout: 8000 });
      return page;
    };
    const fill = async (page: Page, id: string, value: string) => {
      const el = await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 4000 });
      await el!.click({ count: 3 });
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(value);
      await page.keyboard.press('Enter');
      await wait(150);
    };
    let page = await open(heading);
    await page.click('[data-testid="breakpoint-390"]');
    check('G: the inspector edits at 390', await until(() => exists(page, '[data-testid="breakpoint-bar"][data-breakpoint="390"]'), 3000));
    await fill(page, 'type-size', '32');
    doc.invalidate();
    check('G: a 390 font size goes into its media block only', doc.getNode(heading)!.style.fontSize === '64px' && doc.getNode(heading)!.rules?.['@media (max-width: 390px)']?.fontSize === '32px');
    check('G: the field shows the value at 390', await page.$eval('[data-testid="type-size"]', (e) => (e as HTMLInputElement).value) === '32');
    check('G: the override is listed with what it replaces', (await page.$eval('[data-testid="breakpoint-inherited-font-size"]', (e) => e.textContent ?? '').catch(() => '')).includes('64px from base'));
    await page.screenshot({ path: join(shots, 'g-breakpoint-override.png') });
    await page.click('[data-testid="breakpoint-reset-font-size"]');
    await wait(150);
    doc.invalidate();
    check('G: reset brings back the inherited value', !doc.getNode(heading)!.rules?.['@media (max-width: 390px)']?.fontSize && await until(async () => (await page.$eval('[data-testid="type-size"]', (e) => (e as HTMLInputElement).value)) === '64', 3000));
    await page.click('[data-testid="breakpoint-base"]');
    await page.click('[data-testid="type-fluid-on"]');
    await wait(150);
    doc.invalidate();
    check('G: a size made fluid is a clamp() in rem', /^clamp\(/.test(doc.getNode(heading)!.style.fontSize ?? '') && await exists(page, '[data-testid="type-fluid"][data-fluid="on"]'));
    await page.close();

    page = await open(cards);
    await page.waitForSelector('[data-testid="grid-mode"]');
    const autofit = await page.$$('[data-testid="grid-mode-switch"] button');
    await autofit[1]!.click();
    await wait(150);
    doc.invalidate();
    check('G: Auto-fit writes minmax(min(), 1fr)', /^repeat\(auto-fit, minmax\(min\(16rem, 100%\), 1fr\)\)$/.test(doc.getNode(cards)!.style.gridTemplateColumns ?? ''));
    await page.close();

    page = await open(card);
    await page.waitForSelector('[data-testid="container-toggle"]');
    await page.click('[data-testid="container-toggle"]');
    await wait(150);
    doc.invalidate();
    check('G: a frame becomes a container for its content', doc.getNode(card)!.style.containerType === 'inline-size' && Boolean(doc.getNode(card)!.style.containerName));
    await fill(page, 'container-narrow-width', '300');
    doc.invalidate();
    check('G: the narrow condition goes on the row inside, not on the container', Object.keys(doc.getNode(card)!.rules ?? {}).length === 0 && Object.keys(doc.getNode(featureRow)!.rules ?? {}).some((k) => /^@container [\w-]+ \(max-width: 300px\)$/.test(k)) && doc.getNode(featureRow)!.style.flexDirection === undefined);
    // Layout, measured on the canvas: side by side at 480, stacked when the frame is made 280 wide.
    const tops = () => page.evaluate((a: string, b: string) => {
      const box = (id: string) => document.querySelector(`.bogen-world [data-bogen-id="${id}"]`)!.getBoundingClientRect();
      const ra = box(a);
      const rb = box(b);
      return { sameRow: Math.abs(ra.top - rb.top) < 1, stacked: rb.top >= ra.bottom - 0.5 };
    }, partA, partB);
    check('G: at 480 the parts sit side by side', await until(async () => (await tops()).sameRow, 3000));
    doc.transact(() => doc.updateStyle(card, { width: '280px' }));
    check('G: narrowed to 280 the same parts stack', await until(async () => (await tops()).stacked, 4000));
    await page.screenshot({ path: join(shots, 'g-container-narrow.png') });
    doc.transact(() => doc.updateStyle(card, { width: '480px' }));
    check('G: widened again they sit side by side', await until(async () => (await tops()).sameRow, 4000));
    await page.close();

    page = await open(photo);
    check('G: a 600 px file shown 800 px wide is called blurry', await until(async () => (await page.$eval('[data-testid="image-resolution"]', (e) => `${(e as HTMLElement).dataset.level} ${e.textContent}`).catch(() => '')).startsWith('soft Shown 800 px wide from a 600 px file: blurry'), 5000));
    await page.close();

    page = await open(logo);
    check('G: a 24 px SVG shown 400 px wide is a vector, not blurry', await until(async () => (await page.$eval('[data-testid="image-resolution"]', (e) => (e as HTMLElement).dataset.level).catch(() => '')) === 'vector', 5000));
    await page.close();

    page = await open(body);
    check('G: running text 1000 px wide reads as long lines', await until(async () => (await page.$eval('[data-testid="type-measure"]', (e) => (e as HTMLElement).dataset.level).catch(() => '')) === 'long', 4000));
    await page.click('[data-testid="type-measure-fix"]');
    doc.invalidate();
    check('G: Limit to 65ch sets the measure and the note settles', doc.getNode(body)!.style.maxWidth === '65ch' && await until(async () => (await page.$eval('[data-testid="type-measure"]', (e) => (e as HTMLElement).dataset.level).catch(() => '')) === 'ok', 4000));
    await page.close();

    page = await open(heading);
    await page.click('[data-testid="breakpoint-show-sizes"]');
    await page.waitForSelector('[data-testid="sizes-view"]');
    const cols = await page.$$eval('[data-testid^="sizes-"][data-width]', (els) => els.map((e) => Number((e as HTMLElement).dataset.width)));
    check('G: the same artboard at several widths, no copies', cols.length >= 3 && cols.includes(390) && doc.getPages().length === 1 && doc.getChildren(pageId).length === 1);
    check('G: each width reports what sticks out', await until(() => exists(page, '[data-testid="sizes-over-390"]'), 8000));
    await page.screenshot({ path: join(shots, 'g-sizes.png') });
    // One file at every width: an edit shows up in each frame, from the same revision.
    doc.transact(() => doc.updateFields(heading, { text: 'Plates thrown by hand in Graz' }));
    const framesSay = () => page.$$eval('[data-testid="sizes-view"] iframe', (fs) => fs.map((f) => (f as HTMLIFrameElement).contentDocument?.body?.textContent ?? ''));
    check('G: an edit reaches every width', await until(async () => { const t = await framesSay(); return t.length >= 3 && t.every((x) => x.includes('in Graz')); }, 6000));
    const before = doc.getNode(heading)!.text;
    await page.click('[data-testid="sizes-stress-long"]');
    await wait(800);
    check('G: longer text is a preview only', doc.getNode(heading)!.text === before && (await framesSay()).some((x) => x.length > before!.length + 40));
    await page.screenshot({ path: join(shots, 'g-sizes-stress.png') });
    const findings = await page.$$eval('[data-testid="sizes-issue-390"]', (els) => els.map((e) => e.textContent ?? ''));
    check('G: the wide layer is among the findings at 390', findings.includes('Too wide'));
    const target = findings[0] ?? '';
    await page.click('[data-testid="sizes-issue-390"]');
    check('G: a finding closes the view and selects the layer', Boolean(target) && await until(async () => !(await exists(page, '[data-testid="sizes-view"]')) && (await page.$eval('[data-testid="insp-name"]', (e) => (e as HTMLInputElement).value).catch(() => '')) === target, 4000));
    void wide;
    await page.close();
  }

  // ---------------------------------------------------------------- D. native web patterns in the exported page
  const sections = await (async () => {
    const entry = server.storage.create('Studio site');
    const room = await server.rooms.get(entry.id);
    const { doc } = room;
    const pageId = doc.getPages()[0]!.id;
    // Marked as a web page, as section_insert marks the artboard it fills: its export grows with the window.
    const board = doc.insert(pageId, { type: 'frame', name: 'Home', artboard: true, attrs: { 'data-web': 'page' }, style: { position: 'absolute', left: '0px', top: '0px', width: '1440px', display: 'flex', flexDirection: 'column', background: '#f7f4ef' } });
    // An app screen beside it, which must keep its size in every export.
    const app = doc.insert(pageId, { type: 'frame', name: 'App screen', artboard: true, style: { position: 'absolute', left: '1600px', top: '0px', width: '420px', height: '935px', background: '#111111' } });
    doc.invalidate();
    for (const s of SECTIONS) {
      const { nodes } = importHtml(s.html);
      resolveInstanceRefs(doc, nodes as NewNode[]);
      doc.insertMany(board, nodes as NewNode[]);
      doc.invalidate();
    }
    return { doc, board, app };
  })();
  async function behaviour(page: Page, label: string, rootSelector: string): Promise<void> {
    // On a freshly loaded page, so that nothing has moved the keyboard's starting point yet.
    await page.setViewport({ width: 1440, height: 900 });
    await wait(100);
    await page.keyboard.press('Tab');
    check(`${label}: the first tab stop is the site name`, await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Kiln & Table'));
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    check(`${label}: at 1440 the links show and the menu button does not`, await page.evaluate(() => getComputedStyle(document.querySelector('[popovertarget="site-menu"]')!).display === 'none' && [...document.querySelectorAll('nav[aria-label="Main"] a')].some((a) => (a as HTMLElement).offsetWidth > 0)));
    await page.screenshot({ path: join(shots, `${label}-1440.png`), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    await wait(150);
    check(`${label}: at 390 the navigation folds into the menu button`, await page.evaluate(() => getComputedStyle(document.querySelector('[popovertarget="site-menu"]')!).display !== 'none'));
    check(`${label}: nothing is wider than the window at 390`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    check(`${label}: the page root follows the window, not the 1440 design width`, await page.evaluate((sel) => Math.abs((document.querySelector(sel) as HTMLElement).getBoundingClientRect().width - window.innerWidth) <= 1, rootSelector));
    await page.focus('[popovertarget="site-menu"]');
    await page.keyboard.press('Enter');
    check(`${label}: the menu opens from the keyboard`, await page.evaluate(() => document.getElementById('site-menu')!.matches(':popover-open')));
    await page.screenshot({ path: join(shots, `${label}-390-menu.png`) });
    await page.keyboard.press('Escape');
    check(`${label}: Escape closes it`, await page.evaluate(() => !document.getElementById('site-menu')!.matches(':popover-open')));
    const second = await page.$$('details[name="faq"] > summary');
    await second[1]!.click();
    check(`${label}: the accordion keeps one answer open`, await page.evaluate(() => {
      const d = [...document.querySelectorAll('details[name="faq"]')] as HTMLDetailsElement[];
      return !d[0]!.open && d[1]!.open;
    }));
    await page.click('[popovertarget="shipping-note"]');
    check(`${label}: the dialog opens`, await page.evaluate(() => document.getElementById('shipping-note')!.matches(':popover-open')));
    await page.screenshot({ path: join(shots, `${label}-390-dialog.png`) });
    await page.keyboard.press('Escape');
    check(`${label}: Escape closes the dialog`, await page.evaluate(() => !document.getElementById('shipping-note')!.matches(':popover-open')));
  }
  {
    const html = new TextDecoder().decode((await exportTarget(sections.doc, server.renderer, server.storage, { nodeIds: [sections.board] }, 'html')).bytes);
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`export: ${String(e)}`));
    await page.setContent(html, { waitUntil: 'load' });
    await behaviour(page, 'D-export', 'body > :not(style):not(script)');
    await page.close();
  }

  // ---------------------------------------------------------------- E. the React handoff, compiled and rendered
  {
    const code = toReact(sections.doc, sections.board, 'inline');
    const name = /export (?:default )?function (\w+)/.exec(code)?.[1];
    check('E: the export is a named React component', Boolean(name));
    const appCode = toReact(sections.doc, sections.app, 'inline');
    check('E: an app screen exports at its own size, not as a web page', /width: "420px"/.test(appCode) && /height: "935px"/.test(appCode) && !/maxWidth/.test(appCode));
    const dir = join(root, 'react-app');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Page.tsx'), code);
    writeFileSync(join(dir, 'main.tsx'), `import { createRoot } from 'react-dom/client';\nimport { ${name} as Page } from './Page.tsx';\ncreateRoot(document.getElementById('root')!).render(<Page />);\n`);
    const require = createRequire(join(repo, 'package.json'));
    const bundle = await build({
      entryPoints: [join(dir, 'main.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', logLevel: 'silent',
      nodePaths: [dirname(dirname(require.resolve('react/package.json')))], define: { 'process.env.NODE_ENV': '"production"' },
    });
    check('E: it compiles with esbuild against react and react-dom', bundle.errors.length === 0);
    const tsc = spawnSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--jsx', 'react-jsx', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--skipLibCheck', '--allowImportingTsExtensions', '--types', 'react,react-dom', '--typeRoots', join(repo, 'node_modules', '@types'), join(dir, 'Page.tsx')], { encoding: 'utf8' });
    check('E: it passes a strict TypeScript check, as in a typed React project', tsc.status === 0, tsc.stdout.slice(0, 600));
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`react: ${String(e)}`));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`, { waitUntil: 'load' });
    await page.waitForSelector('[popovertarget="site-menu"]');
    check('E: aria-current survives into React', await page.evaluate(() => Boolean(document.querySelector('a[aria-current="page"]'))));
    check('E: the menu is a popover in the rendered DOM', await page.evaluate(() => document.getElementById('site-menu')?.getAttribute('popover') === 'auto'));
    await behaviour(page, 'E-react', '#root > :not(style)');
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

check('no page errors', errors.length === 0, errors.join('\n'));
console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${shots}`);
if (failures.length) {
  console.log(`Failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else if (!process.env.KEEP) rmSync(join(root, 'bogen'), { recursive: true, force: true });

/** A solid-colour RGB PNG of the given size: a real raster file, decoded by the browser like any photo. */
function solidPng(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([0xc9, 0xb8, 0xa0], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
