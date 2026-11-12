/**
 * What a designer coming from Figma reaches for first: layout grids, find and replace, renaming in bulk, frame
 * presets, matching layers, spacing between layers, token swatches and mixed values. Real mouse and keyboard,
 * a real server, a second peer on the same file to see that each change syncs, and Ctrl+Z for each.
 */
import type { Page } from 'puppeteer-core';
import type { BogenDoc } from '@bogen/core';
import { sleep } from './craft-harness.ts';
import { canvasBox, fillField, layerRect, pressKey, shot } from './harness.ts';
import type { T } from './craft.ts';

const selectedIds = (page: Page) => page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.map((x) => x.getAttribute('data-layer') ?? ''));
const count = (page: Page, sel: string) => page.$$eval(sel, (e) => e.length);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => e.textContent ?? '');

function artboard(doc: BogenDoc, pageId: string, name: string, x: number, y: number, w: number, h: number, style: Record<string, string> = {}): string {
  return doc.insert(pageId, { type: 'frame', name, artboard: true, style: { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, backgroundColor: '#ffffff', overflow: 'hidden', ...style } });
}

async function clickLayer(page: Page, id: string, shift = false): Promise<void> {
  const r = await layerRect(page, id);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(r.x + Math.min(6, r.w / 2), r.y + Math.min(6, r.h / 2));
  if (shift) await page.keyboard.up('Shift');
  await sleep(60);
}

async function selectArtboard(page: Page, id: string): Promise<void> {
  await page.click(`[data-frame-label="${id}"]`);
  await sleep(80);
}

async function palette(page: Page, query: string): Promise<void> {
  await pressKey(page, 'Control+p');
  await page.waitForSelector('[data-testid="palette-input"]');
  await page.keyboard.type(query);
  await sleep(80);
  await page.keyboard.press('Enter');
  await sleep(120);
}

async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(30);
  }
  return false;
}

async function grids50(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Grids');
  const board = artboard(doc, pageId, 'Desktop', 0, 0, 1440, 900);
  const box = doc.insert(board, { type: 'frame', name: 'Box', style: { position: 'absolute', left: '300px', top: '300px', width: '200px', height: '100px', backgroundColor: '#222' } });
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  await selectArtboard(page, board);
  // Keyboard: the palette adds 12 columns to a desktop frame.
  await palette(page, 'add layout grid columns');
  t.check('50 the palette adds a column grid, stored in the file and synced', await until(() => doc.getNode(board)?.layoutGrids?.[0]?.count === 12), doc.getNode(board)?.layoutGrids);
  t.check('50 twelve columns show on the canvas', await until(async () => (await count(page, '[data-testid="layout-grid-track"]')) === 12), await count(page, '[data-testid="layout-grid-track"]'));
  t.check('50 the inspector describes it', (await text(page, '[data-testid="grid-summary-0"]')) === '12 columns, gutter 24, margin 80', await text(page, '[data-testid="grid-summary-0"]'));
  // The first column starts at the margin.
  const ab = await layerRect(page, board);
  const first = await page.$eval('[data-testid="layout-grid-track"]', (e) => e.getBoundingClientRect().toJSON() as DOMRect);
  const z = ab.w / 1440;
  t.check('50 the first column sits at the margin', Math.abs(first.x - (ab.x + 80 * z)) < 1.5, { first: first.x, want: ab.x + 80 * z });
  await shot(page, 'craft-50-columns');

  // Mouse and keyboard in the inspector: open the values, set 6 columns.
  await page.click('[data-testid="grid-toggle-0"]');
  await fillField(page, 'grid-count-0', '6');
  t.check('50 the count field changes the grid', await until(async () => (await count(page, '[data-testid="layout-grid-track"]')) === 6) && doc.getNode(board)?.layoutGrids?.[0]?.count === 6);
  await pressKey(page, 'Control+z');
  t.check('50 Ctrl+Z takes it back to 12', await until(() => doc.getNode(board)?.layoutGrids?.[0]?.count === 12), { grids: doc.getNode(board)?.layoutGrids, focus: await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute('data-testid')}`) });
  // A peer changes it: the canvas follows.
  doc.updateFields(board, { layoutGrids: [{ kind: 'columns', count: 4, gutter: 20, margin: 0, align: 'stretch' }] });
  t.check('50 a change from another device shows', await until(async () => (await count(page, '[data-testid="layout-grid-track"]')) === 4));

  // Moving a layer snaps to a column edge. Column 2 of 4 over 1440 with gutter 20 starts at 365.
  await clickLayer(page, box);
  const br = await layerRect(page, box);
  const target = ab.x + 362 * z;
  await page.mouse.move(br.x + 10, br.y + 10);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(br.x + 10 + ((target - br.x) * i) / 8, br.y + 10, { steps: 1 });
  await page.mouse.up();
  await sleep(80);
  t.check('50 a moved layer snaps to the column edge', doc.getNode(box)?.style.left === '365px', doc.getNode(box)?.style.left);

  // Hide and show all grids.
  await pressKey(page, 'Control+Shift+4');
  t.check('50 Ctrl+Shift+4 hides the grids', await until(async () => (await count(page, '[data-testid="layout-grid-track"]')) === 0));
  await pressKey(page, 'Control+Shift+4');
  t.check('50 and shows them again', await until(async () => (await count(page, '[data-testid="layout-grid-track"]')) === 4));
  // The plus button adds rows with the mouse; the minus removes one.
  await selectArtboard(page, board);
  await page.click('[data-testid="grid-add"]');
  t.check('50 the plus adds a second grid, of rows', await until(() => doc.getNode(board)?.layoutGrids?.[1]?.kind === 'rows'));
  await page.click('[data-testid="grid-remove-1"]');
  t.check('50 the minus removes it', await until(() => doc.getNode(board)?.layoutGrids?.length === 1));
  t.check('50 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

async function replace51(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Replace');
  const a = artboard(doc, pageId, 'One', 0, 0, 600, 400);
  const t1 = doc.insert(a, { type: 'text', tag: 'h1', text: 'Book a table', spans: [{ start: 7, end: 12, style: { fontWeight: '700' } }], style: { position: 'absolute', left: '20px', top: '20px', fontSize: '32px' } });
  const t2 = doc.insert(a, { type: 'text', tag: 'p', text: 'book now, notebook', style: { position: 'absolute', left: '20px', top: '90px' } });
  const p2 = doc.createPage('Two');
  const b = artboard(doc, p2, 'Two', 0, 0, 600, 400);
  const t3 = doc.insert(b, { type: 'text', tag: 'p', text: 'Book online', style: { position: 'absolute', left: '20px', top: '20px' } });
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  await page.mouse.click((await canvasBox(page)).x + 700, (await canvasBox(page)).y + 500);
  await pressKey(page, 'Control+h');
  await page.waitForSelector('[data-testid="replace-input"]');
  await page.keyboard.type('book');
  await sleep(120);
  t.check('51 Ctrl+H opens find and replace, counting text layers on this page', (await text(page, '[data-testid="find-count"]')) === '1 of 2', await text(page, '[data-testid="find-count"]'));
  await page.click('[data-testid="find-wholeWord"]');
  await page.click('[data-testid="find-allPages"]');
  await sleep(80);
  t.check('51 all pages and whole words', (await text(page, '[data-testid="find-count"]')) === '1 of 3', await text(page, '[data-testid="find-count"]'));
  await shot(page, 'craft-51-replace');
  await page.click('[data-testid="replace-input"]');
  await page.keyboard.type('Reserve');
  // Enter goes to the first match, Enter again replaces in it.
  await page.keyboard.press('Enter');
  await sleep(80);
  await page.keyboard.press('Enter');
  t.check('51 Enter replaces in the current match', await until(() => doc.getNode(t1)?.text === 'Reserve a table'), doc.getNode(t1)?.text);
  t.check('51 and goes on to the next match', await until(async () => (await selectedIds(page))[0] === t2), await selectedIds(page));
  t.check('51 the bold range stays on its word', JSON.stringify(doc.getNode(t1)?.spans) === JSON.stringify([{ start: 10, end: 15, style: { fontWeight: '700' } }]), doc.getNode(t1)?.spans);
  // Ctrl+Enter replaces the rest, across pages, as one step.
  await page.click('[data-testid="replace-input"]');
  await pressKey(page, 'Control+Enter');
  t.check('51 Ctrl+Enter replaces all, on every page, words only', await until(() => doc.getNode(t3)?.text === 'Reserve online' && doc.getNode(t2)?.text === 'Reserve now, notebook'), [doc.getNode(t2)?.text, doc.getNode(t3)?.text]);
  await page.mouse.click((await canvasBox(page)).x + 700, (await canvasBox(page)).y + 500);
  await pressKey(page, 'Control+z');
  t.check('51 one Ctrl+Z takes back the whole replace all', await until(() => doc.getNode(t3)?.text === 'Book online' && doc.getNode(t2)?.text === 'book now, notebook') && doc.getNode(t1)?.text === 'Reserve a table', [doc.getNode(t1)?.text, doc.getNode(t2)?.text, doc.getNode(t3)?.text]);
  // The mouse: Replace and All buttons.
  await pressKey(page, 'Control+h');
  await page.click('[data-testid="replace-all"]');
  t.check('51 the All button replaces too', await until(() => doc.getNode(t3)?.text === 'Reserve online'));
  t.check('51 the palette offers it', (await (async () => { await pressKey(page, 'Escape'); await pressKey(page, 'Control+p'); await page.keyboard.type('find and replace'); await sleep(60); return page.$eval('[data-testid="palette-row"][aria-selected="true"] .palette-title', (e) => e.textContent); })()) === 'Find and replace text');
  await pressKey(page, 'Escape');
  t.check('51 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

async function rename52(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Rename');
  const a = artboard(doc, pageId, 'Cards', 0, 0, 900, 400);
  const cards = [0, 1, 2].map((i) => doc.insert(a, { type: 'frame', name: `Frame ${i + 7}`, style: { position: 'absolute', left: `${40 + (2 - i) * 260}px`, top: '40px', width: '200px', height: '120px', backgroundColor: '#eee' } }));
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  for (const [i, id] of cards.entries()) await clickLayer(page, id, i > 0);
  await pressKey(page, 'Control+r');
  await page.waitForSelector('[data-testid="rename-dialog"]');
  t.check('52 Ctrl+R with three layers opens bulk rename', true);
  await page.click('[data-testid="rename-pattern"]', { count: 3 });
  await page.keyboard.type('Card $n');
  await sleep(60);
  const preview = await page.$$eval('[data-testid="rename-preview"] b', (e) => e.map((x) => x.textContent));
  t.check('52 the preview numbers them in reading order', JSON.stringify(preview) === JSON.stringify(['Card 1', 'Card 2', 'Card 3']), preview);
  await shot(page, 'craft-52-rename');
  await page.keyboard.press('Enter');
  t.check('52 Enter renames, left to right on the canvas', await until(() => doc.getNode(cards[2]!)?.name === 'Card 1' && doc.getNode(cards[0]!)?.name === 'Card 3'), cards.map((id) => doc.getNode(id)?.name));
  t.check('52 the dialog closes', (await page.$('[data-testid="rename-dialog"]')) === null);
  await pressKey(page, 'Control+z');
  t.check('52 one Ctrl+Z restores every name', await until(() => cards.every((id, i) => doc.getNode(id)?.name === `Frame ${i + 7}`)), cards.map((id) => doc.getNode(id)?.name));
  // Find and replace inside names, through the palette and the mouse.
  await palette(page, 'rename layers in bulk');
  await page.waitForSelector('[data-testid="rename-find"]');
  await page.click('[data-testid="rename-find"]');
  await page.keyboard.type('frame');
  await page.click('[data-testid="rename-replace"]');
  await page.keyboard.type('Tile');
  await page.click('[data-testid="rename-apply"]');
  t.check('52 find and replace in names, from the palette, applied with the button', await until(() => doc.getNode(cards[0]!)?.name === 'Tile 7'), doc.getNode(cards[0]!)?.name);
  // One layer still renames in place.
  await clickLayer(page, cards[0]!);
  await pressKey(page, 'Control+r');
  t.check('52 with one layer Ctrl+R renames in the list', (await page.$('[data-testid="layer-rename"]')) !== null && (await page.$('[data-testid="rename-dialog"]')) === null);
  await pressKey(page, 'Escape');
  t.check('52 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

async function presets53(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Presets');
  const a = artboard(doc, pageId, 'Screen', 0, 0, 393, 852);
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  await selectArtboard(page, a);
  const shown = await page.$eval('[data-testid="insp-preset"]', (e) => (e as HTMLSelectElement).value);
  t.check('53 the inspector names the preset of an artboard', shown === 'Phone', shown);
  await page.select('[data-testid="insp-preset"]', 'iPhone SE');
  t.check('53 choosing a preset resizes it', await until(() => doc.getNode(a)?.style.width === '375px' && doc.getNode(a)?.style.height === '667px'), doc.getNode(a)?.style);
  await page.click('[data-testid="insp-orientation"]');
  t.check('53 the orientation button swaps width and height', await until(() => doc.getNode(a)?.style.width === '667px' && doc.getNode(a)?.style.height === '375px'), doc.getNode(a)?.style);
  await sleep(60);
  t.check('53 and it still knows the preset, on its side', (await page.$eval('[data-testid="insp-preset"]', (e) => (e as HTMLSelectElement).value)) === 'iPhone SE');
  await pressKey(page, 'Control+z');
  await pressKey(page, 'Control+z');
  t.check('53 Ctrl+Z twice is back to the phone', await until(() => doc.getNode(a)?.style.width === '393px'), doc.getNode(a)?.style.width);
  await palette(page, 'swap width and height');
  t.check('53 the palette swaps too', await until(() => doc.getNode(a)?.style.width === '852px'));
  await palette(page, 'new artboard pixel 9');
  const made = (await selectedIds(page))[0];
  t.check('53 the palette makes a device artboard', made !== undefined && doc.getNode(made)?.style.width === '412px' && doc.getNode(made)?.style.height === '923px', made && doc.getNode(made)?.style);
  await pressKey(page, 'f');
  await sleep(60);
  const groups = await page.$$eval('.preset-group', (e) => e.map((x) => x.textContent));
  t.check('53 the frame tool lists sizes by kind', groups.includes('Phone') && groups.includes('Watch') && groups.includes('Print'), groups);
  await shot(page, 'craft-53-frame-tool');
  await pressKey(page, 'Escape');
  t.check('53 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

async function matching54(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Matching');
  const a = artboard(doc, pageId, 'Board', 0, 0, 900, 500);
  const card = (x: number, y: number, bg: string, words: string) => doc.insert(a, { type: 'frame', name: 'Card', style: { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${150 + x / 10}px`, height: '100px', backgroundColor: bg, borderRadius: '8px' }, children: [{ type: 'text', tag: 'p', text: words, style: { fontSize: '14px' } }] });
  const c1 = card(20, 20, '#eee', 'One');
  const c2 = card(300, 200, '#eee', 'Another one');
  const c3 = card(600, 20, '#333', 'Three');
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  await clickLayer(page, c1);
  const before = await selectedIds(page);
  await pressKey(page, 'Control+Alt+a');
  await sleep(80);
  const after = await selectedIds(page);
  t.check('54 Ctrl+Alt+A selects the layers that look the same', before.length === 1 && after.length === 2 && after.includes(c2) && !after.includes(c3), { before, after });
  await clickLayer(page, c3);
  await page.mouse.click((await layerRect(page, c3)).x + 5, (await layerRect(page, c3)).y + 5, { button: 'right' });
  await page.waitForSelector('[data-testid="context-menu"]');
  const items = await page.$$eval('[data-testid="context-menu"] button', (e) => e.map((x) => x.textContent ?? ''));
  t.check('54 the context menu has it', items.some((i) => i.startsWith('Select matching layers')), items);
  await pressKey(page, 'Escape');
  t.check('54 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

async function spacing55(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Spacing');
  const a = artboard(doc, pageId, 'Row', 0, 0, 1000, 400);
  const items = [0, 1, 2].map((i) => doc.insert(a, { type: 'frame', name: `Item ${i}`, style: { position: 'absolute', left: `${40 + i * 120}px`, top: '100px', width: '100px', height: '100px', backgroundColor: '#ccc' } }));
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  for (const [i, id] of items.entries()) await clickLayer(page, id, i > 0);
  await sleep(100);
  t.check('55 even spacing shows a handle in each gap', (await count(page, '[data-testid="spacing-handle-x"]')) === 2, await count(page, '[data-testid="spacing-handle-x"]'));
  t.check('55 the inspector shows the spacing', (await page.$eval('[data-testid="insp-spacing-x"]', (e) => (e as HTMLInputElement).value)) === '20');
  // Drag a handle: every gap follows, the first layer stays.
  const ab = await layerRect(page, a);
  const z = ab.w / 1000;
  const h = await page.$eval('[data-testid="spacing-handle-x"]', (e) => e.getBoundingClientRect().toJSON() as DOMRect);
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(h.x + h.width / 2 + (30 * z * i) / 6, h.y + h.height / 2);
  await sleep(60);
  t.check('55 the gap shows while dragging', (await text(page, '[data-testid="spacing-label"]').catch(() => '')) === '50', await text(page, '[data-testid="spacing-label"]').catch(() => ''));
  await shot(page, 'craft-55-spacing-drag');
  await page.mouse.up();
  await sleep(80);
  const lefts = () => items.map((id) => doc.getNode(id)?.style.left);
  t.check('55 dragging sets every gap to 50', JSON.stringify(lefts()) === JSON.stringify(['40px', '190px', '340px']), lefts());
  await pressKey(page, 'Control+z');
  t.check('55 one Ctrl+Z undoes the whole drag', await until(() => JSON.stringify(lefts()) === JSON.stringify(['40px', '160px', '280px'])), lefts());
  // Keyboard: the palette puts the cursor in the field.
  await palette(page, 'set horizontal spacing');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
  t.check('55 the palette focuses the spacing field', focused === 'insp-spacing-x', focused);
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  t.check('55 typing a spacing sets it', await until(() => JSON.stringify(lefts()) === JSON.stringify(['40px', '148px', '256px'])), lefts());
  // Ragged spacing: mixed in the field, no handles.
  doc.updateStyle(items[2]!, { left: '400px' });
  await sleep(120);
  t.check('55 uneven spacing shows as mixed, without handles', (await page.$eval('[data-testid="insp-spacing-x"]', (e) => (e as HTMLInputElement).value)) === '' && (await count(page, '[data-testid="spacing-handle-x"]')) === 0);
  t.check('55 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

async function swatches56(t: T): Promise<void> {
  const { fileId, doc, pageId, close } = await t.newFile('Swatches');
  doc.setToken('brand', 'color', '#ff3366');
  doc.setToken('surface', 'color', 'var(--brand)');
  const a = artboard(doc, pageId, 'Board', 0, 0, 600, 400, { backgroundColor: 'var(--surface)' });
  const g1 = doc.insert(a, { type: 'frame', name: 'Grid A', style: { position: 'absolute', left: '20px', top: '20px', width: '200px', height: '100px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } });
  const g2 = doc.insert(a, { type: 'frame', name: 'Grid B', style: { position: 'absolute', left: '300px', top: '20px', width: '200px', height: '100px', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' } });
  await sleep(100);
  const { page, errors } = await t.open(fileId);
  await selectArtboard(page, a);
  const bg = await page.$eval('[data-testid="fill-swatch-0"] .swatch-fill', (e) => getComputedStyle(e).backgroundColor);
  t.check('56 a fill bound to a token shows the token colour, through an alias', bg === 'rgb(255, 51, 102)', bg);
  await clickLayer(page, g1);
  await clickLayer(page, g2, true);
  const cols = await page.$eval('[data-testid="insp-grid-cols"]', (e) => (e as HTMLInputElement).value);
  const tpl = await page.$eval('[data-testid="insp-grid-template-cols"]', (e) => (e as HTMLInputElement).placeholder);
  t.check('56 two grids with different columns show as mixed', cols === '' && tpl === 'Mixed', { cols, tpl });
  await fillField(page, 'insp-grid-cols', '3');
  t.check('56 setting the mixed field sets both', await until(() => doc.getNode(g1)?.style.gridTemplateColumns === 'repeat(3, minmax(0, 1fr))' && doc.getNode(g2)?.style.gridTemplateColumns === 'repeat(3, minmax(0, 1fr))'));
  t.check('56 no page errors', errors.length === 0, errors);
  await page.close();
  close();
}

export const figmaSections: [string, (t: T) => Promise<void>][] = [
  ['50', grids50],
  ['51', replace51],
  ['52', rename52],
  ['53', presets53],
  ['54', matching54],
  ['55', spacing55],
  ['56', swatches56],
];
