import { afterEach, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
let h:Harness|undefined;afterEach(async()=>{await h?.cleanup();h=undefined});
it('compares in-file design branches without checking them out or opening a legacy file',async()=>{
 h=await startServer();const c=await connectAgent(h.base,'branch-compare');try{
 const file=(await call(c,'file_create',{name:'Design history'})).id;
 const board=(await call(c,'artboard_create',{file_id:file,name:'Home',width:800,height:600})).id;
 const text=(await call(c,'html_write',{file_id:file,target_id:board,html:'<h1>Original</h1>'})).ids[0];
 const branch=(await call(c,'design_branch_create',{file_id:file,name:'New direction'})).branch.id;
 await call(c,'layer_text',{file_id:file,node_id:text,text:'Alternative'});
 await call(c,'design_branch_switch',{file_id:file,branch_id:'main'});
 const res=await fetch(h.base+`/api/files/${file}/compare?from=branch:${branch}&to=now`);expect(res.status).toBe(200);
 const diff=await res.json()as any;expect(diff.same).toBe(false);expect(diff.counts.changed).toBeGreaterThan(0);
 expect((await call(c,'design_branch_list',{file_id:file})).current).toBe('main');expect(h.server.rooms.peek(branch)).toBeUndefined();
 expect((await fetch(h.base+`/api/files/${file}/compare?from=branch:main&to=now`).then(r=>r.json())as any).same).toBe(true);
 }finally{await c.close()}
});
