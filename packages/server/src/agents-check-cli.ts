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
