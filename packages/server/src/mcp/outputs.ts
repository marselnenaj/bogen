import { z } from 'zod';

/**
 * Output schemas of the tools agents call most, so that a client can read their results as fields
 * (`structuredContent`) and knows their shape before calling. The text result stays the same JSON. Fields
 * that only some results carry are optional, and objects accept more than they list, so a field added later
 * never fails a call. A tool listed here must return a plain object on every path that is not an error.
 */
const id = z.string();
const brand = z.unknown().optional().describe('The brand the file links, with its hard rules, when it has one.');
const brandWarnings = z.unknown().optional().describe('After a write in a branded file: what the change does against the brand, with the fix for each.');
const pageSummary = z.looseObject({ id, name: z.string(), layers: z.number().describe('Top-level layers on the page.') });

const fileSummary = {
  id: id.describe('The file id. Pass it as file_id.'),
  name: z.string().optional(),
  pages: z.array(pageSummary).optional(),
  organization: z.unknown().optional().describe('Current pages with unassigned screens or pending arrangement; ordinary text headings do not count as native sections.'),
  tokens: z.number().optional().describe('How many design tokens the file has.'),
  openComments: z.number().optional().describe('Comment threads that are not resolved.'),
  peopleHere: z.array(z.string()).optional().describe('Names of the people who have it open now.'),
  brand,
  note: z.string().optional(),
};

const layerRef = z.looseObject({ id, type: z.string(), name: z.string() });

const SHAPES: Record<string, z.ZodRawShape> = {
  brand_book_get: { brand_id: id, readiness: z.unknown(), chapters: z.array(z.unknown()).optional(), chapter: z.unknown().optional(), notice: z.string() },
  brand_book_update: { brand_id: id, chapter: z.unknown(), readiness: z.unknown() },
  context_get: {
    organization: z.unknown().optional(),
    editorOpen: z.boolean().describe('Whether a person has the editor open. All tools work either way.'),
    file: z.looseObject({ id, name: z.string().optional() }).optional().describe('The file the person is looking at.'),
    page: z.looseObject({ id, name: z.string().optional() }).nullable().optional(),
    selection: z.array(z.looseObject({ id, type: z.string(), tag: z.string(), name: z.string(), text: z.string().optional() })).optional().describe('The layers the person has selected.'),
    user: z.string().optional(),
    others: z.array(z.looseObject({ name: z.string(), fileId: z.string(), pageId: z.string().nullable().optional() })).optional().describe('Other people and where they are.'),
    currentFile: z.looseObject({ id, name: z.string().optional() }).nullable().optional().describe('With no editor open: the file this session works in.'),
    files: z.array(z.looseObject({ id, name: z.string() })).optional().describe('With no editor open: the newest files.'),
    note: z.string().optional(),
    brand,
  },
  file_open: fileSummary,
  file_create: fileSummary,
  canvas_plan_get: { page_id: id, version: z.literal(1), layout_pending: z.boolean().optional(), revision: z.number(), revision_id: z.string(), sections: z.array(z.unknown()), connections: z.array(z.unknown()), unassigned: z.array(z.unknown()) },
  canvas_plan_set: { page_id: id, applied: z.boolean(), revision: z.number(), revision_id: z.string(), sections: z.array(z.unknown()), connections: z.array(z.unknown()), placements: z.array(z.unknown()), bounds: z.unknown(), unassigned: z.array(z.unknown()) },
  artboard_create: {
    id: id.describe('The artboard. Write into it with html_write and target_id.'),
    name: z.string(),
    page_id: id,
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.union([z.number(), z.literal('hug')]).describe('hug when it grows with its content.'),
    brand_warnings: brandWarnings,
  },
  html_write: {
    ids: z.array(id).describe('The top-level layers written, in order.'),
    tree: z.string().describe('An outline of what was written, three levels deep.'),
    warnings: z.array(z.string()).optional().describe('What was dropped or changed, such as CSS a browser would ignore.'),
    next: z.string().describe('What to do next.'),
    brand_warnings: brandWarnings,
  },
  layer_get: {
    id,
    type: z.string(),
    tag: z.string(),
    name: z.string(),
    parent: z.string().optional(),
    style: z.record(z.string(), z.string()).describe('Stored CSS in camelCase.'),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.string()).optional(),
    rules: z.record(z.string(), z.unknown()).optional().describe('Pseudo-element and condition blocks, such as "::before" or "@container (max-width: 560px)".'),
    overridden: z.unknown().optional().describe('On an instance or a layer inside one: what differs from the main.'),
    children: z.array(layerRef),
    page: z.string().optional().describe('The page the layer is on.'),
  },
  layer_style: {
    updated: z.number().describe('How many layers changed.'),
    style: z.record(z.string(), z.string()).optional().describe('The first layer\'s style after the change.'),
    block: z.string().optional().describe('With pseudo or when: the block that was written.'),
    rules: z.record(z.string(), z.unknown()).optional(),
    warnings: z.array(z.string()).optional(),
    brand_warnings: brandWarnings,
  },
  component_list: {
    total: z.number(),
    components: z.array(z.record(z.string(), z.unknown())).describe('Each main with its id, name, props, variants, slots and instance count.'),
  },
  design_lint: {
    total: z.number().describe('How many issues there are.'),
    counts: z.record(z.string(), z.number()).describe('Issues per rule.'),
    issues: z.array(z.record(z.string(), z.unknown())).describe('Each with the layer, the rule, what is wrong and, where there is one, the style that fixes it.'),
    fixed: z.array(z.looseObject({ node_id: z.string(), rule: z.string(), style: z.unknown() })).optional().describe('With fix true: what was applied.'),
    note: z.string().optional(),
  },
  agent_undo: {
    undone: z.boolean().optional().describe('Whether a step was taken back.'),
    redone: z.boolean().optional().describe('With redo true: whether a step was brought back.'),
    steps: z.number().describe('How many of your steps were used up, more than 1 when someone had overwritten the later ones.'),
    can_undo: z.number(),
    can_redo: z.number(),
    note: z.string().optional(),
  },
};

/** Loose at every level: a client that checks results against the schema accepts fields it does not list. */
export const OUTPUT_SCHEMAS: Record<string, z.ZodType> = Object.fromEntries(Object.entries(SHAPES).map(([name, shape]) => [name, z.looseObject(shape)]));
