import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import type { BogenNode } from '@bogen/core';
import { useSelectedNodes, useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { elOf } from '../canvas/measure.ts';
import { animationEnd, DEFAULT_ANIMATION, MOTION_PRESETS, parseAnimations, parseKeyframes, printAnimations, printKeyframes, type AnimationSpec, type Keyframes } from '../lib/motion.ts';
import { setStyle } from '../ops/ops.ts';
import { pauseAllMotion, playAllMotion, scrubTo } from '../ops/motion.ts';
import { useEditor } from '../state/store.ts';
import { useUi } from '../state/ui.ts';
import { Empty, IconButton, NumberField, Row, Section, SelectField, TextField } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { ctx, msg } from '../i18n/core.ts';

function storedKeyframes(): string[] {
  const kf = session().doc.meta.get('keyframes');
  return Array.isArray(kf) ? (kf as unknown[]).filter((k): k is string => typeof k === 'string') : [];
}

function allKeyframes(): Keyframes[] {
  return storedKeyframes().flatMap((k) => parseKeyframes(k) ?? []);
}

function writeKeyframes(next: Keyframes): void {
  const s = session();
  const list = storedKeyframes();
  const i = list.findIndex((k) => parseKeyframes(k)?.name === next.name);
  const text = printKeyframes(next);
  const out = i >= 0 ? list.map((k, j) => (j === i ? text : k)) : [...list, text];
  s.tx(() => s.doc.meta.set('keyframes', out));
}

const EASINGS = ['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier(.2,.8,.2,1)', 'cubic-bezier(.7,0,.3,1)', 'steps(4, end)'];
const FILLS = ['none', 'forwards', 'backwards', 'both'];
const DIRECTIONS = ['normal', 'reverse', 'alternate', 'alternate-reverse'];
/** How the CSS keywords read in the menus. */
const KEYWORD_LABELS: Record<string, string> = {
  none: msg('None'), forwards: msg('Forwards'), backwards: msg('Backwards'), both: msg('Both'),
  normal: msg('Normal'), reverse: msg('Reverse'), alternate: msg('Alternate'), 'alternate-reverse': msg('Alternate reverse'),
};

function KeyframesEditor({ frames }: { frames: Keyframes }) {
  const t = useT();
  const [active, setActive] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const stops = frames.stops;
  const set = (next: Keyframes['stops']) => writeKeyframes({ ...frames, stops: next });
  const onStopDown = (e: React.PointerEvent<HTMLButtonElement>, index: number) => {
    e.preventDefault();
    setActive(index);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const s = session();
    s.beginGesture();
    const css = stops[index]!.css;
    const move = (ev: PointerEvent) => {
      const r = barRef.current!.getBoundingClientRect();
      const offset = Math.max(0, Math.min(100, Math.round(((ev.clientX - r.left) / r.width) * 100)));
      const next = stops.map((st, i) => (i === index ? { ...st, offset } : st));
      set(next);
      setActive([...next].sort((a, b) => a.offset - b.offset).findIndex((st) => st.css === css && st.offset === offset));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      s.endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const addAt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    const offset = Math.round(((e.clientX - r.left) / r.width) * 100);
    const near = [...stops].sort((a, b) => Math.abs(a.offset - offset) - Math.abs(b.offset - offset))[0];
    set([...stops, { offset, css: near?.css ?? '' }]);
  };
  const current = stops[Math.min(active, stops.length - 1)];
  return (
    <div className="motion-frames" data-testid="keyframes-editor">
      <div ref={barRef} className="motion-bar" onPointerDown={addAt} data-testid="keyframes-bar" title={t('Click to add a stop')}>
        {stops.map((st, i) => (
          <button key={i} type="button" className={`motion-stop${i === active ? ' is-active' : ''}`} style={{ left: `${st.offset}%` }} aria-label={t('Stop at {offset}%', { offset: st.offset })} data-testid="keyframe-stop" onPointerDown={(e) => onStopDown(e, i)} onClick={() => setActive(i)} />
        ))}
      </div>
      {current ? (
        <>
          <Row>
            <NumberField label={t('At')} value={current.offset} min={0} max={100} suffix="%" testId="keyframe-offset" onChange={(offset) => set(stops.map((st, i) => (i === active ? { ...st, offset } : st)))} />
            <IconButton icon={<Trash2 size={13} />} title={t('Remove this stop')} disabled={stops.length <= 1} testId="keyframe-remove" onClick={() => { set(stops.filter((_, i) => i !== active)); setActive(0); }} />
          </Row>
          <textarea key={`${active}-${current.offset}`} className="text-area motion-css" rows={2} spellCheck={false} defaultValue={current.css} aria-label={t('Styles at this stop')} data-testid="keyframe-css" onBlur={(e) => { if (e.target.value !== current.css) set(stops.map((st, i) => (i === active ? { ...st, css: e.target.value.replace(/[{}]/g, '') } : st))); }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } }} />
        </>
      ) : null}
    </div>
  );
}

function AnimationRow({ spec, index, frames, onChange, onRemove }: { spec: AnimationSpec; index: number; frames: Keyframes[]; onChange: (a: AnimationSpec) => void; onRemove: () => void }) {
  const t = useT();
  const f = frames.find((k) => k.name === spec.name);
  return (
    <div className="motion-anim" data-testid="motion-animation">
      <Row>
        <SelectField<string> value={spec.name} options={[...frames.map((k) => ({ value: k.name, label: k.name })), ...(f ? [] : [{ value: spec.name, label: t('{name} (no keyframes)', { name: spec.name }), disabled: true }])]} onChange={(name) => onChange({ ...spec, name })} testId={`motion-name-${index}`} title={t('Keyframes')} />
        <IconButton icon={<Trash2 size={13} />} title={t('Remove this animation')} onClick={onRemove} testId={`motion-remove-${index}`} />
      </Row>
      <Row>
        <NumberField label={t('Time')} value={spec.duration} min={0} step={50} suffix="ms" testId={`motion-duration-${index}`} onChange={(duration) => onChange({ ...spec, duration })} />
        <NumberField label={t('Delay')} value={spec.delay} step={50} suffix="ms" testId={`motion-delay-${index}`} onChange={(delay) => onChange({ ...spec, delay })} />
      </Row>
      <SelectField<string> label={t('Easing')} value={spec.easing} options={[...new Set([...EASINGS, spec.easing])].map((v) => ({ value: v, label: v }))} onChange={(easing) => onChange({ ...spec, easing })} testId={`motion-easing-${index}`} />
      <Row>
        <NumberField label={t('Loop')} value={spec.iterations === 'infinite' ? null : spec.iterations} placeholder="∞" min={0} display={spec.iterations === 'infinite' ? '∞' : undefined} testId={`motion-loop-${index}`} title={t('How many times. Type {keyword} to repeat for ever.', { keyword: 'inf' })} onChange={(iterations) => onChange({ ...spec, iterations })} onRaw={(raw) => { if (/^(inf|∞)/i.test(raw)) onChange({ ...spec, iterations: 'infinite' }); }} />
        <SelectField<string> value={spec.direction} options={DIRECTIONS.map((v) => ({ value: v, label: t(KEYWORD_LABELS[v]!) }))} onChange={(direction) => onChange({ ...spec, direction })} title={t('Direction')} testId={`motion-direction-${index}`} />
      </Row>
      <SelectField<string> label={t(ctx('animation fill mode', 'Fill'))} value={spec.fill} options={FILLS.map((v) => ({ value: v, label: t(KEYWORD_LABELS[v]!) }))} onChange={(fill) => onChange({ ...spec, fill })} testId={`motion-fill-${index}`} />
      {f ? <KeyframesEditor frames={f} /> : null}
    </div>
  );
}

/** The artboard around the selection, or the first one that has anything moving. */
function timelineRoot(nodes: BogenNode[]): string | null {
  const { snap } = session();
  const first = nodes[0];
  if (first) return snap.ancestors(first.id).at(-1) ?? first.id;
  const page = useEditor.getState().pageId;
  const kids = page ? snap.children(page) : [];
  return kids.find((id) => elOf(id)?.getAnimations({ subtree: true }).length) ?? kids[0] ?? null;
}

interface Bar { id: string; name: string; delay: number; duration: number; end: number; infinite: boolean }

function barsOf(root: string): Bar[] {
  const { snap } = session();
  const out: Bar[] = [];
  const walk = (id: string) => {
    const n = snap.nodes.get(id);
    if (!n) return;
    for (const a of parseAnimations(n.style)) out.push({ id, name: n.name, delay: a.delay, duration: a.duration, end: animationEnd(a), infinite: a.iterations === 'infinite' });
    snap.children(id).forEach(walk);
  };
  walk(root);
  return out;
}

function Timeline({ root }: { root: string }) {
  const t = useT();
  useSnapVersion();
  const bars = useMemo(() => barsOf(root).slice(0, 24), [root, session().snap.version]);
  const total = Math.max(500, ...bars.map((b) => b.end));
  const [time, setTime] = useState<number | null>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const paused = useUi((s) => s.motionPaused);
  useEffect(() => { if (!paused) setTime(null); }, [paused]);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const seek = (clientX: number) => {
      const r = ruler.current!.getBoundingClientRect();
      const at = Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total);
      setTime(at);
      scrubTo(root, at);
    };
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 100 : 10;
    const at = Math.max(0, Math.min(total, (time ?? 0) + (e.key === 'ArrowRight' ? step : -step)));
    setTime(at);
    scrubTo(root, at);
  };
  return (
    <div className="motion-timeline" data-testid="motion-timeline">
      <div className="motion-time"><span dir="auto">{session().snap.nodes.get(root)?.name}</span><span data-testid="motion-time">{time === null ? `${Math.round(total)} ms` : `${time} / ${Math.round(total)} ms`}</span></div>
      <div ref={ruler} className="motion-ruler" role="slider" tabIndex={0} aria-label={t('Timeline of this artboard')} aria-valuemin={0} aria-valuemax={total} aria-valuenow={time ?? 0} onPointerDown={onDown} onKeyDown={onKey} data-testid="motion-ruler">
        {time !== null ? <span className="motion-playhead" style={{ left: `${(time / total) * 100}%` }} /> : null}
      </div>
      {bars.map((b, i) => (
        <div key={`${b.id}-${i}`} className="motion-row" title={b.infinite ? t('{name}: {delay} ms delay, {duration} ms, repeating', { name: b.name, delay: b.delay, duration: b.duration }) : t('{name}: {delay} ms delay, {duration} ms', { name: b.name, delay: b.delay, duration: b.duration })}>
          <span className="motion-row-name" dir="auto">{b.name}</span>
          <span className="motion-track"><span className={`motion-span${b.infinite ? ' is-infinite' : ''}`} style={{ left: `${(b.delay / total) * 100}%`, width: `${Math.max(1, ((b.end - b.delay) / total) * 100)}%` }} /></span>
        </div>
      ))}
      {!bars.length ? <div className="hint">{t('Nothing on this artboard moves yet.')}</div> : null}
    </div>
  );
}

export function MotionPanel() {
  const t = useT();
  const nodes = useSelectedNodes();
  const paused = useUi((s) => s.motionPaused);
  useSnapVersion();
  const single = nodes.length === 1 ? nodes[0]! : null;
  const anims = single ? parseAnimations(single.style) : [];
  const frames = allKeyframes();
  const root = timelineRoot(nodes);
  const write = (list: AnimationSpec[]) => { if (single) setStyle([single.id], printAnimations(list)); };
  const addPreset = (name: string) => {
    const preset = MOTION_PRESETS.find((p) => p.name === name);
    if (!preset || !single) return;
    const s = session();
    s.beginGesture();
    if (!frames.some((k) => k.name === preset.keyframes.name)) writeKeyframes(preset.keyframes);
    write([...anims, { ...DEFAULT_ANIMATION, ...preset.spec, name: preset.keyframes.name }]);
    s.endGesture();
  };
  return (
    <div className="motion" data-testid="motion-panel">
      <Section
        title={t('Timeline')}
        actions={<IconButton icon={paused ? <Play size={14} /> : <Pause size={14} />} title={paused ? t('Play all ({shortcut})', { shortcut: 'Alt+P' }) : t('Pause all ({shortcut})', { shortcut: 'Alt+P' })} active={paused} testId="motion-toggle" onClick={() => (paused ? playAllMotion() : pauseAllMotion())} />}
      >
        {root ? <Timeline root={root} /> : <div className="hint">{t('This page is empty.')}</div>}
      </Section>
      {single ? (
        <Section title={t('Animations')} actions={<IconButton icon={<Plus size={14} />} title={t('Add the first keyframes in this file, or a new set')} testId="motion-add" onClick={() => { const first = frames[0]; if (first) write([...anims, { ...DEFAULT_ANIMATION, name: first.name }]); else addPreset('Fade in'); }} />}>
          {anims.map((a, i) => <AnimationRow key={`${a.name}-${i}`} spec={a} index={i} frames={frames} onChange={(next) => write(anims.map((x, j) => (j === i ? next : x)))} onRemove={() => write(anims.filter((_, j) => j !== i))} />)}
          {!anims.length ? <div className="hint">{t('This layer has no animation.')}</div> : null}
          <SelectField<string> label={t('Preset')} value="" options={[{ value: '', label: t('Add'), disabled: true }, ...MOTION_PRESETS.map((p) => ({ value: p.name, label: t(p.name) }))]} onChange={addPreset} testId="motion-preset" />
          <TextField label={t('New')} placeholder={t('Name of new keyframes')} testId="motion-new" value="" onChange={(name) => { const clean = name.trim().replace(/[^\w-]/g, '-'); if (!clean) return; writeKeyframes({ name: clean, stops: [{ offset: 0, css: 'opacity:0' }, { offset: 100, css: 'opacity:1' }] }); write([...anims, { ...DEFAULT_ANIMATION, name: clean }]); }} />
        </Section>
      ) : <Empty title={nodes.length ? t.n(nodes.length, '{count} layer selected', '{count} layers selected') : t('Nothing selected')} hint={t('Select one layer to see and edit its animation.')} />}
    </div>
  );
}
