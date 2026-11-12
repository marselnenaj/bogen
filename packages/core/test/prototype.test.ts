import { describe, expect, it } from 'vitest';
import {
  BogenDoc, createComponent, createInstance, deleteVariable, exportPrototype, getVariables, importHtml, protoMachine, protoModel, protoScript, readProtoState, setVariable,
  updateComponent, type LayerProto, type NewNode, type ProtoModel,
} from '../src/index.ts';

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

function board(doc: BogenDoc, page: string, name: string, html: string, left = 0): string {
  const id = doc.insert(page, { type: 'frame', name, artboard: true, style: { position: 'absolute', left: `${left}px`, top: '0px', width: '390px', height: 'fit-content', display: 'flex', flexDirection: 'column' } });
  doc.insertMany(id, importHtml(html).nodes);
  return id;
}

function byName(doc: BogenDoc, root: string, name: string): string {
  const hit = doc.descendants(root).find((n) => n.name === name);
  if (!hit) throw new Error(`No ${name}`);
  return hit.id;
}

const proto = (doc: BogenDoc, id: string, p: LayerProto) => doc.updateFields(id, { proto: p });

describe('file variables', () => {
  it('keeps a type and a value that fits it, in order, and renames and deletes', () => {
    const { doc } = fresh();
    setVariable(doc, { name: 'menuOpen', type: 'boolean', value: false });
    setVariable(doc, { name: 'count', type: 'number', value: '3' });
    setVariable(doc, { name: 'email', value: 'a@b.c' });
    expect(getVariables(doc)).toEqual([
      { name: 'menuOpen', type: 'boolean', value: false },
      { name: 'count', type: 'number', value: 3 },
      { name: 'email', type: 'text', value: 'a@b.c' },
    ]);
    expect(() => setVariable(doc, { name: 'count', value: 'many' })).toThrow(/not a number/);
    expect(() => setVariable(doc, { name: '1bad', type: 'text' })).toThrow(/valid variable name/);
    setVariable(doc, { name: 'count', rename: 'cartCount' });
    expect(getVariables(doc).map((v) => v.name)).toEqual(['menuOpen', 'cartCount', 'email']);
    deleteVariable(doc, 'email');
    expect(getVariables(doc).map((v) => v.name)).toEqual(['menuOpen', 'cartCount']);
  });

  it('cleans what a layer stores, as it can come from anyone', () => {
    const state = readProtoState({
      interactions: [
        { trigger: 'click', actions: [{ type: 'toggle', variable: 'menuOpen' }, { type: 'set', variable: 'x;y', value: 1 }, { type: 'navigate', to: 'abc', transition: 'explode' }, { type: 'eval', code: 'alert(1)' }] },
        { trigger: 'keydown', actions: [] },
      ],
      showWhen: { variable: 'menuOpen', op: 'is' },
      bind: '<script>',
    } as unknown as LayerProto);
    expect(state).toEqual({ interactions: [{ trigger: 'click', actions: [{ type: 'toggle', variable: 'menuOpen' }, { type: 'navigate', to: 'abc' }] }], showWhen: { variable: 'menuOpen', op: 'is' } });
  });
});

describe('the prototype state machine', () => {
  const m = protoMachine();
  const model: ProtoModel = {
    variables: { open: { type: 'boolean', value: false }, count: { type: 'number', value: 0 }, plan: { type: 'text', value: 'monthly' }, email: { type: 'text', value: '' } },
    screens: ['home', 'done'],
    start: 'home',
    layers: {
      menuButton: { on: { click: [{ type: 'toggle', variable: 'open' }] } },
      menu: { showWhen: { variable: 'open', op: 'is' }, hidden: true, display: 'flex' },
      add: { on: { click: [{ type: 'increment', variable: 'count' }] } },
      badge: { showWhen: { variable: 'count', op: 'gt', value: 0 }, textFrom: 'count' },
      card: { variant: { prop: 'billing', values: ['monthly', 'yearly'], initial: 'monthly', variable: 'plan' } },
      yearly: { on: { click: [{ type: 'set', variable: 'plan', value: 'yearly' }] } },
      tip: { hidden: true },
      info: { on: { hover: [{ type: 'show', target: 'tip' }] } },
      field: { bind: { variable: 'email', kind: 'text' } },
      form: { on: { submit: [{ type: 'navigate', to: 'done', transition: 'slide-left', duration: 250 }] } },
      backButton: { on: { click: [{ type: 'back' }] } },
      outside: { on: { click: [{ type: 'navigate', to: 'nowhere' }] } },
    },
  };

  it('starts from the variables and the first screen, or a screen it is given', () => {
    const s = m.init(model);
    expect(s).toMatchObject({ vars: { open: false, count: 0, plan: 'monthly' }, screen: 'home' });
    expect(m.init(model, 'done').screen).toBe('done');
    expect(m.init(model, 'missing').screen).toBe('home');
  });

  it('toggles a boolean on click, and a layer shows while it holds', () => {
    let s = m.init(model);
    expect(m.visible(model, s, 'menu')).toBe(false);
    s = m.dispatch(model, s, ['menuButton', 'header', 'home'], 'click').state;
    expect(s.vars.open).toBe(true);
    expect(m.visible(model, s, 'menu')).toBe(true);
    s = m.dispatch(model, s, ['icon', 'menuButton'], 'click').state;
    expect(m.visible(model, s, 'menu')).toBe(false);
  });

  it('counts, and shows the count in a text layer once it is above zero', () => {
    let s = m.init(model);
    expect(m.visible(model, s, 'badge')).toBe(false);
    for (let i = 0; i < 3; i++) s = m.dispatch(model, s, ['add'], 'click').state;
    expect(s.vars.count).toBe(3);
    expect(m.visible(model, s, 'badge')).toBe(true);
    expect(m.text(model, s, 'badge')).toBe('3');
  });

  it('picks a variant from a variable', () => {
    let s = m.init(model);
    expect(m.variant(model, s, 'card')).toBe('monthly');
    s = m.dispatch(model, s, ['yearly'], 'click').state;
    expect(m.variant(model, s, 'card')).toBe('yearly');
  });

  it('undoes what a hover did when the pointer leaves', () => {
    const s0 = m.init(model);
    const entered = m.enter(model, s0, 'info');
    expect(m.visible(model, entered.state, 'tip')).toBe(true);
    const left = m.leave(entered.state, entered.saved);
    expect(m.visible(model, left, 'tip')).toBe(false);
  });

  it('binds a field, submits a form to another screen, and goes back', () => {
    let s = m.init(model);
    s = m.field(model, s, 'field', 'me@example.com');
    expect(s.vars.email).toBe('me@example.com');
    const out = m.dispatch(model, s, ['field', 'form', 'home'], 'submit');
    expect(out.nav).toEqual({ to: 'done', transition: 'slide-left', duration: 250 });
    expect(out.state.screen).toBe('done');
    const back = m.dispatch(model, out.state, ['backButton'], 'click');
    expect(back.state.screen).toBe('home');
    expect(back.nav?.back).toBe(true);
  });

  it('ignores triggers nothing answers, and screens that are not in the prototype', () => {
    const s = m.init(model);
    expect(m.dispatch(model, s, ['plain'], 'click').handled).toBeNull();
    const out = m.dispatch(model, s, ['outside'], 'click');
    expect(out.handled).toBe('outside');
    expect(out.state.screen).toBe('home');
    expect(out.nav).toBeNull();
  });

  it('never changes the state it was given', () => {
    const s = m.init(model);
    const copy = JSON.stringify(s);
    m.dispatch(model, s, ['menuButton'], 'click');
    m.field(model, s, 'field', 'x');
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe('the prototype model and export', () => {
  function shop() {
    const { doc, page } = fresh();
    setVariable(doc, { name: 'open', type: 'boolean', value: false });
    setVariable(doc, { name: 'email', type: 'text', value: '' });
    const home = board(doc, page, 'Home', '<header><button>Menu</button></header><nav style="display:flex;gap:8px"><a href="#">Shop</a></nav><form><input type="email" placeholder="Email"><button type="submit">Join</button></form>');
    const done = board(doc, page, 'Done', '<h1>Thanks</h1><button>Back</button>', 500);
    const menuButton = doc.descendants(home).find((n) => n.tag === 'button' && n.text === 'Menu')!.id;
    const nav = doc.descendants(home).find((n) => n.tag === 'nav')!.id;
    const form = doc.descendants(home).find((n) => n.tag === 'form')!.id;
    const input = doc.descendants(home).find((n) => n.tag === 'input')!.id;
    proto(doc, menuButton, { interactions: [{ trigger: 'click', actions: [{ type: 'toggle', variable: 'open' }] }] });
    proto(doc, nav, { showWhen: { variable: 'open', op: 'is' } });
    proto(doc, form, { interactions: [{ trigger: 'submit', actions: [{ type: 'navigate', to: done, transition: 'slide-left' }] }] });
    proto(doc, input, { bind: 'email' });
    const back = doc.descendants(done).find((n) => n.tag === 'button')!.id;
    proto(doc, back, { interactions: [{ trigger: 'click', actions: [{ type: 'back' }] }] });
    return { doc, page, home, done, menuButton, nav, form, input };
  }

  it('reads layers into a model, with the display a hidden layer gets back', () => {
    const { doc, home, done, nav, input } = shop();
    const model = protoModel(doc, [home, done]);
    expect(model.start).toBe(home);
    expect(model.layers[nav]).toMatchObject({ showWhen: { variable: 'open', op: 'is' }, display: 'flex' });
    expect(model.layers[input]).toEqual({ bind: { variable: 'email', kind: 'text' } });
  });

  it('writes one static page with one self-contained script that asks no network', () => {
    const { doc, home, done } = shop();
    const { html, model, script } = exportPrototype(doc, [home]);
    // The screen the form leads to comes along.
    expect(model.screens).toEqual([home, done]);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/<script[^>]*src=/);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain(`data-bogen-id="${done}"`);
    for (const word of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'import(', 'eval(', 'new Function', 'localStorage', 'document.cookie', 'window.open', 'postMessage']) expect(script, word).not.toContain(word);
    // It parses on its own, with no helpers from the build around it.
    expect(() => new Function(script)).not.toThrow();
    expect(script.length).toBeLessThan(16000);
  });

  it('cannot be ended early by what a document says', () => {
    const { doc, page } = fresh();
    setVariable(doc, { name: 'note', type: 'text', value: '</script><img src=x onerror=alert(1)> ' });
    const home = board(doc, page, 'Home', '<p>Hi</p>');
    const { html } = exportPrototype(doc, [home]);
    const inScript = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(inScript).not.toContain('</script');
    expect(inScript).not.toContain('<img');
    expect(inScript).not.toContain(' ');
  });

  it('writes every variant an instance can switch to, and says which is which', () => {
    const { doc, page } = fresh();
    setVariable(doc, { name: 'plan', type: 'text', value: 'monthly' });
    const mainSpec: NewNode = { type: 'frame', name: 'Price', style: { position: 'absolute', left: '900px', top: '0px', display: 'flex', padding: '8px' }, children: [{ type: 'text', tag: 'p', name: 'Amount', text: '9 a month' }] };
    const monthly = doc.insert(page, mainSpec);
    createComponent(doc, monthly, { set: 'Price', variant: { billing: 'monthly' } });
    const yearly = doc.insert(page, { ...mainSpec, children: [{ type: 'text', tag: 'p', name: 'Amount', text: '90 a year' }] });
    createComponent(doc, yearly, { set: 'Price', variant: { billing: 'yearly' } });
    updateComponent(doc, yearly, { set: 'Price', variant: { billing: 'yearly' } });
    const home = board(doc, page, 'Home', '<button>Yearly</button>');
    const card = createInstance(doc, monthly, home);
    proto(doc, card, { variantFrom: { prop: 'billing', variable: 'plan' } });
    const button = doc.descendants(home).find((n) => n.tag === 'button')!.id;
    proto(doc, button, { interactions: [{ trigger: 'click', actions: [{ type: 'set', variable: 'plan', value: 'yearly' }] }] });
    const { html, model } = exportPrototype(doc, [home]);
    const variant = model.layers[card]!.variant!;
    expect(variant).toMatchObject({ prop: 'billing', values: ['monthly', 'yearly'], initial: 'monthly', variable: 'plan' });
    const alt = variant.alts!.yearly!;
    expect(alt).not.toBe(card);
    expect(model.layers[alt]).toMatchObject({ hidden: true, altOf: card, display: 'flex' });
    expect(html).toContain('90 a year');
    expect(html).toContain('9 a month');
    // The original file is untouched.
    expect(doc.getChildren(home)).toHaveLength(2);
  });

  it('keeps the model in the script as data', () => {
    const { doc, home } = shop();
    const { script, model } = exportPrototype(doc, [home]);
    expect(script).toContain(JSON.stringify(model.start));
    expect(protoScript(model)).toBe(script);
  });
});
