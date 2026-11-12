import { describe, expect, it } from 'vitest';
import { BogenDoc, applySpanStyle, autoLayerName, exportDocument, isGenericName, nameFromClass, nameSpecTree, nodeToHtml, normalizeSpans, rangeHasStyle, remapSpans, renderSpec, runsToHtml, textRuns, toJsx, type BogenNode } from '../src/index.ts';

const text = (patch: Partial<BogenNode>): BogenNode => ({ id: 'x', type: 'text', name: 'x', parent: 'p', order: 'a', tag: 'p', style: {}, text: 'Hello world', ...patch });

describe('rich text ranges', () => {
  it('leaves plain text alone', () => {
    const spec = renderSpec(text({}));
    expect(spec.text).toBe('Hello world');
    expect(spec.html).toBeUndefined();
    expect(renderSpec(text({ spans: [] })).html).toBeUndefined();
  });
  it('cuts text at range edges', () => {
    expect(textRuns('Hello world', [{ start: 6, end: 11, style: { color: 'red' } }])).toEqual([{ text: 'Hello ', style: {} }, { text: 'world', style: { color: 'red' } }]);
  });
  it('renders ranges as inline elements', () => {
    const spec = renderSpec(text({ spans: [{ start: 0, end: 5, style: { fontWeight: '700' } }, { start: 6, end: 11, href: 'https://a.b/?x=1&y=2' }] }));
    expect(spec.html).toBe('<span style="font-weight:700">Hello</span> <a href="https://a.b/?x=1&amp;y=2">world</a>');
  });
  it('escapes what is in the text', () => {
    expect(runsToHtml(textRuns('<b>&', [{ start: 0, end: 3, style: { color: 'red' } }]))).toBe('<span style="color:red">&lt;b&gt;</span>&amp;');
  });
  it('line breaks survive', () => {
    expect(runsToHtml(textRuns('a\nb', [{ start: 0, end: 3, style: { color: 'red' } }]))).toBe('<span style="color:red">a<br>b</span>');
  });
  it('sanitizes what is stored', () => {
    const list = normalizeSpans([
      { start: -5, end: 900, style: { color: 'red;background:url(x)', position: 'fixed', fontWeight: '700' }, href: 'javascript:alert(1)' },
      'nonsense', { start: 3, end: 1, style: { color: 'red' } }, { start: 'a', end: 2 },
    ], 11);
    expect(list).toEqual([{ start: 0, end: 11, style: { fontWeight: '700' } }]);
    expect(normalizeSpans('nope', 5)).toEqual([]);
  });
  it('a stored span cannot break out of a style attribute', () => {
    const html = renderSpec(text({ spans: [{ start: 0, end: 5, style: { color: '"><script>x</script>' } }, { start: 5, end: 7, style: { color: 'blue' } }] })).html!;
    expect(html).not.toContain('script');
  });
  it('flattens overlaps, later wins', () => {
    expect(normalizeSpans([{ start: 0, end: 6, style: { color: 'red' } }, { start: 3, end: 9, style: { color: 'blue', fontWeight: '700' } }], 11)).toEqual([
      { start: 0, end: 3, style: { color: 'red' } },
      { start: 3, end: 9, style: { color: 'blue', fontWeight: '700' } },
    ]);
  });
  it('joins neighbours that look the same', () => {
    expect(normalizeSpans([{ start: 0, end: 3, style: { color: 'red' } }, { start: 3, end: 6, style: { color: 'red' } }], 11)).toEqual([{ start: 0, end: 6, style: { color: 'red' } }]);
  });
  it('styling part of a range splits it', () => {
    const next = applySpanStyle([{ start: 0, end: 10, style: { color: 'red' } }], 11, 3, 6, { fontWeight: '700' });
    expect(next).toEqual([{ start: 0, end: 3, style: { color: 'red' } }, { start: 3, end: 6, style: { color: 'red', fontWeight: '700' } }, { start: 6, end: 10, style: { color: 'red' } }]);
  });
  it('a null clears, and a span with nothing left goes away', () => {
    expect(applySpanStyle([{ start: 0, end: 5, style: { color: 'red' } }], 11, 0, 5, { color: null })).toEqual([]);
    expect(applySpanStyle([{ start: 0, end: 5, href: 'https://a' }], 11, 0, 5, {}, null)).toEqual([]);
  });
  it('fills gaps when a range covers plain text too', () => {
    expect(applySpanStyle([{ start: 2, end: 4, style: { color: 'red' } }], 11, 0, 6, { fontWeight: '700' })).toEqual([{ start: 0, end: 2, style: { fontWeight: '700' } }, { start: 2, end: 4, style: { color: 'red', fontWeight: '700' } }, { start: 4, end: 6, style: { fontWeight: '700' } }]);
  });
  it('tells whether all of a range has a value', () => {
    const spans = [{ start: 0, end: 5, style: { fontWeight: '700' } }];
    expect(rangeHasStyle(spans, 11, 1, 4, 'fontWeight', '700')).toBe(true);
    expect(rangeHasStyle(spans, 11, 1, 7, 'fontWeight', '700')).toBe(false);
    expect(rangeHasStyle(spans, 11, 6, 7, 'fontWeight', '700')).toBe(false);
  });
  describe('edits', () => {
    const s = [{ start: 6, end: 11, style: { color: 'red' } }];
    it('typing before moves it', () => expect(remapSpans(s, 'Hello world', 'Oh Hello world')[0]).toMatchObject({ start: 9, end: 14 }));
    it('typing inside grows it', () => expect(remapSpans(s, 'Hello world', 'Hello wonderful world'.replace('wonderful w', 'wow')).length).toBe(1));
    it('typing at the end extends it', () => expect(remapSpans(s, 'Hello world', 'Hello world!')[0]).toMatchObject({ start: 6, end: 12 }));
    it('typing after it leaves it', () => expect(remapSpans([{ start: 0, end: 5, style: { color: 'red' } }], 'Hello world', 'Hello big world')[0]).toMatchObject({ start: 0, end: 5 }));
    it('deleting all of it removes it', () => expect(remapSpans(s, 'Hello world', 'Hello ')).toEqual([]));
    it('deleting before moves it', () => expect(remapSpans(s, 'Hello world', 'world')[0]).toMatchObject({ start: 0, end: 5 }));
    it('nothing changed, nothing moves', () => expect(remapSpans(s, 'Hello world', 'Hello world')).toEqual(s));
  });
  it('stays through the document, a copy and the exports', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    const id = doc.insert(page, { type: 'text', tag: 'h1', name: 'T', text: 'Hi there', spans: [{ start: 3, end: 8, style: { color: 'red', fontSize: '20px' }, href: 'https://a.b/' }] as never, style: {} });
    expect(doc.getNode(id)!.spans).toHaveLength(1);
    const copy = doc.duplicate([id])[0]!;
    expect(doc.getNode(copy)!.spans).toHaveLength(1);
    expect(nodeToHtml(doc, id)).toContain('<a href="https://a.b/" style="color:red;font-size:20px">there</a>');
    expect(exportDocument(doc, [id])).toContain('there</a></h1>');
    const jsx = toJsx(doc, id, 'inline');
    expect(jsx).toContain('<a href="https://a.b/" style={{ color: "red", fontSize: "20px" }}>there</a>');
    expect(jsx).toContain('{"Hi "}<a');
    expect(toJsx(doc, id, 'tailwind')).toContain('text-[length:20px]');
    doc.updateFields(id, { spans: undefined });
    expect(doc.getNode(id)!.spans).toBeUndefined();
  });
});

describe('layer names', () => {
  it('knows what is generic', () => {
    expect(isGenericName('Frame')).toBe(true);
    expect(isGenericName('Frame 12')).toBe(true);
    expect(isGenericName('Hero')).toBe(false);
    expect(isGenericName('')).toBe(true);
  });
  it('reads classes, not build artifacts', () => {
    expect(nameFromClass('hero-card')).toBe('Hero card');
    expect(nameFromClass('flex items-center pricing__table')).toBe('Pricing table');
    expect(nameFromClass('css-1a2b3c sc-xyz')).toBeNull();
    expect(nameFromClass('w-full p-4')).toBeNull();
    expect(nameFromClass('heroCard')).toBe('Hero card');
  });
  it('prefers a label, then a role, then the element', () => {
    expect(autoLayerName({ type: 'frame', tag: 'div', attrs: { 'aria-label': 'Main menu' } })).toBe('Main menu');
    expect(autoLayerName({ type: 'frame', tag: 'div', attrs: { role: 'navigation' } })).toBe('Navigation');
    expect(autoLayerName({ type: 'frame', tag: 'nav' })).toBe('Navigation');
    expect(autoLayerName({ type: 'frame', tag: 'button', firstText: 'Sign up' })).toBe('Button: Sign up');
    expect(autoLayerName({ type: 'frame', tag: 'section', firstText: 'Plans that grow with you, every step of the way' })).toBe('Section: Plans that grow with you,…');
  });
  it('says what a layout is, with the words in it', () => {
    expect(autoLayerName({ type: 'frame', tag: 'div', style: { display: 'flex' }, firstText: 'Hello', childCount: 2 })).toBe('Row: Hello');
    expect(autoLayerName({ type: 'frame', tag: 'div', style: { display: 'flex', flexDirection: 'column' }, childCount: 2 })).toBe('Column');
    expect(autoLayerName({ type: 'frame', tag: 'div', style: { display: 'grid' }, childCount: 2 })).toBe('Grid');
    expect(autoLayerName({ type: 'frame', tag: 'div', childCount: 3 })).toBe('Group');
    expect(autoLayerName({ type: 'frame', tag: 'div', style: { borderRadius: '50%' } })).toBe('Ellipse');
  });
  it('text is named by its first line, images by their alt', () => {
    expect(autoLayerName({ type: 'text', tag: 'p', text: '\n  First line\nSecond' })).toBe('First line');
    expect(autoLayerName({ type: 'image', attrs: { alt: 'A cat' } })).toBe('A cat');
  });
  it('a tree: generic names go, given names stay', () => {
    const tree = nameSpecTree({ type: 'frame', name: 'Frame', tag: 'div', style: { display: 'flex' }, children: [{ type: 'frame', name: 'Hero', tag: 'div' }, { type: 'text', name: 'Hi', text: 'Hi' }] });
    expect(tree.name).toBe('Row: Hi');
    expect(tree.children![0]!.name).toBe('Hero');
  });
  it('a captured name that is really a class becomes words', () => {
    expect(nameSpecTree({ type: 'frame', name: 'pricing-table', tag: 'div' }, true).name).toBe('Pricing table');
    expect(nameSpecTree({ type: 'frame', name: 'pricing-table', tag: 'div' }).name).toBe('pricing-table');
  });
});
