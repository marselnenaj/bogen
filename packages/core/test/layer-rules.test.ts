import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  BogenDoc, blockKey, cleanRuleValue, createComponent, docFromContent, docToContent, evalWidthMedia, exportDocument, importHtml, layerRulesCss, nodeToHtml, parseBlock,
  ruleScopeClass, rulesCss, rulesToTailwind, toJsx, toReact, widthMediaAsContainer, type NewNode,
} from '../src/index.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

function find(nodes: NewNode[], test: (n: NewNode) => boolean): NewNode | undefined {
  for (const n of nodes) {
    if (test(n)) return n;
    const inner = find(n.children ?? [], test);
    if (inner) return inner;
  }
  return undefined;
}

describe('rule blocks', () => {
  it('reads conditions the way people write them, as one canonical key', () => {
    expect(parseBlock('::before')?.key).toBe('::before');
    expect(parseBlock(':before')?.key).toBe('::before');
    expect(parseBlock('@container   (max-width:560px)  ::after')?.key).toBe('@container (max-width: 560px) ::after');
    expect(parseBlock('@container card (min-width: 400px)')).toMatchObject({ at: { kind: 'container', name: 'card', query: '(min-width: 400px)' } });
    expect(parseBlock('@media (max-width: 760px):hover')?.key).toBe('@media (max-width: 760px) :hover');
    expect(parseBlock('parent[open] ::after')?.key).toBe('parent[open]::after');
    expect(parseBlock('@media print')?.key).toBe('@media print');
    expect(parseBlock('@media (width < 560px)')?.key).toBe('@media (width < 560px)');
    for (const bad of ['', ':visited', '::-webkit-scrollbar', '@supports (display: grid)', '@media (x){}', '@media (a);b', '@media "x"', '@media (a) </style>', '@container card', 'body']) expect(parseBlock(bad), bad).toBeNull();
  });

  it('says why a when or a pseudo cannot be stored', () => {
    expect(blockKey('@container (max-width: 560px)', 'after')).toEqual({ key: '@container (max-width: 560px) ::after' });
    expect(blockKey(undefined, '::marker')).toEqual({ key: '::marker' });
    expect(blockKey(undefined, undefined)).toHaveProperty('error');
    expect(blockKey(':visited', undefined)).toHaveProperty('error');
    expect(blockKey('::before', undefined)).toHaveProperty('error');
    expect(blockKey(undefined, '::backdrop')).toHaveProperty('error');
  });

  it('reads width queries for the artboard', () => {
    expect(widthMediaAsContainer('(max-width: 760px)')).toBe('(max-width: 760px)');
    expect(widthMediaAsContainer('screen and (min-width: 600px) and (max-width: 900px)')).toBe('((min-width: 600px) and (max-width: 900px))');
    expect(widthMediaAsContainer('(max-width: 400px), (min-width: 1200px)')).toBe('((max-width: 400px)) or ((min-width: 1200px))');
    expect(widthMediaAsContainer('(max-height: 500px)')).toBeNull();
    expect(widthMediaAsContainer('(prefers-color-scheme: dark)')).toBeNull();
    expect(evalWidthMedia('(max-width: 760px)', 390)).toBe(true);
    expect(evalWidthMedia('(min-width: 48em)', 700)).toBe(false);
    expect(evalWidthMedia('(width >= 600px)', 600)).toBe(true);
    expect(evalWidthMedia('(400px < width)', 300)).toBe(false);
  });
});

describe('rules on layers', () => {
  it('stores blocks per property, and an old layer has none and renders as before', () => {
    const { doc, page } = fresh();
    const plain = doc.insert(page, { type: 'frame', tag: 'section', style: { width: '100px' } });
    const before = nodeToHtml(doc, plain);
    expect(doc.getNode(plain)?.rules).toBeUndefined();
    expect(before).toBe('<section style="width:100px"></section>');
    doc.updateRules(plain, '::before', { content: '"+"', color: 'red' });
    doc.updateRules(plain, '@container (max-width: 560px)', { display: 'none' });
    expect(doc.getNode(plain)?.rules).toEqual({ '::before': { content: '"+"', color: 'red' }, '@container (max-width: 560px)': { display: 'none' } });
    // Flat in storage, as overrides are, so that blocks and properties merge on their own.
    expect((doc.nodes.get(plain)!.get('rules') as Y.Map<string>).toJSON()).toEqual({ '::before#content': '"+"', '::before#color': 'red', '@container (max-width: 560px)#display': 'none' });
    doc.updateRules(plain, '::before', { color: null });
    doc.deleteRules(plain, '@container (max-width: 560px)');
    expect(doc.getNode(plain)?.rules).toEqual({ '::before': { content: '"+"' } });
    const copy = doc.duplicate([plain])[0]!;
    expect(doc.getNode(copy)?.rules).toEqual({ '::before': { content: '"+"' } });
    // Plain copies, as commits and design folders keep them, carry the blocks.
    const content = JSON.parse(JSON.stringify(docToContent(doc)));
    expect(docFromContent(content).getNode(plain)?.rules).toEqual({ '::before': { content: '"+"' } });
  });

  it('merges two devices editing different blocks and properties of one layer', () => {
    const a = fresh();
    const id = a.doc.insert(a.page, { type: 'frame', rules: { '::after': { content: '""' } } });
    const b = new BogenDoc();
    Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.doc.y));
    a.doc.updateRules(id, '::after', { borderLeft: '8px solid red' });
    a.doc.updateRules(id, '@media (max-width: 760px)', { padding: '8px' });
    b.updateRules(id, '::after', { top: '-5px' });
    b.updateRules(id, ':hover', { color: 'blue' });
    b.updateRules(id, '@media (max-width: 760px)', { margin: '0' });
    Y.applyUpdate(b.y, Y.encodeStateAsUpdate(a.doc.y));
    Y.applyUpdate(a.doc.y, Y.encodeStateAsUpdate(b.y));
    const want = { '::after': { content: '""', borderLeft: '8px solid red', top: '-5px' }, '@media (max-width: 760px)': { padding: '8px', margin: '0' }, ':hover': { color: 'blue' } };
    expect(a.doc.getNode(id)?.rules).toEqual(want);
    expect(b.getNode(id)?.rules).toEqual(want);
  });

  it('reach instances from their main, and an instance overrides one property of one block', () => {
    const { doc, page } = fresh();
    const main = doc.insert(page, { type: 'frame', name: 'Tag', children: [{ type: 'text', name: 'Label', text: 'New', rules: { '::before': { content: '"•"' } } }], rules: { ':hover': { background: 'red' } } });
    createComponent(doc, main, { name: 'Tag' });
    const inst = doc.insert(page, { type: 'frame', instanceOf: main });
    const label = doc.getChildren(inst)[0]!.id;
    expect(doc.getNode(inst)?.rules).toEqual({ ':hover': { background: 'red' } });
    expect(doc.getNode(label)?.rules).toEqual({ '::before': { content: '"•"' } });
    doc.updateRules(label, '::before', { content: '"→"' });
    doc.updateRules(inst, ':hover', { background: 'blue' });
    expect(doc.getNode(label)?.rules?.['::before']?.content).toBe('"→"');
    expect(doc.getNode(inst)?.rules?.[':hover']?.background).toBe('blue');
    expect(doc.getNode(main)?.rules?.[':hover']?.background).toBe('red');
    // A main edit still reaches what the instance did not change.
    doc.updateRules(doc.getChildren(main)[0]!.id, '::before', { color: 'green' });
    expect(doc.getNode(label)?.rules?.['::before']).toEqual({ content: '"→"', color: 'green' });
    expect(nodeToHtml(doc, inst)).toContain(`.${ruleScopeClass(label)}::before{color:green;content:"→"}`);
  });
});

describe('the style sheet of a layer', () => {
  const rules = {
    '::before': { content: '"+"', fontSize: '1.25rem' },
    'parent[open]::after': { content: '"−"' },
    '@container (max-width: 560px) ::after': { display: 'none' },
    '@media (max-width: 1000px)': { padding: '10px' },
    '@media (max-width: 760px)': { padding: '4px' },
    ':hover': { color: 'var(--accent)' },
    '@media (prefers-color-scheme: dark)': { color: 'white' },
  };

  it('writes each block for the layer\'s scope, conditions beating the inline style', () => {
    const css = layerRulesCss('abc', rules);
    const lines = css.split('\n');
    expect(lines).toContain('.bgn-abc::before{content:"+";font-size:1.25rem}');
    expect(lines).toContain('[open] > .bgn-abc::after{content:"−" !important}');
    expect(lines).toContain('@container (max-width: 560px){.bgn-abc::after{display:none !important}}');
    expect(lines).toContain('.bgn-abc:hover{color:var(--accent) !important}');
    expect(lines).toContain('@media (prefers-color-scheme: dark){.bgn-abc{color:white !important}}');
    // The narrower width comes later, so that it wins where both hold.
    expect(css.indexOf('max-width: 1000px')).toBeLessThan(css.indexOf('max-width: 760px'));
  });

  it('reads media widths against the artboard and colour schemes against the mode on the canvas', () => {
    const css = layerRulesCss('abc', rules, { media: 'artboard', artboard: { id: 'board', style: { width: '1200px', containerName: 'page' }, self: false }, within: '.bogen-world ', states: '.pv-world' });
    const lines = css.split('\n');
    expect(lines[0]).toBe('.bogen-world [data-bogen-id="board"]{container-name:page bogen-artboard !important;container-type:inline-size !important}');
    expect(lines).toContain('@container bogen-artboard (max-width: 760px){.bogen-world .bgn-abc{padding:4px !important}}');
    expect(lines).toContain('.bogen-world .bgn-abc:where([data-mode="dark"], [data-mode="dark"] *){color:white !important}');
    expect(lines).toContain('.pv-world .bgn-abc:hover{color:var(--accent) !important}');
    expect(layerRulesCss('abc', rules, { media: 'artboard', states: false })).not.toContain(':hover');
    // A hugging artboard has no width of its own to be a container with.
    expect(layerRulesCss('abc', rules, { media: 'artboard', artboard: { id: 'board', style: { width: 'fit-content' }, self: false } })).not.toContain('container-type');
  });

  it('reads the artboard\'s own media blocks at its width, as no container query can ask about itself', () => {
    const own = { '@media (max-width: 760px)': { padding: '4px' }, '@media (min-width: 761px)': { padding: '40px' } };
    const narrow = layerRulesCss('board', own, { media: 'artboard', artboard: { id: 'board', style: { width: '390px' }, self: true } });
    expect(narrow).toBe('.bgn-board{padding:4px !important}');
  });

  it('puts a breakpoint token\'s value into a query, and leaves the block out without one', () => {
    const css = layerRulesCss('abc', { '@media (max-width: var(--bp-md))': { gap: '0' } }, { token: (n) => (n === 'bp-md' ? '768px' : undefined) });
    expect(css).toBe('@media (max-width: 768px){.bgn-abc{gap:0 !important}}');
    expect(layerRulesCss('abc', { '@media (max-width: var(--nope))': { gap: '0' } })).toBe('');
  });

  it('a hidden layer shows none of its rules', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', hidden: true, rules: { '::before': { content: '"x"' } } });
    expect(nodeToHtml(doc, id)).toBe('<div style="display:none"></div>');
  });
});

describe('sanitizing rules', () => {
  it('refuses values that could leave their block or the style element', () => {
    for (const bad of ['red}body{color:red', 'red; } * { color: red', '"a" </style><script>alert(1)</script>', 'url(javascript:alert(1))', 'expression(alert(1))', '"unclosed', 'calc(1px', 'red\\', '@import url(x)', 'x <!-- y', 'a{b']) expect(cleanRuleValue(bad), bad).toBeNull();
    for (const good of ['"\\2014"', '"a;b}"', 'url(data:image/png;base64,AAAA)', 'linear-gradient(var(--red), var(--red)) no-repeat right 1.25rem center / 8px 8px', 'attr(data-label) " "', 'counter(item) ". "']) expect(cleanRuleValue(good), good).not.toBeNull();
  });

  it('never writes what a hostile peer stored, nor a selector of its making', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame' });
    // Written straight into the map, as a peer that skipped every check could.
    const raw = new Y.Map<string>();
    doc.nodes.get(id)!.set('rules', raw);
    raw.set('::before#content', '"ok"');
    raw.set('::before#color', 'red}body{background:red');
    raw.set('::before#x}body{color', 'red');
    raw.set('body{color:red}#color', 'red');
    raw.set('@media (x){} body {#color', 'red');
    raw.set('@media (max-width: 1px)</style><script>#color', 'red');
    raw.set(':hover#background', 'url(javascript:alert(1))');
    const html = nodeToHtml(doc, id);
    expect(html).toContain('::before{content:"ok"}');
    expect(html).not.toMatch(/body\{|<script|javascript:|x\}/);
    // An id from a peer cannot reach into the selector either.
    const odd = 'a"]{}*{color:red}';
    expect(ruleScopeClass(odd)).toMatch(/^bgn-[\w-]+$/);
    expect(layerRulesCss(odd, { '::before': { content: '""' } })).toMatch(/^\.bgn-[\w-]+::before\{content:""\}$/);
  });
});

describe('importing the tomacco.dev docs', () => {
  const css = readFileSync(join(fixtures, 'tomacco-site.css'), 'utf8');
  const html = readFileSync(join(fixtures, 'tomacco-docs.html'), 'utf8');
  const { nodes, droppedRules } = importHtml(`<style>${css}</style>${html}`);

  it('keeps the code block label, the guides menu sign and its open state', () => {
    const pre = find(nodes, (n) => n.tag === 'pre')!;
    // data-lang is not kept on layers, so attr() reads it now.
    expect(pre.rules?.['::before']).toMatchObject({ content: '"sh"', display: 'block' });
    const summary = find(nodes, (n) => n.tag === 'summary')!;
    expect(summary.rules?.['::after']).toMatchObject({ content: '"+"', fontSize: '1.25rem' });
    expect(summary.rules?.['parent[open]::after']).toEqual({ content: '"−"' });
    expect(summary.rules?.[':hover']).toMatchObject({ background: 'var(--ink)' });
    expect(summary.rules?.['@media (max-width: 760px) :hover']).toEqual({ background: 'var(--ink)' });
    // The page's reset and its focus ring on everything stay with the page.
    expect(find(nodes, (n) => n.tag === 'b')?.rules).toBeUndefined();
  });

  it('keeps the diagram arrows and how they change below 560px of room', () => {
    const figure = find(nodes, (n) => n.tag === 'figure')!;
    expect(figure.style?.containerType).toBe('inline-size');
    const merge = find(nodes, (n) => n.name === 'Dg merge')!;
    expect(merge.rules?.['::before']).toMatchObject({ content: '""', position: 'absolute', borderTop: '2px solid var(--red)', top: '14px' });
    expect(merge.rules?.['::after']).toMatchObject({ content: '""', top: '14px', bottom: '0' });
    expect(merge.rules?.['@container (max-width: 560px) ::before']).toEqual({ display: 'none' });
    expect(merge.rules?.['@container (max-width: 560px) ::after']).toEqual({ top: '0', bottom: '0', height: 'auto', left: '23px' });
    const to = find(nodes, (n) => n.tag === 'li' && n.name === 'Dg to')!;
    expect(to.rules?.['::after']).toMatchObject({ borderLeft: '8px solid var(--red)', borderBlock: '6px solid transparent' });
    expect(to.rules?.['@container (max-width: 560px)']).toEqual({ display: 'none' });
    const rows = (figure.children ?? []).filter((c) => c.tag === 'ol');
    expect(rows[0]!.rules?.['@container (max-width: 560px)']).toEqual({ gridTemplateColumns: 'minmax(0, 1fr)', gap: '0' });
    // Only the second and third box of a row lose their top border: the selector was resolved per element.
    expect(rows[0]!.children!.map((c) => c.rules?.['@container (max-width: 560px)']?.borderTopWidth ?? null)).toEqual([null, '0', '0']);
  });

  it('says what it could not keep', () => {
    expect(droppedRules).toContain('.docs-directory > summary::-webkit-details-marker');
  });

  it('renders on the canvas with the condition read against the diagram, and media against the artboard', () => {
    const { doc, page } = fresh();
    const board = doc.insert(page, { type: 'frame', artboard: true, style: { width: '1200px' }, children: nodes });
    const sheet = rulesCss(doc, [board], { media: 'artboard' });
    expect(sheet).toContain(`[data-bogen-id="${board}"]{container-name:bogen-artboard !important;container-type:inline-size !important}`);
    expect(sheet).toMatch(/@container \(max-width: 560px\)\{\.bgn-\w+::before\{display:none !important\}\}/);
    expect(sheet).toMatch(/@container bogen-artboard \(max-width: 760px\)/);
    const page2 = exportDocument(doc, [board]);
    expect(page2).toMatch(/@media \(max-width: 760px\)\{/);
    expect(page2).not.toContain('bogen-artboard');
  });
});

describe('exports keep rules', () => {
  it('goes from HTML out and back in to the same rules', () => {
    const { doc, page } = fresh();
    const rules = { '::before': { content: '"+"', color: 'red' }, 'parent[open]::after': { content: '"−"' }, '@container card (max-width: 560px)': { display: 'none' }, '@media (max-width: 760px) :hover': { color: 'blue' } };
    const id = doc.insert(page, { type: 'frame', tag: 'section', style: { containerType: 'inline-size' }, rules, children: [{ type: 'text', tag: 'p', text: 'Hi', rules: { '::after': { content: 'attr(title)' } }, attrs: { title: 'Tip' } }] });
    const html = nodeToHtml(doc, id, { indent: true });
    expect(html.startsWith('<style>')).toBe(true);
    const back = importHtml(html).nodes[0]!;
    expect(back.rules).toEqual(rules);
    expect(back.children![0]!.rules).toEqual({ '::after': { content: 'attr(title)' } });
    const doc2 = fresh();
    const again = doc2.doc.insert(doc2.page, back);
    expect(doc2.doc.getNode(again)?.rules).toEqual(rules);
  });

  it('writes React with a style element, and Tailwind variants where they say the same', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', name: 'Box', style: { display: 'flex', gridTemplateColumns: 'repeat(3, 1fr)' }, rules: { '::before': { content: '"+"' }, ':hover': { color: '#ff0000' }, '@container (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr)' }, 'parent:hover': { opacity: '0.5' } } });
    const inline = toJsx(doc, id, 'inline');
    expect(inline).toContain('<style>{');
    expect(inline).toContain(`className="${ruleScopeClass(id)}"`);
    const tw = toJsx(doc, id, 'tailwind');
    expect(tw).toContain("before:content-['+']");
    expect(tw).toContain('hover:text-[color:#ff0000]');
    // Inline in the base style, so the variant needs ! to win.
    // Tailwind's @max-[560px] is width < 560px, so max-width keeps its own query to include 560 itself.
    expect(tw).toContain('[@container(max-width:_560px)]:[grid-template-columns:minmax(0,_1fr)]!');
    // No variant for a parent's state: that one stays CSS.
    expect(tw).toMatch(/\*:hover > \.bgn-\w+\{opacity:0\.5 !important\}/);
    expect(rulesToTailwind({ '@media (orientation: portrait)': { color: 'red' } }).classes).toEqual(['[@media(orientation:_portrait)]:text-[color:red]']);
    expect(rulesToTailwind({ '@media (min-width: 600px)': { color: 'red' }, '@container card (min-width: 20rem)': { color: 'blue' } }).classes.sort()).toEqual(['@min-[20rem]/card:text-[color:blue]', 'min-[600px]:text-[color:red]']);
    // A token in a query is Bogen's to resolve, so that block stays CSS.
    expect(rulesToTailwind({ '@media (max-width: var(--bp-md))': { color: 'red' } }).rest).toEqual({ '@media (max-width: var(--bp-md))': { color: 'red' } });
    const main = doc.insert(page, { type: 'frame', name: 'Chip', rules: { '::after': { content: '"x"' } } });
    createComponent(doc, main, { name: 'Chip' });
    expect(toReact(doc, main, 'inline')).toMatch(/export function Chip[\s\S]*<style>\{".bgn-\w+::after\{content:\\"x\\"\}"\}<\/style>/);
  });
});
