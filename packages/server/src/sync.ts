import { applyRemoteUpdate } from './design-branches.ts';
import { BogenDoc, brandUndoScope, repairMirror, textLayersChanged, Y } from '@bogen/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type { EventHub } from './events.ts';
import type { Storage } from './storage.ts';
import { errorMessage } from './util.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

/** An agent disappears from awareness and `/api/status` this long after its last tool call. */
const AGENT_EXPIRY_MS = 40_000;
/** After a tool call an agent counts as working for this long, so that it does not flicker between calls. */
const WORKING_LINGER_MS = 8_000;
const PING_MS = 30_000;
const AGENT_COLORS = ['#e5484d', '#f76b15', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#ad7f58'];

export function agentOrigin(agent: string): string {
  return `agent:${agent}`;
}

function colorFor(name: string): string {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]!;
}

export interface AgentPresenceInfo {
  name: string;
  fileId: string;
  fileName: string;
  status: 'working' | 'idle';
  lastTool: string;
  at: number;
}

/** Something an agent wants a person to look at. An open editor follows it when the person is not busy. */
export interface AgentFocus {
  id: string;
  pageId?: string;
  nodeIds: string[];
  /** Select these layers in the editor. */
  select: boolean;
  /** Bring them into view. */
  view: boolean;
  note?: string;
  at: number;
}

interface AgentPresence {
  awareness: Awareness;
  expiry: NodeJS.Timeout;
  idle: NodeJS.Timeout | null;
  running: number;
  lastTool: string;
  at: number;
  nodeIds: string[];
  pageId?: string;
  focus?: AgentFocus;
  /** The run this agent's tool calls belong to, when Bogen started it. */
  runId?: string;
}

export interface HumanState {
  clientId: number;
  name: string;
  pageId?: string;
  selection: string[];
  lastSeen: number;
}

/** One loaded file: the server's replica, its awareness, and the sockets of its peers. */
/** Origin of the write that puts merged text where older builds read it. Not anyone's edit, so nobody undoes it. */
export const TEXT_MERGE = 'text-merge';

export class Room {
  readonly doc: BogenDoc;
  readonly awareness: Awareness;
  readonly conns = new Map<WebSocket, Set<number>>();
  private undo = new Map<string, Y.UndoManager>();
  readonly agents = new Map<string, AgentPresence>();
  lastUsed = Date.now();
  /** False while the saved state is being applied, which is not a change. */
  ready = false;
  /** Run when the room goes away. */
  readonly cleanups: (() => void)[] = [];

  constructor(readonly id: string, private readonly rooms: Rooms) {
    this.doc = new BogenDoc();
    this.awareness = new Awareness(this.doc.y);
    this.awareness.setLocalState(null);
    this.doc.y.on('update', (update: Uint8Array, origin: unknown) => {
      if (!this.ready) return;
      this.lastUsed = Date.now();
      this.rooms.docChanged(this);
      this.rooms.docUpdated(this, update, origin);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin);
    });
    // Two sides typing in one text layer merge in its CRDT text, but the plain copy older builds read holds
    // one side. Put the merged text there once it has arrived. Same values on every device, so no new conflict.
    this.doc.y.on('afterTransaction', (tr: Y.Transaction) => {
      if (!this.ready || tr.local) return;
      const layers = textLayersChanged(this.doc.nodes as Y.Map<unknown>, tr);
      if (!layers.length) return;
      queueMicrotask(() => {
        try {
          this.doc.transact(() => { for (const m of layers) repairMirror(m); }, TEXT_MERGE);
        } catch (e) {
          console.error(`bogen: ${errorMessage(e)}`);
        }
      });
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const owned = this.conns.get(origin as WebSocket);
      if (owned) {
        for (const id of added) owned.add(id);
        for (const id of removed) owned.delete(id);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_AWARENESS);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.broadcast(encoding.toUint8Array(encoder));
    });
  }

  private broadcast(message: Uint8Array, except?: unknown): void {
    for (const ws of this.conns.keys()) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(message);
  }

  /**
   * Created before an agent's first write, since an UndoManager only sees later changes. Comments are left out:
   * a run from a comment ends with its reply and resolve, and undo is for what it drew, not for its answer.
   */
  undoManagerFor(agent: string): Y.UndoManager {
    let manager = this.undo.get(agent);
    if (!manager) {
      const { nodes, pages, tokens, meta, modes, textStyles, variables } = this.doc;
      manager = new Y.UndoManager([nodes, pages, tokens, meta, modes, textStyles, variables, ...brandUndoScope(this.doc)], { trackedOrigins: new Set([agentOrigin(agent)]), captureTimeout: 0 });
      this.undo.set(agent, manager);
      this.rooms.undoManagerMade(this, agent, manager);
    }
    return manager;
  }

  /** Undoes the agent's latest tool call. False when it has nothing left to undo. */
  undoAgent(agent: string): boolean {
    const manager = this.undo.get(agent);
    if (!manager || !manager.canUndo()) return false;
    manager.undo();
    return true;
  }

  /** Puts back what `undoAgent` took away. False when there is nothing to redo. */
  redoAgent(agent: string): boolean {
    const manager = this.undo.get(agent);
    if (!manager || !manager.canRedo()) return false;
    manager.redo();
    return true;
  }

  /**
   * Forgets every agent's undo and redo steps. After another branch is checked out the live design is a different
   * version, and a step recorded on the one before would write into it.
   */
  clearUndo(): void {
    for (const manager of this.undo.values()) manager.clear();
  }

  /** How much an agent can still undo and redo. Stacks last as long as the file stays loaded. */
  undoDepth(agent: string): { undo: number; redo: number } {
    const manager = this.undo.get(agent);
    return { undo: manager?.undoStack.length ?? 0, redo: manager?.redoStack.length ?? 0 };
  }

  /** Publishes what an agent wants people to look at, through the same awareness as its cursor. */
  agentFocus(name: string, focus: AgentFocus): void {
    const presence = this.agents.get(name);
    if (!presence) return;
    presence.focus = focus;
    this.publishAgent(name, presence);
  }

  /** People currently in the file on this device, most recently active first. */
  humans(): HumanState[] {
    const out: HumanState[] = [];
    const agentIds = new Set([...this.agents.values()].map((a) => a.awareness.clientID));
    this.awareness.getStates().forEach((state, clientId) => {
      if (agentIds.has(clientId) || state.user?.agent || state.user?.device) return;
      out.push({
        clientId,
        name: String(state.user?.name ?? 'Someone'),
        pageId: typeof state.pageId === 'string' ? state.pageId : undefined,
        selection: Array.isArray(state.selection) ? state.selection.filter((s: unknown): s is string => typeof s === 'string') : [],
        lastSeen: this.awareness.meta.get(clientId)?.lastUpdated ?? 0,
      });
    });
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private publishAgent(name: string, presence: AgentPresence): void {
    presence.awareness.setLocalState({
      user: { name, color: this.rooms.agentColors.get(name) ?? colorFor(name), agent: true },
      cursor: null,
      selection: presence.nodeIds,
      pageId: presence.pageId,
      working: presence.running > 0 || presence.idle !== null,
      tool: presence.lastTool,
      ...(presence.focus ? { focus: presence.focus } : {}),
    });
  }

  /** Marks an agent as busy from now until `agentFinished`. */
  agentStarted(name: string, tool: string, runId?: string): void {
    this.lastUsed = Date.now();
    let presence = this.agents.get(name);
    if (!presence) {
      const awareness = new Awareness(new Y.Doc());
      awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        applyAwarenessUpdate(this.awareness, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]), 'agent');
      });
      presence = { awareness, expiry: setTimeout(() => {}, 0), idle: null, running: 0, lastTool: tool, at: Date.now(), nodeIds: [] };
      this.agents.set(name, presence);
    }
    presence.running++;
    presence.lastTool = tool;
    presence.runId = runId;
    presence.at = Date.now();
    this.armExpiry(name, presence);
    this.publishAgent(name, presence);
  }

  agentFinished(name: string, nodeIds: string[] | undefined, pageId: string | undefined): void {
    const presence = this.agents.get(name);
    if (!presence) return;
    presence.running = Math.max(0, presence.running - 1);
    presence.at = Date.now();
    if (nodeIds) presence.nodeIds = nodeIds;
    if (pageId) presence.pageId = pageId;
    if (presence.idle) clearTimeout(presence.idle);
    presence.idle = setTimeout(() => {
      presence.idle = null;
      if (this.agents.get(name) !== presence) return;
      this.publishAgent(name, presence);
      this.rooms.agentWentIdle(this, name);
    }, WORKING_LINGER_MS);
    presence.idle.unref();
    this.armExpiry(name, presence);
    this.publishAgent(name, presence);
  }

  private armExpiry(name: string, presence: AgentPresence): void {
    clearTimeout(presence.expiry);
    presence.expiry = setTimeout(() => this.removeAgent(name), this.rooms.agentExpiryMs);
    presence.expiry.unref();
  }

  private removeAgent(name: string): void {
    const presence = this.agents.get(name);
    if (!presence) return;
    this.agents.delete(name);
    clearTimeout(presence.expiry);
    if (presence.idle) clearTimeout(presence.idle);
    presence.awareness.setLocalState(null);
    presence.awareness.destroy();
    presence.awareness.doc.destroy();
  }

  agentInfos(fileName: string): AgentPresenceInfo[] {
    return [...this.agents].map(([name, a]) => ({
      name, fileId: this.id, fileName, lastTool: a.lastTool, at: a.at,
      status: a.running > 0 || a.idle !== null ? 'working' as const : 'idle' as const,
    }));
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const name of [...this.agents.keys()]) this.removeAgent(name);
    for (const ws of this.conns.keys()) ws.close(1001);
    this.conns.clear();
    for (const manager of this.undo.values()) manager.destroy();
    this.undo.clear();
    this.awareness.destroy();
    this.doc.y.destroy();
  }
}

export interface RoomsOptions {
  /** A file with no peers is unloaded this long after its last use. */
  idleMs?: number;
  agentExpiryMs?: number;
  onChange?: (fileId: string) => void;
  /** Every update to a loaded doc, with its origin. Device sync sends these on. */
  onUpdate?: (fileId: string, update: Uint8Array, origin: unknown) => void;
  /** A file came into memory, with its saved state applied. */
  onRoomLoaded?: (room: Room) => void;
  /** An agent's tool calls stopped a moment ago. */
  onAgentIdle?: (room: Room, agent: string) => void;
  /** An agent's first write in a loaded file. */
  onUndoManager?: (room: Room, agent: string, manager: Y.UndoManager) => void;
}

/** Loads files on first use, keeps peers in sync, and unloads what nobody uses. */
export class Rooms {
  private rooms = new Map<string, Room>();
  private loading = new Map<string, Promise<Room>>();
  private idleMs: number;
  readonly agentExpiryMs: number;
  private sweeper: NodeJS.Timeout;
  private pinger: NodeJS.Timeout;
  private alive = new WeakSet<WebSocket>();
  /** What a connection said it has, until its first answer arrives: to tell edits made before a checkout from later ones. */
  private remoteSv = new WeakMap<WebSocket, Uint8Array>();
  private filesNotice: NodeJS.Timeout | null = null;
  /** Colours given to agent names, such as the lanes of a race, so that each lane's cursor matches its label. */
  readonly agentColors = new Map<string, string>();

  constructor(private readonly storage: Storage, private readonly hub: EventHub, private readonly options: RoomsOptions = {}) {
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.agentExpiryMs = options.agentExpiryMs ?? AGENT_EXPIRY_MS;
    this.sweeper = setInterval(() => void this.sweep(), Math.min(this.idleMs, 30_000));
    this.sweeper.unref();
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.pinger.unref();
  }

  peek(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  loaded(): Room[] {
    return [...this.rooms.values()];
  }

  async get(id: string): Promise<Room> {
    const room = this.rooms.get(id);
    if (room) {
      room.lastUsed = Date.now();
      return room;
    }
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  private async load(id: string): Promise<Room> {
    if (!this.storage.get(id)) throw new Error(`No file with id ${id}. Call file_list to see what exists.`);
    const saved = await this.storage.readDoc(id);
    const room = new Room(id, this);
    if (saved) {
      try {
        Y.applyUpdate(room.doc.y, saved, 'load');
      } catch (e) {
        const aside = await this.storage.quarantineDoc(id);
        room.destroy();
        throw new Error(`The file ${id} could not be read (${errorMessage(e)}). It was moved to ${aside}.`);
      }
    }
    room.ready = true;
    // The only place a first page is ever created, so concurrent editors cannot each add one.
    room.doc.ensureFirstPage();
    this.rooms.set(id, room);
    this.options.onRoomLoaded?.(room);
    return room;
  }

  /** Called for every change to a loaded doc. */
  docChanged(room: Room): void {
    this.storage.scheduleDoc(room.id, () => Y.encodeStateAsUpdate(room.doc.y));
    this.storage.update(room.id, { updatedAt: Date.now() });
    this.options.onChange?.(room.id);
    this.noteFilesChanged();
  }

  /** Share one notification for document and lightweight index updates, including a whole peer batch. */
  noteFilesChanged(): void {
    if (!this.filesNotice) {
      this.filesNotice = setTimeout(() => {
        this.filesNotice = null;
        this.hub.broadcast({ t: 'files' });
      }, 1000);
      this.filesNotice.unref();
    }
  }

  docUpdated(room: Room, update: Uint8Array, origin: unknown): void {
    try {
      this.options.onUpdate?.(room.id, update, origin);
    } catch (e) {
      console.error(`bogen: ${errorMessage(e)}`);
    }
  }

  undoManagerMade(room: Room, agent: string, manager: Y.UndoManager): void {
    this.options.onUndoManager?.(room, agent, manager);
  }

  agentWentIdle(room: Room, agent: string): void {
    this.options.onAgentIdle?.(room, agent);
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.conns.size === 0 && room.agents.size === 0 && now - room.lastUsed >= this.idleMs) await this.unload(room.id);
    }
  }

  async unload(id: string): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    await this.storage.flushDoc(id);
    room.destroy();
  }

  /** For a deleted file: drops the replica and disconnects peers without saving. */
  drop(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    this.rooms.delete(id);
    room.destroy();
  }

  async connect(ws: WebSocket, fileId: string): Promise<void> {
    // Peers start talking as soon as the socket opens, while the file may still be loading.
    const early: Uint8Array[] = [];
    const buffer = (data: Uint8Array) => early.push(data);
    ws.on('message', buffer);
    let room: Room;
    try {
      room = await this.get(fileId);
    } catch (e) {
      console.error(`bogen: ${errorMessage(e)}`);
      ws.close(4404, 'file not available');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.off('message', buffer);
    room.conns.set(ws, new Set());
    this.alive.add(ws);
    ws.on('pong', () => this.alive.add(ws));
    const onMessage = (data: Uint8Array) => {
      try {
        this.handle(room, ws, data);
      } catch (e) {
        console.error(`bogen: bad sync message on ${room.id}: ${errorMessage(e)}`);
        ws.close(1007, 'bad message');
      }
    };
    ws.on('message', onMessage);
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      const owned = room.conns.get(ws);
      room.conns.delete(ws);
      room.lastUsed = Date.now();
      if (owned?.size) removeAwarenessStates(room.awareness, [...owned], null);
    });

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc.y);
    ws.send(encoding.toUint8Array(encoder));
    this.sendAwareness(room, ws);
    for (const data of early) onMessage(data);
  }

  private sendAwareness(room: Room, ws: WebSocket): void {
    const states = room.awareness.getStates();
    if (!states.size) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    ws.send(encoding.toUint8Array(encoder));
  }

  private handle(room: Room, ws: WebSocket, data: Uint8Array): void {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      // An editor that comes back sends what it has (step 1) and then what it did while away (step 2). Edits it made
      // before it saw a checkout belong to the branch it was on, not to the one live now (design-branches.ts).
      const peek = decoding.clone(decoder);
      const step = decoding.readVarUint(peek);
      if (step === syncProtocol.messageYjsSyncStep1) this.remoteSv.set(ws, decoding.readVarUint8Array(peek));
      else if (step === syncProtocol.messageYjsSyncStep2 && this.remoteSv.has(ws)) {
        const sv = this.remoteSv.get(ws)!;
        this.remoteSv.delete(ws);
        applyRemoteUpdate({ storage: this.storage, changed: (id) => this.hub.broadcast({ t: 'history', fileId: id }) }, room, decoding.readVarUint8Array(peek), sv, { name: 'an editor that was away', id: 'editor' }, ws);
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc.y, ws);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    } else if (type === MSG_AWARENESS) {
      applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
    } else if (type === MSG_QUERY_AWARENESS) {
      this.sendAwareness(room, ws);
    }
  }

  private ping(): void {
    for (const room of this.rooms.values()) {
      for (const ws of room.conns.keys()) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }
  }

  agentInfos(): AgentPresenceInfo[] {
    return this.loaded().flatMap((room) => room.agentInfos(this.storage.get(room.id)?.name ?? room.id));
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    clearInterval(this.pinger);
    if (this.filesNotice) clearTimeout(this.filesNotice);
    await Promise.all([...this.rooms.keys()].map((id) => this.unload(id)));
  }
}
