import { describe, expect, it } from 'vitest';
import { BogenDoc, cleanProject, inScope, PROJECT_META_KEY, readProject } from '@bogen/core';
import { startServer } from './helpers.ts';

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('what a file is a design for', () => {
  it('reads only what a file records about itself, and calls the rest unknown', () => {
    const doc = new BogenDoc();
    const page = doc.createPage('Screens');
    const board = doc.insert(page, { type: 'frame', name: 'iPhone 16 Pro app home', artboard: true, style: { width: '402px', height: '874px' } });
    doc.invalidate();
    // A phone-sized board named like an app is still not evidence.
    expect(readProject(doc)).toEqual({ type: 'design', source: 'unknown' });
    doc.updateFields(board, { attrs: { 'data-web': 'page' } });
    doc.invalidate();
    expect(readProject(doc)).toEqual({ type: 'website', source: 'file' });
    doc.meta.set('omarchyTheme', { name: 'Ember', format: 2, target: 'mobile' });
    expect(readProject(doc)).toEqual({ type: 'omarchy-theme', platforms: ['mobile'], source: 'file' });
    doc.meta.set('omarchyTheme', { name: 'Old' });
    expect(readProject(doc).platforms).toEqual(['desktop']);
    expect(readProject(doc, true)).toEqual({ type: 'brand', source: 'file' });
    // The person's answer wins, for one app on several platforms.
    doc.meta.set(PROJECT_META_KEY, { type: 'app', platforms: ['ios', 'android', 'ios', 'watch'] });
    expect(readProject(doc)).toEqual({ type: 'app', platforms: ['ios', 'android'], source: 'person' });
  });

  it('never trusts an unknown kind, and filters by kind and platform', () => {
    expect(cleanProject({ type: 'spaceship' })).toBeNull();
    expect(cleanProject({ type: 'omasidebar-widget', platforms: ['ios'] })).toEqual({ type: 'omasidebar-widget' });
    const app = { type: 'app' as const, platforms: ['ios', 'desktop'] };
    expect(inScope(app, 'app', null)).toBe(true);
    expect(inScope(app, 'app', 'desktop')).toBe(true);
    expect(inScope(app, 'app', 'android')).toBe(false);
    expect(inScope(undefined, 'design', null)).toBe(true);
    expect(inScope(undefined, 'website', null)).toBe(false);
  });

  it('follows a file that becomes a web page and stops being one while it stays open', async () => {
    const h = await startServer();
    try {
      const { id } = await (await fetch(`${h.base}/api/files`, json('POST', { name: 'Studio' }))).json() as { id: string };
      const room = await h.server.rooms.get(id);
      const page = room.doc.getPages()[0]!.id;
      const board = room.doc.insert(page, { type: 'frame', name: 'Home', artboard: true, style: { width: '1440px' } });
      const kind = () => h.server.storage.get(id)?.project?.type;
      const settle = () => new Promise((r) => setTimeout(r, 1800));
      await settle();
      expect(kind()).toBe('design');
      room.doc.updateFields(board, { attrs: { 'data-web': 'page' } });
      await settle();
      expect(kind()).toBe('website');
      room.doc.updateFields(board, { attrs: {} });
      await settle();
      expect(kind()).toBe('design');
    } finally {
      await h.cleanup();
    }
  }, 15_000);

  it('keeps a person\'s answer in the document and in the index, and lets them take it back', async () => {
    const h = await startServer();
    try {
      const { id } = await (await fetch(`${h.base}/api/files`, json('POST', { name: 'Habit tracker' }))).json() as { id: string };
      const listed = async () => ((await (await fetch(`${h.base}/api/files`)).json()) as { id: string; project?: { type: string; platforms?: string[]; source: string } }[]).find((f) => f.id === id);
      const set = await fetch(`${h.base}/api/files/${id}/project`, json('PATCH', { type: 'app', platforms: ['ios', 'android'] }));
      expect(set.status).toBe(200);
      expect((await listed())?.project).toEqual({ type: 'app', platforms: ['ios', 'android'], source: 'person' });
      expect((await h.server.rooms.get(id)).doc.meta.get(PROJECT_META_KEY)).toEqual({ type: 'app', platforms: ['ios', 'android'] });
      expect((await fetch(`${h.base}/api/files/${id}/project`, json('PATCH', { type: 'spaceship' }))).status).toBe(400);
      await fetch(`${h.base}/api/files/${id}/project`, json('PATCH', { type: null }));
      expect((await listed())?.project).toEqual({ type: 'design', source: 'unknown' });
    } finally {
      await h.cleanup();
    }
  });
});
