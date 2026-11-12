import { describe, expect, it } from 'vitest';
import {
  aspectRatioOf, BogenDoc, clampCrop, createComponent, createInstance, croppedHeight, cropStyle, cropToAspect, exportDocument, formatCrop, importHtml,
  nodeToHtml, parseCrop, parseImageFilters, renderSpec, toJsx, toReact, withImageFilters,
} from '../src/index.ts';

function fresh() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  return { doc, page: doc.getPages()[0]!.id };
}

const SRC = 'https://example.com/photo.jpg';

describe('image crop', () => {
  it('reads only crops that fit inside the image', () => {
    expect(parseCrop('0.25 0 0.5 1')).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    expect(parseCrop('0 0 1 1')).toBeUndefined();
    expect(parseCrop('0.6 0 0.5 1')).toBeUndefined();
    expect(parseCrop('a b c d')).toBeUndefined();
    expect(parseCrop('0 0 0 1')).toBeUndefined();
    expect(parseCrop(`0 0 0.5 ${'1'.repeat(100)}`)).toBeUndefined();
    expect(formatCrop({ x: 0.9, y: -1, w: 0.5, h: 2 })).toBe('0.5 0 0.5 1');
    expect(clampCrop({ x: 0.123456, y: 0, w: 0.5, h: 0.5 }).x).toBe(0.1235);
  });

  it('places the background so the crop fills the layer', () => {
    const style = cropStyle(SRC, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    expect(style.backgroundSize).toBe('200% 200%');
    // p = x / (1 - w): 0.25 / 0.5 and 0.5 / 0.5.
    expect(style.backgroundPosition).toBe('50% 100%');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(cropStyle('a"b\\c', { x: 0, y: 0, w: 0.5, h: 0.5 }).backgroundImage).toBe('url("abc")');
  });

  it('takes the largest centred crop of a preset shape, in pixels', () => {
    const natural = { width: 1200, height: 800 };
    const square = cropToAspect(undefined, aspectRatioOf('1:1', natural)!, natural);
    expect(square.h).toBe(1);
    expect(square.w * natural.width).toBeCloseTo(800, 0);
    expect(square.x + square.w / 2).toBeCloseTo(0.5, 3);
    const wide = cropToAspect(undefined, aspectRatioOf('16:9', natural)!, natural);
    expect((wide.w * natural.width) / (wide.h * natural.height)).toBeCloseTo(16 / 9, 2);
    expect(aspectRatioOf('free', natural)).toBeNull();
    expect(aspectRatioOf('original', natural)).toBeCloseTo(1.5);
    // The height that shows the crop undistorted at a width.
    expect(croppedHeight(400, square, natural)).toBe(400);
    expect(croppedHeight(300, undefined, natural)).toBe(200);
  });
});

describe('image filters', () => {
  it('reads the five adjustments in their units, and leaves others alone', () => {
    expect(parseImageFilters('brightness(1.1) contrast(90%) saturate(80%) blur(2px) grayscale(1) drop-shadow(0 0 2px rgb(0 0 0))')).toEqual({ brightness: 110, contrast: 90, saturate: 80, blur: 2, grayscale: 100 });
    expect(parseImageFilters('none')).toEqual({});
    expect(parseImageFilters(undefined)).toEqual({});
  });

  it('writes them after what it does not know, and drops neutral values', () => {
    expect(withImageFilters('drop-shadow(0 0 2px rgb(0 0 0)) brightness(120%)', { contrast: 90 })).toBe('drop-shadow(0 0 2px rgb(0 0 0)) brightness(120%) contrast(90%)');
    expect(withImageFilters('brightness(120%)', { brightness: 100 })).toBeNull();
    expect(withImageFilters('brightness(120%) hue-rotate(20deg)', { brightness: null })).toBe('hue-rotate(20deg)');
    expect(withImageFilters(undefined, { blur: 500, grayscale: -3 })).toBe('blur(50px)');
    expect(withImageFilters(undefined, { saturate: 0 })).toBe('saturate(0%)');
  });
});

describe('crop and filters survive export', () => {
  function cropped() {
    const t = fresh();
    const id = t.doc.insert(t.page, {
      type: 'image', name: 'Photo', src: SRC,
      attrs: { alt: 'A lake', 'data-crop': '0.25 0 0.5 1' },
      style: { width: '300px', height: '400px', objectFit: 'cover', filter: withImageFilters(undefined, { brightness: 110, grayscale: 50 })! },
    });
    return { ...t, id };
  }

  it('renders one element with the crop as CSS and the filter kept', () => {
    const { doc, id } = cropped();
    const spec = renderSpec(doc.getNode(id)!);
    expect(spec.tag).toBe('span');
    expect(spec.attrs).toMatchObject({ role: 'img', 'aria-label': 'A lake' });
    expect(spec.attrs['data-crop']).toBeUndefined();
    expect(spec.style).toMatchObject({ backgroundSize: '200% 100%', backgroundPosition: '50% 0%', filter: 'brightness(110%) grayscale(50%)', width: '300px', height: '400px' });
    expect(spec.style.objectFit).toBeUndefined();
  });

  it('in HTML', () => {
    const { doc, id } = cropped();
    const html = nodeToHtml(doc, id);
    expect(html).toContain('background-size:200% 100%');
    expect(html).toContain('background-position:50% 0%');
    expect(html).toContain(`url(&quot;${SRC}&quot;)`);
    expect(html).toContain('filter:brightness(110%) grayscale(50%)');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('data-crop');
    const page = exportDocument(doc, [id]);
    expect(page).toContain('background-size:200% 100%');
  });

  it('in JSX and in React with components', () => {
    const { doc, id, page } = cropped();
    for (const mode of ['inline', 'tailwind'] as const) {
      const jsx = toJsx(doc, id, mode);
      expect(jsx).toMatch(/backgroundSize: "200% 100%"|bg-\[length:200%_100%\]/);
      expect(jsx).toMatch(/filter: "brightness\(110%\) grayscale\(50%\)"|brightness-\[110%\]|filter/);
      expect(jsx).toContain('role="img"');
      expect(jsx).not.toContain('data-crop');
    }
    const inline = toJsx(doc, id, 'inline');
    expect(inline).toContain('backgroundPosition: "50% 0%"');
    expect(inline).toContain('filter: "brightness(110%) grayscale(50%)"');
    // In a component, the main is written once and its instance uses it.
    const card = doc.insert(page, { type: 'frame', name: 'Card', style: { display: 'flex', width: '320px' } });
    doc.move([id], card);
    createComponent(doc, card);
    const board = doc.insert(page, { type: 'frame', name: 'Board', artboard: true, style: { width: '800px' } });
    createInstance(doc, card, board);
    const react = toReact(doc, board, 'inline');
    expect(react).toContain('backgroundSize: "200% 100%"');
    expect(react).toContain('filter: "brightness(110%) grayscale(50%)"');
    expect(react).not.toContain('data-crop');
  });

  it('keeps the crop through an HTML write, as an agent would set it', () => {
    const { nodes } = importHtml(`<img src="${SRC}" data-crop="0 0.1 1 0.5" style="width:200px;height:50px;filter:contrast(120%)">`);
    expect(nodes[0]!.attrs?.['data-crop']).toBe('0 0.1 1 0.5');
    const t = fresh();
    const [id] = t.doc.insertMany(t.page, nodes);
    expect(nodeToHtml(t.doc, id!)).toContain('background-size:100% 200%');
  });
});
