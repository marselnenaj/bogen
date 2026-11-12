import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  deleteVariable, getVariables, readProtoState, setVariable, variantAxes,
  type BogenNode, type ConditionOp, type FileVariable, type LayerProto, type ProtoAction, type ProtoActionType, type ProtoCondition, type ProtoInteraction, type ProtoTransition, type ProtoTrigger, type VariableType, type VariableValue,
} from '@bogen/core';
import { useSnapVersion } from '../../doc/hooks.ts';
import { session } from '../../doc/session.ts';
import { TRANSITIONS } from '../../preview/preview-model.ts';
import { editor } from '../../state/store.ts';
import { IconButton, NumberField, Section, SelectField, TextField } from '../../ui/controls.tsx';
import { msg } from '../../i18n/core.ts';
import { useT } from '../../i18n/react.ts';

/**
 * The state of a prototype: the file's variables, what a layer does on click, hover and submit, and
 * what of a layer follows a variable. Preview mode and the prototype export run it.
 */

export function useVariables(): FileVariable[] {
  const doc = session().doc;
  const [vars, setVars] = useState(() => getVariables(doc));
  useEffect(() => {
    const update = () => setVars(getVariables(doc));
    doc.variables.observeDeep(update);
    update();
    return () => doc.variables.unobserveDeep(update);
  }, [doc]);
  return vars;
}

const GLYPH: Record<VariableType, string> = { boolean: 'B', number: '#', text: 'T' };
const FIRST_NAME: Record<VariableType, string> = { boolean: 'isOpen', number: 'count', text: 'text' };

function tryWrite(fn: () => void): void {
  try {
    session().tx(fn);
  } catch (e) {
    editor().showToast((e as Error).message);
  }
}

/** Which variables a layer uses, from what it stores. */
function variablesOf(proto: LayerProto | undefined): string[] {
  const s = readProtoState(proto);
  const out = new Set<string>();
  for (const i of s.interactions ?? []) for (const a of i.actions) if ('variable' in a) out.add(a.variable);
  if (s.showWhen) out.add(s.showWhen.variable);
  if (s.variantFrom) out.add(s.variantFrom.variable);
  if (s.bind) out.add(s.bind);
  if (s.textFrom) out.add(s.textFrom);
  return [...out];
}

function ValueField({ type, value, onChange, testId, label }: { type: VariableType; value: VariableValue | undefined; onChange: (v: VariableValue) => void; testId?: string; label?: ReactNode }) {
  const t = useT();
  if (type === 'boolean') return <SelectField<string> label={label} value={String(Boolean(value))} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} onChange={(v) => onChange(v === 'true')} testId={testId} />;
  if (type === 'number') return <NumberField label={label} value={typeof value === 'number' ? value : Number(value) || 0} onChange={onChange} testId={testId} />;
  return <TextField label={label} value={String(value ?? '')} placeholder={t('empty')} onChange={onChange} testId={testId} />;
}

/** The file's variables, with the value preview starts from. Shown when nothing is selected. */
export function VariablesSection() {
  const t = useT();
  const vars = useVariables();
  const version = useSnapVersion();
  const { snap } = session();
  const users = useMemo(() => {
    const out = new Map<string, number>();
    for (const n of snap.nodes.values()) for (const name of variablesOf(n.proto)) out.set(name, (out.get(name) ?? 0) + 1);
    return out;
  }, [snap, version]);
  const add = (type: VariableType) => {
    let name = FIRST_NAME[type];
    for (let i = 2; vars.some((v) => v.name === name); i++) name = `${FIRST_NAME[type]}${i}`;
    tryWrite(() => setVariable(session().doc, { name, type }));
  };
  return (
    <Section title={t('Variables')} note={vars.length ? String(vars.length) : undefined}>
      <div className="hint">{t('Prototype state. Preview and a prototype export start from these values.')}</div>
      {vars.map((v) => {
        const n = users.get(v.name) ?? 0;
        return (
          <div key={v.name} className="var-item" data-testid={`variable-${v.name}`}>
            <div className="var-row">
              <span className="var-type" title={v.type}>{GLYPH[v.type]}</span>
              <TextField className="list-row-grow" value={v.name} title={t('Name')} testId={`variable-name-${v.name}`} onChange={(name) => tryWrite(() => setVariable(session().doc, { name: v.name, rename: name }))} />
              <div className="var-value"><ValueField type={v.type} value={v.value} testId={`variable-value-${v.name}`} onChange={(value) => tryWrite(() => setVariable(session().doc, { name: v.name, value }))} /></div>
              <IconButton icon={<Minus size={13} />} title={t('Delete {name}', { name: v.name })} testId={`variable-delete-${v.name}`} onClick={() => tryWrite(() => deleteVariable(session().doc, v.name))} />
            </div>
            <div className="var-use">{n ? t.n(n, '{count} layer uses it', '{count} layers use it') : t('No layer uses it yet')}</div>
          </div>
        );
      })}
      <div className="param-label">{t('New variable')}</div>
      <div className="var-new">
        {(['boolean', 'number', 'text'] as const).map((type) => <button key={type} type="button" className="btn" onClick={() => add(type)} data-testid={`variable-add-${type}`}>{type === 'boolean' ? t('Boolean') : type === 'number' ? t('Number') : t('Text')}</button>)}
      </div>
    </Section>
  );
}

// What a layer does

const TRIGGERS: { value: ProtoTrigger; label: string }[] = [{ value: 'click', label: msg('Click') }, { value: 'hover', label: msg('Hover') }, { value: 'submit', label: msg('Submit') }];
const ACTION_LABELS: Record<ProtoActionType, string> = {
  set: msg('Set variable'), toggle: msg('Toggle variable'), increment: msg('Add to number'), show: msg('Show layer'), hide: msg('Hide layer'), 'toggle-visibility': msg('Show or hide layer'), 'set-variant': msg('Set variant'), navigate: msg('Go to artboard'), back: msg('Go back'),
};
const OPS: { value: ConditionOp; label: string; needs: boolean }[] = [
  { value: 'is', label: msg('is'), needs: true }, { value: 'not', label: msg('is not'), needs: true }, { value: 'gt', label: msg('above'), needs: true }, { value: 'lt', label: msg('below'), needs: true },
  { value: 'gte', label: msg('at least'), needs: true }, { value: 'lte', label: msg('at most'), needs: true }, { value: 'contains', label: msg('contains'), needs: true }, { value: 'empty', label: msg('is empty'), needs: false }, { value: 'filled', label: msg('is filled'), needs: false },
];

interface Choices {
  vars: FileVariable[];
  boards: { value: string; label: string }[];
  layers: { value: string; label: string }[];
  /** Instances in the artboard that can change variant, with their axes. */
  instances: { value: string; label: string; axes: { axis: string; values: string[] }[] }[];
}

/** What an action can name: the file's variables, its artboards, and the layers of this artboard. */
function useChoices(node: BogenNode, vars: FileVariable[]): Choices {
  const { snap } = session();
  const version = useSnapVersion();
  return useMemo(() => {
    const boards = snap.pages.flatMap((p) => snap.children(p.id).flatMap((id) => {
      const n = snap.nodes.get(id);
      return n?.artboard ? [{ value: id, label: `${n.name}${snap.pages.length > 1 ? ` (${p.name})` : ''}` }] : [];
    }));
    const root = snap.ancestors(node.id).at(-1) ?? node.id;
    const layers: Choices['layers'] = [];
    const instances: Choices['instances'] = [];
    const visit = (id: string, depth: number) => {
      if (layers.length >= 400) return;
      const n = snap.nodes.get(id);
      if (!n) return;
      // Inside an instance a layer does what its main says, so only stored layers are offered.
      if (!id.includes('/')) layers.push({ value: id, label: `${'  '.repeat(Math.min(depth, 6))}${n.name}` });
      const main = n.instanceOf !== undefined ? snap.nodes.get(n.instanceOf) : undefined;
      const axes = main?.component?.set ? variantAxes(snap.source, main.component.set).filter((a) => a.values.length > 1) : [];
      if (axes.length && !id.includes('/')) instances.push({ value: id, label: n.name, axes });
      if (n.instanceOf === undefined) for (const k of snap.children(id)) visit(k, depth + 1);
    };
    visit(root, 0);
    return { vars, boards, layers, instances };
  }, [snap, version, node.id, vars]);
}

/** A new action of a type, filled in with the first thing it can name, so that it is valid at once. */
function newAction(type: ProtoActionType, c: Choices, self: string): ProtoAction {
  const v = c.vars[0];
  const num = c.vars.find((x) => x.type === 'number');
  const bool = c.vars.find((x) => x.type === 'boolean');
  switch (type) {
    case 'set': return { type, variable: v?.name ?? '', value: v ? v.value : '' };
    case 'toggle': return { type, variable: (bool ?? v)?.name ?? '' };
    case 'increment': return { type, variable: (num ?? v)?.name ?? '' };
    case 'show': case 'hide': case 'toggle-visibility': return { type, target: c.layers.find((l) => l.value !== self)?.value ?? self };
    case 'set-variant': {
      const inst = c.instances[0];
      return { type, target: inst?.value ?? '', value: inst?.axes[0]?.values[1] ?? '' };
    }
    case 'navigate': return { type, to: c.boards.find((b) => b.value !== self)?.value ?? '', transition: 'fade' };
    case 'back': return { type };
  }
}

function ActionEditor({ action, choices, self, onChange, onRemove, testId }: { action: ProtoAction; choices: Choices; self: string; onChange: (a: ProtoAction) => void; onRemove: () => void; testId: string }) {
  const t = useT();
  const varOptions = choices.vars.map((v) => ({ value: v.name, label: v.name }));
  const types = (Object.keys(ACTION_LABELS) as ProtoActionType[]).map((type) => ({
    value: type, label: t(ACTION_LABELS[type]),
    disabled: (['set', 'toggle', 'increment'].includes(type) && !choices.vars.length) || (type === 'set-variant' && !choices.instances.length),
  }));
  let detail: ReactNode = null;
  if (action.type === 'set' || action.type === 'toggle' || action.type === 'increment') {
    const v = choices.vars.find((x) => x.name === action.variable);
    detail = (
      <div className="row">
        <SelectField<string> value={action.variable} options={varOptions} title={t('Variable')} testId={`${testId}-variable`} onChange={(name) => {
          const next = choices.vars.find((x) => x.name === name);
          onChange(action.type === 'set' ? { ...action, variable: name, value: next?.value ?? '' } : { ...action, variable: name });
        }} />
        {action.type === 'set' && v ? <ValueField type={v.type} value={action.value} testId={`${testId}-value`} onChange={(value) => onChange({ ...action, value })} /> : null}
        {action.type === 'increment' ? <NumberField label={t('by')} value={action.by ?? 1} title={t('Negative counts down')} testId={`${testId}-by`} onChange={(by) => onChange({ ...action, by })} /> : null}
      </div>
    );
  } else if (action.type === 'show' || action.type === 'hide' || action.type === 'toggle-visibility') {
    detail = <SelectField<string> value={action.target} options={choices.layers} title={t('Layer')} testId={`${testId}-target`} onChange={(target) => onChange({ ...action, target })} />;
  } else if (action.type === 'set-variant') {
    const inst = choices.instances.find((i) => i.value === action.target);
    const values = (inst?.axes ?? []).flatMap((a) => a.values.map((v) => ({ value: v, label: `${a.axis}: ${v}` })));
    detail = (
      <div className="row">
        <SelectField<string> value={action.target} options={choices.instances} title={t('Instance')} testId={`${testId}-target`} onChange={(target) => onChange({ ...action, target, value: choices.instances.find((i) => i.value === target)?.axes[0]?.values[0] ?? '' })} />
        <SelectField<string> value={action.value} options={values} title={t('Variant')} testId={`${testId}-variant`} onChange={(value) => onChange({ ...action, value })} />
      </div>
    );
  } else if (action.type === 'navigate') {
    detail = (
      <div className="row">
        <SelectField<string> value={action.to} options={choices.boards.filter((b) => b.value !== self)} title={t('Artboard')} testId={`${testId}-to`} onChange={(to) => onChange({ ...action, to })} />
        <SelectField<ProtoTransition> value={action.transition ?? 'fade'} options={TRANSITIONS.map((o) => ({ ...o, label: t(o.label) }))} title={t('Transition')} testId={`${testId}-transition`} onChange={(transition) => onChange({ ...action, transition })} />
      </div>
    );
  }
  return (
    <div className="proto-action" data-testid={testId}>
      <div className="list-row">
        <SelectField<ProtoActionType> className="list-row-grow" value={action.type} options={types} title={t('What happens')} testId={`${testId}-type`} onChange={(type) => onChange(newAction(type, choices, self))} />
        <IconButton icon={<Minus size={13} />} title={t('Remove this action')} onClick={onRemove} testId={`${testId}-remove`} />
      </div>
      {detail}
    </div>
  );
}

/** The interactions as stored, so that one being edited is not dropped before it is complete. */
function storedInteractions(node: BogenNode): ProtoInteraction[] {
  const list = (node.proto as { interactions?: unknown } | undefined)?.interactions;
  return Array.isArray(list) ? list.filter((i): i is ProtoInteraction => Boolean(i) && typeof i === 'object' && Array.isArray((i as ProtoInteraction).actions)) : [];
}

function writeProto(node: BogenNode, patch: Record<string, unknown>): void {
  const s = session();
  s.tx(() => {
    const next: Record<string, unknown> = { ...s.doc.getNode(node.id)?.proto, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    s.doc.updateFields(node.id, { proto: Object.keys(next).length ? next as LayerProto : undefined });
  });
}

export function InteractionsEditor({ node }: { node: BogenNode }) {
  const t = useT();
  const vars = useVariables();
  const choices = useChoices(node, vars);
  const list = storedInteractions(node);
  const save = (next: ProtoInteraction[]) => writeProto(node, { interactions: next.length ? next : undefined });
  const isForm = node.tag === 'form';
  return (
    <div className="proto-interactions" data-testid="proto-interactions">
      {list.map((i, n) => (
        <div key={n} className="proto-int" data-testid={`proto-int-${n}`}>
          <div className="list-row">
            <SelectField<ProtoTrigger> className="list-row-grow" label={t('On')} value={i.trigger} options={TRIGGERS.map((tr) => ({ ...tr, label: t(tr.label), disabled: tr.value === 'submit' && !isForm }))} testId={`proto-int-${n}-trigger`} onChange={(trigger) => save(list.map((x, k) => (k === n ? { ...x, trigger } : x)))} />
            <IconButton icon={<Minus size={13} />} title={t('Remove this interaction')} onClick={() => save(list.filter((_, k) => k !== n))} testId={`proto-int-${n}-remove`} />
          </div>
          {i.actions.map((a, k) => (
            <ActionEditor
              key={k}
              action={a}
              choices={choices}
              self={node.id}
              testId={`proto-int-${n}-action-${k}`}
              onChange={(next) => save(list.map((x, j) => (j === n ? { ...x, actions: x.actions.map((y, m) => (m === k ? next : y)) } : x)))}
              onRemove={() => save(list.map((x, j) => (j === n ? { ...x, actions: x.actions.filter((_, m) => m !== k) } : x)))}
            />
          ))}
          <button type="button" className="btn btn-quiet proto-add" data-testid={`proto-int-${n}-add`} onClick={() => save(list.map((x, j) => (j === n ? { ...x, actions: [...x.actions, newAction(vars.length ? 'toggle' : 'navigate', choices, node.id)] } : x)))}>
            <Plus size={12} /> {t('Action')}
          </button>
          {i.trigger === 'hover' ? <div className="hint">{t('Hover undoes itself when the pointer leaves.')}</div> : null}
        </div>
      ))}
      <button type="button" className="btn btn-quiet proto-add" data-testid="proto-int-add" onClick={() => save([...list, { trigger: isForm ? 'submit' : 'click', actions: [newAction(vars.length ? 'toggle' : 'navigate', choices, node.id)] }])}>
        <Plus size={12} /> {t('Interaction')}
      </button>
    </div>
  );
}

/** What of a layer follows a variable: whether it shows, which variant it takes, what a field or text says. */
export function DependsSection({ node }: { node: BogenNode }) {
  const t = useT();
  const vars = useVariables();
  const { snap } = session();
  const state = readProtoState(node.proto);
  const none = { value: '', label: t('Nothing') };
  const varOptions = vars.map((v) => ({ value: v.name, label: v.name }));
  const show = state.showWhen;
  const op = OPS.find((o) => o.value === show?.op);
  const showVar = vars.find((v) => v.name === show?.variable);
  const setShow = (next: ProtoCondition | undefined) => writeProto(node, { showWhen: next });
  const main = node.instanceOf !== undefined ? snap.nodes.get(node.instanceOf) : undefined;
  const axes = main?.component?.set ? variantAxes(snap.source, main.component.set).filter((a) => a.values.length > 1) : [];
  const field = /^(input|textarea|select)$/.test(node.tag);
  if (!vars.length) return <div className="hint">{t('Make a variable with nothing selected to show this layer, pick its variant or fill it from one.')}</div>;
  return (
    <div className="proto-depends" data-testid="proto-depends">
      <div className="param-label">{t('Depends on a variable')}</div>
      <SelectField<string> label={t('Show when')} value={show?.variable ?? ''} options={[{ value: '', label: t('Always') }, ...varOptions]} testId="proto-show-var" onChange={(variable) => {
        const v = vars.find((x) => x.name === variable);
        setShow(v ? { variable, op: v.type === 'boolean' ? 'is' : v.type === 'number' ? 'gt' : 'filled', ...(v.type === 'boolean' ? { value: true } : v.type === 'number' ? { value: 0 } : {}) } : undefined);
      }} />
      {show && showVar ? (
        <div className="row">
          <SelectField<ConditionOp> value={show.op} options={OPS.map((o) => ({ ...o, label: t(o.label) }))} title={t('Condition')} testId="proto-show-op" onChange={(o) => setShow({ variable: show.variable, op: o, ...(OPS.find((x) => x.value === o)?.needs ? { value: show.value ?? showVar.value } : {}) })} />
          {op?.needs ? <ValueField type={showVar.type} value={show.value} testId="proto-show-value" onChange={(value) => setShow({ ...show, value })} /> : null}
        </div>
      ) : null}
      {axes.length ? (
        <div className="row">
          <SelectField<string> label={t('Variant')} value={state.variantFrom?.prop ?? axes[0]!.axis} options={axes.map((a) => ({ value: a.axis, label: a.axis }))} title={t('Variant axis')} testId="proto-variant-axis" onChange={(prop) => writeProto(node, { variantFrom: state.variantFrom ? { ...state.variantFrom, prop } : undefined })} />
          <SelectField<string> value={state.variantFrom?.variable ?? ''} options={[none, ...varOptions.filter((o) => vars.find((v) => v.name === o.value)?.type === 'text')]} title={t('From the text variable')} testId="proto-variant-var" onChange={(variable) => writeProto(node, { variantFrom: variable ? { prop: state.variantFrom?.prop ?? axes[0]!.axis, variable } : undefined })} />
        </div>
      ) : null}
      {field ? <SelectField<string> label={t('Field')} value={state.bind ?? ''} options={[none, ...varOptions]} title={t('Reads and writes this variable')} testId="proto-bind" onChange={(v) => writeProto(node, { bind: v || undefined })} /> : null}
      {node.type === 'text' ? <SelectField<string> label={t('Text')} value={state.textFrom ?? ''} options={[none, ...varOptions]} title={t('Shows this variable\'s value')} testId="proto-text-from" onChange={(v) => writeProto(node, { textFrom: v || undefined })} /> : null}
    </div>
  );
}
