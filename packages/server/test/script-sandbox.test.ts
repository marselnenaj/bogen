import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, parseFromScript, runScript, ScriptStop, type ScriptHandler, type ScriptLimits } from '../src/script-sandbox.ts';

/** The engine alone, with a stand-in for the document API: what untrusted code can and cannot reach. No ports. */
const METHODS = ['echo', 'count', 'big', 'stop'];
const calls: { name: string; args: unknown[] }[] = [];
const handler: ScriptHandler = async (name, args) => {
  calls.push({ name, args });
  if (name === 'echo') return args[0];
  if (name === 'count') return calls.length;
  if (name === 'big') return 'x'.repeat(5 * 1024 * 1024);
  if (name === 'stop') throw ScriptStop.limit('changes');
  throw new Error('unknown');
};
const run = (code: string, limits: Partial<ScriptLimits> = {}) => runScript(code, METHODS, handler, { ...DEFAULT_LIMITS, ...limits });

describe('script sandbox', () => {
  it('runs plain JavaScript and returns JSON', async () => {
    const out = await run('const xs = [3, 1, 2].sort(); console.log("sorted", xs); return { xs, sum: xs.reduce((a, b) => a + b, 0) };');
    expect(out).toMatchObject({ ok: true, result: { xs: [1, 2, 3], sum: 6 }, logs: ['sorted [1,2,3]'] });
  });

  it('has no Node, no timers, no network and no module loader', async () => {
    const out = await run(`return {
      require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer,
      setTimeout: typeof setTimeout, setInterval: typeof setInterval, queueMicrotask: typeof queueMicrotask,
      fetch: typeof fetch, XMLHttpRequest: typeof XMLHttpRequest, WebSocket: typeof WebSocket, WebAssembly: typeof WebAssembly,
      importScripts: typeof importScripts, std: typeof std, os: typeof os,
      globals: Object.getOwnPropertyNames(globalThis).filter((k) => !/^[A-Z]/.test(k)).sort(),
    };`);
    expect(out.ok).toBe(true);
    const r = (out as { result: Record<string, unknown> }).result;
    for (const k of ['require', 'process', 'module', 'Buffer', 'setTimeout', 'setInterval', 'fetch', 'XMLHttpRequest', 'WebSocket', 'WebAssembly', 'importScripts', 'std', 'os']) expect(r[k], k).toBe('undefined');
    // The two host functions are hidden behind bogen and console.
    expect(r.globals).not.toContain('__bogen_call');
    expect(r.globals).not.toContain('__bogen_log');
    expect(r.globals).toContain('bogen');
  });

  it('keeps Function constructor and eval escapes inside the engine', async () => {
    const out = await run(`
      const viaCtor = (function () {}).constructor('return typeof process')();
      const viaApi = bogen.echo.constructor('return typeof require')();
      const viaEval = (0, eval)('typeof globalThis.process');
      const viaProto = Object.getPrototypeOf(bogen).constructor.constructor('return this')();
      return { viaCtor, viaApi, viaEval, sameGlobal: viaProto === globalThis };
    `);
    expect(out).toMatchObject({ ok: true, result: { viaCtor: 'undefined', viaApi: 'undefined', viaEval: 'undefined', sameGlobal: true } });
    // A dynamic import has no loader behind it: at most a rejected promise, which fails the run.
    const imported = await run('let fs = null; import("node:fs").then((m) => { fs = m; }); return typeof fs;');
    expect(imported.ok).toBe(false);
  });

  it('stops an infinite loop on time, and the script cannot catch that', async () => {
    const out = await run('while (true) { try { for (;;) {} } catch (e) { console.log("caught", e); } }', { timeMs: 300 });
    expect(out).toMatchObject({ ok: false, limit: 'time' });
    expect(out.ms).toBeLessThan(3000);
  });

  it('reports deep recursion as the stack limit', async () => {
    const out = await run('function f(n) { return f(n + 1) + 1; } return f(0);');
    expect(out).toMatchObject({ ok: false, limit: 'stack' });
  });

  it('reports a huge allocation as the memory limit', async () => {
    const big = await run('const s = "x".repeat(1e9); return s.length;', { memoryBytes: 16 * 1024 * 1024 });
    expect(big).toMatchObject({ ok: false, limit: 'memory' });
    const grow = await run('const a = []; for (;;) a.push(new Array(1e5).fill(1));', { memoryBytes: 16 * 1024 * 1024 });
    expect(grow.ok).toBe(false);
    expect(['memory', 'time']).toContain((grow as { limit?: string }).limit);
  });

  it('fails on the memory limit even when the script catches the out of memory error', async () => {
    for (const code of [
      'let caught = ""; try { "x".repeat(1e9); } catch (e) { caught = String(e); } return caught;',
      'let caught = ""; try { const a = []; for (;;) a.push(new Array(1e4).fill(1)); } catch (e) { caught = String(e); } return caught;',
      'let caught = ""; try { new Uint8Array(1.5e9); } catch (e) { caught = String(e); } bogen.echo(1); return caught;',
    ]) {
      const out = await run(code, { memoryBytes: 16 * 1024 * 1024 });
      expect(out, code).toMatchObject({ ok: false, limit: 'memory' });
    }
    // Using a good part of the memory without reaching it is fine.
    const fine = await run('const a = []; for (let i = 0; i < 1e5; i++) a.push({ i, s: "y" + i }); return a.length;', { memoryBytes: 16 * 1024 * 1024 });
    expect(fine).toMatchObject({ ok: true, result: 1e5 });
  });

  it('fails on the stack limit even when the script catches the stack overflow', async () => {
    for (const code of [
      'function f(n) { return f(n + 1) + 1; } let caught = ""; try { f(0); } catch (e) { caught = String(e); } return caught;',
      'const o = {}; let c = o; for (let i = 0; i < 1e5; i++) { c.x = {}; c = c.x; } try { JSON.stringify(o); } catch (e) {} return "went on";',
      'function f(n) { return [1].map(() => f(n + 1))[0]; } try { f(0); } catch (e) {} bogen.echo(1); return "went on";',
      // Caught many times over, as a script might in a retry loop.
      'let n = 0; function f() { return f() + 1; } for (let i = 0; i < 20; i++) { try { f(); } catch (e) { n++; } } return n;',
    ]) {
      const out = await run(code);
      expect(out, code).toMatchObject({ ok: false, limit: 'stack' });
    }
    // Ordinary recursion is fine.
    const fine = await run('function f(n) { return n === 0 ? 0 : f(n - 1) + 1; } return f(500);');
    expect(fine).toMatchObject({ ok: true, result: 500 });
  });

  it('refuses a return value over the output limit, and cuts long logs', async () => {
    const out = await run('return "x".repeat(300 * 1024);');
    expect(out).toMatchObject({ ok: false, limit: 'output' });
    const logs = await run('for (let i = 0; i < 100000; i++) console.log("line", i); return 1;');
    expect(logs).toMatchObject({ ok: true, result: 1, logsCut: true });
    expect(logs.logs.length).toBeLessThanOrEqual(500);
  });

  it('counts calls on the server side and stops at the limit, even when the script catches it', async () => {
    const out = await run('let n = 0; for (;;) { try { bogen.echo(1); n++; } catch (e) { n++; } } return n;', { maxCalls: 50 });
    expect(out).toMatchObject({ ok: false, limit: 'operations' });
    expect(out.calls).toBe(51);
  });

  it('stops on a limit a handler raises, even when the script catches it', async () => {
    const out = await run('try { bogen.stop(); } catch (e) { console.log("caught"); } return "went on";');
    expect(out).toMatchObject({ ok: false, limit: 'changes' });
  });

  it('passes JSON only: functions, symbols and prototypes do not cross', async () => {
    calls.length = 0;
    const out = await run(`
      const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "ok": 1}');
      const back = bogen.echo({ evil, fn: () => 1, sym: Symbol('s'), date: new Date(0), nested: { __proto__: { inherited: 1 } } });
      return { back, polluted: ({}).polluted === true };
    `);
    expect(out.ok).toBe(true);
    const sent = calls.at(-1)!.args[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
    expect(Object.hasOwn(sent.evil as object, '__proto__')).toBe(false);
    expect(Object.hasOwn(sent.evil as object, 'constructor')).toBe(false);
    expect((sent.evil as { ok: number }).ok).toBe(1);
    expect(sent.fn).toBeUndefined();
    expect(sent.date).toBe('1970-01-01T00:00:00.000Z');
    // Nothing reached the server's prototypes.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect((Object.prototype as { inherited?: number }).inherited).toBeUndefined();
    expect(parseFromScript('{"__proto__":{"x":1}}')).toEqual({});
  });

  it('answers bogen calls only while the script itself runs', async () => {
    // A getter of the return value runs after the script, and a promise callback would run outside it.
    const getter = await run('return { get x() { return bogen.echo(1); } };');
    expect(getter.ok).toBe(false);
    expect((getter as { error: string }).error).toMatch(/only while the script runs/);
    const later = await run('Promise.resolve().then(() => bogen.echo(1)); return 1;');
    expect(later).toMatchObject({ ok: false });
    expect((later as { error: string }).error).toMatch(/without async, await or then/);
    const asyncMain = await run('return (async () => bogen.echo(2))();');
    expect(asyncMain.ok).toBe(false);
  });

  it('allows calls from callbacks the engine itself drives, one at a time', async () => {
    calls.length = 0;
    const out = await run(`
      const xs = [1, 2, 3].map((n) => bogen.echo(n * 2));
      const sorted = [3, 1, 2].sort((a, b) => bogen.count() >= 0 ? a - b : 0);
      const nested = bogen.echo({ toJSON() { return bogen.echo('inner'); } });
      return { xs, sorted, nested };
    `);
    expect(out).toMatchObject({ ok: true, result: { xs: [2, 4, 6], sorted: [1, 2, 3], nested: 'inner' } });
  });

  it('caps one answer, so that a read cannot flood the engine', async () => {
    const out = await run('try { bogen.big(); return "no"; } catch (e) { return String(e.message); }');
    expect(out).toMatchObject({ ok: true });
    expect((out as { result: string }).result).toMatch(/Narrow the query/);
  });

  it('reports syntax and runtime errors with the line of the script', async () => {
    const syntax = await run('return {');
    expect(syntax.ok).toBe(false);
    expect((syntax as { error: string }).error).toMatch(/SyntaxError/);
    const thrown = await run('const a = 1;\nnull.x;');
    expect((thrown as { error: string }).error).toMatch(/TypeError[\s\S]*script\.js:2/);
  });

  it('runs scripts side by side in separate engines', async () => {
    const [a, b] = await Promise.all([run('globalThis.mark = 1; return typeof globalThis.mark;'), run('return typeof globalThis.mark;')]);
    expect(a).toMatchObject({ ok: true, result: 'number' });
    expect(b).toMatchObject({ ok: true, result: 'undefined' });
    // More than run at once wait their turn, and all finish.
    const many = await Promise.all(Array.from({ length: 7 }, (_, i) => run(`return ${i} * 2;`)));
    expect(many.map((m) => (m as { result: number }).result)).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });

  it('ends at once when the call is cancelled', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const out = await runScript('for (;;) {}', METHODS, handler, DEFAULT_LIMITS, stop.signal);
    expect(out.ok).toBe(false);
    expect(out.ms).toBeLessThan(2000);
  });
});
