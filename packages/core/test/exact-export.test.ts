import { describe, expect, it } from 'vitest';
import { BogenDoc, EXACT_COMMIT, contractString, exactAppText, toExactApp } from '../src/index.ts';
import { importedPage, landingHero, nestedFlex, phoneList, withImage } from './fixtures/exact-designs.ts';

/** Every line of Contract the formatter would keep as it is: two spaces a level, at most 100 wide unless one attribute. */
function formatted(text: string): boolean {
  return text.split('\n').every((l) => !/\t/.test(l) && (l.length <= 100 || !/ [\w-]+=.* [\w-]+=/.test(l.trim())) && (l.length - l.trimStart().length) % 2 === 0);
}

describe('Exact export', () => {
  it('writes a landing hero as a screen, with tokens in app.tamber and its text style as a style', () => {
    const { doc, root } = landingHero();
    const app = toExactApp(doc, root);
    const c = app.files['app.contract']!;
    expect(app.name).toBe('hero');
    expect(app.commit).toBe(EXACT_COMMIT);
    expect(Object.keys(app.files).sort()).toEqual(['app.contract', 'app.json', 'app.tamber', 'app.test.contract', 'app.ts']);
    expect(c).toContain('component Hero');
    expect(c).toContain('main testId="app"');
    expect(c).toContain('color-scheme="light"');
    // The artboard grows with the window up to its design size.
    expect(c).toMatch(/section testId="screen"\n {10}width="100%"/);
    expect(c).toContain('max-width=1280');
    expect(c).toContain('min-height=720');
    expect(c).not.toMatch(/position="absolute"\n {10}left=0/);
    expect(c).toContain('justify-content="center"');
    expect(c).toContain('gap="var(--space-6)"');
    // A token Tamber cannot hold is written where it is used, and said.
    expect(c).toContain('padding="96px clamp(16px, 5vw, 64px)"');
    expect(app.dropped).toContainEqual(expect.objectContaining({ what: '--gutter', approximated: true }));
    expect(c).toContain('style DisplayText\n  font-family="var(--display)"\n  font-size=56\n  font-weight=600\n  line-height=1.05\n  letter-spacing="-0.02em"');
    expect(c).toContain('text "Sleep through the Alps,\\nwake up in Venice" testId="title"');
    expect(c).toContain('role="heading"');
    expect(c).toContain('class=DisplayText');
    expect(c).toContain('white-space="pre-wrap"');
    expect(c).toContain('line-height=1.5');
    expect(c).toContain('opacity=0.8');
    // Links lose the browser's link look, as on the canvas, and buttons and links get a test id.
    expect(c).toMatch(/link testId="primary"\n\s+href="https:\/\/example.com\/routes"/);
    expect(c).toContain('text-decoration-line="none"');
    expect(c).toMatch(/link testId="secondary"[\s\S]*?color="var\(--ink\)"/);
    expect(c).toContain('row gap=12 align-items="center"');
    expect(c).toContain('// Left out of "Hero": ::before');
    expect(c).toContain('// Left out of "Primary": transition');
    expect(app.dropped).toContainEqual(expect.objectContaining({ what: '::before', layer: root }));
    expect(app.dropped).toContainEqual(expect.objectContaining({ what: 'display', value: 'inline-flex', approximated: true }));
    expect(app.files['app.tamber']).toBe('tamber brand\n\n// The tokens of the Bogen file that Hero uses.\ntheme\n  accent: color = #c2410c  scheme=fixed\n  display: family = "Fraunces", serif\n  ink: color = #1b1f24  scheme=fixed\n  paper: color = #fbf8f3  scheme=fixed\n  radius-md: length = 10px\n  space-6: length = 24px\n');
    expect(app.files['app.test.contract']).toBe('test "the screen shows its text"\n  expect tree has "screen"\n  expect text "eyebrow" == "Field notes for night trains"\n');
    expect(app.notes.join(' ')).toMatch(/Fonts are named, not bundled: Inter, Fraunces/);
    expect(formatted(c)).toBe(true);
  });

  it('writes a phone screen with a list, a counting button and a condition as state and an action', () => {
    const { doc, root } = phoneList();
    const app = toExactApp(doc, root);
    const c = app.files['app.contract']!;
    expect(c).toContain('component Inbox\n  state count = 0\n  state showDone = false\n  action pressCompose\n    count = count + 1\n    showDone = not showDone\n  view');
    // A dark mode makes the colours follow the scheme, so the scheme is not pinned.
    expect(c).not.toContain('color-scheme');
    expect(app.files['app.tamber']).toContain('surface: color = light-dark(#ffffff, #101214)');
    expect(c).toContain('text "Inbox" testId="heading"');
    expect(c).toContain('aria-level=2');
    expect(c).toContain('column flex-grow=1');
    expect(c).toMatch(/row justify-content="space-between"\n\s+align-items="center"\n\s+padding="14px 16px"\n\s+border-bottom="1px solid #e5e7eb"/);
    expect(c).toContain('text `${count}` testId="counter"');
    expect(c).toContain('if showDone\n            text "All caught up" testId="done-note"');
    expect(c).toMatch(/button testId="compose"\n\s+appearance="none"\n\s+press=pressCompose/);
    expect(c).toContain('position="sticky"');
    expect(app.dropped).toContainEqual(expect.objectContaining({ what: 'interaction', value: 'navigate' }));
    expect(app.files['app.test.contract']).toContain('test "compose adds 1"\n  tap "compose"\n  expect text "counter" == "1"');
    expect(formatted(c)).toBe(true);
  });

  it('writes nested flex and grid, and leaves out what Contract has no word for', () => {
    const { doc, root } = nestedFlex();
    const app = toExactApp(doc, root);
    const c = app.files['app.contract']!;
    expect(app.files['app.tamber']).toBeUndefined();
    expect(c).toMatch(/column testId="screen"[\s\S]*?\n {10}row gap=16 align-items="stretch"\n {12}column gap=8\n {14}padding=16\n {14}flex=2\n {14}min-width=0/);
    expect(c).toContain('box-sizing="border-box"');
    expect(c).toContain('background-image="linear-gradient(90deg, #0ea5e9, #6366f1)"');
    expect(c).toContain('border-radius=9999');
    expect(c).toMatch(/view display="grid"\n\s+grid-template-columns="repeat\(3, minmax\(0, 1fr\)\)"\n\s+gap=12\n\s+align-items="center"\n\s+justify-items="center"/);
    expect(c).toContain('padding-left=8');
    expect(c).toContain('flex-wrap="wrap"');
    expect(c).toContain('// Left out of "Spacer": filter, mix-blend-mode, object-position');
    expect(c).not.toContain('plus-lighter');
    const spacer = app.dropped.filter((d) => d.name === 'Spacer').map((d) => d.what).sort();
    expect(spacer).toEqual(['filter', 'mix-blend-mode', 'object-position']);
    expect(formatted(c)).toBe(true);
  });

  it('writes images as assets, remote ones by URL, SVG as Contract SVG and text runs as runs', () => {
    const { doc, root } = withImage();
    const app = toExactApp(doc, root);
    const c = app.files['app.contract']!;
    expect(app.assets).toEqual([{ path: 'assets/lake-bled.webp', src: 'bogen-asset:lake-bled.webp' }]);
    expect(c).toMatch(/image "assets\/lake-bled.webp" testId="photo"\n\s+alt="Lake Bled at dawn"\n\s+width="100%"\n\s+height=220\n\s+border-radius=12\n\s+object-fit="cover"\n/);
    expect(c).toContain('image "https://example.com/stamp.png" testId="stamp"');
    expect(c).toContain('view testId="placeholder" background-color="rgba(0, 0, 0, 0.06)" width="100%" height=80');
    expect(app.dropped).toContainEqual(expect.objectContaining({ name: 'Placeholder', approximated: true }));
    expect(c).toContain('svg testId="logo" viewBox="0 0 24 24" width=24 height=24\n            circle cx=12 cy=12 r=10 fill="#0f766e"\n            path d="M7 12l3 3 7-7"');
    expect(c).toContain('stroke-width=2');
    expect(c).toContain('text testId="caption" font-size=15 color="#3f3f46"\n            text "Greetings from "\n            text "\\"Bled\\"" font-style="italic"\n            text ", 6:40 am"');
    expect(app.files['app.test.contract']).toContain('expect text "signature" == "See you soon"');
    expect(app.notes.join(' ')).toContain('Remote images');
    expect(formatted(c)).toBe(true);
  });

  it('writes a page as html_write imports it: text buttons and links around their words, fields, cards', () => {
    const { doc, root } = importedPage();
    const app = toExactApp(doc, root);
    const c = app.files['app.contract']!;
    expect(c).toContain('link testId="routes" href="/routes" color="#333" text-decoration-line="none"\n                text "Routes" testId="routes-label"');
    expect(c).toContain('link testId="about" href="/about" color="CanvasText"');
    expect(c).toMatch(/button testId="notify-me"\n\s+appearance="none"\n\s+padding="12px 18px"\n\s+background-color="#111"[\s\S]*?\n\s+text "Notify me" testId="notify-me-label"/);
    expect(c).toMatch(/input testId="input"\n\s+type="email"\n\s+placeholder="you@example.com"/);
    expect(c).toContain('font-family="\\"Instrument Serif\\", serif"');
    expect(c).toContain('background-image="linear-gradient(180deg,#fff7ed,#ffffff)"');
    expect(c).toContain('// Left out of "Card": :hover');
    expect(app.notes.join(' ')).toContain('Fonts are named, not bundled: Inter, Instrument Serif.');
    expect(formatted(c)).toBe(true);
  });

  it('says what it left out in one text, and writes a stub app.ts and a manifest', () => {
    const { doc, root } = nestedFlex();
    const app = toExactApp(doc, root);
    const text = exactAppText(app);
    expect(text).toContain('// ---- app.contract\n// Dashboard: exported from Bogen as an Exact app (experimental).');
    expect(text).toContain('// ---- left out (3)');
    expect(text).toMatch(/Spacer \([\w]+\): filter "url\(#noise\)"\. Contract takes no url\(\)/);
    expect(app.files['app.ts']).toContain("const sources: Sources = {};");
    expect(app.files['app.ts']).toContain("export const grants = '';");
    expect(JSON.parse(app.files['app.json']!)).toEqual({ name: 'Dashboard', short_name: 'Dashboard', id: 'com.example.dashboard', start_url: '/', display: 'standalone', app: { id: 'com.example.dashboard', name: 'Dashboard' }, host: { web: {} }, deploy: { store: { web: '0' } } });
  });

  it('leaves out hidden layers and layers Contract cannot hold, with a comment where each was', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    const root = doc.insert(page, {
      type: 'frame', tag: 'div', name: '1 weird name!', style: { display: 'block' },
      children: [
        { type: 'text', tag: 'p', name: 'Gone', text: 'Not here', hidden: true },
        { type: 'shader', tag: 'div', name: 'Glow', attrs: { type: 'mesh-gradient' } },
        { type: 'text', tag: 'p', name: 'Tab\tand "quote"', text: 'a\tb "c" \\ d\u0001', style: { fontSize: 'calc(1rem + 2vw)', display: 'contents' } },
      ],
    });
    const app = toExactApp(doc, root);
    const c = app.files['app.contract']!;
    expect(app.name).toBe('weird-name');
    expect(c).toContain('component Screen1WeirdName');
    expect(c).toContain('// Left out: hidden layer "Gone"');
    expect(c).toContain('// Left out: shader layer "Glow"');
    expect(c).toContain('text "a\\tb \\"c\\" \\\\ d\\u{1}" testId="tab-and-quote"');
    expect(app.dropped.map((d) => d.what).sort()).toEqual(['display', 'font-size', 'layer', 'layer']);
    expect(app.files['app.test.contract']).toContain('expect text "tab-and-quote" == "a\\tb \\"c\\" \\\\ d\\u{1}"');
  });

  it('escapes strings as Contract reads them', () => {
    expect(contractString('He said "hi"\n')).toBe('"He said \\"hi\\"\\n"');
    expect(contractString('${x} `y`')).toBe('"${x} `y`"');
  });
});
