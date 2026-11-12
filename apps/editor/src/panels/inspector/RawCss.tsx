import { inspectorStyle } from '../../ops/breakpoints.ts';
import { useMemo, useState } from 'react';
import type { BogenNode } from '@bogen/core';
import { camelCss, kebabCss, parseStyle } from '@bogen/core';
import { ChevronDown, ChevronRight, Eraser, Plus, X } from 'lucide-react';
import { groupStyle, type StyleRow } from '../../lib/style-groups.ts';
import { simplifyStyles } from '../../ops/simplify.ts';
import { IconButton, Section } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';

/** Every property on the selection, editable as text and sorted into groups. Nothing is hidden from the person using it. */
export function RawCssSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const { groups, total, mixed } = useMemo(() => {
    const keys = new Set<string>();
    for (const n of nodes) for (const k of Object.keys(n.style)) keys.add(k);
    const merged: Record<string, string> = {};
    const mixedKeys = new Set<string>();
    for (const k of keys) {
      const values = new Set(nodes.map((n) => n.style[k] ?? ''));
      if (values.size > 1) mixedKeys.add(k);
      merged[k] = [...values][0] ?? '';
    }
    return { groups: groupStyle(merged), total: keys.size, mixed: mixedKeys };
  }, [nodes]);

  const commitNew = (text: string) => {
    setAdding(false);
    const parsed = parseStyle(text);
    if (Object.keys(parsed).length) inspectorStyle(ids, parsed);
  };
  const write = (r: StyleRow, value: string) => {
    const clear = Object.fromEntries((r.sources ?? []).map((k) => [k, null]));
    if (r.sources) inspectorStyle(ids, { ...clear, ...(value ? parseStyle(`${r.label}: ${value}`) : {}) });
    else inspectorStyle(ids, { [r.key]: value || null });
  };
  const rename = (r: StyleRow, next: string) => {
    const clear = Object.fromEntries((r.sources ?? [r.key]).map((k) => [k, null]));
    inspectorStyle(ids, { ...clear, [camelCss(next)]: r.value });
  };
  const q = query.trim().toLowerCase();
  const visible = groups.map((g) => ({ ...g, rows: q ? g.rows.filter((r) => r.label.includes(q) || r.value.toLowerCase().includes(q)) : g.rows })).filter((g) => g.rows.length);

  return (
    <Section
      title={t('Other styles')}
      note={total ? t.n(total, '{count} CSS property', '{count} CSS properties') : 'CSS'}
      collapsible
      defaultOpen={false}
      actions={(
        <>
          <IconButton icon={<Eraser size={14} />} title={t('Simplify styles: remove what does not change the rendering, measured before and after')} onClick={() => void simplifyStyles()} testId="css-simplify" />
          <IconButton icon={<Plus size={14} />} title={t('Add a property')} onClick={() => setAdding(true)} testId="css-add" />
        </>
      )}
    >
      <div className="css-list" data-testid="css-list">
        {total > 8 ? (
          <input className="css-filter" placeholder={t('Filter properties')} value={query} spellCheck={false} aria-label={t('Filter properties')} data-testid="css-filter" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
        ) : null}
        {visible.map((g) => <CssGroup key={g.title} title={g.title} rows={g.rows} startOpen={Boolean(q) || total <= 14 || g.rows.length <= 3} mixed={mixed} onValue={write} onName={rename} />)}
        {!total && !adding ? <div className="hint">{t('No styles set. Add one with the plus, like {example}.', { example: 'color: red' })}</div> : null}
        {total > 0 && !visible.length ? <div className="hint">{t('No property matches this.')}</div> : null}
        {adding ? (
          <input
            autoFocus
            className="css-new"
            placeholder={t('property: value')}
            data-testid="css-new"
            onBlur={(e) => commitNew(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitNew(e.currentTarget.value);
              if (e.key === 'Escape') setAdding(false);
            }}
          />
        ) : null}
      </div>
    </Section>
  );
}

function CssGroup({ title, rows, startOpen, mixed, onValue, onName }: { title: string; rows: StyleRow[]; startOpen: boolean; mixed: Set<string>; onValue: (r: StyleRow, v: string) => void; onName: (r: StyleRow, n: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? startOpen;
  return (
    <div className="css-group" data-testid={`css-group-${title}`}>
      <button type="button" className="css-group-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        {shown ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{t(title)}</span>
        <span className="css-group-count">{rows.length}</span>
      </button>
      {/* Collapsed rows stay in the document, so that everything on the layer can still be found on the page. */}
      <div hidden={!shown}>{rows.map((r) => <CssRow key={r.key} row={r} mixed={mixed.has(r.key)} onValue={(v) => onValue(r, v)} onName={(n) => onName(r, n)} />)}</div>
    </div>
  );
}

function CssRow({ row, mixed, onValue, onName }: { row: StyleRow; mixed: boolean; onValue: (v: string) => void; onName: (n: string) => void }) {
  const t = useT();
  const value = mixed ? '' : row.value;
  const [text, setText] = useState<string | null>(null);
  const [nameText, setNameText] = useState<string | null>(null);
  const display = row.label;
  return (
    <div className={`css-row${row.quiet ? ' is-quiet' : ''}${value.length > 26 ? ' is-long' : ''}`} title={`${display}: ${value}`}>
      <input
        className="css-name"
        value={nameText ?? display}
        spellCheck={false}
        aria-label={t('Name of {property}', { property: display })}
        onChange={(e) => setNameText(e.target.value)}
        onBlur={() => { if (nameText && nameText !== display) onName(nameText); setNameText(null); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setNameText(null); }}
      />
      <textarea
        className="css-value"
        value={text ?? value}
        placeholder={mixed ? t('Mixed') : ''}
        spellCheck={false}
        rows={1}
        aria-label={t('Value of {property}', { property: display })}
        data-testid={`css-value-${display}`}
        onChange={(e) => setText(e.target.value.replace(/\n/g, ' '))}
        onBlur={() => { if (text !== null && text !== value) onValue(text); setText(null); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === 'Escape') setText(null);
        }}
      />
      <IconButton icon={<X size={12} />} title={t('Remove {property}', { property: display })} onClick={() => onValue('')} className="css-remove" tabIndex={-1} />
    </div>
  );
}

export { kebabCss };
