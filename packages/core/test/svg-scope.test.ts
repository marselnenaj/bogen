import { describe, expect, it } from 'vitest';
import { renderSpec, sanitizeSvgMarkup, type BogenNode } from '../src/index.ts';

const artwork = '<svg data-bogen-scope="layer" viewBox="0 0 20 20" aria-labelledby="title"><title id="title">Art</title><defs><pattern id="ink"><path id="stroke" d="M0 0L20 20"/></pattern></defs><rect fill="url(#ink)"/><use href="#stroke"/><path style="stroke:url(\'#ink\')"/></svg>';
const layer = (id: string, svg = artwork) => ({ id, parent: 'page', order: 'a', type: 'svg', tag: 'svg', name: 'Art', style: {}, svg }) as BogenNode;

describe('paint definitions of opted-in SVG artwork', () => {
  it('keeps every component instance independent of a hidden original', () => {
    const original = renderSpec(layer('master')).html!;
    const instance = renderSpec(layer('instance:child')).html!;
    expect(original).toContain('id="bogen-master-ink"');
    expect(instance).toContain('id="bogen-instance_3a_child-ink"');
    expect(instance).toContain('fill="url(#bogen-instance_3a_child-ink)"');
    expect(instance).not.toContain('#bogen-master-ink');
    expect(renderSpec(layer('instance:child')).html).toBe(instance);
  });

  it('rewrites local links, quoted paint URLs and accessibility references together', () => {
    const out = renderSpec(layer('a')).html!;
    expect(out).toContain('href="#bogen-a-stroke"');
    expect(out).toContain('aria-labelledby="bogen-a-title"');
    expect(out).toContain('stroke:url(#bogen-a-ink)');
    expect(out).not.toContain('data-bogen-scope');
  });

  it('does not change unmarked SVG or unsized import sanitization', () => {
    const plain = artwork.replace(' data-bogen-scope="layer"', '');
    expect(renderSpec(layer('a', plain)).html).toBe(sanitizeSvgMarkup(plain));
    expect(sanitizeSvgMarkup(artwork)).toContain('id="ink"');
    expect(renderSpec(layer('a_b')).html).not.toBe(renderSpec(layer('a_5f_b')).html);
  });

  it('sanitizes marked artwork before rewriting references', () => {
    const out = renderSpec(layer('a', artwork.replace('</svg>', '<script>alert(1)</script><rect onclick="bad()"/></svg>'))).html!;
    expect(out).not.toMatch(/script|onclick/);
    expect(out).toContain('url(#bogen-a-ink)');
  });
});
