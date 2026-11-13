import { describe, expect, it } from 'vitest';
import { BogenDoc, importHtml, selectLayers, type NewNode } from '../src/index.ts';

function fixture() {
  const doc = new BogenDoc();
  doc.ensureFirstPage();
  const page = doc.getPages()[0]!.id;
  const board = doc.insert(page, { type: 'frame', tag: 'div', name: 'Board', style: {} } as NewNode);
  const { nodes } = importHtml('<section><h2>Plans</h2><button>Buy</button><button disabled>Soon</button><a href="/more">More</a></section><aside><h2>Help</h2><a href="/legal">Legal</a></aside>');
  const [section, aside] = doc.insertMany(board, nodes);
  return { doc, page, board, section: section!, aside: aside! };
}

describe('selectLayers', () => {
  it('matches tags, attributes, structure and pseudo-classes like a browser', () => {
    const { doc, board, section, aside } = fixture();
    const tags = (selector: string, roots?: string[]) => selectLayers(doc, selector, roots).map((id) => `${doc.getNode(id)!.tag}:${doc.getNode(id)!.text ?? ''}`);
    expect(tags('button')).toEqual(['button:Buy', 'button:Soon']);
    expect(tags('section > button:not([disabled])')).toEqual(['button:Buy']);
    expect(tags('a[href^="/l"]')).toEqual(['a:Legal']);
    expect(tags('h2 + button')).toEqual(['button:Buy']);
    expect(tags('section:has(h2) a')).toEqual(['a:More']);
    expect(tags('a', [aside])).toEqual(['a:Legal']);
    expect(selectLayers(doc, `#${section}`)).toEqual([section]);
    // Pages are roots and not elements: an artboard is a top-level match, and the roots themselves are not tested.
    expect(selectLayers(doc, 'div')).toEqual([board]);
    expect(selectLayers(doc, 'div', [board])).toEqual([]);
  });

  it('throws on a selector that does not parse', () => {
    const { doc } = fixture();
    expect(() => selectLayers(doc, 'button[')).toThrow();
  });
});
