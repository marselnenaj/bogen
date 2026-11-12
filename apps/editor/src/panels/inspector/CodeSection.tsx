import { useState } from 'react';
import { codeComponentName, codeUsageJsx, setCodeProps, type BogenNode, type CodePropValue } from '@bogen/core';
import { Copy, RotateCcw, Scan } from 'lucide-react';
import { session } from '../../doc/session.ts';
import { measureCodeComponent, useCodeComponent, type CodePropInfo } from '../../lib/code-api.ts';
import { editor } from '../../state/store.ts';
import { copyText, IconButton, Section, SelectField, TextField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';
import { t } from '../../i18n/store.ts';

const UNSET = '__unset';

function shown(value: CodePropValue | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** What a field's text means for a prop of this type. Undefined clears the prop. */
function parse(info: CodePropInfo, text: string): CodePropValue | undefined {
  if (text === '') return undefined;
  if (info.type === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(t('{name} takes a number.', { name: info.name }));
    return n;
  }
  if (info.type === 'json') {
    try {
      return JSON.parse(text) as CodePropValue;
    } catch {
      return text;
    }
  }
  return text;
}

/** Props of a component from the person's repository, from its TypeScript types, and a way to fit the layer to it. */
export function CodeSection({ node }: { node: BogenNode }) {
  const t = useT();
  const s = session();
  const code = node.code!;
  const info = useCodeComponent(code.project, code.file, code.name);
  const [busy, setBusy] = useState(false);
  const declared = info?.props ?? [];
  const extra: CodePropInfo[] = Object.keys(code.props).filter((k) => !declared.some((p) => p.name === k)).map((name) => ({ name, type: 'json' }));
  const props = [...declared, ...extra];
  const set = (name: string, value: CodePropValue | undefined) => {
    try {
      s.tx(() => setCodeProps(s.doc, node.id, { [name]: value }));
    } catch (e) {
      editor().showToast((e as Error).message);
    }
  };
  const fit = async () => {
    setBusy(true);
    try {
      const size = await measureCodeComponent(code.project, code.file, code.name, code.props);
      s.tx(() => s.doc.updateStyle(node.id, { width: `${size.width}px`, height: `${size.height}px` }));
    } catch (e) {
      editor().showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title={t('Code component')}
      note={codeComponentName(code)}
      actions={<>
        <IconButton icon={<Scan size={13} />} title={t('Fit the layer to what the component draws')} onClick={() => void fit()} disabled={busy} testId="code-fit" />
        <IconButton icon={<Copy size={13} />} title={t('Copy as JSX')} onClick={() => void copyText(codeUsageJsx(code)).then(() => editor().showToast(t('Copied.')))} testId="code-copy" />
      </>}
    >
      <div className="ds-controls" data-testid="code-section">
        <div className="hint" title={code.import}>{code.file}</div>
        {props.map((p) => {
          const value = code.props[p.name];
          const isSet = value !== undefined;
          const reset = isSet ? <IconButton icon={<RotateCcw size={12} />} title={t('Back to the default of {name}', { name: p.name })} onClick={() => set(p.name, undefined)} tabIndex={-1} /> : null;
          const label = <span className={`ds-prop-label${isSet ? ' is-set' : ''}`} title={p.description}>{p.name}</span>;
          if (p.type === 'enum' && p.options?.length) {
            const options = [{ value: UNSET, label: p.default !== undefined ? t('{value} (default)', { value: String(p.default) }) : t('(default)') }, ...p.options.map((o) => ({ value: o, label: o }))];
            return <div key={p.name} className="ds-control"><SelectField label={label} value={typeof value === 'string' ? value : UNSET} options={options} onChange={(v) => set(p.name, v === UNSET ? undefined : v)} testId={`code-prop-${p.name}`} />{reset}</div>;
          }
          if (p.type === 'boolean') {
            return (
              <label key={p.name} className="ds-toggle" title={p.description ?? (isSet ? t('Set on this layer') : t("The component's default"))}>
                {label}
                <input type="checkbox" checked={Boolean(value ?? p.default)} data-testid={`code-prop-${p.name}`} onChange={(e) => set(p.name, e.target.checked)} />
              </label>
            );
          }
          return (
            <div key={p.name} className="ds-control">
              <TextField
                className={isSet ? 'is-set' : ''}
                label={label}
                value={shown(value)}
                placeholder={p.default !== undefined ? shown(p.default) : p.type === 'json' ? 'JSON' : ''}
                onChange={(text) => {
                  try {
                    set(p.name, parse(p, text));
                  } catch (e) {
                    editor().showToast((e as Error).message);
                  }
                }}
                testId={`code-prop-${p.name}`}
              />
              {reset}
            </div>
          );
        })}
        {info === null && !props.length ? <div className="hint">{t('No props found in the source. Agents can set any with {tool}.', { tool: 'code_component_update' })}</div> : null}
      </div>
    </Section>
  );
}
