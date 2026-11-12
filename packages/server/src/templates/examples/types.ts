import type { BrandSpec } from '../brand-spec.ts';
import type { BrandKit } from '../kit.ts';
import type { TemplatePlan } from '../types.ts';

/**
 * A finished design to start from. Unlike a template, it brings its own small brand: using it makes that brand (or
 * reuses the one it made before) and a new file linked to it, drawn in the brand's tokens.
 */
export interface ExampleDef {
  id: string;
  /** What it is, in two words, for the gallery. */
  kind: string;
  name: string;
  description: string;
  brand: BrandSpec;
  /** In the order of the boards that `build` returns. */
  parts: { key: string; name: string; size: string }[];
  build: (k: BrandKit) => TemplatePlan;
}
