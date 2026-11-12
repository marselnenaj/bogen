import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { brandApi, type BrandDrift, type BrandScores } from '../lib/brand-api.ts';
import { formatDateTime } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';

/** A small line of scores over time, 0 to 100. Nothing with fewer than two points. */
export function Sparkline({ points, width = 96, height = 22, testId }: { points: { at: number; score: number }[]; width?: number; height?: number; testId?: string }) {
  const t = useT();
  if (points.length < 2) return null;
  const xs = points.map((_, i) => (i / (points.length - 1)) * (width - 2) + 1);
  const ys = points.map((p) => height - 1 - (Math.max(0, Math.min(100, p.score)) / 100) * (height - 2));
  const last = points.at(-1)!;
  const first = points[0]!;
  return (
    <svg className="bh-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t.n(points.length, 'Score from {from} to {to} over {count} check', 'Score from {from} to {to} over {count} checks', { from: first.score, to: last.score })} data-testid={testId}>
      <polyline points={xs.map((x, i) => `${x},${ys[i]}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={xs.at(-1)} cy={ys.at(-1)} r="2" fill="currentColor" />
    </svg>
  );
}

function Change({ value }: { value: number | undefined }) {
  if (value === undefined || value === 0) return null;
  return <span className={`bh-change${value > 0 ? ' is-up' : ' is-down'}`}>{value > 0 ? `+${value}` : `${value}`}</span>;
}

/**
 * Brand drift across files, on the brand's page: every linked file with its score and its trend, worst first, its
 * worst layers linked into the file, and a summary over time. Check all runs brand_check on each linked file.
 */
export function BrandHealth({ brandId, by }: { brandId: string; by: string }) {
  const t = useT();
  const [scores, setScores] = useState<BrandScores | null>(null);
  const [drift, setDrift] = useState<BrandDrift | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => brandApi.scores(brandId).then(setScores).catch((e: Error) => setError(e.message)), [brandId]);
  useEffect(() => { void load(); }, [load]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setDrift(await brandApi.drift(brandId, by));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summary = scores?.summary ?? [];
  const last = summary.at(-1);
  const previous = summary.at(-2);
  const files = drift?.files ?? scores?.files.map((f) => {
    const p = f.points.at(-1);
    return { file_id: f.file_id, file_name: f.file_name, score: p?.score ?? null, hard: p?.hard ?? 0, soft: p?.soft ?? 0, layers: p?.layers ?? 0, worst: [], trend: null };
  }).sort((a, b) => (a.score ?? 101) - (b.score ?? 101)) ?? [];
  const pointsOf = (id: string) => scores?.files.find((f) => f.file_id === id)?.points ?? [];
  return (
    <>
      <section className="bp-group" data-testid="brand-health">
        <header className="bp-group-head">
          <span className="bp-group-title">{t('Across linked files')}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => void run()} data-testid="brand-health-run"><RefreshCw size={14} /> {busy ? t('Checking') : t('Check all linked files')}</button>
        </header>
        <div className="bp-group-hint">{t('Each linked file checked as a whole against this brand, worst first. Scores are kept on this device each time a whole file is checked, by you, an agent or a run, so the lines show how each file moves.')}</div>
        <div className="bh-summary" data-testid="brand-health-summary">
          {last ? (
            <>
              <strong>{last.score}</strong>
              <span className="bp-note">{t.n(last.files, 'mean of {count} file, {hard} hard and {soft} soft open, {date}', 'mean of {count} files, {hard} hard and {soft} soft open, {date}', { hard: last.hard, soft: last.soft, date: formatDateTime(last.at) })}</span>
              <Change value={previous ? last.score - previous.score : undefined} />
              <Sparkline points={summary} width={160} height={28} testId="brand-health-trend" />
            </>
          ) : <span className="bp-note">{t('Not checked yet. Check all linked files to start the history.')}</span>}
        </div>
        {error ? <div className="error">{error}</div> : null}
      </section>
      <section className="bp-group">
        <div className="bp-rows" data-testid="brand-health-files">
          {!files.length ? <div className="bp-note">{t('No files link to this brand yet.')}</div> : null}
          {files.map((f) => (
            <div key={f.file_id} className="bh-file" data-testid="brand-health-file" data-file={f.file_name}>
              <div className="bp-row">
                <a className="bp-sample" href={`#/file/${f.file_id}`} dir="auto">{f.file_name}</a>
                <span className="bh-score">{f.score ?? t('nothing drawn')}</span>
                <Change value={f.trend?.change} />
                <Sparkline points={pointsOf(f.file_id)} testId="brand-health-file-trend" />
                <span className="bp-note">{t('{hard} hard, {soft} soft', { hard: f.hard, soft: f.soft })}</span>
              </div>
              {f.worst.length ? (
                <div className="bh-worst">
                  {f.worst.map((w) => (
                    <a key={w.node_id} className="bh-layer" href={`#/file/${f.file_id}?select=${w.node_id}`} title={w.first} data-testid="brand-health-layer">
                      <span className="bh-layer-name" dir="auto">{w.page ? `${w.page} / ` : ''}{w.layer}</span>
                      <span className="bp-note">{w.hard && w.soft ? t('{hard} hard, {soft} soft: {problem}', { hard: w.hard, soft: w.soft, problem: w.first }) : w.hard ? t('{hard} hard: {problem}', { hard: w.hard, problem: w.first }) : w.soft ? t('{soft} soft: {problem}', { soft: w.soft, problem: w.first }) : `: ${w.first}`}</span>
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
