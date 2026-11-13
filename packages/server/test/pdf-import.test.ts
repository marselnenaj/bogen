import { afterAll, describe, expect, it } from 'vitest';
import type { NewNode } from '@bogen/core';
import { importPdf, importSvg, sniffLayerFile } from '../src/layer-import.ts';
import { readPdf, type PdfText } from '../src/pdf-import.ts';
import { findBrowser, Renderer } from '../src/render.ts';
import type { Storage } from '../src/storage.ts';
import { fixturePdf } from './pdf-fixture.ts';

const renderer = new Renderer(async () => null);
afterAll(() => renderer.close());

const stored: { bytes: number; mime: string }[] = [];
const storage = { putAsset: async (bytes: Uint8Array, mime: string) => { stored.push({ bytes: bytes.length, mime }); return { name: `a${stored.length}`, src: `bogen-asset:a${stored.length}.png`, url: '' }; } } as unknown as Storage;

function all(nodes: NewNode[]): NewNode[] {
  const out: NewNode[] = [];
  const walk = (n: NewNode) => { out.push(n); n.children?.forEach(walk); };
  nodes.forEach(walk);
  return out;
}

describe('PDF pages as layers', () => {
  it('reads text with its strings, font, size and colour, vectors and images, without a browser', async () => {
    const out = await readPdf(await fixturePdf(), null);
    expect(out.total).toBe(2);
    expect(out.title).toBe('Quarterly report');
    const [one, two] = out.pages;
    expect(one!.width).toBe(816);
    expect(one!.height).toBe(1056);
    const texts = one!.items.filter((i): i is PdfText => i.kind === 'text');
    expect(texts.map((t) => t.text)).toEqual(['Quarterly report', 'Revenue grew in every region.', 'Costs stayed flat.']);
    expect(texts[0]).toMatchObject({ weight: 700, color: '#1a1a66', family: 'Helvetica, Arial, sans-serif' });
    expect(texts[0]!.size).toBeCloseTo(37.33, 1);
    expect(texts[1]!.size).toBe(16);
    expect(texts[1]!.x).toBeCloseTo(66.67, 1);
    expect(texts[1]!.y).toBeCloseTo(309.33, 1);
    expect(one!.items.filter((i) => i.kind === 'vectors').flatMap((i) => (i.kind === 'vectors' ? i.paths : [])).length).toBe(3);
    const image = one!.items.find((i) => i.kind === 'image');
    expect(image).toMatchObject({ pixels: [4, 4], box: { x: 400, w: 160, h: 160 } });
    const picture = one!.items.find((i) => i.kind === 'picture');
    expect(picture).toMatchObject({ reason: 'gradient' });
    expect(out.notes.join(' ')).toContain('No browser');
    expect(two!.items.map((i) => (i.kind === 'text' ? i.text : i.kind))).toEqual(['Appendix']);
  });

  it.skipIf(!findBrowser())('draws what only works as a picture, alone, and reports it', async () => {
    stored.length = 0;
    const out = await importPdf(storage, renderer, await fixturePdf());
    expect(out.specs.length).toBe(2);
    expect(out.specs[0]).toMatchObject({ type: 'frame', name: 'Quarterly report, page 1', style: { width: '816px', height: '1056px' } });
    const layers = all(out.specs);
    expect(layers.filter((n) => n.type === 'text').map((n) => n.text)).toEqual(['Quarterly report', 'Revenue grew in every region.', 'Costs stayed flat.', 'Appendix']);
    expect(layers.filter((n) => n.type === 'svg').length).toBe(2);
    expect(layers.filter((n) => n.type === 'image').map((n) => n.name)).toEqual(['Image', 'Picture: gradient']);
    expect(out.pages[0]).toMatchObject({ page: 1, text: 3, vectors: 2, images: 1, pictures: [{ reason: 'gradient', drawn: true }] });
    expect(stored.every((s) => s.mime === 'image/png')).toBe(true);
    // The gradient was drawn by itself: a picture of its box, not of the whole page.
    expect(stored.length).toBe(2);
  });

  it('takes an SVG as one sanitized vector layer at its size, and knows the two kinds by their bytes', () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><script>alert(1)</script><rect width="120" height="80" fill="#e5484d" onclick="x()"/></svg>');
    expect(sniffLayerFile(svg)).toBe('svg');
    expect(sniffLayerFile(Buffer.from('%PDF-1.7\n'))).toBe('pdf');
    expect(sniffLayerFile(Buffer.from('GIF89a'))).toBe(null);
    const out = importSvg(svg, 'logo.svg');
    expect(out.specs[0]).toMatchObject({ type: 'svg', name: 'logo', style: { width: '120px', height: '80px' } });
    expect(out.specs[0]!.svg).not.toContain('script');
    expect(out.specs[0]!.svg).not.toContain('onclick');
  });
});
