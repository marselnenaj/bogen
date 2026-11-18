import { afterAll, describe, expect, it, vi } from 'vitest';
import { BogenDoc, createMode } from '@bogen/core';
import { Renderer } from '../src/render.ts';
import { agentCapture, formatLayoutMap, layoutMap, MAP_BUDGET } from '../src/layout-map.ts';
import { type RenderedBox } from '../src/mcp/lint.ts';

const renderer = new Renderer(async () => null);
const docs: BogenDoc[] = [];
afterAll(async () => { await renderer.close(); docs.forEach((d) => d.y.destroy()); });
function fixture(width = 390) {
  const doc = new BogenDoc(); docs.push(doc);
  const page = doc.createPage('App');
  const board = doc.insert(page, { type: 'frame', tag: 'main', name: width === 360 ? 'Android' : 'iPhone', artboard: true, style: { position: 'absolute', left: '-900px', top: '-600px', width: `${width}px`, height: '844px', backgroundColor: 'var(--paper)', color: '#111111', fontFamily: 'sans-serif', padding: '64px 16px 34px', display: 'flex', flexDirection: 'column', gap: '16px' } });
  doc.setToken('paper', 'color', '#ffffff');
  doc.setToken('line', 'color', '#dddddd');
  createMode(doc, 'dark');
  const text = (name: string, value: string, style: Record<string, string> = {}) => doc.insert(board, { type: 'text', tag: 'p', name, text: value, style: { margin: '0', fontSize: '16px', lineHeight: '20px', flexShrink: '0', ...style } });
  return { doc, page, board, text };
}

describe('rendered layout maps', () => {
  it('uses exact boxes and actual sibling gaps, token fills/borders, type and theme', async () => {
    const { doc, board, text } = fixture();
    const heading = text('Title', 'Appointments', { height: '40px', fontWeight: '700' });
    text('Lead', 'Today at the clinic', { height: '20px', borderBottom: '1px solid var(--line)' });
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toContain('Layout map 390x844 CSS px');
    expect(map).toContain('theme light; bg --paper');
    expect(map).toContain(`p Title [${heading}] 16,64,358,40`);
    expect(map).toContain('16,120,358,20 gap=16');
    expect(map).toContain('p=64/16/34/16');
    expect(map).toContain('sans-serif 16px/700 rgb(17, 17, 17) 1L');
    expect(map).toContain('--line');
    const layer = await layoutMap(doc, renderer, { nodeIds: [heading] });
    expect(layer).toContain('Layout map 358x40');
    expect(layer).toContain('0,0,358,40');
    expect(layer).not.toContain('Lead');
  });

  it('counts wrapped text lines and leaves hidden, transparent and clipped-away layers out', async () => {
    const { doc, board, text } = fixture();
    text('Wrapped', 'A real line of words that wraps across several short lines.', { width: '100px' });
    text('Hidden', 'Hidden', { display: 'none' });
    const hidden = doc.insert(board, { type: 'frame', style: { opacity: '0' } });
    doc.insert(hidden, { type: 'text', text: 'Transparent child' });
    const clip = doc.insert(board, { type: 'frame', style: { position: 'relative', width: '100px', height: '20px', overflow: 'hidden' } });
    doc.insert(clip, { type: 'text', text: 'Outside clip', style: { position: 'absolute', top: '100px' } });
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toMatch(/[3-9]L/);
    expect(map).not.toContain('Hidden'); expect(map).not.toContain('Transparent child');
    expect(map).not.toContain('Outside clip');
  });

  it('delivers a real bounded JPEG beside a map and measures width variants without editing the document', async () => {
    const { doc, board, text } = fixture(); text('Title', 'A phone screen');
    const capture = await agentCapture(doc, renderer, { nodeIds: [board] });
    expect(capture.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from((capture.content[0] as { data: string }).data, 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    expect(capture.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('355x768px') });
    const variant = await layoutMap(doc, renderer, { nodeIds: [board] }, { width: 360 });
    expect(variant).toContain('Layout map 360x844');
    expect(doc.getNode(board)!.style.width).toBe('390px');
  });

  it('deduplicates repeated rows with varying copy, preserving size and step', async () => {
    const { doc, board } = fixture();
    for (let i = 0; i < 8; i++) {
      const row = doc.insert(board, { type: 'frame', name: `Patient ${i}`, style: { height: '48px', flexShrink: '0', display: 'flex', alignItems: 'center', padding: '8px', backgroundColor: '#eeeeee' } });
      doc.insert(row, { type: 'text', tag: 'span', text: `Patient ${i}`, style: { fontSize: '16px', lineHeight: '20px' } });
    }
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toContain('×8 (text varies; step=0,64)');
    expect(map).not.toContain('Patient 7');
    expect(map.length).toBeLessThan(1200);
  });

  it('reports overlap, clipping, ellipsis, small type and contrast with its ratio', async () => {
    const { doc, board, text } = fixture();
    text('Tiny', 'Fine print', { fontSize: '10px', color: '#aaaaaa' });
    text('Cut', 'This is a long clipped sentence', { width: '32px', whiteSpace: 'nowrap', overflow: 'hidden' });
    text('Ellipsis', 'The accessible full name still gets ellipsised', { width: '36px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
    text('Vertical', 'Text wraps and is vertically clipped', { width: '40px', height: '20px', overflow: 'hidden' });
    text('Overlap A', 'A', { position: 'absolute', left: '20px', top: '400px', width: '80px', height: '40px' });
    text('Overlap B', 'B', { position: 'absolute', left: '60px', top: '420px', width: '80px', height: '40px' });
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toContain('! small-text'); expect(map).toContain('under 11px');
    expect(map).toMatch(/contrast.*\d+\.\d+:1/);
    expect(map).toContain('cut off'); expect(map).toContain('ellipsised');
    expect(map).toContain('clipped vertically'); expect(map).toContain('overlap');
  });

  it.each([390, 360])('reuses platform targets and edge slips on a %ipx phone', async (width) => {
    const { doc, board, text } = fixture(width);
    text('Aligned', 'One'); text('Slip', 'Two', { marginLeft: '2px' });
    const control = doc.insert(board, { type: 'text', tag: 'button', name: 'Action', text: 'Open', style: { width: '40px', height: '40px', padding: '0', flexShrink: '0', fontSize: '16px' } });
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toContain('edge-slip'); expect(map).toContain('2px');
    expect(map).toContain(`! platform-target [${control}]`);
    expect(map).toContain(width === 390 ? '44x44' : '48x48');
  });

  it('reports small sibling edge slips on desktop artboards too', async () => {
    const { doc, board, text } = fixture(800);
    text('Aligned', 'First'); text('Offset', 'Second', { marginLeft: '2px' });
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toContain('edge-slip'); expect(map).toContain('2px from sibling');
  });

  it('uses the existing spacing scale checks and budgets a large tree with an omission notice', async () => {
    const { doc, board, text } = fixture();
    doc.setToken('space-4', 'spacing', '16px');
    doc.setToken('space-2', 'spacing', '8px');
    text('Odd space', 'One', { padding: '13px' });
    const map = await layoutMap(doc, renderer, { nodeIds: [board] });
    expect(map).toContain("off the file's spacing scale");
    const boxes: RenderedBox[] = Array.from({ length: 300 }, (_, i) => ({ id: `${i}`, parent: null, tag: 'p', role: '', x: 16, y: i * 40, width: 358 + i, height: 24, lines: 1, text: `Different long text ${i}`, style: { 'font-family': 'sans-serif', 'font-size': '16px', 'font-weight': '400' } }));
    const large = formatLayoutMap(doc, boxes, []);
    expect(large.length).toBeLessThanOrEqual(MAP_BUDGET); expect(large).toContain('more; narrow node_id');
  });

  it('honors map-only without rendering a picture and surfaces render failures', async () => {
    const { doc, board } = fixture();
    const probe = vi.fn(async () => ({ issues: [], texts: [], boxes: [] }));
    const screenshot = vi.fn();
    const mock = { probe, screenshot } as unknown as Renderer;
    expect((await agentCapture(doc, mock, { nodeIds: [board] }, { mapOnly: true })).content.every((c) => c.type === 'text')).toBe(true);
    expect(screenshot).not.toHaveBeenCalled();
    probe.mockRejectedValueOnce(new Error('probe failed'));
    await expect(layoutMap(doc, mock, { nodeIds: [board] })).rejects.toThrow('probe failed');
    await expect(layoutMap(doc, mock, { nodeIds: ['missing'] })).rejects.toThrow('No layer');
  });
});
