/**
 * QR codes, written from the rules in ISO/IEC 18004. Byte mode only and versions 1 to 15, which is plenty for a
 * link to open on a phone, and small enough to run on the server and in the editor without a dependency.
 */

export type QrLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * Error correction per version (index 0 is version 1), in the order L, M, Q, H: EC codewords per block, then the
 * block count and data codewords per block of the first group and, where there is one, of the second.
 */
const BLOCKS: number[][][] = [
  [[7, 1, 19], [10, 1, 16], [13, 1, 13], [17, 1, 9]],
  [[10, 1, 34], [16, 1, 28], [22, 1, 22], [28, 1, 16]],
  [[15, 1, 55], [26, 1, 44], [18, 2, 17], [22, 2, 13]],
  [[20, 1, 80], [18, 2, 32], [26, 2, 24], [16, 4, 9]],
  [[26, 1, 108], [24, 2, 43], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
  [[18, 2, 68], [16, 4, 27], [24, 4, 19], [28, 4, 15]],
  [[20, 2, 78], [18, 4, 31], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
  [[24, 2, 97], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
  [[30, 2, 116], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
  [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
  [[20, 4, 81], [30, 1, 50, 4, 51], [28, 4, 22, 4, 23], [24, 3, 12, 8, 13]],
  [[24, 2, 92, 2, 93], [22, 6, 36, 2, 37], [26, 4, 20, 6, 21], [28, 7, 14, 4, 15]],
  [[26, 4, 107], [22, 8, 37, 1, 38], [24, 8, 20, 4, 21], [22, 12, 11, 4, 12]],
  [[30, 3, 115, 1, 116], [24, 4, 40, 5, 41], [20, 11, 16, 5, 17], [24, 11, 12, 5, 13]],
  [[22, 5, 87, 1, 88], [24, 5, 41, 5, 42], [30, 5, 24, 7, 25], [24, 11, 12, 7, 13]],
];

/** Alignment pattern centres per version, from version 2. */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

const LEVELS: QrLevel[] = ['L', 'M', 'Q', 'H'];
/** The two bits each level writes into the format information. They are not in L, M, Q, H order. */
const LEVEL_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const MAX_VERSION = 15;

// Arithmetic in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. EXP is doubled so a sum of two logs
// can index it without a modulo.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;

function mul(a: number, b: number): number {
  return a && b ? EXP[LOG[a]! + LOG[b]!]! : 0;
}

/** The generator polynomial (x - a^0)(x - a^1)...(x - a^(n-1)), highest coefficient first. */
function generator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j]! ^= g[j]!;
      next[j + 1]! ^= mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g;
}

function errorCorrection(data: number[], n: number): number[] {
  const g = generator(n);
  const rem = [...data, ...new Array<number>(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = rem[i]!;
    if (c) for (let j = 1; j <= n; j++) rem[i + j]! ^= mul(g[j]!, c);
  }
  return rem.slice(data.length);
}

interface Spec { ec: number; groups: [number, number][] }

function spec(version: number, level: QrLevel): Spec {
  const [ec, ...rest] = BLOCKS[version - 1]![LEVELS.indexOf(level)]!;
  const groups: [number, number][] = [];
  for (let i = 0; i < rest.length; i += 2) groups.push([rest[i]!, rest[i + 1]!]);
  return { ec: ec!, groups };
}

function dataCapacity(s: Spec): number {
  return s.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

/** Mode, count, bytes, terminator and padding, as codewords. */
function dataCodewords(bytes: Uint8Array, version: number, capacity: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits the data into blocks, adds each block's error correction and interleaves them, codeword by codeword. */
function interleave(data: number[], s: Spec): number[] {
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of s.groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + size));
      at += size;
    }
  }
  const ecs = blocks.map((b) => errorCorrection(b, s.ec));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < s.ec; i++) for (const e of ecs) out.push(e[i]!);
  return out;
}

/** The remainder of `value` shifted left by the generator's degree, divided by `poly`, appended to `value`. */
function bch(value: number, poly: number): number {
  const degree = 31 - Math.clz32(poly);
  let rem = value << degree;
  for (let bit = 31 - Math.clz32(rem); bit >= degree; bit--) if (rem & (1 << bit)) rem ^= poly << (bit - degree);
  return (value << degree) | rem;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  /** Modules that belong to a pattern or to format and version information, which data and masks leave alone. */
  readonly fixed: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  set(r: number, c: number, dark: boolean): void {
    this.dark[r]![c] = dark;
    this.fixed[r]![c] = true;
  }
}

function drawPatterns(g: Grid, version: number): void {
  const n = g.size;
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    // The finder plus its light separator, clipped at the edge.
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        g.set(r, c, ring !== 2 && ring !== 4);
      }
    }
  }
  for (let i = 8; i < n - 8; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  const centres = ALIGN[version - 1]!;
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && (c === 6 || c === last)) || (r === last && c === 6)) continue; // the corners that hold a finder
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) g.set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  if (version >= 7) {
    const bits = bch(version, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(b, a, on);
      g.set(a, b, on);
    }
  }
}

function drawFormat(g: Grid, level: QrLevel, mask: number): void {
  const n = g.size;
  const bits = bch((LEVEL_BITS[level] << 3) | mask, 0x537) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  // Around the top left finder, skipping the timing pattern in row and column 6.
  for (let i = 0; i <= 5; i++) g.set(i, 8, bit(i));
  g.set(7, 8, bit(6));
  g.set(8, 8, bit(7));
  g.set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) g.set(8, 14 - i, bit(i));
  // The copy, split between the other two finders.
  for (let i = 0; i < 8; i++) g.set(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) g.set(n - 15 + i, 8, bit(i));
  g.set(n - 8, 8, true);
}

/** Fills the free modules in the two-column zigzag from the bottom right, skipping the vertical timing column. */
function drawData(g: Grid, codewords: number[]): void {
  const n = g.size;
  const total = codewords.length * 8;
  let i = 0;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (g.fixed[r]![c]) continue;
        // Modules left over after the last codeword are remainder bits, which are light before masking.
        g.dark[r]![c] = i < total && ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
    up = !up;
  }
}

function applyMask(g: Grid, mask: number): void {
  const fn = MASKS[mask]!;
  for (let r = 0; r < g.size; r++) for (let c = 0; c < g.size; c++) if (!g.fixed[r]![c] && fn(r, c)) g.dark[r]![c] = !g.dark[r]![c];
}

/** Penalty rules 1 and 3 for one row or column, from its runs of equal modules. */
function linePenalty(line: boolean[]): number {
  const runs: number[] = [];
  const colours: boolean[] = [];
  for (const m of line) {
    if (colours.length && colours[colours.length - 1] === m) runs[runs.length - 1]!++;
    else {
      runs.push(1);
      colours.push(m);
    }
  }
  let score = 0;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i]! >= 5) score += 3 + runs[i]! - 5;
    // A dark run three units long, flanked by light, dark, light, dark runs of one unit: a finder lookalike.
    // It counts when four units of light lie on either side. The quiet zone is light, so a light run that
    // reaches the edge of the symbol is long enough.
    if (!colours[i] || i < 2 || i + 2 >= runs.length || runs[i]! % 3) continue;
    const u = runs[i]! / 3;
    if (runs[i - 2] !== u || runs[i - 1] !== u || runs[i + 1] !== u || runs[i + 2] !== u) continue;
    const before = i <= 3 ? Infinity : runs[i - 3]!;
    const after = i + 4 >= runs.length ? Infinity : runs[i + 3]!;
    if (before >= 4 * u || after >= 4 * u) score += 40;
  }
  return score;
}

function penalty(g: Grid): number {
  const n = g.size;
  const m = g.dark;
  let score = 0;
  let darkCount = 0;
  for (let r = 0; r < n; r++) {
    score += linePenalty(m[r]!);
    score += linePenalty(m.map((row) => row[r]!));
    for (let c = 0; c < n; c++) {
      if (m[r]![c]) darkCount++;
      if (r + 1 < n && c + 1 < n) {
        const v = m[r]![c];
        if (m[r]![c + 1] === v && m[r + 1]![c] === v && m[r + 1]![c + 1] === v) score += 3;
      }
    }
  }
  // 10 points for each full 5% the dark share, in whole percent, is away from half. Rounding to whole percent
  // first is what qrencode does, and following it lets its output serve as reference.
  const percent = Math.round((darkCount * 100) / (n * n));
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

/** The modules of a QR code for `text`, rows of booleans with true for dark, without the quiet zone. */
export function qrMatrix(text: string, level: QrLevel = 'M'): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    const needed = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (needed <= dataCapacity(spec(version, level)) * 8) break;
  }
  if (version > MAX_VERSION) {
    throw new Error(`Text too long for a QR code: ${bytes.length} bytes do not fit in version ${MAX_VERSION} at level ${level}`);
  }
  const s = spec(version, level);
  const codewords = interleave(dataCodewords(bytes, version, dataCapacity(s)), s);

  const g = new Grid(17 + 4 * version);
  drawPatterns(g, version);
  drawFormat(g, level, 0); // reserves the format modules so data goes around them
  drawData(g, codewords);
  const base = g.dark.map((row) => [...row]);

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    drawFormat(g, level, mask);
    const score = penalty(g);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    for (let r = 0; r < g.size; r++) g.dark[r] = [...base[r]!];
  }
  applyMask(g, best);
  drawFormat(g, level, best);
  return g.dark;
}

/**
 * Text for a terminal, two module rows per line. Light modules are drawn as blocks and dark ones left as the
 * background, so it scans on the usual light-on-dark terminal. The quiet zone is light.
 */
export function qrTerminal(matrix: boolean[][], quiet = 2): string {
  const size = matrix.length + 2 * quiet;
  // Outside the symbol and its quiet zone counts as dark, so an odd last row leaves the background below it.
  const light = (r: number, c: number) => r < size && !matrix[r - quiet]?.[c - quiet];
  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = light(r, c);
      const bottom = light(r + 1, c);
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** One SVG path for the dark modules, a rectangle per horizontal run, in a `0 0 size size` viewBox. */
export function qrSvgPath(matrix: boolean[][], quiet = 2): { size: number; d: string } {
  let d = '';
  matrix.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      const start = c;
      while (row[c + 1]) c++;
      const w = c - start + 1;
      d += `M${start + quiet} ${r + quiet}h${w}v1h-${w}z`;
    }
  });
  return { size: matrix.length + 2 * quiet, d };
}
