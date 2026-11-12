// An installed Bogen theme made into a file again: its verified portrait composition comes back as that shape's
// artwork (byte for byte), never a placeholder; opening it again goes back to its file instead of another
// "<name> Custom" copy; a copy is only made on purpose. Server harness, no renderer calls: nothing here exports.
// The parent runs this with its secure browser setup available, as the harness owns a (lazy) renderer.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_FILE, runtimeManifest } from '../src/omarchy-portrait-runtime.ts';
import { startServer, type Harness } from './helpers.ts';

function pngHeader(width: number, height: number, fill = 0): Buffer {
  const b = Buffer.alloc(96, fill);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const DESK = JSON.stringify([
  { name: 'DP-3', width: 3840, height: 2160, transform: 0, scale: 1 },
  { name: 'DP-5', width: 3840, height: 2160, transform: 3, scale: 1 },
]);

describe('reimporting an installed Bogen theme', () => {
  let h: Harness;
  let root: string;
  const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, PATH: process.env.PATH };
  const portrait = pngHeader(2160, 3840, 9);
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(`${h.base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-reimport-'));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const theme = join(home, '.config', 'omarchy', 'themes', 'nenaj');
    mkdirSync(join(theme, 'backgrounds'), { recursive: true });
    mkdirSync(join(theme, 'displays'), { recursive: true });
    mkdirSync(join(root, 'omarchy', 'themes'), { recursive: true });
    mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
    writeFileSync(join(theme, 'colors.toml'), 'mode = "dark"\naccent = "#c6ff00"\nbackground = "#050505"\nforeground = "#f2f2f2"\n');
    writeFileSync(join(theme, 'backgrounds', '1-nenaj-ink-acid.png'), pngHeader(3840, 2160, 1));
    writeFileSync(join(theme, 'bogen-theme.json'), JSON.stringify({ format: 1, kind: 'omarchy-theme', name: 'Nenaj', slug: 'nenaj', target: 'desktop', files: [] }));
    writeFileSync(join(theme, 'displays', 'background-portrait-9x16.png'), portrait);
    writeFileSync(join(theme, RUNTIME_FILE), runtimeManifest('nenaj', [{ aspect: '9:16', orientation: 'portrait', status: 'composed', reason: '', file: 'displays/background-portrait-9x16.png', bytes: portrait }])!.json);
    mkdirSync(bin);
    writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '${DESK}'\n`);
    writeFileSync(join(bin, 'fc-list'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'hyprctl'), 0o755);
    chmodSync(join(bin, 'fc-list'), 0o755);
    process.env.HOME = home;
    process.env.OMARCHY_PATH = join(root, 'omarchy');
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

  it('keeps the shipped portrait composition as that shape\'s artwork, byte for byte, under the theme\'s own name', async () => {
    const made = await api('/api/omarchy/themes', { from: 'nenaj' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Nenaj', slug: 'nenaj', portraits: ['9:16'] });
    const info = (await api(`/api/omarchy/theme/${made.body.file_id}`)).body.theme;
    expect(info.wallpapers).toMatchObject([{ aspect: '9:16', status: 'artwork' }]);
    const asset = await h.server.storage.readAsset(info.wallpapers[0].image.src.slice('bogen-asset:'.length));
    expect(Buffer.compare(Buffer.from(asset!.bytes), portrait)).toBe(0);
  });

  it('opens that file again instead of another copy, and copies only on purpose', async () => {
    const first = await api('/api/omarchy/themes', { from: 'nenaj' });
    const again = await api('/api/omarchy/themes', { from: 'nenaj' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, file_id: first.body.file_id });
    const copy = await api('/api/omarchy/themes', { from: 'nenaj', copy: true });
    expect(copy.status).toBe(201);
    expect(copy.body.file_id).not.toBe(first.body.file_id);
    expect(copy.body.name).toBe('Nenaj Custom');
  });
});
