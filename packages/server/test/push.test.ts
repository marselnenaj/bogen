import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { describePush, encryptPayload, newVapidKeys, pushHostAllowed, vapidHeader, type PushFetch } from '../src/push.ts';
import { phoneRefusedPath } from '../src/phone.ts';
import type { ServeStatus, TailscaleCli } from '../src/tailnet.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

const NAME = 'omarchy.tail123456.ts.net';
const HOST = `${NAME}:29443`;
const OWNER = 'owner@example.com';
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** What the phone's browser does with a message: RFC 8291 in reverse. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}

describe('web push, by the RFCs', () => {
  it('encrypts as in the example of RFC 8291, appendix A', () => {
    const local = createECDH('prime256v1');
    local.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg', local, Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    );
    expect(b64(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    expect(decrypt(body, Buffer.from('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'base64url'), Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'))).toBe('When I grow up, I want to be a watermelon');
  });

  it('signs a VAPID token the push service can check with the key it was given', () => {
    const keys = newVapidKeys();
    const header = vapidHeader('https://web.push.apple.com/QGuQyavXutnMH', keys, 'https://example.org', 1_800_000_000_000);
    const [, token, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(key).toBe(keys.publicKey);
    const [h, c, s] = token!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: 1_800_000_000 + 12 * 3600, sub: 'https://example.org' });
    const raw = Buffer.from(key!, 'base64url');
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('sends only to known push services', () => {
    expect(pushHostAllowed('https://web.push.apple.com/QGuQyavXutnMH')).toBe(true);
    expect(pushHostAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(pushHostAllowed('http://web.push.apple.com/x')).toBe(false);
    expect(pushHostAllowed('https://web.push.apple.com.evil.example/x')).toBe(false);
    expect(pushHostAllowed('https://127.0.0.1/x')).toBe(false);
    expect(pushHostAllowed('https://web.push.apple.com:8443/x')).toBe(false);
    expect(pushHostAllowed('https://user@web.push.apple.com/x')).toBe(false);
  });

  it('says what happened and the file, and nothing a design or a comment says', () => {
    expect(describePush('run', { agent: 'claude', fileName: 'Landing', fileId: 'f1', status: 'done' })).toEqual({ kind: 'run', title: 'Claude finished', body: 'Landing', url: '#/file/f1', tag: 'bogen-run-f1' });
    expect(describePush('run', { agent: 'codex', fileName: 'Landing', fileId: 'f1', status: 'failed' }).title).toBe('Codex stopped with an error');
    expect(describePush('proposal', { agent: 'claude', fileName: 'L', fileId: 'f1', proposals: ['p1'] }).url).toBe('#/review/f1/p1');
    expect(describePush('proposal', { agent: 'claude', fileName: 'L', fileId: 'f1', proposals: ['p1', 'p2', 'p3'] })).toMatchObject({ title: 'Claude has 3 proposals ready', url: '#/' });
    expect(describePush('comment', { agent: 'claude', fileName: 'L', fileId: 'f1', thread: 't1' })).toMatchObject({ title: 'Claude answered a comment', url: '#/file/f1/thread/t1' });
  });

  it('are routes of the phone itself, which the wall for machine routes lets through', () => {
    expect(phoneRefusedPath('/api/phone/push')).toBe(false);
    expect(phoneRefusedPath('/api/phone/push/test')).toBe(false);
    expect(phoneRefusedPath('/api/phone/code')).toBe(true);
    expect(phoneRefusedPath('/api/phone/push/other')).toBe(true);
  });
});

// ---------------------------------------------------------------- through the phone listener

function fakeTailscale(): TailscaleCli {
  const config: ServeStatus = { TCP: {}, Web: {} };
  return {
    self: async () => ({ dnsName: NAME, ownerLogin: OWNER, ips: ['100.64.0.10'], peers: [] }),
    serveStatus: async () => structuredClone(config),
    serve: async (port, target) => {
      config.TCP![port] = { HTTPS: true };
      config.Web![`${NAME}:${port}`] = { Handlers: { '/': { Proxy: target } } };
    },
    serveOff: async (port) => {
      delete config.TCP![port];
      delete config.Web![`${NAME}:${port}`];
    },
    packetFilter: async () => [],
  };
}

function raw(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: () => any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { Host: HOST, 'Tailscale-User-Login': OWNER, Origin: `https://${HOST}`, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...options.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

/** The phone's side of a subscription: its own key pair and secret, as the browser would make them. */
function phoneKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } };
}

async function boot(sent: { url: string; headers: Record<string, string>; body: Buffer }[], answer = 201) {
  const fetchStandIn: PushFetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { status: answer };
  };
  h = await startServer({ tailscale: fakeTailscale(), phonePort: 0, pushFetch: fetchStandIn });
  await fetch(`${h.base}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
  const port = h.server.phone.boundPort;
  const { code } = await (await fetch(`${h.base}/api/phone/code`, { method: 'POST' })).json() as { code: string };
  const paired = await raw(port, '/api/phone/pair', { method: 'POST', body: { code } });
  const cookie = String(paired.headers['set-cookie']).split(';')[0]!;
  const { id: fileId } = await (await fetch(`${h.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Landing page' }) })).json() as { id: string };
  return { h, port, cookie, fileId, phoneId: paired.json().id as string };
}

describe('notifications on a paired phone', () => {
  it('keep one key pair per phone, owner only, and send to the subscription that phone gave', async () => {
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const { h: harness, port, cookie, fileId, phoneId } = await boot(sent);
    const phone = phoneKeys();

    expect((await raw(port, '/api/phone/push')).status).toBe(401);
    const first = await raw(port, '/api/phone/push', { headers: { Cookie: cookie } });
    expect(first.status).toBe(200);
    expect(first.json()).toMatchObject({ on: false, kinds: { run: true, comment: true, proposal: true } });
    const key = first.json().key as string;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    expect((await raw(port, '/api/phone/push', { headers: { Cookie: cookie } })).json().key).toBe(key);

    // A page could otherwise make this computer send requests anywhere.
    const evil = await raw(port, '/api/phone/push', { method: 'POST', headers: { Cookie: cookie }, body: { subscription: { endpoint: 'https://192.168.178.1/hook', keys: phone.keys } } });
    expect(evil.status).toBe(400);
    const on = await raw(port, '/api/phone/push', { method: 'POST', headers: { Cookie: cookie }, body: { subscription: { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: phone.keys } } });
    expect(on.json()).toMatchObject({ on: true, service: 'web.push.apple.com' });

    const { statSync, readFileSync } = await import('node:fs');
    const file = `${harness.home}/push.json`;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).devices[phoneId].publicKey).toBe(key);
    // Not from the desktop or anywhere but the phone it belongs to.
    expect((await fetch(`${harness.base}/api/phone/push`)).status).toBe(404);
    expect((await (await fetch(`${harness.base}/api/phone`)).json()).devices[0].push).toBe(true);

    const test = await raw(port, '/api/phone/push/test', { method: 'POST', headers: { Cookie: cookie } });
    expect(test.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://web.push.apple.com/QGuQyavXutnMH');
    expect(sent[0]!.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '86400' });
    expect(sent[0]!.headers.Authorization).toContain(`k=${key}`);
    expect(JSON.parse(decrypt(sent[0]!.body, phone.ecdh.getPrivateKey(), phone.auth))).toMatchObject({ kind: 'test', title: 'Notifications are on' });

    // An agent's answer to a comment: a message with the file's name, never the words.
    const agent = await connectAgent(harness.base, 'claude');
    await call(agent, 'comment_add', { file_id: fileId, text: 'The secret plan for the hero', x: 10, y: 10 });
    await until(() => sent.length === 2, 4000);
    await harness.server.push.settled();
    const comment = JSON.parse(decrypt(sent[1]!.body, phone.ecdh.getPrivateKey(), phone.auth));
    expect(comment).toMatchObject({ kind: 'comment', title: 'Claude answered a comment', body: 'Landing page' });
    expect(JSON.stringify(comment)).not.toContain('secret');
    await agent.close();

    // The person's own comment is not news for them.
    await fetch(`${harness.base}/api/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, text: 'Mine', author: 'Mara' }) });
    await new Promise((r) => setTimeout(r, 200));
    expect(sent).toHaveLength(2);

    // A run that ends: one message. What it made while it went comes in that one.
    harness.server.fileEvents.append(fileId, 'agent_finished', { source: 'agent', actor: 'codex' }, { agent: 'codex', run_id: 'r1', status: 'done' });
    await harness.server.push.settled();
    expect(sent).toHaveLength(3);
    expect(JSON.parse(decrypt(sent[2]!.body, phone.ecdh.getPrivateKey(), phone.auth))).toEqual({ kind: 'run', title: 'Codex finished', body: 'Landing page', url: `#/file/${fileId}`, tag: `bogen-run-${fileId}` });
    harness.server.fileEvents.append(fileId, 'agent_finished', { source: 'agent', actor: 'codex' }, { agent: 'codex', run_id: 'r2', status: 'stopped' });
    await harness.server.push.settled();
    expect(sent).toHaveLength(3);

    // Kinds the phone turned off are not sent.
    await raw(port, '/api/phone/push', { method: 'POST', headers: { Cookie: cookie }, body: { kinds: { run: false } } });
    harness.server.fileEvents.append(fileId, 'agent_finished', { source: 'agent', actor: 'codex' }, { agent: 'codex', run_id: 'r3', status: 'done' });
    await harness.server.push.settled();
    expect(sent).toHaveLength(3);

    // Removing the phone takes its keys.
    await fetch(`${harness.base}/api/phone/devices/${phoneId}`, { method: 'DELETE' });
    await until(() => !JSON.parse(readFileSync(file, 'utf8')).devices[phoneId], 2000);
  });

  it('tell proposals made during a run once, when it ends, and outside a run after a burst settles', async () => {
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const { h: harness, port, cookie, fileId } = await boot(sent);
    const phone = phoneKeys();
    await raw(port, '/api/phone/push', { method: 'POST', headers: { Cookie: cookie }, body: { subscription: { endpoint: 'https://web.push.apple.com/abc', keys: phone.keys } } });
    const read = (i: number) => JSON.parse(decrypt(sent[i]!.body, phone.ecdh.getPrivateKey(), phone.auth));
    const runs = harness.server.runs as unknown as { activeFor: (id: string) => string | undefined };
    const real = runs.activeFor.bind(runs);
    runs.activeFor = (id) => (id === fileId ? 'run-1' : real(id));
    for (const p of ['p1', 'p2']) harness.server.fileEvents.append(fileId, 'proposal_created', { source: 'agent', actor: 'claude' }, { proposal_id: p });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
    runs.activeFor = real;
    harness.server.fileEvents.append(fileId, 'agent_finished', { source: 'agent', actor: 'claude' }, { agent: 'claude', run_id: 'run-1', status: 'done' });
    await harness.server.push.settled();
    expect(sent).toHaveLength(1);
    expect(read(0)).toMatchObject({ kind: 'proposal', title: 'Claude has 2 proposals ready', url: '#/' });

    harness.server.fileEvents.append(fileId, 'proposal_created', { source: 'agent', actor: 'codex' }, { proposal_id: 'p9' });
    await until(() => sent.length === 2, 5000);
    expect(read(1)).toMatchObject({ kind: 'proposal', title: 'Codex has a proposal ready', url: `#/review/${fileId}/p9` });
  });

  it('stops sending to a subscription the push service says is gone', async () => {
    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const { h: harness, port, cookie, fileId } = await boot(sent, 410);
    await raw(port, '/api/phone/push', { method: 'POST', headers: { Cookie: cookie }, body: { subscription: { endpoint: 'https://web.push.apple.com/abc', keys: phoneKeys().keys } } });
    harness.server.fileEvents.append(fileId, 'agent_finished', { source: 'agent', actor: 'claude' }, { agent: 'claude', run_id: 'r', status: 'done' });
    await harness.server.push.settled();
    expect(sent).toHaveLength(1);
    expect((await raw(port, '/api/phone/push', { headers: { Cookie: cookie } })).json().on).toBe(false);
  });
});
