import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ui, useUi } from '../state/ui.ts';
import { IconButton } from './controls.tsx';
import { useT } from '../i18n/react.ts';

/** One image of a comment, big. Esc closes, arrows go through the others of that message. */
export function Lightbox() {
  const t = useT();
  const box = useUi((s) => s.lightbox);
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  const open = Boolean(box);
  useEffect(() => {
    if (!open) return undefined;
    back.current = document.activeElement;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      const cur = ui().lightbox;
      if (!cur) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        ui().set({ lightbox: null });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const step = e.key === 'ArrowRight' ? 1 : -1;
        ui().set({ lightbox: { ...cur, index: (cur.index + step + cur.images.length) % cur.images.length } });
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (back.current instanceof HTMLElement && back.current.isConnected) back.current.focus();
    };
  }, [open]);
  if (!box) return null;
  const image = box.images[box.index];
  if (!image) return null;
  const close = () => ui().set({ lightbox: null });
  const many = box.images.length > 1;
  return (
    <div ref={ref} className="lightbox" role="dialog" aria-modal="true" aria-label={image.name ?? t('Attached image')} tabIndex={-1} data-ui data-testid="lightbox" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <img src={image.src} alt={image.name ?? ''} data-testid="lightbox-image" />
      <div className="lightbox-bar">
        {many ? <IconButton icon={<ChevronLeft size={15} />} title={t('Previous ({shortcut})', { shortcut: '←' })} onClick={() => ui().set({ lightbox: { ...box, index: (box.index - 1 + box.images.length) % box.images.length } })} /> : null}
        <span className="lightbox-name" dir="auto">{many ? t('{name} {position} of {total}', { name: image.name ?? t('Image'), position: box.index + 1, total: box.images.length }) : image.name ?? t('Image')}</span>
        {many ? <IconButton icon={<ChevronRight size={15} />} title={t('Next ({shortcut})', { shortcut: '→' })} onClick={() => ui().set({ lightbox: { ...box, index: (box.index + 1) % box.images.length } })} /> : null}
        <IconButton icon={<X size={15} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="lightbox-close" />
      </div>
    </div>
  );
}
