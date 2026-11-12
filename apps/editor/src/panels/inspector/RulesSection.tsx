import { useState } from 'react';
import { blockKey, camelCss, cleanRuleProp, cleanRuleValue, kebabCss, orderedBlocks, parseStyle, PSEUDO_ELEMENTS, type BogenNode } from '@bogen/core';
import { Plus, Trash2, X } from 'lucide-react';
import { session } from '../../doc/session.ts';
import { editor } from '../../state/store.ts';
import { IconButton, Section, SelectField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';
import { t } from '../../i18n/store.ts';

/**
 * A layer's pseudo-elements and conditional styles: `::before`, `@container (max-width: 560px)`, `:hover`.
 * Each block is a list of properties, edited as text the way "Other styles" is. Media width queries read
 * the artboard's width, so preview mode at another width shows them taking effect.
 */
export function RulesSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const node = nodes.length === 1 ? nodes[0]! : null;
  const [adding, setAdding] = useState(false);
  if (!node) return null;
  const rules = node.rules ?? {};
  const blocks = orderedBlocks(rules);
  return (
    <Section
      title={t('Pseudo-elements and conditions')}
      note={blocks.length ? t.n(blocks.length, '{count} block', '{count} blocks') : undefined}
      collapsible
      defaultOpen={blocks.length > 0}
      actions={<IconButton icon={<Plus size={14} />} title={t('Add a pseudo-element or a condition')} onClick={() => setAdding(true)} testId="rules-add" />}
    >
      <div className="css-list" data-testid="rules-list">
        {blocks.map((b) => <RuleBlockView key={b.key} id={node.id} block={b.key} style={rules[b.key] ?? {}} />)}
        {!blocks.length && !adding ? <div className="hint">{t('None. Add {before} or {after}, a state such as {state}, or a condition such as {condition}.', { before: '::before', after: '::after', state: ':hover', condition: '@container (max-width: 560px)' })}</div> : null}
        {adding ? <NewBlock id={node.id} onDone={() => setAdding(false)} /> : null}
      </div>
    </Section>
  );
}

function write(id: string, block: string, patch: Record<string, string | null>): void {
  const s = session();
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && !cleanRuleValue(v)) {
      editor().showToast(t('The value of {property} cannot go into a style sheet.', { property: kebabCss(k) }));
      return;
    }
  }
  s.tx(() => s.doc.updateRules(id, block, patch));
}

function RuleBlockView({ id, block, style }: { id: string; block: string; style: Record<string, string> }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const commitNew = (text: string) => {
    setAdding(false);
    const parsed = parseStyle(text);
    if (Object.keys(parsed).length) write(id, block, parsed);
  };
  return (
    <div className="rule-block" data-testid="rule-block" data-block={block}>
      <div className="rule-head">
        <span className="rule-key" title={block}>{block}</span>
        <IconButton icon={<Plus size={12} />} title={t('Add a property')} onClick={() => setAdding(true)} testId="rule-add-prop" />
        <IconButton icon={<Trash2 size={12} />} title={t('Remove this block')} onClick={() => { const s = session(); s.tx(() => s.doc.deleteRules(id, block)); }} testId="rule-remove" />
      </div>
      {Object.entries(style).map(([k, v]) => <RuleRow key={k} prop={k} value={v} onValue={(next) => write(id, block, { [k]: next || null })} onName={(name) => { const prop = cleanRuleProp(camelCss(name)); if (prop) write(id, block, { [k]: null, [prop]: v }); }} />)}
      {adding ? (
        <input
          autoFocus
          className="css-new"
          placeholder={/::(before|after)$/.test(block) && !style.content ? 'content: ""' : 'property: value'}
          data-testid="rule-new-prop"
          onBlur={(e) => commitNew(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitNew(e.currentTarget.value);
            if (e.key === 'Escape') setAdding(false);
          }}
        />
      ) : null}
    </div>
  );
}

function RuleRow({ prop, value, onValue, onName }: { prop: string; value: string; onValue: (v: string) => void; onName: (n: string) => void }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [nameText, setNameText] = useState<string | null>(null);
  const label = kebabCss(prop);
  return (
    <div className="css-row" title={`${label}: ${value}`}>
      <input
        className="css-name"
        value={nameText ?? label}
        spellCheck={false}
        aria-label={t('Name of {property}', { property: label })}
        onChange={(e) => setNameText(e.target.value)}
        onBlur={() => { if (nameText && nameText !== label) onName(nameText); setNameText(null); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setNameText(null); }}
      />
      <input
        className="css-value"
        value={text ?? value}
        spellCheck={false}
        aria-label={t('Value of {property}', { property: label })}
        data-testid={`rule-value-${label}`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== null && text !== value) onValue(text); setText(null); }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setText(null); }}
      />
      <IconButton icon={<X size={12} />} title={t('Remove {property}', { property: label })} onClick={() => onValue('')} className="css-remove" tabIndex={-1} />
    </div>
  );
}

const PSEUDO_OPTIONS = PSEUDO_ELEMENTS.map((p) => ({ value: p, label: p }));

/** Picks a pseudo-element and a condition, then the first declaration, and writes them as one change. */
function NewBlock({ id, onDone }: { id: string; onDone: () => void }) {
  const t = useT();
  const [pseudo, setPseudo] = useState<string>('::before');
  const [when, setWhen] = useState('');
  const [decl, setDecl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const key = blockKey(when || undefined, pseudo || undefined);
    if ('error' in key) return setError(key.error);
    const parsed = parseStyle(decl || (/::(before|after)$/.test(pseudo) ? 'content: ""' : ''));
    if (!Object.keys(parsed).length) return setError(t('Write at least one property, such as {example}.', { example: 'color: red' }));
    write(id, key.key, parsed);
    onDone();
  };
  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') add();
    if (e.key === 'Escape') onDone();
  };
  return (
    <div className="rule-new" data-testid="rule-new">
      <SelectField<string> value={pseudo} options={[{ value: '', label: t('No pseudo-element') }, ...PSEUDO_OPTIONS]} onChange={setPseudo} title={t('Pseudo-element')} testId="rule-new-pseudo" />
      <input className="css-new" placeholder={t('Condition: {examples}', { examples: '@container (max-width: 560px), :hover, parent[open]' })} value={when} spellCheck={false} data-testid="rule-new-when" onChange={(e) => { setWhen(e.target.value); setError(null); }} onKeyDown={keys} />
      <input className="css-new" placeholder={/::(before|after)$/.test(pseudo) ? 'content: "+"; color: red' : 'property: value'} value={decl} spellCheck={false} data-testid="rule-new-decl" onChange={(e) => { setDecl(e.target.value); setError(null); }} onKeyDown={keys} />
      {error ? <div className="hint rule-error">{error}</div> : null}
      <div className="rule-new-actions">
        <button type="button" className="btn" onClick={onDone}>{t('Cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={add} data-testid="rule-new-add">{t('Add')}</button>
      </div>
    </div>
  );
}
