import { selectAll } from 'css-select';
import type { BogenDoc } from './doc.ts';

/** One object per layer or page id, as css-select keeps some state in WeakMaps keyed by node. */
interface Ref { id: string }

/** css-select's adapter; its package exports the type only through selectAll's options. */
type Adapter = NonNullable<NonNullable<Parameters<typeof selectAll<Ref, Ref>>[2]>['adapter']>;

/**
 * CSS selectors over the layer tree, as a browser would match them against the rendered HTML: tags, attributes,
 * structure (`section > h2`, `:first-child`, `:not(...)`, `:has(...)`) and `#id`. A layer's id answers `#id` unless the
 * layer has an HTML id attribute of its own. Pages are the roots, so `:root` and `body` do not match; an artboard is
 * a child of its page.
 */
function adapter(doc: BogenDoc, ref: (id: string) => Ref): Adapter {
  const children = (id: string) => doc.getChildren(id).map((c) => ref(c.id));
  const attr = (r: Ref, name: string): string | undefined => {
    const node = doc.getNode(r.id);
    if (!node) return undefined;
    const own = node.attrs?.[name];
    if (own !== undefined) return own;
    if (name === 'id') return node.id;
    if (name === 'src') return node.src;
    return undefined;
  };
  return {
    isTag: (r: Ref): r is Ref => !doc.pages.has(r.id) && doc.getNode(r.id) !== undefined,
    getAttributeValue: attr,
    hasAttrib: (r, name) => attr(r, name) !== undefined,
    getChildren: (r) => children(r.id),
    getName: (r) => doc.getNode(r.id)?.tag ?? '',
    getParent: (r) => {
      const parent = doc.getNode(r.id)?.parent;
      return parent ? ref(parent) : null;
    },
    getSiblings: (r) => {
      const parent = doc.getNode(r.id)?.parent;
      return parent ? children(parent) : [r];
    },
    getText: (r) => {
      const node = doc.getNode(r.id);
      if (!node) return '';
      return [node.text ?? '', ...doc.descendants(r.id).map((d) => d.text ?? '')].join('');
    },
    removeSubsets: (nodes: Ref[]) => {
      const set = new Set(nodes.map((n) => n.id));
      return [...set].filter((id) => !doc.ancestors(id).some((a) => set.has(a))).map(ref);
    },
    equals: (a, b) => a.id === b.id,
  };
}

/**
 * The layers under `roots` (pages or layers, the whole file by default) that match `selector`, in tree order.
 * Throws with the parser's message for a selector that does not parse.
 */
export function selectLayers(doc: BogenDoc, selector: string, roots?: readonly string[]): string[] {
  const refs = new Map<string, Ref>();
  const ref = (id: string) => {
    let r = refs.get(id);
    if (!r) refs.set(id, (r = { id }));
    return r;
  };
  const from = roots?.length ? [...roots] : doc.getPages().map((p) => p.id);
  // css-select walks down from the layers it is given and tests them too, so it starts at the roots' children.
  const start = from.flatMap((id) => doc.getChildren(id).map((c) => ref(c.id)));
  return start.length ? selectAll<Ref, Ref>(selector, start, { adapter: adapter(doc, ref), xmlMode: false }).map((r) => r.id) : [];
}
