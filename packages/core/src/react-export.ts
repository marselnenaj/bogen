import { isVirtualId, setMembers, slotsOf, variantAxes } from './components.ts';
import { getTextStyles, textStylesCss } from './design-system.ts';
import type { BogenDoc, BogenNode, ComponentProp, PropValue } from './doc.ts';
import { applyMotion, jsxRules, preflightClasses, styleToTailwind, toJsx, withRuleClasses, withRulesStyle, type JsxData, type JsxMode } from './export.ts';
import { FRAMER_IMPORT, motionHandoff, withMotionConfig, type MotionHandoff, type MotionMode } from './motion.ts';
import { BIND_VARIANT, BIND_VISIBLE, dataDeclarations, fieldAccess, placeholderExpr, placeholderJsx, repeatPlan, variantBindings } from './repeat.ts';
import { fluidPageStyle, jsxBooleanAttr, renderSpec, type AssetResolver } from './render.ts';
import { codeImportLines, codeUsageJsx } from './code-components.ts';
import { handoffImportLines, mergeClassAttrs, type CodeHandoff } from './handoff.ts';

/**
 * Hands components to code as what they are: a React component with typed props per main or variant
 * set, and `<Button size="lg" />` wherever a design uses one. An instance with changes that props
 * cannot express comes out written in full, with a comment that says so.
 */
const ATTR_RENAMES: Record<string, string> = { class: 'className', for: 'htmlFor', colspan: 'colSpan', rowspan: 'rowSpan', autoplay: 'autoPlay', playsinline: 'playsInline', datetime: 'dateTime', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', minlength: 'minLength', autocomplete: 'autoComplete', inputmode: 'inputMode', enterkeyhint: 'enterKeyHint', spellcheck: 'spellCheck', fetchpriority: 'fetchPriority', popovertarget: 'popoverTarget', popovertargetaction: 'popoverTargetAction', 'data-mode': 'data-mode' };
const VOID = new Set(['img', 'input', 'hr', 'br', 'video', 'iframe']);
const POSITION = ['position', 'left', 'top', 'right', 'bottom'];
const RESERVED = new Set(['class', 'default', 'function', 'var', 'let', 'const', 'for', 'if', 'else', 'return', 'new', 'in', 'of', 'do', 'while', 'switch', 'case', 'this', 'typeof', 'void', 'delete', 'with', 'yield', 'import', 'export', 'style', 'className', 'children', 'key', 'ref']);

const js = (text: string) => JSON.stringify(text);

function jsxText(text: string): string {
  if (!/[{}<>&]/.test(text) && !text.includes('\n')) return text;
  return text.split('\n').map((line) => `{${js(line)}}`).join('<br />');
}

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

/** A style object. Values that start with `$` are expressions, not text. */
function styleLiteral(style: Record<string, string>): string {
  const entries = Object.entries(style).map(([k, v]) => `${/^[a-zA-Z]\w*$/.test(k) ? k : js(k)}: ${v.startsWith('$') ? v.slice(1) : js(v)}`);
  return `{{ ${entries.join(', ')} }}`;
}

interface Emit {
  doc: BogenDoc;
  mode: JsxMode;
  resolve: AssetResolver | undefined;
  infos: Map<string, ComponentInfo>;
  /** What a main's props drive: `<path>#<field>` to an expression. Empty outside a component. */
  bound: Map<string, { name: string; fallback?: string }>;
  /** Slots by layer id, to the prop that fills them. */
  slots: Map<string, string>;
  /** CSS for pseudo-elements and conditions that no class can say, collected while writing. */
  css: string[];
  /** Motion as classes or as Framer Motion props, by layer. */
  motion?: MotionHandoff;
  /** Live data: repeats in the file, and the record in scope inside a template. */
  data?: JsxData;
  /** The layer the module is about, when it is not a component: the page root in a project. */
  pageRoot?: string;
}

interface ComponentInfo {
  key: string;
  name: string;
  members: BogenNode[];
  axes: { axis: string; values: string[] }[];
  props: ComponentProp[];
  /** The prop for each slot by name. Members of a set share them by name, as their layers differ. */
  slotProps: Map<string, string>;
  /** The code library's component it stands for: usages import that, and no code is written for it. */
  handoff?: CodeHandoff;
}

function collect(doc: BogenDoc, start: string): BogenNode[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const src = doc.source;
  const visitMain = (mainId: string) => {
    if (seen.has(mainId)) return;
    seen.add(mainId);
    const main = src.raw(mainId);
    // A main that is a code component is the person's own component: its instances are usages of it.
    if (!main || main.code) return;
    for (const member of main.component?.set ? setMembers(src, main.component.set) : []) visitMain(member.id);
    walk(mainId);
    order.push(mainId);
  };
  const walk = (id: string) => {
    const node = src.raw(id);
    if (node?.instanceOf !== undefined) visitMain(node.instanceOf);
    for (const kid of src.rawKids(id)) walk(kid);
  };
  const root = src.raw(start);
  if (root?.component) visitMain(start);
  else walk(start);
  return order.flatMap((id) => src.raw(id) ?? []);
}

function buildInfos(doc: BogenDoc, mains: BogenNode[]): Map<string, ComponentInfo> {
  const byKey = new Map<string, ComponentInfo>();
  const used = new Set<string>();
  const out = new Map<string, ComponentInfo>();
  for (const main of mains) {
    const key = main.component?.set ?? main.id;
    let info = byKey.get(key);
    if (!info) {
      let name = pascal(main.component?.set ?? main.name);
      for (let i = 2; used.has(name); i++) name = `${pascal(main.component?.set ?? main.name)}${i}`;
      used.add(name);
      info = { key, name, members: [], axes: variantAxes(doc.source, main.component?.set), props: [], slotProps: new Map() };
      byKey.set(key, info);
    }
    for (const slot of slotsOf(doc.source, main.id)) {
      if (info.slotProps.has(slot.name)) continue;
      let prop = info.slotProps.size === 0 || slot.path === '.' ? 'children' : camel(slot.name);
      while ([...info.slotProps.values()].includes(prop)) prop = `${prop}2`;
      info.slotProps.set(slot.name, prop);
    }
    info.members.push(main);
    if (!info.handoff && main.component?.handoff) info.handoff = main.component.handoff;
    info.members.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
    for (const prop of main.component?.props ?? []) if (!info.props.some((p) => p.name === prop.name)) info.props.push(prop);
    out.set(main.id, info);
  }
  return out;
}

function typeOf(prop: ComponentProp): string {
  if (prop.type === 'boolean') return 'boolean';
  if (prop.options?.length) return prop.options.map((o) => js(o)).join(' | ');
  return 'string';
}

function literal(value: PropValue): string {
  return typeof value === 'boolean' ? String(value) : js(value);
}

function memberDefault(doc: BogenDoc, main: BogenNode, prop: ComponentProp): PropValue {
  const target = prop.targets?.[0];
  if (target) {
    const layer = doc.source.raw(target.path === '' ? main.id : target.path.split('/').at(-1)!);
    if (target.field === 'text' && layer?.text !== undefined) return layer.text;
    if (target.field === 'src' && layer?.src !== undefined) return layer.src;
    if (target.field === 'visible') return !layer?.hidden;
    if (target.field === 'hidden') return Boolean(layer?.hidden);
    if (target.field.startsWith('style.') && layer?.style[target.field.slice(6)] !== undefined) return layer.style[target.field.slice(6)]!;
  }
  return prop.default ?? (prop.type === 'boolean' ? false : '');
}

function propsOf(attrs: Record<string, string>): string[] {
  return Object.entries(attrs).map(([k, v]) => {
    const name = ATTR_RENAMES[k] ?? k;
    const bare = v === '' ? jsxBooleanAttr(k) : null;
    return v === '' && !bare ? name : `${name}=${js(bare ?? v)}`;
  });
}

/** Writes style as this mode wants it, with a component's root taking its `className` and `style`. */
function styleProps(e: Emit, props: string[], style: Record<string, string>, root: boolean, extra: string[] = []): void {
  const existing = props.findIndex((p) => p.startsWith('className='));
  const named: string[] = existing >= 0 ? [JSON.parse(props.splice(existing, 1)[0]!.slice('className='.length)) as string] : [];
  let inline: Record<string, string> = style;
  if (e.mode === 'tailwind') {
    const bound: Record<string, string> = {};
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries(style)) (v.startsWith('$') ? bound : plain)[k] = v;
    const { classes, rest } = styleToTailwind(plain);
    named.push(...classes, ...extra);
    inline = { ...rest, ...bound };
  }
  if (root) {
    props.push(named.length ? `className={[${js(named.join(' '))}, className].filter(Boolean).join(' ')}` : 'className={className}');
    props.push(Object.keys(inline).length ? `style={{ ${styleLiteral(inline).slice(3, -3)}, ...style }}` : 'style={style}');
    return;
  }
  if (named.length) props.push(`className=${js(named.join(' '))}`);
  if (Object.keys(inline).length) props.push(`style=${styleLiteral(inline)}`);
}

function open(tag: string, props: string[], pad: string): string {
  return `${pad}<${tag}${props.length ? ` ${props.join(' ')}` : ''}`;
}

/** One expression for a bound prop, for use as a value or a child. */
function boundValue(b: { name: string; fallback?: string }): string {
  return b.fallback !== undefined ? `${b.name} ?? ${b.fallback}` : b.name;
}

function layerJsx(e: Emit, id: string, depth: number, root: boolean): string {
  const { doc } = e;
  const stored = doc.rawNode(id);
  if (!stored) return '';
  const raw = e.data?.unhide === id ? { ...stored, hidden: false } : stored;
  if (raw.instanceOf !== undefined) return usage(e, raw, depth);
  const pad = '  '.repeat(depth);
  if (raw.code) return codeUsageJsx(raw.code, pad);
  const pathKey = root ? '' : id;
  const item = e.data?.item;
  const marked = (v: string | undefined) => Boolean(item && v && v.includes('{{'));
  const dataBind = (field: string): { name: string } | undefined => {
    if (!item) return undefined;
    if (field === 'text' && raw.type === 'text' && marked(raw.text) && !raw.spans?.length) return { name: `$jsx:${placeholderJsx(raw.text!, item)}` };
    if (field === 'src' && marked(raw.src)) return { name: placeholderExpr(raw.src!, item) };
    if (field === 'visible' && raw.attrs?.[BIND_VISIBLE]) return { name: fieldAccess(item, raw.attrs[BIND_VISIBLE]!.trim()) };
    if (field.startsWith('style.') && marked(raw.style[field.slice(6)])) return { name: placeholderExpr(raw.style[field.slice(6)]!, item) };
    if (field.startsWith('attr.') && marked(raw.attrs?.[field.slice(5)])) return { name: placeholderExpr(raw.attrs![field.slice(5)]!, item) };
    return undefined;
  };
  const bind = (field: string) => e.bound.get(`${pathKey}#${field}`) ?? dataBind(field);
  const showing = bind('visible');
  const hiding = bind('hidden');
  const src = bind('src');
  // An image whose src is a prop is an image, even when the main shows a placeholder.
  const shown = src && raw.type === 'image' && (!raw.src || marked(raw.src)) ? { ...raw, src: '#' } : raw;
  const spec = renderSpec(showing || hiding ? { ...shown, hidden: false } : shown, e.resolve);
  const style = { ...spec.style };
  // Where a layer sits on the canvas is not part of it, as in toJsx.
  if (root || id === e.pageRoot) for (const k of POSITION) delete style[k];
  if (id === e.pageRoot) {
    // A page handed to code is as wide as the window, up to its design width.
    const fluid = fluidPageStyle(raw, style);
    for (const k of Object.keys(style)) if (!(k in fluid)) delete style[k];
    Object.assign(style, fluid);
  }
  for (const key of e.bound.keys()) {
    if (!key.startsWith(`${pathKey}#style.`)) continue;
    style[key.slice(pathKey.length + 7)] = `$${boundValue(e.bound.get(key)!)}`;
  }
  const attrs = { ...spec.attrs };
  delete attrs[BIND_VISIBLE];
  delete attrs[BIND_VARIANT];
  if (item) {
    for (const k of Object.keys(raw.style)) if (marked(raw.style[k])) style[k] = `$${dataBind(`style.${k}`)!.name}`;
  }
  const moved = applyMotion(raw, e.motion?.layers.get(id), spec.tag, style, attrs);
  if (raw.rules && !moved.node.rules) attrs.class = withRuleClasses(attrs.class, raw.id, { classes: [], dropScope: true }) ?? '';
  if (!attrs.class) delete attrs.class;
  spec.tag = moved.tag;
  addRules(e, moved.node, attrs, style);
  const props: string[] = [];
  if (item) {
    for (const [k, v] of Object.entries(raw.attrs ?? {})) {
      if (k === BIND_VISIBLE || k === BIND_VARIANT || !marked(v)) continue;
      delete attrs[k];
      props.push(`${ATTR_RENAMES[k] ?? k}={${placeholderExpr(v, item)}}`);
    }
  }
  if (e.data?.key) props.push(`key={${e.data.key}}`);
  for (const key of e.bound.keys()) {
    if (!key.startsWith(`${pathKey}#attr.`)) continue;
    const name = key.slice(pathKey.length + 6);
    delete attrs[name];
    props.push(`${ATTR_RENAMES[name] ?? name}={${boundValue(e.bound.get(key)!)}}`);
  }
  if (src) {
    delete attrs.src;
    props.push(`src={${boundValue(src)}}`);
  }
  props.unshift(...propsOf(attrs));
  styleProps(e, props, style, root, e.mode === 'tailwind' ? preflightClasses(doc, raw, style, id === e.pageRoot) : []);
  props.push(...moved.props);
  const start = open(spec.tag, props, pad);
  const slot = e.slots.get(root ? '.' : id);
  const kids = doc.rawKids(id).filter((k) => !e.data?.plan.copies.has(k));
  let out: string;
  const text = bind('text');
  if (text?.name.startsWith('$jsx:')) out = `${start}>${text.name.slice(5)}</${spec.tag}>`;
  else if (text) out = `${start}>{${boundValue(text)}}</${spec.tag}>`;
  else if (spec.html !== undefined) out = `${start} dangerouslySetInnerHTML={{ __html: ${js(spec.html)} }} />`;
  else if (VOID.has(spec.tag)) out = `${start} />`;
  else if (spec.text !== undefined) out = `${start}>${jsxText(spec.text)}</${spec.tag}>`;
  else if (slot) {
    const defaults = kids.map((k) => layerJsx(e, k, depth + 2, false)).filter(Boolean).join('\n');
    out = defaults ? `${start}>\n${pad}  {${slot} ?? (\n${pad}    <>\n${kids.map((k) => layerJsx(e, k, depth + 3, false)).filter(Boolean).join('\n')}\n${pad}    </>\n${pad}  )}\n${pad}</${spec.tag}>` : `${start}>{${slot}}</${spec.tag}>`;
  } else if (!kids.length) out = `${start} />`;
  else out = `${start}>\n${kids.map((k) => childJsx(e, k, depth + 1)).filter(Boolean).join('\n')}\n${pad}</${spec.tag}>`;
  if (showing) return `${pad}{(${boundValue(showing)}) && (\n${out.replace(/^/gm, '  ')}\n${pad})}`;
  if (hiding) return `${pad}{!(${boundValue(hiding)}) && (\n${out.replace(/^/gm, '  ')}\n${pad})}`;
  return out;
}

/** A child, or for a repeat's template the code that maps its data. Its copies are the data, so they stay out. */
function childJsx(e: Emit, id: string, depth: number): string {
  const inner = e.data?.key ? { ...e, data: { ...e.data, key: undefined } } : e;
  const t = e.data && !e.data.item ? e.data.plan.templates.get(id) : undefined;
  if (!t || !e.data) return layerJsx(inner, id, depth, false);
  e.data.used.add(id);
  const pad = '  '.repeat(depth);
  const shown = (data: JsxData) => ({ ...e, data: { ...data, unhide: id } });
  if (t.single) return layerJsx(shown({ ...e.data, item: t.list }), id, depth, false);
  return `${pad}{${t.list}.map((item, i) => (\n${layerJsx(shown({ ...e.data, item: 'item', key: 'i' }), id, depth + 1, false)}\n${pad}))}`;
}

/** A layer's pseudo-elements and conditions: classes on its attributes, and CSS for the rest. */
function addRules(e: Emit, node: BogenNode, attrs: Record<string, string>, style: Record<string, string>): void {
  if (!node.rules) return;
  const rules = jsxRules(node, e.mode, e.mode === 'tailwind' ? styleToTailwind(style).rest : style);
  e.css.push(rules.css);
  const className = withRuleClasses(attrs.class, node.id, rules);
  if (className) attrs.class = className;
  else delete attrs.class;
}

/** The whole tree of a layer as it looks now, for an instance that props alone cannot describe. */
function expanded(e: Emit, id: string, depth: number, root = false): string {
  const { doc } = e;
  const node = doc.getNode(id);
  if (!node) return '';
  const pad = '  '.repeat(depth);
  const spec = renderSpec(node, e.resolve);
  const style = { ...spec.style };
  if (root) for (const k of ['left', 'top', 'right', 'bottom']) if (style[k] === undefined) delete style[k];
  const moved = applyMotion(node, e.motion?.layers.get(id), spec.tag, style, spec.attrs);
  spec.tag = moved.tag;
  addRules(e, moved.node, spec.attrs, style);
  const props = propsOf(spec.attrs);
  styleProps(e, props, style, false, e.mode === 'tailwind' ? preflightClasses(doc, node, style, false) : []);
  props.push(...moved.props);
  const start = open(spec.tag, props, pad);
  if (spec.html !== undefined) return `${start} dangerouslySetInnerHTML={{ __html: ${js(spec.html)} }} />`;
  if (VOID.has(spec.tag)) return `${start} />`;
  if (spec.text !== undefined) return `${start}>${jsxText(spec.text)}</${spec.tag}>`;
  const kids = doc.getChildren(id);
  if (!kids.length) return `${start} />`;
  return `${start}>\n${kids.map((k) => expanded(e, k.id, depth + 1)).join('\n')}\n${pad}</${spec.tag}>`;
}

function usage(e: Emit, raw: BogenNode, depth: number): string {
  const { doc } = e;
  const pad = '  '.repeat(depth);
  const main = doc.rawNode(raw.instanceOf!);
  if (main?.code) return codeUsageJsx(doc.getNode(raw.id)?.code ?? main.code, pad);
  const info = main && e.infos.get(main.id);
  const fills = doc.rawKids(raw.id).flatMap((k) => doc.rawNode(k) ?? []);
  const unsaid = Object.keys(raw.overrides ?? {}).filter((k) => !k.startsWith('#instanceOf'));
  // Which slot prop each fill goes to, or nothing for one that an inner instance holds.
  const here = main ? new Map(slotsOf(doc.source, main.id).map((s) => [s.path, info?.slotProps.get(s.name)])) : new Map<string, string | undefined>();
  const deepFill = info ? fills.some((f) => !here.get(f.slot ?? '')) : false;
  if (main && info?.handoff && !deepFill) return handoffUsage(e, raw, main, info, info.handoff, fills, here, unsaid.length, depth);
  if (!main || !info || unsaid.length || deepFill) {
    const why = !main || !info ? 'its main is gone' : unsaid.length ? `${unsaid.length} change${unsaid.length > 1 ? 's' : ''} on inner layers` : 'a filled inner slot';
    return `${pad}{/* ${raw.name}: written out in full, because of ${why}. */}\n${expanded(e, raw.id, depth, true)}`;
  }
  const attrs: string[] = [];
  const fromData = dataOnInstance(e, raw);
  const defaults = info.members[0]?.component?.variant ?? {};
  for (const [axis, value] of Object.entries(main.component?.variant ?? {})) {
    if (fromData.variants.has(axis)) attrs.push(`${camel(axis)}={${fromData.variants.get(axis)}}`);
    else if (defaults[axis] !== value) attrs.push(`${camel(axis)}=${js(value)}`);
  }
  for (const prop of info.props) {
    const name = camel(prop.name);
    const bound = e.bound.get(`${raw.id}#prop.${prop.name}`) ?? (fromData.props.has(prop.name) ? { name: fromData.props.get(prop.name)! } : undefined);
    if (bound) {
      attrs.push(`${name}={${boundValue(bound)}}`);
      continue;
    }
    const value = raw.props?.[prop.name];
    if (value === undefined) continue;
    attrs.push(value === true ? name : typeof value === 'boolean' ? `${name}={false}` : `${name}=${js(value)}`);
  }
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.style)) if (v !== '') own[k] = v;
  styleProps(e, attrs, own, false);
  const children = fills.filter((f) => here.get(f.slot ?? '') === 'children');
  for (const prop of info.slotProps.values()) {
    if (prop === 'children') continue;
    const filled = fills.filter((f) => here.get(f.slot ?? '') === prop);
    if (filled.length) attrs.push(`${prop}={<>\n${filled.map((f) => layerJsx(e, f.id, depth + 1, false)).join('\n')}\n${pad}</>}`);
  }
  const start = open(info.name, attrs, pad);
  if (!children.length) return withData(e, raw, `${start} />`, depth);
  return withData(e, raw, `${start}>\n${children.map((f) => layerJsx(e, f.id, depth + 1, false)).join('\n')}\n${pad}</${info.name}>`, depth);
}

/** What a record decides on an instance inside a template: props, variant axes and whether it shows. */
function dataOnInstance(e: Emit, raw: BogenNode): { props: Map<string, string>; variants: Map<string, string>; visible?: string } {
  const item = e.data?.item;
  const out = { props: new Map<string, string>(), variants: new Map<string, string>() } as ReturnType<typeof dataOnInstance>;
  if (!item) return out;
  for (const [k, v] of Object.entries(raw.props ?? {})) if (typeof v === 'string' && v.includes('{{')) out.props.set(k, placeholderExpr(v, item));
  for (const b of variantBindings(raw.attrs?.[BIND_VARIANT])) out.variants.set(b.axis, fieldAccess(item, b.field));
  if (raw.attrs?.[BIND_VISIBLE]) out.visible = fieldAccess(item, raw.attrs[BIND_VISIBLE]!.trim());
  return out;
}

function withData(e: Emit, raw: BogenNode, jsx: string, depth: number): string {
  const visible = dataOnInstance(e, raw).visible;
  const pad = '  '.repeat(depth);
  const keyed = e.data?.key ? jsx.replace(/^(\s*<[\w.]+)/m, `$1 key={${e.data.key}}`) : jsx;
  return visible ? `${pad}{${visible} && (\n${keyed.replace(/^/gm, '  ')}\n${pad})}` : keyed;
}

/** A usage of a code library's component, with its import, in that library's prop names. */
function handoffUsage(e: Emit, raw: BogenNode, main: BogenNode, info: ComponentInfo, h: CodeHandoff, fills: BogenNode[], here: Map<string, string | undefined>, unsaid: number, depth: number): string {
  const { doc } = e;
  const pad = '  '.repeat(depth);
  const attrs: string[] = [];
  const texts = new Map<string, string>();
  let childText: string | undefined;
  let dataChild: string | undefined;
  const codeName = (name: string) => (h.props && name in h.props ? h.props[name]! : camel(name));
  const defaults = h.defaults ?? info.members[0]?.component?.variant ?? {};
  const fromData = dataOnInstance(e, raw);
  for (const [axis, value] of Object.entries(main.component?.variant ?? {})) {
    const name = codeName(axis);
    if (name && fromData.variants.has(axis)) {
      attrs.push(`${name}={${fromData.variants.get(axis)}}`);
      continue;
    }
    const flag = h.flags?.[axis]?.[value];
    if (flag) attrs.push(flag);
    if (!name || defaults[axis] === value) continue;
    attrs.push(`${name}=${js(h.values?.[axis]?.[value] ?? value)}`);
  }
  for (const prop of info.props) {
    const name = codeName(prop.name);
    const expr = fromData.props.get(prop.name);
    if (expr && name) {
      if (name === 'children') dataChild = `{${expr}}`;
      else attrs.push(`${name}={${expr}}`);
      continue;
    }
    const bound = e.bound.get(`${raw.id}#prop.${prop.name}`);
    // The member's own prop, whose targets are its own layers: each member of a set may show its own text.
    const ownProp = main.component?.props?.find((p) => p.name === prop.name) ?? prop;
    const value = raw.props?.[prop.name] ?? (prop.type === 'text' ? memberDefault(doc, main, ownProp) : undefined);
    if (prop.type === 'text' && typeof value === 'string') texts.set(prop.name, value);
    if (!name) continue;
    if (name === 'children') {
      if (typeof value === 'string') childText = value;
      continue;
    }
    if (bound) {
      attrs.push(`${name}={${boundValue(bound)}}`);
      continue;
    }
    // A text prop is written with what the design shows, so a placeholder or a label is not lost in code.
    if (raw.props?.[prop.name] === undefined && !(prop.type === 'text' && typeof value === 'string' && value !== '')) continue;
    attrs.push(value === true ? name : typeof value === 'boolean' ? `${name}={false}` : `${name}=${js(String(value))}`);
  }
  const own: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.style)) if (v !== '' && !POSITION.includes(k)) own[k] = v;
  styleProps(e, attrs, own, false);
  if (h.element) jsxMarkupAttrs(attrs);
  const filled = fills.filter((f) => here.get(f.slot ?? '') !== undefined);
  if (dataChild) childText = undefined;
  const childJsx = filled.length ? filled.map((f) => layerJsx(e, f.id, depth + 1, false)).join('\n') : dataChild ? `${pad}  ${dataChild}` : childText !== undefined && childText !== '' ? `${pad}  ${jsxText(childText)}` : '';
  const note = unsaid ? `${pad}{/* ${raw.name}: ${unsaid} change${unsaid > 1 ? 's' : ''} on inner layers that these props do not say. */}\n` : '';
  if (h.usage) {
    const filledBody = (h.element ? jsxMarkup(h.usage) : h.usage)
      .replace(/\{\{\s*attrs\s*\}\}/g, attrs.length ? ` ${attrs.join(' ')}` : '')
      .replace(/\{\{\s*children\s*\}\}/g, filled.length ? `\n${childJsx}\n` : dataChild ?? (childText ? jsxText(childText) : ''))
      .replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, name: string) => {
        const expr = fromData.props.get(name);
        return expr ? `{${expr}}` : jsxText(texts.get(name) ?? '');
      });
    const body = h.element ? mergeClassAttrs(filledBody, 'className') : filledBody;
    return withData(e, raw, `${note}${body.split('\n').map((line) => (line.trim() ? `${pad}${line}` : line)).join('\n')}`, depth);
  }
  const tag = h.element ?? h.name;
  const opening = `${pad}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
  const start = h.element ? mergeClassAttrs(opening, 'className') : opening;
  // A custom element is never self-closing in HTML, so it is not in JSX either, to read the same as its docs.
  if (!childJsx) return withData(e, raw, `${note}${h.element && (h.element.includes('-') || !VOID.has(h.element)) ? `${start}></${tag}>` : `${start} />`}`, depth);
  if (!filled.length && dataChild) return withData(e, raw, `${note}${start}>${dataChild}</${tag}>`, depth);
  if (!filled.length && childText !== undefined && !childText.includes('\n')) return withData(e, raw, `${note}${start}>${jsxText(childText)}</${tag}>`, depth);
  return withData(e, raw, `${note}${start}>\n${childJsx}\n${pad}</${tag}>`, depth);
}

/** HTML attribute names in a markup handoff's usage, as JSX writes them. */
function jsxMarkup(usage: string): string {
  return usage.replace(/(\s)class="/g, '$1className="').replace(/(\s)for="/g, '$1htmlFor="').replace(/(\s)tabindex="/g, '$1tabIndex="');
}

/** A markup handoff's attributes as JSX: `class` as className, `for` as htmlFor, and a checked box as defaultChecked. */
function jsxMarkupAttrs(attrs: string[]): void {
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i]!;
    if (a.startsWith('class="')) attrs[i] = `className=${a.slice(6)}`;
    else if (a.startsWith('for="')) attrs[i] = `htmlFor=${a.slice(4)}`;
    else if (a === 'checked') attrs[i] = 'defaultChecked';
  }
}

function componentCode(e: Emit, info: ComponentInfo, extra: { css?: string; framer?: boolean } = {}): string {
  const { doc } = e;
  const first = info.members[0]!;
  const many = info.members.length > 1;
  const lines: string[] = [];
  const params: string[] = [];
  for (const { axis, values } of info.axes) {
    const name = camel(axis);
    lines.push(`  ${name}?: ${values.map((v) => js(v)).join(' | ')};`);
    params.push(`${name} = ${js(first.component?.variant?.[axis] ?? values[0]!)}`);
  }
  for (const prop of info.props) {
    const name = camel(prop.name);
    lines.push(`  ${name}?: ${typeOf(prop)};`);
    // In a set each member has its own default, so that one is written where it is used.
    params.push(many ? name : `${name} = ${literal(memberDefault(doc, first, prop))}`);
  }
  for (const prop of info.slotProps.values()) {
    lines.push(`  ${prop}?: ReactNode;`);
    params.push(prop);
  }
  lines.push('  className?: string;', '  style?: CSSProperties;');
  params.push('className', 'style');
  const body = (member: BogenNode, depth: number) => {
    const bound: Emit['bound'] = new Map();
    for (const prop of member.component?.props ?? []) {
      for (const target of prop.targets ?? []) {
        bound.set(`${target.path}#${target.field}`, { name: camel(prop.name), ...(many ? { fallback: literal(memberDefault(doc, member, prop)) } : {}) });
      }
    }
    const slots = new Map<string, string>();
    for (const slot of slotsOf(doc.source, member.id)) {
      const prop = info.slotProps.get(slot.name);
      if (prop) slots.set(slot.path, prop);
    }
    const css: string[] = [];
    // A component carries the CSS its own rules need, so that it works wherever it is used.
    const jsx = layerJsx({ ...e, bound, slots, css }, member.id, depth, true);
    if (extra.css) css.push(extra.css);
    const out = withRulesStyle(jsx, css, depth);
    return extra.framer ? withMotionConfig(out, depth) : out;
  };
  const out: string[] = [];
  out.push(`export interface ${info.name}Props {\n${lines.join('\n')}\n}`, '');
  if (first.component?.description) out.push(`/** ${first.component.description.replace(/\*\//g, '* /')} */`);
  out.push(`export function ${info.name}({ ${params.join(', ')} }: ${info.name}Props) {`);
  for (const member of info.members.slice(1)) {
    const conditions = Object.entries(member.component?.variant ?? {}).map(([axis, value]) => `${camel(axis)} === ${js(value)}`);
    if (!conditions.length) continue;
    out.push(`  if (${conditions.join(' && ')}) {\n    return (\n${body(member, 3)}\n    );\n  }`);
  }
  out.push(`  return (\n${body(first, 2)}\n  );\n}`);
  return out.join('\n');
}

/** Whether a layer's code involves components, and so comes from `toReact`. */
export function usesComponents(doc: BogenDoc, id: string): boolean {
  if (isVirtualId(id)) return false;
  const walk = (at: string): boolean => {
    const n = doc.source.raw(at);
    if (!n) return false;
    if (n.instanceOf !== undefined || (n.component && !n.code)) return true;
    return doc.source.rawKids(at).some(walk);
  };
  return walk(id);
}

/** A layer as a module: its components first, then the layer using them. */
export function toReact(doc: BogenDoc, id: string, mode: JsxMode = 'tailwind', resolve?: AssetResolver, motionMode: MotionMode = 'inline'): string {
  const node = doc.rawNode(id);
  if (!node || !usesComponents(doc, id)) return toJsx(doc, id, mode, resolve, motionMode);
  const mains = collect(doc, id);
  const infos = buildInfos(doc, mains);
  const motion = motionHandoff(doc, [id, ...mains.map((m) => m.id)], motionMode);
  const framer = motion.mode === 'framer' && motion.layers.size > 0;
  const base: Emit = { doc, mode, resolve, infos, bound: new Map(), slots: new Map(), css: [], motion, data: { plan: repeatPlan(doc), used: new Set() }, ...(node.component ? {} : { pageRoot: id }) };
  const handoffs = [...new Set([...infos.values()].filter((i) => i.handoff))];
  const own = [...infos.values()].filter((i) => !i.handoff);
  // Only the types the code uses: a project with noUnusedLocals, as Vite's template has, fails on the others.
  const types = own.length ? ['CSSProperties', ...(own.some((i) => i.slotProps.size) ? ['ReactNode'] : [])] : [];
  const blocks: string[] = [[...(types.length ? [`import type { ${types.join(', ')} } from 'react';`] : []), ...(framer ? [FRAMER_IMPORT] : []), ...handoffImportLines(handoffs.map((i) => i.handoff!)), ...codeImportLines(doc, [id, ...mains.map((m) => m.id)])].join('\n')];
  const done = new Set<string>();
  const rootKey = node.component ? infos.get(id)?.key : undefined;
  for (const main of mains) {
    const info = infos.get(main.id)!;
    if (done.has(info.key) || info.handoff) continue;
    done.add(info.key);
    blocks.push(componentCode(base, info, info.key === rootKey ? { css: motion.css, framer } : {}));
  }
  if (!node.component) {
    const taken = new Set([...infos.values()].map((i) => i.name));
    let name = pascal(node.name);
    if (taken.has(name)) name = `${name}Example`;
    const css: string[] = [];
    const body = node.instanceOf !== undefined ? usage({ ...base, css }, { ...node, style: Object.fromEntries(Object.entries(node.style).filter(([k]) => !POSITION.includes(k))) }, 2) : layerJsx({ ...base, css }, id, 2, false);
    if (motion.css) css.push(motion.css);
    const styled = withRulesStyle(body, css, 2);
    blocks.push(`export function ${name}() {\n  return (\n${framer ? withMotionConfig(styled, 2) : styled}\n  );\n}`);
  }
  else if (infos.get(id)?.handoff) {
    // A kit's main: how code uses it, since the component itself lives in the code library.
    const info = infos.get(id)!;
    const body = handoffUsage(base, { ...node, style: {}, props: {}, overrides: {} }, node, info, info.handoff!, [], new Map(), 0, 2);
    blocks.push(`export function ${pascal(node.name)}Example() {\n  return (\n${body}\n  );\n}`);
  }
  const declarations = dataDeclarations(base.data!.plan, base.data!.used);
  if (declarations) blocks.splice(blocks.length - 1, 0, declarations);
  return `${blocks.join('\n\n')}\n`;
}

/** The classes code from this file refers to. */
export function textStyleCssFor(doc: BogenDoc, code: string): string {
  const used = getTextStyles(doc).filter((s) => code.includes(`ts-${s.key}`));
  return used.length ? textStylesCss(used, '', true) : '';
}

/** For the other code exports (sfc-export.ts, swiftui-export.ts): the mains a layer's code needs, and the component of each set. */
export { collect as componentMainsFor, buildInfos as componentInfosFor, memberDefault as propDefaultFor };
export type { ComponentInfo as CodeComponentInfo };
