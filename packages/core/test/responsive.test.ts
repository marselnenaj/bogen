import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyResponsive, BogenDoc, importHtml, linkedArtboards, planResponsive, responsiveLink, responsiveSteps, type BogenNode } from '../src/index.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

function landing() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const board = doc.insert(page, { type: 'frame', name: 'Landing', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1440px', height: 'fit-content', display: 'flex', flexDirection: 'column' } });
  doc.insertMany(board, importHtml(readFileSync(join(fixtures, 'responsive-landing.html'), 'utf8')).nodes);
  const all = () => doc.descendants(board);
  const find = (test: (n: BogenNode) => boolean) => all().find(test)!;
  return { doc, page, board, all, find };
}

describe('responsive variants', () => {
  it('puts each width\'s rules midway to the next wider one, or on a breakpoint token there', () => {
    expect(responsiveSteps(1440, [390, 768]).map((s) => [s.width, s.query])).toEqual([[768, '(max-width: 1104px)'], [390, '(max-width: 576px)']]);
    expect(responsiveSteps(1440, [768], [{ px: 1024, token: 'bp-lg' }]).map((s) => s.query)).toEqual(['(max-width: var(--bp-lg))']);
    expect(responsiveSteps(1440, [1600, 100])).toEqual([]);
  });

  it('wraps or stacks flex rows, takes columns from grids, and steps type and spacing down', () => {
    const { doc, board, find } = landing();
    const plan = planResponsive(doc, board);
    // What applies at a width: its own changes on top of every wider one's, as the cascade does.
    const at = (width: number, id: string) => Object.assign({}, ...plan.changes.filter((c) => c.width >= width && c.id === id).map((c) => c.style)) as Record<string, string>;
    const hero = find((n) => n.tag === 'section' && doc.getChildren(n.id).some((k) => k.tag === 'img')).id;
    const features = find((n) => n.style.display === 'grid' && n.style.gridTemplateColumns === 'repeat(3, 1fr)').id;
    const footer = find((n) => n.tag === 'footer').id;
    const h1 = find((n) => n.tag === 'h1').id;
    const img = find((n) => n.tag === 'img').id;
    const plan1 = find((n) => n.style.width === '380px').id;
    const links = find((n) => n.tag === 'nav').id;
    // The hero's two columns do not fit 768 side by side, so they stack there already.
    expect(at(768, hero)).toMatchObject({ flexDirection: 'column', alignItems: 'stretch' });
    expect(at(768, features).gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(at(390, features).gridTemplateColumns).toBe('1fr');
    expect(at(768, footer).gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    expect(at(768, h1)).toEqual({ fontSize: '60px', lineHeight: '67px' });
    expect(at(390, h1)).toEqual({ fontSize: '48px', lineHeight: '53px' });
    expect(at(768, hero).padding).toBe('80px 48px');
    expect(at(390, hero).padding).toBe('48px 24px');
    expect(at(390, img)).toMatchObject({ aspectRatio: '560 / 420', height: 'auto', width: '100%', maxWidth: '100%' });
    expect(at(390, plan1)).toMatchObject({ width: '100%', height: 'auto' });
    // Five links fit a tablet, and fold into a menu on a phone.
    expect(at(768, links).display).toBeUndefined();
    expect(at(390, links).display).toBe('none');
    expect(plan.menus).toEqual([expect.objectContaining({ width: 390, links })]);
  });

  it('writes media blocks on the layers, with a menu button that shows on a phone, and again cleanly', () => {
    const { doc, board, find, all } = landing();
    const result = applyResponsive(doc, board, { widths: [768, 390] });
    expect(result.method).toBe('rules');
    expect(result.menuButtons).toHaveLength(1);
    const h1 = find((n) => n.tag === 'h1');
    expect(h1.rules).toEqual({ '@media (max-width: 1104px)': { fontSize: '60px', lineHeight: '67px' }, '@media (max-width: 576px)': { fontSize: '48px', lineHeight: '53px' } });
    const menu = doc.getNode(result.menuButtons[0]!)!;
    expect(menu.style.display).toBe('none');
    expect(menu.rules).toEqual({ '@media (max-width: 576px)': { display: 'inline-flex' } });
    expect(doc.getNode(board)!.rules).toBeUndefined();
    const count = all().length;
    const blocks = JSON.stringify(all().map((n) => n.rules ?? null));
    applyResponsive(doc, board, { widths: [768, 390] });
    expect(all().length).toBe(count);
    expect(JSON.stringify(all().map((n) => n.rules ?? null).filter(Boolean)).length).toBe(JSON.stringify(JSON.parse(blocks).filter(Boolean)).length);
  });

  it('makes linked artboards next to the source, and rebuilds them in place', () => {
    const { doc, page, board } = landing();
    const first = applyResponsive(doc, board, { method: 'artboards' });
    expect(first.artboards.map((a) => [a.width, a.updated])).toEqual([[768, false], [390, false]]);
    const phone = first.artboards[1]!.id;
    expect(responsiveLink(doc, phone)).toEqual({ source: board, width: 390 });
    expect(doc.getNode(phone)!.style).toMatchObject({ width: '390px', left: `${1440 + 120 + 768 + 120}px` });
    const phoneH1 = doc.descendants(phone).find((n) => n.tag === 'h1')!;
    expect(phoneH1.style.fontSize).toBe('48px');
    expect(phoneH1.rules).toBeUndefined();
    expect(doc.descendants(phone).find((n) => n.tag === 'nav')!.style.display).toBe('none');
    expect(doc.descendants(phone).some((n) => n.name === 'Menu button' && n.style.display === 'inline-flex')).toBe(true);
    // A later edit to the source reaches the variants when they are made again.
    const h1 = doc.descendants(board).find((n) => n.tag === 'h1')!.id;
    doc.updateFields(h1, { text: 'Clay and fire' });
    doc.updateStyle(phone, { left: '5000px' });
    const second = applyResponsive(doc, board, { method: 'artboards' });
    expect(second.artboards.map((a) => [a.id, a.updated])).toEqual([[first.artboards[0]!.id, true], [phone, true]]);
    expect(doc.getNode(phone)!.style.left).toBe('5000px');
    expect(doc.descendants(phone).find((n) => n.tag === 'h1')!.text).toBe('Clay and fire');
    expect(linkedArtboards(doc, board)).toHaveLength(2);
    expect(doc.getChildren(page)).toHaveLength(3);
    expect(() => applyResponsive(doc, phone)).toThrow(/variant of another artboard/);
  });

  it('steps down the file\'s own tokens and writes them as tokens', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const page = doc.getPages()[0]!.id;
    for (const [name, value] of [['space-sm', '8px'], ['space-md', '16px'], ['space-lg', '32px'], ['space-xl', '64px']]) doc.setToken(name!, 'spacing', value!);
    for (const [name, value] of [['text-body', '16px'], ['text-lg', '24px'], ['text-xl', '40px'], ['text-2xl', '56px']]) doc.setToken(name!, 'font-size', value!);
    const board = doc.insert(page, { type: 'frame', name: 'App', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '1440px' } });
    const head = doc.insert(board, { type: 'frame', name: 'Head', style: { display: 'flex', flexDirection: 'column', padding: 'var(--space-xl)', gap: 'var(--space-md)' } });
    const title = doc.insert(head, { type: 'text', tag: 'h1', name: 'Title', text: 'October', style: { fontSize: 'var(--text-2xl)' } });
    const plan = planResponsive(doc, board, { widths: [390] });
    const style = (id: string) => plan.changes.find((c) => c.id === id)!.style;
    expect(style(title).fontSize).toBe('var(--text-xl)');
    expect(style(head).padding).toBe('var(--space-lg) var(--space-md)');
  });

  it('needs a fixed width to start from', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', name: 'Hug', artboard: true, style: { width: 'fit-content' } });
    expect(() => planResponsive(doc, board)).toThrow(/no fixed width/);
  });
});
