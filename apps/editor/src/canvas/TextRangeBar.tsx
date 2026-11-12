import { useEffect, useState } from 'react';
import { Bold, Italic, Link2, RemoveFormatting, Underline } from 'lucide-react';
import { SPAN_STYLE_KEYS } from '@bogen/core';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { ColorField } from '../ui/ColorPicker.tsx';
import { IconButton } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { rangeValue, refocusRange, styleRange, toggleRangeStyle, useTextRange } from './text-edit.ts';

const WEIGHTS = ['300', '400', '500', '600', '700', '800', '900'];

/** Appears over a selected range while typing in a text layer. What it sets applies to that range only. */
export function TextRangeBar() {
  const t = useT();
  const editing = useEditor((s) => s.editingTextId);
  const rect = useTextRange((s) => s.rect);
  const [, force] = useState(0);
  const [linking, setLinking] = useState(false);
  const [link, setLink] = useState('');
  useEffect(() => { if (!rect) setLinking(false); }, [rect]);
  if (!editing || !rect) return null;
  const left = Math.max(8, Math.min(camera.width - 320, rect.x - camera.left + rect.w / 2 - 150));
  const top = Math.max(8, rect.y - camera.top - 40);
  const bump = () => force((n) => n + 1);
  const toggle = (key: string, on: string, off: string) => { toggleRangeStyle(key, on, off); bump(); };
  const v = rangeValue('fontWeight');
  // A press on a button must leave the selection in the text alone.
  const keep = (e: React.PointerEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'OPTION') e.preventDefault();
  };
  return (
    <div className="text-bar" data-ui data-text-bar data-testid="text-bar" role="toolbar" aria-label={t('Style the selected text')} style={{ left, top }} onPointerDown={keep} onMouseDown={keep as never}>
      <IconButton icon={<Bold size={14} />} title={t('Bold ({shortcut})', { shortcut: 'Ctrl+B' })} active={v.all('700')} testId="range-bold" onClick={() => toggle('fontWeight', '700', '400')} />
      <IconButton icon={<Italic size={14} />} title={t('Italic ({shortcut})', { shortcut: 'Ctrl+I' })} active={rangeValue('fontStyle').all('italic')} testId="range-italic" onClick={() => toggle('fontStyle', 'italic', 'normal')} />
      <IconButton icon={<Underline size={14} />} title={t('Underline ({shortcut})', { shortcut: 'Ctrl+U' })} active={rangeValue('textDecorationLine').all('underline')} testId="range-underline" onClick={() => toggle('textDecorationLine', 'underline', 'none')} />
      <span className="toolbar-sep" />
      <select className="text-bar-select" aria-label={t('Weight')} title={t('Weight')} value="" data-testid="range-weight" onChange={(e) => { styleRange({ fontWeight: e.target.value }); refocusRange(); bump(); }}>
        <option value="" disabled>{t('Weight')}</option>
        {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
      </select>
      <input
        className="text-bar-size"
        placeholder={t('Size')}
        aria-label={t('Size in pixels')}
        title={t('Size in pixels')}
        data-testid="range-size"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            // Focus goes back to the text in this handler, and the key must not arrive there.
            e.preventDefault();
            const n = parseFloat(e.currentTarget.value);
            if (n > 0) styleRange({ fontSize: `${n}px` });
            e.currentTarget.value = '';
            refocusRange();
            bump();
          }
          if (e.key === 'Escape') { e.preventDefault(); refocusRange(); }
        }}
      />
      <div className="text-bar-color" title={t('Colour')}>
        <ColorField value="" placeholder={t('Colour')} onChange={(c) => {
          styleRange({ color: c || null });
          bump();
          // From the field the work is done; in the picker a drag is still going on.
          requestAnimationFrame(() => { if (!document.activeElement?.closest('.popover')) refocusRange(); });
        }} testId="range-color" />
      </div>
      <span className="toolbar-sep" />
      <IconButton icon={<Link2 size={14} />} title={t('Link')} active={linking || Boolean(rangeValue('color').link)} testId="range-link" onClick={() => { setLink(rangeValue('color').link ?? ''); setLinking(!linking); }} />
      <IconButton icon={<RemoveFormatting size={14} />} title={t('Clear what this range sets')} testId="range-clear" onClick={() => { styleRange(Object.fromEntries(SPAN_STYLE_KEYS.map((k) => [k, null])), null); bump(); }} />
      {linking ? (
        <input
          autoFocus
          className="text-bar-link"
          placeholder="https://"
          aria-label={t('Link address')}
          value={link}
          data-testid="range-link-input"
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              const href = link.trim();
              styleRange(href ? { textDecorationLine: 'underline' } : { textDecorationLine: null }, href || null);
              setLinking(false);
              refocusRange();
            }
            if (e.key === 'Escape') { e.preventDefault(); setLinking(false); refocusRange(); }
          }}
        />
      ) : null}
    </div>
  );
}
