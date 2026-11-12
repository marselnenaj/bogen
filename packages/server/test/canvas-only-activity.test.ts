import { afterEach, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h=undefined; });
it('marks only screen placement and canvas-plan changes as canvas-only, including atomic batches',async()=>{
 h=await startServer();const c=await connectAgent(h.base,'placement-scope');try{
 const file=(await call(c,'file_create',{name:'Placement scope'})).id;
 const board=(await call(c,'artboard_create',{file_id:file,name:'Dashboard',width:800,height:600})).id;
 const child=(await call(c,'html_write',{file_id:file,target_id:board,html:'<p>Real content</p>'})).ids[0];
 const events:any[]=[];const off=h.server.hub.tap(e=>{if(e.t==='activity')events.push(e)});
 await call(c,'layer_style',{file_id:file,node_ids:[board],style:{left:'200px',top:'300px'}});expect(events.at(-1).canvasOnly).toBe(true);
 await call(c,'layer_style',{file_id:file,node_ids:[child],style:{left:'20px'}});expect(events.at(-1).canvasOnly).not.toBe(true);
 await call(c,'layer_style',{file_id:file,node_ids:[board],style:{color:'#111111'}});expect(events.at(-1).canvasOnly).not.toBe(true);
 const page=(await call(c,'page_list',{file_id:file}))[0].id;
 await call(c,'canvas_plan_set',{file_id:file,page_id:page,expected_revision:0,sections:[{id:'dashboard',title:'Dashboard',purpose:'Review the overview',lanes:[{title:'Main view',node_ids:[board]}]}]});expect(events.at(-1).canvasOnly).toBe(true);
 await call(c,'batch',{file_id:file,steps:[{tool:'layer_style',args:{node_ids:[board],style:{top:'900px'}}}]});expect(events.at(-1).canvasOnly).toBe(true);
 await call(c,'batch',{file_id:file,steps:[{tool:'layer_style',args:{node_ids:[board],style:{left:'700px'}}},{tool:'layer_text',args:{node_id:child,text:'Changed content'}}]});expect(events.at(-1).canvasOnly).not.toBe(true);
 off();}finally{await c.close()}
});
