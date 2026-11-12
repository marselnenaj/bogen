import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { probe, probeState, userBusEnv } from '../src/daemon.ts';

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('probeState', () => {
  it('says running, with the status, when Bogen answers', async () => {
    const url = await serve((_req, res) => res.end(JSON.stringify({ version: '0.1.0', files: 2, agents: [] })));
    const result = await probeState({ url, port: 0 });
    expect(result).toMatchObject({ state: 'running', status: { version: '0.1.0' } });
    expect(await probe({ url, port: 0 })).toMatchObject({ files: 2 });
  });

  it('says busy, not down, when the server takes the connection and does not reply in time', async () => {
    const url = await serve(() => {});
    expect(await probeState({ url, port: 0 }, 200)).toEqual({ state: 'busy' });
  });

  it('says down when nothing listens, or another program answers', async () => {
    const closed = await serve(() => {});
    const port = Number(new URL(closed).port);
    const server = servers.pop()!;
    await new Promise((resolve) => server.close(resolve));
    expect(await probeState({ url: `http://127.0.0.1:${port}`, port }, 500)).toEqual({ state: 'down' });

    const other = await serve((_req, res) => res.end('{"hello":"world"}'));
    expect(await probeState({ url: other, port: 0 })).toEqual({ state: 'down' });
    expect(await probe({ url: other, port: 0 })).toBeNull();
  });
});

describe('userBusEnv', () => {
  it('leaves an environment that can reach the user manager as it is', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/1000', PATH: '/usr/bin' };
    expect(userBusEnv(env, 1000)).toBe(env);
    const bus = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' };
    expect(userBusEnv(bus, 1000)).toBe(bus);
  });

  it('adds the runtime folder of this user when it exists, and nothing when it does not', () => {
    expect(userBusEnv({ PATH: '/usr/bin' }, 4_000_000)).toEqual({ PATH: '/usr/bin' });
    const uid = process.getuid?.();
    if (uid === undefined || !existsSync(`/run/user/${uid}`)) return;
    expect(userBusEnv({ PATH: '/usr/bin' }, uid)).toEqual({ PATH: '/usr/bin', XDG_RUNTIME_DIR: `/run/user/${uid}` });
  });
});
