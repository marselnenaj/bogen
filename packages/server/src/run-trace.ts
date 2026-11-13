import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunEnd, RunObserver, RunRequest } from './agents.ts';
import type { EventHub } from './events.ts';
import { redactText } from './redact.ts';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * A trace of one run, for a bug report: what it was asked (the request, the conversation before it and the
 * instructions it got), every tool call with its arguments and result cut short, when each happened and how long it
 * took, and the layers it touched. Secrets are masked as in `bogen report`, the home folder is shown as `~`, and the
 * contents of files outside Bogen (the person's repository, read or written by a run) are left out: only their size
 * is kept. A trace is kept on this device, in `$BOGEN_HOME/traces/<runId>.json`, and only goes anywhere when the
 * person downloads it.
 */

export const TRACE_FORMAT = 'bogen-run-trace';
export const TRACE_VERSION = 1;

export interface TraceCall {
  /** Milliseconds since the run started. */
  t: number;
  ms: number;
  /** `bogen` for the canvas tools, `files` for the file tools of a run on a repository. */
  server: 'bogen' | 'files';
  tool: string;
  args: unknown;
  result: string;
  error?: boolean;
  layers?: string[];
}

export interface TraceEvent { t: number; kind: 'text' | 'tool' | 'error' | 'model' | 'nudge'; text?: string; tool?: string }

export interface RunTrace {
  format: typeof TRACE_FORMAT;
  version: typeof TRACE_VERSION;
  runId: string;
  fileId: string;
  fileName?: string;
  runner: string;
  model?: string;
  effort?: string;
  actualModel?: string;
  review?: string;
  source: 'prompt' | 'comment' | 'race' | 'live';
  conversationId?: string;
  threadId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: 'running' | 'done' | 'failed' | 'stopped';
  error?: string;
  prompt: { request: string; title?: string; context?: string; instructions?: string; nodeIds: string[]; pageId?: string };
  calls: TraceCall[];
  events: TraceEvent[];
  /** Layers it created or changed, in the order it first touched them. */
  layers: string[];
  /** Files it wrote in a repository, as paths relative to the project. */
  files?: string[];
  /** How much was left out to keep the trace small. */
  cut: { calls: number; events: number; layers: number };
  redaction: string;
}

const LIMITS = { calls: 600, events: 400, layers: 400, arg: 2000, result: 4000, text: 2000, prompt: 20_000, context: 12_000, instructions: 24_000 };
const KEEP = 200;
const RUN_ID = /^[\w-]{1,40}$/;
/** Keys whose value is a credential. Narrower than the report's list: design tokens and code are design data here. */
const SECRET_KEY = /^(token|secret|password|passwd|passphrase|api[_-]?key|private[_-]?key|cookie|set-cookie|authorization|bearer[_-]?token|access[_-]?token)$/i;
/** File tools whose results or arguments are the person's own files, outside Bogen. */
const FILE_CONTENT_ARGS: Record<string, string[]> = { write_file: ['content'], edit_file: ['old_text', 'new_text'] };
const FILE_CONTENT_RESULTS = new Set(['read_file', 'search']);
/** Bogen tools that return what they read from the person's disk, outside Bogen's own data. */
const OUTSIDE_RESULTS = new Set(['code_get', 'tokens_repo_diff']);
export const REDACTION_NOTE = 'Secrets are masked by pattern, the home folder is ~, and the contents of files outside Bogen are left out, with their size. Read it before you share it.';

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

/** A value made safe for a trace: secrets masked, strings cut, at most a few levels deep. */
export function traceValue(value: unknown, max = LIMITS.arg, home = homedir(), depth = 0): unknown {
  if (typeof value === 'string') return cut(redactText(value, home), max);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[deeper values left out]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => traceValue(v, max, home, depth + 1));
    return value.length > 50 ? [...items, `[${value.length - 50} more items]`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const empty = item === null || item === undefined || item === '' || typeof item === 'boolean' || typeof item === 'number';
    out[key] = SECRET_KEY.test(key) && !empty ? '[redacted]' : traceValue(item, max, home, depth + 1);
  }
  return out;
}

/** The arguments of a call as the trace keeps them: the contents of the person's files only as their size. */
export function traceArgs(server: TraceCall['server'], tool: string, args: unknown, home = homedir()): unknown {
  const hidden = server === 'files' ? FILE_CONTENT_ARGS[tool] : undefined;
  if (hidden && args && typeof args === 'object') {
    const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    for (const key of hidden) if (typeof copy[key] === 'string') copy[key] = `[file content left out: ${(copy[key] as string).length} characters]`;
    return traceValue(copy, LIMITS.arg, home);
  }
  return traceValue(args, LIMITS.arg, home);
}

export function traceResult(server: TraceCall['server'], tool: string, text: string, error: boolean, home = homedir()): string {
  if (!error && ((server === 'files' && FILE_CONTENT_RESULTS.has(tool)) || (server === 'bogen' && OUTSIDE_RESULTS.has(tool)))) return `[file content left out: ${text.length} characters]`;
  return cut(redactText(text, home), LIMITS.result);
}

/** The text of an MCP tool result. */
export function resultText(out: { content?: { type: string; text?: string }[] } | undefined): string {
  return (out?.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
}

/** Keeps the traces of runs: observes every run, and hears every tool call a run's session makes. */
export class RunTraces implements RunObserver {
  private live = new Map<string, RunTrace>();
  private pending = new Map<string, Promise<void>>();
  /** What the CLI is told besides the request. Set by the server, which knows how a run is instructed. */
  instructions?: (req: RunRequest) => string;

  constructor(private readonly home: string, hub?: EventHub, private readonly userHome = homedir()) {
    hub?.tap((event) => {
      if (event.t !== 'activity' || !event.runId) return;
      const trace = this.live.get(event.runId);
      if (!trace) return;
      for (const id of event.nodeIds) {
        if (trace.layers.includes(id)) continue;
        if (trace.layers.length >= LIMITS.layers) trace.cut.layers++;
        else trace.layers.push(id);
      }
    });
  }

  private get dir(): string {
    return join(this.home, 'traces');
  }

  started(runId: string, req: RunRequest): void {
    let instructions: string | undefined;
    try {
      instructions = this.instructions?.(req);
    } catch {
      instructions = undefined;
    }
    const red = (text: string, max: number) => cut(redactText(text, this.userHome), max);
    this.live.set(runId, {
      format: TRACE_FORMAT, version: TRACE_VERSION, runId, fileId: req.fileId, fileName: req.live ? undefined : req.fileName, runner: req.runner,
      ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}), ...(req.review ? { review: req.review } : {}),
      source: req.live ? 'live' : req.race ? 'race' : req.threadId ? 'comment' : 'prompt',
      ...(req.conversationId ? { conversationId: req.conversationId } : {}), ...(req.threadId ? { threadId: req.threadId } : {}),
      startedAt: Date.now(), status: 'running',
      prompt: {
        request: red(req.prompt, LIMITS.prompt), ...(req.title ? { title: red(req.title, 500) } : {}), ...(req.context ? { context: red(req.context, LIMITS.context) } : {}),
        ...(instructions ? { instructions: red(instructions, LIMITS.instructions) } : {}), nodeIds: (req.nodeIds ?? []).slice(0, 200), ...(req.pageId ? { pageId: req.pageId } : {}),
      },
      calls: [], events: [], layers: [], cut: { calls: 0, events: 0, layers: 0 }, redaction: REDACTION_NOTE,
    });
  }

  event(runId: string, event: { kind: TraceEvent['kind']; text?: string; tool?: string }): void {
    const trace = this.live.get(runId);
    if (!trace) return;
    if (event.kind === 'model' && event.text) trace.actualModel = event.text.slice(0, 120);
    // A tool event is said by the CLI; the call itself, with its arguments, comes from the server in `call`.
    if (trace.events.length >= LIMITS.events) {
      trace.cut.events++;
      return;
    }
    trace.events.push({ t: Date.now() - trace.startedAt, kind: event.kind, ...(event.text ? { text: cut(redactText(event.text, this.userHome), LIMITS.text) } : {}), ...(event.tool ? { tool: event.tool } : {}) });
  }

  /** A tool call of a run's session, as the server ran it. */
  call(runId: string, call: { server: TraceCall['server']; tool: string; args: unknown; startedAt: number; result: string; error?: boolean; layers?: string[] }): void {
    const trace = this.live.get(runId);
    if (!trace) return;
    if (trace.calls.length >= LIMITS.calls) {
      trace.cut.calls++;
      return;
    }
    trace.calls.push({
      t: Math.max(0, call.startedAt - trace.startedAt), ms: Date.now() - call.startedAt, server: call.server, tool: call.tool,
      args: traceArgs(call.server, call.tool, call.args, this.userHome), result: traceResult(call.server, call.tool, call.result, Boolean(call.error), this.userHome),
      ...(call.error ? { error: true } : {}), ...(call.layers?.length ? { layers: call.layers.slice(0, 50) } : {}),
    });
  }

  /** Files a run on a repository wrote, which may be said right after it ended. */
  noteFiles(runId: string, files: string[]): void {
    const trace = this.live.get(runId);
    if (trace) trace.files = files.slice(0, 200).map((f) => redactText(f, this.userHome));
    else void this.get(runId).then((t) => {
      if (!t) return;
      t.files = files.slice(0, 200).map((f) => redactText(f, this.userHome));
      return this.write(t);
    }).catch(() => {});
  }

  ended(end: RunEnd, problem?: string): void {
    const trace = this.live.get(end.runId);
    if (!trace) return;
    this.live.delete(end.runId);
    trace.endedAt = Date.now();
    trace.durationMs = trace.endedAt - trace.startedAt;
    trace.status = end.status;
    if (end.status === 'failed' && (problem || end.error)) trace.error = cut(redactText(problem ?? end.error ?? '', this.userHome), LIMITS.text);
    const write = this.write(trace).finally(() => this.pending.delete(end.runId));
    this.pending.set(end.runId, write);
  }

  private async write(trace: RunTrace): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWrite(join(this.dir, `${trace.runId}.json`), JSON.stringify(trace, null, 1), 0o600);
      await this.prune();
    } catch (e) {
      console.error(`bogen: could not keep the trace of run ${trace.runId}: ${errorMessage(e)}`);
    }
  }

  /** Only the newest traces stay. */
  private async prune(): Promise<void> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
    if (names.length <= KEEP) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, at: (await stat(join(this.dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
    for (const old of dated.sort((a, b) => b.at - a.at).slice(KEEP)) await rm(join(this.dir, old.n), { force: true }).catch(() => {});
  }

  /** The trace of a run: as it is so far while it goes, as it was kept once it ended. */
  async get(runId: string): Promise<RunTrace | undefined> {
    if (!RUN_ID.test(runId)) return undefined;
    const live = this.live.get(runId);
    if (live) return structuredClone(live);
    await this.pending.get(runId);
    try {
      return JSON.parse(await readFile(join(this.dir, `${runId}.json`), 'utf8')) as RunTrace;
    } catch {
      return undefined;
    }
  }

  /** What a file's name for a download should be. */
  static fileName(trace: Pick<RunTrace, 'runId' | 'startedAt'>): string {
    return `bogen-trace-${new Date(trace.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${trace.runId}.json`;
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
}
