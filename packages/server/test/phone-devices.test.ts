import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BogenDoc, Y } from '@bogen/core';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { phoneManifest, phoneShell } from '../src/http/static.ts';
import { buildCommit, compareBuilds, validSshHost } from '../src/peer-deploy.ts';
import { isLocalOnlyPath, validPhoneUrl } from '../src/peers.ts';
import { assetNameOf, runImages } from '../src/run-images.ts';
import type { ServeStatus, TailscaleCli } from '../src/tailnet.ts';
import { until } from './helpers.ts';

const OWNER = 'owner@example.com';
const homes: string[] = [];
const running = new Set<BogenServer>();

afterEach(async () => {
  for (const s of running) await s.close();
  running.clear();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function fakeTailscale(name: string): TailscaleCli {
  const config: ServeStatus = { TCP: {}, Web: {} };
  return {
    self: async () => ({ dnsName: name, ownerLogin: OWNER, ips: ['100.64.0.10'], peers: [] }),
    serveStatus: async () => structuredClone(config),
    serve: async (port, target) => {
      config.TCP![port] = { HTTPS: true };
      config.Web![`${name}:${port}`] = { Handlers: { '/': { Proxy: target } } };
    },
    serveOff: async () => {},
    packetFilter: async () => [],
  };
}

async function boot(name: string, options: Partial<ServerOptions> = {}): Promise<BogenServer> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-phone-dev-'));
  homes.push(home);
  const server = new BogenServer({ home, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(home, 'exports'), tailscale: fakeTailscale(name), phonePort: 0, ...options });
  await server.listen();
  running.add(server);
  await fetch(`${server.localUrl()}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
  return server;
}

function phoneCall(server: BogenServer, host: string, path: string, options: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({
      host: '127.0.0.1', port: server.phone.boundPort, path, method: options.method ?? 'GET',
      headers: { Host: host, 'Tailscale-User-Login': OWNER, Origin: `https://${host}`, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function pairPhone(server: BogenServer, host: string): Promise<string> {
  const { code } = await (await fetch(`${server.localUrl()}/api/phone/code`, { method: 'POST' })).json() as { code: string };
  const paired = await phoneCall(server, host, '/api/phone/pair', { method: 'POST', body: { code, name: 'iPhone' } });
  expect(paired.status).toBe(201);
  return String(paired.headers['set-cookie']).split(';')[0]!;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('a phone that was offline', () => {
  it('sends its edits before it connects, and hears which values both sides set while apart', async () => {
    const host = 'omarchy.tail123456.ts.net:29443';
    const pc = await boot('omarchy.tail123456.ts.net', { phoneHttpsPort: 29443 });
    const cookie = await pairPhone(pc, host);
    const { id: fileId } = await (await fetch(`${pc.localUrl()}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Apart' }) })).json() as { id: string };
    const room = await pc.rooms.get(fileId);
    const pageId = room.doc.getPages()[0]!.id;
    const cardId = room.doc.insert(pageId, { type: 'frame', name: 'Card', style: { backgroundColor: '#ffffff', width: '200px' } });

    // The phone has what the computer had, then both change the same fill, and the phone another one too.
    const phone = new BogenDoc(new Y.Doc());
    Y.applyUpdate(phone.y, Y.encodeStateAsUpdate(room.doc.y));
    const phoneBefore = Y.encodeStateVector(phone.y);
    phone.updateStyle(cardId, { backgroundColor: '#ff0000', width: '320px' });
    room.doc.updateStyle(cardId, { backgroundColor: '#0000ff' });

    // Not over the tailnet listener, and not without a paired phone.
    expect(isLocalOnlyPath(`/api/files/${fileId}/catch-up`)).toBe(true);
    expect((await phoneCall(pc, host, `/api/files/${fileId}/catch-up`)).status).toBe(401);

    const sv = await phoneCall(pc, host, `/api/files/${fileId}/catch-up`, { cookie });
    expect(sv.status).toBe(200);
    const update = Y.encodeStateAsUpdate(phone.y, new Uint8Array(Buffer.from(sv.json().sv, 'base64')));
    const out = await phoneCall(pc, host, `/api/files/${fileId}/catch-up`, { method: 'POST', cookie, body: { update: b64(update), sv: b64(Y.encodeStateVector(phone.y)) } });
    expect(out.status).toBe(200);
    const result = out.json();
    expect(result.changed).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ kind: 'layer', nodeId: cardId, field: 'style.backgroundColor', ours: '#0000ff', theirs: '#ff0000', device: 'iPhone' });
    // The width only the phone changed merged with no note, and the fill is what the note says was kept.
    const node = room.doc.getNode(cardId)!;
    expect(node.style.width).toBe('320px');
    expect(node.style.backgroundColor).toBe(result.conflicts[0].kept === 'theirs' ? '#ff0000' : '#0000ff');
    // The desktop's Sync section lists it, as a note from the iPhone.
    const listed = await (await fetch(`${pc.localUrl()}/api/files/${fileId}/conflicts`)).json() as { id: string; device: string }[];
    expect(listed.map((c) => c.id)).toContain(result.conflicts[0].id);
    // And the phone now knows the computer has all of it.
    const after = Y.decodeStateVector(new Uint8Array(Buffer.from(result.sv, 'base64')));
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(phone.y))) expect(after.get(client) ?? 0).toBeGreaterThanOrEqual(clock);
    expect(phoneBefore.length).toBeGreaterThan(0);

    // Sending it again changes nothing and makes no second note.
    const again = await phoneCall(pc, host, `/api/files/${fileId}/catch-up`, { method: 'POST', cookie, body: { update: b64(update), sv: b64(Y.encodeStateVector(phone.y)) } });
    expect(again.json()).toMatchObject({ changed: false, conflicts: [] });
    expect((await phoneCall(pc, host, `/api/files/${fileId}/catch-up`, { method: 'POST', cookie, body: { update: 'bm90IGEgeWpzIHVwZGF0ZQ==', sv: '' } })).status).toBe(400);
  });
});

describe('which computer the phone talks to', () => {
  it('marks the app shell as the phone listener, named after this computer, and escapes the name', () => {
    const html = '<!doctype html><html><head><meta name="apple-mobile-web-app-title" content="Bogen" /><title>Bogen</title></head></html>';
    const out = phoneShell(html, { host: 'MacBook "Air"' });
    expect(out).toContain('<meta name="bogen-listener" content="phone" />');
    expect(out).toContain('<meta name="bogen-host" content="MacBook &#34;Air&#34;" />');
    expect(out).toContain('<meta name="apple-mobile-web-app-title" content="Bogen MacBook &#34;Air&#34;" />');
    expect(JSON.parse(phoneManifest('{"name":"Bogen","short_name":"Bogen","id":"/"}', { host: 'omarchy' }))).toEqual({ name: 'Bogen on omarchy', short_name: 'Bogen omarchy', id: '/' });
  });

  it('passes on only a ts.net https address for another device', () => {
    expect(validPhoneUrl('https://my-laptop.tail123456.ts.net:29443/')).toBe('https://my-laptop.tail123456.ts.net:29443/');
    expect(validPhoneUrl('https://my-laptop.tail123456.ts.net/')).toBe('https://my-laptop.tail123456.ts.net/');
    expect(validPhoneUrl('http://my-laptop.tail123456.ts.net:29443/')).toBeUndefined();
    expect(validPhoneUrl('https://evil.example/')).toBeUndefined();
    expect(validPhoneUrl('https://x.ts.net.evil.example/')).toBeUndefined();
    expect(validPhoneUrl(42)).toBeUndefined();
  });

  it('lists the other computers with their phone address, which each tells its peers', async () => {
    const pcHost = 'omarchy.tail123456.ts.net:29443';
    const pc = await boot('omarchy.tail123456.ts.net', { phoneHttpsPort: 29443 });
    const mac = await boot('my-laptop.tail123456.ts.net', { phoneHttpsPort: 29443 });
    const info = await (await fetch(`${pc.localUrl()}/api/peers/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ insecure: true, name: 'PC' }) })).json() as { url: string; token: string };
    expect((await fetch(`${mac.localUrl()}/api/peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: info.url, token: info.token, insecure: true, name: 'PC' }) })).status).toBe(201);
    await until(() => pc.peers.status().some((p) => p.phoneUrl === 'https://my-laptop.tail123456.ts.net:29443/'), 8000);

    const cookie = await pairPhone(pc, pcHost);
    expect((await phoneCall(pc, pcHost, '/api/phone/hosts')).status).toBe(401);
    const hosts = (await phoneCall(pc, pcHost, '/api/phone/hosts', { cookie })).json();
    expect(hosts.self).toMatchObject({ name: 'PC', url: `https://${pcHost}/` });
    expect(hosts.others).toEqual([expect.objectContaining({ url: 'https://my-laptop.tail123456.ts.net:29443/', state: 'connected' })]);
    // The shell says which computer it is.
    const shell = await phoneCall(pc, pcHost, '/');
    expect(shell.text).toMatch(/bogen-host" content="PC"|editor is not built/);

    // The MacBook's phone listener off: the PC hears it with the next manifest.
    await fetch(`${mac.localUrl()}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false, serve: false }) });
    const link = [...(pc.peers as unknown as { links: Map<string, unknown> }).links.values()][0];
    await (pc.peers as unknown as { catchUp: (l: unknown, full: boolean) => Promise<void> }).catchUp(link, false);
    expect(pc.peers.status()[0]!.phoneUrl).toBeUndefined();
  });
});

describe('updating the other device', () => {
  function standIn(): { script: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-deploy-standin-'));
    homes.push(dir);
    const log = join(dir, 'calls.log');
    const script = join(dir, 'deploy.sh');
    writeFileSync(script, `#!/bin/bash\necho "$*" >> "${log}"\nif [[ " $* " == *" --dry-run "* ]]; then echo "Dry run. Nothing will change on either device."; echo "  dist: would change 3 file(s)"; else echo "Deployed. It answers with 0.1.0+def5678"; fi\n`);
    chmodSync(script, 0o755);
    return { script, log };
  }

  it('runs the deploy script for a paired device: a dry run first, then the real one with its plan, only at this machine', async () => {
    const { script, log } = standIn();
    const pc = await boot('omarchy.tail123456.ts.net', { deployScript: script, reportVersion: '0.1.0+abc1234' });
    const mac = await boot('my-laptop.tail123456.ts.net', { reportVersion: '0.1.0+def5678' });
    const info = await (await fetch(`${mac.localUrl()}/api/peers/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ insecure: true, name: 'MacBook' }) })).json() as { url: string; token: string };
    await fetch(`${pc.localUrl()}/api/peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: info.url, token: info.token, insecure: true, name: 'MacBook' }) });
    await until(() => pc.peers.status().some((p) => p.versionMismatch), 8000);
    const id = pc.peers.status()[0]!.id;
    const api = (body?: unknown) => fetch(`${pc.localUrl()}/api/peers/${id}/deploy`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});

    const first = await (await api()).json();
    expect(first).toMatchObject({ available: true, version: '0.1.0+abc1234', peer: { name: 'MacBook', version: '0.1.0+def5678' }, host: '127.0.0.1', hostSaved: false, running: false });

    expect((await api({ host: 'me@127.0.0.1', dryRun: false })).status).toBe(409);
    expect((await api({ host: '-oProxyCommand=touch /tmp/x', dryRun: true })).status).toBe(400);
    const dry = await (await api({ host: 'me@127.0.0.1', dryRun: true })).json();
    expect(dry).toMatchObject({ code: 0, dryRun: true, host: 'me@127.0.0.1' });
    expect(dry.output).toContain('would change 3 file(s)');
    expect(dry.plan).toMatch(/^[\w-]{16}$/);
    // A plan is for the host it was made for, once.
    expect((await api({ host: 'other@127.0.0.1', dryRun: false, plan: dry.plan })).status).toBe(409);
    const real = await (await api({ host: 'me@127.0.0.1', dryRun: false, plan: dry.plan })).json();
    expect(real).toMatchObject({ code: 0, dryRun: false });
    expect((await api({ host: 'me@127.0.0.1', dryRun: false, plan: dry.plan })).status).toBe(409);
    const port = new URL(info.url).port;
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`me@127.0.0.1 --dry-run --port ${port}`, `me@127.0.0.1 --port ${port}`]);
    expect((await (await api()).json()).host).toBe('me@127.0.0.1');
    expect(statSync(join(pc.options.home, 'peer-deploy.json')).mode & 0o777).toBe(0o600);

    // Not from a proxy, not from a phone.
    expect((await fetch(`${pc.localUrl()}/api/peers/${id}/deploy`, { headers: { 'X-Forwarded-For': '100.64.0.11' } })).status).toBe(403);
    const cookie = await pairPhone(pc, 'omarchy.tail123456.ts.net:29443');
    expect((await phoneCall(pc, 'omarchy.tail123456.ts.net:29443', `/api/peers/${id}/deploy`, { cookie })).status).toBe(403);
  });

  it('reads the build of a version and takes only ssh hosts', () => {
    expect(buildCommit('0.1.0+abc1234')).toEqual({ commit: 'abc1234', dirty: false });
    expect(buildCommit('0.1.0+abc1234.f00d42')).toEqual({ commit: 'abc1234', dirty: true });
    expect(buildCommit('0.1.0')).toBeNull();
    for (const ok of ['macbook', 'my-laptop@100.64.0.12', 'me@my-laptop.tail123456.ts.net']) expect(validSshHost(ok)).toBe(true);
    for (const bad of ['-oProxyCommand=x', 'a b', 'me@host;rm', '', 'a/../b', 'x`y`']) expect(validSshHost(bad)).toBe(false);
  });

  it('says which build is newer when the checkout knows both', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bogen-builds-'));
    homes.push(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    const one = git('rev-parse', '--short', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    const two = git('rev-parse', '--short', 'HEAD');
    expect(await compareBuilds(`0.1.0+${two}`, `0.1.0+${one}`, repo)).toBe('newer');
    expect(await compareBuilds(`0.1.0+${one}`, `0.1.0+${two}`, repo)).toBe('older');
    expect(await compareBuilds(`0.1.0+${one}`, `0.1.0+${one}`, repo)).toBe('same');
    expect(await compareBuilds(`0.1.0+${one}`, '0.1.0+1234567', repo)).toBe('unknown');
    expect(await compareBuilds(`0.1.0+${one}`, undefined, repo)).toBe('unknown');
  });
});

describe('photos for agents', () => {
  it('go with a request as images, only image types under the limit', async () => {
    const stored = new Map<string, { bytes: Uint8Array; mime: string }>([
      ['a'.repeat(64) + '.jpg', { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: 'image/jpeg' }],
      ['b'.repeat(64) + '.m4a', { bytes: new Uint8Array([0]), mime: 'audio/mp4' }],
      ['c'.repeat(64) + '.png', { bytes: new Uint8Array(9 * 1024 * 1024), mime: 'image/png' }],
    ]);
    const storage = { readAsset: async (name: string) => stored.get(name) ?? null };
    expect(assetNameOf(`bogen-asset:${'a'.repeat(64)}.jpg`)).toBe(`${'a'.repeat(64)}.jpg`);
    expect(assetNameOf('../etc/passwd')).toBeNull();
    const images = await runImages(storage, [`bogen-asset:${'a'.repeat(64)}.jpg`]);
    expect(images).toEqual([{ data: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg', name: `${'a'.repeat(64)}.jpg` }]);
    await expect(runImages(storage, [`bogen-asset:${'b'.repeat(64)}.m4a`])).rejects.toMatchObject({ status: 415 });
    await expect(runImages(storage, [`bogen-asset:${'c'.repeat(64)}.png`])).rejects.toMatchObject({ status: 413 });
    await expect(runImages(storage, [`bogen-asset:${'d'.repeat(64)}.png`])).rejects.toMatchObject({ status: 404 });
    await expect(runImages(storage, ['https://example.org/x.png'])).rejects.toMatchObject({ status: 400 });
  });

  it('are refused for a run before it starts when they are not images of this computer', async () => {
    const pc = await boot('omarchy.tail123456.ts.net');
    const { id: fileId } = await (await fetch(`${pc.localUrl()}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'P' }) })).json() as { id: string };
    const res = await fetch(`${pc.localUrl()}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, prompt: 'Use this', runner: 'claude', images: [`bogen-asset:${'e'.repeat(64)}.jpg`] }) });
    expect(res.status).toBe(404);
  });
});
