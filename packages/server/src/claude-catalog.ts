import { EFFORT_ID, MODEL_ID } from '@bogen/core';
import { execOutput, type ExecFn } from './runner-probe.ts';
import type { RunnerModel } from './run-settings.ts';

const REQUEST_ID = 'bogen-model-catalog';

/** Read SDK metadata only: no user message, prompt, model turn or tool is sent. */
export async function readClaudeCatalog(env: NodeJS.ProcessEnv, exec: ExecFn = execOutput): Promise<{ models: RunnerModel[]; defaultModel?: string } | null> {
  const input = JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize', hooks: {} } }) + '\n';
  const args = [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--settings', JSON.stringify({ disableAllHooks: true, sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false } }),
  ];
  let text: string;
  try {
    text = (await exec('claude', args, { env, timeout: 2500, input })).stdout;
  } catch (err) {
    // Some CLI versions exit nonzero on EOF without a user message, after a valid initialize response.
    text = typeof (err as { stdout?: unknown }).stdout === 'string' ? (err as { stdout: string }).stdout : '';
  }
  for (const line of text.split('\n')) {
    try {
      const d = JSON.parse(line);
      if (d?.type === 'control_response' && d.response?.request_id === REQUEST_ID && d.response?.subtype === 'success') return parseClaudeModels(d.response.response?.models);
    } catch { /* A CLI warning or an incomplete frame is not a catalog. */ }
  }
  return null;
}

function modelName(id: string): string {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/.exec(id);
  return match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}${match[4] ?? ''}` : id;
}

/** Account/provider labels come from the installed CLI, not a hardcoded version table. */
export function parseClaudeModels(raw: unknown): { models: RunnerModel[]; defaultModel?: string } | null {
  if (!Array.isArray(raw)) return null;
  const models: RunnerModel[] = [];const seen = new Set<string>();let defaultModel: string | undefined;
  for (const item of raw.slice(0, 400)) {
    if (!item || typeof item !== 'object' || typeof item.value !== 'string' || !MODEL_ID.test(item.value)) continue;
    const resolved = typeof item.resolvedModel === 'string' && MODEL_ID.test(item.resolvedModel) ? item.resolvedModel : undefined;
    if (item.value === 'default') { if (resolved) defaultModel = modelName(resolved);continue; }
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    const display = typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim().slice(0, 200) : item.value;
    const label = resolved && /^(?:opus|sonnet|haiku|fable)$/i.test(display) ? modelName(resolved) : display;
    const efforts = Array.isArray(item.supportedEffortLevels) ? item.supportedEffortLevels.filter((v: unknown): v is string => typeof v === 'string' && EFFORT_ID.test(v)) : undefined;
    models.push({ id: item.value, label, ...(resolved ? { resolvedId: resolved } : {}),
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 500) } : {}),
      ...(efforts ? { efforts: [...new Set<string>(efforts)] } : item.supportsEffort === false || item.supportsEffort === undefined ? { efforts: [] } : {}),
    });
  }
  return models.length ? { models, ...(defaultModel ? { defaultModel } : {}) } : null;
}
