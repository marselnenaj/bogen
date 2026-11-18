import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classifyRun } from '@bogen/core';
import { RunSettingsStore, type RunnerCatalog } from '../src/run-settings.ts';

/** A store with no CLI on the PATH: the built-in Claude catalog (haiku, sonnet, opus, fable), and nothing is started. */
async function store(saved?: object) {
  const home = mkdtempSync(join(tmpdir(), 'bogen-size-home-'));
  if (saved) writeFileSync(join(home, 'run-settings.json'), JSON.stringify(saved));
  const s = new RunSettingsStore(home, () => ({ PATH: '' }));
  await s.load();
  return { s, home };
}
const small = classifyRun({ prompt: 'Make the headline bigger' });
const large = classifyRun({ prompt: 'Redesign the start page' });
const answer = classifyRun({ prompt: 'What do you think of the hero?' });

describe('the model by the size of the request', () => {
  it('picks Sonnet at medium effort for a small change and at low effort for an answer, and keeps the default for a large one', async () => {
    const { s } = await store();
    expect(await s.resolveBySize('claude', {}, small)).toEqual({ choice: { model: 'sonnet', effort: 'medium' }, sized: { size: 'small', reason: 'one target, a local change', model: 'sonnet', effort: 'medium', label: 'Sonnet' } });
    expect((await s.resolveBySize('claude', {}, answer)).choice).toEqual({ model: 'sonnet', effort: 'low' });
    const big = await s.resolveBySize('claude', {}, large);
    expect(big.choice).toEqual({});
    expect(big.sized).toMatchObject({ size: 'large' });
  });

  it('falls back to Opus at low effort without Sonnet', async () => {
    const { s } = await store();
    const catalog: RunnerCatalog = { id: 'claude', models: [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] }, { id: 'haiku', label: 'Haiku' }], efforts: ['low', 'medium', 'high'], cheap: {}, source: 'cli', defaultModel: 'Opus 5.5' };
    vi.spyOn(s, 'catalog').mockResolvedValue(catalog);
    expect((await s.resolveBySize('claude', {}, small)).choice).toEqual({ model: 'opus', effort: 'low' });
    expect((await s.resolveBySize('claude', {}, large)).sized).toEqual({ ...large, label: 'Opus 5.5' });
  });

  it('never overrides a choice: this request, the saved settings, a call preference, or another runner', async () => {
    const { s } = await store();
    expect(await s.resolveBySize('claude', { model: 'opus' }, small)).toEqual({ choice: { model: 'opus' } });
    expect(await s.resolveBySize('claude', { effort: 'high' }, small)).toEqual({ choice: { effort: 'high' } });
    expect(await s.resolveBySize('claude', {}, small, true)).toEqual({ choice: {} });
    expect(await s.resolveBySize('codex', {}, small)).toEqual({ choice: {} });

    const saved = { runners: { claude: { prompt: { model: 'opus', effort: 'high' }, comment: { model: 'opus', effort: 'high' } }, codex: { prompt: {}, comment: {} } } };
    const kept = await store(saved);
    expect(await kept.s.resolveBySize('claude', {}, small)).toEqual({ choice: { model: 'opus', effort: 'high' } });
    // Only an effort saved is a choice too, and "CLI default" is one.
    const effortOnly = await store({ runners: { claude: { prompt: { effort: 'max' }, comment: {} } } });
    expect(await effortOnly.s.resolveBySize('claude', {}, small)).toEqual({ choice: { effort: 'max' } });
    const cliDefault = await store({ runners: { claude: { prompt: { model: 'default' }, comment: {} } } });
    expect(await cliDefault.s.resolveBySize('claude', {}, small)).toEqual({ choice: {} });
  });

  it('only reads the saved settings: the file stays as it was', async () => {
    const saved = { runners: { claude: { prompt: {}, comment: { model: 'opus', effort: 'high' } }, codex: { prompt: {}, comment: { model: 'gpt-6.1-sol', effort: 'default' } } }, shareCursors: false, limits: { claude: 2, codex: 2 } };
    const { s, home } = await store(saved);
    const before = readFileSync(join(home, 'run-settings.json'), 'utf8');
    await s.resolveBySize('claude', {}, small);
    await s.resolveBySize('claude', {}, answer);
    expect(readFileSync(join(home, 'run-settings.json'), 'utf8')).toBe(before);
    expect(s.get().runners.claude).toEqual({ prompt: {}, comment: { model: 'opus', effort: 'high' } });
  });
});
