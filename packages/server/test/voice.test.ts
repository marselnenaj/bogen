import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLocalOnlyPath } from '../src/peers.ts';
import type { ServeStatus, TailscaleCli } from '../src/tailnet.ts';
import { cleanTranscript, findTranscriber, VOICE_LIMIT, VOICE_RETENTION_MS, voiceExtension, voiceNotes } from '../src/voice.ts';
import { startServer, type Harness } from './helpers.ts';

const NAME = 'omarchy.tail123456.ts.net';
const HOST = `${NAME}:29443`;
const OWNER = 'owner@example.com';

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

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; json: () => any }

/** Raw HTTP, since fetch will not send a Host header of our choosing. */
function raw(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body.toString()) });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const viaServe = (extra: Record<string, string> = {}) => ({ Host: HOST, 'Tailscale-User-Login': OWNER, 'X-Forwarded-For': '100.64.0.11', Origin: `https://${HOST}`, ...extra });

/** A few bytes that say they are audio. The stand-in transcriber does not decode them. */
const AUDIO = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(4000, 7)]);

let h: Harness | null = null;
const dirs: string[] = [];
const savedEnv = { BOGEN_TRANSCRIBER: process.env.BOGEN_TRANSCRIBER };
afterEach(async () => {
  await h?.cleanup();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv.BOGEN_TRANSCRIBER === undefined) delete process.env.BOGEN_TRANSCRIBER;
  else process.env.BOGEN_TRANSCRIBER = savedEnv.BOGEN_TRANSCRIBER;
});

/** A script in a temporary folder, as a stand-in for a program. */
function script(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-voice-bin-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function boot(): Promise<{ h: Harness; port: number; fileId: string }> {
  h = await startServer({ tailscale: fakeTailscale(), phonePort: 0 });
  expect((await fetch(`${h.base}/api/phone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })).status).toBe(200);
  const { id } = await (await fetch(`${h.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Voice' }) })).json() as { id: string };
  return { h, port: h.server.phone.boundPort, fileId: id };
}

async function pairPhone(base: string, port: number): Promise<string> {
  const { code } = await (await fetch(`${base}/api/phone/code`, { method: 'POST' })).json() as { code: string };
  const paired = await raw(port, '/api/phone/pair', { method: 'POST', headers: viaServe({ 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), body: JSON.stringify({ code }) });
  expect(paired.status).toBe(201);
  return String(paired.headers['set-cookie']).split(';')[0]!;
}

const voiceFiles = (home: string) => (existsSync(join(home, 'voice')) ? readdirSync(join(home, 'voice')).filter((n) => n !== 'index.json') : []);

describe('voice notes from the phone', () => {
  it('need a paired phone, and are written out by a local transcriber and then deleted', async () => {
    const { h: harness, port, fileId } = await boot();
    const seen = join(mkdtempSync(join(tmpdir(), 'bogen-voice-seen-')), 'path');
    dirs.push(join(seen, '..'));
    process.env.BOGEN_TRANSCRIBER = script('transcribe', `echo "$1" > ${seen}; test -s "$1" && printf '[00:00:00.000 --> 00:00:02.000]  @claude make the headline\\n shorter [BLANK_AUDIO]\\n'`);

    // Without a phone's token the listener refuses before the route, and nothing is stored.
    const anonymous = await raw(port, `/api/voice?fileId=${fileId}`, { method: 'POST', headers: viaServe({ 'Content-Type': 'audio/mp4' }), body: AUDIO });
    expect(anonymous.status).toBe(401);
    expect(voiceFiles(harness.home)).toEqual([]);
    const strangerLogin = await raw(port, `/api/voice?fileId=${fileId}`, { method: 'POST', headers: viaServe({ 'Content-Type': 'audio/mp4', 'Tailscale-User-Login': 'someone@else.example' }), body: AUDIO });
    expect(strangerLogin.status).toBe(403);

    const cookie = await pairPhone(harness.base, port);
    const status = await raw(port, '/api/voice/status', { headers: viaServe({ Cookie: cookie }) });
    expect(status.status).toBe(200);
    expect(status.json()).toMatchObject({ transcriber: { kind: 'command', name: 'transcribe' }, limit: VOICE_LIMIT });

    const sent = await raw(port, `/api/voice?fileId=${fileId}&duration=2.4`, { method: 'POST', headers: viaServe({ Cookie: cookie, 'Content-Type': 'audio/mp4;codecs=mp4a.40.2' }), body: AUDIO });
    expect(sent.status).toBe(201);
    expect(sent.json()).toMatchObject({ transcript: '@claude make the headline shorter', transcriber: 'transcribe' });
    expect(sent.json().attachment).toBeUndefined();
    // The transcriber got the recording in the voice folder, never among the assets, and it is gone now.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(seen, 'utf8')).toContain(join(harness.home, 'voice'));
    expect(voiceFiles(harness.home)).toEqual([]);
    expect(readdirSync(join(harness.home, 'assets')).filter((n) => !n.startsWith('.'))).toEqual([]);
  });

  it('refuses what is too big, empty, not audio, or for a file that does not exist', async () => {
    const { h: harness, fileId } = await boot();
    process.env.BOGEN_TRANSCRIBER = 'off';
    const post = (body: Buffer, type: string, file = fileId, length?: number) => fetch(`${harness.base}/api/voice?fileId=${file}`, { method: 'POST', headers: { 'Content-Type': type, ...(length ? { 'Content-Length': String(length) } : {}) }, body: new Uint8Array(body) });
    expect((await post(Buffer.alloc(VOICE_LIMIT + 1, 1), 'audio/webm')).status).toBe(413);
    expect((await post(AUDIO, 'image/png')).status).toBe(415);
    expect((await post(AUDIO, 'text/html')).status).toBe(415);
    expect((await post(Buffer.alloc(0), 'audio/webm')).status).toBe(400);
    expect((await post(AUDIO, 'audio/webm', 'nosuchfile0')).status).toBe(404);
    expect(voiceFiles(harness.home)).toEqual([]);
    // Streamed without a length: cut off at the limit too.
    const { port } = new URL(harness.base);
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(port), path: `/api/voice?fileId=${fileId}`, method: 'POST', headers: { 'Content-Type': 'audio/ogg', 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', () => resolve(413));
      const piece = Buffer.alloc(1024 * 1024, 3);
      for (let i = 0; i < 11; i++) req.write(piece);
      req.end();
      setTimeout(() => reject(new Error('no answer')), 10_000).unref();
    });
    expect(chunked).toBe(413);
  });

  it('without a model keeps the recording as an attachment, serves it to the owner, and deletes it', async () => {
    const { h: harness, port, fileId } = await boot();
    process.env.BOGEN_TRANSCRIBER = 'off';
    const sent = await fetch(`${harness.base}/api/voice?fileId=${fileId}&duration=12.3`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: AUDIO });
    expect(sent.status).toBe(201);
    const answer = await sent.json() as { transcript: null; reason: string; attachment: { src: string; kind: string; duration: number; device: string } };
    expect(answer.transcript).toBeNull();
    expect(answer.reason).toMatch(/unavailable/);
    expect(answer.attachment).toMatchObject({ kind: 'audio', duration: 12.3, name: 'Voice note' });
    expect(answer.attachment.src).toMatch(/^bogen-voice:[a-f0-9]{24}\.webm$/);
    const name = answer.attachment.src.slice('bogen-voice:'.length);
    expect(voiceFiles(harness.home)).toEqual([name]);
    const { statSync } = await import('node:fs');
    expect(statSync(join(harness.home, 'voice', name)).mode & 0o777).toBe(0o600);

    const got = await fetch(`${harness.base}/api/voice/${name}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('audio/webm');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer()).equals(AUDIO)).toBe(true);
    // A phone that is not paired gets nothing.
    expect((await raw(port, `/api/voice/${name}`, { headers: viaServe() })).status).toBe(401);
    // Names are only ever of the shape the server writes.
    expect((await fetch(`${harness.base}/api/voice/..%2Findex.json`)).status).toBe(404);
    expect((await fetch(`${harness.base}/api/voice/${'a'.repeat(24)}.webm`)).status).toBe(404);

    // The comment carries it, through the same route that starts agents.
    const comment = await fetch(`${harness.base}/api/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, text: 'Voice note', author: 'Ana', pageId: harness.server.rooms.peek(fileId)?.doc.getPages()[0]?.id ?? (await harness.server.rooms.get(fileId)).doc.getPages()[0]!.id, x: 10, y: 10, attachments: [answer.attachment] }) });
    expect(comment.status).toBe(201);
    const { threadId } = await comment.json() as { threadId: string };
    const thread = (await harness.server.rooms.get(fileId)).doc.getComments().find((t) => t.id === threadId)!;
    expect(thread.messages[0]!.attachments).toEqual([answer.attachment]);
    // A src of another shape is refused.
    const bad = await fetch(`${harness.base}/api/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, text: 'x', author: 'Ana', threadId, attachments: [{ src: 'bogen-voice:../../etc/passwd', kind: 'audio' }] }) });
    expect(bad.status).toBe(400);

    expect((await fetch(`${harness.base}/api/voice/${name}`, { method: 'DELETE' })).status).toBe(200);
    expect(voiceFiles(harness.home)).toEqual([]);
    expect((await fetch(`${harness.base}/api/voice/${name}`)).status).toBe(404);
    expect((await fetch(`${harness.base}/api/voice/${name}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('goes with its file, and after the retention period', async () => {
    const { h: harness, fileId } = await boot();
    process.env.BOGEN_TRANSCRIBER = 'off';
    const keep = async (file: string) => (await (await fetch(`${harness.base}/api/voice?fileId=${file}`, { method: 'POST', headers: { 'Content-Type': 'audio/ogg' }, body: AUDIO })).json()) as { attachment: { src: string } };
    await keep(fileId);
    const { id: other } = await (await fetch(`${harness.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Other' }) })).json() as { id: string };
    const second = await keep(other);
    expect(voiceFiles(harness.home)).toHaveLength(2);
    expect((await fetch(`${harness.base}/api/files/${fileId}`, { method: 'DELETE' })).status).toBe(200);
    expect(voiceFiles(harness.home)).toEqual([second.attachment.src.slice('bogen-voice:'.length)]);
    expect(await voiceNotes(harness.server).sweep(Date.now() + VOICE_RETENTION_MS - 60_000)).toBe(0);
    expect(await voiceNotes(harness.server).sweep(Date.now() + VOICE_RETENTION_MS + 60_000)).toBe(1);
    expect(voiceFiles(harness.home)).toEqual([]);
  });

  it('stays off the tailnet listener', () => {
    expect(isLocalOnlyPath('/api/voice')).toBe(true);
    expect(isLocalOnlyPath('/api/voice/status')).toBe(true);
  });
});

describe('transcribers', () => {
  it('are found by looking: whisper.cpp needs its program, a model file and ffmpeg', async () => {
    const model = join(mkdtempSync(join(tmpdir(), 'bogen-voice-model-')), 'ggml-base.en.bin');
    dirs.push(join(model, '..'));
    writeFileSync(model, Buffer.alloc(2_000_000));
    const whisper = script('whisper-cli', `for a; do case "$prev" in -f) test -s "$a" || exit 3;; esac; prev="$a"; done\necho " Hello from the phone."`);
    const ffmpeg = script('ffmpeg', 'for a; do last="$a"; done; printf RIFF > "$last"');
    const dir = join(whisper, '..');
    const env = { PATH: dir, HOME: '/nonexistent', BOGEN_FFMPEG: ffmpeg, BOGEN_WHISPER_MODEL: model };
    const found = await findTranscriber(env);
    expect(found?.kind).toBe('whisper.cpp');
    const audio = join(dir, 'note.m4a');
    writeFileSync(audio, AUDIO);
    expect(cleanTranscript(await found!.run(audio))).toBe('Hello from the phone.');
    expect(await findTranscriber({ ...env, BOGEN_FFMPEG: 'none' })).toBeNull();
    expect(await findTranscriber({ ...env, BOGEN_WHISPER_MODEL: join(dir, 'missing.bin') })).toBeNull();
    expect(await findTranscriber({ ...env, BOGEN_TRANSCRIBER: 'off' })).toBeNull();
    expect(await findTranscriber({ PATH: '/nonexistent', HOME: '/nonexistent' })).toBeNull();
  });

  it('name the type of a body without its parameters, and clean up what they print', () => {
    expect(voiceExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(voiceExtension('Audio/MP4')).toBe('m4a');
    expect(voiceExtension('video/mp4')).toBeNull();
    expect(cleanTranscript('[00:00:00.000 --> 00:00:01.500]   Move it\n[00:00:01.500 --> 00:00:03.000] up. [BLANK_AUDIO] (silence)')).toBe('Move it up.');
  });
});
