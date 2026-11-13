import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { errorMessage } from './util.ts';
import { limitMessage, type ParentMessage, type ScriptJob, type ScriptLimit, type WorkerMessage } from './script-protocol.ts';

export { limitMessage, type ScriptLimit } from './script-protocol.ts';

/**
 * The server's side of script_run's sandbox. Each run gets a new worker thread with a new QuickJS instance, so
 * nothing survives from one script to the next. The worker holds only the engine; the document stays here, and
 * every call of the script's `bogen` API arrives as JSON text, is parsed with prototype keys dropped, and is
 * answered by `handle`. Time, calls and output are counted here, so a misbehaving worker cannot raise them.
 */
export interface ScriptLimits {
  timeMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxCalls: number;
  /** The return value, as JSON. */
  maxOutputBytes: number;
  maxLogBytes: number;
  /** One call's arguments, as JSON. */
  maxCallBytes: number;
  /** One answer to the script, as JSON. */
  maxReplyBytes: number;
}

export const DEFAULT_LIMITS: ScriptLimits = {
  timeMs: 10_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  maxCalls: 5000,
  maxOutputBytes: 256 * 1024,
  maxLogBytes: 64 * 1024,
  maxCallBytes: 512 * 1024,
  maxReplyBytes: 4 * 1024 * 1024,
};

/**
 * Thrown by a handler to end the run, on a limit or when a call left the document half changed. Any other error goes
 * back to the script as an exception, which it may catch.
 */
export class ScriptStop extends Error {
  constructor(message: string, readonly limit?: ScriptLimit) {
    super(message);
  }

  static limit(limit: ScriptLimit, detail?: string): ScriptStop {
    return new ScriptStop(detail ? `${limitMessage(limit)} ${detail}` : limitMessage(limit), limit);
  }
}

export type ScriptOutcome =
  | { ok: true; result: unknown; logs: string[]; logsCut: boolean; calls: number; ms: number }
  | { ok: false; error: string; limit?: ScriptLimit; logs: string[]; logsCut: boolean; calls: number; ms: number };

export type ScriptHandler = (name: string, args: unknown[]) => Promise<unknown>;

/** Keys that would reach an object's prototype if a parsed value were ever merged or assigned. Dropped at parse. */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON from the sandbox: plain data with no prototype keys, so that nothing the script sends can reach a prototype here. */
export function parseFromScript(text: string): unknown {
  return JSON.parse(text, (key, value) => (PROTO_KEYS.has(key) ? undefined : value));
}

let wasm: WebAssembly.Module | undefined;

/** QuickJS's WebAssembly, compiled once: next to the bundled CLI, or from the package in development. */
export function quickjsWasm(): WebAssembly.Module {
  if (wasm) return wasm;
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = join(here, 'quickjs', 'quickjs-asyncify.wasm');
  const path = existsSync(shipped) ? shipped : createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-asyncify/wasm');
  wasm = new WebAssembly.Module(readFileSync(path));
  return wasm;
}

let workerCode: Promise<{ file: string } | { code: string }> | undefined;

/** The built worker next to the CLI, or in development the worker bundled on first use. */
function workerSource(): Promise<{ file: string } | { code: string }> {
  workerCode ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const built = join(here, 'script-worker.js');
    if (existsSync(built)) return { file: built };
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
      entryPoints: [join(here, 'script-worker.ts')], bundle: true, format: 'cjs', platform: 'node', target: 'node22', write: false, logLevel: 'silent',
      // The engine's loader asks import.meta.url for a require; the WebAssembly itself is handed over compiled.
      define: { 'import.meta.url': JSON.stringify('file:///bogen-script-worker.js') },
    });
    return { code: result.outputFiles[0]!.text };
  })().catch((err) => {
    workerCode = undefined;
    throw err;
  });
  return workerCode;
}

/** Sandboxes at once. Each holds a worker and up to its memory limit; more scripts wait their turn. */
const MAX_PARALLEL = 4;
let running = 0;
const waiting: (() => void)[] = [];

/** Runs `code` in a fresh sandbox. Never throws for anything the script does; the outcome says what happened. */
export async function runScript(code: string, methods: readonly string[], handle: ScriptHandler, limits: ScriptLimits = DEFAULT_LIMITS, signal?: AbortSignal): Promise<ScriptOutcome> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await runOne(code, methods, handle, limits, signal);
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function runOne(code: string, methods: readonly string[], handle: ScriptHandler, limits: ScriptLimits, signal?: AbortSignal): Promise<ScriptOutcome> {
  const started = Date.now();
  const deadline = started + limits.timeMs;
  let calls = 0;
  const source = await workerSource();
  const job: ScriptJob = {
    code, wasm: quickjsWasm(), deadline,
    memoryBytes: limits.memoryBytes, stackBytes: limits.stackBytes,
    maxOutputBytes: limits.maxOutputBytes, maxLogBytes: limits.maxLogBytes, methods,
  };
  // The worker gets no environment and no arguments of the server; its own heap is capped besides the engine's.
  const options = { workerData: job, env: {}, argv: [], execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } };
  const worker = 'file' in source ? new Worker(source.file, options) : new Worker(source.code, { ...options, eval: true });
  // Nothing the worker prints reaches the server's output.
  worker.stdout?.resume();
  worker.stderr?.resume();
  const finish = (out: Omit<Extract<ScriptOutcome, { ok: false }>, 'calls' | 'ms'> | Omit<Extract<ScriptOutcome, { ok: true }>, 'calls' | 'ms'>): ScriptOutcome => ({ ...out, calls, ms: Date.now() - started }) as ScriptOutcome;

  try {
    return await new Promise<ScriptOutcome>((resolve) => {
      let settled = false;
      let failed: { message: string; limit?: ScriptLimit } | undefined;
      const done = (out: ScriptOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(out);
      };
      const fail = (error: string, limit?: ScriptLimit) => done(finish({ ok: false, error, ...(limit ? { limit } : {}), logs: [], logsCut: false }));
      // The engine stops itself at the deadline. Past it, with some room for an answer on its way, the thread goes.
      const timer = setTimeout(() => fail(limitMessage('time'), 'time'), limits.timeMs + 1500);
      const onAbort = () => fail('The call was cancelled.');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      const reply = (m: ParentMessage) => {
        if (!settled) worker.postMessage(m);
      };
      worker.on('message', (m: WorkerMessage) => {
        if (settled) return;
        if (m.t === 'done') {
          // A limit this side saw wins over whatever the script made of the error it got.
          if (failed) return done(finish({ ok: false, error: failed.message, ...(failed.limit ? { limit: failed.limit } : {}), logs: m.logs, logsCut: m.logsCut }));
          if (!m.ok) return done(finish({ ok: false, error: m.error, ...(m.limit ? { limit: m.limit } : {}), logs: m.logs, logsCut: m.logsCut }));
          let result: unknown = null;
          try {
            if (m.result !== null) {
              if (m.result.length > limits.maxOutputBytes) return done(finish({ ok: false, error: limitMessage('output'), limit: 'output', logs: m.logs, logsCut: m.logsCut }));
              result = parseFromScript(m.result);
            }
          } catch (e) {
            return done(finish({ ok: false, error: `The return value is not JSON: ${errorMessage(e)}`, logs: m.logs, logsCut: m.logsCut }));
          }
          return done(finish({ ok: true, result, logs: m.logs, logsCut: m.logsCut }));
        }
        if (m.t !== 'call') return;
        void (async () => {
          const stop = (e: ScriptStop) => {
            failed ??= { message: e.message, ...(e.limit ? { limit: e.limit } : {}) };
            reply({ t: 'reply', id: m.id, ok: false, error: failed.message, stop: true, ...(failed.limit ? { limit: failed.limit } : {}) });
          };
          if (failed) return stop(new ScriptStop(failed.message, failed.limit));
          calls++;
          if (calls > limits.maxCalls) return stop(ScriptStop.limit('operations', `The limit is ${limits.maxCalls}.`));
          if (Date.now() > deadline) return stop(ScriptStop.limit('time'));
          if (typeof m.args !== 'string' || typeof m.name !== 'string') return reply({ t: 'reply', id: m.id, ok: false, error: 'Malformed call.' });
          if (m.args.length > limits.maxCallBytes) return reply({ t: 'reply', id: m.id, ok: false, error: `The arguments of bogen.${m.name} are ${Math.round(m.args.length / 1024)} KB, over the ${Math.round(limits.maxCallBytes / 1024)} KB a call may send.` });
          if (!methods.includes(m.name)) return reply({ t: 'reply', id: m.id, ok: false, error: `bogen.${m.name} does not exist. There are: ${methods.join(', ')}.` });
          let args: unknown;
          try {
            args = parseFromScript(m.args);
          } catch {
            return reply({ t: 'reply', id: m.id, ok: false, error: 'The arguments are not JSON.' });
          }
          if (!Array.isArray(args)) return reply({ t: 'reply', id: m.id, ok: false, error: 'The arguments are not a list.' });
          try {
            const value = await handle(m.name, args);
            if (Date.now() > deadline) return stop(ScriptStop.limit('time'));
            const text = value === undefined ? null : JSON.stringify(value);
            if (text !== null && text.length > limits.maxReplyBytes) return reply({ t: 'reply', id: m.id, ok: false, error: `The answer of bogen.${m.name} would be ${Math.round(text.length / 1024 / 1024)} MB. Narrow the query, such as with within, kind or limit.` });
            reply({ t: 'reply', id: m.id, ok: true, value: text ?? null });
          } catch (e) {
            if (e instanceof ScriptStop) return stop(e);
            reply({ t: 'reply', id: m.id, ok: false, error: errorMessage(e) });
          }
        })();
      });
      worker.on('error', (e) => fail(/memory/i.test(errorMessage(e)) ? `${limitMessage('memory')} ${errorMessage(e)}` : `The sandbox failed: ${errorMessage(e)}`, /memory/i.test(errorMessage(e)) ? 'memory' : undefined));
      worker.on('exit', (exitCode) => fail(`The sandbox stopped (exit code ${exitCode}).`));
    });
  } finally {
    void worker.terminate();
  }
}
