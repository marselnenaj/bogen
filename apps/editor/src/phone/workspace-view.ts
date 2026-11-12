import { useSyncExternalStore } from 'react';

export type PhoneWorkspaceView = 'touch' | 'full';
export const PHONE_WORKSPACE_KEY = 'bogen-phone-workspace-v1';
const listeners = new Set<() => void>();
export function parseWorkspaceView(value: string | null): PhoneWorkspaceView {
  return value === 'full' ? 'full' : 'touch';
}
function read(): PhoneWorkspaceView {
  try { return parseWorkspaceView(localStorage.getItem(PHONE_WORKSPACE_KEY)); } catch { return 'touch'; }
}
let current = read();
function changed(next: PhoneWorkspaceView): void {
  if (next === current) return;
  current = next;
  for (const notify of listeners) notify();
}
function storage(event: StorageEvent): void {
  if (event.key === PHONE_WORKSPACE_KEY || event.key === null) changed(read());
}
function subscribe(notify: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', storage);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
    if (!listeners.size) window.removeEventListener('storage', storage);
  };
}
export function setPhoneWorkspaceView(view: PhoneWorkspaceView): void {
  try { localStorage.setItem(PHONE_WORKSPACE_KEY, view); } catch { /* Keep the choice for this tab. */ }
  changed(view);
}
export function usePhoneWorkspaceView(): PhoneWorkspaceView {
  return useSyncExternalStore(subscribe, () => current, () => 'touch');
}
