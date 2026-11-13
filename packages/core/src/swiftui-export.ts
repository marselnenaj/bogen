import { converter, interpolate, parse, type Color as CuloriColor } from 'culori';
import { slotsOf } from './components.ts';
import { parseStyle } from './css.ts';
import type { BogenDoc, BogenNode, ComponentProp, PropValue, Token } from './doc.ts';
import { fileKeyframes, framerValues, parseAnimations, parseTransitions } from './motion.ts';
import { componentInfosFor, componentMainsFor, propDefaultFor, type CodeComponentInfo } from './react-export.ts';
import { repeatPlan } from './repeat.ts';
import { renderSpec, type AssetResolver } from './render.ts';
import type { CodeFile } from './sfc-export.ts';

/**
 * Hands a layer to SwiftUI: one View struct per component with its props as stored properties and its variant axes
 * as enums, instances as initialisers, flex layout as VStack and HStack with their spacing and alignment, absolute
 * children in a ZStack, and the box model as modifiers in CSS's order (padding, frame, background, border, clip,
 * shadow). Tokens become `Tokens` with each colour in light and dark, so the system's appearance switches them.
 * Motion is a keyframe animation of opacity, offset, scale and rotation from its first stop to its last, and none
 * when the person asks the system to reduce motion. What SwiftUI cannot say this way is listed in the notes.
 *
 * Written for iOS 17 and macOS 14. It cannot be compiled where there is no SwiftUI, such as Linux: the tests check
 * the syntax with swiftc -parse where swiftc is, and snapshot the rest.
 */
export interface SwiftUIExport {
  files: CodeFile[];
  entry: string;
  notes: string[];
  /** Icons and drawings as SVG, for the asset catalog: Xcode takes SVG as a template image. */
  assets: { name: string; svg: string }[];
}

const SWIFT_KEYWORDS = new Set(['associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'super', 'self', 'Self', 'throw', 'throws', 'true', 'try', 'Type', 'Protocol']);
/** SwiftUI's own names, which a nested enum would hide inside its view: an axis named so takes Option after it. */
const SWIFTUI_TYPES = new Set(['Color', 'State', 'Style', 'Font', 'Image', 'Text', 'Shape', 'Label', 'Edge', 'Alignment', 'Animation', 'Binding', 'Environment', 'Path', 'Gradient', 'Toggle', 'Button', 'Group', 'Section', 'Menu', 'Link', 'Picker', 'List', 'Form', 'Divider', 'Spacer', 'Axis', 'Layout', 'Material', 'Angle', 'Anchor', 'Capsule', 'Circle', 'Rectangle', 'View', 'Tokens']);
const toRgb = converter('rgb');

function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function typeName(name: string): string {
  const out = words(name).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  return /^[A-Z]/.test(out) ? out : `Layer${out}`;
}

function ident(name: string): string {
  const parts = words(name);
  let out = parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p.toLowerCase())).join('');
  if (!out) out = 'value';
  if (/^\d/.test(out)) out = `v${out}`;
  return SWIFT_KEYWORDS.has(out) ? `\`${out}\`` : out;
}

/** A prop's property name: `body` is the view's own, and an axis may have the prop's name, so those take Text after it. */
function propIdent(name: string, info?: CodeComponentInfo): string {
  const out = ident(name);
  return out === 'body' || info?.axes.some((a) => ident(a.axis) === out) ? `${out.replace(/`/g, '')}Text` : out;
}

function enumName(axis: string): string {
  const out = typeName(axis);
  return SWIFTUI_TYPES.has(out) ? `${out}Option` : out;
}

/** An axis of false and true, such as checked, which is a Bool rather than an enum. */
function isBoolAxis(values: string[]): boolean {
  return values.length === 2 && values.includes('true') && values.includes('false');
}

/** An axis value in Swift: `.outline`, or a Bool. */
function axisValue(values: string[] | undefined, value: string): string {
  return values && isBoolAxis(values) ? value : `.${ident(value)}`;
}

function str(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '').replace(/\t/g, '\\t')}"`;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

interface Bound { name: string; fallback?: string; type: ComponentProp['type'] }

interface Ctx {
  doc: BogenDoc;
  resolve: AssetResolver | undefined;
  infos: Map<string, CodeComponentInfo>;
  names: Map<string, string>;
  tokens: Map<string, Token>;
  usedTokens: Set<string>;
  notes: Set<string>;
  assets: Map<string, string>;
  bound: Map<string, Bound>;
  slots: Map<string, string>;
  /** `@State` flags of the struct being written, one per moving layer. */
  states: string[];
  keyframes: ReturnType<typeof fileKeyframes>;
  /** The font size around a layer, for em values. */
  fontSize: number;
}

/** A token's value in a mode, through the tokens it refers to. */
function tokenValue(ctx: Ctx, name: string, mode: 'light' | 'dark', seen: string[] = []): string | undefined {
  const t = ctx.tokens.get(name);
  if (!t || seen.includes(name)) return undefined;
  const raw = mode === 'dark' ? t.modes?.dark ?? t.value : t.value;
  return raw.replace(/var\(--([\w-]+)(?:,\s*([^)]*))?\)/g, (_, n: string, fb?: string) => tokenValue(ctx, n, mode, [...seen, name]) ?? fb ?? 'transparent');
}

/** A CSS colour as a colour, mixing `color-mix()` itself; undefined for one it cannot read. */
function cssColor(value: string): CuloriColor | undefined {
  const v = value.trim();
  if (v === 'transparent') return { mode: 'rgb', r: 0, g: 0, b: 0, alpha: 0 };
  const mix = /^color-mix\(\s*in\s+(\w+)\s*,\s*(.+)\)$/.exec(v);
  if (mix) {
    const parts = splitTop(mix[2]!);
    const read = (p: string) => {
      const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(p.trim())!;
      return { color: cssColor(m[1]!), pct: m[2] !== undefined ? Number(m[2]) / 100 : undefined };
    };
    const [a, b] = [read(parts[0] ?? ''), read(parts[1] ?? 'transparent')];
    if (!a.color || !b.color) return undefined;
    const pa = a.pct ?? (b.pct !== undefined ? 1 - b.pct : 0.5);
    const space = (['oklab', 'oklch', 'srgb', 'lab', 'lch', 'hsl'].includes(mix[1]!) ? mix[1]!.replace('srgb', 'rgb') : 'oklab') as 'oklab';
    return interpolate([a.color, b.color], space)(1 - pa);
  }
  return parse(v) ?? undefined;
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function swiftColor(c: CuloriColor): string {
  const rgb = toRgb(c);
  const ch = (x: number | undefined) => Math.round(Math.min(1, Math.max(0, x ?? 0)) * 255);
  const hex = `0x${[rgb.r, rgb.g, rgb.b].map((x) => ch(x).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const alpha = rgb.alpha ?? 1;
  return alpha < 1 ? `Color(hex: ${hex}, opacity: ${num(alpha)})` : `Color(hex: ${hex})`;
}

/** A colour value as Swift: a token by name, or a literal with its dark value where tokens make it differ. */
function color(ctx: Ctx, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (v === 'currentColor' || v === 'inherit' || v === 'initial' || v === 'unset') return undefined;
  const token = /^var\(--([\w-]+)\)$/.exec(v);
  if (token && ctx.tokens.get(token[1]!)?.kind === 'color') {
    ctx.usedTokens.add(token[1]!);
    return `Tokens.${ident(token[1]!)}`;
  }
  const resolve = (mode: 'light' | 'dark') => cssColor(v.replace(/var\(--([\w-]+)(?:,\s*([^)]*))?\)/g, (_, n: string, fb?: string) => tokenValue(ctx, n, mode) ?? fb ?? 'transparent'));
  const light = resolve('light');
  if (!light) {
    ctx.notes.add(`The colour ${v.slice(0, 80)} has no SwiftUI equivalent here and is left out.`);
    return undefined;
  }
  const dark = resolve('dark');
  const l = swiftColor(light);
  const d = dark ? swiftColor(dark) : l;
  if (l === d && (toRgb(light).alpha ?? 1) === 0) return 'Color.clear';
  return l === d ? l : `Color(light: ${l}, dark: ${d})`;
}

/** A length in points, or undefined for one that is not a fixed length. */
function length(ctx: Ctx, value: string | undefined): number | undefined {
  if (!value) return undefined;
  let v = value.trim();
  const token = /^var\(--([\w-]+)(?:,\s*([^)]*))?\)$/.exec(v);
  if (token) v = tokenValue(ctx, token[1]!, 'light') ?? token[2] ?? '';
  const m = /^(-?\d*\.?\d+)(px|rem|em|pt)?$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === 'rem') return n * 16;
  if (m[2] === 'em') return n * ctx.fontSize;
  if (m[2] === 'pt') return n * (4 / 3);
  return n;
}

/** `padding: 8px 16px` and its longhands as top, right, bottom and left. */
function box(ctx: Ctx, style: Record<string, string>, prop: 'padding' | 'margin'): [number, number, number, number] {
  const parts = (style[prop] ?? '').trim().split(/\s+(?![^(]*\))/).filter(Boolean).map((p) => length(ctx, p) ?? 0);
  const [t = 0, r = t, b = t, l = r] = parts;
  const side = (s: string, d: number) => length(ctx, style[`${prop}${s}`]) ?? d;
  const inline = style[`${prop}Inline`] !== undefined ? length(ctx, style[`${prop}Inline`]) : undefined;
  const block = style[`${prop}Block`] !== undefined ? length(ctx, style[`${prop}Block`]) : undefined;
  return [side('Top', block ?? t), side('Right', inline ?? r), side('Bottom', block ?? b), side('Left', inline ?? l)];
}

function paddingModifier(p: [number, number, number, number]): string | undefined {
  const [t, r, b, l] = p;
  if (!t && !r && !b && !l) return undefined;
  if (t === r && r === b && b === l) return `.padding(${num(t)})`;
  if (t === b && r === l) return [r ? `.padding(.horizontal, ${num(r)})` : '', t ? `.padding(.vertical, ${num(t)})` : ''].filter(Boolean).join('\n');
  return `.padding(EdgeInsets(top: ${num(t)}, leading: ${num(l)}, bottom: ${num(b)}, trailing: ${num(r)}))`;
}

const WEIGHTS: Record<string, string> = { 100: '.ultraLight', 200: '.thin', 300: '.light', 400: '.regular', normal: '.regular', 500: '.medium', 600: '.semibold', 700: '.bold', bold: '.bold', 800: '.heavy', 900: '.black' };
const GENERIC = /^(system-ui|ui-sans-serif|sans-serif|serif|ui-serif|monospace|ui-monospace|-apple-system|BlinkMacSystemFont|inherit|initial)$/i;

/** The text modifiers a layer sets, which SwiftUI passes down to the texts in it as CSS inherits them. */
function textModifiers(ctx: Ctx, style: Record<string, string>, isText: boolean): string[] {
  const out: string[] = [];
  const size = length(ctx, style.fontSize);
  const weight = style.fontWeight ? WEIGHTS[style.fontWeight] : undefined;
  let family = style.fontFamily;
  const token = family && /^var\(--([\w-]+)\)$/.exec(family.trim());
  if (token) family = tokenValue(ctx, token[1]!, 'light');
  const first = family?.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
  const custom = first && !GENERIC.test(first) ? first : undefined;
  if (custom && size) out.push(`.font(.custom(${str(custom)}, size: ${num(size)}))`);
  else if (size) out.push(`.font(.system(size: ${num(size)}))`);
  if (weight) out.push(`.fontWeight(${weight})`);
  if (style.fontStyle === 'italic') out.push('.italic()');
  const fg = color(ctx, style.color);
  if (fg) out.push(`.foregroundStyle(${fg})`);
  if (isText) {
    const lh = style.lineHeight;
    const lineSize = lh && /^\d*\.?\d+$/.test(lh) ? Number(lh) * (size ?? ctx.fontSize) : length(ctx, lh);
    if (lineSize && lineSize > (size ?? ctx.fontSize)) out.push(`.lineSpacing(${num(lineSize - (size ?? ctx.fontSize))})`);
    const tracking = length({ ...ctx, fontSize: size ?? ctx.fontSize }, style.letterSpacing);
    if (tracking) out.push(`.tracking(${num(tracking)})`);
    if (style.textAlign === 'center') out.push('.multilineTextAlignment(.center)');
    else if (style.textAlign === 'right' || style.textAlign === 'end') out.push('.multilineTextAlignment(.trailing)');
    if (/underline/.test(style.textDecoration ?? style.textDecorationLine ?? '')) out.push('.underline()');
    if (/line-through/.test(style.textDecoration ?? style.textDecorationLine ?? '')) out.push('.strikethrough()');
    if (style.textTransform === 'uppercase') out.push('.textCase(.uppercase)');
    if (style.textTransform === 'lowercase') out.push('.textCase(.lowercase)');
    if (style.whiteSpace === 'nowrap') out.push('.lineLimit(1)');
  }
  return out;
}

/** The shape a layer's corners make: a capsule for a pill, a rounded rectangle, or none. */
function shapeOf(ctx: Ctx, style: Record<string, string>): string | undefined {
  const raw = style.borderRadius?.trim();
  if (!raw) return undefined;
  if (raw === '50%') return 'Circle()';
  const parts = raw.split(/\s+/);
  if (parts.length > 1) {
    const [tl = 0, tr = tl, br = tl, bl = tr] = parts.map((p) => length(ctx, p) ?? 0);
    return `UnevenRoundedRectangle(topLeadingRadius: ${num(tl)}, bottomLeadingRadius: ${num(bl)}, bottomTrailingRadius: ${num(br)}, topTrailingRadius: ${num(tr)}, style: .continuous)`;
  }
  const r = length(ctx, raw);
  if (r === undefined) return undefined;
  if (r <= 0) return undefined;
  if (r >= 999) return 'Capsule()';
  const token = /^var\(--([\w-]+)\)$/.exec(raw);
  if (token && ctx.tokens.has(token[1]!)) {
    ctx.usedTokens.add(token[1]!);
    return `RoundedRectangle(cornerRadius: Tokens.${ident(token[1]!)}, style: .continuous)`;
  }
  return `RoundedRectangle(cornerRadius: ${num(r)}, style: .continuous)`;
}

/** `1px solid #ccc` as its width and colour. */
function border(ctx: Ctx, value: string | undefined): { width: number; color: string; dashed: boolean } | undefined {
  if (!value || /^(none|0|0px)$/.test(value.trim())) return undefined;
  const parts = value.trim().split(/\s+(?![^(]*\))/);
  const width = parts.map((p) => length(ctx, p)).find((n) => n !== undefined) ?? 1;
  const c = parts.find((p) => !/^(-?\d*\.?\d+(px|rem|em)?|solid|dashed|dotted|double|none)$/.test(p));
  const swift = color(ctx, c ?? 'currentColor');
  if (!width || !swift || swift === 'Color.clear') return undefined;
  return { width, color: swift, dashed: /dashed|dotted/.test(value) };
}

function shadow(ctx: Ctx, value: string | undefined): string | undefined {
  if (!value || value === 'none') return undefined;
  const first = splitTop(value).find((s) => !/\binset\b/.test(s));
  if (!first) return undefined;
  const parts = first.trim().split(/\s+(?![^(]*\))/);
  const lengths = parts.map((p) => length(ctx, p)).filter((n): n is number => n !== undefined);
  const c = parts.find((p) => length(ctx, p) === undefined);
  const swift = color(ctx, c ?? 'rgb(0 0 0 / 0.2)');
  if (splitTop(value).length > 1) ctx.notes.add('A box-shadow of several shadows keeps its first outer one: SwiftUI\'s shadow modifier draws one at a time.');
  const [x = 0, y = 0, blur = 0] = lengths;
  return swift ? `.shadow(color: ${swift}, radius: ${num(blur / 2)}, x: ${num(x)}, y: ${num(y)})` : undefined;
}

interface Motion { state: string; from: Record<string, number>; to: Record<string, number>; animation: string }

/** A layer's first keyframe animation as SwiftUI can play it: opacity, offset, scale and rotation, first stop to last. */
function motionOf(ctx: Ctx, node: BogenNode): Motion | undefined {
  const anims = parseAnimations(node.style);
  if (parseTransitions(node.style).length) ctx.notes.add(`${node.name}: CSS transitions run when a state changes, which SwiftUI says with .animation(_:value:) on that state. They are left out.`);
  if (!anims.length) return undefined;
  const a = anims[0]!;
  const frames = ctx.keyframes.get(a.name);
  if (!frames || frames.stops.length < 2) return undefined;
  if (anims.length > 1 || frames.stops.length > 2) ctx.notes.add(`${node.name}: its animation plays from the first keyframe to the last; SwiftUI keyframes for the stops between are not written.`);
  const values = (css: string) => {
    const v = framerValues(parseStyle(css));
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && ['opacity', 'x', 'y', 'scale', 'rotate'].includes(k)) out[k] = x;
    return out;
  };
  const from = values(frames.stops[0]!.css);
  const to = values(frames.stops.at(-1)!.css);
  if (!Object.keys(from).length && !Object.keys(to).length) {
    ctx.notes.add(`${node.name}: its animation changes properties SwiftUI cannot animate this way; it is left out.`);
    return undefined;
  }
  const easing = a.easing === 'linear' ? '.linear' : a.easing === 'ease-in' ? '.easeIn' : a.easing === 'ease-out' ? '.easeOut' : '.easeInOut';
  const repeat = a.iterations === 'infinite' ? `.repeatForever(autoreverses: ${/alternate/.test(a.direction)})` : a.iterations > 1 ? `.repeatCount(${a.iterations}, autoreverses: ${/alternate/.test(a.direction)})` : '';
  const state = `animate${ctx.states.length + 1}`;
  ctx.states.push(state);
  return { state, from, to, animation: `Animation${easing}(duration: ${num(a.duration / 1000)})${a.delay ? `.delay(${num(a.delay / 1000)})` : ''}${repeat}` };
}

function motionModifiers(m: Motion): string[] {
  const out: string[] = [];
  const pick = (k: string, base: number) => `${m.state} ? ${num(m.to[k] ?? base)} : ${num(m.from[k] ?? base)}`;
  if ('opacity' in m.from || 'opacity' in m.to) out.push(`.opacity(${pick('opacity', 1)})`);
  if ('scale' in m.from || 'scale' in m.to) out.push(`.scaleEffect(${pick('scale', 1)})`);
  if ('rotate' in m.from || 'rotate' in m.to) out.push(`.rotationEffect(.degrees(${pick('rotate', 0)}))`);
  if (['x', 'y'].some((k) => k in m.from || k in m.to)) out.push(`.offset(x: ${pick('x', 0)}, y: ${pick('y', 0)})`);
  // Reduced motion: the layer rests where its animation ends, with no movement.
  out.push(`.onAppear {\n  if reduceMotion { ${m.state} = true } else { withAnimation(${m.animation}) { ${m.state} = true } }\n}`);
  return out;
}

function indent(text: string, by: number): string {
  const pad = '    '.repeat(by);
  return text.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

/** A view and its modifiers, each modifier on its own line under it. */
function withModifiers(view: string, modifiers: string[]): string {
  const mods = modifiers.filter(Boolean).flatMap((m) => m.split('\n'));
  return mods.length ? `${view}\n${indent(mods.join('\n'), 1)}` : view;
}

function isAbsolute(n: BogenNode): boolean {
  return n.style.position === 'absolute' || n.style.position === 'fixed';
}

/** One layer as a SwiftUI view. */
function view(ctx: Ctx, id: string, root: boolean, resolved = false): string {
  const { doc } = ctx;
  const node = resolved ? doc.getNode(id) : doc.rawNode(id);
  if (!node || node.hidden) return '';
  if (!resolved && node.instanceOf !== undefined) return usage(ctx, node);
  if (node.code) {
    ctx.notes.add(`${node.name} is a React component of the linked code project: SwiftUI has a comment where it goes.`);
    return `// ${node.name}: a React component of the linked project`;
  }
  const key = root ? '' : id;
  const bind = (field: string) => (resolved ? undefined : ctx.bound.get(`${key}#${field}`));
  const style = node.style;
  const size = length(ctx, style.fontSize) ?? ctx.fontSize;
  const inner: Ctx = { ...ctx, fontSize: size };
  const spec = renderSpec(node, ctx.resolve);
  let base: string;
  const textBound = bind('text');
  if (node.type === 'text') {
    const t = textBound ? `Text(${textBound.fallback !== undefined ? `${textBound.name} ?? ${textBound.fallback}` : textBound.name})` : `Text(${str(node.text ?? '')})`;
    if (node.spans?.length) ctx.notes.add(`${node.name}: its ranges of other styles are one style in SwiftUI; use AttributedString for them.`);
    base = node.tag === 'button' ? `Button(action: {}) {\n${indent(t, 1)}\n}\n.buttonStyle(.plain)` : t;
  } else if (node.type === 'image') {
    const src = bind('src');
    const url = src ? `URL(string: ${src.fallback !== undefined ? `${src.name} ?? ${src.fallback}` : src.name})` : spec.attrs.src ? `URL(string: ${str(spec.attrs.src)})` : 'nil';
    const fit = style.objectFit === 'contain' ? '.scaledToFit()' : '.scaledToFill()';
    base = `AsyncImage(url: ${url}) { image in\n    image.resizable()${fit}\n} placeholder: {\n    Color.gray.opacity(0.15)\n}`;
    if (spec.attrs.alt) base += `\n.accessibilityLabel(${str(spec.attrs.alt)})`;
  } else if (node.type === 'svg') {
    // One asset per drawing: the same name for another drawing, such as two layers called Icon, takes a number.
    const stem = (node.name || 'icon').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'icon';
    const svg = node.svg ?? '';
    let name = stem;
    for (let i = 2; ctx.assets.has(name) && ctx.assets.get(name) !== svg; i++) name = `${stem}-${i}`;
    ctx.assets.set(name, svg);
    base = `Image(${str(name)})\n    .resizable()\n    .renderingMode(.template)\n    .scaledToFit()`;
  } else if (node.type === 'video' || node.type === 'embed' || node.type === 'shader') {
    ctx.notes.add(`${node.name}: a ${node.type} layer has no SwiftUI view here; a grey box keeps its place.`);
    base = 'Color.gray.opacity(0.15)';
  } else if (spec.tag === 'input' || spec.tag === 'textarea') {
    const placeholder = node.attrs?.placeholder ?? '';
    base = spec.tag === 'textarea' ? 'TextEditor(text: .constant(""))' : `TextField(${str(placeholder)}, text: .constant(""))`;
  } else if (spec.tag === 'hr') base = 'Divider()';
  else base = container(inner, node, resolved, root);
  const mods: string[] = [];
  if (node.type !== 'text' && node.type !== 'image' && node.type !== 'svg') mods.push(...textModifiers(inner, style, false));
  else mods.push(...textModifiers(inner, style, node.type === 'text'));
  mods.push(paddingModifier(box(ctx, style, 'padding')) ?? '');
  // Frame: fixed sizes, and stretching where flex or 100% asks for it.
  const w = length(ctx, style.width);
  const h = length(ctx, style.height);
  const fill = style.width === '100%' || /^1(\s|$)/.test(style.flex ?? '') || style.flexGrow === '1' || style.alignSelf === 'stretch';
  const frame: string[] = [];
  if (w !== undefined) frame.push(`width: ${num(w)}`);
  if (h !== undefined) frame.push(`height: ${num(h)}`);
  if (frame.length) mods.push(`.frame(${frame.join(', ')})`);
  const minW = length(ctx, style.minWidth);
  const minH = length(ctx, style.minHeight);
  const maxW = length(ctx, style.maxWidth);
  const range: string[] = [];
  if (minW !== undefined) range.push(`minWidth: ${num(minW)}`);
  if (fill && w === undefined) range.push(`maxWidth: ${maxW !== undefined ? num(maxW) : '.infinity'}`);
  else if (maxW !== undefined) range.push(`maxWidth: ${num(maxW)}`);
  if (minH !== undefined) range.push(`minHeight: ${num(minH)}`);
  if (range.length) mods.push(`.frame(${range.join(', ')}, alignment: .leading)`);
  const shape = shapeOf(ctx, style);
  const bg = color(ctx, style.backgroundColor ?? (style.background && !/gradient|url\(/.test(style.background) ? style.background : undefined));
  if (style.background && /gradient/.test(style.background)) ctx.notes.add(`${node.name}: its gradient background is left out; write it as a LinearGradient.`);
  if (/url\(/.test(style.backgroundImage ?? style.background ?? '')) ctx.notes.add(`${node.name}: its background image is left out; put an Image behind it with .background.`);
  if (bg) mods.push(shape ? `.background(${bg}, in: ${shape})` : `.background(${bg})`);
  const full = border(ctx, style.border);
  if (full) mods.push(`.overlay {\n    ${shape ?? 'Rectangle()'}\n        .stroke(${full.color}, ${full.dashed ? `style: StrokeStyle(lineWidth: ${num(full.width)}, dash: [4])` : `lineWidth: ${num(full.width)}`})\n}`);
  for (const [side, edge, dim] of [['borderTop', 'top', 'height'], ['borderBottom', 'bottom', 'height'], ['borderLeft', 'leading', 'width'], ['borderRight', 'trailing', 'width']] as const) {
    const b = border(ctx, style[side]);
    if (b) mods.push(`.overlay(alignment: .${edge}) {\n    Rectangle().fill(${b.color}).frame(${dim}: ${num(b.width)})\n}`);
  }
  if (shape && (style.overflow === 'hidden' || style.overflow === 'clip' || node.type === 'image')) mods.push(`.clipShape(${shape})`);
  else if (node.type === 'image' && (w !== undefined || h !== undefined)) mods.push('.clipped()');
  mods.push(shadow(ctx, style.boxShadow) ?? '');
  if (style.opacity && Number(style.opacity) < 1) mods.push(`.opacity(${num(Number(style.opacity))})`);
  const motion = motionOf(ctx, node);
  if (motion) mods.push(...motionModifiers(motion));
  if (isAbsolute(node) && !root) mods.push(`.offset(x: ${num(length(ctx, style.left) ?? 0)}, y: ${num(length(ctx, style.top) ?? 0)})`);
  mods.push(paddingModifier(box(ctx, style, 'margin')) ?? '');
  if (node.mode === 'dark') mods.push('.environment(\\.colorScheme, .dark)');
  if (node.attrs?.['aria-label']) mods.push(`.accessibilityLabel(${str(node.attrs['aria-label'])})`);
  if (style.cursor === 'pointer' || /^(button|a)$/.test(spec.tag)) {
    if (spec.tag === 'a') ctx.notes.add(`${node.name}: a link is drawn as its content; give it a Link or a NavigationLink.`);
  }
  let out = withModifiers(base, mods);
  if (spec.tag === 'button' && node.type !== 'text') out = `Button(action: {}) {\n${indent(out, 1)}\n}\n.buttonStyle(.plain)`;
  const showing = bind('visible');
  const hiding = bind('hidden');
  if (showing) out = `if ${showing.fallback !== undefined ? `${showing.name} ?? ${showing.fallback}` : showing.name} {\n${indent(out, 1)}\n}`;
  if (hiding) out = `if !(${hiding.fallback !== undefined ? `${hiding.name} ?? ${hiding.fallback}` : hiding.name}) {\n${indent(out, 1)}\n}`;
  return out;
}

const ALIGN_COLUMN: Record<string, string> = { 'flex-start': '.leading', start: '.leading', center: '.center', 'flex-end': '.trailing', end: '.trailing' };
const ALIGN_ROW: Record<string, string> = { 'flex-start': '.top', start: '.top', center: '.center', 'flex-end': '.bottom', end: '.bottom', baseline: '.firstTextBaseline' };

/** A frame as a stack of its children. */
function container(ctx: Ctx, node: BogenNode, resolved: boolean, root: boolean): string {
  const { doc } = ctx;
  const style = node.style;
  const ids = resolved ? doc.getChildren(node.id).map((n) => n.id) : [...doc.rawKids(node.id)];
  const slot = resolved ? undefined : ctx.slots.get(root ? '.' : node.id);
  const kids = ids.flatMap((k) => (resolved ? doc.getNode(k) : doc.rawNode(k)) ?? []).filter((k) => !k.hidden);
  const absolute = kids.filter(isAbsolute);
  const flow = kids.filter((k) => !isAbsolute(k));
  const flex = style.display === 'flex' || style.display === 'inline-flex';
  const row = flex && !/column/.test(style.flexDirection ?? 'row');
  if (style.display === 'grid' || style.display === 'inline-grid') ctx.notes.add(`${node.name}: a CSS grid is a VStack here; use Grid or LazyVGrid for its columns.`);
  if (flex && style.flexWrap === 'wrap') ctx.notes.add(`${node.name}: wrapping rows are one HStack here; a Layout that flows them is not written.`);
  const gap = length(ctx, row ? style.columnGap ?? style.gap?.split(/\s+/).at(-1) : style.rowGap ?? style.gap?.split(/\s+/)[0]) ?? 0;
  const align = flex ? (row ? ALIGN_ROW : ALIGN_COLUMN)[style.alignItems ?? ''] ?? (row ? '.top' : '.leading') : '.leading';
  const justify = flex ? style.justifyContent ?? '' : '';
  const children = flow.map((k) => view(ctx, k.id, false, resolved)).filter(Boolean);
  if (justify === 'space-between' && children.length > 1) for (let i = children.length - 1; i > 0; i--) children.splice(i, 0, 'Spacer(minLength: 0)');
  else if (justify === 'center' && children.length) children.unshift('Spacer(minLength: 0)'), children.push('Spacer(minLength: 0)');
  else if ((justify === 'flex-end' || justify === 'end') && children.length) children.unshift('Spacer(minLength: 0)');
  let content = children.join('\n');
  if (slot) {
    const defaults = content || 'EmptyView()';
    content = `if let ${slot} {\n    ${slot}\n} else {\n${indent(defaults, 1)}\n}`;
  }
  const stack = `${row ? 'HStack' : 'VStack'}(alignment: ${align}, spacing: ${num(gap)}) {\n${indent(content || 'EmptyView()', 1)}\n}`;
  if (!absolute.length) return stack;
  return `ZStack(alignment: .topLeading) {\n${indent([flow.length || slot ? stack : '', ...absolute.map((k) => view(ctx, k.id, false, resolved))].filter(Boolean).join('\n'), 1)}\n}`;
}

function usage(ctx: Ctx, raw: BogenNode): string {
  const { doc } = ctx;
  const main = doc.rawNode(raw.instanceOf!);
  if (main?.code) {
    ctx.notes.add(`${main.name} is a React component of the linked code project: SwiftUI has a comment where it goes.`);
    return `// ${raw.name}: a React component of the linked project`;
  }
  const info = main && ctx.infos.get(main.id);
  const unsaid = Object.keys(raw.overrides ?? {}).filter((k) => !k.startsWith('#instanceOf'));
  const fills = doc.rawKids(raw.id).flatMap((k) => doc.rawNode(k) ?? []);
  const here = main ? new Map(slotsOf(doc.source, main.id).map((s) => [s.path, info?.slotProps.get(s.name)])) : new Map<string, string | undefined>();
  if (!main || !info || unsaid.length || fills.some((f) => !here.get(f.slot ?? ''))) {
    const why = !main || !info ? 'its main is gone' : unsaid.length ? `${unsaid.length} change${unsaid.length > 1 ? 's' : ''} on inner layers` : 'a filled inner slot';
    return `// ${raw.name}: written out in full, because of ${why}.\n${view(ctx, raw.id, true, true)}`;
  }
  const args: string[] = [];
  const defaults = info.members[0]?.component?.variant ?? {};
  for (const [axis, value] of Object.entries(main.component?.variant ?? {})) if (defaults[axis] !== value) args.push(`${ident(axis)}: ${axisValue(info.axes.find((a) => a.axis === axis)?.values, value)}`);
  for (const prop of info.props) {
    const value = raw.props?.[prop.name];
    if (value === undefined) continue;
    args.push(`${propIdent(prop.name, info)}: ${typeof value === 'boolean' ? String(value) : str(value)}`);
  }
  for (const prop of new Set(info.slotProps.values())) {
    const filled = fills.filter((f) => here.get(f.slot ?? '') === prop);
    if (filled.length) args.push(`${ident(prop === 'children' ? 'content' : prop)}: AnyView(VStack(alignment: .leading, spacing: 0) {\n${indent(filled.map((f) => view(ctx, f.id, false)).join('\n'), 1)}\n})`);
  }
  const call = `${ctx.names.get(info.key)!}(${args.length > 1 ? `\n${indent(args.join(',\n'), 1)}\n` : args.join('')})`;
  const own = raw.style;
  const mods: string[] = [];
  const w = length(ctx, own.width);
  if (w !== undefined) mods.push(`.frame(width: ${num(w)})`);
  else if (own.width === '100%' || /^1(\s|$)/.test(own.flex ?? '')) mods.push('.frame(maxWidth: .infinity, alignment: .leading)');
  return withModifiers(call, mods);
}

function swiftType(prop: ComponentProp): string {
  return prop.type === 'boolean' ? 'Bool' : 'String';
}

function swiftLiteral(value: PropValue): string {
  return typeof value === 'boolean' ? String(value) : str(value);
}

function componentFile(ctx: Ctx, info: CodeComponentInfo): CodeFile {
  const { doc } = ctx;
  const name = ctx.names.get(info.key)!;
  const first = info.members[0]!;
  const many = info.members.length > 1;
  const lines: string[] = [];
  const enums: string[] = [];
  for (const { axis, values } of info.axes) {
    const at = first.component?.variant?.[axis] ?? values[0]!;
    if (isBoolAxis(values)) {
      lines.push(`var ${ident(axis)}: Bool = ${at}`);
      continue;
    }
    const type = enumName(axis);
    enums.push(`enum ${type}: String, CaseIterable {\n${indent(values.map((v) => `case ${ident(v)} = ${str(v)}`).join('\n'), 1)}\n}`);
    lines.push(`var ${ident(axis)}: ${type} = .${ident(at)}`);
  }
  for (const prop of info.props) {
    // In a set each member has its own default, so the property is optional and the member says its own.
    if (many) lines.push(`var ${propIdent(prop.name, info)}: ${swiftType(prop)}? = nil`);
    else lines.push(`var ${propIdent(prop.name, info)}: ${swiftType(prop)} = ${swiftLiteral(propDefaultFor(doc, first, prop))}`);
  }
  for (const prop of new Set(info.slotProps.values())) lines.push(`var ${ident(prop === 'children' ? 'content' : prop)}: AnyView? = nil`);
  const states: string[] = [];
  const body = (member: BogenNode) => {
    const bound = new Map<string, Bound>();
    for (const prop of member.component?.props ?? []) {
      for (const target of prop.targets ?? []) bound.set(`${target.path}#${target.field}`, { name: propIdent(prop.name, info), type: prop.type, ...(many ? { fallback: swiftLiteral(propDefaultFor(doc, member, prop)) } : {}) });
    }
    const slots = new Map<string, string>();
    for (const slot of slotsOf(doc.source, member.id)) {
      const prop = info.slotProps.get(slot.name);
      if (prop) slots.set(slot.path, ident(prop === 'children' ? 'content' : prop));
    }
    const sub: Ctx = { ...ctx, bound, slots, states };
    return view(sub, member.id, true);
  };
  const conditions = (member: BogenNode) => Object.entries(member.component?.variant ?? {}).map(([axis, value]) => {
    const values = info.axes.find((a) => a.axis === axis)?.values;
    return values && isBoolAxis(values) ? (value === 'true' ? ident(axis) : `!${ident(axis)}`) : `${ident(axis)} == .${ident(value)}`;
  }).join(' && ');
  const branches = info.members.slice(1).filter((m) => conditions(m));
  const content = branches.length
    ? `${branches.map((m, i) => `${i ? '} else if' : 'if'} ${conditions(m)} {\n${indent(body(m), 1)}`).join('\n')}\n} else {\n${indent(body(first), 1)}\n}`
    : body(first);
  const desc = first.component?.description ? `/// ${first.component.description.replace(/\n/g, ' ')}\n` : '';
  const stateLines = states.length ? ['@Environment(\\.accessibilityReduceMotion) private var reduceMotion', ...states.map((s) => `@State private var ${s} = false`)] : [];
  const text = `import SwiftUI\n\n${desc}struct ${name}: View {\n${indent([...enums, ...lines, ...stateLines].join('\n'), 1)}\n\n    var body: some View {\n${indent(content, 2)}\n    }\n}\n\n#Preview {\n    ${name}()\n}\n`;
  return { path: `${name}.swift`, text };
}

function tokensFile(ctx: Ctx): CodeFile {
  const lines: string[] = [];
  for (const name of [...ctx.usedTokens].sort()) {
    const t = ctx.tokens.get(name)!;
    if (t.kind === 'color') {
      const light = cssColor(tokenValue(ctx, name, 'light') ?? '');
      const dark = cssColor(tokenValue(ctx, name, 'dark') ?? '');
      if (!light) {
        lines.push(`/// ${name}: ${t.value.slice(0, 60)} is not a colour SwiftUI can take here.\nstatic let ${ident(name)} = Color.clear`);
        continue;
      }
      const l = swiftColor(light);
      const d = dark ? swiftColor(dark) : l;
      lines.push(`/// --${name}\nstatic let ${ident(name)} = ${l === d ? l : `Color(light: ${l}, dark: ${d})`}`);
    } else {
      const n = length(ctx, tokenValue(ctx, name, 'light'));
      lines.push(n !== undefined ? `/// --${name}\nstatic let ${ident(name)}: CGFloat = ${num(n)}` : `/// --${name}\nstatic let ${ident(name)} = ${str(tokenValue(ctx, name, 'light') ?? '')}`);
    }
  }
  const modes = [...new Set(ctx.doc.getTokens().flatMap((t) => Object.keys(t.modes ?? {})))].filter((m) => m !== 'dark');
  if (modes.length) ctx.notes.add(`Tokens follow the light and dark appearance; the file's other modes (${modes.join(', ')}) are not written.`);
  const text = `import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The design's tokens. Colours switch with the system's light and dark appearance.
enum Tokens {
${indent(lines.join('\n'), 1)}
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }

    init(light: Color, dark: Color) {
        #if canImport(UIKit)
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
        #elseif canImport(AppKit)
        self.init(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(dark) : NSColor(light) })
        #else
        self = light
        #endif
    }
}
`;
  return { path: 'Tokens.swift', text };
}

/** A layer as SwiftUI files: a view per component, the screen that uses them, and Tokens.swift. */
export function toSwiftUI(doc: BogenDoc, id: string, resolve?: AssetResolver): SwiftUIExport {
  const node = doc.rawNode(id);
  if (!node) throw new Error(`No layer with id ${id}.`);
  const mains = componentMainsFor(doc, id);
  const infos = componentInfosFor(doc, mains);
  const names = new Map<string, string>();
  const taken = new Set<string>(['Tokens']);
  const notes = new Set<string>();
  const web = new Map<string, string[]>();
  for (const info of new Set(infos.values())) {
    const base = info.name.endsWith('View') ? info.name : `${info.name}View`;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
    names.set(info.key, name);
    if (info.handoff) {
      const lib = info.handoff.from.split('/').slice(0, info.handoff.from.startsWith('@') ? 2 : 1).join('/');
      web.set(lib, [...(web.get(lib) ?? []), `${name} (${info.handoff.name} of ${info.handoff.from})`]);
    }
  }
  for (const [lib, list] of web) notes.add(`${list.length === 1 ? `${list[0]} stands for a component` : `${list.join(', ')} stand for components`} of ${lib} on the web: written here from ${list.length === 1 ? 'its drawing, as a SwiftUI view' : 'their drawings, as SwiftUI views'} of your own.`);
  const ctx: Ctx = {
    doc, resolve, infos, names, tokens: new Map(doc.getTokens().map((t) => [t.name, t])), usedTokens: new Set(), notes, assets: new Map(),
    bound: new Map(), slots: new Map(), states: [], keyframes: fileKeyframes(doc), fontSize: 16,
  };
  const files: CodeFile[] = [];
  const done = new Set<string>();
  for (const main of mains) {
    const info = infos.get(main.id)!;
    if (done.has(info.key)) continue;
    done.add(info.key);
    files.push(componentFile(ctx, info));
  }
  const plan = repeatPlan(doc);
  const inTree = (at: string): boolean => plan.templates.has(at) || doc.rawKids(at).some(inTree);
  if (inTree(id)) notes.add('Live data repeats are written as the copies the canvas shows; loop over your records with ForEach in their place.');
  const hasRules = (at: string): boolean => Boolean(doc.rawNode(at)?.rules) || doc.rawKids(at).some(hasRules);
  if (hasRules(id) || mains.some((m) => hasRules(m.id))) notes.add('Pseudo-elements, hover and other conditions of layers are web CSS and are left out; say states with @State and .onHover where they matter.');
  let entry: string;
  const rootInfo = node.component ? infos.get(id) : undefined;
  if (rootInfo) entry = `${names.get(rootInfo.key)!}.swift`;
  else {
    let name = typeName(node.name);
    if (!name.endsWith('View')) name = `${name}View`;
    if (taken.has(name)) name = `${name}Screen`;
    const states: string[] = [];
    const body = view({ ...ctx, states }, id, true);
    const stateLines = states.length ? ['@Environment(\\.accessibilityReduceMotion) private var reduceMotion', ...states.map((s) => `@State private var ${s} = false`), ''] : [];
    const scroll = node.artboard ? `ScrollView {\n${indent(body, 1)}\n}` : body;
    entry = `${name}.swift`;
    files.push({ path: entry, text: `import SwiftUI\n\nstruct ${name}: View {\n${stateLines.length ? `${indent(stateLines.join('\n'), 1)}\n` : ''}    var body: some View {\n${indent(scroll, 2)}\n    }\n}\n\n#Preview {\n    ${name}()\n}\n` });
  }
  files.unshift(tokensFile(ctx));
  const assets = [...ctx.assets].map(([name, svg]) => ({ name, svg }));
  if (assets.length) notes.add(`Icons and drawings are images from the asset catalog: add ${assets.slice(0, 6).map((a) => `${a.name}.svg`).join(', ')}${assets.length > 6 ? ` and ${assets.length - 6} more` : ''} with Render As Template Image (export_file with format swiftui writes them in Assets).`);
  return { files, entry, notes: [...notes], assets };
}
