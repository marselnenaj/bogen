/// <reference path="./sherpa-onnx-node.d.ts" />
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallLanguage } from '@bogen/core';

/**
 * The listening side of a call, kept loaded for the whole call. With a GPU (Vulkan, CUDA or Metal) whisper.cpp runs
 * Whisper large-v3-turbo in this process through @fugood/whisper.node (MIT): a sentence comes back in about 0.2 s
 * here, against about 0.9 s for a new Voxtype process with Whisper base per sentence, and turbo hears German and
 * design words far better. Without a GPU the call keeps Voxtype, since the CPU build of the binding is too slow.
 */

type WhisperModule = typeof import('@fugood/whisper.node');
type WhisperContext = Awaited<ReturnType<WhisperModule['initWhisper']>>;
export type HearVariant = 'vulkan' | 'cuda' | 'default';

/** The binding's build for a GPU that llama.cpp found: Metal is in the default macOS build. */
export function hearVariant(gpu: string | false | null): HearVariant | null {
  if (gpu === 'vulkan') return 'vulkan';
  if (gpu === 'cuda') return 'cuda';
  if (gpu === 'metal') return 'default';
  return null;
}

/** 16-bit mono PCM at 16 kHz from a WAV that already has that format; null when it needs converting. */
export function pcmOf(wav: Buffer): ArrayBuffer | null {
  if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let format: { channels: number; rate: number; bits: number; pcm: boolean } | null = null;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') format = { pcm: wav.readUInt16LE(body) === 1, channels: wav.readUInt16LE(body + 2), rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!format || !format.pcm || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) return null;
      const end = Math.min(wav.length, body + size);
      const out = new ArrayBuffer(end - body - ((end - body) % 2));
      new Uint8Array(out).set(wav.subarray(body, body + out.byteLength));
      return out;
    }
    at = body + size + (size % 2);
  }
  return null;
}

export class ResidentWhisper {
  private loading: Promise<WhisperContext> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelPath: string, readonly variant: HearVariant) {}

  private context(): Promise<WhisperContext> {
    this.loading ??= (async () => {
      const { initWhisper } = await import('@fugood/whisper.node');
      return initWhisper({ filePath: this.modelPath, useGpu: true }, this.variant);
    })();
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  /** Loads the model, so the first sentence of a call is not slow. */
  async warm(): Promise<void> { await this.context(); }

  /** One utterance, as 16 kHz mono 16-bit PCM. One at a time: the model is one context. */
  transcribe(pcm: ArrayBuffer, language: CallLanguage | 'auto', prompt: string): Promise<string> {
    return this.run(pcm, language, prompt).then((r) => r.text);
  }

  /**
   * One utterance in German or English, whichever it is: Whisper detects the language, and a line it takes for any
   * other language is heard again as the call's language, since a call is in German or English and nothing else.
   */
  async transcribeDeEn(pcm: ArrayBuffer, language: CallLanguage, prompt: string): Promise<string> {
    const first = await this.run(pcm, 'auto', prompt);
    if (first.language === 'de' || first.language === 'en') return first.text;
    return (await this.run(pcm, language, prompt)).text;
  }

  private run(pcm: ArrayBuffer, language: CallLanguage | 'auto', prompt: string): Promise<{ text: string; language?: string }> {
    const job = this.queue.then(async () => {
      const ctx = await this.context();
      const { promise } = ctx.transcribeData(pcm, { language, temperature: 0, maxThreads: 4, ...(prompt ? { prompt } : {}) });
      const r = await promise;
      return r.isAborted ? { text: '' } : { text: r.result, ...(r.language ? { language: r.language } : {}) };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async release(): Promise<void> {
    const ctx = this.loading;
    this.loading = null;
    if (ctx) await (await ctx.catch(() => null))?.release().catch(() => undefined);
  }
}

/**
 * Silero VAD through sherpa-onnx, kept loaded for the call: how much of a stretch is speech, in milliseconds. About
 * 7 ms for a 4 s stretch on one CPU thread, where whisper.cpp's VAD took about 600 ms and held up every turn.
 */
export class ResidentVad {
  private loading: Promise<SherpaVad> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelPath: string) {}

  private detector(): Promise<SherpaVad> {
    this.loading ??= (async () => {
      const sherpa = (await import('sherpa-onnx-node')) as unknown as SherpaModule & { default?: SherpaModule };
      const mod = (sherpa.Vad ? sherpa : sherpa.default!) as SherpaModule;
      return new mod.Vad({ sileroVad: { model: this.modelPath, threshold: 0.5, minSilenceDuration: 0.15, minSpeechDuration: 0.2, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 60);
    })();
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  async warm(): Promise<void> { await this.detector(); }

  /** Milliseconds of speech in 16 kHz mono 16-bit PCM. */
  speechMs(pcm: ArrayBuffer): Promise<number> {
    const job = this.queue.then(async () => {
      const vad = await this.detector();
      const samples = floats(pcm);
      vad.reset();
      for (let at = 0; at < samples.length; at += 512) vad.acceptWaveform(samples.subarray(at, at + 512));
      vad.flush();
      let ms = 0;
      while (!vad.isEmpty()) { ms += (vad.front(false).samples.length / 16000) * 1000; vad.pop(); }
      return Math.round(ms);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async release(): Promise<void> { this.loading = null; }
}

/** Total speech of whisper.cpp's VAD segments, whose times are in hundredths of a second. */
export function speechMsOf(segments: { t0: number; t1: number }[]): number {
  return Math.round(segments.reduce((n, s) => n + Math.max(0, s.t1 - s.t0), 0) * 10);
}

type SherpaModule = typeof import('sherpa-onnx-node');
type OfflineRecognizer = InstanceType<SherpaModule['OfflineRecognizer']>;
type SherpaVad = InstanceType<SherpaModule['Vad']>;

/** The words of a stretch as floats, from 16 kHz mono 16-bit PCM. */
function floats(pcm: ArrayBuffer): Float32Array {
  const ints = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = ints[i]! / 32768;
  return out;
}

/** Words people use about a design in a call, in German and English: boosted, so that they come out as said. */
const DESIGN_WORDS = [
  'Artboard', 'Padding', 'Margin', 'Komponente', 'Komponenten', 'Instanz', 'Seitenkopf', 'Kopfzeile', 'Fußzeile', 'Hero', 'Token',
  'Button', 'Layout', 'Spacing', 'Border Radius', 'Kontrast', 'Überschrift', 'Schriftgröße', 'Abstand', 'Agent', 'Ebene',
  'Frame', 'Header', 'Footer', 'Component', 'Typography', 'Mobile', 'Desktop', 'Primary Color', 'Akzentfarbe', 'Marke',
];
export function designHotwords(): string[] { return DESIGN_WORDS; }

/**
 * Whisper's initial prompt for a call: a short line in the call's language that names the design words and what is
 * on screen, so that "Seitenkopf" or "Padding" come out as written. Kept short: a long prompt makes Whisper repeat it.
 */
export function hearPrompt(language: CallLanguage, names: string[] = []): string {
  const shown = [...new Set(names.map((n) => n.replace(/\s+/g, ' ').trim()).filter((n) => n.length >= 3 && n.length <= 40))].slice(0, 8);
  const lead = language === 'de'
    ? 'Ein Gespräch über ein Design: Seitenkopf, Komponente, Artboard, Padding, Abstand, Hero, Token, Button, Layout.'
    : 'A talk about a design: header, component, artboard, padding, spacing, hero, token, button, layout.';
  return shown.length ? `${lead} ${shown.join(', ')}.` : lead;
}

/**
 * Hotwords for sherpa-onnx: the names on screen (file, page, artboards, selection), each boosted a little, so that
 * "Sprechstunde" or "Porträts" come out as written. Only letters, digits and spaces; at most 40 phrases.
 */
export function hotwords(names: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    for (const part of n.split(/[,·|/:]+/)) {
      const p = part.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
      if (p.length < 3 || p.split(' ').length > 4 || seen.has(p.toLowerCase())) continue;
      seen.add(p.toLowerCase());
      out.push(`${p} :1.5`);
      if (out.length >= 40) return out.join('/');
    }
  }
  return out.join('/');
}

/**
 * NVIDIA Parakeet TDT 0.6B v3 through sherpa-onnx (Apache-2.0), kept loaded for the call, on the CPU: German and
 * English in one model, about 0.2 s a sentence, and no made-up "Vielen Dank." for a sentence it heard badly. The
 * names on screen go in as hotwords, through modified beam search. The language is the model's own guess, so a line
 * in neither of the call's languages is dropped by the caller.
 */
export class ResidentParakeet {
  private loading: Promise<OfflineRecognizer> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string, private readonly threads = 4) {}

  private recognizer(): Promise<OfflineRecognizer> {
    this.loading ??= (async () => {
      const sherpa = (await import('sherpa-onnx-node')) as unknown as SherpaModule & { default?: SherpaModule };
      const mod = (sherpa.OfflineRecognizer ? sherpa : sherpa.default!) as SherpaModule;
      // sherpa-onnx turns hotwords into tokens with a vocabulary file; Parakeet's tokens are that vocabulary.
      const vocab = join(this.dir, 'parakeet-bpe.vocab');
      try { await access(vocab); } catch {
        const tokens = await readFile(join(this.dir, 'parakeet-tokens.txt'), 'utf8');
        await writeFile(vocab, tokens.split('\n').filter(Boolean).map((l) => `${l.split(' ')[0]}\t0`).join('\n') + '\n', { mode: 0o600 });
      }
      return new mod.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: join(this.dir, 'parakeet-encoder.int8.onnx'), decoder: join(this.dir, 'parakeet-decoder.int8.onnx'), joiner: join(this.dir, 'parakeet-joiner.int8.onnx') },
          tokens: join(this.dir, 'parakeet-tokens.txt'), numThreads: this.threads, provider: 'cpu', debug: 0, modelType: 'nemo_transducer', modelingUnit: 'bpe', bpeVocab: vocab,
        },
        decodingMethod: 'modified_beam_search', maxActivePaths: 4,
      });
    })();
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  async warm(): Promise<void> { await this.recognizer(); }

  /** One utterance, as 16 kHz mono 16-bit PCM, with the names on screen as hotwords. One at a time. */
  transcribe(pcm: ArrayBuffer, names: string[] = []): Promise<string> {
    const job = this.queue.then(async () => {
      const r = await this.recognizer();
      const words = hotwords(names);
      const stream = words ? r.createStream(words) : r.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples: floats(pcm) });
      r.decode(stream);
      return (r.getResult(stream).text ?? '').trim();
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async release(): Promise<void> { this.loading = null; }
}
