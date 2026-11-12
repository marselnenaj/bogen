import { BogenDoc, newId, Y } from '@bogen/core';
import type { Renderer } from './render.ts';
import type { Room } from './sync.ts';

/** One field of one layer, before and after a step. */
export interface FieldChange { field: string; before?: unknown; after?: unknown }
export interface LayerChange { nodeId: string; name: string; kind: 'added' | 'removed' | 'changed'; fields: FieldChange[] }

/** One write of one agent: a tool call or a batch, and the entry on that agent's undo stack. */
export interface AgentStep {
  id: string;
  agent: string;
  tool: string;
  at: number;
  runId?: string;
  pageId?: string;
  changes: LayerChange[];
  undone: boolean;
}

interface Kept { step: AgentStep; item: unknown }

const MAX_STEPS = 200;
const VALUE_LIMIT = 300;
const CHANGES_LIMIT = 100;
const SKIPPED_FIELDS = new Set(['order']);

function shortValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > VALUE_LIMIT) return `${value.slice(0, VALUE_LIMIT)}...`;
  if (value instanceof Y.AbstractType) return undefined;
  if (value && typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > VALUE_LIMIT ? `${json.slice(0, VALUE_LIMIT)}...` : value;
  }
  return value;
}

/**
 * What each agent changed, per step, while its file is loaded. Observed from the transactions, so every way of
 * writing is covered, and what is kept is enough to show before and after, and to undo one step out of order.
 */
export class AgentSteps {
  private perRoom = new Map<string, { kept: Kept[]; pending: Map<string, LayerChange[]>; names: Map<string, string> }>();

  watch(room: Room): void {
    const state = { kept: [] as Kept[], pending: new Map<string, LayerChange[]>(), names: new Map<string, string>() };
    this.perRoom.set(room.id, state);
    const { doc } = room;
    doc.nodes.forEach((m, id) => state.names.set(id, String(m.get('name') ?? '')));
    const onNodes = (events: Y.YEvent<any>[], tx: Y.Transaction) => {
      const origin = tx.origin;
      const agent = typeof origin === 'string' && origin.startsWith('agent:') ? origin.slice(6) : null;
      const out = new Map<string, LayerChange>();
      const touch = (id: string, kind: LayerChange['kind']): LayerChange => {
        let change = out.get(id);
        if (!change) {
          change = { nodeId: id, name: state.names.get(id) ?? String(doc.nodes.get(id)?.get('name') ?? ''), kind, fields: [] };
          out.set(id, change);
        }
        return change;
      };
      for (const event of events) {
        if (event.path.length === 0) {
          for (const [id, { action }] of event.changes.keys) {
            if (action === 'add') touch(id, 'added').kind = 'added';
            else if (action === 'delete') touch(id, 'removed').kind = 'removed';
          }
          continue;
        }
        const id = String(event.path[0]);
        const prefix = event.path.length > 1 ? `${event.path.slice(1).join('.')}.` : '';
        const change = touch(id, 'changed');
        if (change.kind !== 'changed') continue;
        const target = event.target as Y.Map<unknown>;
        for (const [key, { oldValue }] of event.changes.keys) {
          if (!prefix && SKIPPED_FIELDS.has(key)) continue;
          change.fields.push({ field: `${prefix}${key}`, before: shortValue(oldValue), after: shortValue(target.get(key)) });
        }
      }
      for (const [id, m] of [...out.keys()].map((nodeId) => [nodeId, doc.nodes.get(nodeId)] as const)) {
        if (m) state.names.set(id, String(m.get('name') ?? ''));
        else state.names.delete(id);
      }
      if (agent) state.pending.set(agent, [...out.values()].filter((c) => c.kind !== 'changed' || c.fields.length).slice(0, CHANGES_LIMIT));
    };
    doc.nodes.observeDeep(onNodes);
    room.cleanups.push(() => {
      doc.nodes.unobserveDeep(onNodes);
      this.perRoom.delete(room.id);
    });
  }

  /** Each undo manager makes stack items. Those are the steps, and what undo works on. */
  manage(room: Room, agent: string, manager: Y.UndoManager): void {
    const state = this.perRoom.get(room.id);
    if (!state) return;
    const steps = new WeakMap<object, AgentStep>();
    let added: object | null = null;
    manager.on('stack-item-added', (e: { stackItem: object; type: string; origin: unknown }) => {
      added = e.stackItem;
      if (e.type !== 'undo' || e.origin === manager) return;
      const presence = room.agents.get(agent);
      const changes = state.pending.get(agent) ?? [];
      state.pending.delete(agent);
      const first = changes.find((c) => c.kind !== 'removed')?.nodeId;
      const page = first ? room.doc.pageOf(first) : presence?.pageId;
      const step: AgentStep = { id: newId(), agent, tool: presence?.lastTool ?? 'edit', at: Date.now(), ...(presence?.runId ? { runId: presence.runId } : {}), ...(page ? { pageId: page } : {}), changes, undone: false };
      steps.set(e.stackItem, step);
      state.kept.unshift({ step, item: e.stackItem });
      if (state.kept.length > MAX_STEPS) state.kept.length = MAX_STEPS;
    });
    manager.on('stack-item-popped', (e: { stackItem: object; type: string }) => {
      const step = steps.get(e.stackItem);
      if (!step) return;
      step.undone = e.type === 'undo';
      if (added) {
        // The same step is now on the other stack, as a new item.
        steps.set(added, step);
        const kept = state.kept.find((k) => k.step === step);
        if (kept) kept.item = added;
      }
    });
  }

  list(fileId: string): AgentStep[] {
    return this.perRoom.get(fileId)?.kept.map((k) => k.step) ?? [];
  }

  get(fileId: string, stepId: string): AgentStep | undefined {
    return this.perRoom.get(fileId)?.kept.find((k) => k.step.id === stepId)?.step;
  }

  /**
   * Takes back one step, also one that is not the latest. Only that step's own changes go, and a value someone
   * changed since stays as they left it. False when there is nothing left of the step to take back.
   */
  undo(room: Room, stepId: string): boolean {
    const kept = this.perRoom.get(room.id)?.kept.find((k) => k.step.id === stepId);
    if (!kept || kept.step.undone) return false;
    const manager = room.undoManagerFor(kept.step.agent);
    const stack = manager.undoStack as unknown[];
    if (!stack.includes(kept.item)) return false;
    manager.undoStack = [kept.item] as typeof manager.undoStack;
    let changed = false;
    try {
      changed = manager.undo() !== null;
    } finally {
      manager.undoStack = stack.filter((item) => item !== kept.item) as typeof manager.undoStack;
    }
    kept.step.undone = true;
    return changed;
  }

  /** The layer as it was right before, or right after, this step, with everything else as it is now. */
  async preview(room: Room, step: AgentStep, which: 'before' | 'after', renderer: Renderer): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const probe = new BogenDoc(new Y.Doc());
    try {
      Y.applyUpdate(probe.y, Y.encodeStateAsUpdate(room.doc.y));
      const targets: string[] = [];
      for (const change of step.changes) {
        if (change.kind === 'added') {
          if (which === 'before') probe.delete([change.nodeId]);
          else targets.push(change.nodeId);
          continue;
        }
        if (change.kind === 'removed') continue;
        if (!probe.nodes.has(change.nodeId)) continue;
        targets.push(change.nodeId);
        const m = probe.nodes.get(change.nodeId)!;
        const style = m.get('style') as Y.Map<string>;
        for (const f of change.fields) {
          const value = which === 'before' ? f.before : f.after;
          const inStyle = f.field.startsWith('style.');
          const key = inStyle ? f.field.slice(6) : f.field;
          // A value too long to keep cannot be put back, so that one stays as it is now.
          if (typeof value === 'string' && value.endsWith('...')) continue;
          if (key === 'parent' && !probe.pages.has(String(value)) && !probe.nodes.has(String(value))) continue;
          const holder = inStyle ? style : m;
          if (value === undefined) holder.delete(key);
          else (holder as Y.Map<unknown>).set(key, value);
        }
      }
      // Only the outermost layers: a child is already in its parent's picture.
      const ids = targets.filter((id, i) => targets.indexOf(id) === i && probe.nodes.has(id) && !probe.ancestors(id).some((a) => targets.includes(a)));
      if (!ids.length) return null;
      const shot = await renderer.screenshot(probe, { nodeIds: ids.slice(0, 8) }, { format: 'png', maxDimension: 640, scale: 1 });
      return { bytes: shot.bytes, mime: shot.mime };
    } finally {
      probe.y.destroy();
    }
  }

  forget(fileId: string): void {
    this.perRoom.delete(fileId);
  }
}
