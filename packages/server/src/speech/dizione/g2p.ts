/**
 * g2p.py: the unknown-word model, letters -> CMUdict phonemes. Letter embeddings (each letter given `slots`
 * positions), a two-layer bidirectional GRU and a CTC output read greedily. The weights come in g2p.npz; the
 * arithmetic is done in float32 like NumPy's, so the choices match the Python reference.
 */

import { inflateRawSync } from 'node:zlib';

interface Settings { letters: string; symbols: string[]; width: number; hidden: number; convs: number; layers: number; slots: number }
interface Tensor { shape: number[]; data: Float32Array }

/** The arrays of an .npz file (a zip of .npy files, stored or deflated). */
export function readNpz(file: Buffer): Map<string, Tensor> {
  const out = new Map<string, Tensor>();
  let eocd = file.length - 22;
  while (eocd >= 0 && file.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('g2p.npz is not a zip file');
  const entries = file.readUInt16LE(eocd + 10);
  let at = file.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (file.readUInt32LE(at) !== 0x02014b50) throw new Error('g2p.npz has a broken directory');
    const method = file.readUInt16LE(at + 10);
    const size = file.readUInt32LE(at + 20);
    const nameLength = file.readUInt16LE(at + 28), extra = file.readUInt16LE(at + 30), comment = file.readUInt16LE(at + 32);
    const local = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const dataStart = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    const raw = file.subarray(dataStart, dataStart + size);
    const npy = method === 0 ? raw : inflateRawSync(raw);
    out.set(name.replace(/\.npy$/, ''), readNpy(Buffer.from(npy)));
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

function readNpy(npy: Buffer): Tensor {
  if (npy.readUInt8(0) !== 0x93 || npy.subarray(1, 6).toString('latin1') !== 'NUMPY') throw new Error('not an .npy array');
  const major = npy.readUInt8(6);
  const headerLength = major === 1 ? npy.readUInt16LE(8) : npy.readUInt32LE(8);
  const start = major === 1 ? 10 : 12;
  const header = npy.subarray(start, start + headerLength).toString('latin1');
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw new Error(`unsupported array: ${header}`);
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const bytes = npy.subarray(start + headerLength, start + headerLength + count * 4);
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = bytes.readFloatLE(i * 4);
  return { shape, data };
}

const f = Math.fround;
const sigmoid = (x: number): number => f(1 / f(1 + f(Math.exp(f(-x)))));

/** x (frames × in) · Wᵀ (out × in) + b, accumulated in double and rounded once, like a float32 dot product. */
function linear(x: Float32Array, frames: number, inSize: number, w: Tensor, b: Tensor): Float32Array {
  const outSize = w.shape[0]!;
  const out = new Float32Array(frames * outSize);
  for (let t = 0; t < frames; t++) {
    for (let o = 0; o < outSize; o++) {
      let sum = 0;
      const row = o * inSize, col = t * inSize;
      for (let k = 0; k < inSize; k++) sum += x[col + k]! * w.data[row + k]!;
      out[t * outSize + o] = f(f(sum) + b.data[o]!);
    }
  }
  return out;
}

function gru(x: Float32Array, frames: number, inSize: number, wIh: Tensor, wHh: Tensor, bIh: Tensor, bHh: Tensor, reverse: boolean): Float32Array {
  const size = wHh.shape[1]!;
  const inputs = linear(x, frames, inSize, wIh, bIh);
  let state = new Float32Array(size);
  const out = new Float32Array(frames * size);
  for (let step = 0; step < frames; step++) {
    const t = reverse ? frames - 1 - step : step;
    const recurrent = linear(state, 1, size, wHh, bHh);
    const next = new Float32Array(size);
    const base = t * 3 * size;
    for (let j = 0; j < size; j++) {
      const reset = sigmoid(f(inputs[base + j]! + recurrent[j]!));
      const update = sigmoid(f(inputs[base + size + j]! + recurrent[size + j]!));
      const candidate = f(Math.tanh(f(inputs[base + 2 * size + j]! + f(reset * recurrent[2 * size + j]!))));
      next[j] = f(f(f(1 - update) * candidate) + f(update * state[j]!));
    }
    state = next;
    out.set(state, t * size);
  }
  return out;
}

export class Model {
  readonly settings: Settings;
  private weights: Map<string, Tensor>;
  private letters: Map<string, number>;
  readonly symbols: string[];

  constructor(settings: Settings, npz: Buffer) {
    this.settings = settings;
    this.weights = readNpz(npz);
    this.letters = new Map([...settings.letters].map((letter, i) => [letter, i + 1]));
    this.symbols = settings.symbols;
    if (settings.convs !== 0) throw new Error('this port of the unknown-word model has no convolution layers');
  }

  private w(name: string): Tensor {
    const t = this.weights.get(name);
    if (!t) throw new Error(`g2p.npz lacks ${name}`);
    return t;
  }

  /** The word reduced to the letters the model knows (accents removed). */
  spellable(word: string): string {
    const plain = word.toLowerCase().normalize('NFKD');
    const kept = [...plain].filter((c) => this.letters.has(c)).join('');
    return kept.replace(/^'+|'+$/g, '');
  }

  private logits(word: string): { frames: number; classes: number; data: Float32Array } {
    const { slots, layers } = this.settings;
    const embed = this.w('embed__weight'), slot = this.w('slot');
    const width = embed.shape[1]!;
    const ids = [...word].map((c) => this.letters.get(c)!);
    const frames = ids.length * slots;
    let x = new Float32Array(frames * width);
    ids.forEach((id, n) => {
      for (let s = 0; s < slots; s++) {
        for (let k = 0; k < width; k++) x[(n * slots + s) * width + k] = f(embed.data[id * width + k]! + slot.data[s * width + k]!);
      }
    });
    let inSize = width;
    for (let layer = 0; layer < layers; layer++) {
      const both = (['', '_reverse'] as const).map((suffix) => gru(x, frames, inSize,
        this.w(`gru__weight_ih_l${layer}${suffix}`), this.w(`gru__weight_hh_l${layer}${suffix}`),
        this.w(`gru__bias_ih_l${layer}${suffix}`), this.w(`gru__bias_hh_l${layer}${suffix}`), suffix !== ''));
      const size = this.w(`gru__weight_hh_l${layer}`).shape[1]!;
      const next = new Float32Array(frames * size * 2);
      for (let t = 0; t < frames; t++) {
        next.set(both[0]!.subarray(t * size, (t + 1) * size), t * size * 2);
        next.set(both[1]!.subarray(t * size, (t + 1) * size), t * size * 2 + size);
      }
      x = next;
      inSize = size * 2;
    }
    const out = this.w('out__weight');
    return { frames, classes: out.shape[0]!, data: linear(x, frames, inSize, out, this.w('out__bias')) };
  }

  /** CMUdict symbols with stress digits for `word` (letters and apostrophes). */
  predict(word: string): string[] {
    const spelled = this.spellable(word);
    if (!spelled) return [];
    const { frames, classes, data } = this.logits(spelled);
    const out: string[] = [];
    let previous = 0;
    for (let t = 0; t < frames; t++) {
      let label = 0;
      for (let c = 1; c < classes; c++) if (data[t * classes + c]! > data[t * classes + label]!) label = c;
      if (label !== previous && label !== 0) out.push(this.symbols[label - 1]!);
      previous = label;
    }
    return out;
  }
}
