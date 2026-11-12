import { useState } from 'react';
import { exportDocument } from '@bogen/core';
import { Download, Plus, Trash2 } from 'lucide-react';
import { unionRects } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { downloadBlob, resolveAsset } from '../lib/api.ts';
import { useEditor } from '../state/store.ts';
import { phoneOrigin } from '../lib/phone.ts';
import { ui } from '../state/ui.ts';
import { IconButton, NumberField, Segmented, SelectField } from '../ui/controls.tsx';
import { EXPORT_PRESETS } from './inspector/presets.ts';
import { openAppCompare, openAppScreenBeside, TomaccoReadiness, useAppScreenCloses } from './AppScreens.tsx';
import '../styles/transfer.css';
import { useT } from '../i18n/react.ts';
import { msg, type Translate } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'webp', label: 'WebP' },
  { value: 'avif', label: 'AVIF' },
  { value: 'svg', label: 'SVG' },
  { value: 'pdf', label: 'PDF' },
  { value: 'html', label: 'HTML' },
  { value: 'prototype', label: msg('Clickable prototype') },
  { value: 'mp4', label: msg('MP4 video') },
  { value: 'webm', label: msg('WebM video') },
];

type Row = { format: string; scale?: number; width?: number; suffix?: string };

const SETS: { label: string; rows: Row[] }[] = [
  { label: msg('Web'), rows: [{ format: 'webp', scale: 1 }, { format: 'webp', scale: 2 }, { format: 'avif', scale: 2 }, { format: 'png', scale: 1 }] },
  { label: 'iOS', rows: [{ format: 'png', scale: 1 }, { format: 'png', scale: 2 }, { format: 'png', scale: 3 }] },
  { label: 'Android', rows: [{ format: 'png', scale: 1, suffix: '-mdpi' }, { format: 'png', scale: 1.5, suffix: '-hdpi' }, { format: 'png', scale: 2, suffix: '-xhdpi' }, { format: 'png', scale: 3, suffix: '-xxhdpi' }, { format: 'png', scale: 4, suffix: '-xxxhdpi' }] },
  { label: msg('Social'), rows: [{ format: 'png', width: 1200, suffix: '-1200' }, { format: 'jpg', width: 1080, suffix: '-1080' }, { format: 'webp', width: 640, suffix: '-640' }] },
  { label: msg('Vector'), rows: [{ format: 'svg' }, { format: 'pdf' }] },
];

const PRESET_FORMATS = FORMATS.filter((f) => f.value !== 'mp4' && f.value !== 'webm' && f.value !== 'prototype');

interface Report { fallbacks?: { id: string; name: string; reason: string }[]; native?: number; encoder?: string; codec?: string; frames?: number; width?: number; height?: number; notes?: string[] }

async function postExport(path: string, data: unknown): Promise<{ blob: Blob; report: Report | null }> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // A plain text answer stays as it is.
    }
    throw new Error(message || t('Export failed with {status}', { status: res.status }));
  }
  const header = res.headers.get('X-Bogen-Export-Report');
  let report: Report | null = null;
  if (header) {
    try {
      report = JSON.parse(decodeURIComponent(header)) as Report;
    } catch {
      // Only a report.
    }
  }
  return { blob: await res.blob(), report };
}

/** "Made with …": one message for each combination of what the encoder reported. */
const MADE_WITH = {
  '': msg('Made with {encoder}.'),
  c: msg('Made with {encoder} as {codec}.'),
  f: msg('Made with {encoder}: {frames} frames.'),
  cf: msg('Made with {encoder} as {codec}: {frames} frames.'),
  s: msg('Made with {encoder}, {width} × {height}.'),
  cs: msg('Made with {encoder} as {codec}, {width} × {height}.'),
  fs: msg('Made with {encoder}: {frames} frames, {width} × {height}.'),
  cfs: msg('Made with {encoder} as {codec}: {frames} frames, {width} × {height}.'),
} as const;

function madeWith(t: Translate, report: Report): string {
  const key = `${report.codec ? 'c' : ''}${report.frames ? 'f' : ''}${report.width ? 's' : ''}` as keyof typeof MADE_WITH;
  return t(MADE_WITH[key], { encoder: report.encoder ?? '', codec: report.codec ?? '', frames: report.frames ?? 0, width: report.width ?? 0, height: String(report.height) });
}

function ReportView({ report }: { report: Report }) {
  const t = useT();
  return (
    <div className="export-report" data-testid="export-report">
      {report.native !== undefined ? <div>{t.n(report.native, '{count} native vector elements.', '{count} native vector elements.')}</div> : null}
      {report.fallbacks?.length ? (
        <>
          <div>{t.n(report.fallbacks.length, '{count} layer stayed HTML in a foreignObject, which vector tools do not show:', '{count} layers stayed HTML in a foreignObject, which vector tools do not show:')}</div>
          {report.fallbacks.slice(0, 20).map((f, i) => <div key={i} className="export-fallback" data-testid="export-fallback">{f.name}: {f.reason}</div>)}
        </>
      ) : report.native !== undefined ? <div>{t('Nothing fell back.')}</div> : null}
      {report.encoder ? <div>{madeWith(t, report)}</div> : null}
      {report.notes?.map((n) => <div key={n}>{n}</div>)}
    </div>
  );
}

export function ExportPanel() {
  const t = useT();
  const selection = useEditor((s) => s.selection);
  const appScreenCloses = useAppScreenCloses();
  const pageId = useEditor((s) => s.pageId);
  const fileName = useEditor((s) => s.fileName);
  const fileId = useEditor((s) => s.fileId);
  const [format, setFormat] = useState('png');
  const [scale, setScale] = useState(2);
  const [duration, setDuration] = useState(3);
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [rows, setRows] = useState<Row[]>(SETS[0]!.rows);
  const { snap, doc } = session();
  useSnapVersion();
  const ids = selection.length ? selection : pageId ? [...snap.children(pageId)] : [];
  const video = format === 'mp4' || format === 'webm';
  const scalable = format === 'png' || format === 'jpg' || format === 'webp' || format === 'avif' || video;
  const box = unionRects(ids.slice(0, 500).flatMap((id) => rectOf(id) ?? []));
  const name = (selection.length === 1 ? snap.nodes.get(selection[0]!)?.name : fileName) || 'bogen';

  const run = async () => {
    if (!fileId || !ids.length) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const { blob, report: answer } = await postExport('/api/export', { fileId, nodeIds: ids, format, ...(scalable ? { scale } : {}), ...(video ? { duration, fps } : {}) });
      downloadBlob(blob, `${name}${scalable && scale !== 1 ? `@${scale}x` : ''}.${format === 'prototype' ? 'html' : format}`);
      setReport(answer);
    } catch (err) {
      // HTML needs no server, so it still works when the renderer is unavailable.
      if (format === 'html') {
        const html = exportDocument(doc, ids, { title: name, indent: true, resolve: resolveAsset });
        downloadBlob(new Blob([html], { type: 'text/html' }), `${name}.html`);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSet = async () => {
    if (!fileId || !ids.length || !rows.length) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const { blob } = await postExport('/api/export/presets', { fileId, nodeIds: ids, presets: rows });
      downloadBlob(blob, `${fileName || 'bogen'}.zip`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const change = (i: number, patch: Partial<Row>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  return (
    <div className="export" data-testid="export-panel">
      <div className="export-target">
        {selection.length ? (selection.length === 1 ? name : t.n(selection.length, '{count} layer', '{count} layers')) : t('The whole page')}
        {box && scalable ? <span className="export-size">{Math.round(box.w * scale)} × {Math.round(box.h * scale)}</span> : null}
      </div>
      <SelectField label={t('Format')} value={format} options={FORMATS.map((f) => ({ ...f, label: t(f.label) }))} onChange={setFormat} testId="export-format" />
      {scalable ? (
        <Segmented<string>
          value={String(scale)}
          onChange={(v) => setScale(Number(v))}
          testId="export-scale"
          options={EXPORT_PRESETS.map((p) => ({ value: String(p.scale), label: p.label, title: t('Scale {scale}', { scale: p.label }) }))}
        />
      ) : null}
      {video ? (
        <div className="export-video">
          <NumberField label={t('Seconds')} value={duration} min={0.1} max={120} step={0.5} onChange={setDuration} testId="export-duration" />
          <NumberField label="FPS" value={fps} min={1} max={60} step={1} onChange={(v) => setFps(Math.round(v))} testId="export-fps" />
        </div>
      ) : null}
      <button type="button" className="btn btn-primary" disabled={busy || !ids.length} onClick={() => void run()} data-testid="export-run">
        <Download size={14} /> {busy ? (video ? t('Rendering frames') : t('Exporting')) : format === 'prototype' ? t('Export prototype') : t('Export {format}', { format: format.toUpperCase() })}
      </button>
      {format === 'prototype' ? <div className="hint">{t('One HTML file: these artboards and every one their links reach, with variables and interactions, and one small script that asks no network.')}</div> : null}
      {video ? <div className="hint">{t('Frame by frame, with CSS animations and shaders at exact times. A GIF or embedded page runs on its own clock.')}</div> : null}
      {error ? <div className="error" data-testid="export-error">{error}</div> : null}
      {report ? <ReportView report={report} /> : null}
      {!ids.length ? <div className="hint">{t('This page is empty, so there is nothing to export.')}</div> : null}

      <div className="export-set" data-testid="export-set">
        <div className="export-set-head">
          <span>{t('Several sizes as a zip')}</span>
          <IconButton icon={<Plus size={13} />} title={t('Add a size')} onClick={() => setRows([...rows, { format: 'png', scale: 1 }])} testId="export-set-add" />
        </div>
        <div className="export-set-names">
          {SETS.map((s) => <button key={s.label} type="button" className="btn btn-quiet" onClick={() => setRows(s.rows)} data-testid={`export-set-${s.label.toLowerCase()}`}>{t(s.label)}</button>)}
        </div>
        {rows.map((row, i) => (
          <div key={i} className="export-set-row" data-testid="export-set-row">
            <SelectField value={row.format} options={PRESET_FORMATS.map((f) => ({ ...f, label: t(f.label) }))} onChange={(v) => change(i, { format: v })} title={t('Format')} />
            {row.width !== undefined
              ? <NumberField label="W" value={row.width} min={1} max={8000} step={10} onChange={(v) => change(i, { width: Math.round(v) })} title={t('Width in pixels')} />
              : <NumberField label="×" value={row.scale ?? 1} min={0.1} max={4} step={0.5} onChange={(v) => change(i, { scale: v })} title={t('Scale')} disabled={row.format === 'svg' || row.format === 'pdf' || row.format === 'html'} />}
            <IconButton icon={<Trash2 size={13} />} title={t('Remove')} onClick={() => setRows(rows.filter((_, n) => n !== i))} />
          </div>
        ))}
        <button type="button" className="btn" disabled={busy || !ids.length || !rows.length} onClick={() => void runSet()} data-testid="export-set-run">
          <Download size={14} /> {busy ? t('Exporting') : t.n(rows.length, 'Export {count} size as zip', 'Export {count} sizes as zip')}
        </button>
      </div>

      {fileId && !phoneOrigin ? (
        <div className="export-set" data-testid="export-publish">
          <div className="export-set-head"><span>{t('As a website')}</span></div>
          <div className="hint">{t('A frozen static copy, on Bogen\'s own site, in a folder or on GitHub Pages. Or a review link for a client.')}</div>
          <div className="export-set-names">
            <button type="button" className="btn" onClick={() => ui().set({ publishDialog: 'publish' })} data-testid="export-open-publish">{t('Publish')}</button>
            <button type="button" className="btn" onClick={() => ui().set({ publishDialog: 'share' })} data-testid="export-open-share">{t('Share for review')}</button>
          </div>
        </div>
      ) : null}

      {fileId && !phoneOrigin ? (
        <div className="export-set" data-testid="export-app">
          <div className="export-set-head"><span>{t('The app on a device')}</span></div>
          <div className="hint">{t('Put the screen a running app shows beside this artboard, then compare the two.')}</div>
          <div className="export-set-names">
            <button type="button" className="btn" onClick={openAppScreenBeside} data-testid="export-app-import">{t('Import an app screen')}</button>
            <button type="button" className="btn" disabled={!selection.length} onClick={openAppCompare} data-testid="export-app-compare">{t('Design versus app')}</button>
          </div>
          <TomaccoReadiness refresh={appScreenCloses} />
        </div>
      ) : null}

      {fileId ? <a className="btn btn-quiet export-bogen" href={`/api/files/${fileId}/download`} download data-testid="export-bogen"><Download size={13} /> {t('Download {extension} file', { extension: '.bogen' })}</a> : null}
    </div>
  );
}
