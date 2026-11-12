import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeLibrary } from '../src/design-knowledge/library.ts';
import { disciplineSkill } from '../src/design-knowledge/index.ts';
import { call, callRaw, connectAgent, startServer } from './helpers.ts';

const homes: string[] = [];
const fixture = () => { const home=mkdtempSync(join(tmpdir(),'bogen-skills-'));homes.push(home);return {home,library:new KnowledgeLibrary(home)}; };
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
describe('personal design guidance',()=>{
  it('keeps shipped originals immutable, persists custom Markdown and restores with a recoverable previous version',()=>{
    const {home,library}=fixture(), original=library.skill('websites');
    const saved=library.change({discipline:'websites',revision:original.revision,action:'save',markdown:'# My sites\nUse warm paper and large type.',reason:'The person wants this style for their sites.'},'agent-fixture');
    expect(saved.customized).toBe(true);expect(library.skill('websites',true).markdown).toBe(disciplineSkill('websites'));
    expect(new KnowledgeLibrary(home).skill('websites')).toEqual(saved);
    expect(readFileSync(saved.path,'utf8')).toBe(saved.markdown);
    const playbook=library.read({action:'playbook',discipline:'websites'}) as any;
    expect(playbook.skill.markdown).toBe(saved.markdown);expect(playbook.instructionPriority).toContain('not competing');
    expect(library.skill('widgets').customized).toBe(false);
    const restored=library.change({discipline:'websites',revision:saved.revision,action:'restore',reason:'The person requests the original.'},'person');
    expect(restored.customized).toBe(false);expect(restored.markdown).toBe(original.markdown);
    const history=readdirSync(join(home,'design-knowledge','websites','history')).map(n=>JSON.parse(readFileSync(join(home,'design-knowledge','websites','history',n),'utf8')));
    expect(history).toHaveLength(2);expect(history.find(h=>h.action==='restore').previous.markdown).toBe(saved.markdown);expect(history.find(h=>h.action==='save').actor).toBe('agent-fixture');
  });
  it('rejects concurrent changes and ambiguous edits without losing either version',()=>{
    const {library}=fixture(), original=library.skill('widgets');
    const saved=library.change({discipline:'widgets',revision:original.revision,action:'save',markdown:'# Widgets\nplain plain',reason:'A durable preference.'},'person');
    expect(()=>library.change({discipline:'widgets',revision:original.revision,action:'save',markdown:'stale draft',reason:'Stale editor.'},'agent')).toThrow('changed since');
    expect(()=>library.change({discipline:'widgets',revision:saved.revision,action:'save',edits:[{before:'plain',after:'quiet'}],reason:'Ambiguous edit.'},'agent')).toThrow('exactly once');
    expect(()=>library.change({discipline:'widgets',revision:saved.revision,action:'save',edits:[{before:'missing',after:'quiet'}],reason:'Wrong passage.'},'agent')).toThrow('exactly once');
    expect(library.skill('widgets')).toEqual(saved);
    const changed=library.change({discipline:'widgets',revision:saved.revision,action:'save',edits:[{before:'plain plain',after:'quiet type'}],reason:'The user prefers quieter typography.'},'agent');
    expect(changed.markdown).toBe('# Widgets\nquiet type');
    writeFileSync(changed.path,'# Edited by an external agent\nKeep flat surfaces.');
    expect(library.skill('widgets').markdown).toContain('external agent');
    expect(()=>library.change({discipline:'widgets',revision:changed.revision,action:'restore',reason:'Stale restore.'},'person')).toThrow('changed since');
  });
  it('rejects invalid targets, empty guidance and mutually exclusive write modes',()=>{
    const {library}=fixture(), original=library.skill('widgets');
    expect(()=>library.skill('../outside')).toThrow('Unknown design discipline');
    for(const extra of [{markdown:' '},{markdown:'x'.repeat(64001)},{},{markdown:'x',edits:[{before:'x',after:'y'}]}])expect(()=>library.change({discipline:'widgets',revision:original.revision,action:'save',reason:'A request.',...extra},'person')).toThrow();
    expect(library.skill('widgets')).toEqual(original);
  });
  it('uses the same personal guidance through HTTP, MCP and download, and respects access and stale revisions',async()=>{
    const {home}=fixture(),h=await startServer({thumbnails:false},home),client=await connectAgent(h.base,'personal-skill-agent');
    try {
      const original=await call(client,'design_knowledge',{action:'skill',discipline:'social'});
      const custom=await call(client,'design_knowledge_update',{discipline:'social',revision:original.revision,action:'save',edits:[{before:'# Social graphics',after:'# Personal social graphics'}],reason:'The user wants a personal social style.'});
      expect(custom.customized).toBe(true);
      const current=await(await fetch(h.base+'/api/design-knowledge?action=skill&discipline=social')).json();expect(current).toEqual(custom);
      expect(await(await fetch(h.base+'/api/design-knowledge?action=skill&discipline=social&download=1')).text()).toBe(custom.markdown);
      const remote=await(await fetch(h.base+'/api/design-knowledge?action=skill&discipline=social',{headers:{'X-Forwarded-For':'192.0.2.2'}})).json();expect(remote.markdown).toBe(original.markdown);expect(remote.path).toBeUndefined();
      expect((await call(client,'design_knowledge',{action:'original',discipline:'social'})).markdown).toBe(original.markdown);
      expect((await callRaw(client,'design_knowledge_update',{discipline:'social',revision:original.revision,action:'restore',reason:'A stale update.'})).isError).toBe(true);
      const patch={discipline:'social',revision:custom.revision,action:'restore',reason:'The person restores the original.'};
      expect((await fetch(h.base+'/api/design-knowledge',{method:'PATCH',headers:{'Content-Type':'application/json','X-Forwarded-For':'192.0.2.2'},body:JSON.stringify(patch)})).status).toBe(403);
      const restored=await fetch(h.base+'/api/design-knowledge',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});expect(restored.status).toBe(200);expect((await restored.json()).customized).toBe(false);
      expect((await fetch(h.base+'/api/design-knowledge',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)})).status).toBe(409);
    } finally {await client.close();await h.cleanup();}
  });
});
