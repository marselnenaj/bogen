import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { exportBogenFile, exportFolder, importBogenFile, importFolder } from '../src/cli-transfer.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const FONT = readFileSync(join(dirname(createRequire(import.meta.url).resolve('@fontsource-variable/source-sans-3/LICENSE')), 'files/source-sans-3-latin-wght-normal.woff2'));
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="5" fill="#e03010"/></svg>';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function start(): Promise<Harness> {
  const h = await startServer();
  harnesses.push(h);
  return h;
}

async function rest<T = any>(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function download(base: string, id: string, query = ''): Promise<{ bytes: Buffer; brand: any }> {
  const res = await fetch(`${base}/api/files/${id}/download${query}`);
  expect(res.status).toBe(200);
  const header = res.headers.get('x-bogen-brand');
  return { bytes: Buffer.from(await res.arrayBuffer()), brand: header ? JSON.parse(decodeURIComponent(header)) : null };
}

async function upload(base: string, bytes: Buffer, name = 'Site.bogen'): Promise<any> {
  const res = await fetch(`${base}/api/files/import`, { method: 'POST', headers: { 'Content-Type': 'application/x-bogen', 'X-Bogen-Filename': name }, body: new Uint8Array(bytes) });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`import: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** A brand with a colour, a hosted font and a logo, and a file linked to it that uses all three. */
async function brandedFile(h: Harness) {
  const client = await connectAgent(h.base, 'claude');
  const { id: brand } = await call(client, 'brand_create', { name: 'Acme' });
  const font = await call(client, 'brand_asset_add', { brand_id: brand, kind: 'font', name: 'Source Sans', data_base64: FONT.toString('base64'), mime_type: 'font/woff2', confirmed: true });
  const logo = await call(client, 'brand_asset_add', { brand_id: brand, kind: 'logo', name: 'Mark', data_base64: Buffer.from(LOGO).toString('base64'), mime_type: 'image/svg+xml', background: 'light', confirmed: true });
  await call(client, 'brand_update', {
    brand_id: brand, confirmed: true,
    items: [
      { section: 'colors', name: 'Signal', role: 'primary', value: '#e03010', token: 'signal' },
      { section: 'families', family: 'Acme Sans', role: 'body', fallback: 'sans-serif', weights: [400, 700], token: 'font-body', assets: [font.src] },
    ],
  });
  await call(client, 'brand_publish', { brand_id: brand, note: 'First' });
  const file = await call(client, 'file_create', { name: 'Launch page' });
  await call(client, 'brand_link', { brand_id: brand, file_id: file.id });
  await call(client, 'artboard_create', { name: 'Hero', width: 400, height: 200 });
  return { client, brand: brand as string, file: file.id as string, fontSrc: font.src as string, logoSrc: logo.src as string };
}

const assetOk = async (base: string, src: string) => (await fetch(`${base}/assets/${src.slice('bogen-asset:'.length)}`)).ok;

describe('a file and its brand, together', () => {
  it('arrives on another device with its brand under the same id, its assets, tokens and fonts', async () => {
    const a = await start();
    const { client, brand, file, fontSrc, logoSrc } = await brandedFile(a);
    const out = await download(a.base, file);
    expect(out.bytes.subarray(0, 7).toString('latin1')).toBe('BOGEN\x02\n');
    expect(out.brand).toMatchObject({ included: true, id: brand, name: 'Acme', version: 1 });

    const b = await start();
    const imported = await upload(b.base, out.bytes);
    expect(imported.kind).toBe('file');
    expect(imported.brand).toMatchObject({ id: brand, status: 'created', version_in_file: 1, differs: false });
    expect((await rest<any[]>(b.base, '/api/brands')).map((x) => x.id)).toEqual([brand]);
    const linked = await rest(b.base, `/api/files/${imported.id}/brand`);
    expect(linked.link.id).toBe(brand);
    expect(linked.note.missing).toBeFalsy();
    expect(linked.note.name).toBe('Acme');
    expect(await assetOk(b.base, fontSrc)).toBe(true);
    expect(await assetOk(b.base, logoSrc)).toBe(true);
    const other = await connectAgent(b.base, 'codex');
    const tokens = await call<any[]>(other, 'tokens_get', { file_id: imported.id });
    expect(tokens.find((t) => t.name === 'signal')?.value).toBe('#e03010');
    expect((await call<any[]>(other, 'fonts_captured', { file_id: imported.id })).some((f) => f.src === fontSrc)).toBe(true);
    expect((await call(other, 'brand_get', { brand_id: brand })).name ?? 'Acme').toBeTruthy();
    await client.close();
    await other.close();
  });

  it('keeps a brand that is here already, and says when the one that came differs', async () => {
    const a = await start();
    const { client, brand, file } = await brandedFile(a);
    const b = await start();
    const first = await upload(b.base, (await download(a.base, file)).bytes);
    expect(first.brand.status).toBe('created');
    const again = await upload(b.base, (await download(a.base, file)).bytes);
    expect(again.brand).toMatchObject({ id: brand, status: 'kept', differs: false });

    // A new version on the first device, while the second keeps its own.
    await call(client, 'brand_update', { brand_id: brand, confirmed: true, items: [{ section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' }] });
    await call(client, 'brand_publish', { brand_id: brand, note: 'Ink' });
    const newer = await upload(b.base, (await download(a.base, file)).bytes);
    expect(newer.brand).toMatchObject({ id: brand, status: 'kept', differs: true, version_in_file: 2, version_here: 1 });
    expect(newer.brand.message).toMatch(/kept as it is/);
    const here = await rest(b.base, `/api/brands/${brand}`);
    expect(here.versions.length).toBe(1);
    expect(JSON.stringify(here)).not.toContain('#101010');
    expect((await rest(b.base, `/api/files/${newer.id}/brand`)).link.id).toBe(brand);
    await client.close();
  });

  it('leaves the brand out when asked, in format 1', async () => {
    const a = await start();
    const { client, brand, file } = await brandedFile(a);
    const out = await download(a.base, file, '?brand=0');
    expect(out.bytes.subarray(0, 7).toString('latin1')).toBe('BOGEN\x01\n');
    expect(out.brand).toMatchObject({ included: false, id: brand, why: 'left out' });
    const b = await start();
    const imported = await upload(b.base, out.bytes);
    expect(imported.brand).toBeUndefined();
    expect((await rest(b.base, `/api/files/${imported.id}/brand`)).note.missing).toBe(true);
    await client.close();
  });

  it('gives a brand a new id when its own was deleted on this device, and links the file to that', async () => {
    const a = await start();
    const { client, brand, file } = await brandedFile(a);
    const b = await start();
    (b.server.peers as unknown as { tombstones: Map<string, unknown> }).tombstones.set(brand, { name: 'Acme', deletedAt: Date.now(), snapshot: '' });
    const imported = await upload(b.base, (await download(a.base, file)).bytes);
    expect(imported.brand.status).toBe('created');
    expect(imported.brand.previous_id).toBe(brand);
    expect(imported.brand.id).not.toBe(brand);
    expect((await rest(b.base, `/api/files/${imported.id}/brand`)).link.id).toBe(imported.brand.id);
    await client.close();
  });

  it('a brand on its own keeps its id, and does not take over the default brand here', async () => {
    const a = await start();
    const { client, brand } = await brandedFile(a);
    await call(client, 'brand_default', { brand_id: brand });
    const out = await download(a.base, brand);
    expect(out.brand).toMatchObject({ included: true, id: brand });
    const b = await start();
    const own = await rest(b.base, '/api/brands', { method: 'POST', body: { name: 'House' } });
    const local = await connectAgent(b.base, 'claude');
    await call(local, 'brand_default', { brand_id: own.id });
    await local.close();
    const imported = await upload(b.base, out.bytes, 'Acme.bogen');
    expect(imported).toMatchObject({ kind: 'brand', id: brand, name: 'Acme' });
    const brands = await rest<any[]>(b.base, '/api/brands');
    expect(brands.find((x) => x.id === own.id)?.isDefault).toBe(true);
    expect(brands.find((x) => x.id === brand)?.isDefault).toBe(false);
    await client.close();
  });

  it('travels through the MCP tools', async () => {
    const a = await start();
    const { client, brand, file } = await brandedFile(a);
    const written = await call(client, 'file_export', { file_id: file });
    expect(written.path).toMatch(/\.bogen$/);
    expect(written.brand).toMatchObject({ included: true, id: brand });
    const alone = await call(client, 'brand_export', { brand_id: brand });
    expect(alone.kind).toBe('brand');
    const b = await start();
    const other = await connectAgent(b.base, 'codex');
    const opened = await call(other, 'file_import', { path: written.path });
    expect(opened.brand).toMatchObject({ id: brand, status: 'created' });
    expect((await call(other, 'tokens_get', {})).some((t: any) => t.name === 'signal')).toBe(true);
    const brandOnly = await call(other, 'file_import', { path: alone.path });
    expect(brandOnly.file_id).toBeUndefined();
    expect(brandOnly.brand).toMatchObject({ id: brand, status: 'kept', differs: false });
    await client.close();
    await other.close();
  });

  it('travels through the CLI, as a .bogen file and as a design folder with the brand in brand/', async () => {
    const a = await start();
    const { client, brand, file, logoSrc } = await brandedFile(a);
    const dir = mkdtempSync(join(tmpdir(), 'bogen-brand-cli-'));
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    const connA = { url: a.base, port: 0 };
    await exportBogenFile(connA, 'Launch page', join(dir, 'launch.bogen'), {}, say);
    expect(lines.join('\n')).toMatch(/With its brand "Acme", version 1/);
    await exportFolder(connA, file, join(dir, 'folder'), {}, say);
    expect(readFileSync(join(dir, 'folder', 'brand', 'design.json'), 'utf8')).toContain('"name"');
    expect(readFileSync(join(dir, 'folder', 'brand', 'assets', logoSrc.slice('bogen-asset:'.length)), 'utf8')).toContain('<svg');

    const b = await start();
    const connB = { url: b.base, port: 0 };
    lines.length = 0;
    await importFolder(connB, join(dir, 'folder'), {}, say);
    expect(lines.join('\n')).toMatch(/Added the brand "Acme"/);
    const files = await rest<any[]>(b.base, '/api/files');
    expect(files[0].brandId).toBe(brand);
    expect(await assetOk(b.base, logoSrc)).toBe(true);
    lines.length = 0;
    await importBogenFile(connB, join(dir, 'launch.bogen'), say);
    expect(lines.join('\n')).toMatch(/is on this device already/);

    lines.length = 0;
    await exportFolder(connA, file, join(dir, 'folder'), { 'no-brand': true }, say);
    expect(lines.join('\n')).toMatch(/Without its brand, as asked/);
    expect(() => readFileSync(join(dir, 'folder', 'brand', 'design.json'))).toThrow();
    await client.close();
  });

  it('bogen export and bogen import, as commands', async () => {
    const a = await start();
    const { client, brand } = await brandedFile(a);
    const b = await start();
    const dir = mkdtempSync(join(tmpdir(), 'bogen-brand-cmd-'));
    const cli = async (h: Harness, ...args: string[]) => (await run('npx', ['tsx', 'packages/server/src/cli.ts', ...args], { cwd: ROOT, env: { ...process.env, BOGEN_URL: h.base, BOGEN_HOME: h.home } })).stdout;
    expect(await cli(a, 'export', 'Launch page', join(dir, 'page.bogen'))).toMatch(/With its brand "Acme"/);
    expect(await cli(a, 'export', 'Acme', join(dir, 'acme.bogen'))).toMatch(/The brand "Acme" on its own/);
    await expect(cli(a, 'export', 'Launch page', join(dir, 'page.bogen'))).rejects.toThrow(/--force/);
    expect(await cli(b, 'import', join(dir, 'acme.bogen'))).toMatch(/Imported the brand "Acme"/);
    expect(await cli(b, 'import', join(dir, 'page.bogen'))).toMatch(/is on this device already/);
    expect((await rest<any[]>(b.base, '/api/brands')).map((x) => x.id)).toEqual([brand]);
    await client.close();
  }, 60_000);
});
