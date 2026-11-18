import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCKUP_ATTR, readMockupConfig } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

describe('mockup_place', () => {
  let h: Harness;
  let fileId: string;
  beforeAll(async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'mockup-agent');
    fileId = (await call(agent, 'file_create', { name: 'Mockups' })).id;
    await agent.close();
  }, 60_000);
  afterAll(() => h.cleanup());

  it('lists the scenes', async () => {
    const agent = await connectAgent(h.base, 'mockup-agent');
    const out = await call(agent, 'mockup_list', {});
    expect(out.scenes.map((s: { id: string }) => s.id)).toEqual(['poster-wall', 'billboard', 'tote-bag', 'badge-lanyard', 'hanging-sign', 'packet', 'cap', 'phone', 'laptop']);
    await agent.close();
  });

  it('places a live instance of the artboard on a scene and changes it in place', async () => {
    const agent = await connectAgent(h.base, 'mockup-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const poster = await call(agent, 'artboard_create', { name: 'Poster', width: 500, height: 700, background: '#123456' });
    await call(agent, 'html_write', { target_id: poster.id, html: '<h1 style="color:#fff;margin:0;padding:40px">Twelve seeds out.</h1>' });
    const out = await call(agent, 'mockup_place', { source: poster.id, scene: 'billboard', width: 800, x: 700, y: 0 });
    expect(out.note).toContain('component');
    const doc = (await h.server.rooms.get(fileId)).doc;
    expect(doc.getNode(poster.id)!.component).toBeTruthy();
    const frame = doc.getNode(out.id)!;
    expect(frame.style.width).toBe('800px');
    expect(frame.style.height).toBe('600px');
    const config = readMockupConfig(frame.attrs?.[MOCKUP_ATTR]);
    expect(config).toMatchObject({ source: poster.id, scene: 'billboard', blend: 'multiply' });
    const surface = doc.getChildren(out.id).find((c) => c.name === 'Surface')!;
    const strip = doc.getChildren(surface.id)[0]!;
    expect(strip.style.transform).toMatch(/^matrix3d\(/);
    expect(doc.source.raw(doc.getChildren(strip.id)[0]!.id)?.instanceOf).toBe(poster.id);

    const again = await call(agent, 'mockup_place', { node_id: out.id, scene: 'tote-bag', shading: 0.5 });
    expect(again.id).toBe(out.id);
    expect(again.strips).toBe(8);
    expect(readMockupConfig(doc.getNode(out.id)!.attrs?.[MOCKUP_ATTR])).toMatchObject({ scene: 'tote-bag', shading: 0.5, source: poster.id });
    expect(again.note).toBeUndefined();
    // Scene at the back, the print over it, the light over the print.
    expect(doc.getChildren(out.id).map((c) => c.name)).toEqual(['Scene', 'Surface', 'Light on the surface']);
    await agent.close();
  });

  it('asks for what it needs', async () => {
    const agent = await connectAgent(h.base, 'mockup-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const board = await call(agent, 'artboard_create', { name: 'Card', width: 400, height: 250 });
    expect((await callRaw(agent, 'mockup_place', { source: board.id })).isError).toBe(true);
    expect((await callRaw(agent, 'mockup_place', { source: board.id, scene: 'moon' })).isError).toBe(true);
    expect((await callRaw(agent, 'mockup_place', { source: board.id, photo: 'bogen-asset:nope.png' })).isError).toBe(true);
    await agent.close();
  });
});
