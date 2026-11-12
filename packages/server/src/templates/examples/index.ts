import { BrandKit } from '../kit.ts';
import type { TemplateDef } from '../types.ts';
import { couchette } from './couchette.ts';
import { crux } from './crux.ts';
import { laneway } from './laneway.ts';
import { secondShelf } from './second-shelf.ts';
import type { ExampleDef } from './types.ts';

export type { ExampleDef } from './types.ts';

/** The gallery, in the order the home screen shows it. */
export const EXAMPLES: readonly ExampleDef[] = [couchette, crux, laneway, secondShelf];

/** An example as a template: template_list and template_use offer both, and `only` picks its boards by part. */
export function exampleTemplate(ex: ExampleDef): TemplateDef {
  return {
    id: ex.id, name: ex.name, kind: ex.kind, brand: ex.brand,
    description: `${ex.description} Brings its own brand, ${ex.brand.name}, made with the brand tools: using it makes that brand (or reuses it) and a new file linked to it.`,
    parts: ex.parts,
    fileName: () => ex.name,
    build(env, options) {
      const plan = ex.build(new BrandKit(env));
      if (!options.only?.length) return plan;
      return { ...plan, boards: plan.boards.filter((_, i) => options.only!.includes(ex.parts[i]?.key ?? '')) };
    },
  };
}
