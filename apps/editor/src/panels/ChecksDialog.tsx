import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Plus, X } from 'lucide-react';
import { BUILTIN_CHECKS, deleteCheck, getChecks, parseCheck, resolveCheck, setCheck, type CheckDefinition, type CheckRule } from '@bogen/core';
import { LOCAL, session } from '../doc/session.ts';
import { useFrameVersion } from '../doc/hooks.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { IconButton } from '../ui/controls.tsx';
import { fitSelection } from '../ops/ops.ts';
import '../styles/checks.css';
import { useT } from '../i18n/react.ts';

type Finding = { id: string; rule: string; message: string; severity: string; width?: number; actual?: string | number | null; expected?: string | number };
type Report = { ok: boolean; reports: { id: string; name: string; ok: boolean; skipped?: boolean; total: number; findings: Finding[]; incomplete?: boolean }[]; note?: string };
const serialize = (check: CheckDefinition) => JSON.stringify(check);
const csv = (text: string) => text.trim() ? text.split(',').map((v) => Number(v.trim())) : undefined;

function RuleEditor({ rule, update, remove }: { rule: CheckRule; update: (r: CheckRule) => void; remove: () => void }) {
  const t = useT();
  const numeric = rule.kind === 'count' || rule.kind === 'geometry' || rule.operator === 'min' || rule.operator === 'max';
  const ops = rule.kind === 'attribute' ? ['present', 'absent', 'equals', 'not-equals'] : rule.kind === 'style' ? ['equals', 'not-equals', 'min', 'max'] : ['equals', 'min', 'max'];
  return <fieldset className="check-rule">
    <legend>{rule.id}</legend>
    <div className="check-row">
      <label>{t('Measure')}<select value={rule.kind} onChange={(e) => update({ ...rule, kind: e.target.value as CheckRule['kind'], property: e.target.value === 'geometry' ? 'height' : e.target.value === 'attribute' ? 'alt' : 'font-size', operator: e.target.value === 'attribute' ? 'present' : 'min', value: 24 })}><option value="geometry">{t('Size or position')}</option><option value="style">{t('Computed CSS')}</option><option value="attribute">{t('Attribute')}</option><option value="count">{t('Element count')}</option></select></label>
      <label>{t('Selector')}<input value={rule.selector} onChange={(e) => update({ ...rule, selector: e.target.value })} placeholder="button" /></label>
      <button type="button" className="btn btn-quiet" onClick={() => { const id = editor().selection[0]; if (id) update({ ...rule, selector: `[data-bogen-id=${JSON.stringify(id)}]` }); }} disabled={!editor().selection.length}>{t('Use selection')}</button>
    </div>
    <div className="check-row">
      {rule.kind !== 'count' ? <label>{t('Property')}<input value={rule.property ?? ''} onChange={(e) => update({ ...rule, property: e.target.value })} /></label> : null}
      <label>{t('Condition')}<select value={rule.operator} onChange={(e) => { const operator = e.target.value as CheckRule['operator']; update({ ...rule, operator, value: operator === 'min' || operator === 'max' ? Number(rule.value) || 0 : String(rule.value ?? '') }); }}>{ops.map((op) => <option key={op}>{op}</option>)}</select></label>
      {!['present', 'absent'].includes(rule.operator) ? <label>{numeric ? t('Expected (number)') : `${t('Expected')} `}<input type={numeric ? 'number' : 'text'} value={rule.value ?? ''} onChange={(e) => update({ ...rule, value: numeric ? Number(e.target.value) : e.target.value })} /></label> : null}
      <label>{t('Severity')}<select value={rule.severity ?? 'warning'} onChange={(e) => update({ ...rule, severity: e.target.value as CheckRule['severity'] })}><option value="warning">{t('Warning')}</option><option value="error">{t('Error')}</option></select></label>
    </div>
    <label>{t('Finding message')}<input value={rule.message ?? ''} onChange={(e) => update({ ...rule, message: e.target.value })} placeholder={t('What should be corrected?')} /></label>
    <div className="check-row"><label className="check-toggle"><input type="checkbox" checked={rule.enabled !== false} onChange={(e) => update({ ...rule, enabled: e.target.checked })} />{t('Enabled')}</label><button type="button" className="btn btn-quiet" onClick={remove}>{t('Remove rule / override')}</button></div>
  </fieldset>;
}

export default function ChecksDialog() {
  const t = useT();
  const s = session();
  const doc = s.doc;
  const pageId = useEditor((st) => st.pageId);
  useFrameVersion();
  const subscribe = useMemo(() => (notify: () => void) => { doc.meta.observe(notify); return () => doc.meta.unobserve(notify); }, [doc]);
  const read = useMemo(() => () => JSON.stringify(getChecks(doc)), [doc]);
  const raw = useSyncExternalStore(subscribe, read);
  const checks: CheckDefinition[] = useMemo(() => JSON.parse(raw), [raw]);
  const [draft, setDraft] = useState<CheckDefinition>(BUILTIN_CHECKS[1]!);
  const [selected, setSelected] = useState<string | null>(BUILTIN_CHECKS[1]!.id);
  const [loaded, setLoaded] = useState(serialize(BUILTIN_CHECKS[1]!));
  const [widths, setWidths] = useState(BUILTIN_CHECKS[1]!.widths!.join(', '));
  const [heights, setHeights] = useState(BUILTIN_CHECKS[1]!.viewport_heights!.join(', '));
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [transfer, setTransfer] = useState(false);
  const [json, setJson] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef(document.activeElement);
  const close = () => ui().set({ checksOpen: false });
  const builtin = selected?.startsWith('builtin:') ?? false;
  const targets = pageId ? doc.getChildren(pageId) : [];
  const nodeId = target || targets.find((n) => editor().selection.some((id) => id === n.id || doc.ancestors(id).includes(n.id)))?.id || targets[0]?.id || '';
  const candidate = { ...draft, widths: csv(widths), viewport_heights: csv(heights) };
  const dirty = serialize(candidate) !== loaded;
  const current = checks.find((c) => c.id === selected);
  const conflict = !builtin && selected !== null && (!current || serialize(current) !== loaded);
  let inherited: CheckRule[] = [];
  try { if (draft.extends) inherited = resolveCheck(doc, draft.extends).rules ?? []; } catch { /* Save reports invalid inheritance. */ }
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter((el) => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    const restore = back.current;
    return () => { window.removeEventListener('keydown', key, true); if (restore instanceof HTMLElement && restore.isConnected) restore.focus(); };
  }, []);
  const choose = (c: CheckDefinition, saved = true) => {
    setDraft(c); setSelected(saved ? c.id : null); setLoaded(saved ? serialize(c) : ''); setWidths(c.widths?.join(', ') ?? ''); setHeights(c.viewport_heights?.join(', ') ?? ''); setError(''); setReport(null); setTransfer(false);
  };
  const create = (base?: CheckDefinition) => {
    let n = 1; while (checks.some((c) => c.id === `check-${n}`)) n++;
    choose({ id: `check-${n}`, name: base ? `${base.name} — custom` : 'My design check', ...(base ? { extends: base.id } : {}), rules: [] }, false);
  };
  const save = () => {
    try {
      if (conflict) throw new Error(t('This check changed elsewhere. Reload it before saving, or create a new check.'));
      const parsed = parseCheck(candidate);
      if (parsed.id !== selected && checks.some((c) => c.id === parsed.id)) throw new Error(t('That id already exists. Choose the saved check to edit it.'));
      choose(setCheck(doc, parsed, LOCAL));
    } catch (e) { setError(String((e as Error).message)); }
  };
  const run = async () => {
    if (!nodeId || !selected || dirty || conflict) return;
    setRunning(true); setError(''); setReport(null);
    try {
      const response = await fetch(`/api/files/${s.fileId}/checks/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: nodeId, check_ids: [selected], expected: current ? { [current.id]: serialize(current) } : undefined }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || t('The check could not run.'));
      setReport(result);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setRunning(false); }
  };
  const remove = () => { try { deleteCheck(doc, selected!, LOCAL); choose(BUILTIN_CHECKS[1]!); } catch (e) { setError((e as Error).message); } };
  const measures = [draft.responsive ? t('Responsive layout') : '', draft.lint ? t('Design lint') : '', draft.a11y ? t('Accessibility') : ''].filter(Boolean);
  return <div className="dialog-scrim checks-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div ref={ref} className="dialog checks-dialog" role="dialog" aria-modal="true" aria-labelledby="checks-title" data-testid="checks-dialog">
      <header className="dialog-head"><h2 className="dialog-title" id="checks-title">{t('Design checks')}</h2><IconButton icon={<X size={16} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} /></header>
      <div className="checks-layout">
        <nav className="checks-list" aria-label={t('Saved checks')}>
          <button type="button" className="btn btn-outline checks-new" onClick={() => create()} data-testid="check-new"><Plus size={14} aria-hidden="true" />{t('New check')}</button>
          <h3>{t('Built into Bogen')}</h3>{BUILTIN_CHECKS.map((c) => <button type="button" key={c.id} className="checks-item" aria-current={selected === c.id ? 'true' : undefined} onClick={() => choose(c)}>{c.name}</button>)}
          <h3>{t('Saved in this file')}</h3>{checks.map((c) => <button type="button" key={c.id} className="checks-item" aria-current={selected === c.id ? 'true' : undefined} onClick={() => choose(c)} data-testid={`saved-check-${c.id}`}>{c.enabled === false ? t('{name} (off)', { name: c.name }) : c.name}</button>)}
          {selected === null ? <button type="button" className="checks-item" aria-current="true">{draft.name || t('New check')}</button> : null}
          {!checks.length && selected !== null ? <p>{t('Save checks here to reuse them with this file and your agents.')}</p> : null}
          <button type="button" className="checks-item checks-other" onClick={() => ui().set({ checksOpen: false, complianceOpen: true })} data-testid="open-compliance">{t('Accessibility and legal check')}</button>
        </nav>
        <div className="checks-pane">
        <div className="checks-edit">
          <header className="checks-edit-head">
            <div className="checks-edit-title"><h3>{draft.name || t('New check')}</h3>{builtin ? <p>{t('Built into Bogen. Run it as it is, or make a copy to change its settings and rules.')}</p> : null}</div>
            {builtin ? null : <div className="checks-edit-tools">{selected ? <button type="button" className="btn btn-quiet" onClick={() => create(draft)}>{t('Extend this check')}</button> : null}<button type="button" className="btn btn-quiet" onClick={() => { setTransfer(!transfer); setJson(JSON.stringify(candidate, null, 2)); }} aria-expanded={transfer}>{t('Import / export JSON')}</button></div>}
          </header>
          {transfer && !builtin ? <div className="check-transfer"><label>{t('Check definition')}<textarea value={json} onChange={(e) => setJson(e.target.value)} rows={8} spellCheck={false} /></label><button type="button" className="btn" onClick={() => { try { choose(parseCheck(JSON.parse(json)), false); } catch (e) { setError((e as Error).message); } }}>{t('Load as draft')}</button><span>{t('Copy this JSON to share a definition. Import bases first when extending another custom check.')}</span></div> : null}
          {builtin ? <dl className="check-facts" data-testid="check-facts">
            <dt>{t('Widths (px)')}</dt><dd>{draft.widths?.join(', ') ?? t('Inherit')}</dd>
            {draft.viewport_heights ? <><dt>{t('Browser heights (px)')}</dt><dd>{draft.viewport_heights.join(', ')}</dd></> : null}
            {draft.tolerance !== undefined ? <><dt>{t('Height tolerance (px)')}</dt><dd>{draft.tolerance}</dd></> : null}
            <dt>{t('Measures')}</dt><dd>{measures.join(', ')}</dd>
          </dl> : <fieldset disabled={running} className="check-fields">
            <div className="check-row"><label>{t('Name')}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="check-name" /></label><label>{t('Id')}<input value={draft.id} disabled={selected !== null} onChange={(e) => setDraft({ ...draft, id: e.target.value })} data-testid="check-id" /></label></div>
            <label>{t('Description')}<input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
            <label>{t('Extend')}<select value={draft.extends ?? ''} onChange={(e) => setDraft({ ...draft, extends: e.target.value || undefined })} data-testid="check-base"><option value="">{t('None')}</option>{[...BUILTIN_CHECKS, ...checks].filter((c) => c.id !== draft.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <div className="check-row"><label>{t('Widths (px)')}<input value={widths} onChange={(e) => setWidths(e.target.value)} placeholder={t('Inherit, e.g. {example}', { example: '1440, 768, 390' })} data-testid="check-widths" /></label><label>{t('Browser heights (px)')}<input value={heights} onChange={(e) => setHeights(e.target.value)} placeholder={t('Inherit, e.g. {example}', { example: '664, 760, 600' })} data-testid="check-heights" /></label><label>{t('Height tolerance (px)')}<input type="number" min="0" max="100" value={draft.tolerance ?? ''} placeholder={t('Inherit')} onChange={(e) => setDraft({ ...draft, tolerance: e.target.value === '' ? undefined : Number(e.target.value) })} /></label></div>
            <div className="check-row">{(['lint', 'a11y', 'responsive'] as const).map((key) => <label key={key}>{key === 'lint' ? t('Design lint') : key === 'a11y' ? t('Accessibility') : t('Responsive layout')}<select value={draft[key] === undefined ? 'inherit' : String(draft[key])} onChange={(e) => setDraft({ ...draft, [key]: e.target.value === 'inherit' ? undefined : e.target.value === 'true' })}><option value="inherit">{t('Inherit')}</option><option value="true">{t('On')}</option><option value="false">{t('Off')}</option></select></label>)}<label className="check-toggle"><input type="checkbox" checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />{t('Enabled')}</label></div>
            {inherited.length ? <div className="check-inherited"><h4>{t('Inherited rules')}</h4>{inherited.map((r) => <div className="check-row" key={r.id}><span>{r.id}: {r.selector} · {r.kind}</span><button type="button" className="btn btn-quiet" disabled={draft.rules?.some((own) => own.id === r.id)} onClick={() => setDraft({ ...draft, rules: [...draft.rules ?? [], { ...r }] })}>{t('Override')}</button></div>)}</div> : null}
            {(draft.rules ?? []).map((rule, index) => <RuleEditor key={rule.id} rule={rule} update={(r) => setDraft({ ...draft, rules: draft.rules!.map((old, i) => i === index ? r : old) })} remove={() => setDraft({ ...draft, rules: draft.rules!.filter((_, i) => i !== index) })} />)}
            <button type="button" className="btn btn-outline check-add-rule" data-testid="check-add-rule" onClick={() => { let n = 1; while ([...inherited, ...draft.rules ?? []].some((r) => r.id === `rule-${n}`)) n++; setDraft({ ...draft, rules: [...draft.rules ?? [], { id: `rule-${n}`, kind: 'geometry', selector: 'button', property: 'height', operator: 'min', value: 44, message: 'Buttons should be at least 44px high.' }] }); }}><Plus size={14} aria-hidden="true" />{t('Add rule')}</button>
          </fieldset>}
          {conflict ? <p role="alert">{t.rich('This check changed elsewhere. {reload}', { reload: <button type="button" className="run-link" onClick={() => current ? choose(current) : create()}>{t('Reload')}</button> })}</p> : null}
          {error ? <p role="alert" className="check-error" data-testid="check-error">{error}</p> : null}
          {report ? <div className="check-results" aria-live="polite" data-testid="check-results">{report.reports.map((r) => <section key={r.id}><h4>{r.skipped ? t('{name}: Skipped', { name: r.name }) : r.ok ? t('{name}: Passed', { name: r.name }) : t.n(r.total, '{name}: {count} finding', '{name}: {count} findings', { name: r.name })}</h4>{r.incomplete ? <p>{t('More than 2,000 elements matched a rule. Narrow its selector for a complete check.')}</p> : null}{r.findings.map((f, i) => <button type="button" key={i} className="check-finding" onClick={() => { editor().set({ selection: [f.id] }); close(); requestAnimationFrame(fitSelection); }}><strong>{f.severity}{f.width ? ` · ${f.width}px` : ''}</strong><span>{f.message}</span>{f.actual !== undefined ? <small>{f.expected !== undefined ? t('Actual: {actual} · Expected: {expected}', { actual: String(f.actual), expected: String(f.expected) }) : t('Actual: {actual}', { actual: String(f.actual) })}</small> : null}</button>)}</section>)}</div> : null}
        </div>
        <footer className="check-actions">
          {builtin
            ? <button type="button" className="btn btn-outline" onClick={() => create(draft)} data-testid="check-extend">{t('Make a copy to edit')}</button>
            : <><button type="button" className="btn" onClick={save} disabled={running || conflict} data-testid="check-save">{t('Save check')}</button>{selected ? <button type="button" className="btn btn-quiet check-delete" disabled={running} onClick={remove}>{t('Delete')}</button> : null}</>}
          {dirty && !builtin ? <span className="check-note">{t('Save your changes before running.')}</span> : null}
          <span className="check-grow" />
          <label className="check-target">{t('Run on')}<select value={nodeId} translate="no" onChange={(e) => setTarget(e.target.value)} aria-label={t('Check artboard')}>{targets.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={running || !nodeId || !selected || dirty || conflict} data-testid="check-run">{running ? t('Checking…') : t('Run check')}</button>
        </footer>
        </div>
      </div>
    </div>
  </div>;
}
