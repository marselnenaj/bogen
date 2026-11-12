import type { NewNode } from './doc.ts';

/**
 * Names for layers nobody named, from what a person would call them: the role or element, then the
 * class, then the words inside. Explicit names always win; these only replace generic ones.
 */
const GENERIC = /^(frame|group|div|span|box|container|wrapper|layer|text|rectangle|ellipse|item|list|section|article|link|button|main|header|footer|navigation|sidebar|form|table|row|column|grid|before|after)( \d+)?$/i;

export function isGenericName(name: string | undefined): boolean {
  const n = (name ?? '').trim();
  return !n || GENERIC.test(n);
}

const ROLE_NAMES: Record<string, string> = { navigation: 'Navigation', banner: 'Header', main: 'Main', contentinfo: 'Footer', button: 'Button', link: 'Link', dialog: 'Dialog', alertdialog: 'Dialog', tablist: 'Tabs', tab: 'Tab', tabpanel: 'Tab panel', menu: 'Menu', menuitem: 'Menu item', list: 'List', listitem: 'Item', search: 'Search', form: 'Form', img: 'Image', heading: 'Heading', region: 'Section', complementary: 'Sidebar', checkbox: 'Checkbox', switch: 'Switch', radio: 'Radio', slider: 'Slider', textbox: 'Input', tooltip: 'Tooltip', alert: 'Alert', status: 'Status', progressbar: 'Progress', table: 'Table', row: 'Row', cell: 'Cell', article: 'Article', group: 'Group', toolbar: 'Toolbar' };
const TAG_NAMES: Record<string, string> = { nav: 'Navigation', header: 'Header', footer: 'Footer', section: 'Section', main: 'Main', aside: 'Sidebar', article: 'Article', ul: 'List', ol: 'List', li: 'Item', button: 'Button', a: 'Link', form: 'Form', table: 'Table', thead: 'Table head', tbody: 'Table body', tr: 'Row', td: 'Cell', th: 'Header cell', figure: 'Figure', figcaption: 'Caption', details: 'Details', summary: 'Summary', label: 'Label', input: 'Input', textarea: 'Text area', select: 'Select', hr: 'Divider', blockquote: 'Quote', dl: 'List', dt: 'Term', dd: 'Definition', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', video: 'Video', iframe: 'Embed', img: 'Image', svg: 'Vector', p: 'Text' };

/** Classes that describe styling or a build tool, not the thing itself. */
const UTILITY = /^(css-|sc-|jsx-|svelte-|astro-|emotion-|chakra-|mui-|ant-|tw-|_|[a-z]{1,3}$|[a-z]{1,3}\d+$|(?:[a-z]+:)|(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|container|wrapper|inner|outer|content|row|col|column|clearfix|w-|h-|p[xytrbl]?-|m[xytrbl]?-|gap-|text-|bg-|border|rounded|shadow|font-|leading-|tracking-|items-|justify-|self-|space-|min-|max-|overflow-|opacity-|z-|top-|left-|right-|bottom-|inset-|grow|shrink|basis-|order-|col-|row-|aspect-|object-|transition|duration-|ease-|transform|scale-|rotate-|translate-|cursor-|select-|underline|uppercase|lowercase|capitalize|truncate|sr-only|not-|group|peer))/;
const HASHED = /\d{3,}|[A-Z].*[a-z0-9].*[A-Z0-9]{2,}|^(?=.*\d)[a-zA-Z0-9]{6,}$/;

function humanize(cls: string): string {
  const words = cls.replace(/__|--/g, ' ').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}

/** The first class that reads like a name, as words. */
export function nameFromClass(className: string | undefined): string | null {
  for (const cls of (className ?? '').split(/\s+/)) {
    if (!cls || cls.length > 40 || UTILITY.test(cls) || HASHED.test(cls)) continue;
    const name = humanize(cls);
    if (name.length >= 3) return name;
  }
  return null;
}

function excerpt(text: string | undefined, size = 32): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  if (flat.length <= size) return flat;
  const cut = flat.slice(0, size);
  const space = cut.lastIndexOf(' ');
  return `${(space > size / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface NameInput {
  type: string;
  tag?: string;
  name?: string;
  text?: string;
  /** The first words inside, for layers with children. */
  firstText?: string;
  attrs?: Record<string, string>;
  style?: Record<string, string>;
  childCount?: number;
}

export function autoLayerName(n: NameInput): string {
  const tag = (n.tag ?? '').toLowerCase();
  const attrs = n.attrs ?? {};
  const label = attrs['aria-label']?.trim() || attrs.title?.trim();
  if (n.type === 'image') return label || attrs.alt?.trim() || 'Image';
  if (n.type === 'video') return label || 'Video';
  if (n.type === 'embed') return label || 'Embed';
  if (n.type === 'shader') return n.name?.trim() || 'Shader';
  if (n.type === 'svg') return label || (n.name && !isGenericName(n.name) ? n.name : 'Vector');
  if (n.type === 'text') return excerpt(n.text) || (TAG_NAMES[tag] ?? 'Text');
  if (label) return label;
  const role = ROLE_NAMES[(attrs.role ?? '').toLowerCase()];
  const semantic = role ?? TAG_NAMES[tag];
  const words = excerpt(n.firstText, 28);
  const cls = nameFromClass(attrs.class);
  if (semantic) {
    if ((tag === 'a' || tag === 'button' || role === 'Button' || role === 'Link' || tag === 'li' || tag === 'section' || tag === 'article') && words) return `${semantic}: ${words}`;
    return cls && !['ul', 'ol', 'li'].includes(tag) ? `${semantic}: ${cls}` : semantic;
  }
  if (cls) return cls;
  const display = n.style?.display ?? '';
  const layout = /grid/.test(display) ? 'Grid' : /flex/.test(display) ? ((n.style?.flexDirection ?? 'row').startsWith('column') ? 'Column' : 'Row') : (n.style?.borderRadius === '50%' && !n.childCount ? 'Ellipse' : n.childCount ? 'Group' : 'Rectangle');
  return words ? `${layout}: ${words}` : layout;
}

function firstTextOf(spec: NewNode): string | undefined {
  if (spec.text?.trim()) return spec.text;
  for (const c of spec.children ?? []) {
    const t = firstTextOf(c);
    if (t) return t;
  }
  return undefined;
}

/**
 * Replaces generic names in a tree about to be inserted. Artboards and named layers stay. With
 * `rawClasses`, a name that is really a class of the page (from a Capture) becomes words too.
 */
export function nameSpecTree(spec: NewNode, rawClasses = false, given?: WeakSet<NewNode>): NewNode {
  const children = spec.children?.map((c) => nameSpecTree(c, rawClasses, given));
  let name = spec.name;
  if (!spec.artboard && spec.type === 'frame' && !given?.has(spec)) {
    const raw = rawClasses && /^[a-z_][\w-]*$/.test(name ?? '');
    const fromClass = raw ? nameFromClass(name) : null;
    if (fromClass) name = fromClass;
    else if (raw || isGenericName(name)) name = autoLayerName({ type: spec.type, tag: spec.tag, name, firstText: firstTextOf(spec), attrs: spec.attrs, style: spec.style, childCount: spec.children?.length ?? 0 });
  }
  return { ...spec, ...(name ? { name } : {}), ...(children ? { children } : {}) };
}
