/** What script-sandbox.ts and script-worker.ts say to each other. Values only, so that both sides can load it. */
export type ScriptLimit = 'time' | 'memory' | 'stack' | 'operations' | 'output' | 'changes';

export interface ScriptJob {
  code: string;
  wasm: WebAssembly.Module;
  /** Date.now() after which the script is interrupted. */
  deadline: number;
  memoryBytes: number;
  stackBytes: number;
  maxOutputBytes: number;
  maxLogBytes: number;
  methods: readonly string[];
}

export type WorkerMessage =
  | { t: 'call'; id: number; name: string; args: string }
  | { t: 'done'; ok: true; result: string | null; logs: string[]; logsCut: boolean }
  | { t: 'done'; ok: false; error: string; limit?: ScriptLimit; logs: string[]; logsCut: boolean };

export type ParentMessage =
  | { t: 'reply'; id: number; ok: true; value: string | null }
  /** With stop, the run ends here whatever the script does with the error: a limit, or a call that failed part way. */
  | { t: 'reply'; id: number; ok: false; error: string; stop?: boolean; limit?: ScriptLimit };

export function limitMessage(limit: ScriptLimit): string {
  switch (limit) {
    case 'time': return 'The script ran out of time.';
    case 'memory': return 'The script ran out of memory.';
    case 'stack': return 'The script nested calls too deeply (stack limit).';
    case 'operations': return 'The script made too many bogen calls.';
    case 'output': return 'The script returned more than the output limit.';
    case 'changes': return 'The script changed more than one run may.';
  }
}
