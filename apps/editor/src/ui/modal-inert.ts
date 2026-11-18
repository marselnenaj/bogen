/**
 * While a modal dialog is open, what is behind it cannot be reached: everything outside the dialog that was on the
 * page when it opened is made inert (out of the tab order, away from screen readers and the pointer) and hidden from
 * screen readers, as a native modal <dialog> does. What opens later, such as a menu or a tooltip of the dialog itself, stays as it is. When the
 * last modal closes, every element gets back what it had.
 */
const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

export function inertOutsideModals(root: Document = document): () => void {
  let made: HTMLElement[] = [];
  let open: Element | null = null;
  const release = () => {
    for (const el of made) { el.inert = false; el.removeAttribute('aria-hidden'); }
    made = [];
    open = null;
  };
  const apply = (modal: Element) => {
    release();
    open = modal;
    for (let el: Element | null = modal; el && el !== root.body; el = el.parentElement) {
      for (const sibling of el.parentElement?.children ?? []) {
        if (sibling === el || !(sibling instanceof HTMLElement) || sibling.inert || sibling.hasAttribute('aria-hidden') || sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE') continue;
        if (sibling.matches(MODAL) || sibling.querySelector(MODAL)) continue;
        sibling.inert = true;
        sibling.setAttribute('aria-hidden', 'true');
        made.push(sibling);
      }
    }
  };
  const check = () => {
    const modals = [...root.querySelectorAll(MODAL)];
    const top = modals[modals.length - 1] ?? null;
    if (top === open) return;
    if (top) apply(top);
    else release();
  };
  const observer = new MutationObserver(check);
  observer.observe(root.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'role'] });
  check();
  return () => { observer.disconnect(); release(); };
}
