import table from './shader-params.json' with { type: 'json' };
import type { ShaderInfo, ShaderParam } from './shader-params-gen.ts';

/**
 * What each shader effect takes, from the table generated out of the shader package (gen-shader-params.ts), and the
 * check that a shader layer's attributes are ones its effect reads. A misspelt or invented attribute would otherwise
 * do nothing without a word.
 *
 * Attributes are the effect's parameter names, camelCase, except its own `type` (such as halftone-dots' classic or
 * gooey), which is written `variant`, because `type` names the effect.
 */
export const SHADERS = table as unknown as Record<string, ShaderInfo>;
export const SHADER_TYPE_NAMES = Object.keys(SHADERS).sort();

/** The effect's id in kebab case: MeshGradient and meshGradient are read as mesh-gradient, as the renderer does. */
export function shaderTypeId(type: string): string {
  return type.trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
}

/** The attribute a parameter is written as on the layer. */
export const attrOf = (param: string): string => (param === 'type' ? 'variant' : param);
/** The parameter an attribute stands for. */
export const paramOf = (attr: string): string => (attr === 'variant' ? 'type' : attr);

/** Attributes any layer may carry that are not parameters of the effect. */
const GLOBAL = /^(type|id|class|title|role|lang|dir|aria-[\w-]+|data-[\w-]+)$/;

export function shaderParams(type: string): (ShaderParam & { attr: string })[] | null {
  const info = SHADERS[shaderTypeId(type)];
  if (!info) return null;
  return Object.entries(info.params).map(([name, p]) => ({ attr: attrOf(name), ...p }));
}

/** Why these attributes would not work on a shader of this type, one sentence each; empty when they all would. */
export function shaderAttrProblems(given: string | undefined, attrs: Record<string, string | null>): string[] {
  if (!given) return ['A shader layer needs type, the effect, such as mesh-gradient.'];
  const type = shaderTypeId(given);
  const info = SHADERS[type];
  if (!info) return [`There is no shader effect "${type}". The effects are: ${SHADER_TYPE_NAMES.join(', ')}.`];
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const [attr, value] of Object.entries(attrs)) {
    if (GLOBAL.test(attr)) continue;
    const p = info.params[paramOf(attr)];
    if (!p) {
      unknown.push(attr);
      continue;
    }
    if (value === null) continue;
    const v = value.trim();
    if (p.kind === 'number' && (v === '' || Number.isNaN(Number(v)))) problems.push(`${attr} is a number${p.range ? ` (the presets use ${p.range[0]} to ${p.range[1]})` : ''}, not "${value}".`);
    if (p.kind === 'boolean' && v !== 'true' && v !== 'false') problems.push(`${attr} is true or false, not "${value}".`);
    if (p.kind === 'choice' && p.options && !p.options.includes(v)) problems.push(`${attr} is one of ${p.options.join(', ')}, not "${value}".`);
  }
  if (unknown.length) problems.unshift(`${type} has no ${unknown.map((u) => `"${u}"`).join(', ')}. It takes: ${Object.keys(info.params).map(attrOf).join(', ')}. shader_params lists defaults and choices.`);
  return problems;
}
