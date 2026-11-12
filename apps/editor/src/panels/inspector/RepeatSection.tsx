import { useState } from 'react';
import {
  applyRepeat, bindLayer, getDataSource, getRepeatBinding, layerBindings, parseRecords, placeholdersIn, recordFields, recordsFrom, repeatTemplateOf,
  storedRecords, templateFor, variantAxes, type BogenNode, type DataRecord, type LayerBindingPatch, type RepeatSource,
} from '@bogen/core';
import { session } from '../../doc/session.ts';
import { fetchRecords, useDataSources } from '../../ops/data.ts';
import { editor } from '../../state/store.ts';
import { Section, Segmented, SelectField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';

const PASTE = '__paste';
const URL_KIND = '__url';
const NONE = '';

function shortText(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 14 ? `${t.slice(0, 13)}…` : t;
}

/**
 * Designs from data: a layer becomes a template whose copies are the records of a data source, and its layers'
 * text, image, visibility and variant are bound to fields. The copies on the canvas are the live preview, and
 * Refresh makes them again from the source.
 */
export function RepeatSection({ node }: { node: BogenNode }) {
  const t = useT();
  const s = session();
  const sources = useDataSources();
  const copyOf = repeatTemplateOf(s.doc, node.id);
  const templateId = templateFor(s.doc, node.id) ?? node.id;
  const template = s.snap.nodes.get(templateId) ?? node;
  const binding = getRepeatBinding(s.doc, templateId);
  const bound = binding?.source.kind === 'source' ? binding.source.source : undefined;
  const [choice, setChoice] = useState<string>(bound ?? (binding?.source.kind === 'url' ? URL_KIND : binding ? PASTE : sources[0]?.id ?? PASTE));
  const [data, setData] = useState('');
  const [url, setUrl] = useState(binding?.source.url ?? '');
  const [path, setPath] = useState(binding?.source.path ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<number>(binding?.source.record ?? 0);
  if (copyOf) {
    return (
      <Section title={t('Data')} collapsible defaultOpen={false}>
        <div className="repeat" data-testid="repeat-section">
          <div className="hint">{t('A copy made from a record. Its template decides what it shows.')}</div>
          <button type="button" className="btn" onClick={() => editor().set({ selection: [copyOf] })} data-testid="repeat-template">{t('Select the template')}</button>
        </div>
      </Section>
    );
  }

  const source = choice !== PASTE && choice !== URL_KIND ? getDataSource(s.doc, choice) : undefined;
  const records = source?.records ?? (binding ? storedRecords(s.doc, binding) : undefined) ?? [];
  const fields = [...new Set([...recordFields(records), ...placeholdersIn(s.doc.toSpec(templateId))])];
  const single = binding?.source.record !== undefined;
  const mine = layerBindings(s.doc, node.id);
  const instanceMain = node.instanceOf !== undefined ? s.doc.source.raw(node.instanceOf) : undefined;
  const axes = instanceMain?.component?.set ? variantAxes(s.doc.source, instanceMain.component.set) : [];
  const textProps = (instanceMain?.component?.props ?? []).filter((p) => p.type === 'text' || p.type === 'image');
  const hasAny = Boolean(fields.length || binding || sources.length);
  if (!hasAny && node.type !== 'text' && node.type !== 'image' && node.type !== 'frame' && node.instanceOf === undefined) return null;

  const bind = (patch: LayerBindingPatch) => {
    setError(null);
    try {
      s.tx(() => bindLayer(s.doc, node.id, patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const fieldPicker = (label: string, value: string | undefined, onChange: (field: string | null) => void, testId: string) => (
    <SelectField key={testId} label={label} value={value ?? NONE} testId={testId} onChange={(v) => onChange(v === NONE ? null : v)} options={[{ value: NONE, label: t('Not bound') }, ...fields.map((f) => ({ value: f, label: f }))]} />
  );

  const run = async (asRecord = single, index = record) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const one = asRecord ? { record: index } : {};
      let list: DataRecord[];
      let from: RepeatSource;
      if (source) {
        list = source.records;
        from = { kind: 'source', source: source.id, ...one };
      } else if (choice === PASTE && data.trim()) {
        list = parseRecords(data, { path: path.trim() || undefined });
        from = { kind: 'inline', ...(path.trim() ? { path: path.trim() } : {}), ...one };
      } else if (choice === URL_KIND && url.trim()) {
        list = await fetchRecords(url.trim(), { path: path.trim() || undefined });
        from = { kind: 'url', url: url.trim(), ...(path.trim() ? { path: path.trim() } : {}), ...one };
      } else if (binding?.records) {
        list = recordsFrom(binding.records);
        from = { ...binding.source, ...one };
        if (!asRecord) delete from.record;
      } else throw new Error(choice === URL_KIND ? t('Give an address.') : t('Paste some data, or pick a source from the Data panel.'));
      // In this editor's own transaction: one Ctrl+Z takes back all the copies.
      const result = s.tx(() => applyRepeat(s.doc, templateId, list, from));
      setNote([
        t.n(result.copies.length, '{count} copy.', '{count} copies.'),
        result.missing.length ? t('Empty because not in the data: {fields}.', { fields: result.missing.join(', ') }) : '',
        result.refused.length ? t('Refused: {reasons}.', { reasons: result.refused.slice(0, 3).join('; ') }) : '',
        result.warning ?? '',
      ].filter(Boolean).join(' '));
      setData('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = (r: DataRecord, i: number) => {
    const first = Object.values(r).find((v) => typeof v === 'string' && v.trim());
    return `${i + 1}${first ? `: ${shortText(String(first))}` : ''}`;
  };
  const liveCopies = binding ? binding.copies.filter((id) => s.snap.nodes.has(id)) : [];
  const copiesFrom = (from: RepeatSource): string => {
    const n = liveCopies.length;
    if (from.kind === 'source') {
      const name = getDataSource(s.doc, from.source ?? '')?.name;
      return name ? t.n(n, '{count} copy from {source}.', '{count} copies from {source}.', { source: name }) : t.n(n, '{count} copy from a removed source.', '{count} copies from a removed source.');
    }
    if (from.kind === 'url') return t.n(n, '{count} copy from {source}.', '{count} copies from {source}.', { source: from.url ?? '' });
    return t.n(n, '{count} copy from pasted data.', '{count} copies from pasted data.');
  };

  return (
    <Section title={t('Data')} collapsible defaultOpen={Boolean(binding) || templateId !== node.id}>
      <div className="repeat" data-testid="repeat-section">
        {templateId !== node.id ? <div className="hint" dir="auto">{t('Inside the template {name}.', { name: template.name })}</div> : null}
        <SelectField label={t('Source')} value={choice} testId="repeat-source" onChange={setChoice} options={[...sources.map((src) => ({ value: src.id, label: src.name })), { value: PASTE, label: t('Paste here') }, { value: URL_KIND, label: t('An address') }]} />
        {choice === PASTE ? <textarea className="repeat-data" rows={4} placeholder={t('Paste JSON or CSV')} value={data} onChange={(e) => setData(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="repeat-data" /> : null}
        {choice === URL_KIND ? <input className="token-input" placeholder={t('A public address')} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="repeat-url" /> : null}
        {choice === PASTE || choice === URL_KIND ? <input className="token-input" placeholder={t('Where the list is, such as {example}', { example: 'data.items' })} value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="repeat-path" /> : null}
        <div className="repeat-row">
          <span className="param-label">{t('Use')}</span>
          <Segmented<'list' | 'record'> value={single ? 'record' : 'list'} testId="repeat-use" onChange={(v) => { if (binding) void run(v === 'record', record); }} options={[{ value: 'list', label: t('List'), title: t('One copy per record') }, { value: 'record', label: t('Record'), title: t('One copy of one record, such as a profile'), disabled: !binding }]} />
        </div>
        {single && records.length ? <SelectField label={t('Show')} value={String(record)} testId="repeat-record" onChange={(v) => { setRecord(Number(v)); void run(true, Number(v)); }} options={records.slice(0, 200).map((r, i) => ({ value: String(i), label: label(r, i) }))} /> : null}
        {fields.length ? (
          <div className="repeat-bindings" data-testid="repeat-bindings">
            <span className="panel-title">{t('Bindings')}</span>
            {node.type === 'text' ? fieldPicker(t('Text "{text}"', { text: shortText(mine.text ? `{{${mine.text}}}` : node.text) }), mine.text, (f) => bind({ text: f }), 'bind-text') : null}
            {node.type === 'image' || node.type === 'video' ? fieldPicker(t('Image'), mine.src, (f) => bind({ src: f }), 'bind-src') : null}
            {node.type === 'image' ? fieldPicker(t('Alt'), mine.attrs.alt, (f) => bind({ attrs: { alt: f } }), 'bind-alt') : null}
            {fieldPicker(t('Visible'), mine.visible, (f) => bind({ visible: f }), 'bind-visible')}
            {axes.map((a) => fieldPicker(t('Variant: {axis}', { axis: a.axis }), mine.variant[a.axis], (f) => bind({ variant: { [a.axis]: f } }), `bind-variant-${a.axis}`))}
            {textProps.map((p) => fieldPicker(p.name, mine.props[p.name], (f) => bind({ props: { [p.name]: f } }), `bind-prop-${p.name}`))}
          </div>
        ) : <div className="hint">{t("Pick a source to bind this layer's text, image, visibility and variant to its fields.")}</div>}
        <div className="repeat-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()} data-testid="repeat-run">{busy ? t('Working') : binding ? t('Refresh') : t('Repeat this layer')}</button>
          {liveCopies.length ? <button type="button" className="btn" onClick={() => editor().set({ selection: liveCopies })} data-testid="repeat-select">{t('Select copies')}</button> : null}
        </div>
        {binding ? <div className="hint" dir="auto">{copiesFrom(binding.source)}</div> : null}
        {note ? <div className="hint" data-testid="repeat-note">{note}</div> : null}
        {error ? <div className="error" data-testid="repeat-error">{error}</div> : null}
      </div>
    </Section>
  );
}
