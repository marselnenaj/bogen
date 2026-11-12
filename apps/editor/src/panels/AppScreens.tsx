import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Copy, X } from 'lucide-react';
import { insertAppScreen, type NewNode } from '@bogen/core';
import { session } from '../doc/session.ts';
import { fitSelection } from '../ops/ops.ts';
import { editor } from '../state/store.ts';
import { copyText, IconButton, Segmented } from '../ui/controls.tsx';
import { tomaccoView, type TomaccoStatus } from './tomacco-state.ts';
import '../styles/app-screen.css';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/**
 * App screens from Tomacco: the import dialog and the design versus app view. The server reads the screen (a
 * device through tomaccoctl, an export folder on this computer, or two files picked here) and works out the
 * layers; the editor inserts them, so that the import is one step of this person's undo.
 *
 * Bogen never builds, installs or starts the app here: it takes the screen of a device that already runs it, and
 * when Tomacco is missing or no device runs, it shows the command from `tomaccoctl doctor` for the person to run.
 */

type View = { kind: 'import'; beside?: string } | { kind: 'compare'; nodeId: string; screen?: Screen } | null;

let view: View = null;
const listeners = new Set<() => void>();
let closes = 0;
const setView = (next: View) => {
  if (view && !next) closes++;
  view = next;
  for (const l of listeners) l();
};
/** How often a dialog here has closed: what Tomacco reported before may no longer hold, so a note elsewhere asks again. */
export const useAppScreenCloses = () => useSyncExternalStore((fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
}, () => closes);
const useView = () => useSyncExternalStore((fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
}, () => view);

const closeView = () => setView(null);

/** The import dialog. With `beside`, a layer id, the screen goes to the right of its artboard and can be compared with it next. */
export function openAppScreenImport(beside?: unknown): void {
  // A toolbar button passes its click event: only a layer id counts.
  setView(typeof beside === 'string' && beside ? { kind: 'import', beside } : { kind: 'import' });
}

/** The import dialog, beside the selected artboard when there is one. */
export function openAppScreenBeside(): void {
  openAppScreenImport(selectedArtboard() ?? undefined);
}

/** The artboard a selected layer is in: the one to put a screen beside or to compare with. */
export function selectedArtboard(): string | null {
  const s = session();
  const id = editor().selection[0];
  if (!id || !s.doc.getNode(id)) return null;
  return [id, ...s.doc.ancestors(id)].at(-1) ?? id;
}

/** Design versus app for the selected layer, or the artboard it is in. */
export function openAppCompare(): void {
  const s = session();
  const id = editor().selection[0];
  if (!id) {
    editor().showToast(t('Select the artboard to compare with the app first.'));
    return;
  }
  const top = [id, ...s.doc.ancestors(id)].at(-1) ?? id;
  const records = s.doc.meta.get('appScreens') as Record<string, unknown> | undefined;
  setView({ kind: 'compare', nodeId: records?.[id] || s.doc.getNode(id)?.artboard ? id : top });
}

interface Summary { platform: string; device: string | null; model: string | null; os: string | null; width: number; height: number; unit: string; elements: number; elementsSource: string | null; app: string | null; capturedAt: string | null; warnings: string[] }
interface Screen { screenId: string; summary: Summary; png: string }
interface Device { id: string; platform: string; name: string; state?: string }
type Box = { x: number; y: number; width: number; height: number };
interface Matched { layer: { id: string; name: string; text?: string; box: Box }; element: { id: string; role: string; label: string; name: string; box: Box }; summary: string; text: { design: string; app: string } | null }
interface Compared {
  percent: number; unit: string; width: number; height: number; warnings: string[];
  matched: Matched[]; onlyInDesign: { id: string; name: string; text?: string; box: Box }[]; onlyInApp: { id: string; role: string; label: string; name: string; box: Box }[];
  images: { diff: string; design: string; app: string };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? t('{path} failed with {status}.', { path, status: res.status }));
  return out;
}

function readFile(file: File, as: 'text' | 'base64'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t('Could not read {file}.', { file: file.name })));
    reader.onload = () => resolve(as === 'text' ? String(reader.result) : String(reader.result).replace(/^data:[^,]*,/, ''));
    if (as === 'text') reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

const describe = (s: Summary) => [s.model ?? s.device, s.os].filter(Boolean).join(', ');

/**
 * Whether Tomacco can give a screen now, and if not the one command that changes that, from `tomaccoctl doctor`.
 * Shown with a copy button; Bogen never runs it. Nothing is shown while a device is running unless `always`.
 */
export function TomaccoReadiness({ refresh = 0, always = false }: { refresh?: number; always?: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<TomaccoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setStatus(null);
    setError(null);
    fetch(`/api/tomacco/status${refresh ? '?fresh=1' : ''}`).then(async (r) => {
      const body = await r.json() as TomaccoStatus & { error?: string };
      if (!r.ok) throw new Error(body.error ?? t('The device list is only on the computer itself.'));
      if (live) setStatus(body);
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [refresh]);
  const view = tomaccoView(status, error);
  const command = (text: string) => (
    <div className="appscreen-command">
      <code data-testid="tomacco-command">{text}</code>
      <IconButton icon={<Copy size={13} />} title={t('Copy command')} onClick={() => void copyText(text).then(() => editor().showToast(t('Command copied')))} />
    </div>
  );
  if (view.kind === 'checking') return always ? <p className="hint" data-testid="tomacco-state">{t('Checking Tomacco')}</p> : null;
  if (view.kind === 'ready') return null;
  if (view.kind === 'unknown') return always ? <p className="hint" data-testid="tomacco-state">{view.message}</p> : null;
  if (view.kind === 'missing') {
    return (
      <div className="appscreen-ready" data-testid="tomacco-state" data-state="missing">
        <p>{t('{command} is not installed on this computer.', { command: 'tomaccoctl' })} {t('To install it, run this in a terminal:')}</p>
        {view.command ? command(view.command) : null}
      </div>
    );
  }
  return (
    <div className="appscreen-ready" data-testid="tomacco-state" data-state="no-device">
      <p>{t('No device is running.')}{view.what ? ` ${t('Next step, from {command}:', { command: 'tomaccoctl doctor' })} ${view.what}` : ''}</p>
      {view.command ? command(view.command) : null}
      {view.detail ? <p className="hint">{view.detail}</p> : null}
      {view.command ? <p className="hint">{t('Bogen shows this command and never runs it.')}</p> : null}
    </div>
  );
}

/** Where the screen comes from: a running device, or an export. Reads it once and hands it on. */
function SourcePicker({ onScreen, busy, setBusy }: { onScreen: (screen: Screen) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const t = useT();
  const [tab, setTab] = useState<'device' | 'export'>('device');
  const [devices, setDevices] = useState<{ available: boolean; devices: Device[]; notes: string[] } | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [looks, setLooks] = useState(0);
  const files = useRef<HTMLInputElement>(null);

  const loadDevices = () => {
    setDevices(null);
    void fetch('/api/tomacco/devices').then(async (r) => {
      const body = await r.json() as { available: boolean; devices: Device[]; notes: string[]; error?: string };
      if (!r.ok) throw new Error(body.error ?? t('The device list is only on the computer itself.'));
      setDevices(body);
      setDevice((d) => d ?? body.devices[0]?.id ?? null);
      if (!body.devices.length) setTab('export');
    }).catch((e: Error) => {
      setDevices({ available: false, devices: [], notes: [e.message] });
      setTab('export');
    });
  };
  useEffect(loadDevices, []);

  const read = async (source: unknown) => {
    setBusy(true);
    setError(null);
    try {
      onScreen(await post<Screen>('/api/tomacco/screen', { source }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (list: FileList | null) => {
    const all = [...(list ?? [])];
    const json = all.find((f) => /\.json$/i.test(f.name));
    const png = all.find((f) => /\.png$/i.test(f.name) && !/marked/i.test(f.name));
    if (!json || !png) {
      setError(t('Choose both files of the export: {json} and {png}.', { json: 'screen.json', png: 'screen.png' }));
      return;
    }
    await read({ json: await readFile(json, 'text'), png: await readFile(png, 'base64') });
  };
  const chosen = devices?.devices.find((d) => d.id === device);

  return (
    <div className="appscreen-source">
      <Segmented value={tab} onChange={setTab} testId="appscreen-tab" options={[{ value: 'device', label: t('From a device'), title: t('The screen of a running device now') }, { value: 'export', label: t('From an export'), title: t('A screen export on this computer') }]} />
      {tab === 'device' ? (
        <>
          <div className="appscreen-devices" role="listbox" aria-label={t('Devices')} data-testid="appscreen-devices">
            {!devices ? <div className="hint appscreen-row">{t('Looking for devices')}</div> : null}
            {devices?.devices.map((d) => (
              <button key={d.id} type="button" role="option" aria-selected={d.id === device} className={`appscreen-row${d.id === device ? ' is-active' : ''}`} onClick={() => setDevice(d.id)} data-testid="appscreen-device">
                <span><b>{d.id}</b> {d.name !== d.id ? d.name : ''}</span><span className="appscreen-state">{d.state ?? d.platform}</span>
              </button>
            ))}
            {devices && !devices.devices.length ? <div className="hint appscreen-row" data-testid="appscreen-no-devices">{devices.available ? t('No device is running.') : devices.notes[0] ?? t('{command} is not installed on this computer.', { command: 'tomaccoctl' })}</div> : null}
          </div>
          <p className="hint">{t('Takes the screen now through {command}. Nothing leaves this computer.', { command: 'tomaccoctl screen.export' })}</p>
          <div className="import-actions">
            <button type="button" className="btn btn-quiet" onClick={() => { setLooks((n) => n + 1); loadDevices(); }} data-testid="appscreen-look-again">{t('Look again')}</button>
            <button type="button" className="btn" disabled={busy || !chosen} onClick={() => void read({ device: chosen!.id, ...(chosen!.platform === 'ios' && chosen!.id !== 'virtual-iphone' ? { platform: 'ios' } : {}) })} data-testid="appscreen-take">{busy ? t('Taking the screen') : t('Take the screen')}</button>
          </div>
        </>
      ) : (
        <form className="import-form" onSubmit={(e) => { e.preventDefault(); if (path.trim()) void read({ path: path.trim() }); }}>
          <label className="import-field">
            <span>{t('Folder of the export, on this computer')}</span>
            <input className="token-input" value={path} placeholder="~/exports/login" onChange={(e) => setPath(e.target.value)} data-testid="appscreen-path" />
          </label>
          <div className="import-actions">
            <button type="button" className="btn btn-quiet" onClick={() => files.current?.click()}>{t('Choose the two files')}</button>
            <button type="submit" className="btn" disabled={busy || !path.trim()} data-testid="appscreen-read">{busy ? t('Reading') : t('Read it')}</button>
          </div>
          <input ref={files} type="file" accept=".json,.png,application/json,image/png" multiple hidden onChange={(e) => void pick(e.target.files)} data-testid="appscreen-files" />
          <p className="hint">{t('Made with {command}: a folder with {json} and {png}.', { command: 'tomaccoctl call screen.export', json: 'screen.json', png: 'screen.png' })}</p>
        </form>
      )}
      {devices && !devices.devices.length ? <TomaccoReadiness refresh={looks} /> : null}
      {error ? <div className="error" data-testid="appscreen-error">{error}</div> : null}
    </div>
  );
}

function useEscape(close: () => void): void {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [close]);
}

function ImportDialog({ beside }: { beside?: string }) {
  const t = useT();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(true);
  const [frame, setFrame] = useState(false);
  const [shot, setShot] = useState(true);
  const [compare, setCompare] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const close = closeView;
  useEscape(close);
  const besideName = beside ? session().doc.getNode(beside)?.name ?? t('Artboard') : null;

  const place = async () => {
    if (!screen) return;
    const s = session();
    const current = editor().pageId ?? s.doc.getPages()[0]?.id;
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await post<{ spec: NewNode; record: Parameters<typeof insertAppScreen>[3]; pageId?: string }>('/api/tomacco/import', { fileId: s.fileId, pageId: current, screenId: screen.screenId, plan: true, text, frame, screenshot: shot, ...(beside && s.doc.getNode(beside) ? { beside } : {}) });
      const pageId = plan.pageId && s.doc.pages.has(plan.pageId) ? plan.pageId : current;
      let id = '';
      s.tx(() => { id = insertAppScreen(s.doc, pageId, plan.spec, plan.record); });
      editor().set({ selection: [id] });
      requestAnimationFrame(() => fitSelection());
      const at = { width: screen.summary.width, height: screen.summary.height, unit: screen.summary.unit };
      const what = describe(screen.summary);
      editor().showToast(what ? t('Imported {device} at {width} x {height} {unit}.', { device: what, ...at }) : t('Imported the screen at {width} x {height} {unit}.', at));
      // The same capture, so the comparison is of the screen just placed, without taking it again.
      if (beside && compare && s.doc.getNode(beside)) setView({ kind: 'compare', nodeId: beside, screen });
      else close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sum = screen?.summary;
  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog appscreen-dialog" role="dialog" aria-modal="true" aria-label={t('Import an app screen')} data-testid="appscreen-dialog">
        <header className="dialog-head">
          <span className="import-title">{t('Import an app screen')}</span>
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} />
        </header>
        <div className="appscreen-body">
          <div className="appscreen-main">
            {screen && sum ? (
              <div className="appscreen-read" data-testid="appscreen-summary">
                <p><b>{describe(sum) || sum.platform}</b>{sum.app ? `, ${sum.app}` : ''}</p>
                <button type="button" className="btn btn-quiet" onClick={() => setScreen(null)}>{t('Another screen')}</button>
              </div>
            ) : <SourcePicker onScreen={setScreen} busy={busy} setBusy={setBusy} />}
            <div className="appscreen-options">
              <label className="import-check"><input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} data-testid="appscreen-text" /><span>{t('Text as editable text')}</span></label>
              <label className="import-check"><input type="checkbox" checked={frame} onChange={(e) => setFrame(e.target.checked)} data-testid="appscreen-frame" /><span>{t('Device frame')}</span></label>
              <label className="import-check"><input type="checkbox" checked={shot} onChange={(e) => setShot(e.target.checked)} data-testid="appscreen-shot" /><span>{t('Keep the screenshot under the layers')}</span></label>
              {besideName ? <label className="import-check"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} data-testid="appscreen-compare-after" /><span>{t('Compare with {name} afterwards', { name: besideName })}</span></label> : null}
            </div>
            {sum?.warnings.length ? sum.warnings.slice(0, 4).map((w) => <p key={w} className="hint">{w}</p>) : null}
            {error ? <div className="error">{error}</div> : null}
          </div>
          <figure className="appscreen-preview">
            {screen ? <img src={`data:image/png;base64,${screen.png}`} alt={t('The app screen')} data-testid="appscreen-preview" /> : <div className="appscreen-blank" />}
            <figcaption>{sum
              ? sum.elementsSource === 'ocr'
                ? t.n(sum.elements, '{width} x {height} {unit}, {count} elements read off the screen', '{width} x {height} {unit}, {count} elements read off the screen', { width: Math.round(sum.width), height: Math.round(sum.height), unit: sum.unit })
                : t.n(sum.elements, '{width} x {height} {unit}, {count} elements', '{width} x {height} {unit}, {count} elements', { width: Math.round(sum.width), height: Math.round(sum.height), unit: sum.unit })
              : t('No screen yet')}</figcaption>
          </figure>
        </div>
        <footer className="appscreen-foot">
          <button type="button" className="btn btn-quiet" onClick={close}>{t('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!screen || busy} onClick={() => void place()} data-testid="appscreen-import">{busy && screen ? t('Importing') : t('Import as artboard')}</button>
        </footer>
      </div>
    </div>
  );
}

type Mode = 'side' | 'overlay' | 'diff';

function Compare({ nodeId, initial }: { nodeId: string; initial?: Screen }) {
  const t = useT();
  const [screen, setScreen] = useState<Screen | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Compared | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('overlay');
  const [opacity, setOpacity] = useState(50);
  const [hover, setHover] = useState<{ design?: Box; app?: Box } | null>(null);
  const close = closeView;
  useEscape(close);
  const name = session().doc.getNode(nodeId)?.name ?? t('Artboard');

  useEffect(() => {
    if (!screen) return;
    setBusy(true);
    setError(null);
    post<Compared>('/api/tomacco/compare', { fileId: session().fileId, nodeId, screenId: screen.screenId })
      .then(setResult, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [screen, nodeId]);

  const png = (b64: string) => `data:image/png;base64,${b64}`;
  const mark = (box: Box | undefined, kind: string) => (box && result ? (
    <span className={`appscreen-mark is-${kind}`} style={{ left: `${(box.x / result.width) * 100}%`, top: `${(box.y / result.height) * 100}%`, width: `${(box.width / result.width) * 100}%`, height: `${(box.height / result.height) * 100}%` }} />
  ) : null);
  const picture = (src: string, label: string, extra?: React.ReactNode) => (
    <figure className="appscreen-figure">
      <div className="appscreen-frame">
        <img src={src} alt={label} />
        {extra}
        {mark(hover?.design, 'design')}
        {mark(hover?.app, 'app')}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
  const matchedCount = result ? result.matched.length : 0;
  const appCount = result ? result.matched.length + result.onlyInApp.length : 0;

  return (
    <div className="history-stage appscreen-stage" data-testid="appscreen-compare">
      <div className="appscreen-canvas">
        {result ? (
          mode === 'side' ? (
            <div className="appscreen-pair">{picture(png(result.images.design), t('Design'))}{picture(png(result.images.app), t('App'))}</div>
          ) : mode === 'overlay' ? (
            picture(png(result.images.design), t('Design under the app'), <img className="appscreen-over" src={png(result.images.app)} alt="" style={{ opacity: opacity / 100 }} />)
          ) : picture(png(result.images.diff), t('Design, differences in red'))
        ) : (
          <div className="appscreen-pick">
            {busy ? <p className="hint">{t('Comparing')}</p> : <SourcePicker onScreen={setScreen} busy={busy} setBusy={setBusy} />}
            {error ? <div className="error" data-testid="appscreen-error">{error}</div> : null}
          </div>
        )}
      </div>
      <aside className="appscreen-aside" aria-label={t('Design versus app')}>
        <header className="appscreen-aside-head">
          <div className="appscreen-aside-title">
            <span className="import-title">{t('Design versus app')}</span>
            <IconButton icon={<X size={14} />} title={t('Back to the canvas ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="appscreen-close" />
          </div>
          <span className="hint">{screen ? t('{name} against {device}', { name, device: describe(screen.summary) || screen.summary.platform }) : name}</span>
        </header>
        {result ? (
          <>
            <div className="appscreen-controls">
              <Segmented value={mode} onChange={setMode} testId="appscreen-mode" options={[{ value: 'side', label: t('Side by side'), title: t('Design and app next to each other') }, { value: 'overlay', label: t('Overlay'), title: t('The app over the design') }, { value: 'diff', label: t('Difference'), title: t('Differing pixels in red') }]} />
              {mode === 'overlay' ? (
                <label className="appscreen-slider"><span>{t('App opacity')}</span><input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} data-testid="appscreen-opacity" /><span>{opacity}%</span></label>
              ) : null}
              <p data-testid="appscreen-percent">{t.rich('{percent} of the pixels differ. {matched} of {count} elements matched.', { percent: <b>{result.percent}%</b>, matched: matchedCount, count: appCount })}</p>
              {result.warnings.slice(0, 3).map((w) => <p key={w} className="hint">{w}</p>)}
              <button type="button" className="btn btn-quiet" onClick={() => { setResult(null); setScreen(null); }}>{t('Another screen')}</button>
            </div>
            <div className="appscreen-list" data-testid="appscreen-matches">
              {result.matched.map((m) => (
                <button key={m.layer.id} type="button" className="appscreen-item" onMouseEnter={() => setHover({ design: m.layer.box, app: m.element.box })} onMouseLeave={() => setHover(null)} onFocus={() => setHover({ design: m.layer.box, app: m.element.box })} onClick={() => editor().set({ selection: [m.layer.id] })} data-testid="appscreen-match">
                  <span className="appscreen-item-name">{m.element.label || m.element.name} <span className="hint">{m.element.role}</span></span>
                  <span className={m.summary === 'same' ? 'hint' : 'appscreen-off'}>{m.text ? t('"{text}" here', { text: m.text.design }) : m.summary}</span>
                </button>
              ))}
              {result.onlyInApp.length ? <div className="appscreen-group">{t('Only in the app')}</div> : null}
              {result.onlyInApp.map((e) => (
                <button key={e.id} type="button" className="appscreen-item" onMouseEnter={() => setHover({ app: e.box })} onMouseLeave={() => setHover(null)} data-testid="appscreen-only-app">
                  <span className="appscreen-item-name">{e.label || e.name} <span className="hint">{e.role}</span></span>
                </button>
              ))}
              {result.onlyInDesign.length ? <div className="appscreen-group">{t('Only in the design')}</div> : null}
              {result.onlyInDesign.map((l) => (
                <button key={l.id} type="button" className="appscreen-item" onMouseEnter={() => setHover({ design: l.box })} onMouseLeave={() => setHover(null)} onClick={() => editor().set({ selection: [l.id] })} data-testid="appscreen-only-design">
                  <span className="appscreen-item-name" dir="auto">{l.text || l.name}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}

/** Mounted once in the editor. */
export function AppScreens() {
  const current = useView();
  if (!current) return null;
  return current.kind === 'import' ? <ImportDialog beside={current.beside} /> : <Compare key={current.nodeId} nodeId={current.nodeId} initial={current.screen} />;
}
