import type { BogenDoc, BogenNode } from './doc.ts';
import { camelCss, kebabCss, parseStyle, splitCssList } from './css.ts';
import { keyframesName } from './html-import.ts';
import { cleanRuleStyle, parseBlock } from './layer-rules.ts';

/**
 * CSS animations as data, and motion as code. The motion panel edits what is stored, which stays plain
 * CSS: `@keyframes` blocks in the file and `animation` and `transition` in a layer's style. For handoff
 * the same motion comes out as clean CSS, with the animations on a class per layer and only for people who
 * have not asked for reduced motion, or as Framer Motion props for the React export.
 */

export interface KeyStop { offset: number; css: string }
export interface Keyframes { name: string; stops: KeyStop[] }

const pct = (t: string): number | null => {
  const v = t.trim().toLowerCase();
  if (v === 'from') return 0;
  if (v === 'to') return 100;
  return v.endsWith('%') ? parseFloat(v) : null;
};

/** One `@keyframes` block, or null when it is not one. A stop written for several offsets becomes several. */
export function parseKeyframes(text: string): Keyframes | null {
  const m = /^\s*@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{([\s\S]*)\}\s*$/.exec(text);
  if (!m) return null;
  const stops: KeyStop[] = [];
  const body = m[2]!;
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const close = body.indexOf('}', open);
    if (close < 0) break;
    const css = body.slice(open + 1, close).trim().replace(/;\s*$/, '');
    for (const part of body.slice(i, open).split(',')) {
      const offset = pct(part);
      if (offset !== null && !Number.isNaN(offset)) stops.push({ offset, css });
    }
    i = close + 1;
  }
  stops.sort((a, b) => a.offset - b.offset);
  return { name: m[1]!, stops };
}

export function printKeyframes(k: Keyframes): string {
  const stops = [...k.stops].sort((a, b) => a.offset - b.offset).map((s) => `${Math.round(s.offset * 100) / 100}%{${s.css.replace(/[{}]/g, '')}}`).join('');
  return `@keyframes ${k.name}{${stops}}`;
}

export interface AnimationSpec { name: string; duration: number; delay: number; easing: string; iterations: number | 'infinite'; direction: string; fill: string }

export const DEFAULT_ANIMATION: Omit<AnimationSpec, 'name'> = { duration: 600, delay: 0, easing: 'ease', iterations: 1, direction: 'normal', fill: 'both' };

const EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\))$/;
const DIRECTION = /^(normal|reverse|alternate|alternate-reverse)$/;
const FILL = /^(none|forwards|backwards|both)$/;
const PLAY = /^(running|paused)$/;

function ms(v: string): number | null {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(v.trim());
  if (!m) return null;
  return parseFloat(m[1]!) * (m[2] === 's' ? 1000 : 1);
}

/** The animations of a style, from the shorthand or the longhands. */
export function parseAnimations(style: Record<string, string>): AnimationSpec[] {
  if (style.animationName && style.animationName !== 'none') {
    const names = splitCssList(style.animationName);
    const list = (v: string | undefined, fallback: string) => (v ? splitCssList(v) : [fallback]);
    const durations = list(style.animationDuration, '0s');
    const delays = list(style.animationDelay, '0s');
    const easings = list(style.animationTimingFunction, 'ease');
    const counts = list(style.animationIterationCount, '1');
    const directions = list(style.animationDirection, 'normal');
    const fills = list(style.animationFillMode, 'none');
    return names.map((name, i) => ({
      name: name.trim(),
      duration: ms(durations[i % durations.length]!) ?? 0,
      delay: ms(delays[i % delays.length]!) ?? 0,
      easing: easings[i % easings.length]!.trim(),
      iterations: counts[i % counts.length]!.trim() === 'infinite' ? 'infinite' : parseFloat(counts[i % counts.length]!) || 1,
      direction: directions[i % directions.length]!.trim(),
      fill: fills[i % fills.length]!.trim(),
    }));
  }
  if (!style.animation || style.animation === 'none') return [];
  return splitCssList(style.animation).map((part) => {
    const spec: AnimationSpec = { name: '', duration: 0, delay: 0, easing: 'ease', iterations: 1, direction: 'normal', fill: 'none' };
    let timeCount = 0;
    for (const token of splitCssList(part, ' ')) {
      const t = token.trim();
      const time = ms(t);
      if (time !== null) {
        if (timeCount++ === 0) spec.duration = time;
        else spec.delay = time;
      } else if (EASING.test(t)) spec.easing = t;
      else if (DIRECTION.test(t)) spec.direction = t;
      else if (FILL.test(t) && t !== 'none') spec.fill = t;
      else if (t === 'infinite') spec.iterations = 'infinite';
      else if (/^[\d.]+$/.test(t)) spec.iterations = parseFloat(t);
      else if (!PLAY.test(t)) spec.name = t;
    }
    return spec;
  }).filter((s) => s.name);
}

const seconds = (v: number) => `${Math.round(v) / 1000}s`;

/** What to write: one longhand per thing, and no shorthand left that could fight them. */
export function printAnimations(list: AnimationSpec[]): Record<string, string | null> {
  const clear: Record<string, string | null> = { animation: null, animationName: null, animationDuration: null, animationDelay: null, animationTimingFunction: null, animationIterationCount: null, animationDirection: null, animationFillMode: null, animationPlayState: null };
  if (!list.length) return clear;
  return {
    ...clear,
    animationName: list.map((a) => a.name).join(', '),
    animationDuration: list.map((a) => seconds(a.duration)).join(', '),
    animationDelay: list.some((a) => a.delay) ? list.map((a) => seconds(a.delay)).join(', ') : null,
    animationTimingFunction: list.map((a) => a.easing).join(', '),
    animationIterationCount: list.map((a) => String(a.iterations)).join(', '),
    animationDirection: list.some((a) => a.direction !== 'normal') ? list.map((a) => a.direction).join(', ') : null,
    animationFillMode: list.map((a) => a.fill).join(', '),
  };
}

/** When an animation ends on its timeline; endless ones count for one pass. */
export function animationEnd(a: Pick<AnimationSpec, 'delay' | 'duration' | 'iterations'>): number {
  return a.delay + a.duration * (a.iterations === 'infinite' ? 1 : a.iterations);
}

export interface TransitionSpec { property: string; duration: number; delay: number; easing: string }

/** The transitions of a style, from the shorthand or the longhands. */
export function parseTransitions(style: Record<string, string>): TransitionSpec[] {
  if (style.transitionProperty || style.transitionDuration) {
    const props = splitCssList(style.transitionProperty ?? 'all');
    const list = (v: string | undefined, fallback: string) => (v ? splitCssList(v) : [fallback]);
    const durations = list(style.transitionDuration, '0s');
    const delays = list(style.transitionDelay, '0s');
    const easings = list(style.transitionTimingFunction, 'ease');
    return props.map((property, i) => ({ property: property.trim(), duration: ms(durations[i % durations.length]!) ?? 0, delay: ms(delays[i % delays.length]!) ?? 0, easing: easings[i % easings.length]!.trim() })).filter((t) => t.property !== 'none');
  }
  if (!style.transition || style.transition === 'none') return [];
  return splitCssList(style.transition).map((part) => {
    const spec: TransitionSpec = { property: 'all', duration: 0, delay: 0, easing: 'ease' };
    let timeCount = 0;
    for (const t of splitCssList(part, ' ')) {
      const time = ms(t);
      if (time !== null) {
        if (timeCount++ === 0) spec.duration = time;
        else spec.delay = time;
      } else if (EASING.test(t)) spec.easing = t;
      else if (/^[a-z-]+$/.test(t)) spec.property = t;
    }
    return spec;
  }).filter((t) => t.property !== 'none');
}

const ANIMATION_PROPS = ['animation', 'animationName', 'animationDuration', 'animationDelay', 'animationTimingFunction', 'animationIterationCount', 'animationDirection', 'animationFillMode', 'animationPlayState'];
const TRANSITION_PROPS = ['transition', 'transitionProperty', 'transitionDuration', 'transitionDelay', 'transitionTimingFunction', 'transitionBehavior'];

/** The keyframes stored in a file, by name. Only well-formed blocks: they go into style elements. */
export function fileKeyframes(doc: BogenDoc): Map<string, Keyframes> {
  const out = new Map<string, Keyframes>();
  const kf = doc.meta.get('keyframes');
  if (!Array.isArray(kf)) return out;
  for (const text of kf) {
    if (typeof text !== 'string' || keyframesName(text) === null) continue;
    const parsed = parseKeyframes(text);
    if (parsed) out.set(parsed.name, parsed);
  }
  return out;
}

function hasMotion(n: BogenNode): boolean {
  return parseAnimations(n.style).length > 0 || parseTransitions(n.style).length > 0;
}

/** Layers under these roots that move, in tree order. */
export function movingLayers(doc: BogenDoc, rootIds: string[]): BogenNode[] {
  const out: BogenNode[] = [];
  const visit = (n: BogenNode) => {
    if (n.hidden) return;
    if (hasMotion(n)) out.push(n);
    for (const c of doc.getChildren(n.id)) visit(c);
  };
  for (const id of rootIds) {
    const n = doc.getNode(id);
    if (n) visit(n);
  }
  return out;
}

export type MotionMode = 'inline' | 'css' | 'framer';

/** What motion handoff changes on one layer. */
export interface MotionLayer {
  /** Class that carries its motion in `css` mode. */
  className?: string;
  /** Style properties that leave the inline style. */
  strip: string[];
  /** For Framer Motion: the element becomes `motion.<tag>` with these props. */
  framer?: string[];
  /** Rule blocks that Framer Motion now says, such as `:hover`. */
  dropBlocks?: string[];
}

export interface MotionHandoff {
  mode: MotionMode;
  layers: Map<string, MotionLayer>;
  /** `css`: the keyframes and the rules. `framer`: nothing, or the keyframes it could not say. */
  css: string;
  notes: string[];
}

function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layer';
}

function prettyKeyframes(k: Keyframes): string {
  const stops = k.stops.map((s) => {
    const decls = Object.entries(cleanRuleStyle(parseStyle(s.css))).map(([p, v]) => `    ${kebabCss(p)}: ${v};`).join('\n');
    return `  ${Math.round(s.offset * 100) / 100}% {\n${decls}\n  }`;
  }).join('\n');
  return `@keyframes ${k.name} {\n${stops}\n}`;
}

function animationShorthand(a: AnimationSpec): string {
  const parts = [a.name, `${Math.round(a.duration)}ms`, a.easing];
  if (a.delay) parts.push(`${Math.round(a.delay)}ms`);
  if (a.iterations !== 1) parts.push(String(a.iterations));
  if (a.direction !== 'normal') parts.push(a.direction);
  if (a.fill !== 'none') parts.push(a.fill);
  return parts.join(' ');
}

function transitionShorthand(t: TransitionSpec): string {
  return [t.property, `${Math.round(t.duration)}ms`, t.easing, ...(t.delay ? [`${Math.round(t.delay)}ms`] : [])].join(' ');
}

/**
 * Motion of these roots as clean CSS: the `@keyframes` they use, then `animation` and `transition` on a
 * class per moving layer, inside `prefers-reduced-motion: no-preference` so that a person who asked for
 * less motion gets the layers at rest. The layers lose those properties from their inline style.
 */
export function motionCss(doc: BogenDoc, rootIds: string[]): MotionHandoff {
  const frames = fileKeyframes(doc);
  const layers = new Map<string, MotionLayer>();
  const used = new Set<string>();
  const taken = new Set<string>();
  const rules: string[] = [];
  const notes: string[] = [];
  for (const n of movingLayers(doc, rootIds)) {
    let name = `motion-${slug(n.name)}`;
    for (let i = 2; taken.has(name); i++) name = `motion-${slug(n.name)}-${i}`;
    taken.add(name);
    const anims = parseAnimations(n.style);
    const transitions = parseTransitions(n.style);
    for (const a of anims) {
      if (frames.has(a.name)) used.add(a.name);
      else notes.push(`${n.name} uses an animation called ${a.name} that this file has no keyframes for.`);
    }
    const decls = [
      ...(anims.length ? [`animation: ${anims.map(animationShorthand).join(', ')};`] : []),
      ...(transitions.length ? [`transition: ${transitions.map(transitionShorthand).join(', ')};`] : []),
    ];
    rules.push(`  .${name} {\n${decls.map((d) => `    ${d}`).join('\n')}\n  }`);
    layers.set(n.id, { className: name, strip: [...ANIMATION_PROPS, ...TRANSITION_PROPS].filter((p) => n.style[p] !== undefined) });
  }
  if (!rules.length) return { mode: 'css', layers, css: '', notes };
  const keyframes = [...used].map((k) => prettyKeyframes(frames.get(k)!));
  const css = [...keyframes, `@media (prefers-reduced-motion: no-preference) {\n${rules.join('\n')}\n}`].join('\n\n');
  return { mode: 'css', layers, css, notes };
}

// Framer Motion

type FramerValue = number | string;

function num(v: string): number | null {
  const t = v.trim();
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : null;
}

function px(v: string): FramerValue {
  const t = v.trim();
  const m = /^(-?\d*\.?\d+)px$/.exec(t);
  if (m) return Number(m[1]);
  return num(t) ?? t;
}

function deg(v: string): FramerValue {
  const t = v.trim();
  const d = /^(-?\d*\.?\d+)deg$/.exec(t);
  if (d) return Number(d[1]);
  const turn = /^(-?\d*\.?\d+)turn$/.exec(t);
  if (turn) return Number(turn[1]) * 360;
  return num(t) ?? t;
}

/** One stop's declarations as Framer Motion values: transforms become x, y, scale and rotate. */
export function framerValues(style: Record<string, string>): Record<string, FramerValue> {
  const out: Record<string, FramerValue> = {};
  for (const [prop, value] of Object.entries(style)) {
    if (prop === 'translate') {
      const [x, y] = splitCssList(value, ' ');
      if (x !== undefined) out.x = px(x);
      if (y !== undefined) out.y = px(y);
    } else if (prop === 'scale') {
      const [x, y] = splitCssList(value, ' ');
      if (y === undefined) out.scale = num(x ?? '1') ?? x ?? 1;
      else { out.scaleX = num(x!) ?? x!; out.scaleY = num(y) ?? y; }
    } else if (prop === 'rotate') out.rotate = deg(value);
    else if (prop === 'transform') {
      const fns = [...value.matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)];
      const known: Record<string, string> = { translateX: 'x', translateY: 'y', scale: 'scale', scaleX: 'scaleX', scaleY: 'scaleY', rotate: 'rotate', rotateZ: 'rotate', skewX: 'skewX', skewY: 'skewY' };
      if (!fns.length || fns.some((f) => !known[f[1]!] && f[1] !== 'translate')) {
        out.transform = value;
        continue;
      }
      for (const f of fns) {
        const args = splitCssList(f[2]!, ',');
        if (f[1] === 'translate') {
          out.x = px(args[0] ?? '0');
          if (args[1] !== undefined) out.y = px(args[1]);
        } else {
          const key = known[f[1]!]!;
          out[key] = key.startsWith('rotate') || key.startsWith('skew') ? deg(args[0] ?? '0') : key.startsWith('scale') ? num(args[0] ?? '1') ?? args[0]! : px(args[0] ?? '0');
        }
      }
    } else out[camelCss(prop)] = num(value) ?? value;
  }
  return out;
}

const EASE_NAMES: Record<string, string | number[]> = { linear: 'linear', ease: [0.25, 0.1, 0.25, 1], 'ease-in': 'easeIn', 'ease-out': 'easeOut', 'ease-in-out': 'easeInOut' };

function framerEase(easing: string): string | number[] | null {
  const named = EASE_NAMES[easing];
  if (named) return named;
  const bezier = /^cubic-bezier\(\s*([^)]+)\)$/.exec(easing);
  if (bezier) {
    const parts = bezier[1]!.split(',').map((p) => Number(p.trim()));
    if (parts.length === 4 && parts.every(Number.isFinite)) return parts;
  }
  return null;
}

function literal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(literal).join(', ')}]`;
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : v > 0 ? 'Infinity' : '-Infinity';
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}

interface FramerAnimation { animate: Record<string, FramerValue[]>; initial?: Record<string, FramerValue>; transition: Record<string, unknown>; notes: string[] }

/** One CSS animation as Framer Motion keyframes and a transition. */
export function framerAnimation(a: AnimationSpec, frames: Keyframes): FramerAnimation {
  const notes: string[] = [];
  const stops = frames.stops.map((s) => ({ offset: s.offset / 100, values: framerValues(cleanRuleStyle(parseStyle(s.css))) }));
  const keys = [...new Set(stops.flatMap((s) => Object.keys(s.values)))];
  const reversed = a.direction === 'reverse' || a.direction === 'alternate-reverse';
  const ordered = reversed ? [...stops].reverse().map((s) => ({ ...s, offset: 1 - s.offset })) : stops;
  const animate: Record<string, FramerValue[]> = {};
  for (const key of keys) {
    // Framer wants a value at every stop; a stop that leaves one out holds the one before it.
    let last: FramerValue | undefined = ordered.find((s) => s.values[key] !== undefined)?.values[key];
    animate[key] = ordered.map((s) => (last = s.values[key] ?? last) as FramerValue);
  }
  const times = ordered.map((s) => s.offset);
  const transition: Record<string, unknown> = { duration: a.duration / 1000 };
  if (a.delay) transition.delay = a.delay / 1000;
  const ease = framerEase(a.easing);
  if (ease) transition.ease = ease;
  else notes.push(`${a.easing} has no Framer Motion easing; it runs linear.`);
  if (times.length > 2 || times[0] !== 0 || times.at(-1) !== 1) transition.times = times;
  if (a.iterations === 'infinite') transition.repeat = Infinity;
  else if (a.iterations > 1) transition.repeat = a.iterations - 1;
  if (transition.repeat !== undefined && a.direction.startsWith('alternate')) transition.repeatType = 'reverse';
  const initial = a.fill === 'both' || a.fill === 'backwards' ? Object.fromEntries(Object.entries(animate).map(([k, v]) => [k, v[0]!])) : undefined;
  if (a.fill === 'none' && a.iterations !== 'infinite') notes.push(`${frames.name} ends where it stops in Framer Motion; in CSS its fill is none and it went back.`);
  return { animate, ...(initial ? { initial } : {}), transition, notes };
}

/**
 * Motion of these roots as Framer Motion props, for the React export: each moving layer becomes a
 * `motion.<tag>` with `initial`, `animate` and `transition`, and a `:hover` block with a transition becomes
 * `whileHover`. Reduced motion is left to `<MotionConfig reducedMotion="user">` around the component.
 */
export function motionFramer(doc: BogenDoc, rootIds: string[]): MotionHandoff {
  const frames = fileKeyframes(doc);
  const layers = new Map<string, MotionLayer>();
  const notes: string[] = [];
  for (const n of movingLayers(doc, rootIds)) {
    const anims = parseAnimations(n.style).filter((a) => {
      if (frames.has(a.name)) return true;
      notes.push(`${n.name} uses an animation called ${a.name} that this file has no keyframes for.`);
      return false;
    });
    const transitions = parseTransitions(n.style);
    const props: string[] = [];
    const strip: string[] = [];
    if (anims.length) {
      const parts = anims.map((a) => ({ a, f: framerAnimation(a, frames.get(a.name)!) }));
      for (const p of parts) notes.push(...p.f.notes.map((t) => `${n.name}: ${t}`));
      const animate = Object.assign({}, ...parts.map((p) => p.f.animate)) as Record<string, FramerValue[]>;
      const initial = Object.assign({}, ...parts.map((p) => p.f.initial ?? {})) as Record<string, FramerValue>;
      // Several animations each time their own values.
      const transition = parts.length === 1 ? parts[0]!.f.transition : Object.fromEntries(parts.flatMap((p) => Object.keys(p.f.animate).map((k) => [k, p.f.transition])));
      if (Object.keys(initial).length) props.push(`initial={${literal(initial)}}`);
      props.push(`animate={${literal(animate)}}`, `transition={${literal(transition)}}`);
      strip.push(...ANIMATION_PROPS.filter((p) => n.style[p] !== undefined));
    }
    const dropBlocks: string[] = [];
    const hoverKey = Object.keys(n.rules ?? {}).find((k) => parseBlock(k)?.key === ':hover');
    if (transitions.length && hoverKey) {
      const hover = framerValues(cleanRuleStyle(n.rules![hoverKey]!));
      const t = transitions[0]!;
      const ease = framerEase(t.easing);
      props.push(`whileHover={${literal(hover)}}`);
      if (!anims.length) props.push(`transition={${literal({ duration: t.duration / 1000, ...(t.delay ? { delay: t.delay / 1000 } : {}), ...(ease ? { ease } : {}) })}}`);
      dropBlocks.push(hoverKey);
      strip.push(...TRANSITION_PROPS.filter((p) => n.style[p] !== undefined));
    }
    if (props.length) layers.set(n.id, { strip, framer: props, ...(dropBlocks.length ? { dropBlocks } : {}) });
  }
  return { mode: 'framer', layers, css: '', notes };
}

export function motionHandoff(doc: BogenDoc, rootIds: string[], mode: MotionMode): MotionHandoff {
  if (mode === 'css') return motionCss(doc, rootIds);
  if (mode === 'framer') return motionFramer(doc, rootIds);
  return { mode, layers: new Map(), css: '', notes: [] };
}

export const FRAMER_IMPORT = "import { motion, MotionConfig } from 'framer-motion';";

/** Wraps a component's markup in `MotionConfig`, so that Framer Motion honours reduced motion. */
export function withMotionConfig(jsx: string, depth: number): string {
  const pad = '  '.repeat(depth);
  return `${pad}<MotionConfig reducedMotion="user">\n${jsx.replace(/^/gm, '  ')}\n${pad}</MotionConfig>`;
}
