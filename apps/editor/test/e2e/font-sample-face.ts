/**
 * A small squared display face, drawn as code for the real run of the font tools (fonts.ts): capitals, figures and
 * basic punctuation on a 1000 unit em. Coordinates are those of a glyph cell: y down, 0 on the ascender line.
 *
 * One system holds it together: vertical stems of 128, horizontals of 108 (thinner, so they look as heavy), one
 * outer corner radius, rounds 6 units over the cap height and baseline, and side bearings by the kind of side:
 * straight, round or open.
 */

export const METRICS = { unitsPerEm: 1000, ascender: 800, descender: -200, capHeight: 700, xHeight: 500 };

const T = METRICS.ascender - METRICS.capHeight; // cap height line, 100
const B = METRICS.ascender; // baseline, 800
const S = 128; // vertical stem
const H = 108; // horizontal bar
const D = 142; // diagonal stem, measured across, a little heavier so it looks the same
const R = 176; // outer corner radius
const O = 6; // overshoot of rounds
const MID = Math.round((T + B) / 2) + 14; // optical middle: a little low, so the upper part does not look heavier

type Pt = [number, number];
type Seg = { to: Pt; c1?: Pt; c2?: Pt };
interface Sub { start: Pt; segs: Seg[] }

const K = 0.5523;
const n = (v: number) => Math.round(v * 10) / 10;

function area(sub: Sub): number {
  const pts = [sub.start, ...sub.segs.flatMap((s) => [...(s.c1 ? [s.c1, s.c2!] : []), s.to])];
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function reverse(sub: Sub): Sub {
  const pts: Pt[] = [sub.start, ...sub.segs.map((s) => s.to)];
  const segs: Seg[] = [];
  for (let i = sub.segs.length - 1; i >= 0; i--) {
    const s = sub.segs[i]!;
    const to = pts[i]!;
    segs.push(s.c1 ? { to, c1: s.c2!, c2: s.c1 } : { to });
  }
  return { start: sub.segs.length ? sub.segs.at(-1)!.to : sub.start, segs };
}

/** Clockwise on screen (y down): every solid part runs this way, so overlapping parts join. */
const solid = (sub: Sub): Sub => (area(sub) < 0 ? reverse(sub) : sub);

const poly = (...pts: Pt[]): Sub => solid({ start: pts[0]!, segs: pts.slice(1).map((to) => ({ to })) });
const rect = (x: number, y: number, w: number, h: number): Sub => poly([x, y], [x + w, y], [x + w, y + h], [x, y + h]);

/**
 * A quarter of a rounded corner, R across, with the stem and bar thicknesses on its two arms. `at` names the corner
 * of the box: tl, tr, bl, br. (x, y) is that outer corner of the box.
 */
function corner(at: 'tl' | 'tr' | 'bl' | 'br', x: number, y: number, r = R, sx = S, sy = H): Sub {
  const dx = at.endsWith('l') ? 1 : -1;
  const dy = at.startsWith('t') ? 1 : -1;
  const cx = x + dx * r;
  const cy = y + dy * r;
  const rx = r - sx;
  const ry = r - sy;
  // Outer arc from the vertical side to the horizontal side, then back along the inner arc.
  const a0: Pt = [x, cy];
  const a1: Pt = [cx, y];
  const i0: Pt = [cx, y + dy * sy];
  const i1: Pt = [x + dx * sx, cy];
  const sub: Sub = {
    start: a0,
    segs: [
      { c1: [x, cy - dy * r * K], c2: [cx - dx * r * K, y], to: a1 },
      { to: i0 },
      { c1: [cx - dx * rx * K, y + dy * sy], c2: [x + dx * sx, cy - dy * ry * K], to: i1 },
      { to: a0 },
    ],
  };
  return solid(sub);
}

function d(subs: Sub[]): string {
  return subs.map((s) => `M${n(s.start[0])} ${n(s.start[1])}${s.segs.map((g) => (g.c1 ? `C${n(g.c1[0])} ${n(g.c1[1])} ${n(g.c2![0])} ${n(g.c2![1])} ${n(g.to[0])} ${n(g.to[1])}` : `L${n(g.to[0])} ${n(g.to[1])}`)).join('')}Z`).join('');
}

/** A rounded box outline from x0 to x1, top to bottom, with corners where `round` says. */
function box(x0: number, x1: number, top: number, bottom: number, round: { tl?: boolean; tr?: boolean; bl?: boolean; br?: boolean }, r = R): Sub[] {
  const out: Sub[] = [];
  const tl = round.tl ? r : 0, tr = round.tr ? r : 0, bl = round.bl ? r : 0, br = round.br ? r : 0;
  if (round.tl) out.push(corner('tl', x0, top, r));
  if (round.tr) out.push(corner('tr', x1, top, r));
  if (round.bl) out.push(corner('bl', x0, bottom, r));
  if (round.br) out.push(corner('br', x1, bottom, r));
  out.push(rect(x0 + tl, top, x1 - x0 - tl - tr, H)); // top bar
  out.push(rect(x0 + bl, bottom - H, x1 - x0 - bl - br, H)); // bottom bar
  out.push(rect(x0, top + tl, S, bottom - top - tl - bl)); // left stem
  out.push(rect(x1 - S, top + tr, S, bottom - top - tr - br)); // right stem
  return out;
}

const SB = { straight: 72, round: 52, open: 24 };

interface Glyph { char: string; advance: number; d: string }

/** Places a body of width w between two side bearings. */
function glyph(char: string, left: keyof typeof SB, w: number, right: keyof typeof SB, draw: (x0: number, x1: number) => Sub[]): Glyph {
  const x0 = SB[left];
  return { char, advance: x0 + w + SB[right], d: d(draw(x0, x0 + w)) };
}

/** A diagonal stem of width D across, from (xa, ya) at its middle to (xb, yb). */
function diagonal(xa: number, ya: number, xb: number, yb: number, w = D): Sub {
  const h = w / 2;
  return poly([xa - h, ya], [xa + h, ya], [xb + h, yb], [xb - h, yb]);
}

const TO = T - O; // round top
const BO = B + O; // round bottom

export const GLYPHS: Glyph[] = [
  glyph('A', 'open', 560, 'open', (x0, x1) => {
    const c = (x0 + x1) / 2;
    return [diagonal(c - 30, T, x0 + D / 2, B), diagonal(c + 30, T, x1 - D / 2, B), rect(c - 100, T, 200, H), rect(x0 + 110, 540, x1 - x0 - 220, H)];
  }),
  glyph('B', 'straight', 468, 'round', (x0, x1) => [
    ...box(x0, x1 - 20, T, MID + H / 2, { tr: true, br: true }, 150),
    ...box(x0, x1, MID - H / 2, B, { tr: true, br: true }),
  ]),
  glyph('C', 'round', 470, 'straight', (x0, x1) => [
    corner('tl', x0, TO), corner('bl', x0, BO),
    rect(x0 + R, TO, x1 - x0 - R, H), rect(x0 + R, BO - H, x1 - x0 - R, H), rect(x0, TO + R, S, BO - TO - 2 * R),
  ]),
  glyph('D', 'straight', 500, 'round', (x0, x1) => box(x0, x1, T, B, { tr: true, br: true })),
  glyph('E', 'straight', 400, 'straight', (x0, x1) => [rect(x0, T, S, B - T), rect(x0, T, x1 - x0, H), rect(x0, MID - H / 2, x1 - x0 - 40, H), rect(x0, B - H, x1 - x0, H)]),
  glyph('F', 'straight', 390, 'open', (x0, x1) => [rect(x0, T, S, B - T), rect(x0, T, x1 - x0, H), rect(x0, MID - H / 2, x1 - x0 - 40, H)]),
  glyph('G', 'round', 492, 'straight', (x0, x1) => [
    corner('tl', x0, TO), corner('bl', x0, BO), corner('br', x1, BO),
    rect(x0 + R, TO, x1 - x0 - R, H), rect(x0 + R, BO - H, x1 - x0 - 2 * R, H), rect(x0, TO + R, S, BO - TO - 2 * R),
    rect(x1 - S, MID - H / 2, S, BO - R - MID + H / 2), rect(x1 - 210, MID - H / 2, 210, H),
  ]),
  glyph('H', 'straight', 476, 'straight', (x0, x1) => [rect(x0, T, S, B - T), rect(x1 - S, T, S, B - T), rect(x0, MID - H / 2, x1 - x0, H)]),
  glyph('I', 'straight', S, 'straight', (x0) => [rect(x0, T, S, B - T)]),
  glyph('J', 'open', 400, 'straight', (x0, x1) => [corner('bl', x0, BO), corner('br', x1, BO), rect(x0 + R, BO - H, x1 - x0 - 2 * R, H), rect(x1 - S, T, S, BO - R - T), rect(x0, 560, S, BO - R - 560)]),
  glyph('K', 'straight', 500, 'open', (x0, x1) => [rect(x0, T, S, B - T), diagonal(x1 - D / 2, T, x0 + S + 40, MID + 30), diagonal(x0 + S + 70, MID - 40, x1 - D / 2, B)]),
  glyph('L', 'straight', 390, 'open', (x0, x1) => [rect(x0, T, S, B - T), rect(x0, B - H, x1 - x0, H)]),
  glyph('M', 'straight', 640, 'straight', (x0, x1) => {
    const c = (x0 + x1) / 2;
    return [rect(x0, T, S, B - T), rect(x1 - S, T, S, B - T), diagonal(x0 + D / 2 + 10, T, c, 620, 128), diagonal(x1 - D / 2 - 10, T, c, 620, 128)];
  }),
  glyph('N', 'straight', 520, 'straight', (x0, x1) => [rect(x0, T, S, B - T), rect(x1 - S, T, S, B - T), diagonal(x0 + D / 2 + 6, T, x1 - D / 2 - 6, B, 132)]),
  glyph('O', 'round', 540, 'round', (x0, x1) => box(x0, x1, TO, BO, { tl: true, tr: true, bl: true, br: true })),
  glyph('P', 'straight', 468, 'round', (x0, x1) => [...box(x0, x1, T, MID + H / 2 + 20, { tr: true, br: true }), rect(x0, T, S, B - T)]),
  glyph('Q', 'round', 540, 'round', (x0, x1) => [...box(x0, x1, TO, BO, { tl: true, tr: true, bl: true, br: true }), diagonal(x1 - 160, 600, x1 - 10, BO + 70, 130)]),
  glyph('R', 'straight', 476, 'open', (x0, x1) => [...box(x0, x1 - 8, T, MID + H / 2, { tr: true, br: true }, 160), rect(x0, T, S, B - T), diagonal(x1 - 160, MID + 20, x1 - D / 2 + 4, B)]),
  glyph('S', 'round', 470, 'round', (x0, x1) => [
    corner('tl', x0, TO), corner('bl', x0, MID + H / 2, 150), corner('tr', x1, MID - H / 2, 150), corner('br', x1, BO),
    rect(x0 + R, TO, x1 - x0 - R, H), rect(x0, TO + R, S, MID + H / 2 - 150 - TO - R),
    rect(x0 + 150, MID - H / 2, x1 - x0 - 300, H),
    rect(x1 - S, MID - H / 2 + 150, S, BO - R - MID + H / 2 - 150), rect(x0, BO - H, x1 - x0 - R, H),
  ]),
  glyph('T', 'open', 480, 'open', (x0, x1) => [rect(x0, T, x1 - x0, H), rect((x0 + x1) / 2 - S / 2, T, S, B - T)]),
  glyph('U', 'straight', 500, 'straight', (x0, x1) => [...box(x0, x1, T - 1, BO, { bl: true, br: true }).filter((_, i) => i !== 2)]),
  glyph('V', 'open', 560, 'open', (x0, x1) => {
    const c = (x0 + x1) / 2;
    return [diagonal(x0 + D / 2, T, c - 28, B), diagonal(x1 - D / 2, T, c + 28, B), rect(c - 96, B - H, 192, H)];
  }),
  glyph('W', 'open', 800, 'open', (x0, x1) => {
    const a = x0 + (x1 - x0) * 0.27;
    const b = x1 - (x1 - x0) * 0.27;
    const c = (x0 + x1) / 2;
    return [diagonal(x0 + 68, T, a - 18, B, 132), diagonal(c - 6, 300, a + 18, B, 128), diagonal(c + 6, 300, b - 18, B, 128), diagonal(x1 - 68, T, b + 18, B, 132), rect(a - 80, B - H, 160, H), rect(b - 80, B - H, 160, H), rect(c - 82, 300, 164, 90)];
  }),
  glyph('X', 'open', 540, 'open', (x0, x1) => [diagonal(x0 + D / 2 + 4, T, x1 - D / 2 - 4, B), diagonal(x1 - D / 2 - 4, T, x0 + D / 2 + 4, B)]),
  glyph('Y', 'open', 540, 'open', (x0, x1) => {
    const c = (x0 + x1) / 2;
    return [diagonal(x0 + D / 2 + 4, T, c - 10, 470), diagonal(x1 - D / 2 - 4, T, c + 10, 470), rect(c - S / 2, 420, S, B - 420)];
  }),
  glyph('Z', 'open', 480, 'open', (x0, x1) => [rect(x0 + 14, T, x1 - x0 - 14, H), rect(x0, B - H, x1 - x0, H), diagonal(x1 - D / 2 - 6, T + H - 10, x0 + D / 2 + 6, B - H + 10, 150)]),
  // Figures: the width of a capital O less a little, all one advance so they line up in tables.
  ...[
    ['0', (x0: number, x1: number) => box(x0, x1, TO, BO, { tl: true, tr: true, bl: true, br: true }, 160)],
    ['1', (x0: number, x1: number) => [rect(x1 - S - 70, T, S, B - T), poly([x1 - S - 70, T], [x1 - 70, T], [x1 - S - 70, T + 200], [x0 + 30, T + 200], [x0 + 30, T + 110])]],
    ['2', (x0: number, x1: number) => [corner('tr', x1, TO, 160), rect(x0, TO, x1 - x0 - 160, H), rect(x1 - S, TO + 160, S, MID - TO - 160 + H / 2 - 150), corner('br', x1, MID + H / 2, 150), rect(x0 + 150, MID - H / 2, x1 - x0 - 300, H), corner('tl', x0, MID - H / 2, 150), rect(x0, MID - H / 2 + 150, S, B - MID + H / 2 - 150), rect(x0, B - H, x1 - x0, H)]],
    ['3', (x0: number, x1: number) => [...box(x0, x1, TO, BO, { tr: true, br: true }, 160).filter((_, i) => i !== 4), rect(x0 + 90, MID - H / 2, x1 - x0 - 90 - S / 2, H)]],
    ['4', (x0: number, x1: number) => [rect(x1 - S - 40, T, S, B - T), rect(x0, 560, x1 - x0, H), diagonal(x1 - S - 40 + 50, T, x0 + 70, 560 + 60, 136)]],
    ['5', (x0: number, x1: number) => [rect(x0, T, x1 - x0, H), rect(x0, T, S, MID - T + H / 2), rect(x0, MID - H / 2, x1 - x0 - 150, H), corner('tr', x1, MID - H / 2, 150), rect(x1 - S, MID - H / 2 + 150, S, BO - 160 - MID + H / 2 - 150), corner('br', x1, BO, 160), rect(x0, BO - H, x1 - x0 - 160, H)]],
    ['6', (x0: number, x1: number) => [corner('tl', x0, TO, 160), rect(x0 + 160, TO, x1 - x0 - 160, H), rect(x0, TO + 160, S, MID - TO - 160), ...box(x0, x1, MID - H / 2, BO, { tr: true, br: true, bl: true }, 150)]],
    ['7', (x0: number, x1: number) => [rect(x0, T, x1 - x0, H), diagonal(x1 - D / 2 - 6, T + H - 10, x0 + 110, B, 144)]],
    ['8', (x0: number, x1: number) => [...box(x0 + 14, x1 - 14, TO, MID + H / 2, { tl: true, tr: true, bl: true, br: true }, 140), ...box(x0, x1, MID - H / 2, BO, { tl: true, tr: true, bl: true, br: true }, 160)]],
    ['9', (x0: number, x1: number) => [...box(x0, x1, TO, MID + H / 2, { tl: true, tr: true, bl: true }, 150), rect(x1 - S, MID, S, BO - 160 - MID), corner('br', x1, BO, 160), rect(x0, BO - H, x1 - x0 - 160, H)]],
  ].map(([char, draw]) => glyph(char as string, 'round', 440, 'round', draw as (x0: number, x1: number) => Sub[])),
  glyph('.', 'straight', S, 'straight', (x0) => [rect(x0, B - S + 6, S, S - 6)]),
  glyph(',', 'straight', S, 'straight', (x0) => [rect(x0, B - S + 6, S, S - 6), poly([x0 + S - 40, B], [x0 + S, B], [x0 + 40, B + 150], [x0, B + 150])]),
  glyph(':', 'straight', S, 'straight', (x0) => [rect(x0, B - S + 6, S, S - 6), rect(x0, 360, S, S - 6)]),
  glyph(';', 'straight', S, 'straight', (x0) => [rect(x0, 360, S, S - 6), rect(x0, B - S + 6, S, S - 6), poly([x0 + S - 40, B], [x0 + S, B], [x0 + 40, B + 150], [x0, B + 150])]),
  glyph('!', 'straight', S, 'straight', (x0) => [rect(x0, T, S, 470), rect(x0, B - S + 6, S, S - 6)]),
  glyph('?', 'open', 420, 'round', (x0, x1) => [corner('tr', x1, TO, 160), rect(x0, TO, x1 - x0 - 160, H), rect(x1 - S, TO + 160, S, 140), corner('br', x1, 520, 150), rect(x0 + 140, 520 - H, x1 - x0 - 290, H), rect(x0 + 140, 520 - H, S, 110), rect(x0 + 140, B - S + 6, S, S - 6)]),
  glyph('-', 'open', 280, 'open', (x0, x1) => [rect(x0, MID + 20 - H / 2, x1 - x0, H)]),
  glyph("'", 'straight', S, 'straight', (x0) => [rect(x0, T, S, 230)]),
  glyph('"', 'straight', 2 * S + 80, 'straight', (x0) => [rect(x0, T, S, 230), rect(x0 + S + 80, T, S, 230)]),
  glyph('&', 'round', 560, 'open', (x0, x1) => [...box(x0 + 20, x1 - 160, TO, MID + H / 2, { tl: true, tr: true, bl: true }, 130), ...box(x0, x1 - 120, MID - H / 2, BO, { tl: true, bl: true, br: true }, 150), rect(x1 - 120 - S, MID + 40, S, 140), diagonal(x1 - 220, MID + 60, x1 - D / 2, B, 136)]),
  glyph(' ', 'open', 220, 'open', () => []),
];

/** Pairs to tighten: diagonals and open shapes against each other. Values in font units. */
export const KERNING: { left: string; right: string; value: number }[] = [
  { left: 'A', right: 'V', value: -60 }, { left: 'V', right: 'A', value: -60 },
  { left: 'A', right: 'T', value: -40 }, { left: 'T', right: 'A', value: -40 },
  { left: 'A', right: 'W', value: -40 }, { left: 'W', right: 'A', value: -40 },
  { left: 'A', right: 'Y', value: -50 }, { left: 'Y', right: 'A', value: -50 },
  { left: 'L', right: 'T', value: -50 }, { left: 'L', right: 'V', value: -50 }, { left: 'L', right: 'Y', value: -50 },
  { left: 'T', right: '.', value: -60 }, { left: 'T', right: ',', value: -60 }, { left: 'F', right: '.', value: -50 },
  { left: 'P', right: '.', value: -40 }, { left: 'V', right: '.', value: -60 }, { left: 'Y', right: '.', value: -60 },
];
