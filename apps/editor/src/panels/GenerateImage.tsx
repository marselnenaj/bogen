import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { resolveAsset } from '../lib/api.ts';
import { aspectFor, IMAGE_ASPECTS, imageGen, type GeneratorStatus, type ImageAspect, type ImageJob, type JobPicture } from '../lib/image-generate.ts';
import { editor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton } from '../ui/controls.tsx';
import { dropActivity, putActivity } from '../lib/activity.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { msg } from '../i18n/core.ts';

/** What the dialog fills: a layer's image, a fill, a shader's picture, or a new image on the canvas. */
export interface GenerateTarget {
  /** The layer's name, said in the dialog: "Goes into Hero photo". */
  into?: string;
  /** The shape of the box it goes into, for the first guess of a shape. */
  box?: { width: number; height: number };
  onPick: (pick: { src: string; width?: number; height?: number; prompt: string }) => void;
}

/** Opens Generate image for a target. The request of the last dialog stays, so reopening shows how it goes. */
export function openGenerateImage(target: GenerateTarget): void {
  ui().set({ generateImage: target });
}

const SHAPE: Record<ImageAspect, { label: string; w: number; h: number }> = {
  square: { label: msg('Square'), w: 10, h: 10 },
  landscape: { label: msg('Landscape'), w: 14, h: 10 },
  portrait: { label: msg('Portrait'), w: 10, h: 14 },
  wide: { label: msg('Wide'), w: 16, h: 9 },
  tall: { label: msg('Tall'), w: 9, h: 16 },
};

/** What the person wrote last, so a second picture for the same page starts from it. */
let lastPrompt = '';
let lastCount = 1;

/**
 * Pictures still being made when the dialog closed: they go on, as a pill in the dock (lib/activity.ts), and Open
 * brings the dialog back with them. Stop is the only thing that ends them.
 */
interface Parked { target: GenerateTarget; jobs: ImageJob[]; prompt: string; aspect: ImageAspect; count: number; retried: Set<string>; chosen: string | null }
let parked: Parked | null = null;
let parkTimer = 0;
const PARK_ID = 'image:generate';

function showParked(): void {
  const p = parked;
  if (!p) return dropActivity(PARK_ID);
  const pictures = p.jobs.flatMap((j) => j.pictures);
  const made = pictures.filter((x) => x.state === 'done').length;
  const running = p.jobs.some((j) => !j.endedAt);
  const startedAt = Math.min(...p.jobs.map((j) => j.startedAt));
  putActivity({
    id: PARK_ID, kind: 'image', state: running ? 'running' : made ? 'done' : 'failed',
    title: p.target.into || t('Generate image'),
    detail: running ? `${t('Image')} · ${t.n(pictures.length, 'Making {count} picture', 'Making {count} pictures')}` : made ? t.n(made, '{count} picture ready', '{count} pictures ready') : t('The pictures did not come back'),
    startedAt, ...(running ? {} : { endedAt: Math.max(...p.jobs.map((j) => j.endedAt ?? Date.now())) }),
    open: () => ui().set({ generateImage: p.target }),
    ...(running ? { stop: () => { for (const j of p.jobs) if (!j.endedAt) void imageGen.cancel(j.id).catch(() => {}); }, stopLabel: t('Stop making the pictures') } : {}),
    covered: () => Boolean(ui().generateImage),
  });
}

function park(p: Parked): void {
  parked = p;
  showParked();
  window.clearInterval(parkTimer);
  parkTimer = window.setInterval(() => {
    const now = parked;
    if (!now) return window.clearInterval(parkTimer);
    const open = now.jobs.filter((j) => !j.endedAt);
    if (!open.length) { window.clearInterval(parkTimer); return; }
    void Promise.all(open.map((j) => imageGen.job(j.id).catch(() => j))).then((next) => {
      if (parked !== now) return;
      now.jobs = now.jobs.map((j) => next.find((x) => x.id === j.id) ?? j);
      showParked();
    });
  }, 1000);
}

/** The parked pictures for this target, taken back by the dialog. */
function unpark(target: GenerateTarget): Parked | null {
  if (!parked || parked.target !== target) return null;
  const p = parked;
  parked = null;
  window.clearInterval(parkTimer);
  dropActivity(PARK_ID);
  return p;
}

export function GenerateImageDialog() {
  const target = useUi((s) => s.generateImage);
  return target ? <Body target={target} /> : null;
}

interface Shown { job: string; index: number; picture: JobPicture }

function Body({ target }: { target: GenerateTarget }) {
  const t = useT();
  const [back] = useState(() => unpark(target));
  const [status, setStatus] = useState<GeneratorStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [prompt, setPrompt] = useState(back?.prompt ?? lastPrompt);
  const [aspect, setAspect] = useState<ImageAspect>(back?.aspect ?? (target.box ? aspectFor(target.box.width, target.box.height) : 'landscape'));
  const [count, setCount] = useState(back?.count ?? lastCount);
  const [jobs, setJobs] = useState<ImageJob[]>(back?.jobs ?? []);
  const [retried, setRetried] = useState<Set<string>>(back?.retried ?? new Set());
  const [phase, setPhase] = useState<'prompt' | 'sheet'>(back ? 'sheet' : 'prompt');
  const [chosen, setChosen] = useState<string | null>(back?.chosen ?? null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const area = useRef<HTMLTextAreaElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  // Closing never throws pictures away that are still being made: they go on in the dock, and Open brings them back.
  const close = () => {
    if (jobs.some((j) => !j.endedAt)) park({ target, jobs, prompt, aspect, count, retried, chosen });
    ui().set({ generateImage: null });
  };

  const check = async (fresh = false) => {
    setChecking(true);
    try {
      setStatus(await imageGen.status(fresh));
    } catch (e) {
      setStatus({ state: 'broken', message: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => { void check(); }, []);
  useEffect(() => { if (status?.state === 'ready' && phase === 'prompt') area.current?.focus(); }, [status?.state, phase]);

  const running = jobs.some((j) => !j.endedAt);
  // Follows the requests while any runs, once a second.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      for (const j of jobs) {
        if (j.endedAt) continue;
        void imageGen.job(j.id).then((next) => setJobs((all) => all.map((x) => (x.id === next.id ? next : x)))).catch(() => {});
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, jobs.map((j) => `${j.id}:${j.endedAt ?? ''}`).join(',')]);

  const shown: Shown[] = useMemo(() => jobs.flatMap((j) => j.pictures.map((picture, index) => ({ job: j.id, index, picture })))
    .filter((s) => !(retried.has(s.job) && (s.picture.state === 'failed' || s.picture.state === 'cancelled'))), [jobs, retried]);
  const done = shown.filter((s) => s.picture.state === 'done' && s.picture.src);
  const failed = shown.filter((s) => s.picture.state === 'failed');
  const key = (s: Shown) => `${s.job}:${s.index}`;
  const selected = done.find((s) => key(s) === chosen) ?? done[0] ?? null;
  const startedAt = jobs.length ? Math.min(...jobs.map((j) => j.startedAt)) : now;
  const elapsed = clock((jobs.every((j) => j.endedAt) && jobs.length ? Math.max(...jobs.map((j) => j.endedAt!)) : now) - startedAt);

  const start = async (n: number, keep: boolean) => {
    const text = prompt.trim();
    if (!text) return;
    setError(null);
    lastPrompt = text;
    lastCount = count;
    try {
      const job = await imageGen.start({ prompt: text, aspect, count: n, ...(editor().fileId ? { fileId: editor().fileId! } : {}) });
      setJobs((all) => (keep ? [...all, job] : [job]));
      if (!keep) setChosen(null);
      setNow(Date.now());
      setPhase('sheet');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const retry = () => {
    const owners = new Set(failed.map((s) => s.job));
    setRetried((r) => new Set([...r, ...owners]));
    void start(failed.length, true);
  };
  const stop = () => {
    for (const j of jobs) if (!j.endedAt) void imageGen.cancel(j.id).then((next) => setJobs((all) => all.map((x) => (x.id === next.id ? next : x)))).catch(() => {});
  };
  const use = (s: Shown | null) => {
    if (!s?.picture.src) return;
    for (const j of jobs) if (!j.endedAt) void imageGen.cancel(j.id).catch(() => {});
    target.onPick({ src: s.picture.src, width: s.picture.width, height: s.picture.height, prompt: jobs.find((j) => j.id === s.job)?.prompt ?? prompt });
    ui().set({ generateImage: null });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const onSheetKey = (e: React.KeyboardEvent) => {
    if (!done.length) return;
    const at = Math.max(0, done.findIndex((s) => s === selected));
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 2 : e.key === 'ArrowUp' ? -2 : 0;
    if (step) {
      e.preventDefault();
      const next = done[Math.min(done.length - 1, Math.max(0, at + step))]!;
      setChosen(key(next));
      sheet.current?.querySelector<HTMLElement>(`[data-key="${key(next)}"]`)?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      use(selected);
    }
  };

  const ready = status?.state === 'ready';
  const title = phase === 'sheet' && done.length ? t('Pick a picture') : t('Generate image');
  const numberOf = (s: Shown) => shown.indexOf(s) + 1;

  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog gen-dialog" role="dialog" aria-modal="true" aria-label={title} data-testid="generate-dialog">
        <header className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="generate-close" />
        </header>

        {!status ? <div className="gen-body"><p className="gen-note">{t('Checking for the Codex CLI…')}</p></div> : null}

        {status && !ready ? (
          <>
            <div className="gen-body" data-testid="generate-unavailable">
              <p className="gen-lead">{t('Bogen makes pictures with the Codex CLI on this computer. It is optional, and uses your own Codex sign-in.')}</p>
              <div className="gen-status" role="status"><span className={`gen-dot is-${status.state}`} />{status.state === 'missing' ? t('The Codex CLI was not found.') : status.state === 'signed-out' ? t('Found {version}, but it is not signed in.', { version: status.version ?? 'codex' }) : (status.message ?? t('The Codex CLI did not answer.'))}</div>
              <ol className="gen-steps">
                <li><span className="gen-n">1</span><span>{t.rich('Install the Codex CLI, if {command} says nothing.', { command: <code>codex --version</code> })}</span></li>
                <li><span className="gen-n">2</span><span>{t.rich('Run {command} in a terminal and sign in.', { command: <code>codex login</code> })}</span></li>
                <li><span className="gen-n">3</span><span>{t('Come back and check again. Nothing else to set.')}</span></li>
              </ol>
            </div>
            <footer className="gen-foot">
              <span className="gen-note">{t('Upload image still works as before.')}</span>
              <button type="button" className="btn btn-quiet" onClick={close}>{t('Close')}</button>
              <button type="button" className="btn btn-primary" disabled={checking} onClick={() => void check(true)} data-testid="generate-recheck">{checking ? t('Checking…') : t('Check again')}</button>
            </footer>
          </>
        ) : null}

        {ready && phase === 'prompt' ? (
          <>
            <div className="gen-body">
              <label className="gen-field">
                <span className="gen-label">{t('What should the picture show?')}</span>
                <textarea ref={area} className="gen-prompt" dir="auto" rows={4} maxLength={4000} value={prompt} placeholder={t('Subject, setting, light, framing and style, in plain words')}
                  onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(count, false); } }} data-testid="generate-prompt" />
              </label>
              <div className="gen-row">
                <div className="gen-field">
                  <span className="gen-label" id="gen-shape">{t('Shape')}</span>
                  <div className="gen-seg" role="radiogroup" aria-labelledby="gen-shape">
                    {IMAGE_ASPECTS.map((a) => (
                      <button key={a} type="button" role="radio" aria-checked={aspect === a} className={`gen-segb${aspect === a ? ' is-active' : ''}`} onClick={() => setAspect(a)} data-testid={`generate-aspect-${a}`}>
                        <i className="gen-shape" style={{ width: SHAPE[a].w, height: SHAPE[a].h }} aria-hidden="true" />{t(SHAPE[a].label)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="gen-field">
                  <span className="gen-label" id="gen-count">{t('How many')}</span>
                  <div className="gen-seg" role="radiogroup" aria-labelledby="gen-count">
                    {[1, 2, 3, 4].map((n) => (
                      <button key={n} type="button" role="radio" aria-checked={count === n} className={`gen-segb${count === n ? ' is-active' : ''}`} onClick={() => setCount(n)} data-testid={`generate-count-${n}`}>{n}</button>
                    ))}
                  </div>
                </div>
              </div>
              {target.into ? <p className="gen-target">{t.rich('Goes into {layer} once you pick one.', { layer: <span className="gen-chip" dir="auto">{target.into}</span> })}</p> : <p className="gen-target">{t('Placed in the middle of the view once you pick one.')}</p>}
              {error ? <p className="gen-error" role="alert">{error}</p> : null}
            </div>
            <footer className="gen-foot">
              <span className="gen-note">{t('Uses the Codex CLI on this computer. About a minute per picture, two at a time.')}</span>
              {jobs.length ? <button type="button" className="btn btn-quiet" onClick={() => setPhase('sheet')}>{t('Back to the pictures')}</button> : <button type="button" className="btn btn-quiet" onClick={close}>{t('Cancel')}</button>}
              <button type="button" className="btn btn-primary" disabled={!prompt.trim()} onClick={() => void start(count, false)} data-testid="generate-start"><Sparkles size={14} /> {t.n(count, 'Generate {count}', 'Generate {count}')}</button>
            </footer>
          </>
        ) : null}

        {ready && phase === 'sheet' ? (
          <>
            <div className="gen-body">
              <p className="gen-said" dir="auto">{jobs.at(-1)?.prompt}</p>
              <div ref={sheet} className={`gen-sheet is-${jobs.at(-1)?.aspect ?? 'landscape'}`} role="listbox" aria-label={t('Generated pictures')} onKeyDown={onSheetKey} data-testid="generate-sheet">
                {shown.map((s) => {
                  const p = s.picture;
                  const n = numberOf(s);
                  if (p.state === 'done' && p.src) {
                    const on = selected === s;
                    return (
                      <div key={key(s)} data-key={key(s)} className={`gen-cell${on ? ' is-selected' : ''}`} role="option" aria-selected={on} tabIndex={on ? 0 : -1}
                        onClick={() => setChosen(key(s))} onDoubleClick={() => use(s)} data-testid="generate-picture">
                        <img src={resolveAsset(p.src)} alt={t('Picture {number}', { number: n })} />
                        <span className="gen-num" aria-hidden="true">{n}</span>
                        {on ? <span className="gen-tick" aria-hidden="true"><Check size={14} /></span> : null}
                        {on && p.width && p.height ? <span className="gen-size">{p.width} × {p.height}</span> : null}
                      </div>
                    );
                  }
                  if (p.state === 'failed' || p.state === 'cancelled') {
                    return (
                      <div key={key(s)} className="gen-cell gen-fail" role="option" aria-selected={false} aria-disabled="true" data-testid="generate-failed">
                        <b>{p.state === 'cancelled' ? t('Picture {number} was stopped', { number: n }) : t('Picture {number} did not come back', { number: n })}</b>
                        {p.state === 'failed' && p.error ? <span dir="auto">{p.error}</span> : null}
                      </div>
                    );
                  }
                  return (
                    <div key={key(s)} className="gen-cell gen-wait" role="option" aria-selected={false} aria-disabled="true" aria-label={p.state === 'making' ? t('Making picture {number}', { number: n }) : t('Picture {number} waits for a free slot', { number: n })}>
                      {p.state === 'making' ? <><span className="gen-spin" aria-hidden="true" />{t('Making {number} · {time}', { number: n, time: elapsed })}</> : t('Waiting for a free slot')}
                    </div>
                  );
                })}
              </div>
              {running ? <div className="gen-bar" role="progressbar" aria-label={t('{done} of {count} ready', { done: done.length, count: shown.length })} aria-valuenow={done.length} aria-valuemin={0} aria-valuemax={shown.length}><i style={{ width: `${(100 * done.length) / Math.max(1, shown.length)}%` }} /></div> : null}
              {error ? <p className="gen-error" role="alert">{error}</p> : null}
            </div>
            <footer className="gen-foot">
              <span className="gen-note" aria-live="polite">
                {running ? t('{done} of {count} ready · {time}. Pictures that are done stay, even if you stop.', { done: done.length, count: shown.length, time: elapsed })
                  : t('{done} of {count} ready in {time}. The others stay in this file\'s images.', { done: done.length, count: shown.length, time: elapsed })}
              </span>
              {running ? <button type="button" className="btn" onClick={stop} data-testid="generate-stop">{t('Stop')}</button> : (
                <>
                  <button type="button" className="btn btn-quiet" onClick={() => setPhase('prompt')}>{t('Change the prompt')}</button>
                  {failed.length ? <button type="button" className="btn" onClick={retry} data-testid="generate-retry">{t.n(failed.length, 'Try {count} again', 'Try {count} again')}</button>
                    : <button type="button" className="btn" onClick={() => void start(count, true)} data-testid="generate-more">{t.n(count, 'Make {count} more', 'Make {count} more')}</button>}
                </>
              )}
              <button type="button" className="btn btn-primary" disabled={!selected} onClick={() => use(selected)} data-testid="generate-use">{selected ? t('Use picture {number}', { number: numberOf(selected) }) : t('Use picture')}</button>
            </footer>
          </>
        ) : null}
      </div>
    </div>
  );
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
