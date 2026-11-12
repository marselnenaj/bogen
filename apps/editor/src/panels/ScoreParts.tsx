import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { BrandScore } from '../lib/brand-api.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

const CATEGORY_NAMES: Record<string, string> = {
  colour: msg('Colour'), contrast: msg('Contrast'), type: msg('Type'), spacing: msg('Spacing'), shape: msg('Shape'), logo: msg('Logo'), voice: msg('Voice'), rules: msg('Rules'), tokens: msg('Tokens'),
};
const QUALITY_NAMES: Record<string, string> = { hierarchy: msg('Type hierarchy'), rhythm: msg('Spacing rhythm'), roles: msg('Palette roles'), system: msg('Tokens, logo, components') };

function Bar({ value }: { value: number }) {
  return <span className="bf-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}

/**
 * What a brand score is made of, in the Brand tab of a file: what would raise it most, conformance per category and
 * the parts of quality. Each row selects the layers it is about.
 */
export function ScoreParts({ score, onSelect }: { score: BrandScore; onSelect: (ids: string[]) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const raise = score.raise ?? [];
  const pick = (ids: string[] | undefined) => (ids?.length ? () => onSelect(ids) : undefined);
  const vars = { conformance: score.conformance, quality: score.quality ?? '', penalty: score.hard_penalty ?? 0, value: score.value };
  const sum = score.quality === undefined
    ? (score.hard_penalty ? t('Conformance {conformance}, less {penalty} for hard problems, makes {value}.', vars) : t('Conformance {conformance}, makes {value}.', vars))
    : (score.hard_penalty ? t('60% of conformance {conformance} and 40% of quality {quality}, less {penalty} for hard problems, makes {value}.', vars) : t('60% of conformance {conformance} and 40% of quality {quality}, makes {value}.', vars));
  return (
    <div className="bf-parts" data-testid="brand-score-parts">
      <div className="hint" data-testid="brand-score-sum">{sum}</div>
      {raise.length ? (
        <div data-testid="brand-score-raise">
          <div className="bf-title">{t('What would raise it most')}</div>
          <div className="bf-list">
            {raise.map((l) => (
              <button key={`${l.kind}${l.key}`} type="button" className="bf-item bf-part" onClick={pick(l.node_ids)} disabled={!l.node_ids.length} data-testid="brand-lever" data-key={l.key} title={l.node_ids.length ? t.n(l.node_ids.length, 'Select {count} layer', 'Select {count} layers') : undefined}>
                <span className="bf-item-head"><span className="bf-gain">+{l.gain}</span><span className="bf-item-text">{l.label}</span>{l.node_ids.length ? <span className="bf-count">{t.n(l.node_ids.length, '{count} layer', '{count} layers')}</span> : null}</span>
                <span className="bf-fix">{l.how}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" className="bf-title bf-toggle" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="brand-score-parts-toggle">
        <span>{t('Parts of the score')}</span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open ? (
        <>
          <div className="bf-list" data-testid="brand-score-categories">
            {score.categories.map((c) => (
              <button key={c.category} type="button" className="bf-item bf-part" onClick={pick(c.node_ids)} disabled={!c.node_ids?.length} data-testid="brand-score-category" data-category={c.category}>
                <span className="bf-item-head"><span className="bf-part-name">{CATEGORY_NAMES[c.category] ? t(CATEGORY_NAMES[c.category]!) : c.category}</span><Bar value={c.score} /><span className="bf-count">{c.score}</span></span>
                <span className="bf-fix">{c.failed ? t.n(c.checked, '{failed} of {count} check failed, weight {weight}', '{failed} of {count} checks failed, weight {weight}', { failed: c.failed, weight: c.weight }) : t.n(c.checked, '{count} check, all passed, weight {weight}', '{count} checks, all passed, weight {weight}', { weight: c.weight })}</span>
              </button>
            ))}
          </div>
          {score.quality_parts.length ? (
            <div className="bf-list" data-testid="brand-score-quality">
              {score.quality_parts.map((q) => (
                <button key={q.dimension} type="button" className="bf-item bf-part" onClick={pick(q.node_ids)} disabled={!q.node_ids?.length} data-testid="brand-score-quality-part" data-dimension={q.dimension}>
                  <span className="bf-item-head"><span className="bf-part-name">{QUALITY_NAMES[q.dimension] ? t(QUALITY_NAMES[q.dimension]!) : q.dimension}</span><Bar value={q.score} /><span className="bf-count">{q.score}</span></span>
                  <span className="bf-fix">{q.basis}</span>
                </button>
              ))}
            </div>
          ) : <div className="hint">{t('Too little here to judge quality, so the score is conformance alone.')}</div>}
        </>
      ) : null}
    </div>
  );
}
