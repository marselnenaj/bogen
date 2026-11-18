import { createComponent, instanceSpec, overrideKey, type BogenDoc, type BogenNode, type PropValue } from '@bogen/core';

/**
 * What a page repeats, such as the rows of a list or the cards of a grid, comes from one component in its code. A
 * capture gets that back: the first of each repeat becomes a component, the others its instances, with what differs
 * between them (words, pictures, names, attributes, positions) as overrides. Changing the main then changes every row,
 * as it would in the page's code. Only layers that match exactly apart from those are joined.
 */

/** Kept out of the comparison: where a layer sits says nothing about what it is. */
const PLACE = new Set(['left', 'top', 'right', 'bottom', 'position', 'zIndex']);
/** The same thresholds as design_lint's repeated structure check, so that what it would report is what is joined. */
const MIN_LAYERS = 2;
const LARGE = 6;
const MAX_ROUNDS = 400;

interface Group { nodes: BogenNode[]; size: number }

function groupsUnder(doc: BogenDoc, rootId: string, skip: ReadonlySet<string>): Group[] {
  const groups = new Map<string, Group>();
  // Each shape gets a short number, so that a parent's key names its children's shapes instead of repeating them.
  const shapes = new Map<string, number>();
  const shape = (key: string) => {
    let n = shapes.get(key);
    if (n === undefined) shapes.set(key, n = shapes.size);
    return String(n);
  };
  const signature = (id: string): { key: string; size: number } | null => {
    const n = doc.source.raw(id);
    if (!n || n.instanceOf !== undefined || n.component || skip.has(id)) return null;
    const kids = doc.source.rawKids(id).map(signature);
    if (kids.some((k) => k === null)) return null;
    const style = Object.entries(n.style).filter(([k]) => !PLACE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(';') + (n.rules ? JSON.stringify(n.rules) : '');
    const size = 1 + kids.reduce((sum, k) => sum + k!.size, 0);
    const key = shape(`${n.type}<${n.tag}>{${style}}[${kids.map((k) => k!.key).join(',')}]`);
    if (kids.length) {
      const group = groups.get(key) ?? { nodes: [], size };
      group.nodes.push(n);
      groups.set(key, group);
    }
    return { key, size };
  };
  for (const kid of doc.source.rawKids(rootId)) signature(kid);
  return [...groups.values()].filter((g) => g.nodes.length >= 2 && g.size > MIN_LAYERS
    && (g.nodes.length >= 3 || g.size >= LARGE || new Set(g.nodes.map((n) => n.parent)).size < g.nodes.length));
}

/** The overrides that turn the main into this copy, or null when the copy differs in something an override cannot say. */
function overridesFor(doc: BogenDoc, main: BogenNode, copy: BogenNode): { style: Record<string, string>; overrides: Record<string, PropValue> } | null {
  const overrides: Record<string, PropValue> = {};
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(copy.style)) if (PLACE.has(k)) style[k] = v;
  const walk = (m: BogenNode, c: BogenNode, path: string): boolean => {
    const set = (field: string, value: PropValue) => { overrides[overrideKey(path, field)] = value; };
    if ((m.spans || c.spans) && (JSON.stringify(m.spans) !== JSON.stringify(c.spans))) return false;
    if (m.proto || c.proto || m.slotName !== undefined || c.slotName !== undefined || m.textStyle !== c.textStyle || m.mode !== c.mode || Boolean(m.locked) !== Boolean(c.locked)) return false;
    if (path) {
      for (const k of new Set([...Object.keys(m.style), ...Object.keys(c.style)])) {
        if (!PLACE.has(k) || m.style[k] === c.style[k]) continue;
        set(`style.${k}`, c.style[k] ?? '');
      }
      if (m.name !== c.name) set('name', c.name);
    }
    if (m.text !== c.text) {
      if (c.text === undefined) return false;
      set('text', c.text);
    }
    for (const field of ['src', 'svg'] as const) {
      if (m[field] === c[field]) continue;
      if (c[field] === undefined) return false;
      set(field, c[field]!);
    }
    if (Boolean(m.hidden) !== Boolean(c.hidden)) set('hidden', Boolean(c.hidden));
    const ma = m.attrs ?? {}, ca = c.attrs ?? {};
    for (const k of new Set([...Object.keys(ma), ...Object.keys(ca)])) {
      if (ma[k] === ca[k]) continue;
      set(`attr.${k}`, ca[k] === undefined ? false : ca[k]!);
    }
    const mk = doc.source.rawKids(m.id), ck = doc.source.rawKids(c.id);
    if (mk.length !== ck.length) return false;
    return mk.every((id, i) => walk(doc.source.raw(id)!, doc.source.raw(ck[i]!)!, id));
  };
  return walk(main, copy, '') ? { style, overrides } : null;
}

/**
 * Joins the repeats under a captured artboard into components. `keep` are layers that must stay as they are. Returns
 * which layer became which instance, so that what refers to a copy can refer to its instance instead.
 */
export function componentsFromRepeats(doc: BogenDoc, rootId: string, keep: ReadonlySet<string> = new Set(), origin?: unknown): Map<string, string> {
  const joined = new Map<string, string>();
  const tried = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const groups = groupsUnder(doc, rootId, keep).filter((g) => !tried.has(g.nodes[0]!.id));
    if (!groups.length) break;
    // The biggest repeat first: a card that repeats takes its title along, so the title needs no component of its own.
    const group = groups.sort((a, b) => b.size * b.nodes.length - a.size * a.nodes.length)[0]!;
    const main = group.nodes[0]!;
    tried.add(main.id);
    const plans = group.nodes.slice(1).map((copy) => ({ copy, plan: overridesFor(doc, main, copy) }))
      .filter((p): p is { copy: BogenNode; plan: NonNullable<ReturnType<typeof overridesFor>> } => p.plan !== null);
    if (!plans.length) continue;
    doc.transact(() => {
      createComponent(doc, main.id, { name: main.name });
      for (const { copy, plan } of plans) {
        const index = doc.source.rawKids(copy.parent).indexOf(copy.id);
        const instance = doc.insert(copy.parent, instanceSpec(doc, main.id, { name: copy.name, style: plan.style, ...(Object.keys(plan.overrides).length ? { overrides: plan.overrides } : {}) }), index, origin);
        doc.delete([copy.id], origin);
        joined.set(copy.id, instance);
      }
    }, origin);
  }
  return joined;
}
