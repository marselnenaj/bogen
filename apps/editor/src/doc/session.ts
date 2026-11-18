import { brandUndoScope, BogenDoc, hostedFamilies, overrideFamilies, Y } from '@bogen/core';
import { WebsocketProvider } from 'y-websocket';
import { OfflineDoc } from './offline.ts';
import { PhoneLink } from './phone-link.ts';
import { Snapshot } from './snapshot.ts';
import { clearUndoOnCheckout } from './branch-watch.ts';
import { ensureFont } from '../lib/fonts.ts';
import { loadUser, type LocalUser } from '../lib/user.ts';
import { t } from '../i18n/store.ts';
import { bindTeamWriter, type TeamWriter } from './team-writer.ts';

/** Moves this tab's presence to a new Yjs id: the old id leaves, the same state shows under the new one. */
export function moveAwareness(aw: { clientID: number; getLocalState(): unknown; setLocalState(state: unknown): void }, id: number): void {
  if (aw.clientID === id) return;
  const state = aw.getLocalState();
  aw.setLocalState(null);
  aw.clientID = id;
  if (state !== null) aw.setLocalState(state);
}

/** Origin of every transaction this editor makes. The undo manager tracks only this. */
export const LOCAL = 'bogen-editor';

export interface AwarenessUser { name: string; color: string; agent?: boolean; /** Someone on another of this person's devices. */ device?: string }
export interface AwarenessState {
  user: AwarenessUser;
  cursor: { x: number; y: number; pageId: string } | null;
  selection: string[];
  pageId: string | null;
  chat?: string;
  /** Additive to the spec: what this peer is looking at, so that others can follow it. */
  viewport?: { x: number; y: number; z: number; w: number; h: number };
  /** Agents only. */
  focus?: AgentFocus;
}
/** Something an agent wants the person to look at. */
export interface AgentFocus { id: string; pageId?: string; nodeIds: string[]; select: boolean; view: boolean; note?: string; at: number }
export interface Peer extends AwarenessState { clientId: number }

/** One open file: the Y.Doc, its connection, its snapshot and the local undo stack. */
export class Session {
  readonly y = new Y.Doc();
  readonly doc = new BogenDoc(this.y);
  readonly snap = new Snapshot(this.doc);
  readonly provider: WebsocketProvider;
  readonly undo: Y.UndoManager;
  readonly user: LocalUser = loadUser();
  /** The copy on this phone. Null on the desktop, where the server is always there. */
  readonly offline: OfflineDoc | null;
  /** On the phone: when the socket connects, and what waits for the computer. */
  readonly link: PhoneLink | null;
  /** The id this tab writes a team file with; `ready` before the editor lets anyone write. */
  readonly writer: TeamWriter;
  private gestureDepth = 0;
  private stopCheckoutWatch: () => void = () => {};
  private offSwitch: () => void = () => {};

  constructor(readonly fileId: string) {
    // A family the document carries loads from there, not from Google Fonts by name.
    let hosted: { size: number; families: Set<string> } | null = null;
    const faces = this.y.getMap('fontFaces');
    const load = (family: string | undefined) => {
      if (!hosted || hosted.size !== faces.size) hosted = { size: faces.size, families: hostedFamilies(this.doc) };
      ensureFont(family, hosted.families);
    };
    this.snap.onNodeChanged = (n) => {
      load(n.style.fontFamily);
      if (n.overrides) overrideFamilies(n).forEach(load);
    };
    this.doc.textStyles.observeDeep(() => {
      for (const t of this.snap.textStyles) if (t.style.fontFamily) load(t.style.fontFamily);
    });
    // Agents usually name fonts through tokens, and layers then only say var(--font-serif).
    this.doc.tokens.observeDeep(() => {
      for (const t of this.doc.getTokens()) if (t.kind === 'font-family') load(t.value);
    });
    // Before anything writes: in a team file this tab writes with an id of this device (team-writer.ts).
    this.writer = bindTeamWriter(fileId, this.y);
    // Before the socket, so that a stored copy is in the document before the server's state arrives.
    this.offline = OfflineDoc.enabled() ? new OfflineDoc(fileId, this.y) : null;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // On the phone the link decides when the socket connects: changes made offline go to the computer first.
    this.provider = new WebsocketProvider(`${proto}//${location.host}/sync`, fileId, this.y, { disableBc: true, connect: !this.offline });
    this.link = this.offline ? new PhoneLink(fileId, this.y, this.provider, this.offline) : null;
    // Presence is keyed by the Yjs id: when this tab switches the id it writes with, others see it under the new
    // one, and the old one leaves.
    this.offSwitch = this.writer.onSwitch(() => moveAwareness(this.provider.awareness, this.y.clientID));
    this.undo = new Y.UndoManager([this.doc.nodes, this.doc.pages, this.doc.tokens, this.doc.meta, this.doc.modes, this.doc.textStyles, this.doc.variables, ...brandUndoScope(this.doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    // A switch of branch, from anywhere, empties Ctrl+Z: its steps were made on the branch that was live before.
    this.stopCheckoutWatch = clearUndoOnCheckout(this.y, this.undo);
  }

  destroy(): void {
    this.offSwitch();
    this.stopCheckoutWatch();
    this.writer.destroy();
    this.undo.destroy();
    this.provider.awareness.setLocalState(null);
    this.link?.destroy();
    this.offline?.destroy();
    this.provider.destroy();
    this.snap.destroy();
    this.y.destroy();
  }

  /** Runs `fn` as one local transaction, one undo step unless a gesture is open. */
  tx<T>(fn: () => T): T {
    return this.doc.transact(fn, LOCAL);
  }

  /** All transactions until the matching `endGesture` become one undo step. */
  beginGesture(): void {
    if (this.gestureDepth++ === 0) {
      this.undo.stopCapturing();
      this.undo.captureTimeout = Number.MAX_SAFE_INTEGER;
    }
  }

  endGesture(): void {
    if (this.gestureDepth === 0) return;
    if (--this.gestureDepth === 0) {
      this.undo.captureTimeout = 0;
      this.undo.stopCapturing();
    }
  }
}

let current: Session | null = null;

export function setSession(s: Session | null): void {
  current = s;
}

export function session(): Session {
  if (!current) throw new Error(t('No file is open.'));
  return current;
}

export function maybeSession(): Session | null {
  return current;
}
