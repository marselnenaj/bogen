import { useEffect, useState, useSyncExternalStore } from 'react';
import { Square, Wand2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { agentApi, type DisplayChoices, type ThemeInfo, type WallpaperStatus } from '../lib/agent-api.ts';
import { collabApi } from '../lib/collab-api.ts';
import { conversationFor } from '../lib/conversation.ts';
import { onServerEvent } from '../lib/events.ts';
import { history } from '../lib/history-api.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { useT } from '../i18n/react.ts';
import type { Translate } from '../i18n/core.ts';
import { isDesigned, PORTRAIT_ASPECT, portraitNeed, portraitRequests, type AgentChoice } from './portrait-request.ts';

/** The prompt's own runner choice: what it asks unless the person picks another there. */
const RUNNER_KEY = 'bogen-prompt-runner';

/** The prompt shows a run of the open file; another file's request is followed in the queue. */
function promptOf(fileId: string) {
  const s = editor();
  return s.fileId === fileId ? s : null;
}

const requests = portraitRequests({
  savedRunner: () => {
    try {
      return localStorage.getItem(RUNNER_KEY);
    } catch {
      return null;
    }
  },
  fileBusy: async (fileId) => {
    if (promptOf(fileId)?.prompt.running) return true;
    // The server refuses a second run in a file anyway; asking first keeps the checkpoint and the shape from happening.
    const queue = await collabApi.queue().catch(() => null);
    return Boolean(queue?.running.some((r) => r.fileId === fileId));
  },
  runners: () => api.runners(),
  runSettings: () => agentApi.runSettings(),
  checkpoint: (fileId, message) => history.commit(fileId, message, session().user.name),
  addDisplays: (fileId, add) => agentApi.addThemeDisplays(fileId, add),
  displays: (fileId) => agentApi.themeDisplays(fileId),
  findBoard: (prefix) => {
    for (const n of session().snap.nodes.values()) if (n.artboard && n.name.startsWith(prefix)) return { id: n.id, name: n.name };
    return undefined;
  },
  pageOf: (id) => session().snap.pageOf(id),
  conversationId: (fileId) => conversationFor(fileId),
  beforeStart: (fileId, nodeIds, title) => {
    const s = promptOf(fileId);
    if (s) s.set({ prompt: { ...s.prompt, nodeIds, running: true, runId: null, messages: [...s.prompt.messages, { role: 'user', text: title }] } });
  },
  startRun: async (body) => {
    const out = await api.startRun(body);
    const s = promptOf(body.fileId);
    if (s?.prompt.running) s.set({ prompt: { ...s.prompt, runId: out.runId } });
    return out;
  },
  startFailed: (fileId, message) => {
    const s = promptOf(fileId);
    if (s) s.set({ prompt: { ...s.prompt, running: false, runId: null, messages: [...s.prompt.messages, { role: 'error', text: message }] } });
  },
  stopRun: async (runId) => { await collabApi.stopRun(runId); },
});

/** Runs end while the dialog is closed too: listened for from the first time the section shows, for good. */
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  onServerEvent((e) => {
    if (e.t === 'agent' && (e.kind === 'done' || e.kind === 'error')) requests.ended(e.fileId, e.runId, e.kind, e.text);
  });
}

/** "… but the 9:16 layout still …", for a state that is not done: one whole sentence per state, for translation. */
function stillLine(t: Translate, agent: string, status: WallpaperStatus): string {
  switch (status) {
    case 'artwork': return t('{agent} finished, but the 9:16 layout still has its own artwork.', { agent });
    case 'composed': return t('{agent} finished, but the 9:16 layout still is composed.', { agent });
    case 'needs-design': return t('{agent} finished, but the 9:16 layout still needs its own design.', { agent });
    case 'mismatch': return t('{agent} finished, but the 9:16 layout still shows a picture of another shape.', { agent });
    case 'unverified': return t('{agent} finished, but the 9:16 layout still shows a picture of unknown size.', { agent });
    case 'missing': return t('{agent} finished, but the 9:16 layout still has no composition.', { agent });
  }
}

/**
 * "Add 9:16 layout": asks the prompt's agent to compose the 9:16 wallpaper of this desktop theme, in this file, on its
 * existing 9:16 board, after a checkpoint in the History. Shown while the 9:16 shape is missing or not designed.
 */
export function PortraitRequest({ fileId, info, choices, onChanged }: { fileId: string; info: ThemeInfo; choices: DisplayChoices | null; onChanged: () => void }) {
  const t = useT();
  const phase = useSyncExternalStore(requests.subscribe, () => requests.get(fileId));
  const promptRunning = useEditor((s) => s.fileId === fileId && s.prompt.running);
  const [agent, setAgent] = useState<AgentChoice | null>(null);
  const [after, setAfter] = useState<WallpaperStatus | 'checking' | null>(null);
  const [stopping, setStopping] = useState(false);
  const need = portraitNeed(info);
  const endedRun = phase.at === 'ended' ? phase.runId : null;

  useEffect(listen, []);
  useEffect(() => {
    let live = true;
    void requests.preview().then((a) => { if (live) setAgent(a); }, () => { if (live) setAgent(null); });
    return () => { live = false; };
  }, [fileId, phase.at]);

  // Once the run ends, the composition's state is asked again: it says whether the work is done, not the agent.
  useEffect(() => {
    setStopping(false);
    if (!endedRun) return setAfter(null);
    let live = true;
    setAfter('checking');
    void agentApi.themeDisplays(fileId).then((r) => {
      if (live) setAfter(r.wallpapers.find((w) => w.aspect === PORTRAIT_ASPECT)?.status ?? 'missing');
    }, () => { if (live) setAfter(null); });
    onChanged();
    return () => { live = false; };
  }, [endedRun]);

  if (!need.show && (phase.at === 'idle' || phase.at === 'choose' || phase.at === 'failed')) return null;
  const going = phase.at === 'starting' || phase.at === 'running';
  const chooseAgent = () => {
    ui().set({ omarchyThemeOpen: false });
    const s = editor();
    s.set({ prompt: { ...s.prompt, open: true } });
  };
  const stop = async () => {
    setStopping(true);
    try {
      await requests.stop(fileId);
    } catch (e) {
      setStopping(false);
      editor().showToast((e as Error).message);
    }
  };

  let line: React.ReactNode = null;
  let alert = false;
  if (phase.at === 'running') line = stopping ? t('Stopping {agent}.', { agent: phase.agent }) : t('{agent} is composing the 9:16 layout in this file.', { agent: phase.agent });
  else if (phase.at === 'choose') line = phase.why;
  else if (phase.at === 'failed') { line = phase.error; alert = true; }
  else if (phase.at === 'ended') {
    if (phase.outcome === 'failed') { line = phase.error ?? t('{agent} stopped with an error.', { agent: phase.agent }); alert = true; }
    else if (phase.outcome === 'stopped') line = t('Stopped. What it changed so far stays; the History has the version from before.');
    else if (after === 'checking' || after === null) line = t('{agent} finished. Checking the 9:16 layout.', { agent: phase.agent });
    else if (isDesigned(after)) line = t('The 9:16 layout is designed. It is in the next export or install; nothing was installed or applied.');
    else line = stillLine(t, phase.agent, after);
  }

  return (
    <div className="omarchy-portrait-request" data-testid="omarchy-portrait-request" data-phase={phase.at}>
      {need.show || going ? (
        <div className="omarchy-actions">
          {!need.wallpaper && !going ? <span className="settings-hint">{t('No 9:16 layout yet.')}</span> : null}
          <button type="button" className="btn" disabled={going || promptRunning || agent?.ok === false} aria-busy={going} onClick={() => void requests.start(fileId, info, choices)} data-testid="omarchy-portrait-request-start">
            <Wand2 size={14} /> {going ? (phase.at === 'starting' ? t('Starting') : t('Working')) : t('Add 9:16 layout')}
          </button>
          {phase.at === 'running' ? <button type="button" className="btn btn-quiet" disabled={stopping} onClick={() => void stop()} data-testid="omarchy-portrait-request-stop"><Square size={12} /> {t('Stop')}</button> : null}
          {phase.at === 'running' || phase.at === 'choose' || (!going && agent?.ok === false) ? (
            <button type="button" className="run-link" onClick={chooseAgent} data-testid="omarchy-portrait-request-prompt">{phase.at === 'running' ? t('Show progress') : t('Choose an agent')}</button>
          ) : null}
        </div>
      ) : null}
      {!going && phase.at !== 'choose' && need.show ? (
        <div className="settings-hint" data-testid="omarchy-portrait-request-agent">
          {promptRunning ? t('A run is going in this file. Wait for it to finish.') : agent?.ok ? t("Asks {agent} to compose it here, from the theme's palette and artwork.", { agent: agent.label }) : agent ? agent.why : null}
        </div>
      ) : null}
      {line ? <div className={alert ? 'error' : 'omarchy-note'} role={alert ? 'alert' : 'status'} aria-live="polite" data-testid="omarchy-portrait-request-status">{line}</div> : null}
    </div>
  );
}
