import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BogenDoc, exportDocument, importHtml, nodeToHtml, parseStyle, styleToTailwind, toJsx } from '../src/index.ts';

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

describe('html import in layout containers', () => {
  it('keeps inline children of flex and grid containers as separate layers', () => {
    const { nodes } = importHtml('<nav style="display:flex;gap:8px"><a href="#a">One</a><a href="#b">Two</a></nav>');
    expect(nodes[0]!.type).toBe('frame');
    expect(nodes[0]!.children!.map((c) => [c.type, c.text, c.attrs?.href])).toEqual([['text', 'One', '#a'], ['text', 'Two', '#b']]);
  });

  it('still reads inline tags in a plain block as one text layer', () => {
    const { nodes } = importHtml('<p>Hello <b>there</b></p>');
    expect(nodes[0]).toMatchObject({ type: 'text', text: 'Hello there' });
    expect(importHtml('<div style="display:flex">Only text</div>').nodes[0]!.type).toBe('text');
  });
});

describe('document', () => {
  it('keeps child order through insert, move and duplicate', () => {
    const { doc, page } = fresh();
    const [a, b, c] = doc.insertMany(page, [{ type: 'frame', name: 'a' }, { type: 'frame', name: 'b' }, { type: 'frame', name: 'c' }]);
    expect(doc.getChildren(page).map((n) => n.name)).toEqual(['a', 'b', 'c']);
    doc.move([c!], page, 0);
    expect(doc.getChildren(page).map((n) => n.name)).toEqual(['c', 'a', 'b']);
    doc.duplicate([a!]);
    expect(doc.getChildren(page).map((n) => n.name)).toEqual(['c', 'a', 'a', 'b']);
    expect(b).toBeTruthy();
  });

  it('reads only the asked parent\'s layers after a write, and sees the write', () => {
    const { doc, page } = fresh();
    const [a, b] = doc.insertMany(page, [
      { type: 'frame', name: 'a', children: Array.from({ length: 50 }, (_, i) => ({ type: 'frame' as const, name: `a${i}` })) },
      { type: 'frame', name: 'b', children: [{ type: 'text', name: 'b0', text: 'One' }, { type: 'text', name: 'b1', text: 'Two' }] },
    ]);
    expect(doc.getChildren(b!).map((n) => n.text)).toEqual(['One', 'Two']);
    const b1 = doc.getChildren(b!)[1]!.id;
    doc.updateFields(b1, { text: 'Three' });
    doc.updateStyle(b1, { color: 'red' });
    let reads = 0;
    const raw = doc.rawNode.bind(doc);
    doc.rawNode = (id) => { reads++; return raw(id); };
    expect(doc.rawKids(a!)).toHaveLength(50);
    expect(reads).toBe(0);
    expect(doc.getChildren(b!).map((n) => [n.text, n.style.color])).toEqual([['One', undefined], ['Three', 'red']]);
    expect(reads).toBe(2);
    doc.getChildren(b!);
    expect(reads).toBe(2);
    expect(doc.getChildren('nothing')).toEqual([]);
  });

  it('moves several layers between siblings keeping their relative order', () => {
    const { doc, page } = fresh();
    const [a, b, , d] = doc.insertMany(page, ['a', 'b', 'c', 'd'].map((name) => ({ type: 'frame' as const, name })));
    doc.move([a!, b!], page, 3);
    expect(doc.getChildren(page).map((n) => n.name)).toEqual(['c', 'a', 'b', 'd']);
    expect(d).toBeTruthy();
  });

  it('refuses to move a layer into its own subtree', () => {
    const { doc, page } = fresh();
    const a = doc.insert(page, { type: 'frame' });
    const b = doc.insert(a, { type: 'frame' });
    expect(() => doc.move([a], b)).toThrow(/into itself/);
  });

  it('refuses children on layers that cannot hold them', () => {
    const { doc, page } = fresh();
    const t = doc.insert(page, { type: 'text', text: 'x' });
    expect(() => doc.insert(t, { type: 'frame' })).toThrow(/cannot hold children/);
  });

  it('merges styles and removes properties set to empty', () => {
    const { doc, page } = fresh();
    const a = doc.insert(page, { type: 'frame', style: { color: 'red', width: '10px' } });
    doc.updateStyle(a, { color: '', width: '20px', height: '5px' });
    expect(doc.getNode(a)!.style).toEqual({ width: '20px', height: '5px' });
  });

  it('deletes a whole subtree', () => {
    const { doc, page } = fresh();
    const a = doc.insert(page, { type: 'frame', children: [{ type: 'frame', children: [{ type: 'text', text: 'x' }] }] });
    expect(doc.nodes.size).toBe(3);
    doc.delete([a]);
    expect(doc.nodes.size).toBe(0);
  });

  it('merges concurrent edits from two peers', () => {
    const { doc, page } = fresh();
    const a = doc.insert(page, { type: 'frame', style: { width: '10px' } });
    const peer = new BogenDoc(new Y.Doc());
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    doc.updateStyle(a, { color: 'red' });
    peer.updateStyle(a, { height: '5px' });
    peer.insert(page, { type: 'text', text: 'hi' });
    Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(peer.y));
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    expect(doc.getNode(a)!.style).toEqual({ width: '10px', color: 'red', height: '5px' });
    expect(doc.getChildren(page).length).toBe(2);
    expect(peer.getChildren(page).length).toBe(2);
  });

  it('survives a parent cycle made by concurrent moves', () => {
    const { doc, page } = fresh();
    const a = doc.insert(page, { type: 'frame' });
    const b = doc.insert(page, { type: 'frame' });
    const peer = new BogenDoc(new Y.Doc());
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    doc.move([a], b);
    peer.move([b], a);
    Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(peer.y));
    expect(doc.pageOf(a)).toBeUndefined();
    expect(doc.ancestors(a).length).toBeLessThan(3);
  });

  it('undoes per actor', () => {
    const { doc, page } = fresh();
    const undo = new Y.UndoManager([doc.nodes], { trackedOrigins: new Set(['agent:x']) });
    doc.insert(page, { type: 'frame', name: 'mine' }, undefined, 'me');
    doc.insert(page, { type: 'frame', name: 'agent' }, undefined, 'agent:x');
    undo.undo();
    expect(doc.getChildren(page).map((n) => n.name)).toEqual(['mine']);
  });
});

describe('importHtml', () => {
  it('keeps semantic tags and inline styles', () => {
    const { nodes } = importHtml('<section style="display:flex;gap:8px"><h1 style="font-size:40px">Hi</h1><p>Body <b>bold</b></p></section>');
    const root = nodes[0]!;
    expect(root).toMatchObject({ type: 'frame', tag: 'section', style: { display: 'flex', gap: '8px' } });
    expect(root.children![0]).toMatchObject({ type: 'text', tag: 'h1', text: 'Hi', style: { fontSize: '40px' } });
    expect(root.children![1]).toMatchObject({ type: 'text', tag: 'p', text: 'Body bold' });
  });

  it('applies style sheets by specificity and lets inline win', () => {
    const { nodes, keyframes } = importHtml('<style>.a{color:red;width:1px}div.a{color:blue}#x{width:2px}@keyframes f{to{opacity:0}}a:hover{color:pink}</style><div id="x" class="a" style="height:3px"><span class="a">t</span></div>');
    expect(nodes[0]!.style).toMatchObject({ color: 'blue', width: '2px', height: '3px' });
    expect(keyframes[0]).toContain('@keyframes f');
  });

  it('strips scripts, handlers and javascript urls', () => {
    const { nodes } = importHtml('<div onclick="x()"><script>evil()</script><a href="javascript:alert(1)" data-name="l">go</a><img src="javascript:alert(1)"><svg onload="x()"><script>y()</script><path d="M0 0" onclick="z()"/></svg></div>');
    const json = JSON.stringify(nodes);
    expect(json).not.toMatch(/evil|alert|onload|onclick/);
    expect(nodes[0]!.children![2]!.type).toBe('svg');
    expect(nodes[0]!.children![2]!.svg).toContain('<path');
  });

  it('refuses unsafe css values', () => {
    const { nodes } = importHtml('<div style="background:url(javascript:x);color:red"></div>');
    expect(nodes[0]!.style).toEqual({ color: 'red' });
  });

  it('parses declarations with urls and semicolons in strings', () => {
    expect(parseStyle('background:url("a;b.png");content:"x;y";color:red !important')).toEqual({ background: 'url("a;b.png")', content: '"x;y"', color: 'red' });
  });

  it('makes shader layers from x-shader', () => {
    const { nodes } = importHtml('<x-shader type="MeshGradient" colors="#000 #fff" speed="0.4" style="width:100px"></x-shader>');
    expect(nodes[0]).toMatchObject({ type: 'shader', attrs: { type: 'MeshGradient', colors: '#000 #fff', speed: '0.4' }, style: { width: '100px' } });
  });
});

describe('export', () => {
  it('round trips through HTML', () => {
    const { doc, page } = fresh();
    const html = '<section style="display:flex;gap:8px"><h1 style="font-size:40px">Hi &amp; bye</h1><img src="https://a.test/x.png" alt="x"></section>';
    const [id] = doc.insertMany(page, importHtml(html).nodes);
    const out = nodeToHtml(doc, id!);
    expect(out).toContain('<section');
    expect(out).toContain('<h1 style="font-size:40px;white-space:pre-wrap">Hi &amp; bye</h1>');
    expect(out).toContain('src="https://a.test/x.png"');
    const again = new BogenDoc();
    again.ensureFirstPage();
    const [id2] = again.insertMany(again.getPages()[0]!.id, importHtml(out).nodes);
    expect(again.getChildren(id2!).map((n) => n.tag)).toEqual(['h1', 'img']);
  });

  it('writes tokens into exported documents', () => {
    const { doc, page } = fresh();
    doc.setToken('brand', 'color', '#123456');
    const id = doc.insert(page, { type: 'frame', style: { color: 'var(--brand)' } });
    expect(exportDocument(doc, [id])).toContain('--brand:#123456');
  });

  it('exports React with Tailwind and falls back to style for the rest', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', name: 'hero card', tag: 'section', style: { position: 'absolute', left: '10px', display: 'flex', gap: '8px', backgroundColor: 'var(--brand)', mixBlendMode: 'multiply' }, children: [{ type: 'text', tag: 'h1', text: 'a{b}' }] });
    const jsx = toJsx(doc, id);
    expect(jsx).toContain('export function HeroCard()');
    expect(jsx).toContain('flex gap-[8px] bg-(--brand)');
    expect(jsx).toContain('mixBlendMode: "multiply"');
    expect(jsx).not.toContain('left');
    expect(jsx).toContain('{"a{b}"}');
  });

  it('covers common utilities', () => {
    expect(styleToTailwind({ width: '100%', flexDirection: 'column', marginTop: '-4px', fontWeight: '600' }).classes).toEqual(['w-full', 'flex-col', '-mt-[4px]', 'font-[600]']);
  });
});

describe('parsing the output gives the same tree', () => {
  it('keeps a vector inside a paragraph', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', tag: 'p', children: [{ type: 'svg', svg: '<svg></svg>' }, { type: 'text', tag: 'span', text: 'x' }] });
    expect(nodeToHtml(doc, id)).toMatch(/^<p><span[^>]*><svg/);
  });

  it('turns a paragraph holding blocks into a div', () => {
    const { doc, page } = fresh();
    const id = doc.insert(page, { type: 'frame', tag: 'p', children: [{ type: 'frame', tag: 'div' }] });
    expect(nodeToHtml(doc, id)).toMatch(/^<div><div/);
  });
});

describe('stored documents are not trusted', () => {
  const hostile = (spec: Parameters<BogenDoc['insert']>[1]) => {
    const { doc, page } = fresh();
    const id = doc.insert(page, spec);
    return nodeToHtml(doc, id);
  };

  it.each([
    ['event handler on svg', '<svg onload="alert(1)"><path d="M0 0"/></svg>'],
    ['html element in svg', '<svg><img src="x" onerror="alert(1)"/></svg>'],
    ['comment parser differential', '<svg><!--><img src=x onerror=alert(1)>--></svg>'],
    ['cdata parser differential', '<svg><![CDATA[><img src=x onerror=alert(1)>]]></svg>'],
    ['script element', '<svg><script>alert(1)</script></svg>'],
    ['foreign object', '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>'],
    ['script url link', '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'],
    ['animated link target', '<svg><a><animate attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>'],
    ['style breakout', '<svg><style><![CDATA[</style><img src=x onerror=alert(1)>]]></style></svg>'],
  ])('neutralizes %s', (_, svg) => {
    const html = hostile({ type: 'svg', svg });
    expect(html).not.toMatch(/alert|onerror|onload|<img|<script|<iframe/i);
  });

  it('keeps ordinary svg intact', () => {
    const html = hostile({ type: 'svg', svg: '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><path d="M0 0L5 5" fill="url(#g)"/><use href="#g"/></svg>' });
    expect(html).toContain('<path d="M0 0L5 5" fill="url(#g)"/>');
    expect(html).toContain('<linearGradient id="g">');
    expect(html).toContain('href="#g"');
  });

  it('never renders an active element from a stored tag', () => {
    for (const tag of ['script', 'iframe', 'object', 'base', 'style', 'img onerror=x', 'x-evil']) {
      expect(hostile({ type: 'frame', tag })).toMatch(/^<div/);
      expect(hostile({ type: 'text', tag, text: 'x' })).toMatch(/^<div/);
    }
    expect(hostile({ type: 'frame', tag: 'section' })).toMatch(/^<section/);
  });

  it('drops event handlers, srcdoc and script urls from stored attributes', () => {
    const html = hostile({ type: 'frame', tag: 'a', attrs: { onclick: 'alert(1)', srcdoc: '<script>', href: 'javascript:alert(1)', 'aria-label': 'ok' } });
    expect(html).not.toMatch(/onclick|srcdoc|alert/);
    expect(html).toContain('aria-label="ok"');
  });

  it('drops script urls from image and embed sources and keeps the sandbox', () => {
    expect(hostile({ type: 'image', src: 'javascript:alert(1)' })).not.toContain('alert');
    expect(hostile({ type: 'embed', src: 'https://a.test/', attrs: { sandbox: 'allow-same-origin allow-scripts' } })).toContain('sandbox="allow-scripts"');
  });
});
