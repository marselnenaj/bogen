import { splitTopLevel } from './css-values.ts';
import { msg } from '../i18n/core.ts';

/** CSS animations as data, for the motion panel. What is stored stays plain CSS. Pure. */
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
    const names = splitTopLevel(style.animationName);
    const list = (v: string | undefined, fallback: string) => (v ? splitTopLevel(v) : [fallback]);
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
  return splitTopLevel(style.animation).map((part) => {
    const spec: AnimationSpec = { name: '', duration: 0, delay: 0, easing: 'ease', iterations: 1, direction: 'normal', fill: 'none' };
    let timeCount = 0;
    for (const token of splitTopLevel(part, ' ')) {
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

export interface MotionPreset { name: string; keyframes: Keyframes; spec: Partial<AnimationSpec> }

export const MOTION_PRESETS: MotionPreset[] = [
  { name: msg('Fade in'), keyframes: { name: 'fade-in', stops: [{ offset: 0, css: 'opacity:0' }, { offset: 100, css: 'opacity:1' }] }, spec: {} },
  { name: msg('Slide up'), keyframes: { name: 'slide-up', stops: [{ offset: 0, css: 'opacity:0;translate:0 16px' }, { offset: 100, css: 'opacity:1;translate:0 0' }] }, spec: { easing: 'cubic-bezier(.2,.8,.2,1)' } },
  { name: msg('Scale in'), keyframes: { name: 'scale-in', stops: [{ offset: 0, css: 'opacity:0;scale:.92' }, { offset: 100, css: 'opacity:1;scale:1' }] }, spec: { easing: 'cubic-bezier(.2,.8,.2,1)' } },
  { name: msg('Pulse'), keyframes: { name: 'pulse', stops: [{ offset: 0, css: 'scale:1' }, { offset: 50, css: 'scale:1.06' }, { offset: 100, css: 'scale:1' }] }, spec: { duration: 1200, iterations: 'infinite', easing: 'ease-in-out', fill: 'none' } },
  { name: msg('Spin'), keyframes: { name: 'spin', stops: [{ offset: 0, css: 'rotate:0deg' }, { offset: 100, css: 'rotate:360deg' }] }, spec: { duration: 1000, iterations: 'infinite', easing: 'linear', fill: 'none' } },
];

/** When an animation ends on its timeline; endless ones count for one pass. */
export function animationEnd(a: Pick<AnimationSpec, 'delay' | 'duration' | 'iterations'>): number {
  return a.delay + a.duration * (a.iterations === 'infinite' ? 1 : a.iterations);
}
