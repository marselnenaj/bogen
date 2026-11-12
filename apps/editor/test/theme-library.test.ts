import { describe, expect, it } from 'vitest';
import { branchCount, candidatesFor, filterProjects, inFolder, installedRows, libraryRows, type ThemeGroup, type ThemeLibrary, type ThemeProject } from '../src/lib/theme-library.ts';

const project = (file_id: string, patch: Partial<ThemeProject> = {}): ThemeProject => ({
  file_id, file_name: patch.name ?? file_id, name: file_id, slug: null, target: 'desktop', updatedAt: 0, status: 'draft',
  branch: { current: 'main', open: [{ id: 'main', name: 'Main' }] }, ...patch,
});
const installed = (name: string, patch: Partial<ThemeLibrary['installed'][number]> = {}): ThemeLibrary['installed'][number] => ({
  name, title: name, source: 'stock', mode: 'dark', swatches: [], backgrounds: 1, current: false, fromRepo: false, project_file_ids: [], ...patch,
});

const tokyo: ThemeGroup = { key: 'tokyo-night-custom', label: 'Tokyo Night Custom', file_ids: ['vk', 'j5', '6n', '1q'], reason: 'same-identity' };
const lib: Pick<ThemeLibrary, 'projects' | 'groups'> = {
  groups: [tokyo],
  projects: [
    project('vk', { name: 'Tokyo Night Custom', status: 'in-use', updatedAt: 10, folder: 'Themes' }),
    project('j5', { name: 'Tokyo Night Custom', updatedAt: 40, folder: 'Themes/Old' }),
    project('6n', { name: 'Tokyo Night Custom', updatedAt: 30, folder: 'Archive' }),
    project('1q', { name: 'Tokyo Night Custom', updatedAt: 20 }),
    project('lift', { name: 'Tokyo Liftoff', updatedAt: 50, folder: 'Themes' }),
    project('cat', { name: 'Catppuccin Mine', status: 'installed', updatedAt: 5, branch: { current: 'b1', current_name: 'Warmer', open: [{ id: 'main', name: 'Main' }, { id: 'b1', name: 'Warmer' }] } }),
    project('draft', { name: 'Unnamed draft', updatedAt: 60, folder: 'Clients/Acme' }),
    project('phone', { name: 'Pocket Night', target: 'mobile', updatedAt: 70, folder: 'Themes' }),
  ],
};

describe('the theme library', () => {
  it('includes drafts that were never installed', () => {
    const rows = libraryRows(lib, null, '');
    const draft = rows.find((r) => r.lead.file_id === 'draft');
    expect(draft?.status).toBe('draft');
    expect(rows.find((r) => r.lead.file_id === 'lift')?.status).toBe('draft');
  });

  it('shows copies of one theme as one row, with every copy and none hidden', () => {
    const rows = libraryRows(lib, null, '');
    const group = rows.filter((r) => r.group?.key === 'tokyo-night-custom');
    expect(group).toHaveLength(1);
    expect(group[0]!.copies.map((p) => p.file_id).sort()).toEqual(['1q', '6n', 'j5', 'vk']);
    // A separate contribution with a similar name stays its own theme.
    expect(rows.find((r) => r.lead.file_id === 'lift')?.group).toBeUndefined();
    // Every project is somewhere: four copies in one row, the rest one each.
    expect(rows.reduce((n, r) => n + r.copies.length, 0)).toBe(lib.projects.length);
    expect(rows).toHaveLength(lib.projects.length - 3);
  });

  it('lists in use first, then installed, then by last edit', () => {
    const rows = libraryRows(lib, null, '');
    expect(rows[0]!.status).toBe('in-use');
    expect(rows[1]!.lead.file_id).toBe('cat');
    expect(rows.slice(2).map((r) => r.lead.file_id)).toEqual(['phone', 'draft', 'lift']);
  });

  it('respects the folder, with its subfolders', () => {
    expect(inFolder('Themes/Old', 'Themes')).toBe(true);
    expect(inFolder('Themes2', 'Themes')).toBe(false);
    expect(inFolder(undefined, '')).toBe(true);
    expect(inFolder('Themes', '')).toBe(false);
    const rows = libraryRows(lib, 'Themes', '');
    expect(rows.map((r) => r.lead.file_id).sort()).toEqual(['lift', 'phone', 'vk']);
    // Two copies are in the folder: still one row of them.
    expect(rows.find((r) => r.lead.file_id === 'vk')?.copies.map((c) => c.file_id).sort()).toEqual(['j5', 'vk']);
    expect(libraryRows(lib, 'Archive', '')).toHaveLength(1);
    expect(libraryRows(lib, 'Archive', '')[0]!.group).toBeUndefined();
    expect(libraryRows(lib, 'Nowhere', '')).toEqual([]);
  });

  it('respects the search, everywhere like the file list', () => {
    expect(filterProjects(lib.projects, 'Clients/Acme', 'tokyo').map((p) => p.file_id).sort()).toEqual(['1q', '6n', 'j5', 'lift', 'vk']);
    expect(libraryRows(lib, null, 'catppuccin').map((r) => r.lead.file_id)).toEqual(['cat']);
    expect(libraryRows(lib, null, 'nothing like it')).toEqual([]);
  });

  it('a Mobile filter lists only mobile themes, and no desktop theme to start from', () => {
    expect(libraryRows(lib, null, '', 'mobile').map((r) => r.lead.file_id)).toEqual(['phone']);
    expect(filterProjects(lib.projects, null, 'night', 'mobile').map((p) => p.file_id)).toEqual(['phone']);
    expect(installedRows([installed('tokyo-night'), installed('catppuccin')], '', 'mobile')).toEqual([]);
  });

  it('a Desktop filter lists no mobile theme', () => {
    const rows = libraryRows(lib, null, '', 'desktop');
    expect(rows.some((r) => r.copies.some((c) => c.target === 'mobile'))).toBe(false);
    expect(rows.find((r) => r.group)?.copies).toHaveLength(4);
    expect(installedRows([installed('tokyo-night')], '', 'desktop')).toHaveLength(1);
    // Any other platform value is no platform filter.
    expect(libraryRows(lib, null, '', null)).toHaveLength(libraryRows(lib, null, '').length);
  });

  it('counts branches besides main', () => {
    expect(branchCount(lib.projects.find((p) => p.file_id === 'cat')!)).toBe(1);
    expect(branchCount(lib.projects[0]!)).toBe(0);
  });

  it('starts from installed themes, the one in use and the person\'s own first, narrowed by a search', () => {
    const list = [installed('nord'), installed('mine', { source: 'user' }), installed('tokyo-night', { current: true, title: 'Tokyo Night' })];
    expect(installedRows(list, '').map((i) => i.name)).toEqual(['tokyo-night', 'mine', 'nord']);
    expect(installedRows(list, 'tokyo').map((i) => i.name)).toEqual(['tokyo-night']);
  });

  it('offers the projects an installed theme already has as candidates to pick from', () => {
    const out = candidatesFor(lib.projects, ['vk', 'j5', 'missing']);
    expect(out.map((c) => c.file_id)).toEqual(['vk', 'j5']);
    expect(out[0]).toMatchObject({ target: 'desktop', folder: 'Themes' });
    expect(candidatesFor(lib.projects, ['cat'])[0]!.branch).toEqual({ current: 'b1', current_name: 'Warmer' });
  });
});

describe('one theme in the file grid after copies were brought together', () => {
  it('lists a kept copy under its project, not as a file of its own, and as before without its project', async () => {
    const { canonicalFiles } = await import('../src/lib/theme-library.ts');
    const project = { id: 'p1', theme: {} };
    const copyA = { id: 'c1', theme: { consolidatedInto: { fileId: 'p1' } } };
    const copyB = { id: 'c2', theme: { consolidatedInto: { fileId: 'p1' } } };
    const orphan = { id: 'c3', theme: { consolidatedInto: { fileId: 'gone' } } };
    const other = { id: 'x' };
    const out = canonicalFiles([project, copyA, copyB, orphan, other]);
    expect(out.map((f) => f.id)).toEqual(['p1', 'c3', 'x']);
    expect(out[0]!.keptCopies?.map((f) => f.id)).toEqual(['c1', 'c2']);
  });
});
