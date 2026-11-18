import type { QualityReport } from '../design-quality.ts';
import type { RunTrace } from '../run-trace.ts';

/** Avoid feeding a run its own instructions and earlier results recursively when it asks what happened. */
export function compactTrace(trace: RunTrace) {
  const tools: Record<string, { calls: number; errors: number; ms: number }> = {};
  for (const call of trace.calls) {
    const key = `${call.server}/${call.tool}`;
    const row = (tools[key] ??= { calls: 0, errors: 0, ms: 0 });
    row.calls++; row.errors += Number(!!call.error); row.ms += call.ms;
  }
  return {
    runId: trace.runId, fileId: trace.fileId, runner: trace.runner, model: trace.actualModel ?? trace.model,
    status: trace.status, durationMs: trace.durationMs, error: trace.error,
    prompt_chars: Object.fromEntries((['request', 'context', 'instructions'] as const).map((key) => [key, (trace.prompt[key] ?? '').length])),
    calls: trace.calls.length, tools, cut: trace.cut,
    recent_errors: trace.calls.filter((c) => c.error).slice(-5).map((c) => ({ tool: c.tool, t: c.t, result: c.result.slice(0, 300) })),
    next: 'detail full returns the complete redacted trace; save true writes the full JSON to the export folder. Use full only to investigate specific failures.',
    redaction: trace.redaction,
  };
}

/** Transport projection only: the completion gate keeps the full report, evidence and every measured finding. */
export function compactVerification(report: QualityReport) {
  const rubric = report.rubric;
  const next = rubric.next.split(' Advisory, your call:')[0]!;
  return {
    ...report,
    visual: { ...report.visual,
      observations: report.visual.observations.map(({ criterion, verdict }) => ({ criterion, verdict })),
      criteria: report.visual.criteria.filter((c) => !report.visual.observations.some((o) => o.criterion === c.id)),
    },
    rubric: { ...rubric,
      scores: rubric.scores.map(({ criterion, score }) => ({ criterion, score })),
      next: next + (rubric.advisory.some((a) => !a.kept) ? ' Advisory, your call: weigh rubric.advisory; change it or record kept [{check, reason}].' : ''),
    },
    detail_hint: 'Submitted evidence is stored, not echoed. detail full returns it; design_knowledge action rubric gives scoring anchors. Measured findings and completion states are unchanged.',
  };
}
