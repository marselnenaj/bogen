import { newId, type BogenDoc } from './doc.ts';

export interface CanvasLane { title: string; node_ids: string[] }
export interface CanvasSection { id: string; title: string; purpose: string; lanes: CanvasLane[] }
export interface CanvasConnection { from: string; to: string; label: string }
export interface CanvasPlan { version: 1; revision: number; revision_id: string; layout_pending?: boolean; sections: CanvasSection[]; connections: CanvasConnection[] }
export interface CanvasBox { x: number; y: number; w: number; h: number }
export interface CanvasPlacement extends CanvasBox { id: string }
export interface CanvasSize { node_id: string; width: number; height: number }
const key = (page: string) => `canvasPlan:${page}`;
const empty = (): CanvasPlan => ({ version: 1, revision: 0, revision_id: 'empty', sections: [], connections: [] });
const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.trim().length > 0 && s.length <= max;

/** Canvas annotations are document records, not extra artboards or exported design layers. */
export function readCanvasPlan(doc: BogenDoc, page: string): CanvasPlan {
  const raw = doc.meta.get(key(page));
  return validCanvasPlan(raw) ? raw : empty();
}

function validCanvasPlan(raw: unknown): raw is CanvasPlan {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as CanvasPlan;
  if ((p.layout_pending !== undefined && typeof p.layout_pending !== 'boolean') || p.version !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 0 || !text(p.revision_id, 100) || !Array.isArray(p.sections) || p.sections.length > 50 || !Array.isArray(p.connections) || p.connections.length > 200) return false;
  let count = 0;
  const valid = p.sections.every(s => s && text(s.id, 80) && text(s.title, 120) && text(s.purpose, 500) && Array.isArray(s.lanes) && s.lanes.length <= 20 && s.lanes.every(l => l && text(l.title, 120) && Array.isArray(l.node_ids) && l.node_ids.length <= 100 && l.node_ids.every(id => typeof id === 'string' && id.length <= 100 && ++count <= 500)));
  return valid && p.connections.every(c => c && text(c.from, 100) && text(c.to, 100) && text(c.label, 120));
}

const px = (s: string | undefined) => /^\d+(?:\.\d+)?px$/.test(s ?? '') ? Number.parseFloat(s!) : NaN;
function sizeOf(doc: BogenDoc, id: string, sizes: Map<string, CanvasSize>): { w: number; h: number } {
  const n = doc.getNode(id)!; const measured = sizes.get(id);
  const w = measured?.width ?? px(n.style.width); const h = measured?.height ?? px(n.style.height);
  if (![w, h].every(v => Number.isFinite(v) && v > 0 && v <= 100_000)) throw new Error(`Screen "${n.name}" has no finite size. Inspect its actual bounds and provide sizes; do not change a hugging screen to a fixed height just to arrange it.`);
  return { w, h };
}

/** Pure layout preparation: validate the complete request before moving any screen. */
export function prepareCanvasPlan(doc: BogenDoc, page: string, input: {
  sections: CanvasSection[]; connections?: CanvasConnection[]; expected_revision: number; expected_revision_id?: string;
  sizes?: CanvasSize[]; columns?: number; max_row_width?: number; x?: number; y?: number;
}): { plan: CanvasPlan; placements: CanvasPlacement[]; bounds: CanvasBox | null; base_revision_id: string } {
  if (!doc.pages.has(page)) throw new Error('No such page.');
  const current = readCanvasPlan(doc, page);
  if (input.expected_revision !== current.revision || (current.revision > 0 && input.expected_revision_id !== current.revision_id)) throw new Error(`Canvas plan changed (revision ${current.revision}). Read canvas_plan_get and reconcile before applying.`);
  const probe = { version: 1 as const, revision: current.revision + 1, revision_id: newId(), sections: input.sections, connections: input.connections ?? [] };
  if (!validCanvasPlan(probe)) throw new Error('Invalid canvas plan: use named sections with a purpose and named lanes, at most 500 screens and 200 connections.');
  const columns = input.columns ?? 3; const maxWidth = input.max_row_width ?? 4800;
  if (!Number.isInteger(columns) || columns < 1 || columns > 6 || !Number.isFinite(maxWidth) || maxWidth < 400 || maxWidth > 30_000) throw new Error('Use 1–6 columns and a row width between 400 and 30000.');
  const sizes = new Map((input.sizes ?? []).map(s => [s.node_id, s]));
  const assigned = new Set<string>(); const sectionIds = new Set<string>();
  for (const s of input.sections) {
    if (sectionIds.has(s.id)) throw new Error('Section ids must be unique.'); sectionIds.add(s.id);
    if (!s.lanes.length) throw new Error(`Section "${s.title}" needs at least one named lane.`);
    for (const lane of s.lanes) for (const id of lane.node_ids) {
      const n = doc.getNode(id);
      if (!n || n.parent !== page || !n.artboard || n.hidden) throw new Error(`"${id}" must be a visible top-level screen on this page.`);
      if (n.style.position !== 'absolute') throw new Error(`Screen "${n.name}" must be absolutely positioned on the canvas before it can be arranged.`);
      if ((n.style.transform && n.style.transform !== 'none') || (n.style.rotate && n.style.rotate !== 'none')) throw new Error(`Screen "${n.name}" is transformed. Keep its placement or remove the transform deliberately before arranging it.`);
      if (n.locked) throw new Error(`Screen "${n.name}" is locked. Leave it in place or ask the person to unlock it.`);
      if (assigned.has(id)) throw new Error(`Screen "${n.name}" belongs to more than one lane.`);
      assigned.add(id); sizeOf(doc, id, sizes);
    }
  }
  const seenEdges = new Set<string>();
  for (const c of probe.connections) {
    if (!assigned.has(c.from) || !assigned.has(c.to) || c.from === c.to) throw new Error('Connections must join two different screens in this plan.');
    const k = `${c.from}:${c.to}`; if (seenEdges.has(k)) throw new Error('Duplicate connection.'); seenEdges.add(k);
  }
  const x = input.x ?? 0; let y = input.y ?? 0;
  if (![x, y].every(v => Number.isFinite(v) && Math.abs(v) <= 1_000_000)) throw new Error('Invalid canvas origin.');
  if (!assigned.size) return { plan: probe, placements: [], bounds: null, base_revision_id: current.revision_id };
  // A partial plan goes below untouched screens, never over their contents.
  if (input.y === undefined) for (const n of doc.getChildren(page)) {
    if (!n.artboard || n.hidden || assigned.has(n.id)) continue;
    y = Math.max(y, (Number.parseFloat(n.style.top ?? '') || 0) + sizeOf(doc, n.id, sizes).h + 320);
  }
  const placements: CanvasPlacement[] = [];
  for (const s of probe.sections) {
    if (!s.lanes.some(l => l.node_ids.length)) continue;
    y += 140;
    for (const lane of s.lanes) {
      if (!lane.node_ids.length) continue;
      y += 56; let at = x + 80; let height = 0; let col = 0;
      for (const id of lane.node_ids) {
        const { w, h } = sizeOf(doc, id, sizes);
        if (col && (col >= columns || at + w > x + 80 + maxWidth)) { y += height + 120; at = x + 80; height = 0; col = 0; }
        placements.push({ id, x: at, y, w, h }); at += w + 96; height = Math.max(height, h); col++;
      }
      y += height + 100;
    }
    y += 220;
  }
  if (placements.some(p => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.x + p.w), Math.abs(p.y + p.h)) > 10_000_000)) throw new Error('Canvas plan is too large. Split independent flows across pages instead of creating an enormous sheet.');
  // An explicit origin must also respect unassigned objects. No content is silently moved out of the way.
  for (const n of doc.getChildren(page)) {
    if (n.hidden || assigned.has(n.id)) continue;
    const left = Number.parseFloat(n.style.left ?? ''); const top = Number.parseFloat(n.style.top ?? '');
    if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
    const { w, h } = sizeOf(doc, n.id, sizes);
    if (placements.some(p => p.x < left + w + 48 && p.x + p.w + 48 > left && p.y < top + h + 48 && p.y + p.h + 48 > top)) throw new Error(`Plan would overlap untouched layer "${n.name}". Include it deliberately or choose a free origin.`);
  }
  return { plan: probe, placements, bounds: unionCanvasBoxes(placements), base_revision_id: current.revision_id };
}

export function unionCanvasBoxes(boxes: CanvasBox[]): CanvasBox | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(b => b.x)); const y = Math.min(...boxes.map(b => b.y));
  return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
}

export function applyCanvasPlan(doc: BogenDoc, page: string, prepared: ReturnType<typeof prepareCanvasPlan>, origin?: unknown): void {
  if (readCanvasPlan(doc, page).revision + 1 !== prepared.plan.revision || readCanvasPlan(doc, page).revision_id !== prepared.base_revision_id) throw new Error('Canvas plan changed before apply.');
  doc.transact(() => {
    for (const p of prepared.placements) doc.updateStyle(p.id, { left: `${p.x}px`, top: `${p.y}px`, right: null, bottom: null });
    doc.meta.set(key(page), structuredClone(prepared.plan));
  }, origin);
}
