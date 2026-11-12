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
  tip.style.left = `${Math.max(4, Math.min(innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2))}px`;
  tip.style.top = `${below ? r.bottom + 6 : r.top - t.height - 6}px`;
}

function arm(el: HTMLElement, delay: number): void {
  if (el === current) return;
  hide();
  const title = el.getAttribute('title');
  if (!title) return;
  current = el;
  saved = title;
  // The browser's own tooltip would come up as well.
  el.removeAttribute('title');
  timer = window.setTimeout(() => { if (current === el && el.isConnected) show(el, title); }, delay);
}

export function installTooltips(): void {
  const target = (t: EventTarget | null): HTMLElement | null => {
    const el = t instanceof Element ? t.closest<HTMLElement>('[title]') : null;
    return el && !el.closest('.bogen-world') ? el : null;
  };
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
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
