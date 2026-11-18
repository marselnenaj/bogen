import { describe, expect, it } from 'vitest';
import { fastBookHtml, safeFontCss, type BookFontSources } from '../src/book-fonts.ts';

const face = (family: string, file: string, range = 'U+0000-00FF, U+0131') => `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/x/${file}.woff2) format('woff2');\n  unicode-range: ${range};\n}`;
const page = (links: string) => `<!doctype html><html><head><meta charset="utf-8"><style>a{}</style>${links}</head><body><main><section>1</section><section>2</section></main></body></html>`;
const link = (q: string) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${q}&amp;display=swap">`;
const sources = (css: (href: string) => Promise<string>, file: BookFontSources['file'] = async () => null): BookFontSources => ({ css, file });

describe('the brand book page', () => {
  it('puts the Google Fonts sheets into the page, so nothing holds up the first paint', async () => {
    const asked: string[] = [];
    const out = await fastBookHtml(page(link('Inline1')), sources(async (href) => { asked.push(href); return face('Inline1', 'a', 'U+0100-02BA'); }));
    expect(asked).toEqual(['https://fonts.googleapis.com/css2?family=Inline1&display=swap']);
    expect(out).not.toContain('<link');
    expect(out).toContain('https://fonts.gstatic.com/s/x/a.woff2');
    expect(out.indexOf('Inline1')).toBeLessThan(out.indexOf('</head>'));
    expect(out).toContain('content-visibility: auto');
  });

  it('puts the Latin files in as data, from the sheet whose faces win', async () => {
    const got: string[] = [];
    const v1 = `${face('Embed1', 'old-latin')}\n${face('Embed1', 'old-ext', 'U+0100-02BA')}`;
    const css2 = `${face('Embed1', 'new-latin')}\n${face('Embed1', 'new-ext', 'U+0100-02BA')}`;
    const html = `${link('Embed1v1')}${link('Embed1v2')}`;
    const out = await fastBookHtml(page(html), sources(async (href) => (href.includes('v1') ? v1 : css2), async (url) => { got.push(url); return 'd09GMgAB'; }));
    expect(got).toEqual(['https://fonts.gstatic.com/s/x/new-latin.woff2']);
    expect(out).toContain("url(data:font/woff2;base64,d09GMgAB) format('woff2')");
    expect(out).toContain('https://fonts.gstatic.com/s/x/old-latin.woff2');
    expect(out).toContain('https://fonts.gstatic.com/s/x/new-ext.woff2');
  });

  it('asks Google once and keeps the sheet', async () => {
    let n = 0;
    const get = sources(async () => { n++; return face('Kept1', 'k'); });
    await fastBookHtml(page(link('Kept1')), get);
    await fastBookHtml(page(link('Kept1')), get);
    expect(n).toBe(1);
  });

  it('moves a sheet it cannot fetch to the end of the body', async () => {
    const out = await fastBookHtml(page(link('Offline1')), sources(async () => { throw new Error('offline'); }));
    const head = out.slice(0, out.indexOf('</head>'));
    expect(head).not.toContain('<link');
    expect(out).toMatch(/<\/main><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Offline1&amp;display=swap"><\/body>/);
  });

  it('keeps only font faces served from fonts.gstatic.com and nothing that could close the style element', () => {
    const f = face('Safe1', 's');
    expect(safeFontCss(f)).toBe(f);
    expect(safeFontCss(f.replace('https://fonts.gstatic.com/', 'https://evil.example/'))).toBeNull();
    expect(safeFontCss(`${f} </style><script>alert(1)</script>`)).toBe(f);
    expect(safeFontCss('@font-face { font-family: "</style>"; src: url(https://fonts.gstatic.com/c.woff2); }')).toBeNull();
    expect(safeFontCss('body { color: red }')).toBeNull();
  });
});
