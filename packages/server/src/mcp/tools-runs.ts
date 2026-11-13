import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RunTraces } from '../run-trace.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

export function registerRunTools(define: ToolDefiner): void {
  define('trace_get', {
    description: 'The trace of one agent run that Bogen started, for a bug report: the request and the instructions it got, every tool call with its arguments and result cut short, timings in milliseconds from the start, the layers it touched, and the files it wrote in a repository. Secrets are masked, the home folder is ~ and the contents of files outside Bogen are left out. Without run_id it lists the latest runs of the file with their ids. With save it also writes the JSON into the export folder and says where.',
    readOnly: true,
  }, {
    run_id: z.string().regex(/^[\w-]{1,40}$/).optional().describe('The run. Leave it out to list the latest runs of the file.'),
    save: z.boolean().default(false).describe('Also write it as a .json file into the export folder.'),
    file_id: fileIdArg,
  }, async ({ run_id, save, file_id }, ctx) => {
    if (!run_id) {
      const fileId = ctx.fileId(file_id);
      const runs = (await ctx.app.history.list(fileId, 20)).map((r) => ({ run_id: r.id, runner: r.runner, status: r.status, started_at: new Date(r.startedAt).toISOString(), request: (r.title ?? r.prompt).replace(/\s+/g, ' ').slice(0, 120) }));
      return { runs, hint: runs.length ? 'Pass one run_id for its trace.' : 'No runs on this file yet.' };
    }
    const trace = await ctx.app.traces.get(run_id);
    if (!trace) throw new Error('No trace of that run. Traces are kept for the latest 200 runs Bogen started on this device; runs of an outside MCP client have none.');
    if (!save) return trace;
    const dir = ctx.app.exportDir ?? process.env.BOGEN_EXPORT_DIR ?? join(homedir(), 'Downloads', 'Bogen');
    await mkdir(dir, { recursive: true });
    const path = join(dir, RunTraces.fileName(trace));
    await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
    return { saved: path, calls: trace.calls.length, status: trace.status, duration_ms: trace.durationMs ?? null, redaction: trace.redaction };
  });
}
