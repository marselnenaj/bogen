import { Y } from '@bogen/core';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { z } from 'zod';
import { FILE_ID } from './storage.ts';
import type { Room, Rooms } from './sync.ts';

/** Who has a file open on a device, as another device hears it. Agents are never part of this. */
export interface RemotePerson { name: string; color: string; selection: string[]; pageId?: string; cursor?: { x: number; y: number; pageId: string } | null }

const Id = z.string().regex(/^[\w-]{1,64}$/);
export const PresencePerson = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  selection: z.array(Id).max(200),
  pageId: Id.optional(),
  cursor: z.object({ x: z.number().finite(), y: z.number().finite(), pageId: Id }).nullable().optional(),
});
export const PresenceMessage = z.object({ t: z.literal('presence'), id: z.string().regex(FILE_ID), people: z.array(PresencePerson).max(20) });
export type PresenceMessage = z.output<typeof PresenceMessage>;

/** What a peer says it understands. A peer that does not list it never receives it, since older ones drop the socket over an unknown message. */
export const FEATURE_PRESENCE = 'presence';

const SEND_MS = 150;
const REFRESH_MS = 15_000;
/** A device that has said nothing for this long is taken to have left. */
const EXPIRE_MS = 40_000;

interface Shown { awareness: Awareness; state: RemotePerson }
interface Remote { people: RemotePerson[]; at: number; shown: Map<number, Shown> }

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Sends who is in each file to paired devices, and shows who is over there through the awareness of the local room, so
 * that an open editor needs nothing new. Such a state has `user.device`, which keeps it out of `humans()` and from being
 * sent on. Everything about it is display: it is not in any document and can start nothing.
 */
export class PeerPresence {
  private local = new Map<string, RemotePerson[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private remote = new Map<string, Map<string, Remote>>();
  private refresher: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: {
    rooms: Rooms;
    /** Sends to every connected device that takes presence. */
    send: (message: PresenceMessage) => void;
    deviceName: (peerId: string) => string;
    shareCursors: () => boolean;
    changed: () => void;
  }) {
    this.refresher = setInterval(() => this.refresh(), REFRESH_MS);
    this.refresher.unref();
  }

  watch(room: Room): void {
    const onChange = () => this.schedule(room);
    room.awareness.on('change', onChange);
    room.cleanups.push(() => {
      room.awareness.off('change', onChange);
      this.dropShown(room.id);
      this.schedule(room, true);
    });
    this.applyRemote(room);
  }

  private people(room: Room): RemotePerson[] {
    const out: RemotePerson[] = [];
    const share = this.deps.shareCursors();
    room.awareness.getStates().forEach((state) => {
      const user = state.user as { name?: unknown; color?: unknown; agent?: unknown; device?: unknown } | undefined;
      if (!user || user.agent || user.device) return;
      const parsed = PresencePerson.safeParse({
        name: String(user.name ?? 'Someone').slice(0, 80), color: user.color, selection: Array.isArray(state.selection) ? state.selection.slice(0, 200) : [],
        ...(typeof state.pageId === 'string' ? { pageId: state.pageId } : {}),
        ...(share && state.cursor ? { cursor: state.cursor } : {}),
      });
      if (parsed.success) out.push(parsed.data);
    });
    return out;
  }

  private schedule(room: Room, gone = false): void {
    if (this.closed || this.timers.has(room.id)) return;
    const { id } = room;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      const people = gone || this.deps.rooms.peek(id) !== room ? [] : this.people(room);
      if (sameJson(this.local.get(id) ?? [], people)) return;
      if (people.length) this.local.set(id, people);
      else this.local.delete(id);
      this.deps.send({ t: 'presence', id, people });
    }, SEND_MS));
    this.timers.get(id)!.unref();
  }

  /** A device that just connected has heard nothing yet. */
  snapshot(): PresenceMessage[] {
    return [...this.local].map(([id, people]) => ({ t: 'presence', id, people }));
  }

  private refresh(): void {
    for (const message of this.snapshot()) this.deps.send(message);
    const now = Date.now();
    for (const [fileId, devices] of this.remote) {
      for (const [peerId, entry] of devices) if (now - entry.at > EXPIRE_MS) this.receive(peerId, { t: 'presence', id: fileId, people: [] });
    }
  }

  receive(peerId: string, message: PresenceMessage): void {
    if (this.closed) return;
    let devices = this.remote.get(message.id);
    if (!devices) {
      devices = new Map();
      this.remote.set(message.id, devices);
    }
    const entry = devices.get(peerId) ?? { people: [], at: 0, shown: new Map() };
    entry.people = message.people;
    entry.at = Date.now();
    devices.set(peerId, entry);
    const room = this.deps.rooms.peek(message.id);
    if (room) this.show(room, peerId, entry);
    if (!message.people.length) {
      devices.delete(peerId);
      if (!devices.size) this.remote.delete(message.id);
    }
    this.deps.changed();
  }

  private applyRemote(room: Room): void {
    for (const [peerId, entry] of this.remote.get(room.id) ?? []) this.show(room, peerId, entry);
  }

  /** One awareness per person over there, as agents have, so that each is a client of its own in the editor. */
  private show(room: Room, peerId: string, entry: Remote): void {
    const device = this.deps.deviceName(peerId);
    for (let index = 0; index < Math.max(entry.people.length, entry.shown.size); index++) {
      const person = entry.people[index];
      let shown = entry.shown.get(index);
      if (!person) {
        if (shown) {
          shown.awareness.setLocalState(null);
          shown.awareness.destroy();
          shown.awareness.doc.destroy();
          entry.shown.delete(index);
        }
        continue;
      }
      if (!shown) {
        const awareness = new Awareness(new Y.Doc());
        awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
          if (this.deps.rooms.peek(room.id) === room) applyAwarenessUpdate(room.awareness, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]), 'peer-presence');
        });
        shown = { awareness, state: person };
        entry.shown.set(index, shown);
      }
      shown.state = person;
      shown.awareness.setLocalState({
        user: { name: person.name, color: person.color, device },
        cursor: person.cursor ?? null, selection: person.selection, pageId: person.pageId ?? null,
      });
    }
  }

  private dropShown(fileId: string): void {
    for (const entry of this.remote.get(fileId)?.values() ?? []) {
      for (const shown of entry.shown.values()) {
        shown.awareness.setLocalState(null);
        shown.awareness.destroy();
        shown.awareness.doc.destroy();
      }
      entry.shown.clear();
    }
  }

  /** A device that dropped off has left every file it was in. */
  peerGone(peerId: string): void {
    for (const [fileId, devices] of [...this.remote]) if (devices.has(peerId)) this.receive(peerId, { t: 'presence', id: fileId, people: [] });
  }

  /** What is known about a device, for status. */
  of(peerId: string): { fileId: string; people: { name: string; selection: number }[] }[] {
    const out: { fileId: string; people: { name: string; selection: number }[] }[] = [];
    for (const [fileId, devices] of this.remote) {
      const entry = devices.get(peerId);
      if (entry?.people.length) out.push({ fileId, people: entry.people.map((p) => ({ name: p.name, selection: p.selection.length })) });
    }
    return out;
  }

  close(): void {
    this.closed = true;
    if (this.refresher) clearInterval(this.refresher);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const fileId of this.remote.keys()) this.dropShown(fileId);
    this.remote.clear();
  }
}
