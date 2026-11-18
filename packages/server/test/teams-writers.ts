import { randomBytes } from 'node:crypto';
import { Y } from '@bogen/core';
import { b64u, type DeviceKeys } from '../src/teams/crypto.ts';
import { clientIdOf, sealUpdate } from '../src/teams/envelope.ts';

/**
 * Test helpers for N6: changes written the way a member's device writes them, with a Yjs id derived from the
 * device key and a fresh nonce, and sealed naming that nonce.
 */
const nonces = new WeakMap<Uint8Array, string[]>();

export function writerDoc(device: DeviceKeys): { doc: Y.Doc; nonce: string } {
  const nonce = b64u(randomBytes(16));
  const doc = new Y.Doc();
  doc.clientID = clientIdOf(device.ed.pub, nonce);
  return { doc, nonce };
}

/** Remembers which nonces an update was written with, for `sealAs`. */
export function mark(update: Uint8Array, list: string[]): Uint8Array {
  nonces.set(update, list);
  return update;
}

/** A change to `root` of a copy of `base`, written by `device`. */
export function editBy(device: DeviceKeys, base: Y.Doc, root: string, key = `k${Math.random()}`, value: unknown = 'changed'): Uint8Array {
  const { doc, nonce } = writerDoc(device);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  const before = Y.encodeStateVector(doc);
  doc.getMap(root).set(key, value);
  return mark(Y.encodeStateAsUpdate(doc, before), [nonce]);
}

/** sealUpdate, naming the nonces the update was written with. */
export function sealAs(device: DeviceKeys, person: string, team: string, file: string, seq: number, heads: string[], update: Uint8Array, time = Date.now()) {
  return sealUpdate(device, person, team, file, seq, heads, update, time, nonces.get(update) ?? []);
}

/**
 * A port nothing listens on, asked of the system: fixed ranges collide with the ephemeral ports other tests'
 * servers get when the whole suite runs at once.
 */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
