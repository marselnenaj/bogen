import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARAKEET_MODEL } from '../src/speech/catalog.ts';
import { otherLanguage } from '../src/speech/call.ts';
import { hotwords, pcmOf, ResidentParakeet } from '../src/speech/hear.ts';

/** Parakeet v3 through sherpa-onnx: the default way a call hears, with the names on screen as hotwords. */
describe('Parakeet', () => {
  it('turns the names on screen into hotwords, without symbols or long phrases', () => {
    const h = hotwords(['Sprechstunde · Praxis-Website', 'Produkt, Porträts', 'Startseite, Desktop', 'Produkt', 'x', 'A very long name that goes on and on']);
    expect(h).toBe('Sprechstunde :1.5/Praxis Website :1.5/Produkt :1.5/Porträts :1.5/Startseite :1.5/Desktop :1.5');
    expect(hotwords([])).toBe('');
  });

  it('knows a line that is neither German nor English', () => {
    expect(otherLanguage('Más perguntas.')).toBe(true);
    expect(otherLanguage('Más preguntas para el equipo.')).toBe(true);
    expect(otherLanguage('Mach die Überschrift größer.')).toBe(false);
    expect(otherLanguage('Make the headline bigger.')).toBe(false);
  });

  it('downloads four pinned files, credited as CC BY 4.0', () => {
    expect(PARAKEET_MODEL.files.map((f) => f.name)).toEqual(['parakeet-encoder.int8.onnx', 'parakeet-decoder.int8.onnx', 'parakeet-joiner.int8.onnx', 'parakeet-tokens.txt']);
    expect(PARAKEET_MODEL.files.every((f) => /^https:\/\/huggingface\.co\/csukuangfj\/sherpa-onnx-nemo-parakeet-tdt-0\.6b-v3-int8\/resolve\/[0-9a-f]{40}\//.test(f.url) && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(PARAKEET_MODEL.bytes).toBe(PARAKEET_MODEL.files.reduce((n, f) => n + f.bytes, 0));
    expect(PARAKEET_MODEL.attribution).toMatch(/CC BY 4\.0/);
  });

  // Runs with the model on disk: BOGEN_TEST_PARAKEET=<folder with encoder.int8.onnx, decoder…, joiner…, tokens.txt> and
  // BOGEN_TEST_PARAKEET_WAV=<16 kHz mono WAV> with BOGEN_TEST_PARAKEET_TEXT=<what is said in it>.
  const dir = process.env.BOGEN_TEST_PARAKEET;
  it.skipIf(!dir)('hears a German sentence on the CPU, with hotwords', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-parakeet-'));
    try {
      for (const [from, to] of [['encoder.int8.onnx', 'parakeet-encoder.int8.onnx'], ['decoder.int8.onnx', 'parakeet-decoder.int8.onnx'], ['joiner.int8.onnx', 'parakeet-joiner.int8.onnx'], ['tokens.txt', 'parakeet-tokens.txt']] as const) symlinkSync(join(dir!, from), join(home, to));
      const hearer = new ResidentParakeet(home);
      const pcm = pcmOf(readFileSync(process.env.BOGEN_TEST_PARAKEET_WAV!))!;
      const started = performance.now();
      const text = await hearer.transcribe(pcm, ['Sprechstunde', 'Porträts']);
      const warm = performance.now();
      await hearer.transcribe(pcm, []);
      const ms = performance.now() - warm;
      expect(text.toLowerCase().replace(/[^\p{L} ]/gu, '')).toBe(process.env.BOGEN_TEST_PARAKEET_TEXT!.toLowerCase().replace(/[^\p{L} ]/gu, ''));
      expect(ms).toBeLessThan(1500);
      expect(started).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
