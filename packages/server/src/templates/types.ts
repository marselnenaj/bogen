import type { BrandSpec } from './brand-spec.ts';
import type { TemplateEnv } from './kit.ts';

/** A layer of a board that becomes the main of a component, found by its layer name. */
export interface ComponentDef {
  layer: string;
  name: string;
  description?: string;
  set?: string;
  variant?: Record<string, string>;
  /** Each prop drives a layer inside the main, found by name; '' is the main itself. */
  props?: { name: string; type: 'text' | 'boolean' | 'image'; target: string; field?: string }[];
}

/** What a board is made of, in order: markup, written into the board or a named layer of it, and components made from layers already there. */
export type BoardStep = { html: string; into?: string } | { component: ComponentDef };

export interface BoardPlan {
  name: string;
  /** The board's own tag. A page that holds its own header, main and footer is a div; the default is main. */
  tag?: string;
  width: number;
  /** Fixed height, for formats such as social images. Leave out to hug content. */
  height?: number;
  background: string;
  color: string;
  font: string;
  steps: BoardStep[];
}

export interface TemplatePlan {
  page: string;
  boards: BoardPlan[];
  /** What the brand does not say yet, each as the short note the boards show. */
  gaps: string[];
  /** Layers that hold words for a person or an agent to write, by layer name, with what goes there. */
  slots?: { layer: string; hint: string }[];
}

export interface TemplateOptions {
  /** Which boards or formats, by key. Default is all. */
  only?: string[];
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  /** The source-based design knowledge and completion-review profile. */
  discipline?: string;
  /** Board keys with what each one is, for template_list and `only`. */
  parts: { key: string; name: string; size: string }[];
  /** The name a new file gets. */
  fileName: (brand: string) => string;
  /** For an example: what it is in two words, and the small brand it brings. Using it makes that brand, or reuses it. */
  kind?: string;
  brand?: BrandSpec;
  build: (env: TemplateEnv, options: TemplateOptions) => TemplatePlan;
}
