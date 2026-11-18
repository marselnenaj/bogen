/// <reference path="./opentype.d.ts" />
import type * as opentype from 'opentype.js';
import type { Rgba } from './image-raster.ts';

/**
 * Fields for pattern layers that need more than arithmetic: the darkness of an image and the shape of a text, each
 * sampled into one value per cell. The pattern stores the field, so it redraws without the image or the font.
 */

/** Darkness (1 - luminance) of an image per cell, the image cropped to the grid's shape about its centre. */
export function imageField(img: Rgba, columns: number, rows: number): Float32Array {
  const out = new Float32Array(columns * rows);
  const want = columns / rows;
  const have = img.width / img.height;
  // Cover: crop the longer side.
  const cw = have > want ? img.height * want : img.width;
  const ch = have > want ? img.height : img.width / want;
  const ox = (img.width - cw) / 2;
  const oy = (img.height - ch) / 2;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      // Average the pixels under the cell, a few samples per cell for small images.
      const x0 = ox + (x / columns) * cw;
      const x1 = ox + ((x + 1) / columns) * cw;
      const y0 = oy + (y / rows) * ch;
      const y1 = oy + ((y + 1) / rows) * ch;
      let sum = 0;
      let n = 0;
      const sx = Math.max(1, Math.round(x1 - x0));
      const sy = Math.max(1, Math.round(y1 - y0));
      for (let j = 0; j < Math.min(sy, 4); j++) {
        for (let i = 0; i < Math.min(sx, 4); i++) {
          const px = Math.min(img.width - 1, Math.floor(x0 + ((i + 0.5) / Math.min(sx, 4)) * (x1 - x0)));
          const py = Math.min(img.height - 1, Math.floor(y0 + ((j + 0.5) / Math.min(sy, 4)) * (y1 - y0)));
          const k = (py * img.width + px) * 4;
          const a = img.data[k + 3]! / 255;
          // Transparent reads as paper.
          const l = (0.2126 * img.data[k]! + 0.7152 * img.data[k + 1]! + 0.0722 * img.data[k + 2]!) / 255;
          sum += 1 - (l * a + (1 - a));
          n++;
        }
      }
      out[y * columns + x] = n ? sum / n : 0;
    }
  }
  return out;
}

type Point = [number, number];

/** Path commands to closed polygons, curves flattened into short segments. */
function polygons(commands: opentype.PathCommand[]): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  let last: Point = [0, 0];
  const steps = 8;
  for (const c of commands) {
    if (c.type === 'M') {
      if (cur.length > 2) out.push(cur);
      cur = [[c.x, c.y]];
      last = [c.x, c.y];
    } else if (c.type === 'L') {
      cur.push([c.x, c.y]);
      last = [c.x, c.y];
    } else if (c.type === 'Q') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        cur.push([u * u * last[0] + 2 * u * t * c.x1 + t * t * c.x, u * u * last[1] + 2 * u * t * c.y1 + t * t * c.y]);
      }
      last = [c.x, c.y];
    } else if (c.type === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        cur.push([
          u * u * u * last[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * last[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        ]);
      }
      last = [c.x, c.y];
    } else if (c.type === 'Z') {
      if (cur.length > 2) out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 2) out.push(cur);
  return out;
}

/** Nonzero winding, as fonts are filled. */
function inside(polys: Point[][], x: number, y: number): boolean {
  let winding = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) winding++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) winding--;
    }
  }
  return winding !== 0;
}

/**
 * A text as a mask over the grid: 1 where the letters are, soft at their edges (3 x 3 samples per cell). The text is
 * set in the font on one line per line break, centred, and scaled to fill `fill` of the grid's width or height.
 */
export function textField(font: opentype.Font, text: string, columns: number, rows: number, options: { fill?: number; letterSpacing?: number } = {}): Float32Array {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const size = 100;
  const lineHeight = ((font.ascender - Math.min(0, font.descender)) / font.unitsPerEm) * size;
  const opts = { kerning: true, letterSpacing: options.letterSpacing ?? 0 };
  const widths = lines.map((l) => font.getAdvanceWidth(l, size, opts));
  const commands: opentype.PathCommand[] = [];
  let box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const maxW = Math.max(...widths);
  lines.forEach((l, i) => {
    const path = font.getPath(l, (maxW - widths[i]!) / 2, (i + 1) * lineHeight, size, opts);
    commands.push(...path.commands);
    const b = path.getBoundingBox();
    if (Number.isFinite(b.x1) && b.x2 > b.x1) box = { x1: Math.min(box.x1, b.x1), y1: Math.min(box.y1, b.y1), x2: Math.max(box.x2, b.x2), y2: Math.max(box.y2, b.y2) };
  });
  const out = new Float32Array(columns * rows);
  if (!Number.isFinite(box.x1)) return out;
  const polys = polygons(commands);
  const fill = options.fill ?? 0.86;
  const bw = box.x2 - box.x1;
  const bh = box.y2 - box.y1;
  const scale = Math.min((columns * fill) / bw, (rows * fill) / bh);
  const offX = (columns - bw * scale) / 2;
  const offY = (rows - bh * scale) / 2;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      let hits = 0;
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const gx = x + (i + 0.5) / 3;
          const gy = y + (j + 0.5) / 3;
          if (inside(polys, (gx - offX) / scale + box.x1, (gy - offY) / scale + box.y1)) hits++;
        }
      }
      out[y * columns + x] = hits / 9;
    }
  }
  return out;
}
