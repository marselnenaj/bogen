import { useEffect, useRef, useState } from 'react';
import { KnowledgeSkill, type PersonalSkill } from './KnowledgeSkill.tsx';
import { useT } from '../i18n/react.ts';
import '../styles/design-knowledge.css';

interface Rule { id: string; title: string; when: string; guidance: string; verify: string; repair: string; caveat: string; evidence: string }
interface Recipe { id: string; name: string; useWhen: string; sequence: string[]; requiredContent: string[]; avoid: string[]; template?: string }
interface Playbook { brief: string[]; states: string[]; deliver: string[] }
interface StylePolicy { precedence: string; review: string; rules: { id: string; avoid: string; instead: string; check: string }[] }
interface Catalog { version: string; disciplines: { id: string; name: string; purpose: string }[]; counts: { playbooks: number; rules: number; recipes: number; styleRules: number }; policy: string }
async function get<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/design-knowledge?' + new URLSearchParams(params), { signal });
  if (!response.ok) throw new Error(`Design knowledge: ${response.status}`);
  return response.json() as Promise<T>;
}

/** Metadata loads on demand; the reference remains English independently of the design's language. */
export function DesignKnowledge({ initialDiscipline, embedded = false }: { initialDiscipline?: string; embedded?: boolean } = {}) {
  const t=useT();const [open,setOpen]=useState(embedded),[catalog,setCatalog]=useState<Catalog|null>(null);
  const [selected,setSelected]=useState(initialDiscipline??'foundations'),[query,setQuery]=useState('');
  const [rules,setRules]=useState<Rule[]>([]),[recipes,setRecipes]=useState<Recipe[]>([]),[playbook,setPlaybook]=useState<Playbook|null>(null),[stylePolicy,setStylePolicy]=useState<StylePolicy|null>(null),[effective,setEffective]=useState<PersonalSkill|null>(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[exporting,setExporting]=useState(false),[skill,setSkill]=useState<PersonalSkill|null>(null),[editSkill,setEditSkill]=useState(false),[retry,setRetry]=useState(0);
  const skillButton=useRef<HTMLButtonElement>(null),preview=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(initialDiscipline)setSelected(initialDiscipline);},[initialDiscipline]);
  useEffect(()=>{if(!open)return;const controller=new AbortController();get<Catalog>({action:'catalog'},controller.signal).then(setCatalog).catch((e:Error)=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[open,retry]);
  useEffect(()=>{
    if(!open)return;const controller=new AbortController();setLoading(true);setError('');
    Promise.all([get<{items:Rule[]}>({action:'rules',discipline:selected,limit:'30'},controller.signal),get<{items:Recipe[]}>({action:'recipes',discipline:selected,limit:'30'},controller.signal),get<{playbook:Playbook;workflow:{antiSlop:StylePolicy};skill?:PersonalSkill}>({action:'playbook',discipline:selected},controller.signal)])
      .then(([r,p,b])=>{setRules(r.items);setRecipes(p.items);setPlaybook(b.playbook);setStylePolicy(b.workflow.antiSlop);setEffective(b.skill??null);})
      .catch((e:Error)=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();
  },[open,selected,retry]);
  useEffect(()=>{if(!skill)return;const scroller=preview.current?.closest<HTMLElement>('.settings-content');if(scroller)scroller.scrollTop=0;else preview.current?.scrollIntoView({block:'nearest'});preview.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true});},[skill]);
  const inspect=async(edit=false)=>{setExporting(true);setError('');try{const result=await get<PersonalSkill>({action:'skill',discipline:selected});setEditSkill(edit);setSkill(result);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setExporting(false);}};
  const closeSkill=()=>{setSkill(null);setRetry(n=>n+1);requestAnimationFrame(()=>skillButton.current?.focus({preventScroll:true}));};
  const matches=(item:unknown)=>!query.trim()||JSON.stringify(item).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const content=<div className="knowledge-content">
    {skill?<div ref={preview}><KnowledgeSkill initial={skill} startEditing={editSkill} onClose={closeSkill}/></div>:<>
      {catalog?<p className="hint" lang="en">{catalog.counts.playbooks} playbooks · {catalog.counts.rules} decisions · {catalog.counts.styleRules} anti-slop rules · {catalog.counts.recipes} composition briefs.</p>:null}
      <div className="knowledge-controls"><select aria-label={t('Guide')} value={selected} data-testid="knowledge-discipline" onChange={e=>setSelected(e.target.value)} lang="en">{catalog?.disciplines.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select><input type="search" aria-label={t('Search')} placeholder={t('Search')} value={query} onChange={e=>setQuery(e.target.value)} data-testid="knowledge-search"/><button ref={skillButton} type="button" className="btn btn-quiet" disabled={exporting||!catalog} onClick={()=>void inspect()} data-testid="knowledge-skill">{exporting?t('Reading…'):'SKILL.md'}</button><button type="button" className="btn btn-primary" disabled={exporting||!catalog} onClick={()=>void inspect(true)} data-testid="knowledge-skill-edit-direct">{t('Edit SKILL.md')}</button></div>
      {loading?<p role="status">{t('Reading…')}</p>:<div className="knowledge-results" lang="en" data-testid="knowledge-results">
        {effective?.customized?<section data-testid="knowledge-personal"><p>{t('Custom')} · {t('Personal guidance on this computer. Not synced.')}</p><pre className="knowledge-markdown">{effective.markdown}</pre></section>:<>
        <p>{catalog?.disciplines.find(d=>d.id===selected)?.purpose}</p>
        {playbook&&!query.trim()?<section className="knowledge-brief" data-testid="knowledge-brief"><h3>Working brief</h3><p>Infer these from the request and existing work. Ask only when an answer blocks the task.</p><ul>{playbook.brief.map(s=><li key={s}>{s}</li>)}</ul><details><summary>States and deliverables</summary><p><strong>Consider:</strong> {playbook.states.join(' · ')}</p><p><strong>Deliver:</strong> {playbook.deliver.join(' · ')}</p></details></section>:null}
        {stylePolicy?<details className="knowledge-style" data-testid="knowledge-anti-slop"><summary>{t('Anti-slop rules')} ({stylePolicy.rules.length})</summary><p>{stylePolicy.precedence}</p>{stylePolicy.rules.filter(matches).map(r=><article className="knowledge-rule" key={r.id}><h3>{r.avoid}</h3><p>{r.instead}</p><p><strong>Check:</strong> {r.check}</p></article>)}</details>:null}
        {rules.filter(matches).map(r=><article className="knowledge-rule" key={r.id} data-testid="knowledge-rule"><h3>{r.title}<span className="knowledge-evidence">{r.evidence}</span></h3><p><strong>When:</strong> {r.when}</p><p><strong>Do:</strong> {r.guidance}</p><p><strong>Check:</strong> {r.verify}</p><p><strong>Repair:</strong> {r.repair}</p><p className="hint"><strong>Exception:</strong> {r.caveat}</p></article>)}
        {recipes.filter(matches).map(r=><details className="knowledge-recipe" key={r.id} data-testid="knowledge-recipe"><summary>{r.name}</summary><p>{r.useWhen}</p><ol>{r.sequence.map(s=><li key={s}>{s}</li>)}</ol><p>Needed: {r.requiredContent.join(' · ')}</p><p>Avoid: {r.avoid.join(' · ')}</p>{r.template?<p>Editable starting point: <code>{r.template}</code> through the linked brand’s Templates or <code>template_use</code>.</p>:null}</details>)}
        <p className="hint">Built-in design runs measure affected artboards and allow at most two extra repair turns. Visual review is self-assessment; only the person accepts a proposal or resolves a thread.</p>
        </>}
      </div>}
    </>}
    {error?<div role="alert" className="knowledge-error"><p>{error}</p>{!skill?<button type="button" className="btn" onClick={()=>setRetry(n=>n+1)}>{t('Try again')}</button>:null}</div>:null}
  </div>;
  return embedded?<section className="design-knowledge is-embedded" data-testid="design-knowledge">{content}</section>:<details className="design-knowledge" data-testid="design-knowledge" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>{t('Design knowledge')}</summary>{open?content:null}</details>;
}
