import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

describe('semantic canvas organization over MCP',()=>{
 let h:Harness;let agent:Client;let file:string;let page:string;let ids:string[];
 beforeAll(async()=>{
  h=await startServer();agent=await connectAgent(h.base,'canvas-planner');file=(await call(agent,'file_create',{name:'Canvas plan fixture'})).id;
  page=(await h.server.rooms.get(file)).doc.getPages()[0]!.id;ids=[];
  for(const name of ['Sign in','Account','Error','Settings']) ids.push((await call(agent,'artboard_create',{file_id:file,page_id:page,name,width:390,height:844})).id);
 },60000);
 afterAll(async()=>{await agent?.close();await h?.cleanup();});
 const input=()=>({file_id:file,page_id:page,expected_revision:0,sections:[{id:'account',title:'Account access',purpose:'Enter an account and recover from an error',lanes:[{title:'Main path',node_ids:ids.slice(0,2)},{title:'Errors',node_ids:[ids[2]]}]},{id:'preferences',title:'Settings',purpose:'Manage preferences',lanes:[{title:'Preferences',node_ids:[ids[3]]}]}],connections:[{from:ids[0],to:ids[1],label:'Sign in'}]});
 it('reports unfinished native organization to external clients even when text headings exist',async()=>{
  const heading=await call(agent,'html_write',{file_id:file,page_id:page,html:'<h2>Account flow</h2>'});
  const opened=await call(agent,'file_open',{file_id:file});expect(opened.organization.needs_attention).toBe(true);expect(opened.organization.pages[0].unassigned).toBe(4);
  const context=await call(agent,'context_get');expect(context.organization.needs_attention).toBe(true);
  await call(agent,'layer_delete',{file_id:file,node_ids:heading.ids});
 });
 it('provides the real unassigned screens and previews without moving anything',async()=>{
  const before=await call(agent,'canvas_plan_get',{file_id:file,page_id:page});expect(before.revision).toBe(0);expect(before.unassigned).toHaveLength(4);
  const {doc}=await h.server.rooms.get(file);const left=doc.getNode(ids[1]!)!.style.left;
  const preview=await call(agent,'canvas_plan_set',{...input(),dry_run:true});expect(preview.applied).toBe(false);expect(preview.sections).toHaveLength(2);expect(preview.placements).toHaveLength(4);
  expect(doc.getNode(ids[1]!)!.style.left).toBe(left);expect((await call(agent,'canvas_plan_get',{file_id:file,page_id:page})).revision).toBe(0);
 });
 it('applies a plan as one undoable step and refuses stale updates',async()=>{
  const {doc}=await h.server.rooms.get(file);const old=doc.getNode(ids[1]!)!.style.left;
  const applied=await call(agent,'canvas_plan_set',input());expect(applied.applied).toBe(true);expect(applied.unassigned).toEqual([]);
  expect((await call(agent,'canvas_plan_get',{file_id:file,page_id:page})).revision).toBe(1);
  expect((await callRaw(agent,'canvas_plan_set',input())).isError).toBe(true);
  await call(agent,'agent_undo',{file_id:file});expect(doc.getNode(ids[1]!)!.style.left).toBe(old);expect((await call(agent,'canvas_plan_get',{file_id:file,page_id:page})).revision).toBe(0);
 });
 it('attaches new screens to named lanes atomically and leaves arrangement pending until reflow',async()=>{
  const sections=[{id:'checkout',title:'Complete a purchase',purpose:'Review and confirm an order',lanes:[{title:'Main path',node_ids:[]}]}];
  await call(agent,'canvas_plan_set',{file_id:file,page_id:page,expected_revision:0,sections});
  const created=await call(agent,'artboard_create',{file_id:file,page_id:page,name:'Review order',width:1440,height:900,section_id:'checkout',lane_title:'Main path'});
  const grouped=await call(agent,'canvas_plan_get',{file_id:file,page_id:page});expect(grouped.layout_pending).toBe(true);expect(grouped.sections[0].lanes[0].node_ids).toEqual([created.id]);
  await call(agent,'agent_undo',{file_id:file});const {doc}=await h.server.rooms.get(file);expect(doc.getNode(created.id)).toBeFalsy();
  const before=doc.getChildren(page).length;expect((await callRaw(agent,'artboard_create',{file_id:file,page_id:page,name:'Wrong lane',section_id:'checkout',lane_title:'Missing'})).isError).toBe(true);expect(doc.getChildren(page)).toHaveLength(before);
 });

});
