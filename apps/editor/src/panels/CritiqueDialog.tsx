import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { CRITIQUE_DIMENSIONS, critiqueMet, getCritiques, updateCritique, type BogenDoc, type CritiqueFinding, type CritiqueRecord, type CritiqueDimension } from '@bogen/core';
import { LOCAL, session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { IconButton } from '../ui/controls.tsx';
import { critiqueApi, type CritiqueStatus, type Reviewer } from '../lib/critique.ts';
import { chatAgent, expectedRange, fixFindings, loopChoice, setLoopChoice, startReview, stopFix, stopLoop, stopReview, useCritiqueFlow } from '../lib/critique-flow.ts';
import { elapsed } from '../lib/activity.ts';
import { CritiqueWall, type WallBoard } from './CritiqueWall.tsx';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';
import '../styles/critique.css';

/**
 * Review like a designer. Start: what to review and who reviews it. Waiting: the person's own screens on a wall with
 * a reading light, the real stage and the clock. Results: the crit sheet, the score's ring, the dimensions, the
 * defects with where they are, taste and keep, the rounds. Fix starts the agent at once. The dialog always closes
 * (X, Escape, the backdrop); a running review goes on in the dock at the foot of the window. Designed in Bogen:
 * "Bogen Brand System", page "Design critique", artboards D2 to D4.
 */

const DIMENSION: Record<CritiqueDimension, string> = {
  state: msg('State clarity'), consistency: msg('Consistency'), hierarchy: msg('Hierarchy'), copy: msg('Text'), layout: msg('Layout'), brand: msg('Brand'),
};
const KIND: Record<string, string> = {
  state: msg('State'), consistency: msg('Across screens'), copy: msg('Text'), colour: msg('Colour'), brand: msg('Brand'), layout: msg('Layout'),
  hierarchy: msg('Hierarchy'), naming: msg('Naming'), generated: msg('Reads as generated'), craft: msg('Craft'),
};
const REVIEWER: Record<Reviewer, string> = { auto: msg('Automatic'), fable: msg('Fable'), opus: msg('Opus'), sonnet: msg('Sonnet') };
const STAGES = ['rules', 'pictures', 'reviewer', 'writing'] as const;
const LOOP_TARGET = 7.5;
const LOOP_ROUNDS = 3;
/** More than this many layers, or more than one page, and a fix asks once, in the dialog. */

function selectLayer(id: string): void {
  const { doc } = session();
  if (!doc.getNode(id)) return;
  const pageId = doc.pageOf(id);
  editor().set({ ...(pageId ? { pageId } : {}), selection: [id] });
}

function useCritiques(): CritiqueRecord[] {
  const doc = session().doc;
  const subscribe = useMemo(() => (notify: () => void) => { doc.meta.observe(notify); return () => doc.meta.unobserve(notify); }, [doc]);
  const read = useMemo(() => () => JSON.stringify(getCritiques(doc).map((r) => [r.id, r.defects.map((d) => `${d.threadId ?? ''}${d.addressed ?? ''}`), r.taste.map((n) => n.addressed ?? '')])), [doc]);
  const key = useSyncExternalStore(subscribe, read);
  return useMemo(() => getCritiques(doc), [key, doc]); // eslint-disable-line react-hooks/exhaustive-deps
}

const px = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) && n > 0 ? n : 0; };
function boardsOf(doc: BogenDoc, ids: { id: string; name: string }[]): WallBoard[] {
  return ids.map(({ id, name }) => {
    const n = doc.getNode(id);
    return { id, name: n?.name || name, width: px(n?.style?.width) || 390, height: px(n?.style?.height) || px(n?.style?.minHeight) || 780 };
  });
}
const shortName = (name: string) => name.split(/\s[·|–—]\s/)[0]!.slice(0, 40);

/** A second, ticking while something runs. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

export default function CritiqueDialog() {
  const t = useT();
  const s = session();
  const fileId = s.fileId;
  const pageId = useEditor((st) => st.pageId);
  const selection = useEditor((st) => st.selection);
  const fileName = useEditor((st) => st.fileName);
  const records = useCritiques();
  const flow = useCritiqueFlow((st) => st.files[fileId]);
  const job = flow?.job ?? null;
  const running = job?.state === 'running';
  const fixing = flow?.fix?.state === 'running';
  const [status, setStatus] = useState<CritiqueStatus | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [mode, setMode] = useState<'start' | 'result'>(running || fixing || records.length ? 'result' : 'start');
  const [scope, setScope] = useState<'page' | 'selection'>('page');
  const [reviewer, setReviewer] = useState<Reviewer>('auto');
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);

  const close = () => ui().set({ critiqueOpen: false });
  const check = async () => { try { setStatus(await critiqueApi.status()); } catch (e) { setStatus({ state: 'missing', message: (e as Error).message }); } };
  useEffect(() => { void check(); }, []);

  // Always closable: Escape here, before anything under the dialog can take it, and the focus kept inside.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const dialog = root.current;
    // The dialog itself takes the focus: Tab goes to its first control, and no ring shows on a mouse open.
    requestAnimationFrame(() => dialog?.focus({ preventScroll: true }));
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab' && dialog) {
        const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((el) => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); if (back?.isConnected) back.focus({ preventScroll: true }); };
  }, []);

  // A review that ends while the dialog shows it opens on its result.
  const ended = job && job.state === 'done' ? job.recordId : null;
  useEffect(() => { if (ended) { setShown(ended); setMode('result'); } }, [ended]);
  useEffect(() => { if (job?.state === 'failed') setError(job.error ?? t('The review stopped.')); }, [job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const doc = s.doc;
  const boardsOnPage = pageId ? doc.getChildren(pageId).filter((n) => n.artboard && !n.hidden) : [];
  const selectedBoards = [...new Set(selection.map((id) => [id, ...doc.ancestors(id)].find((a) => doc.getNode(a)?.artboard)).filter((x): x is string => Boolean(x)))];
  const pageName = pageId ? doc.pages.get(pageId)?.get('name') as string | undefined : undefined;

  const start = async () => {
    setError(null);
    try {
      await startReview(fileId, fileName, { reviewer, ...(scope === 'selection' && selectedBoards.length ? { screens: selectedBoards } : pageId ? { pageId } : {}) });
      setMode('result');
    } catch (e) { setError((e as Error).message); }
  };

  const record = records.find((r) => r.id === shown) ?? records[0];
  const unavailable = status && status.state !== 'ready' && !running;
  const waiting = running && job;
  const view = unavailable ? 'unavailable' : waiting ? 'waiting' : mode === 'start' || !record ? 'start' : 'result';
  const title = view === 'result' && record ? t('Design critique · {count} screens', { count: record.screens.length }) : t('Review like a designer');

  // On the body, above the editor's panels, so the scrim steps all of the editor back.
  return createPortal(
    // The backdrop closes on the click, not on the press: closing on the press let the click land on the editor below.
    <div className="dialog-scrim crit-scrim" data-ui onPointerDown={(e) => { pressed.current = e.target === e.currentTarget; }} onClick={(e) => { if (pressed.current && e.target === e.currentTarget) close(); pressed.current = false; }} data-testid="critique-scrim">
      <div ref={root} tabIndex={-1} className={`dialog critique-dialog is-${view}`} role="dialog" aria-modal="true" aria-labelledby="crit-title" data-testid="critique-dialog">
        <header className="dialog-head crit-head-bar">
          <h2 className="dialog-title" id="crit-title">{title}</h2>
          <IconButton icon={<X size={16} />} title={view === 'waiting' || fixing ? t('Close, it keeps running ({shortcut})', { shortcut: 'Esc' }) : t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="critique-close" />
        </header>

        {view === 'unavailable' ? (
          <div className="crit-body" data-testid="critique-unavailable">
            <p className="crit-lead">{t('Review like a designer runs on Claude Code, on your own plan, so no key is needed.')}</p>
            <p className="crit-note">{status?.message ?? t('Install Claude Code and sign in, then check again. Run checks works without it.')}</p>
            <footer className="crit-foot"><button type="button" className="btn btn-primary" onClick={() => void check()} data-testid="critique-recheck">{t('Check again')}</button></footer>
          </div>
        ) : view === 'waiting' ? (
          <Waiting fileId={fileId} records={records} onStop={() => void stopReview(fileId)} />
        ) : view === 'start' ? (
          <div className="crit-body crit-start">
            <CritiqueWall job={null} boards={boardsOf(doc, (scope === 'selection' && selectedBoards.length ? selectedBoards : boardsOnPage.map((n) => n.id)).slice(0, 16).map((id) => ({ id, name: doc.getNode(id)?.name ?? id })))} preview={(id) => critiqueApi.shot(fileId, id)} />
            <fieldset className="crit-field">
              <legend className="crit-label">{t('Screens')}</legend>
              <label className="crit-radio"><input type="radio" name="crit-scope" checked={scope === 'page'} onChange={() => setScope('page')} />{t.n(boardsOnPage.length, '{name}: {count} artboard', '{name}: all {count} artboards, as states of one flow', { name: pageName ?? '' })}</label>
              <label className="crit-radio"><input type="radio" name="crit-scope" checked={scope === 'selection'} disabled={!selectedBoards.length} onChange={() => setScope('selection')} />{selectedBoards.length ? t.n(selectedBoards.length, 'The selected artboard', 'The {count} selected artboards') : t('Selected artboards')}</label>
            </fieldset>
            <label className="crit-field">
              <span className="crit-label">{t('Reviewer')}</span>
              <select className="crit-select" value={reviewer} onChange={(e) => setReviewer(e.target.value as Reviewer)} data-testid="critique-reviewer">
                {(Object.keys(REVIEWER) as Reviewer[]).map((r) => <option key={r} value={r}>{t(REVIEWER[r])}</option>)}
              </select>
            </label>
            <p className="crit-note">{t('Each review is a fresh session that sees only the pictures, the brand and the brief, never how the work was made. It costs about $1.70 of your plan per round and usually takes {lo} to {hi} minutes. You can close this while it runs.', expectedRange(records))}</p>
            {error ? <p className="crit-error" role="alert">{error}</p> : null}
            <footer className="crit-foot">
              {records.length ? <button type="button" className="btn btn-quiet" onClick={() => setMode('result')}>{t('Back to the last review')}</button> : null}
              <button type="button" className="btn btn-primary" disabled={!status || (scope === 'page' ? !boardsOnPage.length : !selectedBoards.length)} onClick={() => void start()} data-testid="critique-start">{t('Review')}</button>
            </footer>
          </div>
        ) : record ? (
          <Result key={record.id} record={record} records={records} onShow={setShown} onClose={close} onAgain={() => { setError(null); setMode('start'); }} />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function Waiting({ fileId, records, onStop }: { fileId: string; records: CritiqueRecord[]; onStop: () => void }) {
  const t = useT();
  const job = useCritiqueFlow((st) => st.files[fileId]?.job)!;
  const loop = useCritiqueFlow((st) => st.files[fileId]?.loop);
  const doc = session().doc;
  const now = useNow(true);
  const ids = job.screenIds ?? [];
  const boards = boardsOf(doc, ids.map((id) => ({ id, name: doc.getNode(id)?.name ?? id })));
  const step = job.step ?? 'rules';
  const at = STAGES.findIndex((s) => s === step);
  const who = job.reviewer ?? t('The reviewer');
  const lead = step === 'queued' ? t('Waiting for the current review to finish') : step === 'writing' ? t('{reviewer} is writing it up', { reviewer: who })
    : step === 'reviewer' ? t.n(job.screens, '{reviewer} is looking at {count} screen', '{reviewer} is looking at {count} screens', { reviewer: who })
    : step === 'pictures' ? t.n(job.screens, 'Rendering {count} screen', 'Rendering {count} screens')
    : t('Checking the rules');
  const since = (s: (typeof STAGES)[number]) => job.stepAt?.[s] ? elapsed((job.stepAt[s] ?? job.startedAt) - job.startedAt) : '';
  const nextAt = (s: (typeof STAGES)[number]) => { const i = STAGES.indexOf(s); return STAGES.slice(i + 1).map((x) => job.stepAt?.[x]).find(Boolean); };
  const detail: Record<(typeof STAGES)[number], string> = {
    rules: job.ruleFindings === undefined ? t('contrast, overflow, wording') : job.ruleFindings ? t.n(job.ruleFindings, '{count} finding for the reviewer', '{count} findings for the reviewer') : t('no rule findings'),
    pictures: t('{done} of {count}', { done: job.rendered ?? 0, count: job.screens }),
    reviewer: at > 2 && job.stepAt?.reviewer ? t('took {time}', { time: elapsed((nextAt('reviewer') ?? now) - job.stepAt.reviewer) }) : at === 2 ? t('since {time}', { time: since('reviewer') }) : t('a fresh session'),
    writing: job.written ? t('{defects} defects, {taste} notes so far', { defects: job.written.defects, taste: job.written.taste }) : at === 3 ? t('since {time}', { time: since('writing') }) : t('next'),
  };
  const label: Record<(typeof STAGES)[number], string> = { rules: t('Rule checks'), pictures: t('Pictures'), reviewer: t('{reviewer} looking', { reviewer: who }), writing: t('Writing up') };
  return (
    <div className="crit-body crit-waiting" data-testid="critique-running" data-step={step}>
      <CritiqueWall job={job} boards={boards} />
      <div className="crit-who">
        <p className="crit-lead" role="status" data-testid="critique-stage">{lead}</p>
        <p className="crit-clock" data-testid="critique-clock"><span className="crit-clock-n">{elapsed(now - job.startedAt)}</span> <span className="crit-clock-of">· {t('usually {lo} to {hi} min', expectedRange(records))}</span></p>
      </div>
      <ol className="crit-stages" aria-label={t('Stages')}>
        {STAGES.map((st, i) => (
          <li key={st} className={i < at ? 'is-done' : i === at ? 'is-now' : ''} aria-current={i === at ? 'step' : undefined} data-testid={`critique-stage-${st}`}>
            <span className="crit-bar" aria-hidden="true" />
            <span className="crit-stage-name">{label[st]}{i < at ? <Check size={12} aria-label={t('done')} className="crit-stage-check" /> : null}</span>
            <span className="crit-stage-detail">{i <= at || st === 'writing' ? detail[st] : t('next')}</span>
          </li>
        ))}
      </ol>
      <p className="crit-note">{loop ? `${t('A loop to {until}: each round a new reviewer who has not seen the round before.', { until: loop.until })} ` : null}{t('A fresh session that sees only these pictures, the brand and the brief, never how the work was made. Close this whenever you like: the review keeps running at the foot of the window.')}</p>
      <footer className="crit-foot">
        <button type="button" className="btn btn-quiet" onClick={onStop} data-testid="critique-stop">{t('Stop review')}</button>
        <button type="button" className="btn" onClick={() => ui().set({ critiqueOpen: false })} data-testid="critique-minimise">{t('Minimise')}</button>
      </footer>
    </div>
  );
}

/** Results whose score was revealed already: the ring fills once per review, not each time the dialog opens. */
const revealed = new Set<string>();

/** The score's ring: it fills once and the number counts up with it; with reduced motion both are there at once. */
function ScoreRing({ id, score }: { id: string; score: number }) {
  const t = useT();
  const [still] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches || revealed.has(id));
  const [shown, setShown] = useState(still ? score : 0);
  useEffect(() => {
    revealed.add(id);
    if (still) { setShown(score); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 700);
      setShown(score * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <div className="crit-ring" data-testid="critique-ring">
      <svg viewBox="0 0 104 104" aria-hidden="true"><circle className="crit-ring-track" cx="52" cy="52" r={r} /><circle className="crit-ring-fill" cx="52" cy="52" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - shown / 10)} /></svg>
      <p className="crit-ring-n"><span data-testid="critique-score" aria-hidden="true">{shown === score ? score : shown.toFixed(1)}</span><span className="crit-ring-of" aria-hidden="true">{t('of 10')}</span><span className="crit-sr">{score} / 10</span></p>
    </div>
  );
}

/** The rounds of one loop as a small line of scores, each round a point to open. */
function History({ series, current, onShow }: { series: CritiqueRecord[]; current: CritiqueRecord; onShow: (id: string) => void }) {
  const t = useT();
  if (series.length < 2) return null;
  const w = 72, h = 24;
  const x = (i: number) => 4 + (i * (w - 8)) / (series.length - 1);
  const y = (v: number) => h - 3 - (v / 10) * (h - 6);
  return (
    <div className="crit-history" data-testid="critique-history">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        <polyline className="crit-spark" points={series.map((r, i) => `${x(i)},${y(r.score)}`).join(' ')} />
        {series.map((r, i) => <circle key={r.id} className={r.id === current.id ? 'crit-spark-dot is-now' : 'crit-spark-dot'} cx={x(i)} cy={y(r.score)} r={r.id === current.id ? 3.5 : 2.5} />)}
      </svg>
      <span className="crit-history-text">{t.n(series.length, '{from} to {to} in {count} round', '{from} to {to} in {count} rounds', { from: series[0]!.score, to: series.at(-1)!.score })}</span>
      <span className="crit-chips">{series.map((r) => <button type="button" key={r.id} className={`crit-chip${r.id === current.id ? ' is-active' : ''}`} aria-pressed={r.id === current.id} aria-label={t('Round {round}, {score} of 10', { round: r.round, score: r.score })} onClick={() => onShow(r.id)} data-testid="critique-round">{t('R{round}', { round: r.round })}</button>)}</span>
    </div>
  );
}

function Result({ record, records, onShow, onClose, onAgain }: { record: CritiqueRecord; records: CritiqueRecord[]; onShow: (id: string) => void; onClose: () => void; onAgain: () => void }) {
  const t = useT();
  const s = session();
  const doc = s.doc;
  const flow = useCritiqueFlow((st) => st.files[s.fileId]);
  const fixing = flow?.fix?.state === 'running';
  const now = useNow(fixing);
  // A fix started from the foot of a long list says so where the person is looking: the status comes into view.
  const fixingRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (fixing) fixingRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [fixing]);
  const series = records.filter((r) => r.series === record.series).sort((a, b) => a.round - b.round);
  const latest = series.at(-1)?.id === record.id;
  const [defects, setDefects] = useState<Set<number>>(() => new Set(record.defects.map((d, i) => (d.addressed ? -1 : i)).filter((i) => i >= 0)));
  const [taste, setTaste] = useState<Set<number>>(new Set());
  const [loop, setLoopState] = useState(loopChoice);
  const setLoop = (on: boolean) => { setLoopChoice(on); setLoopState(on); };
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  useEffect(() => { void chatAgent().then((a) => setAgent(a?.label ?? null), () => setAgent(null)); }, []);

  const job = flow?.job;
  const target = record.until ?? LOOP_TARGET;
  // The picture the reviewer saw, while the server keeps it; else the screen as it is now, said so on the crop.
  const pictureFor = (screen: number): { src: string; now: boolean } | null => {
    const id = record.screens[screen - 1]?.id;
    if (job && job.recordId === record.id && (job.rendered ?? 0) >= screen) return { src: critiqueApi.picture(job.id, screen), now: false };
    return id && doc.getNode(id) ? { src: critiqueApi.shot(s.fileId, id), now: true } : null;
  };

  const pin = (i: number) => {
    const f = record.defects[i]!;
    const target = f.nodeId && doc.getNode(f.nodeId) ? f.nodeId : record.screens[(f.screens[0] ?? 1) - 1]?.id;
    const page = target ? doc.pageOf(target) : record.pageId;
    if (!page) return;
    const threadId = doc.addThread({ pageId: page, ...(target ? { nodeId: target } : {}), x: 0, y: 0, author: s.user.name, text: `${f.title}\n${f.evidence}`, suggestion: { text: f.fix, check: 'critique', by: record.reviewer } }, LOCAL);
    updateCritique(doc, record.id, (rec) => ({ ...rec, defects: rec.defects.map((d, j) => (j === i ? { ...d, threadId } : d)) }), LOCAL);
  };

  // Fix starts the run at once: the person chose it, and the run is undone in one step from the chat. A confirm
  // placed below the list went unseen, so a click seemed to do nothing.
  const fix = async (d: number[], n: number[]) => {
    setError(null);
    try {
      await fixFindings({ fileId: s.fileId, record, defects: d, taste: n, loop: loop && d.length ? { series: record.series, until: target, maxRounds: Math.min(5, Math.max(record.maxRounds, LOOP_ROUNDS, record.round + 1)) } : null });
    } catch (e) { setError((e as Error).message); }
  };
  const toggle = (set: Set<number>, put: (s: Set<number>) => void, i: number) => { const next = new Set(set); if (next.has(i)) next.delete(i); else next.add(i); put(next); };
  const chosenD = [...defects].sort((a, b) => a - b);
  const chosenT = [...taste].sort((a, b) => a - b);
  const total = chosenD.length + chosenT.length;
  const meta = [record.reviewer, elapsed(record.durationMs), record.maxRounds > 1 ? t('round {round} of {max}', { round: record.round, max: record.maxRounds }) : '', record.until !== undefined ? t('target {until}', { until: record.until }) : ''].filter(Boolean).join(' · ');
  const rechecked = record.rechecked ?? [];
  const met = critiqueMet({ ...record, until: target });
  // Something to fix: a defect, or a taste note the person ticked.
  const fixable = record.defects.length > 0 || record.taste.length > 0;
  const fixedCount = rechecked.filter((r) => r.fixed).length;

  return (
    <div className="crit-body crit-result" data-testid="critique-result">
      <section className="crit-top" aria-label={t('Score')}>
        <ScoreRing id={record.id} score={record.score} />
        <div className="crit-top-text">
          {record.verdict ? <p className="crit-verdict">{record.verdict}</p> : null}
          <div className="crit-meta"><span>{meta}</span><History series={series} current={record} onShow={onShow} /></div>
          {job?.note && job.recordId === record.id ? <p className="crit-note">{job.note}</p> : null}
          {rechecked.length ? <p className="crit-note" data-testid="critique-rechecked">{t('{fixed} of {count} findings from the round before are really fixed.', { fixed: fixedCount, count: rechecked.length })}</p> : null}
          {flow?.loopNote && latest ? <p className="crit-note" data-testid="critique-loop-note">{flow.loopNote}</p> : null}
        </div>
      </section>
      <dl className="crit-dims" data-testid="critique-dims">
        {CRITIQUE_DIMENSIONS.filter((d) => record.dimensions[d] !== undefined).map((d) => {
          const v = record.dimensions[d]!;
          return <div key={d} className="crit-dim"><dt>{t(DIMENSION[d])}</dt><dd><span className="crit-num">{v}</span><span className="crit-meter" aria-hidden="true"><i className={v >= 7 ? 'is-ok' : 'is-low'} style={{ width: `${v * 10}%` }} /></span></dd></div>;
        })}
      </dl>

      {fixing && flow?.fix ? (
        <div ref={fixingRef} className="crit-fixing" role="status" data-testid="critique-fixing">
          <span className="crit-fixing-dot" aria-hidden="true" />
          <span className="crit-fixing-text">{flow.fix.titles?.length === 1 ? t('{agent} is fixing: {title}', { agent: flow.fix.runner === 'codex' ? 'Codex' : 'Claude', title: flow.fix.titles[0]! }) : t('{agent} is fixing {count} findings', { agent: flow.fix.runner === 'codex' ? 'Codex' : 'Claude', count: flow.fix.titles?.length ?? flow.fix.defects + flow.fix.taste })}{flow.loop ? ` · ${t('then a new reviewer looks, until {until} or round {max}', { until: flow.loop.until, max: flow.loop.maxRounds })}` : ''}</span>
          <span className="crit-clock-n">{elapsed(now - flow.fix.startedAt)}</span>
          {flow.loop ? <button type="button" className="btn btn-sm btn-quiet" onClick={() => stopLoop(s.fileId)} data-testid="critique-loop-off">{t('No new review')}</button> : null}
          <button type="button" className="btn btn-sm" onClick={() => void stopFix(s.fileId)} data-testid="critique-fix-stop">{t('Stop')}</button>
        </div>
      ) : null}

      <section className="crit-sec" aria-labelledby="crit-defects">
        <div className="crit-sec-head"><h3 id="crit-defects">{record.defects.length ? t.n(record.defects.length, '{count} defect', '{count} defects') : t('No defects')}</h3>{record.defects.length ? <span>{t('objective, any careful reviewer would agree')}</span> : null}</div>
        {record.defects.length ? <ol className="crit-findings">{record.defects.map((f, i) => (
          <Finding key={i} f={f} r={record} picture={pictureFor(f.screens[0] ?? 1)} checked={defects.has(i)} onCheck={() => toggle(defects, setDefects, i)} onPin={() => pin(i)} onFix={() => void fix([i], [])} busy={fixing || !latest} onShow={() => { if (f.nodeId) { selectLayer(f.nodeId); onClose(); } }} />
        ))}</ol> : null}
      </section>

      {record.taste.length ? <section className="crit-sec" aria-labelledby="crit-taste">
        <div className="crit-sec-head"><h3 id="crit-taste">{t.n(record.taste.length, '{count} taste note', '{count} taste notes')}</h3><span>{t('your call; tick one to have it done too')}</span></div>
        <ul className="crit-notes">{record.taste.map((n, i) => (
          <li key={i} className="crit-note-row" data-testid="critique-taste">
            <input type="checkbox" className="crit-check" checked={taste.has(i)} onChange={() => toggle(taste, setTaste, i)} aria-label={t('Include: {title}', { title: n.title })} disabled={fixing || !latest} />
            <div><p className="crit-title">{n.title}{n.addressed ? <span className="crit-status is-fix">{t('Fix started')}</span> : null}</p><p className="crit-text">{n.detail}</p></div>
          </li>
        ))}</ul>
      </section> : null}

      {record.keep.length ? <section className="crit-sec" aria-labelledby="crit-keep">
        <div className="crit-sec-head"><h3 id="crit-keep">{t('Keep')}</h3></div>
        <ul className="crit-keep">{record.keep.map((k, i) => <li key={i}><Check size={14} aria-hidden="true" />{k}</li>)}</ul>
      </section> : null}


      {error ? <p className="crit-error" role="alert" data-testid="critique-fix-error">{error}</p> : null}

      <footer className="crit-foot crit-fixbar">
        {!fixing ? <button type="button" className="btn btn-quiet" onClick={onAgain} data-testid="critique-new">{t('Review again')}</button> : null}
        {latest && fixable ? <>
          <span className="crit-fixbar-who">{agent ? t('Runs with {agent} from the chat', { agent }) : ''}</span>
          <span className="crit-fixbar-go">
            {record.defects.length && !met ? <label className="crit-loop"><input type="checkbox" className="crit-check" checked={loop} onChange={(e) => setLoop(e.target.checked)} disabled={fixing} data-testid="critique-loop" />{t('Then review again until {until}', { until: target })}</label> : null}
            <button type="button" className="btn btn-primary" disabled={!total || fixing} onClick={() => void fix(chosenD, chosenT)} data-testid="critique-fix-selected">
              {fixing ? t('Fixing…') : !total ? t('Choose what to fix') : chosenT.length ? t('Fix {count} selected', { count: total }) : chosenD.length === record.defects.length ? t.n(total, 'Fix the defect', 'Fix all {count} defects') : t.n(total, 'Fix {count} defect', 'Fix {count} defects')}
            </button>
          </span>
        </> : null}
      </footer>
    </div>
  );
}

/** Where each layer sits in its artboard, as parts of it, kept from the last time both were drawn on the canvas. */
const parts = new Map<string, { x: number; y: number; w: number; h: number }>();
function partOf(boardId: string | undefined, nodeId: string | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!boardId || !nodeId || nodeId === boardId) return null;
  const b = document.querySelector(`[data-bogen-id="${CSS.escape(boardId)}"]`)?.getBoundingClientRect();
  const n = document.querySelector(`[data-bogen-id="${CSS.escape(nodeId)}"]`)?.getBoundingClientRect();
  if (b && n && b.width > 0 && b.height > 0 && n.width > 0 && n.height > 0) {
    const part = { x: (n.left - b.left) / b.width, y: (n.top - b.top) / b.height, w: n.width / b.width, h: n.height / b.height };
    if (part.x >= -0.01 && part.y >= -0.01 && part.x + part.w <= 1.01 && part.y + part.h <= 1.01) parts.set(nodeId, part);
  }
  return parts.get(nodeId) ?? null;
}

/** Where a finding is, on the person's own screen: the picture cropped around its layer, with a pencil ring. */
function Crop({ picture, boardId, nodeId, name }: { picture: { src: string; now: boolean } | null; boardId?: string; nodeId?: string; name: string }) {
  const t = useT();
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 152, h: 104 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 152, h: el.clientHeight || 104 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const part = useMemo(() => partOf(boardId, nodeId), [boardId, nodeId]);
  const { w: W, h: H } = size;
  let img: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' };
  let ring: React.CSSProperties | null = null;
  if (part && natural) {
    // Close enough that the layer reads, with room around it; never smaller than the crop, so the picture fills it.
    const fit = Math.min((W - 24) / (natural.w * Math.max(part.w, 0.05)), (H - 20) / (natural.h * Math.max(part.h, 0.04)) / 2.2, 2);
    const scale = Math.max(fit, W / natural.w, H / natural.h);
    const iw = natural.w * scale, ih = natural.h * scale;
    // A little below the layer's middle, so what follows it (often the other half of the finding) is in the crop too.
    const cx = (part.x + part.w / 2) * iw, cy = (part.y + part.h) * ih;
    const left = Math.min(0, Math.max(W - iw, W / 2 - cx)), top = Math.min(0, Math.max(H - ih, H / 2 - cy));
    img = { position: 'absolute', width: iw, height: ih, maxWidth: 'none', left, top };
    // The ring around the layer, kept inside the crop so it is never cut.
    const rl = Math.max(3, left + part.x * iw - 6), rt = Math.max(3, top + part.y * ih - 4);
    const rr = Math.min(W - 3, left + (part.x + part.w) * iw + 6), rb = Math.min(H - 3, top + (part.y + part.h) * ih + 4);
    if (rr - rl > 8 && rb - rt > 6) ring = { left: rl, top: rt, width: rr - rl, height: rb - rt };
  }
  return (
    <div ref={box} className="crit-crop" aria-hidden="true">
      {picture ? <img src={picture.src} alt="" style={img} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} draggable={false} /> : <span className="crit-crop-name">{name}</span>}
      {ring ? <span className="crit-crop-ring" style={ring} /> : null}
      {picture?.now ? <span className="crit-crop-now">{t('now')}</span> : null}
    </div>
  );
}

function Finding({ f, r, picture, checked, onCheck, onPin, onFix, onShow, busy }: { f: CritiqueFinding; r: CritiqueRecord; picture: { src: string; now: boolean } | null; checked: boolean; onCheck: () => void; onPin: () => void; onFix: () => void; onShow: () => void; busy: boolean }) {
  const t = useT();
  const screens = f.screens.map((n) => shortName(r.screens[n - 1]?.name ?? String(n)));
  const board = r.screens[(f.screens[0] ?? 1) - 1]?.id;
  return (
    <li className="crit-finding" data-testid="critique-defect">
      <input type="checkbox" className="crit-check" checked={checked} onChange={onCheck} aria-label={t('Include: {title}', { title: f.title })} disabled={busy} data-testid="critique-defect-check" />
      <Crop picture={picture} boardId={board} nodeId={f.nodeId} name={screens[0] ?? ''} />
      <div className="crit-finding-body">
        <div className="crit-head"><p className="crit-title">{f.title}</p><span className="crit-kind">{t(KIND[f.kind] ?? KIND.craft!)}</span></div>
        <p className="crit-text">{screens.length ? <b className="crit-where">{screens.join(', ')}. </b> : null}{f.evidence}</p>
        {f.fix ? <p className="crit-text crit-fix">{t('Fix: {fix}', { fix: f.fix })}</p> : null}
        <div className="crit-actions">
          <button type="button" className="btn btn-sm crit-fix-btn" onClick={onFix} disabled={busy} data-testid="critique-fix-one">{t('Fix')}</button>
          {f.threadId ? null : <button type="button" className="btn btn-sm btn-quiet" onClick={onPin} data-testid="critique-pin">{t('Pin as comment')}</button>}
          {f.nodeId ? <button type="button" className="btn btn-sm btn-quiet" onClick={onShow}>{t('Show layer')}</button> : null}
          <span className="crit-statuses">
            {f.threadId ? <span className="crit-status" data-testid="critique-pinned">{t('Pinned')}</span> : null}
            {f.addressed ? <span className="crit-status is-fix" data-testid="critique-addressed">{t('Fix started')}</span> : null}
          </span>
        </div>
      </div>
    </li>
  );
}
