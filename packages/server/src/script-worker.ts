import { parentPort, workerData } from 'node:worker_threads';
import variant from '@jitl/quickjs-wasmfile-release-asyncify';
import { newQuickJSAsyncWASMModuleFromVariant, newVariant, type AsyncFunctionImplementation, type QuickJSAsyncContext, type QuickJSHandle } from 'quickjs-emscripten-core';
import { limitMessage, type ParentMessage, type ScriptJob, type ScriptLimit, type WorkerMessage } from './script-protocol.ts';

/**
 * Runs one agent-written script in QuickJS compiled to WebAssembly, in a worker thread of its own. The script sees an
 * ECMAScript engine and nothing else: no require, process, timers, network or files. Its one way out is the
 * `bogen` object, whose calls cross to the server as JSON strings and come back as JSON strings. See
 * script-sandbox.ts for the side that answers them, and docs/guide/agents.md for the threat model.
 */

/** What the script runs before its own code: `bogen` and `console`, built on the two host functions, which it then hides. */
function prelude(methods: readonly string[]): string {
  return `(() => {
  const call = globalThis.__bogen_call, log = globalThis.__bogen_log;
  delete globalThis.__bogen_call; delete globalThis.__bogen_log;
  const parse = JSON.parse, stringify = JSON.stringify;
  const api = {};
  for (const name of ${JSON.stringify(methods)}) {
    api[name] = function (...args) {
      const out = call(name, stringify(args, (k, v) => (v === undefined ? null : v)));
      return out === null ? undefined : parse(out);
    };
  }
  globalThis.bogen = Object.freeze(api);
  const show = (v) => {
    if (typeof v === 'string') return v;
    try { const s = stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const write = (...args) => { log(args.map(show).join(' ')); };
  globalThis.console = Object.freeze({ log: write, info: write, warn: write, error: write, debug: write });
})();`;
}

function errorText(vm: QuickJSAsyncContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped && typeof dumped === 'object') {
    const e = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    const head = `${typeof e.name === 'string' ? e.name : 'Error'}: ${typeof e.message === 'string' ? e.message : JSON.stringify(dumped)}`;
    const stack = typeof e.stack === 'string' ? e.stack.split('\n').filter((l) => /script\.js/.test(l)).slice(0, 6).join('\n') : '';
    return stack ? `${head}\n${stack}` : head;
  }
  return String(dumped);
}

/** Which engine limit an error the script did not catch stands for. */
function engineLimit(message: string): ScriptLimit | undefined {
  if (/out of memory/i.test(message)) return 'memory';
  if (/stack overflow|call stack/i.test(message)) return 'stack';
  return undefined;
}

/** Room for the engine's static data and its own stack, on top of what the script may allocate. */
const ENGINE_BASE = 16 * 1024 * 1024;
/** Below QuickJS's stack limit: anything written here means the limit was reached, even if the script caught the error. */
const STACK_GUARD = 64 * 1024;
const CANARY = 0xa5a5a5a5;

/**
 * A QuickJS instance whose limits the host can see. Memory: the engine gets a WebAssembly memory with a maximum, and
 * every time its allocator is refused more, onMemory runs. Stack: QuickJS raises a stack overflow as an ordinary
 * error, so the bytes just below its limit are filled with a canary; its error path always writes there, and so does
 * anything else that reached the limit.
 */
async function startEngine(job: ScriptJob, onMemory: () => void): Promise<{ vm: QuickJSAsyncContext; stackTouched: () => boolean }> {
  const memory = new WebAssembly.Memory({ initial: ENGINE_BASE / 65536, maximum: Math.ceil((ENGINE_BASE + job.memoryBytes) / 65536) });
  let exports: WebAssembly.Exports | undefined;
  let watched = false;
  const qjs = await newQuickJSAsyncWASMModuleFromVariant(newVariant(variant, {
    emscriptenModule: {
      wasmMemory: memory,
      instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
        // The heap's resize import is the one that grows the memory. Wrapped, a refusal is seen here.
        const env = imports.a as Record<string, unknown>;
        for (const [name, fn] of Object.entries(env)) {
          if (typeof fn !== 'function' || !/\.grow\(/.test(Function.prototype.toString.call(fn))) continue;
          const resize = fn as (...args: unknown[]) => unknown;
          env[name] = (...args: unknown[]) => {
            const ok = resize(...args);
            if (!ok) onMemory();
            return ok;
          };
          watched = true;
        }
        const instance = new WebAssembly.Instance(job.wasm, imports);
        exports = instance.exports;
        done(instance, job.wasm);
        return {};
      },
    } as never,
  }));
  if (!watched) throw new Error('the engine\'s memory cannot be watched');
  const vm = qjs.newContext();
  // No allocation limit inside QuickJS: its refusals would not be seen. The memory's maximum is the limit.
  vm.runtime.setMemoryLimit(-1);
  vm.runtime.setMaxStackSize(job.stackBytes);
  // emscripten's stackSave: the stack pointer, at its top while no engine code runs.
  const stackSave = exports?.Pa;
  const top = typeof stackSave === 'function' ? (stackSave as () => number)() : NaN;
  const low = top - job.stackBytes - STACK_GUARD;
  if (!Number.isInteger(top) || low < 1024 * 1024 || top > memory.buffer.byteLength) throw new Error('the engine\'s stack cannot be watched');
  const guard = () => new Uint32Array(memory.buffer, low & ~3, STACK_GUARD / 4);
  guard().fill(CANARY);
  return { vm, stackTouched: () => guard().some((w) => w !== CANARY) };
}

async function run(job: ScriptJob, port: NonNullable<typeof parentPort>): Promise<WorkerMessage> {
  const logs: string[] = [];
  let logBytes = 0;
  let logsCut = false;
  /** Set at the deadline, or by the server when a call hit a limit or failed part way. The next interrupt check stops the script, and it cannot catch that. */
  let stopped: { message: string; limit?: ScriptLimit } | undefined;
  const stoppedDone = (): WorkerMessage => ({ t: 'done', ok: false, error: stopped!.message, ...(stopped!.limit ? { limit: stopped!.limit } : {}), logs, logsCut });
  let inCall = false;
  /** Whether the script's own evaluation is still running. */
  let open = true;
  let nextId = 1;
  const pending = new Map<number, (m: ParentMessage) => void>();
  port.on('message', (m: ParentMessage) => {
    const resolve = pending.get(m.id);
    pending.delete(m.id);
    resolve?.(m);
  });

  const engine = await startEngine(job, () => {
    stopped ??= { message: limitMessage('memory'), limit: 'memory' };
  });
  const { vm } = engine;
  const rt = vm.runtime;
  /** Records a limit the engine hit, whether or not the script caught the error it was given. */
  const engineHit = () => {
    if (!stopped && engine.stackTouched()) stopped = { message: limitMessage('stack'), limit: 'stack' };
    return stopped !== undefined;
  };
  let lastGuardCheck = 0;
  rt.setInterruptHandler(() => {
    if (!stopped && Date.now() > job.deadline) stopped = { message: limitMessage('time'), limit: 'time' };
    if (!stopped && Date.now() - lastGuardCheck > 10) {
      lastGuardCheck = Date.now();
      engineHit();
    }
    return stopped !== undefined;
  });

  // Answers without waiting whenever it refuses: a promise is only safe while the script's own evaluation can suspend.
  const callFn = vm.newAsyncifiedFunction('__bogen_call', ((nameHandle: QuickJSHandle | undefined, argsHandle: QuickJSHandle | undefined) => {
    if (!open) return { error: vm.newError('bogen calls work only while the script runs, not from a getter or toJSON of its return value.') };
    // typeof never runs the script's code; reading a string out of anything else would (toString), from inside this call.
    if (!nameHandle || !argsHandle || vm.typeof(nameHandle) !== 'string' || vm.typeof(argsHandle) !== 'string') return { error: vm.newError('bogen calls take JSON strings.') };
    if (inCall) return { error: vm.newError('A bogen call cannot start while another one is running.') };
    if (engineHit()) return { error: vm.newError(`The script was stopped: ${stopped!.message}`) };
    const name = vm.getString(nameHandle);
    const args = vm.getString(argsHandle);
    inCall = true;
    return (async () => {
      try {
        const id = nextId++;
        const reply = await new Promise<ParentMessage>((resolve) => {
          pending.set(id, resolve);
          port.postMessage({ t: 'call', id, name, args } satisfies WorkerMessage);
        });
        if (!reply.ok) {
          if (reply.stop) stopped ??= { message: reply.error, ...(reply.limit ? { limit: reply.limit } : {}) };
          return { error: vm.newError(reply.error) };
        }
        return reply.value === null ? vm.null : vm.newString(reply.value);
      } finally {
        inCall = false;
      }
    })();
  }) as AsyncFunctionImplementation);
  vm.setProp(vm.global, '__bogen_call', callFn);
  callFn.dispose();

  const logFn = vm.newFunction('__bogen_log', (lineHandle) => {
    if (!lineHandle || vm.typeof(lineHandle) !== 'string') return;
    if (logsCut) return;
    const line = vm.getString(lineHandle).slice(0, 2000);
    if (logBytes + line.length > job.maxLogBytes || logs.length >= 500) {
      logsCut = true;
      return;
    }
    logBytes += line.length;
    logs.push(line);
  });
  vm.setProp(vm.global, '__bogen_log', logFn);
  logFn.dispose();

  const setup = vm.evalCode(prelude(job.methods), 'prelude.js');
  if (setup.error) return { t: 'done', ok: false, error: `The sandbox did not start: ${errorText(vm, setup.error)}`, logs, logsCut };
  setup.value.dispose();

  // The script's first line stays line 1, so that error positions match what the agent wrote.
  const source = `(function () { "use strict"; ${job.code}\n}).call(undefined)`;
  const result = await vm.evalCodeAsync(source, 'script.js');
  open = false;
  if (engineHit()) return stoppedDone();
  if (result.error) {
    const message = errorText(vm, result.error);
    const limit = engineLimit(message);
    return { t: 'done', ok: false, error: limit ? `${limitMessage(limit)} ${message}` : message, ...(limit ? { limit } : {}), logs, logsCut };
  }
  const value = result.value;
  if (rt.hasPendingJob() || vm.typeof(value) === 'object' && vm.getProp(value, 'then').consume((then) => vm.typeof(then) === 'function')) {
    return { t: 'done', ok: false, error: 'The script returned a promise or left promise callbacks to run. The bogen API answers at once, so write the script without async, await or then.', logs, logsCut };
  }
  if (vm.typeof(value) === 'undefined') return { t: 'done', ok: true, result: null, logs, logsCut };
  // Turned into JSON inside the sandbox, so that the script's getters and toJSON run there and not here.
  const json = vm.evalCode('(v) => { const s = JSON.stringify(v); return s === undefined ? null : s; }', 'result.js');
  if (json.error) return { t: 'done', ok: false, error: errorText(vm, json.error), logs, logsCut };
  const text = vm.callFunction(json.value, vm.undefined, value);
  json.value.dispose();
  if (engineHit()) return stoppedDone();
  if (text.error) {
    const message = errorText(vm, text.error);
    return { t: 'done', ok: false, error: `The script's return value is not JSON: ${message}`, logs, logsCut };
  }
  const out = vm.typeof(text.value) === 'string' ? vm.getString(text.value) : null;
  if (out !== null && out.length > job.maxOutputBytes) return { t: 'done', ok: false, error: `${limitMessage('output')} The return value is ${Math.round(out.length / 1024)} KB.`, limit: 'output', logs, logsCut };
  return { t: 'done', ok: true, result: out, logs, logsCut };
}

if (parentPort && workerData) {
  const port = parentPort;
  run(workerData as ScriptJob, port).then(
    (done) => port.postMessage(done),
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      // The thread's own stack ran out inside the engine: the same limit, reached a level further down.
      const stack = e instanceof RangeError && /call stack/i.test(message);
      port.postMessage({ t: 'done', ok: false, error: stack ? limitMessage('stack') : `The sandbox failed: ${message}`, ...(stack ? { limit: 'stack' as const } : {}), logs: [], logsCut: false } satisfies WorkerMessage);
    },
  );
}
