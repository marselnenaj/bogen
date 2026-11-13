import { camelCss, cssValueContains, selectLayers, Y, type BogenDoc, type BogenNode, type NodeType } from '@bogen/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BogenServer } from '../http/server.ts';
import { DEFAULT_LIMITS, runScript, ScriptStop } from '../script-sandbox.ts';
import type { Room } from '../sync.ts';
import { errorMessage } from '../util.ts';
import { brandGuard, strictRefusal } from './brand-enforce.ts';
import { assertUnlocked, fileIdArg, isToolResult, type Session, type ToolContext, type ToolDefiner } from './kit.ts';
import { ScratchContext, scratchCopy } from './tools-batch.ts';

const KINDS = ['frame', 'text', 'image', 'svg', 'shader', 'video', 'embed'] as const satisfies readonly NodeType[];
const READS = ['find', 'get', 'children', 'pages', 'tokens', 'components'] as const;
const WRITES = ['setStyle', 'setText', 'setAttrs', 'rename', 'create', 'move', 'bind', 'remove', 'duplicate'] as const;
const METHODS: readonly string[] = [...READS, ...WRITES];

/** Layers one run may add, so that a loop of duplicates cannot grow a file past what anyone can open. */
const MAX_NEW_LAYERS = 10_000;
/** What the write calls of one run may send in all, as JSON. */
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
/** The finished difference, as a Yjs update. */
const MAX_UPDATE_BYTES = 16 * 1024 * 1024;
const MAX_IDS = 500;
const MAX_FIND = 5000;
const SHOWN_CHANGES = 200;

export const SCRIPT_DESCRIPTION = `Run JavaScript you write against the open file, for edits that would take many calls: renaming every button, binding colours to tokens across a page, building a grid from data. The script runs isolated (QuickJS in WebAssembly, no network, files, timers or Node) and reaches the document only through \`bogen\`. All its changes are applied at the end as one atomic step that one agent_undo takes back; if it throws or hits a limit, nothing is applied and the result says why. dry_run true runs it the same way and returns the planned changes without applying them. Locked layers, the brand's strict mode and an open revision hold as for every other tool.

API, synchronous, JSON values only. A target is an id, a layer from find or get, or a list of either.
Read: bogen.find({name, text, kind, tag, selector, style, within, limit}) gives layers {id, name, kind, tag, parent, page, children, text, style, rules, attrs, src, locked, hidden, artboard, component, instanceOf, textStyle}; name and text match anywhere ignoring case, selector is CSS over the layer tree ("section > h2", "button:not([disabled])", "#id"), within is a page or layer id. bogen.get(id), bogen.children(id), bogen.pages(), bogen.tokens(), bogen.components().
Write: bogen.setStyle(target, {prop: value|null}, {pseudo, when}?), setText(target, text), setAttrs(target, {name: value|null}), rename(target, name), create(html, {parent, mode: "append"|"prepend"|"into"|"replace", index}) returns the new ids (the same sanitizer as html_write), move(target, {parent, index, x, y}), bind(target, {prop: "token-name"}) sets var(--token-name) after checking the token exists, remove(target), duplicate(target) returns the copies' ids. Errors are exceptions you may catch. console.log goes to logs; return a JSON value for result.

Examples:
// Bulk rename, in tree order:
bogen.find({ tag: "button" }).forEach((b, i) => bogen.rename(b, "Button / " + (i + 1)));
// Every button's colours from tokens:
bogen.bind(bogen.find({ selector: "button" }), { backgroundColor: "accent", color: "on-accent" });
// A grid of cards from data, into an artboard:
const plans = [{ name: "Solo", price: "9 EUR" }, { name: "Team", price: "29 EUR" }, { name: "Studio", price: "79 EUR" }];
const [grid] = bogen.create('<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px"></div>', { parent: "<artboard id>" });
for (const p of plans) bogen.create("<article><h3>" + p.name + "</h3><p>" + p.price + " a month</p></article>", { parent: grid });
return bogen.children(grid).length;

Limits: ${DEFAULT_LIMITS.timeMs / 1000} s by default (timeout_ms up to 30 s), ${DEFAULT_LIMITS.memoryBytes / 1024 / 1024} MB, ${DEFAULT_LIMITS.maxCalls} bogen calls, ${MAX_NEW_LAYERS} new layers and ${DEFAULT_LIMITS.maxOutputBytes / 1024} KB of return value per run. For one or two changes, call the tool itself; for a few dependent ones, batch.`;

type Target = string[];

/** What a script sees of a layer: its design, not the device-local or internal fields (code links, prototype state). */
function view(doc: BogenDoc, node: BogenNode) {
  return {
    id: node.id, name: node.name, kind: node.type, tag: node.tag, parent: node.parent, page: doc.pageOf(node.id) ?? null,
    children: doc.getChildren(node.id).map((c) => c.id),
    ...(node.text !== undefined ? { text: node.text } : {}),
    style: { ...node.style },
    ...(node.rules ? { rules: node.rules } : {}),
    ...(node.attrs ? { attrs: { ...node.attrs } } : {}),
    ...(node.src ? { src: node.src } : {}),
    ...(node.locked ? { locked: true } : {}),
    ...(node.hidden ? { hidden: true } : {}),
    ...(node.artboard ? { artboard: true } : {}),
    ...(node.component ? { component: { set: node.component.set ?? null, variant: node.component.variant ?? null } } : {}),
    ...(node.instanceOf ? { instanceOf: node.instanceOf, props: node.props ?? {} } : {}),
    ...(node.textStyle ? { textStyle: node.textStyle } : {}),
  };
}

const findQuery = z.object({
  name: z.string().optional(),
  text: z.string().optional(),
  kind: z.enum(KINDS).optional(),
  tag: z.string().optional(),
  selector: z.string().max(500).optional(),
  style: z.record(z.string(), z.string()).optional(),
  within: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_FIND).default(1000),
}).strict();

const styleOptions = z.object({ pseudo: z.string().optional(), when: z.string().optional() }).strict();
const createOptions = z.object({
  parent: z.string().optional(),
  mode: z.enum(['append', 'prepend', 'into', 'replace']).default('append'),
  index: z.number().int().min(0).optional(),
}).strict();
const moveOptions = z.object({
  parent: z.string().optional(),
  index: z.number().int().min(0).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
}).strict();

interface Planned { op: string; ids: string[]; [k: string]: unknown }

/** One run: the private copy, what the script has done to it so far, and the budget it has left. */
class ScriptRun {
  readonly doc: BogenDoc;
  readonly changes: Planned[] = [];
  readonly warnings = new Set<string>();
  readonly touched = new Set<string>();
  writeBytes = 0;
  readonly startLayers: number;

  constructor(private readonly define: ToolDefiner, private readonly app: BogenServer, private readonly session: Session, private readonly ctx: ToolContext, readonly scratch: Room, readonly y: Y.Doc) {
    this.doc = scratch.doc;
    this.startLayers = this.doc.nodes.size;
  }

  private layer(id: unknown): BogenNode {
    if (typeof id !== 'string') throw new Error('A layer id is a string.');
    const node = this.doc.getNode(id);
    if (!node) throw new Error(`No layer with id ${id}. Ids change when a layer is replaced: find it again.`);
    return node;
  }

  /** An id, a layer object, or a list of either, as existing layer ids. */
  private targets(value: unknown): Target {
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) throw new Error('No layers given.');
    if (list.length > MAX_IDS) throw new Error(`At most ${MAX_IDS} layers per call; split the list.`);
    return [...new Set(list.map((v) => {
      const id = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : undefined;
      if (id === undefined) throw new Error('A target is a layer id, a layer from find or get, or a list of them.');
      return this.layer(id).id;
    }))];
  }

  private parentOf(value: unknown): string {
    const id = typeof value === 'string' ? value : value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') throw new Error('parent is a layer id, a page id or a layer.');
    if (this.doc.pages.has(id)) return id;
    return this.layer(id).id;
  }

  /** Runs a write tool on the copy, as batch does. A call that throws after it changed something ends the run. */
  private async tool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.define.tools.get(tool);
    if (!entry) throw new Error(`${tool} is not available in this session.`);
    // Offline, like a dry run: no images fetched or stored, no network, whether or not this run is applied.
    const stepCtx = new ScratchContext(this.app, this.session, tool, this.scratch, true, this.ctx.signal);
    let changed = false;
    const watch = (tr: Y.Transaction) => {
      if (tr.changed.size || tr.deleteSet.clients.size) changed = true;
    };
    this.y.on('afterTransaction', watch);
    try {
      const out = await entry.handler(z.object(entry.shape).parse(args) as never, stepCtx);
      for (const id of stepCtx.nodeIds ?? []) this.touched.add(id);
      return isToolResult(out as never) ? null : out;
    } catch (e) {
      const message = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') : errorMessage(e);
      if (changed) throw new ScriptStop(`A ${tool} call failed after it had changed part of the copy, so the run stops and nothing is applied: ${message}`);
      throw new Error(message);
    } finally {
      this.y.off('afterTransaction', watch);
    }
  }

  private budget(args: unknown[]): void {
    this.writeBytes += JSON.stringify(args).length;
    if (this.writeBytes > MAX_WRITE_BYTES) throw ScriptStop.limit('changes', `The write calls sent more than ${MAX_WRITE_BYTES / 1024 / 1024} MB in all.`);
  }

  private grew(): void {
    const added = this.doc.nodes.size - this.startLayers;
    if (added > MAX_NEW_LAYERS) throw ScriptStop.limit('changes', `It added ${added} layers; one run may add ${MAX_NEW_LAYERS}.`);
  }

  private plan(op: string, ids: string[], details: Record<string, unknown> = {}): void {
    this.changes.push({ op, ids, ...details });
  }

  async call(name: string, args: unknown[]): Promise<unknown> {
    const doc = this.doc;
    switch (name) {
      case 'find': {
        const q = findQuery.parse(args[0] ?? {});
        const roots = q.within ? [this.parentOf(q.within)] : undefined;
        let pool: BogenNode[];
        if (q.selector !== undefined) {
          // Matching runs on the server's own thread, so a selector that nests :has would cost the time of everyone.
          if ((q.selector.match(/:has\(/gi) ?? []).length > 1) throw new Error('A selector may use :has() once. Filter the layers it finds in the script for the rest.');
          let ids: string[];
          try {
            ids = selectLayers(doc, q.selector, roots);
          } catch (e) {
            throw new Error(`The selector ${JSON.stringify(q.selector)} does not parse: ${errorMessage(e)}`);
          }
          pool = ids.flatMap((id) => doc.getNode(id) ?? []);
        } else pool = (roots ?? doc.getPages().map((p) => p.id)).flatMap((id) => doc.descendants(id));
        const wanted = Object.entries(q.style ?? {}).map(([k, v]) => [camelCss(k), v] as const);
        const hits = pool.filter((n) => {
          if (q.kind && n.type !== q.kind) return false;
          if (q.tag && n.tag !== q.tag.toLowerCase()) return false;
          if (q.name && !n.name.toLowerCase().includes(q.name.toLowerCase())) return false;
          if (q.text && !(n.text ?? '').toLowerCase().includes(q.text.toLowerCase())) return false;
          return wanted.every(([k, v]) => n.style[k] !== undefined && cssValueContains(n.style[k], v));
        });
        return hits.slice(0, q.limit).map((n) => view(doc, n));
      }
      case 'get': {
        const node = typeof args[0] === 'string' ? doc.getNode(args[0]) : undefined;
        return node ? view(doc, node) : null;
      }
      case 'children': {
        const id = this.parentOf(args[0]);
        return doc.getChildren(id).map((n) => view(doc, n));
      }
      case 'pages':
        return doc.getPages().map((p) => ({ id: p.id, name: p.name, layers: doc.getChildren(p.id).map((c) => c.id) }));
      case 'tokens':
        return doc.getTokens();
      case 'components': {
        const out = await this.tool('component_list', {}) as { components?: unknown[] } | null;
        return out?.components ?? [];
      }
    }
    // Writes from here on.
    this.budget(args);
    switch (name) {
      case 'setStyle': {
        const ids = this.targets(args[0]);
        const style = z.record(z.string(), z.string().nullable()).parse(args[1]);
        const opts = styleOptions.parse(args[2] ?? {});
        for (let i = 0; i < ids.length; i += 200) await this.tool('layer_style', { node_ids: ids.slice(i, i + 200), style, ...opts });
        this.plan('setStyle', ids, { style, ...opts });
        return ids.length;
      }
      case 'bind': {
        const ids = this.targets(args[0]);
        const map = z.record(z.string(), z.string().min(1)).parse(args[1]);
        const tokens = new Set(doc.getTokens().map((t) => t.name));
        const style: Record<string, string> = {};
        for (const [prop, raw] of Object.entries(map)) {
          const token = raw.replace(/^var\(\s*--|^--|\s*\)$/g, '');
          if (!tokens.has(token)) throw new Error(`There is no token "${token}". bogen.tokens() lists the ${tokens.size} there are.`);
          style[prop] = `var(--${token})`;
        }
        for (let i = 0; i < ids.length; i += 200) await this.tool('layer_style', { node_ids: ids.slice(i, i + 200), style });
        this.plan('bind', ids, { style });
        return ids.length;
      }
      case 'setText': {
        const ids = this.targets(args[0]);
        const text = z.string().max(100_000).parse(args[1]);
        for (const id of ids) await this.tool('layer_text', { node_id: id, text });
        this.plan('setText', ids, { text: text.slice(0, 200) });
        return ids.length;
      }
      case 'setAttrs': {
        const ids = this.targets(args[0]);
        const attrs = z.record(z.string(), z.string().nullable()).parse(args[1]);
        for (const id of ids) await this.tool('layer_attrs', { node_id: id, attrs });
        this.plan('setAttrs', ids, { attrs });
        return ids.length;
      }
      case 'rename': {
        const ids = this.targets(args[0]);
        const label = z.string().min(1).max(200).parse(args[1]);
        // Stricter than layer_rename: a script does not rename what the person locked either.
        assertUnlocked(doc, ids);
        for (const id of ids) await this.tool('layer_rename', { node_id: id, name: label });
        this.plan('rename', ids, { name: label });
        return ids.length;
      }
      case 'create': {
        const html = z.string().min(1).parse(args[0]);
        const opts = createOptions.parse(args[1] ?? {});
        const target = opts.parent !== undefined ? this.parentOf(opts.parent) : undefined;
        const out = await this.tool('html_write', { html, mode: opts.mode, ...(target ? { target_id: target } : {}), ...(opts.index !== undefined ? { index: opts.index } : {}) }) as { ids: string[]; warnings?: string[] };
        for (const w of out.warnings ?? []) this.warnings.add(w);
        this.grew();
        this.plan('create', out.ids, { parent: target ?? null, mode: opts.mode, html: html.length > 200 ? `${html.slice(0, 200)}...` : html });
        return out.ids;
      }
      case 'move': {
        const ids = this.targets(args[0]);
        const opts = moveOptions.parse(args[1] ?? {});
        const parent = opts.parent !== undefined ? this.parentOf(opts.parent) : undefined;
        await this.tool('layer_move', { node_ids: ids, ...(parent ? { parent_id: parent } : {}), ...(opts.index !== undefined ? { index: opts.index } : {}), ...(opts.x !== undefined ? { x: opts.x } : {}), ...(opts.y !== undefined ? { y: opts.y } : {}) });
        this.plan('move', ids, { ...(parent ? { parent } : {}), ...(opts.index !== undefined ? { index: opts.index } : {}), ...(opts.x !== undefined ? { x: opts.x } : {}), ...(opts.y !== undefined ? { y: opts.y } : {}) });
        return ids.length;
      }
      case 'remove': {
        const ids = this.targets(args[0]);
        await this.tool('layer_delete', { node_ids: ids });
        for (const id of ids) this.touched.delete(id);
        this.plan('remove', ids);
        return ids.length;
      }
      case 'duplicate': {
        const ids = this.targets(args[0]);
        // Counted before the copy is made, so that one call cannot grow the file past the limit first.
        const adding = ids.reduce((sum, id) => sum + 1 + doc.descendants(id).length, 0);
        if (doc.nodes.size - this.startLayers + adding > MAX_NEW_LAYERS) throw ScriptStop.limit('changes', `Duplicating these would add ${adding} layers, past the ${MAX_NEW_LAYERS} one run may add.`);
        const out = await this.tool('layer_duplicate', { node_ids: ids.slice(0, 100) }) as { ids: string[] };
        const more = ids.length > 100 ? await this.tool('layer_duplicate', { node_ids: ids.slice(100) }) as { ids: string[] } : { ids: [] };
        this.grew();
        const copies = [...out.ids, ...more.ids];
        this.plan('duplicate', ids, { copies });
        return copies;
      }
    }
    throw new Error(`bogen.${name} does not exist.`);
  }
}

function failure(body: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 1) }] };
}

export function registerScriptTool(define: ToolDefiner, app: BogenServer, session: Session): void {
  define('script_run', { description: SCRIPT_DESCRIPTION }, {
    code: z.string().min(1).max(100_000).describe('The script body. It runs as a function: return a JSON value to get it back as result.'),
    dry_run: z.boolean().default(false).describe('Run it and return the planned changes, applying nothing.'),
    timeout_ms: z.number().int().min(100).max(30_000).default(DEFAULT_LIMITS.timeMs),
    file_id: fileIdArg,
  }, async ({ code, dry_run, timeout_ms, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const copy = scratchCopy(room);
    try {
      const run = new ScriptRun(define, app, session, ctx, copy.room, copy.y);
      const outcome = await runScript(code, METHODS, (name, args) => run.call(name, args), { ...DEFAULT_LIMITS, timeMs: timeout_ms }, ctx.signal);
      const changes = run.changes.slice(0, SHOWN_CHANGES);
      const report = {
        dry_run, calls: outcome.calls, ms: outcome.ms, logs: outcome.logs, ...(outcome.logsCut ? { logs_cut: true } : {}),
        changes, ...(run.changes.length > changes.length ? { changes_total: run.changes.length } : {}),
        ...(run.warnings.size ? { warnings: [...run.warnings] } : {}),
      };
      if (!outcome.ok) return failure({ ok: false, applied: false, error: `Nothing was applied. ${outcome.error}`, ...(outcome.limit ? { limit: outcome.limit } : {}), ...report });

      const guard = await brandGuard(ctx, 'script_run', { file_id: room.id });
      const refused = guard ? strictRefusal(guard, copy.room.doc) : null;
      if (refused) return failure({ ok: false, applied: false, error: refused, brand: guard!.data.fields.name, result: outcome.result, ...report });
      const update = Y.encodeStateAsUpdate(copy.y, copy.before);
      if (update.length > MAX_UPDATE_BYTES) return failure({ ok: false, applied: false, limit: 'changes', error: `Nothing was applied. The changes come to ${Math.round(update.length / 1024 / 1024)} MB, over the ${MAX_UPDATE_BYTES / 1024 / 1024} MB one run may apply.`, ...report });

      const summary = { layers_before: run.startLayers, layers_after: copy.room.doc.nodes.size, touched: [...run.touched].filter((id) => copy.room.doc.getNode(id)).slice(0, 500) };
      if (dry_run && run.changes.length) {
        // The same refusals the real write would give: the branch pin and an open revision's scope.
        try {
          ctx.preflight(room, update);
        } catch (e) {
          return failure({ ok: false, applied: false, error: errorMessage(e), result: outcome.result, ...report });
        }
      }
      if (dry_run || !run.changes.length) return { ok: true, applied: false, result: outcome.result, ...summary, ...report };
      // Through ctx.write, so that a revision's scope, the branch and a critique's limits hold as for any tool.
      try {
        ctx.write(room, () => Y.applyUpdate(room.doc.y, update));
      } catch (e) {
        return failure({ ok: false, applied: false, error: errorMessage(e), result: outcome.result, ...report });
      }
      ctx.touch(summary.touched.filter((id) => room.doc.getNode(id)));
      return { ok: true, applied: true, result: outcome.result, ...summary, ...report, next: 'Look at the result with canvas_screenshot. agent_undo takes the whole script back.' };
    } finally {
      copy.y.destroy();
    }
  });
}
