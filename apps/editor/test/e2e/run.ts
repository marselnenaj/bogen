/**
 * End to end checks through the real UI: real mouse and keyboard in Chromium, against the built editor
 * and a mock server that speaks the contract. Run: npx tsx apps/editor/test/e2e/run.ts [section...]
 */
import { resolve } from 'node:path';
import type { Page } from 'puppeteer-core';
import { allNodes, canvasBox, check, clickTest, docOf, drag, fillField, layerRect, newFilePage, paste, pressKey, setup, shot, sleep, summary, teardown, watchErrors, type Ctx } from './harness.ts';
import { px } from '../../src/lib/css-values.ts';

const only = process.argv.slice(2);
const want = (name: string) => !only.length || only.includes(name);

async function home(ctx: Ctx): Promise<void> {
  const page = await ctx.browser.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);
  await page.goto(`${ctx.base}/#/`);
  await page.waitForSelector('[data-testid="home"]');
  await sleep(150);
  await shot(page, 'home-empty');
  check(ctx, 'home: empty state says something', (await page.$eval('[data-testid="home"]', (e) => e.textContent ?? '')).includes('No files yet'));

  await clickTest(page, 'home-new');
  await page.waitForSelector('[data-testid="canvas"]');
  check(ctx, 'home: new goes to file by hash', /#\/file\//.test(page.url()), page.url());
  await clickTest(page, 'home-link');
  await page.waitForSelector('[data-testid="file"]');
  check(ctx, 'home: lists the file', (await page.$$('[data-testid="file"]')).length === 1);

  await page.hover('[data-testid="file"]');
  await clickTest(page, 'file-menu');
  await clickTest(page, 'file-action-rename');
  await page.waitForSelector('[data-testid="file-rename-input"]');
  await page.keyboard.type('Landing page');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-file-name="Landing page"]');
  check(ctx, 'home: rename', true);

  await page.hover('[data-testid="file"]');
  await clickTest(page, 'file-menu');
  await clickTest(page, 'file-action-duplicate');
  await sleep(100);
  check(ctx, 'home: duplicate', (await page.$$('[data-testid="file"]')).length === 2);

  await page.click('[data-testid="home-search"]');
  await page.keyboard.type('copy');
  await sleep(50);
  check(ctx, 'home: search filters', (await page.$$('[data-testid="file"]')).length === 1);
  await shot(page, 'home-search');
  await page.keyboard.press('Escape');
  await sleep(50);

  const first = await page.$('[data-file-name="Landing page copy"]');
  await first!.hover();
  const menu = await first!.$('[data-testid="file-menu"]');
  await menu!.click();
  await clickTest(page, 'file-action-delete');
  await clickTest(page, 'file-action-delete-confirm');
  await sleep(100);
  check(ctx, 'home: delete', (await page.$$('[data-testid="file"]')).length === 1);
  await shot(page, 'home');
  check(ctx, 'home: no page errors', errors.length === 0, errors);
  await page.close();
}

async function canvas(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Canvas');
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(page);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  await shot(page, 'editor-empty');

  // Frame
  await pressKey(page, 'f');
  await sleep(40);
  await shot(page, 'frame-tool');
  await drag(page, cx - 300, cy - 200, cx + 100, cy + 100);
  let nodes = allNodes(doc);
  const frame = nodes[0];
  check(ctx, 'tools: frame drawn as artboard', nodes.length === 1 && Boolean(frame?.artboard) && frame?.style.position === 'absolute', nodes);
  check(ctx, 'tools: frame size is the drag', px(frame?.style.width) === 400 && px(frame?.style.height) === 300, frame?.style);
  const frameId = frame!.id;

  // Text inside it
  await pressKey(page, 't');
  await page.mouse.click(cx - 200, cy - 100);
  await sleep(60);
  await page.keyboard.type('Hello Bogen');
  await sleep(50);
  await shot(page, 'text-editing');
  await page.keyboard.press('Escape');
  await sleep(50);
  nodes = allNodes(doc);
  const text = nodes.find((n) => n.type === 'text');
  check(ctx, 'tools: text typed inline', text?.text === 'Hello Bogen', text);
  check(ctx, 'tools: text is inside the frame', text?.parent === frameId, text?.parent);

  // Selection depth: a click selects the child of the top frame.
  await page.mouse.click(cx + 50, cy + 50);
  await sleep(30);
  await pressKey(page, 'Escape');
  await page.mouse.click(box.x + 20, box.y + 20);
  await sleep(30);
  const sel = () => page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.map((x) => x.getAttribute('data-layer')));
  check(ctx, 'selection: click on empty clears', (await sel()).length === 0);
  await page.mouse.click(cx + 50, cy + 50);
  await sleep(30);
  check(ctx, 'selection: click on frame body selects it', (await sel())[0] === frameId, await sel());

  // Resize with the SE handle.
  const r0 = await layerRect(page, frameId);
  await drag(page, r0.x + r0.w, r0.y + r0.h, r0.x + r0.w + 80, r0.y + r0.h + 40);
  const f1 = doc.getNode(frameId)!;
  check(ctx, 'transform: resize by handle', px(f1.style.width) === 480 && px(f1.style.height) === 340, f1.style);

  // Undo is one step, redo restores.
  await pressKey(page, 'Control+z');
  await sleep(40);
  const f2 = doc.getNode(frameId)!;
  check(ctx, 'edit: undo reverts the whole drag in one step', px(f2.style.width) === 400 && px(f2.style.height) === 300, f2.style);
  await pressKey(page, 'Control+Shift+z');
  await sleep(40);
  check(ctx, 'edit: redo', px(doc.getNode(frameId)!.style.width) === 480);
  await pressKey(page, 'Control+z');
  await sleep(40);

  // Shift keeps the ratio.
  const r1 = await layerRect(page, frameId);
  await page.mouse.move(r1.x + r1.w, r1.y + r1.h);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(r1.x + r1.w + 100, r1.y + r1.h + 10, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await sleep(30);
  const f3 = doc.getNode(frameId)!;
  check(ctx, 'transform: shift keeps ratio', Math.abs(px(f3.style.width) / px(f3.style.height) - 400 / 300) < 0.02, f3.style);
  await pressKey(page, 'Control+z');

  // Alt from centre.
  await sleep(30);
  const r2 = await layerRect(page, frameId);
  await page.mouse.move(r2.x + r2.w, r2.y + r2.h);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(r2.x + r2.w + 50, r2.y + r2.h + 20, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(30);
  const f4 = doc.getNode(frameId)!;
  check(ctx, 'transform: alt resizes from centre', Math.abs(px(f4.style.width) - 500) < 2 && Math.abs(px(f4.style.left) - (px(frame!.style.left) - 50)) < 2, f4.style);
  await pressKey(page, 'Control+z');
  await sleep(30);

  // Move and nudge.
  const before = doc.getNode(frameId)!;
  const mid = await layerRect(page, frameId);
  await drag(page, mid.x + 300, mid.y + 250, mid.x + 340, mid.y + 280);
  let after = doc.getNode(frameId)!;
  check(ctx, 'transform: move', Math.abs(px(after.style.left) - px(before.style.left) - 40) <= 8 && Math.abs(px(after.style.top) - px(before.style.top) - 30) <= 8, after.style);
  const left = px(after.style.left);
  await pressKey(page, 'ArrowRight');
  await pressKey(page, 'Shift+ArrowDown');
  after = doc.getNode(frameId)!;
  check(ctx, 'transform: nudge', px(after.style.left) === left + 1, after.style);

  // Rotate.
  await sleep(20);
  const handle = await page.$('.ov-rotate-handle');
  const hb = await handle!.boundingBox();
  const rr = await layerRect(page, frameId);
  await drag(page, hb!.x + 4, hb!.y + 4, rr.x + rr.w + 40, rr.y + rr.h / 2);
  after = doc.getNode(frameId)!;
  check(ctx, 'transform: rotate handle', Math.abs(parseFloat(after.style.rotate ?? '0') - 90) < 8, after.style.rotate);
  await sleep(30);
  await shot(page, 'rotated');
  // Rotated resize keeps the opposite corner in place.
  const se = await page.$('.ov-handle-se');
  const seBox = await se!.boundingBox();
  const nw = await page.$('.ov-handle-nw');
  const nwBefore = await nw!.boundingBox();
  await drag(page, seBox!.x + 4, seBox!.y + 4, seBox!.x - 30, seBox!.y + 50);
  const nwAfter = await (await page.$('.ov-handle-nw'))!.boundingBox();
  check(ctx, 'transform: rotated resize holds the opposite corner', Math.abs(nwBefore!.x - nwAfter!.x) < 2 && Math.abs(nwBefore!.y - nwAfter!.y) < 2, { nwBefore, nwAfter });
  await pressKey(page, 'Control+z');
  await pressKey(page, 'Control+z');
  await sleep(30);

  // Alt-drag duplicates.
  const countBefore = allNodes(doc).length;
  const rd = await layerRect(page, frameId);
  await page.mouse.move(rd.x + 300, rd.y + 250);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(rd.x + 800, rd.y + 250, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await sleep(50);
  check(ctx, 'transform: alt-drag duplicates the subtree', allNodes(doc).length === countBefore + 2, allNodes(doc).length);
  await pressKey(page, 'Control+z');
  await sleep(40);
  check(ctx, 'transform: alt-drag duplicate undoes in one step', allNodes(doc).length === countBefore);

  // Zoom and pan.
  const zoom = () => page.$eval('[data-testid="zoom-level"]', (e) => e.textContent);
  const worldT = () => page.$eval('.bogen-world', (e) => (e as HTMLElement).style.transform);
  const t0 = await worldT();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel({ deltaX: 30, deltaY: 40 });
  await sleep(30);
  check(ctx, 'canvas: wheel pans', (await worldT()) !== t0);
  await pressKey(page, 'Shift+Digit0');
  check(ctx, 'canvas: shift+0 is 100%', (await zoom()) === '100%', await zoom());
  await pressKey(page, '=');
  check(ctx, 'canvas: + zooms in', (await zoom()) === '150%', await zoom());
  await pressKey(page, '-');
  await pressKey(page, '-');
  check(ctx, 'canvas: - zooms out', (await zoom()) === '75%', await zoom());
  await pressKey(page, 'Shift+Digit1');
  await sleep(20);
  const zf = await zoom();
  check(ctx, 'canvas: shift+1 fits', zf !== null, zf);
  await page.keyboard.down('Control');
  await page.mouse.wheel({ deltaY: -100 });
  await page.keyboard.up('Control');
  await sleep(30);
  check(ctx, 'canvas: ctrl+wheel zooms', (await zoom()) !== zf, await zoom());

  // Space pan.
  const t1 = await worldT();
  await page.keyboard.down('Space');
  await drag(page, cx, cy, cx + 50, cy + 20);
  await page.keyboard.up('Space');
  check(ctx, 'canvas: space drag pans', (await worldT()) !== t1);
  // Middle mouse pan.
  const t2 = await worldT();
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 30, cy + 30, { steps: 3 });
  await page.mouse.up({ button: 'middle' });
  check(ctx, 'canvas: middle mouse pans', (await worldT()) !== t2);
  // H tool.
  await pressKey(page, 'h');
  const t3 = await worldT();
  await drag(page, cx, cy, cx - 30, cy - 10);
  check(ctx, 'canvas: H tool pans', (await worldT()) !== t3);
  await pressKey(page, 'v');
  // Pixel grid above 600%.
  await page.evaluate(() => void 0);
  await pressKey(page, 'Shift+Digit0');
  for (let i = 0; i < 6; i++) await pressKey(page, '=');
  await sleep(30);
  check(ctx, 'canvas: pixel grid at high zoom', (await page.$('.ov-grid')) !== null, await zoom());
  await shot(page, 'pixel-grid');
  await pressKey(page, 'Shift+Digit1');
  await sleep(30);
  check(ctx, 'canvas: no pixel grid when fitted', (await page.$('.ov-grid')) === null);

  // Z tool: click zooms in.
  await pressKey(page, 'z');
  const zb = await zoom();
  await page.mouse.click(cx, cy);
  await sleep(30);
  check(ctx, 'canvas: Z tool click zooms', (await zoom()) !== zb);
  await pressKey(page, 'v');
  check(ctx, 'canvas: no page errors', errors.length === 0, errors);
  await page.close();
}

/** A frame with three children in flex, returning all ids. */
async function flexFixture(page: Page, ctx: Ctx, fileId: string) {
  const doc = docOf(ctx, fileId);
  await paste(page, {
    'text/html': `<section data-name="Row" style="display:flex;gap:10px;padding:12px;width:400px;height:120px;background:#eee">
      <div data-name="A" style="width:60px;height:60px;background:#e66"></div>
      <div data-name="B" style="width:60px;height:60px;background:#6e6"></div>
      <div data-name="C" style="width:60px;height:60px;background:#66e"></div></section>`,
  });
  await sleep(50);
  const byName = (name: string) => allNodes(doc).find((n) => n.name === name)!;
  return { doc, row: byName('Row'), a: byName('A'), b: byName('B'), c: byName('C') };
}

async function selection(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Selection');
  const { doc, row, a, b, c } = await flexFixture(page, ctx, fileId);
  check(ctx, 'paste: html becomes layers', Boolean(row && a && b && c));
  const sel = () => page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.map((x) => x.getAttribute('data-name')));
  const ra = await layerRect(page, a.id);
  await pressKey(page, 'Escape');
  await page.mouse.click(ra.x + 10, ra.y + 10);
  await sleep(30);
  check(ctx, 'selection: click picks the child of the top frame', (await sel())[0] === 'A', await sel());
  await pressKey(page, 'Tab');
  check(ctx, 'selection: Tab next sibling', (await sel())[0] === 'B', await sel());
  await pressKey(page, 'Shift+Tab');
  check(ctx, 'selection: shift+Tab previous sibling', (await sel())[0] === 'A', await sel());
  await pressKey(page, 'Shift+Enter');
  check(ctx, 'selection: shift+Enter parent', (await sel())[0] === 'Row', await sel());
  await pressKey(page, 'Enter');
  check(ctx, 'selection: Enter child', (await sel())[0] === 'C', await sel());
  await pressKey(page, 'Escape');
  check(ctx, 'selection: Esc steps out', (await sel())[0] === 'Row', await sel());
  await pressKey(page, 'Escape');
  check(ctx, 'selection: Esc clears at top', (await sel()).length === 0);

  // Shift adds, ctrl+A selects all siblings.
  await page.mouse.click(ra.x + 10, ra.y + 10);
  await sleep(20);
  const rb = await layerRect(page, b.id);
  await page.keyboard.down('Shift');
  await page.mouse.click(rb.x + 10, rb.y + 10);
  await page.keyboard.up('Shift');
  await sleep(20);
  check(ctx, 'selection: shift adds', (await sel()).length === 2, await sel());
  await pressKey(page, 'Control+a');
  check(ctx, 'selection: ctrl+A selects siblings', (await sel()).length === 3, await sel());
  await pressKey(page, 'Escape');
  await pressKey(page, 'Escape');

  // Marquee in empty canvas.
  const box = await canvasBox(page);
  const rr = await layerRect(page, row.id);
  await drag(page, Math.max(box.x + 2, rr.x - 40), rr.y - 40, rr.x + rr.w + 40, rr.y + rr.h + 40);
  check(ctx, 'selection: marquee', (await sel())[0] === 'Row', await sel());
  await pressKey(page, 'Escape');

  // Ctrl click goes deep and double click drills.
  await page.keyboard.down('Control');
  await page.mouse.click(ra.x + 10, ra.y + 10);
  await page.keyboard.up('Control');
  await sleep(20);
  check(ctx, 'selection: ctrl-click deep selects', (await sel())[0] === 'A', await sel());

  // Flex reorder by drag, with a drop indicator.
  await pressKey(page, 'Escape');
  await pressKey(page, 'Escape');
  const ra2 = await layerRect(page, a.id);
  const rc2 = await layerRect(page, c.id);
  await page.mouse.click(ra2.x + 10, ra2.y + 10);
  await sleep(20);
  await page.mouse.move(ra2.x + 10, ra2.y + 10);
  await page.mouse.down();
  await page.mouse.move(rc2.x + rc2.w - 2, rc2.y + 20, { steps: 10 });
  await sleep(40);
  check(ctx, 'transform: flex drag shows drop indicator', (await page.$('[data-testid="drop-line"]')) !== null);
  await shot(page, 'flex-drag');
  await page.mouse.up();
  await sleep(50);
  check(ctx, 'transform: flex child reorders by dragging', doc.getChildren(row.id).map((n) => n.name).join() === 'B,C,A', doc.getChildren(row.id).map((n) => n.name));

  // Reparent out of the flex parent onto the page.
  const rx = await layerRect(page, b.id);
  await page.mouse.click(rx.x + 10, rx.y + 10);
  await sleep(20);
  const rowR = await layerRect(page, row.id);
  await drag(page, rx.x + 10, rx.y + 10, rowR.x + rowR.w + 80, rowR.y + rowR.h + 80, 10);
  const bNode = doc.getNode(b.id)!;
  check(ctx, 'transform: drag out of a frame reparents to the page', bNode.parent === doc.getPages()[0]!.id && bNode.style.position === 'absolute', bNode);

  // And into a frame, as absolute child.
  await pressKey(page, 'Escape');
  await pressKey(page, 'f');
  const vb = await canvasBox(page);
  await drag(page, vb.x + 60, vb.y + 60, vb.x + 260, vb.y + 260);
  const target = allNodes(doc).find((n) => n.artboard)!;
  check(ctx, 'tools: second frame', Boolean(target));
  const bb = await layerRect(page, b.id);
  await pressKey(page, 'Escape');
  await page.mouse.click(bb.x + 10, bb.y + 10);
  await sleep(20);
  const tt = await layerRect(page, target.id);
  await page.mouse.move(bb.x + 10, bb.y + 10);
  await page.mouse.down();
  await page.mouse.move(tt.x + 100, tt.y + 100, { steps: 12 });
  await sleep(30);
  await shot(page, 'reparent-drag');
  await page.mouse.up();
  await sleep(50);
  const inFrame = doc.getNode(b.id)!;
  check(ctx, 'transform: drag into a frame reparents', inFrame.parent === target.id, inFrame.parent);
  const rb2 = await layerRect(page, b.id);
  check(ctx, 'transform: reparent keeps the screen position', Math.abs(rb2.x + 10 - (tt.x + 100)) < 8 && Math.abs(rb2.y + 10 - (tt.y + 100)) < 8, { rb2, tt });

  check(ctx, 'selection: no page errors', errors.length === 0, errors);
  await page.close();
}

async function snapping(ctx: Ctx): Promise<void> {
  const { page, fileId } = await newFilePage(ctx, 'Snap');
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(page);
  // Three rectangles, snapping the third to the first's top edge.
  const draw = async (x: number, y: number, w: number, h: number) => {
    await pressKey(page, 'r');
    await drag(page, box.x + x, box.y + y, box.x + x + w, box.y + y + h);
    await pressKey(page, 'Escape');
  };
  await draw(100, 100, 100, 100);
  await draw(300, 240, 100, 100);
  await draw(100, 400, 100, 100);
  const rects = allNodes(doc).filter((n) => n.name === 'Rectangle');
  check(ctx, 'tools: rectangles drawn', rects.length === 3, rects.length);
  const second = rects.sort((a, b) => px(a.style.top) - px(b.style.top))[1]!;
  const first = rects[0]!;
  const r = await layerRect(page, second.id);
  // Move up until it is almost level with the first one.
  await page.mouse.move(r.x + 20, r.y + 20);
  await page.mouse.down();
  await page.mouse.move(r.x + 20, box.y + 100 + 20 + 3, { steps: 8 });
  await sleep(30);
  const guides = await page.$$('.ov-guide');
  check(ctx, 'guides: guides appear when aligned', guides.length > 0, guides.length);
  await shot(page, 'smart-guides');
  await page.mouse.up();
  await sleep(30);
  check(ctx, 'guides: snaps to the sibling edge', px(doc.getNode(second.id)!.style.top) === px(first.style.top), [doc.getNode(second.id)!.style.top, first.style.top]);
  // Alt measures.
  await page.keyboard.down('Alt');
  const r3 = await layerRect(page, first.id);
  await page.mouse.move(r3.x + 10, r3.y + 10);
  await sleep(50);
  check(ctx, 'guides: alt measures distances', (await page.$$('.ov-measure-label')).length > 0);
  await shot(page, 'measure');
  await page.keyboard.up('Alt');
  await page.close();
}

async function inspector(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Inspector');
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(page);
  await pressKey(page, 'f');
  await drag(page, box.x + 120, box.y + 80, box.x + 620, box.y + 480);
  const frame = allNodes(doc)[0]!;
  // Two children, drawn.
  await pressKey(page, 'r');
  await drag(page, box.x + 160, box.y + 140, box.x + 260, box.y + 240);
  await pressKey(page, 'r');
  await drag(page, box.x + 300, box.y + 140, box.x + 400, box.y + 240);
  const kids = doc.getChildren(frame.id);
  check(ctx, 'inspector: rectangles are nested in the frame', kids.length === 2, kids.length);

  // Select the frame and turn on flex.
  await pressKey(page, 'Shift+Enter');
  check(ctx, 'inspector: shows the frame', (await page.$eval('[data-testid="insp-name"]', (e) => (e as HTMLInputElement).value)) === 'Frame');
  await shot(page, 'inspector-frame');
  await clickTest(page, 'insp-layout-row');
  await sleep(40);
  let f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: flex row via layout control', f.style.display === 'flex' && f.style.flexDirection === 'row', f.style);
  check(ctx, 'inspector: children enter the flow', doc.getChildren(frame.id).every((k) => !k.style.position), doc.getChildren(frame.id).map((k) => k.style.position));
  await fillField(page, 'insp-gap', '24');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: gap', f.style.gap === '24px', f.style.gap);
  await fillField(page, 'insp-pad-x', '16+4');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: padding with math', f.style.padding === '0 20px' || f.style.padding === '0px 20px', f.style.padding);
  await clickTest(page, 'matrix-center-center');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: alignment matrix', f.style.justifyContent === 'center' && f.style.alignItems === 'center', f.style);
  await shot(page, 'inspector-flex');

  // Grid.
  await clickTest(page, 'insp-layout-grid');
  await fillField(page, 'insp-grid-cols', '3');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: grid columns', f.style.display === 'grid' && (f.style.gridTemplateColumns ?? '').startsWith('repeat(3'), f.style);
  await clickTest(page, 'insp-layout-row');

  // Numeric: W with fill and hug.
  await fillField(page, 'insp-width', '640');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: width', f.style.width === '640px', f.style.width);
  await page.select('[data-testid="insp-height-mode"]', 'hug');
  await sleep(30);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: hug', f.style.height === 'fit-content', f.style.height);
  await page.select('[data-testid="insp-height-mode"]', 'fixed');
  await sleep(30);
  await fillField(page, 'insp-height', '400');

  // Scrub a label.
  const label = await page.evaluateHandle(() => [...document.querySelectorAll('.field-label')].find((e) => e.textContent === 'Radius'));
  const lb = await (label.asElement() as import('puppeteer-core').ElementHandle<Element>).boundingBox();
  await drag(page, lb!.x + 4, lb!.y + 8, lb!.x + 44, lb!.y + 8, 5);
  await sleep(50);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: scrub label changes value', px(f.style.borderRadius) >= 15, f.style.borderRadius);
  await pressKey(page, 'Control+z');
  await sleep(30);
  check(ctx, 'inspector: scrub undoes in one step', !doc.getNode(frame.id)!.style.borderRadius, doc.getNode(frame.id)!.style.borderRadius);

  // Arrow keys in a field.
  await page.click('[data-testid="insp-radius"]');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('Shift');
  await sleep(40);
  await page.keyboard.press('Tab');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: arrows and shift+arrows', px(f.style.borderRadius) === 11, f.style.borderRadius);

  // Fill: solid via hex, then a gradient.
  await page.mouse.click(box.x + 20, box.y + 20);
  await sleep(10);
  await page.mouse.click(box.x + 600, box.y + 460);
  await sleep(30);
  await page.evaluate(() => document.querySelector('.panel-scroll')?.scrollTo(0, 400));
  await clickTest(page, 'fill-swatch-0');
  await sleep(40);
  await shot(page, 'color-picker');
  await fillField(page, 'picker-hex', '#ff3366');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: colour by hex', (f.style.backgroundColor ?? '').toLowerCase() === '#ff3366', f.style);
  await page.select('[data-testid="picker-format"]', 'oklch');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: colour as oklch', (f.style.backgroundColor ?? '').startsWith('oklch('), f.style.backgroundColor);
  await page.select('[data-testid="picker-format"]', 'p3');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: colour as display-p3', (f.style.backgroundColor ?? '').startsWith('color(display-p3'), f.style.backgroundColor);
  await clickTest(page, 'fill-kind-linear');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: linear gradient fill', (f.style.backgroundImage ?? '').startsWith('linear-gradient('), f.style.backgroundImage);
  await shot(page, 'gradient-editor');
  // Add a stop by clicking the bar.
  const bar = await page.$('[data-testid="gradient-bar"]');
  const bb = await bar!.boundingBox();
  await page.mouse.click(bb!.x + bb!.width / 2, bb!.y + bb!.height / 2);
  await sleep(40);
  check(ctx, 'inspector: gradient stop added on the bar', (await page.$$('[data-testid="gradient-stop"]')).length === 3);
  await clickTest(page, 'fill-kind-conic');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: conic gradient', (f.style.backgroundImage ?? '').startsWith('conic-gradient('), f.style.backgroundImage);
  await clickTest(page, 'fill-kind-radial');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: radial gradient', (f.style.backgroundImage ?? '').startsWith('radial-gradient('), f.style.backgroundImage);
  await page.keyboard.press('Escape');
  await sleep(30);
  await clickTest(page, 'fill-add');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: layered fills', (await page.$$('[data-testid^="fill-swatch-"]')).length === 2, f.style);

  // Border, shadow, filter, blend.
  await clickTest(page, 'border-add');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: border', f.style.borderWidth === '1px', f.style);
  await clickTest(page, 'shadow-add');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: shadow', (f.style.boxShadow ?? '').includes('12px'), f.style.boxShadow);
  await clickTest(page, 'shadow-add');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: multiple shadows', (f.style.boxShadow ?? '').split(',').length >= 2, f.style.boxShadow);
  await page.select('[data-testid="add-Filter"]', 'blur');
  await sleep(30);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: filter', (f.style.filter ?? '').includes('blur('), f.style.filter);
  await page.select('[data-testid="add-Backdrop"]', 'blur');
  await sleep(30);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: backdrop filter', (f.style.backdropFilter ?? '').includes('blur('), f.style.backdropFilter);
  await page.select('[data-testid="insp-blend"]', 'multiply');
  await sleep(30);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: blend mode', f.style.mixBlendMode === 'multiply', f.style.mixBlendMode);
  await fillField(page, 'insp-opacity', '50');
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: opacity', f.style.opacity === '0.5', f.style.opacity);

  // Tag picker.
  await page.select('[data-testid="insp-tag"]', 'section');
  await sleep(30);
  const tag = await page.$eval(`[data-bogen-id="${frame.id}"]`, (e) => e.tagName);
  check(ctx, 'inspector: semantic tag rewrites the real element', tag === 'SECTION', tag);

  // Raw CSS.
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.section-toggle')].find((e) => e.textContent?.includes('CSS')) as HTMLElement | undefined;
    t?.click();
  });
  await sleep(30);
  await clickTest(page, 'css-add');
  await page.waitForSelector('[data-testid="css-new"]');
  await page.keyboard.type('cursor: pointer; aspect-ratio: 4 / 3');
  await page.keyboard.press('Enter');
  await sleep(40);
  f = doc.getNode(frame.id)!;
  check(ctx, 'inspector: raw CSS adds properties', f.style.cursor === 'pointer' && f.style.aspectRatio === '4 / 3', f.style);
  const rows = await page.$$('.css-row');
  check(ctx, 'inspector: raw CSS lists every property', rows.length === Object.keys(f.style).length, { rows: rows.length, keys: Object.keys(f.style).length });
  await shot(page, 'inspector-css');

  // Multi selection shows mixed values.
  await pressKey(page, 'Enter');
  await pressKey(page, 'Control+a');
  await sleep(40);
  await page.evaluate(() => document.querySelector('.panel-scroll')?.scrollTo(0, 0));
  await clickTest(page, 'tab-design');
  const kidsNow = doc.getChildren(frame.id);
  check(ctx, 'inspector: multi selection is active', kidsNow.length === 2);
  await fillField(page, 'insp-opacity', '40');
  check(ctx, 'inspector: edits apply to all selected', doc.getChildren(frame.id).every((k) => k.style.opacity === '0.4'), doc.getChildren(frame.id).map((k) => k.style.opacity));
  // Make one differ, then the field reads Mixed.
  const firstKid = kidsNow[0]!;
  await page.evaluate(() => 0);
  const kr = await layerRect(page, firstKid.id);
  await page.mouse.click(kr.x + 5, kr.y + 5);
  await sleep(30);
  await fillField(page, 'insp-opacity', '90');
  await pressKey(page, 'Control+a');
  await sleep(40);
  const placeholder = await page.$eval('[data-testid="insp-opacity"]', (e) => (e as HTMLInputElement).placeholder);
  check(ctx, 'inspector: mixed values read as Mixed', placeholder === 'Mixed', placeholder);
  await shot(page, 'inspector-mixed');

  // Typography.
  await pressKey(page, 'Escape');
  await pressKey(page, 'Escape');
  await pressKey(page, 'Escape');
  await pressKey(page, 't');
  await page.mouse.click(box.x + 700, box.y + 200);
  await sleep(40);
  await page.keyboard.type('Type sample');
  await page.keyboard.press('Escape');
  await sleep(40);
  const tNode = () => allNodes(doc).find((n) => n.type === 'text')!;
  await fillField(page, 'type-size', '32');
  check(ctx, 'typography: size', tNode().style.fontSize === '32px', tNode().style);
  await fillField(page, 'type-line-height', '1.2');
  check(ctx, 'typography: line height', tNode().style.lineHeight === '1.2', tNode().style.lineHeight);
  await fillField(page, 'type-tracking', '-0.5');
  check(ctx, 'typography: tracking', tNode().style.letterSpacing === '-0.5px', tNode().style.letterSpacing);
  await page.select('[data-testid="type-weight"]', '700');
  await sleep(30);
  check(ctx, 'typography: weight', tNode().style.fontWeight === '700', tNode().style.fontWeight);
  await clickTest(page, 'type-align-center');
  check(ctx, 'typography: align', tNode().style.textAlign === 'center');
  await clickTest(page, 'type-case-uppercase');
  check(ctx, 'typography: case', tNode().style.textTransform === 'uppercase');
  await clickTest(page, 'type-underline');
  check(ctx, 'typography: decoration', tNode().style.textDecorationLine === 'underline');
  await clickTest(page, 'font-button');
  await page.waitForSelector('[data-testid="font-search"]');
  await page.keyboard.type('Lora');
  await sleep(120);
  await shot(page, 'font-picker');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'typography: font search picks a family', (tNode().style.fontFamily ?? '').includes('Lora'), tNode().style.fontFamily);
  await clickTest(page, 'type-gradient');
  check(ctx, 'typography: text gradient', tNode().style.WebkitBackgroundClip === 'text' && tNode().style.color === 'transparent', tNode().style);
  await clickTest(page, 'type-gradient');
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('.inspector details')) (d as HTMLDetailsElement).open = true;
  });
  await sleep(30);
  await fillField(page, 'type-stroke', '1');
  check(ctx, 'typography: text stroke', tNode().style.WebkitTextStrokeWidth === '1px', tNode().style);
  await page.click('[data-testid="feature-tnum"]');
  await sleep(30);
  check(ctx, 'typography: OpenType feature', (tNode().style.fontFeatureSettings ?? '').includes('tnum'), tNode().style.fontFeatureSettings);
  await fillField(page, 'axis-wght', '650');
  check(ctx, 'typography: variable axis', (tNode().style.fontVariationSettings ?? '').includes('wght'), tNode().style.fontVariationSettings);
  await page.click('[data-testid="type-truncate"]');
  await sleep(30);
  check(ctx, 'typography: truncation', tNode().style.textOverflow === 'ellipsis', tNode().style);
  await shot(page, 'typography');
  // Hotkeys.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressKey(page, 'Control+b');
  check(ctx, 'hotkeys: ctrl+B toggles bold', tNode().style.fontWeight === '400' || tNode().style.fontWeight === '700', tNode().style.fontWeight);
  const sizeBefore = px(tNode().style.fontSize);
  await pressKey(page, 'Control+Shift+.');
  check(ctx, 'hotkeys: ctrl+shift+> grows the type', px(tNode().style.fontSize) === sizeBefore + 1, tNode().style.fontSize);
  await pressKey(page, 'Control+Alt+KeyR');
  check(ctx, 'hotkeys: ctrl+alt+R aligns text right', tNode().style.textAlign === 'right', tNode().style.textAlign);

  check(ctx, 'inspector: no page errors', errors.length === 0, errors);
  await page.close();
}

async function layerTree(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Tree');
  const { doc, row, a, b, c } = await flexFixture(page, ctx, fileId);
  const rowsY = async (name: string) => {
    const el = await page.$(`[data-testid="layer-row"][data-name="${name}"]`);
    return el!.boundingBox();
  };
  const order = () => doc.getChildren(row.id).map((n) => n.name).join();
  check(ctx, 'tree: paint order', order() === 'A,B,C', order());
  // Children in flow read in document order. Drag C below A.
  const rc = await rowsY('C');
  const ra = await rowsY('A');
  await page.mouse.move(rc!.x + 40, rc!.y + 13);
  await page.mouse.down();
  await page.mouse.move(ra!.x + 40, ra!.y + ra!.height - 2, { steps: 8 });
  await sleep(30);
  check(ctx, 'tree: drop line while dragging', (await page.$('[data-testid="layer-drop-line"]')) !== null);
  await shot(page, 'layer-drag');
  await page.mouse.up();
  await sleep(50);
  check(ctx, 'tree: drag reorders', order() === 'A,C,B', order());
  await pressKey(page, 'Control+z');
  await sleep(40);
  check(ctx, 'tree: reorder undoes', order() === 'A,B,C', order());

  // Hide, lock, rename, collapse.
  const hideBtn = await page.$(`[data-layer="${a.id}"] [data-testid="layer-hide"]`);
  await (await page.$(`[data-layer="${a.id}"]`))!.hover();
  await hideBtn!.click();
  await sleep(30);
  check(ctx, 'tree: hide', doc.getNode(a.id)!.hidden === true);
  check(ctx, 'tree: hidden is display none', (await page.$eval(`[data-bogen-id="${a.id}"]`, (e) => getComputedStyle(e).display)) === 'none');
  const r = await page.$(`[data-layer="${b.id}"] [data-testid="layer-lock"]`);
  await (await page.$(`[data-layer="${b.id}"]`))!.hover();
  await r!.click();
  await sleep(30);
  check(ctx, 'tree: lock', doc.getNode(b.id)!.locked === true);
  // A locked layer cannot be selected on the canvas.
  const rbb = await layerRect(page, b.id);
  await page.mouse.click(rbb.x + 5, rbb.y + 5);
  await sleep(30);
  const selName = await page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.map((x) => x.getAttribute('data-name')));
  check(ctx, 'tree: locked layer is passed through', !selName.includes('B'), selName);

  await page.mouse.click(ra!.x + 60, ra!.y + 13, { count: 2 });
  await page.waitForSelector('[data-testid="layer-rename"]');
  await page.keyboard.type('Renamed');
  await page.keyboard.press('Enter');
  await sleep(30);
  check(ctx, 'tree: rename', doc.getNode(a.id)!.name === 'Renamed', doc.getNode(a.id)!.name);
  await page.click(`[data-layer="${row.id}"] .layer-toggle`);
  await sleep(30);
  check(ctx, 'tree: collapse', (await page.$(`[data-layer="${c.id}"]`)) === null);
  await page.click(`[data-layer="${row.id}"] .layer-toggle`);
  await sleep(30);

  // Pages.
  await clickTest(page, 'page-add');
  await sleep(50);
  await page.keyboard.type('Second');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'pages: add and rename', doc.getPages().at(-1)!.name === 'Second', doc.getPages().map((p) => p.name));
  check(ctx, 'pages: new page is empty', (await page.$$('[data-bogen-id]')).length === 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const pageRows = await page.$$('[data-testid="page-row"]');
  await pageRows[0]!.click();
  await sleep(50);
  check(ctx, 'pages: switching shows its layers', (await page.$$('[data-bogen-id]')).length >= 4);
  // Reorder pages.
  const p0 = await pageRows[0]!.boundingBox();
  const p1 = await pageRows[1]!.boundingBox();
  await drag(page, p1!.x + 20, p1!.y + 8, p0!.x + 20, p0!.y + 1, 6);
  await sleep(40);
  check(ctx, 'pages: reorder', doc.getPages()[0]!.name === 'Second', doc.getPages().map((p) => p.name));
  // Delete.
  const rowsNow = await page.$$('[data-testid="page-row"]');
  const delPage = await rowsNow[0]!.$('.row-action');
  await rowsNow[0]!.hover();
  await delPage!.click();
  await sleep(40);
  check(ctx, 'pages: delete', doc.getPages().length === 1, doc.getPages().length);

  // Tokens.
  await clickTest(page, 'tab-tokens');
  await sleep(20);
  await page.click('[data-testid="token-new-name"]');
  await page.keyboard.type('brand');
  await page.keyboard.press('Tab');
  await page.keyboard.type('#3366ff');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'tokens: add colour', doc.getTokens().some((t) => t.name === 'brand' && t.value === '#3366ff' && t.kind === 'color'), doc.getTokens());
  await page.select('[data-testid="token-kind"]', 'spacing');
  await page.click('[data-testid="token-new-name"]');
  await page.keyboard.type('gap-m');
  await page.keyboard.press('Tab');
  await page.keyboard.type('16px');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'tokens: add by kind', doc.getTokens().some((t) => t.name === 'gap-m' && t.kind === 'spacing'), doc.getTokens());
  await fillField(page, 'token-value-gap-m', '20px');
  check(ctx, 'tokens: edit', doc.getTokens().find((t) => t.name === 'gap-m')?.value === '20px');
  const hasVar = await page.$eval('.bogen-world', (e) => getComputedStyle(e).getPropertyValue('--brand').trim());
  check(ctx, 'tokens: written as CSS variables on the world', hasVar === '#3366ff', hasVar);
  await shot(page, 'tokens');
  await clickTest(page, 'token-copy-tailwind');
  await sleep(40);
  check(ctx, 'tokens: copy feedback', (await page.$('[data-testid="toast"]')) !== null);
  await page.hover('[data-token="gap-m"]');
  await clickTest(page, 'token-delete-gap-m');
  await sleep(30);
  check(ctx, 'tokens: delete', !doc.getTokens().some((t) => t.name === 'gap-m'));
  await clickTest(page, 'tab-layers');
  check(ctx, 'tree: no page errors', errors.length === 0, errors);
  await page.close();
}

async function edit(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Edit');
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(page);
  const rect = async (x: number, y: number) => {
    await pressKey(page, 'r');
    await drag(page, box.x + x, box.y + y, box.x + x + 80, box.y + y + 80);
  };
  await rect(100, 100);
  await rect(240, 120);
  await rect(380, 90);
  const page0 = () => doc.getPages()[0]!.id;
  check(ctx, 'edit: three layers', doc.getChildren(page0()).length === 3);

  // Align and distribute.
  await pressKey(page, 'Control+a');
  await pressKey(page, 'Alt+w');
  await sleep(30);
  let kids = doc.getChildren(page0());
  check(ctx, 'arrange: align top', new Set(kids.map((k) => k.style.top)).size === 1, kids.map((k) => k.style.top));
  await pressKey(page, 'Alt+Shift+h');
  await sleep(30);
  kids = doc.getChildren(page0());
  const xs = kids.map((k) => px(k.style.left)).sort((a, b) => a - b);
  check(ctx, 'arrange: distribute evens the gaps', Math.abs((xs[1]! - xs[0]!) - (xs[2]! - xs[1]!)) < 0.01, xs);

  // Group, ungroup.
  const screenBefore = await layerRect(page, kids[0]!.id);
  await pressKey(page, 'Control+g');
  await sleep(40);
  let top = doc.getChildren(page0());
  check(ctx, 'layers: group', top.length === 1 && top[0]!.name === 'Group', top.map((t) => t.name));
  const groupId = top[0]!.id;
  const inGroup = await layerRect(page, doc.getChildren(groupId)[0]!.id);
  check(ctx, 'layers: group does not move anything', Math.abs(inGroup.x - screenBefore.x) < 1 && Math.abs(inGroup.y - screenBefore.y) < 1, { inGroup, screenBefore });
  await pressKey(page, 'Control+Shift+g');
  await sleep(40);
  top = doc.getChildren(page0());
  check(ctx, 'layers: ungroup', top.length === 3, top.length);
  const afterUngroup = await layerRect(page, top[0]!.id);
  check(ctx, 'layers: ungroup does not move anything', Math.abs(afterUngroup.x - screenBefore.x) < 1, afterUngroup);

  // Wrap in frame.
  await pressKey(page, 'Control+Alt+g');
  await sleep(40);
  top = doc.getChildren(page0());
  check(ctx, 'layers: wrap in frame', top.length === 1 && top[0]!.name === 'Frame', top.map((t) => t.name));
  await pressKey(page, 'Control+z');
  await sleep(40);

  // Z order.
  const ids = doc.getChildren(page0()).map((k) => k.id);
  await pressKey(page, 'Escape');
  const r0 = await layerRect(page, ids[0]!);
  await page.mouse.click(r0.x + 5, r0.y + 5);
  await sleep(20);
  await pressKey(page, 'Control+]');
  await sleep(30);
  check(ctx, 'arrange: bring forward', doc.getChildren(page0())[1]!.id === ids[0], doc.getChildren(page0()).map((k) => k.id));
  await pressKey(page, 'Control+Alt+]');
  await sleep(30);
  check(ctx, 'arrange: to front', doc.getChildren(page0()).at(-1)!.id === ids[0]);
  await pressKey(page, 'Control+[');
  await sleep(30);
  check(ctx, 'arrange: send backward', doc.getChildren(page0())[1]!.id === ids[0], doc.getChildren(page0()).map((k) => k.id));

  // Lock and hide by shortcut.
  await pressKey(page, 'Control+Shift+h');
  await sleep(20);
  check(ctx, 'layers: hide by shortcut', doc.getNode(ids[0]!)!.hidden === true);
  await pressKey(page, 'Control+Shift+h');
  await sleep(20);
  await pressKey(page, 'Control+Shift+l');
  await sleep(20);
  check(ctx, 'layers: lock by shortcut', doc.getNode(ids[0]!)!.locked === true);
  await pressKey(page, 'Control+z');
  await sleep(30);

  // Flip.
  await page.mouse.click(r0.x + 5, r0.y + 5);
  await sleep(20);
  await pressKey(page, 'Shift+h');
  await sleep(20);
  check(ctx, 'transform: flip', doc.getNode(ids[0]!)!.style.scale === '-1 1', doc.getNode(ids[0]!)!.style.scale);
  await pressKey(page, 'Control+z');
  await sleep(20);

  // Duplicate and delete.
  const n0 = allNodes(doc).length;
  await pressKey(page, 'Control+d');
  await sleep(40);
  check(ctx, 'edit: duplicate', allNodes(doc).length === n0 + 1);
  await pressKey(page, 'Delete');
  await sleep(40);
  check(ctx, 'edit: delete', allNodes(doc).length === n0);
  await pressKey(page, 'Escape');

  // Copy and paste as html on the clipboard, through the real events.
  await page.mouse.click(r0.x + 5, r0.y + 5);
  await sleep(20);
  const copied = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { html: dt.getData('text/html'), plain: dt.getData('text/plain') };
  });
  check(ctx, 'clipboard: copy writes text/html', copied.html.includes('<div') && copied.html.includes('background-color'), copied.html.slice(0, 200));
  await paste(page, { 'text/html': copied.html, 'text/plain': copied.plain });
  check(ctx, 'clipboard: paste own copy', allNodes(doc).length === n0 + 1, allNodes(doc).length);
  await pressKey(page, 'Control+z');
  await sleep(30);

  // Cut.
  await page.mouse.click(r0.x + 5, r0.y + 5);
  await sleep(20);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await sleep(30);
  check(ctx, 'clipboard: cut removes', allNodes(doc).length === n0 - 1, allNodes(doc).length);
  await pressKey(page, 'Control+z');
  await sleep(30);

  // External paste: HTML with a style sheet, SVG, plain text.
  await pressKey(page, 'Escape');
  await pressKey(page, 'Escape');
  await paste(page, { 'text/html': '<style>.card{padding:24px;background:#fff;border-radius:12px}h2{font-size:28px;color:#123}</style><div class="card" data-name="Card"><h2>Pasted title</h2><p>Body</p></div>' });
  let card = allNodes(doc).find((n) => n.name === 'Card');
  check(ctx, 'paste: external HTML with style sheet', card?.style.padding === '24px' && card.style.position === 'absolute', card?.style);
  const h2 = allNodes(doc).find((n) => n.tag === 'h2');
  check(ctx, 'paste: semantic tag and text kept', h2?.text === 'Pasted title' && h2.style.fontSize === '28px', h2);
  await shot(page, 'pasted-html');

  await pressKey(page, 'Escape');
  await pressKey(page, 'Escape');
  await paste(page, { 'text/plain': '<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="30" fill="#e11"/><script>alert(1)</script></svg>' });
  const svg = allNodes(doc).find((n) => n.type === 'svg');
  check(ctx, 'paste: SVG becomes a vector layer', Boolean(svg) && svg?.style.width === '64px', svg?.style);
  check(ctx, 'paste: SVG is sanitized and fills the layer', !(svg?.svg ?? '').includes('script') && (svg?.svg ?? '').includes('width="100%"'), svg?.svg);

  await pressKey(page, 'Escape');
  await paste(page, { 'text/plain': 'Just some words' });
  const plain = allNodes(doc).find((n) => n.text === 'Just some words');
  check(ctx, 'paste: plain text becomes a text layer', Boolean(plain));

  // Copy and paste styles.
  await pressKey(page, 'Escape');
  card = allNodes(doc).find((n) => n.name === 'Card')!;
  await page.evaluate(() => 0);
  await page.click(`[data-layer="${card.id}"]`);
  await sleep(20);
  await pressKey(page, 'Control+Alt+c');
  await page.click(`[data-layer="${plain!.id}"]`);
  await sleep(20);
  await pressKey(page, 'Control+Alt+v');
  await sleep(30);
  const styled = doc.getNode(plain!.id)!;
  check(ctx, 'edit: copy and paste styles', styled.style.borderRadius === '12px', styled.style);
  await pressKey(page, 'Control+z');

  // Paste to replace, in a page with clipboard permission.
  // Paste with an image file.
  await pressKey(page, 'Escape');
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const file = new File([bytes], 'x.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pngB64);
  await sleep(200);
  const image = allNodes(doc).find((n) => n.type === 'image');
  check(ctx, 'paste: image uploads through /api/assets', (image?.src ?? '').startsWith('bogen-asset:'), image);
  const loaded = await page.$eval(`[data-bogen-id="${image!.id}"]`, (e) => (e as HTMLImageElement).src);
  check(ctx, 'paste: asset url resolved on canvas', loaded.includes('/assets/'), loaded);

  // Drag and drop an image file.
  const before = allNodes(doc).filter((n) => n.type === 'image').length;
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const file = new File([bytes], 'y.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const canvas = document.querySelector('[data-testid="canvas"]')!;
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 500, clientY: r.top + 300 }));
    canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 500, clientY: r.top + 300 }));
  }, pngB64);
  await sleep(200);
  check(ctx, 'tools: image by drag and drop', allNodes(doc).filter((n) => n.type === 'image').length === before + 1);

  check(ctx, 'edit: no page errors', errors.length === 0, errors);
  await page.close();
}

async function vector(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Vector');
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(page);
  const X = (v: number) => box.x + v;
  const Y = (v: number) => box.y + v;
  // Line.
  await pressKey(page, 'l');
  await drag(page, X(100), Y(100), X(300), Y(200));
  const line = allNodes(doc).find((n) => n.name === 'Line');
  check(ctx, 'tools: line', Boolean(line) && (line?.style.rotate ?? '').endsWith('deg'), line?.style);

  // Ellipse.
  await pressKey(page, 'o');
  await drag(page, X(340), Y(100), X(440), Y(200));
  const el = allNodes(doc).find((n) => n.name === 'Ellipse');
  check(ctx, 'tools: ellipse', el?.style.borderRadius === '50%', el?.style);

  // Pen: a triangle with one smooth node, closing on the first.
  await pressKey(page, 'p');
  await page.mouse.click(X(120), Y(300));
  await sleep(20);
  await drag(page, X(220), Y(260), X(260), Y(260));
  await page.mouse.click(X(300), Y(360));
  await sleep(20);
  await page.mouse.move(X(200), Y(420));
  await sleep(30);
  await shot(page, 'pen-drawing');
  await page.mouse.click(X(120), Y(300));
  await sleep(40);
  let pen = allNodes(doc).find((n) => n.type === 'svg');
  check(ctx, 'tools: pen makes a vector layer', Boolean(pen?.svg?.includes('<path')) && Boolean(pen?.svg?.includes('C')) && Boolean(pen?.svg?.includes('Z')), pen?.svg);

  // Node editing on double click.
  const pr = await layerRect(page, pen!.id);
  await page.mouse.click(pr.x + pr.w / 2, pr.y + pr.h / 2, { count: 2 });
  await sleep(60);
  check(ctx, 'tools: double click enters node editing', (await page.$$('[data-path-point]')).length === 3, (await page.$$('[data-path-point]')).length);
  await shot(page, 'node-editing');
  const nodeEl = (await page.$$('[data-path-point]'))[2]!;
  const nb = await nodeEl.boundingBox();
  const widthBefore = pen!.style.width;
  await drag(page, nb!.x + 4, nb!.y + 4, nb!.x + 60, nb!.y + 40);
  await sleep(50);
  pen = doc.getNode(pen!.id)!;
  check(ctx, 'tools: dragging a node edits the path and refits', pen.style.width !== widthBefore, [widthBefore, pen.style.width]);
  await pressKey(page, 'Control+z');
  await sleep(50);
  pen = doc.getNode(pen!.id)!;
  check(ctx, 'tools: node edit undoes', pen.style.width === widthBefore, [widthBefore, pen.style.width]);
  await pressKey(page, 'Enter');
  await sleep(30);
  check(ctx, 'tools: Enter leaves node editing', (await page.$$('[data-path-point]')).length === 0);

  // Pencil.
  await pressKey(page, 'Shift+p');
  await page.mouse.move(X(500), Y(300));
  await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(X(500 + i * 8), Y(300 + Math.sin(i / 2) * 30));
  await page.mouse.up();
  await sleep(40);
  const stroke = allNodes(doc).find((n) => n.name === 'Stroke');
  check(ctx, 'tools: pencil stroke', Boolean(stroke?.svg?.includes('C')), stroke?.svg?.slice(0, 200));
  await shot(page, 'vectors');

  // Vector inspector.
  await fillField(page, 'vector-width', '6');
  check(ctx, 'vector: stroke width', (doc.getNode(stroke!.id)!.svg ?? '').includes('stroke-width="6"'), doc.getNode(stroke!.id)!.svg?.slice(0, 200));

  // Flatten two shapes.
  await pressKey(page, 'Escape');
  const lr = await layerRect(page, el!.id);
  await page.mouse.click(lr.x + lr.w / 2, lr.y + lr.h / 2);
  await sleep(20);
  await page.keyboard.down('Shift');
  const sr = await layerRect(page, stroke!.id);
  await page.mouse.click(sr.x + 4, sr.y + sr.h / 2);
  await page.keyboard.up('Shift');
  await sleep(20);
  const sel = await page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.length);
  if (sel !== 2) await pressKey(page, 'Control+a');
  const count = allNodes(doc).length;
  await pressKey(page, 'Control+e');
  await sleep(50);
  check(ctx, 'layers: flatten merges vectors into one', allNodes(doc).length < count, [count, allNodes(doc).length]);
  check(ctx, 'vector: no page errors', errors.length === 0, errors);
  await page.close();
}

async function shader(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Shader');
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(page);
  await pressKey(page, 's');
  await drag(page, box.x + 120, box.y + 100, box.x + 520, box.y + 400);
  await sleep(600);
  const s = allNodes(doc).find((n) => n.type === 'shader');
  check(ctx, 'shader: layer drawn', s?.attrs?.type === 'mesh-gradient', s?.attrs);
  const hasCanvas = await page.$eval(`[data-bogen-id="${s!.id}"]`, (e) => Boolean(e.querySelector('canvas')));
  check(ctx, 'shader: live canvas mounted', hasCanvas);
  check(ctx, 'shader: inspector shows', (await page.$('[data-testid="shader-inspector"]')) !== null);
  await shot(page, 'shader');
  await fillField(page, 'shader-distortion', '0.5');
  check(ctx, 'shader: param writes to the document', doc.getNode(s!.id)!.attrs?.distortion === '0.5', doc.getNode(s!.id)!.attrs);
  await clickTest(page, 'shader-preset-Ink');
  await sleep(50);
  const c = doc.getNode(s!.id)!.attrs?.colors;
  check(ctx, 'shader: preset applies', Boolean(c) && c !== s!.attrs?.colors, c);
  await page.select('[data-testid="shader-type"]', 'dot-grid');
  await sleep(300);
  check(ctx, 'shader: effect switch', doc.getNode(s!.id)!.attrs?.type === 'dot-grid', doc.getNode(s!.id)!.attrs?.type);
  check(ctx, 'shader: no page errors', errors.filter((e) => !/WebGL|GL_|gl/.test(e)).length === 0, errors);
  await page.close();
}

async function panels(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Panels');
  const doc = docOf(ctx, fileId);
  await flexFixture(page, ctx, fileId);
  const row = allNodes(doc).find((n) => n.name === 'Row')!;

  // Code.
  await clickTest(page, 'tab-code');
  await sleep(150);
  let code = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
  check(ctx, 'code: html', code.includes('<section') && code.includes('display:flex'), code.slice(0, 200));
  await shot(page, 'code-panel');
  const mono = await page.$eval('[data-testid="code-output"]', (e) => getComputedStyle(e).fontFamily);
  check(ctx, 'code: mono only in the code panel', /mono/i.test(mono), mono);
  await clickTest(page, 'code-mode-react');
  await sleep(150);
  code = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
  check(ctx, 'code: react inline', code.includes('export function') && code.includes('style={{'), code.slice(0, 200));
  await clickTest(page, 'code-mode-tailwind');
  await sleep(150);
  code = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
  check(ctx, 'code: tailwind', code.includes('className='), code.slice(0, 200));
  // Live update.
  await clickTest(page, 'tab-design');
  await fillField(page, 'insp-gap', '33');
  await clickTest(page, 'tab-code');
  await sleep(150);
  code = await page.$eval('[data-testid="code-output"]', (e) => e.textContent ?? '');
  check(ctx, 'code: follows edits', code.includes('33px'), code.slice(0, 200));
  await page.evaluate(() => { (window as unknown as { __c?: string }).__c = ''; });

  // Comments.
  const box = await canvasBox(page);
  await pressKey(page, 'c');
  const rr = await layerRect(page, row.id);
  await page.mouse.click(rr.x + 40, rr.y + 40);
  await sleep(40);
  await page.waitForSelector('.ov-composer textarea');
  await shot(page, 'comment-composer');
  await page.keyboard.type('Should this be bigger?');
  await page.keyboard.press('Enter');
  await sleep(60);
  check(ctx, 'comments: thread created', doc.getComments().length === 1 && doc.getComments()[0]!.messages[0]!.text === 'Should this be bigger?', doc.getComments());
  check(ctx, 'comments: pinned to a layer', Boolean(doc.getComments()[0]!.nodeId), doc.getComments()[0]);
  check(ctx, 'comments: pin on the canvas', (await page.$('.ov-pin')) !== null);
  await page.waitForSelector('[data-testid="thread-reply"]');
  await page.click('[data-testid="thread-reply"]');
  await page.keyboard.type('Yes');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'comments: reply', doc.getComments()[0]!.messages.length === 2);
  await shot(page, 'comments');
  await page.click('[data-testid="comments-search"]');
  await page.keyboard.type('nothing like this');
  await sleep(30);
  check(ctx, 'comments: search', (await page.$('[data-testid="thread"]')) === null);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(30);
  await page.hover('[data-testid="thread"]');
  await clickTest(page, 'thread-resolve');
  await sleep(30);
  check(ctx, 'comments: resolve', doc.getComments()[0]!.resolved === true);
  check(ctx, 'comments: resolved leaves the canvas', (await page.$('.ov-pin')) === null);
  await page.select('[data-testid="comments-filter"]', 'resolved');
  await sleep(30);
  check(ctx, 'comments: filter', (await page.$('[data-testid="thread"]')) !== null);

  // Export.
  await clickTest(page, 'tab-export');
  await sleep(30);
  await shot(page, 'export');
  await page.select('[data-testid="export-format"]', 'webp');
  await clickTest(page, 'export-scale-3');
  await clickTest(page, 'export-run');
  await sleep(100);
  const req = ctx.server.exportRequests.at(-1) as { format: string; scale: number; fileId: string; nodeIds: string[] };
  check(ctx, 'export: calls /api/export', req?.format === 'webp' && req.scale === 3 && req.fileId === fileId, req);

  // Agents.
  await clickTest(page, 'tab-agents');
  await clickTest(page, 'agents-part-settings');
  await sleep(30);
  check(ctx, 'agents: connect commands', ((await page.$eval('[data-testid="connect-agent"]', (e) => e.textContent)) ?? '').includes('bogen install claude-code'));
  await clickTest(page, 'agents-part-activity');
  ctx.server.broadcast({ t: 'activity', fileId, agent: 'claude', tool: 'set_style', nodeIds: [row.id], at: Date.now() });
  await sleep(80);
  check(ctx, 'agents: activity feed from /events', (await page.$('[data-testid="feed-row"]')) !== null);
  check(ctx, 'agents: working highlight on nodes', (await page.$('.ov-outline.is-working')) !== null);
  check(ctx, 'agents: undo per agent listed', (await page.$('[data-testid="agent-undo"]')) !== null);
  await shot(page, 'agents');

  // Prompt.
  await clickTest(page, 'tab-design');
  await page.mouse.click(box.x + 10, box.y + 10);
  await sleep(30);
  // Attached to a selection, it sits right under it.
  const rowR = await layerRect(page, row.id);
  await page.mouse.click(rowR.x + rowR.w - 8, rowR.y + rowR.h - 8);
  await sleep(30);
  await pressKey(page, 'Control+k');
  await page.waitForSelector('[data-testid="prompt-input"]');
  await sleep(40);
  const near = await (await page.$('[data-testid="prompt"]'))!.boundingBox();
  check(ctx, 'prompt: attached under the selection', near!.y >= rowR.y + rowR.h && near!.y < rowR.y + rowR.h + 60, [near, rowR]);
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + 10, box.y + 10);
  await sleep(30);
  await pressKey(page, 'Control+k');
  await page.waitForSelector('[data-testid="prompt-input"]');
  await sleep(60);
  check(ctx, 'prompt: runner picker from /api/runners', ((await page.$eval('[data-testid="prompt-runner"]', (e) => e.textContent)) ?? '').includes('Claude Code'));
  await page.keyboard.type('Make it nicer');
  await sleep(20);
  await shot(page, 'prompt');
  await page.keyboard.press('Enter');
  await sleep(70);
  check(ctx, 'prompt: stop button while running', (await page.$('[data-testid="prompt-stop"]')) !== null);
  await sleep(600);
  const msgs = await page.$eval('[data-testid="prompt-messages"]', (e) => e.textContent ?? '');
  check(ctx, 'prompt: streams replies from /events', msgs.includes('Looking at the') && msgs.includes('Done.') && msgs.includes('bogen_set_style'), msgs);
  check(ctx, 'prompt: reaches the server with the runner', ctx.server.runs.at(-1)?.runner === 'claude' && ctx.server.runs.at(-1)?.prompt === 'Make it nicer', ctx.server.runs.at(-1));
  await shot(page, 'prompt-done');
  await page.keyboard.press('Escape');
  await sleep(30);
  check(ctx, 'prompt: Esc closes', (await page.$('[data-testid="prompt-input"]')) === null);

  // Shortcuts dialog from the registry.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pressKey(page, 'Control+/');
  await page.waitForSelector('[data-testid="shortcuts-dialog"]');
  const all = (await page.$$('[data-testid="shortcut-row"]')).length;
  check(ctx, 'shortcuts: dialog lists the registry', all > 60, all);
  await sleep(40);
  await shot(page, 'shortcuts');
  await page.keyboard.type('flip');
  await sleep(30);
  check(ctx, 'shortcuts: searchable', (await page.$$('[data-testid="shortcut-row"]')).length === 2, (await page.$$('[data-testid="shortcut-row"]')).length);
  await page.keyboard.press('Escape');
  await sleep(30);
  check(ctx, 'shortcuts: Esc closes', (await page.$('[data-testid="shortcuts-dialog"]')) === null);

  // Typing does not trigger tools.
  await clickTest(page, 'tab-comments');
  await page.click('[data-testid="comments-search"]');
  await page.keyboard.type('rf');
  await sleep(20);
  const toolActive = await page.$eval('[data-testid="tool-move"]', (e) => e.classList.contains('is-active'));
  check(ctx, 'shortcuts: ignored while typing', toolActive);
  await clickTest(page, 'tab-design');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Minimal UI and panel resize.
  await pressKey(page, 'Control+\\');
  await sleep(30);
  check(ctx, 'layout: minimal hides the panels', (await page.$('[data-testid="left-panel"]')) === null);
  await shot(page, 'minimal');
  await pressKey(page, 'Control+\\');
  await sleep(30);
  check(ctx, 'layout: back from minimal', (await page.$('[data-testid="left-panel"]')) !== null);
  const r0 = await page.$eval('[data-testid="left-panel"]', (e) => e.getBoundingClientRect().width);
  const rz = await (await page.$('[data-testid="resizer-left"]'))!.boundingBox();
  await drag(page, rz!.x + 3, rz!.y + 200, rz!.x + 63, rz!.y + 200);
  await sleep(30);
  const r1 = await page.$eval('[data-testid="left-panel"]', (e) => e.getBoundingClientRect().width);
  check(ctx, 'layout: resizable panel', Math.abs(r1 - r0 - 60) < 4, [r0, r1]);

  // Theme.
  ctx.server.setTheme({ name: 'test', mode: 'dark', vars: { '--ui-bg': '#101418', '--ui-bg-2': '#171c21', '--ui-bg-3': '#20262c', '--ui-fg': '#e6edf3', '--ui-fg-2': '#8b98a5', '--ui-border': '#2a3138', '--ui-accent': '#e0af68', '--ui-accent-fg': '#101418', '--ui-danger': '#f7768e' } });
  await sleep(350);
  const bg = await page.$eval('[data-testid="toolbar"]', (e) => getComputedStyle(e).backgroundColor);
  check(ctx, 'theme: { t: theme } applies live', bg === 'rgb(16, 20, 24)', bg);
  await shot(page, 'theme-dark');
  ctx.server.setTheme(null);
  await sleep(300);
  check(ctx, 'panels: no page errors', errors.length === 0, errors);
  await page.close();

  // /api/theme on load.
  ctx.server.setTheme({ name: 't2', mode: 'light', vars: { '--ui-accent': '#118844' } });
  const p2 = await ctx.browser.newPage();
  await p2.goto(`${ctx.base}/#/`);
  await p2.waitForSelector('[data-testid="home"]');
  await sleep(150);
  const accent = await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim());
  check(ctx, 'theme: GET /api/theme on load', accent === '#118844', accent);
  ctx.server.setTheme(null);
  await p2.close();

  // Default dark via prefers-color-scheme.
  const p3 = await ctx.browser.newPage();
  await p3.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await p3.goto(`${ctx.base}/#/file/${fileId}`);
  await p3.waitForSelector('[data-testid="canvas"]');
  await sleep(200);
  const darkBg = await p3.$eval('[data-testid="toolbar"]', (e) => getComputedStyle(e).backgroundColor);
  check(ctx, 'theme: dark default without a theme', darkBg === 'rgb(28, 28, 27)', darkBg);
  await shot(p3, 'default-dark');
  await p3.close();
}

async function multiplayer(ctx: Ctx): Promise<void> {
  const a = await ctx.browser.createBrowserContext();
  const b = await ctx.browser.createBrowserContext();
  const { page: pa, fileId, errors: ea } = await newFilePage(ctx, 'Multi', a);
  const pb = await b.newPage();
  const eb: string[] = [];
  pb.on('pageerror', (e) => eb.push(String(e)));
  await pb.goto(`${ctx.base}/#/file/${fileId}`);
  await pb.waitForSelector('[data-testid="canvas"]');
  await sleep(200);
  const doc = docOf(ctx, fileId);
  const box = await canvasBox(pa);

  // A draws, B sees it.
  await pressKey(pa, 'f');
  await drag(pa, box.x + 100, box.y + 80, box.x + 500, box.y + 400);
  const frame = allNodes(doc)[0]!;
  await sleep(120);
  check(ctx, 'multiplayer: B sees A draw', (await pb.$(`[data-bogen-id="${frame.id}"]`)) !== null);

  // B edits, A sees it.
  await pb.evaluate(() => 0);
  const fb = await layerRect(pb, frame.id);
  await pb.mouse.click(fb.x + 50, fb.y + 50);
  await sleep(30);
  await fillField(pb, 'insp-radius', '20');
  await sleep(120);
  const radius = await pa.$eval(`[data-bogen-id="${frame.id}"]`, (e) => getComputedStyle(e).borderRadius);
  check(ctx, 'multiplayer: A sees B edit', radius === '20px', radius);

  // Undo stays per actor: A undoing does not touch B's radius.
  await pa.bringToFront();
  await pressKey(pa, 'Control+z');
  await sleep(120);
  const stillThere = doc.getNode(frame.id);
  check(ctx, 'multiplayer: undo removes only my own edit', !stillThere, stillThere?.style);
  await pressKey(pa, 'Control+Shift+z');
  await sleep(120);
  check(ctx, 'multiplayer: redo brings it back', Boolean(doc.getNode(frame.id)));

  // Cursors and names.
  await pa.mouse.move(box.x + 300, box.y + 200);
  await sleep(20);
  await pa.mouse.move(box.x + 320, box.y + 220);
  await sleep(150);
  check(ctx, 'multiplayer: B sees A as a named cursor', (await pb.$('.ov-cursor')) !== null);
  const peers = await pb.$$('[data-testid="peer"]');
  check(ctx, 'multiplayer: peer listed', peers.length === 1, peers.length);

  // Selection outline of others.
  const fa = await layerRect(pa, frame.id);
  await pa.mouse.click(fa.x + 60, fa.y + 60);
  await sleep(150);
  check(ctx, 'multiplayer: B sees the selection of A', (await pb.$('.ov-outline.is-peer')) !== null);
  await pb.bringToFront();
  await sleep(50);
  await shot(pb, 'multiplayer');

  // Cursor chat.
  await pa.bringToFront();
  await pa.mouse.move(box.x + 330, box.y + 230);
  await pressKey(pa, '/');
  await pa.waitForSelector('.ov-chat input');
  await pa.keyboard.type('hello there');
  await sleep(120);
  const chat = await pb.$eval('.ov-cursor-chat', (e) => e.textContent);
  check(ctx, 'multiplayer: cursor chat', chat === 'hello there', chat);
  await pb.bringToFront();
  await shot(pb, 'cursor-chat');
  await pa.bringToFront();
  await pa.keyboard.press('Enter');

  // Follow.
  await pb.bringToFront();
  await clickTest(pb, 'peer');
  await sleep(40);
  check(ctx, 'multiplayer: following shows', (await pb.$('[data-testid="follow-pill"]')) !== null);
  await pa.bringToFront();
  await pressKey(pa, 'Shift+Digit0');
  await pressKey(pa, '=');
  await sleep(250);
  const zb = await pb.$eval('[data-testid="zoom-level"]', (e) => e.textContent);
  check(ctx, 'multiplayer: follow applies their zoom', zb === '150%', zb);
  await pb.bringToFront();
  await clickTest(pb, 'follow-pill');

  // Agent cursor through the same awareness: simulated by a third client from the server's side.
  const rec = ctx.server.files.get(fileId)!;
  rec.aw.setLocalState({ user: { name: 'claude', color: '#a855f7', agent: true }, cursor: { x: 200, y: 200, pageId: doc.getPages()[0]!.id }, selection: [frame.id], pageId: doc.getPages()[0]!.id });
  await sleep(120);
  check(ctx, 'multiplayer: agent shows as a cursor', ((await pb.$$eval('.ov-cursor.is-agent .ov-cursor-name', (e) => e.map((x) => x.textContent))) ?? [])[0] === 'claude');
  check(ctx, 'multiplayer: agent working highlight', (await pb.$('.ov-outline.is-working')) !== null);
  await shot(pb, 'agent-cursor');
  rec.aw.setLocalState(null);

  // Connection lost.
  ctx.server.dropSync();
  await sleep(300);
  check(ctx, 'multiplayer: banner when connection is lost', (await pb.$('[data-testid="connection-banner"]')) !== null);
  await shot(pb, 'connection-lost');
  // Edit while offline, then reconnect.
  await pb.bringToFront();
  await pressKey(pb, 'Shift+Digit1');
  await sleep(30);
  const fbb = await layerRect(pb, frame.id);
  await pb.mouse.click(fbb.x + 50, fbb.y + 50);
  await sleep(30);
  await fillField(pb, 'insp-radius', '44');
  ctx.server.resumeSync();
  await pb.waitForSelector('[data-testid="connection-banner"]', { hidden: true, timeout: 8000 });
  await sleep(300);
  check(ctx, 'multiplayer: edits made offline sync on reconnect', doc.getNode(frame.id)?.style.borderRadius === '44px', doc.getNode(frame.id)?.style.borderRadius);

  check(ctx, 'multiplayer: no page errors', ea.length === 0 && eb.length === 0, [...ea, ...eb]);
  await a.close();
  await b.close();
}

async function perfSection(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Perf');
  const doc = docOf(ctx, fileId);
  const pageId = doc.getPages()[0]!.id;
  const COUNT = 5000;
  const specs = Array.from({ length: COUNT }, (_, i) => ({
    type: 'frame' as const,
    name: `Layer ${i}`,
    style: { position: 'absolute', left: `${(i % 100) * 24}px`, top: `${Math.floor(i / 100) * 24}px`, width: '20px', height: '20px', backgroundColor: `hsl(${i % 360} 70% 60%)`, borderRadius: '3px' },
  }));
  const t0 = Date.now();
  doc.insertMany(pageId, specs, undefined, 'server');
  await page.waitForFunction((n) => document.querySelectorAll('[data-bogen-id]').length >= n, { timeout: 60000 }, COUNT);
  const mountMs = Date.now() - t0;
  console.log(`5000 layers: mounted in ${mountMs} ms`);
  await sleep(200);
  await pressKey(page, 'Shift+Digit1');
  await sleep(500);

  // Pan FPS with the actual wheel path.
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  const fps = await page.evaluate(async () => {
    const canvas = document.querySelector('[data-testid="canvas"]')!;
    const frames: number[] = [];
    let last = performance.now();
    let n = 0;
    return await new Promise<{ fps: number; p95: number; max: number }>((resolve) => {
      const step = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: n % 2 ? 6 : -4, deltaY: 3, bubbles: true, cancelable: true }));
        n++;
        if (n < 180) requestAnimationFrame(step);
        else {
          const f = frames.slice(5).sort((a, b) => a - b);
          const mean = f.reduce((a, b) => a + b, 0) / f.length;
          resolve({ fps: 1000 / mean, p95: f[Math.floor(f.length * 0.95)]!, max: f.at(-1)! });
        }
      };
      requestAnimationFrame(step);
    });
  });
  console.log(`pan: ${fps.fps.toFixed(1)} fps, p95 frame ${fps.p95.toFixed(1)} ms, worst ${fps.max.toFixed(1)} ms`);
  check(ctx, 'perf: pan at 5,000 layers holds frame rate', fps.fps > 45, fps);

  // Style update to paint, with a measured element and a real inspector edit.
  await pressKey(page, 'Shift+Digit1');
  await sleep(100);
  const id = doc.getChildren(pageId).at(-1)!.id;
  await pressKey(page, 'Tab');
  await sleep(100);
  const sel = await page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.length);
  check(ctx, 'perf: selection reached the layer list', sel === 1, sel);
  // Time from a local transaction to the DOM having the new value.
  const timings = await page.evaluate(async () => {
    const hook = (window as unknown as { __bogenTest: { setStyle: (patch: Record<string, string>) => string } }).__bogenTest;
    const out: number[] = [];
    for (let i = 0; i < 40; i++) {
      const color = `rgb(${i * 3}, 20, 40)`;
      const t = performance.now();
      const el = document.querySelector(`[data-bogen-id="${hook.setStyle({ backgroundColor: color })}"]`) as HTMLElement;
      await Promise.resolve();
      await Promise.resolve();
      while (el.style.backgroundColor !== color) await new Promise((r) => setTimeout(r, 0));
      out.push(performance.now() - t);
      await new Promise((r) => requestAnimationFrame(r));
    }
    out.sort((a, b) => a - b);
    return { median: out[20]!, p95: out[38]!, max: out[39]! };
  });
  console.log(`style update to DOM: median ${timings.median.toFixed(2)} ms, p95 ${timings.p95.toFixed(2)} ms, worst ${timings.max.toFixed(2)} ms`);
  check(ctx, 'perf: style update stays local and fast', timings.median < 16, timings);

  // Re-render count of NodeView: one edit touches one element.
  // Drag one layer among 5,000.
  const r2 = await layerRect(page, id);
  const dragTime = await (async () => {
    const t = Date.now();
    await page.mouse.move(r2.x + r2.w / 2, r2.y + r2.h / 2);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) await page.mouse.move(r2.x + i * 2, r2.y + i);
    await page.mouse.up();
    return Date.now() - t;
  })();
  console.log(`drag of one layer, 40 moves: ${dragTime} ms (${(dragTime / 40).toFixed(1)} ms per move, includes CDP round trip)`);

  // Layer tree virtualization: how many rows really exist.
  const rowCount = (await page.$$('[data-testid="layer-row"]')).length;
  console.log(`layer rows in the DOM for 5000 layers: ${rowCount}`);
  check(ctx, 'perf: layer tree is virtualized', rowCount < 100, rowCount);
  await shot(page, 'perf-5000');

  // Select all and move the marquee logic.
  const tSel = Date.now();
  await pressKey(page, 'Escape');
  await pressKey(page, 'Control+a');
  await sleep(100);
  console.log(`select all 5000: ${Date.now() - tSel - 100} ms`);
  check(ctx, 'perf: no page errors', errors.length === 0, errors);
  await page.close();
}


async function extras(ctx: Ctx): Promise<void> {
  const { page, fileId, errors } = await newFilePage(ctx, 'Extras');
  const doc = docOf(ctx, fileId);
  const page0 = () => doc.getPages()[0]!.id;
  const box = await canvasBox(page);

  // Frame presets.
  await pressKey(page, 'f');
  await sleep(30);
  check(ctx, 'tools: F shows size presets', (await page.$('[data-testid="preset-Phone"]')) !== null);
  await clickTest(page, 'preset-Phone');
  await sleep(50);
  const phone = allNodes(doc).find((n) => n.name === 'Phone');
  check(ctx, 'tools: preset makes an artboard of that size', phone?.artboard === true && phone.style.width === '393px' && phone.style.height === '852px', phone);
  await clickTest(page, 'tab-design');
  const pr = await layerRect(page, phone!.id);
  check(ctx, 'tools: a new artboard is brought into view', pr.y >= box.y && pr.y + pr.h <= box.y + box.h, pr);
  await pressKey(page, 'Control+z');
  await sleep(30);

  // Image from the file picker.
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), page.click('[data-testid="tool-image"]')]);
  const png = resolve(import.meta.dirname, '../fixtures/pixel.png');
  await chooser.accept([png]);
  await sleep(300);
  check(ctx, 'tools: image from the file picker', allNodes(doc).some((n) => n.type === 'image'));
  await pressKey(page, 'Delete');
  await sleep(30);

  // Double click drills in, then edits text.
  await paste(page, { 'text/html': '<div data-name="Outer" style="display:flex;padding:24px;background:#eee"><div data-name="Inner" style="display:flex;padding:12px;background:#ddd"><p data-name="Label" style="font-size:20px">Drill me</p></div></div>' });
  await sleep(40);
  const byName = (name: string) => allNodes(doc).find((n) => n.name === name)!;
  await pressKey(page, 'Escape');
  await page.mouse.click(box.x + 4, box.y + 4);
  await sleep(20);
  const selName = () => page.$$eval('[data-testid="layer-row"].is-selected', (e) => e.map((x) => x.getAttribute('data-name')));
  const lr = await layerRect(page, byName('Label').id);
  await page.mouse.click(lr.x + 10, lr.y + 10);
  await sleep(30);
  check(ctx, 'selection: first click takes the child of the top frame', (await selName())[0] === 'Inner', await selName());
  await page.mouse.click(lr.x + 10, lr.y + 10, { count: 2 });
  await sleep(40);
  check(ctx, 'selection: double click drills in', (await selName())[0] === 'Label', await selName());
  await page.mouse.click(lr.x + 10, lr.y + 10, { count: 2 });
  await sleep(60);
  check(ctx, 'selection: double click on text edits it', await page.$eval(`[data-bogen-id="${byName('Label').id}"]`, (e) => (e as HTMLElement).isContentEditable));
  await page.keyboard.down('Control');
  await page.keyboard.press('a', { commands: ['SelectAll'] });
  await page.keyboard.up('Control');
  await page.keyboard.type('Edited');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await page.mouse.click(box.x + 4, box.y + 4);
  await sleep(50);
  check(ctx, 'text: multi-line edit commits on click away', byName('Label').text === 'Edited\nSecond line', byName('Label').text);
  check(ctx, 'text: the element leaves edit mode', !(await page.$eval(`[data-bogen-id="${byName('Label').id}"]`, (e) => (e as HTMLElement).isContentEditable)));
  const shown = await page.$eval(`[data-bogen-id="${byName('Label').id}"]`, (e) => (e as HTMLElement).innerText);
  check(ctx, 'text: the DOM shows the committed text', shown === 'Edited\nSecond line', shown);
  await pressKey(page, 'Control+z');
  await sleep(40);
  check(ctx, 'text: one undo step for the whole edit', byName('Label').text === 'Drill me', byName('Label').text);
  check(ctx, 'text: undo reaches the DOM', (await page.$eval(`[data-bogen-id="${byName('Label').id}"]`, (e) => (e as HTMLElement).innerText)) === 'Drill me');

  // Gap and padding handles on the canvas.
  await paste(page, { 'text/html': '<div data-name="Stack" style="position:absolute;display:flex;flex-direction:column;gap:20px;padding:30px;width:300px;background:#f4f4f4"><div data-name="S1" style="height:60px;background:#88a"></div><div data-name="S2" style="height:60px;background:#a88"></div></div>' });
  await sleep(50);
  const stack = byName('Stack');
  await page.click(`[data-layer="${stack.id}"]`);
  await sleep(40);
  await page.mouse.move(box.x + 2, box.y + 2);
  await sleep(40);
  await shot(page, 'gap-padding-handles');
  const padTop = await page.$('.ov-pad-top');
  const pb = await padTop!.boundingBox();
  await drag(page, pb!.x + pb!.width / 2, pb!.y + pb!.height / 2, pb!.x + pb!.width / 2, pb!.y + pb!.height / 2 + 14);
  await sleep(30);
  check(ctx, 'handles: padding handle drags one side', (doc.getNode(stack.id)!.style.padding ?? '').startsWith('44px 30px 30px'), doc.getNode(stack.id)!.style.padding);
  await pressKey(page, 'Control+z');
  await sleep(30);
  check(ctx, 'handles: padding drag undoes in one step', doc.getNode(stack.id)!.style.padding === '30px', doc.getNode(stack.id)!.style.padding);
  const gap = await page.$('.ov-gap');
  const gb = await gap!.boundingBox();
  await drag(page, gb!.x + gb!.width / 2, gb!.y + gb!.height / 2, gb!.x + gb!.width / 2, gb!.y + gb!.height / 2 + 10);
  await sleep(30);
  check(ctx, 'handles: gap handle changes gap', px(doc.getNode(stack.id)!.style.gap) > 20, doc.getNode(stack.id)!.style.gap);
  await pressKey(page, 'Control+z');
  await sleep(20);

  // Token binding from the picker.
  await clickTest(page, 'tab-tokens');
  await page.click('[data-testid="token-new-name"]');
  await page.keyboard.type('brand');
  await page.keyboard.press('Tab');
  await page.keyboard.type('#ff00aa');
  await page.keyboard.press('Enter');
  await sleep(30);
  await clickTest(page, 'tab-layers');
  await page.click(`[data-layer="${stack.id}"]`);
  await sleep(30);
  await clickTest(page, 'fill-swatch-0');
  await sleep(40);
  await page.click('.picker-token');
  await sleep(40);
  check(ctx, 'tokens: bind a fill to a token', doc.getNode(stack.id)!.style.backgroundColor === 'var(--brand)', doc.getNode(stack.id)!.style.backgroundColor);
  const painted = await page.$eval(`[data-bogen-id="${stack.id}"]`, (e) => getComputedStyle(e).backgroundColor);
  check(ctx, 'tokens: binding paints the token value', painted === 'rgb(255, 0, 170)', painted);
  await page.keyboard.press('Escape');
  await sleep(20);

  // Selection colours rewrite across descendants.
  const seen = await page.evaluate(() => [...document.querySelectorAll('[data-section="Selection colours"] .color-text input')].map((e) => (e as HTMLInputElement).value));
  check(ctx, 'colours: selection colours lists the subtree', seen.includes('#88a') && seen.includes('#a88'), seen);
  const row = await page.evaluateHandle(() => [...document.querySelectorAll('[data-section="Selection colours"] .color-text input')].find((e) => (e as HTMLInputElement).value === '#88a'));
  await (row.asElement() as import('puppeteer-core').ElementHandle<Element>).click();
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type('#00ff00');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'colours: replacing rewrites the descendant', byName('S1').style.background === '#00ff00' || byName('S1').style.backgroundColor === '#00ff00', byName('S1').style);

  // Per-corner radius.
  await clickTest(page, 'insp-corners');
  await sleep(20);
  const corner = await page.evaluateHandle(() => [...document.querySelectorAll('.corners-grid input')][1]);
  await (corner.asElement() as import('puppeteer-core').ElementHandle<Element>).click();
  await page.keyboard.type('16');
  await page.keyboard.press('Enter');
  await sleep(30);
  check(ctx, 'appearance: per-corner radius', (doc.getNode(stack.id)!.style.borderRadius ?? '').includes('16px'), doc.getNode(stack.id)!.style.borderRadius);

  // Frame label: a drag moves the frame, a double click renames.
  await pressKey(page, 'f');
  await drag(page, box.x + 40, box.y + 500, box.x + 240, box.y + 700);
  const art = allNodes(doc).filter((n) => n.artboard).at(-1)!;
  await pressKey(page, 'Escape');
  const label = await page.$(`[data-frame-label="${art.id}"]`);
  const lb = await label!.boundingBox();
  const left0 = px(doc.getNode(art.id)!.style.left);
  await drag(page, lb!.x + 8, lb!.y + 6, lb!.x + 48, lb!.y + 6);
  check(ctx, 'canvas: dragging a frame label moves the frame', Math.abs(px(doc.getNode(art.id)!.style.left) - left0 - 40) < 8, doc.getNode(art.id)!.style.left);
  const lb2 = await (await page.$(`[data-frame-label="${art.id}"]`))!.boundingBox();
  await page.mouse.click(lb2!.x + 8, lb2!.y + 6, { count: 2 });
  await page.waitForSelector('.ov-frame-rename');
  await page.keyboard.type('Hero');
  await page.keyboard.press('Enter');
  await sleep(40);
  check(ctx, 'canvas: double click on a label renames', doc.getNode(art.id)!.name === 'Hero', doc.getNode(art.id)!.name);

  // Paste on top and paste to replace, with real keyboard events and the system clipboard.
  await ctx.browser.defaultBrowserContext().overridePermissions(ctx.base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  await page.click(`[data-layer="${byName('S2').id}"]`);
  await sleep(30);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyC', { commands: ['Copy'] });
  await page.keyboard.up('Control');
  await sleep(50);
  const clipText = await page.evaluate(() => navigator.clipboard.readText().catch((e: Error) => `ERR ${e.message}`));
  console.log(`clipboard text after a real ctrl+C: ${JSON.stringify(clipText)}`);
  const beforePaste = allNodes(doc).length;
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyV', { commands: ['Paste'] });
  await page.keyboard.up('Control');
  await sleep(120);
  check(ctx, 'clipboard: real ctrl+C and ctrl+V', allNodes(doc).length === beforePaste + 1, [beforePaste, allNodes(doc).length]);
  await pressKey(page, 'Control+z');
  await sleep(50);

  // Replace a selected layer with what was copied.
  const targetLayer = byName('S1');
  await page.click(`[data-layer="${targetLayer.id}"]`);
  await sleep(30);
  await pressKey(page, 'Control+Shift+r');
  await sleep(200);
  check(ctx, 'clipboard: paste to replace', !doc.getNode(targetLayer.id), doc.getNode(targetLayer.id)?.name);
  const stackKids = doc.getChildren(stack.id).map((k) => k.name);
  check(ctx, 'clipboard: replacement sits in the same slot', stackKids.join() === 'S2,S2', stackKids);
  await pressKey(page, 'Control+z');
  await sleep(50);

  // Paste on top keeps the exact position.
  await page.click(`[data-layer="${byName('S2').id}"]`);
  await sleep(30);
  await pressKey(page, 'Delete');
  await sleep(30);
  await pressKey(page, 'Control+z');
  await sleep(30);

  // Context menu.
  const cr = await layerRect(page, stack.id);
  await page.mouse.click(cr.x + 10, cr.y + 10, { button: 'right' });
  await sleep(40);
  check(ctx, 'canvas: right click opens a menu', (await page.$('.menu')) !== null);
  await shot(page, 'context-menu');
  await page.keyboard.press('Escape');
  await sleep(20);
  check(ctx, 'canvas: Esc closes the menu', (await page.$('.menu')) === null);

  // Escape cancels a running drag, whatever was already written.
  const before = doc.getNode(art.id)!;
  const ar = await layerRect(page, art.id);
  await page.mouse.click(ar.x + 60, ar.y + 60);
  await sleep(20);
  await page.mouse.move(ar.x + 60, ar.y + 60);
  await page.mouse.down();
  await page.mouse.move(ar.x + 200, ar.y + 160, { steps: 8 });
  await sleep(100);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await sleep(40);
  check(ctx, 'transform: Esc cancels a move', doc.getNode(art.id)!.style.left === before.style.left, [before.style.left, doc.getNode(art.id)!.style.left]);
  const back = await layerRect(page, art.id);
  check(ctx, 'transform: Esc puts the DOM back too', Math.abs(back.x - ar.x) < 1, [back.x, ar.x]);

  // Resizing several layers scales them as a group.
  await page.mouse.click(box.x + 4, box.y + 4);
  await sleep(20);
  await pressKey(page, 'r');
  await drag(page, box.x + 500, box.y + 500, box.x + 560, box.y + 560);
  await pressKey(page, 'Escape');
  await pressKey(page, 'r');
  await drag(page, box.x + 600, box.y + 520, box.x + 640, box.y + 560);
  const rects = allNodes(doc).filter((n) => n.name === 'Rectangle');
  await page.click(`[data-layer="${rects[0]!.id}"]`);
  await page.keyboard.down('Control');
  await page.click(`[data-layer="${rects[1]!.id}"]`);
  await page.keyboard.up('Control');
  await sleep(30);
  await shot(page, 'multi-selection');
  const seH = await (await page.$('.ov-handle-se'))!.boundingBox();
  const w0 = px(doc.getNode(rects[0]!.id)!.style.width);
  await drag(page, seH!.x + 4, seH!.y + 4, seH!.x + 4 + 140, seH!.y + 4 + 60);
  const w1 = px(doc.getNode(rects[0]!.id)!.style.width);
  check(ctx, 'transform: resizing several scales them together', w1 > w0 * 1.5, [w0, w1]);

  // Chrome styles stay out of the world: defaults there match a bare exported document.
  await paste(page, { 'text/html': '<div data-name="Raw" style="position:absolute;left:900px;top:0"><code data-name="RawCode">x()</code><button data-name="RawBtn">Go</button><input data-name="RawInput"></div>' });
  await sleep(40);
  const fontOf = (name: string, prop: string) => page.$eval(`[data-bogen-id="${byName(name).id}"]`, (e, p) => getComputedStyle(e).getPropertyValue(p as string), prop);
  check(ctx, 'world: <code> keeps its monospace default', /monospace/.test(await fontOf('RawCode', 'font-family')), await fontOf('RawCode', 'font-family'));
  check(ctx, 'world: chrome font does not leak into layers', !/Source Sans/.test(await fontOf('RawBtn', 'font-family')) && !/Source Sans/.test(await fontOf('RawInput', 'font-family')), await fontOf('RawInput', 'font-family'));
  const worldColor = await page.$eval('.bogen-world', (e) => getComputedStyle(e).color);
  check(ctx, 'world: default text colour is black', worldColor === 'rgb(0, 0, 0)', worldColor);
  await pressKey(page, 'Delete');
  await sleep(20);

  // Flatten leaves text out; Tab with no selection picks the top.
  await page.mouse.click(box.x + 4, box.y + 4);
  await pressKey(page, 'Tab');
  await sleep(20);
  check(ctx, 'selection: Tab with nothing selected takes the top layer', (await selName()).length === 1);
  check(ctx, 'extras: no page errors', errors.length === 0, errors);
  void page0;
  await page.close();
}

const SECTIONS: [string, (ctx: Ctx) => Promise<void>][] = [
  ['home', home], ['canvas', canvas], ['selection', selection], ['snapping', snapping], ['inspector', inspector],
  ['layers', layerTree], ['edit', edit], ['vector', vector], ['shader', shader], ['panels', panels], ['multiplayer', multiplayer], ['extras', extras], ["perf", perfSection],
];

async function main(): Promise<void> {
  const ctx = await setup();
  let crashed = false;
  try {
    for (const [name, fn] of SECTIONS) {
      if (!want(name)) continue;
      console.log(`\n== ${name}`);
      try {
        await fn(ctx);
      } catch (err) {
        crashed = true;
        check(ctx, `${name}: finished without throwing`, false, (err as Error).stack);
        const pages = await ctx.browser.pages();
        for (const p of pages.slice(-1)) await p.screenshot({ path: `${process.cwd()}/apps/editor/screenshots/crash-${name}.png` }).catch(() => {});
      }
    }
  } finally {
    const failed = summary(ctx);
    await teardown(ctx);
    process.exit(failed || crashed ? 1 : 0);
  }
}

void main();
