import { describe, expect, it } from 'vitest';
import { parseClaudeModels, readClaudeCatalog } from '../src/claude-catalog.ts';
import type { ExecFn } from '../src/runner-probe.ts';

const entries = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-sonnet-5-5' },
  { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'not-an-effort'] },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
];
describe('Claude CLI model metadata, without a model turn', () => {
  it('keeps account/provider labels, versions, valid effort levels and an explicit CLI default', () => {
    expect(parseClaudeModels(entries)).toEqual({ defaultModel: 'Sonnet 5.5', models: [
      { id: 'opus', label: 'Opus 5.5', resolvedId: 'claude-opus-5-5', efforts: ['low', 'high'] },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
    ] });
  });
  it('does not claim Opus 5.5 when a deployment resolves to another version or custom model', () => {
    expect(parseClaudeModels([{ value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-6' }])?.models[0]?.label).toBe('Opus 4.6');
    expect(parseClaudeModels([{ value: 'opus', displayName: 'Opus', resolvedModel: 'my-provider-model' }])?.models[0]?.label).toBe('my-provider-model');
  });
  it('deduplicates model ids, drops malformed rows and leaves an unsupported catalog unknown', () => {
    expect(parseClaudeModels(null)).toBeNull();expect(parseClaudeModels([])).toBeNull();
    expect(parseClaudeModels([...entries, entries[1], { value: '--bad' }, { value: 12 }, null])?.models).toHaveLength(2);
  });
  it('sends only initialize metadata and closes input, with tools/MCP/hooks/session persistence disabled', async () => {
    const exec: ExecFn = async (command, args, options) => {
      expect(command).toBe('claude');expect(options.timeout).toBe(2500);
      const frames = options.input!.trim().split('\n').map((s) => JSON.parse(s));
      expect(frames).toHaveLength(1);expect(frames[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
      expect(args).toContain('--no-session-persistence');expect(args[args.indexOf('--tools') + 1]).toBe('');
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: {} });
      expect(JSON.parse(args[args.indexOf('--settings') + 1]!).disableAllHooks).toBe(true);
      return { stdout: JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frames[0].request_id, response: { models: entries, account: { private: 'never exposed' } } } }), stderr: '' };
    };
    const out = await readClaudeCatalog({}, exec);expect(out?.models[0]?.label).toBe('Opus 5.5');expect(JSON.stringify(out)).not.toContain('never exposed');
  });
  it('accepts a valid metadata response before a CLI EOF error, but no unrelated frames', async () => {
    const exec: ExecFn = async (_c, _a, options) => {
      const id = JSON.parse(options.input!).request_id;
      throw Object.assign(new Error('No user prompt'), { stdout: JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { models: entries } } }) });
    };
    expect((await readClaudeCatalog({}, exec))?.models).toHaveLength(2);
    expect(await readClaudeCatalog({}, async () => ({ stdout: '{broken}\n'+JSON.stringify({type:'result',models:entries}),stderr:'' }))).toBeNull();
  });
});
