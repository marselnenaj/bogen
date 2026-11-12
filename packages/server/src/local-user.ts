import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Who is on the other end of a loopback connection. Every user of a machine can open 127.0.0.1, so a
 * server that trusts loopback trusts them all. On Linux the kernel says which user owns each TCP
 * socket in /proc/net/tcp and tcp6, so the server can keep its loopback listener to its own user (and
 * root, who could read the files anyway) with no token for the browser, the CLI or the bar to carry.
 *
 * Elsewhere, and where /proc cannot be read, the owner is unknown and the caller decides.
 */

const TABLES = ['/proc/net/tcp', '/proc/net/tcp6'];
const LISTEN = '0A';

export type ReadTable = (path: string) => string | null;

const readTable: ReadTable = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The uid that owns the client end of a connection from `clientPort` to `serverPort`: the row whose
 * local port is the client's and whose remote port is ours. Null when no table could be read or no row
 * matches. Undefined when there is no /proc to ask.
 */
export function socketOwner(clientPort: number, serverPort: number, read: ReadTable = readTable): number | null | undefined {
  let readAny = false;
  for (const path of TABLES) {
    const table = read(path);
    if (table === null) continue;
    readAny = true;
    for (const line of table.split('\n').slice(1)) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
      const cols = line.trim().split(/\s+/);
      // Any state but listening: a client that already half-closed its end still sent this request.
      if (cols.length < 8 || cols[3] === LISTEN) continue;
      if (portOf(cols[1]!) === clientPort && portOf(cols[2]!) === serverPort) return Number(cols[7]);
    }
  }
  return readAny ? null : undefined;
}

function portOf(address: string): number {
  return parseInt(address.slice(address.lastIndexOf(':') + 1), 16);
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Whether a connection comes from this process's user or root. True where the platform cannot say, so
 * macOS and Windows keep working as before; the security policy says so.
 */
export function fromOwnUser(socket: Socket, read: ReadTable = readTable, uid = process.getuid?.()): boolean {
  if (uid === undefined) return true;
  const { remotePort, localPort } = socket;
  if (!remotePort || !localPort) return false;
  const owner = socketOwner(remotePort, localPort, read);
  return owner === undefined || owner === uid || owner === 0;
}

/**
 * Closes every loopback connection another local user opens, before it can send a byte we read.
 * Connections from other machines are left to the listener's own rules.
 */
export function keepToOwnUser(server: Server, read: ReadTable = readTable, uid = process.getuid?.()): void {
  server.on('connection', (socket: Socket) => {
    if (LOOPBACK.test(socket.remoteAddress ?? '') && !fromOwnUser(socket, read, uid)) socket.destroy();
  });
}
