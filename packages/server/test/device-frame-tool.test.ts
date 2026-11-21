import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_ATTR, canvasDeviceFrames, deviceForSize, deviceGeometry, deviceProfile, readDeviceConfig } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

describe('device frames', () => {
  it('draws the iPhones to Apple\'s measurements and finds the device of a size', () => {
    const p = deviceProfile('iphone-18pro')!;
    const g = deviceGeometry(p);
    // 71.85 mm of body over a 66.57 mm wide active area of 402 points: about 16 points of bezel each side.
    expect(g.screen.w).toBe(402);
    expect(g.screen.x - g.body.x).toBeGreaterThan(15);
    expect(g.screen.x - g.body.x).toBeLessThan(17);
    expect(g.cutout?.shape).toBe('island');
    expect(g.buttons.length).toBe(5);
    expect(deviceForSize(393, 852).id).toBe('iphone-16');
    expect(deviceForSize(852, 393).id).toBe('iphone-16');
    expect(deviceForSize(1440, 1024).id).toBe('browser');
    expect(deviceForSize(375, 667).kind).toBe('phone');
    // A taller artboard keeps the body's width and stretches it.
    expect(deviceGeometry(p, { width: 402, height: 1600 }).body.w).toBeCloseTo(g.body.w, 3);
  });

  let h: Harness;
  let fileId: string;
  beforeAll(async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'device-agent');
    fileId = (await call(agent, 'file_create', { name: 'Devices' })).id;
    await agent.close();
  }, 60_000);
  afterAll(() => h.cleanup());

  it('puts an artboard live into a phone, changes it in place, and frames an artboard on the canvas', async () => {
    const agent = await connectAgent(h.base, 'device-agent');
    await call(agent, 'file_open', { file_id: fileId });
    expect((await call(agent, 'device_list', {})).devices.length).toBeGreaterThan(10);
    const screen = await call(agent, 'artboard_create', { name: 'Home', width: 393, height: 852, background: '#f4f1ea' });
    const out = await call(agent, 'device_frame', { source: screen.id, x: 600, y: 0 });
    expect(out.device).toBe('iphone-16');
    expect(out.note).toContain('component');
    const doc = (await h.server.rooms.get(fileId)).doc;
    const layer = doc.getNode(out.id)!;
    expect(readDeviceConfig(layer.attrs?.[DEVICE_ATTR])).toMatchObject({ device: 'iphone-16', source: screen.id, sourceWidth: 393 });
    const [scr, frame] = doc.getChildren(out.id);
    expect(scr!.name).toBe('Screen');
    expect(scr!.style.width).toBe('393px');
    expect(scr!.style.backgroundColor).toBe('#f4f1ea');
    expect(frame!.type).toBe('svg');
    expect(doc.source.raw(doc.getChildren(scr!.id)[0]!.id)?.instanceOf).toBe(screen.id);

    const again = await call(agent, 'device_frame', { node_id: out.id, device: 'pixel-11', width: 300 });
    expect(again.id).toBe(out.id);
    expect(doc.getNode(out.id)!.style.width).toBe('300px');
    expect(readDeviceConfig(doc.getNode(out.id)!.attrs?.[DEVICE_ATTR])).toMatchObject({ device: 'pixel-11', source: screen.id });

    const around = await call(agent, 'device_frame', { around: screen.id });
    expect(around.device).toBe('iphone-16');
    expect(canvasDeviceFrames(doc)[screen.id]).toEqual({ device: 'iphone-16' });
    await call(agent, 'device_frame', { around: screen.id, device: 'none' });
    expect(canvasDeviceFrames(doc)[screen.id]).toBeUndefined();

    expect((await callRaw(agent, 'device_frame', { source: screen.id, device: 'brick' })).isError).toBe(true);
    expect((await callRaw(agent, 'device_frame', { around: frame!.id })).isError).toBe(true);
    await agent.close();
  });
});
