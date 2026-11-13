import { slotsOf } from './components.ts';
import { escapeAttr, escapeHtml, styleToCss } from './css.ts';
import type { BogenDoc, BogenNode, ComponentProp, PropValue } from './doc.ts';
import { mergeClassAttrs, type CodeHandoff } from './handoff.ts';
import { motionHandoff, type MotionHandoff } from './motion.ts';
import { componentInfosFor, componentMainsFor, propDefaultFor, textStyleCssFor, type CodeComponentInfo } from './react-export.ts';
import { repeatPlan } from './repeat.ts';
import { fluidPageStyle, RESET_CSS, renderSpec, rulesCss, tokensCss, type AssetResolver } from './render.ts';

/**
 * Hands a layer to Vue (single-file components with `<script setup lang="ts">`) or Svelte 5 (runes): one file per
 * component with typed props, a variant set as one component that switches on its axes, slots as slots (Vue) or
 * snippets (Svelte), instances as usages, and the page that uses them. Styles stay inline as in react-inline; tokens,
 * text styles, layer rules and motion go into one bogen.css that the page imports. Motion is CSS that runs only under
 * prefers-reduced-motion: no-preference.
 *
 * A kit that hands off to markup (daisyUI, USWDS, Pico CSS, Web Awesome) is written as that markup, which works the
 * same in both. A kit that hands off to a React library (shadcn/ui, MUI, Mantine, Carbon React) cannot be imported
 * here, so its components are written from their drawing like the file's own, and the notes say so.
 */
export type SfcFlavor = 'vue' | 'svelte';

export interface CodeFile { path: string; text: string }

export interface SfcExport {
  flavor: SfcFlavor;
  files: CodeFile[];
  /** The file of the layer itself: its component, or the page that uses the components. */
  entry: string;
  /** What the code could not say, or says differently from the canvas. */
  notes: string[];
}

const POSITION = ['position', 'left', 'top', 'right', 'bottom'];
const VOID = new Set(['img', 'input', 'hr', 'br', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
const RESERVED = new Set(['class', 'style', 'default', 'function', 'var', 'let', 'const', 'for', 'if', 'else', 'return', 'new', 'in', 'of', 'do', 'while', 'switch', 'case', 'this', 'typeof', 'void', 'delete', 'with', 'yield', 'import', 'export', 'key', 'ref', 'slot', 'is', 'children', 'props', 'rest']);

function pascal(name: string): string {
  const parts = name.replace(/[^\w\s-]/g, ' ').split(/[\s_-]+/).filter(Boolean);
  const out = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  return /^[A-Z]/.test(out) ? out : `Layer${out}`;
}

function camel(name: string): string {
  const parts = name.split(/[\s_-]+/).filter(Boolean);
  const out = parts.map((p, i) => (i ? p[0]!.toUpperCase() + p.slice(1) : p[0]!.toLowerCase() + p.slice(1))).join('').replace(/\W/g, '');
  const safe = /^[a-zA-Z_]/.test(out) ? out : `p${out}`;
  return RESERVED.has(safe) ? `${safe}Prop` : safe;
}

/** A JavaScript string in single quotes, which sits inside a double-quoted Vue attribute. */
function lit(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/"/g, '\\x22').replace(/</g, '\\x3c')}'`;
}

/** A prop's name in code: camelCase, and with Text after it when a variant axis has the same name, such as a title axis and a title text. */
function propName(info: CodeComponentInfo, name: string): string {
  const out = camel(name);
  return info.axes.some((a) => camel(a.axis) === out) ? `${out}Text` : out;
}

function literal(value: PropValue): string {
  return typeof value === 'boolean' ? String(value) : lit(value);
}

/** Braces are expressions in Svelte markup and `{{` is one in Vue, so text and attribute values carry them as entities. */
function braces(text: string): string {
  return text.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

function textHtml(text: string): string {
  return braces(escapeHtml(text)).replace(/\n/g, '<br />');
}

function attrHtml(name: string, value: string): string {
  return value === '' ? ` ${name}` : ` ${name}="${braces(escapeAttr(value))}"`;
}

interface Bound { name: string; fallback?: string }

interface Ctx {
  doc: BogenDoc;
  flavor: SfcFlavor;
  resolve: AssetResolver | undefined;
  infos: Map<string, CodeComponentInfo>;
  /** The file name of each component, by its set or main. */
  names: Map<string, string>;
  /** What a component's props drive, `<path>#<field>` to the prop. Empty outside a component. */
  bound: Map<string, Bound>;
  /** Slots of the component being written, by layer id ('.' for its root), to the slot's prop. */
  slots: Map<string, string>;
  motion: MotionHandoff;
  notes: Set<string>;
  /** Components the file being written uses, by key, for its imports. */
  used: Set<string>;
  /** Modules markup handoffs need for their side effects. */
  side: Set<string>;
  /** The layer the page is about, which takes the window's width. */
  pageRoot?: string;
  /** The component being written, whose root takes the class and style a usage gives it (Svelte). */
  rootOf?: string;
}

const expr = (b: Bound) => (b.fallback !== undefined ? `${b.name} ?? ${b.fallback}` : b.name);

function bindAttr(ctx: Ctx, name: string, value: string): string {
  return ctx.flavor === 'vue' ? ` :${name}="${value}"` : ` ${name}={${value}}`;
}

function show(ctx: Ctx, cond: string, body: string, pad: string): string {
  if (ctx.flavor === 'vue') return body.replace(/^(\s*<[\w-]+)/, `$1 v-if="${cond}"`);
  return `${pad}{#if ${cond}}\n${body.replace(/^/gm, '  ')}\n${pad}{/if}`;
}

/** One layer and what is under it. `resolved` writes an instance's tree as the canvas shows it, with no bindings. */
function layer(ctx: Ctx, id: string, depth: number, root: boolean, resolved = false): string {
  const { doc } = ctx;
  const stored = resolved ? doc.getNode(id) : doc.rawNode(id);
  if (!stored) return '';
  const pad = '  '.repeat(depth);
  if (!resolved && stored.instanceOf !== undefined) return usage(ctx, stored, depth);
  if (stored.code) {
    ctx.notes.add(`${stored.name} is a React component of the linked code project, which Vue and Svelte cannot mount: it is left as a comment where it goes.`);
    return `${pad}<!-- ${stored.name.replace(/--/g, '-')}: a React component of the linked project -->`;
  }
  if (stored.type === 'shader') ctx.notes.add(`${stored.name} is a shader layer: it comes out as an empty element with data-shader. Mount @paper-design/shaders with the parameters from layer_get.`);
  const key = root ? '' : id;
  const bind = (field: string) => (resolved ? undefined : ctx.bound.get(`${key}#${field}`));
  const showing = bind('visible');
  const hiding = bind('hidden');
  const src = bind('src');
  const shown = src && stored.type === 'image' && !stored.src ? { ...stored, src: '#' } : stored;
  const spec = renderSpec(showing || hiding ? { ...shown, hidden: false } : shown, ctx.resolve);
  const style = { ...spec.style };
  if (root || id === ctx.pageRoot) for (const k of POSITION) delete style[k];
  if (id === ctx.pageRoot) {
    const fluid = fluidPageStyle(stored, style);
    for (const k of Object.keys(style)) if (!(k in fluid)) delete style[k];
    Object.assign(style, fluid);
  }
  const moving = ctx.motion.layers.get(id);
  const attrs = { ...spec.attrs };
  if (moving) {
    for (const k of moving.strip) delete style[k];
    if (moving.className) attrs.class = [attrs.class, moving.className].filter(Boolean).join(' ');
  }
  const dynamicStyle: string[] = [];
  for (const k of ctx.bound.keys()) {
    if (resolved || !k.startsWith(`${key}#style.`)) continue;
    const prop = k.slice(key.length + 7);
    delete style[prop];
    dynamicStyle.push(ctx.flavor === 'vue' ? `${lit(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))}: ${expr(ctx.bound.get(k)!)}` : ` style:${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}={${expr(ctx.bound.get(k)!)}}`);
  }
  let out = `${pad}<${spec.tag}`;
  const svelteRoot = ctx.flavor === 'svelte' && root && ctx.rootOf !== undefined;
  for (const [k, v] of Object.entries(attrs)) {
    const b = bind(`attr.${k}`);
    if (b) out += bindAttr(ctx, k, expr(b));
    else if (k === 'class' && svelteRoot) out += ` class="${braces(escapeAttr(v))} {className}"`;
    else out += attrHtml(k, v);
  }
  for (const k of ctx.bound.keys()) {
    if (resolved || !k.startsWith(`${key}#attr.`) || k.slice(key.length + 6) in attrs) continue;
    out += bindAttr(ctx, k.slice(key.length + 6), expr(ctx.bound.get(k)!));
  }
  if (src) out += bindAttr(ctx, 'src', expr(src));
  if (svelteRoot && !attrs.class) out += ' class={className}';
  const css = styleToCss(style);
  if (svelteRoot) out += ` style="${braces(escapeAttr(css))}${css ? '; ' : ''}{style}"`;
  else if (css) out += ` style="${braces(escapeAttr(css))}"`;
  if (dynamicStyle.length) out += ctx.flavor === 'vue' ? ` :style="{ ${dynamicStyle.join(', ')} }"` : dynamicStyle.join('');
  const kids = resolved ? doc.getChildren(id).map((n) => n.id) : [...doc.rawKids(id)];
  const text = bind('text');
  const slot = resolved ? undefined : ctx.slots.get(root ? '.' : id);
  let body: string;
  if (text) body = `${out}>${ctx.flavor === 'vue' ? `{{ ${expr(text)} }}` : `{${expr(text)}}`}</${spec.tag}>`;
  else if (VOID.has(spec.tag)) body = `${out} />`;
  else if (spec.html !== undefined) body = `${out}>${braces(spec.html)}</${spec.tag}>`;
  else if (spec.text !== undefined) body = `${out}>${textHtml(spec.text)}</${spec.tag}>`;
  else if (slot) {
    const defaults = kids.map((k) => layer(ctx, k, depth + (ctx.flavor === 'vue' ? 2 : 3), false)).filter(Boolean).join('\n');
    if (ctx.flavor === 'vue') {
      const tag = slot === 'children' ? '<slot' : `<slot name="${slot}"`;
      body = defaults ? `${out}>\n${pad}  ${tag}>\n${defaults}\n${pad}  </slot>\n${pad}</${spec.tag}>` : `${out}>${tag} /></${spec.tag}>`;
    } else {
      body = defaults
        ? `${out}>\n${pad}  {#if ${slot}}\n${pad}    {@render ${slot}()}\n${pad}  {:else}\n${defaults}\n${pad}  {/if}\n${pad}</${spec.tag}>`
        : `${out}>{@render ${slot}?.()}</${spec.tag}>`;
    }
  } else if (!kids.length) body = `${out}></${spec.tag}>`;
  else body = `${out}>\n${kids.map((k) => layer(ctx, k, depth + 1, false, resolved)).filter(Boolean).join('\n')}\n${pad}</${spec.tag}>`;
  if (showing) return show(ctx, expr(showing), body, pad);
  if (hiding) return show(ctx, `!(${expr(hiding)})`, body, pad);
  return body;
}

/** An instance whose inner layers changed in ways its props cannot say: its tree as it looks, with a comment. */
function writtenOut(ctx: Ctx, raw: BogenNode, why: string, depth: number): string {
  const pad = '  '.repeat(depth);
  return `${pad}<!-- ${raw.name.replace(/--/g, '-')}: written out in full, because of ${why}. -->\n${layer({ ...ctx, rootOf: undefined }, raw.id, depth, true, true)}`;
}

function usage(ctx: Ctx, raw: BogenNode, depth: number): string {
  const { doc } = ctx;
  const pad = '  '.repeat(depth);
  const main = doc.rawNode(raw.instanceOf!);
  if (main?.code) {
    ctx.notes.add(`${main.name} is a React component of the linked code project, which Vue and Svelte cannot mount: it is left as a comment where it goes.`);
    return `${pad}<!-- ${raw.name.replace(/--/g, '-')}: a React component of the linked project -->`;
  }
  const info = main && ctx.infos.get(main.id);
  if (!main || !info) return writtenOut(ctx, raw, 'its main is gone', depth);
  const fills = doc.rawKids(raw.id).flatMap((k) => doc.rawNode(k) ?? []);
  const unsaid = Object.keys(raw.overrides ?? {}).filter((k) => !k.startsWith('#instanceOf'));
  const here = new Map(slotsOf(doc.source, main.id).map((s) => [s.path, info.slotProps.get(s.name)]));
  if (fills.some((f) => !here.get(f.slot ?? ''))) return writtenOut(ctx, raw, 'a filled inner slot', depth);
  if (info.handoff?.element) return markupUsage(ctx, raw, main, info, info.handoff, fills, here, unsaid.length, depth);
  if (unsaid.length) return writtenOut(ctx, raw, `${unsaid.length} change${unsaid.length > 1 ? 's' : ''} on inner layers`, depth);
  ctx.used.add(info.key);
  const name = ctx.names.get(info.key)!;
  let out = `${pad}<${name}`;
  const defaults = info.members[0]?.component?.variant ?? {};
  for (const [axis, value] of Object.entries(main.component?.variant ?? {})) if (defaults[axis] !== value) out += attrHtml(camel(axis), value);
  for (const prop of info.props) {
    const value = raw.props?.[prop.name];
    if (value === undefined) continue;
    out += typeof value === 'boolean' ? bindAttr(ctx, propName(info, prop.name), String(value)) : attrHtml(propName(info, prop.name), value);
  }
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.style)) if (v !== '' && !POSITION.includes(k)) own[k] = v;
  if (Object.keys(own).length) out += attrHtml('style', styleToCss(own));
  const groups = new Map<string, BogenNode[]>();
  for (const f of fills) {
    const prop = here.get(f.slot ?? '')!;
    groups.set(prop, [...(groups.get(prop) ?? []), f]);
  }
  if (!groups.size) return `${out} />`;
  const parts: string[] = [];
  for (const [prop, list] of groups) {
    const inner = list.map((f) => layer(ctx, f.id, depth + (prop === 'children' ? 1 : 2), false)).join('\n');
    if (prop === 'children') parts.push(inner);
    else if (ctx.flavor === 'vue') parts.push(`${pad}  <template #${prop}>\n${inner}\n${pad}  </template>`);
    else parts.push(`${pad}  {#snippet ${prop}()}\n${inner}\n${pad}  {/snippet}`);
  }
  return `${out}>\n${parts.join('\n')}\n${pad}</${name}>`;
}

/** A usage of a kit that is markup (daisyUI, USWDS, Pico CSS, Web Awesome): its HTML, the same in Vue and Svelte. */
function markupUsage(ctx: Ctx, raw: BogenNode, main: BogenNode, info: CodeComponentInfo, h: CodeHandoff, fills: BogenNode[], here: Map<string, string | undefined>, unsaid: number, depth: number): string {
  const { doc } = ctx;
  const pad = '  '.repeat(depth);
  for (const m of h.side ?? []) ctx.side.add(m);
  const attrs: string[] = [];
  const texts = new Map<string, string>();
  let childText: string | undefined;
  const codeName = (name: string) => (h.props && name in h.props ? h.props[name]! : camel(name));
  const defaults = h.defaults ?? info.members[0]?.component?.variant ?? {};
  for (const [axis, value] of Object.entries(main.component?.variant ?? {})) {
    const flag = h.flags?.[axis]?.[value];
    if (flag) attrs.push(braces(flag));
    const name = codeName(axis);
    if (!name || defaults[axis] === value) continue;
    attrs.push(`${name}="${braces(escapeAttr(h.values?.[axis]?.[value] ?? value))}"`);
  }
  for (const prop of info.props) {
    const name = codeName(prop.name);
    const ownProp = main.component?.props?.find((p) => p.name === prop.name) ?? prop;
    const value = raw.props?.[prop.name] ?? (prop.type === 'text' ? propDefaultFor(doc, main, ownProp) : undefined);
    if (prop.type === 'text' && typeof value === 'string') texts.set(prop.name, value);
    if (!name) continue;
    if (name === 'children') {
      if (typeof value === 'string') childText = value;
      continue;
    }
    if (raw.props?.[prop.name] === undefined && !(prop.type === 'text' && typeof value === 'string' && value !== '')) continue;
    if (value === true) attrs.push(name);
    else if (typeof value === 'string') attrs.push(`${name}="${braces(escapeAttr(value))}"`);
  }
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.style)) if (v !== '' && !POSITION.includes(k)) own[k] = v;
  if (Object.keys(own).length) attrs.push(`style="${braces(escapeAttr(styleToCss(own)))}"`);
  const filled = fills.filter((f) => here.get(f.slot ?? '') !== undefined);
  const inner = filled.length ? filled.map((f) => layer(ctx, f.id, depth + 1, false)).join('\n') : childText ? textHtml(childText) : '';
  const note = unsaid ? `${pad}<!-- ${raw.name.replace(/--/g, '-')}: ${unsaid} change${unsaid > 1 ? 's' : ''} on inner layers that these attributes do not say. -->\n` : '';
  const tag = h.element!;
  const body = h.usage
    ? h.usage
      .replace(/\{\{\s*attrs\s*\}\}/g, attrs.length ? ` ${attrs.join(' ')}` : '')
      .replace(/\{\{\s*children\s*\}\}/g, filled.length ? `\n${inner}\n` : inner)
      .replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, name: string) => textHtml(texts.get(name) ?? ''))
    : `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}${VOID.has(tag) ? ' />' : `>${filled.length ? `\n${inner}\n${pad}` : inner}</${tag}>`}`;
  return `${note}${mergeClassAttrs(body, 'class').split('\n').map((line) => (line.trim() ? (line.startsWith(pad) ? line : `${pad}${line}`) : line)).join('\n')}`;
}

function tsType(prop: ComponentProp): string {
  if (prop.type === 'boolean') return 'boolean';
  if (prop.options?.length) return prop.options.map((o) => lit(o)).join(' | ');
  return 'string';
}

function importLine(ctx: Ctx, key: string): string {
  const name = ctx.names.get(key)!;
  return `import ${name} from './${name}.${ctx.flavor}';`;
}

function scriptBlock(ctx: Ctx, lines: string[]): string {
  return `<script${ctx.flavor === 'vue' ? ' setup' : ''} lang="ts">\n${lines.map((l) => (l ? `  ${l}` : '')).join('\n')}\n</script>`;
}

function componentFile(ctx: Ctx, info: CodeComponentInfo): CodeFile {
  const { doc } = ctx;
  const first = info.members[0]!;
  const many = info.members.length > 1;
  const types: string[] = [];
  const defaults: string[] = [];
  for (const { axis, values } of info.axes) {
    types.push(`${camel(axis)}?: ${values.map((v) => lit(v)).join(' | ')}`);
    defaults.push(`${camel(axis)}${ctx.flavor === 'vue' ? ': ' : ' = '}${lit(first.component?.variant?.[axis] ?? values[0]!)}`);
  }
  for (const prop of info.props) {
    const name = propName(info, prop.name);
    types.push(`${name}?: ${tsType(prop)}`);
    // In a set each member has its own default, written where it is used. Vue makes an absent boolean false unless it has a default.
    if (!many) defaults.push(`${name}${ctx.flavor === 'vue' ? ': ' : ' = '}${literal(propDefaultFor(doc, first, prop))}`);
    else if (ctx.flavor === 'vue' && prop.type === 'boolean') defaults.push(`${name}: undefined`);
    else if (ctx.flavor === 'svelte') defaults.push(name);
  }
  if (ctx.flavor === 'svelte') {
    for (const prop of info.slotProps.values()) {
      types.push(`${prop}?: Snippet`);
      defaults.push(prop);
    }
    types.push('class?: string', 'style?: string');
    defaults.push("class: className = ''", "style = ''");
  }
  const used = new Set<string>();
  const sub: Ctx = { ...ctx, used, rootOf: info.key };
  const body = (member: BogenNode, depth: number) => {
    const bound = new Map<string, Bound>();
    for (const prop of member.component?.props ?? []) {
      for (const target of prop.targets ?? []) bound.set(`${target.path}#${target.field}`, { name: propName(info, prop.name), ...(many ? { fallback: literal(propDefaultFor(doc, member, prop)) } : {}) });
    }
    const slots = new Map<string, string>();
    for (const slot of slotsOf(doc.source, member.id)) {
      const prop = info.slotProps.get(slot.name);
      if (prop) slots.set(slot.path, prop);
    }
    return layer({ ...sub, bound, slots }, member.id, depth, true);
  };
  const conditions = (member: BogenNode) => Object.entries(member.component?.variant ?? {}).map(([axis, value]) => `${camel(axis)} === ${lit(value)}`).join(' && ');
  let markup: string;
  const branches = info.members.slice(1).filter((m) => conditions(m));
  if (!branches.length) markup = body(first, ctx.flavor === 'vue' ? 1 : 0);
  else if (ctx.flavor === 'vue') {
    markup = [...branches.map((m, i) => `  <template ${i ? 'v-else-if' : 'v-if'}="${conditions(m)}">\n${body(m, 2)}\n  </template>`), `  <template v-else>\n${body(first, 2)}\n  </template>`].join('\n');
  } else {
    markup = `${branches.map((m, i) => `${i ? '{:else if' : '{#if'} ${conditions(m)}}\n${body(m, 1)}`).join('\n')}\n{:else}\n${body(first, 1)}\n{/if}`;
  }
  const name = ctx.names.get(info.key)!;
  const description = first.component?.description ? `/** ${first.component.description.replace(/\*\//g, '* /')} */` : '';
  const imports = [...used].filter((k) => k !== info.key).sort().map((k) => importLine(ctx, k));
  if (ctx.flavor === 'vue') {
    const props = types.length ? `defineProps<{\n    ${types.join(';\n    ')};\n  }>()` : '';
    const call = props && defaults.length ? `withDefaults(${props}, {\n    ${defaults.join(',\n    ')},\n  });` : props ? `${props};` : '';
    const script = [...imports, ...(imports.length && call ? [''] : []), ...(description && call ? [description] : []), ...(call ? [call] : [])];
    return { path: `${name}.vue`, text: `${script.length ? `${scriptBlock(ctx, script)}\n\n` : ''}<template>\n${markup}\n</template>\n` };
  }
  const script = [
    ...(info.slotProps.size ? ["import type { Snippet } from 'svelte';"] : []),
    ...imports,
    '',
    ...(description ? [description] : []),
    `let { ${defaults.join(', ')} }: { ${types.join('; ')} } = $props();`,
  ];
  return { path: `${name}.svelte`, text: `${scriptBlock(ctx, script)}\n\n${markup}\n` };
}

/** A layer as Vue or Svelte files: its components, the page that uses them, and bogen.css. */
export function toSfc(doc: BogenDoc, id: string, flavor: SfcFlavor, resolve?: AssetResolver): SfcExport {
  const node = doc.rawNode(id);
  if (!node) throw new Error(`No layer with id ${id}.`);
  const mains = componentMainsFor(doc, id);
  const infos = componentInfosFor(doc, mains);
  const motion = motionHandoff(doc, [id, ...mains.map((m) => m.id)], 'css');
  const notes = new Set<string>();
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const react = new Map<string, string[]>();
  for (const info of new Set(infos.values())) {
    let name = info.name;
    for (let i = 2; taken.has(name); i++) name = `${info.name}${i}`;
    taken.add(name);
    names.set(info.key, name);
    if (info.handoff && !info.handoff.element) {
      const lib = info.handoff.from.split('/').slice(0, info.handoff.from.startsWith('@') ? 2 : 1).join('/');
      react.set(lib, [...(react.get(lib) ?? []), `${name} (${info.handoff.name} of ${info.handoff.from})`]);
    }
  }
  for (const [lib, list] of react) notes.add(`${list.length === 1 ? `${list[0]} stands for a component` : `${list.join(', ')} stand for components`} of ${lib}, a React library: written here from ${list.length === 1 ? 'its drawing, as a component' : 'their drawings, as components'} of your own.`);
  const ctx: Ctx = { doc, flavor, resolve, infos, names, bound: new Map(), slots: new Map(), motion, notes, used: new Set(), side: new Set(), ...(node.component ? {} : { pageRoot: id }) };
  const files: CodeFile[] = [];
  const done = new Set<string>();
  for (const main of mains) {
    const info = infos.get(main.id)!;
    if (done.has(info.key) || info.handoff?.element) continue;
    done.add(info.key);
    files.push(componentFile(ctx, info));
  }
  const plan = repeatPlan(doc);
  const inTree = (at: string): boolean => plan.templates.has(at) || doc.rawKids(at).some(inTree);
  if (inTree(id)) notes.add('Live data repeats are written as the copies the canvas shows. Loop over your records with v-for (Vue) or {#each} (Svelte) in their place.');
  const css = [
    `/* Base styles the design assumes. Leave them out if your project has its own reset. */\n${RESET_CSS}`,
  ];
  let entry: string;
  const rootInfo = node.component ? infos.get(id) : undefined;
  if (rootInfo && !rootInfo.handoff?.element) entry = `${names.get(rootInfo.key)!}.${flavor}`;
  else {
    let name = pascal(node.name);
    if (taken.has(name)) name = `${name}Page`;
    const used = new Set<string>();
    const pageCtx: Ctx = { ...ctx, used };
    const markup = node.instanceOf !== undefined || rootInfo ? usage(pageCtx, rootInfo ? { ...node, instanceOf: id, id: `${id}-example`, style: {}, props: {}, overrides: {} } as BogenNode : { ...node, style: Object.fromEntries(Object.entries(node.style).filter(([k]) => !POSITION.includes(k))) }, flavor === 'vue' ? 1 : 0) : layer(pageCtx, id, flavor === 'vue' ? 1 : 0, false);
    const imports = [...[...ctx.side].sort().map((m) => `import '${m}';`), "import './bogen.css';", ...[...used].sort().map((k) => importLine(ctx, k))];
    entry = `${name}.${flavor}`;
    files.push({ path: entry, text: flavor === 'vue' ? `${scriptBlock(ctx, imports)}\n\n<template>\n${markup}\n</template>\n` : `${scriptBlock(ctx, imports)}\n\n${markup}\n` });
  }
  const code = files.map((f) => f.text).join('\n');
  if (code.includes('var(--')) css.push(`/* Tokens */\n${tokensCss(doc)}`);
  const textStyles = textStyleCssFor(doc, code);
  if (textStyles) css.push(`/* Text styles */\n${textStyles}`);
  const rules = rulesCss(doc, [id, ...mains.map((m) => m.id)]);
  if (rules) css.push(`/* Pseudo-elements and conditions of layers */\n${rules}`);
  if (motion.css) css.push(`/* Motion */\n${motion.css}`);
  for (const n of motion.notes) notes.add(n);
  files.push({ path: 'bogen.css', text: `${css.join('\n\n')}\n` });
  return { flavor, files, entry, notes: [...notes] };
}

/** The files as one text, for code_get: each under a line that names it, then what could not be said. */
export function codeFilesText(files: CodeFile[], notes: string[]): string {
  const comment = (path: string, text: string) => (/\.(css|swift|kt)$/.test(path) ? `/* ${text.replace(/\*\//g, '* /')} */` : `<!-- ${text.replace(/--/g, '-')} -->`);
  const body = files.map((f) => `${comment(f.path, `File: ${f.path}`)}\n${f.text}`).join('\n');
  return notes.length ? `${body}\n${comment('notes.css', `Not expressed or different from the canvas:\n- ${notes.join('\n- ')}`)}\n` : body;
}
