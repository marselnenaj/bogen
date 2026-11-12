import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCommand, type RunRequest } from '../src/agents.ts';
import { prepareRunKnowledge, runDiscipline } from '../src/run-knowledge.ts';
import { startServer, type Harness } from './helpers.ts';
import { listRevisions } from '@bogen/core';

describe('effective skills reach built-in canvas runs',()=>{
 let h:Harness,file:string,page:string,screen:string,child:string;
 beforeAll(async()=>{h=await startServer({thumbnails:false});file=h.server.createFile('Skill scope fixture').id;const {doc}=await h.server.rooms.get(file);page=doc.getPages()[0]!.id;screen=doc.insert(page,{type:'frame',artboard:true,attrs:{'data-bogen-discipline':'pitch-decks'},style:{}});child=doc.insert(screen,{type:'text',text:'Original message',style:{}});});
 afterAll(async()=>{await h.cleanup();});
 const req=(patch:Partial<RunRequest>={}):RunRequest=>({runner:'claude',fileId:file,fileName:'Fixture',pageId:page,prompt:'Make the hierarchy clearer',nodeIds:[child],...patch});
 it('chooses a selected screen’s real discipline for a short follow-up, with explicit new-task words taking precedence',async()=>{
  const {doc}=await h.server.rooms.get(file);expect(runDiscipline(req(),doc)).toBe('pitch-decks');expect(runDiscipline(req({prompt:'Design a website'}),doc)).toBe('websites');
  doc.meta.set('project',{type:'website'});expect(runDiscipline(req({nodeIds:[]}),doc)).toBe('websites');
 });
 it('loads the current personal content afresh, injects it into Claude, Codex and OpenCode commands, and stores only metadata in history',async()=>{
  const original=h.server.knowledge.skill('pitch-decks');const personal=h.server.knowledge.change({discipline:'pitch-decks',revision:original.revision,action:'save',markdown:'# Personal deck\nLead with customer evidence, use quiet type.',reason:'The person prefers evidence before decoration.'},'fixture-person');
  const prepared=await prepareRunKnowledge(h.server,req());expect(prepared.designGuidance?.markdown).toBe(personal.markdown);
  for(const runner of ['claude','codex','opencode'] as const){const c=buildCommand(runner,{...prepared,runner},{url:h.base+'/mcp'},'/tmp/config.json','/tmp');expect(c.args.join(' ')+'\n'+c.stdin).toContain(personal.markdown);expect(c.args.join(' ')+'\n'+c.stdin).toContain(personal.revision);}
  h.server.history.started('guidedfixture',prepared);const record=await h.server.history.get(file,'guidedfixture');expect(record?.knowledge).toEqual({discipline:'pitch-decks',revision:personal.revision,customized:true});expect(JSON.stringify(record)).not.toContain(personal.markdown);
  h.server.knowledge.change({discipline:'pitch-decks',revision:personal.revision,action:'save',edits:[{before:'quiet type',after:'strong editorial type'}],reason:'The person changed their preference.'},'fixture-person');expect((await prepareRunKnowledge(h.server,req())).designGuidance?.markdown).toContain('strong editorial type');
 });
 it('central server preparation includes the skill without a paid model call and leaves repository live runs alone',async()=>{
  const prepared=await h.server.runs.prepare!(req({review:'critique'}));expect(prepared.designGuidance?.discipline).toBe('pitch-decks');
  const live=req({live:{dir:'/tmp',mcpUrl:h.base,instructions:'Local repository rules',label:'Fixture'}});expect(await prepareRunKnowledge(h.server,live)).toBe(live);
 });
 it('prepares an explicit screen redo as one scoped revision while keeping files, pages and the original intact',async()=>{
  const {doc}=await h.server.rooms.get(file);
  const other=doc.insert(page,{type:'frame',name:'Another screen',artboard:true,style:{width:'640px',height:'480px'}});
  const files=h.server.storage.list().length,pages=doc.getPages().length,original=doc.getNode(child);
  const prepared=await h.server.runs.prepare!(req({intent:'revise',nodeIds:[screen],conversationId:'explicit-screen-redo',prompt:'Redo only the selected screen. Keep the content; use a quieter composition.'}));
  expect(prepared.intent).toBe('revise');
  expect(prepared.revision?.artboards).toHaveLength(1);
  expect(prepared.revision?.artboards[0]?.original).toBe(screen);
  expect(prepared.revision?.artboards[0]?.copy).not.toBe(screen);
  const revision=listRevisions(doc).find(r=>r.id===prepared.revision?.id)!;
  expect(revision.targets).toEqual([screen]);
  expect(revision.targets).not.toContain(other);
  expect(doc.getNode(child)).toEqual(original);
  expect(h.server.storage.list()).toHaveLength(files);
  expect(doc.getPages()).toHaveLength(pages);
  expect(prepared.designGuidance?.discipline).toBe('pitch-decks');
  const continued=await h.server.runs.prepare!({...prepared,prompt:'Keep refining this revision.'});
  expect(continued.revision?.id).toBe(revision.id);
  expect(continued.revision?.reused).toBe(true);
 });
 it('passes an explicit app classification to agents even when OS theme records or colours are present',async()=>{
  const {doc}=await h.server.rooms.get(file);doc.meta.set('omarchyTheme',{name:'Legacy palette',target:'desktop'});doc.meta.set('project',{type:'app',platforms:['ios','android']});
  const prepared=await prepareRunKnowledge(h.server,req({nodeIds:[],prompt:'Continue refining the current screen.'}));
  expect(prepared.project).toEqual({type:'app',platforms:['ios','android'],source:'person'});expect(prepared.designGuidance?.discipline).toBe('mobile-apps');
  const command=buildCommand('codex',prepared,{url:h.base+'/mcp'},'/tmp/config.json','/tmp');
  expect(command.args.join(' ')+'\n'+command.stdin).toContain('Project classification: app (ios, android); source: person');
 });

});
