import { describe, expect, it } from 'vitest';
import { BogenDoc, Y } from '../src/index.ts';
import { applyCanvasPlan, prepareCanvasPlan, readCanvasPlan, type CanvasSection } from '../src/canvas-plan.ts';
import { createDesignBranch, switchDesignBranch } from '../src/design-branches.ts';
import { docToContent } from '../src/content.ts';

function fixture() {
  const d = new BogenDoc(); const page = d.createPage('App');
  const screen = (name: string, w=390, h=844) => d.insert(page, { type:'frame', name, artboard:true, style:{position:'absolute',left:'0px',top:'0px',width:`${w}px`,height:`${h}px`} });
  const ids = [screen('Sign in'),screen('Account'),screen('Empty'),screen('Settings',1440,900)];
  d.insert(ids[0]!,{type:'text',text:'Original content',style:{}});
  const sections: CanvasSection[] = [{id:'account',title:'Account',purpose:'Enter and use an account',lanes:[{title:'Main path',node_ids:ids.slice(0,2)},{title:'Empty state',node_ids:[ids[2]!]}]},{id:'settings',title:'Settings',purpose:'Change account preferences',lanes:[{title:'Desktop',node_ids:[ids[3]!]}]}];
  return { d,page,ids,sections,screen };
}
describe('semantic canvas planning',()=>{
 it('records a meaningful plan before any screens are drawn',()=>{
  const d=new BogenDoc();const page=d.createPage('App');const sections=[{id:'checkout',title:'Checkout',purpose:'Complete a purchase',lanes:[{title:'Main path',node_ids:[]}]}];
  const p=prepareCanvasPlan(d,page,{sections,expected_revision:0});expect(p.placements).toEqual([]);applyCanvasPlan(d,page,p);expect(readCanvasPlan(d,page).sections).toEqual(sections);d.y.destroy();
 });
 it('separates task sections and named state lanes without changing the screen hierarchy/content',()=>{
  const {d,page,ids,sections}=fixture();const child=d.getChildren(ids[0]!)[0]!.id;
  const prepared=prepareCanvasPlan(d,page,{sections,expected_revision:0,connections:[{from:ids[0]!,to:ids[1]!,label:'Sign in'}]});
  expect(d.getNode(ids[1]!)!.style.left).toBe('0px');
  applyCanvasPlan(d,page,prepared);
  expect(readCanvasPlan(d,page).revision).toBe(1);
  expect(d.getNode(ids[0]!)!.parent).toBe(page);expect(d.getNode(child)!.text).toBe('Original content');
  expect(d.getNode(ids[1]!)!.style.left).not.toBe('0px');
  const by=new Map(prepared.placements.map(p=>[p.id,p]));expect(by.get(ids[2]!)!.y).toBeGreaterThan(by.get(ids[0]!)!.y+844);
  expect(by.get(ids[3]!)!.y).toBeGreaterThan(by.get(ids[2]!)!.y+844+200);d.y.destroy();
 });
 it('wraps a long flow without overlaps despite different screen sizes',()=>{
  const {d,page,ids,sections}=fixture();sections[0]!.lanes=[{title:'Steps',node_ids:ids}];sections.splice(1);
  const p=prepareCanvasPlan(d,page,{sections,expected_revision:0,columns:2});
  for(const a of p.placements)for(const b of p.placements)if(a.id!==b.id)expect(a.x>=b.x+b.w||b.x>=a.x+a.w||a.y>=b.y+b.h||b.y>=a.y+a.h).toBe(true);
  expect(p.placements[2]!.y).toBeGreaterThan(p.placements[0]!.y);d.y.destroy();
 });
 it('rejects duplicates, cross-page, locked screens, invalid links and stale revisions without writes',()=>{
  const {d,page,ids,sections}=fixture();const initial=Y.encodeStateAsUpdate(d.y);
  const bad=structuredClone(sections);bad[1]!.lanes[0]!.node_ids=[ids[0]!];expect(()=>prepareCanvasPlan(d,page,{sections:bad,expected_revision:0})).toThrow('more than one');
  expect(()=>prepareCanvasPlan(d,page,{sections,expected_revision:2})).toThrow('changed');
  expect(()=>prepareCanvasPlan(d,page,{sections,expected_revision:0,connections:[{from:ids[0]!,to:'missing',label:'Go'}]})).toThrow('Connections');
  expect(Y.encodeStateAsUpdate(d.y)).toEqual(initial);
  d.updateFields(ids[0]!,{locked:true} as never);expect(()=>prepareCanvasPlan(d,page,{sections,expected_revision:0})).toThrow('locked');
  d.nodes.get(ids[0]!)!.set('locked',false);const other=d.createPage('Other');d.nodes.get(ids[0]!)!.set('parent',other);expect(()=>prepareCanvasPlan(d,page,{sections,expected_revision:0})).toThrow('top-level');d.y.destroy();
 });
 it('requires real measurements for hugging screens and preserves their sizing mode',()=>{
  const {d,page,ids,sections}=fixture();d.updateStyle(ids[0]!,{height:'fit-content'});
  expect(()=>prepareCanvasPlan(d,page,{sections,expected_revision:0})).toThrow('actual bounds');
  const p=prepareCanvasPlan(d,page,{sections,expected_revision:0,sizes:[{node_id:ids[0]!,width:390,height:2600}]});applyCanvasPlan(d,page,p);
  expect(d.getNode(ids[0]!)!.style.height).toBe('fit-content');expect(p.placements[2]!.y).toBeGreaterThan(p.placements[0]!.y+2600);d.y.destroy();
 });
 it('places partial plans below untouched screens and refuses explicit collisions',()=>{
  const {d,page,ids,sections}=fixture();const partial=[sections[1]!];
  const p=prepareCanvasPlan(d,page,{sections:partial,expected_revision:0});expect(p.placements[0]!.y).toBeGreaterThan(844);
  expect(()=>prepareCanvasPlan(d,page,{sections:partial,expected_revision:0,y:-196,x:-80})).toThrow('overlap');
  applyCanvasPlan(d,page,p);expect(d.getNode(ids[0]!)!.style.top).toBe('0px');d.y.destroy();
 });
 it('round trips metadata, supports undo, and keeps a branch map off an unplanned Main',()=>{
  const {d,page,sections}=fixture();const branch=createDesignBranch(d,{name:'Organization',by:'test',checkout:true}).branch;
  const undo=new Y.UndoManager([d.nodes,d.meta],{trackedOrigins:new Set(['plan'])});
  applyCanvasPlan(d,page,prepareCanvasPlan(d,page,{sections,expected_revision:0}),'plan');
  d.meta.set('canvasCover',sections[0]!.lanes[0]!.node_ids[0]);
  const reopened=new BogenDoc();Y.applyUpdate(reopened.y,Y.encodeStateAsUpdate(d.y));expect(readCanvasPlan(reopened,page).sections).toEqual(sections);reopened.y.destroy();
  expect(docToContent(d).extra?.meta?.[`canvasPlan:${page}`]).toBeDefined();
  undo.undo();expect(readCanvasPlan(d,page).revision).toBe(0);undo.redo();expect(readCanvasPlan(d,page).revision).toBe(1);
  switchDesignBranch(d,'main');expect(readCanvasPlan(d,page).sections).toEqual([]);expect(d.meta.has('canvasCover')).toBe(false);
  switchDesignBranch(d,branch.id);expect(readCanvasPlan(d,page).sections).toEqual(sections);undo.destroy();d.y.destroy();
 });
 it('rejects a different peer plan even if its numeric revision is the same',()=>{
  const {d,page,sections}=fixture();applyCanvasPlan(d,page,prepareCanvasPlan(d,page,{sections,expected_revision:0}));
  const current=readCanvasPlan(d,page);const prepared=prepareCanvasPlan(d,page,{sections,expected_revision:current.revision,expected_revision_id:current.revision_id});
  d.meta.set(`canvasPlan:${page}`,{...current,revision_id:'different-peer-update'});expect(()=>applyCanvasPlan(d,page,prepared)).toThrow('changed before apply');d.y.destroy();
 });
 it('refuses transformed roots and releases opposite anchors without resizing screens',()=>{
  const {d,page,ids,sections}=fixture();d.updateStyle(ids[0]!,{transform:'rotate(15deg)'});
  expect(()=>prepareCanvasPlan(d,page,{sections,expected_revision:0})).toThrow('transformed');
  d.updateStyle(ids[0]!,{transform:null,right:'0px',bottom:'0px'});
  applyCanvasPlan(d,page,prepareCanvasPlan(d,page,{sections,expected_revision:0}));
  expect(d.getNode(ids[0]!)!.style.right).toBeUndefined();expect(d.getNode(ids[0]!)!.style.bottom).toBeUndefined();
  expect(d.getNode(ids[0]!)!.style.width).toBe('390px');d.y.destroy();
 });
 it('ignores malformed/unbounded file records without crashing the editor',()=>{
  const {d,page}=fixture();d.meta.set(`canvasPlan:${page}`,{version:1,revision:3,sections:[null],connections:[]});expect(readCanvasPlan(d,page).sections).toEqual([]);d.y.destroy();
 });
});
