import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Y } from '@bogen/core';
import { newEd, signBytes } from '../src/teams/crypto.ts';
import { TeamService } from '../src/teams/service.ts';
import { freePort } from './teams-writers.ts';
import { bindingBytes, bindingUri, certificateFor, deviceCertificate, deviceOf, edKeyOf, tlsPost, TLS_KEY_LIFE_MS, TLS_KEY_ROTATE_MS } from '../src/teams/tls.ts';

/**
 * The device signing key and the TLS key are separate: a TLS key counts only with the device key's signature over
 * it, and peers pin the device, not the TLS key.
 */

const NOW = Date.UTC(2026, 10, 16, 12);
const x509 = (pem: string) => new X509Certificate(pem);
/** A certificate whose binding is signed by `signer` but claims to speak for `claims`. */
function forged(claims: string, signer: { priv: string }, tlsKey = newEd(), issued = NOW, expires = NOW + TLS_KEY_LIFE_MS) {
  const sig = signBytes(signer.priv, bindingBytes(claims, tlsKey.pub, issued, expires));
  return certificateFor(tlsKey, bindingUri(claims, issued, expires, sig), issued - 60_000, expires);
}

describe('TLS key separate from the device key', () => {
  it('certifies a fresh TLS key that is not the device key', () => {
    const device = newEd();
    const tls = deviceCertificate(device, { now: NOW });
    const cert = x509(tls.cert);
    expect(edKeyOf(cert)).toBe(tls.tlsPub);
    expect(tls.tlsPub).not.toBe(device.pub);
    expect(deviceOf(cert, NOW)).toMatchObject({ device: device.pub, tls: tls.tlsPub });
  });

  it('refuses a TLS key that is not certified: no binding, or the device key used as the TLS key', () => {
    const device = newEd();
    expect(deviceOf(x509(certificateFor(newEd(), null, NOW - 60_000, NOW + 86_400_000).cert), NOW)).toBeNull();
    // The old single-key form: the device key in the certificate, certified by itself.
    const same = deviceCertificate(device, { tls: { key: device, issued: NOW }, now: NOW });
    expect(deviceOf(x509(same.cert), NOW)).toBeNull();
  });

  it('refuses a certificate that claims another device, signed by a key that is not that device', () => {
    const anna = newEd();
    const stranger = newEd();
    expect(deviceOf(x509(forged(anna.pub, stranger).cert), NOW)).toBeNull();
  });

  it('refuses a binding for another TLS key than the one in the certificate', () => {
    const device = newEd();
    const other = newEd();
    const sig = signBytes(device.priv, bindingBytes(device.pub, other.pub, NOW, NOW + TLS_KEY_LIFE_MS));
    const cert = certificateFor(newEd(), bindingUri(device.pub, NOW, NOW + TLS_KEY_LIFE_MS, sig), NOW - 60_000, NOW + TLS_KEY_LIFE_MS);
    expect(deviceOf(x509(cert.cert), NOW)).toBeNull();
  });

  it('refuses expired bindings, bindings from the future and bindings longer than a key may live', () => {
    const device = newEd();
    expect(deviceOf(x509(forged(device.pub, device, newEd(), NOW - TLS_KEY_LIFE_MS - 1, NOW - 1).cert), NOW)).toBeNull();
    expect(deviceOf(x509(forged(device.pub, device, newEd(), NOW + 86_400_000, NOW + 2 * 86_400_000).cert), NOW)).toBeNull();
    expect(deviceOf(x509(forged(device.pub, device, newEd(), NOW, NOW + 2 * TLS_KEY_LIFE_MS).cert), NOW)).toBeNull();
    expect(deviceOf(x509(forged(device.pub, device, newEd(), NOW, NOW + TLS_KEY_LIFE_MS).cert), NOW)).not.toBeNull();
  });

  it('a signature made over a TLS binding does not count as anything else, and the reverse', () => {
    // The binding's tag is its own: a device signature over the same bytes without the tag does not verify.
    const device = newEd();
    const tlsKey = newEd();
    const bytes = bindingBytes(device.pub, tlsKey.pub, NOW, NOW + TLS_KEY_LIFE_MS);
    expect(bytes.toString('utf8').startsWith('bogen-tls-binding-v1|')).toBe(true);
    const untagged = signBytes(device.priv, Buffer.from(bytes.toString('utf8').replace('bogen-tls-binding-v1|', '')));
    const cert = certificateFor(tlsKey, bindingUri(device.pub, NOW, NOW + TLS_KEY_LIFE_MS, untagged), NOW - 60_000, NOW + TLS_KEY_LIFE_MS);
    expect(deviceOf(x509(cert.cert), NOW)).toBeNull();
  });
});

// ---- Between devices ----------------------------------------------------------------------------------------

const made: { svc: TeamService; home: string }[] = [];
async function device(name: string, clock?: { now: number }) {
  const home = await mkdtemp(join(tmpdir(), 'bogen-teams-tls-'));
  const docs = new Map<string, Y.Doc>();
  const names = new Map<string, string>();
  const svc: TeamService = new TeamService({
    home, deviceName: () => name, ...(clock ? { now: () => clock.now } : {}),
    doc: async (file) => {
      let d = docs.get(file);
      if (!d) {
        d = new Y.Doc();
        d.on('update', (u: Uint8Array, origin: unknown) => svc.onRoomUpdate(file, u, origin));
        docs.set(file, d);
      }
      return d;
    },
    ensureFile: (file, n) => { if (!names.has(file)) names.set(file, n); },
    fileExists: (file) => names.has(file),
    fileName: (file) => names.get(file),
  });
  await svc.start();
  made.push({ svc, home });
  await svc.setTransports({ lan: { on: true, address: '127.0.0.1' }, tailscale: { on: false }, vpn: { on: false, address: '' }, port: await freePort() });
  return { svc, docs, names, home };
}
afterEach(async () => {
  for (const { svc, home } of made.splice(0)) {
    await svc.stop();
    await rm(home, { recursive: true, force: true });
  }
});
async function owned(name: string, clock?: { now: number }) {
  const d = await device(name, clock);
  const { team, phrase } = await d.svc.create('Studio', name);
  await d.svc.confirmPhrase(Object.fromEntries(phrase!.map((w, i) => [String(i), w])));
  return { ...d, team };
}

describe('TLS keys between devices', () => {
  it('a member device is refused when its certificate is signed by a key that is not a member', async () => {
    const anna = await owned('Anna');
    const stranger = newEd();
    const tls = deviceCertificate(stranger);
    const res = await tlsPost(anna.svc.urls[0]!, tls, anna.svc.view().me.device, '/team/v2/sync', () => JSON.stringify({ team: anna.team, ops: [], vectors: {} }));
    expect(res.status).toBe(403);
  }, 30_000);

  it('a client refuses a server whose certificate claims the expected device but is signed by another key', async () => {
    const anna = await owned('Anna');
    const ben = await device('Ben');
    // Ben's own, valid certificate: it speaks for Ben's device, not for Anna's.
    await expect(tlsPost(ben.svc.urls[0]!, deviceCertificate(newEd()), anna.svc.view().me.device, '/team/v2/sync', () => '{}')).rejects.toThrow(/another device/);
  }, 30_000);

  it('the listener never presents the device signing key', async () => {
    const anna = await owned('Anna');
    const res = await tlsPost(anna.svc.urls[0]!, deviceCertificate(newEd()), anna.svc.view().me.device, '/team/v2/sync', () => '{}');
    expect(res.peer?.device).toBe(anna.svc.view().me.device);
    expect(res.peer?.tls).not.toBe(anna.svc.view().me.device);
  }, 30_000);

  it('a rotated TLS key keeps the device; the key from before the rotation is refused once the new one was seen', async () => {
    const clock = { now: Date.now() };
    const anna = await owned('Anna', clock);
    const ben = await device('Ben', clock);
    await ben.svc.join((await anna.svc.invite(anna.team, 'edit')).link, 'Ben');
    await ben.svc.syncAll();
    const annaDevice = anna.svc.view().me.device;
    const before = anna.svc['tls'];
    // Half a key's life later, the next sync makes a new TLS key; the device and the team stay as they were.
    clock.now += TLS_KEY_ROTATE_MS + 1000;
    await anna.svc.syncAll();
    const after = anna.svc['tls'];
    expect(after.tlsPub).not.toBe(before.tlsPub);
    expect(anna.svc.view().me.device).toBe(annaDevice);
    // Anna, with the new key, still reaches Ben: that sync does not throw.
    await anna.svc.syncAll();
    // Someone holding Anna's old TLS key and its still unexpired binding is refused by Ben now.
    const res = await tlsPost(ben.svc.urls[0]!, before, ben.svc.view().me.device, '/team/v2/sync', () => JSON.stringify({ team: anna.team, ops: [], vectors: {} }), { now: clock.now });
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/older TLS key/);
  }, 60_000);

  it('keeps the TLS key across a restart while it is young', async () => {
    const anna = await owned('Anna');
    const first = anna.svc['tls'].tlsPub;
    await anna.svc.stop();
    await anna.svc.start();
    expect(anna.svc['tls'].tlsPub).toBe(first);
  }, 30_000);
});
