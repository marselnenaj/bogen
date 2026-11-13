import { BogenDoc, Y } from '@bogen/core';
import { z } from 'zod';
import type { BogenServer } from '../http/server.ts';
import { agentOrigin, type Room } from '../sync.ts';
import { errorMessage } from '../util.ts';
import { fileIdArg, isToolResult, ToolContext, type Session, type ToolDefiner } from './kit.ts';

const BATCHABLE = [
  'artboard_create', 'html_write', 'layer_style', 'layer_text', 'layer_rename', 'layer_move', 'layer_duplicate', 'layer_delete', 'layer_set_flags', 'layer_attrs',
  'layers_group', 'layers_ungroup', 'layer_wrap', 'layers_align', 'layers_distribute', 'tokens_set', 'tokens_delete', 'tokens_rename', 'keyframes_set', 'variable_set', 'interaction_set', 'page_create', 'page_rename', 'page_reorder', 'layer_repeat', 'layer_bind', 'data_source_set', 'data_source_refresh', 'data_source_delete',
  'component_create', 'component_update', 'instance_create', 'instance_set', 'instance_detach', 'mode_create', 'mode_set', 'text_style_set', 'text_style_apply', 'icon_insert', 'image_crop', 'image_filter', 'layout_grid_set', 'text_replace', 'layers_rename',
];

/** The path starts with a letter, so that text such as "$9.99" stays text. */
const REF = /^\$(\w+)\.([a-zA-Z_]\w*(?:\.\w+)*)$/;

/** A step's context: the same tools, but working on a copy of the file that nobody can see. script_run uses it too. */
export class ScratchContext extends ToolContext {
  override readonly dryRun: boolean;

  constructor(app: BogenServer, session: Session, tool: string, private readonly scratch: Room, dryRun: boolean, signal?: AbortSignal) {
    super(app, session, tool, signal);
    this.dryRun = dryRun;
  }

  override async room(fileId?: string): Promise<Room> {
    if (fileId && fileId !== this.scratch.id) throw new Error('A batch works on one file. Leave out file_id in its steps.');
    return this.scratch;
  }

  override write<T>(room: Room, fn: () => T): T {
    this.wrote = true;
    return room.doc.transact(fn, agentOrigin(this.agent));
  }

  override finish(): void {}
}

/** Replaces strings such as `$hero.id` with values from earlier steps. Only whole strings count, so text stays text. */
function resolveRefs(value: unknown, results: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    const match = REF.exec(value);
    if (!match) return value;
    let cur: unknown = results.get(match[1]!);
    if (cur === undefined) throw new Error(`${value} refers to a step that has not run. Name a step with "as", or use its number from 0.`);
    for (const key of match[2]!.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[key];
    if (cur === undefined) {
      const top = results.get(match[1]!);
      const keys = top && typeof top === 'object' ? Object.keys(top).slice(0, 20).join(', ') : '';
      throw new Error(`${value} is not in that step's result.${keys ? ` Its result has: ${keys}.` : ' That step returns text, not fields.'} Run the batch with dry_run true to see each step's result.`);
    }
    return cur;
  }
  if (Array.isArray(value)) return value.flatMap((v) => {
    const out = resolveRefs(v, results);
    // `$grid.ids` inside a list of ids adds them all.
    return Array.isArray(out) && typeof v === 'string' ? out : [out];
  });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  return value;
}

/**
 * A private copy of a file to run write tools on. A Yjs transaction cannot be rolled back, so what reaches the file is
 * the copy's difference from `before`, as one transaction, and only once everything has passed. Destroy `y` after.
 */
export function scratchCopy(room: Room): { y: Y.Doc; before: Uint8Array; room: Room } {
  const y = new Y.Doc({ gc: false });
  Y.applyUpdate(y, Y.encodeStateAsUpdate(room.doc.y));
  const before = Y.encodeStateVector(y);
  return { y, before, room: Object.create(room, { doc: { value: new BogenDoc(y) } }) as Room };
}

export function registerBatchTool(define: ToolDefiner, app: BogenServer, session: Session): void {
  define('batch', { description: `Run several write tools as one atomic step: all of them or none, and one agent_undo takes back the whole batch. Use it for changes that belong together, such as new tokens and the section using them, or a group and its alignment. If a step fails, nothing is applied and the error names the step. With dry_run true nothing is applied either, and you get what each step would have returned, which is the way to check a risky change first; images are not fetched or generated in a dry run.

Steps run in order, and each sees what the ones before it did. Refer to an earlier result with a string such as "$0.id", "$0.ids.0", or "$hero.id" for a step with "as": "hero".

Allowed tools: ${BATCHABLE.join(', ')}. For one change, just call the tool. Keep drawing in small visible chunks rather than sending a page as one batch.` }, {
    steps: z.array(z.object({
      tool: z.string().describe('A tool name from the list above.'),
      args: z.record(z.string(), z.unknown()).default({}).describe('The arguments of that tool.'),
      as: z.string().regex(/^\w+$/).optional().describe('A name for later steps to refer to this result.'),
    })).min(1).max(100),
    dry_run: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ steps, dry_run, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    for (const [i, step] of steps.entries()) {
      if (!BATCHABLE.includes(step.tool)) throw new Error(`Step ${i}: ${step.tool} cannot be part of a batch. Allowed: ${BATCHABLE.join(', ')}.`);
    }
    // The steps run on a private copy; the file gets its difference once every step has passed.
    const { y: scratchY, before, room: scratch } = scratchCopy(room);
    const results = new Map<string, unknown>();
    const report: { step: number; tool: string; result: unknown }[] = [];
    const touched: string[] = [];
    let canvasOnly = true;
    try {
      for (const [i, step] of steps.entries()) {
        const stepCtx = new ScratchContext(app, session, step.tool, scratch, dry_run, ctx.signal);
        try {
          const entry = define.tools.get(step.tool)!;
          const args = z.object(entry.shape).parse(resolveRefs(step.args, results));
          const out = await entry.handler(args as never, stepCtx);
          const value = isToolResult(out) ? null : out;
          results.set(String(i), value);
          if (step.as) results.set(step.as, value);
          report.push({ step: i, tool: step.tool, result: value });
          if (stepCtx.wrote && !stepCtx.canvasOnly) canvasOnly = false;
          touched.push(...(stepCtx.nodeIds ?? []));
          if (stepCtx.pageId) ctx.pageId = stepCtx.pageId;
        } catch (e) {
          const message = `Step ${i} (${step.tool}) failed, so nothing was applied: ${e instanceof z.ZodError ? e.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : errorMessage(e)}`;
          if (!dry_run) throw new Error(message);
          return { ok: false, dry_run: true, applied: false, failed_step: i, error: message, steps: report };
        }
      }
      if (dry_run) return { ok: true, dry_run: true, applied: false, steps: report };
      const update = Y.encodeStateAsUpdate(scratchY, before);
      room.undoManagerFor(ctx.agent);
      ctx.wrote = true;
      ctx.canvasOnly = canvasOnly;
      Y.applyUpdate(room.doc.y, update, agentOrigin(ctx.agent));
      ctx.touch(touched.filter((id) => room.doc.getNode(id)));
      return { ok: true, applied: true, steps: report };
    } finally {
      scratchY.destroy();
    }
  });
}
