/**
 * The import formats in the real editor: a Mermaid diagram drawn by diagram_insert, and a PDF dropped on the canvas,
 * which comes in through the editor's drop and the server's layer import. One screenshot of each.
 *
 *   npx tsx apps/editor/test/e2e/formats.ts [screenshot folder]
 *
 * Needs a built editor (npm run build --workspace @bogen/editor) and ~/.local/bin/secure-chromium, sandbox on.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixturePdf } from '../../../../packages/server/test/pdf-fixture.ts';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { SHOTS, watchErrors } from './harness.ts';

const out = resolve(process.argv[2] ?? SHOTS);
mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};

async function call<T = any>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
}

const server = await startRealServer();
const browser = await launch(server.port);
const client = new Client({ name: 'formats-e2e', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`)));
  const file = await call(client, 'file_create', { name: 'Formats' });
  await call(client, 'tokens_set', { file_id: file.id, tokens: [
    { name: 'surface', kind: 'color', value: '#ffffff' }, { name: 'bg', kind: 'color', value: '#f4f2ec' }, { name: 'text', kind: 'color', value: '#0e0e0c' },
    { name: 'border', kind: 'color', value: '#8f8c82' }, { name: 'accent', kind: 'color', value: '#2b3df2' }, { name: 'font-body', kind: 'font-family', value: '"Source Sans 3", sans-serif' }, { name: 'radius-md', kind: 'radius', value: '6px' },
  ] });
  const diagram = await call(client, 'diagram_insert', { file_id: file.id, name: 'Sign-up flow', source: `flowchart LR
  A[Open invite] --> B{Has an account?}
  B -- yes --> C[Sign in]
  B -- no --> D[Create account]
  D --> E[Verify email]
  E --> C
  C --> F((Workspace))` });
  check('diagram_insert draws six nodes and six connectors', diagram.counts.nodes === 6 && diagram.counts.connectors === 6, diagram.counts);

  const page = await freshPage(browser);
  const errors: string[] = [];
  watchErrors(page, errors);
  await page.goto(`${server.base}/#/file/${file.id}`);
  await page.waitForSelector('[data-testid="canvas"]', { timeout: 20000 });
  await sleep(1500);
  const mermaidShot = resolve(out, 'formats-mermaid.png');
  await page.screenshot({ path: mermaidShot as `${string}.png` });
  console.log(`screenshot ${mermaidShot}`);

  // A PDF dropped on an empty page comes in as boards of layers.
  const second = await call(client, 'page_create', { file_id: file.id, name: 'PDF' });
  await page.waitForFunction((name: string) => [...document.querySelectorAll('[data-testid="page-row"]')].some((r) => r.textContent?.includes(name)), { timeout: 10000 }, 'PDF');
  const rows = await page.$$('[data-testid="page-row"]');
  await rows.at(-1)!.click();
  await sleep(400);
  const pdf = Buffer.from(await fixturePdf()).toString('base64');
  await page.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'Quarterly report.pdf', { type: 'application/pdf' });
    const data = new DataTransfer();
    data.items.add(file);
    const vp = document.querySelector('[data-testid="canvas"]')!;
    const r = vp.getBoundingClientRect();
    const at = { clientX: r.left + 120, clientY: r.top + 80, bubbles: true, cancelable: true, dataTransfer: data };
    vp.dispatchEvent(new DragEvent('dragover', at));
    vp.dispatchEvent(new DragEvent('drop', at));
  }, pdf);
  const toast = await page.waitForFunction(() => {
    const t = document.querySelector('.toast')?.textContent ?? '';
    return t.includes('pages as layers') ? t : false;
  }, { timeout: 30000 }).then((h) => h.jsonValue() as Promise<unknown>).catch(() => '');
  check('the drop reports pages and what became a picture', String(toast).includes('2 pages as layers') && String(toast).includes('gradient'), toast);
  // Fit the new boards in view.
  await page.keyboard.down('Shift');
  await page.keyboard.press('Digit1');
  await page.keyboard.up('Shift');
  await sleep(1200);
  const tree = await call<string>(client, 'layer_tree', { file_id: file.id, page_id: second.id, depth: 2 }).catch(async () => (await client.callTool({ name: 'layer_tree', arguments: { file_id: file.id, page_id: second.id, depth: 2 } })).content);
  check('the dropped PDF made two boards with text layers', JSON.stringify(tree).includes('Quarterly report, page 1') && JSON.stringify(tree).includes('Quarterly report, page 2'), tree);
  const pdfShot = resolve(out, 'formats-pdf-page.png');
  await page.screenshot({ path: pdfShot as `${string}.png` });
  console.log(`screenshot ${pdfShot}`);
  check('no errors in the page', errors.length === 0, errors);
} finally {
  await client.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
