import { useEffect, useRef, useState } from 'react';
import { api, type Runner } from '../lib/api.ts';
import { brandApi, type BrandListItem, type UrlJob } from '../lib/brand-api.ts';
import { useT } from '../i18n/react.ts';
import { runnerName } from '../panels/RunChoice.tsx';

/**
 * The prompt box at the top of Home: say what to make, and Bogen makes one file of that kind, in the folder, with the
 * brand, and hands the prompt to the agent there. Or paste a website address and take its brand.
 * Designed in the Bogen file "Adaptive workspace" (P1, P3, P6) and "Bogen Brand System", page Brand book (IA 1).
 */

type Kind = 'website' | 'app' | 'omarchy-theme' | 'brand-url';
const RUNNER_KEY = 'bogen-prompt-runner';
const URL_IN = /\bhttps?:\/\/[^\s"'<>]+/i;

function remembered(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
}

/** A file name from the first words of a prompt. */
function nameFrom(prompt: string): string {
  const words = prompt.replace(URL_IN, '').replace(/[^\p{L}\p{N}\s'&-]/gu, ' ').trim().split(/\s+/).slice(0, 6).join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 60) || 'Untitled';
}

export function Composer({ folder, brands, onBrands }: { folder: string | null; brands: BrandListItem[] | null; onBrands?: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<Kind>('website');
  const [prompt, setPrompt] = useState('');
  const [brand, setBrand] = useState<string>(() => remembered('bogen-composer-brand') ?? '');
  const [runners, setRunners] = useState<Runner[]>([]);
  const [runner, setRunner] = useState<string>(() => remembered(RUNNER_KEY) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlChoice, setUrlChoice] = useState<'ask' | 'text'>('ask');
  useEffect(() => { void api.runners().then((list) => setRunners(list.filter((r) => r.available)), () => {}); }, []);
  const chosen = runners.find((r) => r.id === runner) ?? runners[0];
  const known = brands?.find((b) => b.id === brand);
  const labels: Record<Kind, string> = { website: t('Website'), app: t('App interface'), 'omarchy-theme': t('Omarchy theme'), 'brand-url': t('Brand from a website') };
  const link = kind !== 'brand-url' && urlChoice === 'ask' ? URL_IN.exec(prompt)?.[0] : undefined;

  const create = async () => {
    if (!prompt.trim() || !chosen) return;
    setBusy(true); setError(null);
    try {
      const file = await api.createFile(nameFrom(prompt));
      if (folder) await api.moveFile(file.id, folder).catch(() => {});
      await api.setProject(file.id, { type: kind === 'brand-url' ? 'website' : kind });
      if (known) await brandApi.link(file.id, known.id);
      remember(RUNNER_KEY, chosen.id);
      remember('bogen-composer-brand', known?.id ?? '');
      await api.startRun({ fileId: file.id, nodeIds: [], prompt: prompt.trim(), runner: chosen.id, intent: 'new_page' });
      location.hash = `#/file/${file.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const where = folder ? folder.split('/').at(-1)! : t('All files');
  const hint = kind === 'brand-url' ? null
    : !chosen ? t('No agent is set up on this computer. Settings shows how to connect Claude Code or Codex.')
    : known ? t('Makes one file in {folder}, following {brand}, and {agent} draws it there.', { folder: where, brand: known.name, agent: runnerName(chosen.id) })
    : t('Makes one file in {folder} and {agent} draws it there.', { folder: where, agent: runnerName(chosen.id) });

  return (
    <section className="composer" aria-label={t('Start something')} data-testid="composer">
      <div className="composer-box">
        <div className="composer-tabs" role="tablist" aria-label={t('What to make')}>
          {(Object.keys(labels) as Kind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => { setKind(k); setError(null); }} data-testid={`composer-kind-${k}`}>{labels[k]}</button>
          ))}
        </div>
        {kind === 'brand-url' ? <FromWebsite brands={brands} initial={URL_IN.exec(prompt)?.[0] ?? ''} {...(onBrands ? { onDone: onBrands } : {})} /> : <>
          <textarea
            className="composer-prompt"
            value={prompt}
            rows={2}
            placeholder={kind === 'website' ? t('A landing page for a ceramics studio: classes, opening hours, the shop.') : kind === 'app' ? t('A habit tracker for iOS: today, a streak, a gentle reminder.') : t('A calm dark theme with warm greys and one green.')}
            aria-label={t('What should it be?')}
            onChange={(e) => { setPrompt(e.target.value); if (!URL_IN.test(e.target.value)) setUrlChoice('ask'); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void create(); }}
            data-testid="composer-prompt"
            dir="auto"
          />
          {link ? (
            <div className="composer-link" role="group" aria-label={t('The prompt has a link')} data-testid="composer-link">
              <span>{t('The prompt has a link. Use {host} for', { host: hostOf(link) })}</span>
              <button type="button" className="btn btn-quiet" onClick={() => setKind('brand-url')} data-testid="composer-link-brand">{t('Its brand')}</button>
              <button type="button" className="btn btn-quiet" onClick={() => setUrlChoice('text')} data-testid="composer-link-text">{t('Nothing: just text')}</button>
            </div>
          ) : null}
          <div className="composer-bar">
            <label className="composer-pick"><span>{t('Brand')}</span>
              <select value={known ? brand : ''} onChange={(e) => setBrand(e.target.value)} data-testid="composer-brand">
                <option value="">{t('None')}</option>
                {(brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <span className="composer-spacer" />
            {runners.length > 1 ? (
              <label className="composer-pick"><span>{t('To')}</span>
                <select value={chosen?.id ?? ''} onChange={(e) => setRunner(e.target.value)} data-testid="composer-runner">
                  {runners.map((r) => <option key={r.id} value={r.id}>{runnerName(r.id)}</option>)}
                </select>
              </label>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={busy || !prompt.trim() || !chosen} onClick={() => void create()} data-testid="composer-create">
              {busy ? t('Making the file…') : kind === 'app' ? t('Create app interface') : kind === 'omarchy-theme' ? t('Create theme') : t('Create website')}
            </button>
          </div>
        </>}
      </div>
      {hint ? <p className="composer-hint" data-testid="composer-hint">{hint}</p> : null}
      {error ? <p className="error" role="alert" data-testid="composer-error">{error}</p> : null}
    </section>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/**
 * A brand from a website address: Bogen captures the page and reads what it really uses, without an agent, and
 * everything arrives as suggestions to review. The address and choices stay filled in when it fails.
 */
export function FromWebsite({ brands, initial = '', onDone }: { brands: BrandListItem[] | null; initial?: string; onDone?: () => void }) {
  const t = useT();
  const [url, setUrl] = useState(initial);
  const [into, setInto] = useState('');
  const [job, setJob] = useState<UrlJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const timer = window.setInterval(() => {
      void brandApi.job(job.id).then((next) => {
        setJob(next);
        if (next.state !== 'running') onDone?.();
      }, () => {});
    }, 700);
    return () => clearInterval(timer);
  }, [job?.id, job?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async (again?: string) => {
    setError(null);
    const address = /^[a-z][\w+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    try {
      setJob(await brandApi.fromUrl(address, again ?? (into || undefined)));
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const host = job ? hostOf(job.url) : '';
  const steps: { id: UrlJob['step'] | 'review'; label: string }[] = [
    { id: 'capture', label: t('Load the page and capture it at 1440 × 900') },
    { id: 'read', label: t('Read what the rendered page uses') },
    { id: 'save', label: t('Save it as suggestions') },
  ];
  const at = job ? steps.findIndex((s) => s.id === job.step) : -1;
  const review = job ? `#/brand/${job.brandId}/review` : '#/brands';

  return (
    <div className="from-website" data-testid="from-website">
      <div className="from-website-form">
        <label className="from-website-url"><span>{t('Website address')}</span>
          <input ref={field} type="url" inputMode="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && url.trim()) void start(); }} data-testid="from-website-url" disabled={job?.state === 'running'} />
        </label>
        <p className="from-website-what">{t('Bogen reads the colours, fonts, spacing and logo candidates the page really uses. They arrive as suggestions: nothing binds until you confirm it. No agent is needed.')}</p>
        <div className="composer-bar">
          <label className="composer-pick"><span>{t('Into')}</span>
            <select value={into} onChange={(e) => setInto(e.target.value)} data-testid="from-website-into" disabled={job?.state === 'running'}>
              <option value="">{t('A new brand')}</option>
              {(brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <span className="composer-spacer" />
          <button type="button" className="btn btn-primary" disabled={!url.trim() || job?.state === 'running'} onClick={() => void start()} data-testid="from-website-start">{t('Take the brand')}</button>
        </div>
      </div>
      {error ? <div className="from-website-card is-failed" role="alert" data-testid="from-website-error"><p>{error}</p></div> : null}
      {job ? (
        <div className={`from-website-card is-${job.state}`} role="status" aria-live="polite" data-testid="from-website-job" data-state={job.state}>
          {job.state === 'running' ? <>
            <div className="from-website-head"><strong>{t('Taking the brand from {host}', { host })}</strong><button type="button" className="btn btn-quiet" onClick={() => void brandApi.cancelJob(job.id).then(setJob)} data-testid="from-website-cancel">{t('Cancel')}</button></div>
            <ol className="from-website-steps">{steps.map((s, i) => <li key={s.id} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>{s.label}</li>)}</ol>
            <p className="from-website-note">{t('You can leave Home. The brand appears under Brands when it is done.')}</p>
          </> : job.state === 'failed' ? <>
            <p><strong>{t('Could not take the brand from {host}.', { host })}</strong> {job.error}</p>
            <p className="from-website-note">{t('Nothing was saved, and no brand was made.')}</p>
            <div className="from-website-actions"><button type="button" className="btn" onClick={() => void start()} data-testid="from-website-retry">{t('Retry')}</button><button type="button" className="btn btn-quiet" onClick={() => { setJob(null); field.current?.focus(); }}>{t('Edit address')}</button></div>
          </> : job.state === 'cancelled' ? <p>{t('Cancelled. Nothing was kept.')}</p> : <>
            <strong>{job.state === 'ready' ? t('{brand} is ready to review', { brand: job.brandName }) : t('Partly taken from {host}', { host })}</strong>
            {job.found ? <dl className="from-website-found">
              <dt>{t('Colours')}</dt><dd>{job.found.colors}</dd>
              <dt>{t('Fonts')}</dt><dd>{job.found.families_named.join(', ') || t('none')}</dd>
              <dt>{t('Type sizes')}</dt><dd>{job.found.typeSteps}</dd>
              <dt>{t('Logos')}</dt><dd>{job.found.logos || t('none')}</dd>
            </dl> : null}
            {job.notes.length ? <ul className="from-website-notes">{job.notes.slice(0, 4).map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
            <div className="from-website-actions"><a className="btn btn-primary" href={review} data-testid="from-website-review">{t('Review what was found')}</a>{job.state === 'partial' ? <button type="button" className="btn" onClick={() => void start(job.brandId)}>{t('Retry')}</button> : null}</div>
          </>}
        </div>
      ) : null}
    </div>
  );
}
