import { useMemo, useSyncExternalStore } from 'react';
import { readCanvasPlan } from '@bogen/core';
import { runCommand } from '../../commands/registry.ts';
import { useComments, usePages, useStructureVersion } from '../../doc/hooks.ts';
import { session } from '../../doc/session.ts';
import { formatNumber } from '../../i18n/format.ts';
import { useT } from '../../i18n/react.ts';
import { useEditor } from '../../state/store.ts';
import { Section } from '../../ui/controls.tsx';
import { draftPrompt } from '../prompt-actions.ts';

/** With nothing selected the inspector is about the page: what it holds, and the way to its checks. */
export function PageSummary() {
  const t = useT();
  const pageId = useEditor((s) => s.pageId);
  const page = usePages().find((p) => p.id === pageId);
  const comments = useComments();
  const structure = useStructureVersion();
  const { doc, snap } = session();
  // The canvas plan is in the file's meta, which the structure version does not follow.
  const subscribe = useMemo(() => (notify: () => void) => { doc.meta.observe(notify); return () => doc.meta.unobserve(notify); }, [doc]);
  const sections = useSyncExternalStore(subscribe, () => (pageId ? readCanvasPlan(doc, pageId).sections.length : 0));
  const artboards = useMemo(() => (pageId ? doc.getChildren(pageId).filter((n) => n.artboard).length : 0), [doc, pageId, structure]);
  if (!page) return null;
  const open = comments.filter((c) => c.pageId === page.id && !c.resolved).length;
  const facts: [string, number, string][] = [[t('Artboards'), artboards, 'artboards'], [t('Sections'), sections, 'sections'], [t('Open comments'), open, 'comments']];
  return (
    <>
      <Section title={t('Page')} actions={<span className="section-aside" data-testid="nothing-selected">{t('Nothing selected')}</span>}>
        <div className="page-facts-name" dir="auto" data-testid="page-facts-name">{page.name}</div>
        <dl className="page-facts" data-testid="page-facts">
          {facts.map(([label, value, id]) => <div key={id} className="page-fact"><dt>{label}</dt><dd data-testid={`page-facts-${id}`}>{formatNumber(value)}</dd></div>)}
        </dl>
        {!snap.nodes.size ? <div className="hint">{t('Draw something with the tools above, or paste HTML to begin.')}</div> : null}
      </Section>
      <Section title={t('Design checks')}>
        <div className="hint">{t('Contrast, spacing, target sizes and accessibility on this page.')}</div>
        <div className="page-checks">
          <button type="button" className="btn" onClick={() => runCommand('view.checks')} data-testid="page-checks-run">{t('Run checks')}</button>
          <button type="button" className="btn btn-outline" onClick={() => runCommand('view.critique')} data-testid="page-critique">{t('Review like a designer')}</button>
          <button type="button" className="btn btn-outline" onClick={() => draftPrompt(t('Run design_lint and a11y_audit on the page {name} and fix what they find.', { name: page.name }))} data-testid="page-checks-ask">{t('Ask agent to fix')}</button>
        </div>
      </Section>
    </>
  );
}
