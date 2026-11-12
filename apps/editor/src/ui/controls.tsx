import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { evalExpression, fmt } from '../lib/css-values.ts';
import { maybeSession } from '../doc/session.ts';
import { useT } from '../i18n/react.ts';

export const MIXED = Symbol('mixed');

/** With nothing typed yet, ctrl+Z in a field means the document, not the field. */
function documentUndo(e: React.KeyboardEvent, dirty: boolean): boolean {
  if (dirty || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return false;
  const s = maybeSession();
  if (!s) return false;
  e.preventDefault();
  if (e.shiftKey) s.undo.redo();
  else s.undo.undo();
  return true;
}
export type Maybe<T> = T | typeof MIXED;

/** Common value of a list, or MIXED. */
export function common<T>(values: T[]): Maybe<T> | undefined {
  if (!values.length) return undefined;
  const first = values[0]!;
  return values.every((v) => v === first) ? first : MIXED;
}

interface NumberFieldProps {
  label?: ReactNode;
  value: number | typeof MIXED | null;
  /** Shown in place of the number when the value is not numeric, such as `auto`. */
  display?: string;
  onChange: (value: number) => void;
  /** Text that is not arithmetic, such as `50%`, `auto` or `fit-content`. */
  onRaw?: (text: string) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  suffix?: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  className?: string;
  testId?: string;
  /** Pixels of drag per step when scrubbing. */
  scrubRate?: number;
}

/** Numeric input with scrubbing on its label, arrow keys, and math in the field. */
export function NumberField({ label, value, display, onChange, onRaw, min, max, step = 1, precision = 2, suffix, disabled, title, placeholder, className, testId, scrubRate = 2 }: NumberFieldProps) {
  const t = useT();
  const shown = value === MIXED ? '' : display ?? (value === null ? '' : fmt(value, precision));
  const [text, setText] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const clamp = (n: number) => {
    let out = n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return Number(out.toFixed(precision));
  };
  const numeric = typeof value === 'number' ? value : undefined;

  const commit = () => {
    if (text === null) return;
    const raw = text.trim();
    setText(null);
    if (!raw || raw === shown) return;
    // A length in another unit is what it says, not arithmetic.
    if (onRaw && /^-?[\d.]+\s*(%|vw|vh|vmin|vmax|em|rem|ch|fr)$/i.test(raw)) {
      onRaw(raw);
      return;
    }
    const n = evalExpression(raw, numeric);
    if (n !== null) onChange(clamp(n));
    else onRaw?.(raw);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (documentUndo(e, text !== null)) return;
    if (e.key === 'Enter') {
      // Back to the canvas, so that the next keys are shortcuts again.
      commit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setText(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const base = text !== null ? (evalExpression(text, numeric) ?? numeric ?? 0) : numeric ?? 0;
      const next = clamp(base + dir * step * mult);
      setText(null);
      onChange(next);
    }
  };

  const onScrubDown = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const start = numeric ?? 0;
    const startX = e.clientX;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let moved = false;
    let raf = 0;
    let pending: number | null = null;
    const flush = () => {
      raf = 0;
      if (pending !== null) onChange(pending);
    };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 2) return;
      if (!moved) {
        moved = true;
        maybeSession()?.beginGesture();
        document.body.classList.add('is-scrubbing');
      }
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      pending = clamp(start + Math.round(dx / scrubRate) * step * mult);
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      if (moved) {
        flush();
        maybeSession()?.endGesture();
        document.body.classList.remove('is-scrubbing');
      } else inputRef.current?.focus();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <label className={`field${disabled ? ' is-disabled' : ''} ${className ?? ''}`} title={title}>
      {label !== undefined ? <span className="field-label" onPointerDown={onScrubDown} onClick={(e) => e.preventDefault()}>{label}</span> : null}
      <input
        ref={inputRef}
        className="field-input"
        data-testid={testId}
        value={text ?? shown}
        placeholder={value === MIXED ? t('Mixed') : placeholder}
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
      {suffix ? <span className="field-suffix">{suffix}</span> : null}
    </label>
  );
}

interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: ReactNode;
  className?: string;
  mixed?: boolean;
  title?: string;
  testId?: string;
  /** Commit on every keystroke rather than on enter and blur. */
  live?: boolean;
}

export function TextField({ value, onChange, placeholder, disabled, label, className, mixed, title, testId, live }: TextFieldProps) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text !== null && text !== value) onChange(text);
    setText(null);
  };
  return (
    <label className={`field${disabled ? ' is-disabled' : ''} ${className ?? ''}`} title={title}>
      {label !== undefined ? <span className="field-label is-static">{label}</span> : null}
      <input
        className="field-input"
        data-testid={testId}
        value={text ?? (mixed ? '' : value)}
        placeholder={mixed ? t('Mixed') : placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (live) onChange(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (documentUndo(e, text !== null)) return;
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setText(null);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

interface SelectFieldProps<T extends string> {
  value: T | typeof MIXED | undefined;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
  title?: string;
  testId?: string;
}

const SELECT_CHEVRON = <ChevronDown size={12} className="field-chevron" />;

export function SelectField<T extends string>({ value, options, onChange, label, disabled, className, title, testId }: SelectFieldProps<T>) {
  const t = useT();
  const known = value !== MIXED && options.some((o) => o.value === value);
  return (
    <label className={`field field-select${disabled ? ' is-disabled' : ''} ${className ?? ''}`} title={title}>
      {label !== undefined ? <span className="field-label is-static">{label}</span> : null}
      <select
        className="field-input"
        data-testid={testId}
        value={value === MIXED ? '__mixed' : (value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {value === MIXED ? <option value="__mixed" disabled>{t('Mixed')}</option> : null}
        {value !== MIXED && !known ? <option value={value ?? ''} disabled>{value ?? ''}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      {SELECT_CHEVRON}
    </label>
  );
}

export function IconButton({ icon, title, onClick, active, disabled, className, testId, tabIndex }: { icon: ReactNode; title: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; active?: boolean; disabled?: boolean; className?: string; testId?: string; tabIndex?: number }) {
  return (
    <button type="button" className={`icon-btn${active ? ' is-active' : ''} ${className ?? ''}`} title={title} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick} data-testid={testId} tabIndex={tabIndex}>
      {icon}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, testId }: { value: T | typeof MIXED | undefined; options: { value: T; icon?: ReactNode; label?: string; title: string; disabled?: boolean }[]; onChange: (value: T) => void; testId?: string }) {
  return (
    <div className="segmented" role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`segment${value === o.value ? ' is-active' : ''}`} title={o.title} aria-label={o.title} disabled={o.disabled} onClick={() => onChange(o.value)} data-testid={testId ? `${testId}-${o.value}` : undefined}>
          {o.icon ?? o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, note, children, actions, collapsible, defaultOpen = true, empty }: { title: string; note?: string; children?: ReactNode; actions?: ReactNode; collapsible?: boolean; defaultOpen?: boolean; empty?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section${empty ? ' is-empty' : ''}`} data-section={title}>
      <header className="section-head">
        {collapsible ? (
          <button type="button" className="section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{title}</span>{note ? <span className="section-note">{note}</span> : null}
          </button>
        ) : <span className="section-title">{title}</span>}
        <span className="section-actions">{actions}</span>
      </header>
      {open && children ? <div className="section-body">{children}</div> : null}
    </section>
  );
}

export function Row({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`row ${className ?? ''}`} style={style}>{children}</div>;
}

/** The interface size setting. A zoomed element's left and top are in zoomed pixels too. */
function uiZoom(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
}

const FOCUSABLE = '[role="menuitem"]:not(:disabled), button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The controls of a popover that the keyboard reaches, in order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert], [hidden]') && el.getClientRects().length > 0);
}

/**
 * A floating panel anchored next to an element. Closes on outside press and Escape, and when it closes with the focus
 * inside, the focus goes back to its button. It stays inside the window at any UI scale: no wider than the window,
 * and as high as the room below its button (or the window), scrolling what is more.
 *
 * `focus` is for menus and panels opened from a button, as in the toolbar: the focus moves to its first control when
 * it opens, the arrow keys, Home and End move through a menu's items, and Tab past its last control (or Shift+Tab
 * before its first) closes it and goes on from its button.
 */
export function Popover({ anchor, onClose, children, width = 240, side = 'left', className, focus = false }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; side?: 'left' | 'below'; className?: string; focus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      // The popover is drawn at the UI scale: its CSS pixels are `z` window pixels.
      const z = uiZoom();
      const a = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.max(0, Math.min(width * z, vw - 16));
      const h = el.getBoundingClientRect().height;
      let left = side === 'left' ? a.left - w - 8 : a.left;
      left = Math.max(8, Math.min(vw - w - 8, left));
      let top: number;
      if (side === 'below') {
        // Below its button while there is a usable room there; else as high in the window as it needs.
        top = a.bottom + 4;
        if (vh - top - 8 < Math.min(h, 160)) top = Math.max(8, vh - h - 8);
      } else top = Math.max(8, Math.min(vh - h - 8, a.top - 8));
      const next = { left: left / z, top: top / z, width: w / z, maxHeight: Math.max(0, vh - top - 8) / z };
      setPos((p) => (p && p.left === next.left && p.top === next.top && p.width === next.width && p.maxHeight === next.maxHeight ? p : next));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(ref.current);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, side, width]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // A popover opened from within this popover keeps it open.
      if (t.closest('.popover, [data-keep-popover]')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);
  // Opened from its button: the focus goes in, unless something inside took it already (an autofocused field).
  useEffect(() => {
    const el = ref.current;
    if (!focus || !el || el.contains(document.activeElement)) return;
    focusables(el)[0]?.focus({ preventScroll: true });
  }, [focus]);
  // Closing with the focus inside gives it back to the button, before the popover leaves the page.
  useLayoutEffect(() => () => {
    const el = ref.current;
    if (el && el.contains(document.activeElement) && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }, [anchor]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!focus || !el || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    const menu = target.closest('[role="menu"]');
    if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const items = focusables(menu as HTMLElement).filter((i) => i.getAttribute('role') === 'menuitem');
      if (!items.length) return;
      const at = items.indexOf(target);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      e.preventDefault();
      e.stopPropagation();
      items[next]?.focus({ preventScroll: false });
      return;
    }
    if (e.key === 'Tab') {
      const all = focusables(el);
      const edge = e.shiftKey ? all[0] : all[all.length - 1];
      if (all.length && target !== edge) return;
      // Out of the popover: from its button on, as if it had not been opened. The browser moves the focus after this.
      anchor?.focus({ preventScroll: true });
      onClose();
    }
  };
  return createPortal(
    <div ref={ref} className={`popover ${className ?? ''}`} data-ui onKeyDown={onKeyDown} style={{ width: pos?.width ?? width, maxHeight: pos?.maxHeight, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
      {children}
    </div>,
    document.body,
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
    </div>
  );
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text);
  return Promise.resolve();
}

function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
