import { readFileSync, existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { VAD_MODEL } from '../src/speech/catalog.ts';
import { ResidentVad, speechMsOf } from '../src/speech/hear.ts';
import { startServer, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });

describe('telling speech from noise before Whisper', () => {
  it('reads whisper.cpp\'s VAD segments, which are in hundredths of a second', () => {
    expect(speechMsOf([])).toBe(0);
    expect(speechMsOf([{ t0: 152, t1: 158 }, { t0: 173, t1: 186 }])).toBe(190);
  });

  it('fetches the voice activity model with its size and checksum', () => {
    expect(VAD_MODEL.url).toBe('https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx');
    expect(VAD_MODEL.sha256).toBe('1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3');
    expect(VAD_MODEL.bytes).toBe(2_327_524);
  });

  // Needs the downloaded model: BOGEN_TEST_VAD=<path to silero_vad_v6.2.onnx>, and BOGEN_TEST_SPEECH=<16 kHz WAV>.
  const vadFile = process.env.BOGEN_TEST_VAD;
  it.skipIf(!vadFile || !existsSync(vadFile))('finds no speech in silence, noise or typing, and speech in a sentence, in milliseconds', async () => {
    const vad = new ResidentVad(vadFile!);
    const n = 16000 * 3;
    const silence = new Int16Array(n);
    const noise = new Int16Array(n).map(() => Math.round((Math.random() * 2 - 1) * 800));
    const typing = new Int16Array(n);
    for (let k = 0; k < 24; k++) { const at = Math.floor((k / 24) * (n - 400)); for (let i = 0; i < 300; i++) typing[at + i] = Math.round((Math.random() * 2 - 1) * 14000 * Math.exp(-i / 40)); }
    for (const pcm of [silence, noise, typing]) expect(await vad.speechMs(pcm.buffer)).toBeLessThan(250);
    const speech = process.env.BOGEN_TEST_SPEECH;
    if (speech && existsSync(speech)) {
      const b = readFileSync(speech);
      const pcm = new ArrayBuffer(b.length - 44);
      new Uint8Array(pcm).set(b.subarray(44));
      const started = performance.now();
      expect(await vad.speechMs(pcm)).toBeGreaterThan(600);
      expect(performance.now() - started).toBeLessThan(100);
    }
    await vad.release();
  });
});

describe('the call record keeps how each line was heard', () => {
  it('keeps the engine, a noise reason and the new routes, and nothing made up', async () => {
    h = await startServer();
    const { id: fileId } = await (await fetch(`${h.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Call' }) })).json() as { id: string };
    const log = (body: unknown) => fetch(`${h!.base}/api/call/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await log({ fileId, conversationId: 'chat1', lines: [
      { at: 1, who: 'person', text: 'Not just classy, more modern.', engine: 'whisper-gpu' },
      { at: 2, who: 'voice', text: 'Got it, passing that on: more modern.', kind: 'steer', route: 'steer', source: 'rules', ms: 120 },
      { at: 3, who: 'person', text: 'Thank you.', kind: 'noise', reason: 'made-up', engine: 'whisper-gpu' },
      { at: 4, who: 'voice', text: 'x', route: 'teleport', engine: 'whisper gpu!', reason: 'because' },
    ] })).status).toBe(200);
    const chat = await h.server.conversations.get(fileId, 'chat1');
    expect(chat?.call).toEqual([
      { at: 1, who: 'person', text: 'Not just classy, more modern.', engine: 'whisper-gpu' },
      { at: 2, who: 'voice', text: 'Got it, passing that on: more modern.', kind: 'steer', route: 'steer', source: 'rules', ms: 120 },
      { at: 3, who: 'person', text: 'Thank you.', kind: 'noise', reason: 'made-up', engine: 'whisper-gpu' },
      { at: 4, who: 'voice', text: 'x' },
    ]);
  });
});

describe('what the voice knows about the file\'s runs', () => {
  it('gives the last three runs, newest first, with what was asked and answered, and one still running', async () => {
    const { recentRuns } = await import('../src/speech/call.ts');
    const now = Date.UTC(2026, 10, 17, 11, 36);
    const app = {
      options: { home: '' },
      history: { list: async () => [
        { status: 'running', prompt: '[Voice call. Prepared by the call\'s voice from what the person said.]\n\nGoal: Redo it.', title: 'Have the design agent redo the whole thing and make it a lot better.', startedAt: now - 3 * 60_000 },
        { status: 'done', prompt: '3D.', result: 'I took "3D" to mean   giving the design real depth.', startedAt: now - 900 * 60_000, endedAt: now - 880 * 60_000 },
      ] },
    };
    const runs = await recentRuns(app, 'f1', now);
    expect(runs).toEqual([
      { minutesAgo: 3, status: 'running', asked: 'Have the design agent redo the whole thing and make it a lot better.' },
      { minutesAgo: 880, status: 'done', asked: '3D.', result: 'I took "3D" to mean giving the design real depth.' },
    ]);
    expect(await recentRuns({ options: { home: '' } }, 'f1', now)).toEqual([]);
  });
});
