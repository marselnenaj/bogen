import { createServer } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { TailnetListener } from '../src/tailnet.ts';

describe('TailnetListener', () => {
  it('stops at once and drops a live link that came in on it, an upgraded socket included', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    const held: Socket[] = [];
    const listener = new TailnetListener({
      create: () => {
        const server = createServer((_req, res) => res.end('ok'));
        // Like a peer's WebSocket: the server answers the upgrade and keeps the socket.
        server.on('upgrade', (_req, socket) => {
          socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
          held.push(socket as Socket);
        });
        return server;
      },
      port: () => port,
      resolve: async () => '127.0.0.1',
    });
    listener.start();
    expect(await listener.refresh()).toBe(`http://127.0.0.1:${port}`);

    const client = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.write('GET /peer HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await new Promise<void>((resolve) => client.once('data', () => resolve()));
    expect(held).toHaveLength(1);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));

    const t0 = Date.now();
    await listener.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    await closed;
    expect(listener.url).toBeNull();
  });
});
