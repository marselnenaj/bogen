/**
 * The editor's canvas is inside its one main landmark, so a design drawn there must not add more. NodeView does this
 * for the live canvas while rendering; this does the same for markup set as HTML (an older version on the canvas):
 * each main element becomes a div that says what it was, a role of main goes, and each top-level board becomes a
 * section named after the board. The look stays the same, and exports keep the design's own markup.
 */
export function demoteDesignLandmarks(root: HTMLElement, boardName: (el: HTMLElement) => string | undefined, boardWord: string): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[role="main"]'))) {
    el.removeAttribute('role');
    el.setAttribute('data-bogen-tag', 'main');
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('main'))) replaceTag(el, el.parentElement === root ? 'section' : 'div', 'main');
  for (const el of Array.from(root.children)) {
    if (!(el instanceof HTMLElement) || el.hasAttribute('role')) continue;
    const board = el.tagName === 'DIV' ? replaceTag(el, 'section', 'div') : el;
    if (board.tagName !== 'SECTION') continue;
    const name = boardName(board);
    if (name && !board.hasAttribute('aria-label') && !board.hasAttribute('aria-labelledby')) board.setAttribute('aria-label', name);
    board.setAttribute('aria-roledescription', boardWord);
  }
}

function replaceTag(el: HTMLElement, tag: string, was: string): HTMLElement {
  const next = el.ownerDocument.createElement(tag);
  for (const a of Array.from(el.attributes)) next.setAttribute(a.name, a.value);
  if (!next.hasAttribute('data-bogen-tag')) next.setAttribute('data-bogen-tag', was);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}
