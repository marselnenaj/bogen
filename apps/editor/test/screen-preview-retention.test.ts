import { describe, expect, it } from 'vitest';
import { mergeScreenPreviews, type ScreenPreview } from '../src/canvas/screen-previews.ts';
import { shouldPrepareScreen, canvasPreviewPixelBudget } from '../src/canvas/artboard-loading.ts';

describe('continuous frame pictures', () => {
 const old: ScreenPreview = { id:'a',key:'old',layers:700,state:'ready',src:'/old',smallSrc:'/old-small',width:390,height:844,scope:'main' };
 it('keeps the last actual picture through an edit until its replacement is ready', () => {
  const previous=new Map([['a',old]]);
  const pending=mergeScreenPreviews(previous,[{id:'a',key:'new',layers:750,state:'pending'}],'main');
  expect(pending.get('a')).toMatchObject({key:'new',state:'pending',src:'/old',smallSrc:'/old-small',height:844});
  expect(previous.get('a')).toBe(old);
  const ready=mergeScreenPreviews(pending,[{id:'a',key:'new',layers:750,state:'ready',src:'/new',smallSrc:'/new-small',height:900}],'main');
  expect(ready.get('a')?.src).toBe('/new');expect(ready.get('a')?.height).toBe(900);
 });
 it('does not reuse a different branch’s picture or resurrect a deleted screen',()=>{
  const pending=mergeScreenPreviews(new Map([['a',old]]),[{id:'a',key:'other',layers:700,state:'pending'}],'alternate');
  expect(pending.get('a')?.src).toBeUndefined();
  expect(mergeScreenPreviews(new Map([['a',old]]),[],'main').size).toBe(0);
 });
 it('prepares editable content before the old 140px boundary and avoids threshold flicker',()=>{
  expect(shouldPrepareScreen(64,300,false)).toBe(true);
  expect(shouldPrepareScreen(52,300,true)).toBe(true);
  expect(shouldPrepareScreen(52,300,false)).toBe(false);
  expect(shouldPrepareScreen(32,300,true)).toBe(false);
  expect(canvasPreviewPixelBudget(4)*4).toBeLessThanOrEqual(6_000_000);
 });
});
