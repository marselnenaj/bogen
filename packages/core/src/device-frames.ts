import type { BogenDoc, NewNode } from './doc.ts';

/**
 * Device frames: phones and tablets drawn to scale around a screen, from Tomacco's measured device profiles
 * (Apple's dimensional drawings for the iPhones: body, corner curve, island or notch, buttons; makers' specs for the
 * Android devices, whose bezels are approximate), and a browser window for web pages. Every frame is plain SVG and
 * HTML, so it exports like any other layer.
 *
 * A frame is used two ways: drawn around an artboard on the canvas (`meta.deviceFrames`, a view of the artboard
 * that changes nothing in it), or placed in a design as a layer, with an artboard live in its screen or an image.
 */

export interface DeviceButton { kind: string; edge: 'left' | 'right' | 'top' | 'bottom'; from: number; length: number }

export interface DeviceProfile {
  id: string;
  name: string;
  platform: 'ios' | 'android' | 'web';
  kind: 'phone' | 'tablet' | 'desktop';
  /** The display in points or dp, portrait. */
  width: number;
  height: number;
  /** The panel's pixels, short side first. */
  panel: [number, number];
  /** The display's corner radius in points. */
  radius: number;
  /** The border around the display, in points, for a profile without a measured body. */
  bezel: number;
  cutout: 'island' | 'notch' | 'punch' | 'none';
  cutoutWidth?: number;
  cutoutHeight?: number;
  cutoutOffset?: number;
  cutoutRadius?: number;
  cutoutShoulder?: number;
  ppi?: number;
  /** The body in millimetres: outline, corner radius and the black border inside the metal band. */
  body?: { width: number; height: number; radius: number; border?: number };
  buttons?: DeviceButton[];
  finishes: { name: string; color: string }[];
}

export const DEVICE_PROFILES: readonly DeviceProfile[] = [
  {id: 'iphone-18pro', name: 'iPhone 18 Pro', platform: 'ios', kind: 'phone', width: 402, height: 874, panel: [1206, 2622], radius: 62, bezel: 16, cutout: 'island', cutoutWidth: 94.5, cutoutHeight: 36.67, cutoutOffset: 14, ppi: 460, body: {width: 71.85, height: 150.01, radius: 12.71, border: 1.44}, buttons: [{kind: 'action', edge: 'left', from: 0.2055, length: 0.046}, {kind: 'volumeUp', edge: 'left', from: 0.2855, length: 0.0747}, {kind: 'volumeDown', edge: 'left', from: 0.3802, length: 0.0747}, {kind: 'side', edge: 'right', from: 0.3112, length: 0.118}, {kind: 'cameraControl', edge: 'right', from: 0.599, length: 0.114}], finishes: [{name: 'Black', color: '#3c3c3c'}, {name: 'Silver', color: '#f7f7f7'}, {name: 'Glacier', color: '#e8f2ff'}, {name: 'Burgundy', color: '#4d1821'}]},
  {id: 'iphone-18promax', name: 'iPhone 18 Pro Max', platform: 'ios', kind: 'phone', width: 440, height: 956, panel: [1320, 2868], radius: 62, bezel: 16, cutout: 'island', cutoutWidth: 94.67, cutoutHeight: 36.67, cutoutOffset: 14, ppi: 460, body: {width: 77.98, height: 163.43, radius: 12.71, border: 1.36}, buttons: [{kind: 'action', edge: 'left', from: 0.1886, length: 0.0422}, {kind: 'volumeUp', edge: 'left', from: 0.2621, length: 0.0685}, {kind: 'volumeDown', edge: 'left', from: 0.349, length: 0.0685}, {kind: 'side', edge: 'right', from: 0.2856, length: 0.1083}, {kind: 'cameraControl', edge: 'right', from: 0.6319, length: 0.1046}], finishes: [{name: 'Black', color: '#3c3c3c'}, {name: 'Silver', color: '#f7f7f7'}, {name: 'Glacier', color: '#e8f2ff'}, {name: 'Burgundy', color: '#4d1821'}]},
  {id: 'iphone-air', name: 'iPhone Air', platform: 'ios', kind: 'phone', width: 420, height: 912, panel: [1260, 2736], radius: 62, bezel: 16, cutout: 'island', cutoutWidth: 125.33, cutoutHeight: 36.67, cutoutOffset: 20, ppi: 460, body: {width: 74.7, height: 156.18, radius: 12.65, border: 1.44}, buttons: [{kind: 'action', edge: 'left', from: 0.1961, length: 0.0442}, {kind: 'volumeUp', edge: 'left', from: 0.273, length: 0.0717}, {kind: 'volumeDown', edge: 'left', from: 0.3639, length: 0.0717}, {kind: 'side', edge: 'right', from: 0.2973, length: 0.114}, {kind: 'cameraControl', edge: 'right', from: 0.6161, length: 0.1095}], finishes: [{name: 'Sky Blue', color: '#b7cbd7'}, {name: 'Light Gold', color: '#d5c9aa'}, {name: 'Cloud White', color: '#dfe0dd'}, {name: 'Space Black', color: '#323435'}]},
  {id: 'iphone-17', name: 'iPhone 17', platform: 'ios', kind: 'phone', width: 402, height: 874, panel: [1206, 2622], radius: 62, bezel: 15, cutout: 'island', cutoutWidth: 125.33, cutoutHeight: 36.67, cutoutOffset: 14, ppi: 460, body: {width: 71.45, height: 149.61, radius: 12.58, border: 1.44}, buttons: [{kind: 'action', edge: 'left', from: 0.2047, length: 0.0461}, {kind: 'volumeUp', edge: 'left', from: 0.285, length: 0.0749}, {kind: 'volumeDown', edge: 'left', from: 0.3799, length: 0.0749}, {kind: 'side', edge: 'right', from: 0.3106, length: 0.1183}, {kind: 'cameraControl', edge: 'right', from: 0.5993, length: 0.1143}], finishes: [{name: 'Lavender', color: '#dfceea'}, {name: 'Sage', color: '#a9b689'}, {name: 'Mist Blue', color: '#96aed1'}, {name: 'White', color: '#f5f5f5'}, {name: 'Black', color: '#353839'}]},
  {id: 'iphone-17e', name: 'iPhone 17e', platform: 'ios', kind: 'phone', width: 390, height: 844, panel: [1170, 2532], radius: 47.33, bezel: 21, cutout: 'notch', cutoutWidth: 161.33, cutoutHeight: 33.67, cutoutOffset: 0, cutoutRadius: 22.46, cutoutShoulder: 4.95, ppi: 460, body: {width: 71.52, height: 146.71, radius: 10.47, border: 2.42}, buttons: [{kind: 'action', edge: 'left', from: 0.1875, length: 0.0514}, {kind: 'volumeUp', edge: 'left', from: 0.2693, length: 0.0807}, {kind: 'volumeDown', edge: 'left', from: 0.3661, length: 0.0807}, {kind: 'side', edge: 'right', from: 0.2956, length: 0.125}], finishes: [{name: 'Soft Pink', color: '#fce7e6'}, {name: 'White', color: '#fafafa'}, {name: 'Black', color: '#3c4042'}]},
  {id: 'iphone-16', name: 'iPhone 16', platform: 'ios', kind: 'phone', width: 393, height: 852, panel: [1179, 2556], radius: 55, bezel: 20, cutout: 'island', cutoutWidth: 125, cutoutHeight: 36.67, cutoutOffset: 11.33, ppi: 460, body: {width: 71.63, height: 147.64, radius: 11.38, border: 2.27}, buttons: [{kind: 'action', edge: 'left', from: 0.2075, length: 0.0467}, {kind: 'volumeUp', edge: 'left', from: 0.2888, length: 0.0759}, {kind: 'volumeDown', edge: 'left', from: 0.385, length: 0.0759}, {kind: 'side', edge: 'right', from: 0.3149, length: 0.1199}, {kind: 'cameraControl', edge: 'right', from: 0.594, length: 0.1159}], finishes: [{name: 'Ultramarine', color: '#9aadf6'}, {name: 'Teal', color: '#b0d4d2'}, {name: 'Pink', color: '#f2adda'}, {name: 'White', color: '#fafafa'}, {name: 'Black', color: '#3c4042'}]},
  {id: 'pixel-11', name: 'Pixel 11', platform: 'android', kind: 'phone', width: 412, height: 924, panel: [1080, 2424], radius: 34, bezel: 8, cutout: 'punch', cutoutWidth: 13, cutoutHeight: 13, cutoutOffset: 11, finishes: [{name: 'Frost', color: '#d6e7ec'}, {name: 'Pistachio', color: '#c2d5bc'}, {name: 'Hibiscus', color: '#bc727c'}, {name: 'Obsidian', color: '#303333'}]},
  {id: 'pixel-11-pro', name: 'Pixel 11 Pro', platform: 'android', kind: 'phone', width: 412, height: 919, panel: [1280, 2856], radius: 34, bezel: 8, cutout: 'punch', cutoutWidth: 13, cutoutHeight: 13, cutoutOffset: 11, finishes: [{name: 'Canyon', color: '#a27561'}, {name: 'Olive', color: '#8c967b'}, {name: 'Fog', color: '#ced7dc'}, {name: 'Obsidian', color: '#303333'}]},
  {id: 'pixel-11-pro-xl', name: 'Pixel 11 Pro XL', platform: 'android', kind: 'phone', width: 448, height: 997, panel: [1344, 2992], radius: 34, bezel: 8, cutout: 'punch', cutoutWidth: 13, cutoutHeight: 13, cutoutOffset: 11, finishes: [{name: 'Canyon', color: '#a27561'}, {name: 'Olive', color: '#8c967b'}, {name: 'Fog', color: '#ced7dc'}, {name: 'Obsidian', color: '#303333'}]},
  {id: 'galaxy-s26', name: 'Galaxy S26', platform: 'android', kind: 'phone', width: 360, height: 780, panel: [1080, 2340], radius: 34, bezel: 8, cutout: 'punch', cutoutWidth: 13, cutoutHeight: 13, cutoutOffset: 11, finishes: [{name: 'Cobalt Violet', color: '#52516d'}, {name: 'Sky Blue', color: '#a5c4dd'}, {name: 'White', color: '#dededd'}, {name: 'Black', color: '#2e3034'}]},
  {id: 'galaxy-s26-ultra', name: 'Galaxy S26 Ultra', platform: 'android', kind: 'phone', width: 480, height: 1040, panel: [1440, 3120], radius: 27, bezel: 8, cutout: 'punch', cutoutWidth: 13, cutoutHeight: 13, cutoutOffset: 11, finishes: [{name: 'Cobalt Violet', color: '#52516d'}, {name: 'Sky Blue', color: '#a5c4dd'}, {name: 'White', color: '#dededd'}, {name: 'Black', color: '#2e3034'}]},
  {id: 'galaxy-z-flip8', name: 'Galaxy Z Flip8', platform: 'android', kind: 'phone', width: 360, height: 840, panel: [1080, 2520], radius: 34, bezel: 8, cutout: 'punch', cutoutWidth: 13, cutoutHeight: 13, cutoutOffset: 11, finishes: [{name: 'Pink', color: '#f2c9d0'}, {name: 'Graphite', color: '#3a3b3f'}, {name: 'Cream', color: '#ece6d8'}, {name: 'Mint', color: '#cfe8dc'}]},
  {id: 'galaxy-tab-s12-plus', name: 'Galaxy Tab S12+', platform: 'android', kind: 'tablet', width: 876, height: 1400, panel: [1752, 2800], radius: 20, bezel: 14, cutout: 'none', finishes: [{name: 'Gray', color: '#5c5f63'}, {name: 'Silver', color: '#d7d8da'}]},
  {id: 'galaxy-tab-s12-ultra', name: 'Galaxy Tab S12 Ultra', platform: 'android', kind: 'tablet', width: 924, height: 1480, panel: [1848, 2960], radius: 20, bezel: 12, cutout: 'none', finishes: [{name: 'Gray', color: '#5c5f63'}, {name: 'Silver', color: '#d7d8da'}]},
  { id: 'browser', name: 'Browser window', platform: 'web', kind: 'desktop', width: 1440, height: 900, panel: [900, 1440], radius: 0, bezel: 0, cutout: 'none', finishes: [{ name: 'Light', color: '#ececee' }, { name: 'Dark', color: '#2b2c30' }] },
];

export function deviceProfile(id: string): DeviceProfile | undefined {
  const key = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  return DEVICE_PROFILES.find((p) => key(p.id) === key(id) || key(p.name) === key(id));
}

/** The device a screen of this size is: one of exactly this size in either orientation, else the nearest in shape. */
export function deviceForSize(width: number, height: number): DeviceProfile {
  const w = Math.min(width, height);
  const h = Math.max(width, height);
  const devices = DEVICE_PROFILES.filter((p) => p.kind !== 'desktop');
  const exact = devices.find((p) => Math.abs(p.width - w) < 0.5 && Math.abs(p.height - h) < 0.5);
  if (exact) return exact;
  // A wide screen larger than a tablet is a web page.
  if (width > height && width >= 1024) return deviceProfile('browser')!;
  const tablet = w >= 600;
  const score = (p: DeviceProfile) => Math.abs(p.height / p.width - h / w) + Math.abs(p.width - w) / 400;
  return [...devices].filter((p) => (p.kind === 'tablet') === tablet).sort((a, b) => score(a) - score(b))[0]!;
}

interface Rect { x: number; y: number; w: number; h: number }

export interface DeviceGeometry {
  /** The whole drawing, with room around the body for the buttons. */
  width: number;
  height: number;
  body: Rect & { radius: number };
  /** The screen, in the drawing. */
  screen: Rect & { radius: number };
  /** Apple's continuous corners rather than circular arcs. */
  continuous: boolean;
  /** The metal band seen from the front, outside the display's black border. */
  rail: number;
  cutout: (Rect & { shape: 'island' | 'notch' | 'punch'; shoulder: number; lower: number }) | null;
  buttons: (Rect & { flush: boolean })[];
  /** For a browser window: the bar above the page. */
  bar: number;
}

const MARGIN = 4;
const BROWSER_BAR = 44;

/**
 * The frame's geometry around a screen of the given size (portrait), by default the device's own. A screen of another
 * size scales the body by its width and stretches it to its height, so the frame always fits the artboard.
 */
export function deviceGeometry(p: DeviceProfile, screen: { width: number; height: number } = p): DeviceGeometry {
  const sw = screen.width;
  const sh = screen.height;
  if (p.kind === 'desktop') {
    return { width: sw + 2, height: sh + BROWSER_BAR + 1, body: { x: 0, y: 0, w: sw + 2, h: sh + BROWSER_BAR + 1, radius: 12 }, screen: { x: 1, y: BROWSER_BAR, w: sw, h: sh, radius: 0 }, continuous: false, rail: 1, cutout: null, buttons: [], bar: BROWSER_BAR };
  }
  const s = sw / p.width;
  const ppm = p.ppi && p.body ? p.width / ((p.panel[0] / p.ppi) * 25.4) : 0;
  const measured = ppm > 0 && !!p.body;
  const bodyW = measured ? Math.max(p.width + 2, p.body!.width * ppm) : p.width + p.bezel * 2;
  const bodyH = measured ? Math.max(p.height + 2, p.body!.height * ppm) : p.height + p.bezel * 2;
  const side = ((bodyW - p.width) / 2) * s;
  const topBottom = ((bodyH - p.height) / 2) * s;
  const radius = p.radius * s;
  const bezel = Math.min(side, topBottom);
  const body = { x: MARGIN, y: MARGIN, w: sw + side * 2, h: sh + topBottom * 2, radius: measured ? p.body!.radius * ppm * s : radius + bezel };
  const scr = { x: MARGIN + side, y: MARGIN + topBottom, w: sw, h: sh, radius };
  const rail = measured && p.body!.border !== undefined ? Math.max(1, bezel - p.body!.border * ppm * s) : 2 * s;
  let cutout: DeviceGeometry['cutout'] = null;
  if (p.cutout !== 'none') {
    const punch = p.cutout === 'punch';
    const w = (p.cutoutWidth ?? (punch ? 13 : p.cutout === 'notch' ? 164 : 119)) * s;
    const h = (p.cutoutHeight ?? (punch ? 13 : p.cutout === 'notch' ? 34 : 35)) * s;
    const y = (p.cutoutOffset ?? (p.cutout === 'notch' ? 0 : 11)) * s;
    cutout = { shape: p.cutout, x: scr.x + (sw - w) / 2, y: scr.y + y, w, h, shoulder: (p.cutoutShoulder ?? Math.min(6, w / 10 / s)) * s, lower: Math.min(h, w / 2, (p.cutoutRadius ?? Math.min(p.cutoutHeight ?? 34, w / s / 6)) * s) };
  }
  // Buttons stand out of the band by 0.45 mm (Apple's drawings); a profile without them keeps a side button and rocker.
  const list = p.buttons ?? (p.kind === 'phone' ? [{ kind: 'side', edge: 'right', from: 0.22, length: 48 / bodyH }, { kind: 'volume', edge: 'right', from: 0.34, length: 76 / bodyH }] as DeviceButton[] : []);
  const unit = (measured ? 0.45 * ppm : 3) * s + 1;
  const buttons = list.map((b) => {
    const flush = b.kind === 'cameraControl';
    const depth = flush ? 1.5 * s : unit;
    const across = b.edge === 'top' || b.edge === 'bottom';
    // Fractions of the device's own body, so a taller artboard keeps them where they are on the device.
    const along = across ? body.w : bodyH * s;
    const start = b.from * along;
    const len = b.length * along;
    if (across) return { x: body.x + start, y: b.edge === 'top' ? body.y - (flush ? 0 : depth - 1) : body.y + body.h - (flush ? depth : 1), w: len, h: depth, flush };
    return { x: b.edge === 'left' ? body.x - (flush ? 0 : depth - 1) : body.x + body.w - (flush ? depth : 1), y: body.y + start, w: depth, h: len, flush };
  });
  return { width: body.w + MARGIN * 2, height: body.h + MARGIN * 2, body, screen: scr, continuous: p.platform === 'ios', rail, cutout, buttons, bar: 0 };
}

const f = (v: number) => Math.round(v * 1000) / 1000;

/** A rounded rectangle, with Apple's continuous corners (a smooth curve over 1.53 times the radius) when asked. */
export function roundedPath(x: number, y: number, w: number, h: number, radius: number, continuous: boolean): string {
  const span = continuous ? 1.52866483 : 1;
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2 / span));
  const k = [[1.52866483, 0], [1.08849296, 0], [0.86840694, 0], [0.63149399, 0.074911], [0.37282392, 0.16905899], [0.16905899, 0.37282392], [0.074911, 0.63149399], [0, 0.86840694], [0, 1.08849296], [0, 1.52866483]] as const;
  const corner = (cx: number, cy: number, ax: number, ay: number, bx: number, by: number) => {
    if (!(r > 0)) return `L ${f(cx)} ${f(cy)}`;
    if (!continuous) return `L ${f(cx + ax * r)} ${f(cy + ay * r)} A ${f(r)} ${f(r)} 0 0 1 ${f(cx + bx * r)} ${f(cy + by * r)}`;
    const p = (i: number) => `${f(cx + (ax * k[i]![0] + bx * k[i]![1]) * r)} ${f(cy + (ay * k[i]![0] + by * k[i]![1]) * r)}`;
    return `L ${p(0)} C ${p(1)} ${p(2)} ${p(3)} C ${p(4)} ${p(5)} ${p(6)} C ${p(7)} ${p(8)} ${p(9)}`;
  };
  return ['M', f(x + w / 2), f(y), corner(x + w, y, -1, 0, 0, 1), corner(x + w, y + h, 0, -1, -1, 0), corner(x, y + h, 1, 0, 0, -1), corner(x, y, 0, 1, 1, 0), 'Z'].join(' ');
}

function mix(hex: string, other: string, amount: number): string {
  const parse = (h: string) => { const v = h.replace('#', ''); const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v.slice(0, 6); return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) || 0); };
  const a = parse(hex);
  const b = parse(other);
  return `#${a.map((c, i) => Math.round(c + (b[i]! - c) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function luma(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export interface DeviceDrawOptions {
  /** A finish by index or a colour; the darkest by default. */
  finish?: number | string;
  /** Drawn on its side (a screen wider than tall), turned a quarter to the left. */
  turned?: boolean;
  /** For a browser window: the address shown in its bar. */
  address?: string;
}

/** The finish a frame has unless one is chosen: the darkest, which reads on light and dark grounds alike. */
export function defaultFinish(p: DeviceProfile): number {
  return p.finishes.reduce((best, f, i) => (luma(f.color) < luma(p.finishes[best]!.color) ? i : best), 0);
}

export function finishColor(p: DeviceProfile, finish: number | string | undefined): string {
  if (typeof finish === 'string' && /^#[0-9a-f]{6}$/i.test(finish)) return finish;
  const i = typeof finish === 'number' ? finish : defaultFinish(p);
  return (p.finishes[Math.max(0, Math.min(p.finishes.length - 1, i))] ?? p.finishes[0])?.color ?? '#3c3c3c';
}

/** Where the screen sits in the drawing as shown, turned or not. */
export function shownScreen(g: DeviceGeometry, turned = false): Rect {
  return turned ? { x: g.screen.y, y: g.width - g.screen.x - g.screen.w, w: g.screen.h, h: g.screen.w } : { x: g.screen.x, y: g.screen.y, w: g.screen.w, h: g.screen.h };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The frame as one SVG, sized by its container: the body with its band, glass and buttons, a hole where the screen is
 * (what lies under it shows through), and the island, notch or camera over the screen.
 */
export function deviceFrameSvg(p: DeviceProfile, g: DeviceGeometry, opts: DeviceDrawOptions = {}): string {
  const finish = finishColor(p, opts.finish);
  const vw = opts.turned ? g.height : g.width;
  const vh = opts.turned ? g.width : g.height;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" data-bogen-scope="layer" viewBox="0 0 ${f(vw)} ${f(vh)}" width="100%" height="100%" preserveAspectRatio="none">`;
  const turn = opts.turned ? `<g transform="translate(0 ${f(g.width)}) rotate(-90)">` : '<g>';
  const hole = roundedPath(g.screen.x, g.screen.y, g.screen.w, g.screen.h, g.screen.radius, g.continuous);
  if (p.kind === 'desktop') {
    const dark = luma(finish) < 0.4;
    const ink = dark ? '#c9cad0' : '#55565c';
    const field = dark ? '#3a3b40' : '#ffffff';
    const b = g.body;
    const top = `M ${f(b.x)} ${f(b.y + b.radius)} A ${b.radius} ${b.radius} 0 0 1 ${f(b.x + b.radius)} ${f(b.y)} L ${f(b.x + b.w - b.radius)} ${f(b.y)} A ${b.radius} ${b.radius} 0 0 1 ${f(b.x + b.w)} ${f(b.y + b.radius)} L ${f(b.x + b.w)} ${f(b.y + b.h)} L ${f(b.x)} ${f(b.y + b.h)} Z`;
    const cy = g.bar / 2;
    const urlW = Math.min(560, b.w * 0.42);
    const address = esc(opts.address ?? '');
    return `${open}${turn}<path d="${top} ${hole}" fill-rule="evenodd" fill="${finish}"/><path d="${top}" fill="none" stroke="${mix(finish, '#000000', 0.18)}" stroke-width="1"/><line x1="${f(b.x)}" y1="${f(g.bar - 0.5)}" x2="${f(b.x + b.w)}" y2="${f(g.bar - 0.5)}" stroke="${mix(finish, '#000000', 0.14)}"/>`
      + [['#ff5f57', 20], ['#febc2e', 40], ['#28c840', 60]].map(([c, x]) => `<circle cx="${x}" cy="${f(cy)}" r="6" fill="${c}"/>`).join('')
      + `<rect x="${f(b.x + (b.w - urlW) / 2)}" y="${f(cy - 14)}" width="${f(urlW)}" height="28" rx="8" fill="${field}"/>${address ? `<text x="${f(b.x + b.w / 2)}" y="${f(cy + 4.5)}" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13" fill="${ink}">${address}</text>` : ''}</g></svg>`;
  }
  const b = g.body;
  const outline = roundedPath(b.x, b.y, b.w, b.h, b.radius, g.continuous);
  const glass = roundedPath(b.x + g.rail, b.y + g.rail, b.w - g.rail * 2, b.h - g.rail * 2, Math.max(0, b.radius - g.rail), g.continuous);
  const light = mix(finish, '#ffffff', 0.3);
  const dark = mix(finish, '#000000', 0.12);
  const metal = `<linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="${f(b.x)}" y1="${f(b.y)}" x2="${f(b.x + b.w)}" y2="${f(b.y + b.h)}"><stop offset="0" stop-color="${light}"/><stop offset=".28" stop-color="${finish}"/><stop offset=".55" stop-color="${dark}"/><stop offset=".8" stop-color="${finish}"/><stop offset="1" stop-color="${mix(finish, '#ffffff', 0.2)}"/></linearGradient>`;
  const buttons = g.buttons.map((r) => `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="${f(Math.min(r.w, r.h) / 2)}" fill="${r.flush ? mix(finish, '#000000', 0.38) : finish}"${r.flush ? ` stroke="${mix(finish, '#ffffff', 0.4)}" stroke-width=".5"` : ''}/>`).join('');
  let cut = '';
  const c = g.cutout;
  if (c) {
    if (c.shape === 'notch') {
      const { x, y, w, h, shoulder: sh, lower: lo } = c;
      cut = `<path d="M ${f(x - sh)} ${f(y - 1)} L ${f(x + w + sh)} ${f(y - 1)} A ${f(sh)} ${f(sh)} 0 0 0 ${f(x + w)} ${f(y + sh - 1)} L ${f(x + w)} ${f(y + h - lo)} A ${f(lo)} ${f(lo)} 0 0 1 ${f(x + w - lo)} ${f(y + h)} L ${f(x + lo)} ${f(y + h)} A ${f(lo)} ${f(lo)} 0 0 1 ${f(x)} ${f(y + h - lo)} L ${f(x)} ${f(y + sh - 1)} A ${f(sh)} ${f(sh)} 0 0 0 ${f(x - sh)} ${f(y - 1)} Z" fill="#020205"/>`
        + `<circle cx="${f(x + w * 0.62)}" cy="${f(y + h * 0.46)}" r="${f(h * 0.17)}" fill="#0b1626"/>`;
    } else if (c.shape === 'punch') {
      cut = `<circle cx="${f(c.x + c.w / 2)}" cy="${f(c.y + c.h / 2)}" r="${f(c.w / 2)}" fill="#020205"/><circle cx="${f(c.x + c.w / 2)}" cy="${f(c.y + c.h / 2)}" r="${f(c.w * 0.22)}" fill="#0d1a2c"/>`;
    } else {
      cut = `<rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}" rx="${f(c.h / 2)}" fill="#020205"/><circle cx="${f(c.x + c.w - c.h / 2)}" cy="${f(c.y + c.h / 2)}" r="${f(c.h * 0.17)}" fill="#0b1626"/>`;
    }
  }
  return `${open}<defs>${metal}</defs>${turn}${buttons}<path d="${outline} ${hole}" fill-rule="evenodd" fill="url(#metal)"/><path d="${outline}" fill="none" stroke="${mix(finish, '#ffffff', 0.12)}" stroke-width=".75"/><path d="${glass} ${hole}" fill-rule="evenodd" fill="#050609"/><path d="${glass}" fill="none" stroke="#ffffff" stroke-opacity=".09" stroke-width=".75"/>${cut}</g></svg>`;
}

/** What a device layer remembers, so that it can be changed later (data-bogen-device). */
export interface DeviceLayerConfig {
  device: string;
  finish?: number;
  /** The main its screen shows, live. */
  source?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  /** Or an image in its screen. */
  image?: string;
  /** The layer's width in px; its height follows the device. */
  width: number;
  address?: string;
}

export const DEVICE_ATTR = 'data-bogen-device';

export function readDeviceConfig(raw: string | undefined): DeviceLayerConfig | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DeviceLayerConfig;
    return v && typeof v.device === 'string' && typeof v.width === 'number' ? v : null;
  } catch { return null; }
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

/** The device layer's size and children: the screen (an artboard live, an image or empty) under the drawn frame. */
export function deviceLayer(c: DeviceLayerConfig, ground?: string): { width: number; height: number; children: NewNode[] } {
  const p = deviceProfile(c.device) ?? DEVICE_PROFILES[0]!;
  const g = deviceGeometry(p);
  const s = c.width / g.width;
  const height = Math.round(g.height * s * 100) / 100;
  const scr = g.screen;
  const inner: NewNode[] = [];
  if (c.source && c.sourceWidth && c.sourceHeight) {
    // Fitted by width: an app screen is as wide as the device; a taller one scrolls past the bottom edge.
    const k = (scr.w * s) / c.sourceWidth;
    inner.push({ type: 'frame', instanceOf: c.source, name: 'Design', style: { position: 'absolute', left: '0px', top: '0px', width: px(c.sourceWidth), height: px(c.sourceHeight), margin: '0px', transformOrigin: '0 0', transform: `scale(${Math.round(k * 10000) / 10000})` } });
  } else if (c.image) {
    inner.push({ type: 'image', tag: 'img', name: 'Screenshot', src: c.image, style: { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', display: 'block' }, attrs: { alt: '' } });
  }
  const children: NewNode[] = [
    { type: 'frame', tag: 'div', name: 'Screen', style: { position: 'absolute', left: px(scr.x * s), top: px(scr.y * s), width: px(scr.w * s), height: px(scr.h * s), overflow: 'hidden', borderRadius: px(scr.radius * s), backgroundColor: ground ?? (p.kind === 'desktop' ? '#ffffff' : '#000000') }, children: inner },
    { type: 'svg', tag: 'svg', name: p.name, svg: deviceFrameSvg(p, g, { finish: c.finish, address: c.address }), style: { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%', pointerEvents: 'none' }, attrs: { 'aria-hidden': 'true' } },
  ];
  return { width: c.width, height, children };
}

/** Frames drawn around artboards on the canvas, by artboard id. */
export interface CanvasDeviceFrame { device: string; finish?: number }

export function canvasDeviceFrames(doc: BogenDoc): Record<string, CanvasDeviceFrame> {
  const v = doc.meta.get('deviceFrames');
  return v && typeof v === 'object' ? v as Record<string, CanvasDeviceFrame> : {};
}

/** Shows a frame around an artboard on the canvas, or none with null. */
export function setCanvasDeviceFrame(doc: BogenDoc, artboard: string, frame: CanvasDeviceFrame | null): void {
  const next = { ...canvasDeviceFrames(doc) };
  if (frame) next[artboard] = frame; else delete next[artboard];
  if (Object.keys(next).length) doc.meta.set('deviceFrames', next); else doc.meta.delete('deviceFrames');
}
