import { expect, it, vi } from 'vitest';
import { BogenDoc, applyCanvasPlan, prepareCanvasPlan } from '@bogen/core';
import { DesignQuality } from '../src/design-quality.ts';

function fixture() {
  const doc=new BogenDoc(),page=doc.createPage('App');
  const add=(name:string)=>doc.insert(page,{type:'frame',name,artboard:true,style:{position:'absolute',left:'0px',top:'0px',width:'390px',height:'844px'}});
  const old=add('Existing work');
  const quality=new DesignQuality({rooms:{get:async()=>({doc})}} as never);
  quality.beginRun('file','run',doc);
  const ids=['Welcome','Account details','Verify email'].map(add);
  const review=vi.spyOn(quality,'review').mockResolvedValue({automated:{state:'passed',findings:[]},visual:{state:'self-assessed'},rubric:{state:'scored'}} as never);
  const req={runner:'codex' as const,fileId:'file',fileName:'App',prompt:'Design an onboarding flow',pageId:page};
  return {doc,page,old,ids,quality,review,req};
}
it('requires structure before completing a run that created several screens, without touching older work',async()=>{
  const f=fixture();const before=f.doc.getNode(f.old);
  const blocked=await f.quality.beforeFinish(f.req,'run',f.ids);
  expect(blocked).toMatchObject({ok:false,retryable:true});expect(blocked.message).toContain('canvas_plan_set');expect(f.review).not.toHaveBeenCalled();
  applyCanvasPlan(f.doc,f.page,prepareCanvasPlan(f.doc,f.page,{expected_revision:0,sections:[{id:'onboarding',title:'Create an account',purpose:'Set up access to the product',lanes:[{title:'Main path',node_ids:f.ids}]}]}));
  expect((await f.quality.beforeFinish(f.req,'run',f.ids)).ok).toBe(true);expect(f.doc.getNode(f.old)).toEqual(before);f.doc.y.destroy();
});
it('requires a finished arrangement after screens have only been assigned to groups',async()=>{
  const f=fixture();applyCanvasPlan(f.doc,f.page,prepareCanvasPlan(f.doc,f.page,{expected_revision:0,sections:[{id:'main',title:'Account setup',purpose:'Complete account setup',lanes:[{title:'Main path',node_ids:f.ids}]}]}));
  const key=`canvasPlan:${f.page}`;f.doc.meta.set(key,{...f.doc.meta.get(key) as object,layout_pending:true});
  expect((await f.quality.beforeFinish(f.req,'run',f.ids)).message).toContain('arrangement is pending');f.doc.y.destroy();
});
it('does not demand a reorganization of untouched screens or a simple edit to existing work',async()=>{
  const f=fixture();expect((await f.quality.beforeFinish(f.req,'run',[f.old])).ok).toBe(true);f.doc.y.destroy();
});
