import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBrand } from '@bogen/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BogenServer } from '../src/http/server.ts';
import { call, callRaw, connectAgent } from './helpers.ts';

const homes: string[] = [];
const servers: BogenServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'bogen-welcome-'));
  homes.push(home);
  return home;
}

/** A server on a data folder, started the way `bogen serve` starts it. */
async function start(home: string, welcome = true): Promise<BogenServer> {
  const server = new BogenServer({ home, port: 0, welcome });
  await server.listen();
  servers.push(server);
  return server;
}

async function stop(server: BogenServer): Promise<void> {
  servers.splice(servers.indexOf(server), 1);
  await server.close();
}

const names = (s: BogenServer) => s.storage.list().map((f) => f.name);
const post = async (s: BogenServer, path: string, body: unknown = {}) => {
  const res = await fetch(`${s.localUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};

describe('the welcome file', () => {
  it('is made once, on the first start of an empty data folder, drawn in the Bogen brand', async () => {
    const home = newHome();
    let s = await start(home);
    expect(names(s)).toEqual(['Welcome to Bogen']);
    const id = s.storage.list()[0]!.id;
    const { doc } = await s.rooms.get(id);
    expect(doc.getPages().map((p) => p.name)).toEqual(['Welcome']);
    const board = doc.getChildren(doc.getPages()[0]!.id)[0]!;
    expect(board).toMatchObject({ name: 'Welcome to Bogen', artboard: true });
    const all = doc.descendants(board.id);
    const text = all.map((n) => n.text ?? '').join(' ');
    for (const words of ['bogen install claude-code', 'Design a pricing page in Bogen.', '@claude', 'bogen phone pair', 'Give it a brand.', 'bogen welcome']) expect(text).toContain(words);
    expect(all.some((n) => n.attrs?.href?.endsWith('/docs/guide/brand.md'))).toBe(true);
    // Its colours and type are the Bogen brand's tokens, so the tokens panel shows them.
    expect(doc.getTokens().map((t) => t.name)).toEqual(expect.arrayContaining(['blue', 'blue-deep', 'ink', 'paper', 'tomato']));
    expect(all.some((n) => n.style.background === 'var(--blue)')).toBe(true);
    // No radius, no gradients: the brand's hard rules.
    expect(all.filter((n) => Object.entries(n.style).some(([k, v]) => /radius/i.test(k) && v !== '0px' && v !== '0'))).toEqual([]);
    expect(all.filter((n) => Object.values(n.style).some((v) => /gradient\(/.test(v)))).toEqual([]);

    // A restart makes nothing new.
    await stop(s);
    s = await start(home);
    expect(names(s)).toEqual(['Welcome to Bogen']);
  });

  it('never comes back by itself once deleted, and Help or bogen welcome makes it again', async () => {
    const home = newHome();
    let s = await start(home);
    const first = s.storage.list()[0]!.id;
    await s.deleteFile(first);
    await stop(s);
    s = await start(home);
    expect(names(s)).toEqual([]);

    const made = await post(s, '/api/welcome');
    expect(made.status).toBe(200);
    expect(made.body.created).toBe(true);
    expect(made.body.id).not.toBe(first);
    const again = await post(s, '/api/welcome');
    expect(again.body).toEqual({ id: made.body.id, created: false });
    expect(names(s)).toEqual(['Welcome to Bogen']);
  });

  it('is not made in a data folder that already has files, nor when it is turned off', async () => {
    const home = newHome();
    let s = await start(home, false);
    s.createFile('Mine');
    await stop(s);
    s = await start(home);
    expect(names(s)).toEqual(['Mine']);
    await stop(s);
    s = await start(home);
    expect(names(s)).toEqual(['Mine']);
    expect(names(await start(newHome(), false))).toEqual([]);
  });
});

describe('examples', () => {
  const SIZES: Record<string, string[]> = {
    'example-landing': ['1440 x hug', '390 x hug'],
    'example-app': ['393 x 852', '393 x 852', '393 x 852', '393 x 852'],
    'example-deck': Array(6).fill('1920 x 1080'),
    'example-social': ['1200 x 630', '1080 x 1080'],
  };

  it('the gallery lists each example and makes it: its own brand, a file linked to it, boards in the brand\'s tokens', async () => {
    const s = await start(newHome(), false);
    const res = await fetch(`${s.localUrl()}/api/examples`);
    const list = await res.json() as { id: string; kind: string; colors: string[]; fonts: string[] }[];
    expect(list.map((e) => e.id)).toEqual(Object.keys(SIZES));
    expect(list.map((e) => e.kind)).toEqual(['Landing page', 'App screens', 'Pitch deck', 'Social images']);
    for (const e of list) expect(e.colors.length).toBeGreaterThan(2);

    for (const e of list) {
      const out = await post(s, `/api/examples/${e.id}`);
      expect(out.status, e.id).toBe(201);
      expect(out.body.boards.map((b: { width: number; height: number | 'hug' }) => `${b.width} x ${b.height}`), e.id).toEqual(SIZES[e.id]);
      expect(out.body.linked).toBe(true);
      const { doc } = await s.rooms.get(out.body.file_id);
      const brand = await s.brands.read(out.body.brand_id);
      const data = readBrand(brand.room.doc);
      expect(data.colors.every((c) => !c.suggested)).toBe(true);
      expect(data.logos.length).toBeGreaterThan(0);
      // Drawn in the brand: its colour tokens, not copies of them.
      const nodes = out.body.boards.flatMap((b: { id: string }) => doc.descendants(b.id));
      const styles = nodes.flatMap((n: { style: Record<string, string> }) => Object.values(n.style)).join(' ');
      for (const c of data.colors.slice(0, 3)) expect(styles, `${e.id} ${c.token}`).toContain(`var(--${c.token})`);
      expect(nodes.length, e.id).toBeGreaterThan(20);
    }
    expect(s.storage.listBrands().map((b) => b.name).sort()).toEqual(['Couchette', 'Crux', 'Laneway', 'Second Shelf']);

    // Again: a second file, the same brand.
    const again = await post(s, '/api/examples/example-app');
    expect(s.storage.listBrands()).toHaveLength(4);
    expect(names(s).filter((n) => n === 'Crux, app screens')).toHaveLength(2);
    expect(again.body.brand_id).toBe(s.storage.listBrands().find((b) => b.name === 'Crux')!.id);
    expect((await post(s, '/api/examples/nothing')).status).toBe(404);
  });

  it('template_list offers the examples and template_use makes one over MCP, parts and all', async () => {
    const s = await start(newHome(), false);
    const client = await connectAgent(s.localUrl(), 'claude');
    const listed = await call(client, 'template_list');
    const examples = listed.templates.filter((t: { example?: boolean }) => t.example);
    expect(examples.map((t: { id: string; brand: string }) => `${t.id} ${t.brand}`)).toEqual(['example-landing Couchette', 'example-app Crux', 'example-deck Laneway', 'example-social Second Shelf']);

    const out = await call(client, 'template_use', { template: 'example-deck', options: { only: ['1', '6'] } });
    expect(out.file_name).toBe('Laneway, a pitch deck');
    expect(out.boards.map((b: { name: string }) => b.name)).toEqual(['Laneway 1, title', 'Laneway 6, the ask']);
    const brand = s.storage.listBrands().find((b) => b.name === 'Laneway')!;
    expect(out.brand_id).toBe(brand.id);
    // The agent's one undo step takes the boards back.
    const { doc } = await s.rooms.get(out.file_id);
    expect(doc.getChildren(out.page_id)).toHaveLength(2);
    await call(client, 'agent_undo', { file_id: out.file_id });
    expect(doc.getChildren(out.page_id)).toHaveLength(0);

    // A file linked to another brand is not mixed with an example's.
    const mine = await call(client, 'template_use', { template: 'example-social' });
    const refused = await callRaw(client, 'template_use', { template: 'example-app', file_id: mine.file_id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/brings its own/);
    await client.close();
  });
});
