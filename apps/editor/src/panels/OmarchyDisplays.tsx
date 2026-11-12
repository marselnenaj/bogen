import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Monitor, Plus } from 'lucide-react';
import { agentApi, type DisplayChoices, type DisplayRequest, type DisplayRuntime, type ThemeInfo, type ThemeWallpaper } from '../lib/agent-api.ts';
import { api } from '../lib/api.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { PortraitRequest } from './PortraitRequest.tsx';

const STATUS_TEXT: Record<ThemeWallpaper['status'], string> = {
  artwork: msg('Own artwork'),
  composed: msg('Composed for this shape'),
  'needs-design': msg('Needs its own design'),
  mismatch: msg('Picture of another shape, cropped'),
  unverified: msg('Picture of unknown size'),
  missing: msg('No composition'),
};
const DONE = new Set<ThemeWallpaper['status']>(['artwork', 'composed']);
/** Real faults, shown as errors; a stand-in that still needs design is a to-do, not an error. */
const FAULT = new Set<ThemeWallpaper['status']>(['mismatch', 'unverified', 'missing']);

/** One short line per state for people. Agents and the export get the full reason. */
function helpFor(w: ThemeWallpaper): string {
  switch (w.status) {
    case 'composed': return t('Designed for this shape, exported as a render of the composition.');
    case 'artwork': return t('Uses its own picture, exported as it is.');
    case 'needs-design': return t("Not designed yet: Bogen's placeholder is never exported or shown. Compose it from the theme on its board, or use artwork made at {aspect}.", { aspect: w.aspect });
    case 'mismatch': return t('A picture of another shape fills it and is cut off, so the export leaves it out. Use artwork made at {aspect}.', { aspect: w.aspect });
    case 'unverified': return t("Bogen cannot read this picture's size to check its shape. Use a PNG, JPEG, WebP or GIF made at {aspect}.", { aspect: w.aspect });
    case 'missing': return t("Its composition is gone. Bring it back with Undo or the file's History.");
  }
}

/** The wallpaper problems of a theme, which this section shows, so the dialog's problem list can leave them out. */
export const isWallpaperProblem = (p: string): boolean => /^The \w+ [\d.]+:[\d.]+ background needs its own design/.test(p);

type Choices = DisplayChoices | null;

/** The first option still free: a portrait monitor of this computer, then a preset, else a custom size. */
function firstFree(c: DisplayChoices): string {
  const monitor = c.monitors.find((m) => m.usable && !m.present && m.height > m.width);
  if (monitor) return `monitor:${monitor.name}`;
  const preset = c.presets.find((p) => !p.present);
  return preset ? `preset:${preset.id}` : 'custom';
}

/** Whether a picked option can still be added. */
function stillFree(c: DisplayChoices, pick: string): boolean {
  if (pick === 'custom') return true;
  if (pick.startsWith('preset:')) return c.presets.some((p) => p.id === pick.slice(7) && !p.present);
  if (pick.startsWith('monitor:')) return c.monitors.some((m) => m.name === pick.slice(8) && m.usable && !m.present);
  return false;
}

/**
 * The desktop displays a theme is designed for, in the theme dialog: the 1920 x 1080 previews, a portrait monitor and
 * others, each shape's own wallpaper composition and whether it is designed, and a way to add more or to give a
 * composition artwork of its shape. Previews only: nothing here changes the monitors or what Omarchy shows.
 */
export function OmarchyDisplays({ fileId, info, onChanged }: { fileId: string; info: ThemeInfo; onChanged: () => void }) {
  const t = useT();
  const [choices, setChoices] = useState<Choices>(null);
  const [pick, setPick] = useState('');
  const [custom, setCustom] = useState({ width: '1080', height: '1920' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [artFor, setArtFor] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<DisplayRuntime | null>(null);
  const displayKey = info.displays.map((d) => `${d.width}x${d.height}`).join(',');

  useEffect(() => {
    let live = true;
    void agentApi.themeDisplays(fileId).then((r) => {
      if (!live) return;
      const next = { presets: r.presets, monitors: r.monitors };
      setChoices(next);
      setRuntime(r.runtime ?? null);
      // After an add the picked size has previews: move on to the next one that can still be added.
      setPick((p) => (p && stillFree(next, p) ? p : firstFree(next)));
    }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [fileId, displayKey, info.wallpapers.map((w) => w.status).join(',')]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const request = (): DisplayRequest | null => {
    if (pick.startsWith('preset:')) return { preset: pick.slice(7) };
    if (pick.startsWith('monitor:')) return { monitor: pick.slice(8) };
    const width = Number(custom.width);
    const height = Number(custom.height);
    return Number.isInteger(width) && Number.isInteger(height) ? { width, height } : null;
  };

  const add = () => run(async () => {
    const r = request();
    if (!r) throw new Error(t('Give the width and height in whole pixels.'));
    const out = await agentApi.addThemeDisplays(fileId, [r]);
    if (!out.added.length) return out.skipped.map((s) => s.reason).join(' ') || t('Nothing to add.');
    const size = out.added.map((a) => `${a.width} × ${a.height}`).join(', ');
    return [t('Added previews at {size}, below the design.', { size }), ...(out.wallpapers.length ? [t('Its portrait composition is a quiet placeholder until you design it.')] : []), t("Undo it from the file's History.")].join(' ');
  });

  const useArtwork = (aspect: string, picked: File) => run(async () => {
    const uploaded = await api.upload(picked);
    const out = await agentApi.assignDisplayArtwork(fileId, { aspect, src: uploaded.src, name: picked.name });
    const o = out.wallpaper.orientation;
    const vars = { file: picked.name, aspect };
    // A whole sentence per orientation: the word from the server is English and must not sit inside a translation.
    if (o === 'portrait') return t('{file} is now the portrait {aspect} artwork. The composition it covers is hidden, not deleted.', vars);
    if (o === 'landscape') return t('{file} is now the landscape {aspect} artwork. The composition it covers is hidden, not deleted.', vars);
    if (o === 'square') return t('{file} is now the square {aspect} artwork. The composition it covers is hidden, not deleted.', vars);
    return t('{file} is now the {aspect} artwork. The composition it covers is hidden, not deleted.', vars);
  });

  return (
    <section className="omarchy-section" data-testid="omarchy-theme-displays">
      <div className="settings-name"><Monitor size={13} /> {t('Displays')}</div>
      <div className="settings-hint">{t('Previews for more screens, such as a monitor turned on its side. They do not change your monitors or what Omarchy shows.')}</div>
      <div className="omarchy-folder">
        <label className="field field-select">
          <select className="field-input" value={pick} disabled={!choices} onChange={(e) => setPick(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="omarchy-display-pick" aria-label={t('Display to add')}>
            {choices?.monitors.length ? (
              <optgroup label={t("This computer's monitors")}>
                {choices.monitors.map((m) => <option key={m.name} value={`monitor:${m.name}`} disabled={!m.usable || m.present}>{m.present ? t('{display} (has previews)', { display: m.label }) : !m.usable ? t('{display} (not supported)', { display: m.label }) : m.label}</option>)}
              </optgroup>
            ) : null}
            <optgroup label={t('Presets')}>
              {choices?.presets.map((p) => <option key={p.id} value={`preset:${p.id}`} disabled={p.present}>{p.present ? t('{display} (has previews)', { display: p.label }) : p.label}</option>)}
            </optgroup>
            <option value="custom">{t('Custom size…')}</option>
          </select>
        </label>
        {pick === 'custom' ? (
          <span className="omarchy-custom-size">
            <input className="field-input" inputMode="numeric" value={custom.width} onChange={(e) => setCustom({ ...custom, width: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label={t('Width in logical pixels')} title={t('The mode, turned as mounted, divided by the scale')} data-testid="omarchy-display-width" />
            ×
            <input className="field-input" inputMode="numeric" value={custom.height} onChange={(e) => setCustom({ ...custom, height: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label={t('Height in logical pixels')} title={t('The mode, turned as mounted, divided by the scale')} data-testid="omarchy-display-height" />
          </span>
        ) : null}
        <button type="button" className="btn" disabled={busy || !choices} onClick={() => void add()} data-testid="omarchy-display-add"><Plus size={14} /> {busy ? t('Adding') : t('Add previews')}</button>
      </div>
      {note ? <div className="omarchy-note" role="status" data-testid="omarchy-displays-note">{note}</div> : null}
      {error ? <div className="error" role="alert" data-testid="omarchy-displays-error">{error}</div> : null}

      <dl className="omarchy-files" data-testid="omarchy-displays-list">
        {info.displays.map((d) => (
          <div key={`${d.width}x${d.height}`} className="omarchy-display-row" data-testid="omarchy-display" data-size={`${d.width}x${d.height}`}>
            <dt>{d.label}</dt>
            <dd>{d.wallpaper === 'Wallpaper' ? t('landscape background') : t('{name} background', { name: d.wallpaper.replace(/^Wallpaper · /, '') })}</dd>
          </div>
        ))}
      </dl>

      <PortraitRequest fileId={fileId} info={info} choices={choices} onChanged={onChanged} />
      {info.wallpapers.length ? (
        <ul className="omarchy-list" data-testid="omarchy-wallpapers">
          {info.wallpapers.map((w) => (
            <li key={w.component} className="omarchy-wallpaper" data-testid="omarchy-wallpaper" data-aspect={w.aspect} data-status={w.status}>
              <span className="omarchy-wallpaper-head">
                <b>{w.orientation[0]!.toUpperCase()}{w.orientation.slice(1)} {w.aspect}</b>
                <span className={`omarchy-status ${DONE.has(w.status) ? 'is-done' : 'is-open'}`}>{t(STATUS_TEXT[w.status])}</span>
                {w.board ? (
                  <button type="button" className="btn btn-quiet" disabled={busy} data-testid="omarchy-wallpaper-artwork" title={t('A PNG, JPEG, WebP or GIF made at {aspect}', { aspect: w.aspect })} onClick={() => { setArtFor(w.aspect); file.current?.click(); }}>
                    <ImagePlus size={14} /> {t('Use artwork…')}
                  </button>
                ) : null}
              </span>
              <div className={FAULT.has(w.status) ? 'error' : 'settings-hint'}>{helpFor(w)}</div>
            </li>
          ))}
        </ul>
      ) : null}
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-testid="omarchy-wallpaper-file" onChange={(e) => {
        const picked = e.target.files?.[0];
        e.target.value = '';
        if (picked && artFor) void useArtwork(artFor, picked);
      }} />
      {info.notes.length ? (
        <div className="settings-hint" data-testid="omarchy-displays-runtime" data-plugin={runtime?.plugin.state ?? info.portrait?.state ?? 'unknown'}>
          <div>{runtime?.plugin.summary ?? info.portrait?.summary ?? t('Stock Omarchy shows the same wallpaper on every screen.')}</div>
          {runtime?.screens.length ? (
            <ul className="omarchy-list" data-testid="omarchy-display-runtime-screens">
              {runtime.screens.map((s) => <li key={s.name} data-screen={s.name}>{s.reason ? t('{screen} ({size}): shows {shows}. {reason}', { screen: s.name, size: `${s.width} × ${s.height}`, shows: s.shows, reason: s.reason }) : t('{screen} ({size}): shows {shows}', { screen: s.name, size: `${s.width} × ${s.height}`, shows: s.shows })}</li>)}
            </ul>
          ) : null}
          {(runtime?.plugin.next ?? info.portrait?.next ?? []).filter((n) => !n.startsWith('#')).slice(0, 2).map((n) => <div key={n}><code>{n.replace(/\s+#.*$/, '')}</code></div>)}
        </div>
      ) : null}
    </section>
  );
}
