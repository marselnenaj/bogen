import { BogenDoc, bindingBrand, createMode, getTextStyles, markBrandDoc, readBrand, setTextStyle, setTokenMode, Y, type Token } from '@bogen/core';
import { describe, expect, it } from 'vitest';
import { brandDesignMd, designMdTokens, docDesignMd, importDesignMdBrand, importDesignMdTokens, parseDesignMd, writeDesignMdTokens } from '../src/design-md.ts';
import { readDesignMdTokens } from '../src/repo-tokens.ts';

const sorted = (tokens: Token[]) => [...tokens].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ ...t, ...(t.modes ? { modes: { ...t.modes } } : {}) }));

function sample(): BogenDoc {
  const doc = new BogenDoc(new Y.Doc());
  doc.transact(() => {
    doc.setToken('primary', 'color', '#1a1c1e');
    doc.setToken('surface', 'color', '#ffffff');
    doc.setToken('accent', 'color', 'oklch(0.62 0.19 35)');
    doc.setToken('link', 'color', 'var(--accent)');
    doc.setToken('radius-md', 'radius', '8px');
    doc.setToken('space-2', 'spacing', '8px');
    doc.setToken('space-4', 'spacing', '1rem');
    doc.setToken('font-body', 'font-family', '"Public Sans", sans-serif');
    doc.setToken('bp-md', 'breakpoint', '768px');
    doc.setToken('lh-body', 'line-height', '1.5');
    createMode(doc, 'dark');
    setTokenMode(doc, 'surface', 'dark', '#111111');
    setTokenMode(doc, 'primary', 'dark', '#f2f2f2');
    setTextStyle(doc, 'Heading 1', { fontFamily: 'var(--font-body)', fontSize: '48px', fontWeight: '600', lineHeight: '1.1', letterSpacing: '-0.02em' });
    setTextStyle(doc, 'Body', { fontFamily: '"Public Sans", sans-serif', fontSize: '16px', fontWeight: '400', lineHeight: '1.6' });
  });
  return doc;
}

describe('DESIGN.md', () => {
  it('exports a file\'s tokens and reads the same tokens back', () => {
    const doc = sample();
    const text = docDesignMd(doc, 'Daylight');
    expect(text.startsWith('---\nversion: alpha\nname: Daylight\n')).toBe(true);
    expect(text).toContain('colors:');
    expect(text).toContain('link: "{colors.accent}"');
    expect(text).toContain('typography:');
    expect(text).toContain('## Colors');
    const md = parseDesignMd(text);
    expect(md.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(sorted(designMdTokens(md).tokens)).toEqual(sorted(doc.getTokens()));

    const into = new BogenDoc(new Y.Doc());
    const done = importDesignMdTokens(into, md);
    expect(done.skipped).toEqual([]);
    expect(done.modes).toEqual(['dark']);
    expect(sorted(into.getTokens())).toEqual(sorted(doc.getTokens()));
    const styles = Object.fromEntries(getTextStyles(into).map((s) => [s.key, s.style]));
    expect(styles['heading-1']).toMatchObject({ fontSize: '48px', fontWeight: '600', lineHeight: '1.1', letterSpacing: '-0.02em' });
    expect(styles.body?.fontFamily).toBe('"Public Sans", sans-serif');
  });

  it('reads the format: front matter and fenced blocks merged, references, sections', () => {
    const md = parseDesignMd(`---
version: alpha
name: Daylight Prestige
description: Editorial design system with high-contrast neutrals.
---

## Overview

Quiet and exact.

## Colors

The palette is rooted in high-contrast neutrals.

\`\`\`yaml
colors:
  primary: "#1A1C1E"
  tertiary: "#B8422E"
  on-tertiary: "#ffffff"
\`\`\`

## Typography

\`\`\`yaml
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: 600
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-tertiary}"
    rounded: "{rounded.md}"
\`\`\`

## Do's and Don'ts

- Do use the primary color only for the single most important action
- Don't mix rounded and sharp corners in the same view
`);
    expect(md.name).toBe('Daylight Prestige');
    expect(md.colors.tertiary).toBe('#B8422E');
    expect(md.sections.map((s) => s.id)).toEqual(['overview', 'colors', 'typography', 'dos']);
    const broken = md.findings.find((f) => f.rule === 'broken-ref');
    expect(broken?.message).toContain('{rounded.md}');
    expect(md.findings.some((f) => f.rule === 'orphaned-tokens' && f.message.includes('primary'))).toBe(true);
    const { tokens } = designMdTokens(md);
    expect(tokens.find((t) => t.name === 'primary')).toMatchObject({ kind: 'color', value: '#1A1C1E' });
  });

  it('rejects what the format rejects and maps its lint onto brand_check', () => {
    const dup = parseDesignMd('---\ncolors:\n  primary: "#000"\n---\n\n## Colors\n\n```yaml\ncolors:\n  secondary: "#fff"\n```\n\n## Colors\n\nAgain.\n');
    expect(dup.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(['duplicate-key', 'duplicate-section']));
    const low = parseDesignMd('---\ncolors:\n  primary: "#777777"\n  paper: "#888888"\ncomponents:\n  chip:\n    backgroundColor: "{colors.paper}"\n    textColor: "{colors.primary}"\n---\n');
    const contrast = low.findings.find((f) => f.rule === 'contrast-ratio');
    expect(contrast?.brand_check).toBe('color.contrast');
    expect(low.findings.find((f) => f.rule === 'missing-typography')?.brand_check).toBe('type.off-brand-font');
    const typo = parseDesignMd('---\ncolours:\n  primary: "#000"\n---\n');
    expect(typo.findings.find((f) => f.rule === 'unknown-key')?.message).toContain('colors');
  });

  it('writes pushed tokens into a DESIGN.md that exists, keeping its prose and comments', () => {
    const before = '---\nname: Site\n# kept\ncolors:\n  primary: "#000000"\n---\n\n## Overview\n\nHand written.\n\n## Shapes\n\n```yaml\nrounded:\n  sm: 4px\n```\n';
    const after = writeDesignMdTokens(before, [
      { name: 'primary', kind: 'color', value: '#222222', modes: { dark: '#eeeeee' } },
      { name: 'sm', kind: 'radius', value: '6px' },
      { name: 'gap', kind: 'spacing', value: '12px' },
    ]);
    expect(after).toContain('Hand written.');
    expect(after).toContain('# kept');
    expect(after).toMatch(/```yaml\nrounded:\n {2}sm: 6px\n```/);
    const tokens = readDesignMdTokens(after, 'DESIGN.md');
    expect(tokens.find((t) => t.name === 'primary')).toMatchObject({ value: '#222222', modes: { dark: '#eeeeee' }, format: 'design-md' });
    expect(tokens.find((t) => t.name === 'gap')).toMatchObject({ kind: 'spacing', value: '12px' });
  });

  it('puts a DESIGN.md into a brand as suggestions only, and writes back what binds', () => {
    const brand = new BogenDoc(new Y.Doc());
    markBrandDoc(brand);
    const md = parseDesignMd(`---
name: Harbour
description: Calm banking for people who run small shops.
colors:
  primary: "#0b3d5c"
  surface: "#f7f5f2"
typography:
  headline-lg:
    fontFamily: Fraunces
    fontSize: 40px
    fontWeight: 600
  body-md:
    fontFamily: Inter
    fontSize: 16px
rounded:
  md: 8px
spacing:
  sm: 8px
components:
  button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
---

## Layout

A 12 column grid, 24px gutters.

## Do's and Don'ts

- Do keep one primary action per screen
- Don't use gradients
`);
    const out = brand.transact(() => importDesignMdBrand(brand, md, 'DESIGN.md', 'test', 'agent:test'));
    expect(out.added).toMatchObject({ colors: 2, families: 2, typeScale: 2, radius: 1, spacing: 1, rules: 2, pairings: 1 });
    expect(out.chapters).toEqual(['layout']);
    const data = readBrand(brand);
    expect([...data.colors, ...data.rules, ...data.families].every((i) => i.suggested)).toBe(true);
    expect(data.suggestedFields).toEqual(expect.arrayContaining(['positioning', 'name']));
    expect(bindingBrand(data).fields.positioning).toBe('');
    // Nothing was confirmed, so the brand's own DESIGN.md holds no tokens yet.
    expect(parseDesignMd(brandDesignMd('Harbour', data)).colors).toEqual({});
  });
});
