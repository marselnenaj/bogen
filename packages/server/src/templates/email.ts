import { familyStack, type BrandColor, type BrandFamily } from '@bogen/core';
import { BrandKit, h, t, type Style, type TemplateEnv, type TypeRole } from './kit.ts';
import type { TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';
import { brandLines, pick, Slots, slotText } from './words.ts';

/**
 * An email at 600 wide, laid out the way mail clients read it: nested tables with role="presentation", rows and cells,
 * inline styles, no flex or grid inside the message, and literal values rather than tokens, since mail clients do not
 * know CSS variables. Fonts end in a web-safe stack. The button is a cell with a background around a link, which
 * clients that drop padding on links still draw.
 */

const WIDTH = 600;
const WEB_SAFE = ['Arial', 'Helvetica', 'sans-serif'];
const WEB_SAFE_MONO = ['Courier New', 'Courier', 'monospace'];

/** A brand family's stack with the web-safe fonts after it. */
function mailStack(f: BrandFamily | undefined, mono = false): string {
  const tail = mono ? WEB_SAFE_MONO : WEB_SAFE;
  const head = f ? familyStack(f) : '';
  const have = head.toLowerCase();
  const rest = tail.filter((n) => !have.includes(n.toLowerCase())).map((n) => (n.includes(' ') ? `"${n}"` : n));
  return [head, ...rest].filter(Boolean).join(', ');
}

export function emailBoard(k: BrandKit, slots: Slots): { name: string; html: string; bg: string; fg: string; font: string } {
  const hex = (c: BrandColor | null, fallback: string) => (c ? k.hex(c) : fallback);
  const base = k.base();
  const s = k.scheme(base);
  const paper = hex(s.bg, '#ffffff');
  const ink = hex(s.fg, '#111111');
  const muted = hex(s.muted, ink);
  const line = hex(s.line, muted);
  const accent = k.accent();
  const onAccent = accent ? k.textOn(accent) : null;
  const button = accent && onAccent ? { bg: k.hex(accent), fg: k.hex(onAccent) } : { bg: ink, fg: paper };
  const body = mailStack(k.family('body'));
  const display = mailStack(k.family('display'));
  const px = (n: number) => `${Math.round(n)}px`;
  const font = (role: TypeRole, family: string, weight?: number): Style => ({ margin: 0, fontFamily: family, fontSize: px(role.px), lineHeight: /^[\d.]+$/.test(role.lineHeight) ? role.lineHeight : '1.4', fontWeight: weight ?? role.weight });
  const space = (n: number) => px(k.spacePx(n));
  const table = (rows: string[], style: Style = {}, name = 'Table') => h('table', { width: '100%', borderCollapse: 'collapse', borderSpacing: 0, ...style }, [h('tbody', {}, rows)], { role: 'presentation', 'data-name': name });
  const row = (cell: string, name: string, style: Style = {}) => h('tr', {}, [h('td', { padding: `${space(24)} ${space(40)}`, ...style }, [cell], { 'data-name': name })], { 'data-name': `${name} row` });
  const logo = k.logoFor(base);
  const lines = brandLines(k);
  const year = k.env.date.getFullYear();

  const rows = [
    row(slotText(slots, 'p', { ...font(k.type('small', 16), body), color: muted }, 'The line inboxes show after the subject.', 'Preheader', 'One line the inbox shows after the subject. Make it add to the subject, not repeat it.'), 'Preheader', { paddingTop: space(16), paddingBottom: space(16) }),
    row(logo ? k.logo(logo, 56, {}, 'Logo') : h('p', { ...font(k.type('subheading', 28), display, 700), color: ink }, t(k.name), { 'data-name': 'Name' }), 'Header', { borderBottom: `1px solid ${line}` }),
    row([
      slotText(slots, 'h1', { ...font(k.type('heading', 40), display), color: ink }, pick(k, lines, 'h1', 'Say what this email is about'), 'Headline', 'What this email is about, in a line the reader cares about.'),
    ].join(''), 'Hero', { paddingTop: space(40), paddingBottom: space(16) }),
    row([
      slotText(slots, 'p', { ...font(k.type('body', 18), body), color: ink, paddingBottom: space(16) }, 'Why the reader gets this, in a sentence.', 'Opening', 'Why the reader gets this email, in a sentence.'),
      slotText(slots, 'p', { ...font(k.type('body', 18), body), color: ink }, 'The one thing to know, and what to do next.', 'Body', 'The one thing to know, and what to do next. Keep it short.'),
    ].join(''), 'Body', { paddingTop: 0 }),
    row(h('table', { borderCollapse: 'collapse', borderSpacing: 0 }, [h('tbody', {}, [h('tr', {}, [
      h('td', { background: button.bg, borderRadius: px(k.data.radius.filter((r) => r.value > 0 && r.value < 999).sort((a, b) => a.value - b.value)[0]?.value ?? 0), padding: `${space(16)} ${space(32)}` }, [
        h('a', { ...font(k.type('body', 18), body, 700), color: button.fg, textDecoration: 'none', display: 'inline-block' }, 'Your main action', { href: 'https://example.com/', 'data-name': slots.add('Button label', 'The one action, as a verb and what it does: "Read the guide", not "Click here".') }),
      ], { 'data-name': 'Button' }),
    ])])], { role: 'presentation', 'data-name': 'Button table' }), 'Action', { paddingTop: space(8), paddingBottom: space(40) }),
    row([
      h('p', { ...font(k.type('small', 16), body), color: muted, paddingBottom: space(8) }, t(`Copyright ${year} ${k.name}`), { 'data-name': 'Copyright' }),
      slotText(slots, 'p', { ...font(k.type('small', 16), body), color: muted, paddingBottom: space(8) }, 'The sender\'s postal address', 'Address', 'The postal address of the sender, which the law asks for in many countries.'),
      h('a', { ...font(k.type('small', 16), body), color: muted, textDecoration: 'underline' }, 'Unsubscribe from these emails', { href: 'https://example.com/unsubscribe', 'data-name': slots.add('Unsubscribe', 'The unsubscribe link: set its href to the real address.') }),
    ].join(''), 'Footer', { borderTop: `1px solid ${line}`, paddingTop: space(24), paddingBottom: space(40) }),
  ];
  return { name: `Email, ${WIDTH}`, html: table(rows, { width: `${WIDTH}px`, background: paper }, 'Email'), bg: paper, fg: ink, font: body };
}

export const email: TemplateDef = {
  id: 'email',
  name: 'Email',
  description: 'An email at 600 wide in the brand, table-safe: nested tables with role="presentation", rows and cells, inline styles and literal brand values (mail clients know no CSS variables), web-safe fonts after the brand\'s, no flex or grid. Preheader, header with the logo, headline, body, a button that is a coloured cell around a link, and a footer with copyright, postal address and an unsubscribe link. Texts are slots.',
  parts: [{ key: '600', name: `Email, ${WIDTH}`, size: `${WIDTH} wide, hugs content` }],
  fileName: (brand) => `${brand} email`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const slots = new Slots();
    if (options.only?.length && !options.only.includes('600')) return { page: 'Email', boards: [], gaps: [] };
    const made = emailBoard(k, slots);
    const gaps = k.logos().length ? [] : ['No logo yet: add one with brand_asset_add, and the header carries it.'];
    return { page: 'Email', boards: [{ name: made.name, width: WIDTH, background: made.bg, color: made.fg, font: made.font, steps: [{ html: made.html }] }], gaps, slots: slots.list };
  },
};
