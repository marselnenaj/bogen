import { describe, expect, it } from 'vitest';
import { collectionRows, presetProjects, presetSource, presetThumb, unrepresentedPresets, type CollectionPreset, type ThemeProject } from '../src/lib/theme-library.ts';

const preset = (id: string, patch: Partial<CollectionPreset> = {}): CollectionPreset => ({
  id, name: id, description: '', mode: 'dark', medium: 'vector', swatches: [], ready: true, ...patch,
});
const project = (file_id: string, patch: Partial<ThemeProject> = {}): ThemeProject => ({
  file_id, file_name: file_id, name: file_id, slug: null, target: 'desktop', updatedAt: 0, status: 'draft',
  branch: { current: 'main', open: [{ id: 'main', name: 'Main' }] }, ...patch,
});

describe('the Bogen collection on Home', () => {
  const presets = [
    preset('interference', { name: 'Interference', description: 'Op art in bone and black.' }),
    preset('kiln', { name: 'Kiln', medium: 'raster', ready: false, description: 'Glaze, macro.' }),
    preset('relief-tide', { name: 'Relief Tide', mode: 'light', description: 'A two-ink linocut of an indigo sea.' }),
  ];

  it('offers only presets whose art is all here', () => {
    expect(collectionRows(presets, '').map((p) => p.id)).toEqual(['interference', 'relief-tide']);
  });

  it('is desktop only: a Mobile filter leaves none, Desktop and all leave them', () => {
    expect(collectionRows(presets, '', 'mobile')).toEqual([]);
    expect(collectionRows(presets, '', 'desktop')).toHaveLength(2);
    expect(collectionRows(presets, '', null)).toHaveLength(2);
  });

  it('narrows by name and description, never showing a pending preset', () => {
    expect(collectionRows(presets, 'indigo').map((p) => p.id)).toEqual(['relief-tide']);
    expect(collectionRows(presets, 'INTERF').map((p) => p.id)).toEqual(['interference']);
    expect(collectionRows(presets, 'glaze')).toEqual([]);
  });

  it('finds the desktop projects started from a preset by their source, not by name', () => {
    const projects = [
      project('a', { name: 'Interference', from: presetSource('interference') }),
      project('b', { name: 'My op art', from: presetSource('interference') }),
      project('c', { name: 'Interference' }),
      project('d', { name: 'Interference', from: presetSource('interference'), target: 'mobile' }),
      project('e', { name: 'Kiln', from: 'kiln' }),
    ];
    expect(presetProjects(projects, 'interference').map((p) => p.file_id)).toEqual(['a', 'b']);
    expect(presetProjects(projects, 'kiln')).toEqual([]);
  });

  it('asks for small pictures by id and orientation', () => {
    expect(presetThumb('relief-tide', 'portrait')).toBe('/api/omarchy/collection/relief-tide/portrait?v=4');
    expect(presetSource('kiln')).toBe('collection/kiln');
  });

  it('replaces a preset with its visible desktop project, including a renamed project', () => {
    const files = [{ theme: { target: 'desktop' as const, from: presetSource('interference'), name: 'My new name', slug: 'my-new-name', branch: 'main', branches: [] } }];
    expect(unrepresentedPresets(presets, files, '', 'desktop').map((p) => p.id)).toEqual(['relief-tide']);
    // A project outside the current folder/search does not remove its Open card from this view.
    expect(unrepresentedPresets(presets, [], '', 'desktop').map((p) => p.id)).toEqual(['interference', 'relief-tide']);
  });

  it('never mistakes a similarly named or mobile project for the desktop preset', () => {
    const files = [{ theme: { target: 'mobile' as const, from: presetSource('interference'), name: 'Interference', slug: null, branch: 'main', branches: [] } }];
    expect(unrepresentedPresets(presets, files, 'interf', 'desktop').map((p) => p.id)).toEqual(['interference']);
    expect(unrepresentedPresets(presets, files, '', 'mobile')).toEqual([]);
  });
});
