import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/react.ts';

export interface PersonalSkill { markdown: string; discipline: string; customized: boolean; revision: string }
async function readSkill(discipline: string, action = 'skill'): Promise<PersonalSkill> {
  const response = await fetch('/api/design-knowledge?' + new URLSearchParams({ action, discipline }));
  if (!response.ok) throw new Error(`SKILL.md: ${response.status}`);
  return response.json();
}
const draftKey = (id: string) => `bogen-skill-draft:${id}`;
function draftOf(skill: PersonalSkill) {
  try { const d = JSON.parse(sessionStorage.getItem(draftKey(skill.discipline)) ?? 'null');
    if (d && typeof d.markdown === 'string' && typeof d.revision === 'string') return d as {markdown:string;revision:string};
  } catch { /* A missing or unavailable draft never prevents reading the skill. */ }
  return null;
}

export function KnowledgeSkill({ initial, startEditing = false, onClose }: { initial: PersonalSkill; startEditing?: boolean; onClose: () => void }) {
  const t = useT(), root = useRef<HTMLElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const [saved, setSaved] = useState(initial), [draft, setDraft] = useState(() => draftOf(initial));
  const [editing, setEditing] = useState(() => startEditing || Boolean(draftOf(initial))), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [copied, setCopied] = useState(false), [done, setDone] = useState(false);
  const [original, setOriginal] = useState<string | null>(null), [restore, setRestore] = useState(false);
  const text = draft?.markdown ?? saved.markdown, base = draft?.revision ?? saved.revision;
  const dirty = text !== saved.markdown, conflict = Boolean(draft && base !== saved.revision);
  const remember = (markdown: string, revision = base) => {
    const next = { markdown, revision }; setDraft(next); setDone(false); setCopied(false);
    try { sessionStorage.setItem(draftKey(initial.discipline), JSON.stringify(next)); } catch { /* Editing still works in memory. */ }
  };
  const clearDraft = () => { setDraft(null); try { sessionStorage.removeItem(draftKey(initial.discipline)); } catch { /* unavailable */ } };
  useEffect(() => { if (editing) editor.current?.focus({preventScroll:true}); }, [editing]);
  const loadCurrent = async () => { setBusy(true); setError(''); try { setSaved(await readSkill(initial.discipline)); } catch(e) {setError(String(e));} finally {setBusy(false);} };
  const change = async (action: 'save' | 'restore') => {
    setBusy(true); setError(''); setDone(false);
    try {
      const response = await fetch('/api/design-knowledge', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ discipline:initial.discipline, revision:base, action, ...(action==='save'?{markdown:text}:{}), reason:action==='save'?'The person edited this discipline’s personal guidance.':'The person restored the shipped guidance.' }) });
      if (!response.ok) {
        if (response.status === 409) { const latest=await readSkill(initial.discipline);if(!draft)remember(text,base);setSaved(latest);setEditing(true);setRestore(false);throw new Error(t('Compare your draft with the saved version before keeping your edits.')); }
        const body = await response.json().catch(()=>({})); throw new Error(body.error ?? `SKILL.md: ${response.status}`);
      }
      setSaved(await response.json()); clearDraft(); setEditing(false); setOriginal(null); setRestore(false); setDone(true);
    } catch(e) { setError(e instanceof Error?e.message:String(e)); } finally { setBusy(false); }
  };
  const copy = async () => {
    setError('');
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch {
      if (editing) editor.current?.select();
      else { const pre=root.current?.querySelector('pre'), selection=window.getSelection();if(pre&&selection){const range=document.createRange();range.selectNodeContents(pre);selection.removeAllRanges();selection.addRange(range);} }
      try {if(document.execCommand('copy')){setCopied(true);return;}}catch{/* Leave the text selected. */}
      setError(t('Copy is unavailable. Select the text to copy it.'));
    }
  };
  return <section ref={root} className="knowledge-skill" data-knowledge-skill data-testid="knowledge-skill-preview" aria-label="SKILL.md" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}}}>
    <header className="knowledge-skill-head"><button type="button" className="btn btn-quiet" onClick={onClose} data-testid="knowledge-skill-back">{t('Back')}</button><strong>SKILL.md</strong><span className="hint" lang="en">bogen-{initial.discipline}</span><span className="hint" data-testid="knowledge-skill-source">{t(saved.customized?'Custom':'Original')}</span></header>
    <p className="hint">{t('Personal guidance on this computer. Not synced.')}</p>
    <div className="knowledge-skill-actions">
      {!editing?<button type="button" className="btn" disabled={busy} onClick={()=>{setEditing(true);setRestore(false);setDone(false);}} data-testid="knowledge-skill-edit">{t('Edit')}</button>:<>
        <button type="button" className="btn" disabled={busy||!dirty||!text.trim()||conflict} onClick={()=>void change('save')} data-testid="knowledge-skill-save">{t('Save')}</button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={()=>{clearDraft();setEditing(false);setError('');}} data-testid="knowledge-skill-discard">{t('Discard')}</button>
      </>}
      <button type="button" className="btn" onClick={()=>void copy()} data-testid="knowledge-skill-copy">{t(copied?'Copied':'Copy')}</button>
      {dirty?<button type="button" className="btn" disabled>{t('Download')}</button>:<a className="btn" href={'/api/design-knowledge?'+new URLSearchParams({action:'skill',discipline:initial.discipline,download:'1'})} download={`bogen-${initial.discipline}-SKILL.md`} data-testid="knowledge-skill-download">{t('Download')}</a>}
      <button type="button" className="btn btn-quiet" disabled={busy} onClick={()=>{if(original!==null)setOriginal(null);else {setBusy(true);void readSkill(initial.discipline,'original').then(s=>setOriginal(s.markdown),(e:Error)=>setError(e.message)).finally(()=>setBusy(false));}}} data-testid="knowledge-skill-original">{t('Original')}</button>
      {!editing&&saved.customized?<button type="button" className="btn btn-quiet" disabled={busy} onClick={()=>setRestore(true)} data-testid="knowledge-skill-restore">{t('Restore {name}',{name:t('Original')})}</button>:null}
    </div>
    {editing?<p className="hint">{t('Drafts stay in this tab until you save or discard them.')} <button type="button" className="run-link" disabled={busy} onClick={()=>void loadCurrent()} data-testid="knowledge-skill-reload">{t('Compare with now')}</button></p>:null}
    {conflict?<section className="knowledge-conflict" role="alert"><strong>{t('Changed on both sides')}</strong><p>{t('Compare your draft with the saved version before keeping your edits.')}</p><details open><summary>{t('Compare with now')}</summary><pre className="knowledge-markdown" data-testid="knowledge-skill-current">{saved.markdown}</pre></details><button type="button" className="btn" disabled={busy} onClick={()=>{remember(text,saved.revision);setError('');}} data-testid="knowledge-skill-keep">{t('Keep my edits')}</button></section>:null}
    {restore?<div className="knowledge-conflict" role="group"><p>{t('Restore {name}',{name:t('Original')})}?</p><button type="button" className="btn" disabled={busy} onClick={()=>void change('restore')} data-testid="knowledge-skill-restore-confirm">{t('Restore {name}',{name:t('Original')})}</button><button type="button" className="btn btn-quiet" onClick={()=>setRestore(false)}>{t('Cancel')}</button></div>:null}
    {error&&!conflict?<p role="alert" className="knowledge-error">{error}</p>:null}
    {done?<p role="status">{t('Saved')}</p>:null}
    {editing?<textarea ref={editor} className="knowledge-markdown knowledge-editor" aria-label="SKILL.md" value={text} maxLength={64000} disabled={busy} onChange={e=>remember(e.target.value)} spellCheck={false} data-testid="knowledge-skill-editor"/>:<pre className="knowledge-markdown" tabIndex={0} lang="en" data-testid="knowledge-skill-text"><code>{saved.markdown}</code></pre>}
    {original!==null?<details open className="knowledge-original"><summary>{t('Original')}</summary><pre className="knowledge-markdown" lang="en" data-testid="knowledge-skill-original-text">{original}</pre></details>:null}
  </section>;
}
