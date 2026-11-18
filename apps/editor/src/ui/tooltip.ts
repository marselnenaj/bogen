/**
 * Tooltips for everything in the chrome that has a title: quick, in the theme, with the shortcut set
 * apart, and on keyboard focus as well as on hover. One listener for all of them.
 */
import { splitTitle } from './tooltip-text.ts';

let tip: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;
let saved: string | null = null;

const DELAY = 450;
const QUICK = 60;
let lastHidden = 0;

function restore(): void {
  if (current && saved !== null && !current.hasAttribute('title')) current.setAttribute('title', saved);
  current = null;
  saved = null;
}

function hide(): void {
  clearTimeout(timer);
  if (tip?.isConnected) lastHidden = performance.now();
  tip?.remove();
  restore();
}

function show(el: HTMLElement, text: string): void {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.dataset.testid = 'tooltip';
  }
  const { label, keys } = splitTitle(text);
  tip.textContent = '';
  const a = document.createElement('span');
  a.textContent = label;
  tip.appendChild(a);
  if (keys) {
    const k = document.createElement('kbd');
    k.textContent = keys;
    tip.appendChild(k);
  }
  document.body.appendChild(tip);
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const below = r.bottom + 6 + t.height < innerHeight;
  const x = Math.max(4, Math.min(innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2));
  const y = below ? r.bottom + 6 : r.top - t.height - 6;
  // The tip is zoomed with the interface size, and a zoomed fixed box multiplies its own left and top by that
  // zoom: place it in its own units, so it sits at the element at every interface size.
  const zoom = Number.parseFloat(getComputedStyle(tip).zoom) || 1;
  tip.style.left = `${x / zoom}px`;
  tip.style.top = `${y / zoom}px`;
}

/**
 * A name that shows in full needs no tooltip. An element marked `data-title-if-cut` gets its own text as one only
 * while that text is cut off, measured when the pointer or the focus comes to it.
 */
export function cutText(el: HTMLElement): string | null {
  if (!el.hasAttribute('data-title-if-cut')) return null;
  const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  return cut ? (el.getAttribute('data-title-if-cut') || el.textContent || '').trim() || null : null;
}

function arm(el: HTMLElement, delay: number): void {
  if (el === current) return;
  hide();
  const own = el.getAttribute('title');
  const title = own ?? cutText(el);
  if (!title) return;
  current = el;
  saved = own;
  // The browser's own tooltip would come up as well.
  if (own !== null) el.removeAttribute('title');
  timer = window.setTimeout(() => { if (current === el && el.isConnected) show(el, title); }, delay);
}

export function installTooltips(): void {
  const target = (t: EventTarget | null): HTMLElement | null => {
    const el = t instanceof Element ? t.closest<HTMLElement>('[title], [data-title-if-cut]') : null;
    return el && !el.closest('.bogen-world') ? el : null;
  };
  // A control that appears under a resting pointer (a panel that opened where the pointer was) gets a pointerover
  // without the pointer moving; its tooltip would cover what is under it, so only a moving pointer arms one.
  let moved = 0;
  document.addEventListener('pointermove', () => { moved = performance.now(); }, { capture: true, passive: true });
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    if (performance.now() - moved > 250) return;
    const el = target(e.target);
    if (el) arm(el, performance.now() - lastHidden < 500 ? QUICK : DELAY);
    else if (current && !(e.target instanceof Node && current.contains(e.target))) hide();
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = target(e.target);
    if (el && el.matches(':focus-visible')) arm(el, DELAY);
  }, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('blur', hide);
}
