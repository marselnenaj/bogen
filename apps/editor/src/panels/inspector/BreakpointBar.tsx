import { useState } from 'react';
import { kebabCss, type BogenNode } from '@bogen/core';
import { Columns3, X } from 'lucide-react';
import { useSnapVersion } from '../../doc/hooks.ts';
import { session } from '../../doc/session.ts';
import { breakpointKey, fileBreakpoints, inheritedAt, overridesAt } from '../../ops/breakpoints.ts';
import { ui, useUi } from '../../state/ui.ts';
import { useT } from '../../i18n/react.ts';

/**
 * Which width the inspector edits at. Base changes the layer everywhere; a breakpoint changes it only up to that
 * width, in its own @media block. At a breakpoint the bar lists what that width overrides, each with a way back to the
 * inherited value, so overrides and inherited values never look alike.
 */
export function BreakpointBar({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const width = useUi((s) => s.breakpoint);
  useSnapVersion();
  const { doc } = session();
  const [custom, setCustom] = useState('');
  const widths = fileBreakpoints(doc);
  const shown = width !== null && !widths.includes(width) ? [...widths, width].sort((a, b) => b - a) : widths;
  const single = nodes.length === 1 ? nodes[0]! : null;
  const overrides = single && width !== null ? overridesAt(single, width) : {};
  const artboard = single ? [single.id, ...doc.ancestors(single.id)].map((id) => doc.getNode(id)).find((n) => n?.artboard) : undefined;
  const pick = (w: number | null) => ui().set({ breakpoint: w });
  const addCustom = () => {
    const w = Math.round(Number(custom));
    if (w >= 200 && w <= 3000) pick(w);
    setCustom('');
  };
  const reset = (prop: string | null) => {
    if (!single || width === null) return;
    const s = session();
    s.tx(() => (prop ? s.doc.updateRules(single.id, breakpointKey(width), { [prop]: null }) : s.doc.deleteRules(single.id, breakpointKey(width))));
  };
  return (
    <div className={`bp-bar${width !== null ? ' is-scoped' : ''}`} data-testid="breakpoint-bar" data-breakpoint={width ?? 'base'}>
      <div className="bp-row" role="radiogroup" aria-label={t('Edit at width')}>
        <button type="button" role="radio" aria-checked={width === null} className={`bp-chip${width === null ? ' is-on' : ''}`} onClick={() => pick(null)} data-testid="breakpoint-base" title={t('Change the layer at every width')}>{t('Base')}</button>
        {shown.map((w) => (
          <button key={w} type="button" role="radio" aria-checked={width === w} className={`bp-chip${width === w ? ' is-on' : ''}`} onClick={() => pick(w)} data-testid={`breakpoint-${w}`} title={t('Change it only up to {width} px wide', { width: w })}>≤ {w}</button>
        ))}
        <input className="bp-custom" inputMode="numeric" placeholder="px" aria-label={t('Another width')} value={custom} data-testid="breakpoint-custom" onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} onBlur={addCustom} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') addCustom(); }} />
        {artboard ? <button type="button" className="bp-sizes" onClick={() => ui().set({ sizesOf: artboard.id })} data-testid="breakpoint-show-sizes" title={t('See this artboard at several widths side by side')}><Columns3 size={13} /> {t('Sizes')}</button> : null}
      </div>
      {width !== null ? (
        <div className="bp-scope" data-testid="breakpoint-scope">
          <p className="hint">{t('Changes here apply up to {width} px only. Values shown are what this layer has at {width} px; the canvas shows the base design.', { width })}</p>
          {single ? (
            Object.keys(overrides).length ? (
              <ul className="bp-overrides" data-testid="breakpoint-overrides">
                {Object.entries(overrides).map(([prop, value]) => (
                  <li key={prop} data-prop={kebabCss(prop)}>
                    <span className="bp-prop">{kebabCss(prop)}</span>
                    <span className="bp-value">{value}</span>
                    <span className="bp-from" data-testid={`breakpoint-inherited-${kebabCss(prop)}`}>{((i) => (i.from === 'base' ? t('instead of {value} from base', { value: i.value ?? 'unset' }) : t('instead of {value} from {from}', { value: i.value ?? 'unset', from: i.from })))(inheritedAt(single, width, prop))}</span>
                    <button type="button" className="icon-btn" title={t('Use the inherited {property} again', { property: kebabCss(prop) })} onClick={() => reset(prop)} data-testid={`breakpoint-reset-${kebabCss(prop)}`}><X size={11} /></button>
                  </li>
                ))}
                <li><button type="button" className="run-link" onClick={() => reset(null)} data-testid="breakpoint-reset-all">{t('Clear the overrides at {width}', { width })}</button></li>
              </ul>
            ) : <p className="hint" data-testid="breakpoint-inherits">{t('No overrides at {width}: everything is inherited.', { width })}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
