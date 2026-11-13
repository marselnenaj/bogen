import { clampAt, fluidClamp, hostedFamilies } from '@bogen/core';
import { inspectorStyle } from '../../ops/breakpoints.ts';
import { elOf, rectOf } from '../../canvas/measure.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type BogenNode } from '@bogen/core';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, ALargeSmall, Baseline, CaseLower, CaseSensitive, CaseUpper, Italic, Strikethrough, Underline } from 'lucide-react';
import { fmt, fmtPx, parseAxes, parseFeatures, printAxes, printFeatures, px } from '../../lib/css-values.ts';
import { ensureFont, listFonts, listLocalFonts, primaryFamily } from '../../lib/fonts.ts';
import { setFields } from '../../ops/ops.ts';
import { ColorField } from '../../ui/ColorPicker.tsx';
import { common, IconButton, MIXED, NumberField, Popover, Row, Section, Segmented, SelectField, TextField } from '../../ui/controls.tsx';
import type { FontEntry } from '../../lib/api.ts';
import { TextStyleField } from './TextStyleField.tsx';
import { fileFamilies } from './FontPanel.tsx';
import { session } from '../../doc/session.ts';
import { ctx, msg } from '../../i18n/core.ts';
import { useT } from '../../i18n/react.ts';

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const WEIGHT_NAMES: Record<number, string> = { 100: ctx('font weight', 'Thin'), 200: ctx('font weight', 'Extra light'), 300: ctx('font weight', 'Light'), 400: ctx('font weight', 'Regular'), 500: ctx('font weight', 'Medium'), 600: ctx('font weight', 'Semibold'), 700: ctx('font weight', 'Bold'), 800: ctx('font weight', 'Extra bold'), 900: ctx('font weight', 'Black') };

function FontPicker({ value, mixed, onChange }: { value: string; mixed: boolean; onChange: (family: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [local, setLocal] = useState<FontEntry[]>([]);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) void listFonts().then(setFonts);
  }, [open]);
  // Fonts the file holds, made here or brought by a capture, read when the list opens.
  const inFile = useMemo<FontEntry[]>(() => (open ? fileFamilies().map((f) => ({ family: f.family, source: 'file', made: f.made })) : []), [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...inFile, ...local, ...fonts];
    const seen = new Set<string>();
    const out: FontEntry[] = [];
    for (const f of all) {
      if (seen.has(f.family) || (q && !f.family.toLowerCase().includes(q))) continue;
      seen.add(f.family);
      out.push(f);
      if (out.length > 120) break;
    }
    return out;
  }, [fonts, local, inFile, query]);

  const canAddTyped = query.trim() && !results.some((r) => r.family.toLowerCase() === query.trim().toLowerCase());

  return (
    <>
      <button ref={ref} type="button" className="font-button" onClick={() => setOpen(!open)} data-testid="font-button" title={t('Font family')}>
        <span>{mixed ? t('Mixed') : primaryFamily(value) || t('Default')}</span>
      </button>
      {open ? (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={256} className="font-popover">
          <input
            autoFocus
            className="font-search"
            placeholder={t('Search fonts')}
            value={query}
            data-testid="font-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const first = results[0]?.family ?? query.trim();
                if (first) {
                  onChange(first);
                  setOpen(false);
                }
              }
            }}
          />
          <div className="font-list">
            {canAddTyped ? (
              <button type="button" className="font-row" onClick={() => { onChange(query.trim()); setOpen(false); }}>{t('Use "{font}"', { font: query.trim() })}</button>
            ) : null}
            {results.map((f) => (
              <button key={f.family} type="button" className="font-row" data-testid="font-row" onClick={() => { onChange(f.family); setOpen(false); }} onMouseEnter={() => { if (f.source === 'google') ensureFont(f.family); }} style={{ fontFamily: `"${f.family}", var(--ui-font)` }}>
                <span>{f.family}</span>
                {f.source === 'local' ? <span className="font-tag">{t('Local')}</span> : null}
                {f.source === 'file' ? <span className="font-tag" data-testid="font-tag-file">{f.made ? t('Made here') : t('In this file')}</span> : null}
              </button>
            ))}
            {!results.length && !canAddTyped ? <div className="hint">{t('No font matches.')}</div> : null}
          </div>
          {!local.length && 'queryLocalFonts' in window ? (
            <button type="button" className="btn btn-quiet" onClick={() => void listLocalFonts().then(setLocal)}>{t('Show fonts on this computer')}</button>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

const FEATURES: { tag: string; label: string }[] = [
  { tag: 'liga', label: msg('Ligatures') },
  { tag: 'calt', label: msg('Contextual') },
  { tag: 'dlig', label: msg('Discretionary') },
  { tag: 'tnum', label: msg('Tabular figures') },
  { tag: 'onum', label: msg('Oldstyle figures') },
  { tag: 'lnum', label: msg('Lining figures') },
  { tag: 'frac', label: msg('Fractions') },
  { tag: 'smcp', label: msg('Small caps') },
  { tag: 'case', label: msg('Case forms') },
  { tag: 'zero', label: msg('Slashed zero') },
  { tag: 'ss01', label: msg('Stylistic set 1') },
  { tag: 'ss02', label: msg('Stylistic set 2') },
];

const AXES: { tag: string; label: string; min: number; max: number; step: number }[] = [
  { tag: 'wght', label: msg('Weight'), min: 1, max: 1000, step: 10 },
  { tag: 'wdth', label: msg('Width'), min: 25, max: 200, step: 1 },
  { tag: 'slnt', label: msg('Slant'), min: -15, max: 15, step: 1 },
  { tag: 'ital', label: msg('Italic'), min: 0, max: 1, step: 1 },
  { tag: 'opsz', label: msg('Optical'), min: 8, max: 144, step: 1 },
];

export function TypographySection({ nodes: all, allText }: { nodes: BogenNode[]; allText: boolean }) {
  const t = useT();
  const nodes = all.filter((n) => n.type === 'text');
  const ids = nodes.map((n) => n.id);
  const first = nodes[0]!;
  const styles = session().snap.textStyles;
  // A text style writes a class, so its values are not on the layer but are what it shows.
  const val = (key: string) => common(nodes.map((n) => n.style[key] ?? styles.find((t) => t.key === n.textStyle)?.style[key] ?? ''));
  const family = val('fontFamily');
  const weight = val('fontWeight');
  const size = val('fontSize');
  const lh = val('lineHeight');
  const ls = val('letterSpacing');
  const color = val('color');
  const align = val('textAlign');
  const transform = val('textTransform');
  const decoration = val('textDecorationLine');
  const isItalic = val('fontStyle') === 'italic';
  const isTruncated = nodes.every((n) => n.style.textOverflow === 'ellipsis');
  const clamp = val('WebkitLineClamp');
  const isGradient = nodes.every((n) => n.style.WebkitBackgroundClip === 'text');
  const strokeW = val('WebkitTextStrokeWidth');
  const strokeC = val('WebkitTextStrokeColor');
  const features = parseFeatures(first.style.fontFeatureSettings);
  const axes = parseAxes(first.style.fontVariationSettings);

  const lhIsUnitless = typeof lh === 'string' && lh !== '' && /^[\d.]+$/.test(lh);
  const lhShown = lh === MIXED ? MIXED : lh ? parseFloat(lh) : null;

  const toggleTruncate = () => {
    if (isTruncated) inspectorStyle(ids, { whiteSpace: null, overflow: null, textOverflow: null, display: null, WebkitLineClamp: null, WebkitBoxOrient: null });
    else inspectorStyle(ids, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
  };

  const toggleGradient = () => {
    if (isGradient) inspectorStyle(ids, { WebkitBackgroundClip: null, backgroundClip: null, backgroundImage: null, color: '#111111' });
    else inspectorStyle(ids, { WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', backgroundImage: first.style.backgroundImage ?? 'linear-gradient(90deg, #7c3aed 0%, #ec4899 100%)' });
  };

  return (
    <Section title={t('Typography')}>
      <div className="stack">
        {!allText ? <div className="hint">{t('Applies to the text layers in the selection.')}</div> : null}
        <TextStyleField nodes={nodes} />
        <FontPicker value={typeof family === 'string' ? family : ''} mixed={family === MIXED} onChange={(f) => { ensureFont(f, hostedFamilies(session().doc)); inspectorStyle(ids, { fontFamily: `"${f}", sans-serif` }); }} />
        <Row>
          <SelectField<string>
            value={weight === MIXED ? MIXED : weight || '400'}
            options={WEIGHTS.map((w) => ({ value: String(w), label: `${w} ${t(WEIGHT_NAMES[w]!)}` }))}
            onChange={(w) => inspectorStyle(ids, { fontWeight: w })}
            title={t('Weight')}
            testId="type-weight"
          />
          <NumberField label={t('Size')} value={size === MIXED ? MIXED : size ? fluidEnds(size)?.[1] ?? px(size) : 16} min={1} testId="type-size" title={t('Font size')} onChange={(v) => inspectorStyle(ids, { fontSize: fmtPx(v) })} onRaw={(raw) => inspectorStyle(ids, { fontSize: raw })} />
        </Row>
        {size !== MIXED ? <FluidRow value={typeof size === 'string' && size ? size : '16px'} onChange={(v) => inspectorStyle(ids, { fontSize: v })} testId="type-fluid" /> : null}
        {nodes.length === 1 && (first.text?.length ?? 0) > 80 ? <MeasureNote node={first} /> : null}
        <Row>
          <NumberField
            label={t('Line')}
            value={lhShown}
            step={lhIsUnitless ? 0.05 : 1}
            placeholder={t('Auto')}
            testId="type-line-height"
            title={t('Line height. Numbers under 8 are multiples of the font size.')}
            onChange={(v) => inspectorStyle(ids, { lineHeight: v < 8 ? fmt(v) : fmtPx(v) })}
            onRaw={(raw) => inspectorStyle(ids, { lineHeight: raw === 'auto' ? null : raw })}
          />
          <NumberField
            label={t('Track')}
            value={ls === MIXED ? MIXED : ls ? parseFloat(ls) : 0}
            step={0.1}
            testId="type-tracking"
            title={t('Letter spacing in pixels. Type a value with em to keep it relative.')}
            onChange={(v) => inspectorStyle(ids, { letterSpacing: v ? fmtPx(v) : null })}
            onRaw={(raw) => inspectorStyle(ids, { letterSpacing: raw })}
          />
        </Row>
        <ColorField value={typeof color === 'string' ? color : ''} mixed={color === MIXED} placeholder={t('Text colour')} onChange={(c) => inspectorStyle(ids, { color: c })} testId="type-color" />
        <Row>
          <Segmented<string>
            value={align === MIXED ? MIXED : align || 'left'}
            onChange={(v) => inspectorStyle(ids, { textAlign: v === 'left' ? null : v })}
            testId="type-align"
            options={[
              { value: 'left', icon: <AlignLeft size={14} />, title: t('Left') },
              { value: 'center', icon: <AlignCenter size={14} />, title: t('Centre') },
              { value: 'right', icon: <AlignRight size={14} />, title: t('Right') },
              { value: 'justify', icon: <AlignJustify size={14} />, title: t('Justify') },
            ]}
          />
          <div className="row-tight">
            <IconButton icon={<Italic size={14} />} title={t('Italic ({shortcut})', { shortcut: 'Ctrl+I' })} active={isItalic} onClick={() => inspectorStyle(ids, { fontStyle: isItalic ? null : 'italic' })} testId="type-italic" />
            <IconButton icon={<Underline size={14} />} title={t('Underline ({shortcut})', { shortcut: 'Ctrl+U' })} active={decoration === 'underline'} onClick={() => inspectorStyle(ids, { textDecorationLine: decoration === 'underline' ? null : 'underline' })} testId="type-underline" />
            <IconButton icon={<Strikethrough size={14} />} title={t('Strikethrough ({shortcut})', { shortcut: 'Ctrl+Shift+X' })} active={decoration === 'line-through'} onClick={() => inspectorStyle(ids, { textDecorationLine: decoration === 'line-through' ? null : 'line-through' })} />
          </div>
        </Row>
        <Row>
          <Segmented<string>
            value={transform === MIXED ? MIXED : transform || 'none'}
            onChange={(v) => inspectorStyle(ids, { textTransform: v === 'none' ? null : v })}
            testId="type-case"
            options={[
              { value: 'none', icon: <Baseline size={14} />, title: t('As typed') },
              { value: 'uppercase', icon: <CaseUpper size={14} />, title: t('Uppercase') },
              { value: 'lowercase', icon: <CaseLower size={14} />, title: t('Lowercase') },
              { value: 'capitalize', icon: <CaseSensitive size={14} />, title: t('Capitalize') },
            ]}
          />
          <div className="row-tight">
            <IconButton icon={<ALargeSmall size={14} />} title={t('Text gradient: paint the fills through the text')} active={isGradient} onClick={toggleGradient} testId="type-gradient" />
          </div>
        </Row>
        <details className="details" open={isTruncated || Boolean(clamp)}>
          <summary>{t('Truncation')}</summary>
          <Row>
            <label className="check"><input type="checkbox" checked={isTruncated} onChange={toggleTruncate} data-testid="type-truncate" /> {t('One line with ellipsis')}</label>
          </Row>
          <NumberField
            label={t('Lines')}
            value={clamp === MIXED ? MIXED : clamp ? Number(clamp) : null}
            placeholder={t('All')}
            min={1}
            title={t('Clamp to this many lines')}
            onChange={(v) => inspectorStyle(ids, { display: '-webkit-box', WebkitLineClamp: String(v), WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: null, textOverflow: null })}
            onRaw={() => inspectorStyle(ids, { display: null, WebkitLineClamp: null, WebkitBoxOrient: null, overflow: null })}
          />
        </details>
        <details className="details" open={Boolean(strokeW)}>
          <summary>{t('Text stroke')}</summary>
          <Row>
            <NumberField label="W" value={strokeW === MIXED ? MIXED : strokeW ? px(strokeW) : 0} min={0} step={0.5} testId="type-stroke" onChange={(v) => inspectorStyle(ids, { WebkitTextStrokeWidth: v ? fmtPx(v) : null, ...(v && !strokeC ? { WebkitTextStrokeColor: '#111111' } : {}) })} />
          </Row>
          {strokeW ? <ColorField value={typeof strokeC === 'string' ? strokeC : ''} mixed={strokeC === MIXED} onChange={(c) => inspectorStyle(ids, { WebkitTextStrokeColor: c })} /> : null}
        </details>
        <details className="details" open={Object.keys(axes).length > 0}>
          <summary>{t('Variable axes')}</summary>
          {AXES.map((a) => (
            <div className="axis" key={a.tag}>
              <NumberField
                label={t(a.label)}
                value={axes[a.tag] !== undefined ? parseFloat(axes[a.tag]!) : null}
                placeholder={t('Default')}
                min={a.min}
                max={a.max}
                step={a.step}
                testId={`axis-${a.tag}`}
                onChange={(v) => inspectorStyle(ids, { fontVariationSettings: printAxes({ ...axes, [a.tag]: String(v) }) })}
                onRaw={() => {
                  const { [a.tag]: _drop, ...rest } = axes;
                  inspectorStyle(ids, { fontVariationSettings: Object.keys(rest).length ? printAxes(rest) : null });
                }}
              />
            </div>
          ))}
          <TextField value={first.style.fontVariationSettings ?? ''} placeholder={'"GRAD" 100, "CASL" 1'} onChange={(v) => inspectorStyle(ids, { fontVariationSettings: v || null })} title="font-variation-settings" />
        </details>
        <details className="details" open={Object.keys(features).length > 0}>
          <summary>{t('OpenType features')}</summary>
          <div className="feature-grid">
            {FEATURES.map((f) => {
              const on = features[f.tag] !== undefined && features[f.tag] !== '0' && features[f.tag] !== 'off';
              return (
                <label className="check" key={f.tag} title={f.tag}>
                  <input
                    type="checkbox"
                    checked={on}
                    data-testid={`feature-${f.tag}`}
                    onChange={() => {
                      const next = { ...features };
                      if (on) delete next[f.tag];
                      else next[f.tag] = '1';
                      inspectorStyle(ids, { fontFeatureSettings: Object.keys(next).length ? printFeatures(next) : null });
                    }}
                  /> {t(f.label)}
                </label>
              );
            })}
          </div>
          <TextField value={first.style.fontFeatureSettings ?? ''} placeholder={'"ss03" 1'} onChange={(v) => inspectorStyle(ids, { fontFeatureSettings: v || null })} title="font-feature-settings" />
        </details>
        {nodes.length === 1 ? (
          <details className="details">
            <summary>{t('Content')}</summary>
            <textarea
              className="text-area"
              dir="auto"
              rows={3}
              defaultValue={first.text ?? ''}
              key={first.text ?? ''}
              onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => { if (e.target.value !== (session().snap.nodes.get(first.id)?.text ?? '')) setFields([first.id], { text: e.target.value }); }}
            />
          </details>
        ) : null}
      </div>
    </Section>
  );
}

/** The two ends of a fluid size (px at the small and the large viewport), from a clamp() or a token holding one. */
export function fluidEnds(value: string): [number, number] | null {
  const token = /^var\(--([\w-]+)\)$/.exec(value.trim());
  const raw = token ? session().snap.tokens.find((t) => t.name === token[1])?.value ?? '' : value;
  if (!/^clamp\(/.test(raw.trim())) return null;
  const lo = clampAt(raw, FLUID_FROM);
  const hi = clampAt(raw, FLUID_TO);
  return lo !== null && hi !== null ? [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10] : null;
}

/**
 * Where a fluid size starts on a phone. Type shrinks a little and stays readable (never under 10 px); space shrinks
 * more, in proportion, so a 4 px gap becomes 2 px on a phone and never grows past what it was.
 */
export function fluidStart(fixed: number, kind: 'type' | 'space'): number {
  return kind === 'type' ? Math.min(fixed, Math.max(10, Math.round(fixed * 0.78))) : Math.max(0, Math.round(fixed * 0.5));
}

const FLUID_FROM = 360;
const FLUID_TO = 1280;

/**
 * A size that grows with the viewport, as clamp() in rem: the px it has on a 360 px phone and on a 1280 px screen. A
 * size from a token says so and is changed in the token, so every layer that uses it follows.
 */
export function FluidRow({ value, onChange, testId, kind = 'type' }: { value: string; onChange: (v: string) => void; testId: string; kind?: 'type' | 'space' }) {
  const t = useT();
  const ends = fluidEnds(value);
  const token = /^var\(--([\w-]+)\)$/.exec(value.trim())?.[1];
  const fixed = parseFloat(value) || 16;
  if (!ends) {
    return (
      <div className="fluid-row" data-testid={testId} data-fluid="off">
        <button type="button" className="run-link" title={t('Grow this size with the screen, from a phone to a desktop')} onClick={() => onChange(fluidClamp(fluidStart(fixed, kind), fixed, FLUID_FROM, FLUID_TO))} data-testid={`${testId}-on`}>{t('Make it fluid')}</button>
      </div>
    );
  }
  if (token) return <div className="fluid-row hint" data-testid={testId} data-fluid="token">{t('Fluid {from} → {to} px from {token}. Change it in Tokens.', { from: ends[0], to: ends[1], token: `--${token}` })}</div>;
  return (
    <div className="fluid-row" data-testid={testId} data-fluid="on" title={value}>
      <span className="hint">{t('Fluid')}</span>
      <NumberField label="360" value={ends[0]} min={1} testId={`${testId}-min`} title={t('Size on a 360 px wide phone')} onChange={(v) => onChange(fluidClamp(v, ends[1], FLUID_FROM, FLUID_TO))} />
      <NumberField label="1280" value={ends[1]} min={1} testId={`${testId}-max`} title={t('Size on a 1280 px wide screen')} onChange={(v) => onChange(fluidClamp(ends[0], v, FLUID_FROM, FLUID_TO))} />
      <button type="button" className="run-link" onClick={() => onChange(`${ends[1]}px`)} data-testid={`${testId}-off`}>{t('Fixed')}</button>
    </div>
  );
}

/** How many characters fit on a line: the layer's width over the average width of a letter in its own font. */
export function charsPerLine(width: number, avgChar: number): number {
  return avgChar > 0 ? Math.round(width / avgChar) : 0;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * The measure of running text, as a designer reads it: characters per line at the width it has on the canvas. Around
 * 45–75 reads best; much more and the eye loses the next line, much less and the text breaks into fragments.
 */
function MeasureNote({ node }: { node: BogenNode }) {
  const t = useT();
  const [chars, setChars] = useState(0);
  // Measured after the canvas has laid the change out, not during this render.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = elOf(node.id);
      const width = rectOf(node.id)?.w ?? 0;
      measureCtx ??= document.createElement('canvas').getContext('2d');
      if (!el || !measureCtx || !width) return setChars(0);
      const cs = getComputedStyle(el);
      measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const sample = 'the quick brown fox jumps over a lazy dog and then keeps on reading';
      setChars(charsPerLine(width, measureCtx.measureText(sample).width / sample.length));
    });
    return () => cancelAnimationFrame(frame);
  }, [node.id, node.style, node.text]);
  if (!chars) return null;
  const level = chars > 85 ? 'long' : chars < 35 ? 'short' : 'ok';
  return (
    <div className={`measure-row hint is-${level}`} data-testid="type-measure" data-chars={chars} data-level={level}>
      <span>{level === 'long' ? t.n(chars, 'About {count} character per line: long lines lose the reader.', 'About {count} characters per line: long lines lose the reader.') : level === 'short' ? t.n(chars, 'About {count} character per line: short lines break the text up.', 'About {count} characters per line: short lines break the text up.') : t.n(chars, 'About {count} character per line.', 'About {count} characters per line.')}</span>
      {level === 'long' ? <button type="button" className="run-link" onClick={() => inspectorStyle([node.id], { maxWidth: '65ch' })} data-testid="type-measure-fix">{t('Limit to {width}', { width: '65ch' })}</button> : null}
    </div>
  );
}
