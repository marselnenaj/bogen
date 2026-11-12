import type { ComponentType } from 'react';
import { msg } from '../i18n/core.ts';

/**
 * Shader layers keep their parameters in `attrs`, as strings, with `type` naming the effect in kebab
 * case. The library itself is loaded only when a shader is on screen or the inspector needs it.
 */
export const SHADER_TYPES: { id: string; label: string; image?: boolean }[] = [
  { id: 'mesh-gradient', label: msg('Mesh gradient') },
  { id: 'static-mesh-gradient', label: msg('Static mesh gradient') },
  { id: 'static-radial-gradient', label: msg('Static radial gradient') },
  { id: 'grain-gradient', label: msg('Grain gradient') },
  { id: 'dithering', label: msg('Dithering') },
  { id: 'smoke-ring', label: msg('Smoke ring') },
  { id: 'neuro-noise', label: msg('Neuro noise') },
  { id: 'dot-orbit', label: msg('Dot orbit') },
  { id: 'dot-grid', label: msg('Dot grid') },
  { id: 'simplex-noise', label: msg('Simplex noise') },
  { id: 'perlin-noise', label: msg('Perlin noise') },
  { id: 'metaballs', label: msg('Metaballs') },
  { id: 'waves', label: msg('Waves') },
  { id: 'voronoi', label: msg('Voronoi') },
  { id: 'warp', label: msg('Warp') },
  { id: 'god-rays', label: msg('God rays') },
  { id: 'spiral', label: msg('Spiral') },
  { id: 'swirl', label: msg('Swirl') },
  { id: 'pulsing-border', label: msg('Pulsing border') },
  { id: 'color-panels', label: msg('Colour panels') },
  { id: 'paper-texture', label: msg('Paper texture'), image: true },
  { id: 'fluted-glass', label: msg('Fluted glass'), image: true },
  { id: 'water', label: msg('Water'), image: true },
  { id: 'image-dithering', label: msg('Image dithering'), image: true },
  { id: 'liquid-metal', label: msg('Liquid metal'), image: true },
  { id: 'lens-distortion', label: msg('Lens distortion'), image: true },
  { id: 'heatmap', label: msg('Heatmap'), image: true },
  { id: 'halftone-dots', label: msg('Halftone dots'), image: true },
  { id: 'halftone-cmyk', label: msg('Halftone CMYK'), image: true },
  { id: 'gem-smoke', label: msg('Gem smoke'), image: true },
];

export const DEFAULT_SHADER = 'mesh-gradient';

export type ShaderValue = string | number | boolean | string[];
export interface ShaderPreset { name: string; params: Record<string, ShaderValue> }

type Lib = Record<string, unknown>;
let lib: Promise<Lib> | null = null;

export function loadShaderLib(): Promise<Lib> {
  if (!lib) lib = import('@paper-design/shaders-react') as unknown as Promise<Lib>;
  return lib;
}

function pascal(id: string): string {
  return id.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
}

export async function shaderComponent(id: string): Promise<ComponentType<Record<string, unknown>> | null> {
  const m = await loadShaderLib();
  return (m[pascal(id)] as ComponentType<Record<string, unknown>> | undefined) ?? null;
}

export async function shaderPresets(id: string): Promise<ShaderPreset[]> {
  const m = await loadShaderLib();
  const name = pascal(id);
  const key = `${name[0]!.toLowerCase()}${name.slice(1)}Presets`;
  return (m[key] as ShaderPreset[] | undefined) ?? [];
}

/** Strings from the document back to the types the components want. */
export function parseShaderAttrs(attrs: Record<string, string> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k === 'type' || k.startsWith('data-')) continue;
    if (k === 'colors') {
      out.colors = parseColorList(v);
      continue;
    }
    if (v === 'true') out[k] = true;
    else if (v === 'false') out[k] = false;
    else if (v !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

export function parseColorList(v: string): string[] {
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      return JSON.parse(t) as string[];
    } catch {
      return [];
    }
  }
  return t.split(/\s*,\s*(?![^(]*\))/).filter(Boolean);
}

export function presetToAttrs(type: string, preset: ShaderPreset): Record<string, string> {
  const out: Record<string, string> = { type };
  for (const [k, v] of Object.entries(preset.params)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
  }
  return out;
}
