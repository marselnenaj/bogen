import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Pipette } from 'lucide-react';
import { detectFormat, formatColor, hexOf, hsvaFromOklch, hsvaFromP3, hsvToCssHue, isVar, oklchParts, p3Parts, parseToHsva, varName, type ColorFormat, type Hsva } from '../lib/color.ts';
import { fmt } from '../lib/css-values.ts';
import { useTokens } from '../doc/hooks.ts';
import { maybeSession } from '../doc/session.ts';
import { IconButton, NumberField, Popover, SelectField, TextField } from './controls.tsx';
import { withTokenValues } from '../lib/token-color.ts';
import { useT } from '../i18n/react.ts';

declare global {
  interface Window { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }
}

function useDrag(onDrag: (x: number, y: number) => void) {
  return (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    maybeSession()?.beginGesture();
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onDrag(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      maybeSession()?.endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
}

/** The picker. Keeps HSV as its working state so that hue survives at black, white and gray. */
export function ColorPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const tokens = useTokens().filter((tk) => tk.kind === 'color');
  const bound = isVar(value) ? varName(value) : null;
  const resolved = bound ? (tokens.find((tk) => tk.name === bound)?.value ?? '#000000') : value;
  const [hsva, setHsva] = useState<Hsva>(() => parseToHsva(resolved) ?? { h: 0, s: 0, v: 0, a: 1 });
  const [format, setFormat] = useState<ColorFormat>(() => detectFormat(resolved));
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    const parsed = parseToHsva(resolved);
    if (parsed) setHsva(parsed);
  }, [value, resolved]);

  const emit = (next: Hsva, f: ColorFormat = format) => {
    setHsva(next);
    const out = formatColor(next, f);
    lastEmitted.current = out;
    onChange(out);
  };

  const area = useDrag((x, y) => emit({ ...hsva, s: x, v: 1 - y }));
  const hue = useDrag((x) => emit({ ...hsva, h: x * 360 }));
  const alpha = useDrag((x) => emit({ ...hsva, a: Math.round(x * 100) / 100 }));

  const pick = async () => {
    if (!window.EyeDropper) return;
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      const parsed = parseToHsva(sRGBHex);
      if (parsed) emit(parsed);
    } catch {
      // Dismissed with Escape.
    }
  };

  const hex = hexOf(formatColor({ ...hsva, a: 1 }, 'hex'));
  const parts = oklchParts(hsva);
  const p3 = p3Parts(hsva);

  return (
    <div className="picker" data-testid="color-picker">
      <div className="picker-area" style={{ backgroundColor: hsvToCssHue(hsva.h) }} onPointerDown={area} data-testid="picker-area">
        <div className="picker-area-thumb" style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, backgroundColor: hex }} />
      </div>
      <div className="picker-sliders">
        <div className="picker-sliders-col">
          <div className="picker-slider picker-hue" onPointerDown={hue}>
            <div className="picker-slider-thumb" style={{ left: `${(hsva.h / 360) * 100}%` }} />
          </div>
          <div className="picker-slider picker-alpha" onPointerDown={alpha}>
            <div className="picker-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${hex})` }} />
            <div className="picker-slider-thumb" style={{ left: `${hsva.a * 100}%` }} />
          </div>
        </div>
        {window.EyeDropper ? <IconButton icon={<Pipette size={14} />} title={t('Pick a colour from the screen')} onClick={() => void pick()} /> : null}
      </div>
      <div className="row">
        <SelectField<ColorFormat>
          className="picker-format"
          value={format}
          onChange={(f) => { setFormat(f); emit(hsva, f); }}
          options={[{ value: 'hex', label: 'Hex' }, { value: 'oklch', label: 'OKLCH' }, { value: 'p3', label: 'P3' }]}
          testId="picker-format"
        />
        {format === 'hex' ? (
          <TextField
            value={hex}
            testId="picker-hex"
            onChange={(text) => {
              const parsed = parseToHsva(text.startsWith('#') ? text : `#${text}`) ?? parseToHsva(text);
              if (parsed) emit({ ...parsed, a: hsva.a });
            }}
          />
        ) : null}
        <NumberField value={Math.round(hsva.a * 100)} suffix="%" min={0} max={100} className="picker-alpha-field" title={t('Opacity')} onChange={(v) => emit({ ...hsva, a: v / 100 })} />
      </div>
      {format === 'oklch' ? (
        <div className="row">
          <NumberField label="L" value={Number(fmt(parts.l, 1))} min={0} max={100} step={1} precision={1} onChange={(l) => emit(hsvaFromOklch(l, parts.c, parts.h, hsva.a))} />
          <NumberField label="C" value={Number(fmt(parts.c, 3))} min={0} max={0.5} step={0.01} precision={3} onChange={(c) => emit(hsvaFromOklch(parts.l, c, parts.h, hsva.a))} />
          <NumberField label="H" value={Number(fmt(parts.h, 1))} min={0} max={360} step={1} precision={1} onChange={(h) => emit(hsvaFromOklch(parts.l, parts.c, h, hsva.a))} />
        </div>
      ) : null}
      {format === 'p3' ? (
        <div className="row">
          <NumberField label="R" value={Number(fmt(p3.r, 3))} min={0} max={1} step={0.01} precision={3} onChange={(r) => emit(hsvaFromP3(r, p3.g, p3.b, hsva.a))} />
          <NumberField label="G" value={Number(fmt(p3.g, 3))} min={0} max={1} step={0.01} precision={3} onChange={(g) => emit(hsvaFromP3(p3.r, g, p3.b, hsva.a))} />
          <NumberField label="B" value={Number(fmt(p3.b, 3))} min={0} max={1} step={0.01} precision={3} onChange={(b) => emit(hsvaFromP3(p3.r, p3.g, b, hsva.a))} />
        </div>
      ) : null}
      {tokens.length ? (
        <div className="picker-tokens">
          {tokens.map((tk) => (
            <button
              key={tk.name}
              type="button"
              className={`picker-token${bound === tk.name ? ' is-active' : ''}`}
              title={t('Bind to {token}', { token: `--${tk.name}` })}
              onClick={() => {
                const v = `var(--${tk.name})`;
                lastEmitted.current = v;
                onChange(v);
              }}
            >
              <span className="swatch-dot" style={{ background: withTokenValues(tk.value) }} />
              <span>{tk.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="picker-hint">{t('Add colour tokens on the left to bind them here.')}</div>
      )}
    </div>
  );
}

/** Swatch plus value, opening the picker in a popover. */
export function ColorField({ value, onChange, placeholder, mixed, testId, onRemove }: { value: string; onChange: (value: string) => void; placeholder?: string; mixed?: boolean; testId?: string; onRemove?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const label = mixed ? t('Mixed') : isVar(value) ? `--${varName(value)}` : value || placeholder || t('None');
  const swatch = mixed ? undefined : value;
  void onRemove;
  return (
    <div className="color-field">
      <button ref={ref} type="button" className="swatch" onClick={() => setOpen(!open)} title={t('Edit colour')} data-testid={testId}>
        <span className="swatch-fill" style={{ background: swatch ? withTokenValues(swatch) : 'transparent' }} />
      </button>
      <TextField className="color-text" value={value} mixed={mixed} placeholder={label} onChange={onChange} />
      {open ? (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          <ColorPicker value={value || '#000000'} onChange={onChange} />
        </Popover>
      ) : null}
    </div>
  );
}
