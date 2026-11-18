import { useEffect, useMemo, useState } from 'react';
import { changedEditionParts, type BrandData } from '@bogen/core';
import { PenTool } from 'lucide-react';
import { onServerEvent } from '../lib/events.ts';
import { editionAgent, editionApi, PART_LABELS, startEdition, type EditionStatus } from '../lib/brand-edition.ts';
import { formatDate, formatList } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';

/**
 * The designed edition on the brand's book: a button that has an agent art-direct the book as pages in a file of its
 * own, or, once there is one, a link to it, whether an agent works on it, and which parts of the brand changed since.
 * What changed is compared with the brand as it is open here, so it follows an edit at once.
 */
export function BrandEdition({ brandId, brandName, data, by }: { brandId: string; brandName: string; data: BrandData; by: string }) {
  const t = useT();
  const [status, setStatus] = useState<EditionStatus | null | undefined>(undefined);
  const [asking, setAsking] = useState<{ refresh: boolean; agent: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => { void editionApi.status(brandId).then((s) => { if (live) setStatus(s); }, () => { if (live) setStatus(null); }); };
    load();
    const off = onServerEvent((e) => {
      if (e.t === 'brand' && e.id === brandId) load();
      if (e.t === 'files') load();
    });
    return () => { live = false; off(); };
  }, [brandId]);

  const changed = useMemo(() => (status ? changedEditionParts(status, data) : []), [status, data]);

  const ask = async (refresh: boolean) => {
    setError(null);
    const agent = await editionAgent().catch(() => null);
    if (!agent) return setError(t('Install {claude} or {codex} to design a brand book.', { claude: 'claude', codex: 'codex' }));
    setAsking({ refresh, agent: agent.label });
  };
  const start = async () => {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      await startEdition({ brandId, brandName, by, refresh: asking.refresh, ...(status ? { fileName: status.file_name } : {}) });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setAsking(null);
    }
  };

  if (status === undefined) return null;
  const parts = formatList(changed.map((p) => t(PART_LABELS[p])));
  return (
    <div className="bp-edition" role="region" aria-label={t('Designed edition')} data-testid="brand-edition">
      <PenTool size={14} aria-hidden="true" className="bp-edition-icon" />
      {asking ? (
        <>
          <p data-testid="brand-edition-confirm">{asking.refresh
            ? t('{agent} redoes the pages that show {parts} in the designed edition, on your plan, then has them reviewed again.', { agent: asking.agent, parts })
            : t('{agent} designs the book as editable pages in a new file, on your plan, and has an independent reviewer judge it once. It takes half an hour or more.', { agent: asking.agent })}</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()} data-testid="brand-edition-start">{busy ? t('Starting') : t('Start')}</button>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => setAsking(null)} data-testid="brand-edition-cancel">{t('Cancel')}</button>
        </>
      ) : status ? (
        <>
          <p>
            <span>{t('Designed edition')}: </span>
            <a href={`#/file/${status.file_id}`} dir="auto" data-testid="brand-edition-open">{status.file_name}</a>
            <span className="bp-edition-meta"> · {status.running ? (status.refreshing ? t('an agent is refreshing it now') : t('an agent is working on it now')) : t('made {date}', { date: formatDate(status.at) })}</span>
            {!status.running && changed.length ? <span className="bp-edition-stale" data-testid="brand-edition-stale"> · {t('The brand changed since: {parts}.', { parts })}</span> : null}
          </p>
          {!status.running && changed.length ? <button type="button" className="btn" onClick={() => void ask(true)} data-testid="brand-edition-refresh">{t('Refresh those pages')}</button> : null}
          {!status.running ? <button type="button" className="btn btn-quiet" onClick={() => void ask(false)} data-testid="brand-edition-make">{t('Make a new edition')}</button> : null}
        </>
      ) : (
        <>
          <p>{t('One template serves every brand. A designed edition is art-directed for this one: applications from its world, fewer and fuller pages, its quirks on show.')}</p>
          <button type="button" className="btn" onClick={() => void ask(false)} data-testid="brand-edition-make">{t('Make a designed edition')}</button>
        </>
      )}
      {error ? <div className="error" role="alert" dir="auto" data-testid="brand-edition-error">{error}</div> : null}
    </div>
  );
}
