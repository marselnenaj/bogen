import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VoiceEntry } from './catalog.ts';
import { Phonemizer } from './dizione/engine.ts';

/**
 * Text to speech for a call, on this computer. An engine loads a voice once and then turns one sentence at a time
 * into a WAV, so the first sentence plays while the next is made. Piper voices run in ONNX Runtime's WebAssembly
 * build, with eSpeak NG (GPL-3.0-or-later, compiled to WebAssembly) for the phonemes, so there is no native binary
 * and nothing that differs between Linux and macOS.
 */
export interface TtsEngine {
  readonly id: VoiceEntry['engine'];
  /** Loads the voice's files from `dir`; cheap when it is already loaded. */
  load(voice: VoiceEntry, dir: string): Promise<void>;
  /** One sentence as 16-bit mono WAV. */
  synthesize(voice: VoiceEntry, text: string, signal?: AbortSignal): Promise<Buffer>;
}

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  vowel_clusters?: string[][];
}

type Ort = typeof import('onnxruntime-web');
interface Session { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> }

let ortModule: Promise<Ort> | null = null;
const ort = (): Promise<Ort> => (ortModule ??= import('onnxruntime-web'));

type ESpeak = (options: { arguments: string[]; preRun?: ((m: { FS: { writeFile(path: string, data: string): void } }) => void)[] }) => Promise<{ FS: { readFile(path: string, o: { encoding: 'utf8' }): string } }>;
let espeakModule: Promise<ESpeak> | null = null;
/** By name, so that type checks of other packages that include this file need no declaration of it. */
const ESPEAK = 'espeak-ng';
const espeak = (): Promise<ESpeak> => (espeakModule ??= (import(ESPEAK) as Promise<{ default: ESpeak }>).then((m) => m.default));

/** IPA for one clause, as eSpeak NG gives it for this language, without the zero-width joiners it puts in ties. */
export async function phonemize(text: string, voice: string): Promise<string> {
  const run = await espeak();
  const e = await run({ preRun: [(m) => m.FS.writeFile('in.txt', text)], arguments: ['--phonout', 'out', '--sep=""', '-q', '-b', '1', '--ipa=3', '-v', voice, '-f', 'in.txt'] });
  return e.FS.readFile('out', { encoding: 'utf8' }).replace(/‍/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Piper's phoneme ids for a sentence: start, each phoneme followed by the pad, end. Diphthongs the voice knows as one
 * symbol (`vowel_clusters`, Piper 1.5) stay one; a phoneme the voice lacks is left out. Clause marks the text had
 * (commas, full stops, questions) are put back, since they shape the voice's pauses and pitch.
 */
export function phonemeIds(clauses: { ipa: string; mark: string }[], config: Pick<PiperConfig, 'phoneme_id_map' | 'vowel_clusters'>): number[] {
  const map = config.phoneme_id_map;
  const pad = map['_'] ?? [0];
  const ids = [...(map['^'] ?? []), ...pad];
  const clusters = new Set((config.vowel_clusters ?? []).map((c) => c.join('')));
  clauses.forEach(({ ipa, mark }, n) => {
    const chars = [...ipa.normalize('NFD')];
    for (let i = 0; i < chars.length; i++) {
      let c = chars[i]!;
      const pair = c + (chars[i + 1] ?? '');
      if (clusters.has(pair) && map[pair]) { c = pair; i++; }
      if (map[c]) ids.push(...map[c]!, ...pad);
    }
    if (mark && map[mark]) ids.push(...map[mark]!, ...pad);
    if (n < clauses.length - 1 && map[' ']) ids.push(...map[' ']!, ...pad);
  });
  ids.push(...(map['$'] ?? []));
  return ids;
}

/** A sentence in clauses, each with the mark that ended it. */
export function clauses(text: string): { text: string; mark: string }[] {
  const out: { text: string; mark: string }[] = [];
  const re = /([^,.;:!?…]+)([,.;:!?…]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[1]!.trim();
    if (t) out.push({ text: t, mark: (m[2] ?? '').slice(0, 1).replace('…', '.') });
  }
  return out;
}

export function wav(samples: Float32Array, rate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]! * gain)) * 32767), 44 + i * 2);
  return buf;
}

export class PiperEngine implements TtsEngine {
  readonly id = 'piper' as const;
  private loaded = new Map<string, Promise<{ session: Session; config: PiperConfig }>>();
  /** One sentence at a time per process: ONNX Runtime's WebAssembly build runs one inference at a time anyway. */
  private queue: Promise<unknown> = Promise.resolve();

  load(voice: VoiceEntry, dir: string): Promise<void> {
    return this.voice(voice, dir).then(() => undefined);
  }

  private voice(voice: VoiceEntry, dir?: string): Promise<{ session: Session; config: PiperConfig }> {
    let found = this.loaded.get(voice.id);
    if (!found) {
      if (!dir) throw new Error(`The voice ${voice.name} is not loaded.`);
      found = (async () => {
        const [model, config] = await Promise.all([readFile(join(dir, `${voice.id}.onnx`)), readFile(join(dir, `${voice.id}.onnx.json`), 'utf8')]);
        const o = await ort();
        const session = (await o.InferenceSession.create(model, { executionProviders: ['wasm'] })) as unknown as Session;
        return { session, config: JSON.parse(config) as PiperConfig };
      })();
      this.loaded.set(voice.id, found);
      found.catch(() => this.loaded.delete(voice.id));
    }
    return found;
  }

  async synthesize(voice: VoiceEntry, text: string, signal?: AbortSignal): Promise<Buffer> {
    const { session, config } = await this.voice(voice);
    const parts = clauses(text);
    if (!parts.length) return wav(new Float32Array(0), config.audio.sample_rate);
    const ipa = await Promise.all(parts.map((p) => phonemize(p.text, config.espeak.voice)));
    const ids = phonemeIds(parts.map((p, i) => ({ ipa: ipa[i]!, mark: p.mark })), config);
    const job = this.queue.then(async () => {
      if (signal?.aborted) throw new Error('Cancelled.');
      const o = await ort();
      const inf = config.inference;
      const out = await session.run({
        input: new o.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new o.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new o.Tensor('float32', Float32Array.from([inf.noise_scale, inf.length_scale, inf.noise_w]), [3]),
      });
      return wav(out[Object.keys(out)[0]!]!.data, config.audio.sample_rate);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

// ---------------------------------------------------------------- tiny-voca

interface TinyVocaConfig { sample_rate: number; voices: string[]; model: { max_tokens: number } }

const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|inc|ltd|co|e\.g|i\.e|a\.m|p\.m)|\b[A-Z])\.$/i;

/** Sentences, without breaking after titles, initials or inside numbers (as tiny-voca's own reader splits them). */
export function tinySentences(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const piece of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/)) {
    current = current ? current + ' ' + piece : piece;
    if (!ABBREVIATIONS.test(current)) { parts.push(current); current = ''; }
  }
  if (current) parts.push(current);
  return parts.filter((part) => /[\p{L}\p{N}]/u.test(part));
}

/** A full stop where the text ends without a mark: before a mark the voice lets the sound fall, without one it breaks off. */
export function finished(text: string): string {
  const body = text.replace(/\s+$/, '');
  if (!body) return text;
  const last = body.split(/\s+/).pop()!;
  const marked = /[\p{L}\p{N}]/u.test(last) ? /[.!?…,;:]["'”’)\]»]*$/.test(last) : /[.!?…]/.test(last) || /^[,;:]$/.test(last);
  return marked ? text : body + '.';
}

/**
 * tiny-voca, two English speakers in one 21 MB ONNX model, about real time times 150 on a CPU. The text goes through
 * Bogen's TypeScript port of dizione, the phonemizer the model was trained with. A sentence longer than the model
 * reads at once is cut at commas, then by words, as tiny-voca's own reader does.
 */
export class TinyVocaEngine implements TtsEngine {
  readonly id = 'tiny-voca' as const;
  private loaded: Promise<{ session: Session; config: TinyVocaConfig; phonemizer: Phonemizer }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  load(_voice: VoiceEntry, dir: string): Promise<void> {
    return this.model(dir).then(() => undefined);
  }

  private model(dir?: string): Promise<{ session: Session; config: TinyVocaConfig; phonemizer: Phonemizer }> {
    if (!this.loaded) {
      if (!dir) throw new Error('The tiny-voca voice is not loaded.');
      const found = (async () => {
        const [model, config] = await Promise.all([readFile(join(dir, 'tiny-voca-model.onnx')), readFile(join(dir, 'tiny-voca-config.json'), 'utf8')]);
        const o = await ort();
        const session = (await o.InferenceSession.create(model, { executionProviders: ['wasm'] })) as unknown as Session;
        return { session, config: JSON.parse(config) as TinyVocaConfig, phonemizer: new Phonemizer(dir, 'tiny-voca-') };
      })();
      this.loaded = found;
      found.catch(() => { if (this.loaded === found) this.loaded = null; });
    }
    return this.loaded;
  }

  /** The phoneme ids of a sentence, cut so each piece fits the model. Nothing when there is nothing to say. */
  private fit(phonemizer: Phonemizer, sentence: string, limit: number): { ids: number[]; stress: number[] }[] {
    let result: { ids: number[]; stress: number[] };
    try { result = phonemizer.phonemize(sentence); } catch { return []; }
    if (result.ids.length <= limit - 12) return [result];
    const pieces = sentence.split(/(?<=[,;:—])\s+/);
    if (pieces.length > 1) return pieces.flatMap((p) => this.fit(phonemizer, p, limit));
    const words = sentence.split(' ');
    if (words.length < 2) return [];
    const half = Math.ceil(words.length / 2);
    return [...this.fit(phonemizer, words.slice(0, half).join(' '), limit), ...this.fit(phonemizer, words.slice(half).join(' '), limit)];
  }

  async synthesize(voice: VoiceEntry, text: string, signal?: AbortSignal): Promise<Buffer> {
    const { session, config, phonemizer } = await this.model();
    const utterances = tinySentences(finished(text)).flatMap((s) => this.fit(phonemizer, s, config.model.max_tokens));
    if (!utterances.length) return wav(new Float32Array(0), config.sample_rate);
    const job = this.queue.then(async () => {
      const o = await ort();
      const chunks: Float32Array[] = [];
      for (const { ids, stress } of utterances) {
        if (signal?.aborted) throw new Error('Cancelled.');
        const ints = (values: number[]) => new o.Tensor('int64', BigInt64Array.from(values.map(BigInt)), [1, values.length]);
        const scalar = (value: number) => new o.Tensor('float32', Float32Array.from([value]), [1]);
        const out = await session.run({
          tokens: ints(ids), stress: ints(stress), voice: new o.Tensor('int64', BigInt64Array.from([BigInt(voice.speaker ?? 0)]), [1]),
          speed: scalar(1), pitch_shift: scalar(0), pitch_range: scalar(1),
        });
        chunks.push(out['audio']!.data);
      }
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) { all.set(c, offset); offset += c.length; }
      return wav(all, config.sample_rate);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}
