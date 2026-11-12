import { describe, expect, it } from 'vitest';
import { BogenDoc, Y } from '@bogen/core';
import { thumbnailTarget } from '../src/thumbnail-target.ts';

function board(doc: BogenDoc, page: string, name = 'Background', width = 3840, height = 2160, hidden = false) {
  return doc.insert(page, { type: 'frame', name, artboard: true, hidden, style: { width: `${width}px`, height: `${height}px` } });
}
function wallpaper(doc: BogenDoc, root: string) {
  const id = doc.insert(root, { type: 'frame', name: 'Wallpaper', style: {} });
  doc.nodes.get(id)!.set('component', new Y.Map());
  return id;
}

describe('dashboard thumbnail target', () => {
  it('finds a real landscape wallpaper after a process page, regardless of artboard name', () => {
    const d = new BogenDoc();
    const process = d.createPage('Process'); board(d, process, 'Palette');
    const art = d.createPage('Artwork');
    const mockup = board(d, art, 'Preview · desktop');
    d.insert(mockup, { type: 'frame', name: 'Wallpaper', style: {} });
    const portrait = board(d, art, 'Tall', 2160, 3840); wallpaper(d, portrait);
    const hidden = board(d, art, 'Hidden', 3840, 2160, true); wallpaper(d, hidden);
    const actual = board(d, art, 'My completely renamed artwork'); wallpaper(d, actual);
    d.meta.set('omarchyTheme', { target: 'desktop' });
    expect(thumbnailTarget(d)).toEqual({ nodeIds: [actual] });
    expect(d.getPages()).toHaveLength(2);
    d.y.destroy();
  });
  it('uses a populated screen and ignores empty/hidden pages', () => {
    const d = new BogenDoc();
    const empty = d.createPage('Empty'); board(d, empty, 'Hidden', 100, 100, true);
    const page = d.createPage('Website'); const root = board(d, page); wallpaper(d, root);
    expect(thumbnailTarget(d)).toEqual({ nodeIds: [root] });
    d.y.destroy();
  });
  it('bounds a large non-theme project to one visible artboard', () => {
    const d = new BogenDoc(); const page = d.createPage('Screens');
    const root = board(d, page);
    for (let i = 0; i < 11; i++) board(d, page);
    expect(thumbnailTarget(d)).toEqual({ nodeIds: [root] });
    d.y.destroy();
  });
  it('falls back safely for incomplete themes and empty documents', () => {
    const d = new BogenDoc(); expect(thumbnailTarget(d)).toBeNull();
    const page = d.createPage('Theme'); board(d, page);
    d.meta.set('omarchyTheme', { target: 'desktop' });
    expect(thumbnailTarget(d)).toEqual({ pageId: page });
    d.y.destroy();
  });
  it('prefers a populated 16:9 screen across pages over a palette, phone and empty placeholder', () => {
    const d=new BogenDoc(),p=d.createPage('Process');const palette=board(d,p,'Palette',1920,1080);wallpaper(d,palette);
    const page=d.createPage('Product');const phone=board(d,page,'Phone',390,844);wallpaper(d,phone);board(d,page,'Empty cover',1920,1080);
    const actual=board(d,page,'Dashboard',1600,900);wallpaper(d,actual);
    expect(thumbnailTarget(d)).toEqual({nodeIds:[actual]});d.y.destroy();
  });
  it('respects a chosen cover and falls back when it is hidden or deleted', () => {
    const d=new BogenDoc(),p=d.createPage('App');const a=board(d,p,'Dashboard',1600,900);wallpaper(d,a);const b=board(d,p,'Phone',390,844);wallpaper(d,b);
    d.meta.set('canvasCover',b);expect(thumbnailTarget(d)).toEqual({nodeIds:[b]});d.updateFields(b,{hidden:true});expect(thumbnailTarget(d)).toEqual({nodeIds:[a]});
    d.meta.set('canvasCover','deleted');expect(thumbnailTarget(d)).toEqual({nodeIds:[a]});d.y.destroy();
  });

});
