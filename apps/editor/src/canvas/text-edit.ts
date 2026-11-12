import { diffText, mapOffset, rangeHasStyle, remapSpans, renderSpec, runsToHtml, textRuns, type TextSpan, type Y } from '@bogen/core';
import { session } from '../doc/session.ts';
import { resolveAsset } from '../lib/api.ts';
import { create } from 'zustand';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { elOf } from './measure.ts';

interface EditState {
  id: string; el: HTMLElement; original: string; created: boolean; onInput: (e: Event) => void; onKey: (e: KeyboardEvent) => void; onBlur: (e: FocusEvent) => void; onSelection: () => void; onPress: (e: PointerEvent) => void; onCompose: (e: CompositionEvent) => void; timer: number;
  /** What the element shows, and its ranges as predicted here until the document says. */
  text: string; spans: TextSpan[];
  /** What the document showed when the element last agreed with it. What was typed since is the change from this. */
  base: string;
  range: { start: number; end: number } | null; keepFocus: boolean;
  composing: boolean; writing: boolean; unobserve: () => void;
}

/** The range selected in the layer being typed in, for the bar that styles it. */
export const useTextRange = create<{ rect: { x: number; y: number; w: number; h: number } | null; set: (rect: { x: number; y: number; w: number; h: number } | null) => void }>((set) => ({ rect: null, set: (rect) => set({ rect }) }));

/** Offset of a DOM position in the layer's text, with a line break as one character. */
function offsetOf(el: HTMLElement, node: Node, nodeOffset: number): number {
  let total = 0;
  let done = false;
  const walk = (n: Node) => {
    if (done) return;
    if (n === node && n.nodeType !== Node.TEXT_NODE) {
      for (let i = 0; i < nodeOffset; i++) walk2(n.childNodes[i]!);
      done = true;
      return;
    }
    if (n === node) {
      total += nodeOffset;
      done = true;
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) total += n.nodeValue?.length ?? 0;
    else if (n.nodeName === 'BR') total += 1;
    else for (const c of n.childNodes) walk(c);
  };
  const walk2 = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) total += n.nodeValue?.length ?? 0;
    else if (n.nodeName === 'BR') total += 1;
    else for (const c of n.childNodes) walk2(c);
  };
  for (const c of el.childNodes) {
    walk(c);
    if (done) break;
  }
  if (node === el && !done) {
    total = 0;
    for (let i = 0; i < nodeOffset; i++) walk2(el.childNodes[i]!);
  }
  return total;
}

function positionAt(el: HTMLElement, offset: number): { node: Node; offset: number } {
  let left = offset;
  let found: { node: Node; offset: number } | null = null;
  const walk = (n: Node) => {
    if (found) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.nodeValue?.length ?? 0;
      if (left <= len) found = { node: n, offset: left };
      else left -= len;
    } else if (n.nodeName === 'BR') {
      if (left === 0) found = { node: n.parentNode!, offset: [...n.parentNode!.childNodes].indexOf(n as ChildNode) };
      else left -= 1;
    } else for (const c of n.childNodes) walk(c);
  };
  for (const c of el.childNodes) walk(c);
  return found ?? { node: el, offset: el.childNodes.length };
}

function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  return { start: offsetOf(el, r.startContainer, r.startOffset), end: offsetOf(el, r.endContainer, r.endOffset) };
}

function selectOffsets(el: HTMLElement, range: { start: number; end: number }): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = positionAt(el, range.start);
  const b = positionAt(el, range.end);
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}

let state: EditState | null = null;

/** What the layer shows in the document, which keeps changing under a frozen view while others type. */
function shownInDoc(id: string): { text: string; spans: TextSpan[] } {
  const n = session().doc.getNode(id);
  return { text: n?.text ?? '', spans: n?.spans ?? [] };
}

function paint(el: HTMLElement, text: string, spans: TextSpan[]): void {
  if (spans.length) el.innerHTML = runsToHtml(textRuns(text, spans));
  else el.textContent = text;
}

/**
 * Writes what was typed since the last write as the change it is, on top of whatever others typed meanwhile, then
 * shows the merged text with the caret where it was. Not during an IME composition, which owns the element then.
 */
function flush(st: EditState, force = false): void {
  if (st.composing && !force) return;
  clearTimeout(st.timer);
  const s = session();
  const typed = readText(st.el);
  if (typed !== st.base && s.doc.nodes.has(st.id)) {
    st.writing = true;
    try {
      s.tx(() => s.doc.editText(st.id, st.base, typed));
    } finally {
      st.writing = false;
    }
  }
  const now = shownInDoc(st.id);
  st.base = now.text;
  if (now.text !== typed || JSON.stringify(now.spans) !== JSON.stringify(st.spans)) {
    const at = document.activeElement === st.el ? selectionOffsets(st.el) : null;
    const change = diffText(typed, now.text);
    paint(st.el, now.text, now.spans);
    if (at) selectOffsets(st.el, { start: mapOffset(change, at.start), end: mapOffset(change, at.end) });
    if (st.range) st.range = { start: mapOffset(change, st.range.start), end: mapOffset(change, st.range.end) };
  }
  st.text = now.text;
  st.spans = now.spans;
}

function readText(el: HTMLElement): string {
  const raw = el.innerText;
  // Browsers keep a trailing line break node in editable hosts; it is not content.
  return raw.endsWith('\n') && !el.textContent?.endsWith('\n') ? raw.slice(0, -1) : raw;
}

export function isEditingText(): boolean {
  return state !== null;
}

export function editingEl(): HTMLElement | null {
  return state?.el ?? null;
}

/** Puts the real element in edit mode. The snapshot keeps its view frozen so React leaves it alone. */
export function startTextEdit(id: string, options: { selectAll?: boolean; created?: boolean; caretAt?: { x: number; y: number } } = {}): void {
  stopTextEdit();
  const s = session();
  const n = s.snap.nodes.get(id);
  const el = elOf(id);
  if (!n || !el || n.type !== 'text' || s.snap.isLocked(id)) return;
  s.snap.freeze(id);
  el.contentEditable = 'plaintext-only';
  el.spellcheck = false;
  el.classList.add('bogen-text-editing');
  el.focus({ preventScroll: true });

  const sel = window.getSelection();
  if (sel) {
    let range: Range | null = null;
    if (options.caretAt) {
      // The capture layer and overlay sit above the text; they step aside for the lookup.
      const viewport = camera.viewport;
      viewport?.classList.add('is-caret-lookup');
      const hit = document.caretRangeFromPoint?.(options.caretAt.x, options.caretAt.y) ?? null;
      viewport?.classList.remove('is-caret-lookup');
      if (hit && el.contains(hit.startContainer)) range = hit;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      if (!options.selectAll) range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const onInput = (e: Event) => {
    // Others see typing live, a few times a second. This also moves the local overlay.
    if (!state) return;
    const st = state;
    const text = readText(el);
    if (st.spans.length) {
      st.spans = remapSpans(st.spans, st.text, text);
      // Typing next to a range leaves the browser's guess at which element it belongs in. Put it right.
      if (!(e as InputEvent).isComposing) {
        const html = runsToHtml(textRuns(text, st.spans));
        if (el.innerHTML !== html) {
          const at = selectionOffsets(el);
          el.innerHTML = html;
          if (at) selectOffsets(el, at);
        }
      }
    }
    st.text = text;
    clearTimeout(st.timer);
    st.timer = window.setTimeout(() => { if (state === st) flush(st); }, 180);
  };
  const onCompose = (e: CompositionEvent) => {
    if (!state) return;
    state.composing = e.type === 'compositionstart';
    if (!state.composing) {
      const st = state;
      clearTimeout(st.timer);
      st.timer = window.setTimeout(() => { if (state === st) flush(st); }, 0);
    }
  };
  // Others typing in this layer show up here as they arrive, merged with what is being typed.
  const map = s.doc.nodes.get(id);
  const onChange = () => {
    const st = state;
    if (!st || st.id !== id || st.writing) return;
    queueMicrotask(() => { if (state === st) flush(st); });
  };
  map?.observeDeep(onChange as (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stopTextEdit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      stopTextEdit();
    } else if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'b' || key === 'i' || key === 'u') {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'b') toggleRangeStyle('fontWeight', '700', '400');
        else if (key === 'i') toggleRangeStyle('fontStyle', 'italic', 'normal');
        else toggleRangeStyle('textDecorationLine', 'underline', 'none');
      }
    }
  };
  const onBlur = (e: FocusEvent) => {
    // A click on another panel commits, but a window losing focus should not, nor does the range bar.
    if (state?.keepFocus || (e.relatedTarget as Element | null)?.closest?.('[data-text-bar], .popover')) return;
    if (document.hasFocus() && !el.contains(e.relatedTarget as Node | null)) stopTextEdit();
  };
  const onSelection = () => {
    const st = state;
    if (!st) return;
    const at = selectionOffsets(el);
    if (at && at.end > at.start) {
      st.range = at;
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      useTextRange.getState().set({ x: r.left, y: r.top, w: r.width, h: r.height });
    } else if (at && document.activeElement === el) {
      st.range = null;
      useTextRange.getState().set(null);
    }
  };
  const onPress = (e: PointerEvent) => {
    if (state) state.keepFocus = Boolean((e.target as Element).closest?.('[data-text-bar], .popover'));
  };
  document.addEventListener('selectionchange', onSelection);
  window.addEventListener('pointerdown', onPress, true);
  el.addEventListener('input', onInput);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
  el.addEventListener('compositionstart', onCompose);
  el.addEventListener('compositionend', onCompose);
  // A layer created for typing already opened the gesture, so that creation and text undo together.
  if (!options.created) s.beginGesture();
  state = {
    id, el, original: n.text ?? '', created: Boolean(options.created), onInput, onKey, onBlur, onSelection, onPress, onCompose, timer: 0, text: n.text ?? '', spans: n.spans ?? [], base: n.text ?? '', range: null, keepFocus: false,
    composing: false, writing: false, unobserve: () => map?.unobserveDeep(onChange as (events: Y.YEvent<Y.AbstractType<unknown>>[]) => void),
  };
  editor().set({ editingTextId: id, selection: [id], hoverId: null });
}

/** Commits what was typed. An empty new layer goes away again. */
export function stopTextEdit(): void {
  const st = state;
  if (!st) return;
  state = null;
  const s = session();
  clearTimeout(st.timer);
  const { el, id } = st;
  const text = readText(el);
  el.removeEventListener('input', st.onInput);
  el.removeEventListener('keydown', st.onKey);
  el.removeEventListener('blur', st.onBlur);
  el.removeEventListener('compositionstart', st.onCompose);
  el.removeEventListener('compositionend', st.onCompose);
  st.unobserve();
  document.removeEventListener('selectionchange', st.onSelection);
  window.removeEventListener('pointerdown', st.onPress, true);
  useTextRange.getState().set(null);
  el.removeAttribute('contenteditable');
  el.classList.remove('bogen-text-editing');
  window.getSelection()?.removeAllRanges();

  const empty = !text.trim();
  if (empty && (st.created || !st.original)) {
    s.snap.thaw(id);
    s.tx(() => s.doc.delete([id]));
    s.endGesture();
    editor().set({ editingTextId: null, selection: [] });
    return;
  }
  // React's view of this element is stale after typing. Make the DOM agree before the thaw.
  const frozen = s.snap.node(id);
  const spec = frozen ? renderSpec(frozen, resolveAsset) : null;
  if (spec?.html !== undefined) el.innerHTML = spec.html;
  else el.textContent = spec?.text ?? '';
  if (text !== st.base && s.doc.nodes.has(id)) s.tx(() => s.doc.editText(id, st.base, text));
  s.snap.thaw(id);
  s.endGesture();
  editor().set({ editingTextId: null });
}

/** The range being worked on: what is selected now, or what was when focus moved to the range bar. */
function currentRange(st: EditState): { start: number; end: number } | null {
  const now = selectionOffsets(st.el);
  if (now && now.end > now.start) return now;
  return st.range;
}

/** Styles the selected range of the layer being typed in. A null value clears that property. */
export function styleRange(patch: Record<string, string | null>, href?: string | null): boolean {
  const st = state;
  if (!st) return false;
  const range = currentRange(st);
  if (!range || range.end <= range.start) return false;
  const s = session();
  // What was typed goes in first, so that the range means the same characters in the document.
  const typed = readText(st.el);
  flush(st, true);
  const change = diffText(typed, st.text);
  const at = { start: mapOffset(change, range.start), end: mapOffset(change, range.end) };
  st.writing = true;
  try {
    s.tx(() => s.doc.formatText(st.id, at.start, at.end, patch, href));
  } finally {
    st.writing = false;
  }
  const now = shownInDoc(st.id);
  st.text = st.base = now.text;
  st.spans = now.spans;
  paint(st.el, now.text, now.spans);
  st.range = at;
  if (document.activeElement === st.el) selectOffsets(st.el, at);
  return true;
}

/** Puts focus and the selection back in the text after working in the range bar. */
export function refocusRange(): void {
  const st = state;
  if (!st) return;
  st.keepFocus = false;
  st.el.focus({ preventScroll: true });
  if (st.range) selectOffsets(st.el, st.range);
}

export function rangeValue(key: string): { all: (value: string) => boolean; link: string | null } {
  const st = state;
  const range = st ? currentRange(st) : null;
  const all = (value: string) => Boolean(st && range && rangeHasStyle(st.spans, st.text.length, range.start, range.end, key, value));
  const span = st && range ? st.spans.find((x) => x.start <= range.start && x.end > range.start) : undefined;
  return { all, link: span?.href ?? null };
}

/** Bold and friends on a range. With no range they fall to the whole layer. */
export function toggleRangeStyle(key: string, on: string, off: string): void {
  const st = state;
  if (!st) return;
  const range = currentRange(st);
  const s = session();
  if (!range || range.end <= range.start) {
    const current = s.snap.nodes.get(st.id)?.style[key];
    s.tx(() => s.doc.updateStyle(st.id, { [key]: current === on ? null : on }));
    return;
  }
  const has = rangeHasStyle(st.spans, st.text.length, range.start, range.end, key, on);
  // Off means the value that undoes it here: nothing, unless the layer itself is styled that way.
  const layer = s.snap.nodes.get(st.id)?.style[key];
  styleRange({ [key]: has ? (layer === on ? off : null) : on });
}
