import { useEffect, useMemo, useState } from 'react';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { driftApi, type Drift, type DriftKind } from '../lib/drift-api.ts';
import { camera } from '../state/camera.ts';
import { rectOf } from '../canvas/measure.ts';
import { editor, useEditor } from '../state/store.ts';
import { Empty, Segmented } from '../ui/controls.tsx';
import { useDriftState } from './drift-state.ts';
import '../styles/drift.css';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';
import type { Translate } from '../i18n/core.ts';

type Filter = 'all' | 'layout' | 'style' | 'text' | 'elements';
const GROUPS: Record<Exclude<Filter, 'all'>, DriftKind[]> = { layout: ['spacing', 'size'], style: ['color', 'font'], text: ['text'], elements: ['missing', 'extra'] };

/** The artboard the panel is about: the one the selection is in, or the only one on the page. */
function useArtboard(): string | null {
  const selection = useEditor((s) => s.selection);
  const pageId = useEditor((s) => s.pageId);
  const version = useSnapVersion();
  return useMemo(() => {
    const { doc } = session();
    const first = selection[0];
    if (first && doc.getNode(first)) {
      const page = doc.pageOf(first);
      return [first, ...doc.ancestors(first)].find((id) => doc.getNode(id)?.parent === page) ?? null;
    }
    const top = pageId ? doc.getChildren(pageId).filter((n) => n.artboard) : [];
    return top.length === 1 ? top[0]!.id : null;
  }, [selection, pageId, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

const label = (t: Translate, d: Drift) => (d.kind === 'missing' ? t('missing') : d.kind === 'extra' ? t('extra') : d.kind === 'text' ? t('text') : (d.property ?? d.kind).replace(/-/g, ' '));

const FILTER_LABELS: Record<Filter, string> = { all: msg('All {count}'), layout: msg('Layout {count}'), style: msg('Style {count}'), text: msg('Text {count}'), elements: msg('Elements {count}') };
const FILTER_TITLES: Record<Filter, string> = { all: msg('Every drift'), layout: msg('Spacing and sizes'), style: msg('Colours and fonts'), text: msg('Changed words'), elements: msg('Missing and extra elements') };

function Swatch({ value }: { value: string }) {
  return value === 'transparent' ? null : <span className="drift-swatch" style={{ background: value }} />;
}

function Values({ d }: { d: Drift }) {
  const t = useT();
  if (d.kind === 'missing') return <span className="hint">{t('In the design, not found on the live page')}</span>;
  if (d.kind === 'extra') return <span className="hint">{d.live_element?.text ? t('On the live page, not in the design: {selector}, "{text}"', { selector: d.live_element.selector ?? '', text: d.live_element.text.slice(0, 60) }) : t('On the live page, not in the design: {selector}', { selector: d.live_element?.selector ?? '' })}</span>;
  if (d.kind === 'text') {
    return (
      <>
        <span className="drift-text"><span className="hint">{`${t('Design')} `}</span>{d.design}</span>
        <span className="drift-text"><span className="hint">{`${t('Live')} `}</span>{d.live}</span>
      </>
    );
  }
  const color = d.kind === 'color';
  return (
    <span className="drift-values">
      <span><span className="hint">{`${t('Design')} `}</span>{color ? <Swatch value={d.design ?? ''} /> : null}{d.design}</span>
      <span><span className="hint">{`${t('Live')} `}</span>{color ? <Swatch value={d.live ?? ''} /> : null}{d.live}</span>
    </span>
  );
}

function Row({ d, index, active }: { d: Drift; index: number; active: boolean }) {
  const go = () => {
    useDriftState.getState().set({ focus: d.kind === 'extra' ? index : null });
    const { doc } = session();
    if (d.layer_id && doc.getNode(d.layer_id)) {
      const pageId = doc.pageOf(d.layer_id);
      editor().set({ ...(pageId ? { pageId } : {}), selection: [d.layer_id] });
      return;
    }
    // Only the live page has it: show where, on the artboard.
    const report = useDriftState.getState().report;
    const board = report ? rectOf(report.node_id) : null;
    const box = d.live_element?.box;
    if (board && box) camera.fit({ x: board.x + box.x, y: board.y + box.y, w: box.width, h: box.height });
  };
  const t = useT();
  const offBrand = d.brand && !d.brand.live;
  return (
    <button type="button" className={`drift-item${active ? ' is-active' : ''}`} onClick={go} data-testid="drift-item" data-kind={d.kind} data-layer={d.layer_id}>
      <span className="drift-item-head"><strong>{d.layer ?? d.live_element?.tag ?? t('Element')}</strong><span className="hint">{label(t, d)}</span></span>
      <Values d={d} />
      {d.live_element && d.kind !== 'extra' ? <span className="hint drift-selector">{d.live_element.selector}</span> : null}
      {offBrand ? <span className="drift-off">{d.kind === 'font' ? t('The live font is not in the brand') : t('The live colour is not in the brand')}</span> : null}
    </button>
  );
}

/** Drift: the selected artboard against the live page it stands for. */
export function DriftPanel() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId)!;
  const selection = useEditor((s) => s.selection);
  const artboard = useArtboard();
  const report = useDriftState((s) => (s.fileId === fileId ? s.report : null));
  const overlay = useDriftState((s) => s.overlay);
  const focus = useDriftState((s) => s.focus);
  const [url, setUrl] = useState('');
  const [defaults, setDefaults] = useState<{ url: string | null; width: number | null; color_scheme: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    setDefaults(null);
    setError(null);
    if (!artboard) return;
    let live = true;
    driftApi.defaults(fileId, artboard).then((d) => {
      if (!live) return;
      setDefaults(d);
      setUrl(d.url ?? '');
    }).catch(() => {});
    return () => { live = false; };
  }, [fileId, artboard]);

  const name = artboard ? session().doc.getNode(artboard)?.name ?? '' : '';
  const mine = report && report.node_id === artboard ? report : null;

  const run = async () => {
    if (!artboard || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await driftApi.check(fileId, { nodeId: artboard, url: url.trim() });
      useDriftState.getState().set({ report: out, fileId, focus: null });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!artboard) return <Empty title={t('Select an artboard')} hint={t('Drift compares an artboard with the live page it stands for: pixels, spacing, colours, fonts and words.')} />;

  const counts = mine?.counts;
  const count = (f: Filter) => (!counts ? 0 : f === 'all' ? mine!.drifts.length : GROUPS[f].reduce((n, k) => n + counts[k], 0));
  const shown = mine ? mine.drifts.map((d, i) => [d, i] as const).filter(([d]) => filter === 'all' || GROUPS[filter].includes(d.kind)) : [];
  const selected = new Set(selection);

  return (
    <div className="drift" data-testid="drift-panel">
      <div className="drift-head">
        <span className="bf-title">{name}</span>
        <span className="hint" data-testid="drift-meta">{mine ? t('Compared with the live page at {width} wide, {scheme}', { width: mine.width, scheme: mine.color_scheme }) : defaults?.url ? (defaults.width !== null ? t('Captured from this page at {width} wide, {scheme}', { width: defaults.width, scheme: defaults.color_scheme }) : t('Captured from this page at its wide, {scheme}', { scheme: defaults.color_scheme })) : t('Not captured from a page: type its address.')}</span>
      </div>
      <form className="bf-row" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input className="drift-url" value={url} placeholder="https://" spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label={t('Live page')} data-testid="drift-url" />
        <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()} data-testid="drift-run">{busy ? t('Comparing') : t('Compare')}</button>
      </form>
      {busy ? <div className="hint">{t('Opening the page at the artboard\'s width, then comparing.')}</div> : null}
      {error ? <div className="error" data-testid="drift-error">{error}</div> : null}
      {mine ? (
        <>
          <div className="bf-score" data-testid="drift-score"><strong>{mine.pixels.different_percent}%</strong><span className="hint">{mine.more ? t.n(mine.drifts.length, 'of the pixels differ, {count}+{more} drift', 'of the pixels differ, {count}+{more} drifts', { more: mine.more }) : t.n(mine.drifts.length, 'of the pixels differ, {count} drift', 'of the pixels differ, {count} drifts')}</span></div>
          <label className="check" title={t('Differing pixels in red over the artboard, and dashed boxes where the live page has more')}>
            <input type="checkbox" checked={overlay} onChange={(e) => useDriftState.getState().set({ overlay: e.target.checked })} data-testid="drift-overlay-toggle" />
            <span>{t('Show differences on the canvas')}</span>
          </label>
          {mine.drifts.length ? (
            <Segmented<Filter> value={filter} onChange={setFilter} testId="drift-filter" options={(['all', 'layout', 'style', 'text', 'elements'] as const).map((f) => ({ value: f, label: t(FILTER_LABELS[f], { count: count(f) }), title: t(FILTER_TITLES[f]) }))} />
          ) : <div className="hint">{t('The design and the live page agree.')}</div>}
          <div className="bf-list">{shown.map(([d, i]) => <Row key={i} d={d} index={i} active={(d.layer_id !== undefined && selected.has(d.layer_id)) || focus === i} />)}</div>
          {mine.notes.map((n) => <div key={n} className="hint">{n}</div>)}
          <div className="hint">{t('To fix the repo, ask your agent to run {check} on this artboard, then {get} on the layer of each drift.', { check: 'drift_check', get: 'code_get' })}</div>
        </>
      ) : null}
    </div>
  );
}
