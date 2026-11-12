import { applyCanvasPlan, prepareCanvasPlan, readCanvasPlan } from '@bogen/core';
import { z } from 'zod';
import { assertUnlocked, fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';

export function registerCanvasPlanTools(define: ToolDefiner): void {
  define('canvas_plan_get', { description: 'Read a page’s canvas plan, revision tokens and unassigned screens. Sections and lanes are editing annotations, not exported layers. Read before creating several screens or changing the plan; guide_get layout explains the workflow', readOnly: true }, {
    file_id: fileIdArg, page_id: pageIdArg,
  }, async ({ file_id, page_id }, ctx) => {
    const room = await ctx.room(file_id); const page = ctx.page(room, page_id); const plan = readCanvasPlan(room.doc, page);
    const grouped = new Set(plan.sections.flatMap(s => s.lanes.flatMap(l => l.node_ids)));
    return { page_id: page, ...plan, unassigned: room.doc.getChildren(page).filter(n => n.artboard && !n.hidden && !grouped.has(n.id)).map(n => ({ id: n.id, name: n.name, width: n.style.width, height: n.style.height })) };
  });
  define('canvas_plan_set', { description: 'Arrange named task sections and ordered state/variant lanes in one undoable step. Read canvas_plan_get and send its revision tokens; inspect dry_run before applying. Moves only named screens, preserving ids and other content. Supply measured sizes for hugging screens. Connections annotate actual flows without creating prototype behavior. Preserve unrelated organization; see guide_get layout', }, {
    file_id: fileIdArg, page_id: pageIdArg,
    expected_revision: z.number().int().min(0), expected_revision_id: z.string().max(100).optional().describe('Send the current revision_id from canvas_plan_get when updating an existing plan, including after a conflict.'),
    sections: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: z.string().min(1).max(120), purpose: z.string().min(1).max(500), lanes: z.array(z.object({ title: z.string().min(1).max(120), node_ids: z.array(z.string()).max(100) })).min(1).max(20) })).max(50),
    connections: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().min(1).max(120) })).max(200).default([]),
    sizes: z.array(z.object({ node_id: z.string(), width: z.number().positive().max(100000), height: z.number().positive().max(100000) })).max(1000).optional(),
    columns: z.number().int().min(1).max(6).default(3), max_row_width: z.number().min(400).max(30000).default(4800),
    x: z.number().min(-1000000).max(1000000).optional(), y: z.number().min(-1000000).max(1000000).optional(),
    dry_run: z.boolean().default(false),
  }, async ({ file_id, page_id, dry_run, ...input }, ctx) => {
    const room = await ctx.room(file_id); const page = ctx.page(room, page_id);
    const prepared = prepareCanvasPlan(room.doc, page, input);
    assertUnlocked(room.doc, prepared.placements.map(p => p.id));
    if (!dry_run) { ctx.canvasOnly = true; ctx.write(room, () => applyCanvasPlan(room.doc, page, prepared)); ctx.touch(prepared.placements.map(p => p.id)); }
    const assigned = new Set(prepared.placements.map(p => p.id));
    return { page_id: page, applied: !dry_run, revision: prepared.plan.revision, revision_id: prepared.plan.revision_id, sections: prepared.plan.sections, connections: prepared.plan.connections, placements: prepared.placements, bounds: prepared.bounds, unassigned: room.doc.getChildren(page).filter(n => n.artboard && !n.hidden && !assigned.has(n.id)).map(n => ({ id: n.id, name: n.name })) };
  });
}
