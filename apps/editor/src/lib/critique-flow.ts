import { create } from 'zustand';
import { critiqueMet, getCritiques, updateCritique, type BogenDoc, type CritiqueRecord } from '@bogen/core';
import { LOCAL, maybeSession } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { t } from '../i18n/store.ts';
import { api } from './api.ts';
import { agentApi } from './agent-api.ts';
import { conversationFor } from './conversation.ts';
import { onServerEvent } from './events.ts';
import { critiqueApi, type CritiqueJob, type CritiqueStart } from './critique.ts';
import { dropActivity, putActivity, activity } from './activity.ts';
import { playSound } from '../call/call-sounds.ts';
import { sendPrompt } from '../panels/prompt-actions.ts';
import { rememberChatOpen } from '../panels/chat-state.ts';

/**
 * Review like a designer, outside its dialog: the review that runs for a file, the fix run that takes its findings
 * on, and the loop that has a new reviewer look after each fix. All of it keeps going when the dialog closes, and
 * shows as a pill in the dock at the foot of the window (lib/activity.ts) until the person opens it again.
 */

export interface FixRun {
  runId: string | null;
  runner: string;
  startedAt: number;
  endedAt?: number;
  state: 'running' | 'done' | 'failed' | 'stopped';
  defects: number;
  taste: number;
  /** The findings it took on, by title. */
  titles?: string[];
  /** Whether the run changed any layer: a run that ended with open work but changed things still gets a new review. */
  edited?: boolean;
  error?: string;
}
export interface ReviewLoop { series: string; until: number; maxRounds: number }
export interface FileFlow {
  fileId: string;
  fileName: string;
  job: CritiqueJob | null;
  fix: FixRun | null;
  loop: ReviewLoop | null;
  /** Why the loop stopped, for the dialog. */
  loopNote?: string;
}

interface FlowStore { files: Record<string, FileFlow> }
export const useCritiqueFlow = create<FlowStore>(() => ({ files: {} }));

export function flowOf(fileId: string): FileFlow | undefined { return useCritiqueFlow.getState().files[fileId]; }
function setFlow(fileId: string, patch: Partial<FileFlow>): FileFlow {
  const now = flowOf(fileId) ?? { fileId, fileName: '', job: null, fix: null, loop: null };
  const next = { ...now, ...patch };
  useCritiqueFlow.setState((s) => ({ files: { ...s.files, [fileId]: next } }));
  syncActivities(fileId);
  return next;
}

const routeFile = () => /^#\/file\/([\w-]+)/.exec(location.hash)?.[1] ?? null;
/** Whether the dialog shows this file's review right now, so its pill would only repeat it. */
export function dialogShows(fileId: string): boolean {
  return ui().critiqueOpen && editor().fileId === fileId && routeFile() === fileId;
}

/** Opens the file, if another is in front, and the review's dialog. */
export function openReview(fileId: string): void {
  if (routeFile() !== fileId) location.hash = `#/file/${fileId}`;
  ui().set({ critiqueOpen: true });
}

// ---------------------------------------------------------------- the review

let poller = 0;
function follow(): void {
  if (poller) return;
  poller = window.setInterval(() => {
    const running = Object.values(useCritiqueFlow.getState().files).filter((f) => f.job?.state === 'running');
    if (!running.length) { window.clearInterval(poller); poller = 0; return; }
    for (const f of running) {
      const id = f.job!.id;
      void critiqueApi.job(id).then((job) => {
        if (flowOf(f.fileId)?.job?.id !== id) return;
        setFlow(f.fileId, { job });
        if (job.state !== 'running') reviewEnded(f.fileId, job);
      }, (e: Error) => {
        // The server restarted, or the job is gone: say so instead of waiting for ever.
        if (/gone|No such/.test(e.message) && flowOf(f.fileId)?.job?.id === id) setFlow(f.fileId, { job: { ...f.job!, state: 'failed', error: e.message, endedAt: Date.now() } });
      });
    }
    syncAll();
  }, 1000);
}

export async function startReview(fileId: string, fileName: string, req: Omit<CritiqueStart, 'fileId'>): Promise<CritiqueJob> {
  const job = await critiqueApi.start({ ...req, fileId });
  setFlow(fileId, { fileName, job, loopNote: undefined });
  follow();
  return job;
}

export async function stopReview(fileId: string): Promise<void> {
  const f = flowOf(fileId);
  if (!f?.job || f.job.state !== 'running') return;
  setFlow(fileId, { loop: null });
  const job = await critiqueApi.cancel(f.job.id).catch(() => f.job!);
  setFlow(fileId, { job: { ...job, state: job.state === 'running' ? 'stopped' : job.state, endedAt: job.endedAt ?? Date.now() } });
}

/** The record a job wrote, once the file's copy here has it. */
async function recordOf(fileId: string, recordId: string): Promise<CritiqueRecord | null> {
  for (let i = 0; i < 40; i++) {
    const s = maybeSession();
    if (!s || s.fileId !== fileId) return null;
    const r = getCritiques(s.doc).find((x) => x.id === recordId);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 150));
  }
  return null;
}

function reviewEnded(fileId: string, job: CritiqueJob): void {
  if (job.state === 'done' && !dialogShows(fileId)) playSound('moved');
  const f = flowOf(fileId);
  if (!f?.loop || job.state !== 'done' || !job.recordId) {
    if (f?.loop && job.state !== 'done') setFlow(fileId, { loop: null, loopNote: t('The loop stopped: the review did not finish.') });
    return;
  }
  void (async () => {
    const record = await recordOf(fileId, job.recordId!);
    const loop = flowOf(fileId)?.loop;
    if (!loop) return;
    if (!record) return void setFlow(fileId, { loop: null, loopNote: t('Open the file to continue the loop.') });
    if (critiqueMet(record)) return void setFlow(fileId, { loop: null, loopNote: t('Done in round {round}: no objective defect, {score} of 10.', { round: record.round, score: record.score }) });
    if (record.round >= record.maxRounds) return void setFlow(fileId, { loop: null, loopNote: t('Stopped after round {round} with {count} defects open.', { round: record.round, count: record.defects.length }) });
    try {
      await fixFindings({ fileId, record, defects: record.defects.map((_, i) => i), taste: [], loop });
    } catch (e) {
      setFlow(fileId, { loop: null, loopNote: (e as Error).message });
    }
  })();
}

// ---------------------------------------------------------------- fixing

/** The agent and model the chat in this file uses, which a fix run uses too. */
export async function chatAgent(): Promise<{ runner: string; label: string; model?: string; effort?: string } | null> {
  let saved: string | null = null;
  try { saved = localStorage.getItem('bogen-prompt-runner'); } catch { /* the first available one */ }
  const runners = (await api.runners()).filter((r) => r.available);
  const runner = runners.find((r) => r.id === saved)?.id ?? runners[0]?.id;
  if (!runner) return null;
  const answer = await agentApi.runSettings().catch(() => null);
  const { model, effort } = answer?.settings.runners[runner]?.prompt ?? {};
  const name = runner === 'codex' ? 'Codex' : runner === 'claude' ? 'Claude' : runner.charAt(0).toUpperCase() + runner.slice(1);
  const modelLabel = model && model !== 'default' ? answer?.catalogs[runner]?.models.find((m) => m.id === model)?.label ?? model : '';
  return { runner, label: modelLabel ? `${name} · ${modelLabel}` : name, ...(model && model !== 'default' ? { model } : {}), ...(effort && effort !== 'default' ? { effort } : {}) };
}

const screenName = (r: CritiqueRecord, n: number) => (r.screens[n - 1]?.name ?? String(n)).split(/\s[·|–—]\s/)[0]!.slice(0, 60);

/** The brief a fix run gets: each chosen finding with its evidence, its layer and the fix, and what to leave alone. */
export function fixBrief(r: CritiqueRecord, defects: number[], taste: number[]): string {
  const lines = [
    `Fix these findings from an independent design review (${r.reviewer}, round ${r.round}) of ${r.screens.length} screen${r.screens.length === 1 ? '' : 's'}: ${r.screens.map((s) => `"${s.name}" (${s.id})`).join(', ')}.`,
    'Change only what each finding needs. Keep what the review says to keep. Do not restyle anything else.',
  ];
  if (defects.length) {
    lines.push('', 'Objective defects:');
    defects.forEach((i, n) => {
      const d = r.defects[i];
      if (!d) return;
      const where = d.screens.map((s) => screenName(r, s)).join(', ');
      lines.push(`${n + 1}. ${d.title}${where ? ` (on ${where})` : ''}${d.nodeId ? `, layer ${d.nodeId}` : ''}.`, `   Evidence: ${d.evidence}`, ...(d.fix ? [`   Suggested fix: ${d.fix}`] : []));
    });
  }
  if (taste.length) {
    lines.push('', 'Taste notes the person chose to have done too:');
    for (const i of taste) { const n = r.taste[i]; if (n) lines.push(`- ${n.title}: ${n.detail}`); }
  } else lines.push('', 'Only the objective defects above. Leave the taste notes alone; the person did not choose them.');
  if (r.keep.length) lines.push('', 'Keep:', ...r.keep.map((k) => `- ${k}`));
  lines.push('', 'When done, say in one line per finding what you changed. Do not call design_critique again; the editor manages any loop the person explicitly chose. Run design_lint and fix hard findings.');
  return lines.join('\n');
}

/** How far a fix reaches: the layers its findings point at (a whole artboard counts with everything in it) and their pages. */
export function fixScope(doc: BogenDoc, r: CritiqueRecord, defects: number[], taste: number[]): { layers: number; pages: number } {
  const ids = new Set<string>();
  const pages = new Set<string>();
  const add = (id: string | undefined) => {
    if (!id || !doc.getNode(id)) return;
    const node = doc.getNode(id)!;
    const all = node.artboard ? [id, ...doc.descendants(id).map((n) => n.id)] : [id];
    for (const x of all) ids.add(x);
    const page = doc.pageOf(id);
    if (page) pages.add(page);
  };
  for (const i of defects) { const d = r.defects[i]; if (d) add(d.nodeId ?? r.screens[(d.screens[0] ?? 1) - 1]?.id); }
  for (const i of taste) { const n = r.taste[i]; if (n) for (const s of n.screens?.length ? n.screens : [1]) add(r.screens[s - 1]?.id); }
  return { layers: ids.size, pages: pages.size };
}

export interface FixRequest { fileId: string; record: CritiqueRecord; defects: number[]; taste: number[]; loop?: ReviewLoop | null }

/**
 * Starts the agent on the chosen findings at once, with the chat's agent and model: no draft to send. In this file
 * the run shows in the chat as any request does; elsewhere it runs on the server and the chat shows it when the
 * person comes back. The findings are marked as taken on, so the next reviewer checks them.
 */
export async function fixFindings(req: FixRequest): Promise<void> {
  const { fileId, record } = req;
  if (!req.defects.length && !req.taste.length) throw new Error(t('Choose a finding to fix.'));
  if (flowOf(fileId)?.fix?.state === 'running') throw new Error(t('A fix is already running in this file.'));
  const agent = await chatAgent();
  if (!agent) throw new Error(t('Install {claude} or {codex} to fix findings.', { claude: 'claude', codex: 'codex' }));
  const brief = fixBrief(record, req.defects, req.taste);
  const display = req.taste.length
    ? t('Fix {defects} defects and {taste} taste notes from the review', { defects: req.defects.length, taste: req.taste.length })
    : t.n(req.defects.length, 'Fix {count} defect from the review', 'Fix {count} defects from the review');
  const s = maybeSession();
  const here = s?.fileId === fileId;
  const nodeIds = [...new Set(req.defects.map((i) => record.defects[i]?.nodeId).filter((x): x is string => Boolean(x && (!here || s!.doc.getNode(x)))))];
  let runId: string | null = null;
  const state = editor();
  if (here && state.fileId === fileId && routeFile() === fileId) {
    if (state.prompt.running) throw new Error(t('The agent is still working in this file. Wait for it, or stop it, then fix.'));
    // The chat shows the run as any request; it opens without taking the focus from the dialog.
    rememberChatOpen(fileId, true);
    state.set({ minimal: false, prompt: { ...state.prompt, open: true, nodeIds } });
    // Always a change run, never in the chat's current mode: a fix that went out as a critique would change nothing.
    await sendPrompt(brief, agent.runner, { intent: 'edit', ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}), title: display }, { display, runnerLabel: agent.runner });
    const after = editor();
    const last = after.prompt.messages.at(-1);
    if (last?.role === 'error') throw new Error(last.text);
    runId = after.prompt.runId;
  } else {
    runId = (await api.startRun({ fileId, nodeIds, prompt: brief, title: display, intent: 'edit', runner: agent.runner, conversationId: conversationFor(fileId), ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}) })).runId;
  }
  if (here && s) {
    const at = Date.now();
    updateCritique(s.doc, record.id, (rec) => ({
      ...rec,
      defects: rec.defects.map((d, i) => (req.defects.includes(i) ? { ...d, addressed: at } : d)),
      taste: rec.taste.map((n, i) => (req.taste.includes(i) ? { ...n, addressed: at } : n)),
    }), LOCAL);
  }
  setFlow(fileId, { fileName: flowOf(fileId)?.fileName || fileNameNow(fileId), fix: { runId, runner: agent.runner, startedAt: Date.now(), state: 'running', defects: req.defects.length, taste: req.taste.length, titles: [...req.defects.map((i) => record.defects[i]?.title ?? ''), ...req.taste.map((i) => record.taste[i]?.title ?? '')].filter(Boolean) }, loop: req.loop ?? null, loopNote: undefined });
  if (!runId) {
    // The chat started it but the id is still on the way: the chat's own state tells when it ends.
    waitForChat(fileId);
  }
}

function fileNameNow(fileId: string): string {
  return editor().fileId === fileId ? editor().fileName : '';
}

/** A run started from the chat whose id arrives a moment later. */
function waitForChat(fileId: string): void {
  const tick = window.setInterval(() => {
    const f = flowOf(fileId);
    if (!f?.fix || f.fix.state !== 'running' || f.fix.runId) return window.clearInterval(tick);
    const p = editor().prompt;
    if (editor().fileId === fileId && p.runId) { setFlow(fileId, { fix: { ...f.fix, runId: p.runId } }); window.clearInterval(tick); }
  }, 250);
}

/** Runs the person stopped: their end reads as stopped, not failed. */
const stopping = new Set<string>();
export async function stopFix(fileId: string): Promise<void> {
  const f = flowOf(fileId);
  if (!f?.fix || f.fix.state !== 'running') return;
  if (f.fix.runId) stopping.add(f.fix.runId);
  setFlow(fileId, { loop: null });
  if (f.fix.runId) await api.stopRun(f.fix.runId).catch(() => undefined);
  const now = flowOf(fileId)!;
  if (now.fix?.state === 'running') setFlow(fileId, { fix: { ...now.fix, state: 'stopped', endedAt: Date.now() } });
}

export function stopLoop(fileId: string): void { setFlow(fileId, { loop: null, loopNote: t('The loop stops after this step.') }); }

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  onServerEvent((e) => {
    if (e.t === 'activity' && e.runId) {
      const f = Object.values(useCritiqueFlow.getState().files).find((x) => x.fix?.state === 'running' && x.fix.runId === e.runId && !x.fix.edited);
      if (f?.fix) setFlow(f.fileId, { fix: { ...f.fix, edited: true } });
      return;
    }
    if (e.t !== 'agent' || (e.kind !== 'done' && e.kind !== 'error')) return;
    const f = Object.values(useCritiqueFlow.getState().files).find((x) => x.fix?.state === 'running' && x.fix.runId === e.runId);
    if (!f?.fix) { stopping.delete(e.runId); return; }
    const stopped = stopping.delete(e.runId);
    const state = stopped ? 'stopped' : e.kind === 'done' ? 'done' : 'failed';
    setFlow(f.fileId, { fix: { ...f.fix, state, endedAt: Date.now(), ...(e.kind === 'error' && e.text ? { error: e.text } : {}) } });
    const loop = flowOf(f.fileId)?.loop;
    // A run that changed layers but ended with work it reports as open (its own self-check) still gets the new
    // reviewer: that review is the check that counts. A run that changed nothing does not.
    const reviewable = state === 'done' || (state === 'failed' && f.fix.edited);
    if (!reviewable || !loop) {
      if (loop) setFlow(f.fileId, { loop: null, loopNote: state === 'stopped' ? t('Stopped. The loop ends here.') : t('The fix run did not finish, so no new review started.') });
      return;
    }
    if (state === 'failed') setFlow(f.fileId, { loopNote: t('The agent reported open work after its changes; a new reviewer looks at them.') });
    // A new reviewer, who has not seen the round before, looks at the fixed screens.
    const last = flowOf(f.fileId)?.job;
    void startReview(f.fileId, f.fileName, { reviewer: 'auto', series: loop.series, until: loop.until, maxRounds: loop.maxRounds, ...(last?.screenIds?.length ? { screens: last.screenIds } : {}) })
      .catch((err: Error) => setFlow(f.fileId, { loop: null, loopNote: err.message }));
  });
}
listen();

// ---------------------------------------------------------------- the pills

function syncAll(): void { for (const id of Object.keys(useCritiqueFlow.getState().files)) syncActivities(id); }

/** Keeps this file's pills in the dock in step with its review and fix run. */
function syncActivities(fileId: string): void {
  const f = flowOf(fileId);
  if (!f) return;
  const where = f.fileName || t('this file');
  const rid = `review:${fileId}`;
  const job = f.job;
  if (job) {
    const who = job.reviewer ?? t('The reviewer');
    const n = job.screens;
    const pictures = Array.from({ length: Math.min(3, job.rendered ?? 0) }, (_, i) => critiqueApi.picture(job.id, i + 1));
    const round = f.loop ? ` · ${t('loop to {until}', { until: f.loop.until })}` : '';
    const prior = activity(rid);
    if (job.state === 'running') {
      // The kind of work and its file as the title; the stage, as the dialog's stages name it, under it.
      const stage = job.step === 'queued' ? t('Waiting for the current review to finish') : job.step === 'writing' ? t('{reviewer} is writing it up', { reviewer: who })
        : job.step === 'reviewer' ? t('{reviewer} is looking', { reviewer: who })
        : job.step === 'pictures' ? t('Pictures {done} of {count}', { done: job.rendered ?? 0, count: n })
        : t('Rule checks');
      putActivity({ id: rid, kind: 'review', state: 'running', title: where, stopLabel: t('Stop the review'), detail: `${t('Review')} · ${stage}${round}`, startedAt: job.startedAt, pictures, open: () => openReview(fileId), stop: () => void stopReview(fileId), covered: () => dialogShows(fileId) });
    } else if (job.state === 'done') {
      putActivity({ id: rid, kind: 'review', state: 'done', title: t('Review done · {score}', { score: job.score ?? '' }), detail: `${t.n(job.defects ?? 0, '{count} defect', '{count} defects')} · ${where}${round}`, startedAt: job.startedAt, endedAt: job.endedAt ?? Date.now(), ...(job.score !== undefined ? { score: job.score } : {}), pictures, open: () => openReview(fileId), covered: () => dialogShows(fileId) });
    } else if (job.state === 'stopped') {
      // The person stopped it: nothing to come back to.
      dropActivity(rid);
    } else if (prior || job.state === 'failed') {
      putActivity({ id: rid, kind: 'review', state: job.state, title: t('The review did not finish'), detail: job.error ?? where, startedAt: job.startedAt, endedAt: job.endedAt ?? Date.now(), open: () => openReview(fileId), covered: () => dialogShows(fileId) });
    }
  }
  const fid = `fix:${fileId}`;
  const fix = f.fix;
  if (fix) {
    const agent = fix.runner === 'codex' ? 'Codex' : fix.runner === 'claude' ? 'Claude' : fix.runner;
    const what = fix.taste ? t('{defects} defects, {taste} taste notes', { defects: fix.defects, taste: fix.taste }) : t.n(fix.defects, '{count} defect', '{count} defects');
    const loopLine = f.loop ? ` · ${t('then a new review')}` : '';
    if (fix.state === 'running') putActivity({ id: fid, kind: 'fix', state: 'running', stopLabel: t('Stop the fix'), title: where, detail: `${t('{agent} is fixing {what}', { agent, what })}${loopLine}`, startedAt: fix.startedAt, open: () => openReview(fileId), stop: () => void stopFix(fileId), covered: () => dialogShows(fileId) });
    // Once the next review runs, it carries the story on; a fix the person stopped needs no pill.
    else if ((job && job.startedAt > fix.startedAt) || fix.state === 'stopped') dropActivity(fid);
    else {
      const changed = fix.state === 'done' || fix.edited;
      putActivity({ id: fid, kind: 'fix', state: changed ? 'done' : 'failed', title: changed ? t('{agent} fixed {what}', { agent, what }) : t('The fix did not finish'), detail: changed ? where : fix.error ?? where, startedAt: fix.startedAt, endedAt: fix.endedAt ?? Date.now(), open: () => openReview(fileId), covered: () => dialogShows(fileId) });
    }
  }
}

/** How long the reviewer takes: the range of the last reviews in this file, or the usual three to five minutes. */
export function expectedRange(records: CritiqueRecord[]): { lo: number; hi: number } {
  const times = records.slice(0, 5).map((r) => r.durationMs).filter((ms) => ms > 20_000);
  if (times.length < 2) return { lo: 3, hi: 5 };
  const lo = Math.max(1, Math.floor(Math.min(...times) / 60_000));
  return { lo, hi: Math.max(lo + 1, Math.ceil(Math.max(...times) / 60_000)) };
}

/** The choice of "Then review again until 7.5", kept while the editor is open, so closing the dialog keeps it. */
let loopChosen = false;
export function loopChoice(): boolean { return loopChosen; }
export function setLoopChoice(on: boolean): void { loopChosen = on; }
