// A small library of website sections that work as websites, not as pictures of them: a header whose navigation
// folds into a popover menu by its own width, an editorial hero, proof with sources, an accordion that keeps one
// answer open, a dialog, and a footer. Every behaviour is native HTML (popover, <details name>, anchors), so the canvas,
// the preview and an exported page behave the same with a keyboard and without script.
//
// Colours, type and space come from tokens with fallbacks (--ink, --paper, --accent, --type-*, --space-*), so the
// sections take on a file's own tokens and type_scale_set. The copy is a worked example for a small ceramics studio,
// written to be replaced: each section lists the layers that carry facts only the person knows.

export type SectionKind = 'header' | 'hero' | 'proof' | 'accordion' | 'dialog' | 'footer';

export interface Section {
  kind: SectionKind;
  name: string;
  /** What the section does, for section_list. */
  description: string;
  html: string;
  /** Layers whose words are facts the person must supply, by layer name. */
  facts: { layer: string; hint: string }[];
}

const INK = 'var(--ink, #1d1b19)';
const PAPER = 'var(--paper, #f7f4ef)';
const MUTED = 'var(--muted, #6b655d)';
const LINE = 'var(--line, color-mix(in srgb, #1d1b19 14%, transparent))';
const ACCENT = 'var(--accent, #9a3b1f)';
const ON_ACCENT = 'var(--on-accent, #fbf7f2)';
const T = (role: string, fallback: string) => `var(--type-${role}, ${fallback})`;
const S = (step: string, fallback: string) => `var(--space-${step}, ${fallback})`;
const FOCUS = `outline: 2px solid ${ACCENT}; outline-offset: 3px;`;
const WRAP = `width: min(100%, 72rem); margin-inline: auto; padding-inline: ${S('m', '1.5rem')};`;

const header: Section = {
  kind: 'header',
  name: 'Header with navigation',
  description: 'Sticky header with the site name and a main navigation. Below 44rem of its own width the links fold into a menu button that opens a popover with the same links: Esc and a click outside close it, no script. The current page is marked with aria-current.',
  facts: [{ layer: 'Site name', hint: 'The name as people say it.' }, { layer: 'Nav links', hint: 'The real sections of the page, each linking to its id.' }],
  html: `<style>
.wh { position: sticky; top: 0; z-index: 10; background: ${PAPER}; border-bottom: 1px solid ${LINE}; container-type: inline-size; container-name: site-header; }
.wh-row { ${WRAP} display: flex; align-items: center; justify-content: space-between; gap: ${S('m', '1.5rem')}; min-height: 4rem; }
.wh-name { font-size: ${T('h3', '1.5rem')}; font-weight: 600; letter-spacing: -0.01em; color: ${INK}; text-decoration: none; }
.wh-links { display: flex; gap: ${S('m', '1.5rem')}; list-style: none; margin: 0; padding: 0; }
.wh-link { display: inline-flex; min-height: 44px; align-items: center; color: ${INK}; text-decoration: none; font-size: ${T('body', '1rem')}; }
.wh-link:hover { text-decoration: underline; text-underline-offset: 0.25em; }
.wh-link:focus-visible { ${FOCUS} }
.wh-current { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.35em; }
.wh-menu { display: none; min-height: 44px; padding: 0 ${S('s', '1rem')}; border: 1px solid ${INK}; background: transparent; color: ${INK}; font: inherit; cursor: pointer; }
.wh-menu:focus-visible { ${FOCUS} }
.wh-pop { margin: 4rem 0 0 auto; width: min(100vw, 22rem); padding: ${S('m', '1.5rem')}; border: 1px solid ${LINE}; background: ${PAPER}; color: ${INK}; }
.wh-pop-links { display: flex; flex-direction: column; gap: ${S('2xs', '0.5rem')}; list-style: none; margin: 0; padding: 0; }
@container site-header (max-width: 44rem) { .wh-links { display: none; } .wh-menu { display: inline-flex; align-items: center; } }
</style>
<header class="wh" id="top" data-name="Site header">
  <div class="wh-row" data-name="Header row">
    <a class="wh-name" href="#top" data-name="Site name">Kiln &amp; Table</a>
    <nav aria-label="Main" data-name="Main navigation">
      <ul class="wh-links" data-name="Nav links">
        <li><a class="wh-link wh-current" href="#work" aria-current="page" data-name="Nav link current">Work</a></li>
        <li><a class="wh-link" href="#studio" data-name="Nav link">Studio</a></li>
        <li><a class="wh-link" href="#questions" data-name="Nav link">Questions</a></li>
      </ul>
      <button class="wh-menu" type="button" popovertarget="site-menu" aria-label="Open the menu" data-name="Menu button">Menu</button>
    </nav>
  </div>
  <nav class="wh-pop" id="site-menu" popover aria-label="Menu" data-name="Menu popover">
    <ul class="wh-pop-links">
      <li><a class="wh-link wh-current" href="#work" aria-current="page">Work</a></li>
      <li><a class="wh-link" href="#studio">Studio</a></li>
      <li><a class="wh-link" href="#questions">Questions</a></li>
    </ul>
  </nav>
</header>`,
};

const hero: Section = {
  kind: 'hero',
  name: 'Editorial hero',
  description: 'A large, left-aligned headline on the fluid display size, a lead paragraph held to a readable measure, one primary and one quiet action, and a captioned picture that keeps its ratio. Stacks by itself on narrow screens.',
  facts: [{ layer: 'Hero headline', hint: 'What the reader gets, in their words.' }, { layer: 'Hero lead', hint: 'Who it is for and what makes it specific.' }, { layer: 'Hero picture', hint: 'A real photo: upload it and set its alt text.' }],
  html: `<style>
.hx { ${WRAP} display: grid; grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr)); gap: ${S('xl', '3rem')}; align-items: end; padding-block: ${S('2xl', '4rem')}; color: ${INK}; }
.hx-text { display: flex; flex-direction: column; gap: ${S('m', '1.5rem')}; }
.hx-h { font-size: ${T('display', 'clamp(2.5rem, 1.6rem + 4vw, 5rem)')}; line-height: 1.02; letter-spacing: -0.02em; font-weight: 600; max-width: 14ch; }
.hx-lead { font-size: ${T('lead', '1.25rem')}; line-height: 1.5; color: ${MUTED}; max-width: 36ch; }
.hx-actions { display: flex; flex-wrap: wrap; gap: ${S('s', '1rem')}; }
.hx-primary { display: inline-flex; align-items: center; min-height: 48px; padding: 0 ${S('m', '1.5rem')}; background: ${ACCENT}; color: ${ON_ACCENT}; text-decoration: none; font-weight: 600; }
.hx-primary:focus-visible, .hx-quiet:focus-visible { ${FOCUS} }
.hx-quiet { display: inline-flex; align-items: center; min-height: 48px; color: ${INK}; text-decoration: underline; text-underline-offset: 0.25em; }
.hx-fig { display: flex; flex-direction: column; gap: ${S('2xs', '0.5rem')}; margin: 0; }
.hx-img { width: 100%; height: auto; aspect-ratio: 4 / 5; object-fit: cover; background: color-mix(in srgb, ${INK} 6%, ${PAPER}); }
.hx-cap { font-size: ${T('small', '0.875rem')}; color: ${MUTED}; }
</style>
<section class="hx" id="work" aria-labelledby="hero-title" data-name="Hero">
  <div class="hx-text" data-name="Hero text">
    <h1 class="hx-h" id="hero-title" data-name="Hero headline">Plates thrown by hand, fired for daily use</h1>
    <p class="hx-lead" data-name="Hero lead">Stoneware for kitchens that cook every night. Each set is made to order in a two-person studio and ships when the glaze has set.</p>
    <div class="hx-actions" data-name="Hero actions">
      <a class="hx-primary" href="#studio" data-name="Primary action">See this season’s sets</a>
      <a class="hx-quiet" href="#questions" data-name="Secondary action">How ordering works</a>
    </div>
  </div>
  <figure class="hx-fig" data-name="Hero figure">
    <img class="hx-img" alt="" loading="eager" data-name="Hero picture">
    <figcaption class="hx-cap" data-name="Hero caption">Dinner set in iron glaze, six pieces.</figcaption>
  </figure>
</section>`,
};

const proof: Section = {
  kind: 'proof',
  name: 'Proof with sources',
  description: 'Three facts as a description list that wraps by itself, and one quote with its source. Facts and the quote are what the person supplies; the structure keeps each claim next to where it comes from.',
  facts: [{ layer: 'Fact value', hint: 'A number you can show the source of.' }, { layer: 'Fact source', hint: 'Where the number comes from, and when.' }, { layer: 'Quote', hint: 'A real customer’s words, with permission.' }, { layer: 'Quote source', hint: 'Their name and what they bought.' }],
  html: `<style>
.px { ${WRAP} display: flex; flex-direction: column; gap: ${S('xl', '3rem')}; padding-block: ${S('2xl', '4rem')}; color: ${INK}; border-top: 1px solid ${LINE}; }
.px-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); gap: ${S('l', '2rem')}; margin: 0; }
.px-item { display: flex; flex-direction: column-reverse; gap: ${S('3xs', '0.25rem')}; }
.px-value { font-size: ${T('h1', '3rem')}; line-height: 1.05; font-weight: 600; margin: 0; }
.px-label { font-size: ${T('body', '1rem')}; color: ${INK}; }
.px-source { font-size: ${T('small', '0.875rem')}; color: ${MUTED}; order: -1; }
.px-quote { margin: 0; max-width: 40rem; display: flex; flex-direction: column; gap: ${S('s', '1rem')}; }
.px-q { font-size: ${T('h3', '1.5rem')}; line-height: 1.35; }
.px-cite { font-size: ${T('small', '0.875rem')}; color: ${MUTED}; font-style: normal; }
</style>
<section class="px" id="studio" aria-labelledby="proof-title" data-name="Proof">
  <h2 class="px-q" id="proof-title" data-name="Proof heading">Made slowly, and it shows in the numbers</h2>
  <dl class="px-list" data-name="Facts">
    <div class="px-item" data-name="Fact"><dt class="px-label" data-name="Fact label">sets sent out since the kiln was built</dt><dd class="px-value" data-name="Fact value">1,240</dd><dd class="px-source" data-name="Fact source">Order book, 2019 to October 2026</dd></div>
    <div class="px-item" data-name="Fact"><dt class="px-label" data-name="Fact label">returned because of a chip in transit</dt><dd class="px-value" data-name="Fact value">0.6%</dd><dd class="px-source" data-name="Fact source">Courier claims, last 12 months</dd></div>
    <div class="px-item" data-name="Fact"><dt class="px-label" data-name="Fact label">from order to doorstep, on average</dt><dd class="px-value" data-name="Fact value">23 days</dd><dd class="px-source" data-name="Fact source">Shipping log, this season</dd></div>
  </dl>
  <blockquote class="px-quote" data-name="Quote block">
    <p class="px-q" data-name="Quote">We use the bowls every day and they still look like the day they came out of the box.</p>
    <footer><cite class="px-cite" data-name="Quote source">Mara L., six-piece set, 2024</cite></footer>
  </blockquote>
</section>`,
};

const accordion: Section = {
  kind: 'accordion',
  name: 'Accordion, one open at a time',
  description: 'Questions as native disclosures that share a name, so opening one closes the others, the way tabs behave, with the keyboard and screen readers handled by the browser. The first answer is open.',
  facts: [{ layer: 'Question', hint: 'A question buyers really ask.' }, { layer: 'Answer', hint: 'The answer, plainly, in one or two sentences.' }],
  html: `<style>
.ax { ${WRAP} display: flex; flex-direction: column; gap: ${S('xl', '3rem')}; padding-block: ${S('2xl', '4rem')}; color: ${INK}; }
.ax-h { font-size: ${T('h2', '2.25rem')}; line-height: 1.15; letter-spacing: -0.01em; font-weight: 600; }
.ax-list { display: flex; flex-direction: column; border-top: 1px solid ${LINE}; max-width: 46rem; }
.ax-item { border-bottom: 1px solid ${LINE}; }
.ax-q { display: flex; align-items: center; justify-content: space-between; gap: ${S('s', '1rem')}; min-height: 56px; cursor: pointer; font-size: ${T('body', '1rem')}; font-weight: 600; list-style: none; }
.ax-q::after { content: "+"; font-weight: 400; font-size: 1.25em; }
.ax-q:focus-visible { ${FOCUS} }
.ax-item[open] .ax-q::after { content: "\\2212"; }
.ax-a { padding: 0 0 ${S('m', '1.5rem')}; color: ${MUTED}; font-size: ${T('body', '1rem')}; line-height: 1.6; max-width: 62ch; }
</style>
<section class="ax" id="questions" aria-labelledby="questions-title" data-name="Questions">
  <h2 class="ax-h" id="questions-title" data-name="Questions heading">Before you order</h2>
  <div class="ax-list" data-name="Question list">
    <details class="ax-item" name="faq" open data-name="Question item"><summary class="ax-q" data-name="Question">How long does a set take?</summary><p class="ax-a" data-name="Answer">Three to four weeks: we throw, dry and fire each order, and only ship once the glaze has cured.</p></details>
    <details class="ax-item" name="faq" data-name="Question item"><summary class="ax-q" data-name="Question">Can it go in the dishwasher?</summary><p class="ax-a" data-name="Answer">Yes. The stoneware is fired at 1,260 °C; hand-washing keeps the iron glaze matte for longer.</p></details>
    <details class="ax-item" name="faq" data-name="Question item"><summary class="ax-q" data-name="Question">What if something breaks on the way?</summary><p class="ax-a" data-name="Answer">Send a photo within a week and we make the piece again at no cost.</p></details>
  </div>
</section>`,
};

const dialog: Section = {
  kind: 'dialog',
  name: 'Dialog',
  description: 'A button that opens a popover dialog with a heading, a short text and a close button. Esc and a click outside close it; focus returns to the button. Native popover, no script.',
  facts: [{ layer: 'Dialog heading', hint: 'What the dialog is about.' }, { layer: 'Dialog text', hint: 'The one thing the reader needs to know or do.' }],
  html: `<style>
.dx { ${WRAP} padding-block: ${S('l', '2rem')}; color: ${INK}; }
.dx-open { display: inline-flex; align-items: center; min-height: 48px; padding: 0 ${S('m', '1.5rem')}; border: 1px solid ${INK}; background: transparent; color: ${INK}; font: inherit; font-weight: 600; cursor: pointer; }
.dx-open:focus-visible, .dx-close:focus-visible { ${FOCUS} }
.dx-pop { width: min(100% - 2rem, 30rem); padding: ${S('l', '2rem')}; border: 1px solid ${LINE}; background: ${PAPER}; color: ${INK}; }
.dx-body { display: flex; flex-direction: column; gap: ${S('s', '1rem')}; }
.dx-h { font-size: ${T('h3', '1.5rem')}; line-height: 1.25; font-weight: 600; }
.dx-t { font-size: ${T('body', '1rem')}; line-height: 1.6; color: ${MUTED}; }
.dx-close { align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px; padding: 0 ${S('s', '1rem')}; background: ${ACCENT}; color: ${ON_ACCENT}; border: 0; font: inherit; font-weight: 600; cursor: pointer; }
</style>
<aside class="dx" aria-label="Shipping note" data-name="Dialog section">
  <button class="dx-open" type="button" popovertarget="shipping-note" data-name="Dialog button">Shipping to the EU</button>
  <div class="dx-pop" id="shipping-note" popover role="dialog" aria-labelledby="shipping-title" data-name="Dialog">
    <div class="dx-body">
      <h2 class="dx-h" id="shipping-title" data-name="Dialog heading">Shipping to the EU</h2>
      <p class="dx-t" data-name="Dialog text">Orders ship from Graz within the EU with tracking. Duties are paid by us, so nothing is due at the door.</p>
      <button class="dx-close" type="button" popovertarget="shipping-note" popovertargetaction="hide" data-name="Dialog close">Close</button>
    </div>
  </div>
</aside>`,
};

const footer: Section = {
  kind: 'footer',
  name: 'Footer',
  description: 'Contact, the same sections as the navigation, the small print and a link back to the top, in columns that wrap by themselves.',
  facts: [{ layer: 'Footer contact', hint: 'A real address or e-mail.' }, { layer: 'Small print', hint: 'Company name, registration and the current year.' }],
  html: `<style>
.fx { border-top: 1px solid ${LINE}; color: ${INK}; background: ${PAPER}; }
.fx-in { ${WRAP} display: grid; grid-template-columns: repeat(auto-fit, minmax(min(12rem, 100%), 1fr)); gap: ${S('l', '2rem')}; padding-block: ${S('xl', '3rem')}; }
.fx-h { font-size: ${T('small', '0.875rem')}; font-weight: 600; margin-bottom: ${S('2xs', '0.5rem')}; }
.fx-list { display: flex; flex-direction: column; gap: ${S('3xs', '0.25rem')}; list-style: none; margin: 0; padding: 0; }
.fx-link { display: inline-flex; min-height: 32px; align-items: center; color: ${INK}; text-decoration: none; font-size: ${T('small', '0.875rem')}; }
.fx-link:hover { text-decoration: underline; }
.fx-link:focus-visible { ${FOCUS} }
.fx-print { font-size: ${T('small', '0.875rem')}; color: ${MUTED}; }
</style>
<footer class="fx" data-name="Site footer">
  <div class="fx-in" data-name="Footer columns">
    <div data-name="Footer contact column"><p class="fx-h">Studio</p><p class="fx-print" data-name="Footer contact">Kiln &amp; Table, Annenstraße 12, 8020 Graz · hello@example.com</p></div>
    <nav aria-label="Footer" data-name="Footer navigation"><p class="fx-h">On this page</p><ul class="fx-list"><li><a class="fx-link" href="#work">Work</a></li><li><a class="fx-link" href="#studio">Studio</a></li><li><a class="fx-link" href="#questions">Questions</a></li></ul></nav>
    <div data-name="Footer end"><p class="fx-print" data-name="Small print">Copyright 2026 Kiln &amp; Table. Sample copy: replace before publishing.</p><a class="fx-link" href="#top" data-name="Back to top">Back to top</a></div>
  </div>
</footer>`,
};

export const SECTIONS: readonly Section[] = [header, hero, proof, accordion, dialog, footer];

export function findSection(kind: string): Section {
  const s = SECTIONS.find((x) => x.kind === kind);
  if (!s) throw new Error(`There is no section "${kind}". Sections: ${SECTIONS.map((x) => x.kind).join(', ')}.`);
  return s;
}
