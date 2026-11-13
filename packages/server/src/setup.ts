import { createInterface } from 'node:readline';
import { CLIENTS, detected, install, registration, type Client, type InstallResult } from './install.ts';

/** How each client is called where a person reads it. */
export const LABELS: Record<Client, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  zed: 'Zed',
  grok: 'Grok',
  hermes: 'Hermes',
  omp: 'Oh My Pi',
};

/** Names people and agents also write for a client. */
const ALIASES: Record<string, Client> = { claude: 'claude-code', 'claude-code': 'claude-code', code: 'vscode', 'gemini-cli': 'gemini', 'oh-my-pi': 'omp' };

export type AgentChoice = Client[] | 'all' | 'none';

/** `claude-code,codex`, `all` or `none`, from --agents or BOGEN_AGENTS. Throws on a name it does not know. */
export function parseAgents(value: string): AgentChoice {
  const names = value.split(/[\s,]+/).map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!names.length || (names.length === 1 && names[0] === 'none')) return 'none';
  if (names.includes('all')) return 'all';
  const out: Client[] = [];
  for (const name of names) {
    const client = ALIASES[name] ?? (CLIENTS as readonly string[]).find((c) => c === name) as Client | undefined;
    if (!client) throw new Error(`Unknown agent "${name}". Use ${CLIENTS.join(', ')}, all or none.`);
    if (!out.includes(client)) out.push(client);
  }
  return out;
}

export interface ClientState {
  client: Client;
  found: boolean;
  /** Registered with Bogen, or null when that is not in a file Bogen reads. */
  connected: boolean | null;
  /** False when registered without the skill that Claude Code and Codex get. */
  skill: boolean | null;
}

/** Every client, with whether it is here and whether Bogen is in it. Changes nothing. */
export async function survey(): Promise<ClientState[]> {
  return Promise.all(CLIENTS.map(async (client) => {
    const found = detected(client);
    const info = await registration(client);
    return { client, found, connected: info.registered, skill: info.skill };
  }));
}

const complete = (s: ClientState) => s.connected === true && s.skill !== false;

function describe(s: ClientState): string {
  if (s.connected === true) return s.skill === false ? 'connected, without the Bogen skill' : 'connected';
  if (s.connected === null) return 'found; whether Bogen is in it is not known';
  return 'found, not connected';
}

const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export interface SetupIO {
  write(text: string): void;
  /** Asks one question; null when there is no one to answer any more. */
  ask?: (question: string) => Promise<string | null>;
}

export interface SetupOptions {
  /** From --agents or BOGEN_AGENTS. Without it, a terminal is asked and anything else only told what to run. */
  agents?: string;
  connect?: (clients: Client[]) => Promise<InstallResult[]>;
}

async function yes(io: SetupIO, question: string): Promise<boolean | null> {
  for (;;) {
    const answer = await io.ask!(`${question} [Y/n] `);
    if (answer === null) return null;
    const a = answer.trim().toLowerCase();
    if (a === '' || a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
  }
}

/**
 * Finds the agents on this computer, says which ones have Bogen, connects the ones asked for, and ends with what to
 * do next. Running it again connects nothing twice: a client already connected is only connected again by name.
 */
export async function setup(options: SetupOptions, io: SetupIO): Promise<number> {
  const choice = options.agents === undefined ? undefined : parseAgents(options.agents);
  const states = await survey();
  const shown = states.filter((s) => s.found || s.connected === true);
  const say = (text = '') => io.write(`${text}\n`);

  if (shown.length) {
    say('Agents on this computer:');
    const width = Math.max(...shown.map((s) => LABELS[s.client].length));
    for (const s of shown) say(`  ${LABELS[s.client].padEnd(width)}   ${describe(s)}`);
  } else {
    say(`No agent found on this computer. Bogen works with ${list(CLIENTS.map((c) => LABELS[c]))}.`);
  }

  let targets: Client[] = [];
  const open = shown.filter((s) => !complete(s));
  if (choice === 'all') targets = shown.filter((s) => s.found).map((s) => s.client);
  else if (Array.isArray(choice)) targets = choice;
  else if (choice === undefined && io.ask && open.length) {
    say();
    for (const s of open) {
      const answer = await yes(io, `Connect ${LABELS[s.client]}?`);
      if (answer === null) break;
      if (answer) targets.push(s.client);
    }
  }

  let failed = false;
  const connected: Client[] = [];
  if (targets.length) {
    say();
    const results = await (options.connect ?? install)(targets);
    for (const r of results) {
      say(`${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'}  ${r.client}: ${r.how}`);
      if (r.ok && !r.skipped) connected.push(r.client);
      else if (!r.ok) failed = true;
    }
  }

  const left = open.filter((s) => !targets.includes(s.client));
  say();
  if (left.length) {
    say(`To connect ${left.length > 1 ? 'them' : 'it'}${io.ask || choice !== undefined ? ' later' : ''}, run:`);
    for (const s of left) say(`  bogen install ${s.client}`);
    if (choice === undefined && !io.ask) say('Or run bogen setup in a terminal to be asked, or bogen setup --agents all.');
    say();
  } else if (!shown.length) {
    say('Install one of them, then run: bogen setup');
    say();
  }

  say('Next:');
  if (connected.length) {
    const names = connected.map((c) => LABELS[c]);
    say(`  Restart ${list(names)}, or start a new session. A session that was open before does not have Bogen's tools yet.`);
    const slash = connected.filter((c) => c === 'claude-code' || c === 'codex').map((c) => LABELS[c]);
    if (slash.length) say(`  In ${list(slash)}, /mcp then lists bogen.`);
  }
  say('  Open the canvas:   bogen open');
  if (connected.length || shown.some(complete)) say('  Ask your agent:    "Design a pricing page in Bogen."');
  say('  Check the setup:   bogen doctor');
  if (failed) say('\nA client above could not be connected. Its line says why; bogen install <client> tries again.');
  return failed ? 1 : 0;
}

/** Questions on the terminal. Ctrl+C stops setup; Ctrl+D stops the questions and keeps what was answered. */
export function terminalQuestions(): { ask: (question: string) => Promise<string | null>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(130);
  });
  return {
    ask: (question) => new Promise((resolve) => {
      if (closed) return resolve(null);
      const onClose = () => {
        process.stdout.write('\n');
        resolve(null);
      };
      rl.once('close', onClose);
      rl.question(question, (answer) => {
        rl.off('close', onClose);
        resolve(answer);
      });
    }),
    close: () => rl.close(),
  };
}
