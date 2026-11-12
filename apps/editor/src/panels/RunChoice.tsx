import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { agentMentions, isRunnerId, RUNNERS, runnerLabel, MAX_PARALLEL_RUNS } from '@bogen/core';
import { agentApi, type RunnerCatalog, type RunScope, type RunSettings } from '../lib/agent-api.ts';
import { catalogsToLoad } from './run-catalogs.ts';
import { editor } from '../state/store.ts';
import { SelectField } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/** One copy for the whole editor: the prompt, the comment boxes and the settings show the same choice. */
let answer: { settings: RunSettings; catalogs: Record<string, RunnerCatalog> } | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const fn of listeners) fn(); };

function load(): void {
  loading ??= agentApi.runSettings().then((a) => {
    answer = a;
    changed();
  }, () => { loading = null; });
}

/** Runners whose catalog was asked for. A catalog of the newer runners is only asked when one is picked. */
const asking = new Set<string>();

/** Loads the catalogs of the runners a picker shows right now, such as the lanes of a race. */
export function useRunnerCatalogs(runners: readonly string[]): void {
  const data = useRunSettings();
  const key = [...new Set(runners)].sort().join();
  useEffect(() => {
    for (const runner of catalogsToLoad(data?.catalogs, runners, asking)) loadCatalog(runner);
    // `key` stands for the runners; `data` changes when a catalog arrives.
  }, [data, key]);
}

function loadCatalog(runner: string): void {
  if (!answer || answer.catalogs[runner] || asking.has(runner) || !isRunnerId(runner)) return;
  asking.add(runner);
  agentApi.runnerCatalog(runner).then((catalog) => {
    if (answer) answer = { ...answer, catalogs: { ...answer.catalogs, [runner]: catalog } };
    changed();
  }, () => {}).finally(() => asking.delete(runner));
}

export function useRunSettings(): typeof answer {
  useEffect(load, []);
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, () => answer);
}

export const AUTO = '';
export const CLI_DEFAULT = 'default';

async function save(runner: string, scope: RunScope, field: 'model' | 'effort', value: string): Promise<void> {
  try {
    const settings = await agentApi.saveRunSetting({ runner, scope, [field]: value === AUTO ? null : value });
    if (answer) answer = { ...answer, settings };
    changed();
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

async function saveLimit(runner: string, limit: number): Promise<void> {
  try {
    const settings = await agentApi.saveRunSetting({ runner, limit });
    if (answer) answer = { ...answer, settings };
    changed();
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

/** Says whether a cursor also shows on other devices. */
export async function saveShareCursors(on: boolean): Promise<void> {
  const settings = await agentApi.saveRunSetting({ shareCursors: on });
  if (answer) answer = { ...answer, settings };
  changed();
}

export function runnerName(id: string): string {
  return runnerLabel(id);
}

/** What a run of this kind uses when nothing was chosen, in words. */
function autoLabel(catalog: RunnerCatalog | undefined, scope: RunScope, field: 'model' | 'effort'): string {
  const cheap = catalog?.cheap[field];
  if (scope === 'comment' && cheap) {
    if (field === 'effort') return cheap.charAt(0).toUpperCase() + cheap.slice(1);
    return t('{model}, cheapest', { model: catalog?.models.find((m) => m.id === cheap)?.label ?? cheap });
  }
  return field === 'model' && catalog?.defaultModel ? `${t('CLI default')} · ${catalog.defaultModel}` : t('CLI default');
}

/** Model and effort for one runner, for one kind of run. Remembered on the server. */
export function RunChoice({ runner, scope, testId }: { runner: string; scope: RunScope; testId?: string }) {
  const t = useT();
  const data = useRunSettings();
  const [, force] = useState(0);
  useEffect(() => force((n) => n + 1), [runner]);
  const catalog = data?.catalogs[runner];
  useEffect(() => { if (data && !catalog) loadCatalog(runner); }, [data, catalog, runner]);
  const current = data?.settings.runners[runner]?.[scope] ?? {};
  if (!catalog) return null;
  // Missing, too old, or lacking a switch Bogen needs: said in the CLI's own words, and nothing to choose.
  if (catalog.problem && !catalog.models.length) return <div className="run-choice run-choice-problem" role="status" data-testid={testId ? `${testId}-problem` : undefined}>{catalog.problem}</div>;
  const takesEffort = isRunnerId(runner) ? RUNNERS[runner].efforts : true;
  const onlyDefault = catalog.entry === 'cli-default';
  const chosen = catalog.models.find((m) => m.id === (current.model ?? (scope === 'comment' ? catalog.cheap.model : undefined)));
  const efforts = chosen?.efforts ?? catalog.efforts;
  const modelOptions = [
    { value: AUTO, label: autoLabel(catalog, scope, 'model') },
    ...(scope === 'comment' ? [{ value: CLI_DEFAULT, label: t('CLI default') }] : []),
    ...catalog.models.map((m) => ({ value: m.id, label: m.label })),
    // A model named by hand, or one the CLI no longer lists, stays selectable.
    ...(current.model && current.model !== CLI_DEFAULT && !catalog.models.some((m) => m.id === current.model) ? [{ value: current.model, label: current.model }] : []),
  ];
  const effortOptions = [
    { value: AUTO, label: autoLabel(catalog, scope, 'effort') },
    ...(scope === 'comment' ? [{ value: CLI_DEFAULT, label: t('CLI default') }] : []),
    ...efforts.map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) })),
  ];
  return (
    <div className="run-choice" data-testid={testId}>
      {onlyDefault ? null : <SelectField<string> value={current.model ?? AUTO} options={modelOptions} onChange={(v) => void save(runner, scope, 'model', v)} title={scope === 'comment' ? t('Model for comments') : t('Model for the prompt')} testId={testId ? `${testId}-model` : undefined} />}
      {takesEffort && (efforts.length || current.effort) ? <SelectField<string> value={current.effort ?? AUTO} options={effortOptions} onChange={(v) => void save(runner, scope, 'effort', v)} title={t('Effort: how hard the model thinks. Lower costs less of your plan.')} testId={testId ? `${testId}-effort` : undefined} /> : null}
      {onlyDefault ? <span className="run-choice-note" data-testid={testId ? `${testId}-default` : undefined}>{t('CLI default')}</span> : null}
    </div>
  );
}

/** Under a comment box, once the text asks an agent: who, and on what. */
export function CommentRunChoice({ text }: { text: string }) {
  const asked = agentMentions(text);
  if (!asked.length) return null;
  return (
    <div className="comment-run-choice" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {asked.map((runner) => (
        <div key={runner} className="comment-run-row">
          <span className="comment-run-name">{runnerName(runner)}</span>
          <RunChoice runner={runner} scope="comment" testId={`comment-choice-${runner}`} />
        </div>
      ))}
    </div>
  );
}

/**
 * In the Agents tab: every runner whose catalog is here, one group each. Each row is a group named by its runner
 * and its kind, so a screen reader says which model a select is for; the layout follows the sidebar's width.
 */
export function RunSettingsSection({ onlyRunner }: { onlyRunner?: string } = {}) {
  const t = useT();
  const data = useRunSettings();
  const id = useId();
  if (!data) return null;
  return (
    <div className="section-plain run-settings" data-testid="run-settings" role="group" aria-labelledby={`${id}models`}>
      <div className="feed-title" id={`${id}models`}>{t('Models')}</div>
      {Object.keys(data.catalogs).filter(runner => !onlyRunner || runner === onlyRunner).map((runner) => {
        const name = `${id}${runner}`;
        return (
          <div key={runner} className="run-settings-runner" role="group" aria-labelledby={name}>
            <div className="run-settings-name" id={name}>{runnerName(runner)}</div>
            <div className="run-settings-row" role="group" aria-labelledby={`${name} ${name}-prompt`}>
              <span className="run-settings-kind" id={`${name}-prompt`}>{t('Prompt')}</span>
              <RunChoice runner={runner} scope="prompt" testId={`settings-${runner}-prompt`} />
            </div>
            <div className="run-settings-row" role="group" aria-labelledby={`${name} ${name}-comment`}>
              <span className="run-settings-kind" id={`${name}-comment`}>{t('Comments')}</span>
              <RunChoice runner={runner} scope="comment" testId={`settings-${runner}-comment`} />
            </div>
            <div className="run-settings-row" role="group" aria-labelledby={`${name} ${name}-limit`} title={t('How many runs of this CLI a race starts at once. They share your plan and its limits; the rest wait their turn.')}>
              <span className="run-settings-kind" id={`${name}-limit`}>{t('In a race')}</span>
              <SelectField<string> value={String(data.settings.limits?.[runner] ?? 2)} options={Array.from({ length: MAX_PARALLEL_RUNS }, (_, i) => i + 1).map((n) => ({ value: String(n), label: t.n(n, '{count} at once', '{count} at once') }))} onChange={(v) => void saveLimit(runner, Number(v))} testId={`settings-${runner}-limit`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
