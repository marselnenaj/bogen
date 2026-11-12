import { deflateSync } from 'node:zlib';
import {
  addFontFaces, autoGrid, BogenDoc, checkAttrs, clampAt, designReview, fluidClamp, fluidScale, focusOrder, fontAudit, importHtml, containerNarrowPlan, mediaToContainerPlan, stressCopy, toJsx,
} from '@bogen/core';
import { afterEach, describe, expect, it } from 'vitest';
import { exportTarget } from '../src/exporter.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

function board(doc: BogenDoc, width = 1440) {
  doc.ensureFirstPage();
  const pageId = doc.getPages()[0]!.id;
  const id = doc.insert(pageId, { type: 'frame', name: 'Page', artboard: true, style: { width: `${width}px`, display: 'flex', flexDirection: 'column' } });
  doc.invalidate();
  return { pageId, id };
}

describe('fluid type and space', () => {
  it('writes clamp() in rem that hits the ends exactly and stays readable at the reader\'s font size', () => {
    const v = fluidClamp(16, 20, 360, 1280);
    expect(v).toMatch(/^clamp\(1rem, [\d.]+rem \+ [\d.]+vw, 1\.25rem\)$/);
    expect(clampAt(v, 360)).toBeCloseTo(16, 1);
    expect(clampAt(v, 1280)).toBeCloseTo(20, 1);
    expect(clampAt(v, 200)).toBe(16);
    expect(clampAt(v, 2000)).toBe(20);
    expect(fluidClamp(16, 16)).toBe('1rem');
  });

  it('makes a scale whose roles step down at every width, with spacing that grows with it', () => {
    const { tokens, styles, at } = fluidScale();
    const order = ['display', 'h1', 'h2', 'h3', 'lead', 'body', 'small'];
    for (const w of [360, 800, 1280]) {
      const sizes = order.map((r) => clampAt(tokens.find((t) => t.name === `type-${r}`)!.value, w)!);
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]!, `${order[i]} at ${w}`).toBeLessThan(sizes[i - 1]!);
    }
    expect(at.body).toEqual([16, 18]);
    expect(styles.find((s) => s.key === 'h1')!.style.fontSize).toBe('var(--type-h1)');
    expect(tokens.filter((t) => t.kind === 'spacing').map((t) => t.name)).toContain('space-xl');
  });
});

describe('grids and containers', () => {
  it('fits columns without a breakpoint and without overflowing a phone', () => {
    expect(autoGrid('16rem', '1.5rem')).toEqual({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))', gap: '1.5rem' });
    expect(autoGrid('280px', '1rem', 'fill').gridTemplateColumns).toBe('repeat(auto-fill, minmax(min(280px, 100%), 1fr))');
  });

  it('turns a component\'s media queries into queries of the slot it sits in, never of itself', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    const slot = doc.insert(b.id, { type: 'frame', name: 'Sidebar', style: { width: '480px' } });
    const card = doc.insert(slot, { type: 'frame', name: 'Card', style: { display: 'flex' } });
    const title = doc.insert(card, { type: 'text', name: 'Title', text: 'A card' });
    doc.updateRules(card, '@media (max-width: 720px)', { flexDirection: 'column' });
    doc.updateRules(title, '@media (prefers-color-scheme: dark)', { color: 'white' });
    doc.invalidate();
    const plan = mediaToContainerPlan(doc, card, 'sidebar', 480, 1440);
    // The card's own rule can only follow an ancestor: the container is its parent.
    expect(plan.containerId).toBe(slot);
    expect(plan.containerStyle).toEqual({ containerType: 'inline-size', containerName: 'sidebar' });
    expect(plan.changes).toEqual([{ id: card, from: '@media (max-width: 720px)', to: '@container sidebar (max-width: 240px)' }]);
    expect(plan.skipped[0]).toMatch(/not a plain width query/);
  });

  it('puts a narrow condition on the layouts inside a container, not on the container', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    const card = doc.insert(b.id, { type: 'frame', name: 'Card', style: { width: '480px', display: 'flex', containerType: 'inline-size', containerName: 'card' } });
    const row = doc.insert(card, { type: 'frame', name: 'Row', style: { display: 'flex', gap: '16px' } });
    const grid = doc.insert(card, { type: 'frame', name: 'Grid', style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } });
    const nested = doc.insert(card, { type: 'frame', name: 'Nested', style: { display: 'block', containerType: 'inline-size' } });
    doc.insert(nested, { type: 'frame', name: 'Inner row', style: { display: 'flex' } });
    doc.insert(card, { type: 'frame', name: 'Column', style: { display: 'flex', flexDirection: 'column' } });
    doc.invalidate();
    const plan = containerNarrowPlan(doc, card, 'card', 300);
    expect(plan.map((c) => c.id)).toEqual([row, grid]);
    expect(plan.every((c) => c.id !== card && c.key === '@container card (max-width: 300px)')).toBe(true);
    expect(plan[0]!.props.flexDirection).toBe('column');
    expect(plan[1]!.props.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(containerNarrowPlan(doc, row, 'row', 200)).toEqual([]);
  });
});

describe('fonts', () => {
  it('names synthesized weights and italics, missing fallbacks and families nothing provides', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    addFontFaces(doc, [{ family: 'Brand Sans', src: `bogen-asset:${'a'.repeat(64)}.woff2`, weight: '400' }]);
    const bold = doc.insert(b.id, { type: 'text', name: 'Bold', text: 'Heavy words', style: { fontFamily: '"Brand Sans", system-ui, sans-serif', fontWeight: '700' } });
    const bare = doc.insert(b.id, { type: 'text', name: 'Bare', text: 'No fallback', style: { fontFamily: 'Inter' } });
    const it = doc.insert(b.id, { type: 'text', name: 'Italic', text: 'Slanted', style: { fontFamily: 'Inter, sans-serif', fontStyle: 'italic', fontWeight: '600' } });
    const ghost = doc.insert(b.id, { type: 'text', name: 'Ghost', text: 'Missing', style: { fontFamily: 'Totally Made Up, serif' } });
    doc.invalidate();
    const out = fontAudit(doc, [b.id], { google: new Set(['Inter']) });
    const msg = (id: string) => out.findings.filter((f) => f.layers.includes(id)).map((f) => f.message).join('\n');
    expect(msg(bold)).toMatch(/Brand Sans 700 is used but no 700 face/);
    expect(msg(bare)).toMatch(/ends without a generic family/);
    expect(msg(it)).toMatch(/italic 600: Bogen loads Google italics at 400 and 700 only/);
    expect(msg(ghost)).toMatch(/Nothing provides Totally Made Up/);
    expect(out.families.find((f) => f.family === 'Brand Sans')).toMatchObject({ source: 'hosted', weights: ['700'] });
  });
});

describe('keyboard focus order', () => {
  it('lists the stops a keyboard visits and what breaks the order or the names', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    const { nodes } = importHtml(`<nav style="display:flex;flex-direction:row-reverse"><a href="#a">First</a><a href="#b">Second</a></nav>
      <a>No href</a><button type="button" aria-label="Search"><svg viewBox="0 0 1 1"></svg></button><button type="button"></button>
      <button type="button" popovertarget="nowhere">Menu</button><div tabindex="3">Jump</div>`);
    doc.insertMany(b.id, nodes);
    doc.invalidate();
    const out = focusOrder(doc, b.id);
    expect(out.stops.map((s) => s.name)).toEqual(['Jump', 'First', 'Second', 'Search', '', 'Menu']);
    const text = out.issues.map((i) => i.message).join('\n');
    expect(text).toMatch(/row-reverse/);
    expect(text).toMatch(/<a> without href/);
    expect(text).toMatch(/has no name/);
    expect(text).toMatch(/popovertarget="nowhere" names no element/);
    expect(text).toMatch(/tabindex="3" moves this ahead/);
  });
});

describe('design review', () => {
  it('measures what makes a page look generated, with layers to look at', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    const card = (t: string) => `<div style="display:flex;flex-direction:column;width:300px"><svg viewBox="0 0 1 1" data-name="Icon"></svg><h3 style="font-size:20px">${t}</h3><p>Short line about ${t}.</p></div>`;
    const { nodes } = importHtml(`<p style="text-transform:uppercase;font-size:12px">FEATURES</p><h2 style="font-size:40px">Everything you need 🚀</h2>
      <div style="display:flex;gap:13px">${card('Fast')}${card('Secure')}${card('Simple')}</div>
      <p style="text-transform:uppercase;font-size:12px">PRICING</p><h2 style="font-size:40px">Simple pricing!</h2>
      <p style="text-transform:uppercase;font-size:12px">FAQ</p><h2 style="font-size:40px">Questions!</h2>
      <p style="font-size:16px;line-height:1.2">${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4)}</p>`);
    doc.insertMany(b.id, nodes);
    doc.invalidate();
    const { observations } = designReview(doc, b.id);
    const text = observations.map((o) => o.message).join('\n');
    expect(text).toMatch(/No h1/);
    expect(text).toMatch(/3 cards with the same icon-title-text shape/);
    expect(text).toMatch(/small uppercase label over them/);
    expect(text).toMatch(/emoji/);
    expect(text).toMatch(/placeholder copy/);
    expect(text).toMatch(/exclamation mark/);
    expect(text).toMatch(/no width or max-width/);
    expect(text).toMatch(/Line height 1\.2/);
  });
});

describe('content stress', () => {
  it('lengthens text and drops images in a copy, and leaves the file as it was', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    const title = doc.insert(b.id, { type: 'text', name: 'Title', text: 'Order today' });
    const img = doc.insert(b.id, { type: 'image', name: 'Photo', src: `bogen-asset:${'b'.repeat(64)}.png` });
    doc.invalidate();
    const before = JSON.stringify([doc.getNode(title), doc.getNode(img)]);
    const out = stressCopy(doc, b.id, { textFactor: 2, longWords: true, missingImages: true });
    expect(out.changed).toBe(2);
    expect(out.doc.getNode(title)!.text!.length).toBeGreaterThanOrEqual('Order today'.length * 2);
    expect(out.doc.getNode(title)!.text).toContain('Datenschutzgrundverordnungskonformitätsprüfung');
    expect(out.doc.getNode(img)!.src).toBeFalsy();
    expect(JSON.stringify([doc.getNode(title), doc.getNode(img)])).toBe(before);
    out.doc.y.destroy();
  });
});

describe('attributes a real website needs', () => {
  it('keeps checked web attributes and refuses wrong values', () => {
    expect(checkAttrs('frame', { id: 'menu', popover: '', 'aria-expanded': 'false', tabindex: '0', name: 'faq', popovertarget: 'menu', loading: 'lazy' }).rejected).toEqual([]);
    const bad = checkAttrs('frame', { popover: 'evil', tabindex: 'x', id: '1-bad', onclick: 'x()' }).rejected.map((r) => r.name).sort();
    expect(bad).toEqual(['id', 'onclick', 'popover', 'tabindex']);
  });

  it('makes only a web page fluid in code, and keeps app screens and posters at their size', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const p = doc.getPages()[0]!.id;
    const site = doc.insert(p, { type: 'frame', name: 'Site', artboard: true, attrs: { 'data-web': 'page' }, style: { width: '1440px', height: '900px', display: 'flex' } });
    const app = doc.insert(p, { type: 'frame', name: 'Screen', artboard: true, style: { width: '420px', height: '935px', display: 'flex' } });
    const poster = doc.insert(p, { type: 'frame', name: 'Poster', artboard: true, style: { width: '1080px', height: '1350px' } });
    doc.invalidate();
    const s = toJsx(doc, site, 'inline');
    expect(s).toMatch(/width: "100%"/);
    expect(s).toMatch(/maxWidth: "1440px"/);
    expect(s).toMatch(/minHeight: "900px"/);
    expect(s).not.toMatch(/height: "900px"/);
    for (const id of [app, poster]) {
      const code = toJsx(doc, id, 'inline');
      expect(code).not.toMatch(/maxWidth|width: "100%"/);
    }
    expect(toJsx(doc, app, 'inline')).toMatch(/width: "420px", height: "935px"/);
  });

  it('carries them into React with React\'s names', () => {
    const doc = new BogenDoc();
    const b = board(doc);
    doc.insertMany(b.id, importHtml('<button type="button" popovertarget="m" tabindex="0">Menu</button><nav id="m" popover><a href="#x" aria-current="page">X</a></nav>').nodes);
    doc.invalidate();
    const jsx = toJsx(doc, b.id, 'inline');
    expect(jsx).toContain('popoverTarget="m"');
    expect(jsx).toContain('tabIndex="0"');
    expect(jsx).toContain('aria-current="page"');
    expect(jsx).toMatch(/<nav[^>]*id="m"[^>]*popover="auto"/);
  });
});

/** A real PNG of one colour, small enough to keep tests fast. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

describe('over MCP and in the export', () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('inserts the six sections as a working page: native behaviour, no focus problems, nothing generic', async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'claude');
    const file = (await call(agent, 'file_create', { name: 'Studio' })).id;
    await call(agent, 'type_scale_set', { file_id: file });
    const page = (await call(agent, 'artboard_create', { name: 'Home', width: 1440, x: 0, y: 0, file_id: file })).id;
    for (const kind of ['header', 'hero', 'proof', 'accordion', 'dialog', 'footer']) {
      const out = await call(agent, 'section_insert', { kind, into: page, file_id: file });
      expect(out.ids.length, kind).toBeGreaterThan(0);
    }
    // A second header would duplicate #top and #site-menu: refused, with what to do.
    const room0 = await h.server.rooms.get(file);
    expect(room0.doc.getNode(page)!.attrs?.['data-web']).toBe('page');
    const twice = await callRaw(agent, 'section_insert', { kind: 'header', into: page, file_id: file });
    expect(twice.isError).toBe(true);
    expect(twice.content[0]!.text).toMatch(/#top/);
    const focus = await call(agent, 'focus_order', { node_id: page, file_id: file });
    expect(focus.issues).toEqual([]);
    expect(focus.order.map((s: any) => s.name).slice(0, 6)).toEqual(['Kiln & Table', 'Work', 'Studio', 'Questions', 'See this season’s sets', 'How ordering works']);
    // The menu button is hidden at 1440 by the header's own container query; the popover's links wait behind it.
    expect(Object.keys(focus.inside_popovers).sort()).toEqual(['shipping-note', 'site-menu']);
    const review = await call(agent, 'design_review', { node_id: page, file_id: file });
    expect(review.observations.filter((o: any) => o.aspect === 'pattern' || o.aspect === 'content' || o.aspect === 'hierarchy')).toEqual([]);
    const room = await h.server.rooms.get(file);
    const html = new TextDecoder().decode((await exportTarget(room.doc, h.server.renderer, h.server.storage, { nodeIds: [page] }, 'html')).bytes);
    expect(html).toMatch(/<button[^>]*popovertarget="site-menu"/);
    expect(html).toMatch(/<nav[^>]*id="site-menu"[^>]*popover/);
    expect(html).toMatch(/<details[^>]*name="faq"[^>]*open/);
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(/@container site-header \(max-width: 44rem\)/);
    expect(html).toContain('popovertargetaction="hide"');
    expect(html).toContain('--type-display');
    // A web page's export has a head for the web: viewport, language, its name as title, description.
    room0.doc.updateFields(page, { attrs: { ...room0.doc.getNode(page)!.attrs, lang: 'en', 'data-description': 'Plates thrown by hand in Graz.' } });
    const html2 = new TextDecoder().decode((await exportTarget(room.doc, h.server.renderer, h.server.storage, { nodeIds: [page] }, 'html')).bytes);
    expect(html2).toMatch(/^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Plates thrown by hand in Graz.">/);
    expect(html2).toContain('<title>Home</title>');
    // A web page's export grows with the window up to its design width.
    expect(html).toMatch(/data-web="page"[^>]*style="[^"]*width:\s*100%[^"]*max-width:\s*1440px/);
    await agent.close();
  }, 60_000);

  it('exports images with their own size, lazy after the first, decoded off the main thread', async () => {
    h = await startServer();
    const doc = new BogenDoc();
    const b = board(doc);
    const a = await h.server.storage.putAsset(png(40, 30), 'image/png');
    const c = await h.server.storage.putAsset(png(20, 50), 'image/png');
    doc.insert(b.id, { type: 'image', name: 'Lead', src: a.src, attrs: { alt: 'A bowl' }, style: { width: '100%', height: 'auto' } });
    doc.insert(b.id, { type: 'image', name: 'Second', src: c.src, attrs: { alt: 'A cup' }, style: { width: '100%', height: 'auto' } });
    doc.invalidate();
    const html = new TextDecoder().decode((await exportTarget(doc, h.server.renderer, h.server.storage, { nodeIds: [b.id] }, 'html')).bytes);
    const imgs = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toMatch(/width="40"/);
    expect(imgs[0]).toMatch(/height="30"/);
    expect(imgs[0]).toMatch(/loading="eager"/);
    expect(imgs[0]).toMatch(/fetchpriority="high"/);
    expect(imgs[1]).toMatch(/width="20" height="50"|height="50"[^>]*width="20"|width="20"[^>]*height="50"/);
    expect(imgs[1]).toMatch(/loading="lazy"/);
    for (const i of imgs) expect(i).toMatch(/decoding="async"/);
  });

  it('gives motion a still alternative, and grids and containers through tools', async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'claude');
    const file = (await call(agent, 'file_create', { name: 'Motion' })).id;
    const page = (await call(agent, 'artboard_create', { name: 'Home', width: 1440, x: 0, y: 0, file_id: file })).id;
    await call(agent, 'html_write', { target_id: page, html: '<div data-name="Cards"><div style="width:480px;display:flex" data-name="Card"><p>One</p></div><div data-name="Two"><p>Two</p></div></div>', file_id: file });
    const room = await h.server.rooms.get(file);
    const cards = room.doc.descendants(page).find((n) => n.name === 'Cards')!.id;
    const card = room.doc.descendants(page).find((n) => n.name === 'Card')!.id;
    await call(agent, 'motion_preset', { node_ids: [card], preset: 'rise', stagger_ms: 60, file_id: file });
    expect(room.doc.getNode(card)!.style.animation).toMatch(/^bogen-rise 420ms cubic-bezier/);
    expect(room.doc.getNode(card)!.rules?.['@media (prefers-reduced-motion: reduce)']).toEqual({ animation: 'none' });
    expect(JSON.stringify(room.doc.meta.get('keyframes'))).toContain('@keyframes bogen-rise');
    await call(agent, 'grid_set', { node_id: cards, min: '16rem', file_id: file });
    expect(room.doc.getNode(cards)!.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(16rem, 100%), 1fr))');
    await call(agent, 'layer_style', { node_ids: [card], style: { flexDirection: 'column' }, when: '@media (max-width: 720px)', file_id: file });
    const cq = await call(agent, 'container_queries', { node_id: card, name: 'card', component_width: 480, file_id: file });
    expect(cq.changed[0].to).toBe('@container card (max-width: 240px)');
    // The card answers to the slot it sits in; it is not a container of itself.
    expect(cq.container_layer).toBe(cards);
    expect(room.doc.getNode(cards)!.style.containerType).toBe('inline-size');
    expect(room.doc.getNode(card)!.style.containerType).toBeUndefined();
    expect(Object.keys(room.doc.getNode(card)!.rules ?? {})).toContain('@container card (max-width: 240px)');
    await agent.close();
  }, 30_000);
});
