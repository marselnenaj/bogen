import {
  DEVICE_ATTR, DEVICE_PROFILES, canvasDeviceFrames, createComponent, defaultFinish, deviceForSize, deviceGeometry, deviceLayer, deviceProfile, readDeviceConfig, setCanvasDeviceFrame,
  type BogenNode, type DeviceLayerConfig,
} from '@bogen/core';
import { useSyncExternalStore } from 'react';
import { session } from '../../doc/session.ts';
import { goToLayer } from '../../ops/reveal.ts';
import { computedBox } from '../../canvas/measure.ts';
import { Row, Section, SelectField } from '../../ui/controls.tsx';
import { useT } from '../../i18n/react.ts';

/**
 * Device frames in the inspector: the frame shown around an artboard on the canvas, and the device, finish and
 * screen of a device layer placed in a design (the agents' device_frame does the same).
 */

export const isDevice = (n: BogenNode): boolean => !!n.attrs?.[DEVICE_ATTR];

const num = (v: string | undefined) => Number(/^(-?[\d.]+)px$/.exec(v ?? '')?.[1] ?? Number.NaN);

function useCanvasFrames() {
  const { doc } = session();
  return useSyncExternalStore((fn) => { doc.meta.observe(fn); return () => doc.meta.unobserve(fn); }, () => doc.meta.get('deviceFrames'));
}

/** Shows or hides the frame around an artboard on the canvas; shown, it is the device of the artboard's size. */
export function toggleCanvasFrame(node: BogenNode): void {
  const s = session();
  const on = !!canvasDeviceFrames(s.doc)[node.id];
  const box = computedBox(node.id);
  const w = box?.width ?? num(node.style.width);
  const h = box?.height ?? num(node.style.height);
  s.tx(() => setCanvasDeviceFrame(s.doc, node.id, on || !(w > 0 && h > 0) ? null : { device: deviceForSize(w, h).id }));
}

export function ArtboardDeviceRow({ node }: { node: BogenNode }) {
  const t = useT();
  useCanvasFrames();
  const s = session();
  const frame = canvasDeviceFrames(s.doc)[node.id];
  const profile = frame ? deviceProfile(frame.device) : undefined;
  const set = (device: string, finish?: number) => s.tx(() => setCanvasDeviceFrame(s.doc, node.id, device ? { device, ...(finish !== undefined ? { finish } : {}) } : null));
  return (
    <Row>
      <SelectField<string>
        className="field-grow"
        label={t('Device frame')}
        title={t('Shown around the artboard on the canvas. It does not change the artboard or its export.')}
        value={frame?.device ?? ''}
        options={[{ value: '', label: t('None') }, ...DEVICE_PROFILES.map((p) => ({ value: p.id, label: t('{preset}, {width} × {height}', { preset: p.name, width: p.width, height: p.height }) }))]}
        onChange={(v) => set(v)}
        testId="insp-device-frame"
      />
      {profile && profile.finishes.length > 1 ? (
        <SelectField<string> label={t('Finish')} value={String(frame?.finish ?? defaultFinish(profile))} options={profile.finishes.map((f, i) => ({ value: String(i), label: f.name }))} onChange={(v) => set(profile.id, Number(v))} testId="insp-device-finish" />
      ) : null}
    </Row>
  );
}

function writeDevice(node: BogenNode, next: DeviceLayerConfig): void {
  const s = session();
  const ground = next.source ? s.doc.getNode(next.source)?.style.backgroundColor : undefined;
  const layer = deviceLayer(next, ground);
  s.tx(() => {
    s.doc.updateFields(node.id, { attrs: { ...(node.attrs ?? {}), [DEVICE_ATTR]: JSON.stringify(next) } });
    s.doc.updateStyle(node.id, { width: `${layer.width}px`, height: `${layer.height}px` });
    const old = s.doc.getChildren(node.id).map((c) => c.id);
    if (old.length) s.doc.delete(old);
    s.doc.insertMany(node.id, layer.children);
  });
}

/** Puts the selected artboard live into the device of its size, beside it, as the agents' device_frame does. */
export function placeInDevice(node: BogenNode): string | null {
  const box = computedBox(node.id);
  const w = box?.width ?? num(node.style.width);
  const h = box?.height ?? num(node.style.height);
  if (!(w > 0 && h > 0)) return null;
  const s = session();
  const p = deviceForSize(w, h);
  const left = (num(node.style.left) || 0) + w + 120;
  const top = num(node.style.top) || 0;
  return s.tx(() => {
    if (!node.component && !node.instanceOf) createComponent(s.doc, node.id, { description: 'A screen that device frames show. Change it here and every device follows.' });
    const main = node.instanceOf ?? node.id;
    const config: DeviceLayerConfig = { device: p.id, source: main, sourceWidth: w, sourceHeight: h, width: Math.round(deviceGeometry(p).width * 100) / 100 };
    const layer = deviceLayer(config, node.style.backgroundColor);
    return s.doc.insert(node.parent, {
      type: 'frame', tag: 'figure', name: `Device · ${p.name}`,
      style: { position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${layer.width}px`, height: `${layer.height}px` },
      attrs: { [DEVICE_ATTR]: JSON.stringify(config), role: 'img', 'aria-label': `${node.name} on ${p.name}` },
      children: layer.children,
    });
  });
}

export function DeviceSection({ node }: { node: BogenNode }) {
  const t = useT();
  const c = readDeviceConfig(node.attrs?.[DEVICE_ATTR]);
  if (!c) return null;
  const profile = deviceProfile(c.device);
  const source = c.source ? session().doc.getNode(c.source) : null;
  // A new device keeps the layer's height on the page roughly where it was: the same scale of screen.
  const setDevice = (id: string) => {
    const next = deviceProfile(id);
    const was = profile ? deviceGeometry(profile).width : c.width;
    if (next) writeDevice(node, { ...c, device: id, finish: undefined, width: Math.round((c.width / was) * deviceGeometry(next).width * 100) / 100 });
  };
  return (
    <Section title={t('Device frame')} note={source ? t('Shows {name} in a device. Change the design and the screen follows.', { name: source.name }) : undefined}>
      <div className="stack">
        <SelectField<string> value={c.device} options={DEVICE_PROFILES.map((p) => ({ value: p.id, label: t('{preset}, {width} × {height}', { preset: p.name, width: p.width, height: p.height }) }))} onChange={setDevice} testId="device-model" />
        {profile && profile.finishes.length > 1 ? (
          <SelectField<string> label={t('Finish')} value={String(c.finish ?? defaultFinish(profile))} options={profile.finishes.map((f, i) => ({ value: String(i), label: f.name }))} onChange={(v) => writeDevice(node, { ...c, finish: Number(v) })} testId="device-finish" />
        ) : null}
        {source ? <button type="button" className="btn" onClick={() => goToLayer(source.id, { fit: true })} data-testid="device-source">{t('Select the design')}</button> : null}
      </div>
    </Section>
  );
}
