import { inspectorStyle, updateScoped } from '../../ops/breakpoints.ts';
import type { BogenNode } from '@bogen/core';
import { Link2, Link2Off } from 'lucide-react';
import { computedBox, elOf, flowOf, isFlow } from '../../canvas/measure.ts';
import { session } from '../../doc/session.ts';
import { detectH, detectV, patchH, patchV, type HConstraint, type VConstraint } from '../../lib/constraints.ts';
import { fmt } from '../../lib/css-values.ts';
import { common, IconButton, MIXED, Row, SelectField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';

/** A locked ratio as width over height, or null. CSS holds it, in `aspect-ratio`. */
export function ratioOf(n: BogenNode): number | null {
  const v = n.style.aspectRatio;
  if (!v || v === 'auto') return null;
  const parts = v.replace('auto', '').trim().split('/').map((p) => parseFloat(p));
  const a = parts[0];
  if (!a) return null;
  const b = parts[1] ?? 1;
  return b ? a / b : null;
}

export function RatioLock({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const on = nodes.every((n) => ratioOf(n) !== null);
  const toggle = () => {
    const s = session();
    s.tx(() => {
      for (const n of nodes) {
        if (on) {
          const b = computedBox(n.id);
          updateScoped(s.doc, n.id, { aspectRatio: null, ...(b && !n.style.height ? { height: `${fmt(b.height)}px` } : {}) });
        } else {
          const b = computedBox(n.id);
          if (!b || !b.width || !b.height) continue;
          updateScoped(s.doc, n.id, { aspectRatio: `${fmt(b.width)} / ${fmt(b.height)}`, width: n.style.width ?? `${fmt(b.width)}px`, height: null });
        }
      }
    });
  };
  return <IconButton icon={on ? <Link2 size={14} /> : <Link2Off size={14} />} title={on ? t('Unlock the aspect ratio') : t('Lock the aspect ratio')} active={on} onClick={toggle} testId="insp-ratio" />;
}

/** Children placed freely in a frame can be pinned to its edges. */
export function ConstraintsRow({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const { snap } = session();
  const eligible = nodes.every((n) => snap.nodes.has(n.parent) && !isFlow(n.id) && flowOf(n.parent).kind === 'none');
  if (!eligible) return null;
  const hs = common(nodes.map((n) => detectH(n.style)));
  const vs = common(nodes.map((n) => detectV(n.style)));
  const set = (axis: 'h' | 'v', kind: string) => {
    const s = session();
    s.tx(() => {
      for (const n of nodes) {
        const box = computedBox(n.id);
        const parent = elOf(n.parent);
        if (!box || !parent) continue;
        updateScoped(s.doc, n.id, axis === 'h' ? patchH(kind as HConstraint, box.left, box.width, parent.clientWidth) : patchV(kind as VConstraint, box.top, box.height, parent.clientHeight));
      }
    });
  };
  return (
    <Row>
      <SelectField<HConstraint> label="↔" title={t('Horizontal constraint')} value={hs === MIXED ? MIXED : hs} testId="insp-constraint-h" onChange={(k) => set('h', k)} options={[{ value: 'left', label: t('Left') }, { value: 'right', label: t('Right') }, { value: 'both', label: t('Left and right') }, { value: 'center', label: t('Center') }, { value: 'scale', label: t('Scale') }]} />
      <SelectField<VConstraint> label="↕" title={t('Vertical constraint')} value={vs === MIXED ? MIXED : vs} testId="insp-constraint-v" onChange={(k) => set('v', k)} options={[{ value: 'top', label: t('Top') }, { value: 'bottom', label: t('Bottom') }, { value: 'both', label: t('Top and bottom') }, { value: 'center', label: t('Center') }, { value: 'scale', label: t('Scale') }]} />
    </Row>
  );
}

type OverflowMode = 'visible' | 'hidden' | 'clip' | 'auto' | 'scroll-x' | 'scroll-y' | 'other';

function overflowOf(n: BogenNode): OverflowMode {
  const { overflow, overflowX, overflowY } = n.style;
  const x = overflowX ?? overflow ?? 'visible';
  const y = overflowY ?? overflow ?? 'visible';
  if (x === y) {
    if (x === 'visible' || x === 'hidden' || x === 'clip') return x;
    if (x === 'auto' || x === 'scroll') return 'auto';
    return 'other';
  }
  if ((x === 'auto' || x === 'scroll') && (y === 'hidden' || y === 'clip')) return 'scroll-x';
  if ((y === 'auto' || y === 'scroll') && (x === 'hidden' || x === 'clip')) return 'scroll-y';
  return 'other';
}

const OVERFLOW_PATCH: Record<Exclude<OverflowMode, 'other'>, Record<string, string | null>> = {
  visible: { overflow: null, overflowX: null, overflowY: null },
  hidden: { overflow: 'hidden', overflowX: null, overflowY: null },
  clip: { overflow: 'clip', overflowX: null, overflowY: null },
  auto: { overflow: 'auto', overflowX: null, overflowY: null },
  'scroll-x': { overflow: null, overflowX: 'auto', overflowY: 'hidden' },
  'scroll-y': { overflow: null, overflowX: 'hidden', overflowY: 'auto' },
};

export function OverflowRow({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const value = common(nodes.map(overflowOf));
  return (
    <SelectField<OverflowMode>
      label={t('Overflow')}
      title={t('What happens to content that does not fit')}
      value={value}
      testId="insp-overflow"
      onChange={(m) => { if (m !== 'other') inspectorStyle(ids, OVERFLOW_PATCH[m]); }}
      options={[{ value: 'visible', label: t('Visible') }, { value: 'hidden', label: t('Clip') }, { value: 'auto', label: t('Scroll') }, { value: 'scroll-y', label: t('Scroll vertically') }, { value: 'scroll-x', label: t('Scroll horizontally') }, ...(value === 'other' ? [{ value: 'other' as const, label: t('Custom'), disabled: true }] : [])]}
    />
  );
}
