import type { BrandColor } from '@bogen/core';
import { BrandKit, h, t } from './kit.ts';
import { target } from './words.ts';

/** The header and footer of a page template: landmarks of their own, with links people can hit. */

export interface Paint { bg: string; fg: string; muted: string; line: string }

export function pageHeader(k: BrandKit, ground: BrandColor | null, p: Paint, mobile: boolean, links: string[], pad: string): string {
  const logo = k.logoFor(ground);
  const nav = links.map((label) => h('a', { ...k.font(k.type('small')), ...target({ padding: `${k.space(4)} 0` }), color: p.fg, textDecoration: 'none' }, t(label), { href: '#', 'data-name': 'Link' }));
  return h('header', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: mobile ? k.space(12) : k.space(24), padding: `${k.space(20)} ${pad}`, borderBottom: `1px solid ${p.line}` }, [
    h('a', { ...target(), textDecoration: 'none', color: p.fg }, [logo ? k.logo(logo, mobile ? 32 : 40) : h('span', { ...k.font(k.type('subheading', 32), 700), color: p.fg }, t(k.name), { 'data-name': 'Name' })], { href: '#', 'aria-label': `${k.name}, home`, 'data-name': 'Home link' }),
    nav.length ? h('nav', { display: 'flex', gap: mobile ? k.space(16) : k.space(32) }, nav, { 'aria-label': 'Main', 'data-name': 'Main navigation' }) : '',
  ], { 'data-name': 'Header' });
}

export function pageFooter(k: BrandKit, ground: BrandColor | null, p: Paint, mobile: boolean, pad: string, extra: string[] = []): string {
  const logo = k.logoFor(ground);
  return h('footer', { display: 'flex', flexDirection: mobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: mobile ? 'flex-start' : 'center', gap: k.space(24), padding: `${k.space(48)} ${pad}`, background: p.bg, borderTop: `1px solid ${p.line}` }, [
    logo ? k.logo(logo, 32) : h('p', { ...k.font(k.type('body'), 700), color: p.fg }, t(k.name), { 'data-name': 'Name' }),
    ...extra,
    h('p', { ...k.font(k.type('small')), color: p.muted }, t(`Copyright ${k.env.date.getFullYear()} ${k.name}`), { 'data-name': 'Small print' }),
  ], { 'data-name': 'Footer' });
}
