// Writes a big file the way an agent would: about 10,000 layers of landing pages over several artboards, with
// components and their instances, real text and stored images. Out comes a data folder to copy as BOGEN_HOME.
// Usage: npx tsx scripts/gen-perf-fixture.ts <out-dir> [--artboards=8] [--rows=140]
// Prints {home, fileId, pageId, artboards, stored, rendered} as JSON. A server of its own in a temp folder, on no fixed port.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenDoc, Y } from '../packages/core/src/index.ts';
import { BogenServer } from '../packages/server/src/http/server.ts';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const out = positional[0];
if (!out) throw new Error('Usage: gen-perf-fixture.ts <out-dir> [--artboards=8] [--rows=140]');
const ARTBOARDS = Number(flag('artboards', '8'));
const ROWS = Number(flag('rows', '140'));

/** A real PNG with a gradient and some grain, so that it costs what a photo costs to decode. */
function png(width: number, height: number, seed: number): Buffer {
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
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let r = seed * 9301 + 49297;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      r = (r * 9301 + 49297) % 233280;
      const grain = (r / 233280) * 24;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = Math.min(255, (40 + seed * 31 + (x / width) * 120 + grain) % 256);
      raw[o + 1] = Math.min(255, 60 + (y / height) * 140 + grain);
      raw[o + 2] = Math.min(255, (120 + seed * 17 + ((x + y) / (width + height)) * 100 + grain) % 256);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const WORDS = 'quiet harbour ledger copper field morning signal orchard lantern ferry timber granite meadow thread margin current anchor station paper canvas river'.split(' ');
const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(' ');
const title = (seed: number, n: number) => { const w = words(seed, n); return w[0]!.toUpperCase() + w.slice(1); };

const home = mkdtempSync(join(tmpdir(), 'bogen-perf-gen-'));
const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports') });
await server.listen();
const client = new Client({ name: 'perf-fixture', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${server.localUrl()}/mcp`)));
async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? '';
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
}

try {
  await call('file_create', { name: 'Big file, 10k layers' });
  const pageId = (await call<{ id: string }[]>('page_list', {}))[0]!.id;
  await call('tokens_set', { tokens: [
    { name: 'ink', kind: 'color', value: '#16181d' }, { name: 'muted', kind: 'color', value: '#5b616e' },
    { name: 'surface', kind: 'color', value: '#f6f4ef' }, { name: 'accent', kind: 'color', value: '#1f5eff' },
    { name: 'space-2', kind: 'spacing', value: '8px' }, { name: 'space-4', kind: 'spacing', value: '16px' }, { name: 'space-8', kind: 'spacing', value: '32px' },
  ] });
  const images: string[] = [];
  for (let i = 0; i < 8; i++) images.push((await call<{ src: string }>('asset_upload', { data_base64: png(480, 300, i).toString('base64'), mime_type: 'image/png' })).src);

  // Components, on an artboard of their own: a button, a card with an image, a table row, a footer link.
  const kit = await call<{ id: string }>('artboard_create', { name: 'Components', width: 1200, page_id: pageId });
  const made = await call<{ ids: string[] }>('html_write', { target_id: kit.id, html: `
    <a style="display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:8px;background:var(--accent);color:#fff;font:600 15px/1.2 Inter;text-decoration:none"><span>Get started</span></a>
    <article style="display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:12px;background:#fff;border:1px solid #e3e0d8;width:320px">
      <img src="${images[0]}" alt="" style="width:100%;height:180px;object-fit:cover;border-radius:8px">
      <h3 style="margin:0;font:600 20px/1.3 Inter;color:var(--ink)">Card title</h3>
      <p style="margin:0;font:400 15px/1.5 Inter;color:var(--muted)">A short line that says what this is about and why it matters.</p>
      <div style="display:flex;gap:8px"><span style="padding:4px 8px;border-radius:99px;background:var(--surface);font:500 12px Inter">Tag</span><span style="padding:4px 8px;border-radius:99px;background:var(--surface);font:500 12px Inter">Second</span></div>
    </article>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 80px;gap:16px;padding:12px 16px;border-bottom:1px solid #e3e0d8;font:400 14px Inter;color:var(--ink)"><span>Name</span><span>Owner</span><span>Status</span><span>Updated</span><span>Open</span></div>
    <a style="display:flex;font:400 14px/2 Inter;color:var(--muted);text-decoration:none"><span>Footer link</span></a>` });
  const [buttonId, cardId, rowId, linkId] = made.ids as [string, string, string, string];
  await call('component_create', { node_ids: [buttonId], name: 'Button', props: [{ name: 'label', type: 'text', target: 'Get started' }] });
  await call('component_create', { node_ids: [cardId], name: 'Card', props: [{ name: 'title', type: 'text', target: 'Card title' }] });
  await call('component_create', { node_ids: [rowId], name: 'Table row', props: [{ name: 'name', type: 'text', target: 'Name' }, { name: 'status', type: 'text', target: 'Status' }] });
  await call('component_create', { node_ids: [linkId], name: 'Footer link', props: [{ name: 'label', type: 'text', target: 'Footer link' }] });

  for (let a = 0; a < ARTBOARDS; a++) {
    const board = await call<{ id: string }>('artboard_create', { name: `Landing ${a + 1}, desktop`, width: 1440, page_id: pageId, background: '#fbfaf7' });
    const write = (html: string) => call('html_write', { target_id: board.id, html });
    await write(`<header style="display:flex;align-items:center;justify-content:space-between;padding:20px 64px;border-bottom:1px solid #e3e0d8">
      <strong style="font:700 20px Inter;color:var(--ink)">${title(a, 1)}</strong>
      <nav style="display:flex;gap:28px">${Array.from({ length: 6 }, (_, i) => `<a style="font:500 15px Inter;color:var(--ink);text-decoration:none">${title(a + i, 1)}</a>`).join('')}</nav>
      <x-instance component="Button" prop-label="Sign in"></x-instance></header>`);
    await write(`<section style="display:grid;grid-template-columns:1fr 1fr;gap:48px;padding:96px 64px;align-items:center">
      <div style="display:flex;flex-direction:column;gap:24px"><h1 style="margin:0;font:700 64px/1.05 Inter;color:var(--ink)">${title(a, 6)}</h1>
      <p style="margin:0;font:400 20px/1.5 Inter;color:var(--muted)">${title(a + 3, 28)}.</p>
      <div style="display:flex;gap:12px"><x-instance component="Button" prop-label="Start free"></x-instance><x-instance component="Button" prop-label="See a demo"></x-instance></div></div>
      <img src="${images[a % images.length]}" alt="Product" style="width:100%;height:420px;object-fit:cover;border-radius:16px"></section>`);
    await write(`<section style="display:flex;flex-direction:column;gap:32px;padding:64px">
      <h2 style="margin:0;font:700 40px/1.15 Inter;color:var(--ink)">${title(a + 1, 4)}</h2>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px">${Array.from({ length: 16 }, (_, i) => `<x-instance component="Card" prop-title="${title(a * 16 + i, 3)}"></x-instance>`).join('')}</div></section>`);
    await write(`<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:64px;background:var(--surface)">${Array.from({ length: 9 }, (_, i) => `
      <figure style="margin:0;display:flex;flex-direction:column;gap:16px;padding:24px;background:#fff;border-radius:12px">
        <blockquote style="margin:0;font:400 17px/1.55 Inter;color:var(--ink)">"${title(a + i, 22)}."</blockquote>
        <figcaption style="display:flex;align-items:center;gap:12px"><img src="${images[(a + i) % images.length]}" alt="" style="width:40px;height:40px;border-radius:99px;object-fit:cover">
        <span style="display:flex;flex-direction:column"><b style="font:600 14px Inter">${title(i, 2)}</b><small style="font:400 13px Inter;color:var(--muted)">${title(i + 5, 3)}</small></span></figcaption></figure>`).join('')}</section>`);
    // The long part: a table of rows, in chunks, as an agent writes it.
    const table = await write(`<section style="display:flex;flex-direction:column;padding:64px"><h2 style="margin:0 0 24px;font:700 32px Inter;color:var(--ink)">Recent work</h2></section>`) as { ids: string[] };
    for (let c = 0; c < ROWS; c += 20) {
      await call('html_write', { target_id: table.ids[0], html: Array.from({ length: Math.min(20, ROWS - c) }, (_, i) => `<x-instance component="Table row" prop-name="${title(a * 100 + c + i, 3)}" prop-status="${['Draft', 'In review', 'Live'][(c + i) % 3]}"></x-instance>`).join('') });
    }
    await write(`<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:64px">${Array.from({ length: 3 }, (_, t) => `
      <div style="display:flex;flex-direction:column;gap:16px;padding:32px;border:1px solid #e3e0d8;border-radius:16px">
        <h3 style="margin:0;font:600 22px Inter">${['Starter', 'Team', 'Company'][t]}</h3><p style="margin:0;font:700 44px Inter">${[0, 24, 96][t]} EUR</p>
        <ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px">${Array.from({ length: 10 }, (_, i) => `<li style="display:flex;gap:8px;font:400 15px Inter"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8l3 3 7-7" stroke="currentColor" fill="none" stroke-width="2"/></svg><span>${title(t * 10 + i, 4)}</span></li>`).join('')}</ul>
        <x-instance component="Button" prop-label="Choose ${['Starter', 'Team', 'Company'][t]}"></x-instance></div>`).join('')}</section>`);
    await write(`<section style="display:flex;flex-direction:column;gap:12px;padding:64px">${Array.from({ length: 16 }, (_, i) => `
      <details style="border-bottom:1px solid #e3e0d8;padding:16px 0"><summary style="font:600 17px Inter">${title(a + i, 7)}?</summary><p style="margin:8px 0 0;font:400 15px/1.6 Inter;color:var(--muted)">${title(a + i + 2, 30)}.</p></details>`).join('')}</section>`);
    await write(`<footer style="display:grid;grid-template-columns:repeat(5,1fr);gap:32px;padding:64px;background:var(--ink)">${Array.from({ length: 5 }, (_, col) => `
      <div style="display:flex;flex-direction:column"><b style="font:600 14px Inter;color:#fff;margin-bottom:12px">${title(col, 1)}</b>${Array.from({ length: 8 }, (_, i) => `<x-instance component="Footer link" prop-label="${title(col * 8 + i, 2)}"></x-instance>`).join('')}</div>`).join('')}</footer>`);
  }
} finally {
  await client.close();
  await server.close();
}

const fileId = JSON.parse(readFileSync(join(home, 'index.json'), 'utf8')).files[0].id as string;
const y = new Y.Doc();
Y.applyUpdate(y, new Uint8Array(readFileSync(join(home, 'files', `${fileId}.ydoc`))));
const doc = new BogenDoc(y);
const pageId = doc.getPages()[0]!.id;
let stored = 0;
let rendered = 0;
const walkStored = (id: string) => { for (const k of doc.rawKids(id)) { stored++; walkStored(k); } };
const walkRendered = (id: string) => { for (const k of doc.getChildren(id)) { rendered++; walkRendered(k.id); } };
walkStored(pageId);
walkRendered(pageId);
rmSync(out, { recursive: true, force: true });
cpSync(home, out, { recursive: true });
rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify({ home: out, fileId, pageId, artboards: doc.getChildren(pageId).length, stored, rendered }));
process.exit(0);
