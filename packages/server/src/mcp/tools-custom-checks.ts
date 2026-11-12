import { BUILTIN_CHECKS, deleteCheck, getChecks, setCheck } from '@bogen/core';
import { z } from 'zod';
import { runSavedChecks } from '../custom-checks.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

const Rule = z.object({
  id: z.string(), kind: z.enum(['style', 'attribute', 'geometry', 'count']), selector: z.string(), property: z.string().optional(),
  operator: z.enum(['equals', 'not-equals', 'min', 'max', 'present', 'absent']), value: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(), severity: z.enum(['warning', 'error']).optional(), enabled: z.boolean().optional(),
}).strict();
const Definition = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(), extends: z.string().optional(), enabled: z.boolean().optional(),
  lint: z.boolean().optional(), a11y: z.boolean().optional(), responsive: z.boolean().optional(), widths: z.array(z.number()).optional(), viewport_heights: z.array(z.number()).optional(),
  tolerance: z.number().optional(), rules: z.array(Rule).optional(),
}).strict();
export function registerCustomCheckTools(define: ToolDefiner): void {
  define('check_list', { description: 'List this file\'s saved, user-defined checks and the built-in checks they can extend. Definitions travel with the file, including sync, undo, versions and design-folder export. Read guide_get checks for examples.', readOnly: true }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return { builtins: BUILTIN_CHECKS, checks: getChecks(doc) };
  });
  define('check_set', { description: 'Create or replace a saved check in the file as one undo step. Extend a built-in or another saved check using extends. Inherited rules are overridden by their id; enabled false disables a rule or check. Rules assert rendered CSS values, attributes, element counts or geometry using CSS selectors scoped to the target. Style equality uses computed CSS syntax; min/max use numbers. Profiles may combine design lint, responsive widths and viewport_heights with a pixel tolerance. No JavaScript is executed. The editor offers the same definitions in Design checks.', }, { definition: Definition, file_id: fileIdArg }, async ({ definition, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    return ctx.write(room, () => setCheck(room.doc, definition));
  });
  define('check_delete', { description: 'Delete a saved check as one undo step. Built-ins cannot be removed. A check that another check extends must be unlinked first.', destructive: true }, { check_id: z.string(), file_id: fileIdArg }, async ({ check_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    ctx.write(room, () => deleteCheck(room.doc, check_id));
    return { deleted: check_id };
  });
  define('check_run', { description: 'Run saved checks on an artboard or frame without changing the design. Omit check_ids to run enabled saved checks; supply built-in ids from check_list to run those directly. Returns measured findings with layer ids, actual and expected values, widths and severity. Height changes are findings to review, while preserving intentional scroll effects. At most eight checks per call.', readOnly: true }, { node_id: z.string(), check_ids: z.array(z.string()).min(1).max(8).optional(), file_id: fileIdArg }, async ({ node_id, check_ids, file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    const report = await runSavedChecks(doc, ctx.app.renderer, node_id, check_ids);
    ctx.touch([node_id]);
    return report;
  });
}
