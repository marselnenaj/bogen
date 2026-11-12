import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { camera } from '../state/camera.ts';
import { chromeLayout, useWindowSize, type ChromeLayout } from '../state/chrome-layout.ts';
import { useSettings } from '../state/settings.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

type Side = 'left' | 'right';

const NAMES: Record<Side, string> = { left: msg('Layers, pages and assets'), right: msg('Inspector') };
const TOGGLE_TITLES: Record<Side, { open: string; close: string }> = {
  left: { open: msg('Open layers, pages and assets ({shortcut})'), close: msg('Close layers, pages and assets ({shortcut})') },
  right: { open: msg('Open inspector ({shortcut})'), close: msg('Close inspector ({shortcut})') },
};
const KEYS: Record<Side, string> = { left: 'Ctrl+Alt+1', right: 'Ctrl+Alt+2' };

/** The layout of the editor's chrome for this window, UI scale and the panel widths chosen. */
export function useChrome(): ChromeLayout {
  const { width, height } = useWindowSize();
  const scale = useSettings((s) => s.uiScale);
  const leftWidth = useEditor((s) => s.leftWidth);
  const rightWidth = useEditor((s) => s.rightWidth);
  return useMemo(() => chromeLayout({ width, height, scale, leftWidth, rightWidth }), [width, height, scale, leftWidth, rightWidth]);
}

/** The same, read once, for commands. */
export function currentChrome(): ChromeLayout {
  const st = editor();
  return chromeLayout({ width: window.innerWidth, height: window.innerHeight, scale: useSettings.getState().uiScale, leftWidth: st.leftWidth, rightWidth: st.rightWidth });
}

/**
 * Shows a panel: beside the canvas when it fits, else as a drawer over it. `toggle` closes a drawer that is open,
 * which is what the toolbar buttons and their shortcuts do.
 */
export function showPanel(side: Side, toggle = false): void {
  if (editor().minimal) editor().set({ minimal: false });
  const lay = currentChrome();
  if (lay[side] === 'docked') {
    ui().set({ drawer: null });
    return;
  }
  const open = ui().drawer === side;
  ui().set({ drawer: open && toggle ? null : side });
  if (open && toggle) focusToggle(side);
}

function focusToggle(side: Side): void {
  // At the smallest toolbar the button is an item of More: the focus goes back to More.
  requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-testid="panel-toggle-${side}"]`) ?? document.querySelector<HTMLElement>('[data-testid="toolbar-more"]'))?.focus());
}

/** The same as PanelToggle, as an item of the toolbar's More menu, for when the toolbar has no room for the button. */
export function PanelMenuItem({ side, lay, onDone }: { side: Side; lay: ChromeLayout; onDone: () => void }) {
  const t = useT();
  const open = useUi((s) => s.drawer === side);
  if (lay[side] !== 'drawer') return null;
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  return (
    <button type="button" role="menuitem" className={`menu-item${open ? ' is-current' : ''}`} title={t(open ? TOGGLE_TITLES[side].close : TOGGLE_TITLES[side].open, { shortcut: KEYS[side] })} aria-controls={`panel-drawer-${side}`} onClick={() => { onDone(); showPanel(side, true); }} data-testid={`more-panel-${side}`}>
      <span className="menu-with-icon"><Icon size={13} /> {t(NAMES[side])}</span><span className="menu-keys">{KEYS[side]}</span>
    </button>
  );
}

/** The toolbar button for a panel that is in a drawer at this width. Nothing while it sits beside the canvas. */
export function PanelToggle({ side, lay }: { side: Side; lay: ChromeLayout }) {
  const t = useT();
  const open = useUi((s) => s.drawer === side);
  if (lay[side] !== 'drawer') return null;
  const Icon = side === 'left' ? PanelLeft : PanelRight;
  const title = t(open ? TOGGLE_TITLES[side].close : TOGGLE_TITLES[side].open, { shortcut: KEYS[side] });
  return (
    <button type="button" className={`icon-btn panel-toggle${open ? ' is-active' : ''}`} title={title} aria-label={title} aria-expanded={open} aria-controls={`panel-drawer-${side}`} onClick={() => showPanel(side, true)} data-testid={`panel-toggle-${side}`}>
      <Icon size={15} />
    </button>
  );
}

/**
 * Where a panel lives, whatever the window does: one element for its whole life, so the panel inside is never
 * mounted again and keeps what it holds (an unsent reply, a search, an export form, a field being edited). Docked, it
 * is a column beside the canvas. As an open drawer it lies over the canvas at its edge, takes the focus, and Esc
 * closes it and gives the focus back to its button. Closed, or with the panels hidden, it is not displayed and is
 * inert: out of the tab order and away from screen readers, with its contents kept.
 */
export function PanelHost({ side, lay, minimal, resizer, children }: { side: Side; lay: ChromeLayout; minimal: boolean; resizer: ReactNode; children: ReactNode }) {
  const t = useT();
  const drawerOpen = useUi((s) => s.drawer === side);
  const ref = useRef<HTMLDivElement>(null);
  const docked = !minimal && lay[side] === 'docked';
  const open = !minimal && !docked && drawerOpen;
  const stowed = !docked && !open;
  useEffect(() => {
    if (open) ref.current?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div
      ref={ref}
      id={`panel-drawer-${side}`}
      className={docked ? 'panel-slot' : `panel-slot panel-drawer is-${side}${stowed ? ' is-stowed' : ''}`}
      style={open ? { width: side === 'left' ? lay.leftPx : lay.rightPx } : undefined}
      hidden={stowed}
      inert={stowed}
      role={open ? 'dialog' : undefined}
      aria-modal={open ? false : undefined}
      aria-label={open ? t(NAMES[side]) : undefined}
      tabIndex={open ? -1 : undefined}
      data-testid={open ? `panel-drawer-${side}` : `panel-slot-${side}`}
      data-dock={docked ? 'docked' : open ? 'drawer' : 'stowed'}
      onKeyDown={open ? (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        ui().set({ drawer: null });
        focusToggle(side);
      } : undefined}
    >
      {side === 'right' ? <span className="panel-resizer-host" hidden={!docked}>{resizer}</span> : null}
      {children}
      {side === 'left' ? <span className="panel-resizer-host" hidden={!docked}>{resizer}</span> : null}
    </div>
  );
}

/** Sets a tab of a panel and shows that panel, also when the tab was already the one chosen. */
export function openTab(side: Side, patch: Partial<Pick<ReturnType<typeof editor>, 'leftTab' | 'rightTab' | 'activeThreadId'>>): void {
  editor().set(patch);
  showPanel(side);
}

/** Closes a drawer whose panel fits beside the canvas again, and tells the camera the canvas changed size. */
export function useChromeUpkeep(lay: ChromeLayout, minimal: boolean): void {
  const drawer = useUi((s) => s.drawer);
  useEffect(() => {
    if (drawer && (minimal || lay[drawer] === 'docked')) ui().set({ drawer: null });
  }, [drawer, minimal, lay]);
  // Asking for a tab of a panel that is in a drawer (Show layers, History in the toolbar) opens that drawer, and so
  // does opening a comment thread from its pin, also when Comments was already the tab chosen.
  useEffect(() => useEditor.subscribe((st, prev) => {
    const thread = Boolean(st.activeThreadId) && st.activeThreadId !== prev.activeThreadId;
    const side: Side | null = st.leftTab !== prev.leftTab ? 'left' : st.rightTab !== prev.rightTab || thread ? 'right' : null;
    if (!side || st.minimal || ui().drawer === side || currentChrome()[side] === 'docked') return;
    ui().set({ drawer: side });
  }), []);
  useEffect(() => {
    const f = requestAnimationFrame(() => camera.measureViewport());
    return () => cancelAnimationFrame(f);
  }, [lay.mode, lay.leftPx, lay.rightPx]);
}
