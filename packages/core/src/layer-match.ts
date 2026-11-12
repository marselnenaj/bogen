import type { BogenDoc, BogenNode } from './doc.ts';

/**
 * Layers that match: the same kind of layer with the same look, wherever it is and whatever it says.
 * Position, size and the words of a text do not count; type, element, component, text style, the rest of
 * the style and the shape of what is inside (two levels deep) do.
 */

const PLACE = new Set([
  'position', 'left', 'top', 'right', 'bottom', 'inset', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'transform', 'translate', 'rotate', 'zIndex', 'order', 'gridColumn', 'gridRow', 'gridArea', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
]);

function looks(n: BogenNode): string {
  const style = Object.keys(n.style).filter((k) => !PLACE.has(k)).sort().map((k) => `${k}:${n.style[k]}`).join(';');
  return [n.type, n.tag, n.instanceOf ?? '', n.textStyle ?? '', n.src && n.type !== 'image' ? n.src : '', style].join('|');
}

/** What two layers must share to match. */
export function matchSignature(doc: BogenDoc, id: string, depth = 2, memo?: Map<string, string>): string {
  const key = `${depth}:${id}`;
  const known = memo?.get(key);
  if (known !== undefined) return known;
  const n = doc.getNode(id);
  if (!n) return '';
  const kids = doc.getChildren(id);
  const inner = depth > 0 ? kids.map((k) => matchSignature(doc, k.id, depth - 1, memo)).join(',') : String(kids.length);
  const out = `${looks(n)}[${inner}]`;
  memo?.set(key, out);
  return out;
}

/** Layers on the page of each given layer that match it, including the given ones, in layer order. Hidden layers are left out. */
export function matchingLayers(doc: BogenDoc, ids: readonly string[], options: { within?: string } = {}): string[] {
  const memo = new Map<string, string>();
  const wanted = new Map<string, Set<string>>();
  for (const id of ids) {
    const page = options.within ?? doc.pageOf(id);
    if (!page) continue;
    let set = wanted.get(page);
    if (!set) wanted.set(page, (set = new Set()));
    set.add(matchSignature(doc, id, 2, memo));
  }
  const out: string[] = [];
  for (const [root, signatures] of wanted) {
    const visit = (parent: string) => {
      for (const n of doc.getChildren(parent)) {
        if (n.hidden) continue;
        if (signatures.has(matchSignature(doc, n.id, 2, memo))) out.push(n.id);
        // An instance's inside is computed: selecting its parts is not what matching is for.
        if (n.instanceOf === undefined) visit(n.id);
      }
    };
    visit(root);
  }
  return out;
}
