import { useState } from 'react';
import { createMode, deleteMode, deleteTextStyle, setPageMode, type TextStyle } from '@bogen/core';
import { Plus, Trash2 } from 'lucide-react';
import { create } from 'zustand';
import { useModes, usePages, useTextStyles } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton, SelectField, Segmented } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';

/** Which mode the token rows show and edit. Local: looking at dark values changes nothing for others. */
export const useEditingMode = create<{ mode: string | null; set: (mode: string | null) => void }>((set) => ({ mode: null, set: (mode) => set({ mode }) }));

const INHERIT = '__inherit';

export function ModeBar() {
  const t = useT();
  const modes = useModes();
  const pages = usePages();
  const pageId = useEditor((s) => s.pageId);
  const editing = useEditingMode((s) => s.mode);
  const setEditing = useEditingMode((s) => s.set);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const s = session();
  const add = () => {
    const mode = name.trim().replace(/\s+/g, '-');
    if (!mode) return;
    try {
      s.tx(() => createMode(s.doc, mode));
      setEditing(mode);
      setName('');
      setAdding(false);
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const current = modes.some((m) => m.name === editing) ? editing! : modes.find((m) => m.base)?.name;
  const page = pages.find((p) => p.id === pageId);
  const selected = modes.find((m) => m.name === current);
  return (
    <div className="mode-bar" data-testid="mode-bar">
      <div className="mode-row">
        {modes.length ? (
          <Segmented<string>
            value={current}
            onChange={setEditing}
            testId="token-mode"
            options={modes.map((m) => ({ value: m.name, label: m.name, title: t('Edit values in {mode}', { mode: m.name }) }))}
          />
        ) : <span className="hint mode-hint">{t('One value per token')}</span>}
        {selected && !selected.base ? <IconButton icon={<Trash2 size={13} />} title={t('Delete mode {mode}', { mode: selected.name })} testId="mode-delete" onClick={() => { s.tx(() => deleteMode(s.doc, selected.name)); setEditing(null); }} tabIndex={-1} /> : null}
        <IconButton icon={<Plus size={14} />} title={t('Add a theme mode, such as dark or compact')} active={adding} testId="mode-add" onClick={() => setAdding(!adding)} tabIndex={-1} />
      </div>
      {adding ? (
        <input autoFocus className="token-input" placeholder={modes.length ? 'compact' : 'dark'} value={name} data-testid="mode-name" onChange={(e) => setName(e.target.value)} onBlur={() => { if (!name.trim()) setAdding(false); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); if (e.key === 'Escape') setAdding(false); }} spellCheck={false} />
      ) : null}
      {modes.length && pageId ? (
        <SelectField<string>
          label={t('This page')}
          value={page?.mode ?? INHERIT}
          testId="token-page-mode"
          onChange={(mode) => s.tx(() => setPageMode(s.doc, pageId, mode === INHERIT ? null : mode))}
          options={[{ value: INHERIT, label: t('Plain values ({mode})', { mode: modes.find((m) => m.base)?.name ?? 'base' }) }, ...modes.filter((m) => !m.base).map((m) => ({ value: m.name, label: m.name }))]}
        />
      ) : null}
    </div>
  );
}

function sample(t: TextStyle): string {
  return [t.style.fontSize, t.style.fontWeight, t.style.lineHeight && `/ ${t.style.lineHeight}`].filter(Boolean).join(' ');
}

/** The file's text styles, for reading and removing. Making and applying is in the inspector. */
export function TextStylesList() {
  const t = useT();
  const styles = useTextStyles();
  const s = session();
  if (!styles.length) return null;
  return (
    <div className="token-group" data-testid="text-styles">
      <div className="token-group-title">{t('Text styles')}</div>
      {styles.map((st) => (
        <div key={st.key} className="token-row text-style-row" data-testid="text-style-row" data-style={st.key}>
          <span className="text-style-name" dir="auto" title={st.style.fontFamily}>{st.name}</span>
          <span className="text-style-sample">{sample(st)}</span>
          <IconButton className="row-action" icon={<Trash2 size={13} />} title={t('Delete {name}', { name: st.name })} onClick={() => s.tx(() => deleteTextStyle(s.doc, st.key))} tabIndex={-1} />
        </div>
      ))}
    </div>
  );
}
