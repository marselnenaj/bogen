import { useEffect, useMemo, useRef, useState } from 'react';
import { readBrand, type BogenNode } from '@bogen/core';
import { elOf } from '../canvas/measure.ts';
import { useFrameVersion, useNode, useSelectedNodes, useTextStyles, useTokens } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { openSheet } from './board-view.ts';
import {
  applyPhoneEdit, colorSwatches, currentFill, isCurrentSwatch, sizeUnit, spacingLabel, spacingScale, stepSize, stepSpacing, typeDetail, typeOptions, type PhoneEdit,
} from './edit-ops.ts';
import { phoneFile, usePhoneFile, type EditTab } from './file-state.ts';
import { Sheet } from './Sheet.tsx';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

const TABS: { id: EditTab; label: string }[] = [
  { id: 'text', label: msg('Text') },
  { id: 'fill', label: msg('Fill') },
  { id: 'layout', label: msg('Layout') },
  { id: 'type', label: msg('Type') },
];

function useBrand() {
  const { doc } = session();
  const tokens = useTokens();
  // The brand of a brand file lives in the file; a linked brand has put its tokens and text styles here.
  return useMemo(() => readBrand(doc), [doc, tokens]);
}

/** The text layers a frame holds, breadth first, so that the headline comes before the footnote. */
function textLayersIn(id: string, limit = 8): BogenNode[] {
  const { snap } = session();
  const out: BogenNode[] = [];
  const queue = [...snap.children(id)];
  for (let i = 0; i < queue.length && out.length < limit && i < 400; i++) {
    const n = snap.nodes.get(queue[i]!);
    if (!n) continue;
    if (n.type === 'text') out.push(n);
    else queue.push(...snap.children(n.id));
  }
  return out;
}

/** The text of one layer, as a plain field. One focus, one undo step, however much is typed. */
function TextField({ id, label }: { id: string; label: string }) {
  const node = useNode(id);
  const s = session();
  const text = node?.text ?? '';
  const [value, setValue] = useState(text);
  const focused = useRef(false);
  const base = useRef(text);
  useEffect(() => {
    if (!focused.current) setValue(text);
  }, [text]);
  useEffect(() => () => {
    if (focused.current) s.endGesture();
  }, [s]);
  return (
    <label className="pf-field">
      <span className="pf-label" dir="auto">{label}</span>
      <textarea
        className="pf-input" value={value} rows={Math.min(4, Math.max(1, Math.ceil(value.length / 30)))} data-testid="pf-text-input" data-layer-id={id}
        onFocus={() => {
          focused.current = true;
          base.current = session().snap.nodes.get(id)?.text ?? '';
          s.beginGesture();
        }}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (!s.snap.nodes.has(id)) return;
          base.current = s.tx(() => s.doc.editText(id, base.current, next));
        }}
        onBlur={() => {
          focused.current = false;
          s.endGesture();
        }}
      />
    </label>
  );
}

function Swatches({ nodes, kind, none }: { nodes: BogenNode[]; kind: 'fill' | 'color'; none?: boolean }) {
  const t = useT();
  const tokens = useTokens();
  const brand = useBrand();
  const swatches = useMemo(() => colorSwatches(tokens, brand), [tokens, brand]);
  const first = nodes[0]!;
  const current = kind === 'color' ? first.style.color : currentFill(first);
  const ids = nodes.map((n) => n.id);
  if (!swatches.length) return <p className="pf-dim">{t('This file has no colour tokens yet. Add them on the computer, or link a brand.')}</p>;
  const apply = (css: string | null) => applyPhoneEdit(ids, kind === 'color' ? { kind: 'color', css: css ?? '' } : { kind: 'fill', css });
  return (
    <div className="pf-swatches" role="group">
      {none ? <button type="button" className={`pf-swatch is-none${current ? '' : ' is-on'}`} aria-label={t('No fill')} aria-pressed={!current} onClick={() => apply(null)} data-testid="pf-swatch" data-swatch="none" /> : null}
      {swatches.map((sw) => {
        const on = isCurrentSwatch(sw, current, tokens);
        return <button key={sw.key} type="button" className={`pf-swatch${on ? ' is-on' : ''}`} style={{ background: sw.color }} aria-label={sw.label} aria-pressed={on} title={sw.label} onClick={() => apply(sw.css)} data-testid="pf-swatch" data-swatch={sw.key} />;
      })}
    </div>
  );
}

function TextTab({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const node = nodes[0]!;
  const styles = useTextStyles();
  const tokens = useTokens();
  const brand = useBrand();
  useFrameVersion();
  const texts = node.type === 'text' ? [node] : textLayersIn(node.id);
  const style = styles.find((st) => st.key === node.textStyle);
  const option = style ? typeOptions([style], brand, tokens)[0] : undefined;
  const cs = elOf(node.id) ? getComputedStyle(elOf(node.id)!) : null;
  const detail = option ? typeDetail(option) : cs ? `${Math.round(parseFloat(cs.fontSize))} · ${cs.fontWeight}` : '';
  return (
    <>
      {texts.length ? texts.map((n) => <TextField key={n.id} id={n.id} label={n.name} />) : <p className="pf-dim" dir="auto">{t('There is no text in {name}.', { name: node.name })}</p>}
      <div className="pf-field">
        <span className="pf-label">{t('Text style')}</span>
        <button type="button" className="pf-pick" onClick={() => phoneFile().set({ editTab: 'type' })} data-testid="pf-text-style">
          <b>{style?.name ?? t('None')}</b><span>{detail} ›</span>
        </button>
      </div>
      <div className="pf-field">
        <span className="pf-label">{t('Colour, from the brand')}</span>
        <Swatches nodes={nodes} kind="color" />
      </div>
    </>
  );
}

function FillTab({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const text = nodes[0]!.type === 'text';
  return (
    <div className="pf-field">
      <span className="pf-label">{text ? t('Text colour, from the brand') : t('Fill, from the brand')}</span>
      <Swatches nodes={nodes} kind="fill" none={!text} />
    </div>
  );
}

function Stepper({ label, value, onStep, disabled, testId }: { label: string; value: string; onStep: (dir: 1 | -1) => void; disabled?: boolean | undefined; testId: string }) {
  const t = useT();
  return (
    <div className={`pf-stepper${disabled ? ' is-off' : ''}`} data-testid={testId}>
      <span className="pf-stepper-label">{label}</span>
      <button type="button" className="pf-sq" disabled={disabled} onClick={() => onStep(-1)} aria-label={t('{label} smaller', { label })} data-testid={`${testId}-down`}>−</button>
      <span className="pf-stepper-value" data-testid={`${testId}-value`}>{value}</span>
      <button type="button" className="pf-sq" disabled={disabled} onClick={() => onStep(1)} aria-label={t('{label} larger', { label })} data-testid={`${testId}-up`}>+</button>
    </div>
  );
}

function LayoutTab({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const tokens = useTokens();
  useFrameVersion();
  const node = nodes[0]!;
  const ids = nodes.map((n) => n.id);
  const el = elOf(node.id);
  const cs = el ? getComputedStyle(el) : null;
  const scale = useMemo(() => spacingScale(tokens), [tokens]);
  const unit = useMemo(() => sizeUnit(tokens), [tokens]);
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  const pad = { css: node.style.padding, px: cs ? parseFloat(cs.paddingTop) || 0 : 0 };
  const flex = cs ? /flex|grid/.test(cs.display) : false;
  const gap = { css: node.style.gap, px: cs ? parseFloat(cs.rowGap) || parseFloat(cs.columnGap) || 0 : 0 };
  const edit = (e: PhoneEdit | null) => { if (e) applyPhoneEdit(ids, e); };
  const space = (kind: 'padding' | 'gap', current: { css?: string | undefined; px: number }, dir: 1 | -1) => {
    const next = stepSpacing(scale, current, dir);
    edit(next ? { kind, css: next.css } : null);
  };
  return (
    <>
      <Stepper label={t('Width')} value={`${Math.round(w)}`} disabled={!el} onStep={(dir) => edit({ kind: 'size', axis: 'width', px: stepSize(w, dir, unit) })} testId="pf-width" />
      <Stepper label={t('Height')} value={`${Math.round(h)}`} disabled={!el} onStep={(dir) => edit({ kind: 'size', axis: 'height', px: stepSize(h, dir, unit) })} testId="pf-height" />
      <Stepper label={t('Padding')} value={spacingLabel(scale, pad)} disabled={!el} onStep={(dir) => space('padding', pad, dir)} testId="pf-padding" />
      <Stepper label={t('Gap')} value={flex ? spacingLabel(scale, gap) : t('No auto layout')} disabled={!flex} onStep={(dir) => space('gap', gap, dir)} testId="pf-gap" />
      <p className="pf-dim">{t('Steps of {unit} px for the size, and the spacing tokens for padding and gap.', { unit })}</p>
    </>
  );
}

function TypeTab({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const styles = useTextStyles();
  const tokens = useTokens();
  const brand = useBrand();
  const options = useMemo(() => typeOptions(styles, brand, tokens), [styles, brand, tokens]);
  const current = nodes[0]!.textStyle;
  const ids = nodes.map((n) => n.id);
  if (!options.length) return <p className="pf-dim">{t('This file has no text styles or type scale yet. Make them on the computer, or link a brand.')}</p>;
  return (
    <div className="pf-type-list" role="list">
      {options.map((o) => {
        const on = Boolean(o.textStyle) && o.textStyle === current;
        return (
          <button key={o.key} type="button" role="listitem" className={`pf-type${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => applyPhoneEdit(ids, { kind: 'type', option: o })} data-testid="pf-type" data-type-key={o.key}>
            <b>{o.label}</b><span>{typeDetail(o)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** D3: change the selection with what the file's design system offers. Done closes it. */
export function EditSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const nodes = useSelectedNodes();
  const tab = usePhoneFile((s) => s.editTab);
  if (!nodes.length) {
    return (
      <Sheet title={t('Edit')} onClose={onClose} testId="pf-edit">
        <p className="pf-dim">{t('Tap a layer on the canvas, or pick one in Layers.')}</p>
        <button type="button" className="pf-wide" onClick={() => openSheet('layers')}>{t('Layers')}</button>
      </Sheet>
    );
  }
  const tabs = (
    <div className="pf-tabs" role="tablist">
      {TABS.map((tb) => <button key={tb.id} type="button" role="tab" aria-selected={tab === tb.id} className={`pf-tab${tab === tb.id ? ' is-on' : ''}`} onClick={() => phoneFile().set({ editTab: tb.id })} data-testid={`pf-edit-${tb.id}`}>{t(tb.label)}</button>)}
    </div>
  );
  return (
    <Sheet head={tabs} onClose={onClose} testId="pf-edit">
      <div className="pf-edit-body" key={`${tab}-${nodes[0]!.id}`}>
        {tab === 'text' ? <TextTab nodes={nodes} /> : tab === 'fill' ? <FillTab nodes={nodes} /> : tab === 'layout' ? <LayoutTab nodes={nodes} /> : <TypeTab nodes={nodes} />}
      </div>
    </Sheet>
  );
}
