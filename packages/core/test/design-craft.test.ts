import { describe, expect, it } from 'vitest';
import { BogenDoc, CRAFT_CRITERION, CRAFT_LIMITS, craftFindings, designReview, importHtml, type CraftRule } from '../src/index.ts';
import { CONSIDERED, CRAFT_TOKENS, GENERATED } from './fixtures/design-craft.ts';

function build(html: string, options: { style?: Record<string, string>; attrs?: Record<string, string>; name?: string; tokens?: boolean; template?: boolean; theme?: boolean } = {}) {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  // What an Omarchy theme file records about itself.
  if (options.theme) doc.meta.set('omarchyTheme', { name: 'Test', target: 'desktop' });
  if (options.tokens) for (const t of CRAFT_TOKENS) doc.setToken(t.name, t.kind, t.value);
  const id = doc.insert(doc.getPages()[0]!.id, { type: 'frame', name: options.name ?? 'Page', artboard: true, style: { width: '1440px', display: 'flex', flexDirection: 'column', ...options.style }, ...(options.attrs ? { attrs: options.attrs } : {}) });
  // A template may write data-brand-example; html an agent writes may not.
  doc.insertMany(id, importHtml(html, { counterExamples: options.template }).nodes);
  doc.invalidate();
  return { doc, id };
}
const rules = (html: string, options?: Parameters<typeof build>[1]): CraftRule[] => {
  const { doc, id } = build(html, options);
  return craftFindings(doc, id).map((f) => f.rule);
};
const finding = (html: string, rule: CraftRule, options?: Parameters<typeof build>[1]) => {
  const { doc, id } = build(html, options);
  return craftFindings(doc, id).find((f) => f.rule === rule);
};
const p = (n: number, style = '') => Array.from({ length: n }, (_, i) => `<p style="${style}">Paragraph number ${i} of the running text</p>`).join('');

describe('craft checks on a whole page', () => {
  it('finds every habit of the generated page, and each finding says what to do', () => {
    const { doc, id } = build(GENERATED, { tokens: true });
    const found = craftFindings(doc, id);
    expect(found.map((f) => f.rule).sort()).toEqual([
      'all-caps', 'boxes', 'centred', 'decorative-mono', 'default-gradient', 'eyebrow', 'font-families', 'glow', 'heavy-type', 'loud-type',
      'nested-boxes', 'pattern-background', 'primary-actions', 'text-on-image', 'tilt', 'type-scale', 'window-chrome',
    ]);
    for (const f of found) {
      expect(f.criterion, f.rule).toBe(CRAFT_CRITERION[f.rule]);
      expect(doc.getNode(f.nodeId), f.rule).toBeDefined();
      expect(f.layers.length, f.rule).toBeGreaterThan(0);
      // A number or a name from the page, and an instruction: not a verdict.
      expect(f.message, f.rule).toMatch(/\d|"/);
      expect(f.message, f.rule).toMatch(/\b(set|use|keep|remove|delete|put|take|show|centre)\b/i);
    }
    const by = (rule: CraftRule) => found.find((f) => f.rule === rule)!;
    expect(by('font-families').message).toContain('3 font families on one artboard (Space Grotesk on 11, JetBrains Mono on 4, Georgia on 1)');
    expect(by('loud-type').numbers).toEqual({ loud: 6, largest: 72 });
    expect(by('primary-actions').message).toContain('2 different actions in "Hero" share one filled style ("Start free trial", "Book a demo")');
    expect(by('centred').numbers).toEqual({ share: 0.88 });
  });

  it('stays quiet on the considered page for the same product', () => {
    const { doc, id } = build(CONSIDERED, { tokens: true });
    expect(craftFindings(doc, id)).toEqual([]);
    expect(designReview(doc, id).observations).toEqual([]);
  });

  it('reaches design_review with its rule id, without saying twice what the review already says', () => {
    const { doc, id } = build(GENERATED, { tokens: true });
    const { observations } = designReview(doc, id);
    const craft = observations.filter((o) => o.rule);
    expect(craft.map((o) => o.rule)).toContain('glow');
    expect(craft.find((o) => o.rule === 'loud-type')!.aspect).toBe('hierarchy');
    // The review has its own observation for a label over every heading.
    expect(observations.filter((o) => o.message.includes('small uppercase label over them'))).toHaveLength(1);
    expect(craft.some((o) => o.rule === 'eyebrow')).toBe(false);
  });
});

describe('each craft check has a testable line', () => {
  it('font families: two pass, a third is named, generic stacks do not count', () => {
    const three = `<h1 style="font-family:'Fraunces',serif">Title of the page</h1><p style="font-family:Inter,sans-serif">Body</p><p style="font-family:'IBM Plex Mono',monospace">const a = 1;</p>`;
    expect(rules(three)).toEqual(['font-families']);
    expect(finding(three, 'font-families')!.numbers).toEqual({ families: 3 });
    expect(rules(`<h1 style="font-family:'Fraunces',serif">Title of the page</h1><p style="font-family:Inter,sans-serif">Body</p><p style="font-family:system-ui">More</p><p style="font-family:sans-serif">More</p>`)).toEqual([]);
    expect(CRAFT_LIMITS.families).toBe(2);
  });

  it('monospace: flagged on labels, not on code, commands or figures, and not for a single use', () => {
    const mono = `font-family:'JetBrains Mono',monospace`;
    expect(rules(`<p style="${mono}">Built for teams</p><p style="${mono}">Now in beta</p>`)).toEqual(['decorative-mono']);
    expect(rules(`<p style="${mono}">Built for teams</p>`)).toEqual([]);
    expect(rules(`<pre style="${mono}">hello world</pre><code style="${mono}">plain words</code><p style="${mono}">npm install bogen-design</p><p style="${mono}">12.480,00</p><p style="${mono}">render(page)</p>`)).toEqual([]);
    // Inherited from a parent, as html usually has it.
    expect(rules(`<div style="${mono}"><p>Built for teams</p><p>Now in beta</p></div>`)).toEqual(['decorative-mono']);
  });

  it('type scale: a literal size within 8% of a step but not on it; a token, a step by value and a size of its own pass', () => {
    // The scale is 14, 17, 22, 32, 76: 15 sits beside 14 (7%), 26 and 48 beside nothing.
    const html = `<p style="font-size:15px">Beside a step</p><p style="font-size:var(--text-base)">On it</p><p style="font-size:17px">On it by value</p><p style="font-size:26px">Its own step</p><p style="font-size:48px">Its own step</p>`;
    const f = finding(html, 'type-scale', { tokens: true })!;
    expect(f.numbers).toEqual({ layers: 1, sizes: 1 });
    expect(f.message).toContain('15px on 1, beside var(--text-sm) at 14px');
    // A file without a declared scale has nothing to be beside.
    expect(rules(html)).toEqual([]);
    expect(CRAFT_LIMITS.scaleNear).toBe(0.08);
  });

  it('loud type: three peaks pass, a fourth does not, and a size a quarter smaller is not loud', () => {
    const h = (n: number, size = 64) => Array.from({ length: n }, (_, i) => `<h2 style="font-size:${size}px;font-weight:400">Heading ${i}</h2>`).join('');
    expect(rules(h(3) + p(3))).toEqual([]);
    expect(rules(h(4) + p(3))).toEqual(['loud-type']);
    expect(rules(h(1) + h(5, 48) + p(3))).toEqual([]);
    expect(rules(h(1) + h(3, 56) + p(3))).toEqual(['loud-type']);
    // Small type everywhere is a tool, not a shouting page.
    expect(rules(h(6, 20) + p(3))).toEqual([]);
  });

  it('heavy type: more than two thirds of the words in 600 or heavier, from eight texts up', () => {
    expect(rules(p(8, 'font-weight:600'))).toEqual(['heavy-type']);
    expect(rules(p(6, 'font-weight:700') + p(2))).toEqual(['heavy-type']);
    expect(rules(p(5, 'font-weight:700') + p(4))).toEqual([]);
    expect(rules(p(7, 'font-weight:700'))).toEqual([]);
  });

  it('capitals: three texts, or one long run; an acronym is not one', () => {
    expect(rules('<p>FEATURES</p><p>PRICING</p>')).toEqual([]);
    expect(rules('<p>FEATURES</p><p>PRICING</p><p style="text-transform:uppercase">Contact us</p>')).toEqual(['all-caps']);
    expect(rules('<p>FAQ</p><p>HTML</p><p>USD</p><p>API</p>')).toEqual([]);
    expect(rules('<p>THE ONLY INVOICING TOOL YOU WILL EVER NEED</p>')).toEqual(['all-caps']);
    expect(rules('<p>日本語のテキストです</p><p>日本語のテキスト</p><p>日本語のテキストで</p>')).toEqual([]);
  });

  it('labels over headings: one may carry information, two are a habit', () => {
    const block = (label: string) => `<div><p style="font-size:13px">${label}</p><h2 style="font-size:32px">A heading for the section</h2></div>`;
    expect(rules(block('New in version 4'))).toEqual([]);
    expect(rules(block('Features') + block('Pricing'))).toEqual(['eyebrow']);
    expect(rules(`<div><p style="font-size:18px">A lead paragraph before the heading</p><h2 style="font-size:32px">Heading</h2></div>`.repeat(2))).toEqual([]);
  });

  it('centred: more than seven in ten texts, from six texts up', () => {
    expect(rules(`<div style="text-align:center">${p(8)}</div>${p(2)}`)).toEqual(['centred']);
    expect(rules(`<div style="text-align:center">${p(6)}</div>${p(4)}`)).toEqual([]);
    expect(rules(`<div style="text-align:center">${p(5)}</div>`)).toEqual([]);
  });

  it('primary actions: the same fill on two different actions in one section', () => {
    const a = (label: string, style = 'background:#c2410c;color:#fff') => `<a href="#x" style="${style}">${label}</a>`;
    const section = (inner: string) => `<section>${inner}</section>`;
    expect(rules(section(a('Start trial') + a('Book a demo')) + section('<p>Rest</p>'))).toEqual(['primary-actions']);
    expect(rules(section(a('Start trial') + a('Book a demo', 'border:1px solid #c2410c;color:#c2410c')) + section('<p>Rest</p>'))).toEqual([]);
    // The same action at the top and the bottom of a page is one action.
    expect(rules(section(a('Start trial')) + section(a('Start trial')))).toEqual([]);
    expect(rules(section(a('Start trial') + a('Start trial')) + section('<p>Rest</p>'))).toEqual([]);
    expect(rules(section(a('Start trial')) + section(a('Read the docs')))).toEqual([]);
    expect(rules(section(a('Save') + a('Cancel', 'background:#e5e7eb;color:#111')) + section('<p>Rest</p>'))).toEqual([]);
  });

  it('glow: a saturated shadow with 8px blur or more, not a neutral shadow or a tight coloured one', () => {
    const box = (shadow: string) => `<div style="${shadow}"><p>Card</p></div>`;
    expect(rules(box('box-shadow:0 0 40px rgba(124,58,237,0.6)'))).toEqual(['glow']);
    expect(rules(box('box-shadow:0 8px 24px rgba(0,0,0,0.18)'))).toEqual([]);
    expect(rules(box('box-shadow:0 1px 2px #7c3aed'))).toEqual([]);
    expect(rules('<h1 style="text-shadow:0 0 16px #22d3ee">Neon</h1>')).toEqual(['glow']);
    expect(rules(box('filter:drop-shadow(0 0 12px hsl(280 90% 60%))'))).toEqual(['glow']);
    expect(CRAFT_LIMITS.glowBlurPx).toBe(8);
  });

  it('tilt: half a degree to thirty, not a quarter turn', () => {
    expect(rules('<div style="transform:rotate(-2deg)"><p>Card</p></div>')).toEqual(['tilt']);
    expect(rules('<div style="rotate:4deg"><p>Card</p></div>')).toEqual(['tilt']);
    expect(rules('<div style="transform:rotate(90deg)"><p>Label</p></div><div style="transform:rotate(180deg)"><p>Label</p></div><div style="transform:rotate(45deg)"><p>Chevron</p></div>')).toEqual([]);
    expect(rules('<div style="transform:translateY(-2px) scale(1.02)"><p>Card</p></div>')).toEqual([]);
    // A bare shape in a drawing is not a tilted card.
    expect(rules('<div style="transform:rotate(12deg);width:40px;height:60px;background:#c2410c"></div>')).toEqual([]);
  });

  it('window chrome: exactly three small round dots, not avatars and not two status dots', () => {
    const dot = (size: number, radius = '50%') => `<div style="width:${size}px;height:${size}px;border-radius:${radius};background:#ef4444"></div>`;
    expect(rules(`<div>${dot(12)}${dot(12)}${dot(12)}</div>`)).toEqual(['window-chrome']);
    expect(rules(`<div>${dot(10, '5px')}${dot(10, '5px')}${dot(10, '5px')}</div>`)).toEqual(['window-chrome']);
    expect(rules(`<div>${dot(12)}${dot(12)}</div>`)).toEqual([]);
    expect(rules(`<div>${dot(40)}${dot(40)}${dot(40)}</div>`)).toEqual([]);
    expect(rules(`<div>${dot(12, '2px')}${dot(12, '2px')}${dot(12, '2px')}</div>`)).toEqual([]);
  });

  it('backgrounds: a repeating dot or grid tile, the blue-to-purple gradient, and gradient text', () => {
    expect(rules('<section style="background-image:radial-gradient(#cbd5e1 1px,transparent 1px);background-size:20px 20px"><p>Text</p></section>')).toEqual(['pattern-background']);
    expect(rules('<section style="background-image:linear-gradient(#e5e7eb 1px,transparent 1px),linear-gradient(90deg,#e5e7eb 1px,transparent 1px);background-size:32px 32px"><p>Text</p></section>')).toEqual(['pattern-background']);
    expect(rules('<section style="background:linear-gradient(135deg,#6366f1,#a855f7)"><p>Text</p></section>')).toEqual(['default-gradient']);
    expect(rules('<section style="background:linear-gradient(90deg,#3b82f6,#8b5cf6,#ec4899)"><p>Text</p></section>')).toEqual(['default-gradient']);
    // Other hues, a single hue, and a neutral fade are choices, not the default.
    expect(rules('<section style="background:linear-gradient(135deg,#f97316,#dc2626)"><p>Text</p></section>')).toEqual([]);
    expect(rules('<section style="background:linear-gradient(135deg,#7c3aed,#6d28d9)"><p>Text</p></section>')).toEqual([]);
    expect(rules('<section style="background:linear-gradient(#ffffff,#f1f5f9)"><p>Text</p></section>')).toEqual([]);
    expect(rules('<h1 style="background:linear-gradient(90deg,#f97316,#dc2626);-webkit-background-clip:text;color:transparent">Headline</h1>')).toEqual(['gradient-text']);
  });

  it('boxes: most groups boxed from six up, and boxes inside boxes from two up', () => {
    const card = (inner = '') => `<div style="border:1px solid #e5e7eb;border-radius:12px"><p>Card text</p>${inner}</div>`;
    const plain = '<div><p>Plain group</p></div>';
    expect(rules(card().repeat(6) + plain.repeat(2))).toEqual(['boxes']);
    expect(rules(card().repeat(5) + plain)).toEqual([]);
    expect(rules(card().repeat(6) + plain.repeat(6))).toEqual([]);
    expect(rules(card(card()) + card(card()))).toEqual(['nested-boxes']);
    expect(rules(card(card()))).toEqual([]);
    // A hairline between rows and a button are not cards.
    expect(rules('<div style="border-top:1px solid #e5e7eb"><p>Row</p></div>'.repeat(8) + '<button style="border:1px solid #111">Go</button>'.repeat(8))).toEqual([]);
  });

  it('text on an image: reported without a scrim, quiet with a gradient over it, a panel under the words or a text shadow', () => {
    const bg = 'background-image:url(https://example.com/a.jpg)';
    const found = finding(`<section data-name="Cover" style="${bg}"><h2>Loved by teams</h2><p>Since 2019</p></section>`, 'text-on-image')!;
    expect(found.numbers).toEqual({ texts: 2 });
    expect(found.message).toContain('directly on the image of "Cover"');
    expect(rules(`<section style="background-image:linear-gradient(rgba(0,0,0,.6),rgba(0,0,0,.6)),url(https://example.com/a.jpg)"><h2>Loved by teams</h2></section>`)).toEqual([]);
    expect(rules(`<section style="${bg}"><div style="background:rgba(0,0,0,0.6)"><h2>Loved by teams</h2></div></section>`)).toEqual([]);
    expect(rules(`<section style="${bg}"><div style="background:rgba(0,0,0,0.2)"><h2>Loved by teams</h2></div></section>`)).toEqual(['text-on-image']);
    expect(rules(`<section style="${bg}"><h2 style="text-shadow:0 1px 2px rgba(0,0,0,.8)">Loved by teams</h2></section>`)).toEqual([]);
    // A picture laid behind the words, and one that sits beside them.
    expect(rules(`<section style="position:relative"><img alt="" src="https://example.com/a.jpg" style="position:absolute;inset:0"><h2>Loved by teams</h2></section>`)).toEqual(['text-on-image']);
    expect(rules(`<section style="position:relative"><img alt="" src="https://example.com/a.jpg" style="position:absolute;inset:0"><div style="position:absolute;inset:0;background:rgba(0,0,0,.5)"></div><h2>Loved by teams</h2></section>`)).toEqual([]);
    expect(rules(`<section style="display:flex"><img alt="" src="https://example.com/a.jpg"><h2>Loved by teams</h2></section>`)).toEqual([]);
  });

  it('viewing size: under 9px where it is seen, a social image at 390px and a slide at 960px; a web page at its own width', () => {
    const social = { style: { width: '1080px', height: '1080px' } };
    const f = finding('<h1 style="font-size:96px">Launch day</h1><p style="font-size:20px">Small print nobody reads</p>', 'viewing-size', social)!;
    expect(f.numbers).toEqual({ texts: 1, need: 25, smallest: 20 });
    expect(f.message).toContain('shows at 7.2px');
    expect(rules('<h1 style="font-size:96px">Launch day</h1><p style="font-size:25px">Readable</p>', social)).toEqual([]);
    expect(rules('<p style="font-size:16px">Footnote</p>', { style: { width: '1920px', height: '1080px' }, attrs: { 'data-bogen-discipline': 'pitch-decks' } })).toEqual(['viewing-size']);
    expect(rules('<p style="font-size:16px">Footnote</p>', { style: { width: '1920px', height: '1080px' }, name: 'Slide 3' })).toEqual(['viewing-size']);
    expect(rules('<p style="font-size:18px">Footnote</p>', { style: { width: '1920px', height: '1080px' }, name: 'Slide 3' })).toEqual([]);
    expect(CRAFT_LIMITS.minSeenPx).toBe(9);
    // A desktop page of the same size is not a slide, and 14px on a web page is fine.
    expect(rules('<p style="font-size:14px">Footnote</p>', { style: { width: '1920px', height: '1080px' } })).toEqual([]);
    expect(rules('<p style="font-size:14px">Footnote</p>')).toEqual([]);
  });

  it('viewing size: what the board or the file says it is decides, and the size is a guess only where nothing says', () => {
    const story = { style: { width: '1080px', height: '1920px' } };
    const small = '<h1 style="font-size:96px">Launch day</h1><p style="font-size:14px">Small print</p>';
    expect(rules(small, story)).toEqual(['viewing-size']);
    // A portrait monitor in a theme file, and a board a template made for a web page, are seen at their own size.
    expect(rules(small, { ...story, theme: true })).toEqual([]);
    expect(rules(small, { ...story, attrs: { 'data-bogen-discipline': 'websites' } })).toEqual([]);
    // A board that says it is social is read as one, and a discipline of no particular medium says nothing.
    expect(rules(small, { ...story, theme: true, attrs: { 'data-bogen-discipline': 'social' } })).toEqual(['viewing-size']);
    expect(rules(small, { ...story, attrs: { 'data-bogen-discipline': 'foundations' } })).toEqual(['viewing-size']);
  });

  it('skips what is hidden, and reads a section on its own with the artboard\'s font', () => {
    expect(rules('<div style="display:none"><div style="transform:rotate(3deg)"><p>Hidden</p></div></div>')).toEqual([]);
    const { doc, id } = build(`<section><p>Built for teams</p><p>Now in beta</p></section>`, { style: { fontFamily: `'JetBrains Mono', monospace` } });
    const section = doc.getChildren(id)[0]!.id;
    expect(craftFindings(doc, section).map((f) => f.rule)).toEqual(['decorative-mono']);
    expect(() => craftFindings(doc, 'missing')).toThrow('No layer with id missing');
  });
});

describe('what a template shows rather than designs', () => {
  const template = { template: true };
  const fill = 'background:#c2410c;color:#fff';
  const buttons = `<a href="#a" style="${fill}">Get started</a><a href="#b" style="${fill}">Send</a>`;
  const card = (inner = '') => `<div style="border:1px solid #e5e7eb"><p>Card text</p>${inner}</div>`;

  it('a specimen of every button and every box is not a screen with three primary actions or boxes in boxes', () => {
    const sheet = `<section data-brand-example="specimen">${buttons}${card(card())}${card(card())}</section><section><p>Notes</p></section>`;
    expect(rules(sheet, template)).toEqual([]);
    // The same parts composed into a screen beside it are still one screen.
    expect(rules(`${sheet}<section>${buttons}${card(card())}${card(card())}</section>`, template).sort()).toEqual(['nested-boxes', 'primary-actions']);
    // An agent cannot mark its own work: html_write drops the mark, so the checks see a screen.
    expect(rules(sheet).sort()).toEqual(['nested-boxes', 'primary-actions']);
  });

  it('a scale specimen shows every step at its size, and is held to the other rules', () => {
    const steps = [96, 92, 88, 84].map((px) => `<p style="font-size:${px}px">Step at ${px}</p>`).join('');
    const page = (inner: string) => `<h1 style="font-size:48px">Type</h1>${p(4)}${inner}`;
    expect(rules(page(`<div data-brand-example="specimen">${steps}</div>`), template)).toEqual([]);
    expect(rules(page(`<div>${steps}</div>`), template)).toEqual(['loud-type']);
    const sizes = (inner: string) => {
      const { doc, id } = build(inner, template);
      return designReview(doc, id).observations.filter((o) => o.message.includes('different font sizes'));
    };
    const eight = [12, 14, 16, 20, 24, 32, 48, 64].map((px) => `<p style="font-size:${px}px">Step at ${px}</p>`).join('');
    expect(sizes(`<h1 style="font-size:48px">Type</h1><div data-brand-example="specimen">${eight}</div>`)).toEqual([]);
    expect(sizes(`<h1 style="font-size:48px">Type</h1><div>${eight}</div>`)).toHaveLength(1);
    // A glow is a glow in a specimen too.
    expect(rules(`<div data-brand-example="specimen"><div style="box-shadow:0 0 40px rgba(124,58,237,0.6)"><p>Card</p></div></div>`, template)).toEqual(['glow']);
  });

  it('a counter-example is left out of every check, as brand_check leaves it out', () => {
    const wrong = `<div style="box-shadow:0 0 40px rgba(124,58,237,0.6);transform:rotate(-4deg)"><p>Card</p></div>`;
    expect(rules(`<div data-brand-example="dont">${wrong}</div>`, template)).toEqual([]);
    expect(rules(`<div data-brand-example="dont">${wrong}</div>${wrong}`, template).sort()).toEqual(['glow', 'tilt']);
    expect(rules(`<div data-brand-example="dont">${wrong}</div>`).sort()).toEqual(['glow', 'tilt']);
  });
});

describe('design_review reads a token with a fallback as the token', () => {
  const colours = ['#1d1b19', '#f4efe6', '#b5532a', '#6b6259', '#2f4a3a', '#e8dccb', '#8a3b1f'];
  const review = (html: string) => {
    const { doc, id } = build(html);
    return designReview(doc, id).observations;
  };

  it('counts a colour inside var(--x, #fallback) as the token, and a colour written alone as typed in', () => {
    const tokens = colours.map((c, i) => `<p style="color:var(--c${i}, ${c})">Line ${i}</p>`).join('');
    const typed = colours.map((c, i) => `<p style="color:${c}">Line ${i}</p>`).join('');
    expect(review(`<h1>Page</h1>${tokens}`).filter((o) => o.aspect === 'colour')).toEqual([]);
    expect(review(`<h1>Page</h1>${typed}`).filter((o) => o.aspect === 'colour').map((o) => o.message)).toEqual([expect.stringContaining('7 colours typed in on 7 layers')]);
    // A fallback beside a colour typed in does not hide the typed one.
    expect(review(`<h1>Page</h1>${colours.map((c, i) => `<p style="border-color:${c};color:var(--c${i}, #000)">Line ${i}</p>`).join('')}`).filter((o) => o.aspect === 'colour')).toHaveLength(1);
  });

  it('reads a font size through its fallback when the file has no such token', () => {
    const levels = review('<h1 style="font-size:var(--display, 24px)">Title</h1><h2 style="font-size:var(--heading, 40px)">Section</h2>');
    expect(levels.map((o) => o.message)).toEqual([expect.stringContaining('h2 (up to 40px) is as large as or larger than h1 (from 24px)')]);
  });
});

describe('a theme file previews the system, not a page', () => {
  const mono = `font-family:'JetBrains Mono',monospace`;
  const theme = { theme: true };

  it('sets the interface in the system face, and is held to the rest', () => {
    const bar = `<div style="${mono}"><p>Monday 20:14</p><p>Wi-Fi</p><p>Bluetooth</p></div>`;
    expect(rules(bar, theme)).toEqual([]);
    expect(rules(bar)).toEqual(['decorative-mono']);
    // A third family, a glow and text on a picture are what they are in a theme too.
    expect(rules(`${bar}<p style="font-family:Inter">One</p><p style="font-family:Lora">Two</p>`, theme)).toEqual(['font-families']);
    expect(rules(`<div style="box-shadow:0 0 40px rgba(124,58,237,0.6)"><p>Card</p></div>`, theme)).toEqual(['glow']);
  });

  it('counts an icon font glyph as a drawing, not as a type family, in any file', () => {
    const glyphs = `<span style="font-family:'JetBrainsMono Nerd Font'">\u{f14fb}</span><span style="font-family:omarchy"></span>`;
    const page = `<h1 style="font-family:Inter">Title of the page</h1><p style="font-family:Lora">Body</p>`;
    expect(rules(page + glyphs)).toEqual([]);
    expect(rules(page + `<span style="font-family:'JetBrainsMono Nerd Font'">Status \u{f14fb}</span>`)).toEqual(['font-families']);
  });

  it('has no main heading, takes its sizes from the system and its app grid from the phone, and still says what is wrong', () => {
    const review = (html: string, options = {}) => {
      const { doc, id } = build(html, options);
      return designReview(doc, id).observations.map((o) => o.message);
    };
    const icon = (label: string) => `<div style="display:flex;flex-direction:column"><svg viewBox="0 0 1 1" data-name="Icon"></svg><p>${label}</p></div>`;
    const shell = `<div style="padding:3px 9px;gap:6px;display:flex"><p style="padding:5px">Bar</p><p style="padding:7px">Clock</p></div><div style="display:flex">${icon('Terminal')}${icon('Files')}${icon('Browser')}</div>`;
    expect(review(shell, theme)).toEqual([]);
    expect(review(shell).join('\n')).toMatch(/No h1[^]*off a 4px grid[^]*3 cards with the same icon-title-text shape/);
    expect(review(`<h1>One</h1><h1>Two</h1>${shell}`, theme)).toEqual(['2 h1 headings: a page has one main heading.']);
  });
});
