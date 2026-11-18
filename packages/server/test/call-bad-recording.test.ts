import { mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallSpeech } from '../src/speech/call.ts';
import { PARAKEET_MODEL } from '../src/speech/catalog.ts';
import { HttpError } from '../src/util.ts';

let home: string | null = null;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = null; });

/**
 * One recording that cannot be read made ffmpeg fail inside the Parakeet and GPU paths, and the service took that for
 * the engines failing: it heard with Voxtype for the rest of its life (found on the live service, 17 Nov 2026).
 */
describe('a recording that cannot be read', () => {
  it('is answered as bad input and leaves Parakeet on', async () => {
    home = mkdtempSync(join(tmpdir(), 'bogen-bad-recording-'));
    const dir = join(home, 'speech', 'whisper');
    mkdirSync(dir, { recursive: true });
    // Parakeet's files at their sizes (sparse), so it counts as here; nothing is loaded before the recording is read.
    for (const f of PARAKEET_MODEL.files) { const fd = openSync(join(dir, f.name), 'w'); ftruncateSync(fd, f.bytes); closeSync(fd); }
    const speech = new CallSpeech(home);
    expect(speech.status().listen.parakeet?.installed).toBe(true);
    const err = await speech.listen(Buffer.from('this is not audio at all'), 'webm', 'en').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect(speech.status().listen.parakeet?.installed).toBe(true);
    expect(speech.hearEngine()).toBe('parakeet');
  });
});
