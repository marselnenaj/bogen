import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sheetRelease } from './file-state.ts';
import { useT } from '../i18n/react.ts';

/**
 * A sheet over the canvas, which stays in view above it: a handle to drag it down and away, a head with a
 * title and something on the right, a body that scrolls, and a foot that stays at the bottom, above the
 * keyboard when there is one. At 700 px and wider, on the phone app, it is a panel at the side instead, with a
 * close button for the handle (see phone-file.css).
 */
export function Sheet({ title, aside, head, dark, full, foot, onClose, testId, children }: {
  title?: ReactNode;
  /** In place of the title row, such as tabs. It does not drag. */
  head?: ReactNode;
  aside?: ReactNode;
  dark?: boolean;
  /** Over the whole canvas, for the pages. */
  full?: boolean;
  foot?: ReactNode;
  onClose: () => void;
  testId?: string;
  children?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; y0: number; t: number; dy: number; v: number } | null>(null);
  const [dy, setDy] = useState(0);
  const grab = useRef<HTMLDivElement>(null);
  // Dragging the handle is not a scroll: without this, a fast pull ends in a fling, and the browser
  // spends the next tap anywhere on stopping it. React's own touch listeners are passive.
  useEffect(() => {
    const el = grab.current;
    if (!el) return;
    const stop = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, []);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    // Buttons in the head are buttons.
    if ((e.target as HTMLElement).closest('.pf-sheet-aside, .pf-sheet-close')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y0: e.clientY, t: performance.now(), dy: 0, v: 0 };
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const now = performance.now();
    const next = e.clientY - d.y0;
    d.v = (next - d.dy) / Math.max(1, now - d.t);
    d.t = now;
    d.dy = next;
    setDy(Math.max(0, next));
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // Let go of the finger before the sheet goes, or the next tap elsewhere may lose its click.
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const tappedHandle = Math.abs(d.dy) < 6 && (e.target as HTMLElement).closest('.pf-handle');
    if (tappedHandle || (e.type !== 'pointercancel' && sheetRelease(d.dy, d.v, ref.current?.offsetHeight ?? 400) === 'close')) requestAnimationFrame(onClose);
    else setDy(0);
  };

  return (
    <section
      ref={ref}
      className={`pf-sheet${dark ? ' is-dark' : ''}${full ? ' is-full' : ''}${dy ? ' is-dragging' : ''}`}
      style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      data-testid={testId}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div ref={grab} className="pf-grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-testid="pf-sheet-grab">
        <div className="pf-handle" role="button" tabIndex={0} aria-label={t('Close')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }}><span /></div>
        {title !== undefined ? (
          <div className="pf-sheet-head">
            <h2 className="pf-sheet-title">{title}</h2>
            {aside ? <div className="pf-sheet-aside">{aside}</div> : null}
            <button type="button" className="pf-sheet-close" onClick={onClose} aria-label={t('Close')} data-testid="pf-sheet-close">×</button>
          </div>
        ) : <button type="button" className="pf-sheet-close is-alone" onClick={onClose} aria-label={t('Close')} data-testid="pf-sheet-close">×</button>}
      </div>
      {head ? <div className="pf-sheet-tabs">{head}</div> : null}
      <div className="pf-sheet-body">{children}</div>
      {foot ? <div className="pf-sheet-foot">{foot}</div> : null}
    </section>
  );
}
