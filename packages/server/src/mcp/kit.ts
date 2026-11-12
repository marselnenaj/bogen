import { currentBranchId, describeLayoutGrid, getDesignBranch, isLibraryParent, Y, type BogenDoc, type BogenNode, type RunIntent } from '@bogen/core';
import { draftFor, listRevisions, revisionCopyOf, revisionScope, type Revision } from '../revisions.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BogenServer } from '../http/server.ts';
import { agentOrigin, type Room } from '../sync.ts';
import { errorMessage } from '../util.ts';
import { brandAfterWrite, brandGuard } from './brand-enforce.ts';
import { OUTPUT_SCHEMAS } from './outputs.ts';

export interface Session {
  fileId?: string;
  pageByFile: Map<string, string>;
  agent: () => string;
  /** The run this session belongs to, when Bogen started the CLI itself. */
  runId?: string;
  /** A critique run reads and comments, and gets no other tool. */
  scope?: 'critique';
  /** The revision this session works in: writes outside its copies are refused. */
  revision?: { fileId: string; id: string };
  /**
   * The branch this session works on, per file: the one checked out when it first reached the file, moved only by its
   * own branch tools or file_open. A write after someone else checked out another branch is refused, never mixed in.
   */
  branchPins?: Map<string, string>;
}

/**
 * Which branch each MCP session last wrote to in a loaded file, and when: to keep one agent from switching another's
 * work away. By session, not by name: two clients that both call themselves codex-mcp-client are two agents.
 */
const branchActivity = new WeakMap<Room, Map<Session, { agent: string; branch: string; at: number }>>();
/** The rooms each session wrote to, so that a session that ended can leave them. */
const sessionRooms = new WeakMap<Session, Set<Room>>();

/**
 * A session that ended (its client closed, or its run ended or was stopped) works on no branch any more. Only
 * that session's entries go: another agent that is still writing keeps its branch busy.
 */
export function releaseSession(session: Session): void {
  for (const room of sessionRooms.get(session) ?? []) branchActivity.get(room)?.delete(session);
  sessionRooms.delete(session);
}
/** How long an agent's last write keeps its branch from being switched away by another agent. */
export const BRANCH_BUSY_MS = 10 * 60_000;

/** Other sessions that wrote to this branch of the file lately, by the names they go by. */
export function busyOnBranch(room: Room, branch: string, except: Session, now = Date.now()): string[] {
  const names = [...(branchActivity.get(room)?.entries() ?? [])].filter(([session, a]) => session !== except && a.branch === branch && now - a.at < BRANCH_BUSY_MS).map(([, a]) => a.agent);
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${c} sessions of ${n}` : n));
}

/** Tools that change something, and that a critique still gets: two that comment, and checks with their fixes turned off. */
const CRITIQUE_EXTRA = new Set(['comment_add', 'comment_reply', 'design_lint', 'brand_check', 'file_open']);
/** Of those, the ones that may write to a document. */
const CRITIQUE_WRITES = new Set(['comment_add', 'comment_reply']);

/**
 * Tools that reach past Bogen's own files: the network, a folder or program on this computer, or another person.
 * Their `openWorldHint` says so, and an agent in the browser (WebMCP) asks the person before each call of one.
 */
export const OPEN_WORLD_TOOLS = new Set([
  'asset_upload', 'brand_extract', 'code_project_link', 'data_source_refresh', 'data_source_set', 'drift_check', 'export_file',
  'figma_import', 'layer_repeat', 'omarchy_theme_export', 'omarchy_theme_install', 'page_capture', 'publish_prepare', 'replay_export',
  'share_prepare', 'site_capture', 'site_restyle', 'storybook_import', 'tokens_repo_diff', 'tokens_repo_pull', 'tomacco_compare', 'tomacco_import', 'tomacco_status',
]);

/** Tools that manage revisions themselves, and so are not held to the open one's scope. */
const REVISION_TOOLS = new Set(['revision_start', 'revision_accept', 'revision_discard', 'comment_add', 'comment_reply']);

/** The layers a Yjs transaction touched: added, removed, or with a field, style or rule changed. */
export function touchedLayers(doc: BogenDoc, tr: Y.Transaction): string[] {
  const out = new Set<string>();
  const nodes = doc.nodes as unknown;
  for (const [type, keys] of tr.changed) {
    if ((type as unknown) === nodes) {
      for (const k of keys) if (k) out.add(k);
      continue;
    }
    let t = type as { _item: { parent: unknown; parentSub: string | null } | null } | null;
    while (t?._item && t._item.parent !== nodes) t = t._item.parent as typeof t;
    const key = t?._item?.parentSub;
    if (t?._item && key) out.add(key);
  }
  return [...out];
}

/** File-wide state a Yjs transaction changed: tokens, text styles, modes, variables, or a meta key such as keyframes. */
export function touchedShared(doc: BogenDoc, tr: Y.Transaction): string[] {
  const roots: [unknown, string][] = [[doc.tokens, 'tokens'], [doc.textStyles, 'text styles'], [doc.modes, 'modes'], [doc.variables, 'variables']];
  const meta = doc.meta as unknown;
  const out = new Set<string>();
  for (const [type, keys] of tr.changed) {
    let t = type as unknown as { _item: { parent: unknown; parentSub: string | null } | null };
    while (t._item && t._item.parent && (t._item.parent as unknown) !== meta && !roots.some(([r]) => r === t._item!.parent)) t = t._item.parent as typeof t;
    const root = (type as unknown) === meta ? meta : t._item?.parent;
    const named = roots.find(([r]) => r === root || r === (type as unknown));
    if (named) {
      out.add(named[1]);
      continue;
    }
    if (root === meta) {
      const changed = (type as unknown) === meta ? [...keys].filter(Boolean) as string[] : [t._item?.parentSub ?? ''];
      // The revision records themselves are the one meta key a revision changes.
      for (const k of changed) if (k && k !== 'revisions') out.add(k === 'keyframes' ? 'keyframes' : `file setting "${k}"`);
    }
  }
  return [...out];
}

/** Whether a session of this scope gets the tool at all. */
export function inScope(scope: Session['scope'], name: string, readOnly: boolean | undefined): boolean {
  return scope !== 'critique' || Boolean(readOnly) || CRITIQUE_EXTRA.has(name);
}

export const fileIdArg = z.string().optional().describe('The file. Defaults to the file last opened in this session, then the file the person has open.');
export const pageIdArg = z.string().optional().describe('The page. Defaults to the page last used in this session, then the page the person is on, then the first page.');

/** What one tool call can reach. Collects what it touched, for presence and the activity feed. */
export class ToolContext {
  readonly agent: string;
  private rooms = new Set<Room>();
  wrote = false;
  /** Only editor-space placement/annotations changed, not the design inside a screen. */
  canvasOnly = false;
  nodeIds: string[] | undefined;
  pageId: string | undefined;
  lastRoom: Room | undefined;
  /** Inside a `batch` with `dry_run`: nothing may cost money or reach the network. */
  readonly dryRun: boolean = false;

  constructor(readonly app: BogenServer, readonly session: Session, readonly tool: string, readonly signal?: AbortSignal) {
    this.agent = session.agent();
  }

  /** The most recently active room with a person in it. */
  private humanRoom(): Room | undefined {
    let best: Room | undefined;
    let bestSeen = -1;
    for (const room of this.app.rooms.loaded()) {
      const person = room.humans()[0];
      if (person && person.lastSeen > bestSeen) {
        best = room;
        bestSeen = person.lastSeen;
      }
    }
    return best;
  }

  /** The file a call means, following the defaults in `fileIdArg`. */
  fileId(fileId?: string): string {
    const id = fileId ?? this.session.fileId ?? this.humanRoom()?.id;
    if (id) return id;
    const files = this.app.storage.list();
    if (files.length === 1) return files[0]!.id;
    if (!files.length) throw new Error('There are no files yet. Call file_create.');
    throw new Error('No file is open. Call file_list and then file_open, or pass file_id.');
  }

  async room(fileId?: string): Promise<Room> {
    const id = this.fileId(fileId);
    const room = await this.app.rooms.get(id);
    if (!this.rooms.has(room)) {
      this.rooms.add(room);
      room.agentStarted(this.agent, this.tool, this.session.runId);
    }
    // Looking something up in a brand must not move later writes off the file being worked on.
    if (this.app.storage.get(id)?.kind !== 'brand') this.session.fileId = id;
    this.lastRoom = room;
    this.branchOf(room);
    return room;
  }

  /** The branch this session works on in a file, pinned the first time it reaches the file. */
  branchOf(room: Room): string {
    const pins = (this.session.branchPins ??= new Map());
    let pin = pins.get(room.id);
    if (!pin) {
      pin = currentBranchId(room.doc);
      pins.set(room.id, pin);
    }
    return pin;
  }

  /** Moves this session onto a branch, after its own branch tool or file_open. */
  pinBranch(room: Room, branch: string): void {
    (this.session.branchPins ??= new Map()).set(room.id, branch);
  }

  /** Refuses a write when the file was checked out to another branch since this session started on its own. */
  private assertOnBranch(room: Room): void {
    // A file brought into a theme project as a branch is kept as it was: its work continues in that branch.
    const into = room.doc.meta.get('consolidatedInto') as { fileId?: string; branchId?: string } | undefined;
    if (into?.fileId && this.app.storage.get(into.fileId)) throw new Error(`This file was brought into the theme ${this.app.storage.get(into.fileId)!.name} (${into.fileId}) as its branch ${into.branchId}, and is kept as it was. Nothing was changed. Continue there: file_open ${into.fileId}, then design_branch_switch ${into.branchId} if the person wants that version.`);
    const pinned = this.branchOf(room);
    const live = currentBranchId(room.doc);
    if (pinned === live) return;
    const name = (id: string) => {
      try {
        return getDesignBranch(room.doc, id).name;
      } catch {
        return id;
      }
    };
    throw new Error(`Since you started on the branch "${name(pinned)}" (${pinned}) of this file, it was switched to "${name(live)}" (${live}). Nothing was changed: your edits were meant for "${name(pinned)}", and they would have gone into "${name(live)}". Tell the person, or call file_open to continue on "${name(live)}" on purpose. design_branch_list shows the branches.`);
  }

  /** A page that exists, following the defaults in `pageIdArg`. Remembers it for later calls. */
  page(room: Room, pageId?: string): string {
    if (pageId) {
      if (!room.doc.pages.has(pageId)) throw new Error(`No page with id ${pageId}. Call page_list.`);
    } else {
      const remembered = this.session.pageByFile.get(room.id);
      const human = room.humans().find((h) => h.pageId && room.doc.pages.has(h.pageId))?.pageId;
      pageId = remembered && room.doc.pages.has(remembered) ? remembered : human ?? room.doc.getPages()[0]!.id;
    }
    this.session.pageByFile.set(room.id, pageId);
    this.pageId = pageId;
    return pageId;
  }

  /**
   * The draft revision this call works in, if any: the one the session started, or the one its conversation has open
   * in this file. Found again from the file, so a follow-up run continues where the last one stopped.
   */
  revision(room: Room): Revision | undefined {
    const bound = this.session.revision;
    if (bound && bound.fileId === room.id) {
      const rev = listRevisions(room.doc).find((r) => r.id === bound.id);
      if (rev?.status === 'draft') return rev;
      delete this.session.revision;
      return undefined;
    }
    // The revision the server opened for this run before it started, or the one its conversation has open.
    const runId = this.session.runId;
    const opened = runId ? this.app.runs.revisionOf(runId) : undefined;
    const conversation = runId ? this.app.runs.conversationOf(runId) : undefined;
    const open = (opened ? listRevisions(room.doc).find((r) => r.id === opened && r.status === 'draft') : undefined) ?? draftFor(room.doc, conversation);
    if (open) this.session.revision = { fileId: room.id, id: open.id };
    return open;
  }

  /** What the run that owns this session was started for; undefined outside a run. */
  runIntent(): RunIntent | undefined {
    return this.session.runId ? this.app.runs.intentOf(this.session.runId) : undefined;
  }

  /** Runs edits as one undoable step attributed to this agent. */
  write<T>(room: Room, fn: () => T): T {
    if (this.session.scope === 'critique' && !CRITIQUE_WRITES.has(this.tool)) throw new Error('This run is a critique: it reads and comments, and changes nothing. Leave a comment with your suggestion instead.');
    this.assertOnBranch(room);
    let activity = branchActivity.get(room);
    if (!activity) branchActivity.set(room, (activity = new Map()));
    activity.set(this.session, { agent: this.agent, branch: currentBranchId(room.doc), at: Date.now() });
    let rooms = sessionRooms.get(this.session);
    if (!rooms) sessionRooms.set(this.session, (rooms = new Set()));
    rooms.add(room);
    const manager = room.undoManagerFor(this.agent);
    this.wrote = true;
    const rev = REVISION_TOOLS.has(this.tool) ? undefined : this.revision(room);
    if (!rev || rev.intent === 'new_page') return room.doc.transact(fn, agentOrigin(this.agent));
    // Inside a revision: every layer this call touches must be one of its copies, or new inside one.
    const allowed = revisionScope(room.doc, rev);
    const touched = new Set<string>();
    const shared = new Set<string>();
    const watch = (tr: Y.Transaction) => {
      for (const id of touchedLayers(room.doc, tr)) touched.add(id);
      for (const s of touchedShared(room.doc, tr)) shared.add(s);
    };
    room.doc.y.on('afterTransaction', watch);
    let out: T;
    try {
      out = room.doc.transact(fn, agentOrigin(this.agent));
    } finally {
      room.doc.y.off('afterTransaction', watch);
    }
    // Tokens, text styles, modes, variables and keyframes belong to the whole file: changing them would change the
    // original and every other artboard too. Inside a revision a colour or size changes on the copy itself, for
    // instance as a custom property on its root (--accent: …), which reaches only the copy and goes with it on accept.
    if (shared.size) {
      if (manager.canUndo()) manager.undo();
      throw new Error(`This run works in the revision "${rev.name}" (${rev.id}), and ${[...shared].join(', ')} ${shared.size === 1 ? 'is' : 'are'} shared by the whole file, so changing ${shared.size === 1 ? 'it' : 'them'} would change the original too. Nothing was changed. Set the value on the copy instead: layer_style on its root with a custom property such as {"--accent":"#b4410c"}, or on the layers themselves. Token changes can follow once the revision is accepted.`);
    }
    const outside = [...touched].filter((id) => !allowed.has(id) && !(room.doc.nodes.has(id) && room.doc.ancestors(id).some((a) => allowed.has(a))));
    if (outside.length) {
      // Taken back as the one step it was (captureTimeout 0), before anyone else sees a half-applied change.
      if (manager.canUndo()) manager.undo();
      const copyOf = revisionCopyOf(room.doc, rev);
      const hints = outside.slice(0, 4).map((id) => (copyOf.get(id) ? `${id} is the original; its copy in this revision is ${copyOf.get(id)}` : `${id} is outside the revision`));
      throw new Error(`This run works in the revision "${rev.name}" (${rev.id}) and changes only its copies: ${hints.join('; ')}. Nothing was changed. Use the copy ids (revision_list shows them), or the person accepts or discards the revision first.`);
    }
    return out!;
  }

  touch(ids: string[]): void {
    this.nodeIds = ids;
  }

  finish(): void {
    for (const room of this.rooms) {
      room.agentFinished(this.agent, this.nodeIds, this.pageId);
      if (this.wrote) this.app.hub.broadcast({ t: 'activity', fileId: room.id, agent: this.agent, tool: this.tool, nodeIds: this.nodeIds ?? [], at: Date.now(), ...(this.canvasOnly ? { canvasOnly: true } : {}), ...(this.session.runId ? { runId: this.session.runId } : {}) });
    }
  }
}

type ToolOutput = string | object | CallToolResult;

export function isToolResult(out: ToolOutput): out is CallToolResult {
  return typeof out === 'object' && out !== null && Array.isArray((out as CallToolResult).content);
}

export type ToolHandler = (args: never, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput;

export interface ToolDefiner {
  <S extends z.ZodRawShape>(
    name: string,
    meta: { description: string; readOnly?: boolean; destructive?: boolean },
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput,
  ): void;
  /** What has been defined so far, so that `batch` can run a tool as a step. */
  tools: Map<string, { shape: z.ZodRawShape; handler: ToolHandler }>;
}

/** Registers tools with uniform errors, presence and activity reporting. */
export function toolDefiner(server: McpServer, app: BogenServer, session: Session): ToolDefiner {
  const define = ((name, meta, shape, handler) => {
    // Not even listed: a critique cannot call what it never sees, and a batch of them is not there either.
    if (!inScope(session.scope, name, meta.readOnly)) return;
    define.tools.set(name, { shape, handler: handler as never });
    const output = OUTPUT_SCHEMAS[name];
    const callback = async (args: unknown, extra?: { signal?: AbortSignal }): Promise<CallToolResult> => {
      const ctx = new ToolContext(app, session, name, extra?.signal);
      try {
        if (session.scope === 'critique' && (args as { fix?: unknown }).fix === true) throw new Error('This run is a critique and fixes nothing. Leave a comment with the fix as its suggestion.');
        const guard = meta.readOnly ? null : await brandGuard(ctx, name, args as { file_id?: string });
        const out = meta.readOnly ? await handler(args as never, ctx) : await brandAfterWrite(ctx, name, guard, await handler(args as never, ctx));
        if (isToolResult(out)) return out;
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
        // A tool with an output schema also returns its result as fields, as the protocol asks of it.
        if (output && typeof out === 'object' && !Array.isArray(out)) return { content: [{ type: 'text', text }], structuredContent: out as Record<string, unknown> };
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: errorMessage(e) }] };
      } finally {
        ctx.finish();
      }
    };
    server.registerTool(name, {
      description: meta.description,
      inputSchema: shape,
      ...(output ? { outputSchema: output } : {}),
      annotations: { readOnlyHint: Boolean(meta.readOnly), destructiveHint: Boolean(meta.destructive), openWorldHint: OPEN_WORLD_TOOLS.has(name) },
    }, callback as never);
  }) as ToolDefiner;
  define.tools = new Map();
  return define;
}

/** Agents respect what the person has locked. A layer is locked if it or any ancestor is. */
export function assertUnlocked(doc: BogenDoc, ids: string[]): void {
  for (const id of ids) {
    const node = doc.getNode(id);
    if (!node) throw new Error(`No layer with id ${id}. Ids change when html_write replaces a layer: call layer_tree or layer_find for the ones that exist now.`);
    if (doc.pageOf(id) === undefined && isLibraryParent(doc.ancestors(id).map((a) => doc.rawNode(a)?.parent).at(-1) ?? node.parent)) {
      throw new Error(`Layer ${id} is part of a copy of a shared library component. Change it in the library's file and publish it there, then library_accept here; or override it on an instance.`);
    }
    const lockedBy = [id, ...doc.ancestors(id)].find((a) => doc.getNode(a)?.locked);
    if (lockedBy) throw new Error(`Layer ${id} is locked${lockedBy === id ? '' : ` by its ancestor ${lockedBy}`}. Leave it alone unless the person asked you to change it; layer_set_flags can unlock it.`);
  }
}

const SIZE_PROPS = ['display', 'flexDirection', 'width', 'height', 'position', 'left', 'top'] as const;

function nodeLine(node: BogenNode): string {
  const parts = [`${node.id} ${node.type} <${node.tag}> "${node.name.replace(/\s+/g, ' ').slice(0, 60)}"`];
  const facts = SIZE_PROPS.filter((k) => node.style[k]).map((k) => `${k}:${node.style[k]}`);
  if (facts.length) parts.push(`[${facts.join(' ')}]`);
  if (node.type === 'text' && node.text) parts.push(`text=${JSON.stringify(node.text.slice(0, 60))}`);
  if (node.component) parts.push(`main${node.component.set ? ` of set "${node.component.set}"` : ''}`);
  if (node.instanceOf) parts.push(`instance of ${node.instanceOf}`);
  if (node.virtual && !node.instanceOf) parts.push('inside instance');
  if (node.slotName !== undefined) parts.push(`slot "${node.slotName}"`);
  if (node.mode) parts.push(`mode ${node.mode}`);
  if (node.textStyle) parts.push(`text style ${node.textStyle}`);
  // Only which blocks there are: layer_get has their declarations.
  if (node.rules) {
    const blocks = Object.keys(node.rules);
    parts.push(`rules {${blocks.slice(0, 4).join(', ')}${blocks.length > 4 ? `, +${blocks.length - 4}` : ''}}`);
  }
  if (node.artboard) parts.push('artboard');
  if (node.layoutGrids) parts.push(`grids: ${node.layoutGrids.map(describeLayoutGrid).join('; ')}`);
  if (node.hidden) parts.push('hidden');
  if (node.locked) parts.push('locked');
  return parts.join(' ');
}

/** A compact indented outline. Below the depth limit it counts what it leaves out. */
export function outline(doc: BogenDoc, rootIds: string[], depth: number, maxLines = 400): string {
  const lines: string[] = [];
  let cut = 0;
  const walk = (id: string, level: number) => {
    const node = doc.getNode(id);
    if (!node) return;
    if (lines.length >= maxLines) {
      cut++;
      return;
    }
    const pad = '  '.repeat(level);
    lines.push(pad + nodeLine(node));
    const children = doc.getChildren(id);
    if (!children.length) return;
    if (level + 1 >= depth) {
      lines.push(`${pad}  ... ${doc.descendants(id).length} more below`);
      return;
    }
    for (const c of children) walk(c.id, level + 1);
  };
  for (const id of rootIds) walk(id, 0);
  if (cut) lines.push(`... ${cut} more layers not shown; narrow it with node_id`);
  return lines.join('\n');
}

const PX = /^(-?\d+(?:\.\d+)?)px$/;

/** Next free spot to the right of a page's top-level layers. Read from styles, so no browser is needed. */
export function nextArtboardX(doc: BogenDoc, pageId: string, gap = 80): number {
  let right = 0;
  let any = false;
  for (const node of doc.getChildren(pageId)) {
    const left = PX.exec(node.style.left ?? '');
    const width = PX.exec(node.style.width ?? '');
    if (!left) continue;
    any = true;
    right = Math.max(right, Number(left[1]) + (width ? Number(width[1]) : 1440));
  }
  return any ? right + gap : 0;
}

/**
 * A free spot for a new artboard of `width` x `height` beside the top-level layer `nodeId` (or the one it is in):
 * to its right at the same top, moved further right past whatever is already there. Null when the layer has no
 * position, so the caller can fall back to {@link nextArtboardX}.
 */
export function besideArtboard(doc: BogenDoc, nodeId: string, width: number, height: number, gap = 80): { pageId: string; x: number; y: number } | null {
  const node = doc.getNode(nodeId);
  if (!node) return null;
  const top = [nodeId, ...doc.ancestors(nodeId)].flatMap((id) => doc.getNode(id) ?? []).find((n) => doc.pages.has(n.parent));
  if (!top) return null;
  const box = (n: { style: Record<string, string | undefined> }) => {
    const l = PX.exec(n.style.left ?? ''), t = PX.exec(n.style.top ?? ''), w = PX.exec(n.style.width ?? ''), h = PX.exec(n.style.height ?? '');
    return l ? { x: Number(l[1]), y: t ? Number(t[1]) : 0, w: w ? Number(w[1]) : 1440, h: h ? Number(h[1]) : 1024 } : null;
  };
  const self = box(top);
  if (!self) return null;
  const others = doc.getChildren(top.parent).filter((n) => n.id !== top.id).flatMap((n) => box(n) ?? []);
  let x = self.x + self.w + gap;
  const y = self.y;
  // Each pass moves past one layer in the way, so as many passes as layers always ends.
  for (let i = 0; i <= others.length; i++) {
    const hit = others.find((o) => o.x < x + width + gap && o.x + o.w + gap > x && o.y < y + height && o.y + o.h > y);
    if (!hit) break;
    x = hit.x + hit.w + gap;
  }
  return { pageId: top.parent, x, y };
}
