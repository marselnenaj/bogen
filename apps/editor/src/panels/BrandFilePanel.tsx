import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Wand2 } from 'lucide-react';
import { session } from '../doc/session.ts';
import { brandApi, type BrandListItem, type BrandReport, type BrandViolation, type FileBrand, type FileImpact } from '../lib/brand-api.ts';
import { api } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { editor, useEditor } from '../state/store.ts';
import { SelectField } from '../ui/controls.tsx';
import { useBrandState } from './brand-state.ts';
import { MemorySuggestions } from './MemorySuggestions.tsx';
import { ScoreParts } from './ScoreParts.tsx';
import { Sparkline } from './BrandHealth.tsx';
import { useT } from '../i18n/react.ts';

const NONE = '__none';

/** Selects layers a finding is about, on the page of the first one, and brings that page up. */
function selectLayers(ids: string[]): void {
  const { doc } = session();
  const live = ids.filter((id) => doc.getNode(id));
  if (!live.length) return;
  const pageId = doc.pageOf(live[0]!);
  editor().set({ ...(pageId ? { pageId } : {}), selection: live.filter((id) => doc.pageOf(id) === pageId) });
}

function Violation({ v, fileId, onWaived }: { v: BrandViolation; fileId: string; onWaived: () => void }) {
  const t = useT();
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const select = () => {
    if (v.node_id && session().doc.getNode(v.node_id)) {
      const pageId = session().doc.pageOf(v.node_id);
      editor().set({ ...(pageId ? { pageId } : {}), selection: [v.node_id] });
    }
  };
  const waive = async () => {
    if (!reason.trim()) return;
    try {
      await brandApi.waive(fileId, { nodeId: v.node_id, rule: v.rule, reason: reason.trim(), by: session().user.name });
      onWaived();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="bf-item" data-testid="brand-violation" data-rule={v.rule} data-node-id={v.node_id}>
      <div className="bf-item-head">
        <span className={`bf-dot${v.severity === 'hard' ? ' is-hard' : ''}`} title={v.severity === 'hard' ? t('Hard: a requirement') : t('Soft: a default')} />
        <button type="button" className="bf-item-text" style={{ textAlign: 'left' }} onClick={select}>{v.message}</button>
      </div>
      {v.rule_text ? <div className="bf-fix">{t('Brand rule: {rule}', { rule: v.rule_text })}</div> : null}
      <div className="bf-fix">{v.fix.description}</div>
      {v.node_id ? (
        waiving ? (
          <div className="bf-waive">
            <input autoFocus placeholder={t('Why is this fine here?')} dir="auto" value={reason} data-testid="brand-waive-reason" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void waive(); if (e.key === 'Escape') setWaiving(false); }} />
            <button type="button" className="btn btn-quiet" disabled={!reason.trim()} onClick={() => void waive()} data-testid="brand-waive-confirm">{t('Waive')}</button>
          </div>
        ) : <div className="bf-actions"><button type="button" className="bf-link" onClick={() => setWaiving(true)} data-testid="brand-waive">{t('Waive for this layer')}</button></div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}

/** The Brand tab of a file: which brand it follows, how it stands, what to do about it. */
export function BrandFilePanel() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId)!;
  const [brands, setBrands] = useState<BrandListItem[]>([]);
  const [file, setFile] = useState<FileBrand | null>(null);
  const [impact, setImpact] = useState<FileImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useBrandState((s) => (s.reportFileId === fileId ? s.report : null));
  const markers = useBrandState((s) => s.markers);
  const runs = useBrandState((s) => s.runs);

  const load = useCallback(() => {
    brandApi.list().then(setBrands).catch(() => setBrands([]));
    brandApi.ofFile(fileId).then((f) => {
      setFile(f);
      if (f.updateAvailable && f.link) brandApi.impact(f.link.id).then((i) => setImpact(i.files.find((x) => x.file_id === fileId) ?? null)).catch(() => setImpact(null));
      else setImpact(null);
    }).catch((err: Error) => setError(err.message));
  }, [fileId]);

  const check = useCallback(async (fix = false) => {
    setBusy(true);
    setError(null);
    try {
      const out: BrandReport = await brandApi.check(fileId, { fix });
      useBrandState.getState().set({ report: out, reportFileId: fileId });
      if (fix) editor().showToast(out.fixed?.length ? t.n(out.fixed.length, '{count} safe fixes applied. Undo them from the Agents tab, under brand.', '{count} safe fixes applied. Undo them from the Agents tab, under brand.') : t('Nothing could be fixed safely.'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [fileId, t]);

  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'brand' || e.t === 'files') load(); });
  }, [load]);

  const linked = file?.link?.id ?? null;
  useEffect(() => {
    if (linked && !file?.note?.missing && !report) void check();
  }, [linked, file?.note?.missing]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = async (value: string) => {
    setError(null);
    useBrandState.getState().set({ report: null, reportFileId: null });
    try {
      await brandApi.link(fileId, value === NONE ? null : value);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyUpdate = async () => {
    if (!linked) return;
    setBusy(true);
    try {
      const result = await brandApi.apply(linked, session().user.name, [fileId]);
      editor().showToast(t.n(result.files[0]?.layers ?? 0, 'Version {version} applied to {count} layers. Undo it from the Agents tab, under brand.', 'Version {version} applied to {count} layers. Undo it from the Agents tab, under brand.', { version: result.version }));
      load();
      await check();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unwaive = async (nodeId: string, rule: string) => {
    await brandApi.unwaive(fileId, { nodeId, rule });
    load();
    void check();
  };

  const options = [{ value: NONE, label: t('No brand') }, ...brands.map((b) => ({ value: b.id, label: b.name }))];
  return (
    <div className="bf" data-testid="brand-file-panel">
      <div className="bf-row">
        <SelectField<string> value={linked ?? NONE} options={options} onChange={(v) => void link(v)} testId="brand-file-select" title={t('The brand of this file')} />
        {/* A brand that is not here has no page to open: the hint below says what happened. */}
        {linked && !file?.note?.missing ? <a className="icon-btn" href={`#/brand/${linked}`} title={t('Open the brand')} aria-label={t('Open the brand')} data-testid="brand-open-from-file"><ExternalLink size={14} /></a> : null}
      </div>
      {!linked ? <div className="hint">{t('Link a brand, and agents working here stay within its colours, type and rules. Files work fine without one.')}</div> : null}
      {file?.note?.missing ? <div className="hint" data-testid="brand-missing">{t('This file links to a brand that is not on this device. It may still be syncing, or it was deleted.')}</div> : null}
      {error ? <div className="error" data-testid="brand-file-error">{error}</div> : null}

      {file?.updateAvailable ? (
        <div className="bf-item" data-testid="brand-update">
          <div>{file.linkedVersion ? t('Version {version} of the brand is out, and this file follows version {linked}.', { version: String(file.version), linked: file.linkedVersion }) : t('Version {version} of the brand is out.', { version: String(file.version) })}{impact ? ` ${t('Taking it over changes {layers} and {tokens}.', { layers: t.n(impact.layer_count, '{count} layer', '{count} layers'), tokens: t.n(impact.tokens.length, '{count} token', '{count} tokens') })}` : ''}</div>
          <div className="bf-row"><button type="button" className="btn" disabled={busy} onClick={() => void applyUpdate()} data-testid="brand-apply">{t('Take it over')}</button></div>
        </div>
      ) : null}

      {linked && !file?.note?.missing ? (
        <>
          <div className="bf-row" style={{ justifyContent: 'space-between' }}>
            <div className="bf-score" data-testid="brand-score" title={report?.score.formula}>
              {report?.counts.layers === 0 && !report.violations.length ? <span className="hint">{t('Nothing is drawn here yet')}</span> : report ? <><strong>{report.score.value}</strong><span className="hint">{report.counts.waived ? t('{hard} hard, {soft} soft, {waived} waived', { hard: report.counts.hard, soft: report.counts.soft, waived: report.counts.waived }) : t('{hard} hard, {soft} soft', { hard: report.counts.hard, soft: report.counts.soft })}</span>{report.history ? <span className="bf-trend" title={t("This file's score each time it was checked as a whole")}><Sparkline points={report.history} width={64} height={18} testId="brand-file-trend" /></span> : null}</> : <span className="hint">{busy ? t('Checking') : t('Not checked yet')}</span>}
            </div>
            <div className="row-tight">
              <button type="button" className="icon-btn" title={t('Check again')} aria-label={t('Check again')} disabled={busy} onClick={() => void check()} data-testid="brand-check"><RefreshCw size={14} /></button>
              <button type="button" className="icon-btn" title={t('Apply safe fixes')} aria-label={t('Apply safe fixes')} disabled={busy || !report?.violations.some((v) => v.fix.safe)} onClick={() => void check(true)} data-testid="brand-fix"><Wand2 size={14} /></button>
            </div>
          </div>
          <label className="check" title={t('Marks layers that break the brand with a small dot on the canvas')}>
            <input type="checkbox" checked={markers} onChange={(e) => useBrandState.getState().set({ markers: e.target.checked })} data-testid="brand-markers-toggle" />
            <span>{t('Show on the canvas')}</span>
          </label>
          {report?.score.categories.length ? <ScoreParts score={report.score} onSelect={selectLayers} /> : null}
          {report?.violations.length ? (
            <div>
              <div className="bf-title">{t('Open')}</div>
              <div className="bf-list">{[...report.violations].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1)).slice(0, 100).map((v, i) => <Violation key={`${v.node_id}${v.rule}${i}`} v={v} fileId={fileId} onWaived={() => { load(); void check(); }} />)}</div>
            </div>
          ) : null}
          {report?.checklist.length ? (
            <div data-testid="brand-checklist">
              <div className="bf-title">{t('To judge by eye')}</div>
              <div className="hint">{t('No machine can check these, so they are not in the score.')}</div>
              <div className="bf-list">{report.checklist.map((c) => <div key={c.rule_id} className="bf-item">{c.text}</div>)}</div>
            </div>
          ) : null}
          {report?.not_checked.length ? (
            <div>
              <div className="bf-title">{t('Not checked')}</div>
              <div className="bf-list">{report.not_checked.slice(0, 8).map((c) => <div key={c} className="bf-item">{c}</div>)}</div>
            </div>
          ) : null}
          {file?.waivers.length ? (
            <div data-testid="brand-waivers">
              <div className="bf-title">{t('Waived by a person')}</div>
              <div className="bf-list">{file.waivers.map((w) => (
                <div key={`${w.nodeId}${w.rule}`} className="bf-item" data-testid="brand-waiver">
                  <div>{session().doc.getNode(w.nodeId)?.name ?? w.nodeId}: {w.rule}</div>
                  <div className="bf-fix" dir="auto">{w.by}: {w.reason}</div>
                  <div className="bf-actions"><button type="button" className="bf-link" onClick={() => void unwaive(w.nodeId, w.rule)}>{t('Take back')}</button></div>
                </div>
              ))}</div>
            </div>
          ) : null}
          <MemorySuggestions brandId={linked} />
          {runs.length ? <RunReports /> : null}
        </>
      ) : null}
    </div>
  );
}

/** What runs left behind. In the Agents tab too. */
export function RunReports() {
  const t = useT();
  const runs = useBrandState((s) => s.runs);
  if (!runs.length) return null;
  return (
    <div className="feed" data-testid="brand-run-reports">
      <div className="feed-title">{t('Brand check after runs')}</div>
      {runs.slice(0, 5).map((r) => (
        <div key={r.runId} className="bf-item" data-testid="brand-run-report">
          <div>{r.runner}: {r.text}</div>
          {r.violations.filter((v) => v.severity === 'hard').slice(0, 5).map((v, i) => <div key={i} className="bf-fix">{v.message}</div>)}
        </div>
      ))}
    </div>
  );
}

export { api };
