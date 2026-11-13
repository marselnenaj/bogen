import { BrandBook } from './BrandBook.tsx';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ALL_LANGUAGES, bindingFields, brandCounts, brandLanguages, brandSuggestions, brandVersions, confirmBrandItems, confirmSuggestions, contrastRatio, deleteBrandItem, dismissSuggestions, markBrandFields, normalizeLanguageTag, readBrand, resolveBrandColor, setBrandField, upsertBrandItem, voiceProfile, type BrandColor, type BrandData, type BrandFields, type BrandRule, type BrandRuleCheck, type BrandSection } from '@bogen/core';
import { ArrowLeft, Check, Download, FilePlus2, Plus, Redo2, Trash2, Undo2, Upload, X } from 'lucide-react';
import { Session, setSession } from '../doc/session.ts';
import { api, downloadBlob, resolveAsset } from '../lib/api.ts';
import { brandApi, type BrandChange, type BrandFull, type FileImpact } from '../lib/brand-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { ColorField } from '../ui/ColorPicker.tsx';
import { IconButton, NumberField, Segmented, SelectField, TextField } from '../ui/controls.tsx';
import { BrandHealth } from './BrandHealth.tsx';
import { BrandReview } from './BrandReview.tsx';
import { MemorySuggestions } from './MemorySuggestions.tsx';
import { languageLabel, languageOptions } from './ContentLanguage.tsx';
import { type Translate, ctx, msg } from '../i18n/core.ts';
import { formatDateTime } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';

/** The logo's clear space, as a short field label: not the Clear button. */
const CLEAR_SPACE = ctx('logo clear space, short field label', 'Clear');

type Tab = 'book' | 'review' | 'health' | 'identity' | 'logos' | 'colors' | 'type' | 'layout' | 'imagery' | 'voice' | 'rules' | 'examples' | 'assets' | 'versions';
/** Where each kind of suggestion is edited. */
const TAB_OF_SECTION: Record<string, Tab> = {
  fields: 'identity', colors: 'colors', pairings: 'colors', logos: 'logos', families: 'type', typeScale: 'type', spacing: 'layout', radius: 'layout', rules: 'rules', words: 'voice', voiceExamples: 'voice', artboards: 'examples', assets: 'assets',
};
const TABS: { id: Tab; label: string }[] = [
  { id: 'book', label: msg('Brandbook') },
  { id: 'review', label: msg('Review suggestions') },
  { id: 'health', label: msg('Across files') },
  { id: 'identity', label: msg('Identity') }, { id: 'logos', label: msg('Logos') }, { id: 'colors', label: msg('Colour') }, { id: 'type', label: msg('Typography') }, { id: 'layout', label: msg('Spacing and layout') },
  { id: 'imagery', label: msg('Imagery and icons') }, { id: 'voice', label: msg('Voice') }, { id: 'rules', label: msg('Rules') }, { id: 'examples', label: msg('Examples') }, { id: 'assets', label: msg('Assets') }, { id: 'versions', label: msg('Versions') },
];

/** The brand as an open document, read again after each change. */
function useBrandData(s: Session | null): BrandData | null {
  const store = useMemo(() => {
    if (!s) return null;
    let data = readBrand(s.doc);
    return {
      subscribe: (fn: () => void) => {
        const on = (tx: { changed: Map<unknown, unknown> }) => {
          if (!tx.changed.size) return;
          data = readBrand(s.doc);
          fn();
        };
        s.y.on('afterTransaction', on as never);
        return () => s.y.off('afterTransaction', on as never);
      },
      get: () => data,
    };
  }, [s]);
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, store?.get ?? NO_DATA);
}

const NO_SUBSCRIBE = () => () => {};
const NO_DATA = () => null;

/**
 * `fail` shows why something did not happen, such as a value the brand cannot hold or a file that did not upload.
 * `bound` is the fields as they bind: what the panel shows, with a proposal beside it rather than in it.
 */
interface Ctx { s: Session; data: BrandData; bound: BrandFields; brandId: string; fail: (message: string | null) => void }

function put(ctx: Ctx, section: BrandSection, patch: Record<string, unknown>) {
  try {
    ctx.s.tx(() => upsertBrandItem(ctx.s.doc, section, patch));
    ctx.fail(null);
  } catch (e) {
    // The field goes back to what is stored, so say why rather than leave it looking like a lost keystroke.
    ctx.fail((e as Error).message);
  }
}

/** An upload and what follows it, with its failure shown on the page. */
function attempt(ctx: Ctx, work: () => Promise<void>): void {
  ctx.fail(null);
  work().catch((e: Error) => ctx.fail(e.message));
}

function setField<K extends keyof BrandFields>(ctx: Ctx, key: K, value: BrandFields[K]) {
  ctx.s.tx(() => {
    setBrandField(ctx.s.doc, key, value);
    if (ctx.data.suggestedFields.includes(key)) markBrandFields(ctx.s.doc, [key], false);
  });
}

/**
 * A field an agent proposed, shown beside the field rather than in it: the field keeps what binds, and the proposal can
 * be confirmed or dismissed here as in the Review tab. Editing the field yourself replaces the proposal.
 */
function Proposed({ ctx, field, show }: { ctx: Ctx; field: keyof BrandFields; show?: (value: BrandFields[keyof BrandFields]) => string }) {
  const t = useT();
  if (!ctx.data.suggestedFields.includes(field)) return null;
  const value = ctx.data.fields[field];
  const text = show ? show(value) : typeof value === 'boolean' ? (value ? t('On') : t('Off')) : Array.isArray(value) ? value.join(', ') || t('none') : value === '' ? t('none') : String(value);
  const act = (confirm: boolean) => {
    const previous = brandVersions(ctx.s.doc).at(-1)?.data;
    const row = brandSuggestions(ctx.data, previous).find((r) => r.key === `field:${field}`);
    if (!row) return;
    ctx.s.tx(() => (confirm ? confirmSuggestions(ctx.s.doc, [row]) : dismissSuggestions(ctx.s.doc, [row], previous)));
  };
  return (
    <span className="bp-proposed" data-testid={`brand-proposed-${field}`} title={t('A suggestion. It binds nobody until you confirm it.')}>
      <span className="bp-proposed-value" dir="auto">{t('Proposed: {value}', { value: text })}</span>
      <IconButton icon={<Check size={12} />} title={t('Confirm {name}', { name: text })} onClick={() => act(true)} testId="brand-proposed-confirm" />
      <IconButton icon={<X size={12} />} title={t('Dismiss {name}', { name: text })} onClick={() => act(false)} testId="brand-proposed-dismiss" />
    </span>
  );
}

/** The label of a choice, for a proposal of it. */
function labelOf<T extends string>(options: { value: T; label: string }[]): (value: unknown) => string {
  return (value) => options.find((o) => o.value === value)?.label ?? String(value);
}

/**
 * The language a word, an example or a text rule belongs to, in a brand of several languages: the primary (left
 * unmarked), another of its languages, or all of them.
 */
function ItemLanguage({ ctx, section, item }: { ctx: Ctx; section: 'words' | 'voiceExamples' | 'rules'; item: { id: string; lang?: string } }) {
  const t = useT();
  const langs = brandLanguages(ctx.data);
  if (langs.all.length < 2 && !item.lang) return null;
  const options = [
    { value: '', label: langs.primary ? languageLabel(langs.primary) : t('Language: not set') },
    ...langs.additional.map((tag) => ({ value: tag, label: languageLabel(tag) })),
    ...(item.lang && item.lang !== ALL_LANGUAGES && !langs.all.includes(item.lang) ? [{ value: item.lang, label: languageLabel(item.lang) }] : []),
    { value: ALL_LANGUAGES, label: t('All languages') },
  ];
  const value = item.lang && item.lang !== langs.primary ? item.lang : '';
  return <SelectField<string> className="w-m" value={value} options={options} onChange={(v) => put(ctx, section, { id: item.id, lang: v || undefined })} title={t('Language')} testId="brand-item-language" />;
}

function Suggested({ ctx, id, source }: { ctx: Ctx; id: string; source?: string | undefined }) {
  const t = useT();
  return (
    <button type="button" className="bp-suggested" title={source ? t('A suggestion from {source}. It binds nobody until you confirm it.', { source }) : t('A suggestion. It binds nobody until you confirm it.')} data-testid="brand-confirm-item" onClick={() => ctx.s.tx(() => confirmBrandItems(ctx.s.doc, [id]))}>
      <Check size={12} /> {t('Confirm')}
    </button>
  );
}

/** `what` is the item's own name; `label` the whole title when the item has none. */
function Remove({ ctx, id, what, label }: { ctx: Ctx; id: string; what?: string; label?: string }) {
  const t = useT();
  return <IconButton className="bp-row-action" icon={<Trash2 size={13} />} title={label ?? t('Remove {name}', { name: what ?? '' })} onClick={() => ctx.s.tx(() => deleteBrandItem(ctx.s.doc, id))} tabIndex={-1} />;
}

function Group({ title, hint, actions, children }: { title: string; hint?: string; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="bp-group" data-group={title}>
      <header className="bp-group-head"><span className="bp-group-title">{title}</span><span className="row">{actions}</span></header>
      {hint ? <div className="bp-group-hint">{hint}</div> : null}
      {children}
    </section>
  );
}

function AddButton({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return <button type="button" className="btn btn-quiet" onClick={onClick} data-testid={testId}><Plus size={14} /> {label}</button>;
}

function Area({ value, onChange, placeholder, testId }: { value: string; onChange: (v: string) => void; placeholder?: string; testId?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <textarea
      className="bp-area"
      rows={2}
      value={text ?? value}
      placeholder={placeholder}
      data-testid={testId}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onChange(text);
        setText(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          setText(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function FileButton({ label, accept, onFile, testId }: { label: string; accept: string; onFile: (file: File) => void; testId?: string }) {
  return (
    <label className="btn btn-quiet bp-file" data-testid={testId}>
      <Upload size={14} /> {label}
      <input type="file" accept={accept} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </label>
  );
}

// ---------------------------------------------------------------- sections

function Identity({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const fields = ctx.bound;
  return (
    <Group title={t('Identity')} hint={t('Who this is, for whom, in one line each.')}>
      <div className="bp-rows">
        <div className="bp-row"><TextField label={t('Name')} value={fields.name} onChange={(v) => setField(ctx, 'name', v)} testId="brand-field-name" /><Proposed ctx={ctx} field="name" /></div>
        <div className="bp-row"><TextField label={t('Positioning')} value={fields.positioning} onChange={(v) => setField(ctx, 'positioning', v)} placeholder={t('What it is, in one line')} testId="brand-field-positioning" /><Proposed ctx={ctx} field="positioning" /></div>
        <div className="bp-row"><TextField label={t('Audience')} value={fields.audience} onChange={(v) => setField(ctx, 'audience', v)} placeholder={t('Who it is for')} testId="brand-field-audience" /><Proposed ctx={ctx} field="audience" /></div>
      </div>
    </Group>
  );
}

function backgroundOf(data: BrandData, spec: string): string {
  return resolveBrandColor(data, spec)?.value ?? (spec === 'dark' ? '#111111' : '#ffffff');
}

function Logos({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const add = async (file: File) => {
    const uploaded = await api.upload(file, file.type || (file.name.endsWith('.svg') ? 'image/svg+xml' : undefined));
    const svg = file.type === 'image/svg+xml' || file.name.endsWith('.svg') ? await file.text() : undefined;
    put(ctx, 'logos', { name: file.name.replace(/\.\w+$/, ''), asset: uploaded.src, ...(svg ? { svg } : {}), background: 'any', minWidth: 24, clearSpace: 8 });
  };
  const backgrounds = [{ value: 'any', label: t('Any') }, { value: 'light', label: t('Light') }, { value: 'dark', label: t('Dark') }, ...ctx.data.colors.map((c) => ({ value: c.id, label: c.name }))];
  return (
    <Group title={t('Logos')} hint={t('Each variant says which background it is for, its minimum width and its clear space. Agents get the right one through brand_asset_use.')} actions={<FileButton label={t('Add a variant')} accept="image/*,.svg" onFile={(f) => attempt(ctx, () => add(f))} testId="brand-logo-add" />}>
      <div className="bp-rows">
        {ctx.data.logos.map((l) => (
          <div key={l.id} className="bp-row" data-testid="brand-logo-row">
            <div className="bp-logo-pic" style={{ background: backgroundOf(ctx.data, l.background) }}>{l.asset ? <img src={resolveAsset(l.asset)} alt={l.name} /> : null}</div>
            <TextField value={l.name} onChange={(v) => put(ctx, 'logos', { id: l.id, name: v })} />
            <SelectField className="w-m" value={l.background} options={backgrounds} onChange={(v) => put(ctx, 'logos', { id: l.id, background: v })} title={t('Background this variant is for')} />
            <NumberField className="w-s" label={t('Min')} suffix="px" value={l.minWidth} min={0} onChange={(v) => put(ctx, 'logos', { id: l.id, minWidth: v })} title={t('Minimum width')} />
            <NumberField className="w-s" label={t(CLEAR_SPACE)} suffix="px" value={l.clearSpace} min={0} onChange={(v) => put(ctx, 'logos', { id: l.id, clearSpace: v })} title={t('Clear space around it')} />
            {l.suggested ? <Suggested ctx={ctx} id={l.id} source={l.source} /> : null}
            <Remove ctx={ctx} id={l.id} what={l.name} />
          </div>
        ))}
      </div>
    </Group>
  );
}

function PairCell({ ctx, fg, bg }: { ctx: Ctx; fg: BrandColor; bg: BrandColor }) {
  const t = useT();
  const listed = ctx.data.pairings.find((p) => resolveBrandColor(ctx.data, p.fg)?.id === fg.id && resolveBrandColor(ctx.data, p.bg)?.id === bg.id);
  const ratio = contrastRatio(fg.value, bg.value);
  const effective = listed?.verdict ?? (ctx.bound.pairingDefault === 'forbid' ? 'forbid' : 'allow');
  const cycle = () => {
    // Unset, allowed, forbidden, and back.
    if (!listed) put(ctx, 'pairings', { fg: fg.id, bg: bg.id, verdict: 'allow' });
    else if (listed.verdict === 'allow') put(ctx, 'pairings', { id: listed.id, verdict: 'forbid' });
    else ctx.s.tx(() => deleteBrandItem(ctx.s.doc, listed.id));
  };
  return (
    <td>
      <button
        type="button"
        className={`bp-pair${effective === 'forbid' ? ' is-forbid' : ''}${listed?.verdict === 'allow' ? ' is-allow' : ''}`}
        style={{ background: bg.value, color: fg.value }}
        title={pairTitle(t, fg.name, bg.name, ratio, listed ? listed.verdict : null, effective)}
        data-testid="brand-pair"
        data-fg={fg.name}
        data-bg={bg.name}
        data-verdict={listed?.verdict ?? ''}
        onClick={cycle}
      >
        Aa<small>{ratio.toFixed(1)}</small>
      </button>
    </td>
  );
}

function pairTitle(t: Translate, fg: string, bg: string, ratio: number, listed: 'allow' | 'forbid' | null, effective: 'allow' | 'forbid'): string {
  const vars = { fg, bg, ratio };
  if (listed === 'allow') return t('{fg} on {bg}: {ratio}:1, allow. Click to change.', vars);
  if (listed === 'forbid') return t('{fg} on {bg}: {ratio}:1, forbid. Click to change.', vars);
  return effective === 'forbid' ? t('{fg} on {bg}: {ratio}:1, not listed, so forbid. Click to change.', vars) : t('{fg} on {bg}: {ratio}:1, not listed, so allow. Click to change.', vars);
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function Colours({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const { colors } = ctx.data;
  const fields = ctx.bound;
  const pairOptions = [{ value: 'allow' as const, label: t('Unlisted pairs are allowed') }, { value: 'forbid' as const, label: t('Only listed pairs are allowed') }];
  const paletteOptions = [{ value: 'hard' as const, label: t('Off palette: must not') }, { value: 'soft' as const, label: t('Off palette: should not') }];
  const add = () => put(ctx, 'colors', { name: `Colour ${colors.length + 1}`, role: '', value: '#808080' });
  return (
    <>
      <Group title={t('Palette')} hint={t('Each colour has a role and a token. The token is written into linked files as var(--name).')} actions={<AddButton label={t('Colour')} onClick={add} testId="brand-color-add" />}>
        <div className="bp-rows">
          {colors.map((c) => (
            <div key={c.id} className="bp-row" data-testid="brand-color-row" data-color={c.name}>
              <ColorField value={c.value} onChange={(v) => put(ctx, 'colors', { id: c.id, value: v })} testId={`brand-color-value-${c.name}`} />
              <TextField value={c.name} onChange={(v) => put(ctx, 'colors', { id: c.id, name: v, ...(c.token === slugOf(c.name) && slugOf(v) ? { token: slugOf(v) } : {}) })} placeholder={t('Name')} testId={`brand-color-name-${c.name}`} />
              <TextField className="w-m" value={c.role} onChange={(v) => put(ctx, 'colors', { id: c.id, role: v })} placeholder={t('Role')} />
              <TextField className="w-m" label="--" value={c.token} onChange={(v) => put(ctx, 'colors', { id: c.id, token: v.replace(/^--/, '') })} />
              {c.suggested ? <Suggested ctx={ctx} id={c.id} source={c.source} /> : null}
              <Remove ctx={ctx} id={c.id} what={c.name} />
            </div>
          ))}
        </div>
      </Group>
      <Group title={t('Pairings')} hint={t('Foreground in rows, background in columns, with the contrast computed. Click a cell to allow it, forbid it, or clear it. A blue edge is allowed, a line through is forbidden.')}>
        <div className="bp-row" style={{ borderTop: 0 }}>
          <SelectField<BrandFields['pairingDefault']> value={fields.pairingDefault} options={pairOptions} onChange={(v) => setField(ctx, 'pairingDefault', v)} testId="brand-pair-default" />
          <Proposed ctx={ctx} field="pairingDefault" show={labelOf(pairOptions)} />
          <NumberField className="w-m" label={t('Contrast')} value={fields.minContrast} min={1} max={21} step={0.5} onChange={(v) => setField(ctx, 'minContrast', v)} title={t('Minimum text contrast')} />
          <Proposed ctx={ctx} field="minContrast" />
          <SelectField<BrandFields['offPalette']> className="w-m" value={fields.offPalette} options={paletteOptions} onChange={(v) => setField(ctx, 'offPalette', v)} />
          <Proposed ctx={ctx} field="offPalette" show={labelOf(paletteOptions)} />
        </div>
        {colors.length > 1 ? (
          <div style={{ overflow: 'auto' }}>
            <table className="bp-matrix" data-testid="brand-pair-matrix">
              <thead><tr><th />{colors.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
              <tbody>{colors.map((fg) => <tr key={fg.id}><th>{fg.name}</th>{colors.map((bg) => <PairCell key={bg.id} ctx={ctx} fg={fg} bg={bg} />)}</tr>)}</tbody>
            </table>
          </div>
        ) : null}
      </Group>
    </>
  );
}

function numberList(value: string): number[] {
  return value.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

function Typography({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const { families, typeScale } = ctx.data;
  const familyOptions = [{ value: '', label: t('Any family') }, ...families.map((f) => ({ value: f.id, label: f.family }))];
  const addFile = async (familyId: string, assets: string[], file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const type = file.type || ({ woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' } as Record<string, string>)[ext];
    const uploaded = await api.upload(file, type);
    put(ctx, 'families', { id: familyId, assets: [...assets, uploaded.src] });
  };
  return (
    <>
      <Group title={t('Families')} actions={<AddButton label={t('Family')} onClick={() => put(ctx, 'families', { family: 'Inter', role: 'body', weights: [400, 600] })} testId="brand-family-add" />}>
        <div className="bp-rows">
          {families.map((f) => (
            <div key={f.id} className="bp-group" data-testid="brand-family-row" style={{ borderTop: '1px solid var(--ui-border)', paddingBottom: 4 }}>
              <div className="bp-row" style={{ borderTop: 0 }}>
                <TextField value={f.family} onChange={(v) => put(ctx, 'families', { id: f.id, family: v })} placeholder={t('Family')} testId={`brand-family-name-${f.family}`} />
                <TextField className="w-s" value={f.role} onChange={(v) => put(ctx, 'families', { id: f.id, role: v })} placeholder={t('Role')} />
                <TextField className="w-m" label={t('Wt')} value={f.weights.join(', ')} onChange={(v) => put(ctx, 'families', { id: f.id, weights: numberList(v) })} title={t('Weights')} />
                {f.suggested ? <Suggested ctx={ctx} id={f.id} source={f.source} /> : null}
                <Remove ctx={ctx} id={f.id} what={f.family} />
              </div>
              <div className="bp-row" style={{ borderTop: 0 }}>
                <TextField value={f.fallback} onChange={(v) => put(ctx, 'families', { id: f.id, fallback: v })} placeholder={t('Fallback')} />
                <TextField value={f.license} onChange={(v) => put(ctx, 'families', { id: f.id, license: v })} placeholder={t('Licence note')} />
                <FileButton label={f.assets.length ? t.n(f.assets.length, '{count} file', '{count} files') : t('Font file')} accept=".woff2,.woff,.ttf,.otf" onFile={(file) => attempt(ctx, () => addFile(f.id, f.assets, file))} />
              </div>
            </div>
          ))}
        </div>
      </Group>
      <Group title={t('Scale')} actions={<AddButton label={t('Step')} onClick={() => put(ctx, 'typeScale', { name: `Step ${typeScale.length + 1}`, size: 16, weight: 400 })} testId="brand-step-add" />}>
        <div className="bp-rows">
          {typeScale.map((step) => {
            const fam = families.find((f) => f.id === step.family || f.family === step.family);
            return (
              <div key={step.id} className="bp-row" data-testid="brand-step-row">
                <TextField className="w-m" value={step.name} onChange={(v) => put(ctx, 'typeScale', { id: step.id, name: v })} placeholder={t('Name')} />
                <NumberField className="w-s" suffix="px" value={step.size} min={1} onChange={(v) => put(ctx, 'typeScale', { id: step.id, size: v })} title={t('Size')} />
                <NumberField className="w-xs" value={step.weight} min={0} max={1000} step={100} onChange={(v) => put(ctx, 'typeScale', { id: step.id, weight: v })} title={t('Weight')} />
                <TextField className="w-xs" value={step.lineHeight} onChange={(v) => put(ctx, 'typeScale', { id: step.id, lineHeight: v })} placeholder={t('LH')} title={t('Line height')} />
                <TextField className="w-xs" value={step.tracking} onChange={(v) => put(ctx, 'typeScale', { id: step.id, tracking: v })} placeholder={t('Trk')} title={t('Tracking')} />
                <SelectField className="w-m" value={fam?.id ?? ''} options={familyOptions} onChange={(v) => put(ctx, 'typeScale', { id: step.id, family: v })} title={t('Family')} />
                {step.suggested ? <Suggested ctx={ctx} id={step.id} source={step.source} /> : null}
                <Remove ctx={ctx} id={step.id} what={step.name} />
              </div>
            );
          })}
        </div>
      </Group>
    </>
  );
}

function SizeList({ ctx, section, title, hint }: { ctx: Ctx; section: 'spacing' | 'radius'; title: string; hint: string }) {
  const t = useT();
  const list = ctx.data[section];
  return (
    <Group title={title} hint={hint} actions={<AddButton label={t('Step')} onClick={() => put(ctx, section, { name: String((list.at(-1)?.value ?? 0) + 8), value: (list.at(-1)?.value ?? 0) + 8 })} testId={`brand-${section}-add`} />}>
      <div className="bp-rows">
        {list.map((s) => (
          <div key={s.id} className="bp-row" data-testid={`brand-${section}-row`}>
            <NumberField className="w-s" suffix="px" value={s.value} min={0} onChange={(v) => put(ctx, section, { id: s.id, value: v })} />
            <TextField value={s.name} onChange={(v) => put(ctx, section, { id: s.id, name: v })} placeholder={t('Name')} />
            <TextField className="w-m" label="--" value={s.token} onChange={(v) => put(ctx, section, { id: s.id, token: v.replace(/^--/, '') })} />
            {s.suggested ? <Suggested ctx={ctx} id={s.id} source={s.source} /> : null}
            <Remove ctx={ctx} id={s.id} what={s.name} />
          </div>
        ))}
      </div>
    </Group>
  );
}

function Layout({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const fields = ctx.bound;
  const shadowOptions = [{ value: 'any' as const, label: t('Shadows are fine') }, { value: 'none' as const, label: t('No shadows') }];
  const gradientOptions = [{ value: 'any' as const, label: t('Gradients are fine') }, { value: 'none' as const, label: t('Flat colour only') }];
  return (
    <>
      <SizeList ctx={ctx} section="spacing" title={t('Spacing scale')} hint={t('Padding, margins and gaps come from these.')} />
      <SizeList ctx={ctx} section="radius" title={t('Radius')} hint={t('Corners come from these. Add 0 if the brand has square corners.')} />
      <Group title={t('Layout')}>
        <div className="bp-rows">
          <div className="bp-row">
            <SelectField<BrandFields['shadows']> value={fields.shadows} options={shadowOptions} onChange={(v) => setField(ctx, 'shadows', v)} testId="brand-shadows" />
            <Proposed ctx={ctx} field="shadows" show={labelOf(shadowOptions)} />
            <SelectField<BrandFields['gradients']> value={fields.gradients} options={gradientOptions} onChange={(v) => setField(ctx, 'gradients', v)} testId="brand-gradients" />
            <Proposed ctx={ctx} field="gradients" show={labelOf(gradientOptions)} />
            <NumberField className="w-m" label={t('Width')} suffix="px" value={fields.container} min={0} onChange={(v) => setField(ctx, 'container', v)} title={t('Container width')} />
            <Proposed ctx={ctx} field="container" />
          </div>
          <div className="bp-row"><TextField label={t('Grid')} value={fields.grid} onChange={(v) => setField(ctx, 'grid', v)} placeholder={t('Such as 12 columns, 24px gutter')} /><Proposed ctx={ctx} field="grid" /></div>
          <div className="bp-row is-tall"><Area value={fields.layoutNotes} onChange={(v) => setField(ctx, 'layoutNotes', v)} placeholder={t('Layout notes')} /><Proposed ctx={ctx} field="layoutNotes" /></div>
        </div>
      </Group>
      <RuleList ctx={ctx} title={t('Layout rules')} topics={['layout']} />
    </>
  );
}

const CHECKS: { value: string; label: string; make: (rule: BrandRule) => BrandRuleCheck | null }[] = [
  { value: '', label: msg('By eye'), make: () => null },
  { value: 'no-gradient', label: msg('No gradients'), make: () => ({ type: 'no-gradient' }) },
  { value: 'no-shadow', label: msg('No shadows'), make: () => ({ type: 'no-shadow' }) },
  { value: 'no-glow', label: msg('No glow or blur'), make: () => ({ type: 'no-glow' }) },
  { value: 'no-uppercase', label: msg('No all caps'), make: () => ({ type: 'no-uppercase' }) },
  { value: 'max-families', label: msg('At most 2 families'), make: () => ({ type: 'max-families', value: 2 }) },
  { value: 'forbid-text', label: msg('Text must not say'), make: (rule) => ({ type: 'forbid-text', value: rule.check && 'value' in rule.check && typeof rule.check.value === 'string' ? rule.check.value : 'word' }) },
  { value: 'require-text', label: msg('Text must say'), make: (rule) => ({ type: 'require-text', value: rule.check && 'value' in rule.check && typeof rule.check.value === 'string' ? rule.check.value : 'word' }) },
];

function RuleRow({ ctx, rule }: { ctx: Ctx; rule: BrandRule }) {
  const t = useT();
  return (
    <div className="bp-group" style={{ borderTop: '1px solid var(--ui-border)', padding: '4px 0' }} data-testid="brand-rule-row" data-severity={rule.severity} data-flagged={rule.flagged ? 'yes' : undefined}>
      <div className="row"><Area value={rule.text} onChange={(v) => put(ctx, 'rules', { id: rule.id, text: v })} placeholder={t('The rule')} testId="brand-rule-text" /></div>
      <div className="row">
        <Segmented<BrandRule['kind']> value={rule.kind} options={[{ value: 'do', label: t('Do'), title: t('Do this') }, { value: 'dont', label: t("Don't"), title: t('Do not do this') }]} onChange={(v) => put(ctx, 'rules', { id: rule.id, kind: v })} />
        <Segmented<BrandRule['severity']> value={rule.severity} testId="brand-rule-severity" options={[{ value: 'hard', label: t('Must'), title: t('Hard: agents treat it as a requirement') }, { value: 'soft', label: t('Should'), title: t('Soft: a default that can be broken for a reason') }]} onChange={(v) => put(ctx, 'rules', { id: rule.id, severity: v })} />
        <SelectField<string> value={rule.check?.type ?? ''} options={CHECKS.map((c) => ({ value: c.value, label: t(c.label) }))} onChange={(v) => { const make = CHECKS.find((c) => c.value === v)?.make(rule); put(ctx, 'rules', { id: rule.id, check: make ?? undefined }); }} title={t('How it is checked')} />
        {rule.check?.type === 'forbid-text' || rule.check?.type === 'require-text' ? <TextField className="w-m" value={rule.check.value} onChange={(v) => { if (v.trim()) put(ctx, 'rules', { id: rule.id, check: { type: rule.check!.type, value: v.trim() } }); }} title={t('The text')} testId="brand-rule-check-value" /> : null}
        {rule.check?.type === 'forbid-text' || rule.check?.type === 'require-text' || rule.lang ? <ItemLanguage ctx={ctx} section="rules" item={rule} /> : null}
        {rule.suggested ? <Suggested ctx={ctx} id={rule.id} source={rule.source} /> : null}
        <Remove ctx={ctx} id={rule.id} label={t('Remove this rule')} />
      </div>
      {rule.flagged ? <div className="bp-flag" data-testid="brand-rule-flagged">{t('This reads like an instruction to an agent, not a rule about a design. Agents ignore it until you rewrite it.')}</div> : null}
    </div>
  );
}

function RuleList({ ctx, title, hint, topics, topicForNew }: { ctx: Ctx; title: string; hint?: string; topics: BrandRule['topic'][]; topicForNew?: BrandRule['topic'] }) {
  const t = useT();
  const rules = ctx.data.rules.filter((r) => topics.includes(r.topic));
  return (
    <Group title={title} hint={hint} actions={<AddButton label={t('Rule')} onClick={() => put(ctx, 'rules', { text: 'New rule', kind: 'do', severity: 'soft', topic: topicForNew ?? topics[0] })} testId={`brand-rule-add-${topics[0]}`} />}>
      <div className="bp-rows">{rules.map((r) => <RuleRow key={r.id} ctx={ctx} rule={r} />)}</div>
    </Group>
  );
}

function Voice({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const { words, voiceExamples } = ctx.data;
  const fields = ctx.bound;
  return (
    <>
      <Languages ctx={ctx} />
      <Group title={t('Tone')}><div className="bp-row is-tall" style={{ borderTop: 0 }}><Area value={fields.tone} onChange={(v) => setField(ctx, 'tone', v)} placeholder={t('How it sounds')} testId="brand-field-tone" /><Proposed ctx={ctx} field="tone" /></div></Group>
      <VoiceMeasures ctx={ctx} />
      <Group title={t('Words')} hint={t('Words to avoid are checked in text layers, and words to use are checked for other spellings, such as Followup for Follow-up.')} actions={<AddButton label={t('Word')} onClick={() => put(ctx, 'words', { word: 'word', use: 'avoid' })} testId="brand-word-add" />}>
        <div className="bp-rows">
          {words.map((w) => (
            <div key={w.id} className="bp-row" data-testid="brand-word-row">
              <Segmented<'use' | 'avoid'> value={w.use} options={[{ value: 'use', label: t('Use'), title: t('A word to use') }, { value: 'avoid', label: t('Avoid'), title: t('A word to avoid') }]} onChange={(v) => put(ctx, 'words', { id: w.id, use: v })} />
              <TextField value={w.word} onChange={(v) => put(ctx, 'words', { id: w.id, word: v })} testId={`brand-word-${w.word}`} />
              {w.use === 'avoid' ? <TextField value={w.instead ?? ''} onChange={(v) => put(ctx, 'words', { id: w.id, instead: v })} placeholder={t('Say instead')} /> : null}
              <ItemLanguage ctx={ctx} section="words" item={w} />
              {w.suggested ? <Suggested ctx={ctx} id={w.id} source={w.source} /> : null}
              <Remove ctx={ctx} id={w.id} what={w.word} />
            </div>
          ))}
        </div>
      </Group>
      <Group title={t('Examples')} hint={t('Real sentences, good and bad.')} actions={<AddButton label={t('Example')} onClick={() => put(ctx, 'voiceExamples', { good: 'A good sentence' })} testId="brand-example-add" />}>
        <div className="bp-rows">
          {voiceExamples.map((e) => (
            <div key={e.id} className="bp-row is-tall" data-testid="brand-voice-row">
              <Area value={e.good} onChange={(v) => put(ctx, 'voiceExamples', { id: e.id, good: v })} placeholder={t('Good')} />
              <Area value={e.bad} onChange={(v) => put(ctx, 'voiceExamples', { id: e.id, bad: v })} placeholder={t('Bad')} />
              <ItemLanguage ctx={ctx} section="voiceExamples" item={e} />
              {e.suggested ? <Suggested ctx={ctx} id={e.id} source={e.source} /> : null}
              <Remove ctx={ctx} id={e.id} label={t('Remove this example')} />
            </div>
          ))}
        </div>
      </Group>
      <RuleList ctx={ctx} title={t('Voice rules')} topics={['voice']} />
    </>
  );
}

/**
 * What the voice check measures, as the brand states it. A field left empty is read from the brand's own words where
 * they say it, and the panel shows what it read and from where.
 */
function VoiceMeasures({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const fields = ctx.bound;
  const p = voiceProfile(ctx.data);
  const addressOptions = [{ value: '' as const, label: p.address && !fields.address ? t('Address: {address}, read', { address: p.address.value === 'du' ? 'du' : 'Sie' }) : t('Address: not set') }, { value: 'du' as const, label: t('{address}, never {other}', { address: 'du', other: 'Sie' }) }, { value: 'sie' as const, label: t('{address}, never {other}', { address: 'Sie', other: 'du' }) }];
  const numberOptions = [{ value: '' as const, label: p.numberFormat && !fields.numberFormat ? t('Numbers: {format}, read', { format: p.numberFormat.value === 'de' ? '1.000,50' : '1,000.50' }) : t('Numbers: not set') }, { value: 'de' as const, label: '1.000,50' }, { value: 'en' as const, label: '1,000.50' }];
  const read = (m: { from: string } | null, own: boolean) => (m && !own ? <span className="bp-note" title={m.from} data-testid="brand-voice-inferred">{t('Read from {source}', { source: m.from.replace(/^the /, '') })}</span> : null);
  return (
    <Group title={t('Measured in text')} hint={t("brand_check, design_lint and voice_check measure these in text layers. Leave a field empty, and Bogen reads it from the brand's own words where they say it.")} >
      <div className="bp-rows" data-testid="brand-voice-measures">
        <div className="bp-row">
          <SelectField<BrandFields['address']> className="w-m" value={fields.address} options={addressOptions} onChange={(v) => setField(ctx, 'address', v)} title={t('How a German text addresses the reader')} testId="brand-voice-address" />
          <Proposed ctx={ctx} field="address" show={labelOf(addressOptions)} />
          {read(p.address, Boolean(fields.address))}
        </div>
        <div className="bp-row">
          <NumberField className="w-m" label={t('Sentence')} suffix={t('words')} value={fields.sentenceWords || p.sentenceWords?.value || 0} min={0} max={200} onChange={(v) => setField(ctx, 'sentenceWords', v)} title={t('At most this many words in a sentence. 0 is no limit.')} testId="brand-voice-sentence" />
          <Proposed ctx={ctx} field="sentenceWords" />
          <NumberField className="w-m" label={t('Text')} suffix={t('sentences')} value={fields.paragraphSentences || p.paragraphSentences?.value || 0} min={0} max={50} onChange={(v) => setField(ctx, 'paragraphSentences', v)} title={t('At most this many sentences in one text. 0 is no limit.')} testId="brand-voice-paragraph" />
          <Proposed ctx={ctx} field="paragraphSentences" />
          {read(p.sentenceWords, Boolean(fields.sentenceWords))}
        </div>
        <div className="bp-row">
          <NumberField className="w-s" label={t('Heading')} value={fields.headingMinWords || p.headingWords?.value.min || 0} min={0} max={50} onChange={(v) => setField(ctx, 'headingMinWords', v)} title={t('At least this many words in an h1 or h2. 0 is no minimum.')} testId="brand-voice-heading-min" />
          <Proposed ctx={ctx} field="headingMinWords" />
          <NumberField className="w-s" label={t('to')} suffix={t('words')} value={fields.headingMaxWords || p.headingWords?.value.max || 0} min={0} max={50} onChange={(v) => setField(ctx, 'headingMaxWords', v)} title={t('At most this many words in an h1 or h2. 0 is no maximum.')} testId="brand-voice-heading-max" />
          <Proposed ctx={ctx} field="headingMaxWords" />
          <SelectField<BrandFields['numberFormat']> className="w-m" value={fields.numberFormat} options={numberOptions} onChange={(v) => setField(ctx, 'numberFormat', v)} testId="brand-voice-numbers" />
          <Proposed ctx={ctx} field="numberFormat" show={labelOf(numberOptions)} />
          {read(p.headingWords, Boolean(fields.headingMinWords || fields.headingMaxWords))}
        </div>
      </div>
    </Group>
  );
}

/**
 * The languages the brand speaks: a primary, and others. Words, examples and text rules belong to one of them, and
 * copy is checked in the language it is written in. The brandbook is not translated: each chapter keeps its own.
 */
function Languages({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const primary = ctx.bound.language;
  const others = ctx.bound.languages.filter((l) => l !== primary);
  const p = voiceProfile(ctx.data);
  const unset = p.language && !primary ? (p.language.value === 'de' ? t('Language: German, read') : p.language.value === 'en' ? t('Language: English, read') : t('Language: not set')) : t('Language: not set');
  const setPrimary = (tag: string) => ctx.s.tx(() => {
    setField(ctx, 'language', tag);
    // The primary is no longer one of the others. Read again: a primary that took over keeps the old one among them.
    const now = readBrand(ctx.s.doc).fields.languages;
    if (tag && now.includes(tag)) setField(ctx, 'languages', now.filter((x) => x !== tag));
  });
  const add = (tag: string) => {
    if (!tag || tag === primary || others.includes(tag)) return;
    if (!primary) setPrimary(tag);
    else setField(ctx, 'languages', [...others, tag]);
  };
  const applyCustom = () => {
    const tag = normalizeLanguageTag(custom);
    if (!tag) return setProblem(t('Not a language tag such as fr-CA or pt-BR.'));
    setProblem(null);
    setCustom('');
    add(tag);
  };
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.map((x) => languageLabel(String(x))).join(', ') : t('none'));
  return (
    <Group title={t('Languages')} hint={t('The languages this brand speaks. Copy is checked in the language it is written in, and agents write in it. Words, examples and text rules belong to the primary language unless you give them another.')}>
      <div className="bp-rows" data-testid="brand-languages">
        <div className="bp-row">
          <SelectField<string> className="w-l" label={t('Primary')} value={primary} options={[{ value: '', label: unset }, ...languageOptions([primary, ...others])]} onChange={setPrimary} testId="brand-voice-language" />
          <Proposed ctx={ctx} field="language" show={(v) => (v ? languageLabel(String(v)) : t('Language: not set'))} />
        </div>
        <div className="bp-row bp-langs">
          {others.map((tag) => (
            <span key={tag} className="bp-lang" data-testid="brand-language" data-lang={tag}>
              <span>{languageLabel(tag)}</span>
              <IconButton icon={<X size={12} />} title={t('Remove {name}', { name: languageLabel(tag) })} onClick={() => setField(ctx, 'languages', others.filter((x) => x !== tag))} testId="brand-language-remove" />
            </span>
          ))}
          <SelectField<string> className="w-m" value="" options={[{ value: '', label: t('Add a language') }, ...languageOptions([]).filter((o) => o.value !== primary && !others.includes(o.value))]} onChange={add} testId="brand-language-add" />
          <input
            className="field-input bp-lang-tag"
            value={custom}
            placeholder={t('Other language tag')}
            aria-label={t('Other language tag')}
            maxLength={20}
            spellCheck={false}
            onChange={(e) => { setCustom(e.target.value); setProblem(null); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
            }}
            data-testid="brand-language-custom"
          />
          <button type="button" className="btn btn-quiet" onClick={applyCustom} disabled={!custom.trim()}>{t('Use')}</button>
          <Proposed ctx={ctx} field="languages" show={list} />
        </div>
        {problem ? <div className="bp-flag" role="alert">{problem}</div> : null}
      </div>
    </Group>
  );
}

function Examples({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const { doc } = ctx.s;
  const boards = doc.getPages().flatMap((p) => doc.getChildren(p.id).filter((n) => n.type === 'frame').map((n) => ({ id: n.id, name: n.name, page: p.name })));
  const known = new Set(ctx.data.artboards.map((a) => a.nodeId));
  return (
    <>
      <Group title={t('Example artboards')} hint={t('Layers in this brand that show what good and bad look like. Templates can be copied into linked files.')} actions={<a className="btn btn-quiet" href={`#/file/${ctx.brandId}`} data-testid="brand-open-canvas">{t('Open the canvas')}</a>}>
        <div className="bp-rows">
          {ctx.data.artboards.map((a) => (
            <div key={a.id} className="bp-row" data-testid="brand-artboard-row">
              <TextField value={a.name} onChange={(v) => put(ctx, 'artboards', { id: a.id, name: v })} />
              <Segmented<'good' | 'bad'> value={a.verdict} options={[{ value: 'good', label: t('Good'), title: t('Shows what good looks like') }, { value: 'bad', label: t('Bad'), title: t('Shows what to avoid') }]} onChange={(v) => put(ctx, 'artboards', { id: a.id, verdict: v })} />
              <label className="check"><input type="checkbox" checked={Boolean(a.template)} onChange={(e) => put(ctx, 'artboards', { id: a.id, template: e.target.checked || undefined })} /><span>{t('Template')}</span></label>
              {a.suggested ? <Suggested ctx={ctx} id={a.id} source={a.source} /> : null}
              <Remove ctx={ctx} id={a.id} what={a.name} />
            </div>
          ))}
        </div>
      </Group>
      {boards.some((b) => !known.has(b.id)) ? (
        <Group title={t('On the canvas of this brand')} hint={t('Top-level frames not used as examples yet.')}>
          <div className="bp-rows">
            {boards.filter((b) => !known.has(b.id)).map((b) => (
              <div key={b.id} className="bp-row"><span className="bp-sample" dir="auto">{b.name}</span><span className="bp-note" dir="auto">{b.page}</span><AddButton label={t('Example')} onClick={() => put(ctx, 'artboards', { nodeId: b.id, name: b.name, verdict: 'good' })} /></div>
            ))}
          </div>
        </Group>
      ) : null}
    </>
  );
}

function Assets({ ctx }: { ctx: Ctx }) {
  const t = useT();
  const add = async (file: File) => {
    const uploaded = await api.upload(file, file.type);
    put(ctx, 'assets', { name: file.name.replace(/\.\w+$/, ''), asset: uploaded.src, kind: 'image', tags: [] });
  };
  return (
    <Group title={t('Image library')} hint={t('Stored by content, and synced with the brand. Agents find these by tag.')} actions={<FileButton label={t('Add an image')} accept="image/*" onFile={(f) => attempt(ctx, () => add(f))} testId="brand-asset-add" />}>
      <div className="bp-rows">
        {ctx.data.assets.map((a) => (
          <div key={a.id} className="bp-row" data-testid="brand-asset-row">
            <img className="bp-thumb" src={resolveAsset(a.asset)} alt={a.alt} />
            <TextField value={a.name} onChange={(v) => put(ctx, 'assets', { id: a.id, name: v })} />
            <TextField value={a.tags.join(', ')} onChange={(v) => put(ctx, 'assets', { id: a.id, tags: v.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder={t('Tags')} />
            <TextField value={a.alt} onChange={(v) => put(ctx, 'assets', { id: a.id, alt: v })} placeholder={t('Alt text')} />
            {a.suggested ? <Suggested ctx={ctx} id={a.id} source={a.source} /> : null}
            <Remove ctx={ctx} id={a.id} what={a.name} />
          </div>
        ))}
      </div>
    </Group>
  );
}

function changeLine(t: Translate, c: BrandChange): string {
  if (c.kind !== 'changed') return c.kind === 'added' ? t('Added {section}: {name}', { section: c.section, name: c.name }) : t('Removed {section}: {name}', { section: c.section, name: c.name });
  const fields = (c.fields ?? []).map((f) => t('{field}: {from} to {to}', { field: f.field, from: JSON.stringify(f.from), to: JSON.stringify(f.to) })).join(', ');
  return t('{section}: {name}. {changes}', { section: c.section, name: c.name, changes: fields });
}

function impactLine(t: Translate, layers: number, tokens: number, fromVersion: number | string | null | undefined): string {
  const vars = { layers: t.n(layers, '{count} layer', '{count} layers'), tokens: t.n(tokens, '{count} token', '{count} tokens') };
  return fromVersion ? t('{layers}, {tokens}, on version {version}', { ...vars, version: fromVersion }) : t('{layers}, {tokens}', vars);
}

function Versions({ ctx, full, reload }: { ctx: Ctx; full: BrandFull | null; reload: () => void }) {
  const t = useT();
  const [note, setNote] = useState('');
  const [changes, setChanges] = useState<BrandChange[] | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [impact, setImpact] = useState<{ draft_changes: number; files: FileImpact[] } | null>(null);
  const [applied, setApplied] = useState<{ file_id: string; file_name: string; layers: number; tokens: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = ctx.s.user.name;
  const publish = async () => {
    try {
      await brandApi.publish(ctx.brandId, note, user);
      setNote('');
      reload();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const refresh = () => brandApi.impact(ctx.brandId).then(setImpact).catch((e: Error) => setError(e.message));
  useEffect(() => { void refresh(); }, [ctx.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const showDiff = async (id: string) => {
    setFrom(id);
    setChanges((await brandApi.diff(ctx.brandId, id)).changes);
  };
  const apply = async () => {
    try {
      const out = await brandApi.apply(ctx.brandId, user);
      setApplied(out.files);
      reload();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const undo = async (fileId: string) => {
    await api.undoAgent(fileId, 'brand');
    setApplied((list) => list?.filter((f) => f.file_id !== fileId) ?? null);
    refresh();
  };
  const affected = impact?.files.filter((f) => f.layer_count || f.tokens.length) ?? [];
  return (
    <>
      <Group title={t('Publish')} hint={t('A version is what linked files compare against. Agents working in them hear about it.')}>
        <div className="bp-row" style={{ borderTop: 0 }}>
          <TextField value={note} onChange={setNote} placeholder={t('What changed')} live testId="brand-publish-note" />
          <button type="button" className="btn" onClick={() => void publish()} data-testid="brand-publish">{t('Publish version')}</button>
        </div>
        {full?.draftChanges ? <div className="bp-note" data-testid="brand-draft">{t.n(full.draftChanges, '{count} change since the last version.', '{count} changes since the last version.')}</div> : null}
      </Group>
      <Group title={t('Linked files')} hint={t('What the current state changes in each file.')} actions={affected.length ? <button type="button" className="btn" onClick={() => void apply()} data-testid="brand-apply-all">{t('Apply to linked files')}</button> : null}>
        <div className="bp-rows" data-testid="brand-impact">
          {!impact?.files.length ? <div className="bp-note">{t('No files link to this brand yet.')}</div> : null}
          {impact?.files.map((f) => (
            <div key={f.file_id} className="bp-row" data-testid="brand-impact-row">
              <a className="bp-sample" href={`#/file/${f.file_id}`} dir="auto">{f.file_name}</a>
              <span className="bp-note">{impactLine(t, f.layer_count, f.tokens.length, f.from_version)}</span>
            </div>
          ))}
        </div>
        {applied?.length ? (
          <div className="bp-rows" data-testid="brand-applied">
            {applied.map((f) => (
              <div key={f.file_id} className="bp-row"><span className="bp-sample">{t('{file}: {layers} and {tokens} changed', { file: f.file_name, layers: t.n(f.layers, '{count} layer', '{count} layers'), tokens: t.n(f.tokens, '{count} token', '{count} tokens') })}</span><button type="button" className="btn btn-quiet" onClick={() => void undo(f.file_id)} data-testid="brand-apply-undo">{t('Undo')}</button></div>
            ))}
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}
      </Group>
      <Group title={t('Versions')}>
        <div className="bp-rows">
          {[...(full?.versions ?? [])].reverse().map((v) => (
            <div key={v.id} className="bp-row" data-testid="brand-version-row">
              <span className="bp-sample">{v.note ? t('Version {version}: {note}', { version: v.n, note: v.note }) : t('Version {version}', { version: v.n })}</span>
              <span className="bp-note">{v.by ? t('{date}, {person}', { date: formatDateTime(v.at), person: v.by }) : formatDateTime(v.at)}</span>
              <button type="button" className={`btn btn-quiet${from === v.id ? ' is-active' : ''}`} onClick={() => void showDiff(v.id)} data-testid="brand-version-diff">{t('Compare with now')}</button>
            </div>
          ))}
        </div>
        {changes ? <div className="bp-diff" data-testid="brand-diff">{changes.length ? changes.map((c, i) => <div key={i}>{changeLine(t, c)}</div>) : t('No differences.')}</div> : null}
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- the page

const SHEET_WIDTH = 1200;

function Preview({ brandId, data }: { brandId: string; data: BrandData }) {
  // A sheet is generated on the server, so it waits for a quiet moment.
  const [stamp, setStamp] = useState(0);
  const [box, setBox] = useState({ w: SHEET_WIDTH, h: 800 });
  const holder = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    const timer = window.setTimeout(() => setStamp(Date.now()), 500);
    return () => clearTimeout(timer);
  }, [data]);
  useEffect(() => {
    if (!holder.current) return;
    const seen = new ResizeObserver(([e]) => { if (e) setBox({ w: e.contentRect.width, h: e.contentRect.height }); });
    seen.observe(holder.current);
    return () => seen.disconnect();
  }, []);
  // The sheet has one width, so the frame shows all of it, scaled to the panel.
  const scale = Math.min(1, box.w / SHEET_WIDTH);
  return (
    <aside className="bp-preview" data-testid="brand-preview">
      <div className="bp-preview-head"><span>{t('Brand sheet, generated from the data')}</span></div>
      <div className="bp-preview-frame" ref={holder}>
        {/* No scripts, no same-origin: brands can come from other devices. */}
        <iframe title={t('Brand sheet')} sandbox="" src={`/api/brands/${brandId}/sheet.html?v=${stamp}`} data-testid="brand-sheet" style={{ width: SHEET_WIDTH, height: box.h / scale, transform: `scale(${scale})` }} />
      </div>
    </aside>
  );
}

export function BrandPage({ brandId }: { brandId: string }) {
  const [session, setS] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>('book');
  const [full, setFull] = useState<BrandFull | null>(null);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What did not work on this page: an export, the brand system file, an upload, a value the brand cannot hold.
  const [notice, setNotice] = useState<string | null>(null);
  const data = useBrandData(session);
  const t = useT();

  const reload = () => {
    brandApi.get(brandId).then(setFull).catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    const s = new Session(brandId);
    setS(s);
    setSession(s);
    const onSync = (v: boolean) => { if (v) setSynced(true); };
    s.provider.on('sync', onSync);
    reload();
    const off = onServerEvent((e) => { if (e.t === 'brand' && e.id === brandId) reload(); });
    return () => {
      off();
      s.provider.off('sync', onSync);
      setSession(null);
      s.destroy();
      setS(null);
    };
  }, [brandId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (full?.name) document.title = t('{name}, brand - Bogen', { name: full.name });
    return () => { document.title = 'Bogen'; };
  }, [full?.name, t]);

  useEffect(() => {
    if (!session) return;
    const key = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if (typing || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) session.undo.redo();
      else session.undo.undo();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [session]);

  if (error) return <div className="home-empty" data-testid="brand-error"><div className="empty-title">{t('This brand could not be opened')}</div><div className="empty-hint">{error}</div><a className="btn" href="#/">{t('Back to the files')}</a></div>;
  if (!session || !data || !synced) return <div className="loading" data-testid="loading"><span>{t('Opening the brand')}</span></div>;

  const ctx: Ctx = { s: session, data, bound: bindingFields(data), brandId, fail: setNotice };
  // Live from the document, so that confirming in the review shows at once.
  const suggestions = brandCounts(data).suggestions;
  const count = (tab: Tab): number => {
    switch (tab) {
      case 'review': return suggestions;
      case 'logos': return data.logos.length;
      case 'colors': return data.colors.length;
      case 'type': return data.families.length + data.typeScale.length;
      case 'layout': return data.spacing.length + data.radius.length;
      case 'imagery': return data.rules.filter((r) => r.topic === 'imagery' || r.topic === 'iconography').length;
      case 'voice': return data.words.length + data.voiceExamples.length;
      case 'rules': return data.rules.filter((r) => !['imagery', 'iconography', 'layout', 'voice'].includes(r.topic)).length;
      case 'examples': return data.artboards.length;
      case 'assets': return data.assets.length;
      default: return 0;
    }
  };
  const download = async (ext: 'md' | 'pdf') => {
    const path = `/api/brands/${brandId}/guide.${ext}`;
    setNotice(null);
    try {
      const res = await fetch(path);
      // The PDF needs a browser on this machine to render it, so it can fail where the Markdown does not.
      if (!res.ok) throw new Error((await res.json().then((b: { error?: string }) => b.error).catch(() => null)) ?? t('{method} {path} failed with {status}', { method: 'GET', path, status: res.status }));
      downloadBlob(await res.blob(), `${t('{name} brand guide', { name: full?.name ?? t('brand') })}.${ext}`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const openSystemFile = () => {
    setNotice(null);
    brandApi.systemFile(brandId).then((out) => { location.hash = `#/file/${out.file_id}`; }).catch((e: Error) => setNotice(e.message));
  };
  return (
    <div className={`bp${tab === 'book' ? ' bp-book-open' : ''}`} data-testid="brand-page">
      <header className="bp-head">
        <a className="icon-btn" href="#/" title={t('Back to the files')} aria-label={t('Back to the files')} data-testid="brand-back"><ArrowLeft size={14} /></a>
        <TextField value={full?.name ?? data.fields.name} onChange={(v) => { if (v.trim()) void brandApi.rename(brandId, v.trim()).then(reload); }} testId="brand-title" />
        <span className="bp-note">{full?.versions.length ? (full.draftChanges ? t.n(full.draftChanges, 'Version {version}, {count} change since', 'Version {version}, {count} changes since', { version: full.versions.length }) : t('Version {version}', { version: full.versions.length })) : t('Not published yet')}</span>
        {full?.duplicatedFrom ? <span className="bp-note" dir="auto" data-testid="brand-duplicated-from">{t('Duplicated from {name}, version {version}', { name: full.duplicatedFrom.name, version: full.duplicatedFrom.version })}</span> : null}
        <span className="bp-spacer" />
        {suggestions && tab !== 'review' ? <button type="button" className="btn" onClick={() => setTab('review')} data-testid="brand-review-open" title={t('Each suggestion next to what binds now, to confirm or dismiss one by one or all at once')}>{t.n(suggestions, 'Review {count} suggestion', 'Review {count} suggestions')}</button> : null}
        {suggestions ? <button type="button" className="btn btn-quiet" onClick={() => session.tx(() => confirmBrandItems(session.doc, null))} data-testid="brand-confirm-all">{t('Confirm all')}</button> : null}
        <label className="check" title={t('A write that adds a hard violation is refused, with the fix')}><input type="checkbox" checked={ctx.bound.strict} onChange={(e) => setField(ctx, 'strict', e.target.checked)} data-testid="brand-strict" /><span>{t('Strict')}</span></label>
        <Proposed ctx={ctx} field="strict" />
        <IconButton icon={<Undo2 size={14} />} title={t('Undo')} onClick={() => session.undo.undo()} testId="brand-undo" />
        <IconButton icon={<Redo2 size={14} />} title={t('Redo')} onClick={() => session.undo.redo()} testId="brand-redo" />
        <button type="button" className="btn btn-quiet" title={t('Brand system file')} onClick={openSystemFile} data-testid="brand-template-system"><FilePlus2 size={14} /> {t('Brand system file')}</button>
        <button type="button" className="btn btn-quiet" onClick={() => void download('md')} data-testid="brand-export-md"><Download size={14} /> {t('Markdown')}</button>
        <button type="button" className="btn btn-quiet" onClick={() => void download('pdf')} data-testid="brand-export-pdf"><Download size={14} /> PDF</button>
        <a className="btn btn-quiet" href={`/api/files/${brandId}/download`} download data-testid="brand-export-bogen"><Download size={14} /> .bogen</a>
        {notice ? <div className="error" role="alert" dir="auto" style={{ flexBasis: '100%' }} data-testid="brand-page-error">{notice}</div> : null}
      </header>
      <div className="bp-body">
        <nav className="bp-nav" aria-label={t('Brand sections')}>
          {TABS.filter((item) => item.id !== 'review' || suggestions || tab === 'review').map((item) => (
            <button key={item.id} type="button" className={item.id === tab ? 'is-active' : ''} onClick={() => setTab(item.id)} data-testid={`brand-tab-${item.id}`}>
              <span>{t(item.label)}</span>{count(item.id) ? <span className="bp-nav-count">{count(item.id)}</span> : null}
            </button>
          ))}
        </nav>
        <main className="bp-main" data-testid={`brand-section-${tab}`}>
          {tab === 'book' ? <BrandBook brandId={brandId} data={data} by={session.user.name} session={session} /> : null}
          {tab === 'review' ? <BrandReview s={session} data={data} onOpenSection={(section) => setTab(TAB_OF_SECTION[section] ?? 'identity')} /> : null}
          {tab === 'health' ? <BrandHealth brandId={brandId} by={session.user.name} /> : null}
          {tab === 'identity' ? <Identity ctx={ctx} /> : null}
          {tab === 'logos' ? <Logos ctx={ctx} /> : null}
          {tab === 'colors' ? <Colours ctx={ctx} /> : null}
          {tab === 'type' ? <Typography ctx={ctx} /> : null}
          {tab === 'layout' ? <Layout ctx={ctx} /> : null}
          {tab === 'imagery' ? <><RuleList ctx={ctx} title={t('Imagery')} hint={t('What pictures show and how. Agents judge these by eye.')} topics={['imagery']} /><RuleList ctx={ctx} title={t('Iconography')} topics={['iconography']} /></> : null}
          {tab === 'voice' ? <Voice ctx={ctx} /> : null}
          {tab === 'rules' ? <><RuleList ctx={ctx} title={t('Rules')} hint={t('Must is a requirement for agents. Should is a default. A rule with a check is checked by machine, and the rest are judged by eye.')} topics={['general', 'color', 'type', 'logo']} topicForNew="general" /><section className="bp-group"><MemorySuggestions brandId={ctx.brandId} /></section></> : null}
          {tab === 'examples' ? <Examples ctx={ctx} /> : null}
          {tab === 'assets' ? <Assets ctx={ctx} /> : null}
          {tab === 'versions' ? <Versions ctx={ctx} full={full} reload={reload} /> : null}
        </main>
        {tab !== 'book' ? <Preview brandId={brandId} data={data} /> : null}
      </div>
    </div>
  );
}
