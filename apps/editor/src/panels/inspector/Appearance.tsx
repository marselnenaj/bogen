import { inspectorStyle, updateScoped } from '../../ops/breakpoints.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BogenNode } from '@bogen/core';
import { Blend, ChevronDown, ChevronRight, CircleDot, Image as ImageIcon, Minus, Plus, RotateCw, Square, TrendingUp, Upload, X } from 'lucide-react';
import { session } from '../../doc/session.ts';
import { api, resolveAsset } from '../../lib/api.ts';
import { FILTER_DEFS, fmt, fmtPx, parseFilters, parseShadows, printFilters, printShadows, printTextShadows, px, splitTopLevel, type FilterFn, type Shadow } from '../../lib/css-values.ts';
import { DEFAULT_STOPS, fillPreview, interpolatedStop, parseFills, printFillLayer, printFills, type Fill, type GradientStop } from '../../lib/fills.ts';
import { pickImage } from '../../ops/images.ts';
import { withTokenValues } from '../../lib/token-color.ts';
import { editor } from '../../state/store.ts';
import { ColorField, ColorPicker } from '../../ui/ColorPicker.tsx';
import { SortableList } from '../../ui/SortableList.tsx';
import { ui, useUi } from '../../state/ui.ts';
import { common, IconButton, MIXED, NumberField, Popover, Row, Section, Segmented, SelectField, TextField } from '../../ui/controls.tsx';
import { ctx, msg } from '../../i18n/core.ts';
import { t } from '../../i18n/store.ts';
import { useT } from '../../i18n/react.ts';

function FillEditor({ fill, onChange }: { fill: Fill; onChange: (f: Fill) => void }) {
  const t = useT();
  const kind = fill.kind;
  const stops = 'stops' in fill ? fill.stops : DEFAULT_STOPS;
  const color = fill.kind === 'solid' ? fill.color : stops[0]?.color ?? '#000000';
  const toKind = (k: Fill['kind']) => {
    if (k === kind) return;
    if (k === 'solid') onChange({ kind: 'solid', color });
    else if (k === 'linear') onChange({ kind: 'linear', angle: 180, stops: 'stops' in fill ? stops : [{ color, at: 0 }, { color: '#ffffff', at: 100 }] });
    else if (k === 'radial') onChange({ kind: 'radial', shape: 'circle', stops: 'stops' in fill ? stops : [{ color, at: 0 }, { color: '#ffffff', at: 100 }] });
    else if (k === 'conic') onChange({ kind: 'conic', angle: 0, stops: 'stops' in fill ? stops : [{ color, at: 0 }, { color: '#ffffff', at: 100 }] });
    else onChange({ kind: 'image', url: '', size: 'cover', position: 'center', repeat: 'no-repeat' });
  };
  return (
    <div className="fill-editor" data-testid="fill-editor">
      <Segmented<Fill['kind']>
        value={kind}
        onChange={toKind}
        testId="fill-kind"
        options={[
          { value: 'solid', icon: <Square size={14} />, title: t(ctx('fill type', 'Solid')) },
          { value: 'linear', icon: <TrendingUp size={14} />, title: t('Linear gradient') },
          { value: 'radial', icon: <CircleDot size={14} />, title: t('Radial gradient') },
          { value: 'conic', icon: <RotateCw size={14} />, title: t('Conic gradient') },
          { value: 'image', icon: <ImageIcon size={14} />, title: t('Image') },
        ]}
      />
      {fill.kind === 'solid' ? <ColorPicker value={fill.color} onChange={(c) => onChange({ kind: 'solid', color: c })} /> : null}
      {'stops' in fill ? <GradientEditor fill={fill} onChange={onChange} /> : null}
      {fill.kind === 'image' ? <ImageFillEditor fill={fill} onChange={onChange} /> : null}
    </div>
  );
}

function GradientEditor({ fill, onChange }: { fill: Extract<Fill, { stops: GradientStop[] }>; onChange: (f: Fill) => void }) {
  const t = useT();
  const [localActive, setLocalActive] = useState(0);
  const handles = useUi((s) => s.gradient);
  const active = handles ? handles.stop : localActive;
  const setActive = (i: number) => {
    setLocalActive(i);
    const g = ui().gradient;
    if (g) ui().set({ gradient: { ...g, stop: i } });
  };
  const barRef = useRef<HTMLDivElement>(null);
  const stops = fill.stops;
  const current = stops[Math.min(active, stops.length - 1)]!;
  const setStops = (next: GradientStop[]) => onChange({ ...fill, stops: next });
  const bg = `linear-gradient(to right, ${[...stops].sort((a, b) => a.at - b.at).map((s) => `${s.color} ${s.at}%`).join(', ')})`;

  const startDrag = (e: React.PointerEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(index);
    const bar = barRef.current!;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    session().beginGesture();
    const move = (ev: PointerEvent) => {
      const r = bar.getBoundingClientRect();
      const at = Math.max(0, Math.min(100, Math.round(((ev.clientX - r.left) / r.width) * 100)));
      setStops(stops.map((s, i) => (i === index ? { ...s, at } : s)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      session().endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const addAt = (e: React.PointerEvent) => {
    const r = barRef.current!.getBoundingClientRect();
    const at = Math.round(((e.clientX - r.left) / r.width) * 100);
    const next = [...stops, interpolatedStop(stops, at)];
    setActive(next.length - 1);
    setStops(next);
  };

  return (
    <div className="gradient">
      <div ref={barRef} className="gradient-bar" onPointerDown={addAt} data-testid="gradient-bar">
        <div className="gradient-bar-fill" style={{ background: bg }} />
        {stops.map((s, i) => (
          <div key={i} className={`gradient-stop${i === active ? ' is-active' : ''}`} style={{ left: `${s.at}%` }} onPointerDown={(e) => startDrag(e, i)} data-testid="gradient-stop">
            <span style={{ background: s.color }} />
          </div>
        ))}
      </div>
      <Row>
        <NumberField label={t('Stop')} value={current.at} min={0} max={100} suffix="%" onChange={(at) => setStops(stops.map((s, i) => (i === active ? { ...s, at } : s)))} />
        {fill.kind === 'linear' || fill.kind === 'conic' ? (
          <NumberField label="∠" value={fill.angle} suffix="°" testId="gradient-angle" onChange={(angle) => onChange({ ...fill, angle })} />
        ) : (
          <TextField value={fill.shape} onChange={(shape) => onChange({ ...fill, shape })} placeholder="circle at center" title={t('Radial shape')} />
        )}
        <IconButton icon={<Minus size={14} />} title={t('Remove this stop')} disabled={stops.length <= 2} onClick={() => { setStops(stops.filter((_, i) => i !== active)); setActive(0); }} />
      </Row>
      <ColorPicker key={active} value={current.color} onChange={(color) => setStops(stops.map((s, i) => (i === active ? { ...s, color } : s)))} />
    </div>
  );
}

function ImageFillEditor({ fill, onChange }: { fill: Extract<Fill, { kind: 'image' }>; onChange: (f: Fill) => void }) {
  const t = useT();
  return (
    <div className="stack">
      <div className="fill-image-preview" style={{ background: fill.url ? `center / contain no-repeat url("${resolveAsset(fill.url)}")` : undefined }}>
        {!fill.url ? <span>{t('No image yet')}</span> : null}
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => pickImage(async (file) => {
          const asset = await api.upload(file);
          onChange({ ...fill, url: asset.src });
        })}
      ><Upload size={14} /> {t('Choose image')}</button>
      <TextField value={fill.url} placeholder="https://" onChange={(url) => onChange({ ...fill, url })} title={t('Image URL')} />
      <Row>
        <SelectField value={fill.size} onChange={(size) => onChange({ ...fill, size })} options={[{ value: 'cover', label: t('Cover') }, { value: 'contain', label: t('Contain') }, { value: 'auto', label: t('Original') }, { value: '100% 100%', label: t('Stretch') }]} />
        <SelectField value={fill.repeat} onChange={(repeat) => onChange({ ...fill, repeat })} options={[{ value: 'no-repeat', label: t('Once') }, { value: 'repeat', label: t('Tile') }, { value: 'repeat-x', label: t('Tile {axis}', { axis: 'X' }) }, { value: 'repeat-y', label: t('Tile {axis}', { axis: 'Y' }) }]} />
      </Row>
    </div>
  );
}

function fillLabel(f: Fill): string {
  switch (f.kind) {
    case 'solid': return f.color;
    case 'linear': return t('Linear');
    case 'radial': return t('Radial');
    case 'conic': return t('Conic');
    case 'image': return f.url ? t('Image') : t('Empty image');
  }
}

function FillRow({ fill, onChange, onRemove, index, nodeId }: { fill: Fill; onChange: (f: Fill) => void; onRemove: () => void; index: number; nodeId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // With its editor open, a linear or radial fill also gets handles on the canvas.
  const handles = open && nodeId && (fill.kind === 'linear' || fill.kind === 'radial');
  useEffect(() => {
    if (!handles) return undefined;
    ui().set({ gradient: { nodeId: nodeId!, fillIndex: index, stop: 0 } });
    return () => ui().set({ gradient: null });
  }, [handles, nodeId, index]);
  return (
    <div className="list-row">
      <button ref={ref} type="button" className="swatch" onClick={() => setOpen(!open)} title={t('Edit fill')} data-testid={`fill-swatch-${index}`}>
        <span className="swatch-fill" style={{ background: withTokenValues(fillPreview(fill)) }} />
      </button>
      {fill.kind === 'solid' ? (
        <TextField className="list-row-grow" value={fill.color} onChange={(color) => onChange({ kind: 'solid', color })} testId={`fill-text-${index}`} />
      ) : (
        <button type="button" className="list-row-grow list-row-label" onClick={() => setOpen(!open)}>{fillLabel(fill)}</button>
      )}
      <IconButton icon={<Minus size={14} />} title={t('Remove fill')} onClick={onRemove} testId={`fill-remove-${index}`} />
      {open ? (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={256}>
          <FillEditor fill={fill} onChange={onChange} />
        </Popover>
      ) : null}
    </div>
  );
}

export function FillsSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const lists = nodes.map((n) => parseFills(n.style));
  const key = lists.map((l) => JSON.stringify(l));
  const mixed = new Set(key).size > 1;
  const fills = lists[0] ?? [];
  const write = (next: Fill[]) => inspectorStyle(ids, printFills(next));
  const add = () => {
    const next: Fill[] = [...(mixed ? [] : fills)];
    if (!next.length) next.push({ kind: 'solid', color: '#d9d9d9' });
    else next.unshift({ kind: 'solid', color: '#00000033' });
    write(next);
  };
  const isTextGradient = nodes.some((n) => n.style.WebkitBackgroundClip === 'text' || n.style.backgroundClip === 'text');
  return (
    <Section title={t('Fill')} actions={<IconButton icon={<Plus size={14} />} title={t('Add fill')} onClick={add} testId="fill-add" />} empty={!fills.length && !mixed}>
      {mixed ? <div className="hint">{t('Several different fills. Adding one replaces them.')}</div> : null}
      {!mixed && fills.length ? (
        <div className="stack">
          <SortableList
            items={fills}
            keyOf={(_, i) => i}
            label="fill"
            testId="fills"
            onReorder={write}
            render={(f, i) => (
              <FillRow
                index={i}
                fill={f}
                nodeId={nodes.length === 1 ? nodes[0]!.id : undefined}
                onChange={(nf) => write(fills.map((x, j) => (j === i ? nf : x)))}
                onRemove={() => write(fills.filter((_, j) => j !== i))}
              />
            )}
          />
          {isTextGradient ? <div className="hint">{t('Fills are painted through the text.')}</div> : null}
        </div>
      ) : null}
    </Section>
  );
}

function parseBorderShorthand(style: Record<string, string>): { width: string; lineStyle: string; color: string } {
  if (style.border) {
    let width = '';
    let lineStyle = '';
    let color = '';
    for (const part of splitTopLevel(style.border, ' ')) {
      if (/^[\d.]/.test(part) || ['thin', 'medium', 'thick'].includes(part)) width = part;
      else if (['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset'].includes(part)) lineStyle = part;
      else color = part;
    }
    return { width: style.borderWidth ?? width, lineStyle: style.borderStyle ?? lineStyle, color: style.borderColor ?? color };
  }
  return { width: style.borderWidth ?? '', lineStyle: style.borderStyle ?? '', color: style.borderColor ?? '' };
}

const LINE_STYLES: { value: string; label: string }[] = [{ value: 'solid', label: ctx('line style', 'Solid') }, { value: 'dashed', label: msg('Dashed') }, { value: 'dotted', label: msg('Dotted') }, { value: 'double', label: msg('Double') }];

export function BorderSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const parsed = nodes.map((n) => parseBorderShorthand(n.style));
  const has = parsed.some((p) => p.width && p.lineStyle !== 'none');
  const write = (patch: { width?: string; lineStyle?: string; color?: string }) => {
    const s = session();
    s.tx(() => {
      nodes.forEach((n, i) => {
        const p = parsed[i]!;
        updateScoped(s.doc, n.id, { border: null, borderWidth: patch.width ?? (p.width || '1px'), borderStyle: patch.lineStyle ?? (p.lineStyle || 'solid'), borderColor: patch.color ?? (p.color || '#111111') });
      });
    });
  };
  const width = common(parsed.map((p) => px(p.width)));
  const lineStyle = common(parsed.map((p) => p.lineStyle || 'solid'));
  const color = common(parsed.map((p) => p.color));
  const sides = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const;
  return (
    <Section
      title={t('Border')}
      empty={!has}
      actions={has
        ? <IconButton icon={<Minus size={14} />} title={t('Remove border')} testId="border-remove" onClick={() => inspectorStyle(ids, { border: null, borderWidth: null, borderStyle: null, borderColor: null, borderTopWidth: null, borderRightWidth: null, borderBottomWidth: null, borderLeftWidth: null })} />
        : <IconButton icon={<Plus size={14} />} title={t('Add border')} testId="border-add" onClick={() => write({ width: '1px', lineStyle: 'solid', color: '#111111' })} />}
    >
      {has ? (
        <div className="stack">
          <ColorField value={color === MIXED ? '' : color ?? ''} mixed={color === MIXED} onChange={(c) => write({ color: c })} testId="border-color" />
          <Row>
            <NumberField label="W" value={width === undefined ? 0 : width} min={0} testId="border-width" onChange={(v) => write({ width: fmtPx(v) })} />
            <SelectField value={lineStyle} options={LINE_STYLES.map((v) => ({ value: v.value, label: t(v.label) }))} onChange={(v) => write({ lineStyle: v })} title={t('Border style')} />
          </Row>
          <details className="details">
            <summary>{t('Each side')}</summary>
            <Row className="inspector-quad-row">
              {sides.map((key, i) => (
                <NumberField key={key} label={'TRBL'[i]!} placeholder="-" value={common(nodes.map((n) => (n.style[key] ? px(n.style[key]) : null))) ?? null} min={0} onChange={(v) => inspectorStyle(ids, { [key]: fmtPx(v) })} />
              ))}
            </Row>
          </details>
        </div>
      ) : null}
    </Section>
  );
}

export function OutlineSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const has = nodes.some((n) => n.style.outlineWidth || n.style.outline);
  const width = common(nodes.map((n) => px(n.style.outlineWidth)));
  const offset = common(nodes.map((n) => px(n.style.outlineOffset)));
  const color = common(nodes.map((n) => n.style.outlineColor ?? ''));
  const lineStyle = common(nodes.map((n) => n.style.outlineStyle ?? 'solid'));
  return (
    <Section
      title={t('Outline')}
      empty={!has}
      actions={has
        ? <IconButton icon={<Minus size={14} />} title={t('Remove outline')} onClick={() => inspectorStyle(ids, { outline: null, outlineWidth: null, outlineStyle: null, outlineColor: null, outlineOffset: null })} />
        : <IconButton icon={<Plus size={14} />} title={t('Add outline')} testId="outline-add" onClick={() => inspectorStyle(ids, { outline: null, outlineWidth: '1px', outlineStyle: 'solid', outlineColor: '#111111' })} />}
    >
      {has ? (
        <div className="stack">
          <ColorField value={color === MIXED ? '' : color ?? ''} mixed={color === MIXED} onChange={(c) => inspectorStyle(ids, { outlineColor: c })} />
          <Row>
            <NumberField label="W" value={width === undefined ? 0 : width} min={0} onChange={(v) => inspectorStyle(ids, { outlineWidth: fmtPx(v) })} />
            <NumberField label={t('Off')} value={offset === undefined ? 0 : offset} title={t('Offset')} onChange={(v) => inspectorStyle(ids, { outlineOffset: fmtPx(v) })} />
            <SelectField value={lineStyle} options={LINE_STYLES.map((v) => ({ value: v.value, label: t(v.label) }))} onChange={(v) => inspectorStyle(ids, { outlineStyle: v })} title={t('Outline style')} />
          </Row>
        </div>
      ) : null}
    </Section>
  );
}

function ShadowRow({ shadow, onChange, onRemove, isText, index }: { shadow: Shadow; onChange: (s: Shadow) => void; onRemove: () => void; isText: boolean; index: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const shadowValues = `${fmt(shadow.x)}, ${fmt(shadow.y)}, ${fmt(shadow.blur)}${isText ? '' : `, ${fmt(shadow.spread)}`}`;
  return (
    <div className="shadow-row">
      <div className="list-row">
        <button type="button" className="disclosure" onClick={() => setOpen(!open)} aria-expanded={open} title={t('Show values')} data-testid={`shadow-toggle-${index}`}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="swatch-dot" style={{ background: withTokenValues(shadow.color) }} />
        <span className="list-row-grow list-row-text">{shadow.inset ? t('Inner {values}', { values: shadowValues }) : shadowValues}</span>
        <IconButton icon={<Minus size={14} />} title={t('Remove shadow')} onClick={onRemove} />
      </div>
      {open ? (
        <div className="stack shadow-values">
          <Row>
            <NumberField label="X" value={shadow.x} onChange={(x) => onChange({ ...shadow, x })} />
            <NumberField label="Y" value={shadow.y} onChange={(y) => onChange({ ...shadow, y })} />
          </Row>
          <Row>
            <NumberField label={t('Blur')} value={shadow.blur} min={0} testId={`shadow-blur-${index}`} onChange={(blur) => onChange({ ...shadow, blur })} />
            {!isText ? <NumberField label={t('Size')} value={shadow.spread} onChange={(spread) => onChange({ ...shadow, spread })} /> : null}
          </Row>
          <ColorField value={shadow.color} onChange={(color) => onChange({ ...shadow, color })} />
          {!isText ? (
            <label className="check"><input type="checkbox" checked={shadow.inset} onChange={(e) => onChange({ ...shadow, inset: e.target.checked })} /> {t('Inner shadow')}</label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FilterList({ value, onChange, title }: { value: string | undefined; onChange: (v: string | null) => void; title: string }) {
  const t = useT();
  const list = parseFilters(value);
  const write = (next: FilterFn[]) => onChange(next.length ? printFilters(next) : null);
  const used = new Set(list.map((f) => f.fn));
  const rest = FILTER_DEFS.filter((d) => !used.has(d.fn));
  return (
    <div className="stack">
      <SortableList
        items={list}
        keyOf={(f) => f.fn}
        label="filter"
        testId={`${title}-list`}
        onReorder={write}
        render={(f, i) => {
          const def = FILTER_DEFS.find((d) => d.fn === f.fn);
          return (
            <div className="list-row">
              <span className="list-row-label-fixed">{def ? t(def.label) : f.fn}</span>
              <NumberField className="list-row-grow" value={f.value} suffix={f.unit} min={def?.min} max={def?.max} step={def?.step} testId={`${title}-${f.fn}`} onChange={(v) => write(list.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
              <IconButton icon={<Minus size={14} />} title={t('Remove {filter}', { filter: def ? t(def.label) : f.fn })} onClick={() => write(list.filter((_, j) => j !== i))} />
            </div>
          );
        }}
      />
      {rest.length ? (
        <SelectField<string>
          value=""
          label={t(title)}
          options={[{ value: '', label: t('Add'), disabled: true }, ...rest.map((d) => ({ value: d.fn, label: t(d.label) }))]}
          testId={`add-${title}`}
          onChange={(fn) => {
            const def = FILTER_DEFS.find((d) => d.fn === fn);
            if (def) write([...list, { fn, value: def.initial, unit: def.unit }]);
          }}
        />
      ) : null}
    </div>
  );
}

export function EffectsSection({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const ids = nodes.map((n) => n.id);
  const first = nodes[0]!;
  const allText = nodes.every((n) => n.type === 'text');
  const shadowKey = allText ? 'textShadow' : 'boxShadow';
  const shadows = parseShadows(first.style[shadowKey]);
  const writeShadows = (next: Shadow[]) => inspectorStyle(ids, { [shadowKey]: next.length ? (allText ? printTextShadows(next) : printShadows(next)) : null });
  const mixedShadow = new Set(nodes.map((n) => n.style[shadowKey] ?? '')).size > 1;
  return (
    <Section
      title={t('Effects')}
      actions={<IconButton icon={<Plus size={14} />} title={t('Add shadow')} testId="shadow-add" onClick={() => writeShadows([...(mixedShadow ? [] : shadows), { inset: false, x: 0, y: 4, blur: 12, spread: 0, color: '#00000040' }])} />}
    >
      {mixedShadow ? <div className="hint">{t('Mixed shadows. Adding one replaces them.')}</div> : null}
      {!mixedShadow && shadows.length ? (
        <SortableList
          items={shadows}
          keyOf={(_, i) => i}
          label="shadow"
          testId="shadows"
          onReorder={writeShadows}
          render={(sh, i) => <ShadowRow index={i} shadow={sh} isText={allText} onChange={(next) => writeShadows(shadows.map((x, j) => (j === i ? next : x)))} onRemove={() => writeShadows(shadows.filter((_, j) => j !== i))} />}
        />
      ) : null}
      <FilterList title={msg('Filter')} value={first.style.filter} onChange={(v) => inspectorStyle(ids, { filter: v })} />
      <FilterList title={msg('Backdrop')} value={first.style.backdropFilter} onChange={(v) => inspectorStyle(ids, { backdropFilter: v, WebkitBackdropFilter: null })} />
    </Section>
  );
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|lch\([^)]*\)|lab\([^)]*\)|color\([^)]*\)/g;
const COLOR_KEYS = new Set(['color', 'backgroundColor', 'borderColor', 'outlineColor', 'fill', 'stroke', 'WebkitTextStrokeColor', 'textDecorationColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']);

function colorsIn(nodes: BogenNode[]): Map<string, number> {
  const { snap } = session();
  const out = new Map<string, number>();
  const add = (c: string) => out.set(c, (out.get(c) ?? 0) + 1);
  const visit = (n: BogenNode, budget: { left: number }) => {
    if (budget.left-- <= 0) return;
    for (const [k, v] of Object.entries(n.style)) {
      const found = v.match(COLOR_RE);
      if (found) found.forEach(add);
      else if (COLOR_KEYS.has(k) && !/^var\(/.test(v) && v !== 'transparent') add(v);
    }
    if (n.svg) {
      for (const m of n.svg.replace(/<defs[\s\S]*?<\/defs>/g, '').matchAll(/\b(?:fill|stroke)="([^"]+)"/g)) {
        const v = m[1]!;
        if (v !== 'none' && !v.startsWith('url(')) add(v);
      }
    }
    for (const c of snap.children(n.id)) {
      const child = snap.nodes.get(c);
      if (child) visit(child, budget);
    }
  };
  const budget = { left: 3000 };
  for (const n of nodes) visit(n, budget);
  return out;
}

function replaceColor(nodes: BogenNode[], from: string, to: string): void {
  const s = session();
  const { snap, doc } = s;
  const visit = (n: BogenNode) => {
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.style)) if (v.includes(from)) patch[k] = v.split(from).join(to);
    if (Object.keys(patch).length) updateScoped(doc, n.id, patch);
    if (n.svg?.includes(`"${from}"`)) doc.updateFields(n.id, { svg: n.svg.split(`"${from}"`).join(`"${to}"`) });
    for (const c of snap.children(n.id)) {
      const child = snap.nodes.get(c);
      if (child) visit(child);
    }
  };
  s.tx(() => nodes.forEach(visit));
}

function SelectionColorRow({ color, count, nodes }: { color: string; count: number; nodes: BogenNode[] }) {
  // The row keeps following the colour it started from while dragging in the picker.
  const current = useRef(color);
  current.current = color;
  const onChange = (next: string) => {
    if (next === current.current) return;
    replaceColor(nodes, current.current, next);
    current.current = next;
  };
  return (
    <div className="list-row">
      <ColorField value={color} onChange={onChange} />
      <span className="list-count">{count}</span>
    </div>
  );
}

export function SelectionColors({ nodes }: { nodes: BogenNode[] }) {
  const t = useT();
  const colors = useMemo(() => [...colorsIn(nodes).entries()].sort((a, b) => b[1] - a[1]).slice(0, 12), [nodes]);
  const hasKids = nodes.length > 1 || session().snap.children(nodes[0]!.id).length > 0 || nodes[0]!.type === 'svg';
  if (!hasKids || colors.length < 1) return null;
  return (
    <Section title={t('Selection colours')} collapsible defaultOpen={colors.length <= 6}>
      <div className="stack">
        {colors.map(([c, n], i) => <SelectionColorRow key={i} color={c} count={n} nodes={nodes} />)}
      </div>
    </Section>
  );
}

export { Blend, X, printFillLayer, editor };
