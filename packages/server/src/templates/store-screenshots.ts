import { luminance, type BrandColor } from '@bogen/core';
import { BrandKit, h, type TemplateEnv } from './kit.ts';
import type { BoardPlan, BoardStep, TemplateDef, TemplateOptions, TemplatePlan } from './types.ts';
import { brandLines, pick, Slots, slotText } from './words.ts';

/**
 * Store screenshots: a caption band in the brand over a phone drawn in CSS, at the sizes the stores ask for. iPhone
 * 6.9" is 1320 x 2868, an Android phone 1080 x 1920. The phone is plain shapes, a body, a screen and a camera, with no
 * maker's artwork, and the screen is an image slot for a real screenshot.
 */

interface Device {
  key: 'iphone' | 'android';
  label: string;
  width: number;
  height: number;
  /** The drawn phone's body width, its bezel, its corner, the screen's ratio, and the camera. */
  body: number;
  bezel: number;
  radius: number;
  screenRatio: number;
  camera: { width: number; height: number; top: number };
  band: number;
  headline: number;
}

const DEVICES: Device[] = [
  { key: 'iphone', label: 'iPhone 6.9 inch', width: 1320, height: 2868, body: 960, bezel: 24, radius: 140, screenRatio: 2868 / 1320, camera: { width: 250, height: 72, top: 40 }, band: 760, headline: 132 },
  { key: 'android', label: 'Android phone', width: 1080, height: 1920, body: 600, bezel: 14, radius: 72, screenRatio: 2400 / 1080, camera: { width: 30, height: 30, top: 26 }, band: 500, headline: 88 },
];
const SCREENS = 3;

function px(n: number): string {
  return `${Math.round(n)}px`;
}

/** The neutral that stands out most from the ground, for the phone's body. */
function bodyColor(k: BrandKit, ground: BrandColor | null): BrandColor | null {
  if (!ground) return k.colorFor('dark');
  return [...k.neutrals()].filter((c) => c.id !== ground.id).sort((a, b) => Math.abs(luminance(b.value) - luminance(ground.value)) - Math.abs(luminance(a.value) - luminance(ground.value)))[0] ?? k.colorFor('dark');
}

function phone(k: BrandKit, d: Device, ground: BrandColor | null, slots: Slots): string {
  const screenW = d.body - 2 * d.bezel;
  const screenH = screenW * d.screenRatio;
  const shell = bodyColor(k, ground);
  const dark = k.colorFor('dark');
  // The bezel is a border: the camera, placed from inside it, sits at its own distance from the screen's top.
  return h('div', { position: 'relative', flex: 'none', width: px(d.body), height: px(screenH + 2 * d.bezel), border: `${px(d.bezel)} solid ${k.c(shell)}`, background: k.c(shell), color: k.c(k.textOn(shell)), borderRadius: px(d.radius), boxSizing: 'border-box' }, [
    h('img', { display: 'block', width: px(screenW), height: px(screenH), objectFit: 'cover', borderRadius: px(d.radius - d.bezel) }, [], { alt: 'The app screen this caption describes', 'data-name': slots.add('Screen', 'A real screenshot of the app at this size: upload it with asset_upload and set it as the src.') }),
    h('div', { position: 'absolute', top: px(d.camera.top), left: '50%', width: px(d.camera.width), height: px(d.camera.height), marginLeft: px(-d.camera.width / 2), background: k.c(dark), borderRadius: px(d.camera.height / 2) }, [], { 'data-name': 'Camera' }),
  ], { 'data-name': `Phone / ${d.label}` });
}

function board(k: BrandKit, d: Device, n: number, slots: Slots, define: boolean): BoardPlan {
  const base = k.base();
  const p = k.paint(k.scheme(base));
  const accent = k.accent();
  const band = accent && k.textOn(accent, true) && k.textOn(accent) ? accent : k.alternate() ?? base;
  const b = k.paint(k.scheme(band));
  const pad = k.space(d.key === 'iphone' ? 96 : 64);
  const lines = brandLines(k);
  const headlines = ['Say what this screen does', 'The second thing it does well', 'The reason people keep it'];
  const headline = n === 1 ? pick(k, lines, 'h1', headlines[0]!) : headlines[n - 1]!;
  const component = `Phone / ${d.label}`;
  const steps: BoardStep[] = [];
  const html = h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '1 1 auto' }, [
    h('header', { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: k.space(24), alignSelf: 'stretch', height: px(d.band), padding: `0 ${pad}`, background: b.bg, boxSizing: 'border-box' }, [
      slotText(slots, 'h1', { ...k.font(k.sized(d.headline, 'display')), color: b.fg }, headline, 'Caption', 'What this screen lets people do, in a few words. One idea per screenshot.'),
      slotText(slots, 'p', { ...k.font(k.sized(d.key === 'iphone' ? 48 : 36)), color: b.fg }, 'One short line that backs it up.', 'Subline', 'A short line that backs the caption up, or leave it out.'),
    ], { 'data-name': 'Caption band' }),
    h('div', { display: 'flex', justifyContent: 'center', alignSelf: 'stretch', paddingTop: k.space(d.key === 'iphone' ? 64 : 40) }, define ? [phone(k, d, base, slots)] : [], { 'data-name': 'Device' }),
  ], { 'data-name': 'Screenshot' });
  if (define) steps.push({ component: { layer: component, name: component, description: `A ${d.label} drawn in CSS: body, screen and camera. Set the screen with its image prop.`, props: [{ name: 'screen', type: 'image', target: 'Screen' }] } });
  else steps.push({ into: 'Device', html: h('x-instance', {}, [], { component }) });
  slots.add('Screen', 'A real screenshot of the app at this size: upload it with asset_upload and set it as the src.');
  return { name: `${d.label} ${n}`, width: d.width, height: d.height, background: p.bg, color: p.fg, font: k.stack(k.family('body')), steps: [{ html }, ...steps] };
}

export const storeScreenshots: TemplateDef = {
  id: 'app-store-screenshots',
  name: 'App store screenshots',
  description: 'Store screenshots in the brand: three for iPhone 6.9" at 1320 x 2868 and three for an Android phone at 1080 x 1920, each a caption band over a phone drawn in CSS, with no maker\'s artwork. The phone is a component per size whose screen is an image slot for a real screenshot; captions are slots.',
  parts: DEVICES.map((d) => ({ key: d.key, name: `${d.label}, ${SCREENS} screens`, size: `${d.width} x ${d.height}` })),
  fileName: (brand) => `${brand} store screenshots`,
  build(env: TemplateEnv, options: TemplateOptions): TemplatePlan {
    const k = new BrandKit(env);
    const slots = new Slots();
    const boards = DEVICES.filter((d) => !options.only?.length || options.only.includes(d.key)).flatMap((d) => {
      const define = !env.components.has(`Phone / ${d.label}`);
      return Array.from({ length: SCREENS }, (_, i) => board(k, d, i + 1, slots, define && i === 0));
    });
    return { page: 'Store screenshots', boards, gaps: [], slots: slots.list };
  },
};
