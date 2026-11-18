import {
  MOCKUP_ATTR, MOCKUP_BLENDS, MOCKUP_SCENES, PATTERN_ATTR, PATTERN_CELLS, PATTERN_FIELD_ATTR, createComponent, decodeField, mockupChildren, normalizePatternSpec, readMockupConfig, readPatternSpec, renderPattern, sceneById,
  type BogenNode, type Mesh, type MockupBlend, type MockupConfig, type PatternCell, type PatternSpec, type Point,
} from '@bogen/core';
import { Shuffle } from 'lucide-react';
import { session } from '../../doc/session.ts';
import { editor } from '../../state/store.ts';
import { goToLayer } from '../../ops/reveal.ts';
import { ColorField } from '../../ui/ColorPicker.tsx';
import { IconButton, NumberField, Row, Section, Segmented, SelectField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';
import { msg } from '../../i18n/core.ts';

/**
 * Inspector sections for the brand application layers the agents make: a pattern (a graphic device of cells) and a
 * mockup (a design on an object). Both are redrawn here from what the layer stores, with the same code the server
 * uses, so tuning a pattern or swapping a mockup's scene needs no agent.
 */

export function isPattern(node: BogenNode): boolean {
  return node.type === 'svg' && Boolean(node.attrs?.[PATTERN_ATTR]);
}

export function isMockup(node: BogenNode): boolean {
  return node.type === 'frame' && Boolean(node.attrs?.[MOCKUP_ATTR]);
}

const CELL_LABELS: Record<PatternCell, string> = { circle: msg('Circle'), square: msg('Square'), rounded: msg('Rounded'), diamond: msg('Diamond'), plus: msg('Plus'), custom: msg('Custom') };

function writePattern(node: BogenNode, patch: Partial<PatternSpec>): void {
  const stored = JSON.parse(node.attrs?.[PATTERN_ATTR] ?? '{}') as Record<string, unknown>;
  const before = readPatternSpec(node.attrs?.[PATTERN_ATTR]);
  if (!before) return;
  let spec: PatternSpec;
  try {
    spec = normalizePatternSpec({ ...before, ...patch });
  } catch {
    return;
  }
  // A sampled field only fits the grid it was sampled on: changing columns or rows of an image or text fill needs the agent.
  const field = node.attrs?.[PATTERN_FIELD_ATTR] ? decodeField(node.attrs[PATTERN_FIELD_ATTR]!, spec.columns * spec.rows) : null;
  const drawn = renderPattern(spec, field);
  const extra = Object.fromEntries(Object.entries(stored).filter(([k]) => k === 'image' || k === 'text'));
  const s = session();
  s.tx(() => s.doc.updateFields(node.id, { svg: drawn.svg, attrs: { ...(node.attrs ?? {}), [PATTERN_ATTR]: JSON.stringify({ ...spec, ...extra }) } }));
}

export function PatternSection({ node }: { node: BogenNode }) {
  const t = useT();
  const spec = readPatternSpec(node.attrs?.[PATTERN_ATTR]);
  if (!spec) return null;
  const sampled = spec.fill === 'image' || spec.fill === 'text';
  const set = (patch: Partial<PatternSpec>) => writePattern(node, patch);
  return (
    <Section title={t('Pattern')} note={t('A graphic device of cells. The agent can fill it from an image or a word; here you tune how it looks.')} actions={<IconButton icon={<Shuffle size={14} />} title={t('Another arrangement')} onClick={() => set({ seed: spec.seed + 1 })} testId="pattern-shuffle" />}>
      <div className="stack">
        <Row>
          <SelectField<PatternCell> label={t('Cell')} value={spec.cell} options={PATTERN_CELLS.filter((c) => c !== 'custom' || spec.cell === 'custom').map((c) => ({ value: c, label: t(CELL_LABELS[c]) }))} onChange={(v) => set({ cell: v })} testId="pattern-cell" />
          <SelectField label={t('Fill')} value={spec.fill} disabled={sampled} title={sampled ? t('Filled from an image or text. Ask the agent to change what it is filled from.') : undefined} options={(sampled ? [spec.fill] : ['solid', 'gradient', 'radial', 'noise']).map((f) => ({ value: f, label: t(f === 'solid' ? 'Everywhere' : f === 'gradient' ? 'Gradient' : f === 'radial' ? 'Radial' : f === 'noise' ? 'Noise' : f === 'image' ? 'Image' : 'Text') }))} onChange={(v) => set({ fill: v as PatternSpec['fill'] })} testId="pattern-fill" />
        </Row>
        <Row>
          <NumberField label={t('Columns')} value={spec.columns} min={1} max={400} precision={0} disabled={sampled} onChange={(v) => set({ columns: Math.round(v) })} testId="pattern-columns" />
          <NumberField label={t('Rows')} value={spec.rows} min={1} max={400} precision={0} disabled={sampled} onChange={(v) => set({ rows: Math.round(v) })} testId="pattern-rows" />
        </Row>
        {spec.fill === 'gradient' ? <NumberField label={t('Angle')} value={spec.angle} min={-360} max={360} precision={0} suffix="°" onChange={(v) => set({ angle: v })} testId="pattern-angle" /> : null}
        <Row>
          <NumberField label={t('Threshold')} value={spec.threshold} min={0} max={0.99} step={0.02} title={t('Cells under this value stay empty')} onChange={(v) => set({ threshold: v })} testId="pattern-threshold" />
          <NumberField label={t('Rough')} value={spec.roughness} min={0} max={1} step={0.02} title={t('Noise that breaks the edge into single cells')} onChange={(v) => set({ roughness: v })} testId="pattern-roughness" />
        </Row>
        <Row>
          <NumberField label={t('Gap')} value={spec.gap} min={0} max={0.9} step={0.02} onChange={(v) => set({ gap: v })} testId="pattern-gap" />
          <NumberField label={t('Scatter')} value={spec.scatter} min={0} max={0.95} step={0.02} title={t('Cells left out at random')} onChange={(v) => set({ scatter: v })} testId="pattern-scatter" />
        </Row>
        <Row>
          <Segmented value={spec.sizeByValue ? 'grow' : 'full'} options={[{ value: 'full', label: t('Full cells'), title: t('Every filled cell at full size') }, { value: 'grow', label: t('Halftone'), title: t('Cells grow with their value') }]} onChange={(v) => set({ sizeByValue: v === 'grow' })} testId="pattern-size" />
          <Segmented value={spec.invert ? 'on' : 'off'} options={[{ value: 'off', label: t('Normal'), title: t('Cells fill where the value is high') }, { value: 'on', label: t('Inverted'), title: t('Cells fill where the value is low') }]} onChange={(v) => set({ invert: v === 'on' })} testId="pattern-invert" />
        </Row>
        {spec.colors.map((c, i) => (
          <div className="param-color" key={i}>
            <span className="param-label">{spec.colors.length > 1 ? t('Tone {n}', { n: i + 1 }) : t('Colour')}</span>
            <ColorField value={c} onChange={(v) => set({ colors: spec.colors.map((x, j) => (j === i ? v || x : x)) })} testId={`pattern-color-${i}`} />
          </div>
        ))}
      </div>
    </Section>
  );
}

const SCENE_LABELS: Record<string, string> = {
  'poster-wall': msg('Poster on a wall'), billboard: msg('Billboard'), 'tote-bag': msg('Tote bag'), 'badge-lanyard': msg('Badge on a lanyard'), 'hanging-sign': msg('Hanging sign'),
  packet: msg('Packet'), cap: msg('Cap'), phone: msg('Phone'), laptop: msg('Laptop'),
};

const scaleMesh = (m: Mesh, s: number): Mesh => ({ top: m.top.map(([x, y]) => [x * s, y * s] as Point), bottom: m.bottom.map(([x, y]) => [x * s, y * s] as Point) });

/** Rebuilds a mockup's layers from a changed config, in place. */
export function writeMockup(node: BogenNode, next: MockupConfig): void {
  const scene = next.scene === 'photo' ? null : sceneById(next.scene);
  const s = session();
  s.tx(() => {
    s.doc.updateFields(node.id, { attrs: { ...(node.attrs ?? {}), [MOCKUP_ATTR]: JSON.stringify(next) } });
    s.doc.updateStyle(node.id, { width: `${next.width}px`, height: `${next.height}px` });
    const old = s.doc.getChildren(node.id).map((c) => c.id);
    if (old.length) s.doc.delete(old);
    s.doc.insertMany(node.id, mockupChildren(next, scene));
  });
}

/** Places the selected artboard on a scene beside it, as the agents' mockup_place does. */
export function placeInMockup(node: BogenNode, sceneId = 'poster-wall'): string | null {
  const scene = sceneById(sceneId);
  const w = Number(/^([\d.]+)px$/.exec(node.style.width ?? '')?.[1]);
  const h = Number(/^([\d.]+)px$/.exec(node.style.height ?? '')?.[1]);
  if (!scene || !w || !h) return null;
  const s = session();
  const width = 800;
  const k = width / scene.width;
  const left = Number(/^(-?[\d.]+)px$/.exec(node.style.left ?? '')?.[1] ?? 0) + w + 120;
  const top = Number(/^(-?[\d.]+)px$/.exec(node.style.top ?? '')?.[1] ?? 0);
  const id = s.tx(() => {
    if (!node.component && !node.instanceOf) createComponent(s.doc, node.id, { description: 'Artwork that mockups show. Change it here and every mockup follows.' });
    const main = node.instanceOf ?? node.id;
    const config: MockupConfig = { source: main, sourceWidth: w, sourceHeight: h, scene: scene.id, width, height: Math.round(scene.height * k), mesh: scaleMesh(scene.mesh, k), blend: scene.blend, shading: scene.shading, fit: 'cover' };
    return s.doc.insert(node.parent, {
      type: 'frame', tag: 'figure', name: `Mockup · ${scene.name}`,
      style: { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${config.height}px`, overflow: 'hidden', isolation: 'isolate' },
      attrs: { [MOCKUP_ATTR]: JSON.stringify(config), role: 'img', 'aria-label': `${node.name} on ${scene.name.toLowerCase()}` },
      children: mockupChildren(config, scene),
    });
  });
  editor().set({ selection: [id] });
  return id;
}

export function MockupSection({ node }: { node: BogenNode }) {
  const t = useT();
  const c = readMockupConfig(node.attrs?.[MOCKUP_ATTR]);
  if (!c) return null;
  const set = (patch: Partial<MockupConfig>) => writeMockup(node, { ...c, ...patch });
  const setScene = (id: string) => {
    const scene = sceneById(id);
    if (!scene) return;
    const k = c.width / scene.width;
    set({ scene: id, height: Math.round(scene.height * k), mesh: scaleMesh(scene.mesh, k), blend: scene.blend, shading: scene.shading });
  };
  const source = session().doc.getNode(c.source);
  return (
    <Section title={t('Mockup')} note={t('Shows {name} on an object. Change the design and the mockup follows.', { name: source?.name ?? t('a design') })}>
      <div className="stack">
        {c.scene !== 'photo' ? (
          <SelectField label={t('Scene')} value={c.scene} options={MOCKUP_SCENES.map((s) => ({ value: s.id, label: t(SCENE_LABELS[s.id] ?? s.name) }))} onChange={setScene} testId="mockup-scene" />
        ) : null}
        <Row>
          <SelectField<MockupBlend> label={t('Blend')} value={c.blend} options={MOCKUP_BLENDS.map((b) => ({ value: b, label: t(b === 'normal' ? 'Normal (a screen)' : b === 'multiply' ? 'Multiply (ink)' : b[0]!.toUpperCase() + b.slice(1)) }))} onChange={(v) => set({ blend: v })} testId="mockup-blend" />
          <NumberField label={t('Light')} value={c.shading} min={0} max={1} step={0.05} title={t('How much of the surface\'s light and shadow shows on the print')} onChange={(v) => set({ shading: Math.min(1, Math.max(0, v)) })} testId="mockup-shading" />
        </Row>
        <Segmented value={c.fit} options={[{ value: 'cover', label: t('Crop to fit'), title: t('Show the part of the design that has the surface\'s shape') }, { value: 'stretch', label: t('Stretch'), title: t('Squeeze the whole design onto the surface') }]} onChange={(v) => set({ fit: v })} testId="mockup-fit" />
        {source ? <button type="button" className="btn" onClick={() => goToLayer(source.id, { fit: true })} data-testid="mockup-source">{t('Select the design')}</button> : null}
      </div>
    </Section>
  );
}
