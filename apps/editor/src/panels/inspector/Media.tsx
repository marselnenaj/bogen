import { rectOf } from '../../canvas/measure.ts';
import { inspectorStyle } from '../../ops/breakpoints.ts';
import { useEffect, useMemo, useState } from 'react';
import { CROP_ASPECTS, CROP_ATTR, IMAGE_FILTER_KEYS, IMAGE_FILTERS, parseCrop, parseImageFilters, withImageFilters, type BogenNode, type CropAspect, type ImageFilterKey } from '@bogen/core';
import { Crop, Minus, PenTool, Plus, Upload } from 'lucide-react';
import { startPathEdit } from '../../canvas/pen.ts';
import { DEFAULT_SHADER, parseColorList, presetToAttrs, SHADER_TYPES, shaderPresets, type ShaderPreset } from '../../lib/shaders.ts';
import { api, resolveAsset } from '../../lib/api.ts';
import { fmt } from '../../lib/css-values.ts';
import { applyAspect, aspectOf, cropOf, setImageFilter, useNaturalSize, vectorizeImage, writeCrop } from '../../ops/image-edit.ts';
import { pickImage } from '../../ops/images.ts';
import { setFields } from '../../ops/ops.ts';
import { capsOf, isClosedMarkup, setCap, setStrokeAlign, setStrokeWidth, strokeAlignOf, strokeWidthOf, type CapKind, type StrokeAlign } from '../../ops/vector.ts';
import { session } from '../../doc/session.ts';
import { ui, useUi } from '../../state/ui.ts';
import { ColorField } from '../../ui/ColorPicker.tsx';
import { IconButton, NumberField, Row, Section, Segmented, SelectField, TextField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';
import { ctx, msg } from '../../i18n/core.ts';
import { t } from '../../i18n/store.ts';

const SIZING = new Set(['fit', 'scale', 'rotation', 'offsetX', 'offsetY', 'originX', 'originY', 'worldWidth', 'worldHeight', 'frame']);
const FITS = ['contain', 'cover', 'none'];

function isColorKey(key: string, value: unknown): boolean {
  return typeof value === 'string' && (/^color/i.test(key) || /^#|^rgb|^hsl/.test(value));
}

/** Shader parameters. Presets and the parameters themselves come from the library, live on the GPU. */
export function ShaderSection({ node }: { node: BogenNode }) {
  const t = useT();
  const type = node.attrs?.type ?? DEFAULT_SHADER;
  const [presets, setPresets] = useState<ShaderPreset[]>([]);
  useEffect(() => {
    let alive = true;
    void shaderPresets(type).then((p) => { if (alive) setPresets(p); });
    return () => { alive = false; };
  }, [type]);

  const defaults = presets[0]?.params ?? {};
  const attrs = node.attrs ?? {};
  const writeAttr = (key: string, value: string | null) => {
    const next = { ...attrs };
    if (value === null) delete next[key];
    else next[key] = value;
    setFields([node.id], { attrs: next });
  };
  const setType = async (next: string) => {
    const p = await shaderPresets(next);
    setFields([node.id], { attrs: p[0] ? presetToAttrs(next, p[0]) : { type: next } });
  };
  const keys = useMemo(() => {
    const all = new Set([...Object.keys(defaults), ...Object.keys(attrs)]);
    all.delete('type');
    return [...all];
  }, [defaults, attrs]);
  const main = keys.filter((k) => !SIZING.has(k));
  const sizing = keys.filter((k) => SIZING.has(k) && k !== 'frame' && k !== 'worldWidth' && k !== 'worldHeight');
  const typeInfo = SHADER_TYPES.find((st) => st.id === type);

  const renderParam = (key: string) => {
    const raw = attrs[key];
    const dflt = (defaults as Record<string, unknown>)[key];
    const current: unknown = raw ?? dflt;
    if (key === 'colors') {
      const colors = typeof raw === 'string' ? parseColorList(raw) : ((dflt as string[]) ?? []);
      const set = (next: string[]) => writeAttr('colors', JSON.stringify(next));
      return (
        <div className="stack" key={key}>
          {colors.map((c, i) => (
            <div className="list-row" key={i}>
              <ColorField value={c} onChange={(v) => set(colors.map((x, j) => (j === i ? v : x)))} testId={`shader-color-${i}`} />
              <IconButton icon={<Minus size={14} />} title={t('Remove colour')} disabled={colors.length <= 1} onClick={() => set(colors.filter((_, j) => j !== i))} />
            </div>
          ))}
          <button type="button" className="btn btn-quiet" onClick={() => set([...colors, colors.at(-1) ?? '#ffffff'])}><Plus size={14} /> {t('Add colour')}</button>
        </div>
      );
    }
    if (key === 'fit') return <SelectField key={key} label={t('Fit')} value={String(current ?? 'contain')} options={FITS.map((f) => ({ value: f, label: f[0]!.toUpperCase() + f.slice(1) }))} onChange={(v) => writeAttr(key, v)} />;
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    if (typeof dflt === 'boolean' || current === 'true' || current === 'false') {
      return <label className="check" key={key}><input type="checkbox" checked={String(current) === 'true'} onChange={(e) => writeAttr(key, String(e.target.checked))} /> {label}</label>;
    }
    if (typeof dflt === 'number' || (typeof current === 'string' && current !== '' && !Number.isNaN(Number(current)))) {
      const value = Number(current);
      const unit = /speed/i.test(key) ? 0.1 : Math.abs(Number(dflt ?? value)) <= 2 ? 0.01 : 1;
      return <NumberField key={key} className="param" label={label} value={Number(fmt(value, 3))} step={unit} precision={3} scrubRate={1} testId={`shader-${key}`} onChange={(v) => writeAttr(key, String(v))} />;
    }
    if (isColorKey(key, current)) return <div className="param-color" key={key}><span className="param-label">{label}</span><ColorField value={String(current ?? '')} onChange={(v) => writeAttr(key, v)} /></div>;
    if (key === 'image' || key === 'src') {
      return (
        <div className="stack" key={key}>
          <button type="button" className="btn" onClick={() => pickImage(async (f) => { const a = await api.upload(f); writeAttr(key, a.src); })}><Upload size={14} /> {t('Choose image')}</button>
        </div>
      );
    }
    return <TextField key={key} label={label} value={String(current ?? '')} onChange={(v) => writeAttr(key, v)} />;
  };

  return (
    <Section title={t('Shader')}>
      <div className="stack" data-testid="shader-inspector">
        <SelectField value={type} options={SHADER_TYPES.map((st) => ({ value: st.id, label: t(st.label) }))} onChange={(next) => void setType(next)} testId="shader-type" title={t('Effect')} />
        {presets.length > 1 ? (
          <div className="preset-chips">
            {presets.map((p) => (
              <button key={p.name} type="button" className="chip" data-testid={`shader-preset-${p.name}`} onClick={() => setFields([node.id], { attrs: presetToAttrs(type, p) })}>{p.name}</button>
            ))}
          </div>
        ) : null}
        {typeInfo?.image && !attrs.image ? <div className="hint">{t('This effect works on an image. Choose one below.')}</div> : null}
        {typeInfo?.image && !keys.includes('image') ? (
          <button type="button" className="btn" onClick={() => pickImage(async (f) => { const a = await api.upload(f); writeAttr('image', a.src); })}><Upload size={14} /> {t('Choose image')}</button>
        ) : null}
        {main.map(renderParam)}
        <details className="details">
          <summary>{t('Placement')}</summary>
          <div className="stack">{sizing.map(renderParam)}</div>
        </details>
      </div>
    </Section>
  );
}

const DETAILS = [{ value: 'low', label: msg('Low'), title: msg('Fewer, smoother shapes') }, { value: 'medium', label: msg('Medium'), title: msg('Balanced') }, { value: 'high', label: msg('High'), title: msg('Small shapes and close edges') }] as const;
const ASPECT_LABEL: Record<CropAspect, string> = { free: msg('Free'), original: msg('Original'), '1:1': '1:1', '4:3': '4:3', '3:2': '3:2', '16:9': '16:9', '9:16': '9:16', '4:5': '4:5' };

/** The image filters' names: `IMAGE_FILTERS` in core holds them in English. */
const FILTER_LABEL: Record<ImageFilterKey, string> = { brightness: msg('Brightness'), contrast: msg('Contrast'), saturate: msg('Saturation'), blur: msg('Blur'), grayscale: msg('Grayscale') };

export function ImageSection({ node }: { node: BogenNode }) {
  const t = useT();
  const fit = node.style.objectFit ?? 'cover';
  const natural = useNaturalSize(node.src);
  const cropping = useUi((s) => s.crop?.nodeId === node.id);
  const crop = cropOf(node);
  const cropped = Boolean(parseCrop(node.attrs?.[CROP_ATTR]));
  const aspect = aspectOf(crop, natural, CROP_ASPECTS);
  const filters = parseImageFilters(node.style.filter);
  const [colors, setColors] = useState(8);
  const [detail, setDetail] = useState<'low' | 'medium' | 'high'>('medium');
  const [tracing, setTracing] = useState(false);
  const [traceNote, setTraceNote] = useState<string | null>(null);
  const vectorize = async () => {
    setTracing(true);
    setTraceNote(null);
    try {
      const out = await vectorizeImage(node, colors, detail);
      setTraceNote(t('{paths} paths in {colors} colours, {size} KB.', { paths: out.paths, colors: out.colors, size: Math.max(1, Math.round(out.bytes / 1024)) }));
    } catch (e) {
      setTraceNote((e as Error).message);
    } finally {
      setTracing(false);
    }
  };
  return (
    <Section title={t('Image')} actions={node.src ? <button type="button" className="btn btn-quiet" onClick={() => pickImage(async (f) => { const a = await api.upload(f); setFields([node.id], { src: a.src }); })}>{t('Replace')}</button> : undefined}>
      <div className="stack">
        {node.src ? <div className="fill-image-preview" style={{ background: `center / contain no-repeat url("${resolveAsset(node.src)}")`, filter: node.style.filter }} /> : null}
        {!node.src ? <button type="button" className="btn" onClick={() => pickImage(async (f) => { const a = await api.upload(f); setFields([node.id], { src: a.src }); })}><Upload size={14} /> {t('Upload image')}</button> : null}
        <TextField label="Alt" value={node.attrs?.alt ?? ''} placeholder={t('Describe the image')} onChange={(alt) => setFields([node.id], { attrs: { ...(node.attrs ?? {}), alt } })} />
        {node.src && natural ? <ResolutionNote id={node.id} natural={natural} src={node.src} /> : null}
        {!cropped ? (
          <>
            <Row>
              <SelectField label={t('Fit')} value={fit} options={['cover', 'contain', 'fill', 'none', 'scale-down'].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))} onChange={(v) => inspectorStyle([node.id], { objectFit: v })} testId="image-fit" />
            </Row>
            <TextField label={t('Focus')} value={node.style.objectPosition ?? ''} placeholder="center" title="object-position" onChange={(v) => inspectorStyle([node.id], { objectPosition: v || null })} />
          </>
        ) : null}
        {node.src ? (
          <>
            <div className="image-subhead">{t('Crop')}{cropped ? <button type="button" className="btn btn-quiet" onClick={() => writeCrop(node.id, null, natural)} data-testid="crop-reset">{t('Reset')}</button> : null}</div>
            <div className="preset-chips" data-testid="crop-presets">
              {CROP_ASPECTS.map((a) => (
                <button key={a} type="button" className={`chip${aspect === a ? ' is-active' : ''}`} disabled={!natural && a !== 'free'} onClick={() => natural && applyAspect(node, a, natural)} data-testid={`crop-aspect-${a}`}>{t(ASPECT_LABEL[a])}</button>
              ))}
            </div>
            <button type="button" className={`btn${cropping ? '' : ' btn-primary'}`} onClick={() => ui().set({ crop: cropping ? null : { nodeId: node.id } })} data-testid="crop-on-canvas"><Crop size={14} /> {cropping ? t('Done cropping') : t('Crop on canvas')}</button>
            <div className="image-subhead">{t('Filters')}{node.style.filter && IMAGE_FILTER_KEYS.some((k) => filters[k] !== undefined) ? <button type="button" className="btn btn-quiet" onClick={() => inspectorStyle([node.id], { filter: withImageFilters(node.style.filter, { brightness: null, contrast: null, saturate: null, blur: null, grayscale: null }) })} data-testid="filter-reset">{t('Reset')}</button> : null}</div>
            {IMAGE_FILTER_KEYS.map((k) => {
              const spec = IMAGE_FILTERS[k];
              const value = filters[k] ?? spec.neutral;
              return (
                <label key={k} className="image-filter">
                  <span>{t(FILTER_LABEL[k])}</span>
                  <input type="range" min={spec.min} max={spec.max} step={k === 'blur' ? 0.5 : 1} value={value} onChange={(e) => setImageFilter([node.id], k, Number(e.target.value))} onDoubleClick={() => setImageFilter([node.id], k, null)} title={t('Double-click to reset')} data-testid={`filter-${k}`} />
                  <span className="image-filter-value">{fmt(value, 1)}{spec.unit === 'px' ? ' px' : '%'}</span>
                </label>
              );
            })}
            <div className="image-subhead">{t('Vectorize')}</div>
            <Row>
              <NumberField label={t('Colours')} value={colors} min={2} max={64} step={1} precision={0} onChange={(v) => setColors(Math.round(Math.min(64, Math.max(2, v))))} testId="vectorize-colors" />
            </Row>
            <Segmented value={detail} options={DETAILS.map((d) => ({ value: d.value, label: t(d.label), title: t(d.title) }))} onChange={setDetail} testId="vectorize-detail" />
            <button type="button" className="btn" disabled={tracing || !node.src.startsWith('bogen-asset:')} title={node.src.startsWith('bogen-asset:') ? t('Traced on this computer, into a vector layer beside the image') : t('Only images stored in Bogen can be vectorized')} onClick={() => void vectorize()} data-testid="vectorize-run"><PenTool size={14} /> {tracing ? t('Tracing') : t('Vectorize')}</button>
            {traceNote ? <div className="hint" data-testid="vectorize-note">{traceNote}</div> : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}

function strokeAttrs(svg: string): { stroke: string; fill: string; width: string; dash: string; cap: string } {
  // What is in `defs` is markers and clip paths, not the drawing.
  const drawing = svg.replace(/<defs[\s\S]*?<\/defs>/g, '');
  const pick = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(drawing)?.[1] ?? '';
  return { stroke: pick('stroke'), fill: pick('fill'), width: pick('stroke-width'), dash: pick('stroke-dasharray'), cap: pick('stroke-linecap') };
}

/** Sets an attribute on every path-like element of the markup. */
function writeSvgAttr(id: string, name: string, value: string | null): void {
  const s = session();
  const n = s.snap.nodes.get(id);
  if (!n?.svg) return;
  const doc = new DOMParser().parseFromString(n.svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return;
  const targets = [...root.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')].filter((el) => !el.closest('defs'));
  for (const el of targets) {
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
  setFields([id], { svg: new XMLSerializer().serializeToString(root) });
}

const CAP_OPTIONS: { value: CapKind; label: string }[] = [{ value: 'none', label: msg('None') }, { value: 'arrow', label: msg('Arrow') }, { value: 'triangle', label: msg('Triangle') }, { value: 'circle', label: msg('Circle') }, { value: 'bar', label: msg('Bar') }];

export function VectorSection({ node }: { node: BogenNode }) {
  const t = useT();
  const capOptions = CAP_OPTIONS.map((o) => ({ ...o, label: t(o.label) }));
  const a = strokeAttrs(node.svg ?? '');
  const closed = isClosedMarkup(node.svg ?? '');
  const caps = capsOf(node.svg ?? '');
  return (
    <Section title={t('Vector')} actions={<IconButton icon={<PenTool size={14} />} title={t('Edit points')} onClick={() => startPathEdit(node.id)} testId="vector-edit" />}>
      <div className="stack">
        <div className="param-color"><span className="param-label">{t('Fill')}</span><ColorField value={a.fill === 'none' ? '' : a.fill} placeholder={t('None')} onChange={(v) => writeSvgAttr(node.id, 'fill', v || 'none')} testId="vector-fill" /></div>
        <div className="param-color"><span className="param-label">{t('Stroke')}</span><ColorField value={a.stroke === 'none' ? '' : a.stroke} placeholder={t('None')} onChange={(v) => writeSvgAttr(node.id, 'stroke', v || 'none')} testId="vector-stroke" /></div>
        <Row>
          <NumberField label="W" value={strokeWidthOf(node.svg ?? '')} min={0} step={0.5} testId="vector-width" onChange={(v) => setStrokeWidth(node.id, v)} />
          <TextField label={t('Dash')} value={a.dash} placeholder={t('None')} onChange={(v) => writeSvgAttr(node.id, 'stroke-dasharray', v || null)} />
        </Row>
        <Row>
          <SelectField label={t('Cap')} value={a.cap || 'butt'} options={['butt', 'round', 'square'].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))} onChange={(v) => writeSvgAttr(node.id, 'stroke-linecap', v)} />
          <SelectField<StrokeAlign> label={t('Align')} title={t('Where the stroke sits on a closed path')} testId="vector-align" value={strokeAlignOf(node.svg ?? '')} disabled={!closed} onChange={(v) => setStrokeAlign(node.id, v)} options={[{ value: 'center', label: t('Center') }, { value: 'inside', label: t('Inside') }, { value: 'outside', label: t('Outside'), disabled: a.fill === 'none' || !a.fill }]} />
        </Row>
        {!closed || caps.start !== 'none' || caps.end !== 'none' ? (
          <Row>
            <SelectField<CapKind> label={t(ctx('start of a path', 'Start'))} title={t('Marker at the start of the path')} testId="vector-cap-start" value={caps.start} onChange={(v) => setCap(node.id, 'start', v)} options={capOptions} />
            <SelectField<CapKind> label={t('End')} title={t('Marker at the end of the path')} testId="vector-cap-end" value={caps.end} onChange={(v) => setCap(node.id, 'end', v)} options={capOptions} />
          </Row>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Whether the file fits how big the image is shown: on a 2× screen a picture needs twice its CSS width in pixels to
 * look sharp, and far more than that only makes the page heavier. Read from the layer's width on the canvas.
 */
export function resolutionAdvice(natural: { width: number; height: number }, shownWidth: number, src = ''): { level: 'ok' | 'soft' | 'heavy' | 'vector'; text: string } {
  const need = Math.round(shownWidth * 2);
  if (!shownWidth) return { level: 'ok', text: '' };
  // An SVG's width and height are only its default size: it is drawn sharp at any size and on any screen.
  if (isVectorSrc(src)) return { level: 'vector', text: t('Vector image: sharp at any size and on any screen.') };
  if (natural.width < shownWidth) return { level: 'soft', text: t('Shown {shown} px wide from a {width} px file: blurry on every screen. Use one at least {need} px wide.', { shown: Math.round(shownWidth), width: natural.width, need }) };
  if (natural.width < need * 0.9) return { level: 'soft', text: t('Shown {shown} px wide from a {width} px file: sharp at 1×, soft on 2× screens, which want {need} px.', { shown: Math.round(shownWidth), width: natural.width, need }) };
  if (natural.width > need * 2.5) return { level: 'heavy', text: t('The file is {width} px wide for {shown} px shown: about {times}× the pixels a 2× screen needs. A {need} px version loads faster.', { width: natural.width, shown: Math.round(shownWidth), times: Math.round((natural.width / need) ** 2), need }) };
  return { level: 'ok', text: t('{width} × {height} for {shown} px shown: sharp on 2× screens.', { width: natural.width, height: natural.height, shown: Math.round(shownWidth) }) };
}

/** An SVG file or data URL, by the asset's extension or the data URL's type. */
export function isVectorSrc(src: string): boolean {
  return /^data:image\/svg\+xml[;,]/i.test(src) || /\.svg(?:[?#].*)?$/i.test(src);
}

function ResolutionNote({ id, natural, src }: { id: string; natural: { width: number; height: number }; src: string }) {
  useT();
  // The width on the page, in world coordinates whatever the canvas zoom.
  const shown = rectOf(id)?.w ?? 0;
  const advice = resolutionAdvice(natural, shown, src);
  if (!advice.text) return null;
  return <div className={`hint resolution-${advice.level}`} data-testid="image-resolution" data-level={advice.level}>{advice.text}</div>;
}
