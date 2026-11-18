import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLocalOnlyPath } from '../src/peers.ts';
import { VOICES, callLanguages, offeredVoices, voiceFor } from '../src/speech/catalog.ts';
import { clauses, finished, phonemeIds, phonemize, tinySentences, wav } from '../src/speech/tts.ts';
import { startServer, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });

describe('Piper text frontend', () => {
  it('splits a sentence into clauses with their marks', () => {
    expect(clauses('Okay, ich mache das. Fertig?')).toEqual([{ text: 'Okay', mark: ',' }, { text: 'ich mache das', mark: '.' }, { text: 'Fertig', mark: '?' }]);
  });
  it('maps phonemes to ids with pads, joins known diphthongs, puts back clause marks', () => {
    const map = { '^': [1], '$': [2], '_': [0], ' ': [3], a: [10], ɪ: [11], aɪ: [12], ',': [4], '.': [5] };
    expect(phonemeIds([{ ipa: 'aɪ', mark: ',' }, { ipa: 'a', mark: '.' }], { phoneme_id_map: map, vowel_clusters: [['a', 'ɪ']] })).toEqual([1, 0, 12, 0, 4, 0, 3, 0, 10, 0, 5, 0, 2]);
    // Without clusters the diphthong is two symbols; unknown symbols are dropped.
    expect(phonemeIds([{ ipa: 'aɪx', mark: '' }], { phoneme_id_map: map })).toEqual([1, 0, 10, 0, 11, 0, 2]);
  });
  it('phonemizes German with its umlauts intact, through eSpeak NG in WebAssembly', async () => {
    const ipa = await phonemize('Die Überschrift ist größer', 'de');
    expect(ipa).toContain('yːbɜʃr');
    expect(ipa).toContain('ɡɾˈøːsɜ');
    expect(ipa).not.toContain('‍');
  });
  it('writes 16-bit mono WAV and keeps peaks from clipping', () => {
    const b = wav(Float32Array.from([0, 2, -2]), 22050);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.readUInt32LE(24)).toBe(22050);
    expect(Math.abs(b.readInt16LE(46))).toBeLessThan(32767);
  });
});

describe('voice catalogue', () => {
  it('has a preferred voice per language, each with a licence and checksums', () => {
    expect(voiceFor('de')?.id).toBe('de_DE-thorsten-medium');
    expect(voiceFor('en')?.id).toBe('en_US-tiny-voca-F2');
    expect(voiceFor('en', 'en_US-ljspeech-medium')?.engine).toBe('piper');
    const tiny = VOICES.filter((v) => v.engine === 'tiny-voca');
    expect(tiny.map((v) => v.speaker)).toEqual([0, 1]);
    expect(tiny[0]!.files).toBe(tiny[1]!.files);
    for (const v of tiny) expect(v.attribution).toMatch(/CC BY 4\.0/);
    for (const f of tiny[0]!.files) expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    for (const v of VOICES) {
      expect(v.licence.length).toBeGreaterThan(10);
      for (const f of v.files) expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe('call routes', () => {
  it('are closed on the tailnet and answer the owner here', async () => {
    expect(isLocalOnlyPath('/api/call/say')).toBe(true);
    h = await startServer();
    const status = await (await fetch(`${h.base}/api/call/status`)).json() as { voices: { language: string }[]; ready: Record<string, boolean>; languages: string[] };
    // English only until German has its own voice: no German voice is offered or downloadable.
    expect(status.languages).toEqual(['en']);
    expect(status.voices.length).toBe(offeredVoices().length);
    expect(status.voices.every((v) => v.language === 'en')).toBe(true);
    expect(status.ready).toEqual({ de: false, en: false });
    expect((await fetch(`${h.base}/api/call/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'de_DE-thorsten-medium' }) })).status).toBe(404);
    const say = await fetch(`${h.base}/api/call/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hallo', language: 'de' }) });
    expect(say.status).toBe(409);
    expect((await fetch(`${h.base}/api/call/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x', language: 'fr' }) })).status).toBe(400);
    expect((await fetch(`${h.base}/api/call/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'nope' }) })).status).toBe(404);
    expect((await fetch(`${h.base}/api/call/listen`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'x' })).status).toBe(415);
  });

  // With BOGEN_TEST_VOICES pointing at downloaded Piper voices, the real voices speak.
  const voices = process.env.BOGEN_TEST_VOICES;
  it('speaks English unless German is turned on', () => {
    expect(callLanguages({})).toEqual(['en']);
    expect(callLanguages({ BOGEN_CALL_LANGUAGES: 'en,de' })).toEqual(['en', 'de']);
    expect(callLanguages({ BOGEN_CALL_LANGUAGES: 'fr' })).toEqual(['en']);
    expect(offeredVoices({}).some((v) => v.language === 'de')).toBe(false);
    expect(offeredVoices({ BOGEN_CALL_LANGUAGES: 'de,en' }).some((v) => v.language === 'de')).toBe(true);
  });

  it.skipIf(!voices || !existsSync(join(voices, 'de_DE-thorsten-medium.onnx')))('speaks a German and an English sentence with the real voices', async () => {
    process.env.BOGEN_CALL_LANGUAGES = 'en,de';
    h = await startServer();
    const dir = join(h.home, 'speech', 'voices');
    mkdirSync(dir, { recursive: true });
    for (const v of VOICES) for (const f of v.files) if (!existsSync(join(dir, f.name)) && existsSync(join(voices!, f.name))) symlinkSync(join(voices!, f.name), join(dir, f.name));
    for (const [language, text] of [['de', 'Die Überschrift ist jetzt größer.'], ['en', 'The headline is larger now.']]) {
      const r = await fetch(`${h.base}/api/call/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language }) });
      expect(r.status).toBe(200);
      const b = Buffer.from(await r.arrayBuffer());
      expect(b.toString('ascii', 0, 4)).toBe('RIFF');
      expect((b.length - 44) / 2 / 22050).toBeGreaterThan(1);
    }
  }, 60_000);
});

describe('tiny-voca', () => {
  it('splits sentences as its own reader does and ends a text with a mark', () => {
    expect(tinySentences('Dr. Lena Hofer called. She paid $12.50 at 3 p.m. today! Is it done?')).toEqual(['Dr. Lena Hofer called.', 'She paid $12.50 at 3 p.m. today!', 'Is it done?']);
    expect(finished('Make it bigger')).toBe('Make it bigger.');
    expect(finished('Done, really?')).toBe('Done, really?');
    expect(finished('see you :)')).toBe('see you :).');
  });

  // With BOGEN_TEST_TINY_VOCA pointing at a folder with the tiny-voca files under Bogen's names, both speakers speak.
  const tiny = process.env.BOGEN_TEST_TINY_VOCA;
  it.skipIf(!tiny || !existsSync(join(tiny, 'tiny-voca-model.onnx')))('speaks with both speakers, fast, at 24 kHz', async () => {
    h = await startServer();
    const dir = join(h.home, 'speech', 'voices');
    mkdirSync(dir, { recursive: true });
    for (const f of VOICES.find((v) => v.engine === 'tiny-voca')!.files) if (existsSync(join(tiny!, f.name))) symlinkSync(join(tiny!, f.name), join(dir, f.name));
    for (const voice of ['en_US-tiny-voca-F2', 'en_US-tiny-voca-M2']) {
      const say = (text: string) => fetch(`${h!.base}/api/call/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language: 'en', voice }) });
      await say('Warm up.');
      const started = Date.now();
      const r = await say('Done. The headline is bigger now and sits on two lines. Should it be bolder too?');
      const ms = Date.now() - started;
      expect(r.status).toBe(200);
      const b = Buffer.from(await r.arrayBuffer());
      expect(b.readUInt32LE(24)).toBe(24000);
      expect((b.length - 44) / 2 / 24000).toBeGreaterThan(3);
      expect(ms).toBeLessThan(2000);
    }
  }, 60_000);
});

describe('talking layer', () => {
  it('lists the local models with a licence and checksums, one for GPUs and one for CPUs', async () => {
    const { TALK_MODELS } = await import('../src/speech/catalog.ts');
    expect(TALK_MODELS.some((m) => m.forGpu)).toBe(true);
    expect(TALK_MODELS.some((m) => !m.forGpu)).toBe(true);
    for (const m of TALK_MODELS) {
      expect(m.licence).toMatch(/Apache-2\.0/);
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\//);
    }
  });

  it('answers with no line when the rules should speak, and is closed on the tailnet', async () => {
    expect(isLocalOnlyPath('/api/call/talk')).toBe(true);
    h = await startServer();
    const post = (body: unknown) => fetch(`${h!.base}/api/call/talk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const rules = await (await post({ kind: 'result', language: 'de', said: 'Mach es blau.', agent: 'Done.', choice: 'rules' })).json() as { text: string | null; source: string };
    expect(rules).toMatchObject({ text: null, source: 'rules' });
    expect((await post({ kind: 'sing', language: 'de', choice: 'rules' })).status).toBe(400);
    const status = await (await fetch(`${h.base}/api/call/status`)).json() as { talk: { models: { installed: boolean }[]; auto: string } };
    expect(status.talk.models.every((m) => !m.installed)).toBe(true);
    expect(['claude', 'rules']).toContain(status.talk.auto);
    expect((await fetch(`${h.base}/api/call/end`, { method: 'POST' })).status).toBe(200);
  });

  it('talks for one call at a time: the newest, and the late end of a call handed on leaves it alone', async () => {
    h = await startServer();
    const post = (name: string, body: unknown) => fetch(`${h!.base}/api/call/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const current = async () => ((await (await fetch(`${h!.base}/api/call/status`)).json()) as { call: { id: string } | null }).call;
    expect(await current()).toBeNull();
    await post('talk', { warm: true, choice: 'rules', call: 'window1call' });
    expect((await current())?.id).toBe('window1call');
    // A second window of the browser opens its call: it is the one call now.
    await post('talk', { warm: true, choice: 'rules', call: 'window2call' });
    expect((await current())?.id).toBe('window2call');
    // The first window's end arrives late: the call going on keeps its talking layer.
    expect(await (await post('end', { call: 'window1call' })).json()).toMatchObject({ ok: true, ended: false });
    expect((await current())?.id).toBe('window2call');
    expect(await (await post('end', { call: 'window2call' })).json()).toMatchObject({ ok: true, ended: true });
    expect(await current()).toBeNull();
    // An editor that sends no id ends whatever is going on, as before.
    await post('talk', { warm: true, choice: 'rules', call: 'window3call' });
    expect((await fetch(`${h.base}/api/call/end`, { method: 'POST' })).status).toBe(200);
    expect(await current()).toBeNull();
  });

  it('keeps one Claude Code session open for the call and reads its stream-json answers', async () => {
    const { ClaudePersona } = await import('../src/speech/persona.ts');
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    const fake = join(dir, 'claude');
    // A stand-in CLI: one process, one answer per input line, and it records its arguments.
    writeFileSync(fake, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
let n = 0, buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); n++;
  const text = 'Antwort ' + n + ': ' + m.message.content[0].text.length;
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Antwort ' } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: text, is_error: false }) + '\\n'); } });
`);
    chmodSync(fake, 0o755);
    const persona = new ClaudePersona({ command: fake, model: 'opus' });
    const a = await persona.reply({ kind: 'result', language: 'de', said: 'Mach es blau.', agent: 'Done.' });
    const b = await persona.reply({ kind: 'result', language: 'de', said: 'Mach es grün.', agent: 'Done.' });
    // A question is answered in a session of its own, so a long retell never holds it up.
    const c = await persona.reply({ kind: 'chat', language: 'de', said: 'Hallo?' });
    expect(a.text).toMatch(/^Antwort 1: /);
    expect(b.text).toMatch(/^Antwort 2: /);
    expect(c.text).toMatch(/^Antwort 1: /);
    const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[];
    // No tools, no MCP servers of the person's, the model asked for, nothing saved.
    expect(args).toEqual(expect.arrayContaining(['--tools', '', '--strict-mcp-config', '--model', 'opus', '--no-session-persistence', '--input-format', 'stream-json']));
    await persona.dispose();
  });

  const MODEL = process.env.BOGEN_TEST_TALK_MODEL;
  it.skipIf(!MODEL)('answers in a sentence or two with a local model (BOGEN_TEST_TALK_MODEL)', async () => {
    const { LocalPersona } = await import('../src/speech/persona.ts');
    const persona = new LocalPersona({ modelPath: MODEL!, family: 'qwen3' });
    const r = await persona.reply({ kind: 'result', language: 'de', said: 'Mach den Button blau.', agent: 'Done: the primary button now uses #2C3EB5. Contrast 8.1:1.' });
    expect(r.text.length).toBeGreaterThan(3);
    expect(r.text.split(/\s+/).length).toBeLessThan(40);
    await persona.dispose();
  }, 120_000);
});
