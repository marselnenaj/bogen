import { useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';

/** The grip's words for each kind of list its callers make, as whole sentences; other labels use the general ones. */
const GRIP_WORDS: Record<string, { drag: string; reorder: string }> = {
  fill: { drag: msg('Drag to reorder fill. Arrow keys work too.'), reorder: msg('Reorder fill {position} of {total}. Use the up and down arrow keys.') },
  filter: { drag: msg('Drag to reorder filter. Arrow keys work too.'), reorder: msg('Reorder filter {position} of {total}. Use the up and down arrow keys.') },
  shadow: { drag: msg('Drag to reorder shadow. Arrow keys work too.'), reorder: msg('Reorder shadow {position} of {total}. Use the up and down arrow keys.') },
};

/**
 * A list whose rows are reordered by dragging a grip. The grip also takes Arrow keys, so that the
 * order can be changed from the keyboard.
 */
export function SortableList<T>({ items, keyOf, render, onReorder, label, testId }: { items: T[]; keyOf: (item: T, index: number) => string | number; render: (item: T, index: number) => ReactNode; onReorder: (next: T[]) => void; label: string; testId?: string }) {
  const t = useT();
  const words = Object.prototype.hasOwnProperty.call(GRIP_WORDS, label) ? GRIP_WORDS[label]! : null;
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; offset: number; to: number } | null>(null);
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onReorder(next);
  };
  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const list = listRef.current!;
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > .sortable-row')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, mid: r.top + r.height / 2, bottom: r.bottom };
    });
    const startY = e.clientY;
    let to = from;
    const onMove = (ev: PointerEvent) => {
      const y = ev.clientY;
      const dragged = rows[from]!;
      const centre = dragged.mid + (y - startY);
      to = rows.reduce((best, r, i) => (Math.abs(r.mid - centre) < Math.abs(rows[best]!.mid - centre) ? i : best), from);
      setDrag({ from, offset: y - startY, to });
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      setDrag(null);
      move(from, to);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  };
  return (
    <div ref={listRef} className={`sortable${drag ? ' is-sorting' : ''}`} data-testid={testId}>
      {items.map((item, i) => {
        const dragging = drag?.from === i;
        const before = drag && drag.to === i && drag.from > i;
        const after = drag && drag.to === i && drag.from < i;
        return (
          <div key={keyOf(item, i)} className={`sortable-row${dragging ? ' is-dragging' : ''}${before ? ' drop-before' : ''}${after ? ' drop-after' : ''}`} style={dragging ? { transform: `translateY(${drag!.offset}px)` } : undefined}>
            {items.length > 1 ? (
              <button
                type="button"
                className="sortable-grip"
                title={words ? t(words.drag) : t('Drag to reorder {item}. Arrow keys work too.', { item: label })}
                aria-label={words ? t(words.reorder, { position: i + 1, total: items.length }) : t('Reorder {item} {position} of {total}. Use the up and down arrow keys.', { item: label, position: i + 1, total: items.length })}
                data-testid={testId ? `${testId}-grip-${i}` : undefined}
                onPointerDown={(e) => onGripDown(e, i)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  e.stopPropagation();
                  move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
                  const at = e.key === 'ArrowUp' ? i - 1 : i + 1;
                  requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>('.sortable-grip')[at]?.focus());
                }}
              ><GripVertical size={12} /></button>
            ) : <span className="sortable-grip-gap" />}
            <div className="sortable-body">{render(item, i)}</div>
          </div>
        );
      })}
    </div>
  );
}
