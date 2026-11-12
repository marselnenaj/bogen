import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { keepToOwnUser, socketOwner } from '../src/local-user.ts';

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const row = (local: string, remote: string, state: string, uid: number) => `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0000000000000000 20 4 30 10 -1\n`;


describe('who is on the other end of a loopback connection', () => {
  it('reads the owner of the client end from the kernel table', () => {
    const tcp = HEAD + row('0100007F:74E6', '00000000:0000', '0A', 1000) + row('0100007F:74E6', '0100007F:C350', '01', 1000) + row('0100007F:C350', '0100007F:74E6', '01', 1001);
    const read = (path: string) => (path.endsWith('tcp') ? tcp : '');
    // Port 0xC350 = 50000 is the client, 0x74E6 = 29926 the server: the row of the client's own end says 1001.
    expect(socketOwner(50000, 29926, read)).toBe(1001);
    expect(socketOwner(50001, 29926, read)).toBeNull();
    expect(socketOwner(50000, 29926, () => null)).toBeUndefined();
  });

  it('finds an IPv6 row too', () => {
    const tcp6 = HEAD + row('00000000000000000000000001000000:C351', '00000000000000000000000001000000:74E6', '01', 1002);
    expect(socketOwner(50001, 29926, (path) => (path.endsWith('tcp6') ? tcp6 : HEAD))).toBe(1002);
  });

  it('closes a connection another user opens, and serves its own user', async () => {
    if (process.platform !== 'linux') return;
    const serve = async (uid: number) => {
      const srv = createServer((_req, res) => res.end('ok'));
      // The real kernel table: the client below is this process, so its owner is our own uid.
      keepToOwnUser(srv, undefined, uid);
      await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done));
      const port = (srv.address() as { port: number }).port;
      const text = await fetch(`http://127.0.0.1:${port}/`, { headers: { Connection: 'close' } }).then((r) => r.text(), () => 'refused');
      await new Promise<void>((done) => srv.close(() => done()));
      return text;
    };
    expect(await serve(process.getuid!())).toBe('ok');
    // As a server run by someone else would see us.
    expect(await serve(process.getuid!() + 4242)).toBe('refused');
  });
});
