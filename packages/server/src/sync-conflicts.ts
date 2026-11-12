import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { liveRich, MARK_KEY, newId, richTextAt, Y, type TextSpan } from '@bogen/core';
import { atomicWrite, errorMessage } from './util.ts';

/** Both sides set one value without knowing about the other. One won, by the CRDT's rules, and the other is only here. */
export interface SyncConflict {
  id: string;
  fileId: string;
  kind: 'layer' | 'token';
  nodeId?: string;
  /** The layer or token, as a person knows it. */
  name: string;
  /** `style.color`, `text`, `name`, `value`. */
  field: string;
  ours: string;
  theirs: string;
  device: string;
  kept: 'ours' | 'theirs';
  at: number;
  /**
   * Both whole texts with their ranges, when both devices edited the words of one text layer while apart and
   * their edits could not merge into something readable (see `textsClash`). `ours` is this device's.
   */
  texts?: { ours: TextVersion; theirs: TextVersion };
}

export interface TextVersion { text: string; spans?: TextSpan[] }

export type RawConflict = Omit<SyncConflict, 'id' | 'fileId' | 'device' | 'at'>;

/** A text layer that a catch-up left holding both sides' edits mixed together, and the one text it keeps instead. */
export interface TextFix { nodeId: string; text: string; spans: TextSpan[] }

export interface SyncComparison { conflicts: RawConflict[]; fixes: TextFix[] }

/** Only for a catch-up after the two devices were apart. Never for edits that crossed over a live link. */
export interface TextCheck {
  /** The other device's state vector, sent with the update. */
  remoteSv: Uint8Array;
}

const FIELDS = new Set(['name', 'text', 'tag', 'src', 'svg', 'attrs', 'hidden', 'locked']);
const VALUE_LIMIT = 400;
const MAX_PER_FILE = 100;
const MAX_WALK = 2000;
/** A text longer than this, counted with what was deleted from it, is not compared character by character: it counts as a clash. */
const MAX_TEXT_UNITS = 200_000;
/** Whole texts kept in a note, for Use the other and Keep both as a branch. */
const MAX_NOTE_TEXT = 100_000;

function text(value: unknown): string {
  const out = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return out.length > VALUE_LIMIT ? `${out.slice(0, VALUE_LIMIT)}...` : out;
}

function valueOf(item: Y.Item): unknown {
  return item.content.getContent().at(-1);
}

/** Whoever wrote `item` had seen `known`: following what each value was written on top of leads back to it. */
function knew(item: Y.Item, known: Y.Item, store: Y.Doc['store']): boolean {
  let current: Y.Item = item;
  for (let i = 0; i < MAX_WALK; i++) {
    const origin = current.origin;
    if (!origin) return false;
    if (origin.client === known.id.client && origin.clock >= known.id.clock && origin.clock < known.id.clock + known.length) return true;
    const next = Y.getItem(store, origin);
    if (!(next instanceof Y.Item)) return false;
    current = next;
  }
  return false;
}

/** Whether a client ever wrote a layer's text mark, which only builds that merge text do. */
function wroteMark(m: Y.Map<unknown>, client: number): boolean {
  let walked = 0;
  for (let item: Y.Item | null = m._map.get(MARK_KEY) ?? null; item && walked < MAX_WALK; item = item.left, walked++) {
    if (item.parentSub === MARK_KEY && item.id.client === client) return true;
  }
  return false;
}

type DeleteSet = Y.Snapshot['ds'];

const SPACE = /\s/;

interface Unit {
  /** 0: in the text both had and kept. 1: changed here. 2: changed on the other device. */
  side: 0 | 1 | 2;
  insert: boolean;
  /** Null when the character was deleted here and its content is gone. */
  ch: string | null;
}

const isSpace = (ch: string | null) => ch !== null && SPACE.test(ch);

/**
 * Whether two sets of edits to one `Y.Text`, made apart, would merge into a readable text. The rule:
 *
 * - The text both devices had in common is cut into words at whitespace.
 * - An edit touches a word when it deletes a character of it, or inserts next to it with no whitespace in
 *   between: typing at the end of `world` touches `world`, inserting `brave ` before it does not.
 * - They clash when an edit from one side and an edit from the other touch the same word, or sit next to
 *   each other with no unchanged character of the common text between them (both typed at one place).
 *
 * So one side changing the start of a sentence and the other its end merges, as do edits in different
 * words. Both rewording one word, both typing at the same place, or both replacing the whole text clash. Only
 * changes to the characters count; changes to ranges of formatting merge as they are.
 */
export function textsClash(t: Y.Text, seen: Map<number, number>, ours: DeleteSet, remoteSv: Map<number, number>, theirs: DeleteSet): boolean {
  const units: Unit[] = [];
  for (let item = t._start; item; item = item.right) {
    const content = item.content;
    if (content instanceof Y.ContentFormat) continue;
    const str = content instanceof Y.ContentString ? content.str : null;
    const lost = content instanceof Y.ContentDeleted;
    for (let i = 0; i < item.length; i++) {
      if (units.length > MAX_TEXT_UNITS) return true;
      const id = Y.createID(item.id.client, item.id.clock + i);
      const here = id.clock < (seen.get(id.client) ?? 0);
      const there = id.clock < (remoteSv.get(id.client) ?? 0);
      const goneHere = here && Y.isDeleted(ours, id);
      const goneThere = there && Y.isDeleted(theirs, id);
      // An embed counts as one character that is not whitespace.
      const ch = str !== null ? str[i]! : lost ? null : '\uFFFC';
      if (here && there) {
        if (!goneHere && !goneThere) units.push({ side: 0, insert: false, ch });
        else if (goneHere !== goneThere) units.push({ side: goneHere ? 1 : 2, insert: false, ch });
      } else if (here && !goneHere) units.push({ side: 1, insert: true, ch });
      else if (there && !goneThere) units.push({ side: 2, insert: true, ch });
    }
  }
  // Next to each other, with nothing unchanged in between.
  let run = 0;
  for (const u of units) {
    run = u.side === 0 ? 0 : run | u.side;
    if (run === 3) return true;
  }
  // The words of the common text: inserted characters neither split nor join them.
  const wordOf: (number | null)[] = [];
  let word = 0;
  let inWord = false;
  for (const u of units) {
    if (u.insert) {
      wordOf.push(null);
      continue;
    }
    if (isSpace(u.ch)) {
      inWord = false;
      wordOf.push(null);
      continue;
    }
    if (!inWord) word++;
    inWord = true;
    wordOf.push(word);
  }
  const touched = [new Set<number>(), new Set<number>(), new Set<number>()];
  for (let k = 0; k < units.length; k++) {
    const u = units[k]!;
    if (u.side === 0) continue;
    if (!u.insert) {
      if (wordOf[k] !== null) touched[u.side]!.add(wordOf[k]!);
      continue;
    }
    if (k > 0 && units[k - 1]!.insert && units[k - 1]!.side === u.side) continue;
    let end = k;
    while (end + 1 < units.length && units[end + 1]!.insert && units[end + 1]!.side === u.side) end++;
    let left = k - 1;
    while (left >= 0 && units[left]!.insert) left--;
    let right = end + 1;
    while (right < units.length && units[right]!.insert) right++;
    if (left >= 0 && wordOf[left] !== null && !isSpace(u.ch)) touched[u.side]!.add(wordOf[left]!);
    if (right < units.length && wordOf[right] !== null && !isSpace(units[end]!.ch)) touched[u.side]!.add(wordOf[right]!);
  }
  for (const w of touched[1]!) if (touched[2]!.has(w)) return true;
  return false;
}

/** The newest value of a key that came with the update. */
function newestNew(m: Y.Map<unknown>, key: string, seen: Map<number, number>): Y.Item | null {
  let walked = 0;
  for (let item: Y.Item | null = m._map.get(key) ?? null; item && walked < MAX_WALK; item = item.left, walked++) {
    if (item.parentSub === key && item.id.clock + item.length > (seen.get(item.id.client) ?? 0)) return item;
  }
  return null;
}

function spansOf(value: unknown): TextSpan[] {
  return Array.isArray(value) ? value as TextSpan[] : [];
}

/**
 * Compares a file with an update from another device: which values did both sides set while apart? A Y.Map keeps the
 * values of one key as a chain, each written on top of the one its writer saw last, so this needs no timestamps, and
 * both devices reach the same answer. It runs on a throwaway copy that keeps deleted content.
 */
export function findConflicts(base: Uint8Array, update: Uint8Array, check?: TextCheck): RawConflict[] {
  return compareSync(base, update, check).conflicts;
}

/**
 * `findConflicts`, and for text layers that both devices edited while apart (`check`, only for a catch-up after
 * being apart) the text each should keep. Two edits that `textsClash` would leave both sides' words mixed
 * together, so the layer keeps one side's whole text: the one the layer's `text` field keeps, by the same rule
 * as every other value. Both devices find the same one. Equal texts need no note, only the fix.
 */
export function compareSync(base: Uint8Array, update: Uint8Array, check?: TextCheck): SyncComparison {
  const y = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(y, base);
    const nodes = y.getMap('nodes') as Y.Map<Y.Map<unknown>>;
    const tokens = y.getMap('tokens') as Y.Map<Y.Map<unknown>>;
    const before = Y.snapshot(y);
    const seen = new Map(before.sv);
    Y.applyUpdate(y, update);
    const out: RawConflict[] = [];
    const fixes: TextFix[] = [];
    const done = new Set<string>();
    for (const [client, structs] of y.store.clients) {
      const from = seen.get(client) ?? 0;
      for (const struct of structs) {
        if (struct.id.clock + struct.length <= from || !(struct instanceof Y.Item) || struct.parentSub === null) continue;
        const parent = struct.parent;
        if (!(parent instanceof Y.Map)) continue;
        const key = struct.parentSub;
        const holder = parent._item;
        if (!holder || holder.parentSub === null) continue;
        let raw: Pick<RawConflict, 'kind' | 'nodeId' | 'name' | 'field'> | null = null;
        if (holder.parent === nodes && FIELDS.has(key)) {
          raw = { kind: 'layer', nodeId: holder.parentSub, name: String((parent as Y.Map<unknown>).get('name') ?? ''), field: key };
        } else if (holder.parent === tokens && key === 'value') {
          raw = { kind: 'token', name: holder.parentSub, field: 'value' };
        } else if (holder.parentSub === 'style' && holder.parent instanceof Y.Map && holder.parent._item?.parent === nodes && holder.parent._item.parentSub) {
          raw = { kind: 'layer', nodeId: holder.parent._item.parentSub, name: String((holder.parent as Y.Map<unknown>).get('name') ?? ''), field: `style.${key}` };
        }
        if (!raw) continue;
        const where = `${raw.kind}:${raw.nodeId ?? raw.name}:${raw.field}`;
        if (done.has(where)) continue;
        done.add(where);
        // Walk the key's chain from the winner: the first new item is what the other side wrote last, the first old one is ours.
        const winner = parent._map.get(key);
        let newest: Y.Item | null = null;
        let oldest: Y.Item | null = null;
        for (let item: Y.Item | null = winner ?? null; item && (!newest || !oldest); item = item.left) {
          if (item.parentSub !== key) continue;
          const isNew = item.id.clock + item.length > (seen.get(item.id.client) ?? 0);
          if (isNew) newest ??= item;
          else oldest ??= item;
        }
        if (!newest || !oldest || newest.id.client === oldest.id.client) continue;
        // The other device already took our value over its own and dropped its own: it compared the two then, and
        // noted it. Its value is gone from what it sends, so a note here would only say "undefined".
        if (newest.content instanceof Y.ContentDeleted || oldest.content instanceof Y.ContentDeleted) continue;
        // Ours had already been removed before this update came.
        if (Y.isDeleted(before.ds, oldest.id)) continue;
        if (knew(newest, oldest, y.store)) continue;
        // Both sides typed in one text layer with a build that writes its CRDT text: that holds both edits.
        const layer = parent as Y.Map<unknown>;
        const rich = key === 'text' ? liveRich(layer) : null;
        if (rich && wroteMark(layer, newest.id.client) && wroteMark(layer, oldest.id.client)) {
          if (!check || !raw.nodeId) continue;
          const remoteSv = Y.decodeStateVector(check.remoteSv);
          if (!textsClash(rich, seen, before.ds, remoteSv, Y.decodeUpdate(update).ds)) continue;
          const ours = richTextAt(rich, before);
          const spansItem = newestNew(layer, 'spans', seen);
          const theirs: TextVersion = { text: String(valueOf(newest) ?? ''), spans: spansOf(spansItem ? valueOf(spansItem) : ours.spans) };
          const kept = winner === newest ? 'theirs' : 'ours';
          const keep = kept === 'ours' ? ours : theirs;
          fixes.push({ nodeId: raw.nodeId, text: keep.text, spans: keep.spans ?? [] });
          if (ours.text === theirs.text) continue;
          const whole = ours.text.length + theirs.text.length <= MAX_NOTE_TEXT;
          out.push({ ...raw, ours: text(ours.text), theirs: text(theirs.text), kept, ...(whole ? { texts: { ours, theirs } } : {}) });
          continue;
        }
        const theirs = valueOf(newest);
        const ours = valueOf(oldest);
        if (JSON.stringify(theirs) === JSON.stringify(ours)) continue;
        out.push({ ...raw, ours: text(ours), theirs: text(theirs), kept: winner === newest ? 'theirs' : 'ours' });
      }
    }
    return { conflicts: out, fixes };
  } finally {
    y.destroy();
  }
}

/** A note as the other device sees it: its value is ours, ours is its. */
export function fromTheOtherSide(c: RawConflict): RawConflict {
  return { ...c, ours: c.theirs, theirs: c.ours, kept: c.kept === 'ours' ? 'theirs' : 'ours', ...(c.texts ? { texts: { ours: c.texts.theirs, theirs: c.texts.ours } } : {}) };
}

/** The notes per file, in `$BOGEN_HOME/sync-conflicts.json`. They only inform: the merge has already happened. */
/** What makes two notes the same conflict: the same two values of one field. */
function sameConflict(c: RawConflict): string {
  return JSON.stringify([c.kind, c.nodeId ?? '', c.name, c.field, c.ours, c.theirs]);
}

export class SyncConflicts {
  private notes = new Map<string, SyncConflict[]>();
  /**
   * Notes a person dismissed, or kept as a branch, per file. Both devices can report one conflict, the other one's
   * report a moment later over the network: a report that arrives after the person dealt with the note is the same
   * note, and does not bring it back. Only this run: such reports are in flight, never kept for later.
   */
  private dismissed = new Map<string, Set<string>>();
  private write: Promise<void> = Promise.resolve();

  constructor(private readonly home: string, private readonly changed: (fileId: string) => void) {}

  private get path(): string {
    return join(this.home, 'sync-conflicts.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, SyncConflict[]>;
      for (const [id, list] of Object.entries(parsed)) if (Array.isArray(list)) this.notes.set(id, list);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: sync-conflicts.json was unreadable: ${errorMessage(e)}`);
    }
  }

  /** Keeps the notes, and returns them as kept: a note already there for the same two values is not added again. */
  add(fileId: string, device: string, found: RawConflict[]): SyncConflict[] {
    if (!found.length) return [];
    const list = this.notes.get(fileId) ?? [];
    const dismissed = this.dismissed.get(fileId);
    const out: SyncConflict[] = [];
    let added = false;
    for (const raw of found) {
      // The same two values reported again is the same conflict.
      const same = list.find((c) => c.field === raw.field && c.nodeId === raw.nodeId && c.name === raw.name && c.ours === raw.ours && c.theirs === raw.theirs);
      if (same) {
        out.push(same);
        continue;
      }
      if (dismissed?.has(sameConflict(raw))) continue;
      added = true;
      const note = { ...raw, id: newId(), fileId, device, at: Date.now() };
      list.unshift(note);
      out.push(note);
    }
    if (!added) return out;
    if (list.length > MAX_PER_FILE) list.length = MAX_PER_FILE;
    this.notes.set(fileId, list);
    void this.save();
    this.changed(fileId);
    return out;
  }

  get(fileId: string, id: string): SyncConflict | undefined {
    return this.notes.get(fileId)?.find((c) => c.id === id);
  }

  list(fileId: string): SyncConflict[] {
    return this.notes.get(fileId) ?? [];
  }

  all(): SyncConflict[] {
    return [...this.notes.values()].flat();
  }

  dismiss(fileId: string, id?: string): void {
    const list = this.notes.get(fileId);
    if (!list) return;
    const gone = this.dismissed.get(fileId) ?? new Set<string>();
    for (const c of list) if (!id || c.id === id) gone.add(sameConflict(c));
    while (gone.size > MAX_PER_FILE) gone.delete(gone.values().next().value!);
    this.dismissed.set(fileId, gone);
    const kept = id ? list.filter((c) => c.id !== id) : [];
    if (kept.length) this.notes.set(fileId, kept);
    else this.notes.delete(fileId);
    void this.save();
    this.changed(fileId);
  }

  forget(fileId: string): void {
    this.dismissed.delete(fileId);
    if (this.notes.delete(fileId)) void this.save();
  }

  /** Drops the notes of every file `keep` says no to. */
  prune(keep: (fileId: string) => boolean): void {
    let dropped = false;
    for (const id of [...this.dismissed.keys()]) if (!keep(id)) this.dismissed.delete(id);
    for (const id of [...this.notes.keys()]) if (!keep(id)) dropped = this.notes.delete(id) || dropped;
    if (dropped) void this.save();
  }

  private save(): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.notes));
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.path, body, 0o600));
    this.write.catch((e) => console.error(`bogen: could not save sync-conflicts.json: ${errorMessage(e)}`));
    return this.write;
  }

  flush(): Promise<void> {
    return this.write.catch(() => {});
  }
}
