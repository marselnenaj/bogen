import { ProjectKindControl } from './ProjectKind.tsx';
import { RedoScreenAction } from './RedoScreenAction.tsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { exactAppText, motionHandoff, nodeToHtml, textStyleCssFor, toExactApp, toReact, exportDocument, type MotionMode } from '@bogen/core';
import { Check, Copy, MessageSquare, Pencil, SlidersHorizontal, Code2, Download, Bot, Play, History, GitCompareArrows } from 'lucide-react';
import { useComments, useSnapVersion } from '../doc/hooks.ts';
import { CommentsPanel } from './Conversations.tsx';
import { session } from '../doc/session.ts';
import { resolveAsset } from '../lib/api.ts';
import { editor, useEditor, type RightTab } from '../state/store.ts';
import { copyText, Empty, IconButton, Segmented } from '../ui/controls.tsx';
import { AgentsPanel } from './AgentsPanel.tsx';
import '../styles/transfer.css';
import '../styles/inspector-navigation.css';
import { ExportPanel } from './ExportPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { Inspector } from './inspector/Inspector.tsx';
import { commandById, displayKeys } from '../commands/registry.ts';
import { MotionPanel } from './MotionPanel.tsx';
import { EXPORT_PRESETS } from './inspector/presets.ts';
import { unionRects } from '../canvas/geometry.ts';
import { DriftPanel } from './DriftPanel.tsx';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

const TABS: { id: RightTab; label: string; icon: typeof Pencil }[] = [
  { id: 'design', icon: SlidersHorizontal, label: msg('Design') },
  { id: 'code', icon: Code2, label: msg('Code') },
  { id: 'comments', icon: MessageSquare, label: msg('Comments') },
  { id: 'export', icon: Download, label: msg('Export') },
  { id: 'agents', icon: Bot, label: msg('Agents') },
  { id: 'motion', icon: Play, label: msg('Motion') },
  { id: 'history', icon: History, label: msg('History') },
  { id: 'drift', icon: GitCompareArrows, label: msg('Drift') },
];

const TAB_COMMANDS: Partial<Record<RightTab, string>> = { design: 'view.design', code: 'view.code', comments: 'view.comments', export: 'view.export', motion: 'view.motion' };

function tabTitle(label: string, id: RightTab): string {
  const cmd = TAB_COMMANDS[id];
  const c = cmd ? commandById(cmd) : undefined;
  return c ? t('{tab} ({shortcut})', { tab: t(label), shortcut: displayKeys(c) }) : t(label);
}

export function RightPanel() {
  const t = useT();
  const tab = useEditor((s) => s.rightTab);
  const tabList = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => { tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [tab]);
  const threads = useComments();
  const open = threads.filter((th) => !th.resolved).length;
  return (
    <aside className="panel panel-right" aria-label={t('Inspector')} data-testid="right-panel">
      <div ref={tabList} className="tabs inspector-tabs inspector-nav" role="tablist" aria-label={t('Inspector')} onKeyDown={(event) => {
        const backwards = event.key === (document.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft');
        const forwards = event.key === (document.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
        if (!backwards && !forwards && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const current = TABS.findIndex((item) => item.id === tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (current + (backwards ? -1 : 1) + TABS.length) % TABS.length;
        editor().set({ rightTab: TABS[next]!.id });
        tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {TABS.map((item) => (
          <button key={item.id} id={`${panelId}-${item.id}`} type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} aria-controls={`${panelId}-content`} aria-selected={tab === item.id} title={tabTitle(item.label, item.id)} data-active={tab === item.id ? '' : undefined} className={`tab${tab === item.id ? ' is-active' : ''}`} onClick={() => editor().set({ rightTab: item.id })} data-testid={`tab-${item.id}`}>
            <item.icon size={15} aria-hidden="true" /><span className="inspector-tab-label">{t(item.label)}</span>{item.id === 'comments' && open ? <span className="tab-count">{open}</span> : null}
          </button>
        ))}
      </div>
      <header className="inspector-current-panel"><h2>{t(TABS.find(item => item.id === tab)!.label)}</h2><ProjectKindControl /></header>
      <div id={`${panelId}-content`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className="panel-scroll" tabIndex={0}>
        {tab === 'design' ? <><RedoScreenAction/><Inspector /></> : null}
        {tab === 'code' ? <CodePanel /> : null}
        {tab === 'comments' ? <CommentsPanel /> : null}
        {tab === 'export' ? <ExportPanel /> : null}
        {tab === 'agents' ? <AgentsPanel /> : null}
        {tab === 'motion' ? <MotionPanel /> : null}
        {tab === 'history' ? <HistoryPanel /> : null}
        {tab === 'drift' ? <DriftPanel /> : null}
      </div>
    </aside>
  );
}

// Code

/** `exact` is experimental: an Exact app in Contract, one per root (core's exact-export.ts). */
type CodeMode = 'html' | 'react' | 'tailwind' | 'exact';

function highlight(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /("(?:[^"\\]|\\.)*")|(<\/?[a-zA-Z][\w-]*|\/?>)|(\b(?:export|function|return|const)\b)/g;
  let last = 0;
  let key = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index;
    if (i > last) out.push(code.slice(last, i));
    const cls = m[1] ? 'code-str' : m[2] ? 'code-tag' : 'code-kw';
    out.push(<span key={key++} className={cls}>{m[0]}</span>);
    last = i + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const MAX_CODE = 200000;

function CodePanel() {
  const t = useT();
  const selection = useEditor((s) => s.selection);
  const pageId = useEditor((s) => s.pageId);
  const version = useSnapVersion();
  const [mode, setMode] = useState<CodeMode>('html');
  const [motion, setMotion] = useState<MotionMode>('css');
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const { snap, doc } = session();
  const roots = useMemo(() => (selection.length ? selection : pageId ? [...snap.children(pageId)] : []), [selection, pageId, snap, version]);

  useEffect(() => {
    // Generating code is not free on big selections, so it waits for a quiet moment.
    const timer = window.setTimeout(() => {
      const parts: string[] = [];
      const limited = roots.slice(0, 200);
      if (mode === 'exact') {
        // Each root is its own app, which lists what it left out at its end, motion included.
        const text = limited.map((id) => exactAppText(toExactApp(doc, id), resolveAsset)).join('\n');
        setCode(text.length > MAX_CODE ? `${text.slice(0, MAX_CODE)}\n\n${t('… cut here, the selection is large.')}` : text);
        return;
      }
      // Framer Motion is React's; HTML takes the same motion as CSS.
      const moving = mode === 'html' ? motionHandoff(doc, limited, motion === 'framer' ? 'css' : motion) : null;
      for (const id of limited) {
        if (mode === 'html') parts.push(nodeToHtml(doc, id, { indent: true, stripRootPosition: true, resolve: resolveAsset, ...(moving?.layers.size ? { motion: moving } : {}) }));
        // A component comes out as one, with typed props, and an instance as a usage of it.
        else parts.push(toReact(doc, id, mode === 'react' ? 'inline' : 'tailwind', resolveAsset, motion));
      }
      const joined = parts.join('\n');
      const classes = textStyleCssFor(doc, joined);
      const extra = [
        classes ? `/* Text styles this code relies on */\n${classes}` : '',
        moving?.css ? `/* Motion: put this in your style sheet */\n${moving.css}` : '',
        moving?.notes.length ? `/* ${moving.notes.join(' ').replace(/\*\//g, '* /')} */` : '',
      ].filter(Boolean);
      const text = [joined, ...extra].join('\n\n');
      setCode(text.length > MAX_CODE ? `${text.slice(0, MAX_CODE)}\n\n${t('… cut here, the selection is large.')}` : text);
    }, 80);
    return () => clearTimeout(timer);
  }, [roots, mode, motion, doc, version, t]);

  const rendered = useMemo(() => (code.length < 30000 ? highlight(code) : code), [code]);
  const copy = () => void copyText(code).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  });

  return (
    <div className="code-panel" data-testid="code-panel">
      <div className="code-head">
        <Segmented<CodeMode>
          value={mode}
          onChange={setMode}
          testId="code-mode"
          options={[{ value: 'html', label: 'HTML', title: t('HTML with inline styles') }, { value: 'react', label: 'React', title: t('React with inline styles') }, { value: 'tailwind', label: 'Tailwind', title: t('React with Tailwind classes') }, { value: 'exact', label: 'Exact', title: t('Exact app in Contract, experimental') }]}
        />
        <IconButton icon={copied ? <Check size={14} /> : <Copy size={14} />} title={t('Copy code')} onClick={copy} testId="code-copy" />
      </div>
      {mode === 'exact' ? null : <div className="code-motion">
        <span className="param-label">{t('Motion')}</span>
        <Segmented<MotionMode>
          value={mode === 'html' && motion === 'framer' ? 'css' : motion}
          onChange={setMotion}
          testId="code-motion"
          options={[
            { value: 'css', label: 'CSS', title: t('Keyframes, and animation and transition on a class, only without reduced motion') },
            { value: 'framer', label: 'Framer', title: t('Framer Motion props in a MotionConfig that honours reduced motion. React only'), disabled: mode === 'html' },
            { value: 'inline', label: t('Inline'), title: t('Motion as stored, in the inline style') },
          ]}
        />
      </div>}
      {!roots.length ? <Empty title={t('Nothing to show')} hint={t('Select a layer or add something to this page to see its code.')} /> : <pre className="code" data-testid="code-output"><code>{rendered}</code></pre>}
    </div>
  );
}

// Comments: see Conversations.tsx

export { MessageSquare };
