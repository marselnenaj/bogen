import { MAX_PARALLEL_RUNS } from '@bogen/core';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EFFORT_ID, MODEL_ID, RUNNER_IDS, RUNNERS, isRunnerId, type RunnerId } from '@bogen/core';
import { RunnerProbes } from './runner-probe.ts';
import { readClaudeCatalog } from './claude-catalog.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

export { EFFORT_ID, MODEL_ID };

export interface RunChoice { model?: string; effort?: string }
export type RunScope = 'prompt' | 'comment';
export interface RunnerSettings { prompt: RunChoice; comment: RunChoice }
/** `limits`: how many runs of each runner may go at once in a race. A plan has its own limits, and runs share it. */
export interface RunSettings { runners: Record<RunnerId, RunnerSettings>; shareCursors: boolean; limits: Record<RunnerId, number> }

export interface RunnerModel { id: string; label: string; resolvedId?: string; description?: string; efforts?: string[]; defaultEffort?: string }
export interface RunnerCatalog {
  id: RunnerId;
  /** The CLI-resolved default, when the metadata endpoint supplies it. */
  defaultModel?: string;
  models: RunnerModel[];
  efforts: string[];
  /** What a comment uses until the person chooses something else. */
  cheap: RunChoice;
  /** `cli` when the CLI itself said what it offers. */
  source: 'cli' | 'built-in';
  /**
   * How a model is chosen for this runner: from `models`, typed by the person (`free`, for an id the CLI's own
   * provider setup knows), or only the CLI's own default (`cli-default`).
   */
  entry?: 'catalog' | 'free' | 'cli-default';
  /** Why this runner cannot run here now, when it cannot: missing, too old, or lacking a switch Bogen needs. */
  problem?: string;
}

/** Says "no flag, let the CLI decide", as opposed to not having chosen anything yet. */
export const CLI_DEFAULT = 'default';

const CATALOG_CACHE_MS = 10 * 60_000;
const CATALOG_PATIENCE_MS = 2500;
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `claude --help` names aliases for the latest of each model, and has no list command. Haiku is the cheap one. */
const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'];

const CLAUDE_CHEAP: RunChoice = { model: 'haiku', effort: 'low' };
/** Models OpenCode lists, at most. A provider setup can name thousands. */
const MAX_LISTED = 400;

export interface CommandEnv { env: () => NodeJS.ProcessEnv }

function output(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    // A stand-in, or a future CLI, may wait for input it will never get.
    child.stdin?.end();
  });
}

const title = (alias: string) => alias.charAt(0).toUpperCase() + alias.slice(1);

export function parseClaudeHelp(help: string): { models: string[]; efforts: string[] } {
  const flat = help.replace(/\s+/g, ' ');
  const efforts = /--effort <level>.*?\(([a-z, ]+)\)/.exec(flat)?.[1]?.split(',').map((s) => s.trim()).filter(Boolean);
  const named = /--model <model>.*?\(e\.g\.(.*?)\)/.exec(flat)?.[1]?.match(/'([\w.-]+)'/g)?.map((m) => m.slice(1, -1));
  const models = [...new Set([...CLAUDE_ALIASES.filter((a) => a === 'haiku' || !named || named.includes(a)), ...(named ?? [])])];
  return { models, efforts: efforts?.length ? efforts : CLAUDE_EFFORTS };
}

interface CodexEntry { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; priority?: unknown; default_reasoning_level?: unknown; supported_reasoning_levels?: unknown }

export function parseCodexModels(text: string): { models: RunnerModel[]; cheap: RunChoice } {
  const parsed = JSON.parse(text) as { models?: CodexEntry[] } | CodexEntry[];
  const entries = (Array.isArray(parsed) ? parsed : parsed.models ?? []).filter((m) => typeof m.slug === 'string' && MODEL_ID.test(m.slug) && m.visibility !== 'hide');
  entries.sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999));
  const models: RunnerModel[] = entries.map((m) => {
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.flatMap((l: { effort?: unknown }) => (typeof l?.effort === 'string' && EFFORT_ID.test(l.effort) ? [l.effort] : [])) : [];
    return {
      id: m.slug as string, label: typeof m.display_name === 'string' ? m.display_name : (m.slug as string),
      ...(typeof m.description === 'string' ? { description: m.description } : {}),
      ...(levels.length ? { efforts: levels } : {}),
      ...(typeof m.default_reasoning_level === 'string' ? { defaultEffort: m.default_reasoning_level } : {}),
    };
  });
  // The catalog has no prices. It does say which models are the small ones, and the newest of those comes first.
  const cheapest = models.find((m) => /\b(affordable|efficient|fast)\b/i.test(m.description ?? ''));
  const cheap: RunChoice = cheapest ? { model: cheapest.id, ...(cheapest.efforts?.includes('low') ? { effort: 'low' } : {}) } : {};
  return { models, cheap };
}

/**
 * `opencode models` prints one `provider/model` per line, for the providers the person set up. Lines that are not
 * such an id (a banner, a warning) are left out, and so is anything a model field could not carry.
 */
export function parseOpencodeModels(text: string): RunnerModel[] {
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const id = raw.trim();
    if (id.includes('/') && MODEL_ID.test(id)) seen.add(id);
    if (seen.size >= MAX_LISTED) break;
  }
  return [...seen].map((id) => ({ id, label: id }));
}

export const DEFAULT_LIMIT = 2;
export const MAX_LIMIT = MAX_PARALLEL_RUNS;

function empty(): RunSettings {
  return {
    runners: Object.fromEntries(RUNNER_IDS.map((id) => [id, { prompt: {}, comment: {} }])) as Record<RunnerId, RunnerSettings>,
    shareCursors: false,
    limits: Object.fromEntries(RUNNER_IDS.map((id) => [id, DEFAULT_LIMIT])) as Record<RunnerId, number>,
  };
}

const limitOf = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_LIMIT ? v : DEFAULT_LIMIT);

/**
 * Why a model or effort cannot go to this runner, or null. An adapter without a documented per-run model switch
 * takes none, rather than one that would be dropped on the way.
 */
export function choiceProblem(runner: RunnerId, choice: RunChoice): string | null {
  const traits = RUNNERS[runner];
  if (choice.model && choice.model !== CLI_DEFAULT) {
    if (!MODEL_ID.test(choice.model)) return 'That is not a model id a CLI takes.';
    if (traits.models === 'cli-default') return `${traits.label} runs use the model set up in ${traits.label} itself: Bogen has no per-run model switch for it. Choose the CLI default, or change the model in ${traits.label}.`;
  }
  if (choice.effort && choice.effort !== CLI_DEFAULT && !traits.efforts) return `${traits.label} runs take no effort setting from Bogen. Choose the CLI default.`;
  return null;
}

/** Which model and effort runs use, kept in `$BOGEN_HOME/run-settings.json`, and what each CLI offers. */
export class RunSettingsStore {
  private settings: RunSettings = empty();
  /** Entries of a newer Bogen's runners, kept as they were so that going back and forth loses nothing. */
  private foreign: { runners: Record<string, unknown>; limits: Record<string, unknown> } = { runners: {}, limits: {} };
  private write: Promise<void> = Promise.resolve();
  private catalogs = new Map<RunnerId, { at: number; value: Promise<RunnerCatalog> }>();
  /** Version and capability probes of the CLIs, shared with the runs. */
  readonly probes: RunnerProbes;

  constructor(private readonly home: string, private readonly env: () => NodeJS.ProcessEnv = () => process.env, probes?: RunnerProbes) {
    this.probes = probes ?? new RunnerProbes(env);
  }

  private get path(): string {
    return join(this.home, 'run-settings.json');
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { runners?: Record<string, Partial<RunnerSettings>>; limits?: Record<string, unknown>; shareCursors?: unknown };
      // A file from before the newer runners has only two entries: the others start out empty, as defaults.
      for (const id of RUNNER_IDS) {
        for (const scope of ['prompt', 'comment'] as const) {
          this.settings.runners[id][scope] = clean(parsed.runners?.[id]?.[scope]);
        }
        this.settings.limits[id] = limitOf(parsed.limits?.[id]);
      }
      this.settings.shareCursors = parsed.shareCursors === true;
      const keep = (o: unknown) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => !isRunnerId(k) && /^[a-z][\w-]{0,31}$/.test(k)).slice(0, 16));
      this.foreign = { runners: keep(parsed.runners), limits: keep(parsed.limits) };
    } catch (e) {
      console.error(`bogen: run-settings.json was unreadable, using defaults: ${errorMessage(e)}`);
    }
  }

  get(): RunSettings {
    return structuredClone(this.settings);
  }

  async update(patch: { runner?: RunnerId; scope?: RunScope; model?: string | null; effort?: string | null; shareCursors?: boolean; limit?: number }): Promise<RunSettings> {
    if (patch.runner) {
      const problem = choiceProblem(patch.runner, { ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { effort: patch.effort } : {}) });
      if (problem) throw new HttpError(400, problem);
    }
    if (patch.runner && patch.limit !== undefined) this.settings.limits[patch.runner] = limitOf(patch.limit);
    if (patch.runner && patch.scope) {
      const current = this.settings.runners[patch.runner][patch.scope];
      if (patch.model === null) delete current.model;
      else if (patch.model !== undefined) current.model = patch.model;
      if (patch.effort === null) delete current.effort;
      else if (patch.effort !== undefined) current.effort = patch.effort;
    }
    if (patch.shareCursors !== undefined) this.settings.shareCursors = patch.shareCursors;
    const stored = { ...this.settings, runners: { ...this.foreign.runners, ...this.settings.runners }, limits: { ...this.foreign.limits, ...this.settings.limits } };
    const body = `${JSON.stringify(stored, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.path, body, 0o600));
    await this.write;
    return this.get();
  }

  catalog(id: RunnerId): Promise<RunnerCatalog> {
    const cached = this.catalogs.get(id);
    if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.value;
    const value = id === 'claude' ? this.claudeCatalog() : id === 'codex' ? this.codexCatalog() : this.newerCatalog(id);
    this.catalogs.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * The catalogs a settings snapshot shows: Claude's and Codex's as always, and those of the newer runners only
   * once someone asked for them. Listing settings never starts the other four CLIs.
   */
  async snapshot(options: { probe?: boolean } = {}): Promise<Partial<Record<RunnerId, RunnerCatalog>>> {
    const out: Partial<Record<RunnerId, RunnerCatalog>> = {};
    const eager = options.probe === false ? [] : RUNNER_IDS.filter((id) => RUNNERS[id].eager);
    const loaded = await Promise.all(eager.map((id) => this.catalog(id)));
    eager.forEach((id, i) => (out[id] = loaded[i]!));
    for (const id of RUNNER_IDS) {
      const cached = this.catalogs.get(id);
      if (eager.includes(id) || !cached || Date.now() - cached.at >= CATALOG_CACHE_MS) continue;
      const done = await Promise.race([cached.value, Promise.resolve(null)]);
      if (done) out[id] = done;
    }
    return out;
  }

  private async claudeCatalog(): Promise<RunnerCatalog> {
    const live = await readClaudeCatalog(this.env());
    if (live) {
      const haiku = live.models.find((m) => m.id === 'haiku') ?? live.models.find((m) => /^claude-haiku-/.test(m.id));
      const efforts = [...new Set(live.models.flatMap((model) => model.efforts ?? []))];
      return { id: 'claude', ...live, efforts, cheap: haiku ? { model: haiku.id, ...(haiku.efforts?.includes('low') ? { effort: 'low' } : {}) } : {}, source: 'cli', entry: 'catalog' };
    }
    const fallback = { models: CLAUDE_ALIASES, efforts: CLAUDE_EFFORTS };
    let found = fallback;
    let source: RunnerCatalog['source'] = 'built-in';
    try {
      const help = await output('claude', ['--help'], this.env(), 8000);
      if (help.includes('--model')) {
        found = parseClaudeHelp(help);
        source = 'cli';
      }
    } catch {
      // Not installed, or too old to say.
    }
    return { id: 'claude', models: found.models.map((id) => ({ id, label: title(id) })), efforts: found.efforts, cheap: CLAUDE_CHEAP, source, entry: 'catalog' };
  }

  /**
   * The full list needs the network, which may be slow or gone. A person opening the prompt should not wait for that:
   * after a moment the list shipped with the CLI answers, and the full one takes over when it arrives.
   */
  private async codexCatalog(): Promise<RunnerCatalog> {
    const read = async (args: string[], timeout: number): Promise<RunnerCatalog | null> => {
      try {
        const { models, cheap } = parseCodexModels(await output('codex', args, this.env(), timeout));
        return models.length ? { id: 'codex', models, efforts: CODEX_EFFORTS, cheap, source: 'cli', entry: 'catalog' } : null;
      } catch {
        return null;
      }
    };
    const full = read(['debug', 'models'], 20_000);
    const first = await Promise.race([full, new Promise<null>((done) => setTimeout(() => done(null), CATALOG_PATIENCE_MS).unref())]);
    if (first) return first;
    void full.then((late) => {
      if (late) this.catalogs.set('codex', { at: Date.now(), value: Promise.resolve(late) });
    });
    return (await read(['debug', 'models', '--bundled'], 8000)) ?? { id: 'codex', models: [], efforts: CODEX_EFFORTS, cheap: {}, source: 'built-in', entry: 'catalog' };
  }

  /**
   * Grok, OpenCode, Hermes and Oh My Pi, asked only when someone picks one. A runner Bogen does not run says why
   * and starts nothing. Otherwise the probe comes first: a CLI that is missing, too old or lacking a switch Bogen
   * needs says so here, and nothing else is started. No catalog invents a model, a price or an effort level.
   */
  private async newerCatalog(id: RunnerId): Promise<RunnerCatalog> {
    const traits = RUNNERS[id];
    const base: RunnerCatalog = { id, models: [], efforts: [], cheap: {}, source: 'built-in', entry: traits.models };
    if (traits.blocked) return { ...base, problem: traits.blocked };
    const probe = await this.probes.probe(id);
    if (probe.problem) return { ...base, problem: probe.problem };
    if (id === 'opencode') {
      try {
        const models = parseOpencodeModels(await this.probes.output('opencode', ['models'], 15_000));
        // An empty list says that no provider is set up, which is the person's to do in OpenCode.
        return { ...base, models, source: 'cli', ...(models.length ? {} : { problem: 'OpenCode lists no models. Set up a provider in OpenCode (opencode auth login), then choose OpenCode again.' }) };
      } catch {
        return { ...base, entry: 'free' };
      }
    }
    return base;
  }

  /**
   * What a run really uses. What was asked for wins, then the saved choice, and for comments the cheap default.
   * `default` means no flag at all.
   */
  async resolve(runner: RunnerId, scope: RunScope, asked: RunChoice = {}): Promise<RunChoice> {
    const saved = this.settings.runners[runner][scope];
    // Only Claude and Codex name a cheap model. The others use what the person set up in the CLI itself.
    const cheap = scope !== 'comment' || !RUNNERS[runner].eager ? {} : runner === 'claude' ? CLAUDE_CHEAP : (await this.catalog(runner)).cheap;
    const model = asked.model ?? saved.model ?? cheap.model;
    const effort = asked.effort ?? saved.effort ?? cheap.effort;
    return { ...(model && model !== CLI_DEFAULT ? { model } : {}), ...(effort && effort !== CLI_DEFAULT ? { effort } : {}) };
  }
}

function clean(value: RunChoice | undefined): RunChoice {
  const model = typeof value?.model === 'string' && (value.model === CLI_DEFAULT || MODEL_ID.test(value.model)) ? value.model : undefined;
  const effort = typeof value?.effort === 'string' && (value.effort === CLI_DEFAULT || EFFORT_ID.test(value.effort)) ? value.effort : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
