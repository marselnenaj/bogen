import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import { api, type Runner, type Status } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { browserHasWebMcp } from '../lib/webmcp-editor.ts';
import { resetSettingsSection, useSettings, type Settings } from '../state/settings.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, NumberField, SelectField, Segmented } from '../ui/controls.tsx';
import { Keys } from '../ui/Keys.tsx';
import { LanguageSelect } from '../i18n/LanguageSelect.tsx';
import { useT } from '../i18n/react.ts';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './settings-sections.ts';
import { MAX_PARALLEL_RUNS } from '@bogen/core';
import { RunChoice, runnerName, saveLimit, useRunnerCatalogs, useRunSettings } from './RunChoice.tsx';
import { DesignKnowledge } from './DesignKnowledge.tsx';
import { SyncSection } from './SyncSection.tsx';
import { PhoneSection } from './PhoneSection.tsx';
import { AddToAgent } from './AddToAgent.tsx';
import { ExtensionSection } from './BrowserExtension.tsx';
import { ReferencesSection } from './ReferencesSection.tsx';
import { TeamsSection } from './TeamsSection.tsx';

const SCALES = [90,100,110,125,150,175,200];
export function SettingsDialog() { return useUi(s => s.settingsOpen) ? <Body /> : null; }
function Row({ name, hint, children }: { name: string; hint?: string; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-label"><div className="settings-name">{name}</div>{hint ? <p className="settings-hint">{hint}</p> : null}</div><div className="settings-control">{children}</div></div>;
}
function Body() {
  const t = useT(), st = useSettings();
  const [section, setSection] = useState<SettingsSectionId>('appearance'), [query,setQuery]=useState(''), [menu,setMenu]=useState(true);
  // Teams stay hidden until the server has the feature teams-1 on.
  const [teamsOn,setTeamsOn]=useState(false);
  useEffect(()=>{void api.status().then(st=>setTeamsOn(Boolean(st.features?.includes('teams-1'))),()=>{});},[]);
  const root=useRef<HTMLDivElement>(null), heading=useRef<HTMLHeadingElement>(null), back=useRef<Element | null>(document.activeElement);
  const close=()=>ui().set({settingsOpen:false});
  useEffect(()=>{
    root.current?.querySelector<HTMLInputElement>('[data-testid="settings-search"]')?.focus();
    const key=(e:KeyboardEvent)=>{
      const target=e.target instanceof Element ? e.target : null;
      if (target?.closest('[role="dialog"]')!==root.current) return;
      if(e.key==='Escape' && !target?.closest('[data-knowledge-skill]')){e.preventDefault();e.stopPropagation();close();}
      if(e.key!=='Tab')return;
      const items=[...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(n=>n.getClientRects().length && !n.closest('[hidden]'));
      const first=items[0],last=items.at(-1);if(!first||!last)return;
      if(e.shiftKey && (document.activeElement===first || document.activeElement===root.current)){e.preventDefault();last.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
    };
    window.addEventListener('keydown',key,true);const previous=back.current;
    return ()=>{window.removeEventListener('keydown',key,true);if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};
  },[]);
  const choose=(id:SettingsSectionId)=>{setSection(id);setMenu(false);requestAnimationFrame(()=>heading.current?.focus({preventScroll:true}));};
  const current=SETTINGS_SECTIONS.find(s=>s.id===section)!;
  const q=query.trim().toLocaleLowerCase();
  const matches=SETTINGS_SECTIONS.filter(s=>s.id!=='teams'||teamsOn).filter(s=>!q || [s.label,t(s.label),s.hint,t(s.hint),...s.keywords.flatMap(k=>[k,t(k)])].join(' ').toLocaleLowerCase().includes(q));
  const set=(patch:Partial<Settings>)=>st.update(patch);
  const resettable=section==='appearance'||section==='canvas'||section==='privacy';
  return <div className="dialog-scrim settings-scrim" data-ui onPointerDown={e=>{if(e.target===e.currentTarget)close();}}>
    <div ref={root} className="dialog settings settings-workspace" role="dialog" aria-modal="true" aria-label={t('Settings')} data-testid="settings-dialog" tabIndex={-1}>
      <header className="dialog-head settings-head"><div className="settings-heading"><button type="button" className="settings-back" onClick={()=>{setMenu(true);requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>(`[data-section="${section}"]`)?.focus());}} data-testid="settings-back" aria-label={t('Back')}><ArrowLeft size={16}/></button><strong className="dialog-title settings-title">{t('Settings')}</strong></div><IconButton icon={<X size={16}/>} title={t('Close ({shortcut})',{shortcut:'Esc'})} onClick={close} testId="settings-close" /></header>
      <div className="settings-body settings-layout" data-menu={menu || undefined}>
        <nav className="settings-nav" aria-label={t('Settings')}>
          <label className="settings-search"><Search size={14} aria-hidden="true"/><input type="search" placeholder={t('Search settings')} aria-label={t('Search settings')} value={query} onChange={e=>setQuery(e.target.value)} data-testid="settings-search"/></label>
          <div className="settings-destinations">{matches.map(s=><button type="button" key={s.id} data-section={s.id} data-testid={`settings-nav-${s.id}`} aria-current={section===s.id?'page':undefined} onClick={()=>choose(s.id)}>{t(s.label)}</button>)}{!matches.length?<p className="settings-hint" role="status">{t('No matching settings')}</p>:null}</div>
          <p className="settings-nav-note">{t('Device preferences stay here. Designs keep their own language and brand.')}</p>
        </nav>
        <section className="settings-content" aria-labelledby="settings-page-title" data-testid="settings-content" key={section}>
          <header className="settings-page-head"><h2 id="settings-page-title" ref={heading} tabIndex={-1}>{t(current.label)}</h2><p>{t(current.hint)}</p></header>
          {section==='appearance'?<>
            <Row name={t('Interface size')} hint={t('Panels, toolbar and dialogs. The canvas is not affected')}><SelectField value={String(st.uiScale)} onChange={v=>set({uiScale:Number(v)})} testId="setting-scale" options={SCALES.map(n=>({value:String(n/100),label:`${n}%`}))}/></Row>
            <Row name={t('Theme')}><SelectField<Settings['appearance']> value={st.appearance} onChange={appearance=>set({appearance})} testId="setting-appearance" options={[{value:'system',label:t('Follow system')},{value:'light',label:t('Light')},{value:'dark',label:t('Dark')}]}/></Row>
            <Row name={t('Interface language')} hint={t('This device only. Automatic follows the system or browser language.')}><LanguageSelect/></Row>
            <Row name={t('Reduce motion')}><SelectField<Settings['motion']> value={st.motion} onChange={motion=>set({motion})} testId="setting-motion" options={[{value:'system',label:t('Follow system')},{value:'reduced',label:t('Reduce motion')}]}/></Row>
          </>:null}
          {section==='canvas'?<>
            <Row name={t('Nudge')} hint={t('How far arrow keys move a layer, and with Shift')}><div className="settings-pair"><NumberField label={t('Arrow')} value={st.nudgeSmall} min={0.1} max={100} step={1} testId="setting-nudge" onChange={nudgeSmall=>set({nudgeSmall})}/><NumberField label={t('Shift')} value={st.nudgeBig} min={1} max={1000} step={1} testId="setting-nudge-big" onChange={nudgeBig=>set({nudgeBig})}/></div></Row>
            <Row name={t('Zoom direction')} hint={t('Which way Ctrl and the wheel zoom')}><Segmented value={st.zoomDirection} onChange={zoomDirection=>set({zoomDirection})} testId="setting-zoom" options={[{value:'normal',label:t('Up zooms in'),title:t('Wheel up zooms in')},{value:'inverted',label:t('Down zooms in'),title:t('Wheel down zooms in')}]}/></Row>
            <Row name={t('Plain wheel')} hint={t('What the wheel does without Ctrl')}><Segmented value={st.wheel} onChange={wheel=>set({wheel})} testId="setting-wheel" options={[{value:'pan',label:t('Pans'),title:t('The wheel pans, Ctrl zooms')},{value:'zoom',label:t('Zooms'),title:t('The wheel zooms')}]}/></Row>
            <Row name={t('Layout grids')}><input type="checkbox" role="switch" aria-label={t('Layout grids')} checked={st.layoutGrids} onChange={e=>set({layoutGrids:e.target.checked})} data-testid="setting-grids"/></Row>
            <Row name={t('Fit screen')} hint={t('Keeps the selected or current artboard in view while the window changes size.')}><Keys combo="shift+3"/></Row>
          </>:null}
          {section==='privacy'?<><Row name={t('Agents in this browser')} hint={browserHasWebMcp()?t('Bogen\'s tools for an agent built into the browser (WebMCP). It asks you before deleting or reaching outside the file'):t('For an agent built into the browser (WebMCP). This browser does not offer it')}><Segmented value={st.webmcp} onChange={webmcp=>set({webmcp})} testId="setting-webmcp" options={[{value:'on',label:t('Allowed'),title:t('Offer Bogen\'s tools through WebMCP')},{value:'off',label:t('Off'),title:t('Offer nothing to agents in this browser')}]}/></Row><ExtensionSection/></>:null}
          {section==='knowledge'?<DesignKnowledge embedded/>:null}
          {section==='references'?<ReferencesSection/>:null}
          {section==='teams'&&teamsOn?<TeamsSection/>:null}
          {section==='agents'||section==='devices'||section==='about'?<HostSettings section={section}/>:null}
          {resettable?<div className="settings-reset"><button type="button" className="btn btn-outline" data-testid="settings-reset" onClick={()=>resetSettingsSection(section)}>{t('Back to defaults')}</button></div>:null}
        </section>
      </div>
    </div>
  </div>;
}
function HostSettings({section}:{section:'agents'|'devices'|'about'}) {
  const t=useT();const [status,setStatus]=useState<Status|null>(null),[runners,setRunners]=useState<Runner[]>([]),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    setError('');let live=true;const load=()=>void api.status().then(s=>{if(live){setStatus(s);setError('');}},(e:Error)=>{if(live)setError(e.message);});load();
    if(section==='agents')void api.runners().then(r=>{if(live)setRunners(r);},(e:Error)=>{if(live)setError(e.message);});
    const off=onServerEvent(e=>{if(e.t==='peers'&&section==='devices')load();});return()=>{live=false;off();};
  },[section,retry]);
  if(error)return <div role="alert"><p className="settings-hint">{error}</p><button type="button" className="btn" onClick={()=>setRetry(n=>n+1)}>{t('Try again')}</button></div>;
  if(section==='agents')return <AgentSettings runners={runners}/>;
  if(!status)return <p role="status">{t('Reading…')}</p>;
  if(section==='devices')return <div className="settings-integrations"><div data-testid="setting-devices">{!status.peers?.length?<p className="settings-hint">{t('No other devices sync with this one')}</p>:null}<SyncSection/></div><PhoneSection/></div>;
  return <section data-testid="setting-version" className="settings-version"><h3>{t('This Bogen')}</h3><p className="settings-version-number">{status.version}</p><p className="settings-hint">{status.update?t('Version {version}. Version {next} is available: {how}',{version:status.version,next:status.update.version,how:status.update.how}):t('Version {version}, up to date as far as this computer knows',{version:status.version})}</p>{status.update?.notes?<a className="btn btn-quiet" href={status.update.notes} target="_blank" rel="noreferrer">{t('What is new')}</a>:null}<VoiceCredits/></section>;
}
/** Credit the call's voices ask for (tiny-voca's dataset is CC BY 4.0). Names and licences stay as written. */
function VoiceCredits() {
  const t=useT();
  return <p className="settings-hint" data-testid="setting-voice-credits" translate="no">{t('Voice')}: <a href="https://huggingface.co/n4ze3m/tiny-voca" target="_blank" rel="noreferrer">tiny-voca</a> by Muhammed Nazeem (Apache-2.0), trained on the <a href="https://huggingface.co/datasets/n4ze3m/tiny-voca" target="_blank" rel="noreferrer">tiny-voca dataset</a> (CC BY 4.0); Piper voice LJ Speech (public domain).</p>;
}
function AgentSettings({runners}:{runners:Runner[]}) {
  const t=useT();const [chosen,setChosen]=useState('claude');useRunnerCatalogs(runners.some(r=>r.id===chosen&&r.available)?[chosen]:[]);
  useEffect(()=>{if(runners.length&&!runners.some(r=>r.id===chosen&&r.available))setChosen(runners.find(r=>r.available)?.id??runners[0]!.id);},[runners,chosen]);
  if(!runners.length)return <div className="settings-integrations" data-testid="setting-agents"><p role="status">{t('Reading…')}</p></div>;
  const current=runners.find(r=>r.id===chosen);
  // One place says which agents are here: the choice itself. Those that are missing say so in the list.
  const hint=current?.available?(current.version?t('Installed: {version}',{version:current.version}):t('Installed')):current?.reason??t('{agent}: not found',{agent:runnerName(chosen)});
  return <div className="settings-integrations" data-testid="setting-agents">
    <Row name={t('Agent')} hint={hint}><SelectField value={chosen} onChange={setChosen} testId="settings-runner" options={runners.map(r=>({value:r.id,label:r.available?runnerName(r.id):t('{agent}, not found',{agent:runnerName(r.id)}),disabled:!r.available}))}/></Row>
    {current?.available?<ModelSettings runner={chosen}/>:null}
    <AddToAgent/>
  </div>;
}
/** Model and effort per kind of run, under named columns, and how many runs a race starts at once. */
function ModelSettings({runner}:{runner:string}) {
  const t=useT();const data=useRunSettings();
  if(!data)return null;
  const id=`settings-models-${runner}`;
  return <section className="settings-models" data-testid="run-settings" aria-labelledby={id}>
    <h3 id={id}>{t('Models for {agent}',{agent:runnerName(runner)})}</h3>
    <div className="settings-model-grid">
      <div className="settings-model-row settings-model-cols" aria-hidden="true"><span/><span>{t('Model')}</span><span>{t('Effort')}</span></div>
      <div className="settings-model-row" role="group" aria-labelledby={`${id}-prompt`}><div className="settings-label"><div className="settings-name" id={`${id}-prompt`}>{t('Ask agent')}</div><p className="settings-hint">{t('Runs you start from the prompt')}</p></div><RunChoice runner={runner} scope="prompt" testId={`settings-${runner}-prompt`}/></div>
      <div className="settings-model-row" role="group" aria-labelledby={`${id}-comment`}><div className="settings-label"><div className="settings-name" id={`${id}-comment`}>{t('Comments')}</div><p className="settings-hint">{t('Runs a comment starts when it names the agent with @')}</p></div><RunChoice runner={runner} scope="comment" testId={`settings-${runner}-comment`}/></div>
      <div className="settings-model-row" role="group" aria-labelledby={`${id}-limit`}><div className="settings-label"><div className="settings-name" id={`${id}-limit`}>{t('Runs at once')}</div><p className="settings-hint">{t('How many runs of this CLI a race starts at once. They share your plan and its limits; the rest wait their turn.')}</p></div><div className="run-choice"><SelectField<string> value={String(data.settings.limits?.[runner] ?? 2)} options={Array.from({length:MAX_PARALLEL_RUNS},(_,i)=>i+1).map(n=>({value:String(n),label:t.n(n,'{count} at once','{count} at once')}))} onChange={v=>void saveLimit(runner,Number(v))} testId={`settings-${runner}-limit`}/></div></div>
    </div>
  </section>;
}
