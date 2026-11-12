import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { camelCss, hasProtoState, kebabCss, parseStyle, type BogenNode, type LayerProto, type ProtoTransition } from '@bogen/core';
import { session } from '../../doc/session.ts';
import { TRANSITIONS } from '../../preview/preview-model.ts';
import { common, IconButton, MIXED, NumberField, Section, SelectField, TextField } from '../../ui/controls.tsx';
import { DependsSection, InteractionsEditor } from './PrototypeState.tsx';
import { useT } from '../../i18n/react.ts';

/** What a layer does in preview mode: where a click goes, how it looks under the pointer, and the state it reads and changes. */
export function PrototypeSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const { snap } = session();
  const ids = nodes.map((n) => n.id);
  const boards = useMemo(() => snap.pages.flatMap((p) => snap.children(p.id).flatMap((id) => {
    const n = snap.nodes.get(id);
    return n?.artboard ? [{ value: id, label: `${n.name}${snap.pages.length > 1 ? ` (${p.name})` : ''}` }] : [];
  })), [snap, snap.structureVersion, snap.version]);
  const link = common(nodes.map((n) => n.proto?.link ?? ''));
  const transition = common(nodes.map((n) => n.proto?.transition ?? 'fade'));
  const duration = common(nodes.map((n) => n.proto?.duration ?? 300));
  const first = nodes[0]!;
  const hover = first.proto?.hover ?? {};
  const keys = Object.keys(hover);
  const [adding, setAdding] = useState(false);
  const write = (patch: Partial<LayerProto>) => {
    const s = session();
    s.tx(() => {
      for (const n of nodes) {
        const next: LayerProto = { ...n.proto, ...patch };
        for (const k of Object.keys(next) as (keyof LayerProto)[]) if (next[k] === undefined) delete next[k];
        if (!next.link) { delete next.transition; if (!next.hover) delete next.duration; }
        if (next.hover && !Object.keys(next.hover).length) delete next.hover;
        s.doc.updateFields(n.id, { proto: Object.keys(next).length ? next : undefined });
      }
    });
  };
  const has = Boolean(link && link !== MIXED) || keys.length > 0 || nodes.some((n) => hasProtoState(n.proto));
  const one = nodes.length === 1 && !first.id.includes('/') ? first : null;
  return (
    <Section title={t('Prototype')} collapsible defaultOpen={has} note={has ? t('On') : undefined}>
      <SelectField<string> label={t('On click')} title={t('On click, go to artboard')} value={link === MIXED ? MIXED : link ?? ''} testId="proto-link" options={[{ value: '', label: t('Nothing') }, ...boards.filter((b) => !ids.includes(b.value))]} onChange={(v) => write({ link: v || undefined })} />
      {link && link !== MIXED ? (
        <div className="row">
          <SelectField<ProtoTransition> value={transition === MIXED ? MIXED : transition} options={TRANSITIONS.map((o) => ({ ...o, label: t(o.label) }))} title={t('Transition')} testId="proto-transition" onChange={(v) => write({ transition: v })} />
          <NumberField value={duration === MIXED ? MIXED : duration ?? 300} min={0} max={5000} step={50} suffix="ms" title={t('How long')} testId="proto-duration" onChange={(d) => write({ duration: d })} />
        </div>
      ) : null}
      <div className="proto-hover-head">
        <span className="param-label">{t('While hovering')}</span>
        <IconButton icon={<Plus size={13} />} title={t('Add a style for hover')} testId="proto-hover-add" onClick={() => setAdding(true)} />
      </div>
      {keys.map((k) => (
        <div className="list-row" key={k}>
          <TextField className="list-row-grow" label={kebabCss(k)} value={hover[k] ?? ''} testId={`proto-hover-${kebabCss(k)}`} onChange={(v) => write({ hover: { ...hover, [k]: v } })} />
          <IconButton icon={<Minus size={13} />} title={t('Remove {property}', { property: kebabCss(k) })} onClick={() => { const next = { ...hover }; delete next[k]; write({ hover: next }); }} />
        </div>
      ))}
      {adding ? (
        <input
          autoFocus
          className="css-new"
          placeholder="opacity: .8; background-color: #000"
          data-testid="proto-hover-new"
          onBlur={() => setAdding(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              const parsed = parseStyle(e.currentTarget.value);
              const clean = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [camelCss(k), v]));
              if (Object.keys(clean).length) write({ hover: { ...hover, ...clean } });
              setAdding(false);
            }
            if (e.key === 'Escape') setAdding(false);
          }}
        />
      ) : null}
      {one ? <InteractionsEditor node={one} /> : null}
      {one ? <DependsSection node={one} /> : null}
    </Section>
  );
}
