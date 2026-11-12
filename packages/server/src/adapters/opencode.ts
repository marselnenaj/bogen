/**
 * The adapter for OpenCode (`opencode run --format json`), which runs one prompt and prints JSON lines. The run
 * adds an MCP server of its own, and a fresh agent selected for the run permits only that server's tools, before
 * the prompt is sent. What it does not promise: OpenCode merges the person's own configuration in, so MCP servers
 * they configured may still be started and connected (their tools are denied to the run's agent); and a managed
 * configuration an administrator installed comes after the inline one and may change permissions. That is the
 * administrator's policy, and Bogen does not try to override it.
 *
 * Upstream contracts it follows (2026-11): OpenCode's CLI, config, permissions and MCP docs
 * (dev.opencode.ai/docs/cli, /docs/config, /docs/permissions, /docs/mcp-servers). The switches it relies on are
 * checked against the installed CLI's own help first (`runner-probe.ts`), and a build without one is refused
 * rather than run without it.
 */
import type { RunRequest } from '../agents.ts';

export interface ParsedEvent { kind: 'text' | 'tool' | 'error'; text?: string; tool?: string }

export interface Command { command: string; args: string[]; stdin: string; env: Record<string, string> }

/**
 * Linux takes at most 128 KiB for one argument. OpenCode reads its message from argv, and a run with a long
 * conversation before it is refused with a reason rather than cut.
 */
export const MAX_ARG_BYTES = 120_000;

export interface RunHeaders { agent: string; fileId: string; runId: string }

function message(system: string, prompt: string, label: string): string {
  // The system prompt starts with words, so the one argument can never read as an option.
  const text = `${system}\n\n${prompt}`;
  if (/^-/.test(text)) throw new Error('A prompt for a command line must not start with "-".');
  if (Buffer.byteLength(text) > MAX_ARG_BYTES) throw new Error(`This request is too long for ${label}'s command line (${Math.round(Buffer.byteLength(text) / 1024)} KiB). Start a new conversation, or shorten it.`);
  return text;
}

/** The run's own MCP server and agent names. Unique per run, so that nothing in the person's own config shares them. */
export function opencodeNames(runId: string): { server: string; agent: string } {
  const id = runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'run';
  return { server: `bogen_run_${id}`, agent: `bogen-run-${id}` };
}

/** Rules for one run, in order: OpenCode's permissions are last-match-wins, so the one allow comes after the deny. */
export function opencodeRules(server: string): Record<string, 'allow' | 'deny'> {
  return { '*': 'deny', [`${server}_*`]: 'allow' };
}

/**
 * OpenCode. Its configuration is merged from the person's own files and `OPENCODE_CONFIG_CONTENT`. A merged
 * top-level `permission` is not enough by itself: specific allows of the person's own (`bash`, `edit`, a tool
 * of their MCP server) can stay ahead of or behind our keys, and their default agent may override permissions
 * too. So the run gets an agent of its own, named for this run alone so no config of the person's can touch it,
 * a primary agent whose own rules deny every tool and then allow only the tools of this run's MCP server, and
 * `--agent` selects it. Per OpenCode's permissions and agents docs, an agent's rules are applied over the
 * global ones, and the last matching rule wins.
 *
 * The run's MCP server has a name of its own too. A `bogen` server the person registered with `bogen install
 * opencode` is theirs, without a run: its tools are denied here like any other. `--pure` leaves out external
 * plugins. The login stays where OpenCode keeps it.
 */
export function buildOpencodeCommand(req: RunRequest, system: string, endpoint: { url: string; token?: string }, ids: RunHeaders): Command {
  const headers: Record<string, string> = { 'X-Bogen-Agent': ids.agent, 'X-Bogen-File': ids.fileId, 'X-Bogen-Run': ids.runId };
  // In the inline configuration, which lives in this one child's environment like Codex's BOGEN_MCP_TOKEN: in no
  // file and no argument. (`{env:…}` substitution is documented for config files, not certain for inline content.)
  if (endpoint.token) headers.Authorization = `Bearer ${endpoint.token}`;
  const names = opencodeNames(ids.runId);
  const rules = opencodeRules(names.server);
  const config = {
    $schema: 'https://opencode.ai/config.json',
    mcp: { [names.server]: { type: 'remote', url: endpoint.url, headers, enabled: true, oauth: false } },
    // The same rules at the top too, for anything that reads the global ones.
    permission: rules,
    agent: { [names.agent]: { mode: 'primary', description: 'One Bogen run: only the Bogen tools of this run.', permission: rules } },
    autoupdate: false,
    share: 'disabled',
  };
  return {
    command: 'opencode',
    args: ['--pure', 'run', '--format', 'json', '--agent', names.agent, ...(req.model ? ['--model', req.model] : []), message(system, userText(req), 'OpenCode')],
    stdin: '',
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  };
}

function userText(req: RunRequest): string {
  return req.context ? `${req.context}\n\nThe person's new message:\n${req.prompt}` : req.prompt;
}

/** A tool of the run's own server, as OpenCode names it: `<server>_<tool>`. */
const RUN_TOOL = /^bogen_run_[A-Za-z0-9]+_([a-z][a-z0-9_]*)$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** One line of `opencode run --format json`. */
export function parseOpencodeLine(line: string): ParsedEvent[] {
  // A line that is JSON but no object (null, a number, a list) says nothing; one that is no JSON throws, and the
  // run's reader skips it.
  const msg = obj(JSON.parse(line));
  if (!msg) return [];
  const part = obj(msg.part);
  if (msg.type === 'text' && part) {
    const text = str(part.text);
    return text?.trim() ? [{ kind: 'text', text }] : [];
  }
  if (msg.type === 'tool_use' && part) {
    const name = str(part.tool) ?? 'tool';
    const tool = RUN_TOOL.exec(name)?.[1] ?? null;
    // Another tool shows here too, denied with an error state: it never ran, and is no step of the run.
    return tool ? [{ kind: 'tool', tool }] : [];
  }
  if (msg.type === 'error') {
    const error = obj(msg.error);
    const text = str(obj(error?.data)?.message) ?? str(error?.message) ?? str(error?.name) ?? str(msg.message) ?? 'OpenCode reported an error.';
    return [{ kind: 'error', text }];
  }
  return [];
}
