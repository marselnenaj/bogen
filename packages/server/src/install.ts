import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { installSkill, removeSkill, skillPath } from './skill.ts';
import { atomicWrite, errorMessage } from './util.ts';

const run = promisify(execFile);

/**
 * Clients that can use Bogen's MCP server. This is registration for the client's own sessions, which is not the
 * same as Bogen starting that CLI for a run: OpenCode is both, Grok, Hermes and Oh My Pi only this (see
 * `blocked` in core's runner registry for why).
 */
export const CLIENTS = ['claude-code', 'codex', 'cursor', 'vscode', 'opencode', 'gemini', 'zed', 'grok', 'hermes', 'omp'] as const;
export type Client = (typeof CLIENTS)[number];

export interface InstallResult { client: Client; ok: boolean; how: string; skipped?: boolean }
export interface Command { command: string; args: string[] }

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Next.
    }
  }
  return false;
}

/**
 * How another program starts this CLI: `bogen` if that is what is on PATH, else the command install.sh wrote for
 * this very script (it finds Node again after an update of Node), else the exact script.
 */
export function selfCommand(script = resolve(process.argv[1]!)): Command {
  if (script.endsWith('dist/cli.js') && onPath('bogen')) return { command: 'bogen', args: ['mcp'] };
  const wrapper = join(homedir(), '.local', 'bin', 'bogen');
  try {
    const text = readFileSync(wrapper, 'utf8');
    if (text.includes("Written by Bogen's install.sh") && text.includes(`'${script}'`)) return { command: wrapper, args: ['mcp'] };
  } catch {
    // No such command.
  }
  return { command: process.execPath, args: [...process.execArgv, script, 'mcp'] };
}

// JSON with comments. Clients keep their settings in files people edit by hand, so an edit must leave
// every comment and all formatting alone. This finds the exact span to change and splices text in.

interface Span { start: number; end: number }

function skipSpace(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment.');
      i = end + 2;
    } else return i;
  }
}

function skipString(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j + 1;
  }
  throw new Error('Unterminated string.');
}

function skipValue(text: string, start: number): number {
  let i = skipSpace(text, start);
  const c = text[i];
  if (c === '"') return skipString(text, i);
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    i = skipSpace(text, i + 1);
    while (text[i] !== close) {
      if (i >= text.length) throw new Error('Unexpected end of file.');
      if (c === '{') {
        if (text[i] !== '"') throw new Error(`Expected a key at offset ${i}.`);
        i = skipSpace(text, skipString(text, i));
        if (text[i] !== ':') throw new Error(`Expected ":" at offset ${i}.`);
        i++;
      }
      i = skipSpace(text, skipValue(text, i));
      if (text[i] === ',') i = skipSpace(text, i + 1);
      else if (text[i] !== close) throw new Error(`Expected "," at offset ${i}.`);
    }
    return i + 1;
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
  if (!m) throw new Error(`Unexpected content at offset ${i}.`);
  return i + m[0].length;
}

/** Finds a key's value in the object starting at `objectStart`. */
function findKey(text: string, objectStart: number, key: string): Span | null {
  let i = skipSpace(text, objectStart + 1);
  while (text[i] !== '}') {
    const keyEnd = skipString(text, i);
    const name = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipSpace(text, keyEnd) + 1;
    const start = skipSpace(text, i);
    const end = skipValue(text, start);
    if (name === key) return { start, end };
    i = skipSpace(text, end);
    if (text[i] === ',') i = skipSpace(text, i + 1);
  }
  return null;
}

/** Takes `path` out of JSON or JSONC text, with its comma, and changes nothing else. False when it is not there. */
export function jsoncRemove(text: string, path: string[]): { text: string; removed: boolean } {
  if (!text.trim()) return { text, removed: false };
  let objectStart = skipSpace(text, 0);
  if (text[objectStart] !== '{') throw new Error('The file is not a JSON object.');
  skipValue(text, objectStart);
  for (let depth = 0; depth < path.length - 1; depth++) {
    const span = findKey(text, objectStart, path[depth]!);
    if (!span || text[span.start] !== '{') return { text, removed: false };
    objectStart = span.start;
  }
  const key = path.at(-1)!;
  let i = skipSpace(text, objectStart + 1);
  let previousEnd: number | null = null;
  while (text[i] !== '}') {
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const name = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipSpace(text, keyEnd) + 1;
    const end = skipValue(text, skipSpace(text, i));
    i = skipSpace(text, end);
    const comma = text[i] === ',';
    if (comma) i = skipSpace(text, i + 1);
    if (name === key) {
      if (comma) {
        // The next member moves up to where this one started.
        return { text: text.slice(0, keyStart) + text.slice(i), removed: true };
      }
      if (previousEnd !== null) return { text: text.slice(0, previousEnd) + text.slice(end), removed: true };
      return { text: text.slice(0, objectStart + 1) + text.slice(end), removed: true };
    }
    previousEnd = end;
  }
  return { text, removed: false };
}

function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function pretty(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function insertKey(text: string, objectStart: number, key: string, value: unknown): string {
  const objectEnd = skipValue(text, objectStart) - 1;
  const base = indentAt(text, objectStart);
  const inner = `${base}  `;
  const first = skipSpace(text, objectStart + 1);
  const empty = first === objectEnd;
  const entry = `${JSON.stringify(key)}: ${pretty(value, inner)}`;
  if (empty) return `${text.slice(0, objectStart + 1)}\n${inner}${entry}\n${base}${text.slice(objectEnd)}`;
  // Find the end of the last member, to add a comma right after it.
  let i = first;
  let lastEnd = first;
  while (text[i] !== '}') {
    const keyEnd = skipString(text, i);
    i = skipSpace(text, keyEnd) + 1;
    lastEnd = skipValue(text, i);
    i = skipSpace(text, lastEnd);
    if (text[i] === ',') i = skipSpace(text, i + 1);
  }
  const commaAt = skipSpace(text, lastEnd);
  const trailingComma = text[commaAt] === ',';
  const memberIndent = indentAt(text, first);
  // A comment on the same line belongs to the member before it, so the new one goes after that.
  let lineEnd = trailingComma ? commaAt + 1 : lastEnd;
  for (;;) {
    let p = lineEnd;
    while (text[p] === ' ' || text[p] === '\t') p++;
    if (text.startsWith('//', p)) {
      const nl = text.indexOf('\n', p);
      lineEnd = nl < 0 ? text.length : nl;
      break;
    }
    const close = text.startsWith('/*', p) ? text.indexOf('*/', p) : -1;
    if (close < 0 || text.slice(p, close).includes('\n')) break;
    lineEnd = close + 2;
  }
  const member = `\n${memberIndent}${JSON.stringify(key)}: ${pretty(value, memberIndent)}${trailingComma ? ',' : ''}`;
  return `${text.slice(0, lastEnd)}${trailingComma ? '' : ','}${text.slice(lastEnd, lineEnd)}${member}${text.slice(lineEnd)}`;
}

/** Sets `path` in JSON or JSONC text, changing nothing else. */
export function jsoncSet(text: string, path: string[], value: unknown): string {
  const source = text.trim() ? text : '{}\n';
  let objectStart = skipSpace(source, 0);
  if (source[objectStart] !== '{') throw new Error('The file is not a JSON object.');
  skipValue(source, objectStart);
  let current = source;
  for (let depth = 0; depth < path.length; depth++) {
    const key = path[depth]!;
    const span = findKey(current, objectStart, key);
    const isLast = depth === path.length - 1;
    if (isLast) {
      if (span) {
        const indent = indentAt(current, span.start);
        return current.slice(0, span.start) + pretty(value, indent) + current.slice(span.end);
      }
      return insertKey(current, objectStart, key, value);
    }
    if (!span || current[span.start] !== '{') {
      let nested: unknown = value;
      for (let k = path.length - 1; k > depth; k--) nested = { [path[k]!]: nested };
      if (span) {
        const indent = indentAt(current, span.start);
        return current.slice(0, span.start) + pretty(nested, indent) + current.slice(span.end);
      }
      return insertKey(current, objectStart, key, nested);
    }
    objectStart = span.start;
  }
  return current;
}

async function editJsonFile(path: string, keys: string[], value: unknown): Promise<string> {
  let text = '';
  let mode = 0o600;
  try {
    text = await readFile(path, 'utf8');
    mode = (await stat(path)).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(dirname(path), { recursive: true });
  }
  let next: string;
  try {
    next = jsoncSet(text, keys, value);
  } catch (e) {
    throw new Error(`${path} could not be read as JSON, so it was left alone: ${errorMessage(e)}`);
  }
  await atomicWrite(path, next, mode);
  return `wrote ${path}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Replaces or appends one section, as plain text, so that the rest of the file stays byte for byte. */
export function tomlSetServer(text: string, name: string, command: Command): string {
  const header = `[mcp_servers.${name}]`;
  const block = `${header}\ncommand = ${tomlString(command.command)}\nargs = [${command.args.map(tomlString).join(', ')}]\n`;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // Keep the blank line that separates this from the next section.
  const tail = end < lines.length ? ['', ...lines.slice(end)] : [''];
  return [...lines.slice(0, start), block.trimEnd(), ...tail].join('\n');
}

async function editCodexToml(command: Command): Promise<string> {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(dirname(path), { recursive: true });
  }
  await atomicWrite(path, tomlSetServer(text, 'bogen', command), 0o600);
  return `wrote ${path}`;
}

const zedConfig = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'zed', 'settings.json');
const vscodeConfig = () => (process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code', 'User', 'mcp.json'));
const opencodeConfig = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode', 'opencode.json');
const stdioJson = (c: Command) => ({ command: c.command, args: c.args });

async function runCli(name: string, args: string[]): Promise<void> {
  await run(name, args, { timeout: 30_000 });
}

/** Grok's own flag that keeps a scripted call from checking for an update, before every subcommand. */
const GROK = ['--no-auto-update'];
/** Hermes keeps its settings in `$HERMES_HOME/config.yaml`, `~/.hermes` by default. Only read here, never rewritten by hand. */
const hermesConfig = () => join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), 'config.yaml');

/**
 * Oh My Pi's user MCP file: `<agent dir>/mcp.json`, the agent dir `~/.omp/agent` unless PI_CODING_AGENT_DIR names
 * another. With only PI_CONFIG_DIR set, where the agent dir lands is not something Bogen guesses: it says so.
 */
function ompConfig(): string {
  if (process.env.PI_CODING_AGENT_DIR) return join(process.env.PI_CODING_AGENT_DIR, 'mcp.json');
  // A named profile has its own agent folder. Writing the default one instead would register Bogen elsewhere.
  if (process.env.OMP_PROFILE) throw new Error(`OMP_PROFILE is set (${process.env.OMP_PROFILE.slice(0, 60)}), and Bogen does not write into a profile's mcp.json by guessing its folder. Set PI_CODING_AGENT_DIR to that profile's agent folder, or add a "bogen" entry under "mcpServers" in it yourself.`);
  if (process.env.PI_CONFIG_DIR) throw new Error('PI_CONFIG_DIR is set, and Bogen does not guess where that puts Oh My Pi\'s mcp.json. Set PI_CODING_AGENT_DIR to the agent folder, or add a "bogen" entry under "mcpServers" in that mcp.json yourself.');
  return join(homedir(), '.omp', 'agent', 'mcp.json');
}

function needCli(name: string, label: string): void {
  if (!onPath(name)) throw new Error(`${label} (${name}) is not on PATH. Install it first; Bogen registers itself with ${label}'s own command.`);
}

/**
 * Whether Hermes' config.yaml names a `bogen` server under `mcp_servers`, for status only, by reading lines: a
 * top-level `mcp_servers:` block and an indented `bogen:` inside it. Any other way of writing `mcp_servers` (a
 * flow map, an anchor, a document of several parts) is valid YAML this reader does not follow, and then the
 * answer is null: not known. No YAML is rewritten here; changes go through `hermes mcp`.
 */
export function hermesHasServer(yaml: string, name = 'bogen'): boolean | null {
  let inside = false;
  let indent: number | null = null;
  let unread = false;
  for (const line of yaml.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^(?:---|\.\.\.)\s*$/.test(line)) unread = true;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      inside = /^mcp_servers\s*:\s*(?:#.*)?$/.test(line);
      indent = null;
      if (!inside && /^["']?mcp_servers["']?\s*:/.test(line)) unread = true;
      continue;
    }
    if (!inside) continue;
    indent ??= lead;
    if (lead === indent && new RegExp(`^\\s*["']?${name}["']?\\s*:`).test(line)) return true;
    if (lead === indent && /^\s*[<&*]/.test(line)) unread = true;
  }
  return unread ? null : false;
}

const INSTALLERS: Record<Client, (c: Command) => Promise<string>> = {
  'claude-code': async (c) => {
    if (onPath('claude')) {
      // `add` refuses an existing name, and remove fails when there is none. Both are fine here.
      await runCli('claude', ['mcp', 'remove', '--scope', 'user', 'bogen']).catch(() => {});
      await runCli('claude', ['mcp', 'add', '--scope', 'user', 'bogen', '--', c.command, ...c.args]);
      return 'ran claude mcp add';
    }
    return editJsonFile(join(homedir(), '.claude.json'), ['mcpServers', 'bogen'], { type: 'stdio', ...stdioJson(c) });
  },
  codex: async (c) => {
    if (onPath('codex')) {
      // Codex refuses a CODEX_HOME that does not exist yet, even to write its first config there.
      if (process.env.CODEX_HOME) await mkdir(process.env.CODEX_HOME, { recursive: true });
      await runCli('codex', ['mcp', 'remove', 'bogen']).catch(() => {});
      await runCli('codex', ['mcp', 'add', 'bogen', '--', c.command, ...c.args]);
      return 'ran codex mcp add';
    }
    return editCodexToml(c);
  },
  cursor: (c) => editJsonFile(join(homedir(), '.cursor', 'mcp.json'), ['mcpServers', 'bogen'], stdioJson(c)),
  vscode: async (c) => {
    if (onPath('code')) {
      await runCli('code', ['--add-mcp', JSON.stringify({ name: 'bogen', ...stdioJson(c) })]);
      return 'ran code --add-mcp';
    }
    return editJsonFile(vscodeConfig(), ['servers', 'bogen'], { type: 'stdio', ...stdioJson(c) });
  },
  opencode: (c) => editJsonFile(opencodeConfig(), ['mcp', 'bogen'], { type: 'local', command: [c.command, ...c.args], enabled: true }),
  gemini: async (c) => {
    if (onPath('gemini')) {
      await runCli('gemini', ['mcp', 'remove', '--scope', 'user', 'bogen']).catch(() => {});
      await runCli('gemini', ['mcp', 'add', '--scope', 'user', 'bogen', c.command, ...c.args]);
      return 'ran gemini mcp add';
    }
    return editJsonFile(join(homedir(), '.gemini', 'settings.json'), ['mcpServers', 'bogen'], stdioJson(c));
  },
  zed: (c) => editJsonFile(zedConfig(), ['context_servers', 'bogen'], stdioJson(c)),
  // `grok mcp add <name> -- <command> <args...>`, from Grok's MCP docs. An entry already there is replaced.
  grok: async (c) => {
    needCli('grok', 'Grok');
    await runCli('grok', [...GROK, 'mcp', 'remove', 'bogen']).catch(() => {});
    await runCli('grok', [...GROK, 'mcp', 'add', 'bogen', '--', c.command, ...c.args]);
    return 'ran grok mcp add';
  },
  // `hermes mcp add <name> --command <exe> --args <argv...>`, with --args last, from Hermes' MCP docs.
  hermes: async (c) => {
    needCli('hermes', 'Hermes');
    await runCli('hermes', ['mcp', 'remove', 'bogen']).catch(() => {});
    await runCli('hermes', ['mcp', 'add', 'bogen', '--command', c.command, ...(c.args.length ? ['--args', ...c.args] : [])]);
    return 'ran hermes mcp add';
  },
  // Oh My Pi has no add command: its user mcp.json gets the entry, with everything else in the file left as it was.
  omp: (c) => editJsonFile(ompConfig(), ['mcpServers', 'bogen'], stdioJson(c)),
};

async function removeFromJson(path: string, keys: string[]): Promise<string> {
  let text: string;
  let mode: number;
  try {
    text = await readFile(path, 'utf8');
    mode = (await stat(path)).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `nothing in ${path}`;
    throw e;
  }
  const { text: next, removed } = jsoncRemove(text, keys);
  if (!removed) return `nothing in ${path}`;
  await atomicWrite(path, next, mode);
  return `removed from ${path}`;
}

/** Takes one section out, as plain text, leaving the rest byte for byte. */
export function tomlRemoveServer(text: string, name: string): { text: string; removed: boolean } {
  const header = `[mcp_servers.${name}]`;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return { text, removed: false };
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  // At the end of the file, the blank line that install put before the section goes with it.
  if (end === lines.length) {
    const from = start > 0 && lines[start - 1] === '' ? start - 1 : start;
    const kept = lines.slice(0, from).join('\n');
    return { text: kept && !kept.endsWith('\n') ? `${kept}\n` : kept, removed: true };
  }
  return { text: [...lines.slice(0, start), ...lines.slice(end)].join('\n'), removed: true };
}

async function removeCodexToml(): Promise<string> {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `nothing in ${path}`;
    throw e;
  }
  const { text: next, removed } = tomlRemoveServer(text, 'bogen');
  if (!removed) return `nothing in ${path}`;
  await atomicWrite(path, next, 0o600);
  return `removed from ${path}`;
}

const UNINSTALLERS: Record<Client, () => Promise<string>> = {
  'claude-code': async () => {
    if (onPath('claude')) {
      await runCli('claude', ['mcp', 'remove', '--scope', 'user', 'bogen']).catch(() => {});
      return 'ran claude mcp remove';
    }
    return removeFromJson(join(homedir(), '.claude.json'), ['mcpServers', 'bogen']);
  },
  codex: async () => {
    if (onPath('codex')) {
      await runCli('codex', ['mcp', 'remove', 'bogen']).catch(() => {});
      return 'ran codex mcp remove';
    }
    return removeCodexToml();
  },
  cursor: () => removeFromJson(join(homedir(), '.cursor', 'mcp.json'), ['mcpServers', 'bogen']),
  vscode: () => removeFromJson(vscodeConfig(), ['servers', 'bogen']),
  opencode: () => removeFromJson(opencodeConfig(), ['mcp', 'bogen']),
  gemini: async () => {
    if (onPath('gemini')) {
      await runCli('gemini', ['mcp', 'remove', '--scope', 'user', 'bogen']).catch(() => {});
      return 'ran gemini mcp remove';
    }
    return removeFromJson(join(homedir(), '.gemini', 'settings.json'), ['mcpServers', 'bogen']);
  },
  zed: () => removeFromJson(zedConfig(), ['context_servers', 'bogen']),
  grok: async () => {
    needCli('grok', 'Grok');
    await runCli('grok', [...GROK, 'mcp', 'remove', 'bogen']);
    return 'ran grok mcp remove';
  },
  hermes: async () => {
    // Asked explicitly, so Hermes' own command decides: Bogen's line reader is for status, not for skipping this.
    needCli('hermes', 'Hermes');
    await runCli('hermes', ['mcp', 'remove', 'bogen']);
    return 'ran hermes mcp remove';
  },
  omp: () => removeFromJson(ompConfig(), ['mcpServers', 'bogen']),
};

export async function uninstall(clients: Client[]): Promise<InstallResult[]> {
  const out: InstallResult[] = [];
  for (const client of clients) {
    try {
      const how = await UNINSTALLERS[client]();
      const skill = await removeSkill(client);
      out.push({ client, ok: true, how: skill ? `${how}; ${skill}` : how });
    } catch (e) {
      out.push({ client, ok: false, how: errorMessage(e) });
    }
  }
  return out;
}

/** What is registered, read from each client's own files and changing nothing. */
export async function registration(client: Client): Promise<{ registered: boolean | null; where: string; skill: boolean | null }> {
  const home = homedir();
  const readJson = async (path: string): Promise<Record<string, any> | null> => {
    try {
      return JSON.parse((await readFile(path, 'utf8')).replace(/^\s*\/\/.*$/gm, '')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const skillAt = skillPath(client);
  const skill = skillAt ? existsSync(skillAt) : null;
  switch (client) {
    case 'claude-code': {
      const where = join(home, '.claude.json');
      return { registered: Boolean((await readJson(where))?.mcpServers?.bogen), where, skill };
    }
    case 'codex': {
      const where = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml');
      const text = await readFile(where, 'utf8').catch(() => '');
      return { registered: text.split('\n').some((l) => l.trim() === '[mcp_servers.bogen]'), where, skill };
    }
    case 'cursor': {
      const where = join(home, '.cursor', 'mcp.json');
      return { registered: Boolean((await readJson(where))?.mcpServers?.bogen), where, skill };
    }
    case 'vscode': {
      const where = vscodeConfig();
      return { registered: Boolean((await readJson(where))?.servers?.bogen), where, skill };
    }
    case 'opencode': {
      const where = opencodeConfig();
      return { registered: Boolean((await readJson(where))?.mcp?.bogen), where, skill };
    }
    case 'gemini': {
      const where = join(home, '.gemini', 'settings.json');
      return { registered: Boolean((await readJson(where))?.mcpServers?.bogen), where, skill };
    }
    case 'zed': {
      const where = zedConfig();
      return { registered: Boolean((await readJson(where))?.context_servers?.bogen), where, skill };
    }
    case 'grok':
      // Grok keeps its servers where its own CLI decides. Status reads files only, so it does not say.
      return { registered: null, where: 'grok mcp list', skill };
    case 'hermes': {
      const where = hermesConfig();
      return { registered: hermesHasServer(await readFile(where, 'utf8').catch(() => '')), where, skill };
    }
    case 'omp': {
      let where: string;
      try {
        where = ompConfig();
      } catch (e) {
        return { registered: null, where: errorMessage(e), skill };
      }
      return { registered: Boolean((await readJson(where))?.mcpServers?.bogen), where, skill };
    }
  }
}

/** Whether a client seems to be in use here. `--all` installs only for these. */
export function detected(client: Client): boolean {
  const home = homedir();
  switch (client) {
    case 'claude-code': return onPath('claude') || existsSync(join(home, '.claude.json')) || existsSync(join(home, '.claude'));
    case 'codex': return onPath('codex') || existsSync(join(process.env.CODEX_HOME ?? join(home, '.codex')));
    case 'cursor': return onPath('cursor') || existsSync(join(home, '.cursor'));
    case 'vscode': return onPath('code') || existsSync(dirname(vscodeConfig()));
    case 'opencode': return onPath('opencode') || existsSync(dirname(opencodeConfig()));
    case 'gemini': return onPath('gemini') || existsSync(join(home, '.gemini'));
    case 'zed': return onPath('zed') || existsSync(dirname(zedConfig()));
    // Grok and Hermes are registered through their own CLI, so only one on PATH counts.
    case 'grok': return onPath('grok');
    case 'hermes': return onPath('hermes');
    case 'omp': return onPath('omp') || existsSync(join(home, '.omp'));
  }
}

export async function install(clients: Client[], options: { onlyDetected?: boolean; command?: Command } = {}): Promise<InstallResult[]> {
  const command = options.command ?? selfCommand();
  const out: InstallResult[] = [];
  for (const client of clients) {
    if (options.onlyDetected && !detected(client)) {
      out.push({ client, ok: true, skipped: true, how: 'not found on this machine' });
      continue;
    }
    try {
      const how = await INSTALLERS[client](command);
      const skill = await installSkill(client);
      out.push({ client, ok: true, how: skill ? `${how}; ${skill}` : how });
    } catch (e) {
      out.push({ client, ok: false, how: errorMessage(e) });
    }
  }
  return out;
}
