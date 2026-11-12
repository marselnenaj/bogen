import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { brandApi, type BrandListItem } from '../lib/brand-api.ts';
import { driftApi, type RestyleResult } from '../lib/drift-api.ts';
import { fitSelection } from '../ops/ops.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, Segmented, SelectField } from '../ui/controls.tsx';
import { formatList } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import '../styles/drift.css';

type Width = '1440' | '768' | '390';

/** "Like this site, in a brand": capture a page and redraw its layout in a brand, as a new artboard. */
export function RestyleDialog() {
  const open = useUi((s) => s.restyleOpen);
  return open ? <Body /> : null;
}

function Body() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId)!;
  const ref = useRef<HTMLDivElement>(null);
  const [brands, setBrands] = useState<BrandListItem[]>([]);
  const [brandId, setBrandId] = useState('');
  const [url, setUrl] = useState('');
  const [width, setWidth] = useState<Width>('1440');
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');
  const [keepText, setKeepText] = useState(false);
  const [keepImages, setKeepImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestyleResult | null>(null);
  const close = () => ui().set({ restyleOpen: false });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    Promise.all([brandApi.list(), brandApi.ofFile(fileId).catch(() => null)]).then(([list, file]) => {
      setBrands(list);
      setBrandId(file?.link?.id ?? list.find((b) => b.isDefault)?.id ?? list[0]?.id ?? '');
    }).catch(() => setBrands([]));
    return () => window.removeEventListener('keydown', key, true);
  }, [fileId]);

  const run = async () => {
    if (!url.trim() || !brandId) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await driftApi.restyle(fileId, { url: url.trim(), brandId, width: Number(width), colorScheme: scheme, keepText, keepImages }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const show = () => {
    if (!result) return;
    close();
    if (result.file_id !== fileId) {
      location.hash = `#/file/${result.file_id}`;
      return;
    }
    editor().set({ pageId: result.page_id, selection: [result.node_id] });
    requestAnimationFrame(() => fitSelection());
  };

  const linked = brands.find((b) => b.id === brandId);
  const families = result ? [...new Set(result.restyle.fonts.map((f) => f.to))] : [];
  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <div ref={ref} className="dialog restyle" role="dialog" aria-modal="true" aria-label={t('Like this site, in a brand')} data-testid="restyle-dialog">
        <header className="dialog-head">
          <span className="settings-title">{result ? t('Restyled in {brand}', { brand: result.brand.name }) : t('Like this site, in a brand')}</span>
          <span style={{ flex: 1 }} />
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="restyle-close" />
        </header>
        {result ? (
          <div className="restyle-body" data-testid="restyle-result">
            <div className="bf-score"><strong>{result.check.score}</strong><span className="hint">{t('brand check, {hard} hard, {soft} soft', { hard: result.check.hard, soft: result.check.soft })}</span></div>
            <div className="restyle-lines">
              <span>{t('{colours} colours onto {brandColours} brand colours', { colours: new Set(result.restyle.colors.map((c) => c.from)).size, brandColours: new Set(result.restyle.colors.map((c) => c.name)).size })}</span>
              <span>{families.length ? t.n(result.restyle.fonts.length, '{count} font onto {families}', '{count} fonts onto {families}', { families: formatList(families) }) : t.n(result.restyle.fonts.length, '{count} font onto nothing: the brand has no families', '{count} fonts onto nothing: the brand has no families')}</span>
              <span>{t("{spacing} spacing values and {sizes} font sizes onto the brand's scales", { spacing: result.restyle.spacing, sizes: result.restyle.font_sizes })}</span>
              <span>{result.kept.text && result.kept.images ? t("The site's text and images kept") : result.kept.text ? t('Text kept, {images} images as placeholders', { images: result.restyle.images_replaced }) : result.kept.images ? t('{texts} texts and images kept', { texts: result.restyle.texts_replaced }) : t('{texts} texts and {images} images as placeholders', { texts: result.restyle.texts_replaced, images: result.restyle.images_replaced })}</span>
            </div>
            {result.created_file ? <div className="hint">{t('This file follows another brand, so the artboard is in a new file.')}</div> : null}
            {result.restyle.notes.map((n) => <div key={n} className="hint">{n}</div>)}
            <div className="hint" data-testid="restyle-notice">{result.notice}</div>
            <div className="restyle-actions">
              {result.created_file ? null : <button type="button" className="btn" onClick={() => { close(); editor().set({ leftTab: 'brand' }); }}>{t('Brand tab')}</button>}
              <button type="button" className="btn btn-primary" onClick={show} data-testid="restyle-show">{t('Show artboard')}</button>
            </div>
          </div>
        ) : (
          <form className="restyle-body" onSubmit={(e) => { e.preventDefault(); void run(); }}>
            <div className="hint">{t("Captures a page and redraws its layout in the brand's colours, fonts and spacing, on a new artboard.")}</div>
            <label className="restyle-field">
              <span>{t('Page')}</span>
              <input className="drift-url" value={url} placeholder="https://" spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="restyle-url" />
            </label>
            <div className="restyle-pair">
              <div className="restyle-field">
                <span>{t('Brand')}</span>
                {brands.length ? <SelectField<string> value={brandId} options={brands.map((b) => ({ value: b.id, label: b.name }))} onChange={setBrandId} testId="restyle-brand" title={t('The brand to redraw it in')} /> : <span className="hint">{t('No brands yet. Make one on the home screen.')}</span>}
              </div>
              <div className="restyle-field">
                <span>{t('Width')}</span>
                <Segmented<Width> value={width} onChange={setWidth} testId="restyle-width" options={[{ value: '1440', label: '1440', title: t('Desktop') }, { value: '768', label: '768', title: t('Tablet') }, { value: '390', label: '390', title: t('Phone') }]} />
              </div>
            </div>
            <div className="restyle-field">
              <span>{t('Colour scheme the page sees')}</span>
              <Segmented<'light' | 'dark'> value={scheme} onChange={setScheme} testId="restyle-scheme" options={[{ value: 'light', label: t('Light'), title: 'prefers-color-scheme: light' }, { value: 'dark', label: t('Dark'), title: 'prefers-color-scheme: dark' }]} />
            </div>
            <label className="check"><input type="checkbox" checked={keepText} onChange={(e) => setKeepText(e.target.checked)} data-testid="restyle-keep-text" /><span>{t("Keep the site's text")}</span></label>
            <label className="check"><input type="checkbox" checked={keepImages} onChange={(e) => setKeepImages(e.target.checked)} data-testid="restyle-keep-images" /><span>{t("Keep the site's images")}</span></label>
            <div className="hint restyle-notice">{t('For structure and inspiration. Text and images become placeholders unless you keep them, and you need the right to use anything you keep.')}</div>
            {busy ? <div className="hint">{linked ? t('Capturing the page and redrawing it in {brand}.', { brand: linked.name }) : t('Capturing the page and redrawing it in the brand.')}</div> : null}
            {error ? <div className="error" data-testid="restyle-error">{error}</div> : null}
            <div className="restyle-actions">
              <button type="button" className="btn" onClick={close}>{t('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !url.trim() || !brandId} data-testid="restyle-run">{busy ? t('Restyling') : t('Restyle')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
