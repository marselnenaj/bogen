// Captures pages and measures how close the rendered layers come to the page itself.
// Usage: npx tsx scripts/capture-fidelity.ts <out-dir> <url> [more urls...] [--width=1440] [--scheme=dark]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { BogenServer } from '../packages/server/src/http/server.ts';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const [out, ...urls] = positional as [string, ...string[]];
const width = Number(flag('width', '1440'));
const scheme = flag('scheme', 'dark') as 'dark' | 'light';
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'bogen-fid-'));
const server = new BogenServer({ home, port: 0, exportDir: join(home, 'x') });
await server.listen();
const file = server.storage.create('Fidelity');
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true });
const diffPage = await browser.newPage();
await diffPage.evaluateOnNewDocument('globalThis.__name = (f) => f');
await diffPage.goto('about:blank');

const diff = (a: string, b: string) => diffPage.evaluate(async (ua: string, ub: string) => {
  const load = (u: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const [ia, ib] = await Promise.all([load(ua), load(ub)]);
  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
  const read = (i: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!; x.drawImage(i, 0, 0); return x.getImageData(0, 0, w, h).data; };
  const da = read(ia), db = read(ib);
  let wrong = 0;
  const rows = new Array<number>(Math.ceil(h / 100)).fill(0);
  for (let p = 0; p < da.length; p += 4) {
    const d = Math.abs(da[p]! - db[p]!) + Math.abs(da[p + 1]! - db[p + 1]!) + Math.abs(da[p + 2]! - db[p + 2]!);
    if (d > 48) { wrong++; rows[Math.floor(p / 4 / w / 100)]!++; }
  }
  const bad = rows.map((n, i) => [i * 100, Math.round((n / (w * 100)) * 100)] as const).filter(([, pct]) => pct > 5);
  return { originalSize: `${ia.width}x${ia.height}`, resultSize: `${ib.width}x${ib.height}`, wrongPct: +(wrong / (w * h) * 100).toFixed(2), badBands: bad };
}, a, b);

const toData = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
for (const url of urls) {
  const slug = new URL(url).pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'index';
  const started = Date.now();
  const placed = await server.capturePageInto(file.id, { url, width, colorScheme: scheme, name: slug });
  const room = await server.rooms.get(file.id);
  if (process.env.DUMP) {
    const want = new RegExp(process.env.DUMP);
    for (const n of (await server.rooms.get(file.id)).doc.descendants(placed.nodeId)) if (want.test(n.name)) console.log(JSON.stringify({ name: n.name, tag: n.tag, type: n.type, style: n.style, kids: (await server.rooms.get(file.id)).doc.getChildren(n.id).length, svg: n.svg?.slice(0, 400) }));
  }
  const shot = await server.renderer.screenshot(room.doc, { nodeIds: [placed.nodeId] }, { format: 'png', scale: 1, maxDimension: 100000 } as never);
  const original = await server.storage.readAsset(placed.original.split('/').pop()!);
  writeFileSync(join(out, `${slug}-${width}-${scheme}-original.png`), original!.bytes);
  const bytes = (shot as unknown as { data?: Uint8Array; bytes?: Uint8Array }).bytes ?? (shot as unknown as { data: Uint8Array }).data;
  writeFileSync(join(out, `${slug}-${width}-${scheme}-bogen.png`), Buffer.from(bytes as Uint8Array));
  const result = await diff(toData(original!.bytes), toData(bytes as Uint8Array));
  console.log(JSON.stringify({ slug, ms: Date.now() - started, layers: placed.layers, images: placed.images, failed: placed.failedImages.length, tokens: placed.tokens, ...result }));
}
await browser.close();
await server.close();
rmSync(home, { recursive: true, force: true });
process.exit(0);
