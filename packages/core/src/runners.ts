/**
 * The agent CLIs Bogen can run itself, in one place for the server, the editor and the phone. Ids are stable:
 * they are stored in settings, run history, conversations, reply targets and mentions. Labels are proper names,
 * data rather than product strings, so they are not translated.
 *
 * What a runner can do here is what Bogen's adapter for it was built and tested for, not what the CLI may do on
 * its own: a capability left out is refused with a reason rather than silently dropped.
 */
export const RUNNER_IDS = ['claude', 'codex', 'grok', 'opencode', 'hermes', 'omp'] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

/** How Bogen talks to the CLI. */
export type RunnerProtocol = 'claude-stream' | 'codex-json' | 'opencode-json' | 'none';

export interface RunnerTraits {
  id: RunnerId;
  /** The proper name, as people know it. */
  label: string;
  /** The executable looked up on PATH. Never a shell line. */
  command: string;
  protocol: RunnerProtocol;
  /** Images go with a request. */
  images: boolean;
  /** Runs on a person's own project in live site mode. */
  live: boolean;
  /** A reasoning effort can be chosen. */
  efforts: boolean;
  /**
   * Where models come from: `catalog`, a list the CLI prints; `free`, an id the person types, which the CLI's own
   * provider configuration must know (there is no list command Bogen relies on); `cli-default`, only the CLI's own
   * configured model (Bogen passes no model flag, since this adapter has no documented per-run model switch).
   */
  models: 'catalog' | 'free' | 'cli-default';
  /** Model ids are `provider/model`, as the CLI's own configuration names them. */
  qualifiedModels: boolean;
  /** Read at startup like before. The others are probed only when someone picks them. */
  eager: boolean;
  /**
   * Why Bogen does not run this CLI itself, when it does not: there is no documented per-run control that keeps
   * a run to Bogen's tools before the prompt is sent. Such a runner is never started for a run; the person can
   * still connect it to Bogen with `bogen install <id>` and use Bogen from that CLI.
   */
  blocked?: string;
}

const GROK_BLOCKED = 'Bogen cannot run Grok itself yet. Grok limits its built-in tools only in headless mode (--tools, --disallowed-tools), and that mode still keeps its always-on MCP tools and imports the MCP servers of other apps; its ACP mode has no such limit. So a run cannot be kept to Bogen\'s tools before it starts. To use Bogen from Grok, run `bogen install grok`.';
const HERMES_BLOCKED = 'Bogen cannot run Hermes itself yet. `hermes chat` takes MCP servers only from your own config.yaml (--safe-mode turns MCP off), and its ACP mode documents no per-session limit for its built-in tools. So a run cannot be kept to Bogen\'s tools before it starts. To use Bogen from Hermes, run `bogen install hermes`.';
const OMP_BLOCKED = 'Bogen cannot run Oh My Pi itself yet. --no-tools removes only its built-in tools: it still loads your own MCP servers and those it finds in other apps\' settings, and documents no switch that leaves them out of one run. To use Bogen from Oh My Pi, run `bogen install omp`.';

export const RUNNERS: Readonly<Record<RunnerId, RunnerTraits>> = {
  claude: { id: 'claude', label: 'Claude Code', command: 'claude', protocol: 'claude-stream', images: true, live: true, efforts: true, models: 'catalog', qualifiedModels: false, eager: true },
  codex: { id: 'codex', label: 'Codex', command: 'codex', protocol: 'codex-json', images: true, live: true, efforts: true, models: 'catalog', qualifiedModels: false, eager: true },
  grok: { id: 'grok', label: 'Grok', command: 'grok', protocol: 'none', images: false, live: false, efforts: false, models: 'cli-default', qualifiedModels: false, eager: false, blocked: GROK_BLOCKED },
  opencode: { id: 'opencode', label: 'OpenCode', command: 'opencode', protocol: 'opencode-json', images: false, live: false, efforts: false, models: 'catalog', qualifiedModels: true, eager: false },
  hermes: { id: 'hermes', label: 'Hermes', command: 'hermes', protocol: 'none', images: false, live: false, efforts: false, models: 'cli-default', qualifiedModels: true, eager: false, blocked: HERMES_BLOCKED },
  omp: { id: 'omp', label: 'Oh My Pi', command: 'omp', protocol: 'none', images: false, live: false, efforts: false, models: 'cli-default', qualifiedModels: true, eager: false, blocked: OMP_BLOCKED },
};

export function isRunnerId(value: unknown): value is RunnerId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RUNNERS, value);
}

/** The runners Bogen starts for a run, in the order pickers list them. */
export const RUNNABLE_IDS: readonly RunnerId[] = RUNNER_IDS.filter((id) => !RUNNERS[id].blocked);

/** The proper name of a runner, or the id itself for one this build does not know. */
export function runnerLabel(id: string): string {
  return isRunnerId(id) ? RUNNERS[id].label : id;
}

/**
 * A model id as CLIs name them: `opus`, `gpt-5.4`, `claude-opus-4[1m]`, or provider-qualified such as
 * `anthropic/claude-sonnet-4-5` and `openrouter/x-ai/grok-4`. It is passed as one argv item, never into a shell,
 * and never starts with `-`, so it cannot read as a flag. Nothing else: no spaces, quotes or newlines, so that a
 * model field cannot carry words for the prompt.
 */
export const MODEL_ID = /^(?=.{1,120}$)(?!-)[\w.:[\]-]+(?:\/(?!-)[\w.:@+[\]-]+){0,3}$/;
export const EFFORT_ID = /^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/;

/** Mentions in a comment that ask for an agent. An address such as me@claude.ai is not one. */
const MENTION = new RegExp(`(?:^|[\\s([{,;:'"])@(${RUNNER_IDS.join('|')})(?![\\w-]|\\.\\w)`, 'gi');

/** The agents a comment asks for, in order of first mention. */
export function agentMentions(text: string): RunnerId[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1]!.toLowerCase() as RunnerId))];
}
