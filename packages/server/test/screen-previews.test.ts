import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';
import { ScreenPreviews, screenFingerprint } from '../src/screen-previews.ts';
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; vi.restoreAllMocks(); });
const raster = { bytes: new Uint8Array([1, 2, 3]), preview: new Uint8Array([4, 5]), cssWidth: 900, cssHeight: 1600, width: 432, height: 768, scale: .48, format: 'webp' as const, mime: 'image/webp' };

function mockBatch(server: Harness['server']) {
 return vi.spyOn(server.renderer, 'screenPreviewBatch').mockImplementation(async fn => fn((doc, id, options) => server.renderer.screenshot(doc, { nodeIds: [id] }, options)));
}

describe('derived screen previews', () => {
 it('pauses without spawning a browser, persists both rasters and rejects another file’s cache key', async () => {
  h = await startServer(); mockBatch(h.server); const agent = await connectAgent(h.base, 'preview-fixture');
  try {
   const file = await call(agent, 'file_create', { name: 'Preview fixture' });
   const board = await call(agent, 'artboard_create', { file_id: file.id, name: 'Long page', width: 900 });
   const page = (await h.server.rooms.get(file.id)).doc.getPages()[0]!.id;
   const memory = vi.spyOn(h.server.memoryGauge, 'level').mockReturnValue('low');
   const render = vi.spyOn(h.server.renderer, 'screenshot').mockResolvedValue(raster);
   const url = `${h.base}/api/files/${file.id}/screen-previews?page=${page}`;
   const pending = await fetch(url).then(r => r.json()); expect(pending.paused).toBe(true);
   await new Promise(r => setTimeout(r, 150)); expect(render).not.toHaveBeenCalled();
   memory.mockReturnValue('ok');
   let ready: any;
   await until(async () => { ready = await fetch(url).then(r => r.json()); return ready.screens[0]?.state === 'ready'; });
   expect(ready.screens[0]).toMatchObject({ id: board.id, width: 900, height: 1600 });
   const largeResponse = await fetch(h.base + ready.screens[0].src);
   const largeBytes = await largeResponse.arrayBuffer(); expect(Array.from(new Uint8Array(largeBytes))).toEqual([1,2,3]);
   const smallResponse = await fetch(h.base + ready.screens[0].smallSrc);
   const smallBytes = await smallResponse.arrayBuffer(); expect(Array.from(new Uint8Array(smallBytes))).toEqual([4,5]);
   const reopened = new ScreenPreviews(h.server);
   expect((await reopened.catalog(file.id, page)).screens[0]?.state).toBe('ready'); await reopened.close();
   await new Promise(r => setTimeout(r, 450)); expect(render).toHaveBeenCalledTimes(1);
   const other = await call(agent, 'file_create', { name: 'Other' });
   expect((await fetch(`${h.base}/api/files/${other.id}/screen-previews/${ready.screens[0].key}`)).status).toBe(404);
   const doc = (await h.server.rooms.get(file.id)).doc;
   const before = screenFingerprint(doc, board.id).fingerprint;
   await call(agent, 'html_write', { file_id: file.id, target_id: board.id, html: '<h1>A real change</h1>' });
   expect(screenFingerprint(doc, board.id).fingerprint).not.toBe(before);
   const changed = await fetch(url).then(r => r.json()); expect(changed.screens[0].key).not.toBe(ready.screens[0].key);
   expect(changed.screens[0].src).toBe(ready.screens[0].src);
   expect((await fetch(h.base + ready.screens[0].src)).status).toBe(200);
   expect((await fetch(`${h.base}/api/files/${file.id}`, { method: 'DELETE' })).status).toBe(200);
   expect(existsSync(join(h.home, 'screen-previews', ready.screens[0].key + '.json'))).toBe(false);
  } finally { await agent.close(); }
 }, 15000);
 it('does not certify an image when the design changed during capture', async () => {
  h = await startServer(); mockBatch(h.server); const agent = await connectAgent(h.base, 'preview-race');
  try {
   const file = await call(agent, 'file_create', { name: 'Concurrent preview' });
   const board = await call(agent, 'artboard_create', { file_id: file.id, name: 'Page' });
   const page = (await h.server.rooms.get(file.id)).doc.getPages()[0]!.id;
   let finish!: () => void; const wait = new Promise<void>(r => finish = r);
   const render = vi.spyOn(h.server.renderer, 'screenshot').mockImplementation(async () => { await wait; return raster; });
   const cache = h.server.screenPreviews; const pending = await cache.catalog(file.id, page);
   await until(() => render.mock.calls.length === 1);
   await call(agent, 'layer_style', { file_id: file.id, node_ids: [board.id], style: { backgroundColor: '#123456' } });
   finish(); await new Promise(r => setTimeout(r, 150));
   expect(await cache.image(file.id, pending.screens[0]!.key, false)).toBeNull();
   expect((await cache.catalog(file.id, page)).screens[0]!.key).not.toBe(pending.screens[0]!.key);
  } finally { await agent.close(); }
 });
 it('paginates beyond 500 screens without starting renders under pressure', async () => {
  h = await startServer(); mockBatch(h.server); const agent = await connectAgent(h.base, 'preview-pagination');
  try {
   const file = await call(agent, 'file_create', { name: 'Many screens' });
   const doc = (await h.server.rooms.get(file.id)).doc, page = doc.getPages()[0]!.id;
   doc.y.transact(() => { for (let i=0;i<505;i++) doc.insert(page, { type:'frame',tag:'main',name:'Screen '+i,artboard:true,style:{width:'200px',height:'300px',overflow:'hidden'} }); });
   vi.spyOn(h.server.memoryGauge, 'level').mockReturnValue('low');
   const render = vi.spyOn(h.server.renderer, 'screenshot').mockResolvedValue(raster);
   const screens = []; let offset: number | null = 0;
   while (offset !== null) {
    const response: Response = await fetch(`${h.base}/api/files/${file.id}/screen-previews?page=${page}&offset=${offset}`);
    expect(response.status).toBe(200); const result: { total: number; screens: { id: string }[]; next: number | null } = await response.json();
    expect(result.total).toBe(505); expect(result.screens.length).toBeLessThanOrEqual(200);
    screens.push(...result.screens); offset=result.next;
   }
   expect(new Set(screens.map(s=>s.id)).size).toBe(505);
   expect((await fetch(`${h.base}/api/files/${file.id}/screen-previews?page=${page}&offset=-1`)).status).toBe(400);
   expect(render).not.toHaveBeenCalled();
  } finally { await agent.close(); }
 });

 it('reuses bounded batches, pauses between screens and resumes without discarding the queue', async () => {
  h = await startServer(); const agent = await connectAgent(h.base, 'preview-batches');
  const memory = vi.spyOn(h.server.memoryGauge, 'level').mockReturnValue('ok');
  const counts: number[] = [];
  vi.spyOn(h.server.renderer, 'screenPreviewBatch').mockImplementation(async fn => {
   let captures=0;
   try { return await fn(async () => { captures++; if(counts.length===0) memory.mockReturnValue('low'); return raster; }); }
   finally { counts.push(captures); }
  });
  try {
   const file=await call(agent,'file_create',{name:'Batch lifetime'}),doc=(await h.server.rooms.get(file.id)).doc,page=doc.getPages()[0]!.id;
   doc.y.transact(()=>{for(let i=0;i<8;i++)doc.insert(page,{type:'frame',tag:'main',artboard:true,name:'Screen '+i,style:{width:'900px',height:'1600px'}});});
   const cache=h.server.screenPreviews;await cache.catalog(file.id,page);
   await until(()=>counts.length===1);expect(counts).toEqual([1]);
   const paused=await cache.catalog(file.id,page);expect(paused.paused).toBe(true);expect(paused.screens.filter(s=>s.state==='pending').length).toBe(7);
   memory.mockReturnValue('ok');
   await until(async()=> (await cache.catalog(file.id,page)).screens.every(s=>s.state==='ready'));
   expect(counts.every(n=>n<=4)).toBe(true);expect(counts.some(n=>n>1)).toBe(true);
  } finally { await agent.close(); }
 },15000);

 it('ends a batch before the next screen when foreground work arrives', async () => {
  h = await startServer(); const agent=await connectAgent(h.base,'preview-foreground');
  vi.spyOn(h.server.memoryGauge,'level').mockReturnValue('ok');
  const busy=vi.spyOn(h.server.renderer,'busy','get').mockReturnValue(false),contended=vi.spyOn(h.server.renderer,'previewContended','get').mockReturnValue(false);
  let captures=0;
  vi.spyOn(h.server.renderer,'screenPreviewBatch').mockImplementation(async fn=>fn(async()=>{captures++;if(captures===1){busy.mockReturnValue(true);contended.mockReturnValue(true);}return raster;}));
  try {
   const file=await call(agent,'file_create',{name:'Foreground priority'}),doc=(await h.server.rooms.get(file.id)).doc,page=doc.getPages()[0]!.id;
   doc.y.transact(()=>{for(let i=0;i<4;i++)doc.insert(page,{type:'frame',tag:'main',artboard:true,name:'Screen '+i,style:{width:'900px',height:'1600px'}});});
   const cache=h.server.screenPreviews;await cache.catalog(file.id,page);await until(()=>captures===1);
   await new Promise(r=>setTimeout(r,450));expect(captures).toBe(1);
   busy.mockReturnValue(false);contended.mockReturnValue(false);
   await until(async()=>(await cache.catalog(file.id,page)).screens.every(s=>s.state==='ready'));
   expect(captures).toBe(4);
  }finally{await agent.close();}
 });

 it('warms an already open large design after edits without waiting for a zoom or catalog request', async () => {
  h=await startServer();mockBatch(h.server);const agent=await connectAgent(h.base,'preview-proactive');
  vi.spyOn(h.server.memoryGauge,'level').mockReturnValue('ok');
  const render=vi.spyOn(h.server.renderer,'screenshot').mockResolvedValue(raster);
  try {
   const file=await call(agent,'file_create',{name:'Warm before navigation'}),doc=(await h.server.rooms.get(file.id)).doc,page=doc.getPages()[0]!.id;const ids:string[]=[];
   doc.y.transact(()=>{for(let i=0;i<3;i++){const id=doc.insert(page,{type:'frame',tag:'main',artboard:true,name:'Screen '+i,style:{width:'900px',height:'1600px'}});ids.push(id);for(let j=0;j<350;j++)doc.insert(id,{type:'text',tag:'p',name:'Text',text:'Content '+j,style:{}});}});
   await until(()=>render.mock.calls.length>=3);
   const cache=h.server.screenPreviews;
   await until(async()=>(await cache.catalog(file.id,page)).screens.every(s=>s.state==='ready'));
   await call(agent,'layer_style',{file_id:file.id,node_ids:[ids[0]],style:{backgroundColor:'#374a39'}});
   await until(()=>render.mock.calls.length>=4);
   expect(render.mock.calls.length).toBe(4);
  }finally{await agent.close();}
 },15000);

});
