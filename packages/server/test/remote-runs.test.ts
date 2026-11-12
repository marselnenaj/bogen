import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { until, withoutDesignReview } from './helpers.ts';

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Two real servers, paired the way `bogen peer add` pairs them: the PC, which runs agents, and the MacBook, which
 * asks it to. Both find the same stand-in CLIs on the PATH, so that the run's place is told by where it is recorded.
 */
describe('asking an agent on another device', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-remote-bin-'));
  const log = join(bin, 'calls.jsonl');
  const homes: string[] = [];
  const savedPath = process.env.PATH;
  let pc: BogenServer;
  let mac: BogenServer;
  let file: string;
  let board: string;

  async function boot(options: Partial<ServerOptions> = {}): Promise<BogenServer> {
    const home = mkdtempSync(join(tmpdir(), 'bogen-remote-'));
    homes.push(home);
    const server = new BogenServer({ home, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(home, 'exports'), ...options });
    await server.listen();
    return withoutDesignReview(server);
  }

  beforeAll(async () => {
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    pc = await boot();
    mac = await boot();
    await post(pc.localUrl(), '/api/peers/pair', { name: 'PC', insecure: true });
    await post(mac.localUrl(), '/api/peers/pair', { name: 'MacBook', insecure: true });
    const info = await (await post(pc.localUrl(), '/api/peers/pair', { insecure: true })).json() as { url: string; token: string };
    expect((await post(mac.localUrl(), '/api/peers', { url: info.url, token: info.token, insecure: true })).status).toBe(201);
    const connected = (a: BogenServer, b: BogenServer) => a.peers.status().some((p) => p.id === b.peers.deviceId && p.state === 'connected');
    await until(() => connected(pc, mac) && connected(mac, pc), 8000);
    // A file made on the MacBook, which reaches the PC by sync.
    file = ((await (await post(mac.localUrl(), '/api/files', { name: 'Shared' })).json()) as { id: string }).id;
    const room = await mac.rooms.get(file);
    board = room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '300px', height: '100px', color: '#111111' } }, undefined, 'person:Mara');
    await until(async () => Boolean(pc.storage.get(file)) && Boolean((await pc.rooms.get(file)).doc.getNode(board)), 8000);
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await mac.close();
    await pc.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  it('is refused until the PC\'s owner allows it there, at the PC', async () => {
    expect(await (await fetch(`${mac.localUrl()}/api/runs/remote`)).json()).toEqual([]);
    const refused = await post(mac.localUrl(), '/api/runs', { fileId: file, prompt: 'hi', runner: 'claude', device: pc.peers.deviceId });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('PC does not let this device ask its agents. Turn it on there, in the Agents tab under Other devices.');
    // Straight to the PC with the peer token, as a device could: it offers nothing, and refuses a run.
    const offer = JSON.parse((await mac.peers.request(pc.peers.deviceId, '/api/peer/runs/offer')).toString('utf8'));
    expect(offer).toMatchObject({ device: 'PC', allowed: false, runners: [] });
    const direct = await mac.peers.request(pc.peers.deviceId, '/api/peer/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: file, prompt: 'x', runner: 'claude' }) }).catch((e: Error & { status?: number }) => e);
    expect(direct).toMatchObject({ status: 403, message: 'PC does not let MacBook ask its agents. Turn it on there, in the Agents tab under Other devices.' });
    // And no one without the token gets that far.
    expect((await fetch(`${pc.localUrl()}/api/peer/runs/offer`, { headers: { 'x-bogen-device': mac.peers.deviceId } })).status).toBe(401);
    // The allow list only changes at the PC itself: never through the peer route, which is token only.
    const list = await (await fetch(`${pc.localUrl()}/api/runs/remote/allow`)).json() as { deviceId: string; device: string; allowed: boolean }[];
    expect(list).toEqual([expect.objectContaining({ deviceId: mac.peers.deviceId, device: 'MacBook', allowed: false })]);
    expect((await post(pc.localUrl(), '/api/runs/remote/allow', { deviceId: mac.peers.deviceId, allow: true })).status).toBe(200);
    // A refusal drops what the MacBook knew, so the next look asks again.
    const offers = await (await fetch(`${mac.localUrl()}/api/runs/remote`)).json() as { device: string; runners: { id: string; available: boolean }[] }[];
    expect(offers).toEqual([expect.objectContaining({ device: 'PC', allowed: true, runners: [expect.objectContaining({ id: 'claude', available: true }), expect.objectContaining({ id: 'codex', available: true }), expect.objectContaining({ id: 'opencode', available: expect.any(Boolean) })] })]);
  });

  it('runs on the PC, streams its steps to the MacBook, and its changes come back by sync', async () => {
    const events: any[] = [];
    const off = mac.hub.tap((e) => { if (e.t === 'agent') events.push(e); });
    const tools = [{ name: 'layer_style', args: { node_ids: [board], style: { color: '#e5484d' } } }];
    const res = await post(mac.localUrl(), '/api/runs', { fileId: file, prompt: `make it red ${fake({ tools, reply: 'Made it red.', delayMs: 50 })}`, runner: 'codex', device: pc.peers.deviceId, conversationId: 'remote-chat-1' });
    expect(res.status).toBe(201);
    const { runId, device } = await res.json() as { runId: string; device: string };
    expect(device).toBe('PC');
    await until(() => events.some((e) => e.runId === runId && e.kind === 'done'), 15_000);
    off();
    // Its own tool call, its answer, the server's completion check, done.
    expect(events.filter((e) => e.runId === runId).map((e) => e.tool ?? e.kind)).toEqual(['layer_style', 'text', 'design_verify', 'done']);
    expect(events.find((e) => e.kind === 'text').text).toBe('Made it red.');
    // Recorded where it ran, with who asked; nothing ran on the MacBook.
    const record = await pc.history.get(file, runId);
    expect(record).toMatchObject({ runner: 'codex', status: 'done', askedFrom: 'MacBook', conversationId: 'remote-chat-1' });
    expect(await mac.history.list(file)).toEqual([]);
    await until(async () => (await mac.rooms.get(file)).doc.getNode(board)?.style.color === '#e5484d', 8000);
    // The PC's own run settings chose the model, from the prompt's.
    expect(fakeLog(log).filter((c) => c.kind === 'call').at(-1)!.runner).toBe('codex');

    // What it changed, and Undo this run, from the MacBook, through the PC.
    await until(async () => Boolean((await pc.history.get(file, runId))?.named), 8000);
    const summary = await (await fetch(`${mac.localUrl()}/api/runs/${runId}/summary?fileId=${file}`)).json() as any;
    expect(summary).toMatchObject({ runId, device: 'PC', layers: [{ id: board, name: 'Hero' }] });
    const undone = await post(mac.localUrl(), `/api/runs/${runId}/undo`, { fileId: file, who: 'Mara' });
    expect(undone.status).toBe(200);
    expect((await pc.history.get(file, runId))!.undone!.by).toBe('Mara on MacBook');
    await until(async () => (await mac.rooms.get(file)).doc.getNode(board)?.style.color === '#111111', 8000);
    // Two servers, a run and sync both ways: the waits above allow for a busy machine, so the test does too.
  }, 30_000);

  it('keeps photo references when the phone and remote-run features are combined', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const asset = await mac.storage.putAsset(bytes, 'image/png');
    await pc.storage.putAsset(bytes, 'image/png'); // The already-synced reference on the receiving device.
    const res = await post(mac.localUrl(), '/api/runs', { fileId: file, prompt: `What is in this image? ${fake({ reply: 'A reference image.' })}`, runner: 'codex', device: pc.peers.deviceId, images: [asset.src] });
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    await until(async () => (await pc.history.get(file, runId))?.status === 'done', 10_000);
    expect(fakeLog(log).filter((c) => c.kind === 'call').at(-1)?.images).toEqual([{ via: 'file', bytes: bytes.length }]);
    await until(async () => ((await (await fetch(`${mac.localUrl()}/api/runs/queue`)).json()) as any).running.length === 0, 8000);
  }, 20_000);

  it('shows in both queues, and stops from the MacBook', async () => {
    const res = await post(mac.localUrl(), '/api/runs', { fileId: file, prompt: `wait ${fake({ hang: true })}`, runner: 'claude', device: pc.peers.deviceId });
    const { runId } = await res.json() as { runId: string };
    await until(() => pc.runs.isActive(runId), 8000);
    const there = await (await fetch(`${pc.localUrl()}/api/runs/queue`)).json() as any;
    expect(there.running).toEqual([expect.objectContaining({ runId, source: 'remote', device: 'MacBook' })]);
    const here = await (await fetch(`${mac.localUrl()}/api/runs/queue`)).json() as any;
    expect(here.running).toEqual([expect.objectContaining({ runId, source: 'elsewhere', device: 'PC', fileName: 'Shared' })]);
    expect((await post(mac.localUrl(), `/api/runs/${runId}/stop`, {})).status).toBe(200);
    await until(() => !pc.runs.isActive(runId), 8000);
    await until(async () => (await pc.history.get(file, runId))?.status === 'stopped', 8000);
    await until(async () => ((await (await fetch(`${mac.localUrl()}/api/runs/queue`)).json()) as any).running.length === 0, 8000);
  });

  it('says so when the file has not reached the PC, and when the PC no longer allows it', async () => {
    const local = ((await (await post(mac.localUrl(), '/api/files', { name: 'Only here' })).json()) as { id: string }).id;
    // Taken off the PC before it could arrive there, as if sync had not got to it.
    await until(() => Boolean(pc.storage.get(local)), 8000);
    await pc.storage.remove(local);
    const missing = await post(mac.localUrl(), '/api/runs', { fileId: local, prompt: 'x', runner: 'claude', device: pc.peers.deviceId });
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: string }).error).toBe('This file has not reached PC yet. Wait for it to sync, then ask again.');
    await post(pc.localUrl(), '/api/runs/remote/allow', { deviceId: mac.peers.deviceId, allow: false });
    const refused = await mac.peers.request(pc.peers.deviceId, '/api/peer/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId: file, prompt: 'x', runner: 'claude' }) }).catch((e: Error & { status?: number }) => e);
    expect((refused as { status?: number }).status).toBe(403);
  });

  it('keeps the allow list to the PC itself: not from a phone, not from another device', async () => {
    const asPhone = await fetch(`${pc.localUrl()}/api/runs/remote/allow`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.9' }, body: JSON.stringify({ deviceId: mac.peers.deviceId, allow: true }) });
    expect(asPhone.status).toBe(403);
  });
});
