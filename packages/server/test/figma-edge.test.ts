import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setMembers, variantAxes, type BogenDoc, type BogenNode, type NewNode } from '@bogen/core';
import { convertFigmaPages, geometrySvg, placeFigma, propName, type FigmaFile, type FigmaNode } from '../src/figma.ts';
import { startServer, type Harness } from './helpers.ts';

/**
 * Edge cases of Figma's REST file JSON, as its public docs and OpenAPI types (github.com/figma/rest-api-spec)
 * describe them, recorded by hand in `fixtures/figma/edge-cases.json`: wrapped auto layout, absolute children
 * with constraints, mixed text styles and lists, component sets, instances with property values, swaps and
 * overrides, vector networks drawn from their paths, image crops, tiles and adjustments, per-side strokes,
 * masks and grids. None of this has talked to the real API.
 */
const FIXTURE = resolve(import.meta.dirname, 'fixtures/figma/edge-cases.json');
const FILE = JSON.parse(readFileSync(FIXTURE, 'utf8')) as FigmaFile;
/** 4 x 2 pixels: red, green, blue, yellow. */
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAFklEQVR4nGP4z8DwHwwZ/gMBlIUsAAAgEBHvQnss5QAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'figd_edge_fixture_token';

function convert(flat = false) {
  const canvases = FILE.document!.children!;
  return convertFigmaPages(FILE, canvases, { images: new Map([['img-tile', 'bogen-asset:tile.png']]), vectors: new Map(), sizes: new Map([['img-tile', { width: 4, height: 2 }]]) }, { flat });
}

function findSpec(specs: NewNode[], name: string): NewNode {
  for (const s of specs) {
    if (s.name === name) return s;
    const inner = s.children ? findSpec(s.children, name) : undefined;
    if (inner) return inner;
  }
  return undefined as never;
}

describe('Figma edge cases, converted', () => {
  const out = convert();
  const all = out.pages.flatMap((p) => p.specs);
  const spec = (name: string) => {
    const s = findSpec(all, name);
    expect(s, name).toBeDefined();
    return s;
  };
  const notes = out.unsupported.map((u) => u.what);

  it('packs wrapped lines as Figma does, and spreads them only when told', () => {
    expect(spec('Wrap').style).toMatchObject({ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', alignContent: 'center', columnGap: '12px', rowGap: '20px', padding: '10px 10px 10px 10px', width: '300px', height: '200px' });
    expect(spec('Wrap spread').style).toMatchObject({ flexWrap: 'wrap', alignItems: 'flex-start', alignContent: 'space-between', columnGap: '10px', rowGap: '10px', overflow: 'hidden' });
    expect(spec('Chip A').style).toEqual({ position: 'relative', width: '100px', height: '40px', flexShrink: '0', backgroundColor: '#ff0000' });
  });

  it('places absolute children of auto layout by their constraints', () => {
    expect(spec('Corner badge').style).toEqual({ position: 'absolute', right: '10px', bottom: '10px', width: '20px', height: '20px', backgroundColor: '#0000ff' });
    expect(spec('Centered').style).toEqual({ position: 'absolute', left: 'calc(50% - 25px)', width: '50px', top: '25%', height: '10%', backgroundColor: '#00ff00' });
    expect(spec('Stretched').style).toEqual({ position: 'absolute', left: '5px', right: '5px', top: '5px', bottom: '5px', backgroundColor: 'rgba(0, 0, 0, 0.1)' });
  });

  it('overlaps children for a negative spacing, first on top when asked, and hugs at the top level', () => {
    const frame = spec('Overlap').style!;
    expect(frame.width).toBeUndefined();
    expect(frame.height).toBeUndefined();
    expect(frame.columnGap).toBeUndefined();
    expect(spec('Avatar 1').style).toMatchObject({ zIndex: '3', borderRadius: '50%', boxShadow: 'inset 0 0 0 2px #ffffff' });
    expect(spec('Avatar 1').style!.marginLeft).toBeUndefined();
    expect(spec('Avatar 2').style).toMatchObject({ marginLeft: '-8px', zIndex: '2' });
    expect(spec('Avatar 3').style).toMatchObject({ marginLeft: '-8px', zIndex: '1' });
  });

  it('keeps mixed text styles as ranges, writes lists with markers, and says what a range cannot hold', () => {
    const rich = spec('Rich');
    expect(rich.text).toBe('• Big and Mono\n• second item\nplain line');
    // The ranges moved along with the markers: "Big" and "Mono".
    expect(rich.spans).toEqual([
      { start: 2, end: 5, style: { fontSize: '24px', letterSpacing: '2px' } },
      { start: 10, end: 14, style: { fontFamily: '"JetBrains Mono", sans-serif', textDecorationLine: 'line-through' } },
    ]);
    expect(rich.text!.slice(2, 5)).toBe('Big');
    expect(rich.text!.slice(10, 14)).toBe('Mono');
    expect(rich.style).toMatchObject({ lineHeight: '1.5', fontSize: '16px', whiteSpace: 'pre-wrap', width: '400px', WebkitTextStroke: '2px #ffcc00', paintOrder: 'stroke fill' });
    expect(rich.style!.height).toBeUndefined();
    // A nested item counts on its own level.
    expect(spec('Numbered').text).toBe('1. One\n1. Two\n2. Three');
    expect(spec('Numbered').style).toMatchObject({ fontVariantPosition: 'super', lineHeight: '24px' });
    expect(notes).toEqual(expect.arrayContaining([
      'lists, written as marker characters', 'line heights of text ranges, left out', 'letter case of text ranges, left out',
      'links to layers inside text, left out', 'spacing between paragraphs, left out', 'indentation of nested list items, left out',
    ]));
    expect(out.fonts).toEqual(['Inter', 'JetBrains Mono']);
  });

  it('draws vector networks and boolean operations from their own paths when there is no render', () => {
    const bolt = spec('Bolt');
    expect(bolt.type).toBe('svg');
    expect(bolt.svg).toContain('viewBox="0 0 24 24"');
    expect(bolt.svg).toContain('<path d="M0 0L24 0L12 24Z" fill-rule="evenodd" fill="#ffcc00" fill-opacity="0.5"');
    // The stroke's outline is filled in the stroke's paint.
    expect(bolt.svg).toContain('<path d="M0 0L1 0L12 23L11 23Z" fill="#000000"');
    const ring = spec('Ring');
    expect(ring.svg).toMatch(/<linearGradient id="f[\w]+-g0" gradientUnits="userSpaceOnUse" x1="0" y1="20" x2="40" y2="20">/);
    expect(ring.svg).toContain('fill-rule="evenodd"');
    expect(ring.children).toBeUndefined();
    // An arc is not a circle, so it is a vector too.
    expect(spec('Donut').type).toBe('svg');
    expect(spec('Avatar 1').type).toBe('frame');
    expect(notes).toContain('vectors drawn from their paths, without effects');
  });

  it('keeps unsafe path data out of the SVG', () => {
    const node: FigmaNode = { id: '1:1', type: 'VECTOR', size: { x: 10, y: 10 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], fillGeometry: [{ path: 'M0 0"/><script>alert(1)</script>' }] };
    expect(geometrySvg(node, 'x', { images: new Map(), vectors: new Map(), fonts: new Set(), notes: { add: () => {} } })).toBeNull();
  });

  it('crops, fits, tiles and adjusts images', () => {
    expect(spec('Cropped')).toMatchObject({ type: 'image', src: 'bogen-asset:tile.png', attrs: { 'data-crop': '0.25 0.1 0.5 0.5' } });
    expect(spec('Cropped').style!.objectFit).toBeUndefined();
    expect(spec('Fit').style).toMatchObject({ objectFit: 'contain' });
    // Twice the 4 x 2 image, repeated.
    expect(spec('Tiled').style).toMatchObject({ backgroundImage: 'url("bogen-asset:tile.png")', backgroundSize: '8px 4px', backgroundRepeat: 'repeat', backgroundPosition: '0 0' });
    expect(spec('Adjusted').style).toMatchObject({ filter: 'brightness(2) contrast(1.2) saturate(0)', objectFit: 'cover' });
    expect(spec('Cropped background').style).toMatchObject({ backgroundColor: '#ffffff', backgroundSize: '200% 100%', backgroundPosition: '100% 0%', backgroundRepeat: 'no-repeat' });
    expect(notes).toEqual(expect.arrayContaining(['image adjustments, approximated with CSS filters', 'image temperature, tint, highlights and shadows, left out', 'rotated image fills, shown unrotated']));
    expect(notes).not.toContain('image crops, shown uncropped');
  });

  it('draws strokes on some sides without taking room, unless they are dashed', () => {
    expect(spec('Center sides').style!.boxShadow).toBe('inset 0px 2px 0 0 #000000, inset 1px 0px 0 0 #000000, 0px -2px 0 0 #000000, -1px 0px 0 0 #000000');
    expect(spec('Outside sides').style!.boxShadow).toBe('0px 3px 0 0 #000000');
    expect(spec('Dashed sides').style).toMatchObject({ borderTop: '1px dashed #000000', borderBottom: '1px dashed #000000' });
    expect(spec('Dashed sides').style!.borderLeft).toBeUndefined();
  });

  it('turns a shape mask into a clipping frame that holds the layers above it', () => {
    const masked = spec('Masked');
    expect(masked.children!.map((c) => c.name)).toEqual(['Back', 'Circle mask']);
    const mask = spec('Circle mask');
    expect(mask.style).toEqual({ position: 'absolute', left: '50px', top: '50px', width: '100px', height: '100px', borderRadius: '50%', overflow: 'hidden' });
    expect(mask.children!.map((c) => c.name)).toEqual(['Under mask', 'Over']);
    expect(spec('Under mask').style).toMatchObject({ left: '-50px', top: '-50px', width: '200px', height: '200px' });
    expect(spec('Over').style).toMatchObject({ left: '10px', top: '10px' });
  });

  it('writes grids with their own tracks, gaps, spans and alignment', () => {
    expect(spec('Grid 2').style).toMatchObject({ display: 'grid', gridTemplateColumns: '120px 1fr', gridTemplateRows: 'auto auto', rowGap: '8px', columnGap: '16px' });
    expect(spec('Wide').style).toEqual({ position: 'relative', justifySelf: 'stretch', height: '40px', gridColumn: '1 / span 2', gridRow: '1 / span 1', backgroundColor: '#ff0000' });
    expect(spec('Centered cell').style).toMatchObject({ width: '50px', height: '30px', justifySelf: 'center', alignSelf: 'end', gridColumn: '2 / span 1', gridRow: '2 / span 1' });
  });

  it('reads the sizing of older files', () => {
    expect(spec('Old hug').style).toMatchObject({ width: '200px', flexDirection: 'column' });
    expect(spec('Old hug').style!.height).toBeUndefined();
    expect(spec('Old child').style).toMatchObject({ alignSelf: 'center', width: '50px', height: '50px' });
  });

  describe('components', () => {
    const ids = new Map(out.mains.map((m) => [findName(all, m.id), m]));

    it('makes a main of every component, with set, variant values and text and boolean props', () => {
      expect([...ids.keys()]).toEqual(['Icon/Star', 'Icon/Heart', 'Size=Small', 'Size=Large']);
      expect(ids.get('Icon/Star')!.options).toEqual({ description: 'A star', props: [] });
      const small = ids.get('Size=Small')!;
      expect(small.options.set).toBe('Button');
      expect(small.options.variant).toEqual({ Size: 'Small' });
      const label = findSpec(spec('Size=Small').children!, 'Label');
      const icon = findSpec(spec('Size=Small').children!, 'Icon');
      expect(small.options.props).toEqual([
        { name: 'label', type: 'text', default: 'Button', targets: [{ path: label.fixedId, field: 'text' }] },
        { name: 'hasIcon', type: 'boolean', default: true, targets: [{ path: icon.fixedId, field: 'visible' }] },
      ]);
      expect(ids.get('Size=Large')!.options.variant).toEqual({ Size: 'Large' });
      expect(notes).toContain('instance swap properties, kept as each instance\'s own swap');
      expect(propName('Has icon#20:10')).toBe('hasIcon');
      expect(propName('3D depth#1:2')).toBe('p3DDepth');
    });

    it('links instances to their mains, with only what differs', () => {
      const large = spec('Size=Large');
      const heart = spec('Icon/Heart');
      const largeIcon = findSpec(large.children!, 'Icon');
      const largeLabel = findSpec(large.children!, 'Label');
      // A nested instance inside a main is an instance too.
      expect(largeIcon.instanceOf).toBe(spec('Icon/Star').fixedId);
      const buy = spec('Buy button');
      expect(buy.instanceOf).toBe(large.fixedId);
      expect(buy.children).toBeUndefined();
      expect(buy.artboard).toBeUndefined();
      expect(buy.style).toEqual({ position: 'absolute', left: '0px', top: '1200px', backgroundColor: '#00aa55' });
      expect(buy.props).toEqual({ label: 'Buy now', hasIcon: true });
      // The swapped icon, and the label's colour. The words come from the prop, not an override.
      expect(buy.overrides).toEqual({ [`${largeIcon.fixedId}#instanceOf`]: heart.fixedId, [`${largeLabel.fixedId}#style.color`]: '#ffee00' });
    });

    it('takes visibility from a boolean prop, and other hidden layers as overrides', () => {
      const small = spec('Size=Small');
      const plain = spec('Small plain');
      expect(plain.props).toEqual({ label: 'Button', hasIcon: false });
      expect(plain.overrides).toBeUndefined();
      const edited = spec('Edited');
      expect(edited.overrides).toEqual({ [`${findSpec(small.children!, 'Dot').fixedId}#hidden`]: true });
    });

    it('keeps an instance of a component from elsewhere as a plain frame, and says so', () => {
      const remote = spec('Remote');
      expect(remote.instanceOf).toBeUndefined();
      expect(remote.style).toMatchObject({ width: '100px', height: '40px', backgroundColor: '#ff0000' });
      expect(notes).toContain('instances of components not in the import, as plain frames');
      expect(out.instances).toBe(5);
    });

    it('can still convert everything as plain frames', () => {
      const flat = convert(true);
      expect(flat.mains).toEqual([]);
      expect(flat.instances).toBe(0);
      const buy = findSpec(flat.pages.flatMap((p) => p.specs), 'Buy button');
      expect(buy.instanceOf).toBeUndefined();
      expect(findSpec(buy.children!, 'Label').text).toBe('Buy now');
    });
  });
});

function findName(specs: NewNode[], id: string): string {
  for (const s of specs) {
    if (s.fixedId === id) return s.name!;
    const inner = s.children ? findName(s.children, id) : '';
    if (inner) return inner;
  }
  return '';
}

describe('Figma edge cases through the API stand-in, into a document', () => {
  let h: Harness;
  let api: Server;
  let requests: string[];
  let report: any;
  let doc: BogenDoc;
  const byName = (name: string): BogenNode => {
    let found: BogenNode | undefined;
    doc.nodes.forEach((m, id) => {
      if (!found && m.get('name') === name) found = doc.getNode(id);
    });
    expect(found, name).toBeDefined();
    return found!;
  };

  beforeAll(async () => {
    requests = [];
    const body = readFileSync(FIXTURE);
    api = createServer((req, res) => {
      const url = req.url ?? '';
      requests.push(url);
      const port = (api.address() as AddressInfo).port;
      if (url.startsWith('/download/')) return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(TILE);
      if (req.headers['x-figma-token'] !== TOKEN) return void res.writeHead(403).end('{}');
      if (url.startsWith('/v1/files/EDGEFIXTURE1/images')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: false, status: 200, meta: { images: { 'img-tile': `http://127.0.0.1:${port}/download/tile.png` } } }));
      if (url.startsWith('/v1/files/EDGEFIXTURE1')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
      // Figma answers null for a node it could not render.
      if (url.startsWith('/v1/images/EDGEFIXTURE1')) {
        const ids = decodeURIComponent(/ids=([^&]+)/.exec(url)![1]!).split(',');
        return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ err: null, images: Object.fromEntries(ids.map((id) => [id, null])) }));
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    h = await startServer({ figmaApiBase: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
    const res = await fetch(`${h.base}/api/import/figma`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.figma.com/design/EDGEFIXTURE1/Edges', token: TOKEN }) });
    expect(res.status).toBe(201);
    report = await res.json();
    doc = (await h.server.rooms.get(report.fileId)).doc;
  });

  afterAll(async () => {
    await h.cleanup();
    api.close();
  });

  it('asks for a boolean operation as one vector, and draws what Figma did not render from its paths', () => {
    const asked = requests.filter((u) => u.startsWith('/v1/images/')).flatMap((u) => decodeURIComponent(/ids=([^&]+)/.exec(u)![1]!).split(','));
    expect(asked).toEqual(expect.arrayContaining(['10:20', '10:21', '10:24']));
    expect(asked).not.toContain('10:22');
    expect(asked).not.toContain('10:23');
    expect(report.failed).toContain('vector 10:20: Figma did not render it');
    expect(byName('Bolt').type).toBe('svg');
    expect(report.vectors).toBe(0);
  });

  it('makes real components: a variant set, and instances that resolve with their props and overrides', () => {
    expect(report.components).toBe(4);
    expect(report.instances).toBe(5);
    expect(setMembers(doc.source, 'Button').map((m) => m.name)).toEqual(['Size=Small', 'Size=Large']);
    expect(variantAxes(doc.source, 'Button')).toEqual([{ axis: 'Size', values: ['Small', 'Large'] }]);
    const buy = byName('Buy button');
    expect(buy.instanceOf).toBe(byName('Size=Large').id);
    const [icon, label, dot] = doc.getChildren(buy.id);
    expect(label!.text).toBe('Buy now');
    expect(label!.style.color).toBe('#ffee00');
    expect(icon!.instanceOf).toBe(byName('Icon/Heart').id);
    expect(doc.getChildren(icon!.id)[0]!.svg).toContain('M12 21L2 11');
    expect(dot!.hidden).toBeFalsy();
    const plain = doc.getChildren(byName('Small plain').id);
    expect(plain[0]!.hidden).toBe(true);
    expect(plain[1]!.text).toBe('Button');
    expect(doc.getChildren(byName('Edited').id)[2]!.hidden).toBe(true);
    expect(byName('Remote').instanceOf).toBeUndefined();
  });

  it('keeps an instance plain when a frame link leaves its main out of the import', async () => {
    const res = await fetch(`${h.base}/api/import/figma`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.figma.com/design/EDGEFIXTURE1/Edges?node-id=10-80', token: TOKEN }) });
    const one = await res.json() as { fileId: string; components: number; instances: number; unsupported: { what: string }[] };
    expect([one.components, one.instances]).toEqual([0, 0]);
    expect(one.unsupported.map((u) => u.what)).toContain('instances of components not in the import, as plain frames');
    const narrowed = (await h.server.rooms.get(one.fileId)).doc;
    const [buy] = narrowed.getChildren(narrowed.getPages()[0]!.id);
    expect(buy!.instanceOf).toBeUndefined();
    expect(narrowed.getChildren(buy!.id).map((c) => c.text ?? c.name)).toEqual(['Icon', 'Buy now', 'Dot']);
  });

  it('stores the tile image and sizes the tile from its pixels', () => {
    expect(report.images).toBe(1);
    expect(byName('Tiled').style.backgroundSize).toBe('8px 4px');
    expect(byName('Cropped').attrs?.['data-crop']).toBe('0.25 0.1 0.5 0.5');
  });

  it('renders the linked components exactly as the same file converted as plain frames', async () => {
    const src = byName('Cropped').src!;
    const flat = convertFigmaPages(FILE, FILE.document!.children!, { images: new Map([['img-tile', src]]), vectors: new Map(), sizes: new Map([['img-tile', { width: 4, height: 2 }]]) }, { flat: true });
    const entry = h.server.createFile('Flat');
    const flatDoc = (await h.server.rooms.get(entry.id)).doc;
    placeFigma(flatDoc, flat);
    const compare = async (i: number) => {
      const a = await h.server.renderer.screenshot(doc, { pageId: doc.getPages()[i]!.id }, { format: 'png', scale: 1 });
      const b = await h.server.renderer.screenshot(flatDoc, { pageId: flatDoc.getPages()[i]!.id }, { format: 'png', scale: 1 });
      const diff = await h.server.renderer.compareImages({ bytes: a.bytes, mime: 'image/png' }, { bytes: b.bytes, mime: 'image/png' }, { threshold: 0.05, fit: false, maxDimension: 2000, maxBytes: 16 * 1024 * 1024 });
      return { different: diff.different, total: diff.total };
    };
    const edges = await compare(0);
    const library = await compare(1);
    // 1248000 and 80000 pixels, none of them different.
    expect(edges.total).toBeGreaterThan(1_000_000);
    expect(library.total).toBeGreaterThan(50_000);
    expect([edges.different, library.different]).toEqual([0, 0]);
    // The comparison does see a change as small as one label's colour.
    let label = '';
    flatDoc.nodes.forEach((m, id) => {
      if (m.get('name') === 'Label' && doc.getNode(id) === undefined && flatDoc.getNode(id)?.text === 'Buy now') label = id;
    });
    flatDoc.updateStyle(label, { color: '#000000' });
    expect((await compare(0)).different).toBeGreaterThan(20);
  }, 60_000);
});
