import * as Y from 'yjs';
import type { BogenDoc } from './doc.ts';

/**
 * Hover, focus and active rules of a captured page. A design has one state per layer, so these are
 * kept apart from the layers, per artboard, as a record agents can read when they rebuild the page in
 * code. They are data only: nothing here is ever rendered, on the canvas or in an export.
 */
export interface InteractionRule {
  /** `hover`, `focus`, `focus-visible`, `focus-within` or `active`. */
  states: string[];
  selector: string;
  /** The declarations as the page wrote them, custom properties included. */
  declarations: string;
  /** The enclosing `@media` or `@supports` condition. */
  condition?: string;
  /** Layers in this artboard the selector matched, without the state. */
  layers: string[];
  /** How many elements matched, which can be more than `layers` holds. */
  matches: number;
}

export interface InteractionRecord { url: string; rules: InteractionRule[] }

const MAP_NAME = 'interactionStates';

function map(doc: BogenDoc): Y.Map<unknown> {
  return doc.y.getMap(MAP_NAME);
}

export function setInteractionRecord(doc: BogenDoc, artboardId: string, record: InteractionRecord, origin?: unknown): void {
  doc.transact(() => map(doc).set(artboardId, record), origin);
}

/** Records whose artboard still exists. Ids of layers deleted since then are left out. */
export function getInteractionRecords(doc: BogenDoc): (InteractionRecord & { artboardId: string })[] {
  const out: (InteractionRecord & { artboardId: string })[] = [];
  map(doc).forEach((value, artboardId) => {
    if (!doc.nodes.has(artboardId) || !value || typeof value !== 'object') return;
    const record = value as InteractionRecord;
    if (!Array.isArray(record.rules)) return;
    out.push({
      artboardId,
      url: String(record.url ?? ''),
      rules: record.rules.map((r) => ({ ...r, layers: (Array.isArray(r.layers) ? r.layers : []).filter((id) => doc.nodes.has(id)) })),
    });
  });
  return out.sort((a, b) => (a.artboardId < b.artboardId ? -1 : 1));
}
