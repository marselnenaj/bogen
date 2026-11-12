import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { bulkRename, type RenamePlan } from '@bogen/core';
import { rectOf } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, NumberField, TextField } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { ctx } from '../i18n/core.ts';

/** The layers in reading order on the canvas: rows from the top, then left to right, as a grid of cards reads. */
export function readingOrder(ids: readonly string[]): string[] {
  const rects = new Map(ids.map((id) => [id, rectOf(id)]));
  return [...ids].sort((a, b) => {
    const ra = rects.get(a);
    const rb = rects.get(b);
    if (!ra || !rb) return 0;
    // The same row when they overlap by half the smaller height.
    const overlap = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
    if (overlap > Math.min(ra.h, rb.h) / 2) return ra.x - rb.x;
    return ra.y - rb.y;
  });
}

/** Ctrl+R with several layers selected, or Rename layers in the palette. */
export function openBulkRename(ids: readonly string[] = editor().selection): void {
  const { snap } = session();
  const here = ids.filter((id) => snap.nodes.has(id));
  if (here.length < 2) {
    editor().set({ renamingLayerId: here[0] ?? null, leftTab: 'layers' });
    return;
  }
  ui().set({ bulkRename: readingOrder(here) });
}

export function BulkRenameDialog() {
  const ids = useUi((s) => s.bulkRename);
  return ids ? <Body ids={ids} /> : null;
}

function Body({ ids }: { ids: string[] }) {
  const t = useT();
  const [plan, setPlan] = useState<RenamePlan>({ pattern: '$&', start: 1 });
  const ref = useRef<HTMLDivElement>(null);
  const close = () => ui().set({ bulkRename: null });
  const { snap } = session();
  const names = ids.map((id) => snap.nodes.get(id)?.name ?? '');
  const next = useMemo(() => bulkRename(names, plan), [names.join('\n'), plan]);
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input')?.select();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  const apply = () => {
    const s = session();
    s.tx(() => ids.forEach((id, i) => { if (next[i] && next[i] !== names[i] && s.snap.nodes.has(id)) s.doc.updateFields(id, { name: next[i]! }); }));
    const changed = next.filter((n, i) => n !== names[i]).length;
    editor().showToast(changed ? t.n(changed, 'Renamed {count} layer', 'Renamed {count} layers') : t('No names changed'));
    close();
  };
  const latest = useRef(apply);
  latest.current = apply;
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || (e.target as HTMLElement).tagName === 'BUTTON') return;
    // The field commits on Enter too, after this: take its value on the next frame.
    requestAnimationFrame(() => latest.current());
  };
  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="dialog rename-dialog" role="dialog" aria-modal="true" aria-label={t.n(ids.length, 'Rename {count} layer', 'Rename {count} layers')} data-testid="rename-dialog" onKeyDownCapture={onEnter}>
        <header className="dialog-head settings-head">
          <span className="settings-title">{t.n(ids.length, 'Rename {count} layer', 'Rename {count} layers')}</span>
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="rename-close" />
        </header>
        <div className="rename-body">
          <TextField label={t('Name')} value={plan.pattern ?? ''} live placeholder={t('{pattern} keeps the name', { pattern: '$&' })} onChange={(pattern) => setPlan({ ...plan, pattern })} testId="rename-pattern" />
          <div className="rename-hint">{t('{current} is the current name, {up} counts up, {down} counts down, {padded} pads with zeros. In reading order on the canvas.', { current: '$&', up: '$n', down: '$N', padded: '$nn' })}</div>
          <TextField label={t('Find')} value={plan.find ?? ''} live placeholder={t('Text in the names')} onChange={(find) => setPlan({ ...plan, find })} testId="rename-find" />
          <TextField label={t('With')} value={plan.replace ?? ''} live placeholder={t('Replace it with')} onChange={(replace) => setPlan({ ...plan, replace })} testId="rename-replace" />
          <NumberField label={t(ctx('first number of a numbering', 'Start'))} value={plan.start ?? 1} step={1} precision={0} onChange={(start) => setPlan({ ...plan, start })} testId="rename-start" />
          <ul className="rename-preview" data-testid="rename-preview" aria-label={t('New names')}>
            {next.slice(0, 8).map((n, i) => <li key={ids[i]}><span dir="auto">{names[i]}</span>→<b dir="auto">{n}</b></li>)}
            {next.length > 8 ? <li>{t.n(next.length - 8, 'and {count} more', 'and {count} more')}</li> : null}
          </ul>
        </div>
        <footer className="rename-foot">
          <button type="button" className="btn btn-quiet" onClick={close}>{t('Cancel')}</button>
          <button type="button" className="btn btn-primary" data-testid="rename-apply" onClick={apply}>{t('Rename')}</button>
        </footer>
      </div>
    </div>
  );
}
