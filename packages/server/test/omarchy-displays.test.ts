// Desktop displays of an Omarchy theme, portrait monitors above all: reading hyprctl, the previews laid out for each
// size, a portrait wallpaper composed for its shape rather than the landscape one cropped, adding displays to a theme
// that exists, assigning artwork, and what the export ships. Offline: hyprctl is a stand-in, and the one export test
// stands in for the renderer, so it checks files and diagnostics, not pixels (the browser QA renders those).

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aspectOf, CANONICAL, displayProblem, newThemeDisplays, parseMonitors, PORTRAIT_FALLBACK, resolveRequests, sameShape, wallpaperSize,
} from '../src/omarchy-displays.ts';
import { META_KEY } from '../src/omarchy-theme.ts';
import { exportTheme, imageSize, themeEnv, themeInfo } from '../src/omarchy-themes.ts';
import { BOARD_NAMES, portraitWallpaper, themeBoards, wallpaper } from '../src/templates/omarchy-theme.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** A real PNG header and body of one colour; only the header matters to the checks here. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 128)]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

// The owner's kind of desk, as `hyprctl monitors -j` prints it: a 4K landscape and a 4K turned 270°, both at scale 1.
const DESK = JSON.stringify([
  { name: 'DP-3', width: 3840, height: 2160, transform: 0, scale: 1, disabled: false, mirrorOf: 'none' },
  { name: 'DP-5', width: 3840, height: 2160, transform: 3, scale: 1, disabled: false, mirrorOf: 'none' },
]);

describe('monitors from hyprctl', () => {
  it('turns every rotation the way it is mounted, mirrored or not, and divides by the scale', () => {
    const rows = parseMonitors(JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7].map((transform) => ({ name: `T${transform}`, width: 3840, height: 2160, transform, scale: 2 }))));
    expect(rows.map((r) => [r.name, r.logical.width, r.logical.height, r.rotation, r.flipped, r.orientation])).toEqual([
      ['T0', 1920, 1080, 0, false, 'landscape'], ['T1', 1080, 1920, 90, false, 'portrait'],
      ['T2', 1920, 1080, 180, false, 'landscape'], ['T3', 1080, 1920, 270, false, 'portrait'],
      ['T4', 1920, 1080, 0, true, 'landscape'], ['T5', 1080, 1920, 90, true, 'portrait'],
      ['T6', 1920, 1080, 180, true, 'landscape'], ['T7', 1080, 1920, 270, true, 'portrait'],
    ]);
    // Wallpapers are drawn at device pixels, turned: 2160 x 3840 for the turned 4K at any scale.
    expect(rows[3]!.pixels).toEqual({ width: 2160, height: 3840 });
  });

  it('reads the desk of a landscape 4K and a 4K turned 270°', () => {
    const [a, b] = parseMonitors(DESK);
    expect(a).toMatchObject({ name: 'DP-3', logical: { width: 3840, height: 2160 }, orientation: 'landscape', usable: true });
    expect(b).toMatchObject({ name: 'DP-5', logical: { width: 2160, height: 3840 }, pixels: { width: 2160, height: 3840 }, rotation: 270, orientation: 'portrait', usable: true });
    expect(newThemeDisplays(parseMonitors(DESK))).toEqual([{ width: 2160, height: 3840, source: 'detected', monitor: 'DP-5' }]);
  });

  it('keeps fractional scales and leaves out what is not a desktop of its own', () => {
    const rows = parseMonitors(JSON.stringify([
      { name: 'eDP-1', width: 2560, height: 1600, transform: 0, scale: 1.6 },
      { name: 'HDMI-A-1', width: 1920, height: 1080, transform: 1, scale: 1.25 },
      { name: 'off', width: 1920, height: 1080, disabled: true },
      { name: 'mirror', width: 1920, height: 1080, mirrorOf: 'eDP-1' },
      { name: 'bad-transform', width: 1920, height: 1080, transform: 8 },
      { name: 'bad-scale', width: 1920, height: 1080, scale: 0 },
      { name: 'huge', width: 99999, height: 1080 },
      { name: 'fraction', width: 1920.5, height: 1080 },
    ]));
    expect(rows.map((r) => [r.name, r.logical])).toEqual([['eDP-1', { width: 1600, height: 1000 }], ['HDMI-A-1', { width: 864, height: 1536 }]]);
    expect(parseMonitors('not json')).toEqual([]);
    expect(parseMonitors('{"width":1}')).toEqual([]);
    expect(parseMonitors(JSON.stringify(Array.from({ length: 40 }, () => ({ width: 1920, height: 1080 })))).length).toBe(16);
  });

  it('states its size bounds as what Bogen supports, never as a guess that a narrow screen is a phone', () => {
    const small = parseMonitors(JSON.stringify([{ name: 'tiny', width: 320, height: 180, transform: 1 }]))[0]!;
    expect(small.usable).toBe(false);
    for (const text of [small.reason!, displayProblem({ width: 400, height: 900 })!, displayProblem({ width: 9000, height: 9000 })!, displayProblem({ width: 600, height: 3000 })!]) {
      expect(text).toMatch(/Bogen supports/);
      expect(text).not.toMatch(/phone|mobile/i);
    }
    // Without a usable portrait monitor, as on a laptop or a Mac, a new theme still gets a portrait display.
    expect(newThemeDisplays([small])).toEqual([{ width: 1080, height: 1920, source: 'preset' }]);
    expect(newThemeDisplays([])).toEqual([{ width: PORTRAIT_FALLBACK.width, height: PORTRAIT_FALLBACK.height, source: 'preset' }]);
  });

  it('resolves requests once each, skips sizes the theme has, and keeps to its limits', () => {
    const detected = parseMonitors(DESK);
    const out = resolveRequests([{ preset: 'portrait-1080x1920' }, { width: 1080, height: 1920 }, { monitor: 'DP-5' }, { width: 1920, height: 1080 }], [CANONICAL], detected);
    expect(out.add.map((a) => [a.size, a.source])).toEqual([[{ width: 1080, height: 1920 }, 'preset'], [{ width: 2160, height: 3840 }, 'detected']]);
    expect(out.skipped.map((s) => s.reason)).toEqual(['The theme has previews at this size already.', 'The theme\'s own previews are already 1920 × 1080.']);
    expect(() => resolveRequests([{ preset: 'komodo' }], [], detected)).toThrow(/no preset/);
    expect(() => resolveRequests([{ monitor: 'DP-9' }], [], detected)).toThrow(/no monitor/);
    expect(() => resolveRequests([{ width: 420, height: 935 }], [], detected)).toThrow(/Bogen supports/);
    expect(() => resolveRequests(Array.from({ length: 5 }, (_, i) => ({ width: 1000 + i, height: 1800 })), [], detected)).toThrow(/at most 4/);
  });

  it('names shapes and sizes compositions for them', () => {
    expect([aspectOf({ width: 1080, height: 1920 }), aspectOf({ width: 2160, height: 3840 }), aspectOf({ width: 1200, height: 1920 }), aspectOf({ width: 864, height: 1536 })]).toEqual(['9:16', '9:16', '10:16', '9:16']);
    expect(sameShape({ width: 1080, height: 1920 }, { width: 2160, height: 3840 })).toBe(true);
    expect(sameShape({ width: 3840, height: 2160 }, { width: 2160, height: 3840 })).toBe(false);
    expect(wallpaperSize({ width: 1080, height: 1920 })).toEqual({ width: 2160, height: 3840 });
    expect(wallpaperSize({ width: 1080, height: 1920 }, [{ width: 2160, height: 3840 }])).toEqual({ width: 2160, height: 3840 });
  });

  it('reads the size of a GIF, and gives none for a picture it cannot read', () => {
    const gif = Buffer.from('474946383961' + '3804' + '800700' + '00', 'hex');
    expect(imageSize(gif)).toEqual({ width: 1080, height: 1920 });
    expect(imageSize(Buffer.from('0000001c6674797061766966', 'hex'))).toBeNull();
  });
});

describe('the template for portrait displays', () => {
  const portrait = { width: 1080, height: 1920 };
  const shape = { shape: portrait, size: { width: 2160, height: 3840 } };

  it('lays the portrait desktop out for its size: the editor across the width, two terminals under it', () => {
    const boards = themeBoards({ name: 'Dusk', screens: [{ width: 3840, height: 2160 }], displays: [portrait], wallpapers: [shape] });
    const desktop = boards.find((b) => b.name === 'Preview · desktop · portrait 1080 × 1920')!;
    expect(desktop).toMatchObject({ kind: 'desktop', width: 1080, height: 1920, display: 'portrait 1080 × 1920' });
    expect(desktop.html).toMatch(/flex-direction:column" data-name="Windows"|flex-direction:column;?[^>]*data-name="Windows"/);
    expect(desktop.html).toContain('data-name="Lower row"');
    expect(desktop.html.indexOf('data-name="Editor"')).toBeLessThan(desktop.html.indexOf('data-name="Terminal, focused"'));
    // The landscape preview keeps its layout and its 1920 x 1080 size.
    const own = boards.find((b) => b.name === 'Preview · desktop')!;
    expect(own).toMatchObject({ width: 1920, height: 1080 });
    expect(own.html).toContain('data-name="Left column"');
    for (const b of boards.filter((x) => BOARD_NAMES.display.test(x.name))) expect([b.width, b.height]).toEqual([1080, 1920]);
  });

  it('binds the portrait previews to the portrait composition, and the landscape ones to the Wallpaper', () => {
    const boards = themeBoards({ name: 'Dusk', screens: [{ width: 3840, height: 2160 }], displays: [portrait], wallpapers: [shape] });
    const comp = boards.find((b) => b.kind === 'display-background')!;
    expect(comp).toMatchObject({ name: 'Portrait background · 9:16 · 2160 × 3840', width: 2160, height: 3840, components: ['Wallpaper · portrait 9:16'] });
    expect(comp.html).not.toContain('x-instance');
    // A quiet placeholder for the tall shape until someone designs it: never the landscape design, never palette arcs.
    expect(comp.html).toBe(portraitWallpaper('Wallpaper · portrait 9:16', '9:16'));
    expect(comp.html).not.toContain('Arc ');
    expect(comp.html).not.toBe(wallpaper().replace('data-name="Wallpaper"', 'data-name="Wallpaper · portrait 9:16"'));
    for (const b of boards.filter((x) => BOARD_NAMES.display.test(x.name) && x.kind !== 'boot')) {
      expect(b.html, b.name).toContain('component="Wallpaper · portrait 9:16"');
      expect(b.html, b.name).not.toContain('component="Wallpaper"');
    }
    for (const b of boards.filter((x) => /^Preview · (desktop|launcher|lock screen)$/.test(x.name))) expect(b.html).toContain('component="Wallpaper"');
    // Backgrounds Omarchy cycles through stay landscape; the portrait screen does not get a cropped copy there.
    expect(boards.filter((b) => b.kind === 'background').map((b) => [b.width, b.height])).toEqual([[3840, 2160]]);
    const mains = boards.flatMap((b) => b.components);
    expect(mains.indexOf('Wallpaper · portrait 9:16')).toBeLessThan(boards.findIndex((b) => b.name === 'Preview · desktop · portrait 1080 × 1920') + mains.length);
  });

  it('keeps the boot logo at its own size as Plymouth does, centred on the portrait screen', () => {
    const boot = (display: { width: number; height: number }, unlock?: { width: number; height: number }) => themeBoards({
      name: 'Dusk', screens: [{ width: 3840, height: 2160 }], displays: [display], wallpapers: [{ shape: display, size: wallpaperSize(display) }],
      ...(unlock ? { unlock: { ...unlock, src: 'bogen-asset:x.png', name: 'unlock.png' } } : {}),
    }).find((b) => b.kind === 'boot' && b.display)!.html;
    // 1920 / 2 - 188 / 2 + 188 + 40, and the entry centred on 1080.
    expect(boot(portrait)).toContain('left:397px;top:1094px;width:286px;height:48px');
    expect(boot(portrait)).toContain('left:140px;top:866px;width:800px;height:188px');
    // Narrower than the logo: drawn at its own size, running off both edges, as at boot. Not scaled to fit.
    expect(boot({ width: 720, height: 1280 })).toContain('left:-40px;top:546px;width:800px;height:188px');
    // The 1920 x 1080 boot preview is unchanged.
    expect(themeBoards({ name: 'Dusk', screens: [{ width: 3840, height: 2160 }] }).find((b) => b.name === 'Preview · boot unlock')!.html).toContain('left:817px;top:674px;width:286px;height:48px');
  });

  it('puts a theme\'s first landscape picture on Background 1 even when a portrait one comes first, and gives the portrait its own', () => {
    const tall = { src: 'bogen-asset:aaaaaaaaaaaaaaaa.png', width: 1080, height: 1920, name: '1-tall.png' };
    const wide = { src: 'bogen-asset:bbbbbbbbbbbbbbbb.png', width: 3840, height: 2160, name: '2-wide.png' };
    const boards = themeBoards({ name: 'Dusk', screens: [{ width: 3840, height: 2160 }], backgrounds: [tall, wide], displays: [portrait], wallpapers: [{ shape: portrait, size: { width: 2160, height: 3840 }, image: tall }] });
    const bgs = boards.filter((b) => b.kind === 'background');
    expect(bgs.map((b) => [b.name, b.width, b.height])).toEqual([['Background 1 · 2-wide.png', 3840, 2160], ['Background 2 · 1-tall.png', 2160, 3840]]);
    expect(bgs[0]!.components).toEqual(['Wallpaper']);
    expect(bgs[0]!.html).toContain(wide.src);
    const comp = boards.find((b) => b.kind === 'display-background')!;
    expect(comp.html).toContain(tall.src);
    expect(comp.html).not.toContain(wide.src);
  });
});

// ---------------------------------------------------------------- the server, with a temp HOME and a stand-in hyprctl

const STOCK = `mode = "dark"\naccent = "#89b4fa"\nbackground = "#1e1e2e"\nforeground = "#cdd6f4"\n`;

describe('displays of a theme file', () => {
  let h: Harness;
  let root: string;
  const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, PATH: process.env.PATH };
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${h.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const nodesOf = async (fileId: string) => {
    const { doc } = await h.server.rooms.get(fileId);
    return doc.getPages().flatMap((p) => doc.getChildren(p.id)).flatMap((b) => [b, ...doc.descendants(b.id)]).filter((n) => !n.virtual);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-displays-'));
    const home = join(root, 'home');
    const omarchyPath = join(root, 'omarchy');
    const bin = join(root, 'bin');
    // A stock theme with only landscape pictures, and another with no pictures.
    mkdirSync(join(omarchyPath, 'themes', 'wide', 'backgrounds'), { recursive: true });
    writeFileSync(join(omarchyPath, 'themes', 'wide', 'colors.toml'), STOCK);
    writeFileSync(join(omarchyPath, 'themes', 'wide', 'backgrounds', '1-wide.png'), png(64, 36));
    mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
    mkdirSync(join(home, '.config', 'omarchy', 'themes'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '${DESK}'\n`);
    writeFileSync(join(bin, 'fc-list'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'hyprctl'), 0o755);
    chmodSync(join(bin, 'fc-list'), 0o755);
    process.env.HOME = home;
    process.env.OMARCHY_PATH = omarchyPath;
    process.env.PATH = `${bin}:${saved.PATH}`;
    h = await startServer();
  });

  afterAll(async () => {
    await h?.cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('gives a new theme the turned monitor\'s previews and a quiet portrait placeholder that is not counted as designed', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Desk' });
    expect(made.status).toBe(201);
    const names = made.body.boards.map((b: any) => b.name);
    expect(names).toContain('Portrait background · 9:16 · 2160 × 3840');
    expect(names).toContain('Preview · desktop · portrait 2160 × 3840');
    expect(names.filter((n: string) => n.startsWith('Background '))).toEqual(['Background 1 · 3840 × 2160']);
    const info = (await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme;
    expect(info.displays.map((d: any) => d.label)).toEqual(['Landscape 1920 × 1080 (preview.png)', 'Portrait 2160 × 3840 (DP-5)']);
    expect(info.wallpapers).toMatchObject([{ aspect: '9:16', orientation: 'portrait', status: 'needs-design' }]);
    expect(info.wallpapers[0].reason).toMatch(/placeholder/);
    expect(info.problems.join(' ')).toMatch(/needs its own design/);
    expect(info.notes[0]).toMatch(/one background on every screen/);
    expect(info.portrait).toMatchObject({ enabled: false });

    // Recolouring the placeholder is not a design; a layer of the theme's own is.
    const { doc } = await h.server.rooms.get(made.body.file_id);
    const comp = made.body.boards.find((b: any) => b.name.startsWith('Portrait background'));
    const note = doc.descendants(comp.id).find((n) => n.name === 'Not designed yet')!;
    doc.transact(() => doc.updateStyle(note.id, { color: 'var(--omarchy-accent)' }), 'agent:claude');
    expect((await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme.wallpapers[0].status).toBe('needs-design');
    const main = doc.descendants(comp.id).find((n) => n.name === 'Wallpaper · portrait 9:16') ?? doc.getNode(comp.id)!;
    doc.transact(() => doc.insert(main.id, { type: 'frame', tag: 'div', name: 'Desk wordmark', style: { position: 'absolute', top: '30%', left: '10%', width: '80%', height: '10%', background: 'var(--omarchy-accent)' } }), 'agent:claude');
    expect((await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme.wallpapers[0]).toMatchObject({ status: 'composed', reason: expect.stringMatching(/1 layer of its own/) });
  });

  it('marks the portrait of a theme of landscape pictures as needing its own design, and keeps the picture as it was', async () => {
    const made = await api('/api/omarchy/themes', { from: 'wide', name: 'Wide Desk' });
    const info = (await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme;
    expect(info.backgrounds).toMatchObject([{ name: 'Background 1 · 1-wide.png', kept: true }]);
    expect(info.wallpapers).toMatchObject([{ aspect: '9:16', status: 'needs-design' }]);
    expect(info.problems.join(' ')).toMatch(/portrait 9:16 background needs its own design/);
    // The composition is not the landscape picture: no image in it at all.
    const { doc } = await h.server.rooms.get(made.body.file_id);
    const board = made.body.boards.find((b: any) => b.name.startsWith('Portrait background'));
    expect(doc.descendants(board.id).some((n) => n.type === 'image')).toBe(false);
  });

  it('adds displays to a theme from before them without touching what is there, once, and refuses what it cannot add', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Legacy' });
    const id = made.body.file_id;
    const room = await h.server.rooms.get(id);
    const { doc } = room;
    // Make it a file from before displays: no portrait boards, no display meta, and an edit of the person's own.
    doc.transact(() => {
      for (const b of made.body.boards) if (/portrait/i.test(b.name)) doc.delete([b.id]);
      const meta = { ...(doc.meta.get(META_KEY) as Record<string, unknown>) };
      delete meta.displays;
      delete meta.wallpapers;
      doc.meta.set(META_KEY, meta);
      doc.setToken('omarchy-accent', 'color', '#ff8800');
    }, 'person:editor');
    const terminal = doc.descendants(made.body.boards.find((b: any) => b.name === 'Preview · desktop').id).find((n) => n.name === 'Terminal, focused')!;
    doc.transact(() => doc.updateFields(terminal.id, { name: 'My terminal' }), 'person:editor');
    const before = new Map((await nodesOf(id)).map((n) => [n.id, JSON.stringify(n)]));
    const tokens = JSON.stringify(doc.getTokens());

    const added = await api(`/api/omarchy/theme/${id}/displays`, { add: [{ preset: 'portrait-1080x1920' }, { monitor: 'DP-5' }] });
    expect(added.status).toBe(200);
    expect(added.body.added.map((a: any) => [a.width, a.height])).toEqual([[1080, 1920], [2160, 3840]]);
    expect(added.body.wallpapers).toMatchObject([{ component: 'Wallpaper · portrait 9:16', status: 'needs-design' }]);
    // Every layer that was there is there as it was; the tokens too; no new page.
    const after = new Map((await nodesOf(id)).map((n) => [n.id, JSON.stringify(n)]));
    for (const [nodeId, json] of before) expect(after.get(nodeId), nodeId).toBe(json);
    expect(JSON.stringify(doc.getTokens())).toBe(tokens);
    expect(doc.getPages().length).toBe(1);
    // Below the design, and the second display shares the first one's 9:16 composition.
    const top = Math.max(...[...before.keys()].map((k) => doc.getNode(k)).filter((n) => n?.artboard).map((n) => Number.parseFloat(n!.style.top!) + Number.parseFloat(n!.style.height!)));
    for (const a of added.body.added) for (const b of a.boards) expect(Number.parseFloat(doc.getNode(b.id)!.style.top!)).toBeGreaterThan(top);
    expect(added.body.theme.wallpapers.length).toBe(1);
    expect(added.body.theme.wallpapers[0].status).toBe('needs-design');

    // Again: nothing added, each skipped with why.
    const count = after.size;
    const again = await api(`/api/omarchy/theme/${id}/displays`, { add: [{ preset: 'portrait-1080x1920' }, { width: 1920, height: 1080 }] });
    expect(again.body.added).toEqual([]);
    expect(again.body.skipped.length).toBe(2);
    expect((await nodesOf(id)).length).toBe(count);
    expect((await api(`/api/omarchy/theme/${id}/displays`, { add: [{ width: 420, height: 935 }] })).status).toBe(400);
    expect((await nodesOf(id)).length).toBe(count);
  });

  it('refuses displays on a mobile theme', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Phone', target: 'mobile' });
    const out = await api(`/api/omarchy/theme/${made.body.file_id}/displays`, { add: [{ preset: 'portrait-1080x1920' }] });
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/mobile theme/);
  });

  it('takes portrait artwork only of the composition\'s shape, and says so every time a picture of another shape is put in by hand', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Art' });
    const id = made.body.file_id;
    const wide = (await h.server.storage.putAsset(png(384, 216), 'image/png')).src;
    const tall = (await h.server.storage.putAsset(png(216, 384), 'image/png')).src;
    const count = (await nodesOf(id)).length;
    const refused = await api(`/api/omarchy/theme/${id}/displays/artwork`, { aspect: '9:16', src: wide });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/384 × 216 \(16:9\).*9:16.*Nothing was changed/);
    expect((await nodesOf(id)).length).toBe(count);
    const avif = await api(`/api/omarchy/theme/${id}/displays/artwork`, { aspect: '9:16', src: 'bogen-asset:0123456789abcdef.avif' });
    expect(avif.status).toBe(400);
    expect((await nodesOf(id)).length).toBe(count);

    // What the composition held before the artwork: today Bogen's quiet placeholder (its note and hint), in older
    // files the palette arcs. Whatever it is, every layer of it must survive, hidden, not deleted.
    const { doc } = await h.server.rooms.get(id);
    const board = made.body.boards.find((b: any) => b.name.startsWith('Portrait background'));
    const main = doc.getChildren(board.id)[0]!;
    const before = doc.getChildren(main.id).map((n) => ({ id: n.id, name: n.name, hidden: Boolean(n.hidden) }));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((n) => !n.hidden)).toBe(true);

    const ok = await api(`/api/omarchy/theme/${id}/displays/artwork`, { aspect: '9:16', src: tall, name: 'tall.png' });
    expect(ok.status).toBe(200);
    expect(ok.body.wallpaper).toMatchObject({ status: 'artwork', image: { src: tall, width: 216, height: 384 } });
    expect(doc.getChildren(ok.body.wallpaper.board.id)[0]!.id).toBe(main.id);
    // Each earlier layer is still there, the same layer by id and name, now hidden; the one new layer is the artwork.
    const after = doc.getChildren(main.id);
    for (const prior of before) expect(after.find((n) => n.id === prior.id), prior.name).toMatchObject({ name: prior.name, hidden: true });
    expect(after.filter((n) => !before.some((p) => p.id === n.id)).map((n) => [n.type, n.src, Boolean(n.hidden)])).toEqual([['image', tall, false]]);

    // A landscape picture put into the composition by any other tool is caught, and stays caught.
    const img = doc.getChildren(main.id).find((n) => n.type === 'image')!;
    doc.transact(() => doc.updateFields(img.id, { src: wide }), 'agent:claude');
    for (let i = 0; i < 2; i++) {
      const info = (await api(`/api/omarchy/theme/${id}`)).body.theme;
      expect(info.wallpapers[0]).toMatchObject({ status: 'mismatch' });
      expect(info.wallpapers[0].reason).toMatch(/384 × 216 \(16:9\), not 9:16.*leaves it out/);
      expect(info.problems.join(' ')).toMatch(/needs its own design \(picture of another shape, cropped\)/);
    }
  });

  it('is an MCP tool: list, add as one undoable agent step, and assign', async () => {
    const agent = await connectAgent(h.base, 'claude');
    const made = await call(agent, 'omarchy_theme_create', { name: 'Agent Desk' });
    const listed = await call(agent, 'omarchy_theme_displays', { file_id: made.file_id });
    expect(listed.monitors.map((m: any) => [m.name, m.width, m.height, m.present])).toEqual([['DP-3', 3840, 2160, false], ['DP-5', 2160, 3840, true]]);
    expect(listed.wallpapers[0]).toMatchObject({ aspect: '9:16', status: 'needs-design' });
    expect(listed.runtime).toMatch(/Stock Omarchy shows one background on every screen/);
    expect(listed.done_means).toMatch(/never report a theme's portrait as done/);
    expect(listed.runtime_status.screens.find((s: any) => s.name === 'DP-5')).toMatchObject({ shows: 'the theme background, cropped', reason: expect.stringMatching(/needs its own design/) });
    const count = (await nodesOf(made.file_id)).length;
    const added = await call(agent, 'omarchy_theme_displays', { file_id: made.file_id, action: 'add', add: [{ preset: 'portrait-1200x1920' }] });
    expect(added.added[0]).toMatchObject({ width: 1200, height: 1920 });
    expect(added.wallpapers[0].component).toBe('Wallpaper · portrait 10:16');
    expect(added.next).toMatch(/Design/);
    const undo = await fetch(`${h.base}/api/agents/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: made.file_id, agent: 'claude' }) });
    expect(undo.ok).toBe(true);
    expect((await nodesOf(made.file_id)).length).toBe(count);
    const wrong = await callRaw(agent, 'omarchy_theme_displays', { file_id: made.file_id, action: 'assign_artwork', aspect: '9:16', src: (await h.server.storage.putAsset(png(400, 300), 'image/png')).src });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0]!.text).toMatch(/not taken/);
    await agent.close();
  });

  it('checks the portrait previews against the palette too', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Drift' });
    const { doc } = await h.server.rooms.get(made.body.file_id);
    const board = made.body.boards.find((b: any) => b.name === 'Preview · lock screen · portrait 2160 × 3840');
    doc.transact(() => {
      doc.setToken('om-accent', 'color', '#00ff00');
      doc.updateStyle(doc.descendants(board.id).find((n) => n.name === 'Password')!.id, { color: 'var(--om-accent)' });
    }, 'agent:claude');
    const info = (await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme;
    expect(info.problems.join(' ')).toContain('"Preview · lock screen · portrait 2160 × 3840" draws with --om-accent');
  });

  it('warns, for each display, when the boot logo is wider than it, as Plymouth draws it unscaled', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Narrow' });
    await api(`/api/omarchy/theme/${made.body.file_id}/displays`, { add: [{ width: 720, height: 1280 }] });
    const info = (await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme;
    const boot = info.problems.filter((p: string) => p.startsWith('The boot unlock logo'));
    expect(boot).toEqual([expect.stringMatching(/800 × 188.*portrait 720 × 1280.*at most 640 px wide/)]);
  });

  it('exports the portrait previews under displays/, ships a composition only once it is designed, and says which are ready', async () => {
    const made = await api('/api/omarchy/themes', { name: 'Shipped' });
    // No browser here: a stand-in renderer gives a small PNG per board, of the board's shape, and records the asks.
    const asked: { width: number; scale?: number }[] = [];
    const renderer = h.server.renderer as unknown as { screenshot: (...a: unknown[]) => Promise<{ bytes: Uint8Array; mime: string }> };
    const real = renderer.screenshot;
    renderer.screenshot = async (doc: any, target: any, opts: any) => {
      const node = doc.getNode(target.nodeIds[0]);
      const w = Number.parseFloat(node.style.width);
      const tall = w === 2160 && Number.parseFloat(node.style.height) === 3840 && !opts?.scale;
      asked.push({ width: w, ...(opts?.scale ? { scale: opts.scale } : {}) });
      return { bytes: tall ? png(360, 640) : png(2, 2), mime: 'image/png' };
    };
    try {
      // The placeholder is not shipped, and the runtime manifest lists it as incomplete only.
      let theme = await exportTheme(h.server, themeEnv(h.server), made.body.file_id);
      let paths = theme.files.map((f) => f.path).sort();
      expect(paths).toEqual(['README.md', 'backgrounds/1-3840x2160.png', 'bogen-theme.json', 'colors.toml', 'displays/portrait-runtime.json', 'displays/preview-portrait-2160x3840.png', 'icons.theme', 'preview-unlock.png', 'preview.png', 'shell.toml', 'unlock.png']);
      expect(asked).toContainEqual({ width: 1920, scale: (1800 - 0.1) / 1920 });
      expect(asked).toContainEqual({ width: 2160, scale: (1800 - 0.1) / 3840 });
      expect(theme.manifest.displays).toEqual([{ size: '2160x3840', orientation: 'portrait', wallpaper: 'needs-design', runtime: 'not-shown', preview: 'displays/preview-portrait-2160x3840.png' }]);
      let rt = JSON.parse(new TextDecoder().decode(theme.files.find((f) => f.path === 'displays/portrait-runtime.json')!.bytes));
      expect(rt).toMatchObject({ kind: 'bogen-portrait-runtime', format: 1, theme: 'shipped', wallpapers: [], incomplete: [{ aspect: '9:16', status: 'needs-design' }] });
      expect(theme.problems.join(' ')).toMatch(/portrait 9:16 background needs its own design/);
      expect(theme.problems.join(' ')).toMatch(/landscape background .* is Bogen's plain placeholder field/);
      expect(theme.notes.join(' ')).toMatch(/only with Bogen's portrait background plugin/);
      expect(new TextDecoder().decode(theme.files.find((f) => f.path === 'README.md')!.bytes)).toMatch(/not designed yet \(needs-design\), so none is shipped/);

      // Designed with a layer of its own, it is shipped as a render and listed, measured from its own header.
      const { doc } = await h.server.rooms.get(made.body.file_id);
      const comp = made.body.boards.find((b: any) => b.name.startsWith('Portrait background'));
      const main = doc.descendants(comp.id).find((n) => n.name === 'Wallpaper · portrait 9:16') ?? doc.getNode(comp.id)!;
      doc.transact(() => doc.insert(main.id, { type: 'frame', tag: 'div', name: 'Shipped mark', style: { position: 'absolute', top: '30%', left: '10%', width: '80%', height: '10%', background: 'var(--omarchy-accent)' } }), 'agent:claude');
      theme = await exportTheme(h.server, themeEnv(h.server), made.body.file_id);
      expect(theme.files.map((f) => f.path)).toContain('displays/background-portrait-9x16.png');
      expect(theme.manifest.displays![0]).toMatchObject({ wallpaper: 'composed', runtime: 'bogen.portrait-background', background: 'displays/background-portrait-9x16.png' });
      rt = JSON.parse(new TextDecoder().decode(theme.files.find((f) => f.path === 'displays/portrait-runtime.json')!.bytes));
      expect(rt.wallpapers).toEqual([expect.objectContaining({ aspect: '9:16', width: 360, height: 640, file: 'displays/background-portrait-9x16.png', status: 'composed' })]);

      // A landscape picture shown whole in a band of the field is a composition: the render ships, never its bytes.
      const wide = (await h.server.storage.putAsset(png(384, 216), 'image/png')).src;
      doc.transact(() => doc.insert(main.id, { type: 'image', tag: 'img', name: 'Plate', src: wide, attrs: { alt: 'Plate' }, style: { position: 'absolute', top: '15.755cqh', left: '0', width: '100cqw', height: '56.25cqw', objectFit: 'contain' } }), 'agent:claude');
      theme = await exportTheme(h.server, themeEnv(h.server), made.body.file_id);
      const shipped = theme.files.find((f) => f.path === 'displays/background-portrait-9x16.png')!;
      expect(imageSize(shipped.bytes)).toEqual({ width: 360, height: 640 });
      const info = await themeInfo(h.server, themeEnv(h.server), made.body.file_id);
      expect(info!.wallpapers[0]).toMatchObject({ status: 'composed', reason: expect.stringMatching(/"Plate" whole inside the layout/) });
      expect(info!.previews.desktop).toBe(true);
    } finally {
      renderer.screenshot = real;
    }
  });
});
