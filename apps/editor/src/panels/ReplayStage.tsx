import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { autoCamera, replayClock, replayFrameAt, replayStepAt, type ReplayFrame } from '@bogen/core';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { downloadBlob } from '../lib/api.ts';
import { history, type ReplayExportOptions, type ReplayPlan } from '../lib/history-api.ts';
import { Segmented, SelectField } from '../ui/controls.tsx';
import { setStageView } from './history-state.ts';
import { msg } from '../i18n/core.ts';
import { formatList, formatNumber, formatTime } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import '../styles/transfer.css';

const SPEEDS = ['0.5', '1', '2', '4', '8'] as const;
type Speed = (typeof SPEEDS)[number];
const IDLE = [{ value: '500', label: msg('at most 0.5 s') }, { value: '1000', label: msg('at most 1 s') }, { value: '1500', label: msg('at most 1.5 s') }, { value: '3000', label: msg('at most 3 s') }];
const SIZES = [
  { value: '1920x1080', label: '1920 x 1080' },
  { value: '1280x720', label: '1280 x 720' },
  { value: '1080x1920', label: msg('1080 x 1920, upright') },
  { value: '1080x1080', label: msg('1080 x 1080, square') },
  { value: '960x540', label: '960 x 540' },
];

function clockText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function timeOfDay(at: number): string {
  return formatTime(at, { hour: '2-digit', minute: '2-digit' });
}

/** The picture of one moment, as the video export draws it: core's frame, the server's pictures. */
function Picture({ plan, frame, width, captions }: { plan: ReplayPlan; frame: ReplayFrame; width: number; captions: boolean }) {
  const scale = width / frame.camera.width;
  const screen = (x: number, y: number) => ({ left: (x - frame.camera.x) * scale, top: (y - frame.camera.y) * scale });
  const shots = [frame.under, frame.top].filter((i): i is number => i !== null && Boolean(plan.shots[i]));
  const hl = frame.highlight;
  return (
    <>
      <div className="replay-world" style={{ transform: `translate(${-frame.camera.x * scale}px, ${-frame.camera.y * scale}px) scale(${scale})` }}>
        {shots.map((i) => {
          const r = plan.shots[i]!;
          return <img key={i} src={history.replayShot(plan.fileId, plan.id, i)} alt="" draggable={false} style={{ left: r.x, top: r.y, width: r.width, height: r.height, opacity: i === frame.top ? 1 : 1 - frame.fade, zIndex: i === frame.top ? 1 : 2 }} data-testid="replay-shot" />;
        })}
      </div>
      {hl ? <div className="replay-mark" style={{ ...screen(hl.rect.x - 3 / scale, hl.rect.y - 3 / scale), width: hl.rect.width * scale + 6, height: hl.rect.height * scale + 6, borderColor: hl.color, opacity: hl.opacity }} /> : null}
      {frame.cursors.map((c) => (
        <div key={c.actor} className="replay-cursor" style={{ transform: `translate(${(c.x - frame.camera.x) * scale}px, ${(c.y - frame.camera.y) * scale}px)`, opacity: c.opacity }} data-testid="replay-cursor">
          <svg width="18" height="20" viewBox="0 0 20 22" style={{ transform: `scale(${1 - c.pressed * 0.14})` }}><path d="M1.5 1.5 18 10.2l-7.6 2.1-3.4 7.6z" fill={c.color} stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /></svg>
          <span className="replay-name" style={{ background: c.color }}>{c.actor}</span>
          {captions && frame.caption?.actor === c.actor ? (
            <span className="replay-caption" style={{ opacity: frame.caption.opacity }} data-testid="replay-caption">
              {frame.caption.tool ? <code>{frame.caption.tool}</code> : null}<span dir="auto">{frame.caption.summary}</span>
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

function ExportBox({ plan, speed, idle, setIdle, captions, setCaptions, step, onClose }: { plan: ReplayPlan; speed: number; idle: string; setIdle: (v: string) => void; captions: boolean; setCaptions: (v: boolean) => void; step: number; onClose: () => void }) {
  const t = useT();
  const [format, setFormat] = useState<'mp4' | 'webm' | 'gif'>('mp4');
  const [size, setSize] = useState(plan.frame.height > plan.frame.width * 1.15 ? '1080x1920' : '1920x1080');
  const [cursors, setCursors] = useState(true);
  const [camera, setCamera] = useState<'auto' | 'fit' | 'grow' | 'follow'>('auto');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(plan.steps.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [w, h] = size.split('x').map(Number) as [number, number];
  const last = Math.max(from, Math.min(plan.steps.length, to));
  const seconds = replayClock(plan.steps.slice(from - 1, last), { speed, maxIdleMs: Number(idle) }).duration / 1000;
  const fps = format === 'gif' ? 15 : 30;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const options: ReplayExportOptions = { pageId: plan.pageId, format, speed, maxIdleMs: Number(idle), width: format === 'gif' ? Math.round(w / 2) : w, height: format === 'gif' ? Math.round(h / 2) : h, captions, cursors, camera, fromStep: from - 1, toStep: last - 1 };
      const { blob, name } = await history.replayExport(plan.fileId, options);
      downloadBlob(blob, name);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stepField = (value: number, set: (n: number) => void, label: string, testId: string) => (
    <input className="token-input replay-step-field" type="number" min={1} max={plan.steps.length} value={value} aria-label={label} onChange={(e) => set(Math.max(1, Math.min(plan.steps.length, Math.round(Number(e.target.value) || 1))))} onKeyDown={(e) => e.stopPropagation()} data-testid={testId} />
  );
  return (
    <div className="replay-export" data-testid="replay-export">
      <div className="replay-export-title">{t('Export the replay')}</div>
      <div className="replay-export-grid">
        <span>{t('Format')}</span>
        <Segmented value={format} onChange={setFormat} testId="replay-format" options={[{ value: 'mp4', label: 'MP4', title: t('MP4 video') }, { value: 'webm', label: 'WebM', title: t('WebM video') }, { value: 'gif', label: 'GIF', title: t('GIF, at half the size') }]} />
        <span>{t('Size')}</span>
        <SelectField value={size} onChange={setSize} options={SIZES.map((o) => ({ ...o, label: t(o.label) }))} testId="replay-size" />
        <span>{t('Range')}</span>
        <span className="replay-range">{t.rich('Steps {from} to {to}', { from: stepField(from, setFrom, t('First step'), 'replay-from'), to: stepField(last, setTo, t('Last step'), 'replay-to') })}<button type="button" className="btn btn-quiet" onClick={() => setFrom(Math.max(1, step + 1))} title={t('Start at the step on screen')}>{t('From here')}</button></span>
        <span>{t('Speed')}</span>
        <span>{t('{speed}x, as playing', { speed })}</span>
        <span>{t('Idle gaps')}</span>
        <SelectField value={idle} onChange={setIdle} options={IDLE.map((o) => ({ ...o, label: t(o.label) }))} testId="replay-idle" />
        <span>{t('Camera')}</span>
        <SelectField value={camera} onChange={setCamera} options={[{ value: 'auto', label: t('As it grows, or close when small') }, { value: 'grow', label: t('The page as it grows') }, { value: 'fit', label: t('The whole page') }, { value: 'follow', label: t('Follow the work') }]} testId="replay-camera" />
        <span>{t('Show')}</span>
        <span className="replay-checks">
          <label><input type="checkbox" checked={cursors} onChange={(e) => setCursors(e.target.checked)} /> {t('Cursors and names')}</label>
          <label><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} /> {t('Captions')}</label>
        </span>
      </div>
      <div className="hint">{format === 'gif'
        ? t.n(Math.ceil(seconds * fps), 'About {seconds} s, {frames} frames. Made on this computer, with ffmpeg.', 'About {seconds} s, {frames} frames. Made on this computer, with ffmpeg.', { seconds: Math.round(seconds), frames: formatNumber(Math.ceil(seconds * fps)) })
        : t.n(Math.ceil(seconds * fps), 'About {seconds} s, {frames} frames. Made on this computer.', 'About {seconds} s, {frames} frames. Made on this computer.', { seconds: Math.round(seconds), frames: formatNumber(Math.ceil(seconds * fps)) })}</div>
      {error ? <div className="error" data-testid="replay-export-error">{error}</div> : null}
      <div className="replay-export-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()} data-testid="replay-export-run">{busy ? t('Filming') : t('Export {format}', { format: format.toUpperCase() })}</button>
      </div>
    </div>
  );
}

/**
 * The replay of a page in the editor: how it was built, step by step, with the cursors and names of whoever did
 * each step. The server rebuilds and renders the states; this plays them on core's clock, the same one the video
 * export films, so what plays here is what the video shows.
 */
export function ReplayStage({ fileId, pageId }: { fileId: string; pageId: string }) {
  const t = useT();
  const [plan, setPlan] = useState<ReplayPlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<Speed>('1');
  const [idle, setIdle] = useState('1500');
  const [captions, setCaptions] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [pos, setPos] = useState(0);
  const [box, setBox] = useState({ width: 960, height: 540 });
  const view = useRef<HTMLDivElement>(null);
  const posRef = useRef(0);
  posRef.current = pos;

  useEffect(() => {
    const stop = new AbortController();
    history.replay(fileId, pageId, (done, total) => setProgress({ done, total }), stop.signal).then((p) => {
      setPlan(p);
      // Every picture once, so that playing never waits for one.
      for (let i = 0; i < p.shots.length; i++) if (p.shots[i]) new Image().src = history.replayShot(fileId, p.id, i);
    }, (e: Error) => {
      if (!stop.signal.aborted) setError(e.message);
    });
    return () => stop.abort();
  }, [fileId, pageId]);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const measure = () => setBox({ width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clock = useMemo(() => (plan ? replayClock(plan.steps, { speed: Number(speed), maxIdleMs: Number(idle) }) : null), [plan, speed, idle]);
  const clockRef = useRef(clock);

  // A new speed keeps the step on screen, and how far into it the replay was.
  useEffect(() => {
    const before = clockRef.current;
    clockRef.current = clock;
    if (!before || !clock || before === clock) return;
    const k = replayStepAt(before, posRef.current);
    setPos(k < 0 ? Math.min(posRef.current, clock.at[0] ?? 0) : clock.at[k]! + (posRef.current - before.at[k]!) * (before.timing.speed / clock.timing.speed));
  }, [clock]);

  useEffect(() => {
    if (!playing || !clock) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const next = Math.min(clock.duration, posRef.current + (now - last));
      last = now;
      setPos(next);
      if (next >= clock.duration) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, clock]);

  const step = clock ? replayStepAt(clock, pos) : -1;
  const goStep = useCallback((k: number) => {
    if (!clock || !plan) return;
    const target = Math.max(-1, Math.min(plan.steps.length - 1, k));
    setPlaying(false);
    setPos(target < 0 ? 0 : clock.at[target]! + 260);
  }, [clock, plan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === 'Escape') setStageView(null);
      else if (e.key === ' ') {
        e.preventDefault();
        if (clock && posRef.current >= clock.duration) setPos(0);
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowLeft') goStep(step - 1);
      else if (e.key === 'ArrowRight') goStep(step + 1);
      else return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clock, goStep, step]);

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!clock) return;
    const bar = e.currentTarget.getBoundingClientRect();
    const at = (x: number) => Math.max(0, Math.min(clock.duration, ((x - bar.left) / bar.width) * clock.duration));
    setPlaying(false);
    setPos(at(e.clientX));
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => setPos(at(m.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const frame = plan && clock ? replayFrameAt(plan.steps, clock, { frame: plan.frame, aspect: box.width / box.height, camera: autoCamera(plan.frame, box.width, box.height, true), extents: plan.shots }, pos) : null;
  const actors = plan ? [...new Set(plan.steps.map((s) => s.actor))] : [];
  const current = plan && step >= 0 ? plan.steps[step] : null;

  return (
    <div className="history-stage replay-stage" data-testid="replay-stage">
      <div className="replay-top">
        <b>{t('Replay')}</b>
        <span>{plan ? t.n(plan.steps.length, '{page}, {count} step by {actors}', '{page}, {count} steps by {actors}', { page: plan.pageName, actors: formatList(actors) }) : progress ? t('Rendering {done} of {total}', { done: progress.done, total: progress.total }) : t('Rebuilding the page from its history')}</span>
        {plan?.notes.length ? <span className="hint" title={plan.notes.join(' ')}>{plan.notes[0]}</span> : null}
      </div>
      <div className="replay-view" ref={view} data-testid="replay-view">
        {error ? <div className="replay-message error" data-testid="replay-error">{error}</div> : null}
        {!plan && !error ? <div className="replay-message hint">{progress ? t('Rendering step {done} of {total}', { done: progress.done, total: progress.total }) : t('Reading the timeline')}</div> : null}
        {plan && frame ? <Picture plan={plan} frame={frame} width={box.width} captions={captions} /> : null}
      </div>
      {exporting && plan ? <ExportBox plan={plan} speed={Number(speed)} idle={idle} setIdle={setIdle} captions={captions} setCaptions={setCaptions} step={step} onClose={() => setExporting(false)} /> : null}
      <div className="replay-bar" data-testid="replay-bar">
        <button type="button" className="replay-play" disabled={!clock} onClick={() => { if (clock && pos >= clock.duration) setPos(0); setPlaying(!playing); }} title={playing ? t('Pause ({shortcut})', { shortcut: 'Space' }) : t('Play ({shortcut})', { shortcut: 'Space' })} aria-label={playing ? t('Pause') : t('Play')} data-testid="replay-play">
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" className="icon-btn" disabled={!clock} onClick={() => goStep(step - 1)} title={t('Step before ({shortcut})', { shortcut: 'Left' })} aria-label={t('Step before')}><SkipBack size={13} /></button>
        <button type="button" className="icon-btn" disabled={!clock} onClick={() => goStep(step + 1)} title={t('Step after ({shortcut})', { shortcut: 'Right' })} aria-label={t('Step after')}><SkipForward size={13} /></button>
        <span className="replay-time" data-testid="replay-time">{clockText(pos)} / {clockText(clock?.duration ?? 0)}</span>
        <div className="replay-scrub">
          <div className="replay-track" onPointerDown={scrub} role="slider" aria-label={t('Replay position')} aria-valuemin={0} aria-valuemax={clock?.duration ?? 0} aria-valuenow={Math.round(pos)} tabIndex={0} data-testid="replay-track">
            {plan && clock ? plan.steps.map((s, k) => <span key={s.id} className={`replay-tick${k <= step ? ' is-done' : ''}`} style={{ left: `${(clock.at[k]! / clock.duration) * 100}%`, background: plan.colors[s.actor] }} title={`${s.actor}${s.tool ? `, ${s.tool}` : ''}: ${s.summary}`} />) : null}
            <span className="replay-head" style={{ left: `${clock ? (pos / clock.duration) * 100 : 0}%` }} />
          </div>
          <div className="replay-legend">
            <span>{plan?.steps[0] ? `${timeOfDay(plan.steps[0].at)} ${plan.steps[0].actor}` : ''}</span>
            <span className="replay-now">{current ? `${current.actor}${current.tool ? ` · ${current.tool}` : ''}: ${current.summary}` : t('idle gaps {limit}', { limit: t(IDLE.find((i) => i.value === idle)?.label ?? '') })}</span>
            <span>{plan?.steps.at(-1) ? `${timeOfDay(plan.steps.at(-1)!.at)} ${plan.steps.at(-1)!.actor}` : ''}</span>
          </div>
        </div>
        <Segmented value={speed} onChange={setSpeed} testId="replay-speed" options={SPEEDS.map((v) => ({ value: v, label: `${v}x`, title: t('Play at {speed} times the speed', { speed: v }) }))} />
        <label className="replay-check"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} data-testid="replay-captions" /> {t('Captions')}</label>
        <button type="button" className="btn" disabled={!plan} onClick={() => setExporting(!exporting)} data-testid="replay-export-open">{t('Export')}</button>
        <button type="button" className="btn btn-quiet" onClick={() => setStageView(null)} data-testid="replay-exit">{t('Back to now')}</button>
      </div>
    </div>
  );
}
