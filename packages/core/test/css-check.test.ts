import { describe, expect, it } from 'vitest';
import { cssDeclarationProblem, dropInvalidCss } from '../src/css-check.ts';
import { cssValueContains, normalizeCssValue } from '../src/css.ts';
import { importHtml } from '../src/index.ts';

describe('css values compared as CSS', () => {
  it('spells numbers, zero lengths, colours and spacing one way', () => {
    expect(normalizeCssValue('.55')).toBe('0.55');
    expect(normalizeCssValue('0.550')).toBe('0.55');
    expect(normalizeCssValue('-.5px')).toBe('-0.5px');
    expect(normalizeCssValue('0px 0 0rem 0%')).toBe('0 0 0 0');
    expect(normalizeCssValue('#ABC')).toBe('#aabbcc');
    expect(normalizeCssValue('#AABBCCFF')).toBe('#aabbcc');
    expect(normalizeCssValue('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(normalizeCssValue('rgba(0 0 0 / 50%)')).toBe('#00000080');
    expect(normalizeCssValue('0 4px 12px rgba(0, 0, 0, .1)')).toBe('0 4px 12px #0000001a');
    // Names with numbers in them stay as they are.
    expect(normalizeCssValue('var(--space-04)')).toBe('var(--space-04)');
    expect(normalizeCssValue('0s')).toBe('0s');
  });

  it('finds a value inside another, but not inside a longer number or colour', () => {
    expect(cssValueContains('.55', '0.55')).toBe(true);
    expect(cssValueContains('0.55', '.55')).toBe(true);
    expect(cssValueContains('0', '0px')).toBe(true);
    expect(cssValueContains('0px', '0')).toBe(true);
    expect(cssValueContains('#ABCDEF', '#abcdef')).toBe(true);
    expect(cssValueContains('#fff', 'rgb(255,255,255)')).toBe(true);
    expect(cssValueContains('1px solid #E5E5E5', '#e5e5e5')).toBe(true);
    expect(cssValueContains('16px', '16')).toBe(true);
    expect(cssValueContains('0.55', '0.5')).toBe(false);
    expect(cssValueContains('10px', '0')).toBe(false);
    expect(cssValueContains('#000000aa', '#000')).toBe(false);
  });
});

describe('css declarations a browser would drop', () => {
  it('knows properties, and the values of the common ones', () => {
    const ok: [string, string][] = [
      ['padding', '12px 24px'], ['margin', '0 auto'], ['width', 'calc(100% - 32px)'], ['width', '100%'], ['height', 'fit-content'],
      ['gap', 'var(--space-4)'], ['color', '#ABCDEF'], ['color', 'oklch(0.7 0.1 200)'], ['backgroundColor', 'color-mix(in srgb, red, blue)'],
      ['borderRadius', '8px / 4px'], ['fontWeight', '650'], ['fontWeight', 'bold'], ['display', 'inline flex'], ['opacity', '.5'], ['opacity', '50%'],
      ['justifyContent', 'space-between'], ['alignItems', 'safe center'], ['top', '-12px'], ['fontSize', 'clamp(1rem, 2vw, 2rem)'],
      ['WebkitTextStroke', '1px red'], ['MozOsxFontSmoothing', 'grayscale'], ['--anything', '{ weird }'], ['gridTemplateColumns', 'repeat(3, 1fr)'],
      ['containerType', 'inline-size'], ['textWrap', 'balance'], ['whiteSpace', 'pre-wrap'], ['lineHeight', '1.4'], ['padding', 'inherit'], ['backgroundColor', '{{color}}'],
    ];
    for (const [prop, value] of ok) expect([prop, value, cssDeclarationProblem(prop, value)]).toEqual([prop, value, null]);
    expect(cssDeclarationProblem('colr', 'red')).toBe('not a CSS property');
    expect(cssDeclarationProblem('padding', '12')).toBe('12 needs a unit, such as 12px');
    expect(cssDeclarationProblem('padding', '12px -4px')).toBe('-4px cannot be negative');
    expect(cssDeclarationProblem('width', '100 px')).toBe('100 needs a unit, such as 100px');
    expect(cssDeclarationProblem('gap', '8pz')).toBe('pz is not a unit of length');
    expect(cssDeclarationProblem('color', '#12345')).toBe('#12345 is not a colour');
    expect(cssDeclarationProblem('fontWeight', 'semibold')).toBe('semibold is not a font weight: use 100 to 900, normal or bold');
    expect(cssDeclarationProblem('display', 'flexbox')).toBe('flexbox is not a value of display');
    expect(cssDeclarationProblem('justifyContent', 'between')).toBe('between is not a value of justify-content');
    expect(cssDeclarationProblem('width', 'calc(100% - 4px')).toBe('an unclosed bracket or quote');
    expect(cssDeclarationProblem('padding', '1px 2px 3px 4px 5px')).toBe('too many values for padding');
  });

  it('takes them out of written layers and their blocks, and says where', () => {
    const { nodes } = importHtml('<style>.c:hover{colr:red;color:blue}</style><div class="c" style="padding:12;gap:8px"><p data-name="Body" style="font-weight:semibold">Hi</p></div>');
    const dropped = dropInvalidCss(nodes);
    expect(dropped).toEqual([
      'padding: 12 on <div> "Group: Hi" (12 needs a unit, such as 12px)',
      'colr: red on <div> "Group: Hi" :hover (not a CSS property)',
      'font-weight: semibold on <p> "Body" (semibold is not a font weight: use 100 to 900, normal or bold)',
    ]);
    expect(nodes[0]!.style).toEqual({ gap: '8px' });
    expect(nodes[0]!.rules).toEqual({ ':hover': { color: 'blue' } });
    expect(nodes[0]!.children![0]!.style).toEqual({});
  });
});
