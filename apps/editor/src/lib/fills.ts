import { formatHex8, interpolate } from 'culori';
import { fmt, splitTopLevel } from './css-values.ts';

/**
 * Fills are stored the way CSS wants them: the bottom solid in `backgroundColor`, everything else as
 * layers of `backgroundImage`, first in the list painted on top. A solid above other layers is a
 * flat `linear-gradient(c, c)`.
 */
export interface GradientStop { color: string; at: number }
export type Fill =
  | { kind: 'solid'; color: string }
  | { kind: 'linear'; angle: number; stops: GradientStop[] }
  | { kind: 'radial'; shape: string; stops: GradientStop[] }
  | { kind: 'conic'; angle: number; stops: GradientStop[] }
  | { kind: 'image'; url: string; size: string; position: string; repeat: string };

export const DEFAULT_STOPS: GradientStop[] = [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 100 }];

function parseStops(parts: string[]): GradientStop[] {
  const stops: { color: string; at: number | null }[] = parts.map((p) => {
    const tokens = splitTopLevel(p, ' ');
    const last = tokens.at(-1);
    if (tokens.length > 1 && last && /%$/.test(last)) return { color: tokens.slice(0, -1).join(' '), at: parseFloat(last) };
    return { color: tokens.join(' '), at: null };
  });
  if (stops.length && stops[0]!.at === null) stops[0]!.at = 0;
  if (stops.length && stops.at(-1)!.at === null) stops.at(-1)!.at = 100;
  // Evenly place the stops that have no position, as CSS does.
  let i = 0;
  while (i < stops.length) {
    if (stops[i]!.at !== null) { i++; continue; }
    let j = i;
    while (stops[j]!.at === null) j++;
    const a = stops[i - 1]!.at!;
    const b = stops[j]!.at!;
    for (let k = i; k < j; k++) stops[k]!.at = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return stops.map((s) => ({ color: s.color, at: s.at! }));
}

function angleOf(arg: string): number | null {
  const m = /^(-?[\d.]+)(deg|turn|rad|grad)?$/.exec(arg.trim());
  if (m) {
    const n = parseFloat(m[1]!);
    if (m[2] === 'turn') return n * 360;
    if (m[2] === 'rad') return (n * 180) / Math.PI;
    if (m[2] === 'grad') return n * 0.9;
    return n;
  }
  const TO: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 };
  return TO[arg.trim()] ?? null;
}

export function parseFillLayer(layer: string, size = 'auto', position = '0% 0%', repeat = 'repeat'): Fill | null {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/.exec(layer.trim());
  if (m) {
    const args = splitTopLevel(m[3]!);
    if (m[2] === 'linear') {
      const first = angleOf(args[0] ?? '');
      const stops = parseStops(first === null ? args : args.slice(1));
      if (stops.length === 2 && stops[0]!.color === stops[1]!.color) return { kind: 'solid', color: stops[0]!.color };
      return { kind: 'linear', angle: first ?? 180, stops };
    }
    if (m[2] === 'radial') {
      const hasShape = /^(circle|ellipse|closest|farthest|at\b)/.test(args[0] ?? '');
      return { kind: 'radial', shape: hasShape ? args[0]! : 'circle', stops: parseStops(hasShape ? args.slice(1) : args) };
    }
    const from = /^from\s+(\S+)/.exec(args[0] ?? '');
    return { kind: 'conic', angle: from ? (angleOf(from[1]!) ?? 0) : 0, stops: parseStops(from ? args.slice(1) : args) };
  }
  const url = /^url\((["']?)(.*)\1\)$/.exec(layer.trim());
  if (url) return { kind: 'image', url: url[2]!, size, position, repeat };
  return null;
}

/** All fills of a style, top layer first. */
export function parseFills(style: Record<string, string>): Fill[] {
  const out: Fill[] = [];
  const image = style.backgroundImage;
  if (image && image !== 'none') {
    const sizes = splitTopLevel(style.backgroundSize ?? 'auto');
    const positions = splitTopLevel(style.backgroundPosition ?? '0% 0%');
    const repeats = splitTopLevel(style.backgroundRepeat ?? 'repeat');
    splitTopLevel(image).forEach((layer, i) => {
      const f = parseFillLayer(layer, sizes[i % sizes.length], positions[i % positions.length], repeats[i % repeats.length]);
      if (f) out.push(f);
    });
  }
  const color = style.backgroundColor ?? (style.background && !/gradient|url\(/.test(style.background) ? style.background : undefined);
  if (color && color !== 'transparent') out.push({ kind: 'solid', color });
  return out;
}

export function printStops(stops: GradientStop[]): string {
  return [...stops].sort((a, b) => a.at - b.at).map((s) => `${s.color} ${fmt(s.at)}%`).join(', ');
}

export function printFillLayer(f: Exclude<Fill, { kind: 'image' }> | Fill): string {
  switch (f.kind) {
    case 'solid': return `linear-gradient(${f.color}, ${f.color})`;
    case 'linear': return `linear-gradient(${fmt(f.angle)}deg, ${printStops(f.stops)})`;
    case 'radial': return `radial-gradient(${f.shape}, ${printStops(f.stops)})`;
    case 'conic': return `conic-gradient(from ${fmt(f.angle)}deg, ${printStops(f.stops)})`;
    case 'image': return `url("${f.url}")`;
  }
}

/** The style patch for a list of fills. Removes what is no longer used. */
export function printFills(fills: Fill[]): Record<string, string | null> {
  const patch: Record<string, string | null> = { background: null, backgroundColor: null, backgroundImage: null, backgroundSize: null, backgroundPosition: null, backgroundRepeat: null };
  const layers = [...fills];
  const last = layers.at(-1);
  if (last?.kind === 'solid') {
    patch.backgroundColor = last.color;
    layers.pop();
  }
  if (layers.length) {
    patch.backgroundImage = layers.map(printFillLayer).join(', ');
    if (layers.some((l) => l.kind === 'image')) {
      const per = (fn: (f: Extract<Fill, { kind: 'image' }>) => string, other: string) => layers.map((l) => (l.kind === 'image' ? fn(l) : other)).join(', ');
      patch.backgroundSize = per((l) => l.size, 'auto');
      patch.backgroundPosition = per((l) => l.position, '0% 0%');
      patch.backgroundRepeat = per((l) => l.repeat, 'repeat');
    }
  }
  return patch;
}

export function fillPreview(f: Fill): string {
  if (f.kind === 'solid') return f.color;
  if (f.kind === 'image') return `center / cover url("${f.url.replace(/^bogen-asset:/, '/assets/')}")`;
  return printFillLayer(f);
}

/** A new stop that does not change the look: the colour the gradient already has at that point. */
export function interpolatedStop(stops: GradientStop[], at: number): GradientStop {
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  const next = sorted.find((s) => s.at >= at);
  const prev = [...sorted].reverse().find((s) => s.at <= at);
  if (!next || !prev || next === prev) return { color: (next ?? prev ?? sorted.at(-1)!).color, at };
  try {
    const parsed = interpolate([prev.color, next.color], 'rgb')((at - prev.at) / (next.at - prev.at));
    const hex = formatHex8(parsed);
    return { color: hex ? hex.replace(/ff$/, '') : next.color, at };
  } catch {
    // Tokens and the like have no colour to mix until the browser resolves them.
    return { color: next.color, at };
  }
}
