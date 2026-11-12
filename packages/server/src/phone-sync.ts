import { applyRemoteUpdate, staleFor } from './design-branches.ts';
import { BogenDoc, replaceLayerText, Y } from '@bogen/core';
import { z } from 'zod';
import { assertWellFormed } from './bogen-file.ts';
import type { BogenServer } from './http/server.ts';
import { rescueStranded, TEXT_CONFLICT } from './peers.ts';
import { compareSync, type SyncConflict } from './sync-conflicts.ts';
import { HttpError } from './util.ts';

/**
 * A phone's edits made while it could not reach this computer. The phone sends them here before it connects
 * again, rather than through the sync socket, so that they are compared with what changed here meanwhile, the
 * same way edits from another device are after being apart (sync-conflicts.ts): a value both sides set gets a
 * note, which the phone and the computer both show. The merge itself is the CRDT's, as always.
 */

export const CatchUpBody = z.object({
  /** What the phone has that this computer may not: a Yjs update, base64. */
  update: z.string().min(1).max(96 * 1024 * 1024),
  /** The phone's state vector, base64, for the text check. */
  sv: z.string().max(1024 * 1024),
});

export interface CatchUpResult {
  /** Notes made by this catch-up, as this computer keeps them: `ours` is the computer's value, `theirs` the phone's. */
  conflicts: SyncConflict[];
  /** This computer's state vector after the merge, so the phone knows everything arrived. */
  sv: string;
  /** False when the phone had nothing this computer lacked. */
  changed: boolean;
}

const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export async function phoneCatchUp(app: BogenServer, fileId: string, body: z.output<typeof CatchUpBody>, device: string): Promise<CatchUpResult> {
  app.requireFile(fileId);
  let update: Uint8Array;
  let sv: Uint8Array;
  try {
    update = unb64(body.update);
    sv = unb64(body.sv);
    Y.decodeStateVector(sv);
  } catch {
    throw new HttpError(400, 'That is not a Yjs update and state vector.');
  }
  const room = await app.rooms.get(fileId);
  const base = Y.encodeStateAsUpdate(room.doc.y);
  // First on a copy: an update cannot be taken back once applied.
  const probe = new BogenDoc(new Y.Doc());
  let changed = false;
  try {
    Y.applyUpdate(probe.y, base);
    probe.y.on('update', () => {
      changed = true;
    });
    try {
      Y.applyUpdate(probe.y, update);
    } catch {
      throw new HttpError(400, 'That is not a Yjs update.');
    }
    assertWellFormed(probe, { requirePage: false });
    if (probe.y.store.pendingStructs || probe.y.store.pendingDs) changed = true;
  } finally {
    probe.y.destroy();
  }
  if (!changed) return { conflicts: [], sv: b64(Y.encodeStateVector(room.doc.y)), changed: false };
  // The phone was apart from this computer by definition: it had no connection.
  // Edits the phone made on a branch the file has since switched away from go to that branch (design-branches.ts).
  // Then there is nothing to compare with the branch live here: no notes, no text repairs against it.
  const stale = staleFor(room, sv);
  const found = stale ? { conflicts: [], fixes: [] } : compareSync(base, update, { remoteSv: sv });
  const out = applyRemoteUpdate({ storage: app.storage, changed: (id) => app.hub.broadcast({ t: 'history', fileId: id }) }, room, update, sv, { name: device || 'the phone', id: `phone:${device || 'phone'}` }, 'phone-catch-up');
  rescueStranded(room.doc, 'phone-catch-up');
  if (found.fixes.length && !out.diverted) {
    room.doc.transact(() => {
      for (const fix of found.fixes) {
        const m = room.doc.nodes.get(fix.nodeId) as Y.Map<unknown> | undefined;
        if (m && !m._item?.deleted) replaceLayerText(m, fix.text, fix.spans);
      }
    }, TEXT_CONFLICT);
  }
  const conflicts = app.peers.conflicts.add(fileId, device, found.conflicts);
  return { conflicts, sv: b64(Y.encodeStateVector(room.doc.y)), changed: true };
}

/** What the phone shows about the computers it can use: this one, and the others it syncs with. */
export interface PhoneHosts {
  self: { name: string; url: string | null; version: string };
  others: { id: string; name: string; url: string | null; state: 'connected' | 'offline'; lastSyncAt: number | null }[];
}

export function phoneHosts(app: BogenServer, version: string): PhoneHosts {
  return {
    self: { name: app.peers.device().name, url: app.phone.url, version },
    others: app.peers.status().map((p) => ({ id: p.id, name: p.name, url: p.phoneUrl ?? null, state: p.state, lastSyncAt: p.lastSyncAt })),
  };
}
