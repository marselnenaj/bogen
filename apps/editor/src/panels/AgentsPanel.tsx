import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Copy, RotateCcw } from 'lucide-react';
import { api, type StatusAgent } from '../lib/api.ts';
import { editor, useEditor } from '../state/store.ts';
import { copyText, IconButton } from '../ui/controls.tsx';
import { ActivityFeed } from './ActivityFeed.tsx';
import { AgentsCheckSection } from './AgentsCheck.tsx';
import { RunReports } from './BrandFilePanel.tsx';
import { PhoneSection } from './PhoneSection.tsx';
import { RemoteRunsSection } from './RemoteRuns.tsx';
import { RunSettingsSection } from './RunChoice.tsx';
import { RunHistory } from './RunHistory.tsx';
import { RunQueue } from './RunQueue.tsx';
import { SyncSection } from './SyncSection.tsx';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import '../styles/agents-panel.css';

/**
 * The Agents tab. On top, always: who works in this file, with undo, and whether they may show things. Under it
 * one of three parts, and only that one is mounted: what happens (queue, steps, runs), how runs are set up
 * (models, connecting a client, the check), and the other devices (sync, remote runs, the phone).
 */
type Part = 'activity' | 'settings' | 'devices';

const PARTS: { id: Part; label: string }[] = [
  { id: 'activity', label: msg('Activity') },
  { id: 'settings', label: msg('Settings') },
  { id: 'devices', label: msg('Devices') },
];

const NONE: StatusAgent[] = [];

function sameAgents(a: StatusAgent[], b: StatusAgent[]): boolean {
  return a.length === b.length && a.every((x, i) => x.name === b[i]!.name && x.status === b[i]!.status);
}

/**
 * The agents of this file as the server sees them. Asks every few seconds while the page is visible, once more
 * shortly after an agent's step, and never twice at a time; an answer for a file left behind is dropped.
 */
function useFileAgents(fileId: string | null, latestStep: string | undefined): StatusAgent[] {
  const [agents, setAgents] = useState<StatusAgent[]>(NONE);
  const ask = useRef<() => void>(() => {});
  useEffect(() => {
    setAgents(NONE);
    if (!fileId) return;
    let alive = true;
    let asking = false;
    const load = () => {
      if (asking || document.hidden) return;
      asking = true;
      api.status().then((st) => {
        asking = false;
        if (!alive) return;
        const next = st.agents.filter((a) => a.fileId === fileId);
        setAgents((prev) => (sameAgents(prev, next) ? prev : next));
      }, () => {
        asking = false;
        if (alive) setAgents(NONE);
      });
    };
    ask.current = load;
    load();
    const timer = window.setInterval(load, 4000);
    const shown = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', shown);
    return () => {
      alive = false;
      ask.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [fileId]);
  // A burst of steps asks once.
  useEffect(() => {
    if (!latestStep) return;
    const timer = window.setTimeout(() => ask.current(), 150);
    return () => clearTimeout(timer);
  }, [latestStep]);
  return agents;
}

/** Who is here, what they do, undo per agent, and the Follow switch. */
function AgentsNow({ onWorking, onConnect }: { onWorking: (working: boolean) => void; onConnect: () => void }) {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const activity = useEditor((s) => s.activity);
  const peers = useEditor((s) => s.peers);
  const followAgents = useEditor((s) => s.followAgents);
  const agents = useFileAgents(fileId, activity[0]?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) set.add(a.name);
    for (const a of activity) set.add(a.agent);
    for (const p of peers) if (p.user.agent) set.add(p.user.name);
    return [...set];
  }, [agents, activity, peers]);
  const working = useMemo(() => new Set(agents.filter((a) => a.status === 'working').map((a) => a.name)), [agents]);
  const anyWorking = working.size > 0;
  useEffect(() => onWorking(anyWorking), [anyWorking, onWorking]);

  const undoFor = async (agent: string) => {
    if (!fileId) return;
    setBusy(agent);
    setError(null);
    try {
      await api.undoAgent(fileId, agent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="agents-now">
      {names.length ? (
        <ul className="agent-list">
          {names.map((name) => {
            const on = working.has(name);
            return (
              <li key={name} className="agent-row" data-testid="agent-row" data-status={on ? 'working' : 'idle'}>
                <span className={`agent-dot${on ? ' is-working' : ''}`} aria-hidden="true" />
                <span className="agent-name" dir="auto" title={name}>{name}</span>
                <span className={`agent-status${on ? ' is-working' : ''}`}>{on ? t('Working') : t('Idle')}</span>
                <IconButton icon={<RotateCcw size={13} />} title={t('Undo the last edit of {name}', { name })} disabled={busy === name} onClick={() => void undoFor(name)} testId="agent-undo" />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="agents-none">
          <button type="button" className="run-link" onClick={onConnect} data-testid="agents-connect-link">{t('Connect your agent')}</button>
        </div>
      )}
      {error ? <div className="error agents-error" role="alert">{error}</div> : null}
      <label className="agent-follow" title={t('Agents can select layers and bring them into view. They wait while you drag or type.')}>
        <input type="checkbox" checked={followAgents} onChange={(e) => editor().set({ followAgents: e.target.checked })} data-testid="follow-agents" />
        <span>{t('Let agents show me things')}</span>
      </label>
    </div>
  );
}

const MCP_URL = () => `${location.protocol}//${location.host}/mcp`;

/** How to connect a client: folded under its title, opened when asked for from the top of the tab. */
function ConnectAgent({ ask }: { ask: number }) {
  const t = useT();
  const [open, setOpen] = useState(ask > 0);
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ask) return;
    setOpen(true);
    const el = summary.current;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [ask]);
  const url = MCP_URL();
  const rows = [
    { name: 'Claude Code', command: 'bogen install claude-code' },
    { name: 'Codex', command: 'bogen install codex' },
    { name: t('{product} without the installer', { product: 'Claude Code' }), command: `claude mcp add --transport http bogen ${url}` },
    { name: t('Any other client over stdio'), command: 'bogen mcp' },
  ];
  return (
    <details className="connect agents-connect" data-testid="connect-agent" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary ref={summary} className="connect-title agents-fold">
        <ChevronRight size={12} className="agents-fold-mark" aria-hidden="true" />
        <span>{t('Connect your agent')}</span>
      </summary>
      <p className="hint">{t('Your agent draws on this canvas with your own plan. No keys go through this page.')}</p>
      {rows.map((r) => (
        <div key={r.command} className="connect-row">
          <div className="connect-name" dir="auto">{r.name}</div>
          <div className="connect-cmd">
            <code dir="ltr">{r.command}</code>
            <IconButton icon={<Copy size={13} />} title={t('Copy command')} onClick={() => void copyText(r.command).then(() => editor().showToast(t('Command copied')))} />
          </div>
        </div>
      ))}
    </details>
  );
}

/** Said where Sync would be, when no other device syncs. Hidden by the stylesheet as soon as Sync shows. */
function NoSync() {
  const t = useT();
  return (
    <div className="section-plain agents-no-sync" data-testid="agents-no-sync">
      <div className="feed-title">{t('Sync')}</div>
      <div className="hint">{t('No other devices sync with this one')}</div>
    </div>
  );
}

const AgentsPart = memo(function AgentsPart({ part, id, tabId, connectAsk }: { part: Part; id: string; tabId: string; connectAsk: number }) {
  return (
    <div className="agents-pane" role="tabpanel" id={id} aria-labelledby={tabId} data-part={part}>
      {part === 'activity' ? (
        <>
          <RunQueue />
          <ActivityFeed />
          <RunHistory />
          <RunReports />
        </>
      ) : null}
      {part === 'settings' ? (
        <>
          <RunSettingsSection />
          <ConnectAgent ask={connectAsk} />
          <AgentsCheckSection />
        </>
      ) : null}
      {part === 'devices' ? (
        <>
          <SyncSection />
          <NoSync />
          <RemoteRunsSection />
          <PhoneSection />
        </>
      ) : null}
    </div>
  );
});

export function AgentsPanel() {
  const t = useT();
  const base = useId();
  // Each visit starts on Activity, where the queue and its Stop are.
  const [part, setPart] = useState<Part>('activity');
  const [working, setWorking] = useState(false);
  const [connectAsk, setConnectAsk] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const showConnect = useCallback(() => {
    setPart('settings');
    setConnectAsk((n) => n + 1);
  }, []);
  // Asked once: coming back to Settings later does not open it and move the focus again.
  useEffect(() => { if (part !== 'settings') setConnectAsk(0); }, [part]);

  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, at: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') next = at + ((e.key === 'ArrowRight') !== rtl ? 1 : -1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = PARTS.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    next = (next + PARTS.length) % PARTS.length;
    setPart(PARTS[next]!.id);
    tabs.current[next]?.focus();
  };

  const tabId = (p: Part) => `${base}-tab-${p}`;
  const paneId = `${base}-pane`;
  return (
    <div className="agents agents-panel" data-testid="agents-panel">
      <AgentsNow onWorking={setWorking} onConnect={showConnect} />
      <div className="agents-switch">
        <div className="segmented agents-parts" role="tablist" aria-label={t('Agents')}>
          {PARTS.map((p, i) => {
            const active = p.id === part;
            return (
              <button
                key={p.id}
                ref={(el) => { tabs.current[i] = el; }}
                type="button"
                role="tab"
                id={tabId(p.id)}
                aria-selected={active}
                aria-controls={active ? paneId : undefined}
                tabIndex={active ? 0 : -1}
                className={`segment${active ? ' is-active' : ''}`}
                onClick={() => setPart(p.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                data-testid={`agents-part-${p.id}`}
              >
                <span className="agents-part-label">{t(p.label)}</span>
                {p.id === 'activity' && working && !active ? <span className="agents-part-dot" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      </div>
      <AgentsPart part={part} id={paneId} tabId={tabId(part)} connectAsk={connectAsk} />
    </div>
  );
}
