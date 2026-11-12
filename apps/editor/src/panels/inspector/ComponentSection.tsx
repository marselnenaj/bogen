import { useState, type ReactNode } from 'react';
import { enclosingMain, instanceControls, instancesOf, listOverrides, resetAllOverrides, resetOverride, setInstanceProps, setPageMode, setSlot, slotsOf, updateComponent, variantAxes, type BogenNode, type ComponentProp, type OverrideEntry, type PropTarget } from '@bogen/core';
import { Component, CornerUpLeft, Plus, RotateCcw, Trash2, Unlink } from 'lucide-react';
import { session } from '../../doc/session.ts';
import { addVariantOf, detachSelection, goToMain } from '../../ops/components.ts';
import { setFields } from '../../ops/ops.ts';
import { editor } from '../../state/store.ts';
import { IconButton, Row, Section, Segmented, SelectField, TextField, common, MIXED } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';
import { t } from '../../i18n/store.ts';

/** A name a prop can have, from what a person typed. */
function propName(text: string): string {
  return text.trim().replace(/[^\w-]+/g, '-').replace(/^[^a-zA-Z_]+/, '');
}

function fieldLabel(field: string): string {
  if (field.startsWith('style.')) return field.slice(6).replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
  if (field.startsWith('attr.')) return field.slice(5);
  if (field.startsWith('prop.')) return field.slice(5);
  return field === 'src' ? t('source') : field === 'slot' ? t('slot content') : field;
}

function run(fn: () => void): void {
  try {
    const s = session();
    s.tx(fn);
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

function OverrideList({ id }: { id: string }) {
  const t = useT();
  const s = session();
  const entries = listOverrides(s.snap.source, id);
  if (!entries.length) return <div className="hint" data-testid="overrides-empty">{t('Same as its main.')}</div>;
  return (
    <div className="ds-list" data-testid="overrides">
      {entries.map((o: OverrideEntry) => (
        <div key={o.key} className="ds-row" data-testid="override-row" data-field={o.field} title={`${o.layerName}: ${o.value}`}>
          <span className="ds-row-name">{fieldLabel(o.field)}</span>
          <span className="ds-row-note" dir="auto">{o.layer === id ? o.value : o.layerName}</span>
          <IconButton icon={<RotateCcw size={12} />} title={t('Reset {field}', { field: fieldLabel(o.field) })} testId="override-reset" onClick={() => run(() => resetOverride(s.doc, id, o.key))} tabIndex={-1} />
        </div>
      ))}
    </div>
  );
}

function InstanceControls({ node }: { node: BogenNode }) {
  const t = useT();
  const s = session();
  const controls = instanceControls(s.snap.source, node.id);
  const set = (name: string, value: string | boolean | null) => run(() => setInstanceProps(s.doc, node.id, { [name]: value }));
  if (!controls.length) return null;
  return (
    <div className="ds-controls">
      {controls.map((c) => {
        if (c.type === 'variant' && c.options?.length) {
          return <SelectField key={c.name} label={<span className="ds-prop-label">{c.name}</span>} value={String(c.value)} options={c.options.map((o) => ({ value: o, label: o }))} onChange={(v) => set(c.name, v)} testId={`instance-prop-${c.name}`} />;
        }
        if (c.type === 'boolean') {
          return (
            <label key={c.name} className="ds-toggle" title={c.isSet ? t('Set on this instance') : t('As in the main')}>
              <span className={`ds-prop-label${c.isSet ? ' is-set' : ''}`}>{c.name}</span>
              <input type="checkbox" checked={Boolean(c.value)} data-testid={`instance-prop-${c.name}`} onChange={(e) => set(c.name, e.target.checked)} />
            </label>
          );
        }
        return (
          <div key={c.name} className="ds-control">
            <TextField className={c.isSet ? 'is-set' : ''} label={<span className="ds-prop-label">{c.name}</span>} value={String(c.value)} onChange={(v) => set(c.name, v)} testId={`instance-prop-${c.name}`} />
            {c.isSet ? <IconButton icon={<RotateCcw size={12} />} title={t('Reset {field}', { field: c.name })} onClick={() => set(c.name, null)} tabIndex={-1} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function InstanceSection({ node }: { node: BogenNode }) {
  const t = useT();
  const s = session();
  const stored = s.snap.nodes.stored(node.virtual?.owner ?? node.id);
  const root = !node.virtual || node.virtual.path === '';
  const main = node.instanceOf ? s.snap.nodes.stored(node.instanceOf) : undefined;
  const slots = main ? slotsOf(s.snap.source, main.id) : [];
  return (
    <Section title={main ? t('Instance of {name}', { name: main.name }) : t('Instance')} actions={(
      <>
        <IconButton icon={<CornerUpLeft size={13} />} title={t('Go to main component')} testId="instance-go-main" onClick={() => goToMain(node.id)} disabled={!main} tabIndex={-1} />
        {root ? <IconButton icon={<Unlink size={13} />} title={t('Detach instance')} testId="instance-detach" onClick={detachSelection} tabIndex={-1} /> : null}
      </>
    )}>
      {main ? null : <div className="hint">{t('Its main is gone. Detach it to keep it as layers, or undo the delete.')}</div>}
      <InstanceControls node={node} />
      {slots.length ? <div className="hint">{t('Slots: {slots}. Drop layers on them, or paste with one selected.', { slots: slots.map((sl) => sl.name).join(', ') })}</div> : null}
      <div className="ds-sub">
        <span className="ds-sub-title">{t('Overrides')}</span>
        {root && stored ? <button type="button" className="ds-link" data-testid="overrides-reset-all" onClick={() => run(() => resetAllOverrides(s.doc, node.id))}>{t('Reset all')}</button> : null}
      </div>
      <OverrideList id={node.id} />
    </Section>
  );
}

function InsideInstanceSection({ node }: { node: BogenNode }) {
  const t = useT();
  const s = session();
  const owner = s.snap.nodes.get(node.virtual!.owner);
  return (
    <Section title={owner ? t('Inside {name}', { name: owner.name }) : t('Inside an instance')} actions={<IconButton icon={<CornerUpLeft size={13} />} title={t('Go to this layer in the main')} testId="instance-go-main" onClick={() => goToMain(node.id)} tabIndex={-1} />}>
      <div className="hint">{t('Changes here are overrides on this instance only.')}</div>
      <OverrideList id={node.id} />
    </Section>
  );
}

/** A prop that drives this layer. */
function exposes(main: BogenNode, path: string, field: string): ComponentProp | undefined {
  return main.component?.props?.find((p) => p.targets?.some((t: PropTarget) => t.path === path && t.field === field));
}

function ExposeRow({ main, layer, label, field, type }: { main: BogenNode; layer: BogenNode; label: string; field: string; type: ComponentProp['type'] }) {
  const t = useT();
  const s = session();
  const path = layer.id === main.id ? '' : layer.id;
  const prop = exposes(main, path, field);
  const props = main.component?.props ?? [];
  const add = () => run(() => {
    const base = propName(layer.name) || 'prop';
    let name = field === 'visible' ? `show-${base}` : base;
    for (let i = 2; props.some((p) => p.name === name); i++) name = `${field === 'visible' ? `show-${base}` : base}-${i}`;
    updateComponent(s.doc, main.id, { props: [...props, { name, type, targets: [{ path, field }] }] });
  });
  const remove = () => run(() => updateComponent(s.doc, main.id, { props: props.filter((p) => p !== prop) }));
  return (
    <div className="ds-row" data-testid={`expose-${field}`}>
      <span className="ds-row-name">{label}</span>
      {prop ? <span className="ds-row-note">{t('prop {name}', { name: prop.name })}</span> : null}
      {prop
        ? <IconButton icon={<Trash2 size={12} />} title={t('Stop exposing as {name}', { name: prop.name })} testId={`expose-${field}-remove`} onClick={remove} tabIndex={-1} />
        : <IconButton icon={<Plus size={13} />} title={field === 'text' ? t('Expose text as a prop') : field === 'src' ? t('Expose image as a prop') : field === 'visible' ? t('Expose visible as a prop') : t('Expose {field} as a prop', { field: label.toLowerCase() })} testId={`expose-${field}-add`} onClick={add} tabIndex={-1} />}
    </div>
  );
}

function InMainSection({ node, mainId }: { node: BogenNode; mainId: string }) {
  const t = useT();
  const s = session();
  const main = s.snap.nodes.stored(mainId)!;
  return (
    <Section title={t('In {name}', { name: main.name })} actions={<Component size={13} className="ds-mark" />}>
      {node.type === 'text' ? <ExposeRow main={main} layer={node} label={t('Text')} field="text" type="text" /> : null}
      {node.type === 'image' ? <ExposeRow main={main} layer={node} label={t('Image')} field="src" type="image" /> : null}
      <ExposeRow main={main} layer={node} label={t('Visible')} field="visible" type="boolean" />
      {node.type === 'frame' && node.instanceOf === undefined ? (
        <div className="ds-row">
          <span className="ds-row-name">{t('Slot')}</span>
          {node.slotName !== undefined ? <TextField className="ds-slot-name" value={node.slotName} testId="slot-name" onChange={(v) => run(() => setSlot(s.doc, node.id, propName(v) || 'content'))} /> : null}
          {node.slotName !== undefined
            ? <IconButton icon={<Trash2 size={12} />} title={t('Stop being a slot')} testId="slot-remove" onClick={() => run(() => setSlot(s.doc, node.id, null))} tabIndex={-1} />
            : <IconButton icon={<Plus size={13} />} title={t('Let instances fill this frame')} testId="slot-add" onClick={() => run(() => setSlot(s.doc, node.id, propName(node.name) || 'content'))} tabIndex={-1} />}
        </div>
      ) : null}
    </Section>
  );
}

function AddVariant({ main }: { main: BogenNode }) {
  const t = useT();
  const s = session();
  const axes = variantAxes(s.snap.source, main.component?.set);
  const [axis, setAxis] = useState('');
  const [value, setValue] = useState('');
  const useAxis = axes[0]?.axis ?? 'variant';
  const add = () => {
    const a = (axis.trim() || useAxis).replace(/\s+/g, '-');
    const v = value.trim();
    if (!a || !v) return;
    try {
      addVariantOf(main.id, a, v, axes.length ? undefined : 'default');
      setValue('');
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  return (
    <Row>
      <input className="token-input" placeholder={useAxis} value={axis} data-testid="variant-axis" onChange={(e) => setAxis(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} />
      <input className="token-input" placeholder={t('Value')} value={value} data-testid="variant-value" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} spellCheck={false} />
      <IconButton icon={<Plus size={14} />} title={t('Add a variant: a copy of this main')} onClick={add} disabled={!value.trim()} testId="variant-add" />
    </Row>
  );
}

function MainSection({ node }: { node: BogenNode }) {
  const t = useT();
  const s = session();
  const def = node.component!;
  const count = instancesOf(s.doc, node.id).length;
  const remove = (prop: ComponentProp) => run(() => updateComponent(s.doc, node.id, { props: (def.props ?? []).filter((p) => p !== prop) }));
  const axes = variantAxes(s.snap.source, def.set);
  const slots = slotsOf(s.snap.source, node.id);
  return (
    <Section title={t('Component')} actions={<span className="ds-count" data-testid="main-instance-count">{t.n(count, '{count} instance', '{count} instances')}</span>}>
      <TextField label={<span className="ds-prop-label">{t('Set')}</span>} value={def.set ?? ''} placeholder={t('None')} testId="main-set" onChange={(v) => run(() => updateComponent(s.doc, node.id, { set: v.trim() }))} title={t('Mains in one set are variants of one component.')} />
      {axes.map((a) => (
        <TextField key={a.axis} label={<span className="ds-prop-label">{a.axis}</span>} value={def.variant?.[a.axis] ?? ''} testId={`main-variant-${a.axis}`} onChange={(v) => run(() => updateComponent(s.doc, node.id, { variant: { ...(def.variant ?? {}), [a.axis]: v.trim() } }))} />
      ))}
      <div className="ds-sub"><span className="ds-sub-title">{t('Props')}</span></div>
      {def.props?.length ? (
        <div className="ds-list" data-testid="main-props">
          {def.props.map((p) => (
            <div key={p.name} className="ds-row" data-testid="main-prop">
              <span className="ds-row-name">{p.name}</span>
              <span className="ds-row-note">{p.type}</span>
              <IconButton icon={<Trash2 size={12} />} title={t('Remove {name}', { name: p.name })} onClick={() => remove(p)} tabIndex={-1} />
            </div>
          ))}
        </div>
      ) : <div className="hint">{t('Select a layer inside to expose its text or visibility.')}</div>}
      {slots.length ? <div className="hint">{t('Slots: {slots}', { slots: slots.map((sl) => sl.name).join(', ') })}</div> : null}
      <div className="ds-sub"><span className="ds-sub-title">{t('Add variant')}</span></div>
      <AddVariant main={node} />
    </Section>
  );
}

/** What this selection is to the design system. Nothing at all for an ordinary layer. */
export function ComponentSection({ nodes }: { nodes: BogenNode[] }) {
  const s = session();
  const { snap } = s;
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  const out: ReactNode[] = [];
  if (node.instanceOf !== undefined) out.push(<InstanceSection key="instance" node={node} />);
  else if (node.virtual) out.push(<InsideInstanceSection key="inside" node={node} />);
  const stored = snap.nodes.stored(node.id);
  if (stored?.component) out.push(<MainSection key="main" node={stored} />);
  if (stored && !stored.component) {
    const main = enclosingMain(s.doc, node.id);
    if (main) out.push(<InMainSection key="in-main" node={stored} mainId={main} />);
  }
  return out.length ? <>{out}</> : null;
}

const INHERIT = '__inherit';

/** Which theme mode a layer or the page shows. Only where the file has modes. */
export function ModeSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const s = session();
  const { snap } = s;
  if (!snap.modes.length) return null;
  const value = common(nodes.map((n) => n.mode ?? INHERIT));
  return (
    <Section title={t('Theme mode')}>
      <Segmented<string>
        value={value === MIXED ? MIXED : value}
        testId="insp-mode"
        onChange={(mode) => setFields(nodes.map((n) => n.id), { mode: mode === INHERIT ? undefined : mode })}
        options={[{ value: INHERIT, label: t('Inherit'), title: t('What its parent or page shows') }, ...snap.modes.map((m) => ({ value: m.name, label: m.name, title: t('Show {mode} token values', { mode: m.name }) }))]}
      />
    </Section>
  );
}

export function PageModeSection({ pageId }: { pageId: string }) {
  const t = useT();
  const s = session();
  const { snap } = s;
  if (!snap.modes.length) return null;
  const page = snap.pages.find((p) => p.id === pageId);
  return (
    <Section title={t('Page theme mode')}>
      <Segmented<string>
        value={page?.mode ?? INHERIT}
        testId="page-mode"
        onChange={(mode) => s.tx(() => setPageMode(s.doc, pageId, mode === INHERIT ? null : mode))}
        options={[{ value: INHERIT, label: snap.modes.find((m) => m.base)?.name ?? t('Base'), title: t('The plain token values') }, ...snap.modes.filter((m) => !m.base).map((m) => ({ value: m.name, label: m.name, title: t('Show {mode} token values', { mode: m.name }) }))]}
      />
    </Section>
  );
}
