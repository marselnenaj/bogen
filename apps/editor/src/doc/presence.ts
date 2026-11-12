import { unionRects, type Vec } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { prepareLayerMeasurements } from '../canvas/artboard-loading.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { maybeSession, type AgentFocus, type AwarenessState, type Peer, type Session } from './session.ts';
import { t } from '../i18n/store.ts';

let lastCursor = 0;
let pendingCursor: Vec | null | undefined;
let cursorTimer = 0;
let lastViewport = 0;

function local(s: Session): AwarenessState | null {
  return s.provider.awareness.getLocalState() as AwarenessState | null;
}

function patch(s: Session, values: Partial<AwarenessState>): void {
  const cur = local(s);
  if (cur) s.provider.awareness.setLocalState({ ...cur, ...values });
}

/** Publishes the cursor at most 30 times a second. */
export function sendCursor(world: Vec | null): void {
  const now = performance.now();
  pendingCursor = world;
  const wait = 33 - (now - lastCursor);
  if (wait <= 0) flushCursor();
  else if (!cursorTimer) cursorTimer = window.setTimeout(flushCursor, wait);
}

function flushCursor(): void {
  clearTimeout(cursorTimer);
  cursorTimer = 0;
  lastCursor = performance.now();
  const s = maybeSession();
  if (!s || pendingCursor === undefined) return;
  const pageId = editor().pageId;
  patch(s, { cursor: pendingCursor && pageId ? { x: Math.round(pendingCursor.x * 10) / 10, y: Math.round(pendingCursor.y * 10) / 10, pageId } : null });
  pendingCursor = undefined;
}

export function setCursorChat(text: string | undefined): void {
  const s = maybeSession();
  if (!s) return;
  const cur = local(s);
  if (!cur) return;
  const { chat: _old, ...rest } = cur;
  s.provider.awareness.setLocalState(text ? { ...rest, chat: text } : rest);
}

export function setLocalName(name: string, color: string): void {
  const s = maybeSession();
  if (s) patch(s, { user: { name, color } });
}

export function peersFrom(s: Session): Peer[] {
  const out: Peer[] = [];
  s.provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === s.provider.awareness.clientID) return;
    const st = state as Partial<AwarenessState>;
    if (!st.user) return;
    out.push({ clientId, user: st.user, cursor: st.cursor ?? null, selection: st.selection ?? [], pageId: st.pageId ?? null, ...(st.chat ? { chat: st.chat } : {}), ...(st.viewport ? { viewport: st.viewport } : {}), ...(st.focus ? { focus: st.focus } : {}) });
  });
  return out;
}

/** Wires a session's awareness to the store. Returns the teardown. */
export function startPresence(s: Session): () => void {
  const aw = s.provider.awareness;
  aw.setLocalState({ user: { name: s.user.name, color: s.user.color }, cursor: null, selection: [], pageId: editor().pageId } satisfies AwarenessState);

  const onChange = () => {
    const peers = peersFrom(s);
    editor().set({ peers });
    applyFollow(peers);
    noticeAgentFocus(peers);
  };
  aw.on('change', onChange);
  const offFocus = startAgentFocus();

  const unsub = useEditor.subscribe((st, prev) => {
    if (st.selection !== prev.selection || st.pageId !== prev.pageId) patch(s, { selection: st.selection.slice(0, 200), pageId: st.pageId });
  });

  let viewportTimer = 0;
  const publishViewport = () => {
    viewportTimer = 0;
    lastViewport = performance.now();
    const c = camera.value;
    patch(s, { viewport: { x: c.x, y: c.y, z: c.z, w: camera.width, h: camera.height } });
  };
  const offCamera = camera.subscribe(() => {
    // At most ten times a second, and always the final position.
    if (viewportTimer) return;
    viewportTimer = window.setTimeout(publishViewport, Math.max(0, 100 - (performance.now() - lastViewport)));
  });

  return () => {
    clearTimeout(viewportTimer);
    aw.off('change', onChange);
    unsub();
    offCamera();
    offFocus();
  };
}

// Agents showing the person something. The person stays in control: nothing moves under their hands.

/** An older focus is history, such as what a new tab finds in awareness. */
const FOCUS_FRESH_MS = 15_000;
/** How long a focus waits for a busy person before it is dropped with a note. */
const FOCUS_PATIENCE_MS = 20_000;
const FOCUS_RETRY_MS = 300;
const WHEEL_QUIET_MS = 800;

let pressed = false;
let lastWheel = 0;
let lastKey = 0;
/** A field someone typed into this recently counts as typing; a field that only has focus does not. */
const TYPING_QUIET_MS = 4000;
const shownFocus = new Set<string>();
let waitingFocus: { agent: string; focus: AgentFocus; since: number } | null = null;
let focusTimer = 0;

function personIsBusy(): boolean {
  const st = editor();
  if (pressed || performance.now() - lastWheel < WHEEL_QUIET_MS) return true;
  if (st.gesture.active || st.gesture.marquee || st.gesture.drawing || st.gesture.drop) return true;
  if (st.editingTextId || st.editingPathId || st.pendingComment || st.followClientId !== null) return true;
  const active = document.activeElement;
  const inField = active instanceof HTMLElement && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
  if (!inField) return false;
  // A half-written draft is someone at work, even after a pause.
  const draft = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === 'text') ? active.value.trim().length > 0 : false;
  return draft || performance.now() - lastKey < TYPING_QUIET_MS;
}

function focusLabel(agent: string, focus: AgentFocus): string {
  return focus.note ? t('{agent}: {note}', { agent, note: focus.note }) : t('{agent} is showing you something', { agent });
}

function missedFocusLabel(agent: string, focus: AgentFocus): string {
  return focus.note
    ? t('{agent}: {note}. You were busy, so it did not interrupt.', { agent, note: focus.note })
    : t('{agent} is showing you something. You were busy, so it did not interrupt.', { agent });
}

function showFocus(agent: string, focus: AgentFocus): void {
  const s = maybeSession();
  if (!s) return;
  const state = editor();
  const ids = focus.nodeIds.filter((id) => s.snap.nodes.has(id));
  if (focus.pageId && focus.pageId !== state.pageId && s.snap.pages.some((p) => p.id === focus.pageId)) state.set({ pageId: focus.pageId, selection: [] });
  if (focus.select && ids.length) state.set({ selection: ids });
  if (focus.view || focus.note) state.showToast(focusLabel(agent, focus));
  if (!focus.view || !ids.length) return;
  prepareLayerMeasurements(ids);
  // Layers on a page that just opened are measured after it paints.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = unionRects(ids.flatMap((id) => rectOf(id) ?? []));
    if (box) camera.fit(box, 1);
  }));
}

function tryWaitingFocus(): void {
  const waiting = waitingFocus;
  if (!waiting) return;
  if (!personIsBusy()) {
    waitingFocus = null;
    showFocus(waiting.agent, waiting.focus);
  } else if (Date.now() - waiting.since > FOCUS_PATIENCE_MS) {
    waitingFocus = null;
    editor().showToast(missedFocusLabel(waiting.agent, waiting.focus));
  }
  if (!waitingFocus) {
    clearInterval(focusTimer);
    focusTimer = 0;
  }
}

function noticeAgentFocus(peers: Peer[]): void {
  for (const peer of peers) {
    const focus = peer.focus;
    if (!peer.user.agent || !focus || shownFocus.has(focus.id)) continue;
    shownFocus.add(focus.id);
    if (Date.now() - focus.at > FOCUS_FRESH_MS) continue;
    if (!editor().followAgents) {
      if (focus.note) editor().showToast(focusLabel(peer.user.name, focus));
      continue;
    }
    // Only the latest one matters: an agent that has moved on is not still pointing at the old thing.
    waitingFocus = { agent: peer.user.name, focus, since: Date.now() };
    if (!focusTimer) focusTimer = window.setInterval(tryWaitingFocus, FOCUS_RETRY_MS);
    tryWaitingFocus();
  }
}

function startAgentFocus(): () => void {
  const down = () => { pressed = true; };
  const up = () => { pressed = false; };
  const wheel = () => { lastWheel = performance.now(); };
  const key = () => { lastKey = performance.now(); };
  window.addEventListener('keydown', key, true);
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
  window.addEventListener('wheel', wheel, { capture: true, passive: true });
  return () => {
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('blur', up);
    window.removeEventListener('wheel', wheel, true);
    window.removeEventListener('keydown', key, true);
    clearInterval(focusTimer);
    focusTimer = 0;
    waitingFocus = null;
    shownFocus.clear();
    pressed = false;
  };
}

function applyFollow(peers: Peer[]): void {
  const state = editor();
  if (state.followClientId === null) return;
  const peer = peers.find((p) => p.clientId === state.followClientId);
  if (!peer) {
    state.set({ followClientId: null });
    state.showToast(t('They left, so following stopped.'));
    return;
  }
  if (peer.pageId && peer.pageId !== state.pageId) state.set({ pageId: peer.pageId, selection: [] });
  if (peer.viewport) {
    const v = peer.viewport;
    // Keep what they see centred in this window.
    const worldCx = (v.w / 2 - v.x) / v.z;
    const worldCy = (v.h / 2 - v.y) / v.z;
    camera.set({ z: v.z, x: camera.width / 2 - worldCx * v.z, y: camera.height / 2 - worldCy * v.z });
  } else if (peer.cursor) {
    const c = camera.value;
    camera.set({ ...c, x: camera.width / 2 - peer.cursor.x * c.z, y: camera.height / 2 - peer.cursor.y * c.z });
  }
}

export function stopFollowing(): void {
  if (editor().followClientId !== null) editor().set({ followClientId: null });
}
