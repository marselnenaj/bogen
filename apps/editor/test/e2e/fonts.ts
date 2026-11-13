/**
 * A font made through the MCP tools, end to end: a small squared display face (font-sample-face.ts) drawn as
 * glyph cells, kerned, built, set as a headline, and looked at in the real editor in a real browser.
 * Run after building the editor: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/fonts.ts
 * Screenshots go to BOGEN_FONT_SHOTS, or a temp folder; the run prints their paths. Nothing is exported.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';
import { GLYPHS, KERNING, METRICS } from './font-sample-face.ts';

const shots = process.env.BOGEN_FONT_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-font-shots-'));
mkdirSync(shots, { recursive: true });
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
};

async function main(): Promise<void> {
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const agent = new Client({ name: 'claude-code', version: '1.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`)));
  const tool = async (name: string, args: object) => {
    const out = await agent.callTool({ name, arguments: args as Record<string, unknown> });
    const text = (out.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
    if (out.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  const browser = await launch(server.port);
  try {
    const file = await tool('file_create', { name: 'Quire' });
    const firstPage = (await tool('page_list', { file_id: file.id }))[0].id as string;

    // 1. The font, through the tools an agent has.
    const made = await tool('font_create', { family: 'Quire Display', style: 'Bold', weight: 700, designer: 'Bogen test run', license: 'OFL-1.1', metrics: { units_per_em: METRICS.unitsPerEm, ascender: METRICS.ascender, cap_height: METRICS.capHeight, x_height: METRICS.xHeight, descender: METRICS.descender } });
    check('font_create answers with the guide lines to draw against', made.y?.baseline === 800 && made.y?.cap_height === 100, made.y);
    const set = await tool('font_glyphs_set', { font_id: made.font_id, glyphs: GLYPHS.map((g) => ({ char: g.char, advance: g.advance, d: g.d })) });
    check(`all ${GLYPHS.length} glyphs are written`, set.glyphs.length === GLYPHS.length, set.glyphs.length);
    const holes = set.glyphs.filter((g: { notes?: string[] }) => g.notes?.some((n) => /fills in/.test(n)));
    check('no counter fills in', holes.length === 0, holes);
    const capHeights = new Set(set.glyphs.filter((g: { char?: string }) => /[EFHIKLMNTXZ]/.test(g.char ?? '')).map((g: { bounds: { top: number } }) => g.bounds.top));
    check('flat capitals all reach the cap height exactly', capHeights.size === 1 && capHeights.has(700), [...capHeights]);
    const o = set.glyphs.find((g: { char?: string }) => g.char === 'O');
    check('rounds overshoot the cap height and baseline', o.bounds.top > 700 && o.bounds.bottom < 0, o.bounds);
    await tool('font_kerning_set', { font_id: made.font_id, pairs: KERNING });
    const built = await tool('font_build', { font_id: made.font_id });
    check('font_build makes OTF and WOFF2 with every glyph and the kerning', built.glyphs === GLYPHS.length + 1 && built.kerning_pairs === KERNING.length && /\.otf$/.test(built.otf) && /\.woff2$/.test(built.woff2), built);
    const listed = await tool('fonts_made', {});
    check('fonts_made lists it as current', listed.length === 1 && listed[0].build?.current === true, listed);
    const specimen = await tool('font_specimen', { font_id: made.font_id, words: 'Paper, pen, agent.' });

    // 2. A headline set in it, on the first page.
    const board = await tool('artboard_create', { name: 'Headline', width: 1200, page_id: firstPage, x: 0, y: 0, background: '#f4f2ec' });
    const written = await tool('html_write', { target_id: board.id, html: '<section style="display:flex;flex-direction:column;gap:24px;padding:80px"><h1 style="margin:0;font-family:\'Quire Display\', sans-serif;font-size:128px;line-height:1;color:#0e0e0c">DRAW YOUR OWN TYPE</h1><p style="margin:0;font-family:\'Quire Display\', sans-serif;font-size:40px;color:#2b3df2">AV LT TO WAY. 0123456789!</p></section>' });
    const h1 = (written.tree as string).match(/(\w+) text <h1>/)?.[1];

    // 3. In the browser: the headline in the editor, measured.
    const page = await freshPage(browser);
    const errors: string[] = [];
    watchErrors(page, errors);
    // A link that differs only after the # does not load the editor again, so each one starts from a blank page.
    const open = async (hash: string) => {
      await page.goto('about:blank');
      await page.goto(`${server.base}/${hash}`);
    };
    await open(`#/file/${file.id}?page=${firstPage}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    await page.waitForFunction(() => document.fonts.check('64px "Quire Display"'), { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const measured = await page.evaluate(() => {
      const ready = document.fonts.check('64px "Quire Display"');
      const probe = (kern: string) => {
        const s = document.createElement('span');
        s.textContent = 'AVAVAV';
        s.style.cssText = `font-family:"Quire Display";font-size:100px;font-kerning:${kern};position:absolute;white-space:nowrap`;
        document.body.appendChild(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
      };
      const fallback = (() => {
        const s = document.createElement('span');
        s.textContent = 'AVAVAV';
        s.style.cssText = 'font-family:sans-serif;font-size:100px;position:absolute;white-space:nowrap';
        document.body.appendChild(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
      })();
      return { ready, kerned: probe('normal'), plain: probe('none'), fallback };
    });
    check('the browser loads the built font from the file', measured.ready, measured);
    // AVAVAV has five kerned pairs of -60 units each: 5 x 60 x 0.1 px = 30 px at 100 px.
    check('the browser applies the kerning', Math.abs(measured.plain - measured.kerned - 30) < 1.5, measured);
    const headlinePath = join(shots, 'headline-editor.png');
    await page.screenshot({ path: headlinePath as `${string}.png` });

    // The inspector's font list offers it, marked as made here.
    if (h1) {
      await open(`#/file/${file.id}?page=${firstPage}&select=${h1}`);
      await page.waitForSelector('[data-testid="font-button"]', { timeout: 15000 });
      await page.click('[data-testid="font-button"]');
      await page.waitForSelector('[data-testid="font-row"]', { timeout: 10000 });
      const rows = await page.$$eval('[data-testid="font-row"]', (els) => els.slice(0, 3).map((e) => e.textContent ?? ''));
      check('the font list shows the font made here first', /Quire Display/.test(rows[0] ?? '') && /Made here/.test(rows[0] ?? ''), rows);
      await page.screenshot({ path: join(shots, 'font-picker.png') as `${string}.png` });
      await page.keyboard.press('Escape');
    }

    // 4. The glyph page: guides, the Font panel, a preview line typed in the current build, and Build font.
    await open(`#/file/${file.id}?page=${made.page_id}`);
    await page.waitForSelector('[data-testid="font-panel"]', { timeout: 20000 });
    await sleep(600);
    await page.type('[data-testid="font-preview-input"]', 'BOGEN DRAWS FONTS');
    const previewFamily = await page.$eval('[data-testid="font-preview"]', (el) => getComputedStyle(el).fontFamily);
    check('the preview line is set in the font', /Quire Display/.test(previewFamily), previewFamily);
    const tiles = await page.$$eval('[data-testid="font-glyphs"] button', (els) => els.length);
    check('the glyph overview shows every glyph', tiles === GLYPHS.length, tiles);
    const before = await page.$eval('[data-testid="font-status"]', (el) => el.textContent);
    await page.click('[data-testid="font-build"]');
    await page.waitForFunction((was) => document.querySelector('[data-testid="font-status"]')?.textContent !== was || !document.querySelector('[data-testid="font-build"]')?.hasAttribute('disabled'), { timeout: 20000 }, before);
    await sleep(800);
    const status = await page.$eval('[data-testid="font-status"]', (el) => el.textContent ?? '');
    check('Build font in the panel builds again', status.includes(`${GLYPHS.length + 1} glyphs, ${KERNING.length} kerning pairs`), status);
    const editorPath = join(shots, 'glyph-page-editor.png');
    await page.screenshot({ path: editorPath as `${string}.png` });

    // 5. The specimen, in a window wide enough to show it at its real size.
    await page.setViewport({ width: 2100, height: 1700, deviceScaleFactor: 1 });
    await open(`#/file/${file.id}?page=${made.page_id}&select=${specimen.id}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
    await sleep(1500);
    const box = await page.evaluate((id) => {
      const r = document.querySelector(`[data-bogen-id="${id}"]`)?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    }, specimen.id);
    const specimenPath = join(shots, 'specimen.png');
    check('the specimen is on the canvas at its real size', Boolean(box && Math.abs(box.w / 1200 - 1) < 0.05), box);
    if (box) await page.screenshot({ path: specimenPath as `${string}.png`, clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.w, 2100 - Math.max(0, box.x)), height: Math.min(box.h, 1700 - Math.max(0, box.y)) } });
    check('no errors in the editor', errors.length === 0, errors);
    console.log(`\nshots: ${shots}\n  ${headlinePath}\n  ${editorPath}\n  ${specimenPath}`);
  } finally {
    await agent.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
