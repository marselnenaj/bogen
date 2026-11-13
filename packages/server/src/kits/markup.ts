import { hasIcon, iconSvg } from '@bogen/core/icons';
import type { Variant } from './types.ts';

/**
 * Small helpers that write a kit's components as HTML with inline styles, which importHtml turns into layers.
 * `data-name` names a layer, so that props can find it and variants keep overrides by name; `data-slot` marks
 * a slot. Undefined style values are left out, so a component can say `border: outline ? ... : undefined`.
 */
export type Css = Record<string, string | number | undefined>;

const UNITLESS = new Set(['opacity', 'fontWeight', 'lineHeight', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order']);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function styleAttr(css: Css): string {
  return Object.entries(css)
    .filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v}`)
    .join('; ');
}

function attrsHtml(attrs: Record<string, string>): string {
  return Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
}

/** An element with children, which are HTML strings already. */
export function el(tag: string, css: Css, children: string | string[] = [], attrs: Record<string, string> = {}): string {
  const style = styleAttr(css);
  const inner = Array.isArray(children) ? children.join('') : children;
  return `<${tag}${style ? ` style="${escapeHtml(style)}"` : ''}${attrsHtml(attrs)}>${inner}</${tag}>`;
}

/** A text element, named so that a text prop can drive it. */
export function text(tag: string, css: Css, content: string, name: string, attrs: Record<string, string> = {}): string {
  return el(tag, css, escapeHtml(content), { 'data-name': name, ...attrs });
}

/** Lucide names (ISC, the set Bogen ships) for the icons kits draw. */
export const ICONS = {
  check: 'check', chevronDown: 'chevron-down', chevronLeft: 'chevron-left', chevronRight: 'chevron-right', chevronsUpDown: 'chevrons-up-down',
  x: 'x', settings: 'settings', search: 'search', home: 'house', heart: 'heart', user: 'user', plus: 'plus', minus: 'minus', menu: 'menu',
  bell: 'bell', arrowLeft: 'arrow-left', star: 'star', info: 'info', alert: 'circle-alert', calendar: 'calendar', mail: 'mail', more: 'ellipsis-vertical',
  edit: 'pencil', share: 'share-2', circleCheck: 'circle-check', triangleAlert: 'triangle-alert',
} as const;

/** An icon as an svg layer in the text colour. */
export function icon(name: string, size: number, layerName = 'Icon', strokeWidth = 2): string {
  // A name that is not in the set would draw nothing, unseen: say so while the kit is written.
  if (!hasIcon(name)) throw new Error(`Kit error: there is no Lucide icon "${name}".`);
  const svg = iconSvg(name, { strokeWidth }).replace('width="100%" height="100%"', `width="${size}" height="${size}"`);
  return svg.replace('<svg', `<svg data-name="${escapeHtml(layerName)}" style="flex-shrink: 0"`);
}

/** Every combination of the axes, the first values first. */
export function combinations(axes: Record<string, string[]>): Variant[] {
  let out: Variant[] = [{}];
  for (const [axis, values] of Object.entries(axes)) out = out.flatMap((v) => values.map((value) => ({ ...v, [axis]: value })));
  return out;
}

/**
 * One member per value of each axis, the other axes at their first value: what a showcase of a wide set needs
 * without the product of all of them, such as 11 looks and 3 sizes as 13 members rather than 33.
 */
export function eachAxis(axes: Record<string, string[]>): Variant[] {
  const base = Object.fromEntries(Object.entries(axes).map(([k, v]) => [k, v[0]!]));
  const out: Variant[] = [base];
  for (const [axis, values] of Object.entries(axes)) for (const value of values.slice(1)) out.push({ ...base, [axis]: value });
  return out;
}
