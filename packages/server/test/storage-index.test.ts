import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage.ts';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = () => { const h = mkdtempSync(join(tmpdir(), 'bogen-index-')); homes.push(h); return h; };
const open = async (h: string) => { const s = new Storage(h); await s.init(); return s; };
const edit = (id: string, at: number) => ({ id, at, actor: 'agent:t', summary: `Edit ${id}`, locations: [], locationCount: 0 });

describe('the file list on disk', () => {
  it('keeps recent edits beside the file history, not in index.json', async () => {
    const h = home();
    const s = await open(h);
    const f = s.create('Poster');
    s.update(f.id, { recentEdits: [edit('a', 2), edit('b', 1)] });
    await s.flushAll();
    const index = readFileSync(join(h, 'index.json'), 'utf8');
    expect(index).not.toContain('recentEdits');
    expect(index).not.toContain('\n');
    expect(JSON.parse(readFileSync(join(h, 'history', f.id, 'recent-edits.json'), 'utf8'))).toHaveLength(2);
    expect((await open(h)).get(f.id)?.recentEdits?.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('moves recent edits out of an index an older version wrote', async () => {
    const h = home();
    writeFileSync(join(h, 'index.json'), JSON.stringify({ files: [{ id: 'abcd1234', name: 'Old', createdAt: 1, updatedAt: 2, recentEdits: [edit('x', 5)] }] }));
    const s = await open(h);
    expect(s.get('abcd1234')?.recentEdits?.[0]?.id).toBe('x');
    expect(readFileSync(join(h, 'index.json'), 'utf8')).not.toContain('recentEdits');
    expect(JSON.parse(readFileSync(join(h, 'history', 'abcd1234', 'recent-edits.json'), 'utf8'))[0].id).toBe('x');
  });

  it('writes the list later when only the edit time changed, and soon for a rename', async () => {
    const h = home();
    const s = await open(h);
    const f = s.create('Poster');
    await s.flushIndex();
    s.update(f.id, { updatedAt: Date.now() + 1000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(JSON.parse(readFileSync(join(h, 'index.json'), 'utf8')).files[0].updatedAt).toBe(f.createdAt);
    s.update(f.id, { name: 'Renamed' });
    await new Promise((r) => setTimeout(r, 400));
    const files = JSON.parse(readFileSync(join(h, 'index.json'), 'utf8')).files;
    expect(files[0].name).toBe('Renamed');
    expect(files[0].updatedAt).toBe(f.updatedAt);
  });

  it('removes temporary files an interrupted write left, but not fresh ones', async () => {
    const h = home();
    mkdirSync(join(h, 'files'), { recursive: true });
    const old = join(h, 'peers-state.json.a1b2c3d4e5f6.tmp');
    const fresh = join(h, 'files', 'abcd1234.ydoc.0a0b0c0d0e0f.tmp');
    const other = join(h, 'files', 'notes.tmp');
    for (const p of [old, fresh, other]) writeFileSync(p, 'x');
    utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await open(h);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
