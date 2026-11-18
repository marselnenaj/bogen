/**
 * Built-in mockup scenes, drawn here as SVG rather than photographed, so they carry no licence of anyone else and
 * stay sharp at any size: a poster on a wall, a billboard, a tote bag, a badge on a lanyard, a hanging sign, a
 * packet, a cap, a phone and a laptop. Each has its surface as a mesh (a bent one for fabric), its own light as a
 * shade layer laid over the print with multiply, an optional sheen in screen, and what lies in front of the print.
 * Ids inside are scoped per layer (data-bogen-scope), so two scenes on one page never share a gradient.
 */

import type { Mesh, MockupBlend } from './mockup.ts';

export interface MockupScene {
  id: string;
  name: string;
  /** What it is for, and the shape of design it takes. */
  use: string;
  width: number;
  height: number;
  /** The design's shape the surface has, width / height. */
  aspect: number;
  mesh: Mesh;
  blend: MockupBlend;
  shading: number;
  svg: string;
  shade?: string;
  sheen?: string;
  front?: string;
}

const W = 1600;
const H = 1200;
const open = (w = W, h = H) => `<svg xmlns="http://www.w3.org/2000/svg" data-bogen-scope="layer" viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none">`;
const blur = (id: string, s: number) => `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${s}"/></filter>`;
/** Paper or cloth grain. On a shape (clip) it stays inside the shape; noise alone fills the filter's whole box. */
const grain = (id: string, freq = 0.9, alpha = 0.18, clip = false) => `<filter id="${id}"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ${alpha} 0"/>${clip ? '<feComposite operator="in" in2="SourceGraphic"/>' : ''}</filter>`;
const poly = (pts: [number, number][]) => pts.map((p) => p.join(',')).join(' ');

/** Evenly spaced points on a quadratic curve from a to b that sags by `bend` px at the middle (negative bulges up). */
function arc(a: [number, number], b: [number, number], bend: number, n: number): [number, number][] {
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + bend * 2];
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const u = 1 - t;
    return [Math.round((u * u * a[0] + 2 * u * t * mid[0] + t * t * b[0]) * 10) / 10, Math.round((u * u * a[1] + 2 * u * t * mid[1] + t * t * b[1]) * 10) / 10];
  });
}

const posterQuad: [number, number][] = [[560, 150], [1052, 170], [1046, 912], [566, 930]];
const poster: MockupScene = {
  id: 'poster-wall', name: 'Poster on a wall', use: 'A poster in 2:3, such as 50 x 70 or A2, pasted on a plaster wall in soft daylight.', width: W, height: H, aspect: 2 / 3,
  mesh: { top: [posterQuad[0]!, posterQuad[1]!], bottom: [posterQuad[3]!, posterQuad[2]!] }, blend: 'multiply', shading: 0.85,
  svg: `${open()}<defs><linearGradient id="w" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#e3ded6"/><stop offset="1" stop-color="#c8c0b5"/></linearGradient><radialGradient id="l" cx="0.25" cy="0.1" r="0.9"><stop offset="0" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>${blur('b', 14)}${grain('g', 0.6, 0.22)}</defs><rect width="${W}" height="${H}" fill="url(#w)"/><rect width="${W}" height="${H}" filter="url(#g)" opacity="0.6"/><rect width="${W}" height="${H}" fill="url(#l)"/><rect y="1040" width="${W}" height="160" fill="#9d958a"/><rect y="1040" width="${W}" height="10" fill="#857d72"/><polygon points="${poly(posterQuad.map(([x, y]) => [x + 16, y + 22]))}" fill="#3b342c" opacity="0.35" filter="url(#b)"/><polygon points="${poly(posterQuad)}" fill="#f4f1ea"/></svg>`,
  shade: `${open()}<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.55" stop-color="#f1eee9"/><stop offset="1" stop-color="#d9d3ca"/></linearGradient><linearGradient id="c" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.48" stop-color="#000" stop-opacity="0"/><stop offset="0.5" stop-color="#000" stop-opacity="0.07"/><stop offset="0.52" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>${grain('g', 1.2, 0.2)}</defs><rect width="${W}" height="${H}" fill="url(#s)"/><rect width="${W}" height="${H}" fill="url(#c)"/><rect width="${W}" height="${H}" filter="url(#g)"/></svg>`,
  sheen: `${open()}<defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="0.6"><stop offset="0.25" stop-color="#fff" stop-opacity="0"/><stop offset="0.4" stop-color="#fff" stop-opacity="0.16"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#h)"/></svg>`,
  front: `${open()}<g fill="#f3efe4" opacity="0.72"><rect x="530" y="130" width="70" height="26" transform="rotate(-38 565 143)"/><rect x="1018" y="152" width="70" height="26" transform="rotate(36 1053 165)"/><rect x="1012" y="896" width="70" height="26" transform="rotate(-40 1047 909)"/><rect x="534" y="916" width="70" height="26" transform="rotate(38 569 929)"/></g></svg>`,
};

const boardQuad: [number, number][] = [[300, 200], [1320, 268], [1312, 724], [308, 760]];
const billboard: MockupScene = {
  id: 'billboard', name: 'Billboard', use: 'A roadside billboard, about 3:1 like a 48-sheet, seen from the left under an open sky.', width: W, height: H, aspect: 2.2,
  mesh: { top: [boardQuad[0]!, boardQuad[1]!], bottom: [boardQuad[3]!, boardQuad[2]!] }, blend: 'multiply', shading: 0.7,
  svg: `${open()}<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb6dc"/><stop offset="0.7" stop-color="#dfe8ee"/><stop offset="1" stop-color="#eef0ea"/></linearGradient><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c7f68"/><stop offset="1" stop-color="#5d604c"/></linearGradient>${blur('b', 10)}</defs><rect width="${W}" height="${H}" fill="url(#sky)"/><path d="M0 900 L120 880 L160 850 L230 860 L260 820 L330 830 L380 870 L520 860 L560 810 L640 815 L700 860 L900 870 L960 835 L1040 840 L1100 880 L1300 870 L1360 830 L1440 838 L1500 880 L1600 870 L1600 960 L0 960Z" fill="#a9b3ba" opacity="0.7"/><rect y="940" width="${W}" height="260" fill="url(#gr)"/><rect x="700" y="740" width="34" height="260" fill="#3a3d42"/><rect x="1000" y="726" width="34" height="276" fill="#33363b"/><polygon points="700,990 734,990 760,1010 690,1010" fill="#000" opacity="0.25" filter="url(#b)"/><polygon points="${poly([[286, 186], [1334, 256], [1326, 738], [294, 776]])}" fill="#2c2f33"/><polygon points="${poly([[294, 776], [1326, 738], [1330, 760], [290, 800]])}" fill="#202226"/><path d="M290 812 L1330 772" stroke="#3d4045" stroke-width="8"/><path d="M290 828 L1330 788" stroke="#3d4045" stroke-width="3"/><g stroke="#3d4045" stroke-width="3">${[380, 600, 820, 1040, 1250].map((x) => `<line x1="${x}" y1="${812 - (x - 290) * 0.0385}" x2="${x}" y2="${830 - (x - 290) * 0.0385}"/>`).join('')}</g><g fill="#2c2f33">${[420, 760, 1100].map((x) => `<rect x="${x}" y="${166 + (x - 300) * 0.066 - 40}" width="10" height="44"/><rect x="${x - 26}" y="${166 + (x - 300) * 0.066 - 50}" width="62" height="16" rx="4"/>`).join('')}</g><polygon points="${poly(boardQuad)}" fill="#f2f0ea"/></svg>`,
  shade: `${open()}<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stop-color="#fff"/><stop offset="0.7" stop-color="#eeece6"/><stop offset="1" stop-color="#d4d1c9"/></linearGradient><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.12"/><stop offset="0.08" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#s)"/><rect width="${W}" height="${H}" fill="url(#t)"/><g stroke="#000" stroke-opacity="0.06" stroke-width="2">${[0.2, 0.4, 0.6, 0.8].map((f) => `<line x1="${300 + f * 1020}" y1="${200 + f * 68}" x2="${308 + f * 1004}" y2="${760 - f * 36}"/>`).join('')}</g></svg>`,
};

const toteTop = arc([560, 520], [1040, 520], 6, 8);
const toteBottom = arc([566, 900], [1034, 900], 14, 8);
const tote: MockupScene = {
  id: 'tote-bag', name: 'Tote bag', use: 'A natural canvas tote; the print sits on the front, about 5:4, and bends with the cloth.', width: W, height: H, aspect: 1.25,
  mesh: { top: toteTop, bottom: toteBottom }, blend: 'multiply', shading: 0.9,
  svg: `${open()}<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ece7df"/><stop offset="1" stop-color="#ddd6cb"/></linearGradient><linearGradient id="bag" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e2d8c3"/><stop offset="0.5" stop-color="#efe7d5"/><stop offset="1" stop-color="#d8ceb8"/></linearGradient>${blur('b', 22)}${grain('g', 1.4, 0.35, true)}</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><ellipse cx="800" cy="1110" rx="380" ry="34" fill="#5c5346" opacity="0.35" filter="url(#b)"/><path d="M640 400 C640 170 960 170 960 400" fill="none" stroke="#d6cbb4" stroke-width="34" stroke-linecap="round"/><path d="M640 400 C640 190 960 190 960 400" fill="none" stroke="#c4b89e" stroke-width="6" opacity="0.6"/><path d="M500 390 L1100 390 L1120 1060 Q800 1092 480 1060 Z" fill="url(#bag)"/><path d="M500 390 L1100 390 L1120 1060 Q800 1092 480 1060 Z" filter="url(#g)" opacity="0.8"/><path d="M500 430 L1100 430" stroke="#b9ad93" stroke-width="2" stroke-dasharray="10 8"/><path d="M700 386 L700 470 M900 386 L900 470" stroke="#cbbfa6" stroke-width="30"/></svg>`,
  shade: `${open()}<defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#cfc6b6"/><stop offset="0.18" stop-color="#f6f2ea"/><stop offset="0.34" stop-color="#ebe5da"/><stop offset="0.5" stop-color="#fbf8f2"/><stop offset="0.66" stop-color="#e6dfd2"/><stop offset="0.82" stop-color="#f5f1e8"/><stop offset="1" stop-color="#c9bfae"/></linearGradient><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#b8ad99" stop-opacity="0.6"/></linearGradient>${grain('g', 1.6, 0.5)}</defs><rect width="${W}" height="${H}" fill="url(#f)"/><rect width="${W}" height="${H}" fill="url(#v)"/><rect width="${W}" height="${H}" filter="url(#g)"/></svg>`,
};

const badgeQuad: [number, number][] = [[668, 470], [948, 452], [978, 900], [698, 918]];
const badge: MockupScene = {
  id: 'badge-lanyard', name: 'Badge on a lanyard', use: 'An event or staff badge on a lanyard, portrait about 5:8, slightly turned.', width: W, height: H, aspect: 5 / 8,
  mesh: { top: [badgeQuad[0]!, badgeQuad[1]!], bottom: [badgeQuad[3]!, badgeQuad[2]!] }, blend: 'multiply', shading: 0.6,
  svg: `${open()}<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e4e7ea"/><stop offset="1" stop-color="#c7ccd1"/></linearGradient>${blur('b', 18)}</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><path d="M640 0 L790 330 M980 0 L830 330" stroke="#2d3136" stroke-width="44"/><path d="M640 0 L790 330 M980 0 L830 330" stroke="#45494f" stroke-width="4" stroke-dasharray="2 10"/><polygon points="${poly(([[650, 400], [960, 380], [1000, 960], [690, 980]] as [number, number][]).map(([x, y]) => [x + 26, y + 30]))}" fill="#30363c" opacity="0.4" filter="url(#b)"/><path d="M660 408 Q660 392 676 391 L944 373 Q960 372 961 388 L996 944 Q997 960 981 961 L706 979 Q690 980 689 964 Z" fill="#f7f7f5"/><path d="M660 408 Q660 392 676 391 L944 373 Q960 372 961 388 L996 944 Q997 960 981 961 L706 979 Q690 980 689 964 Z" fill="none" stroke="#c9cdd0" stroke-width="2"/></svg>`,
  shade: `${open()}<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e2e4e6"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#s)"/></svg>`,
  sheen: `${open()}<defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.42" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#h)"/></svg>`,
  front: `${open()}<rect x="768" y="404" width="84" height="18" rx="9" transform="rotate(-3.6 810 413)" fill="#9aa1a8"/><rect x="772" y="407" width="76" height="12" rx="6" transform="rotate(-3.6 810 413)" fill="#d9dde0"/><path d="M780 318 L840 318 L846 366 L774 366 Z" fill="#8d949b"/><path d="M786 322 L834 322 L838 360 L782 360 Z" fill="#c3c8cd"/><rect x="796" y="356" width="28" height="56" rx="8" fill="none" stroke="#7b838a" stroke-width="8"/></svg>`,
};

const signQuad: [number, number][] = [[640, 430], [1150, 370], [1150, 810], [640, 790]];
const sign: MockupScene = {
  id: 'hanging-sign', name: 'Hanging sign', use: 'A blade sign hanging from a bracket over a shop door, landscape about 5:4, seen at an angle.', width: W, height: H, aspect: 1.25,
  mesh: { top: [signQuad[0]!, signQuad[1]!], bottom: [signQuad[3]!, signQuad[2]!] }, blend: 'multiply', shading: 0.75,
  svg: `${open()}<defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a99585"/><stop offset="1" stop-color="#c7b6a6"/></linearGradient><pattern id="brick" width="120" height="48" patternUnits="userSpaceOnUse"><rect width="120" height="48" fill="none"/><path d="M0 47.5 H120 M60 0 V24 M0 23.5 H120 M0 24 V48 M120 24 V48" stroke="#8d7b6c" stroke-width="2" opacity="0.5"/></pattern>${blur('b', 16)}</defs><rect width="${W}" height="${H}" fill="url(#wall)"/><rect width="${W}" height="${H}" fill="url(#brick)"/><rect x="1240" y="0" width="360" height="${H}" fill="#3a3632"/><rect x="1260" y="40" width="320" height="1160" fill="#5e6b70"/><rect x="1260" y="40" width="320" height="1160" fill="#a9c1c9" opacity="0.25"/><rect x="560" y="300" width="30" height="80" fill="#1f1f1f"/><path d="M575 330 L1180 268" stroke="#1f1f1f" stroke-width="16" stroke-linecap="round"/><path d="M600 350 Q760 300 1150 280" stroke="#1f1f1f" stroke-width="6" fill="none"/><polygon points="${poly(signQuad.map(([x, y]) => [x + 40, y + 60]))}" fill="#3a2e25" opacity="0.35" filter="url(#b)"/><polygon points="${poly([[1150, 370], [1172, 374], [1172, 812], [1150, 810]])}" fill="#2a2724"/><polygon points="${poly([[640, 790], [1150, 810], [1172, 812], [660, 794]])}" fill="#2f2b28"/><polygon points="${poly(signQuad)}" fill="#f1ece3"/></svg>`,
  shade: `${open()}<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="0.2"><stop offset="0" stop-color="#fdfcfa"/><stop offset="1" stop-color="#d8d2c8"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#s)"/></svg>`,
  front: `${open()}<g stroke="#1f1f1f" stroke-width="5" fill="none"><path d="M700 300 L700 428"/><path d="M1090 274 L1090 378"/></g><g fill="#1f1f1f"><circle cx="700" cy="430" r="7"/><circle cx="1090" cy="378" r="7"/></g></svg>`,
};

const packetQuad: [number, number][] = [[572, 300], [1030, 282], [1050, 1000], [552, 1012]];
const packet: MockupScene = {
  id: 'packet', name: 'Packet', use: 'A paper packet or pouch standing on a table, portrait about 2:3, with a crimped top.', width: W, height: H, aspect: 0.66,
  mesh: { top: [packetQuad[0]!, packetQuad[1]!], bottom: [packetQuad[3]!, packetQuad[2]!] }, blend: 'multiply', shading: 0.85,
  svg: `${open()}<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efebe4"/><stop offset="0.82" stop-color="#e2dcd2"/><stop offset="0.821" stop-color="#cfc6b9"/><stop offset="1" stop-color="#c2b9ab"/></linearGradient>${blur('b', 20)}</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><ellipse cx="820" cy="1022" rx="330" ry="26" fill="#4e463c" opacity="0.4" filter="url(#b)"/><polygon points="${poly([[1030, 282], [1090, 300], [1104, 990], [1050, 1000]])}" fill="#cfc5b4"/><polygon points="${poly(packetQuad)}" fill="#f3eee4"/></svg>`,
  shade: `${open()}<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e6e0d6"/><stop offset="0.12" stop-color="#fbf9f5"/><stop offset="0.5" stop-color="#f2eee7"/><stop offset="0.52" stop-color="#e3ddd2"/><stop offset="0.55" stop-color="#f6f3ed"/><stop offset="1" stop-color="#ddd6ca"/></linearGradient><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.08"/><stop offset="0.1" stop-color="#000" stop-opacity="0"/><stop offset="0.9" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.12"/></linearGradient>${grain('g', 1.1, 0.18)}</defs><rect width="${W}" height="${H}" fill="url(#s)"/><rect width="${W}" height="${H}" fill="url(#v)"/><rect width="${W}" height="${H}" filter="url(#g)"/></svg>`,
  front: `${open()}<path d="M560 250 L1040 232 L1044 312 L566 330 Z" fill="#e6dfd2"/><path d="${Array.from({ length: 41 }, (_, i) => `${i ? 'L' : 'M'}${566 + i * 11.95} ${330 - i * 0.45 + (i % 2 ? 8 : 0)}`).join(' ')}" stroke="#cfc6b7" stroke-width="3" fill="none"/><path d="${Array.from({ length: 40 }, (_, i) => `M${572 + i * 12} ${262 - i * 0.45} L${572 + i * 12} ${300 - i * 0.45}`).join(' ')}" stroke="#d3cabb" stroke-width="2"/></svg>`,
};

const capTop = arc([640, 470], [960, 470], -24, 8);
const capBottom = arc([630, 640], [970, 640], -6, 8);
const cap: MockupScene = {
  id: 'cap', name: 'Cap', use: 'A six-panel cap from the front; the print is a patch or embroidery on the front panels, about 2:1, curved with the crown.', width: W, height: H, aspect: 1.9,
  mesh: { top: capTop, bottom: capBottom }, blend: 'multiply', shading: 0.8,
  svg: `${open()}<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8e4dd"/><stop offset="1" stop-color="#d4cec4"/></linearGradient><radialGradient id="crown" cx="0.42" cy="0.3" r="0.8"><stop offset="0" stop-color="#f3f0ea"/><stop offset="0.6" stop-color="#e3ddd2"/><stop offset="1" stop-color="#c7bfb2"/></radialGradient><linearGradient id="brim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9d2c6"/><stop offset="1" stop-color="#b9b0a2"/></linearGradient>${blur('b', 24)}${grain('g', 1.8, 0.3, true)}</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><ellipse cx="800" cy="930" rx="420" ry="40" fill="#4a4238" opacity="0.35" filter="url(#b)"/><path d="M440 700 C440 360 600 250 800 250 C1000 250 1160 360 1160 700 Z" fill="url(#crown)"/><path d="M440 700 C440 360 600 250 800 250 C1000 250 1160 360 1160 700 Z" filter="url(#g)" opacity="0.6"/><path d="M800 252 C770 400 760 560 770 700 M800 252 C830 400 840 560 830 700" stroke="#b9b0a2" stroke-width="3" fill="none" opacity="0.7"/><circle cx="800" cy="256" r="16" fill="#d8d1c5"/><path d="M420 700 C520 690 1080 690 1180 700 C1160 820 980 880 800 880 C620 880 440 820 420 700 Z" fill="url(#brim)"/><path d="M450 712 C560 702 1040 702 1150 712" stroke="#a79e90" stroke-width="3" stroke-dasharray="9 7" fill="none"/></svg>`,
  shade: `${open()}<defs><radialGradient id="s" cx="0.42" cy="0.32" r="0.55"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d6cfc3"/></radialGradient>${grain('g', 2, 0.35)}</defs><rect width="${W}" height="${H}" fill="url(#s)"/><rect width="${W}" height="${H}" filter="url(#g)"/></svg>`,
};

const phoneQuad: [number, number][] = [[648, 214], [962, 214], [962, 894], [648, 894]];
const phone: MockupScene = {
  id: 'phone', name: 'Phone', use: 'A phone held upright; the screen takes a 9:19.5 app screen or story.', width: W, height: H, aspect: 314 / 680,
  mesh: { top: [phoneQuad[0]!, phoneQuad[1]!], bottom: [phoneQuad[3]!, phoneQuad[2]!] }, blend: 'normal', shading: 0.35,
  svg: `${open()}<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9e6e1"/><stop offset="1" stop-color="#cfcac2"/></linearGradient><linearGradient id="body" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a2b2f"/><stop offset="0.5" stop-color="#3a3b40"/><stop offset="1" stop-color="#25262a"/></linearGradient>${blur('b', 26)}</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><rect x="660" y="230" width="330" height="720" rx="58" fill="#2b2620" opacity="0.35" filter="url(#b)"/><rect x="628" y="194" width="354" height="720" rx="56" fill="url(#body)"/><rect x="634" y="200" width="342" height="708" rx="51" fill="#0c0c0e"/><rect x="${phoneQuad[0]![0]}" y="${phoneQuad[0]![1]}" width="314" height="680" rx="40" fill="#fff"/><rect x="986" y="330" width="6" height="90" rx="3" fill="#2d2e33"/></svg>`,
  shade: `${open()}<rect width="${W}" height="${H}" fill="#fff"/></svg>`,
  sheen: `${open()}<defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="1"><stop offset="0.36" stop-color="#fff" stop-opacity="0"/><stop offset="0.46" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.6" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#h)"/></svg>`,
  front: `${open()}<rect x="757" y="228" width="96" height="28" rx="14" fill="#0b0b0d"/><path d="M688 214 H922 Q962 214 962 254 V854 Q962 894 922 894 H688 Q648 894 648 854 V254 Q648 214 688 214 Z M630 196 V912 H980 V196 Z" fill="#0c0c0e" fill-rule="evenodd"/></svg>`,
};

const laptopQuad: [number, number][] = [[412, 176], [1188, 176], [1188, 660], [412, 660]];
const laptop: MockupScene = {
  id: 'laptop', name: 'Laptop', use: 'A laptop on a desk; the screen takes a 16:10 web page or slide.', width: W, height: H, aspect: 776 / 484,
  mesh: { top: [laptopQuad[0]!, laptopQuad[1]!], bottom: [laptopQuad[3]!, laptopQuad[2]!] }, blend: 'normal', shading: 0.3,
  svg: `${open()}<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e7e3dc"/><stop offset="0.78" stop-color="#dcd6cc"/><stop offset="0.781" stop-color="#cbc2b4"/><stop offset="1" stop-color="#bfb5a6"/></linearGradient><linearGradient id="base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d7d8db"/><stop offset="1" stop-color="#a9abb0"/></linearGradient>${blur('b', 22)}</defs><rect width="${W}" height="${H}" fill="url(#bg)"/><ellipse cx="800" cy="780" rx="560" ry="30" fill="#3f3830" opacity="0.4" filter="url(#b)"/><rect x="388" y="150" width="824" height="536" rx="24" fill="#1d1e21"/><rect x="${laptopQuad[0]![0]}" y="${laptopQuad[0]![1]}" width="776" height="484" fill="#fff"/><path d="M300 700 L1300 700 L1360 752 Q1362 768 1344 768 L256 768 Q238 768 240 752 Z" fill="url(#base)"/><path d="M700 700 L900 700 L892 716 L708 716 Z" fill="#9c9ea3"/></svg>`,
  shade: `${open()}<rect width="${W}" height="${H}" fill="#fff"/></svg>`,
  sheen: `${open()}<defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="0.7"><stop offset="0.5" stop-color="#fff" stop-opacity="0"/><stop offset="0.62" stop-color="#fff" stop-opacity="0.14"/><stop offset="0.8" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#h)"/></svg>`,
  front: `${open()}<circle cx="800" cy="164" r="4" fill="#3a3b40"/></svg>`,
};

export const MOCKUP_SCENES: readonly MockupScene[] = [poster, billboard, tote, badge, sign, packet, cap, phone, laptop];
