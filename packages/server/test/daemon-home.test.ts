import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHome, connectionFromEnv, startDaemon, stopDaemon, type ServerStatus } from '../src/daemon.ts';
import { DEFAULT_PORT, homeId } from '../src/util.ts';

const servers: Server[] = [];
const dirs: string[] = [];

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bogen-home-'));
  dirs.push(d);
  return d;
}

/** A stand-in for a running Bogen that serves `home`, and counts what reaches it beyond /api/status. */
async function bogenFor(home: string): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    if (req.url !== '/api/status') hits.push(`${req.method} ${req.url}`);
    res.end(JSON.stringify({ version: '9.9.9', pid: 1, port: 0, home: homeId(home), files: 3, agents: [] } satisfies ServerStatus));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('BOGEN_HOME and the server a command uses', () => {
  it('uses the port the named folder records instead of the default one', () => {
    const home = dir();
    writeFileSync(join(home, 'server.json'), JSON.stringify({ pid: process.pid, port: 31234, host: '127.0.0.1' }));
    const conn = connectionFromEnv(undefined, { BOGEN_HOME: home });
    expect(conn.port).toBe(31234);
    expect(conn.home).toMatchObject({ path: home, named: true, id: homeId(home) });
    // An explicit port still wins, and a dead recorded server falls back to the default.
    expect(connectionFromEnv(4000, { BOGEN_HOME: home }).port).toBe(4000);
    writeFileSync(join(home, 'server.json'), JSON.stringify({ pid: 2 ** 22 + 7, port: 31234, host: '127.0.0.1' }));
    expect(connectionFromEnv(undefined, { BOGEN_HOME: home }).port).toBe(DEFAULT_PORT);
  });

  it('refuses the everyday server when BOGEN_HOME names another folder (the bug: a test wrote into real files)', async () => {
    const live = dir();
    const test = dir();
    const server = await bogenFor(live);
    const conn = connectionFromEnv(server.port, { BOGEN_HOME: test });
    await expect(startDaemon(conn)).rejects.toThrow(/serves another data folder/);
    await expect(stopDaemon(conn)).rejects.toThrow(/serves another data folder/);
    expect(server.hits).toEqual([]);
  });

  it('connects when the folder matches, and only warns for the default folder', async () => {
    const home = dir();
    const server = await bogenFor(home);
    await expect(startDaemon(connectionFromEnv(server.port, { BOGEN_HOME: home }))).resolves.toMatchObject({ files: 3 });

    const warnings: string[] = [];
    const unnamed = connectionFromEnv(server.port, { XDG_DATA_HOME: dir() });
    expect(unnamed.home?.named).toBe(false);
    checkHome(unnamed, { version: '1', files: 0, agents: [], port: 0, home: homeId(home) }, (t) => warnings.push(t));
    expect(warnings[0]).toMatch(/serves another data folder/);
    // An older server that does not say which folder it serves is taken as it is.
    expect(checkHome(connectionFromEnv(server.port, { BOGEN_HOME: dir() }), { version: '1', files: 0, agents: [], port: 0 })).toBeTruthy();
  });

  it('leaves BOGEN_URL alone: a server elsewhere is chosen on purpose', () => {
    expect(connectionFromEnv(undefined, { BOGEN_URL: 'http://h:5/', BOGEN_HOME: '/x' }).home).toBeUndefined();
  });
});
