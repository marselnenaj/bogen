import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { AppWindow } from 'lucide-react';
import { useT } from '../i18n/react.ts';
import { onServerEvent } from '../lib/events.ts';
import { isPhone } from '../lib/phone.ts';
import { WindowCoordinator, FOCUS_MS, type Holding, type WindowMsg } from './one-window.ts';
import { fileOfHash, useTabs } from './tabs-state.ts';

/**
 * The browser half of one window per file (one-window.ts): the BroadcastChannel, this window's focus and address, the
 * notice, and `open-request` from the server, which lets `bogen open` and the launchers use a window that is there.
 */

const CHANNEL = 'bogen-windows';
let coordinator: WindowCoordinator | null = null;
let lastFocus = 0;

/** The Mac app raises its own window on request; a browser may or may not let a page do it. */
function focusWindow(): void {
  try { (window as unknown as { bogenDesktop?: { focusWindow?: () => void } }).bogenDesktop?.focusWindow?.(); } catch { /* not the Mac app */ }
  try { window.focus(); } catch { /* not allowed */ }
}

function start(): WindowCoordinator | null {
  if (coordinator) return coordinator;
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(CHANNEL);
  coordinator = new WindowCoordinator({
    post: (m) => channel.postMessage(m),
    listen: (fn) => {
      const on = (e: MessageEvent) => { if (e.data && typeof e.data === 'object' && typeof (e.data as WindowMsg).k === 'string') fn(e.data as WindowMsg); };
      channel.addEventListener('message', on);
      return () => channel.removeEventListener('message', on);
    },
  }, {
    now: () => Date.now(),
    later: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id); },
    focus: focusWindow,
    hasFocus: () => document.hasFocus(),
    hash: () => location.hash,
    setHash: (h) => { location.hash = h; },
    goHome: () => { location.hash = '#/'; },
    closable: () => history.length <= 1,
    close: () => window.close(),
  });
  if (document.hasFocus()) lastFocus = Date.now();
  window.addEventListener('focus', () => { lastFocus = Date.now(); });
  window.addEventListener('pagehide', () => coordinator?.dispose());
  onServerEvent((e) => { if (e.t === 'open-request') void onOpenRequest(e.id, e.hash, e.raise === true); });
  // A narrow door for tests: this window's id and what it holds.
  (window as unknown as { __bogenWindows?: unknown }).__bogenWindows = { me: coordinator.me, holding: () => coordinator?.current };
  return coordinator;
}

/** Starts listening to the other windows of this browser, once per page. */
export function startOneWindow(): void {
  start();
}

/** `bogen open` asks: this window offers to take it, and takes it if the server picks it. */
async function onOpenRequest(id: string, hash: string, raise: boolean): Promise<void> {
  const c = coordinator;
  if (!c || isPhone() || /^#\/(file\/[\w-]+\/preview|live)/.test(location.hash)) return;
  const fileId = fileOfHash(hash);
  // The window with the file always offers; another one only when the caller can bring it forward (Hyprland, a Mac).
  const priority = fileId && c.holds(fileId) ? 2 : fileId && c.heldElsewhere(fileId) ? 0 : raise && document.visibilityState === 'visible' ? 1 : 0;
  if (!priority) return;
  const post = (path: string, body: unknown) => fetch(`/api/open/${encodeURIComponent(id)}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const answer = await (await post('claim', { priority, lastFocus: document.hasFocus() ? Date.now() : lastFocus })).json() as { ok?: boolean };
    if (!answer.ok) return;
    if (hash && hash !== location.hash) location.hash = hash;
    focusWindow();
    await new Promise((r) => setTimeout(r, FOCUS_MS));
    await post('done', { focused: document.hasFocus(), visible: document.visibilityState === 'visible', title: document.title.slice(0, 300) });
  } catch { /* the server went away: the caller opens a window */ }
}

const none: Holding = { state: 'none' };
function useHolding(): Holding {
  return useSyncExternalStore((fn) => coordinator?.subscribe(fn) ?? (() => {}), () => coordinator?.current ?? none);
}

/**
 * Around the editor of a file: shows it when this window has the file, the notice when another window of this
 * browser shows it, and nothing for the moment it takes to ask.
 */
export function FileWindow({ fileId, children }: { fileId: string; children: ReactNode }) {
  const c = start();
  const holding = useHolding();
  useEffect(() => {
    c?.want(fileId, location.hash);
    return () => c?.want(null);
  }, [c, fileId]);
  if (!c) return <>{children}</>;
  if (holding.state === 'mine' && holding.fileId === fileId) return <>{children}</>;
  if (holding.state === 'elsewhere' && holding.fileId === fileId) return <OpenElsewhere fileId={fileId} onUse={() => c.take()} onClose={() => c.dismiss()} />;
  return <div className="loading" aria-busy="true" data-testid="one-window-wait" />;
}

function OpenElsewhere({ fileId, onUse, onClose }: { fileId: string; onUse: () => void; onClose: () => void }) {
  const t = useT();
  const name = useTabs((s) => s.tabs.find((x) => x.id === fileId)?.name ?? '');
  useEffect(() => { document.title = name ? `${name} - Bogen` : 'Bogen'; }, [name]);
  return (
    <div className="one-window" data-testid="open-elsewhere">
      <section className="one-window-card" role="status" aria-labelledby="one-window-title">
        <AppWindow className="one-window-icon" size={28} strokeWidth={1.75} aria-hidden="true" />
        {name ? <p className="one-window-name" dir="auto" translate="no">{name}</p> : null}
        <h1 id="one-window-title" className="one-window-title">{t('This file is open in another window')}</h1>
        <p className="one-window-text">{t('A file opens in one window at a time. Use this window instead, and the other one goes to Home.')}</p>
        <div className="one-window-actions">
          <button type="button" className="btn btn-primary" onClick={onUse} data-testid="open-elsewhere-use">{t('Use this window')}</button>
          <button type="button" className="btn btn-quiet" onClick={onClose} data-testid="open-elsewhere-close">{t('Close')}</button>
        </div>
      </section>
    </div>
  );
}
