import { bindingBrand, type BogenDoc, type BrandData } from '@bogen/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { checkStatic, layersIn, type BrandViolation } from '../brand-check.ts';
import type { Room } from '../sync.ts';
import { isToolResult, type ToolContext } from './kit.ts';

const MAX_WARNINGS = 8;
/** Tools that change the brand or what a brand applies to, rather than a design inside a linked file. */
const NOT_CHECKED = /^(design_knowledge_update$|reference_|brand_|file_|page_|comment_|guide_|agent_undo|proposal_|wait_for_event)/;

export interface BrandGuard {
  room: Room;
  data: BrandData;
  /** What already breaks the brand. Only what is new counts against this write. */
  baseline: Set<string> | null;
  undoBefore: number;
  redoBefore: number;
}

function keyOf(v: BrandViolation): string {
  return `${v.node_id}|${v.rule}|${v.message}`;
}

/** Looks at a linked file before a write. Costs almost nothing without strict mode. */
export async function brandGuard(ctx: ToolContext, tool: string, args: { file_id?: string }): Promise<BrandGuard | null> {
  if (NOT_CHECKED.test(tool)) return null;
  const fileId = args.file_id ?? ctx.session.fileId;
  if (!fileId || !ctx.app.storage.get(fileId)) return null;
  const room = ctx.app.rooms.peek(fileId) ?? await ctx.app.rooms.get(fileId).catch(() => null);
  if (!room) return null;
  const found = await ctx.app.brands.forRoom(room);
  if (!found?.data) return null;
  // Strict mode an agent proposed is not on until a person confirms it.
  const data = bindingBrand(found.data);
  const strict = data.fields.strict;
  const depth = room.undoDepth(ctx.agent);
  return {
    room, data, undoBefore: depth.undo, redoBefore: depth.redo,
    baseline: strict ? new Set(checkStatic(room.doc, data, layersIn(room.doc, { file: true }), true).violations.filter((v) => v.severity === 'hard').map(keyOf)) : null,
  };
}

/**
 * In strict mode, why `doc` (the file itself after a write, or a copy of it with planned changes) may not stand: the
 * hard violations it adds to what already broke the brand. Null when it may.
 */
export function strictRefusal(guard: BrandGuard, doc: BogenDoc): string | null {
  if (!guard.baseline) return null;
  const now = checkStatic(doc, guard.data, layersIn(doc, { file: true }), true).violations.filter((v) => v.severity === 'hard');
  const added = now.filter((v) => !guard.baseline!.has(keyOf(v)));
  if (!added.length) return null;
  return `Nothing was changed. The brand "${guard.data.fields.name}" is in strict mode, and this write would add ${added.length} hard violation${added.length === 1 ? '' : 's'}:\n${added.slice(0, MAX_WARNINGS).map((v) => `- ${v.message} Fix: ${v.fix.description}`).join('\n')}\nChange what you write and try again.`;
}

function addToResult(out: unknown, key: string, value: unknown): typeof out {
  if (typeof out === 'string') return `${out}\n\n${key}: ${JSON.stringify(value)}`;
  if (isToolResult(out as never)) {
    const result = out as CallToolResult;
    return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ [key]: value }) }] };
  }
  if (out && typeof out === 'object') return { ...out, [key]: value };
  return out;
}

/** After a write: the cheap checks on what was touched, and in strict mode, taking it back if it broke a hard rule. */
export async function brandAfterWrite<T>(ctx: ToolContext, tool: string, guard: BrandGuard | null, out: T): Promise<T> {
  if (!guard || !ctx.wrote) return out;
  const { room, data } = guard;
  const { doc } = room;

  const refused = strictRefusal(guard, doc);
  if (refused) {
    rollBack(ctx, guard);
    throw new Error(refused);
  }

  const ids = ctx.nodeIds ?? [];
  const nodes = ids.flatMap((id) => {
    const node = doc.getNode(id);
    return node ? [node, ...doc.descendants(id)] : [];
  });
  const fileLevel = tool === 'tokens_set' || tool === 'tokens_delete' || tool === 'tokens_rename' || tool === 'tokens_from_css';
  if (!nodes.length && !fileLevel) return out;
  const report = checkStatic(doc, data, nodes, fileLevel);
  if (!report.violations.length) return out;
  const shown = [...report.violations].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1)).slice(0, MAX_WARNINGS);
  return addToResult(out, 'brand_warnings', {
    brand: data.fields.name, hard: report.counts.hard, soft: report.counts.soft,
    shown: shown.map((v) => `${v.severity}: ${v.message} Fix: ${v.fix.description}${v.node_id ? ` (${v.node_id})` : ''}`),
    ...(report.violations.length > shown.length ? { more: report.violations.length - shown.length } : {}),
  }) as T;
}

/** A Yjs transaction cannot be aborted, so a refused write is undone, and leaves no redo step to bring it back. */
function rollBack(ctx: ToolContext, guard: BrandGuard): void {
  const manager = guard.room.undoManagerFor(ctx.agent);
  while (manager.undoStack.length > guard.undoBefore) manager.undo();
  while (manager.redoStack.length > guard.redoBefore) manager.redoStack.pop();
  ctx.wrote = false;
  ctx.nodeIds = undefined;
}
