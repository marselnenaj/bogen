import type { BrandColor } from '@bogen/core';
import { BrandKit, h, seenMin, t, type TemplateEnv } from './kit.ts';
import type { BoardPlan, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';

const FORMATS = [
  { key: 'og', name: 'Open Graph, 1200 x 630', width: 1200, height: 630 },
  { key: 'square', name: 'Square, 1080 x 1080', width: 1080, height: 1080 },
] as const;

/** One image: the logo, a line in the brand's own words, and its name, on one of its colours. */
function image(k: BrandKit, format: (typeof FORMATS)[number], ground: BrandColor | null, lead: 'name' | 'line'): BoardPlan {
  const s = k.scheme(ground);
  const p = k.paint(s);
  const pad = format.key === 'og' ? k.space(64) : k.space(88);
  const logo = k.logoFor(ground);
  const goods = k.data.voiceExamples.map((e) => e.good).filter(Boolean);
  const line = [...goods].sort((a, b) => a.length - b.length)[0];
  const positioning = k.data.fields.positioning;
  const big = lead === 'line' && line ? line : k.name;
  // The largest step that sets the line in three lines at most, at about half an em a character.
  const room = format.width - 2 * k.spacePx(format.key === 'og' ? 64 : 88);
  const fits = Math.floor((room * 3) / (Math.max(big.length, 6) * 0.56));
  const bigRole = k.type('hero', Math.min(format.key === 'og' ? 140 : 180, fits));
  const small = lead === 'line' && line ? k.name : positioning || '';
  // Seen in a feed at about 390px wide: the small line keeps to the size that still reads there.
  const min = seenMin(format.width, 'social');
  const lead$ = k.type('lead', 32);
  const smallRole = lead$.px >= min ? lead$ : k.sized(min, 'body', undefined, min);
  const html = h('div', { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flex: '1 1 auto', padding: pad, gap: k.space(40) }, [
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: k.space(24) }, [
      logo ? k.logo(logo, format.key === 'og' ? 72 : 96) : h('span', { ...k.font(k.sized(40, 'display', undefined, min)), color: p.fg }, t(k.name), { 'data-name': 'Name' }),
    ], { 'data-name': 'Top' }),
    h('div', { display: 'flex', flexDirection: 'column', gap: k.space(24) }, [
      h('h1', { ...k.font(bigRole), color: p.fg }, t(big), { 'data-name': 'Headline' }),
      small ? h('p', { ...k.font(smallRole), color: p.fg, maxWidth: format.key === 'og' ? '820px' : '760px' }, t(small), { 'data-name': 'Line' }) : '',
    ], { 'data-name': 'Words' }),
  ], { 'data-name': 'Layout' });
  return { name: format.name, width: format.width, height: format.height, background: p.bg, color: p.fg, font: k.stack(k.family('body')), steps: [{ html }] };
}

export const socialImages: TemplateDef = {
  id: 'social-images',
  name: 'Social images',
  description: 'Share images in the brand: an Open Graph image at 1200 x 630 with the name and positioning on the brand\'s main colour, and a 1080 x 1080 square with its own shortest line on its page colour. Each has the logo variant made for its ground. Fixed sizes, ready to export as PNG. Typographic share cards: for an ad or campaign image, start from a picture instead (design_knowledge social, recipe picture-ad).',
  parts: FORMATS.map((f) => ({ key: f.key, name: f.name, size: `${f.width} x ${f.height}` })),
  fileName: (brand) => `${brand} social images`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const accent = k.accent();
    const loud = accent && k.textOn(accent) && k.textOn(accent, true) ? accent : k.base();
    const gaps: string[] = [];
    if (!k.logos().length) gaps.push('No logo yet: add one with brand_asset_add, and the images carry it.');
    if (!env.data.fields.positioning) gaps.push('No positioning yet: add one line with brand_update (fields.positioning).');
    const boards = FORMATS.filter((f) => !options.only?.length || options.only.includes(f.key)).map((f) => (f.key === 'og' ? image(k, f, loud, 'name') : image(k, f, k.base(), 'line')));
    return { page: 'Social images', boards, gaps };
  },
};
