import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { linkedArtboards, planResponsive, responsiveLink, type BogenNode, type ResponsiveMethod } from '@bogen/core';
import { useSnapVersion } from '../../doc/hooks.ts';
import { session } from '../../doc/session.ts';
import { goToLayer } from '../../ops/reveal.ts';
import { DEFAULT_WIDTHS, makeResponsive, useResponsiveRun } from '../../ops/responsive.ts';
import { editor } from '../../state/store.ts';
import { ui } from '../../state/ui.ts';
import { Section, Segmented, TextField } from '../../ui/controls.tsx';
import { setFields } from '../../ops/ops.ts';
import { msg } from '../../i18n/core.ts';
import { useT } from '../../i18n/react.ts';

const METHOD_HINT: Record<ResponsiveMethod, string> = {
  rules: msg('Media rules on the same layers, which is what code wants. The page adapts in the browser and in the code tab.'),
  artboards: msg('Linked artboards next to this one. Make them again after you change this one, and they follow.'),
};

/** An artboard's narrower versions: what they change, making them, and what still sticks out afterwards. */
export function ResponsiveSection({ node }: { node: BogenNode }) {
  const t = useT();
  const { doc } = session();
  const version = useSnapVersion();
  const [method, setMethod] = useState<ResponsiveMethod>('rules');
  const [widths, setWidths] = useState<number[]>(DEFAULT_WIDTHS);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useResponsiveRun(node.id);
  const link = responsiveLink(doc, node.id);
  const width = parseFloat(node.style.width ?? '') || 0;
  const plan = useMemo(() => {
    if (link) return null;
    try {
      return planResponsive(doc, node.id, { widths, method });
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [doc, node.id, widths, method, version, link]);
  if (link) {
    const source = doc.getNode(link.source);
    return (
      <Section title={t('Responsive')} note={`${link.width}`} collapsible defaultOpen={false}>
        <div className="hint">{source?.name ? t('The {width} version of {name}. Make the variants again from there after you change it.', { width: link.width, name: source.name }) : t('The {width} version of another artboard. Make the variants again from there after you change it.', { width: link.width })}</div>
        <button type="button" className="btn" onClick={() => goToLayer(link.source, { fit: true })} data-testid="responsive-source">{source?.name ? t('Go to {name}', { name: source.name }) : t('Go to the source')}</button>
      </Section>
    );
  }
  const reasons = plan && 'changes' in plan ? countReasons(plan.changes) : [];
  const existing = linkedArtboards(doc, node.id).length > 0 || Object.keys(node.rules ?? {}).some((k) => k.startsWith('@media'));
  const label = widths.slice().sort((a, b) => b - a).map(String).reduce((first, second) => t('{first} and {second}', { first, second }));
  const go = async () => {
    setBusy(true);
    try {
      await makeResponsive(node.id, { widths, method });
    } catch (e) {
      editor().showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addWidth = () => {
    const w = Math.round(Number(adding));
    if (w >= 200 && w < width && !widths.includes(w) && widths.length < 4) setWidths([...widths, w].sort((a, b) => b - a));
    setAdding('');
  };
  return (
    <Section title={t('Responsive')} note={width ? `${node.name} ${width}` : undefined} collapsible defaultOpen={Boolean(run)}>
      <div className="responsive" data-testid="responsive-section">
        <WebPageFields node={node} />
        <Segmented<ResponsiveMethod> value={method} onChange={setMethod} testId="responsive-method" options={[{ value: 'rules', label: t('Media rules'), title: t('Media rules on the same layers') }, { value: 'artboards', label: t('Linked artboards'), title: t('Linked artboards next to this one') }]} />
        <div className="hint">{t(METHOD_HINT[method])}</div>
        <div className="responsive-widths">
          {widths.map((w) => (
            <button key={w} type="button" className="responsive-width" title={t('Leave out {width}', { width: w })} disabled={widths.length === 1} onClick={() => setWidths(widths.filter((x) => x !== w))} data-testid={`responsive-width-${w}`}>
              {w}<X size={11} />
            </button>
          ))}
          {widths.length < 4 ? (
            <input
              className="responsive-add"
              inputMode="numeric"
              placeholder={t('+ width')}
              value={adding}
              data-testid="responsive-add"
              onChange={(e) => setAdding(e.target.value.replace(/\D/g, ''))}
              onBlur={addWidth}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addWidth(); }}
            />
          ) : null}
        </div>
        {plan && 'error' in plan ? <div className="hint">{plan.error}</div> : null}
        {reasons.length ? (
          <div className="responsive-plan" data-testid="responsive-plan">
            <div className="param-label">{t('What changes')}</div>
            {reasons.map(([why, n]) => <div key={why} className="responsive-line"><span>{why}</span><span>{t.n(n, '{count} layer', '{count} layers')}</span></div>)}
          </div>
        ) : null}
        <button type="button" className="btn" onClick={() => ui().set({ sizesOf: node.id })} data-testid="responsive-show-sizes">{t('See it at several widths')}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !plan || 'error' in plan} onClick={() => void go()} data-testid="responsive-run">
          {busy ? t('Making and checking') : existing ? t('Update {widths}', { widths: label }) : t('Make {widths}', { widths: label })}
        </button>
        {run ? <CheckView run={run} /> : null}
      </div>
    </Section>
  );
}

function countReasons(changes: { id: string; why: string[] }[]): [string, number][] {
  const out = new Map<string, Set<string>>();
  for (const c of changes) for (const why of c.why) {
    const set = out.get(why) ?? new Set();
    set.add(c.id);
    out.set(why, set);
  }
  return [...out].map(([why, ids]) => [why[0]!.toUpperCase() + why.slice(1), ids.size]);
}

function CheckView({ run }: { run: NonNullable<ReturnType<typeof useResponsiveRun>> }) {
  const t = useT();
  return (
    <div className="responsive-check" data-testid="responsive-check">
      <div className="param-label">{run.layers ? t.n(run.layers, 'Check, {count} layers changed', 'Check, {count} layers changed') : t('Check')}</div>
      {run.error ? <div className="hint">{t('The check could not run: {error}', { error: run.error })}</div> : null}
      {!run.check && !run.error ? <div className="hint">{t('Laying each width out.')}</div> : null}
      {run.check?.map((r) => {
        const issues = [...r.overflow, ...r.clipped_text.map((c) => ({ ...c, by: undefined }))];
        if (!issues.length) return <div key={r.width} className={`responsive-line${r.ok ? '' : ' is-over'}`} data-testid={`responsive-${r.ok ? 'ok' : 'over'}-${r.width}`}><span>{r.width}</span><span>{r.ok ? t('Fits') : t('{amount} px too wide', { amount: r.content_wider_by })}</span></div>;
        return issues.slice(0, 8).map((i, n) => (
          <button key={`${r.width}-${n}`} type="button" className="responsive-line is-over" title={t('Select this layer')} onClick={() => goToLayer(i.id, { fit: false })} data-testid={`responsive-over-${r.width}`}>
            <span>{r.width} · {i.name || i.id}</span><span>{i.by !== undefined ? `+${i.by} px` : t('cut off')}</span>
          </button>
        ));
      })}
      {run.notes.map((n) => <div key={n} className="hint">{n}</div>)}
      {run.check ? <div className="hint">{t('Click a row to select the layer. An agent can refine the rest with {tool}.', { tool: 'responsive_check' })}</div> : null}
    </div>
  );
}

/**
 * Whether this artboard is a web page, and what its page says about itself. A web page's export grows with the window
 * up to the artboard's width and gets a head for the web: a viewport, its language and description, its name as the
 * title. An app screen, a poster or a slide stays off and keeps its size.
 */
function WebPageFields({ node }: { node: BogenNode }) {
  const t = useT();
  const attrs = node.attrs ?? {};
  const web = attrs['data-web'] === 'page';
  const put = (patch: Record<string, string | null>) => {
    const next: Record<string, string> = { ...attrs };
    for (const [k, v] of Object.entries(patch)) if (v === null || v === '') delete next[k]; else next[k] = v;
    setFields([node.id], { attrs: next });
  };
  return (
    <div className="web-page" data-testid="web-page" data-web={web ? 'page' : ''}>
      <label className="check"><input type="checkbox" checked={web} onChange={(e) => put({ 'data-web': e.target.checked ? 'page' : null })} data-testid="web-page-toggle" /> {node.style.width != null ? t('Web page: as wide as the window in the export, up to {width}', { width: node.style.width }) : t('Web page: as wide as the window in the export, up to its width')}</label>
      {web ? (
        <>
          <TextField label={t('Lang')} value={attrs.lang ?? ''} placeholder="en" onChange={(v) => { if (!v || /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v.trim())) put({ lang: v.trim() || null }); }} title={t("The page's language, for screen readers and hyphenation")} testId="web-page-lang" />
          <TextField value={attrs['data-description'] ?? ''} placeholder={t('What the page is about, for search results and shared links')} onChange={(v) => put({ 'data-description': v.replace(/[<>"]/g, '').slice(0, 300) || null })} title={t('meta description')} testId="web-page-description" />
        </>
      ) : null}
    </div>
  );
}
