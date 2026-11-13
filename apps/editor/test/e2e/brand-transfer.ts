/**
 * A design and its brand from one device to another: two real servers from source, each in its own temp BOGEN_HOME,
 * and the real editor in the sandboxed browser on each. The file goes out through the Export tab's .bogen download
 * with "Include its brand" on, comes in through Open on the other device's home screen, and must render there with
 * the brand's colour token and its hosted font.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/brand-transfer.ts
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from 'puppeteer-core';
import { freshPage, launch, sleep, startRealServer, type RealServer } from './craft-harness.ts';

const FONT = readFileSync(join(dirname(createRequire(import.meta.url).resolve('@fontsource-variable/source-sans-3/LICENSE')), 'files/source-sans-3-latin-wght-normal.woff2'));
const SIGNAL = 'rgb(224, 48, 16)';

let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else failures.push(`${name}: ${JSON.stringify(detail)}`);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};

async function agent(server: RealServer): Promise<Client> {
  const client = new Client({ name: 'claude', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`)));
  return client;
}

async function call<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  if (result.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

const testid = (page: Page, id: string, timeout = 15000) => page.waitForSelector(`[data-testid="${id}"]`, { timeout });

/** What the canvas shows of the headline: its colour, its font, and whether that font is really loaded. */
async function headline(page: Page, id: string) {
  await page.waitForSelector(`[data-bogen-id="${id}"]`, { timeout: 20000 });
  await page.waitForFunction(() => document.fonts.status === 'loaded', { timeout: 20000 });
  await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Acme Sans' && f.status === 'loaded'), { timeout: 20000 }).catch(() => {});
  return page.evaluate((nodeId: string) => {
    const el = document.querySelector(`[data-bogen-id="${nodeId}"]`)!;
    const style = getComputedStyle(el);
    const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Acme Sans').map((f) => f.status);
    return { color: style.color, family: style.fontFamily, faces, ready: document.fonts.check('32px "Acme Sans"') };
  }, id);
}

async function main(): Promise<void> {
  const editorDir = process.env.BOGEN_EDITOR_DIR;
  if (!editorDir) throw new Error('Set BOGEN_EDITOR_DIR to a built editor with this change.');
  const a = await startRealServer({ editorDir });
  const b = await startRealServer({ editorDir });
  check('two servers, two homes', a.home !== b.home && a.port !== b.port, { a: a.home, b: b.home });
  const browserA = await launch(a.port);
  const browserB = await launch(b.port);
  try {
    // On the first device: a brand with a colour and a hosted font, and a file that uses both.
    const one = await agent(a);
    const { id: brand } = await call(one, 'brand_create', { name: 'Acme' });
    const font = await call(one, 'brand_asset_add', { brand_id: brand, kind: 'font', name: 'Acme Sans', data_base64: FONT.toString('base64'), mime_type: 'font/woff2', confirmed: true });
    await call(one, 'brand_update', {
      brand_id: brand, confirmed: true,
      items: [
        { section: 'colors', name: 'Signal', role: 'primary', value: '#e03010', token: 'signal' },
        { section: 'families', family: 'Acme Sans', role: 'body', fallback: 'sans-serif', weights: [400, 700], token: 'font-body', assets: [font.src] },
      ],
    });
    await call(one, 'brand_publish', { brand_id: brand, note: 'First' });
    const file = await call(one, 'file_create', { name: 'Launch page' });
    await call(one, 'brand_link', { brand_id: brand, file_id: file.id });
    const board = await call(one, 'artboard_create', { name: 'Hero', width: 600, height: 240 });
    const written = await call<{ ids: string[] }>(one, 'html_write', { target_id: board.id, html: '<h1 style="margin:40px;font-size:32px;color:var(--signal);font-family:var(--font-body)">Plain tools for plain work</h1>' });
    const h1 = written.ids[0];
    const tree = written;
    check('the headline is drawn', Boolean(h1), tree);

    const pageA = await freshPage(browserA);
    await pageA.goto(`${a.base}/#/file/${file.id}`);
    await testid(pageA, 'canvas', 20000);
    const before = await headline(pageA, h1!);
    check('first device: the headline has the brand colour', before.color === SIGNAL, before);
    check('first device: and the brand font, loaded', before.family.includes('Acme Sans') && before.ready, before);

    // The Export tab: the brand is included by default, and can be left out.
    await (await testid(pageA, 'tab-export'))!.click();
    const toggle = await testid(pageA, 'export-bogen-brand-toggle');
    const label = await pageA.$eval('[data-testid="export-bogen-brand"]', (el) => el.textContent ?? '');
    check('the export tab offers the brand, on', label.includes('Acme') && await toggle!.evaluate((el) => (el as HTMLInputElement).checked), label);
    const href = () => pageA.$eval('[data-testid="export-bogen"]', (el) => (el as HTMLAnchorElement).getAttribute('href') ?? '');
    await toggle!.click();
    const without = await href();
    await toggle!.click();
    const withBrand = await href();
    check('leaving it out asks for the file without its brand', without.endsWith('?brand=0') && !withBrand.includes('brand=0'), { without, withBrand });
    const res = await fetch(`${a.base}${withBrand}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    check('the download is a .bogen file with its brand', res.ok && bytes.subarray(0, 7).toString('latin1') === 'BOGEN\x02\n', { status: res.status, magic: bytes.subarray(0, 7).toString('latin1') });

    // On the second device, which has never seen the brand: Open on the home screen.
    check('the second device has no brands', ((await (await fetch(`${b.base}/api/brands`)).json()) as unknown[]).length === 0);
    const pageB = await freshPage(browserB);
    await pageB.goto(`${b.base}/#/`);
    await pageB.waitForSelector('[data-testid="home-open-input"]', { timeout: 20000 });
    await pageB.evaluate((b64: string) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const input = document.querySelector('[data-testid="home-open-input"]') as HTMLInputElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([raw], 'Launch page.bogen', { type: 'application/x-bogen' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, bytes.toString('base64'));
    await pageB.waitForFunction(() => location.hash.startsWith('#/file/'), { timeout: 20000 });
    const importedId = await pageB.evaluate(() => location.hash.slice('#/file/'.length));
    const toast = await pageB.waitForSelector('[data-testid="toast"]', { timeout: 8000 }).then((el) => el?.evaluate((e) => e.textContent ?? ''), () => '');
    check('opening it says the brand came along', /Acme/.test(toast ?? ''), toast);
    const brandsB = (await (await fetch(`${b.base}/api/brands`)).json()) as { id: string; name: string }[];
    check('the brand arrived under the same id', brandsB.length === 1 && brandsB[0]!.id === brand && brandsB[0]!.name === 'Acme', brandsB);
    const linked = (await (await fetch(`${b.base}/api/files/${importedId}/brand`)).json()) as { link: { id: string }; note: { missing?: boolean; name?: string } };
    check('the file links to it, and it is here', linked.link.id === brand && !linked.note.missing, linked);
    await testid(pageB, 'canvas', 20000);
    const after = await headline(pageB, h1!);
    check('second device: the headline has the brand colour', after.color === SIGNAL, after);
    check('second device: and the brand font, loaded from the asset that came along', after.family.includes('Acme Sans') && after.ready && after.faces.includes('loaded'), after);
    // Inside the layer's edge, where the first device draws its outline of what the agent just wrote.
    const glyphs = async (page: Page) => {
      const box = (await (await page.$(`[data-bogen-id="${h1}"]`))!.boundingBox())!;
      return page.screenshot({ clip: { x: box.x + 3, y: box.y + 3, width: box.width - 6, height: box.height - 6 } });
    };
    // The first device's outline of what the agent wrote fades; a few tries give it time to.
    let shotA = await glyphs(pageA);
    let shotB = await glyphs(pageB);
    for (let i = 0; i < 10 && !Buffer.from(shotA).equals(Buffer.from(shotB)); i++) {
      await sleep(300);
      shotA = await glyphs(pageA);
      shotB = await glyphs(pageB);
    }
    if (process.env.BOGEN_SHOTS) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(process.env.BOGEN_SHOTS, 'headline-a.png'), shotA);
      writeFileSync(join(process.env.BOGEN_SHOTS, 'headline-b.png'), shotB);
      await pageA.$eval('[data-testid="export-bogen-brand"]', (el) => el.scrollIntoView());
      await pageA.screenshot({ path: join(process.env.BOGEN_SHOTS, 'device-a.png') as `${string}.png` });
      await pageB.screenshot({ path: join(process.env.BOGEN_SHOTS, 'device-b.png') as `${string}.png` });
    }
    check('the headline looks the same on both devices', Buffer.from(shotA).equals(Buffer.from(shotB)), { a: shotA.length, b: shotB.length });

    // The same file again: the brand here is kept, and nothing differs.
    const again = await fetch(`${b.base}/api/files/import`, { method: 'POST', headers: { 'Content-Type': 'application/x-bogen', 'X-Bogen-Filename': 'Launch page.bogen' }, body: bytes });
    const second = (await again.json()) as { brand?: { status: string; differs: boolean } };
    check('opening it again keeps the brand that is here', second.brand?.status === 'kept' && second.brand.differs === false, second);
    await one.close();
  } finally {
    console.log(`\n${passed}/${passed + failures.length} checks passed`);
    for (const f of failures) console.log(`  FAIL ${f.slice(0, 500)}`);
    await browserA.close().catch(() => {});
    await browserB.close().catch(() => {});
    await a.close();
    await b.close();
  }
  process.exit(failures.length ? 1 : 0);
}

await main().catch((e) => {
  console.error(e);
  process.exit(1);
});
