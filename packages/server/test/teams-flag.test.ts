import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BogenServer } from '../src/http/server.ts';

/** Teams stay hidden until the feature teams-1 is on: no routes, no listener, nothing in the status. */

const running: { server: BogenServer; home: string }[] = [];
const saved = process.env.BOGEN_FEATURES;
afterEach(async () => {
  for (const { server, home } of running.splice(0)) {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
  if (saved === undefined) delete process.env.BOGEN_FEATURES;
  else process.env.BOGEN_FEATURES = saved;
});

async function boot(): Promise<{ server: BogenServer; base: string }> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-teams-flag-'));
  const server = new BogenServer({ home, port: 0, peerCatchUpMs: 60_000, exportDir: join(home, 'exports') });
  await server.listen();
  running.push({ server, home });
  return { server, base: server.localUrl() };
}

describe('the teams-1 flag', () => {
  it('is off by default: /api/teams is not found and the status names no feature', async () => {
    delete process.env.BOGEN_FEATURES;
    const { base, server } = await boot();
    expect(server.teams).toBeNull();
    expect((await fetch(`${base}/api/teams`)).status).toBe(404);
    expect(((await (await fetch(`${base}/api/status`)).json()) as { features: string[] }).features).toEqual([]);
  });

  it('when on, shows teams to this machine, creates one, and starts no listener until a connection is on', async () => {
    process.env.BOGEN_FEATURES = 'teams-1';
    const { base, server } = await boot();
    expect(((await (await fetch(`${base}/api/status`)).json()) as { features: string[] }).features).toEqual(['teams-1']);
    const created = await fetch(`${base}/api/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Studio Nord', yourName: 'Anna' }) });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { phrase: string[] }).phrase).toHaveLength(12);
    const view = (await (await fetch(`${base}/api/teams`)).json()) as { teams: { name: string; role: string }[]; urls: string[] };
    expect(view.teams.map((t) => [t.name, t.role])).toEqual([['Studio Nord', 'owner']]);
    expect(view.urls).toEqual([]);
    expect(server.teams?.urls).toEqual([]);
  });
});
