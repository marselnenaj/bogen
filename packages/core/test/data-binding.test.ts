import { describe, expect, it } from 'vitest';
import {
  BogenDoc, applyRepeat, bindLayer, createComponent, createInstance, getDataSource, layerBindings, listDataSources, nodeToHtml, repeatsOfSource, rerunSource,
  setDataSource, templateFor, toJsx, toReact, updateComponent,
} from '../src/index.ts';

const PRODUCTS = [
  { name: 'Lamp', image: 'https://example.com/lamp.png', onSale: true, tier: 'gold' },
  { name: 'Chair', image: 'https://example.com/chair.png', onSale: 'no', tier: 'silver' },
  { name: 'Desk', image: 'https://example.com/desk.png', onSale: 1, tier: 'gold' },
];

/** A grid with a card template: a name, an image, a sale tag and a badge of a variant set. */
function setup() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const gold = doc.insert(page, { type: 'frame', tag: 'span', name: 'Badge gold', style: { position: 'absolute', left: '900px', top: '0px', color: 'gold' }, children: [{ type: 'text', tag: 'span', name: 'Label', text: 'Gold' }] });
  const silver = doc.insert(page, { type: 'frame', tag: 'span', name: 'Badge silver', style: { position: 'absolute', left: '900px', top: '60px', color: 'silver' }, children: [{ type: 'text', tag: 'span', name: 'Label', text: 'Silver' }] });
  createComponent(doc, gold, { name: 'Badge', set: 'Badge', variant: { tier: 'gold' } });
  createComponent(doc, silver, { name: 'Badge', set: 'Badge', variant: { tier: 'silver' } });
  const board = doc.insert(page, { type: 'frame', tag: 'main', name: 'Shop', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '800px', display: 'flex', gap: '8px' } });
  const card = doc.insert(board, {
    type: 'frame', tag: 'article', name: 'Card', style: { display: 'flex', flexDirection: 'column' },
    children: [
      { type: 'text', tag: 'h3', name: 'Name', text: 'Product' },
      { type: 'image', tag: 'img', name: 'Photo', src: 'https://example.com/x.png', style: { width: '40px', height: '40px' } },
      { type: 'text', tag: 'span', name: 'Sale', text: 'On sale' },
    ],
  });
  const [name, photo, sale] = doc.getChildren(card).map((c) => c.id) as [string, string, string];
  const badge = createInstance(doc, gold, card);
  return { doc, page, board, card, name, photo, sale, badge, gold, silver };
}

function bindAll(t: ReturnType<typeof setup>) {
  bindLayer(t.doc, t.name, { text: 'name' });
  bindLayer(t.doc, t.photo, { src: 'image', attrs: { alt: 'name' } });
  bindLayer(t.doc, t.sale, { visible: 'onSale' });
  bindLayer(t.doc, t.badge, { variant: { tier: 'tier' } });
}

describe('binding layers to fields', () => {
  it('writes placeholders and bind attributes, and reads them back', () => {
    const t = setup();
    bindAll(t);
    expect(t.doc.getNode(t.name)!.text).toBe('{{name}}');
    expect(layerBindings(t.doc, t.photo)).toMatchObject({ src: 'image', attrs: { alt: 'name' } });
    expect(layerBindings(t.doc, t.sale).visible).toBe('onSale');
    expect(layerBindings(t.doc, t.badge).variant).toEqual({ tier: 'tier' });
    bindLayer(t.doc, t.sale, { visible: null });
    expect(layerBindings(t.doc, t.sale).visible).toBeUndefined();
    expect(() => bindLayer(t.doc, t.name, { text: 'a b' })).toThrow(/not a field name/);
    expect(() => bindLayer(t.doc, t.name, { variant: { tier: 'tier' } })).toThrow(/Only an instance/);
    expect(() => bindLayer(t.doc, t.photo, { attrs: { onclick: 'x' } })).toThrow(/can be bound/);
  });

  it('makes a copy per record of a data source: text, image, visibility and variant', () => {
    const t = setup();
    bindAll(t);
    const source = setDataSource(t.doc, { name: 'Products', kind: 'inline', records: PRODUCTS });
    expect(source.fields).toEqual(['name', 'image', 'onSale', 'tier']);
    const result = applyRepeat(t.doc, t.card, source.records, { kind: 'source', source: source.id });
    expect(result.copies.length).toBe(3);
    expect(result.missing).toEqual([]);
    const [lamp, chair, desk] = result.copies.map((id) => t.doc.getChildren(id));
    expect(lamp![0]!.text).toBe('Lamp');
    expect(lamp![1]!.src).toBe('https://example.com/lamp.png');
    expect(lamp![1]!.attrs?.alt).toBe('Lamp');
    expect(lamp![2]!.hidden).toBeFalsy();
    expect(chair![2]!.hidden).toBe(true);
    expect(desk![2]!.hidden).toBeFalsy();
    // The variant comes from the record: the silver member of the set.
    expect(chair![3]!.instanceOf).toBe(t.silver);
    expect(lamp![3]!.instanceOf).toBe(t.gold);
    expect(nodeToHtml(t.doc, result.copies[1]!)).toContain('Silver');
    // Bindings stay on the template, the copies just show the data.
    expect(chair![2]!.attrs?.['data-bind-visible']).toBeUndefined();
    expect(templateFor(t.doc, t.name)).toBe(t.card);
    expect(repeatsOfSource(t.doc, source.id)).toEqual([t.card]);
  });

  it('binds one record instead of the list', () => {
    const t = setup();
    bindAll(t);
    const source = setDataSource(t.doc, { name: 'Products', kind: 'inline', records: PRODUCTS });
    const result = applyRepeat(t.doc, t.card, source.records, { kind: 'source', source: source.id, record: 1 });
    expect(result.copies.length).toBe(1);
    expect(t.doc.getChildren(result.copies[0]!)[0]!.text).toBe('Chair');
    expect(() => applyRepeat(t.doc, t.card, source.records, { kind: 'source', source: source.id, record: 9 })).toThrow(/no record 9/);
  });

  it('refreshes every template of a source when its records change', () => {
    const t = setup();
    bindAll(t);
    const source = setDataSource(t.doc, { name: 'Products', kind: 'url', url: 'https://example.com/p.json', records: PRODUCTS });
    applyRepeat(t.doc, t.card, source.records, { kind: 'source', source: source.id });
    setDataSource(t.doc, { id: source.id, name: 'Products', kind: 'url', url: 'https://example.com/p.json', records: [{ name: 'Sofa', onSale: true, tier: 'silver', image: 'https://example.com/s.png' }] });
    expect(listDataSources(t.doc).length).toBe(1);
    const [rerun] = rerunSource(t.doc, 'products');
    expect(rerun!.copies.length).toBe(1);
    expect(t.doc.getChildren(rerun!.copies[0]!)[0]!.text).toBe('Sofa');
    // Only the new copies are left, after the hidden template.
    expect(t.doc.getChildren(t.board).length).toBe(2);
    expect(getDataSource(t.doc, 'Products')!.records.length).toBe(1);
  });
});

describe('code from a design with data', () => {
  it('maps over the records instead of writing out the copies', () => {
    const t = setup();
    bindLayer(t.doc, t.name, { text: 'name' });
    bindLayer(t.doc, t.photo, { src: 'image' });
    bindLayer(t.doc, t.sale, { visible: 'onSale' });
    t.doc.delete([t.badge]);
    const source = setDataSource(t.doc, { name: 'Products', kind: 'inline', records: PRODUCTS });
    applyRepeat(t.doc, t.card, source.records, { kind: 'source', source: source.id });
    const code = toJsx(t.doc, t.board, 'inline');
    expect(code).toContain('const products = [');
    expect(code).toContain('{products.map((item, i) => (');
    expect(code).toContain('key={i}');
    expect(code).toContain('{item.name}');
    expect(code).toContain('src={item.image}');
    expect(code).not.toMatch(/<img alt alt/);
    expect(code).toContain('{item.onSale && (');
    // The copies are the data, so their text is not written out as layers.
    expect(code.match(/Chair/g)?.length).toBe(1);
  });

  it('a component picks its variant from the record, and a single record is a constant', () => {
    const t = setup();
    updateComponent(t.doc, t.gold, { props: [{ name: 'label', type: 'text', targets: [{ path: t.doc.getChildren(t.gold)[0]!.id, field: 'text' }] }] });
    bindAll(t);
    bindLayer(t.doc, t.badge, { props: { label: 'name' } });
    const source = setDataSource(t.doc, { name: 'Featured', kind: 'inline', records: PRODUCTS });
    applyRepeat(t.doc, t.card, source.records, { kind: 'source', source: source.id, record: 0 });
    const code = toReact(t.doc, t.board, 'inline');
    expect(code).toContain('const featured = {');
    expect(code).not.toContain('.map(');
    expect(code).toMatch(/<Badge[^>]*tier=\{featured\.tier\}/);
    expect(code).toMatch(/<Badge[^>]*label=\{featured\.name\}/);
    expect(code).toContain('{featured.name}');
    // A bound image stays an image, with its source and alt from the record.
    expect(code).toContain('<img alt={featured.name} src={featured.image}');
    expect(code).toContain('{(featured.onSale) && (');
  });
});
