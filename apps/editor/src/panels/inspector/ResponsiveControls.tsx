import { autoGrid, containerNarrowPlan, mediaToContainerPlan, orderedBlocks, parseBlock, type BogenNode } from '@bogen/core';
import { rectOf } from '../../canvas/measure.ts';
import { session } from '../../doc/session.ts';
import { inspectorStyle } from '../../ops/breakpoints.ts';
import { editor } from '../../state/store.ts';
import { NumberField, Segmented, TextField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';

/**
 * Responsive controls that sit in the Layout section: how a grid makes its columns (a fixed count, or as many as fit
 * at a minimum width), and whether a frame responds to its own width as a container. What they write is plain CSS,
 * so the canvas, the browser and the export lay it out the same.
 */

type GridMode = 'fixed' | 'fit' | 'fill';

const AUTO = /^repeat\(\s*auto-(fit|fill)\s*,\s*minmax\(\s*(?:min\(\s*([^,()]+)\s*,\s*100%\s*\)|([^,()]+))\s*,\s*1fr\s*\)\s*\)$/;

export function gridModeOf(value: string | undefined): { mode: GridMode; min: string } {
  const m = AUTO.exec(value?.trim() ?? '');
  return m ? { mode: m[1] as 'fit' | 'fill', min: (m[2] ?? m[3] ?? '16rem').trim() } : { mode: 'fixed', min: '16rem' };
}

export function GridModeRow({ nodes, ids }: { nodes: BogenNode[]; ids: string[] }) {
  const t = useT();
  const first = nodes[0]!;
  const { mode, min } = gridModeOf(first.style.gridTemplateColumns);
  const gap = first.style.gap ?? '1rem';
  const set = (next: GridMode, width = min) => {
    if (next === 'fixed') inspectorStyle(ids, { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
    else inspectorStyle(ids, { gridTemplateColumns: autoGrid(width, gap, next).gridTemplateColumns! });
  };
  return (
    <div className="grid-mode" data-testid="grid-mode" data-mode={mode}>
      <Segmented<GridMode>
        value={mode}
        onChange={(m) => set(m)}
        testId="grid-mode-switch"
        options={[
          { value: 'fixed', label: t('Count'), title: t('A fixed number of columns') },
          { value: 'fit', label: t('Auto-fit'), title: t('As many columns as fit, stretched across') },
          { value: 'fill', label: t('Auto-fill'), title: t('As many columns as fit, empty tracks kept') },
        ]}
      />
      {mode !== 'fixed' ? (
        <TextField label={t('Min')} value={min} onChange={(v) => { if (/^\d+(\.\d+)?(px|rem|em|ch|%)$/.test(v.trim())) set(mode, v.trim()); }} title={t('Smallest column width; a phone gets one column narrower than this rather than overflowing')} testId="grid-mode-min" />
      ) : null}
    </div>
  );
}

const slug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'box';

/**
 * A frame whose content follows the frame's width, not the page's. A container query reaches only a container's
 * descendants, never the container itself: so this frame becomes the container, and its conditions go on the layouts
 * inside it (a row stacks, a grid drops to one column). The frame's own media rules answer to the slot it sits in,
 * which becomes their container when they are converted.
 */
export function ContainerRow({ node }: { node: BogenNode }) {
  const t = useT();
  const on = node.style.containerType === 'inline-size' || node.style.containerType === 'size';
  const name = node.style.containerName ?? slug(node.name);
  const measured = Math.round(rectOf(node.id)?.w ?? 0);
  const s = session();
  const inside = s.doc.descendants(node.id).flatMap((d) => Object.keys(d.rules ?? {}).filter((k) => parseBlock(k)?.at?.kind === 'container' && (parseBlock(k)!.at as { name?: string }).name === name).map(() => d.name));
  const media = [node, ...s.doc.descendants(node.id)].some((n) => orderedBlocks(n.rules ?? {}).some((b) => b.at?.kind === 'media'));
  const parent = s.doc.getNode(node.parent);
  const toggle = () => inspectorStyle([node.id], on ? { containerType: null, containerName: null } : { containerType: 'inline-size', containerName: name });
  const addNarrow = (width: number) => {
    const plan = containerNarrowPlan(s.doc, node.id, name, width);
    if (!plan.length) return editor().showToast(t('Nothing inside {name} lays out side by side. Its own layout follows the frame around it: use its media rules, or wrap its content in a frame.', { name: node.name }));
    s.tx(() => { for (const c of plan) s.doc.updateRules(c.id, c.key, c.props); });
    editor().showToast(t.n(plan.length, '{count} layout inside {name} stack when it is at most {width} px wide.', '{count} layouts inside {name} stack when it is at most {width} px wide.', { name: node.name, width: Math.round(width) }));
  };
  const convert = () => {
    if (!parent) return;
    const top = s.doc.getNode(s.doc.ancestors(node.id).at(-1) ?? node.id);
    const slotName = parent.style.containerName ?? slug(parent.name);
    const slotWidth = Math.round(rectOf(parent.id)?.w ?? 0) || parseFloat(parent.style.width ?? '') || 600;
    const plan = mediaToContainerPlan(s.doc, node.id, slotName, slotWidth, parseFloat(top?.style.width ?? '') || 1440);
    s.tx(() => {
      s.doc.updateStyle(plan.containerId, plan.containerStyle);
      for (const c of plan.changes) {
        const props = s.doc.getNode(c.id)?.rules?.[c.from];
        if (!props) continue;
        s.doc.updateRules(c.id, c.to, props);
        s.doc.deleteRules(c.id, c.from);
      }
    });
    const moved = t.n(plan.changes.length, '{count} media rule now follow the width of {parent}, the frame {name} sits in.', '{count} media rules now follow the width of {parent}, the frame {name} sits in.', { parent: parent.name, name: node.name });
    editor().showToast(plan.skipped.length ? `${moved} ${t.n(plan.skipped.length, '{count} left as they were.', '{count} left as they were.')}` : moved);
  };
  return (
    <div className="container-row" data-testid="container-row" data-container={on ? name : ''}>
      <label className="check"><input type="checkbox" checked={on} onChange={toggle} data-testid="container-toggle" /> {t("Content follows this frame's width")}</label>
      {on ? (
        <>
          <div className="hint">{measured
            ? t.rich("Container {name}, {width} px wide now. Conditions on the layers inside read this width, not the page's.", { name: <code>{name}</code>, width: measured })
            : t.rich("Container {name}. Conditions on the layers inside read this width, not the page's.", { name: <code>{name}</code> })}</div>
          {inside.length ? <div className="hint" data-testid="container-blocks">{t('Follows it: {layers}', { layers: [...new Set(inside)].join(', ') })}</div> : null}
          <NumberField label={t('Stack at')} value={Math.round((measured || 480) * 0.6)} min={80} testId="container-narrow-width" title={t('Rows and grids inside stack when this frame is at most this wide')} onChange={(v) => addNarrow(v)} />
        </>
      ) : null}
      {media && parent && !parent.artboard ? <button type="button" className="run-link" onClick={convert} data-testid="container-convert">{t('Make its media rules follow {name}', { name: parent.name })}</button> : null}
    </div>
  );
}
