import type { RunnerId } from './agents.ts';
import { checkReport, runAgentsCheck, type AgentsCheck, type CaseName } from './agents-check.ts';
import { MODEL_ID } from './run-settings.ts';

const LABEL: Record<CaseName, string> = { polite: 'polite request', question: 'pure question', memory: 'two-turn chat' };

/**
 * `bogen agents check`: the smoke test in this process, with a throwaway server and data folder of its own, so
 * it needs no running Bogen and leaves nothing behind. Exit code 0 when every case passed.
 */
export async function agentsCheckCommand(options: { runners?: RunnerId[]; model?: string; json?: boolean }, write: (text: string) => void): Promise<number> {
  if (options.model && !MODEL_ID.test(options.model)) {
    write(`bogen: "${options.model}" is not a model name.\n`);
    return 2;
  }
  if (!options.json) write('Running your real claude and codex on a throwaway file. This uses your plan: a few small runs, a few minutes.\n');
  const said = new Set<string>();
  const check: AgentsCheck = await runAgentsCheck({
    ...(options.runners ? { runners: options.runners } : {}), ...(options.model ? { model: options.model } : {}),
    progress: (now) => {
      if (options.json) return;
      for (const r of now.runners) {
        if (!said.has(r.runner)) {
          said.add(r.runner);
          write(r.available ? `${r.runner}: starting${r.model ? ` on ${r.model}` : ''}\n` : `${r.runner}: ${r.error ?? 'not available'}\n`);
        }
        for (const c of r.cases) {
          const key = `${r.runner}:${c.name}`;
          if (said.has(key)) continue;
          said.add(key);
          write(`${r.runner}: ${LABEL[c.name]} ${c.ok ? 'passed' : 'FAILED'} (${c.seconds} s)\n`);
        }
      }
    },
  });
  write(options.json ? `${JSON.stringify(check, null, 2)}\n` : `\n${checkReport(check)}\n`);
  const cases = check.runners.flatMap((r) => r.cases);
  return check.status === 'done' && cases.length > 0 && cases.every((c) => c.ok) && check.runners.every((r) => !r.error) ? 0 : 1;
}

/**
 * `bogen agents trace <run id> [--output <file>]`: the trace of one run from the running server, as JSON, for a bug
 * report. Without --output it goes to stdout. It reads what the server kept; it starts nothing.
 */
export async function agentsTraceCommand(conn: { url: string; token?: string }, runId: string | undefined, output: string | undefined, write: (text: string) => void): Promise<number> {
  if (!runId || !/^[\w-]{1,40}$/.test(runId)) {
    write('Usage: bogen agents trace <run id> [--output <file>]\nThe run id is in the chat (Trace) and in the Agents tab.\n');
    return 2;
  }
  let res: Response;
  try {
    res = await fetch(`${conn.url}/api/runs/trace/${runId}`, { headers: conn.token ? { Authorization: `Bearer ${conn.token}` } : {} });
  } catch {
    write(`bogen: nothing answers on ${conn.url}. Start Bogen first.\n`);
    return 1;
  }
  const body = await res.text();
  if (!res.ok) {
    let message = body;
    try { message = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* plain text */ }
    write(`bogen: ${message}\n`);
    return 1;
  }
  const text = `${JSON.stringify(JSON.parse(body), null, 2)}\n`;
  if (!output) {
    write(text);
    return 0;
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(output, text, { mode: 0o600 });
  write(`Wrote the trace of run ${runId} to ${output}. Read it before you share it.\n`);
  return 0;
}
