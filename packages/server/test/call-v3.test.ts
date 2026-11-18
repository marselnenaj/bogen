import { afterEach, describe, expect, it } from 'vitest';
import { hearingPrompt, screenContext } from '../src/speech/context.ts';
import { HEAR_MODEL } from '../src/speech/catalog.ts';
import { hearVariant, pcmOf } from '../src/speech/hear.ts';
import { wav } from '../src/speech/tts.ts';
import { startServer, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });

describe('hearing on the GPU', () => {
  it('reads 16 kHz mono PCM straight out of the WAV the editor sends, and nothing else', () => {
    const at16k = wav(Float32Array.from([0, 0.5, -0.5, 0.25]), 16000);
    const pcm = pcmOf(at16k)!;
    expect(pcm.byteLength).toBe(8);
    expect(new Int16Array(pcm)[1]).toBeGreaterThan(16000);
    expect(pcmOf(wav(Float32Array.from([0, 1]), 22050))).toBeNull();
    expect(pcmOf(Buffer.from('not a wav at all, just some bytes here and there to be long enough'))).toBeNull();
  });

  it('uses the binding\'s GPU build only when llama.cpp found a GPU', () => {
    expect(hearVariant('vulkan')).toBe('vulkan');
    expect(hearVariant('cuda')).toBe('cuda');
    expect(hearVariant('metal')).toBe('default');
    expect(hearVariant(false)).toBeNull();
    expect(HEAR_MODEL.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('primes listening with the file\'s names first, then design words, each once', () => {
    const p = hearingPrompt({ file: 'Sprechstunde', page: 'Produkt', boards: ['Startseite', 'Profil, Mobil'], selection: ['Startseite'] }, 'de');
    expect(p.startsWith('Sprechstunde, Produkt, Startseite, Profil, Mobil')).toBe(true);
    expect(p).toContain('Überschrift');
    expect(p.match(/Startseite/g)!.length).toBe(1);
    expect(hearingPrompt({}, 'en')).toContain('headline');
  });
});

describe('the call knows what is on screen and keeps its lines', () => {
  it('names the file, page, artboards and selection, and the talk route adds them', async () => {
    h = await startServer();
    const { id: fileId } = await (await fetch(`${h.base}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sprechstunde' }) })).json() as { id: string };
    const room = await h.server.rooms.get(fileId);
    const pageId = room.doc.getPages()[0]!.id;
    room.doc.renamePage(pageId, 'Produkt, Porträts');
    const a = room.doc.insert(pageId, { type: 'frame', name: 'Startseite, Desktop' });
    room.doc.insert(pageId, { type: 'frame', name: 'Profil, Mobil' });
    const screen = await screenContext({ fileName: (id) => h!.server.storage.get(id)?.name, doc: async (id) => (await h!.server.rooms.get(id)).doc }, { fileId, pageId, selection: [a, 'nope'] });
    expect(screen).toEqual({ file: 'Sprechstunde', page: 'Produkt, Porträts', boards: ['Startseite, Desktop', 'Profil, Mobil'], selection: ['Startseite, Desktop'] });

    // The rules speak (no talking layer): the route still accepts the context and the screen.
    const talk = await fetch(`${h.base}/api/call/talk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'route', language: 'en', said: 'Which design?', choice: 'rules', fileId, pageId, selection: [a], context: { working: false, history: [{ who: 'person', text: 'Hi' }, { who: 'hacker', text: 'x' }] } }) });
    expect(talk.status).toBe(200);
    expect(await talk.json()).toMatchObject({ text: null, source: 'rules' });

    // Every line of the call is kept with the chat, even before the chat has a turn.
    const log = (body: unknown) => fetch(`${h!.base}/api/call/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await log({ fileId, conversationId: 'chat1', lines: [
      { at: 1, who: 'person', text: 'No, which design are we talking about?' },
      { at: 2, who: 'voice', text: 'The file Sprechstunde.', kind: 'reply', route: 'answer', source: 'rules', ms: 412 },
      { at: 3, who: 'ghost', text: 'dropped' },
    ] })).status).toBe(200);
    expect((await log({ fileId: 'nofile', conversationId: 'chat1', lines: [] })).status).toBe(404);
    expect((await log({ fileId, lines: [] })).status).toBe(400);
    const chat = await h.server.conversations.get(fileId, 'chat1');
    expect(chat?.call).toEqual([
      { at: 1, who: 'person', text: 'No, which design are we talking about?' },
      { at: 2, who: 'voice', text: 'The file Sprechstunde.', kind: 'reply', route: 'answer', source: 'rules', ms: 412 },
    ]);
  });
});
