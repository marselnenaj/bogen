import { BogenDoc, createMode, importHtml, setTextStyle, applyTextStyle, setTokenMode, setVariable, type NewNode } from '../../src/index.ts';

/**
 * Designs the Exact export is checked on: a landing-page hero, a phone screen with a list and a button, nested
 * flex, and an image. Each returns its document and the artboard to export. scripts/check-exact-export.ts builds
 * the same designs with Exact's compiler when it is there.
 */

function fresh(): { doc: BogenDoc; page: string } {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

export function landingHero(): { doc: BogenDoc; root: string } {
  const { doc, page } = fresh();
  doc.setToken('ink', 'color', '#1b1f24');
  doc.setToken('paper', 'color', '#fbf8f3');
  doc.setToken('accent', 'color', '#c2410c');
  doc.setToken('space-6', 'spacing', '24px');
  doc.setToken('radius-md', 'radius', '10px');
  doc.setToken('display', 'font-family', '"Fraunces", serif');
  doc.setToken('gutter', 'spacing', 'clamp(16px, 5vw, 64px)');
  const heading = setTextStyle(doc, 'Display', { fontFamily: 'var(--display)', fontSize: '56px', fontWeight: '600', lineHeight: '1.05', letterSpacing: '-0.02em' });
  const root = doc.insert(page, {
    type: 'frame', tag: 'section', name: 'Hero', artboard: true,
    style: { position: 'absolute', left: '0px', top: '0px', width: '1280px', height: '720px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', gap: 'var(--space-6)', padding: '96px var(--gutter)', backgroundColor: 'var(--paper)', color: 'var(--ink)', fontFamily: 'Inter, sans-serif' },
    children: [
      { type: 'text', tag: 'p', name: 'Eyebrow', text: 'Field notes for night trains', style: { fontSize: '14px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent)' } },
      { type: 'text', tag: 'h1', name: 'Title', text: 'Sleep through the Alps,\nwake up in Venice', style: { maxWidth: '720px' } },
      { type: 'text', tag: 'p', name: 'Lede', text: 'Timetables, couchette layouts and border notes for 41 overnight routes.', style: { fontSize: '20px', lineHeight: '150%', maxWidth: '560px', opacity: '0.8' } },
      {
        type: 'frame', tag: 'div', name: 'Actions', style: { display: 'flex', gap: '12px', alignItems: 'center' },
        children: [
          { type: 'frame', tag: 'a', name: 'Primary', attrs: { href: 'https://example.com/routes' }, style: { display: 'inline-flex', padding: '14px 22px', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--accent)', color: '#ffffff', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.12)', transition: 'background-color 150ms ease' }, children: [{ type: 'text', tag: 'span', name: 'Primary label', text: 'Browse routes', style: { fontWeight: '600' } }] },
          { type: 'frame', tag: 'a', name: 'Secondary', attrs: { href: '#how' }, style: { padding: '14px 22px', borderRadius: 'var(--radius-md)', border: '1px solid rgba(27, 31, 36, 0.2)' }, children: [{ type: 'text', tag: 'span', name: 'Secondary label', text: 'How it works' }] },
        ],
      },
    ],
  });
  const title = doc.getChildren(root).find((c) => c.name === 'Title')!.id;
  applyTextStyle(doc, title, heading);
  // Not part of Contract: a pseudo-element on the hero.
  doc.updateRules(root, '::before', { content: '""', position: 'absolute' });
  return { doc, root };
}

export function phoneList(): { doc: BogenDoc; root: string } {
  const { doc, page } = fresh();
  createMode(doc, 'dark', { baseName: 'light' });
  doc.setToken('surface', 'color', '#ffffff');
  setTokenMode(doc, 'surface', 'dark', '#101214');
  doc.setToken('label', 'color', '#111827');
  setTokenMode(doc, 'label', 'dark', '#f3f4f6');
  setVariable(doc, { name: 'count', type: 'number', value: 0 });
  setVariable(doc, { name: 'showDone', type: 'boolean', value: false });
  const row = (title: string, detail: string): NewNode => ({
    type: 'frame' as const, tag: 'li', name: `Row ${title}`,
    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #e5e7eb' },
    children: [
      { type: 'text' as const, tag: 'span', name: `${title} title`, text: title, style: { fontSize: '17px' } },
      { type: 'text' as const, tag: 'span', name: `${title} detail`, text: detail, style: { fontSize: '15px', color: '#6b7280' } },
    ],
  });
  const root = doc.insert(page, {
    type: 'frame', tag: 'div', name: 'Inbox', artboard: true,
    style: { position: 'absolute', left: '0px', top: '0px', width: '390px', height: '844px', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--surface)', color: 'var(--label)', fontFamily: 'system-ui, sans-serif' },
    children: [
      { type: 'text', tag: 'h2', name: 'Heading', text: 'Inbox', style: { fontSize: '34px', fontWeight: '700', padding: '56px 16px 8px' } },
      { type: 'frame', tag: 'ul', name: 'List', style: { display: 'flex', flexDirection: 'column', flexGrow: '1' }, children: [row('Ticket refund', '2 min'), row('Seat change', '1 h'), row('Border check', 'Mon')] },
      { type: 'text', tag: 'p', name: 'Counter', text: '0', style: { textAlign: 'center', fontSize: '13px', color: '#6b7280' } },
      { type: 'text', tag: 'p', name: 'Done note', text: 'All caught up', hidden: true, style: { textAlign: 'center' } },
      {
        type: 'frame', tag: 'button', name: 'Compose', style: { margin: '16px', padding: '16px', borderRadius: '14px', backgroundColor: '#2563eb', color: '#ffffff', display: 'flex', justifyContent: 'center', position: 'sticky', bottom: '16px' },
        children: [{ type: 'text', tag: 'span', name: 'Compose label', text: 'New message', style: { fontSize: '17px', fontWeight: '600' } }],
      },
    ],
  });
  const kids = doc.getChildren(root);
  const counter = kids.find((c) => c.name === 'Counter')!.id;
  const note = kids.find((c) => c.name === 'Done note')!.id;
  const button = kids.find((c) => c.name === 'Compose')!.id;
  doc.updateFields(counter, { proto: { textFrom: 'count' } });
  doc.updateFields(note, { proto: { showWhen: { variable: 'showDone', op: 'is', value: true } } });
  doc.updateFields(button, { proto: { interactions: [{ trigger: 'click', actions: [{ type: 'increment', variable: 'count', by: 1 }, { type: 'toggle', variable: 'showDone' }, { type: 'navigate', to: 'elsewhere' }] }] } });
  return { doc, root };
}

export function nestedFlex(): { doc: BogenDoc; root: string } {
  const { doc, page } = fresh();
  const card = (name: string, grow: string): NewNode => ({
    type: 'frame' as const, tag: 'div', name,
    style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', flex: grow, minWidth: '0px', borderRadius: '12px', backgroundColor: '#f1f5f9' },
    children: [
      { type: 'text' as const, tag: 'h3', name: `${name} title`, text: name, style: { fontSize: '18px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
      { type: 'frame' as const, tag: 'div', name: `${name} bar`, style: { height: '6px', width: '60%', borderRadius: '9999px', backgroundImage: 'linear-gradient(90deg, #0ea5e9, #6366f1)' } },
    ],
  });
  const root = doc.insert(page, {
    type: 'frame', tag: 'main', name: 'Dashboard', artboard: true,
    style: { position: 'absolute', left: '0px', top: '0px', width: '800px', height: '600px', display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px', backgroundColor: '#ffffff' },
    children: [
      { type: 'frame', tag: 'div', name: 'Top row', style: { display: 'flex', flexDirection: 'row', gap: '16px', alignItems: 'stretch' }, children: [card('Revenue', '2'), card('Visitors', '1'), card('Refunds', '1')] },
      {
        type: 'frame', tag: 'div', name: 'Grid', style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px', placeItems: 'center' },
        children: [1, 2, 3, 4, 5, 6].map((n): NewNode => ({ type: 'frame' as const, tag: 'div', name: `Cell ${n}`, style: { height: '48px', width: '100%', borderRadius: '8px', border: '1px dashed #94a3b8', display: 'inline-flex', flexFlow: 'row wrap', paddingInline: '8px' } })),
      },
      { type: 'frame', tag: 'div', name: 'Spacer', style: { flexGrow: '1', filter: 'url(#noise)', mixBlendMode: 'plus-lighter', objectPosition: 'top' } },
    ],
  });
  return { doc, root };
}

export function withImage(): { doc: BogenDoc; root: string } {
  const { doc, page } = fresh();
  const root = doc.insert(page, {
    type: 'frame', tag: 'article', name: 'Postcard', artboard: true,
    style: { position: 'absolute', left: '0px', top: '0px', width: '360px', display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', backgroundColor: '#fffdf8' },
    children: [
      { type: 'image', tag: 'img', name: 'Photo', src: 'bogen-asset:lake-bled.webp', attrs: { alt: 'Lake Bled at dawn' }, style: { width: '100%', height: '220px', borderRadius: '12px', objectFit: 'cover' } },
      { type: 'image', tag: 'img', name: 'Stamp', src: 'https://example.com/stamp.png', attrs: { alt: 'Stamp' }, style: { width: '48px', height: '48px', position: 'absolute', top: '24px', right: '24px' } },
      { type: 'image', tag: 'img', name: 'Placeholder', style: { width: '100%', height: '80px' } },
      { type: 'svg', tag: 'svg', name: 'Logo', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#0f766e"/><path d="M7 12l3 3 7-7" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/></svg>', style: { width: '24px', height: '24px' } },
      { type: 'text', tag: 'p', name: 'Caption', text: 'Greetings from "Bled", 6:40 am', spans: [{ start: 15, end: 21, style: { fontStyle: 'italic' } }], style: { fontSize: '15px', color: '#3f3f46' } },
      { type: 'text', tag: 'p', name: 'Signature', text: 'See you soon', style: { fontSize: '15px', color: '#3f3f46' } },
    ],
  });
  return { doc, root };
}

/** A page as html_write brings it in: a header with links, a grid of cards with a hover state, a field and a button. */
export function importedPage(): { doc: BogenDoc; root: string } {
  const { doc, page } = fresh();
  const { nodes } = importHtml(`
<style>.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)} .card:hover{box-shadow:0 8px 24px rgba(0,0,0,.12)}</style>
<header style="display:flex;justify-content:space-between;align-items:center;padding:16px 32px;border-bottom:1px solid #eee">
  <strong style="font-size:20px">Railnote</strong>
  <nav style="display:flex;gap:24px"><a href="/routes" style="color:#333">Routes</a><a href="/about">About</a></nav>
</header>
<section style="padding:64px 32px;background:linear-gradient(180deg,#fff7ed,#ffffff)">
  <h1 style="font-size:48px;line-height:1.1;margin:0 0 16px;font-family:'Instrument Serif', serif">Every night train in Europe</h1>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
    <div class="card"><h3 style="margin:0">Vienna to Venice</h3><p>11 h 20 min, <em>daily</em></p></div>
    <div class="card"><h3 style="margin:0">Paris to Berlin</h3><p>13 h 50 min</p></div>
  </div>
  <form style="display:flex;gap:8px;margin-top:24px"><input type="email" placeholder="you@example.com" style="flex:1;padding:12px;border:1px solid #ccc;border-radius:8px"><button style="padding:12px 18px;background:#111;color:#fff;border-radius:8px">Notify me</button></form>
</section>`);
  const root = doc.insert(page, { type: 'frame', tag: 'div', name: 'Railnote home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', backgroundColor: '#ffffff', fontFamily: 'Inter, sans-serif' }, children: nodes });
  return { doc, root };
}

export const EXACT_FIXTURES = { 'landing-hero': landingHero, 'phone-list': phoneList, 'nested-flex': nestedFlex, 'with-image': withImage, 'imported-page': importedPage } as const;
