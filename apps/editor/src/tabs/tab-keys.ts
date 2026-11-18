import { closeTab, cycleTab, nudgeActive, tabAt, useTabs } from './tabs-state.ts';

/**
 * The tab keys, everywhere in the window (Home and every file), before the editor's own keys:
 * Ctrl+Tab and Ctrl+Shift+Tab or Ctrl+Page Down and Page Up for the next and previous tab, and Ctrl+Shift+Page Up and
 * Page Down to move it, with Ctrl on every system; Ctrl+1 to 8 (Cmd on a Mac) for a tab by place (1 is Home), Ctrl+9 for
 * the last, Ctrl+W to close the open tab.
 * A browser keeps some of these for its own tabs (Ctrl+W, Ctrl+Tab in a normal window); in Bogen's app window they
 * come here. The Mac app maps them in its menu.
 */
export function tabAction(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): (() => void) | null {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return null;
  const key = e.key;
  // Switching and moving tabs is Ctrl on every system: Cmd+Tab is the Mac's app switcher and never reaches a page.
  if (key === 'Tab' || key === 'PageDown' || key === 'PageUp') {
    if (!e.ctrlKey) return null;
    if (key === 'Tab') return () => cycleTab(e.shiftKey ? -1 : 1);
    if (key === 'PageDown') return e.shiftKey ? () => nudgeActive(1) : () => cycleTab(1);
    return e.shiftKey ? () => nudgeActive(-1) : () => cycleTab(-1);
  }
  if (e.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(key) ? key : null);
  if (digit) return () => tabAt(Number(digit));
  if (key.toLowerCase() === 'w' || e.code === 'KeyW') {
    const active = useTabs.getState().active;
    return active ? () => closeTab(active) : null;
  }
  return null;
}

export function installTabKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const run = tabAction(e);
    if (!run) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat || e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') run();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
