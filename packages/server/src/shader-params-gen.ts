/**
 * Builds the shader parameter table from the shader package itself: each effect's default preset gives its
 * parameters and defaults, its other presets the range they use, and the package's choice tables (DitheringTypes,
 * HalftoneDotsGrids and the like) the allowed words. Used by scripts/gen-shader-params.ts and by the test that
 * keeps shader-params.json in step with the installed package; the server reads only the JSON.
 */
export interface ShaderParam {
  kind: 'number' | 'boolean' | 'color' | 'colors' | 'choice' | 'text' | 'image';
  default?: string | number | boolean | string[];
  options?: string[];
  /** The lowest and highest value the effect's presets use: a sensible range, not a hard limit. */
  range?: [number, number];
}
export interface ShaderInfo { params: Record<string, ShaderParam>; presets: string[] }

const SUFFIX: Record<string, string> = { type: 'Types', shape: 'Shapes', grid: 'Grids', pattern: 'Patterns', aspectRatio: 'AspectRatios', fit: 'FitOptions', distortionShape: 'Shapes', gridShape: 'Shapes' };
const pascal = (s: string) => s.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');

export async function shaderParamTable(): Promise<Record<string, ShaderInfo>> {
  const react = (await import('@paper-design/shaders-react')) as unknown as Record<string, unknown>;
  const core = (await import('@paper-design/shaders')) as unknown as Record<string, unknown>;
  const choiceTables = Object.entries(core).filter(([k, v]) => /^[A-Z]\w*(Types|Shapes|Grids|Patterns|AspectRatios|FitOptions)$/.test(k) && v && typeof v === 'object' && !Array.isArray(v)) as [string, Record<string, unknown>][];
  const table: Record<string, ShaderInfo> = {};
  for (const key of Object.keys(react).filter((k) => k.endsWith('Presets')).sort()) {
    const base = key.slice(0, -'Presets'.length);
    const type = base.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const presets = react[key] as { name: string; params: Record<string, unknown> }[];
    const first = presets[0]?.params ?? {};
    const params: Record<string, ShaderParam> = {};
    for (const [name, value] of Object.entries(first)) {
      const seen = presets.map((p) => p.params[name]).filter((v) => v !== undefined);
      if (typeof value === 'number') {
        const nums = seen.filter((v): v is number => typeof v === 'number');
        params[name] = { kind: 'number', default: value, range: [Math.min(...nums), Math.max(...nums)] };
      } else if (typeof value === 'boolean') params[name] = { kind: 'boolean', default: value };
      else if (Array.isArray(value)) params[name] = { kind: 'colors', default: value as string[] };
      else if (typeof value === 'string' && /^(#|rgb|hsl)/i.test(value)) params[name] = { kind: 'color', default: value };
      else if (typeof value === 'string') {
        const own = choiceTables.find(([k]) => k === `${pascal(type)}${SUFFIX[name] ?? ''}`) ?? choiceTables.find(([k, v]) => (SUFFIX[name] ? k.endsWith(SUFFIX[name]!) : false) && value in v)
          ?? choiceTables.find(([k, v]) => k.startsWith(pascal(type)) && value in v);
        params[name] = own ? { kind: 'choice', default: value, options: Object.keys(own[1]) } : { kind: 'text', default: value };
      }
    }
    // Effects that filter a picture take it as image, which no preset sets.
    if (presets.some((p) => 'image' in p.params) || /^(paper-texture|fluted-glass|water|image-dithering|liquid-metal|lens-distortion|heatmap|halftone-dots|halftone-cmyk|gem-smoke)$/.test(type)) params.image = { kind: 'image' };
    table[type] = { params, presets: presets.map((p) => p.name) };
  }
  return table;
}
