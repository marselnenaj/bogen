import { useRef, useState } from 'react';
import { applyTextStyle, setTextStyle, TEXT_STYLE_PROPS, type BogenNode } from '@bogen/core';
import { Plus, RefreshCw } from 'lucide-react';
import { elOf } from '../../canvas/measure.ts';
import { useTextStyles } from '../../doc/hooks.ts';
import { session } from '../../doc/session.ts';
import { editor } from '../../state/store.ts';
import { IconButton, MIXED, common, Popover, SelectField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';

const NONE = '__none';
const CSS_NAMES: Record<string, string> = { fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight', lineHeight: 'line-height', letterSpacing: 'letter-spacing' };

/** What a layer shows now, from its own style and failing that from the browser. */
function bundleOf(n: BogenNode): Record<string, string> {
  const el = elOf(n.id);
  const computed = el ? getComputedStyle(el) : null;
  const out: Record<string, string> = {};
  for (const [prop, css] of Object.entries(CSS_NAMES)) {
    const value = n.style[prop] ?? computed?.getPropertyValue(css);
    if (value && value !== 'normal') out[prop] = value;
  }
  return out;
}

function ownBundle(n: BogenNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of TEXT_STYLE_PROPS) if (n.style[prop] !== undefined) out[prop] = n.style[prop]!;
  return out;
}

/** Named text styles at the top of Typography: pick one, make one, or update it from the layer. */
export function TextStyleField({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const styles = useTextStyles();
  const s = session();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const anchor = useRef<HTMLDivElement>(null);
  const current = common(nodes.map((n) => n.textStyle ?? NONE));
  const key = current === MIXED || current === NONE ? null : (current ?? null);
  const style = styles.find((ts) => ts.key === key);
  // Values of its own on top of the style are what "update" would write back.
  const modified = style ? nodes.some((n) => Object.keys(ownBundle(n)).some((p) => p in style.style)) : false;
  const apply = (next: string) => {
    s.tx(() => {
      for (const n of nodes) applyTextStyle(s.doc, n.id, next === NONE ? null : next);
    });
  };
  const create = () => {
    const label = name.trim();
    if (!label) return;
    try {
      s.tx(() => {
        const made = setTextStyle(s.doc, label, bundleOf(nodes[0]!));
        for (const n of nodes) applyTextStyle(s.doc, n.id, made);
      });
      setNaming(false);
      setName('');
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const update = () => {
    if (!style) return;
    const own = ownBundle(nodes[0]!);
    s.tx(() => {
      setTextStyle(s.doc, style.name, own);
      for (const n of nodes) applyTextStyle(s.doc, n.id, style.key);
    });
  };
  return (
    <div className="ds-text-style" ref={anchor}>
      <SelectField<string>
        className="ds-text-style-select"
        label={t('Style')}
        value={current === MIXED ? MIXED : (current ?? NONE)}
        testId="text-style"
        title={t('Text style')}
        onChange={apply}
        options={[{ value: NONE, label: t('None') }, ...styles.map((ts) => ({ value: ts.key, label: ts.name }))]}
      />
      {modified ? <IconButton icon={<RefreshCw size={13} />} title={t('Update {name} from this layer', { name: style!.name })} testId="text-style-update" onClick={update} tabIndex={-1} /> : null}
      <IconButton icon={<Plus size={14} />} title={t('New text style from this layer')} testId="text-style-add" onClick={() => setNaming(true)} tabIndex={-1} />
      {naming ? (
        <Popover anchor={anchor.current} onClose={() => setNaming(false)} width={200}>
          <input autoFocus className="token-input" placeholder={t('Heading 1')} value={name} data-testid="text-style-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') create(); }} spellCheck={false} />
        </Popover>
      ) : null}
    </div>
  );
}
