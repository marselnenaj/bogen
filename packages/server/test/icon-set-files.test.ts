import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureIconSets, searchSetIcons } from '@bogen/core/icon-sets';
import { afterEach, describe, expect, it } from 'vitest';
import { iconSetDirs, readIconSetFile, useIconSetFiles } from '../src/icon-set-files.ts';

/** The sets beyond Lucide are files next to the bundle, read on first use: not code in cli.js. */
describe('icon set files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    // Back to the real files for the other tests in this process.
    configureIconSets((file) => readIconSetFile(file));
  });

  it('looks next to the bundle and in the source tree, after BOGEN_ICON_SETS_DIR', async () => {
    const list = iconSetDirs({ BOGEN_ICON_SETS_DIR: '/opt/sets' });
    expect(list[0]).toBe('/opt/sets');
    expect(list[1]!.endsWith(join('src', 'icon-sets'))).toBe(true);
    expect(list.at(-1)!.endsWith(join('core', 'src', 'icon-sets'))).toBe(true);
    useIconSetFiles();
    expect((await searchSetIcons('home', { set: 'tabler', limit: 1 }))[0]).toBe('tabler:home');
  });

  it('says clearly when a set\'s file is missing, keeps Lucide working, and reads the file once it is there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-icon-sets-'));
    dirs.push(dir);
    configureIconSets((file) => readIconSetFile(file, [dir]));
    await expect(searchSetIcons('home', { set: 'phosphor' })).rejects.toThrow(/icon set file phosphor\.json is missing: it is not in .*install it again, or set BOGEN_ICON_SETS_DIR/);
    expect(await searchSetIcons('home', { set: 'lucide', limit: 1 })).toEqual(['house']);
    writeFileSync(join(dir, 'phosphor.json'), JSON.stringify({ id: 'phosphor', name: 'Phosphor', viewBox: '0 0 256 256', kind: 'fill', icons: { house: '<path d="M0 0h1"/>' } }));
    expect(await searchSetIcons('house', { set: 'phosphor' })).toEqual(['phosphor:house']);
    await expect(readIconSetFile('../etc.json', [dir])).rejects.toThrow(/not an icon set file/);
  });
});
