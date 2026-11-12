import {
  applyResponsive, CONDITION_OPS, deleteVariable, getVariables, PROTO_ACTION_TYPES, PROTO_TRIGGERS, protoModel, protoScreens, readProtoState, setVariable,
  type BogenDoc, type LayerProto, type ProtoState,
} from '@bogen/core';
import { z } from 'zod';
import { checkWidths } from '../width-check.ts';
import { fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';

const value = z.union([z.boolean(), z.number(), z.string().max(2000)]);
const variableName = z.string().regex(/^[a-zA-Z_][\w-]{0,63}$/);
const condition = z.object({
  variable: variableName,
  op: z.enum(CONDITION_OPS as [string, ...string[]]).describe('is and not compare with value, or test true and false without it; gt, lt, gte, lte compare numbers; contains, empty and filled test text.'),
  value: value.optional(),
});
const action = z.object({
  type: z.enum(PROTO_ACTION_TYPES as [string, ...string[]]).describe('set a variable to value, toggle a boolean, increment a number by by (negative counts down), show, hide or toggle-visibility of target, set-variant of the instance target to value, navigate to an artboard with a transition, or back.'),
  variable: variableName.optional(),
  value: value.optional(),
  by: z.number().optional(),
  target: z.string().max(200).optional().describe('A layer id, for show, hide, toggle-visibility and set-variant.'),
  to: z.string().max(200).optional().describe('An artboard id, for navigate.'),
  transition: z.enum(['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down']).optional(),
  duration: z.number().min(0).max(5000).optional(),
});
const interaction = z.object({ trigger: z.enum(PROTO_TRIGGERS as [string, ...string[]]).describe('click, hover (undone when the pointer leaves) or submit (on a form).'), actions: z.array(action).min(1).max(20) });

const MAX_CHECK_SHOTS = 800;

/** What is wrong with a layer's prototype: variables, layers and artboards it names that are not there. */
function problems(doc: BogenDoc, id: string, state: ProtoState): string[] {
  const vars = new Map(getVariables(doc).map((v) => [v.name, v]));
  const screens = new Set(protoScreens(doc));
  const out: string[] = [];
  const needVar = (name: string | undefined, what: string) => { if (name && !vars.has(name)) out.push(`${what} uses ${name}, which is not a variable yet. Make it with variable_set.`); };
  for (const i of state.interactions ?? []) {
    for (const a of i.actions) {
      if ('variable' in a) needVar(a.variable, `On ${i.trigger}, ${a.type}`);
      if (a.type === 'toggle' && vars.get(a.variable)?.type === 'text') out.push(`toggle of ${a.variable}, a text, switches between empty and "on".`);
      if (a.type === 'increment' && vars.has(a.variable) && vars.get(a.variable)!.type !== 'number') out.push(`increment needs a number, and ${a.variable} is a ${vars.get(a.variable)!.type}.`);
      if ('target' in a && !doc.getNode(a.target)) out.push(`${a.type} names ${a.target}, which is no layer.`);
      if (a.type === 'set-variant' && doc.getNode(a.target)?.instanceOf === undefined) out.push(`set-variant needs an instance of a component with variants, and ${a.target} is not one.`);
      if (a.type === 'navigate' && !screens.has(a.to)) out.push(`navigate goes to ${a.to}, which is no artboard.`);
    }
    if (i.trigger === 'submit' && doc.getNode(id)?.tag !== 'form') out.push('submit happens on a form layer: put this on the form.');
  }
  needVar(state.showWhen?.variable, 'show_when');
  needVar(state.variantFrom?.variable, 'variant_from');
  needVar(state.bind, 'bind');
  needVar(state.textFrom, 'text_from');
  const node = doc.getNode(id);
  if (state.bind && node && !/^(input|textarea|select)$/.test(node.tag)) out.push(`bind works on input, textarea and select, and this layer is a ${node.tag}.`);
  if (state.variantFrom && node?.instanceOf === undefined) out.push('variant_from needs an instance of a component with variants.');
  return out;
}

function summary(doc: BogenDoc, id: string): Record<string, unknown> {
  const n = doc.getNode(id);
  const state = readProtoState(n?.proto);
  return {
    id, name: n?.name ?? '',
    ...(n?.proto?.link ? { link: n.proto.link } : {}),
    ...state,
  };
}

export function registerPrototypeTools(define: ToolDefiner): void {
  define('responsive_variant', { description: 'Make the narrower versions of an artboard, such as 768 and 390 from a 1440 design, then check them. method rules (default, best for code) writes @media (max-width) blocks on the same layers, so the page adapts in the browser and in code_get. method artboards makes linked artboards next to it instead, which calling this again rebuilds from the source after you change it. What it derives: flex rows wrap or stack, grids lose columns, type steps down the type scale (the brand\'s or the file\'s font-size tokens), padding and gap step down the spacing tokens, images keep their aspect ratio, fixed widths give way, and a navigation row folds into a menu button on a phone. Then it lays each width out as responsive_check does and reports what still sticks out or is cut off: refine that with layer_style and when. One undo step; running it again replaces its own blocks.' }, {
    node_id: z.string().describe('The artboard to start from. It needs a fixed width.'),
    widths: z.array(z.number().int().min(200).max(3000)).min(1).max(4).default([768, 390]),
    method: z.enum(['rules', 'artboards']).default('rules'),
    check: z.boolean().default(true).describe('Lay out each width afterwards and report what overflows.'),
    file_id: fileIdArg,
  }, async ({ node_id, widths, method, check, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    if (!doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
    const result = ctx.write(room, () => applyResponsive(doc, node_id, { widths, method }));
    ctx.touch([node_id, ...(method === 'artboards' ? result.artboards.map((a) => a.id) : [])]);
    const out: Record<string, unknown> = {
      method,
      widths: result.steps.map((s) => ({ width: s.width, ...(method === 'rules' ? { when: `@media ${s.query}` } : {}) })),
      ...(method === 'artboards' ? { artboards: result.artboards } : {}),
      layers_changed: result.layers,
      ...(result.menuButtons.length ? { menu_buttons: result.menuButtons } : {}),
      ...(result.notes.length ? { notes: result.notes } : {}),
    };
    if (check) {
      const reports = method === 'rules'
        ? (await checkWidths(doc, ctx.app.renderer, node_id, result.steps.map((s) => s.width), { maxDimension: MAX_CHECK_SHOTS })).report.widths
        : await Promise.all(result.artboards.map(async (a) => ({ ...(await checkWidths(doc, ctx.app.renderer, a.id, [a.width], { maxDimension: MAX_CHECK_SHOTS })).report.widths[0]!, artboard: a.id })));
      out.ok = reports.every((r) => r.ok);
      out.check = reports;
      if (!out.ok) out.next = 'Fix what still overflows with layer_style and when (the @media blocks above), or on the linked artboard, then call responsive_check.';
    }
    return out;
  });

  define('variable_set', { description: 'Create, change, rename or delete a prototype variable of the file: a boolean, number or text that preview mode and a prototype export start from, and that interactions set (interaction_set). Its value is its starting value.' }, {
    name: variableName,
    type: z.enum(['boolean', 'number', 'text']).optional().describe('Needed for a new variable unless value says it.'),
    value: value.optional(),
    description: z.string().max(300).optional(),
    rename: variableName.optional(),
    delete: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ name, type, value: v, description, rename, delete: remove, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    if (remove) {
      if (!getVariables(room.doc).some((x) => x.name === name)) throw new Error(`There is no variable ${name}, so there is nothing to delete. Variables: ${getVariables(room.doc).map((x) => x.name).join(', ') || 'none'}.`);
      ctx.write(room, () => deleteVariable(room.doc, name));
      return { deleted: name, variables: getVariables(room.doc) };
    }
    const out = ctx.write(room, () => setVariable(room.doc, { name, ...(type ? { type } : {}), ...(v !== undefined ? { value: v } : {}), ...(description !== undefined ? { description } : {}), ...(rename ? { rename } : {}) }));
    return { variable: out, variables: getVariables(room.doc) };
  });

  define('interaction_set', { description: 'Make a layer of a prototype do something in preview mode and in a prototype export (export_file format prototype). interactions: on click, hover or submit, a list of actions: set, toggle or increment a variable, show, hide or toggle-visibility of a layer, set-variant of an instance, navigate to an artboard, back. show_when: the layer shows only while a variable holds a condition. variant_from: an instance takes the variant a text variable names. bind: an input, textarea or select reads and writes a variable. text_from: a text layer shows a variable\'s value. Each field you pass replaces what was there, and null removes it. Variables come from variable_set.' }, {
    node_id: z.string(),
    interactions: z.array(interaction).max(8).nullable().optional(),
    show_when: condition.nullable().optional(),
    variant_from: z.object({ prop: z.string().max(100).describe('The variant axis, such as billing.'), variable: variableName }).nullable().optional(),
    bind: variableName.nullable().optional(),
    text_from: variableName.nullable().optional(),
    file_id: fileIdArg,
  }, async (args, ctx) => {
    const room = await ctx.room(args.file_id);
    const { doc } = room;
    const node = doc.getNode(args.node_id);
    if (!node) throw new Error(`No layer with id ${args.node_id}.`);
    if (args.node_id.includes('/')) throw new Error('A layer inside an instance does what its main does: set the interaction on the main, or on the instance itself.');
    const next: LayerProto & Record<string, unknown> = { ...(node.proto ?? {}) };
    const fields: [keyof typeof args, string][] = [['interactions', 'interactions'], ['show_when', 'showWhen'], ['variant_from', 'variantFrom'], ['bind', 'bind'], ['text_from', 'textFrom']];
    for (const [arg, field] of fields) {
      const given = args[arg];
      if (given === undefined) continue;
      if (given === null) delete next[field];
      else next[field] = given;
    }
    // Only what passes the same checks the export uses is stored.
    const clean: LayerProto = { ...(next.link ? { link: next.link, ...(next.transition ? { transition: next.transition } : {}) } : {}), ...(next.duration !== undefined ? { duration: next.duration } : {}), ...(next.hover ? { hover: next.hover } : {}), ...readProtoState(next) };
    const dropped = (args.interactions ?? []).reduce((n, i) => n + i.actions.length, 0) - (clean.interactions ?? []).reduce((n, i) => n + i.actions.length, 0);
    ctx.write(room, () => doc.updateFields(args.node_id, { proto: Object.keys(clean).length ? clean : undefined }));
    ctx.touch([args.node_id]);
    const warnings = [...problems(doc, args.node_id, readProtoState(clean)), ...(dropped > 0 && args.interactions ? [`${dropped} action${dropped === 1 ? ' was' : 's were'} left out: each needs its variable, target or to.`] : [])];
    return { ...summary(doc, args.node_id), ...(warnings.length ? { warnings } : {}) };
  });

  define('prototype_get', { description: 'The prototype of a page: its variables with their starting values, the artboards in the order preview mode shows them, and every layer that does something, with what is wrong with it. Read it before you change a prototype.', readOnly: true }, {
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    const page = ctx.page(room, page_id);
    const screens = doc.getChildren(page).filter((n) => n.artboard || n.type === 'frame').map((n) => n.id);
    const model = protoModel(doc, protoScreens(doc));
    const layers: Record<string, unknown>[] = [];
    const visit = (id: string) => {
      const n = doc.getNode(id);
      if (!n) return;
      if (n.proto) {
        const state = readProtoState(n.proto);
        const issues = problems(doc, id, state);
        layers.push({ ...summary(doc, id), ...(issues.length ? { problems: issues } : {}) });
      }
      for (const c of doc.getChildren(id)) visit(c.id);
    };
    screens.forEach(visit);
    return {
      variables: getVariables(doc),
      screens: screens.map((id) => ({ id, name: doc.getNode(id)?.name ?? '' })),
      start: model.start,
      layers,
      ...(layers.length ? {} : { hint: 'Nothing here does anything yet. Add variables with variable_set and interactions with interaction_set.' }),
    };
  });
}
