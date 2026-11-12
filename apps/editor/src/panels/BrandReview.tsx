import { useEffect, useMemo, useRef, useState } from 'react';
import { brandSuggestions, brandVersions, confirmSuggestions, dismissSuggestions, normalizeColor, REVIEW_SECTION_LABELS, type BrandData, type SuggestionRow } from '@bogen/core';
import { Check, X } from 'lucide-react';
import type { Session } from '../doc/session.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

/** REVIEW_SECTION_LABELS (in @bogen/core) marked for translation here, where they are shown. */
export const SECTION_WORDS = [
  msg('Identity and settings'), msg('Colours'), msg('Pairs'), msg('Logos'), msg('Font families'), msg('Type scale'), msg('Spacing'),
  msg('Radius'), msg('Rules'), msg('Words'), msg('Voice examples'), msg('Examples'), msg('Assets'),
];

const STATUS: Record<SuggestionRow['status'], string> = { new: msg('New'), edit: msg('Changes a confirmed value'), replaces: msg('Replaces a confirmed value') };

function Value({ text, field }: { text: string | null; field: string }) {
  const t = useT();
  if (text === null || text === '') return <span className="br-none">{t('none')}</span>;
  const colour = field === 'value' ? normalizeColor(text) : null;
  return <span className="br-value">{colour ? <span className="br-swatch" style={{ background: colour }} /> : null}{text}</span>;
}

/**
 * Every unconfirmed suggestion of a brand in one list, each as a diff of what binds now and what is suggested, with
 * where it came from. Confirm or dismiss one, a section or all, by mouse or by keyboard: j and k or the arrows move,
 * c or Enter confirms, d or Delete dismisses, and with Shift they act on all. Each action is one undo step.
 */
export function BrandReview({ s, data, onOpenSection }: { s: Session; data: BrandData; onOpenSection: (section: string) => void }) {
  const t = useT();
  const previous = useMemo(() => brandVersions(s.doc).at(-1)?.data, [s, data]);
  const rows = useMemo(() => brandSuggestions(data, previous), [data, previous]);
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const current = rows[Math.min(at, rows.length - 1)];

  useEffect(() => {
    if (at >= rows.length && rows.length) setAt(rows.length - 1);
  }, [rows.length, at]);
  useEffect(() => {
    list.current?.querySelector(`[data-key="${current?.key}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current?.key]);
  useEffect(() => {
    list.current?.focus();
  }, []);

  const confirm = (which: SuggestionRow[]) => { if (which.length) s.tx(() => confirmSuggestions(s.doc, which)); };
  const dismiss = (which: SuggestionRow[]) => { if (which.length) s.tx(() => dismissSuggestions(s.doc, which, previous)); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === 'j' || e.key === 'ArrowDown') setAt((i) => Math.min(rows.length - 1, i + 1));
    else if (key === 'k' || e.key === 'ArrowUp') setAt((i) => Math.max(0, i - 1));
    else if (e.key === 'Home') setAt(0);
    else if (e.key === 'End') setAt(rows.length - 1);
    else if ((key === 'c' || e.key === 'Enter') && e.shiftKey) confirm(rows);
    else if ((key === 'd' || e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey) dismiss(rows);
    else if (key === 'c' || e.key === 'Enter') { if (current) confirm([current]); }
    else if (key === 'd' || e.key === 'Delete' || e.key === 'Backspace') { if (current) dismiss([current]); }
    else if (key === 'e') { if (current) onOpenSection(current.section); }
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (!rows.length) return <div className="bp-group"><div className="bp-note" data-testid="brand-review-empty">{t('No suggestions wait for review. Everything in this brand is confirmed.')}</div></div>;

  const sections = [...new Set(rows.map((r) => r.section))];
  return (
    <section className="bp-group br" data-testid="brand-review">
      <header className="bp-group-head">
        <span className="bp-group-title">{t.n(rows.length, '{count} suggestion to review', '{count} suggestions to review')}</span>
        <span className="row">
          <button type="button" className="btn" onClick={() => confirm(rows)} data-testid="brand-review-confirm-all" title="Shift+C"><Check size={14} /> {t('Confirm all')}</button>
          <button type="button" className="btn btn-quiet" onClick={() => dismiss(rows)} data-testid="brand-review-dismiss-all" title="Shift+D"><X size={14} /> {t('Dismiss all')}</button>
        </span>
      </header>
      <div className="bp-group-hint">{t('{next} and {previous} move, {confirm} confirms, {dismiss} dismisses, {open} opens the section, {confirmAll} and {dismissAll} act on all.', { next: 'j', previous: 'k', confirm: 'c', dismiss: 'd', open: 'e', confirmAll: 'Shift+C', dismissAll: 'Shift+D' })} {t('Dismissing an edit puts back the value of the last version.')} {t('{shortcut} undoes.', { shortcut: 'Ctrl+Z' })}</div>
      <div className="br-list" ref={list} tabIndex={0} role="listbox" aria-label={t('Suggestions')} aria-activedescendant={current ? `br-${current.key}` : undefined} onKeyDown={onKey} data-testid="brand-review-list">
        {sections.map((section) => {
          const inSection = rows.filter((r) => r.section === section);
          return (
            <div key={section} className="br-section" data-section={section}>
              <div className="br-section-head">
                <span>{t(REVIEW_SECTION_LABELS[section])}</span>
                <span className="row">
                  <button type="button" className="bf-link" onClick={() => confirm(inSection)} data-testid="brand-review-confirm-section">{t('Confirm {count}', { count: inSection.length })}</button>
                  <button type="button" className="bf-link" onClick={() => dismiss(inSection)} data-testid="brand-review-dismiss-section">{t('Dismiss {count}', { count: inSection.length })}</button>
                </span>
              </div>
              {inSection.map((r) => {
                const index = rows.indexOf(r);
                return (
                  <div key={r.key} id={`br-${r.key}`} role="option" aria-selected={index === at} className={`br-row${index === at ? ' is-active' : ''}`} data-key={r.key} data-testid="brand-review-row" data-status={r.status} onClick={() => setAt(index)}>
                    <div className="br-row-head">
                      <span className="br-name" dir="auto">{r.name}</span>
                      <span className="br-status">{t(STATUS[r.status])}</span>
                      <span className="br-source" title={t('Where the suggestion came from')}>{r.source ? (r.source.startsWith('capture:') ? t('Captured from {source}', { source: r.source.slice(8) }) : r.source.startsWith('file:') ? t('From file {file}', { file: r.source.slice(5) }) : r.source) : t('Added by an agent')}</span>
                      <button type="button" className="icon-btn" title={t('Confirm ({key})', { key: 'c' })} aria-label={t('Confirm {name}', { name: r.name })} onClick={(e) => { e.stopPropagation(); confirm([r]); }} data-testid="brand-review-confirm"><Check size={14} /></button>
                      <button type="button" className="icon-btn" title={t('Dismiss ({key})', { key: 'd' })} aria-label={t('Dismiss {name}', { name: r.name })} onClick={(e) => { e.stopPropagation(); dismiss([r]); }} data-testid="brand-review-dismiss"><X size={14} /></button>
                    </div>
                    <table className="br-diff">
                      <tbody>
                        {r.changes.map((c) => (
                          <tr key={c.field}>
                            <th scope="row">{c.field}</th>
                            <td className="br-from"><Value text={c.from} field={c.field} /></td>
                            <td className="br-to"><Value text={c.to} field={c.field} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {r.note ? <div className="bp-note br-note">{r.note}</div> : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
