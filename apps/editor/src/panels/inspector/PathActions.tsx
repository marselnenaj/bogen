import type { BogenNode } from '@bogen/core';
import { Spline, SquaresExclude, SquaresIntersect, SquaresSubtract, SquaresUnite } from 'lucide-react';
import { booleanOp, canBoolean, isShape, shapeToPath, type BooleanKind } from '../../ops/vector.ts';
import { IconButton } from '../../ui/controls.tsx';
import { commandById, displayKeys } from '../../commands/registry.ts';
import { msg } from '../../i18n/core.ts';
import { useT } from '../../i18n/react.ts';

const OPS: { kind: BooleanKind; title: string; icon: React.ReactNode }[] = [
  { kind: 'union', title: msg('Union'), icon: <SquaresUnite size={15} /> },
  { kind: 'subtract', title: msg('Subtract'), icon: <SquaresSubtract size={15} /> },
  { kind: 'intersect', title: msg('Intersect'), icon: <SquaresIntersect size={15} /> },
  { kind: 'exclude', title: msg('Exclude'), icon: <SquaresExclude size={15} /> },
];

const keyHint = (id: string) => {
  const c = commandById(id);
  return c ? ` (${displayKeys(c)})` : '';
};

/** Combine several shapes, or turn one into a path. Only there when it applies. */
export function PathActions({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const combine = canBoolean(nodes);
  const convertible = nodes.length >= 1 && nodes.every((n) => isShape(n) || (n.type === 'svg' && /<(rect|circle|ellipse|line|polyline|polygon)\b/.test(n.svg ?? '')));
  if (!combine && !convertible) return null;
  return (
    <div className="path-actions" role="group" aria-label={t('Path operations')} data-testid="path-actions">
      {combine ? OPS.map((o) => <IconButton key={o.kind} icon={o.icon} title={`${t(o.title)}${keyHint(`vector.${o.kind}`)}`} onClick={() => void booleanOp(o.kind)} testId={`bool-${o.kind}`} />) : null}
      {convertible ? <button type="button" className="btn btn-quiet path-convert" title={`${t('Shape to path')}${keyHint('vector.toPath')}`} onClick={() => void shapeToPath()} data-testid="shape-to-path"><Spline size={14} /> {t('To path')}</button> : null}
    </div>
  );
}
