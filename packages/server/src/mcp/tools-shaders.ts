import { z } from 'zod';
import { SHADER_TYPE_NAMES, SHADERS, shaderParams, shaderTypeId } from '../shader-params.ts';
import type { ToolDefiner } from './kit.ts';

/** The parameters of every shader effect, so that an agent sets ones the effect reads. */
export function registerShaderTools(define: ToolDefiner): void {
  define('shader_params', {
    description: 'The parameters a shader effect takes, as the attributes of <x-shader> or of layer_attrs: each with its kind (number, boolean, color, colors, choice, image), its default, the choices where there are some, and for numbers the range the effect\'s presets use. The effect\'s own type, such as halftone-dots\' classic or gooey, is the attribute variant, because type names the effect. Without type it lists the effects. An attribute an effect does not take is refused by html_write and layer_attrs, with the ones it does take.',
    readOnly: true,
  }, {
    type: z.string().max(60).optional().describe('An effect, such as image-dithering or halftone-dots.'),
  }, async ({ type }) => {
    if (!type) return { effects: SHADER_TYPE_NAMES.map((t) => ({ type: t, presets: SHADERS[t]!.presets, image: 'image' in SHADERS[t]!.params })) };
    const params = shaderParams(type);
    if (!params) throw new Error(`There is no shader effect "${type}". The effects are: ${SHADER_TYPE_NAMES.join(', ')}.`);
    const id = shaderTypeId(type);
    return {
      type: id, presets: SHADERS[id]!.presets,
      params: Object.fromEntries(params.map(({ attr, ...p }) => [attr, p])),
      example: `<x-shader type="${id}" ${params.filter((p) => p.kind === 'color' || p.kind === 'choice' || p.kind === 'colors').slice(0, 3).map((p) => `${p.attr}="${Array.isArray(p.default) ? p.default.join(',') : p.default}"`).join(' ')} style="width:100%;height:480px"></x-shader>`,
    };
  });
}
