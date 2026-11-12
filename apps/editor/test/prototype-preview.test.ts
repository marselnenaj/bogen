import { describe, expect, it } from 'vitest';
import { BogenDoc, createComponent, createInstance, importHtml, protoMachine, protoModel, protoScreens, setVariable, updateComponent, Y, type NewNode } from '@bogen/core';
import { Snapshot } from '../src/doc/snapshot.ts';
import { protoViews } from '../src/preview/preview-model.ts';

const m = protoMachine();

function setup() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  setVariable(doc, { name: 'open', type: 'boolean', value: false });
  setVariable(doc, { name: 'count', type: 'number', value: 0 });
  setVariable(doc, { name: 'plan', type: 'text', value: 'monthly' });
  const spec: NewNode = { type: 'frame', name: 'Price', style: { position: 'absolute', left: '900px', top: '0px', display: 'flex' }, children: [{ type: 'text', tag: 'p', name: 'Amount', text: '9 a month' }] };
  const monthly = doc.insert(page, spec);
  createComponent(doc, monthly, { set: 'Price', variant: { billing: 'monthly' } });
  const yearly = doc.insert(page, { ...spec, children: [{ type: 'text', tag: 'p', name: 'Amount', text: '90 a year' }] });
  createComponent(doc, yearly, { set: 'Price', variant: { billing: 'yearly' } });
  updateComponent(doc, yearly, { set: 'Price', variant: { billing: 'yearly' } });
  const home = doc.insert(page, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '390px' } });
  doc.insertMany(home, importHtml('<nav data-name="Menu" style="display:none">Links</nav><span data-name="Badge">0</span>').nodes);
  const card = createInstance(doc, monthly, home);
  const find = (name: string) => doc.descendants(home).find((n) => n.name === name)!.id;
  const menu = find('Menu');
  const badge = find('Badge');
  doc.updateFields(menu, { hidden: true, proto: { showWhen: { variable: 'open', op: 'is', value: true } } });
  doc.updateFields(badge, { proto: { textFrom: 'count' } });
  doc.updateFields(card, { proto: { variantFrom: { prop: 'billing', variable: 'plan' } } });
  return { doc, home, menu, badge, card, monthly, yearly, snap: new Snapshot(doc) };
}

describe('the prototype in preview mode', () => {
  it('shows what the state says without writing anything to the file', () => {
    const { doc, menu, badge, card, yearly, snap } = setup();
    const model = protoModel(doc, protoScreens(doc));
    const before = Y.encodeStateVector(doc.y);
    let state = m.init(model);
    snap.setLocal(protoViews(doc, model, m, state));
    expect(snap.node(menu)?.hidden).toBe(true);
    expect(snap.node(badge)?.text).toBe('0');
    expect(snap.node(card)?.instanceOf).not.toBe(yearly);

    state = { ...state, vars: { ...state.vars, open: true, count: 3, plan: 'yearly' } };
    snap.setLocal(protoViews(doc, model, m, state));
    // Stored hidden and with display none, it shows with the display it had before.
    expect(snap.node(menu)?.hidden).toBe(false);
    expect(snap.node(menu)?.style.display).toBeUndefined();
    expect(snap.node(badge)?.text).toBe('3');
    expect(snap.node(card)?.instanceOf).toBe(yearly);
    expect(snap.children(card).map((id) => snap.node(id)?.text)).toEqual(['90 a year']);

    expect(Y.encodeStateVector(doc.y)).toEqual(before);

    // An edit arriving meanwhile still shows through the view.
    doc.updateStyle(menu, { color: 'red' });
    expect(snap.node(menu)?.style.color).toBe('red');
    expect(snap.node(menu)?.hidden).toBe(false);

    snap.setLocal(new Map());
    expect(snap.node(menu)?.hidden).toBe(true);
    expect(snap.node(badge)?.text).toBe('0');
    expect(doc.getNode(menu)?.hidden).toBe(true);
  });
});
