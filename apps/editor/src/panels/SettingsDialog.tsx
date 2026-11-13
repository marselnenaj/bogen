import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Search, X } from 'lucide-react';
import { api, type Runner, type Status } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { browserHasWebMcp } from '../lib/webmcp-editor.ts';
import { resetSettingsSection, useSettings, type Settings } from '../state/settings.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, NumberField, SelectField, Segmented } from '../ui/controls.tsx';
import { LanguageSelect } from '../i18n/LanguageSelect.tsx';
import { useT } from '../i18n/react.ts';
import { SETTINGS_SECTIONS, type SettingsSectionId } from './settings-sections.ts';
import { runnerName, RunSettingsSection, useRunnerCatalogs } from './RunChoice.tsx';
import { DesignKnowledge } from './DesignKnowledge.tsx';
import { SyncSection } from './SyncSection.tsx';
import { PhoneSection } from './PhoneSection.tsx';
import { AddToAgent } from './AddToAgent.tsx';
import { ExtensionSection } from './BrowserExtension.tsx';
import { ReferencesSection } from './ReferencesSection.tsx';

const SCALES = [90,100,110,125,150,175,200];
export function SettingsDialog() { return useUi(s => s.settingsOpen) ? <Body /> : null; }
function Row({ name, hint, children }: { name: string; hint?: string; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-label"><div className="settings-name">{name}</div>{hint ? <p className="settings-hint">{hint}</p> : null}</div><div className="settings-control">{children}</div></div>;
}
function Body() {
  const t = useT(), st = useSettings();
  const [section, setSection] = useState<SettingsSectionId>('appearance'), [query,setQuery]=useState(''), [menu,setMenu]=useState(true);
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
  const matches=SETTINGS_SECTIONS.filter(s=>!q || [s.label,t(s.label),s.hint,t(s.hint),...s.keywords.flatMap(k=>[k,t(k)])].join(' ').toLocaleLowerCase().includes(q));
  const set=(patch:Partial<Settings>)=>st.update(patch);
  const resettable=section==='appearance'||section==='canvas'||section==='privacy';
  return <div className="dialog-scrim settings-scrim" data-ui onPointerDown={e=>{if(e.target===e.currentTarget)close();}}>
    <div ref={root} className="dialog settings settings-workspace" role="dialog" aria-modal="true" aria-label={t('Settings')} data-testid="settings-dialog" tabIndex={-1}>
      <header className="settings-head"><div className="settings-heading"><button type="button" className="settings-back" onClick={()=>{setMenu(true);requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>(`[data-section="${section}"]`)?.focus());}} data-testid="settings-back" aria-label={t('Back')}><ArrowLeft size={18}/></button><strong className="settings-title">{t('Settings')}</strong></div><span className="settings-head-scope">{t('This device')}</span><IconButton icon={<X size={18}/>} title={t('Close ({shortcut})',{shortcut:'Esc'})} onClick={close} testId="settings-close" /></header>
      <div className="settings-body settings-layout" data-menu={menu || undefined}>
        <nav className="settings-nav" aria-label={t('Settings')}>
          <label className="settings-search"><Search size={16} aria-hidden="true"/><input type="search" placeholder={t('Search settings')} aria-label={t('Search settings')} value={query} onChange={e=>setQuery(e.target.value)} data-testid="settings-search"/></label>
          <div className="settings-destinations">{matches.map(s=><button type="button" key={s.id} data-section={s.id} data-testid={`settings-nav-${s.id}`} aria-current={section===s.id?'page':undefined} onClick={()=>choose(s.id)}>{t(s.label)}</button>)}{!matches.length?<p className="settings-hint" role="status">{t('No matching settings')}</p>:null}</div>
          <p className="settings-nav-note">{t('Device preferences stay here. Designs keep their own language and brand.')}</p>
        </nav>
        <section className="settings-content" aria-labelledby="settings-page-title" data-testid="settings-content" key={section}>
          <header className="settings-page-head"><h1 id="settings-page-title" ref={heading} tabIndex={-1}>{t(current.label)}</h1>{section!=='appearance'&&section!=='canvas'&&section!=='agents'?<p>{t(current.hint)}</p>:null}<span>{t(section==='agents'||section==='devices'||section==='about'?'This computer':'This device')}{section==='appearance'||section==='canvas'||section==='privacy'?` · ${t('Changes apply immediately')}`:''}</span></header>
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
            <section className="settings-explanation"><h2>{t('Fit screen')}</h2><p>{t('Fit screen: the selected or current artboard, held while the window changes')}</p><kbd>Shift+3</kbd></section>
          </>:null}
          {section==='privacy'?<><Row name={t('Agents in this browser')} hint={browserHasWebMcp()?t('Bogen\'s tools for an agent built into the browser (WebMCP). It asks you before deleting or reaching outside the file'):t('For an agent built into the browser (WebMCP). This browser does not offer it')}><Segmented value={st.webmcp} onChange={webmcp=>set({webmcp})} testId="setting-webmcp" options={[{value:'on',label:t('Allowed'),title:t('Offer Bogen\'s tools through WebMCP')},{value:'off',label:t('Off'),title:t('Offer nothing to agents in this browser')}]}/></Row><ExtensionSection/></>:null}
          {section==='knowledge'?<DesignKnowledge embedded/>:null}
          {section==='references'?<ReferencesSection/>:null}
          {section==='agents'||section==='devices'||section==='about'?<HostSettings section={section}/>:null}
        </section>
        <aside className="settings-context" hidden={section!=='appearance'}>{section==='appearance'?<><h2>{t('Preview')}</h2><div className="settings-sample"><strong>{t('Layers')}</strong><div><span>{t('Page')}</span><span className="is-selected">{t('Frame')}</span><span>{t('Text')}</span></div></div><p>{Math.round(st.uiScale*100)}% · {t(st.appearance==='dark'?'Dark':st.appearance==='light'?'Light':'Follow system')}</p></>:<><h2>{t(current.label)}</h2><p>{t(current.hint)}</p></>}</aside>
      </div>
      <footer className="settings-foot">{resettable?<button type="button" className="btn btn-quiet" data-testid="settings-reset" onClick={()=>resetSettingsSection(section)}>{t('Back to defaults')}</button>:null}<span>{t('Esc closes settings')}</span></footer>
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
  return <section data-testid="setting-version" className="settings-version"><h2>{t('This Bogen')}</h2><p className="settings-version-number">{status.version}</p><p className="settings-hint">{status.update?t('Version {version}. Version {next} is available: {how}',{version:status.version,next:status.update.version,how:status.update.how}):t('Version {version}, up to date as far as this computer knows',{version:status.version})}</p>{status.update?.notes?<a className="btn btn-quiet" href={status.update.notes} target="_blank" rel="noreferrer">{t('What is new')}</a>:null}</section>;
}
function AgentSettings({runners}:{runners:Runner[]}) {
  const t=useT();const [chosen,setChosen]=useState('claude');useRunnerCatalogs(runners.some(r=>r.id===chosen&&r.available)?[chosen]:[]);
  useEffect(()=>{if(runners.length&&!runners.some(r=>r.id===chosen&&r.available))setChosen(runners.find(r=>r.available)?.id??runners[0]!.id);},[runners,chosen]);
  return <div className="settings-integrations" data-testid="setting-agents">{!runners.length?<p role="status">{t('Reading…')}</p>:<><Row name={t('Agents on this computer')} hint={t('The model is chosen where you ask an agent.')}><SelectField value={chosen} onChange={setChosen} testId="settings-runner" options={runners.map(r=>({value:r.id,label:runnerName(r.id),disabled:!r.available}))}/></Row><div className="settings-models">{runners.some(r=>r.id===chosen&&r.available)?<RunSettingsSection onlyRunner={chosen}/>:<p className="settings-hint">{runners.find(r=>r.id===chosen)?.reason??t('{agent}: not found',{agent:runnerName(chosen)})}</p>}</div><details className="settings-runner-details"><summary>{t('Agents on this computer')}</summary>{runners.map(r=><div key={r.id} className="settings-runner-row" data-runner={r.id}><strong>{runnerName(r.id)}</strong><span className="settings-hint">{r.available?r.version??t('Available'):r.reason??t('{agent}: not found',{agent:runnerName(r.id)})}</span></div>)}</details><AddToAgent/></>}</div>;
}
