import { describe, expect, it } from 'vitest';
import { googleFontsHrefs } from '../src/google-fonts.ts';

describe('Google Fonts stylesheets', () => {
  it('asks for the whole width range of a family that has one', () => {
    const hrefs = googleFontsHrefs('Archivo');
    expect(hrefs).toHaveLength(2);
    expect(hrefs[1]).toContain('css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900');
  });

  it('keeps one lenient sheet for other families', () => {
    expect(googleFontsHrefs('Libre Caslon Text')).toEqual(['https://fonts.googleapis.com/css?family=Libre+Caslon+Text:100,200,300,400,500,600,700,800,900,400i,700i&display=swap']);
  });
});
