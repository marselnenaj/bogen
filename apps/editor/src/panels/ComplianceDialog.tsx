import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { getComplianceMarks, setComplianceMark, type ComplianceMark, type ComplianceResult } from '@bogen/core';
import { LOCAL, session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { IconButton } from '../ui/controls.tsx';
import { fitSelection } from '../ops/ops.ts';
import { downloadBlob } from '../lib/api.ts';
import { formatDate } from '../i18n/format.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import '../styles/compliance.css';

/**
 * The Accessibility and legal check: a page against a profile (EN 301 549, WCAG, EAA and BaFG, WZG), criterion by
 * criterion. What failed shows its layers; what only a person can decide gets a test and Pass, Fail or Not applicable,
 * saved in the file with the person's name and the date. The score never says conformant while anything is failed
 * or open. Criterion names, tests and findings come from the server in English, as the standards name them.
 */

type Status = 'failed' | 'passed' | 'not-applicable' | 'needs-person';
type Evidence = { rule: string; outcome: 'fail' | 'review' | 'pass'; node_id?: string; layer?: string; message: string; fix?: string };
type Criterion = { key: string; id: string; name: string; level: string | null; en: string | null; coverage: string; status: Status; decided_by: string | null; reason: string; evidence: Evidence[]; test: string; mark?: ComplianceMark; source?: string; advisory?: boolean };
type Reminder = { key: string; topic: string; state: 'found' | 'look' | 'info'; message: string; source: string; node_id?: string; layer?: string };
type Report = {
  profile: { id: string; name: string; description: string };
  checked_at: number;
  engines: { axe: string | null };
  score: { overall: 'fails' | 'incomplete' | 'all-criteria-met'; counts: { failed: number; passed: number; not_applicable: number; needs_person: number; total: number }; automated: { passed: number; decided: number; pass_rate: number | null }; person: { marked: number; open: number } };
  criteria: Criterion[]; advisory: Criterion[]; procedures: Criterion[];
  not_checked: string[];
  legal?: { reminders: Reminder[]; manual: { key: string; topic: string; test: string; source: string }[] };
};
type Section = 'summary' | 'failed' | 'person' | 'passed' | 'na' | 'statement' | 'legal';
type Statement = { markdown: string; html: string; open_fields: string[] };

const PROFILES: { id: string; label: string; translate: boolean }[] = [
  { id: 'en-301-549', label: 'EN 301 549 (web)', translate: false },
  { id: 'wcag-2.2-aa', label: 'WCAG 2.2 AA', translate: false },
  { id: 'wcag-2.1-aa', label: 'WCAG 2.1 AA', translate: false },
  { id: 'eaa-bafg', label: msg('EAA and BaFG (Austria)'), translate: true },
  { id: 'wzg', label: msg('WZG (Austrian public bodies)'), translate: true },
];
const OVERALL = { fails: msg('Does not meet the profile'), incomplete: msg('Not decided yet'), 'all-criteria-met': msg('All criteria met as checked') } as const;
const RESULTS: { result: ComplianceResult; label: string }[] = [{ result: 'pass', label: msg('Pass') }, { result: 'fail', label: msg('Fail') }, { result: 'na', label: msg('Not applicable') }];
const REMINDER = { found: msg('Found'), look: msg('Look at this'), info: msg('Note') } as const;

function useMarks(pageId: string): Record<string, ComplianceMark> {
  const doc = session().doc;
  const subscribe = useMemo(() => (notify: () => void) => { doc.meta.observe(notify); return () => doc.meta.unobserve(notify); }, [doc]);
  const raw = useSyncExternalStore(subscribe, () => JSON.stringify(getComplianceMarks(doc, pageId)));
  return useMemo(() => JSON.parse(raw) as Record<string, ComplianceMark>, [raw]);
}

function showLayer(id: string | undefined) {
  if (!id || !session().doc.getNode(id)) return;
  editor().set({ selection: [id] });
  ui().set({ complianceOpen: false });
  requestAnimationFrame(fitSelection);
}

function EvidenceList({ list }: { list: Evidence[] }) {
  const t = useT();
  if (!list.length) return null;
  return <ul className="compliance-evidence">{list.slice(0, 12).map((e, i) => <li key={i}>
    <span dir="auto">{e.layer ? <strong>{e.layer}: </strong> : null}{e.message}{e.fix ? <em> {e.fix}</em> : null}</span>
    {e.node_id ? <button type="button" className="btn btn-quiet" onClick={() => showLayer(e.node_id)}>{t('Show layer')}</button> : null}
  </li>)}</ul>;
}

function title(c: Criterion): string {
  return [c.name, c.level, c.en ? `EN 301 549 ${c.en}` : ''].filter(Boolean).join(' · ');
}

function MarkControls({ k, mark, pageId }: { k: string; mark?: ComplianceMark; pageId: string }) {
  const t = useT();
  const [note, setNote] = useState(mark?.note ?? '');
  const by = session().user.name || 'Person';
  const set = (result: ComplianceResult | null) => setComplianceMark(session().doc, pageId, k, result ? { result, by, ...(note.trim() ? { note } : {}) } : null, LOCAL);
  return <div className="compliance-mark">
    <div role="group" aria-label={t('Result')} className="compliance-results">
      {RESULTS.map((r) => <button type="button" key={r.result} aria-pressed={mark?.result === r.result} className={mark?.result === r.result ? 'is-active' : ''} onClick={() => set(r.result)}>{t(r.label)}</button>)}
      {mark ? <button type="button" onClick={() => set(null)}>{t('Clear')}</button> : null}
    </div>
    <label>{t('Note')}<input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (mark && note !== (mark.note ?? '')) set(mark.result); }} placeholder={t('What you tested, and on what')} dir="auto" /></label>
    {mark ? <p className="compliance-marked" dir="auto">{t('{result} · {name} · {date}', { result: t(RESULTS.find((r) => r.result === mark.result)!.label), name: mark.by, date: formatDate(mark.at) })}{mark.note ? ` · "${mark.note}"` : ''}</p> : null}
  </div>;
}

function Row({ c, pageId, mark, markable }: { c: Criterion; pageId: string; mark?: ComplianceMark; markable: boolean }) {
  return <article className="compliance-row" data-status={c.status} data-testid={`criterion-${c.key}`}>
    <span className="compliance-id">{c.id}</span>
    <div className="compliance-body">
      <strong>{title(c)}</strong>
      <span className="compliance-reason">{c.reason}</span>
      <EvidenceList list={c.evidence} />
      {markable ? <span className="compliance-test">{c.test}</span> : null}
      {c.source ? <span className="compliance-source">{c.source}</span> : null}
      {markable ? <MarkControls k={c.key} mark={mark} pageId={pageId} /> : null}
    </div>
  </article>;
}

export default function ComplianceDialog() {
  const t = useT();
  const s = session();
  const doc = s.doc;
  const pageId = useEditor((st) => st.pageId) ?? '';
  const marks = useMarks(pageId);
  const [profile, setProfile] = useState('en-301-549');
  const [target, setTarget] = useState('');
  const [section, setSection] = useState<Section>('summary');
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [lang, setLang] = useState<'de' | 'en'>('de');
  const [fields, setFields] = useState({ organisation: '', website: '', contact: '', law: '' });
  const [statement, setStatement] = useState<Statement | null>(null);
  const [marksAtRun, setMarksAtRun] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef(document.activeElement);
  const close = () => ui().set({ complianceOpen: false });
  const boards = pageId ? doc.getChildren(pageId).filter((n) => !n.hidden) : [];
  const page = doc.getPages().find((p) => p.id === pageId);
  const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ pageId, ...(target ? { nodeId: target } : {}), profile, legal: true, ...extra });

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

  const post = (what: string, extra: Record<string, unknown> = {}) => fetch(`/api/files/${s.fileId}/compliance/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(extra) });
  const run = async () => {
    if (!pageId) return;
    setRunning(true); setError(''); setStatement(null);
    try {
      const res = await post('run');
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || t('The check could not run.'));
      setReport(out);
      setMarksAtRun(JSON.stringify(getComplianceMarks(doc, pageId)));
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };
  const exportAs = async (format: 'html' | 'pdf') => {
    setRunning(true); setError('');
    try {
      const res = await post('export', { format, statement: true, language: lang, fields: statementFields() });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('The check could not run.'));
      downloadBlob(await res.blob(), `${t('Accessibility and legal check')} ${page?.name ?? ''}.${format}`.trim());
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };
  const statementFields = () => ({ ...(fields.organisation ? { organisation: fields.organisation } : {}), ...(fields.website ? { website: fields.website } : {}), ...(fields.contact ? { contact: fields.contact } : {}), ...(fields.law ? { law: fields.law } : {}) });
  const draft = async (language = lang) => {
    setRunning(true); setError('');
    try {
      const res = await post('statement', { language, fields: statementFields() });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || t('The check could not run.'));
      setStatement(out);
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };

  const by = (st: Status) => report?.criteria.filter((c) => c.status === st) ?? [];
  const person = [...by('needs-person'), ...(report?.criteria.filter((c) => c.decided_by === 'person') ?? [])];
  const openOnly = (list: Criterion[]) => list.filter((c) => showDone ? Boolean(marks[c.key]) : !marks[c.key]);
  const stale = Boolean(report) && JSON.stringify(marks) !== marksAtRun;
  const nav: { id: Section; label: string; count?: number }[] = [
    { id: 'summary', label: msg('Summary') }, { id: 'failed', label: msg('Failed'), count: report?.score.counts.failed }, { id: 'person', label: msg('Needs a person'), count: report ? report.score.counts.needs_person + report.procedures.filter((p) => p.status === 'needs-person').length : undefined },
    { id: 'passed', label: msg('Passed'), count: report?.score.counts.passed }, { id: 'na', label: msg('Not applicable'), count: report?.score.counts.not_applicable },
  ];
  const s2 = report?.score;
  const list = (items: Criterion[], markable: boolean) => items.length ? items.map((c) => <Row key={c.key} c={c} pageId={pageId} mark={marks[c.key]} markable={markable} />) : <p className="compliance-empty">{t('No criteria here.')}</p>;

  return <div className="dialog-scrim compliance-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <div ref={ref} className="dialog compliance-dialog" role="dialog" aria-modal="true" aria-label={t('Accessibility and legal check')} data-testid="compliance-dialog">
      <header className="dialog-head compliance-head">
        <strong>{t('Accessibility and legal check')}</strong>
        <label>{t('Profile')}<select value={profile} onChange={(e) => { setProfile(e.target.value); setReport(null); }} data-testid="compliance-profile">{PROFILES.map((p) => <option key={p.id} value={p.id}>{p.translate ? t(p.label) : p.label}</option>)}</select></label>
        <label>{t('Check')}<select value={target} onChange={(e) => { setTarget(e.target.value); setReport(null); }}><option value="">{t('Page: {name}', { name: page?.name ?? '' })}</option>{boards.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
        <span className="compliance-spacer" />
        <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={running || !pageId} data-testid="compliance-run">{running ? t('Checking…') : t('Run check')}</button>
        <button type="button" className="btn" onClick={() => void exportAs('html')} disabled={running || !report}>{t('Export HTML')}</button>
        <button type="button" className="btn" onClick={() => void exportAs('pdf')} disabled={running || !report}>{t('Export PDF')}</button>
        <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} />
      </header>
      <div className="compliance-layout">
        <nav className="compliance-nav" aria-label={t('Sections')}>
          {nav.map((n) => <button type="button" key={n.id} className={section === n.id ? 'is-active' : ''} aria-current={section === n.id ? 'page' : undefined} onClick={() => setSection(n.id)}>{t(n.label)}{n.count !== undefined ? <span className={n.id === 'failed' && n.count ? 'is-bad' : ''}>{n.count}</span> : null}</button>)}
          <hr />
          <button type="button" className={section === 'statement' ? 'is-active' : ''} onClick={() => { setSection('statement'); if (report && !statement) void draft(); }}>{t('Accessibility statement')}</button>
          <button type="button" className={section === 'legal' ? 'is-active' : ''} onClick={() => setSection('legal')}>{t('Legal reminders')}{report?.legal ? <span>{report.legal.reminders.filter((r) => r.state === 'look').length}</span> : null}</button>
          <p>{t('A technical aid, not legal advice or a certification. People decide conformance.')}</p>
        </nav>
        <div className="compliance-main" aria-live="polite" data-testid="compliance-main">
          {error ? <p role="alert" className="compliance-error">{error}</p> : null}
          {!report ? <p className="compliance-empty">{running ? t('Checking…') : t('Run the check to see results.')}</p> : null}
          {report && stale ? <p className="compliance-stale">{t('Marks changed. Run the check again to update the score.')} <button type="button" className="btn btn-quiet" onClick={() => void run()} disabled={running}>{t('Run check')}</button></p> : null}
          {report && s2 && section === 'summary' ? <>
            <section className="compliance-status" data-testid="compliance-status" data-overall={s2.overall}>
              <h2>{t(OVERALL[s2.overall])}</h2>
              <p>{t('Bogen never claims conformance while any criterion is failed or unchecked.')}</p>
            </section>
            <section className="compliance-numbers">
              <div><span>{t('Automated pass rate')}</span><strong>{s2.automated.decided ? t('{passed} of {total}', { passed: String(s2.automated.passed), total: String(s2.automated.decided) }) : '–'}</strong><span>{t('criteria the checks decided')}</span></div>
              <div><span>{t('Checked by a person')}</span><strong>{t('{passed} of {total}', { passed: String(s2.person.marked), total: String(s2.person.marked + s2.person.open) })}</strong><span>{t('marked in this file')}</span></div>
              <div><span>{t('Profile')}</span><strong>{report.profile.name}</strong><span>{t('Criteria: {count}', { count: String(s2.counts.total) })}</span></div>
            </section>
            <div className="compliance-bar" aria-hidden="true">{(['failed', 'passed', 'needs_person', 'not_applicable'] as const).map((k) => <span key={k} data-part={k} style={{ flexGrow: s2.counts[k] }} />)}</div>
            <h3>{t('Failed')}</h3>
            {list(by('failed'), false)}
            {report.advisory.some((c) => c.status === 'failed') ? <><h3>{t('WCAG 2.2 additions, as advice')}</h3>{list(report.advisory.filter((c) => c.status === 'failed'), false)}</> : null}
            {report.not_checked.length ? <ul className="compliance-notes">{report.not_checked.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          </> : null}
          {report && section === 'failed' ? list(by('failed'), false) : null}
          {report && section === 'person' ? <>
            <p className="compliance-intro">{t('Test each one, then mark it. Your answer is saved in this file with your name and the date.')}</p>
            <div className="compliance-filter" role="group" aria-label={t('Show')}><button type="button" aria-pressed={!showDone} className={!showDone ? 'is-active' : ''} onClick={() => setShowDone(false)}>{t('Open')}</button><button type="button" aria-pressed={showDone} className={showDone ? 'is-active' : ''} onClick={() => setShowDone(true)}>{t('Done')}</button></div>
            {list(openOnly(person), true)}
            {report.procedures.length ? <><h3>{t('Duties of the law')}</h3>{list(openOnly(report.procedures), true)}</> : null}
            {report.advisory.length ? <><h3>{t('WCAG 2.2 additions, as advice')}</h3>{list(openOnly(report.advisory.filter((c) => c.status !== 'failed')), true)}</> : null}
          </> : null}
          {report && section === 'passed' ? list(by('passed'), false) : null}
          {report && section === 'na' ? list(by('not-applicable'), false) : null}
          {report && section === 'statement' ? <div className="compliance-statement">
            <div className="compliance-statement-draft">
              <div className="compliance-filter" role="group" aria-label={t('Language')}>{(['de', 'en'] as const).map((l) => <button type="button" key={l} aria-pressed={lang === l} className={lang === l ? 'is-active' : ''} onClick={() => { setLang(l); void draft(l); }}>{l === 'de' ? 'Deutsch' : 'English'}</button>)}</div>
              {statement ? <div className="compliance-sheet" data-testid="compliance-statement" dangerouslySetInnerHTML={{ __html: statement.html }} /> : <p className="compliance-empty">{t('Checking…')}</p>}
            </div>
            <aside className="compliance-fields">
              <h3>{t('You fill in')}</h3>
              <label>{t('Body or company')}<input value={fields.organisation} onChange={(e) => setFields({ ...fields, organisation: e.target.value })} dir="auto" /></label>
              <label>{t('Website address')}<input value={fields.website} onChange={(e) => setFields({ ...fields, website: e.target.value })} dir="auto" /></label>
              <label>{t('Feedback contact (e-mail or form)')}<input value={fields.contact} onChange={(e) => setFields({ ...fields, contact: e.target.value })} dir="auto" /></label>
              <label>{t('Law')}<select value={fields.law} onChange={(e) => setFields({ ...fields, law: e.target.value })}><option value="">{t('From the profile')}</option><option value="wzg">{t('WZG, public body')}</option><option value="bafg">{t('BaFG, private service')}</option><option value="none">{t('None')}</option></select></label>
              <p>{t('Fields marked in yellow are for you to fill in. Check the draft before you publish it.')}</p>
              <button type="button" className="btn" onClick={() => void draft()} disabled={running}>{t('Update draft')}</button>
              <button type="button" className="btn btn-primary" disabled={!statement} onClick={() => statement && downloadBlob(new Blob([statement.markdown], { type: 'text/markdown' }), `${lang === 'de' ? 'Erklaerung zur Barrierefreiheit' : 'Accessibility statement'}.md`)}>{t('Download text')}</button>
            </aside>
          </div> : null}
          {report && section === 'legal' && report.legal ? <div className="compliance-legal">
            <p className="compliance-intro">{t('Reminders with their sources, not legal advice. A person decides what applies.')}</p>
            {report.legal.reminders.map((r, i) => <article key={`${r.key}-${i}`} className="compliance-row" data-state={r.state}>
              <span className="compliance-id">{t(REMINDER[r.state])}</span>
              <div className="compliance-body"><strong>{r.topic}</strong><span dir="auto">{r.layer ? <strong>{r.layer}: </strong> : null}{r.message}</span><span className="compliance-source">{r.source}</span>{r.node_id ? <button type="button" className="btn btn-quiet" onClick={() => showLayer(r.node_id)}>{t('Show layer')}</button> : null}{r.state !== 'found' ? <MarkControls k={r.key} mark={marks[r.key]} pageId={pageId} /> : null}</div>
            </article>)}
            <h3>{t('For a person to check')}</h3>
            {report.legal.manual.map((m) => <article key={m.key} className="compliance-row">
              <span className="compliance-id" />
              <div className="compliance-body"><strong>{m.topic}</strong><span>{m.test}</span><span className="compliance-source">{m.source}</span><MarkControls k={m.key} mark={marks[m.key]} pageId={pageId} /></div>
            </article>)}
          </div> : null}
        </div>
      </div>
    </div>
  </div>;
}
