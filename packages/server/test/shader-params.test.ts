import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shaderParamTable } from '../src/shader-params-gen.ts';
import { SHADERS, shaderAttrProblems, shaderTypeId } from '../src/shader-params.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

describe('shader parameters', () => {
  it('match the installed shader package (run scripts/gen-shader-params.ts after an update)', async () => {
    expect(await shaderParamTable()).toEqual(SHADERS);
  });

  it('know defaults, choices and ranges', () => {
    expect(SHADERS['halftone-dots']!.params.type).toEqual({ kind: 'choice', default: 'gooey', options: ['classic', 'gooey', 'holes', 'soft'] });
    expect(SHADERS['image-dithering']!.params.type!.options).toEqual(['random', '2x2', '4x4', '8x8']);
    expect(SHADERS['mesh-gradient']!.params.colors!.kind).toBe('colors');
    expect(SHADERS['image-dithering']!.params.image).toEqual({ kind: 'image' });
    expect(shaderTypeId('MeshGradient')).toBe('mesh-gradient');
  });

  it('name what is wrong with a shader\'s attributes', () => {
    expect(shaderAttrProblems('image-dithering', { type: 'image-dithering', colorFront: '#fff', variant: '4x4', size: '2', 'aria-label': 'Peas', 'data-x': '1' })).toEqual([]);
    expect(shaderAttrProblems('MeshGradient', { colors: '#000,#fff', speed: '0.4' })).toEqual([]);
    const [unknown] = shaderAttrProblems('image-dithering', { type2: '4x4' });
    expect(unknown).toMatch(/has no "type2". It takes: /);
    expect(unknown).toContain('variant');
    expect(unknown).toContain('colorFront');
    expect(shaderAttrProblems('halftone-dots', { variant: 'round' })).toEqual(['variant is one of classic, gooey, holes, soft, not "round".']);
    expect(shaderAttrProblems('halftone-dots', { size: 'big', inverted: 'yes' })).toEqual([expect.stringMatching(/size is a number \(the presets use/), 'inverted is true or false, not "yes".']);
    expect(shaderAttrProblems('sparkles', {})[0]).toMatch(/no shader effect "sparkles"/);
  });
});

describe('shader tools', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(() => h.cleanup());

  it('lists effects and parameters, and refuses an attribute the effect does not take', async () => {
    const agent = await connectAgent(h.base, 'shader-agent');
    const list = await call(agent, 'shader_params', {});
    expect(list.effects.length).toBe(Object.keys(SHADERS).length);
    const one = await call(agent, 'shader_params', { type: 'halftone-dots' });
    expect(one.params.variant).toMatchObject({ kind: 'choice', default: 'gooey' });
    expect(one.example).toContain('<x-shader type="halftone-dots"');
    await call(agent, 'file_create', { name: 'Shaders' });
    const board = await call(agent, 'artboard_create', { name: 'Board', width: 400, height: 300 });
    const bad = await callRaw(agent, 'html_write', { target_id: board.id, html: '<x-shader type="image-dithering" type2="4x4" style="width:100px;height:100px"></x-shader>' });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toMatch(/Nothing was written. image-dithering has no "type2"/);
    const ok = await call(agent, 'html_write', { target_id: board.id, html: '<x-shader type="image-dithering" variant="4x4" colorFront="#94ffaf" style="width:100px;height:100px"></x-shader>' });
    const id = ok.ids[0];
    const wrong = await callRaw(agent, 'layer_attrs', { node_id: id, attrs: { colorFrnt: '#fff' } });
    expect((wrong.content as { text: string }[])[0]!.text).toMatch(/Nothing was changed. image-dithering has no "colorFrnt"/);
    await call(agent, 'layer_attrs', { node_id: id, attrs: { colorBack: '#000c38', variant: '8x8' } });
    await agent.close();
  }, 60_000);
});
