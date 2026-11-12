import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BogenDoc, addVariant, applyTextStyle, createComponent, createInstance, createMode, deleteMode, deleteTextStyle, designSystemCss, detachInstance, effectiveMode, exportDocument, getModes, getTextStyles,
  importHtml, instanceControls, listOverrides, nodeToHtml, renameToken, resetAllOverrides, resetOverride, resolveInstanceRefs, safeCssValue, setInstanceProps, setOverride, setPageMode, setSlot, setTextStyle, setTokenMode,
  slotsOf, textStylesCss, themeCss, toReact, tokensCss, updateComponent, usesComponents, codeImportLines,
} from '../src/index.ts';

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

/** A button main: a frame with a label and an icon. */
function button(doc: BogenDoc, page: string) {
  const main = doc.insert(page, {
    type: 'frame', tag: 'button', name: 'Button',
    style: { position: 'absolute', left: '500px', top: '40px', width: '160px', padding: '8px', backgroundColor: 'rgb(0, 0, 255)', display: 'flex' },
    children: [
      { type: 'text', tag: 'span', name: 'Label', text: 'Buy', style: { color: 'rgb(255, 255, 255)' } },
      { type: 'frame', tag: 'div', name: 'Icon', style: { width: '8px', height: '8px' } },
    ],
  });
  const [label, icon] = doc.getChildren(main).map((c) => c.id) as [string, string];
  createComponent(doc, main);
  return { main, label: label!, icon: icon! };
}

describe('instances are views of their main', () => {
  it('a main edit reaches all instances, on other pages too, and takes no writes', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const other = doc.createPage('Other');
    const a = createInstance(doc, main, page, { style: { position: 'absolute', left: '0px', top: '0px' } });
    const b = createInstance(doc, main, other, { style: { position: 'absolute', left: '0px', top: '0px' } });
    expect(nodeToHtml(doc, a)).toContain('Buy');
    const nodesBefore = doc.nodes.size;
    doc.updateFields(label, { text: 'Sale' });
    doc.updateStyle(main, { backgroundColor: 'rgb(255, 0, 0)' });
    expect(nodeToHtml(doc, a)).toContain('Sale');
    expect(nodeToHtml(doc, b)).toContain('Sale');
    expect(doc.getNode(b)?.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(doc.nodes.size).toBe(nodesBefore);
    expect(doc.getChildren(a).map((c) => c.id)).toEqual([`${a}/${label}`, `${a}/${doc.getChildren(main)[1]!.id}`]);
  });

  it('keeps its own place: the position of the main does not come along', () => {
    const { doc, page } = fresh();
    const { main } = button(doc, page);
    const a = createInstance(doc, main, page, { style: { position: 'absolute', left: '10px', top: '20px' } });
    const node = doc.getNode(a)!;
    expect(node.style.left).toBe('10px');
    const flow = createInstance(doc, main, doc.insert(page, { type: 'frame', style: { position: 'absolute', display: 'flex' } }));
    expect(doc.getNode(flow)!.style.left).toBeUndefined();
    expect(doc.getNode(flow)!.style.position).toBe('relative');
    expect(doc.getNode(flow)!.tag).toBe('button');
  });

  it('survives a sync to a peer, and both sides see the same', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    const peer = new BogenDoc(new Y.Doc());
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    expect(nodeToHtml(peer, a)).toContain('Buy');
    peer.updateFields(`${a}/${label}`, { text: 'Peer text' });
    Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(peer.y));
    expect(nodeToHtml(doc, a)).toContain('Peer text');
  });

  it('merges two peers changing different overrides of the same instance', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    const peer = new BogenDoc(new Y.Doc());
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    doc.updateFields(`${a}/${label}`, { text: 'Mine' });
    peer.updateStyle(`${a}/${label}`, { color: 'rgb(1, 2, 3)' });
    Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(peer.y));
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    for (const d of [doc, peer]) {
      expect(d.getNode(`${a}/${label}`)?.text).toBe('Mine');
      expect(d.getNode(`${a}/${label}`)?.style.color).toBe('rgb(1, 2, 3)');
    }
  });

  it('a document that multiplies instances stops expanding, and renders', () => {
    const { doc, page } = fresh();
    let next = doc.insert(page, { type: 'frame', name: 'Leaf', style: {} });
    createComponent(doc, next);
    for (let level = 0; level < 12; level++) {
      const up = doc.insert(page, { type: 'frame', name: `L${level}`, style: {} });
      for (let i = 0; i < 12; i++) createInstance(doc, next, up);
      createComponent(doc, up);
      next = up;
    }
    const start = performance.now();
    const html = nodeToHtml(doc, next);
    expect(html.length).toBeGreaterThan(100);
    expect(performance.now() - start).toBeLessThan(20_000);
  }, 40_000);

  it('a nested prop can be exposed by the outer component', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    updateComponent(doc, main, { props: [{ name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] }] });
    const bar = doc.insert(page, { type: 'frame', name: 'Bar', style: {} });
    const nested = createInstance(doc, main, bar);
    createComponent(doc, bar);
    updateComponent(doc, bar, { props: [{ name: 'title', type: 'text', targets: [{ path: nested, field: 'prop.label' }] }] });
    const a = createInstance(doc, bar, page, { props: { title: 'Through' } });
    expect(doc.getNode(`${a}/${nested}/${label}`)?.text).toBe('Through');
    const code = toReact(doc, bar, 'inline');
    expect(code).toContain('<Button label={title} />');
    expect(toReact(doc, a, 'inline')).toContain('<Bar title="Through"');
  });

  it('stops at a cycle', () => {
    const { doc, page } = fresh();
    const { main } = button(doc, page);
    // What two people could make at once, or a hostile file: a main holding its own instance.
    const self = doc.insert(main, { type: 'frame', name: 'Self', instanceOf: main, style: {} });
    const html = nodeToHtml(doc, main);
    expect(html.length).toBeLessThan(5000);
    expect(doc.getChildren(self).length).toBeGreaterThan(0);
    expect(() => createInstance(doc, main, main)).toThrow(/inside itself/);
  });

  it('does not let a stored override reach the markup unchecked', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const image = doc.insert(main, { type: 'image', tag: 'img', name: 'Pic', src: 'https://a.example/x.png', style: {} });
    const a = createInstance(doc, main, page);
    const overrides = doc.nodes.get(a)!.get('overrides') as Y.Map<unknown>;
    overrides.set(`${image}#src`, 'javascript:alert(1)');
    overrides.set(`${label}#tag`, 'script');
    overrides.set(`${label}#attr.onclick`, 'alert(1)');
    overrides.set(`${label}#text`, '<script>alert(1)</script>');
    overrides.set(`${label}#__proto__.polluted`, 'yes');
    const html = nodeToHtml(doc, a);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('overrides', () => {
  it('routes writes on a view to overrides, shows and resets them', () => {
    const { doc, page } = fresh();
    const { main, label, icon } = button(doc, page);
    const a = createInstance(doc, main, page);
    const view = `${a}/${label}`;
    doc.updateFields(view, { text: 'Only here' });
    doc.updateStyle(view, { color: 'rgb(9, 9, 9)' });
    doc.updateFields(`${a}/${icon}`, { hidden: true });
    expect(doc.rawNode(label)?.text).toBe('Buy');
    expect(doc.getNode(view)?.text).toBe('Only here');
    expect(nodeToHtml(doc, a)).toContain('display:none');
    const list = listOverrides(doc.source, a);
    expect(list.map((o) => o.field).sort()).toEqual(['hidden', 'style.color', 'text']);
    expect(listOverrides(doc.source, view).length).toBe(2);
    resetOverride(doc, a, list.find((o) => o.field === 'text')!.key);
    expect(doc.getNode(view)?.text).toBe('Buy');
    resetAllOverrides(doc, a);
    expect(listOverrides(doc.source, a)).toEqual([]);
    expect(doc.getNode(view)?.style.color).toBe('rgb(255, 255, 255)');
  });

  it('a value equal to the main is not an override, and a main edit shows through what is not overridden', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    doc.updateStyle(`${a}/${label}`, { color: 'rgb(255, 255, 255)' });
    expect(listOverrides(doc.source, a)).toEqual([]);
    doc.updateStyle(`${a}/${label}`, { fontSize: '20px' });
    doc.updateStyle(label, { color: 'rgb(0, 0, 0)', fontSize: '30px' });
    expect(doc.getNode(`${a}/${label}`)?.style.color).toBe('rgb(0, 0, 0)');
    expect(doc.getNode(`${a}/${label}`)?.style.fontSize).toBe('20px');
  });

  it('removes a value of the main on one instance', () => {
    const { doc, page } = fresh();
    const { main } = button(doc, page);
    const a = createInstance(doc, main, page);
    doc.updateStyle(a, { backgroundColor: null });
    expect(doc.getNode(a)?.style.backgroundColor).toBeUndefined();
    const overrides = listOverrides(doc.source, a);
    expect(overrides.map((o) => o.field)).toContain('style.backgroundColor');
    resetOverride(doc, a, overrides.find((o) => o.field === 'style.backgroundColor')!.key);
    expect(doc.getNode(a)?.style.backgroundColor).toBe('rgb(0, 0, 255)');
  });

  it('deleting a layer inside an instance hides it there', () => {
    const { doc, page } = fresh();
    const { main, icon } = button(doc, page);
    const a = createInstance(doc, main, page);
    doc.delete([`${a}/${icon}`]);
    expect(doc.getNode(`${a}/${icon}`)?.hidden).toBe(true);
    expect(doc.getNode(icon)?.hidden).toBeUndefined();
  });

  it('undo takes back one override through the undo manager', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    const undo = new Y.UndoManager([doc.nodes], { trackedOrigins: new Set(['me']), captureTimeout: 0 });
    doc.updateFields(`${a}/${label}`, { text: 'Changed' }, 'me');
    expect(doc.getNode(`${a}/${label}`)?.text).toBe('Changed');
    undo.undo();
    expect(doc.getNode(`${a}/${label}`)?.text).toBe('Buy');
    undo.redo();
    expect(doc.getNode(`${a}/${label}`)?.text).toBe('Changed');
  });

  it('detach makes ordinary layers that look the same, and undo links it again', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page, { style: { position: 'absolute', left: '7px', top: '8px' } });
    doc.updateFields(`${a}/${label}`, { text: 'Kept' });
    const before = nodeToHtml(doc, a);
    const undo = new Y.UndoManager([doc.nodes], { trackedOrigins: new Set(['me']), captureTimeout: 0 });
    detachInstance(doc, a, 'me');
    expect(doc.rawNode(a)?.instanceOf).toBeUndefined();
    expect(doc.getChildren(a)[0]?.text).toBe('Kept');
    expect(doc.getChildren(a).every((c) => !c.id.includes('/'))).toBe(true);
    doc.updateFields(label, { text: 'Later' });
    expect(nodeToHtml(doc, a)).toContain('Kept');
    // The same declarations, whichever order they are stored in.
    const strip = (h: string) => h.replace(/style="([^"]*)"/g, (_, css: string) => `style="${css.split(';').sort().join(';')}"`);
    expect(strip(nodeToHtml(doc, a))).toBe(strip(before));
    undo.undo();
    expect(doc.rawNode(a)?.instanceOf).toBe(main);
    expect(doc.getChildren(a)[0]?.id).toContain('/');
  });

  it('deleting a main leaves its instances looking as they did, and undo brings it all back', () => {
    const { doc, page } = fresh();
    const { main } = button(doc, page);
    const a = createInstance(doc, main, page);
    const undo = new Y.UndoManager([doc.nodes], { trackedOrigins: new Set(['me']), captureTimeout: 0 });
    doc.delete([main], 'me');
    expect(doc.getNode(main)).toBeUndefined();
    expect(doc.rawNode(a)?.instanceOf).toBeUndefined();
    expect(nodeToHtml(doc, a)).toContain('Buy');
    undo.undo();
    expect(doc.getNode(main)).toBeDefined();
    expect(doc.rawNode(a)?.instanceOf).toBe(main);
    expect(doc.getChildren(a)[0]?.text).toBe('Buy');
  });
});

describe('props, variants and slots', () => {
  it('text and boolean props drive their targets, and a main edit still reaches unset ones', () => {
    const { doc, page } = fresh();
    const { main, label, icon } = button(doc, page);
    updateComponent(doc, main, { props: [
      { name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] },
      { name: 'showIcon', type: 'boolean', targets: [{ path: icon, field: 'visible' }] },
    ] });
    const a = createInstance(doc, main, page);
    const b = createInstance(doc, main, page, { props: { label: 'From prop', showIcon: false } });
    expect(doc.getNode(`${b}/${label}`)?.text).toBe('From prop');
    expect(doc.getNode(`${b}/${icon}`)?.hidden).toBe(true);
    doc.updateFields(label, { text: 'New default' });
    expect(doc.getNode(`${a}/${label}`)?.text).toBe('New default');
    expect(doc.getNode(`${b}/${label}`)?.text).toBe('From prop');
    const controls = instanceControls(doc.source, a);
    expect(controls.find((c) => c.name === 'label')).toMatchObject({ type: 'text', value: 'New default', isSet: false });
    setInstanceProps(doc, a, { label: 'Set' });
    expect(doc.getNode(`${a}/${label}`)?.text).toBe('Set');
    setInstanceProps(doc, a, { label: null });
    expect(doc.getNode(`${a}/${label}`)?.text).toBe('New default');
    expect(() => setInstanceProps(doc, a, { nope: 'x' })).toThrow(/no prop/);
  });

  it('a variant set groups mains, a variant value switches the main and overrides follow by name', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const big = addVariant(doc, main, { size: 'lg' }, { base: { size: 'sm' } });
    doc.updateStyle(big, { width: '320px' });
    const a = createInstance(doc, main, page);
    doc.updateStyle(`${a}/${label}`, { color: 'rgb(7, 7, 7)' });
    expect(instanceControls(doc.source, a).find((c) => c.name === 'size')).toMatchObject({ type: 'variant', value: 'sm', options: ['sm', 'lg'] });
    setInstanceProps(doc, a, { size: 'lg' });
    expect(doc.rawNode(a)?.instanceOf).toBe(big);
    expect(doc.getNode(a)?.style.width).toBe('320px');
    const moved = doc.getChildren(a)[0]!;
    expect(moved.text).toBe('Buy');
    expect(moved.style.color).toBe('rgb(7, 7, 7)');
    expect(() => setInstanceProps(doc, a, { size: 'huge' })).toThrow(/no member/);
  });

  it('deleting one member moves its instances to another member', () => {
    const { doc, page } = fresh();
    const { main } = button(doc, page);
    const big = addVariant(doc, main, { size: 'lg' }, { base: { size: 'sm' } });
    const a = createInstance(doc, big, page);
    doc.delete([big]);
    expect(doc.rawNode(a)?.instanceOf).toBe(main);
  });

  it('a slot keeps its default until an instance fills it, with layers of its own', () => {
    const { doc, page } = fresh();
    const card = doc.insert(page, { type: 'frame', name: 'Card', style: { position: 'absolute', display: 'flex' }, children: [
      { type: 'text', tag: 'h3', name: 'Title', text: 'Title' },
      { type: 'frame', name: 'Body', style: { padding: '8px' }, children: [{ type: 'text', tag: 'p', name: 'Default', text: 'Default body' }] },
    ] });
    createComponent(doc, card);
    const body = doc.getChildren(card)[1]!.id;
    setSlot(doc, body, 'body');
    expect(slotsOf(doc.source, card)).toEqual([{ path: body, name: 'body' }]);
    const a = createInstance(doc, card, page);
    const b = createInstance(doc, card, page);
    expect(nodeToHtml(doc, a)).toContain('Default body');
    const fill = doc.insert(`${a}/${body}`, { type: 'text', tag: 'p', name: 'Mine', text: 'My own' });
    expect(doc.rawNode(fill)?.parent).toBe(a);
    expect(doc.rawNode(fill)?.slot).toBe(body);
    expect(doc.getNode(fill)?.parent).toBe(`${a}/${body}`);
    expect(nodeToHtml(doc, a)).toContain('My own');
    expect(nodeToHtml(doc, a)).not.toContain('Default body');
    expect(nodeToHtml(doc, b)).toContain('Default body');
    // Filling through the instance itself works when it has one slot.
    const via = doc.insert(b, { type: 'text', tag: 'p', name: 'Via', text: 'Via instance' });
    expect(doc.rawNode(via)?.slot).toBe(body);
    // A copy of a filled instance keeps its fill as its own.
    const [copy] = doc.duplicate([a]);
    expect(nodeToHtml(doc, copy!)).toContain('My own');
    expect(doc.rawChildren(copy!)[0]?.id).not.toBe(fill);
    // Only slots take layers.
    expect(() => doc.insert(`${a}/${doc.getChildren(card)[0]!.id}`, { type: 'frame' })).toThrow(/slots/);
    // A fill is an ordinary layer and can be moved out again.
    doc.move([fill], page);
    expect(doc.rawNode(fill)?.slot).toBeUndefined();
    expect(nodeToHtml(doc, a)).toContain('Default body');
    const reset = createInstance(doc, card, page);
    doc.insert(`${reset}/${body}`, { type: 'text', tag: 'p', name: 'X', text: 'X' });
    expect(listOverrides(doc.source, reset).map((o) => o.field)).toEqual(['slot']);
    resetAllOverrides(doc, reset);
    expect(doc.rawChildren(reset)).toEqual([]);
  });

  it('nests: an instance in a main shows through, and an outer instance can override inside it', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const bar = doc.insert(page, { type: 'frame', name: 'Bar', style: { position: 'absolute', display: 'flex' } });
    const nested = createInstance(doc, main, bar);
    createComponent(doc, bar);
    const a = createInstance(doc, bar, page);
    const deep = `${a}/${nested}/${label}`;
    expect(doc.getNode(deep)?.text).toBe('Buy');
    expect(doc.getNode(deep)?.parent).toBe(`${a}/${nested}`);
    doc.updateFields(label, { text: 'Main' });
    expect(doc.getNode(deep)?.text).toBe('Main');
    doc.updateFields(deep, { text: 'Deep' });
    expect(doc.getNode(deep)?.text).toBe('Deep');
    expect(doc.getNode(`${nested}/${label}`)?.text).toBe('Main');
    expect(doc.rawNode(a)?.overrides).toEqual({ [`${nested}/${label}#text`]: 'Deep' });
    expect(doc.ancestors(deep)).toEqual([`${a}/${nested}`, a]);
    // Detaching the outer one leaves the inner one linked, with the override moved onto it.
    detachInstance(doc, a);
    const inner = doc.getChildren(a)[0]!;
    expect(inner.instanceOf).toBe(main);
    expect(doc.getChildren(inner.id)[0]?.text).toBe('Deep');
  });

  it('a text-only main works too', () => {
    const { doc, page } = fresh();
    const main = doc.insert(page, { type: 'text', tag: 'h1', name: 'Heading', text: 'Hello', style: { position: 'absolute', fontSize: '40px' } });
    createComponent(doc, main);
    const a = createInstance(doc, main, page);
    expect(doc.getNode(a)?.type).toBe('text');
    expect(nodeToHtml(doc, a)).toContain('<h1');
    doc.updateFields(a, { text: 'Bye' });
    expect(nodeToHtml(doc, a)).toContain('Bye');
    expect(doc.rawNode(main)?.text).toBe('Hello');
  });
});

describe('HTML: x-instance', () => {
  it('turns into a linked layer, with props by name and fills by slot', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    updateComponent(doc, main, { props: [{ name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] }] });
    const { nodes } = importHtml('<div><x-instance component="Button" prop-label="From HTML" style="margin:4px"></x-instance></div>');
    resolveInstanceRefs(doc, nodes);
    const [root] = doc.insertMany(page, nodes);
    const inst = doc.getChildren(root!)[0]!;
    expect(inst.instanceOf).toBe(main);
    expect(doc.getChildren(inst.id)[0]?.text).toBe('From HTML');
    expect(inst.style.margin).toBe('4px');
    expect(() => resolveInstanceRefs(doc, importHtml('<x-instance component="Nope"></x-instance>').nodes)).toThrow(/no component "Nope".*Button/s);
    expect(() => resolveInstanceRefs(doc, importHtml('<x-instance component="Button" prop-size="m"></x-instance>').nodes)).toThrow(/no prop "size"/);
  });
});

describe('old documents', () => {
  it('read and render without any of the new fields, and stay byte for byte the same', () => {
    const old = new Y.Doc();
    const pages = old.getMap<Y.Map<unknown>>('pages');
    const nodes = old.getMap<Y.Map<unknown>>('nodes');
    const tokens = old.getMap<Y.Map<unknown>>('tokens');
    const page = new Y.Map<unknown>();
    page.set('name', 'Old');
    page.set('order', 'a0');
    pages.set('pg', page);
    const n = new Y.Map<unknown>();
    n.set('type', 'frame');
    n.set('name', 'Board');
    n.set('parent', 'pg');
    n.set('order', 'a0');
    n.set('tag', 'main');
    const style = new Y.Map<string>();
    style.set('color', 'var(--ink)');
    n.set('style', style);
    n.set('artboard', true);
    nodes.set('nd', n);
    const t = new Y.Map<unknown>();
    t.set('kind', 'color');
    t.set('value', '#111');
    tokens.set('ink', t);
    const doc = new BogenDoc(old);
    expect(doc.getNode('nd')?.instanceOf).toBeUndefined();
    expect(getModes(doc)).toEqual([]);
    expect(getTextStyles(doc)).toEqual([]);
    expect(tokensCss(doc)).toBe(':root{--ink:#111}');
    expect(nodeToHtml(doc, 'nd')).toBe('<main style="color:var(--ink)"></main>');
    expect(usesComponents(doc, 'nd')).toBe(false);
    expect(toReact(doc, 'nd', 'inline')).toContain('export function Board()');
  });
});

describe('modes', () => {
  it('writes per-mode values under a selector, with aliases following, and the base mode selectable', () => {
    const { doc } = fresh();
    doc.setToken('bg', 'color', '#fff');
    doc.setToken('surface', 'color', 'var(--bg)');
    doc.setToken('gap', 'spacing', '16px');
    createMode(doc, 'dark');
    createMode(doc, 'compact');
    expect(getModes(doc).map((m) => m.name)).toEqual(['light', 'dark', 'compact']);
    setTokenMode(doc, 'bg', 'dark', '#000');
    setTokenMode(doc, 'gap', 'compact', '8px');
    const css = tokensCss(doc);
    expect(css).toContain(':root,[data-mode="light"]{--bg:#fff;--gap:16px;--surface:var(--bg)}');
    expect(css).toContain('[data-mode="dark"]{--bg:#000;--surface:var(--bg)}');
    expect(css).toContain('[data-mode="compact"]{--gap:8px}');
    setTokenMode(doc, 'bg', 'light', '#eee');
    expect(doc.getTokens().find((t) => t.name === 'bg')?.value).toBe('#eee');
    deleteMode(doc, 'compact');
    expect(doc.getTokens().find((t) => t.name === 'gap')?.modes).toBeUndefined();
    expect(() => deleteMode(doc, 'light')).toThrow(/plain values/);
  });

  it('a mode per layer and per page reaches the markup, also for a part exported alone', () => {
    const { doc, page } = fresh();
    createMode(doc, 'dark');
    const board = doc.insert(page, { type: 'frame', name: 'A', mode: 'dark', style: {}, children: [{ type: 'text', tag: 'p', name: 'T', text: 'x' }] });
    const child = doc.getChildren(board)[0]!.id;
    expect(nodeToHtml(doc, board)).toContain('data-mode="dark"');
    expect(nodeToHtml(doc, child)).toContain('data-mode="dark"');
    expect(effectiveMode(doc, child)).toBe('dark');
    const other = doc.insert(page, { type: 'frame', name: 'B', style: {} });
    setPageMode(doc, page, 'compact');
    expect(effectiveMode(doc, other)).toBe('compact');
    expect(nodeToHtml(doc, other)).toContain('data-mode="compact"');
    expect(exportDocument(doc, [other])).toContain('data-mode="compact"');
    doc.updateFields(board, { mode: undefined });
    expect(effectiveMode(doc, child)).toBe('compact');
  });

  it('never writes a hostile token or mode into the style element', () => {
    const { doc, page } = fresh();
    doc.setToken('evil', 'color', 'red}</style><script>alert(1)</script>');
    doc.setToken('fine', 'color', 'url("a;b}")');
    const t = doc.tokens.get('fine')!;
    t.set('mode:dark', '}</style><script>x</script>');
    const m = new Y.Map<unknown>();
    m.set('order', 'a0');
    doc.modes.set('dark', m);
    const css = tokensCss(doc);
    expect(css).not.toContain('<script');
    expect(css).not.toContain('evil');
    expect(css).toContain('--fine:url("a;b}")');
    expect(safeCssValue('rgb(0 0 0)')).toBe(true);
    expect(safeCssValue('a;b')).toBe(false);
    const n = doc.insert(page, { type: 'frame', style: {} });
    doc.nodes.get(n)!.set('mode', '"><script>x</script>');
    doc.nodes.get(n)!.set('textStyle', '"><script>y</script>');
    expect(nodeToHtml(doc, n)).not.toContain('<script');
    expect(() => setTextStyle(doc, 'x', { fontSize: '1px}</style>' })).toThrow();
    const raw = new Y.Map<unknown>();
    raw.set('fontSize', '1px}</style><script>z</script>');
    doc.textStyles.set('bad', raw);
    expect(textStylesCss(getTextStyles(doc))).not.toContain('<script');
  });
});

describe('renaming a token', () => {
  it('takes its modes along, and everything that refers to it', () => {
    const { doc, page } = fresh();
    doc.setToken('ink', 'color', '#111');
    doc.setToken('alias', 'color', 'var(--ink)');
    createMode(doc, 'dark');
    setTokenMode(doc, 'ink', 'dark', '#eee');
    const { main, label } = button(doc, page);
    doc.updateStyle(main, { color: 'var(--ink)' });
    const a = createInstance(doc, main, page);
    doc.updateStyle(`${a}/${label}`, { color: 'var(--ink)' });
    setTextStyle(doc, 'T', { fontSize: 'var(--ink)' });
    renameToken(doc, 'ink', 'text');
    expect(doc.getTokens().find((t) => t.name === 'text')).toMatchObject({ value: '#111', modes: { dark: '#eee' } });
    expect(doc.getTokens().find((t) => t.name === 'alias')?.value).toBe('var(--text)');
    expect(doc.getNode(main)?.style.color).toBe('var(--text)');
    expect(doc.getNode(`${a}/${label}`)?.style.color).toBe('var(--text)');
    expect(getTextStyles(doc)[0]?.style.fontSize).toBe('var(--text)');
  });
});

describe('text styles', () => {
  it('exports as a class, updating one reaches its users, and applying takes over what it decides', () => {
    const { doc, page } = fresh();
    const key = setTextStyle(doc, 'Heading 1', { fontFamily: 'Inter, sans-serif', fontSize: '40px', fontWeight: '700', lineHeight: '1.1', letterSpacing: '-0.02em' });
    expect(key).toBe('heading-1');
    const a = doc.insert(page, { type: 'text', tag: 'h1', text: 'A', style: { fontSize: '10px', color: 'red' } });
    applyTextStyle(doc, a, key);
    expect(doc.getNode(a)?.style.fontSize).toBeUndefined();
    expect(doc.getNode(a)?.style.color).toBe('red');
    expect(nodeToHtml(doc, a)).toContain('class="ts-heading-1"');
    expect(exportDocument(doc, [a])).toContain('.ts-heading-1{font-family:Inter, sans-serif;font-size:40px;font-weight:700;line-height:1.1;letter-spacing:-0.02em}');
    setTextStyle(doc, 'Heading 1', { fontSize: '48px' });
    expect(exportDocument(doc, [a])).toContain('font-size:48px');
    expect(designSystemCss(doc)).toContain('.ts-heading-1 {');
    expect(toReact(doc, a, 'tailwind')).toContain('ts-heading-1');
    deleteTextStyle(doc, key);
    expect(doc.getNode(a)?.textStyle).toBeUndefined();
    expect(doc.getNode(a)?.style.fontSize).toBe('48px');
  });

  it('works through an instance override', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    const key = setTextStyle(doc, 'Small', { fontSize: '11px' });
    applyTextStyle(doc, `${a}/${label}`, key);
    expect(doc.rawNode(label)?.textStyle).toBeUndefined();
    expect(nodeToHtml(doc, a)).toContain('class="ts-small"');
  });
});

describe('code handoff', () => {
  function system() {
    const { doc, page } = fresh();
    const { main, label, icon } = button(doc, page);
    updateComponent(doc, main, { props: [
      { name: 'label', type: 'text', targets: [{ path: label, field: 'text' }] },
      { name: 'show-icon', type: 'boolean', targets: [{ path: icon, field: 'visible' }] },
    ] });
    return { doc, page, main, label };
  }

  it('makes a typed React component, in both modes', () => {
    const { doc, main } = system();
    const inline = toReact(doc, main, 'inline');
    expect(inline).toContain('export interface ButtonProps');
    expect(inline).toContain('label?: string;');
    expect(inline).toContain('showIcon?: boolean;');
    expect(inline).toContain('label = "Buy"');
    expect(inline).toContain('showIcon = true');
    expect(inline).toContain('{label}');
    expect(inline).toContain('{(showIcon) && (');
    expect(inline).toContain('...style');
    const tailwind = toReact(doc, main, 'tailwind');
    expect(tailwind).toContain('className={["');
    expect(tailwind).toContain('flex');
    expect(tailwind).not.toContain('position:');
  });

  it('writes instances as usages, and spells out what props cannot say', () => {
    const { doc, page, main, label } = system();
    const board = doc.insert(page, { type: 'frame', tag: 'section', name: 'Hero', style: {} });
    const a = createInstance(doc, main, board, { props: { label: 'Go', 'show-icon': false } });
    createInstance(doc, main, board);
    const code = toReact(doc, board, 'inline');
    expect(code).toContain('<Button label="Go" showIcon={false} />');
    expect(code).toContain('<Button />');
    expect(code).toContain('export function Hero()');
    expect(code.indexOf('export function Button')).toBeLessThan(code.indexOf('export function Hero'));
    doc.updateFields(`${a}/${label}`, { name: 'x' });
    doc.updateStyle(`${a}/${label}`, { color: 'rgb(1, 1, 1)' });
    const spelled = toReact(doc, board, 'inline');
    expect(spelled).toContain('written out in full');
    expect(spelled).toContain('rgb(1, 1, 1)');
  });

  it('a variant set is one component with a union and one branch per member', () => {
    const { doc, page, main } = system();
    const big = addVariant(doc, main, { size: 'lg' }, { base: { size: 'sm' } });
    doc.updateStyle(big, { width: '320px' });
    const code = toReact(doc, main, 'inline');
    expect(code).toContain('size?: "sm" | "lg";');
    expect(code).toContain('size = "sm"');
    expect(code).toContain('if (size === "lg") {');
    expect(code).toContain('320px');
    expect(code.match(/export function/g)?.length).toBe(1);
    const a = createInstance(doc, big, page);
    expect(toReact(doc, a, 'inline')).toContain('<Button size="lg"');
  });

  it('slots become props, and fills become their content', () => {
    const { doc, page } = fresh();
    const card = doc.insert(page, { type: 'frame', name: 'Card', style: {}, children: [
      { type: 'frame', name: 'Body', style: {}, children: [{ type: 'text', tag: 'p', name: 'D', text: 'Default' }] },
      { type: 'frame', name: 'Foot', style: {} },
    ] });
    createComponent(doc, card);
    const [body, foot] = doc.getChildren(card).map((c) => c.id) as [string, string];
    setSlot(doc, body, 'body');
    setSlot(doc, foot, 'footer');
    const code = toReact(doc, card, 'inline');
    expect(code).toContain('children?: ReactNode;');
    expect(code).toContain('footer?: ReactNode;');
    expect(code).toContain('{children ?? (');
    const a = createInstance(doc, card, page);
    doc.insert(`${a}/${body}`, { type: 'text', tag: 'p', name: 'Mine', text: 'Mine' });
    doc.insert(`${a}/${foot}`, { type: 'text', tag: 'p', name: 'Foot', text: 'Foot' });
    const usage = toReact(doc, a, 'inline');
    expect(usage).toContain('<p');
    expect(usage).toMatch(/<Card footer=\{<>[\s\S]*Foot[\s\S]*<\/>\}>[\s\S]*Mine[\s\S]*<\/Card>/);
  });
});

describe('component data', () => {
  it('rejects bad prop names and targets', () => {
    const { doc, page } = fresh();
    const { main } = button(doc, page);
    expect(() => updateComponent(doc, main, { props: [{ name: 'a b', type: 'text' }] })).toThrow(/valid prop name/);
    expect(() => updateComponent(doc, main, { props: [{ name: 'a', type: 'text', targets: [{ path: '', field: 'onclick' }] }] })).toThrow(/cannot drive/);
  });

  it('a layer inside an instance cannot be a component itself', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    expect(() => createComponent(doc, `${a}/${label}`)).toThrow(/inside an instance/);
    expect(() => createComponent(doc, a)).toThrow(/already an instance/);
  });

  it('copying carries overrides, and copying from another file gives what it looked like', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    doc.updateFields(`${a}/${label}`, { text: 'Own' });
    const [copy] = doc.duplicate([a]);
    expect(doc.getNode(`${copy}/${label}`)?.text).toBe('Own');
    const spec = { ...doc.toSpec(a), materialized: doc.toSpec(`${a}/${label}`) };
    const elsewhere = fresh();
    const pasted = elsewhere.doc.insert(elsewhere.page, spec);
    expect(elsewhere.doc.getNode(pasted)?.instanceOf).toBeUndefined();
    expect(elsewhere.doc.getNode(pasted)?.text).toBe('Own');
  });

  it('setOverride understands every kind of field', () => {
    const { doc, page } = fresh();
    const { main, label } = button(doc, page);
    const a = createInstance(doc, main, page);
    const view = `${a}/${label}`;
    setOverride(doc, view, 'style.color', 'rgb(5, 5, 5)');
    setOverride(doc, view, 'text', 'T');
    setOverride(doc, view, 'attr.title', 'Hi');
    expect(doc.getNode(view)?.style.color).toBe('rgb(5, 5, 5)');
    expect(doc.getNode(view)?.text).toBe('T');
    expect(doc.getNode(view)?.attrs?.title).toBe('Hi');
    setOverride(doc, view, 'attr.title', null);
    expect(doc.getNode(view)?.attrs?.title).toBeUndefined();
    setOverride(doc, view, 'hidden', true);
    expect(doc.getNode(view)?.hidden).toBe(true);
    setOverride(doc, view, 'hidden', null);
    expect(doc.getNode(view)?.hidden).toBeUndefined();
    expect(() => setOverride(doc, view, 'onclick', 'x')).toThrow(/cannot be overridden/);
  });

  it('theme css keeps plain output for files without modes', () => {
    const { doc } = fresh();
    doc.setToken('a', 'color', '#123');
    expect(themeCss(doc.getTokens(), getModes(doc))).toBe(':root{--a:#123}');
  });
});

describe('a main that is a code component', () => {
  function story() {
    const { doc, page } = fresh();
    const main = doc.insert(page, {
      type: 'embed', name: 'Button / Primary', style: { width: '120px', height: '40px' },
      code: { project: 'proj0001', file: 'src/Button.tsx', name: 'Button', import: '@/components/Button', props: { children: 'Save', tone: 'primary' } },
    });
    createComponent(doc, main, { set: 'Button', variant: { story: 'Primary' }, props: [
      { name: 'tone', type: 'variant', options: ['primary', 'danger'], default: 'primary', targets: [{ path: '', field: 'code.tone' }] },
      { name: 'children', type: 'text', default: 'Save', targets: [{ path: '', field: 'code.children' }] },
    ] });
    return { doc, page, main };
  }

  it('shows the same component in every instance, and props drive its own props', () => {
    const { doc, page, main } = story();
    const a = createInstance(doc, main, page);
    const b = createInstance(doc, main, page, { props: { tone: 'danger', children: 'Delete' } });
    expect(doc.getNode(a)?.code).toMatchObject({ file: 'src/Button.tsx', name: 'Button', props: { children: 'Save', tone: 'primary' } });
    expect(doc.getNode(b)?.code?.props).toEqual({ children: 'Delete', tone: 'danger' });
    setInstanceProps(doc, b, { tone: null });
    expect(doc.getNode(b)?.code?.props.tone).toBe('primary');
    // A prop may drive code.<prop>, and nothing that is not a name.
    expect(() => updateComponent(doc, main, { props: [{ name: 'x', type: 'text', targets: [{ path: '', field: 'code.__proto__.x' }] }] })).toThrow(/cannot drive/);
  });

  it('hands off as a usage of the repository\'s component with its import, not a component of its own', () => {
    const { doc, page, main } = story();
    const board = doc.insert(page, { type: 'frame', tag: 'section', name: 'Form', style: {} });
    createInstance(doc, main, board, { props: { tone: 'danger', children: 'Delete' } });
    const code = toReact(doc, board, 'inline');
    expect(code).toContain('<Button tone="danger">Delete</Button>');
    expect(code).not.toContain('export function Button');
    expect(codeImportLines(doc, board)).toEqual(['import { Button } from "@/components/Button";']);
  });
});
