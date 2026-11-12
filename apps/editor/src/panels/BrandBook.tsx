import { useEffect, useState } from 'react';
import { BRAND_BOOK_CHAPTERS, brandBookReadiness, brandLanguages, chapterLanguage, languageDirection, updateBrandBookChapter, type BrandBookChapterId, type BrandBookStatus, type BrandData } from '@bogen/core';
import type { Session } from '../doc/session.ts';
import { useT } from '../i18n/react.ts';
import { languageLabel, languageOptions } from './ContentLanguage.tsx';
import { SelectField } from '../ui/controls.tsx';

/** Small safe Markdown subset. Content is React text, never executable HTML. */
function BookCopy({ text }: { text: string }) {
  return <div className="brand-book-copy">{text.split(/\n\s*\n/).map((block, i) => {
    if (/^#{1,4} /.test(block)) return <h4 key={i}>{block.replace(/^#{1,4} /, '')}</h4>;
    if (block.split('\n').every((line) => /^[-*] /.test(line))) return <ul key={i}>{block.split('\n').map((line, j) => <li key={j}>{line.slice(2)}</li>)}</ul>;
    return <p key={i}>{block}</p>;
  })}</div>;
}

/** Local editing buffer deliberately survives sync and 409 conflicts. Explicit save, never on blur. */
export function BrandBook({ brandId, data, by, session }: { brandId: string; data: BrandData; by: string; session: Session }) {
  const t = useT();
  const [id, setId] = useState<BrandBookChapterId>('strategy');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ markdown: '', source: '', questions: '', lang: '' });
  const [revision, setRevision] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const chapter = data.book?.chapters.find((c) => c.id === id);
  const def = BRAND_BOOK_CHAPTERS.find((c) => c.id === id)!;
  const readiness = brandBookReadiness(data);
  // A chapter is in the language its author wrote it in, not the interface's: the brand's primary unless it says
  // otherwise. Unknown is said as unknown (lang=""), never left to inherit the interface language.
  const langs = brandLanguages(data);
  const lang = chapterLanguage(editing ? { lang: draft.lang || undefined, markdown: draft.markdown } : chapter, langs);
  const own = { lang: lang ?? '', dir: lang ? languageDirection(lang) : 'auto' } as const;
  const label = (status: BrandBookStatus) => status === 'confirmed' ? t('Confirmed') : status === 'draft' ? t('Draft') : status === 'not-applicable' ? t('Not applicable') : t('Open');
  const begin = () => {
    setDraft({ markdown: chapter?.markdown ?? '', source: chapter?.source ?? '', questions: chapter?.questions ?? '', lang: chapter?.lang ?? '' });
    setRevision(chapter?.revision ?? null); setError(''); setEditing(true);
  };
  useEffect(() => { setEditing(false); setError(''); }, [brandId]);
  const save = async (status: BrandBookStatus) => {
    setSaving(true); setError('');
    const { lang: chosen, ...text } = draft;
    const values = editing ? { ...text, lang: chosen || null } : { markdown: chapter?.markdown ?? '', source: chapter?.source ?? '', questions: chapter?.questions ?? '' };
    try {
      session.tx(() => updateBrandBookChapter(session.doc, { id, ...values, status, expectedRevision: editing ? revision : chapter?.revision ?? null }, by, true));
      setEditing(false);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <section className="brand-book" data-testid="brand-book">
    <header><h2>{t('Brandbook')}</h2><p>{t('Drafts are proposals. Only confirmed chapters guide design. Open questions stay visible.')}</p></header>
    <p className="brand-book-progress" data-testid="brand-book-readiness">{t('Confirmed')} {readiness.confirmed}/{readiness.total} · {t('Draft')} {readiness.draft} · {t('Open')} {readiness.open} · {t('Not applicable')} {readiness.notApplicable}</p>
    {/* Chapter names, their prompts and the foundations come from the brand model in English, like template names. */}
    {readiness.foundationGaps.length ? <p className="bp-group-hint">{t('Required')}: <span lang="en">{readiness.foundationGaps.join(', ')}</span></p> : null}
    <label className="brand-book-picker"><span>{t('Chapter')}</span><select value={id} disabled={editing || saving} onChange={(e) => { setId(e.target.value as BrandBookChapterId); setError(''); }} data-testid="brand-book-chapter">{BRAND_BOOK_CHAPTERS.map((d, i) => <option key={d.id} value={d.id}>{String(i + 1).padStart(2, '0')} · {d.title} · {label(data.book?.chapters.find((c) => c.id === d.id)?.status ?? 'open')}</option>)}</select></label>
    <article>
      <div className="brand-book-title"><h3 lang="en">{def.title}</h3><span>{label(chapter?.status ?? 'open')}</span></div>
      <p className="bp-group-hint" lang="en">{def.prompt}</p>
      {editing ? <>
        <SelectField<string> label={t('Language')} value={draft.lang} options={[{ value: '', label: langs.primary ? languageLabel(langs.primary) : t('Language: not set') }, ...languageOptions([draft.lang, ...langs.all]).filter((o) => o.value !== langs.primary)]} onChange={(v) => setDraft({ ...draft, lang: v })} testId="brand-book-language" />
        <label>{t('Content')}<textarea rows={15} value={draft.markdown} maxLength={12000} onChange={(e) => setDraft({ ...draft, markdown: e.target.value })} {...own} data-testid="brand-book-content" /></label>
        <label>{t('Source')}<textarea rows={2} value={draft.source} maxLength={2000} onChange={(e) => setDraft({ ...draft, source: e.target.value })} {...own} data-testid="brand-book-source" /></label>
        <label>{t('Open questions')}<textarea rows={3} value={draft.questions} maxLength={4000} onChange={(e) => setDraft({ ...draft, questions: e.target.value })} {...own} data-testid="brand-book-questions" /></label>
        <div className="brand-book-actions"><button className="btn" disabled={saving} onClick={() => void save('draft')} data-testid="brand-book-save">{t('Save')}</button><button className="btn btn-quiet" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>{t('Cancel')}</button></div>
      </> : <>
        {/* What the author wrote, in its own language; the interface words around it stay in the interface's. */}
        <div data-testid="brand-book-copy" {...(chapter?.markdown ? own : {})}><BookCopy text={chapter?.markdown || t('No data yet')} /></div>
        {chapter?.source ? <p className="brand-book-copy"><strong>{t('Source')}</strong><br /><span {...own} data-testid="brand-book-source-text">{chapter.source}</span></p> : null}
        {chapter?.questions ? <p className="brand-book-copy"><strong>{t('Open questions')}</strong><br /><span {...own}>{chapter.questions}</span></p> : null}
        <div className="brand-book-actions">
          <button className="btn" disabled={saving} onClick={begin} data-testid="brand-book-edit">{t('Edit')}</button>
          {chapter?.status === 'draft' && chapter.markdown ? <button className="btn btn-quiet" disabled={saving || !!chapter.questions.trim() || !chapter.source.trim()} title={chapter.questions.trim() ? t('Resolve open questions before confirming.') : !chapter.source.trim() ? t('Add a source') : t('Confirm')} onClick={() => void save('confirmed')} data-testid="brand-book-confirm">{t('Confirm')}</button> : null}
          {chapter && ['confirmed', 'not-applicable'].includes(chapter.status) ? <button className="btn btn-quiet" disabled={saving} onClick={() => void save('draft')} data-testid="brand-book-reopen">{t('Reopen')}</button> : null}
          {chapter?.markdown && !chapter.questions.trim() && chapter.status !== 'not-applicable' && chapter.status !== 'confirmed' ? <button className="btn btn-quiet" disabled={saving} onClick={() => void save('not-applicable')} data-testid="brand-book-na">{t('Not applicable')}</button> : null}
        </div>
      </>}
      {error ? <p role="alert" data-testid="brand-book-error">{error}</p> : null}
    </article>
  </section>;
}
