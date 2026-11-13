import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '../src/install.ts';
import { isLocalOnlyPath } from '../src/peers.ts';
import { startServer, type Harness } from './helpers.ts';

/** Settings, Add to agent: what `bogen setup` finds, and Connect, here with a stand-in for `bogen install`. */
describe('the clients API', () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG: process.env.XDG_CONFIG_HOME };
  const home = mkdtempSync(join(tmpdir(), 'bogen-clients-'));
  let h: Harness;
  const asked: Client[][] = [];
  beforeAll(async () => {
    process.env.HOME = home;
    process.env.PATH = '';
    delete process.env.XDG_CONFIG_HOME;
    mkdirSync(join(home, '.cursor'));
    h = await startServer();
    h.server.connectClients = async (clients) => {
      asked.push(clients);
      return clients.map((client) => ({ client, ok: client !== 'zed', how: client === 'zed' ? 'settings.json could not be read as JSON, so it was left alone' : 'wrote it' }));
    };
  });
  afterAll(async () => {
    await h.cleanup();
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.XDG) process.env.XDG_CONFIG_HOME = saved.XDG;
    rmSync(home, { recursive: true, force: true });
  });

  it('lists every client with what setup finds and the tool list it would get', async () => {
    const { clients } = await (await fetch(`${h.base}/api/clients`)).json() as { clients: { client: string; found: boolean; tools: string; label: string }[] };
    expect(clients.find((c) => c.client === 'cursor')).toMatchObject({ found: true, tools: 'grouped', label: 'Cursor' });
    expect(clients.find((c) => c.client === 'claude-code')).toMatchObject({ found: false, tools: 'full' });
  });

  it('connects one client, says why one failed, and knows only its own clients', async () => {
    const ok = await fetch(`${h.base}/api/clients/cursor/connect`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(asked.at(-1)).toEqual(['cursor']);
    const bad = await fetch(`${h.base}/api/clients/zed/connect`, { method: 'POST' });
    expect(bad.status).toBe(500);
    expect((await bad.json() as { error: string }).error).toMatch(/left alone/);
    expect((await fetch(`${h.base}/api/clients/nano/connect`, { method: 'POST' })).status).toBe(404);
    expect(isLocalOnlyPath('/api/clients/cursor/connect')).toBe(true);
  });
});
