import { describe, expect, it } from 'vitest';
import { importHtml, renderSpec, type BogenNode } from '../src/index.ts';

const one = (html: string) => importHtml(html).nodes[0]!;

describe('html import of inline text', () => {
  it('keeps the spaces around inline elements and turns them into ranges', () => {
    const p = one('<p>Hello <strong>world</strong> today</p>');
    expect(p).toMatchObject({ type: 'text', text: 'Hello world today', spans: [{ start: 6, end: 11, style: { fontWeight: '700' } }] });
    // A styled inline element used to split the paragraph into layers with the spaces trimmed off.
    const styled = one('<p>Hello <strong style="color:red">world</strong>, <a href="https://a.b/">link</a> and <em>more</em></p>');
    expect(styled.type).toBe('text');
    expect(styled.text).toBe('Hello world, link and more');
    expect(styled.spans).toEqual([
      { start: 6, end: 11, style: { fontWeight: '700', color: 'red' } },
      { start: 13, end: 17, href: 'https://a.b/' },
      { start: 22, end: 26, style: { fontStyle: 'italic' } },
    ]);
    const html = renderSpec({ id: 'x', parent: 'p', order: 'a', name: 'x', style: {}, ...styled } as BogenNode).html!;
    expect(html).toContain('Hello <span style="font-weight:700;color:red">world</span>, <a href="https://a.b/">link</a> and');
  });

  it('collapses white space as a browser does, across element edges and line breaks', () => {
    const p = one('<p>  Line\n one <b> bold </b> end <br>  next  </p>');
    expect(p.text).toBe('Line one bold end\nnext');
    expect(p.spans).toEqual([{ start: 9, end: 14, style: { fontWeight: '700' } }]);
    // Classes from a style block count as the element's style.
    expect(one('<style>.k{color:#0a0}</style><p>Go <span class="k">now</span></p>')).toMatchObject({ text: 'Go now', spans: [{ start: 3, end: 6, style: { color: '#0a0' } }] });
  });

  it('keeps a no-break space', () => {
    expect(one('<p>A&nbsp;B <em>x</em>&nbsp;y</p>').text).toBe('A B x y');
    expect(one('<p>10&nbsp;%</p>').text).toBe('10 %');
  });

  it('keeps word spaces between inline boxes that stay layers of their own', () => {
    const p = one('<p>Run <span style="padding:2px 4px;background:#eee">npm i</span> first</p>');
    expect(p.type).toBe('frame');
    expect(p.children!.map((c) => c.text)).toEqual(['Run ', 'npm i', ' first']);
    // In a flex row the gap does the spacing, so nothing is added there.
    const row = one('<div style="display:flex">One <b style="padding:4px">Two</b></div>');
    expect(row.children!.map((c) => c.text)).toEqual(['One', 'Two']);
  });

  it('keeps every space and line break in <pre> and under white-space: pre, as a browser shows them', () => {
    // The line break right after <pre> is dropped by HTML itself, and one at the end shows nothing.
    const pre = one('<pre style="font-family:monospace">\n  const a = 1;\n    return  a;\n</pre>');
    expect(pre).toMatchObject({ type: 'text', tag: 'pre', text: '  const a = 1;\n    return  a;' });
    // A text layer wraps by default; a <pre> does not.
    expect(pre.style!.whiteSpace).toBe('pre');
    const code = one('<pre><code>if (x) {\n\treturn;\n}</code></pre>');
    expect(code).toMatchObject({ text: 'if (x) {\n\treturn;\n}', spans: [{ start: 0, end: 19, style: { fontFamily: 'monospace' } }] });
    expect(one('<p style="white-space:pre-wrap">   lead  two</p>')).toMatchObject({ text: '   lead  two', style: { whiteSpace: 'pre-wrap' } });
    expect(one('<div style="white-space:break-spaces"><b>  x</b>  y</div>').text).toBe('  x  y');
    // pre-line keeps the breaks and collapses the rest.
    expect(one('<p style="white-space:pre-line">  a   b\n   c  </p>').text).toBe('a b\nc');
    // Inherited from a parent, also in text between boxes.
    const box = one('<div style="white-space:pre"><div style="padding:4px">  in  box</div>  loose  text</div>');
    expect(box.children!.map((c) => c.text)).toEqual(['  in  box', '  loose  text']);
    // A style block's rule counts as well, and normal text still collapses.
    expect(one('<style>.code{white-space:pre}</style><p class="code">a    b</p>').text).toBe('a    b');
    expect(one('<p>  plain   lead</p>').text).toBe('plain lead');
    expect(one('<div style="white-space:pre"><p style="white-space:normal">  back   to normal</p></div>').children![0]!.text).toBe('back to normal');
  });

  it('leaves a lone styled child as its own layer, and nothing unsafe gets into a range', () => {
    expect(one('<p><span style="color:red">Solo</span></p>').type).toBe('frame');
    const p = one('<p>Click <a href="javascript:alert(1)">here</a> now</p>');
    expect(p.text).toBe('Click here now');
    expect(p.spans).toBeUndefined();
  });
});
