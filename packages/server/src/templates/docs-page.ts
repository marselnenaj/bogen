import { BrandKit, h, t, type TemplateEnv } from './kit.ts';
import { pageFooter, pageHeader } from './page-parts.ts';
import type { BoardPlan, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';
import { pick, Slots, slotText, target } from './words.ts';

/**
 * A documentation page in the brand: a header with the main links, a sidebar of the section's pages, and an article
 * with one h1, h2 and h3 in order, a command in the mono family, a note, a table of options and links to the pages
 * before and after. At 390 the sidebar folds into a disclosure above the article.
 */

function docs(k: BrandKit, width: number, slots: Slots): BoardPlan {
  const mobile = width < 700;
  const base = k.base();
  const p = k.paint(k.scheme(base));
  const alt = k.alternate();
  const a = k.paint(alt ? k.scheme(alt) : k.scheme(base));
  const accent = k.accent();
  const accentLine = accent && base && k.canText(accent, base, true) ? k.c(accent) : p.fg;
  const pad = mobile ? k.space(24) : k.space(64);
  const mono = k.type('mono');
  const sideLinks = ['Install it', 'Your first file', 'This page', 'Settings you can change', 'When something fails'];
  const sidebarList = h('ul', { display: 'flex', flexDirection: 'column', gap: k.space(4), margin: 0, padding: 0, listStyle: 'none' }, sideLinks.map((label, i) => h('li', {}, [
    h('a', { ...k.font(k.type('small')), ...target({ padding: `${k.space(4)} ${k.space(8)}` }), color: p.fg, textDecoration: 'none', ...(i === 2 ? { borderLeft: `2px solid ${accentLine}`, fontWeight: 700 } : { borderLeft: `2px solid transparent` }) }, t(label), { href: '#', 'data-name': slots.add('Page link', 'The title of a page in this section, as the reader would look for it.'), ...(i === 2 ? { 'aria-current': 'page' } : {}) }),
  ], { 'data-name': 'Item' })), { 'data-name': 'Pages' });
  const sidebar = mobile
    ? h('details', { borderTop: `1px solid ${p.line}`, borderBottom: `1px solid ${p.line}`, padding: `${k.space(12)} 0` }, [
      h('summary', { ...k.font(k.type('small'), 700), ...target(), color: p.fg, cursor: 'pointer' }, 'Pages in this section', { 'data-name': 'Section toggle' }),
      h('nav', { paddingTop: k.space(12) }, [sidebarList], { 'aria-label': 'Pages in this section', 'data-name': 'Section navigation' }),
    ], { 'data-name': 'Section' })
    : h('nav', { display: 'flex', flexDirection: 'column', gap: k.space(16), width: '260px', flex: 'none' }, [
      slotText(slots, 'p', { ...k.font(mono), color: p.muted }, 'Name of the section', 'Section name', 'The name of this section of the docs.'),
      sidebarList,
    ], { 'aria-label': 'Pages in this section', 'data-name': 'Section navigation' });

  const cell = (text: string, header = false) => h(header ? 'th' : 'td', { ...k.font(k.type('small'), header ? 700 : undefined), color: p.fg, textAlign: 'left', padding: `${k.space(12)} ${k.space(16)}`, borderBottom: `1px solid ${p.line}` }, t(text), { 'data-name': header ? 'Column' : 'Cell' });
  const optionRow = () => h('tr', {}, [cell('option-name'), cell('What it changes, in a few words.'), cell('Its default')], { 'data-name': 'Option' });
  slots.add('Cell', 'A cell of the options table: the option, what it changes, or its default.');
  // The three heading levels a fifth apart at least, whatever the brand's scale holds.
  const [sizeH1, sizeH2, sizeH3] = k.ladder(mobile ? [40, 28, 22] : [56, 36, 24], { above: k.type('body').px });
  const article = h('article', { display: 'flex', flexDirection: 'column', gap: k.space(24), maxWidth: '760px', flex: '1 1 auto', minWidth: 0 }, [
    slotText(slots, 'h1', { ...k.font(sizeH1!), color: p.fg }, 'The title of this page', 'Title', 'What the page helps the reader do, as they would search for it.'),
    slotText(slots, 'p', { ...k.font(k.type('lead')), color: p.fg, maxWidth: '60ch' }, pick(k, [k.data.fields.positioning], 'p', 'What the reader can do after this page, in a sentence.'), 'Lead', 'What the reader can do after this page, in a sentence.'),
    slotText(slots, 'h2', { ...k.font(sizeH2!), color: p.fg, paddingTop: k.space(16) }, 'Before you start here', 'Section heading', 'A heading for a part of the page.'),
    slotText(slots, 'p', { ...k.font(k.type('body')), color: p.fg }, 'What the reader needs first, and where to get it.', 'Paragraph', 'A short paragraph: one point, two sentences at most.'),
    h('pre', { margin: 0, padding: `${k.space(20)} ${k.space(24)}`, background: a.bg, border: `1px solid ${p.line}`, borderRadius: k.radius(), overflow: 'auto' }, [
      h('code', { ...k.font(mono), color: a.fg }, '$ the command to run', { 'data-name': slots.add('Command', 'A real command the reader can copy and run.') }),
    ], { 'data-name': 'Code block' }),
    h('aside', { display: 'flex', flexDirection: 'column', gap: k.space(8), padding: `${k.space(16)} ${k.space(20)}`, borderLeft: `4px solid ${accentLine}`, background: a.bg }, [
      h('p', { ...k.font(k.type('small'), 700), color: a.fg }, 'Note', { 'data-name': 'Note label' }),
      slotText(slots, 'p', { ...k.font(k.type('body')), color: a.fg }, 'One thing the reader should not miss.', 'Note', 'A warning or a tip the reader should not miss. Leave it out if there is none.'),
    ], { role: 'note', 'data-name': 'Callout' }),
    slotText(slots, 'h3', { ...k.font(sizeH3!, 700), color: p.fg, paddingTop: k.space(8) }, 'Options you can set', 'Subheading', 'A heading for a smaller part of the section.'),
    h('div', { overflow: 'auto' }, [
      h('table', { width: '100%', borderCollapse: 'collapse' }, [
        h('thead', {}, [h('tr', {}, [cell('Option', true), cell('What it does', true), cell('Default', true)])]),
        h('tbody', {}, [optionRow(), optionRow()]),
      ], { 'data-name': 'Options table' }),
    ], { 'data-name': 'Table wrapper' }),
    h('nav', { display: 'flex', flexDirection: mobile ? 'column' : 'row', justifyContent: 'space-between', gap: k.space(16), paddingTop: k.space(32), borderTop: `1px solid ${p.line}` }, [
      h('a', { ...k.font(k.type('body')), ...target(), color: p.fg }, 'Previous: the page before', { href: '#', 'data-name': slots.add('Previous link', 'Previous: and the title of the page before.') }),
      h('a', { ...k.font(k.type('body'), 700), ...target(), color: p.fg }, 'Next: the page after', { href: '#', 'data-name': slots.add('Next link', 'Next: and the title of the page after.') }),
    ], { 'aria-label': 'Previous and next page', 'data-name': 'Pager' }),
  ], { 'data-name': 'Article' });

  const main = h('main', { display: 'flex', flexDirection: mobile ? 'column' : 'row', gap: mobile ? k.space(24) : k.space(64), padding: `${mobile ? k.space(24) : k.space(48)} ${pad}`, alignItems: 'flex-start' }, [sidebar, article], { 'data-name': 'Main' });
  return {
    name: `Docs page, ${width}`, tag: 'div', width, background: p.bg, color: p.fg, font: k.stack(k.family('body')),
    steps: [{ html: [pageHeader(k, base, p, mobile, ['Guides', 'Reference', 'Changes'], pad), main, pageFooter(k, base, p, mobile, pad)].join('') }],
  };
}

export const docsPage: TemplateDef = {
  id: 'docs-page',
  name: 'Docs page',
  description: 'A documentation page in the brand at 1440 and 390: header with the main links, a sidebar of the section\'s pages (a disclosure at 390), and an article with one h1, then h2 and h3 in order, a command in the brand\'s mono family, a note, a table of options and links to the pages before and after. Landmarks: header, nav, main, footer. Texts are slots.',
  parts: [{ key: '1440', name: 'Docs page, 1440', size: '1440 wide, hugs content' }, { key: '390', name: 'Docs page, 390', size: '390 wide, hugs content' }],
  fileName: (brand) => `${brand} docs page`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const slots = new Slots();
    const widths = [1440, 390].filter((w) => !options.only?.length || options.only.includes(String(w)));
    const gaps = k.family('mono') ? [] : ['No mono family yet: add one with brand_update (families, role mono), and code takes it.'];
    return { page: 'Docs page', boards: widths.map((w) => docs(k, w, slots)), gaps, slots: slots.list };
  },
};
