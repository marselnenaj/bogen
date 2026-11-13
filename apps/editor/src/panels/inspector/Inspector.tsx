import { ContainerRow, GridModeRow } from './ResponsiveControls.tsx';
import { FluidRow, fluidEnds } from './Typography.tsx';
import { useUi } from '../../state/ui.ts';
import { BreakpointBar } from './BreakpointBar.tsx';
import { nodeAt } from '../../ops/breakpoints.ts';
import { inspectorStyle, updateScoped } from '../../ops/breakpoints.ts';
import { useMemo, useState } from 'react';
import type { BogenNode } from '@bogen/core';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter,
  ArrowDown, ArrowRight, Ban, Crop, MoveHorizontal, MoveVertical, RectangleHorizontal, RectangleVertical, FlipHorizontal2, FlipVertical2, Grid3x3, LayoutGrid, Lock, Maximize2, Scan, Square, WrapText, Rows3,
} from 'lucide-react';
import { useFrameVersion, useSelectedNodes } from '../../doc/hooks.ts';
import { session } from '../../doc/session.ts';
import { computedBox, elOf, flowOf, isFlow, measure, parentLinear, rectOf } from '../../canvas/measure.ts';
import { common, IconButton, MIXED, NumberField, Row, Section, Segmented, SelectField, TextField, type Maybe } from '../../ui/controls.tsx';
import { fmt, fmtPx, parseSides, printSides, px, radiiOf } from '../../lib/css-values.ts';
import { align, distribute, FLOW_PATCH, flip, placement, positionPatchOf, setFields, tidy, toggleLock } from '../../ops/ops.ts';
import { editor, useEditor } from '../../state/store.ts';
import { apply, invert, linearOf, matRotation, normalizeDeg } from '../../canvas/geometry.ts';
import { FillsSection, BorderSection, EffectsSection, SelectionColors, OutlineSection } from './Appearance.tsx';
import { TypographySection } from './Typography.tsx';
import { RawCssSection } from './RawCss.tsx';
import { RepeatSection } from './RepeatSection.tsx';
import { ComponentSection, ModeSection, PageModeSection } from './ComponentSection.tsx';
import { ImageSection, ShaderSection, VectorSection } from './Media.tsx';
import { CodeSection } from './CodeSection.tsx';
import { Empty } from '../../ui/controls.tsx';
import { FRAME_PRESETS, presetOfSize, type FramePresetGroup } from '@bogen/core';
import { LayoutGridSection } from './LayoutGridSection.tsx';
import { resizeToPreset, swapOrientation } from '../../ops/frames.ts';
import { setSpacing, spacingInfo } from '../../ops/ops.ts';
import { addArtboard } from '../../ops/ops.ts';
import { ConstraintsRow, OverflowRow, RatioLock, ratioOf } from './Layout2.tsx';
import { PathActions } from './PathActions.tsx';
import { FontBuildSection, FontPanel, useIsGlyphPage } from './FontPanel.tsx';
import { PrototypeSection } from './Prototype.tsx';
import { VariablesSection } from './PrototypeState.tsx';
import { ResponsiveSection } from './ResponsiveSection.tsx';
import { RulesSection } from './RulesSection.tsx';
import { ctx, msg } from '../../i18n/core.ts';
import { useT } from '../../i18n/react.ts';

const GROUP_NAMES: Record<FramePresetGroup, string> = { Desktop: msg('Desktop'), Tablet: msg('Tablet'), Phone: msg('Phone'), Watch: msg('Watch'), Social: msg('Social'), Slides: msg('Slides'), Print: msg('Print') };

export function styleValue(nodes: BogenNode[], key: string): Maybe<string> | undefined {
  return common(nodes.map((n) => n.style[key] ?? ''));
}

const FRAME_TAGS = ['div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'ul', 'ol', 'li', 'form', 'button', 'a', 'label', 'details', 'summary', 'table', 'tr', 'td', 'th', 'input', 'textarea', 'select', 'hr'];
const TEXT_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'blockquote', 'code', 'pre', 'strong', 'em', 'small', 'td', 'th', 'time', 'figcaption', 'div'];

function Header({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const single = nodes.length === 1 ? nodes[0]! : null;
  const tags = single?.type === 'text' ? TEXT_TAGS : FRAME_TAGS;
  return (
    <div className="insp-header">
      {single ? (
        <TextField className="insp-name" value={single.name} onChange={(name) => setFields([single.id], { name })} testId="insp-name" />
      ) : <span className="insp-count">{t.n(nodes.length, '{count} layer', '{count} layers')}</span>}
      {single && (single.type === 'frame' || single.type === 'text') ? (
        <SelectField
          className="insp-tag"
          value={single.tag}
          options={tags.map((tag) => ({ value: tag, label: `<${tag}>` }))}
          onChange={(tag) => setFields([single.id], { tag })}
          title={t('HTML element')}
          testId="insp-tag"
        />
      ) : null}
    </div>
  );
}

function AlignRow({ count }: { count: number }) {
  const t = useT();
  const btn = (icon: React.ReactNode, title: string, run: () => void, disabled?: boolean) => <IconButton icon={icon} title={title} onClick={run} disabled={disabled} tabIndex={-1} />;
  return (
    <div className="align-row"><div className="align-controls">
      {btn(<AlignStartVertical size={15} />, t('Align left ({shortcut})', { shortcut: 'Alt+A' }), () => align('left'))}
      {btn(<AlignCenterVertical size={15} />, t('Align horizontal centres ({shortcut})', { shortcut: 'Alt+H' }), () => align('hcenter'))}
      {btn(<AlignEndVertical size={15} />, t('Align right ({shortcut})', { shortcut: 'Alt+D' }), () => align('right'))}
      {btn(<AlignStartHorizontal size={15} />, t('Align top ({shortcut})', { shortcut: 'Alt+W' }), () => align('top'))}
      {btn(<AlignCenterHorizontal size={15} />, t('Align vertical centres ({shortcut})', { shortcut: 'Alt+V' }), () => align('vcenter'))}
      {btn(<AlignEndHorizontal size={15} />, t('Align bottom ({shortcut})', { shortcut: 'Alt+S' }), () => align('bottom'))}
      </div><div className="distribute-controls">
      {btn(<AlignHorizontalDistributeCenter size={15} />, t('Distribute horizontal ({shortcut})', { shortcut: 'Alt+Shift+H' }), () => distribute('x'), count < 3)}
      {btn(<AlignVerticalDistributeCenter size={15} />, t('Distribute vertical ({shortcut})', { shortcut: 'Alt+Shift+V' }), () => distribute('y'), count < 3)}
      {btn(<LayoutGrid size={15} />, t('Tidy up ({shortcut})', { shortcut: 'Ctrl+Alt+T' }), tidy, count < 2)}
    </div></div>
  );
}

type SizeMode = 'fixed' | 'hug' | 'fill';

function sizeModeOf(n: BogenNode, axis: 'width' | 'height', parentFlow: ReturnType<typeof flowOf>): SizeMode {
  const v = n.style[axis];
  const main = parentFlow.kind === 'flow' && (axis === 'width') === (parentFlow.axis === 'x');
  if (parentFlow.kind === 'flow' && !parentFlow.grid) {
    if (main && Number(n.style.flexGrow ?? 0) >= 1) return 'fill';
    if (!main && n.style.alignSelf === 'stretch') return 'fill';
  }
  if (v === '100%') return 'fill';
  if (!v || v === 'auto' || v === 'fit-content' || v === 'max-content' || v === 'min-content') return 'hug';
  return 'fixed';
}

function setSizeMode(ids: string[], axis: 'width' | 'height', mode: SizeMode): void {
  const s = session();
  const { snap, doc } = s;
  s.tx(() => {
    for (const id of ids) {
      const n = snap.nodes.get(id);
      if (!n) continue;
      const pf = snap.nodes.has(n.parent) ? flowOf(n.parent) : ({ kind: 'none' } as const);
      const main = pf.kind === 'flow' && (axis === 'width') === (pf.axis === 'x');
      const box = computedBox(id);
      const clear: Record<string, string | null> = main ? { flexGrow: null, flexBasis: null } : { alignSelf: null };
      if (mode === 'fixed') updateScoped(doc, id, { ...clear, [axis]: fmtPx(box ? (axis === 'width' ? box.width : box.height) : 100) });
      else if (mode === 'hug') updateScoped(doc, id, { ...clear, [axis]: 'fit-content' });
      else if (pf.kind === 'flow' && !pf.grid) {
        if (main) updateScoped(doc, id, { flexGrow: '1', flexBasis: '0', [axis]: null, ...(axis === 'width' ? { minWidth: '0' } : { minHeight: '0' }) });
        else updateScoped(doc, id, { alignSelf: 'stretch', [axis]: null });
      } else updateScoped(doc, id, { [axis]: '100%' });
    }
  });
}

function SizeField({ nodes, axis, label }: { nodes: BogenNode[]; axis: 'width' | 'height'; label: string }) {
  const t = useT();
  const { snap } = session();
  const ids = nodes.map((n) => n.id);
  const values = nodes.map((n) => {
    const b = computedBox(n.id);
    return b ? Number(fmt(axis === 'width' ? b.width : b.height)) : 0;
  });
  const value = common(values) ?? 0;
  const modes = nodes.map((n) => sizeModeOf(n, axis, snap.nodes.has(n.parent) ? flowOf(n.parent) : { kind: 'none' }));
  const mode = common(modes);
  const canFill = nodes.every((n) => snap.nodes.has(n.parent));
  const canHug = nodes.every((n) => n.type === 'frame' || n.type === 'text');
  const lockedRatio = nodes.length === 1 ? ratioOf(nodes[0]!) : null;
  return (
    <div className="size-field">
      <NumberField
        label={label}
        value={value}
        min={0}
        testId={`insp-${axis}`}
        onChange={(v) => {
          // With the ratio locked the width decides, and CSS works out the height from it.
          if (lockedRatio) inspectorStyle(ids, { width: fmtPx(axis === 'width' ? v : v * lockedRatio), height: null, flexGrow: null, flexBasis: null });
          else inspectorStyle(ids, { [axis]: fmtPx(v), ...(axis === 'width' ? { flexGrow: null, flexBasis: null } : { alignSelf: null }) });
        }}
        onRaw={(raw) => inspectorStyle(ids, { [axis]: raw })}
      />
      <SelectField<SizeMode>
        className="size-mode"
        value={mode}
        title={axis === 'width' ? t('Width mode') : t('Height mode')}
        onChange={(m) => setSizeMode(ids, axis, m)}
        options={[{ value: 'fixed', label: t('Fixed') }, { value: 'hug', label: t('Hug'), disabled: !canHug }, { value: 'fill', label: t(ctx('sizing: fill the container', 'Fill')), disabled: !canFill }]}
        testId={`insp-${axis}-mode`}
      />
    </div>
  );
}

function PositionSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  useFrameVersion();
  const { snap } = session();
  const ids = nodes.map((n) => n.id);
  const abs = nodes.map((n) => !isFlow(n.id));
  const allAbs = abs.every(Boolean);
  const anyParentFlow = nodes.some((n) => snap.nodes.has(n.parent));
  const xs = nodes.map((n) => {
    if (!isFlow(n.id)) return Number(fmt(computedBox(n.id)?.left ?? 0));
    const r = rectOf(n.id);
    const pr = rectOf(n.parent);
    return r && pr ? Number(fmt(r.x - pr.x)) : 0;
  });
  const ys = nodes.map((n) => {
    if (!isFlow(n.id)) return Number(fmt(computedBox(n.id)?.top ?? 0));
    const r = rectOf(n.id);
    const pr = rectOf(n.parent);
    return r && pr ? Number(fmt(r.y - pr.y)) : 0;
  });
  const rots = nodes.map((n) => Number(fmt(matRotation(linearOf({ rotate: n.style.rotate, transform: n.style.transform })))));

  const setPos = (key: 'left' | 'top', v: number) => {
    const s = session();
    s.tx(() => {
      for (const n of nodes) {
        const b = computedBox(n.id);
        if (!b) continue;
        updateScoped(s.doc, n.id, positionPatchOf(n.id, key === 'left' ? v : b.left, key === 'top' ? v : b.top));
      }
    });
  };

  const toggleAbsolute = () => {
    const s = session();
    const makeAbs = !allAbs;
    const patches = new Map<string, Record<string, string | null>>();
    for (const id of ids) {
      const n = snap.nodes.get(id);
      if (!n || !snap.nodes.has(n.parent)) continue;
      if (makeAbs) patches.set(id, placement(id, n.parent));
      else patches.set(id, FLOW_PATCH);
    }
    s.tx(() => {
      for (const [id, p] of patches) {
        const n = snap.nodes.get(id)!;
        updateScoped(s.doc, n.parent, snap.nodes.get(n.parent)?.style.position ? {} : { position: 'relative' });
        updateScoped(s.doc, id, p);
      }
    });
  };

  return (
    <Section title={t('Position')} actions={anyParentFlow ? <IconButton icon={<Scan size={14} />} title={t('Absolute position: take this layer out of the parent\'s flow')} active={allAbs} onClick={toggleAbsolute} testId="insp-absolute" /> : null}>
      <Row>
        <NumberField label="X" value={common(xs) ?? 0} disabled={!allAbs} onChange={(v) => setPos('left', v)} testId="insp-x" title={allAbs ? 'X' : t('Follows the layout of the parent')} />
        <NumberField label="Y" value={common(ys) ?? 0} disabled={!allAbs} onChange={(v) => setPos('top', v)} testId="insp-y" title={allAbs ? 'Y' : t('Follows the layout of the parent')} />
      </Row>
      <Row>
        <SizeField nodes={nodes} axis="width" label={t('W')} />
        <SizeField nodes={nodes} axis="height" label={t('H')} />
      </Row>
      {nodes.length === 1 && nodes[0]!.artboard ? <FramePresetRow node={nodes[0]!} /> : null}
      <Row>
        <NumberField label="∠" value={common(rots) ?? 0} precision={1} suffix="°" testId="insp-rotation" title={t('Rotation')} onChange={(v) => inspectorStyle(ids, { rotate: normalizeDeg(v) === 0 ? null : `${fmt(normalizeDeg(v))}deg` })} />
        <div className="row-tight">
          <IconButton icon={<FlipHorizontal2 size={14} />} title={t('Flip horizontal ({shortcut})', { shortcut: 'Shift+H' })} onClick={() => flip('x')} />
          <IconButton icon={<FlipVertical2 size={14} />} title={t('Flip vertical ({shortcut})', { shortcut: 'Shift+V' })} onClick={() => flip('y')} />
          <RatioLock nodes={nodes} />
          <IconButton icon={<Lock size={14} />} title={t('Lock ({shortcut})', { shortcut: 'Ctrl+Shift+L' })} onClick={toggleLock} active={nodes.every((n) => n.locked)} />
        </div>
      </Row>
      <ConstraintsRow nodes={nodes} />
      <MinMax nodes={nodes} />
    </Section>
  );
}

/** An artboard's size by name, such as iPhone SE or A4, and a button that turns it on its side. */
function FramePresetRow({ node }: { node: BogenNode }) {
  const t = useT();
  const box = computedBox(node.id);
  const known = box ? presetOfSize(box.width, box.height) : undefined;
  const landscape = box ? box.width > box.height : false;
  const options = [{ value: '', label: known ? '' : t('Custom size') }, ...FRAME_PRESETS.map((p) => ({ value: p.name, label: p.group === p.name ? t('{preset}, {width} × {height}', { preset: p.name, width: p.w, height: p.h }) : t('{group}: {preset}, {width} × {height}', { group: t(GROUP_NAMES[p.group]), preset: p.name, width: p.w, height: p.h }) }))].filter((o) => o.label);
  return (
    <Row>
      <SelectField<string>
        className="field-grow"
        value={known?.preset.name ?? ''}
        options={options}
        title={t('Size preset')}
        testId="insp-preset"
        onChange={(name) => {
          const preset = FRAME_PRESETS.find((p) => p.name === name);
          // A preset keeps the frame on its side when it already was.
          if (preset) resizeToPreset(preset, [node.id], landscape && preset.w < preset.h);
        }}
      />
      <IconButton icon={landscape ? <RectangleVertical size={14} /> : <RectangleHorizontal size={14} />} title={landscape ? t('Portrait: swap width and height') : t('Landscape: swap width and height')} onClick={() => swapOrientation([node.id])} testId="insp-orientation" />
    </Row>
  );
}

/** The gaps between selected layers side by side, the same everywhere or mixed, to set as one. */
function SpacingRow({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  useFrameVersion();
  const ids = nodes.map((n) => n.id);
  const x = spacingInfo(ids, 'x');
  const y = spacingInfo(ids, 'y');
  if (!x && !y) return null;
  return (
    <Row className="spacing-row">
      {x ? <NumberField label={<MoveHorizontal size={12} />} value={x.gap === null ? MIXED : x.gap} min={0} title={t('Horizontal spacing between the layers')} testId="insp-spacing-x" onChange={(v) => setSpacing('x', v, ids)} /> : <span />}
      {y ? <NumberField label={<MoveVertical size={12} />} value={y.gap === null ? MIXED : y.gap} min={0} title={t('Vertical spacing between the layers')} testId="insp-spacing-y" onChange={(v) => setSpacing('y', v, ids)} /> : <span />}
    </Row>
  );
}

function MinMax({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const has = nodes.some((n) => n.style.minWidth || n.style.maxWidth || n.style.minHeight || n.style.maxHeight);
  const field = (key: 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight', label: string) => {
    const v = styleValue(nodes, key);
    const num = v === MIXED ? MIXED : v ? px(v, NaN) : null;
    return (
      <NumberField
        label={label}
        placeholder={t('None')}
        value={typeof num === 'number' && Number.isNaN(num) ? null : num}
        display={typeof v === 'string' && v && Number.isNaN(px(v, NaN)) ? v : undefined}
        min={0}
        testId={`insp-${key}`}
        className="field-minmax"
        onChange={(n) => inspectorStyle(ids, { [key]: fmtPx(n) })}
        onRaw={(raw) => inspectorStyle(ids, { [key]: raw === 'none' || raw === '-' ? null : raw })}
      />
    );
  };
  return (
    <details className="details" open={has}>
      <summary>{t('Min and max')}</summary>
      <Row>{field('minWidth', t('Min W'))}{field('maxWidth', t('Max W'))}</Row>
      <Row>{field('minHeight', t('Min H'))}{field('maxHeight', t('Max H'))}</Row>
    </details>
  );
}

const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-lighter'];

function AppearanceSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const op = styleValue(nodes, 'opacity');
  const blend = styleValue(nodes, 'mixBlendMode');
  const radii = nodes.map((n) => radiiOf(n.style));
  const same = radii.every((r) => r[0] === r[1] && r[1] === r[2] && r[2] === r[3]);
  const r0 = common(radii.map((r) => r[0])) ?? '0';
  const [cornersOpen, setCorners] = useState(false);
  const showCorners = cornersOpen || !same;
  const setCorner = (i: number, v: number) => {
    const s = session();
    s.tx(() => {
      for (const n of nodes) {
        const cur = radiiOf(n.style).map((x) => x);
        cur[i] = fmtPx(v);
        updateScoped(s.doc, n.id, { borderRadius: printSides({ top: cur[0]!, right: cur[1]!, bottom: cur[2]!, left: cur[3]! }), borderTopLeftRadius: null, borderTopRightRadius: null, borderBottomRightRadius: null, borderBottomLeftRadius: null });
      }
    });
  };
  const setAll = (v: number) => inspectorStyle(ids, { borderRadius: v ? fmtPx(v) : null, borderTopLeftRadius: null, borderTopRightRadius: null, borderBottomRightRadius: null, borderBottomLeftRadius: null });
  return (
    <Section title={t('Appearance')}>
      <Row className="inspector-appearance-row">
        <NumberField label={t('Opacity')} value={op === MIXED ? MIXED : op ? Number(fmt(parseFloat(op) * 100, 0)) : 100} min={0} max={100} suffix="%" testId="insp-opacity" onChange={(v) => inspectorStyle(ids, { opacity: v >= 100 ? null : fmt(v / 100, 3) })} />
        <SelectField value={blend === MIXED ? MIXED : blend || 'normal'} options={BLEND_MODES.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1).replace('-', ' ') }))} onChange={(m) => inspectorStyle(ids, { mixBlendMode: m === 'normal' ? null : m })} title={t('Blend mode')} testId="insp-blend" />
      </Row>
      <Row>
        <NumberField label={t('Radius')} value={r0 === MIXED || !same ? MIXED : px(r0)} min={0} testId="insp-radius" onChange={setAll} onRaw={(raw) => inspectorStyle(ids, { borderRadius: raw })} display={typeof r0 === 'string' && r0.endsWith('%') && same ? r0 : undefined} />
        <IconButton icon={<Scan size={14} />} title={t('Each corner')} active={showCorners} onClick={() => setCorners(!showCorners)} testId="insp-corners" />
      </Row>
      {showCorners ? (
        <div className="corners-grid">
          {(['↖\uFE0E', '↗\uFE0E', '↘\uFE0E', '↙\uFE0E'] as const).map((label, i) => (
            <NumberField key={label} label={label} value={common(radii.map((r) => px(r[i]))) ?? 0} min={0} onChange={(v) => setCorner(i, v)} />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

const Align3 = ['flex-start', 'center', 'flex-end'] as const;

function AlignMatrix({ n, ids }: { n: BogenNode; ids: string[] }) {
  const t = useT();
  const isColumn = (n.style.flexDirection ?? 'row').startsWith('column');
  const justify = n.style.justifyContent ?? 'flex-start';
  const items = n.style.alignItems ?? 'stretch';
  return (
    <div className="align-matrix" role="grid" aria-label={t('Alignment')}>
      {Align3.map((y) => Align3.map((x) => {
        const j = isColumn ? y : x;
        const a = isColumn ? x : y;
        const active = (justify === j || (justify === 'start' && j === 'flex-start') || (justify === 'end' && j === 'flex-end')) && (items === a || (items === 'start' && a === 'flex-start') || (items === 'end' && a === 'flex-end'));
        return (
          <button
            key={`${x}${y}`}
            type="button"
            className={`matrix-cell${active ? ' is-active' : ''}`}
            title={`${y.replace('flex-', '')} ${x.replace('flex-', '')}`}
            data-testid={`matrix-${x}-${y}`}
            onClick={() => inspectorStyle(ids, { justifyContent: j === 'flex-start' ? null : j, alignItems: a })}
          ><span /></button>
        );
      }))}
    </div>
  );
}

function PaddingFields({ nodes, ids }: { nodes: BogenNode[]; ids: string[] }) {
  const t = useT();
  const sides = nodes.map((n) => {
    const s = parseSides(n.style.padding);
    return {
      top: n.style.paddingTop ?? n.style.paddingBlock ?? s.top,
      right: n.style.paddingRight ?? n.style.paddingInline ?? s.right,
      bottom: n.style.paddingBottom ?? n.style.paddingBlock ?? s.bottom,
      left: n.style.paddingLeft ?? n.style.paddingInline ?? s.left,
    };
  });
  const v = (k: 'top' | 'right' | 'bottom' | 'left') => {
    const c = common(sides.map((s) => px(s[k])));
    return c === undefined ? 0 : c;
  };
  const write = (patch: Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>) => {
    const s = session();
    s.tx(() => {
      for (let i = 0; i < nodes.length; i++) {
        const cur = sides[i]!;
        const next = { top: patch.top !== undefined ? fmtPx(patch.top) : cur.top, right: patch.right !== undefined ? fmtPx(patch.right) : cur.right, bottom: patch.bottom !== undefined ? fmtPx(patch.bottom) : cur.bottom, left: patch.left !== undefined ? fmtPx(patch.left) : cur.left };
        const printed = printSides(next);
        updateScoped(s.doc, nodes[i]!.id, { padding: printed === '0' || printed === '0px' ? null : printed, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null, paddingInline: null, paddingBlock: null });
      }
    });
  };
  const symmetric = sides.every((s) => s.left === s.right && s.top === s.bottom);
  void ids;
  return (
    <>
      <Row>
        <NumberField label="↔" value={symmetric ? v('left') : MIXED} min={0} title={t('Horizontal padding')} testId="insp-pad-x" onChange={(n) => write({ left: n, right: n })} />
        <NumberField label="↕" value={symmetric ? v('top') : MIXED} min={0} title={t('Vertical padding')} testId="insp-pad-y" onChange={(n) => write({ top: n, bottom: n })} />
      </Row>
      <details className="details" open={!symmetric}>
        <summary>{t('Each side')}</summary>
        <Row className="inspector-quad-row">
          <NumberField label={t('T')} value={v('top')} min={0} onChange={(n) => write({ top: n })} />
          <NumberField label={t('R')} value={v('right')} min={0} onChange={(n) => write({ right: n })} />
          <NumberField label={t('B')} value={v('bottom')} min={0} onChange={(n) => write({ bottom: n })} />
          <NumberField label={t('L')} value={v('left')} min={0} onChange={(n) => write({ left: n })} />
        </Row>
      </details>
    </>
  );
}

type LayoutKind = 'none' | 'row' | 'column' | 'grid';

function layoutKindOf(n: BogenNode): LayoutKind {
  if (n.style.display === 'grid' || n.style.display === 'inline-grid') return 'grid';
  if (n.style.display === 'flex' || n.style.display === 'inline-flex') return (n.style.flexDirection ?? 'row').startsWith('column') ? 'column' : 'row';
  return 'none';
}

function setLayout(nodes: BogenNode[], kind: LayoutKind): void {
  const s = session();
  const { snap, doc } = s;
  // Leaving layout pins the children where they are, so measure them before anything changes.
  const pins = new Map<string, Record<string, string | null>>();
  if (kind === 'none') {
    for (const n of nodes) for (const c of snap.children(n.id)) if (isFlow(c)) pins.set(c, placement(c, n.id));
  }
  s.tx(() => {
    for (const n of nodes) {
      const wasLayout = layoutKindOf(n) !== 'none';
      if (kind === 'none') {
        updateScoped(doc, n.id, { display: null, flexDirection: null, flexWrap: null, gap: null, rowGap: null, columnGap: null, justifyContent: null, alignItems: null, gridTemplateColumns: null, gridTemplateRows: null, position: n.style.position ?? 'relative' });
        for (const c of snap.children(n.id)) {
          const p = pins.get(c);
          if (p) updateScoped(doc, c, p);
        }
        continue;
      }
      const base: Record<string, string | null> = {};
      if (kind === 'grid') {
        base.display = 'grid';
        base.flexDirection = null;
        base.flexWrap = null;
        if (!n.style.gridTemplateColumns) base.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
        if (!n.style.gap) base.gap = '8px';
      } else {
        base.display = 'flex';
        base.flexDirection = kind;
        base.gridTemplateColumns = null;
        base.gridTemplateRows = null;
        if (!wasLayout) {
          if (!n.style.gap) base.gap = '8px';
          base.alignItems = 'flex-start';
        }
      }
      updateScoped(doc, n.id, base);
      if (!wasLayout) for (const c of snap.children(n.id)) updateScoped(doc, c, FLOW_PATCH);
    }
  });
}

function gridCount(value: string | undefined): number {
  if (!value) return 0;
  const m = /^repeat\((\d+),/.exec(value.trim());
  if (m) return Number(m[1]);
  return value.trim().split(/\s+(?![^(]*\))/).length;
}

function LayoutSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const kind = common(nodes.map(layoutKindOf));
  const first = nodes[0]!;
  const active = kind !== 'none' && kind !== undefined;
  const gapV = styleValue(nodes, 'gap');
  const wrap = styleValue(nodes, 'flexWrap');
  const clip = nodes.every((n) => n.style.overflow === 'hidden' || n.style.overflow === 'clip');
  const isFlex = kind === 'row' || kind === 'column';
  const gapNum = gapV === MIXED ? MIXED : px(gapV);
  return (
    <Section
      title={t('Layout')}
      actions={<IconButton icon={<Crop size={14} />} title={t('Clip content')} active={clip} testId="insp-clip" onClick={() => inspectorStyle(ids, { overflow: clip ? null : 'hidden' })} />}
    >
      <Segmented<LayoutKind>
        value={kind}
        onChange={(k) => setLayout(nodes, k)}
        testId="insp-layout"
        options={[
          { value: 'none', icon: <Ban size={14} />, title: t('No layout: children are positioned freely') },
          { value: 'row', icon: <ArrowRight size={14} />, title: t('Flex row') },
          { value: 'column', icon: <ArrowDown size={14} />, title: t('Flex column') },
          { value: 'grid', icon: <Grid3x3 size={14} />, title: t('Grid') },
        ]}
      />
      {active ? (
        <>
          <div className="layout-grid">
            {isFlex && nodes.length === 1 ? <AlignMatrix n={first} ids={ids} /> : null}
            <div className="layout-grid-col">
              <NumberField label={t('Gap')} value={gapNum === MIXED ? MIXED : (typeof gapV === 'string' && fluidEnds(gapV)?.[1]) || gapNum} min={0} testId="insp-gap" onChange={(v) => inspectorStyle(ids, { gap: fmtPx(v), rowGap: null, columnGap: null })} onRaw={(raw) => inspectorStyle(ids, { gap: raw })} />
              {gapV !== MIXED && nodes.length === 1 ? <FluidRow value={typeof gapV === 'string' && gapV ? gapV : '16px'} onChange={(v) => inspectorStyle(ids, { gap: v, rowGap: null, columnGap: null })} testId="gap-fluid" kind="space" /> : null}
              {isFlex ? (
                <div className="row-tight">
                  <IconButton icon={<WrapText size={14} />} title={t('Wrap')} active={wrap === 'wrap'} testId="insp-wrap" onClick={() => inspectorStyle(ids, { flexWrap: wrap === 'wrap' ? null : 'wrap' })} />
                  <IconButton icon={<Maximize2 size={14} />} title={t('Space between')} active={styleValue(nodes, 'justifyContent') === 'space-between'} onClick={() => inspectorStyle(ids, { justifyContent: styleValue(nodes, 'justifyContent') === 'space-between' ? null : 'space-between' })} />
                  <IconButton icon={<Rows3 size={14} />} title={t('Stretch children')} active={styleValue(nodes, 'alignItems') === 'stretch'} onClick={() => inspectorStyle(ids, { alignItems: styleValue(nodes, 'alignItems') === 'stretch' ? 'flex-start' : 'stretch' })} />
                </div>
              ) : null}
            </div>
          </div>
          {kind === 'grid' ? (
            <>
              {nodes.length === 1 ? <GridModeRow nodes={nodes} ids={ids} /> : null}
              <Row>
                <NumberField label={t('Cols')} value={common(nodes.map((n) => gridCount(n.style.gridTemplateColumns))) ?? 0} min={1} max={48} testId="insp-grid-cols" onChange={(v) => inspectorStyle(ids, { gridTemplateColumns: `repeat(${v}, minmax(0, 1fr))` })} />
                <NumberField label={t('Rows')} value={((r) => (r === 0 ? null : r ?? null))(common(nodes.map((n) => gridCount(n.style.gridTemplateRows))))} placeholder={t('Auto')} min={1} max={48} testId="insp-grid-rows" onChange={(v) => inspectorStyle(ids, { gridTemplateRows: `repeat(${v}, minmax(0, 1fr))` })} />
              </Row>
              <TextField value={(styleValue(nodes, 'gridTemplateColumns') as string | undefined) ?? ''} mixed={styleValue(nodes, 'gridTemplateColumns') === MIXED} onChange={(v) => inspectorStyle(ids, { gridTemplateColumns: v || null })} placeholder={t('Columns, like {example}', { example: '1fr 2fr' })} title="grid-template-columns" testId="insp-grid-template-cols" />
              <TextField value={(styleValue(nodes, 'gridTemplateRows') as string | undefined) ?? ''} mixed={styleValue(nodes, 'gridTemplateRows') === MIXED} onChange={(v) => inspectorStyle(ids, { gridTemplateRows: v || null })} placeholder={t('Rows, like {example}', { example: 'auto 1fr' })} title="grid-template-rows" />
            </>
          ) : null}
        </>
      ) : null}
      <PaddingFields nodes={nodes} ids={ids} />
      <OverflowRow nodes={nodes} />
      {nodes.length === 1 && !first.artboard ? <ContainerRow node={first} /> : null}
    </Section>
  );
}

function ChildOfGridSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const { snap } = session();
  const inGrid = nodes.every((n) => snap.nodes.has(n.parent) && flowOf(n.parent).kind === 'flow' && (flowOf(n.parent) as { grid?: boolean }).grid && isFlow(n.id));
  if (!inGrid) return null;
  return (
    <Section title={t('Grid cell')}>
      <Row>
        <TextField label={t('Col')} value={(styleValue(nodes, 'gridColumn') as string) ?? ''} placeholder="auto" onChange={(v) => inspectorStyle(ids, { gridColumn: v || null })} />
        <TextField label={t('Row')} value={(styleValue(nodes, 'gridRow') as string) ?? ''} placeholder="auto" onChange={(v) => inspectorStyle(ids, { gridRow: v || null })} />
      </Row>
    </Section>
  );
}

function FrameTool() {
  const t = useT();
  return (
    <div className="insp-presets">
      <Section title={t('Frame sizes')}>
        <div className="preset-list">
          {[...new Set(FRAME_PRESETS.map((p) => p.group))].map((group: FramePresetGroup) => (
            <div key={group} role="group" aria-label={t(GROUP_NAMES[group])}>
              <div className="preset-group">{t(GROUP_NAMES[group])}</div>
              {FRAME_PRESETS.filter((p) => p.group === group).map((p) => (
                <button key={p.name} type="button" className="preset-row" data-testid={`preset-${p.name}`} onClick={() => addArtboard(p.name, p.w, p.h)}>
                  <span>{p.name}</span>
                  <span className="preset-size">{p.w} × {p.h}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function PageSummary() {
  const t = useT();
  const count = useMemo(() => session().snap.nodes.size, []);
  return <Empty title={t('Nothing selected')} hint={count ? t('Click a layer on the canvas or in the list on the left.') : t('Draw something with the tools above, or paste HTML to begin.')} />;
}

export function Inspector() {
  const raw = useSelectedNodes();
  // At a breakpoint, every section reads the layer as it is at that width and writes into that width's block.
  const breakpoint = useUi((s) => s.breakpoint);
  const nodes = breakpoint === null ? raw : raw.map((n) => nodeAt(n, breakpoint));
  const pageId = useEditor((s) => s.pageId);
  const tool = useEditor((s) => s.tool);
  useFrameVersion();
  const glyphPage = useIsGlyphPage();
  if (tool === 'frame') return <FrameTool />;
  if (!nodes.length) return <>{glyphPage ? <FontPanel /> : <PageSummary />}{pageId ? <PageModeSection pageId={pageId} /> : null}<VariablesSection /></>;
  const allFrames = nodes.every((n) => n.type === 'frame');
  const anyText = nodes.some((n) => n.type === 'text');
  const allText = nodes.every((n) => n.type === 'text');
  const hasMedia = nodes.length === 1 ? nodes[0] : null;
  const anyMeasured = nodes.some((n) => elOf(n.id));
  void parentLinear; void apply; void invert; void measure; void editor; void Square;
  return (
    <div className="inspector" data-testid="inspector">
      <Header nodes={nodes} />
      <BreakpointBar nodes={raw} />
      {glyphPage ? <FontBuildSection /> : null}
      <ComponentSection nodes={nodes} />
      <AlignRow count={nodes.length} />
      {nodes.length >= 2 ? <SpacingRow nodes={nodes} /> : null}
      {anyMeasured ? <PositionSection nodes={nodes} /> : null}
      <ChildOfGridSection nodes={nodes} />
      {allFrames ? <LayoutSection nodes={nodes} /> : null}
      {hasMedia?.type === 'frame' && !hasMedia.virtual ? <LayoutGridSection node={hasMedia} /> : null}
      {hasMedia?.artboard ? <ResponsiveSection node={hasMedia} /> : null}
      {hasMedia?.type === 'shader' ? <ShaderSection node={hasMedia} /> : null}
      {hasMedia?.type === 'image' ? <ImageSection node={hasMedia} /> : null}
      {hasMedia?.code ? <CodeSection node={hasMedia} /> : null}
      <PathActions nodes={nodes} />
      {hasMedia?.type === 'svg' ? <VectorSection node={hasMedia} /> : null}
      {anyText ? <TypographySection nodes={nodes} allText={allText} /> : null}
      <ModeSection nodes={nodes} />
      <AppearanceSection nodes={nodes} />
      <FillsSection nodes={nodes} />
      <BorderSection nodes={nodes} />
      <OutlineSection nodes={nodes} />
      <EffectsSection nodes={nodes} />
      <SelectionColors nodes={nodes} />
      <PrototypeSection nodes={nodes} />
      {hasMedia ? <RepeatSection key={hasMedia.id} node={hasMedia} /> : null}
      <RulesSection nodes={raw} />
      <RawCssSection nodes={nodes} />
    </div>
  );
}
