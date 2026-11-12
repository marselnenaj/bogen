import { useMemo, useState } from 'react';
import { designSystemCss, renameToken, setTokenMode, type Token, type TokenKind } from '@bogen/core';
import { Copy, FolderGit2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useModes, useTokens } from '../doc/hooks.ts';
import { ModeBar, TextStylesList, useEditingMode } from './ModeBar.tsx';
import { session } from '../doc/session.ts';
import { ColorField } from '../ui/ColorPicker.tsx';
import { copyText, Empty, IconButton, SelectField, TextField } from '../ui/controls.tsx';
import { editor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { useLinkedProject } from '../lib/code-api.ts';
import { OmarchyPaletteButton } from './OmarchyPalette.tsx';
import { OmarchyThemeButton } from './OmarchyTheme.tsx';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

const KINDS: { kind: TokenKind; label: string; placeholder: string; tailwind: string }[] = [
  { kind: 'color', label: msg('Colours'), placeholder: '#3b82f6', tailwind: 'color' },
  { kind: 'radius', label: msg('Radius'), placeholder: '8px', tailwind: 'radius' },
  { kind: 'spacing', label: msg('Spacing'), placeholder: '16px', tailwind: 'spacing' },
  { kind: 'container', label: msg('Containers'), placeholder: '1200px', tailwind: 'container' },
  { kind: 'breakpoint', label: msg('Breakpoints'), placeholder: '768px', tailwind: 'breakpoint' },
  { kind: 'font-family', label: msg('Font families'), placeholder: '"Inter", sans-serif', tailwind: 'font' },
  { kind: 'font-weight', label: msg('Font weights'), placeholder: '600', tailwind: 'font-weight' },
  { kind: 'font-size', label: msg('Font sizes'), placeholder: '16px', tailwind: 'text' },
  { kind: 'line-height', label: msg('Line heights'), placeholder: '1.5', tailwind: 'leading' },
  { kind: 'letter-spacing', label: msg('Letter spacing'), placeholder: '0.02em', tailwind: 'tracking' },
];

export function tokensAsCss(tokens: Token[]): string {
  return `:root {\n${tokens.map((t) => `  --${t.name}: ${t.value};`).join('\n')}\n}\n`;
}

export function tokensAsTailwind(tokens: Token[]): string {
  const byKind = new Map(KINDS.map((k) => [k.kind, k.tailwind]));
  const strip = (name: string, prefix: string) => (name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : name);
  return `@theme {\n${tokens.map((t) => {
    const ns = byKind.get(t.kind) ?? t.kind;
    return `  --${ns}-${strip(t.name, ns)}: ${t.value};`;
  }).join('\n')}\n}\n`;
}

function TokenRow({ token }: { token: Token }) {
  const t = useT();
  const s = session();
  const modes = useModes();
  const editing = useEditingMode((st) => st.mode);
  // In a mode other than the base one, a row shows and edits that mode's value.
  const mode = modes.find((m) => m.name === editing && !m.base)?.name;
  const own = mode ? token.modes?.[mode] : undefined;
  const shown = own ?? token.value;
  const rename = (next: string) => {
    const name = next.trim().replace(/^--/, '').replace(/\s+/g, '-');
    if (!name || name === token.name) return;
    try {
      // Everything bound to the token follows the new name.
      s.tx(() => renameToken(s.doc, token.name, name));
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const setValue = (value: string) => {
    if (!value) return;
    s.tx(() => {
      if (mode) setTokenMode(s.doc, token.name, mode, value);
      else s.doc.setToken(token.name, token.kind, value);
    });
  };
  return (
    <div className={`token-row${mode && own === undefined ? ' is-from-base' : ''}`} data-testid="token-row" data-token={token.name}>
      <TextField className="token-name" value={token.name} onChange={rename} testId={`token-name-${token.name}`} />
      {token.kind === 'color'
        ? <ColorField value={shown} onChange={setValue} testId={`token-color-${token.name}`} />
        : <TextField className="token-value" value={shown} onChange={setValue} testId={`token-value-${token.name}`} />}
      {mode && own !== undefined ? <IconButton className="token-reset" icon={<RotateCcw size={12} />} title={t('Use the base value in {mode}', { mode })} onClick={() => s.tx(() => setTokenMode(s.doc, token.name, mode, null))} tabIndex={-1} testId={`token-reset-${token.name}`} /> : null}
      <IconButton className="row-action" icon={<Trash2 size={13} />} title={t('Delete {token}', { token: `--${token.name}` })} onClick={() => s.tx(() => s.doc.deleteToken(token.name))} tabIndex={-1} testId={`token-delete-${token.name}`} />
    </div>
  );
}

export function TokensPanel() {
  const t = useT();
  const tokens = useTokens();
  const [kind, setKind] = useState<TokenKind>('color');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const groups = useMemo(() => KINDS.map((k) => ({ ...k, list: tokens.filter((t) => t.kind === k.kind) })).filter((g) => g.list.length), [tokens]);
  const def = KINDS.find((k) => k.kind === kind)!;
  const s = session();
  const project = useLinkedProject();

  const add = () => {
    const n = name.trim().replace(/^--/, '').replace(/\s+/g, '-');
    const v = value.trim() || (kind === 'color' ? '#3b82f6' : def.placeholder);
    if (!n) return;
    try {
      s.tx(() => s.doc.setToken(n, kind, v));
      setName('');
      setValue('');
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };

  return (
    <div className="tokens" data-testid="tokens">
      <ModeBar />
      <div className="token-add">
        <SelectField<TokenKind> value={kind} options={KINDS.map((k) => ({ value: k.kind, label: t(k.label) }))} onChange={setKind} testId="token-kind" title={t('Kind')} />
        <div className="token-add-row">
          <input className="token-input" placeholder={t('Name')} value={name} data-testid="token-new-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} spellCheck={false} />
          <input className="token-input" placeholder={def.placeholder} value={value} data-testid="token-new-value" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') add(); }} spellCheck={false} />
          <IconButton icon={<Plus size={14} />} title={t('Add token')} onClick={add} disabled={!name.trim()} testId="token-add" />
        </div>
      </div>
      <div className="token-scroll">
        {!tokens.length ? <Empty title={t('No tokens yet')} hint={t('Tokens are CSS variables. Name a value above, then bind it from any colour field.')} /> : null}
        {groups.map((g) => (
          <div key={g.kind} className="token-group">
            <div className="token-group-title">{t(g.label)}</div>
            {g.list.map((tok) => <TokenRow key={tok.name} token={tok} />)}
          </div>
        ))}
        <TextStylesList />
      </div>
      <OmarchyPaletteButton />
      <OmarchyThemeButton />
      {tokens.length || project ? (
        <div className="token-actions">
          {project ? <button type="button" className="btn btn-quiet" data-testid="token-repo" title={t('The tokens of {project} next to these: pull them in, or push these as a pull request', { project: project.name })} onClick={() => ui().set({ repoTokensOpen: true })}><FolderGit2 size={14} /> {project.name}</button> : null}
          {tokens.length ? (
            <>
              <button type="button" className="btn btn-quiet" data-testid="token-copy-css" onClick={() => void copyText(designSystemCss(s.doc) || tokensAsCss(tokens)).then(() => editor().showToast(t('Copied as CSS variables')))}><Copy size={14} /> {t('Copy CSS')}</button>
              <button type="button" className="btn btn-quiet" data-testid="token-copy-tailwind" onClick={() => void copyText(tokensAsTailwind(tokens)).then(() => editor().showToast(t('Copied as Tailwind theme')))}><Copy size={14} /> {t('Copy Tailwind')}</button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
