/**
 * Constraints of a child in a freeform frame, written as plain CSS so that they keep working in an
 * export: what the layer is pinned to is simply which of left, right, width are set, and to what. Pure.
 */
export type HConstraint = 'left' | 'right' | 'both' | 'center' | 'scale';
export type VConstraint = 'top' | 'bottom' | 'both' | 'center' | 'scale';

type Style = Record<string, string | undefined>;
type Patch = Record<string, string | null>;

const num = (n: number) => String(Math.round(n * 100) / 100);
const pxv = (n: number) => `${num(n)}px`;
const pct = (n: number, of: number) => `${num(of ? (n / of) * 100 : 0)}%`;

function detect(start: string | undefined, end: string | undefined): 'start' | 'end' | 'both' | 'center' | 'scale' {
  const hasStart = Boolean(start) && start !== 'auto';
  const hasEnd = Boolean(end) && end !== 'auto';
  if (hasStart && hasEnd) return 'both';
  if (hasEnd) return 'end';
  if (hasStart && /^calc\(50%/.test(start!)) return 'center';
  if (hasStart && start!.endsWith('%')) return 'scale';
  return 'start';
}

export function detectH(style: Style): HConstraint {
  const d = detect(style.left, style.right);
  return d === 'start' ? 'left' : d === 'end' ? 'right' : d;
}

export function detectV(style: Style): VConstraint {
  const d = detect(style.top, style.bottom);
  return d === 'start' ? 'top' : d === 'end' ? 'bottom' : d;
}

function axis(kind: 'start' | 'end' | 'both' | 'center' | 'scale', at: number, size: number, parent: number, keys: [string, string, string]): Patch {
  const [start, end, length] = keys;
  switch (kind) {
    case 'start': return { [start]: pxv(at), [end]: null, [length]: pxv(size) };
    case 'end': return { [start]: null, [end]: pxv(parent - at - size), [length]: pxv(size) };
    case 'both': return { [start]: pxv(at), [end]: pxv(parent - at - size), [length]: null };
    case 'center': return { [start]: `calc(50% + ${num(at - parent / 2)}px)`, [end]: null, [length]: pxv(size) };
    case 'scale': return { [start]: pct(at, parent), [end]: null, [length]: pct(size, parent) };
  }
}

export function patchH(kind: HConstraint, x: number, w: number, parentW: number): Patch {
  return axis(kind === 'left' ? 'start' : kind === 'right' ? 'end' : kind, x, w, parentW, ['left', 'right', 'width']);
}

export function patchV(kind: VConstraint, y: number, h: number, parentH: number): Patch {
  return axis(kind === 'top' ? 'start' : kind === 'bottom' ? 'end' : kind, y, h, parentH, ['top', 'bottom', 'height']);
}

/** Whether a move or resize has to write more than left and top to keep the constraints as they are. */
export function isConstrained(style: Style): boolean {
  return detectH(style) !== 'left' || detectV(style) !== 'top';
}

/** A layer's position at new coordinates, in the terms of its own constraints. */
export function positionPatch(style: Style, x: number, y: number, w: number, h: number, parentW: number, parentH: number): Patch {
  const hk = detectH(style);
  const vk = detectV(style);
  const out: Patch = {};
  if (hk === 'left') { out.left = pxv(x); out.right = null; } else Object.assign(out, patchH(hk, x, w, parentW));
  if (vk === 'top') { out.top = pxv(y); out.bottom = null; } else Object.assign(out, patchV(vk, y, h, parentH));
  return out;
}
