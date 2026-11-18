/** Read-only, offline audit. Usage: node --import tsx scripts/token-audit.ts [--json] [trace-directory]
 * Text estimates use characters / 4, not a provider tokenizer or a billing estimate. No tools are executed,
 * no transports are connected, and no data is written. Trace truncation is accounted for where possible.
 */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BogenDoc, getCritiques, Y, type CritiqueRecord } from '@bogen/core';
import { decodeRecords } from '../packages/server/src/doc-log.ts';
import { registerAllTools } from '../packages/server/src/mcp/tools.ts';
import { registerPrompts } from '../packages/server/src/mcp/prompts.ts';
import { INSTRUCTIONS } from '../packages/server/src/mcp/guide.ts';
import { critiqueBrief, MAX_SCREENS, pickReviewer, REVIEW_EFFORT, REVIEW_SYSTEM_PROMPT } from '../packages/server/src/design-critique.ts';
import type { BogenServer } from '../packages/server/src/http/server.ts';
import type { RunTrace } from '../packages/server/src/run-trace.ts';

const root = resolve(import.meta.dirname, '..');
export const size = (chars: number) => ({ chars, estimatedTokens: Math.ceil(chars / 4) });

/** Recover original character counts, without counting the truncation/redaction label as model input. */
export function originalSize(text: string): number {
  const hidden = /^\[file content left out: (\d+) characters\]$/.exec(text);
  if (hidden) return Number(hidden[1]);
  const cut = /… \[(\d+) more characters\]$/.exec(text);
  return cut ? text.length - cut[0].length + Number(cut[1]) : text.length;
}

/** Object key order must not make identical arguments look different. Array order is significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Illustrative vision estimate only: 1 token/750 pixels; maps assume 1–3k chars (chars/4).
 * Trace images are not retained, so this is a sensitivity estimate, never measured usage or billing.
 * Explicit formats retain the previous 1280px cap; explicit dimensions/full remain opt-ins.
 */
export function screenshotEstimate(calls: RunTrace['calls']) {
  let before = 0, afterPicture = 0, known = 0, maps = 0, unknown = 0;
  for (const call of calls.filter((c) => c.tool === 'canvas_screenshot' && !c.error)) {
    maps++;
    const match = /(\d+)x(\d+)px/.exec(call.result);
    if (!match) { unknown++; continue; }
    known++;
    const width = Number(match[1]), height = Number(match[2]);
    before += Math.ceil(width * height / 750);
    const args = call.args && typeof call.args === 'object' ? call.args as Record<string, unknown> : {};
    if (args.map_only) continue;
    const max = typeof args.max_dimension === 'number' ? args.max_dimension : args.detail === 'full' || args.format || args.scale !== undefined ? 1280 : 768;
    const scale = Math.min(1, max / Math.max(width, height));
    afterPicture += Math.ceil(Math.round(width * scale) * Math.round(height * scale) / 750);
  }
  const after = { min: afterPicture + known * 250, typical: afterPicture + known * 500, max: afterPicture + known * 750 };
  return { calls: maps, knownDimensions: known, unknownDimensions: unknown, beforePictureTokens: before, afterPictureTokens: afterPicture,
    afterWithMapTokens: after, typicalSaving: before - after.typical,
    typicalSavingPerCall: known ? Math.round((before - after.typical) / known) : null,
    assumptions: 'Illustrative 1 vision token/750 pixels, map 1000/2000/3000 chars at chars/4. JPEG quality changes bytes, not this pixel estimate. Existing screenshot metadata excluded from both sides. Unknown dimensions and cut calls excluded; dimensions cannot recover original CSS size or predict upscaling. Negative saving means the added map costs more.' };
}

export function auditRun(trace: RunTrace) {
  const tools = new Map<string, { calls: number; recordedChars: number; resultChars: number; images: number; truncated: number; args: Map<string, number> }>();
  for (const call of trace.calls) {
    const key = `${call.server}/${call.tool}`;
    const t = tools.get(key) ?? { calls: 0, recordedChars: 0, resultChars: 0, images: 0, truncated: 0, args: new Map() };
    t.calls++;
    t.recordedChars += call.result.length;
    t.resultChars += originalSize(call.result);
    t.images += (call.result.match(/\[image\]/g) ?? []).length;
    if (/… \[\d+ more characters\]$/.test(call.result)) t.truncated++;
    const args = canonical(call.args);
    t.args.set(args, (t.args.get(args) ?? 0) + 1);
    tools.set(key, t);
  }
  const rows = [...tools].map(([tool, t]) => ({ tool, calls: t.calls, ...size(t.resultChars), recordedChars: t.recordedChars,
    imageMarkers: t.images, truncatedResults: t.truncated, repeatedCalls: [...t.args.values()].reduce((n, c) => n + Math.max(0, c - 1), 0),
    repeatedArgumentGroups: [...t.args.values()].filter((n) => n > 1).length,
  })).sort((a, b) => b.chars - a.chars);
  const imageCalls = trace.calls.filter((c) => /\[image\]/.test(c.result)).length;
  const screenshots = trace.calls.filter((c) => c.tool === 'canvas_screenshot');
  return {
    runId: trace.runId, fileName: trace.fileName, model: trace.actualModel ?? trace.model, effort: trace.effort ?? 'CLI default', status: trace.status,
    minutes: trace.durationMs === undefined ? null : Math.round(trace.durationMs / 6000) / 10,
    prompt: size(originalSize(trace.prompt.request)), context: size(originalSize(trace.prompt.context ?? '')), instructions: size(originalSize(trace.prompt.instructions ?? '')),
    tools: rows, calls: trace.calls.length, cut: trace.cut,
    images: { markers: rows.reduce((n, t) => n + t.imageMarkers, 0), calls: imageCalls, callShare: trace.calls.length ? imageCalls / trace.calls.length : 0,
      screenshotCalls: screenshots.length,
      beforeAfter: screenshotEstimate(screenshots),
      recordedDimensions: screenshots.flatMap((c) => { const m = /(\d+)x(\d+)px/.exec(c.result); return m ? [{ width: Number(m[1]), height: Number(m[2]) }] : []; }),
      note: 'Image bytes and vision tokens are absent from traces. Markers are a lower bound and can include images nested in trace_get.' },
  };
}

/** Register definitions in memory only. No BogenServer, listener, transport, renderer or tool call is started. */
export async function catalogSizes() {
  const modes = ['full', 'compact', 'grouped'] as const;
  const rows = [];
  for (const mode of modes) {
    const sdk = new McpServer({ name: 'offline-token-audit', version: '1' });
    registerAllTools(sdk, {} as BogenServer, { agent: () => 'audit', pageByFile: new Map() }, { mode });
    const handlers = (sdk.server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: unknown[] }>> })._requestHandlers;
    const { tools } = await handlers.get('tools/list')!({ method: 'tools/list', params: {} }, {});
    rows.push({ mode, tools: tools.length, ...size(JSON.stringify(tools).length) });
    await sdk.close();
  }
  return rows;
}

export async function sourceSizes() {
  const dir = join(root, 'packages/server/src/mcp');
  const names = (await readdir(dir)).filter((n) => /^tools.*\.ts$/.test(n) || ['guide.ts', 'prompts.ts', 'outputs.ts'].includes(n)).sort();
  const files = await Promise.all(names.map(async (name) => ({ file: `packages/server/src/mcp/${name}`, ...size((await readFile(join(dir, name), 'utf8')).length) })));
  const prompts: { name: string; chars: number; estimatedTokens: number }[] = [];
  registerPrompts({ registerPrompt(name: string, _meta: unknown, handler: (args: object) => { messages: { content: { text: string } }[] }) {
    prompts.push({ name, ...size(handler({}).messages.map((m) => m.content.text).join('\n').length) });
  } } as unknown as McpServer);
  return { files, alwaysOnInstructions: size(INSTRUCTIONS.length), prompts, note: 'Source file sizes include code. Only INSTRUCTIONS is always-on; prompt templates and guides are fetched on demand. Catalog sizes below measure actual serialized tool schemas.' };
}

/** Read Yjs snapshots and valid log records directly. Storage.loadDoc can repair logs, so must not be used here. */
export async function critiqueRecords(home: string) {
  const directory = join(home, 'files');
  const records: (Pick<CritiqueRecord, 'id' | 'reviewer' | 'score' | 'durationMs' | 'tokens' | 'costUsd'> & { fileId: string; screens: number; dimensions: { width?: string; height?: string }[] })[] = [];
  const warnings: string[] = [];
  let names: string[];
  try { names = await readdir(directory); } catch { return { records, warnings: ['No sibling files directory; critique records not scanned.'] }; }
  for (const name of names.filter((n) => n.endsWith('.ydoc')).sort()) {
    const y = new Y.Doc();
    try {
      Y.applyUpdate(y, await readFile(join(directory, name)));
      const log = await readFile(join(directory, name.replace(/\.ydoc$/, '.updates'))).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
      if (log) {
        const decoded = decodeRecords(log);
        if (decoded.validBytes < log.length) warnings.push(`${name}: torn log tail skipped, never repaired`);
        for (const record of decoded.records) Y.applyUpdate(y, record);
      }
      const doc = new BogenDoc(y);
      for (const record of getCritiques(doc)) records.push({ fileId: name.slice(0, -5), id: record.id, reviewer: record.reviewer, screens: record.screens.length,
        score: record.score, durationMs: record.durationMs, tokens: record.tokens, costUsd: record.costUsd,
        dimensions: record.screens.map((s) => { const n = doc.getNode(s.id); return { width: n?.style.width, height: n?.style.height }; }),
      });
    } catch (e) { warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
    finally { y.destroy(); }
  }
  return { records, warnings };
}

export async function audit(directory: string) {
  const runs = [];
  const warnings: string[] = [];
  const screenshotCalls: RunTrace['calls'] = [];
  for (const name of (await readdir(directory)).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const trace = JSON.parse(await readFile(join(directory, name), 'utf8')) as RunTrace;
      if (trace.format !== 'bogen-run-trace') { warnings.push(`${name}: not a Bogen run trace`); continue; }
      runs.push(auditRun(trace));
      screenshotCalls.push(...trace.calls.filter((c) => c.tool === 'canvas_screenshot'));
    } catch (e) { warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const source = await sourceSizes();
  const catalog = await catalogSizes();
  const brief = critiqueBrief({ screens: [{ id: 'a', name: 'Screen', width: 390, height: 844 }], flow: false, language: 'English', ruleFindings: [] });
  const critiqueSource = await readFile(join(root, 'packages/server/src/design-critique.ts'), 'utf8');
  const critiqueJobsSource = await readFile(join(root, 'packages/server/src/critique-run.ts'), 'utf8');
  const sinks = new Map<string, number>();
  for (const r of runs) {
    for (const [name, value] of [['Maker instructions', r.instructions.chars], ['Conversation context', r.context.chars], ['User request', r.prompt.chars]] as const) sinks.set(name, (sinks.get(name) ?? 0) + value);
    for (const t of r.tools) sinks.set(t.tool, (sinks.get(t.tool) ?? 0) + t.chars);
  }
  return { methodology: 'Read-only; text tokens = ceil(chars/4). Result lengths recover trace cut suffixes and hidden file-content lengths. These are one-pass text volumes, not cumulative cached input, model output, vision tokens, or billing. Same-argument calls may legitimately follow edits; arguments may themselves be truncated. Omitted calls cannot be reconstructed.',
    warnings, source, catalog, critiqueRecords: await critiqueRecords(dirname(directory)),
    screenshots: { ...screenshotEstimate(screenshotCalls), ifUsingNewDefaults: screenshotEstimate(screenshotCalls.map((c) => ({ ...c, args: {} }))) },
    critique: { maxImages: MAX_SCREENS, longEdge: Number(/SHOT_SIDE = (\d+)/.exec(critiqueSource)?.[1]), quality: Number(/quality: (\d+)/.exec(critiqueSource)?.[1]), effort: REVIEW_EFFORT, routineReviewer: pickReviewer('auto').label, systemPrompt: size(REVIEW_SYSTEM_PROMPT.length), samplePhoneBrief: size(brief.length),
      previewLongEdge: Number(/maxDimension: (\d+)/.exec(critiqueJobsSource)?.[1]), note: 'One image per selected artboard; editor previews do not add reviewer images. Brief grows with brand rules, rule findings and addressed findings. No reviewer is invoked.' },
    top10TextSinks: [...sinks].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, chars]) => ({ name, ...size(chars) })), runs };
}

export function markdown(result: Awaited<ReturnType<typeof audit>>): string {
  const lines = ['# Bogen token audit', '', result.methodology, '', '## Top 10 observed text sinks', '', '| Sink | Characters | Estimated tokens |', '|---|---:|---:|',
    ...result.top10TextSinks.map((r) => `| ${r.name} | ${r.chars} | ${r.estimatedTokens} |`), '', '## Definitions and critique', '', '```json', JSON.stringify({ source: result.source, catalog: result.catalog, critique: result.critique, critiqueRecords: result.critiqueRecords, warnings: result.warnings, screenshots: result.screenshots }, null, 2), '```'];
  for (const r of result.runs) lines.push('', `## Run ${r.runId} (${r.fileName ?? ''})`, '', `${r.model}; ${r.effort}; ${r.status}; ${r.minutes ?? '?'} minutes.`, '',
    `Request: ${r.prompt.chars} chars (~${r.prompt.estimatedTokens} tokens). Context: ${r.context.chars} (~${r.context.estimatedTokens}). Instructions: ${r.instructions.chars} (~${r.instructions.estimatedTokens}).`, '',
    `Screenshot estimate: ${JSON.stringify(r.images.beforeAfter)}`, '',
    `Images: ${r.images.markers} markers in ${r.images.calls}/${r.calls} calls (${(r.images.callShare * 100).toFixed(1)}%); ${r.images.screenshotCalls} screenshots. Cut: ${JSON.stringify(r.cut)}. ${r.images.note}`, '',
    '| Tool | Calls | Result chars | Estimated tokens | Repeated calls / groups | Truncated |', '|---|---:|---:|---:|---:|---:|',
    ...r.tools.map((t) => `| ${t.tool} | ${t.calls} | ${t.chars} | ${t.estimatedTokens} | ${t.repeatedCalls} / ${t.repeatedArgumentGroups} | ${t.truncatedResults} |`));
  return lines.join('\n') + '\n';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const directory = args.find((a) => a !== '--json') ?? join(process.env.BOGEN_HOME ?? join(homedir(), '.local/share/bogen'), 'traces');
  const result = await audit(directory);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : markdown(result));
}
