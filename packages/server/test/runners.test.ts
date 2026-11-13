/**
 * Contract fixtures for the runner registry and the newer runners: Grok, OpenCode, Hermes and Oh My Pi. Nothing
 * here renders, starts a server, or calls a provider: CLIs are stand-ins in a temporary PATH, and every home and
 * config folder is a temporary one. A real provider smoke is a separate, manual step.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentMentions, EFFORT_ID, MODEL_ID, RUNNABLE_IDS, RUNNER_IDS, RUNNERS, runnerLabel } from '@bogen/core';
import { buildCommand, Runs, type RunRequest } from '../src/agents.ts';
import { buildOpencodeCommand, opencodeNames, opencodeRules, parseOpencodeLine, MAX_ARG_BYTES } from '../src/adapters/opencode.ts';
import { cleanTarget } from '../src/comment-runs.ts';
import { EventHub } from '../src/events.ts';
import { hermesHasServer, install, registration, uninstall } from '../src/install.ts';
import { namesOption, RunnerProbes, type ExecFn } from '../src/runner-probe.ts';
import { choiceProblem, parseOpencodeModels, RunSettingsStore } from '../src/run-settings.ts';

const req = (over: Partial<RunRequest> = {}): RunRequest => ({ fileId: 'file1', fileName: 'Landing', prompt: 'Make the title bigger', runner: 'opencode', ...over });

/** A PATH with only stand-ins and node, so that no real CLI of the person's can be found. */
function sandboxPath(): { bin: string; done: () => void } {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-runners-bin-'));
  symlinkSync(process.execPath, join(bin, 'node'));
  return { bin, done: () => rmSync(bin, { recursive: true, force: true }) };
}

function stand(bin: string, name: string, body = 'process.exit(0);'): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env node\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** Help texts shaped like OpenCode's: `--pure` among the global options only, `--format` and `--agent` under run. */
const OPENCODE_HELP = 'opencode [project]\n\nCommands:\n  opencode run [message..]  run opencode with a message\n\nOptions:\n  -h, --help        show help\n  -v, --version     show version number\n      --print-logs  print logs to stderr\n      --pure        run without external plugins\n';
const OPENCODE_RUN_HELP = 'opencode run [message..]\n\nPositionals:\n  message  message to send\n\nOptions:\n  -m, --model     model to use in the format of provider/model\n      --agent     agent to use\n      --format    format: default (formatted) or json (raw JSON events)\n  -f, --file      file(s) to attach to message\n';

/** A counting stand-in for every command a probe or catalog starts. */
function counting(answers: Record<string, string | Error>): { exec: ExecFn; calls: string[] } {
  const calls: string[] = [];
  const exec: ExecFn = async (command, args) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return { stdout: answer ?? '', stderr: '' };
  };
  return { exec, calls };
}

describe('the runner registry', () => {
  it('has six stable ids, proper names, and only three Bogen runs itself', () => {
    expect(RUNNER_IDS).toEqual(['claude', 'codex', 'grok', 'opencode', 'hermes', 'omp']);
    expect(RUNNABLE_IDS).toEqual(['claude', 'codex', 'opencode']);
    expect(RUNNER_IDS.map(runnerLabel)).toEqual(['Claude Code', 'Codex', 'Grok', 'OpenCode', 'Hermes', 'Oh My Pi']);
    for (const id of ['grok', 'hermes', 'omp'] as const) expect(RUNNERS[id].blocked).toMatch(new RegExp(`bogen install ${id}`));
    expect(RUNNERS.grok.blocked).toMatch(/headless mode.*always-on MCP tools/);
    expect(RUNNERS.hermes.blocked).toMatch(/config\.yaml/);
    expect(RUNNERS.omp.blocked).toMatch(/--no-tools removes only its built-in tools/);
    // Images and live projects only where the adapter was built for them.
    expect(RUNNER_IDS.filter((id) => RUNNERS[id].images)).toEqual(['claude', 'codex']);
    expect(RUNNER_IDS.filter((id) => RUNNERS[id].live)).toEqual(['claude', 'codex']);
  });

  it('routes mentions of every runner, in order, and leaves addresses alone', () => {
    expect(agentMentions('@opencode then @claude, @Grok and @omp: @hermes')).toEqual(['opencode', 'claude', 'grok', 'omp', 'hermes']);
    expect(agentMentions('mail me@claude.ai or ask @codex.')).toEqual(['codex']);
    expect(agentMentions('@opencode-fan and @ompx are people')).toEqual([]);
  });

  it('takes provider-qualified model ids, and nothing that could be read as a flag or as words', () => {
    for (const ok of ['opus', 'gpt-5.4', 'claude-opus-4[1m]', 'anthropic/claude-sonnet-4-5', 'openrouter/x-ai/grok-4', 'ollama/qwen3:32b', 'bedrock/eu.anthropic.claude@v1']) expect(MODEL_ID.test(ok), ok).toBe(true);
    for (const bad of ['-m', '--dangerously', 'a/-b', 'a b', 'a"b', "a'b", 'a;rm', 'a\nb', '/abs', 'a//b', 'x'.repeat(121), '']) expect(MODEL_ID.test(bad), bad).toBe(false);
    expect(EFFORT_ID.test('high')).toBe(true);
  });
});

describe('run settings', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bogen-runners-home-'));
  });

  it('loads a two-runner file from before unchanged, fills the others with defaults, and keeps unknown runners', async () => {
    const old = { runners: { claude: { prompt: { model: 'opus' }, comment: { model: 'haiku', effort: 'low' } }, codex: { prompt: {}, comment: { model: 'default' } }, future: { prompt: { model: 'x' } } }, shareCursors: true, limits: { claude: 3, codex: 1, future: 2 } };
    writeFileSync(join(home, 'run-settings.json'), JSON.stringify(old));
    const store = new RunSettingsStore(home, () => ({ PATH: '' }));
    await store.load();
    const got = store.get();
    expect(got.runners.claude).toEqual(old.runners.claude);
    expect(got.runners.codex).toEqual(old.runners.codex);
    expect(got.runners.opencode).toEqual({ prompt: {}, comment: {} });
    expect(got.limits).toEqual({ claude: 3, codex: 1, grok: 2, opencode: 2, hermes: 2, omp: 2 });
    expect(got.shareCursors).toBe(true);
    await store.update({ runner: 'opencode', scope: 'prompt', model: 'anthropic/claude-sonnet-4-5' });
    const written = JSON.parse(readFileSync(join(home, 'run-settings.json'), 'utf8'));
    expect(written.runners.future).toEqual({ prompt: { model: 'x' } });
    expect(written.limits.future).toBe(2);
    expect(written.runners.opencode.prompt.model).toBe('anthropic/claude-sonnet-4-5');
    expect(written.runners.claude).toEqual(old.runners.claude);
  });

  it('refuses a model or effort a runner cannot take, instead of dropping it on the way', async () => {
    const store = new RunSettingsStore(home, () => ({ PATH: '' }));
    await expect(store.update({ runner: 'grok', scope: 'prompt', model: 'grok-4' })).rejects.toThrow(/model set up in Grok itself/);
    await expect(store.update({ runner: 'opencode', scope: 'prompt', effort: 'high' })).rejects.toThrow(/no effort setting/);
    expect(choiceProblem('opencode', { model: 'default', effort: 'default' })).toBeNull();
    expect(choiceProblem('claude', { model: 'opus', effort: 'max' })).toBeNull();
    // Comments use the cheap model only for Claude and Codex.
    expect(await store.resolve('opencode', 'comment')).toEqual({});
  });

  it('keeps reply targets of every runner, and drops what no runner is', () => {
    expect(cleanTarget({ runner: 'opencode', model: 'openai/gpt-5', effort: 'default', at: 5 })).toEqual({ runner: 'opencode', model: 'openai/gpt-5', effort: 'default', at: 5 });
    expect(cleanTarget({ runner: 'nobody', model: 'x' })).toBeUndefined();
    expect(cleanTarget({ runner: 'codex', model: 'a b' })?.model).toBe('default');
  });

  it('lists OpenCode models from its own output, and no line that is not one', () => {
    expect(parseOpencodeModels('Updating models…\nanthropic/claude-sonnet-4-5\nopenai/gpt-5\n\nnot a model\nbad/-x\nopenai/gpt-5\n').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5']);
  });
});

describe('cheap discovery and lazy probes', () => {
  const path = sandboxPath();
  const env = () => ({ PATH: path.bin });
  beforeAll(() => {
    for (const name of ['opencode', 'grok', 'hermes']) stand(path.bin, name);
  });
  afterAll(path.done);

  it('a settings snapshot and a runner listing start none of the newer CLIs', async () => {
    const { exec, calls } = counting({});
    const probes = new RunnerProbes(env, exec);
    const home = mkdtempSync(join(tmpdir(), 'bogen-runners-home-'));
    const store = new RunSettingsStore(home, env, probes);
    const snapshot = await store.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['claude', 'codex']);
    const saved = process.env.PATH;
    process.env.PATH = path.bin;
    try {
      const runs = new Runs(new EventHub(), () => ({ url: 'http://127.0.0.1:1/mcp' }));
      runs.probes = probes;
      const list = await runs.runners();
      expect(list.map((r) => r.id)).toEqual(RUNNER_IDS);
      expect(list.find((r) => r.id === 'opencode')).toMatchObject({ available: true, checked: false });
      expect(list.find((r) => r.id === 'grok')).toMatchObject({ available: false, installed: true });
      expect(list.find((r) => r.id === 'grok')!.reason).toMatch(/Bogen cannot run Grok itself/);
      expect(list.find((r) => r.id === 'omp')).toMatchObject({ available: false });
      expect(list.find((r) => r.id === 'omp')!.installed).toBeUndefined();
    } finally {
      process.env.PATH = saved;
    }
    expect(calls).toEqual([]);
  });

  it('probes one runner when it is picked, once, with global and run help in their own scopes', async () => {
    const { exec, calls } = counting({ 'opencode --version': '1.2.3\n', 'opencode --help': OPENCODE_HELP, 'opencode run --help': OPENCODE_RUN_HELP, 'opencode models': 'anthropic/claude-sonnet-4-5\n' });
    const probes = new RunnerProbes(env, exec);
    const store = new RunSettingsStore(mkdtempSync(join(tmpdir(), 'bogen-runners-home-')), env, probes);
    const catalog = await store.catalog('opencode');
    expect(catalog).toMatchObject({ id: 'opencode', source: 'cli', entry: 'catalog', models: [{ id: 'anthropic/claude-sonnet-4-5', label: 'anthropic/claude-sonnet-4-5' }] });
    expect(catalog.problem).toBeUndefined();
    await store.catalog('opencode');
    expect((await probes.probe('opencode')).version).toBe('1.2.3');
    expect(calls).toEqual(['opencode --version', 'opencode --help', 'opencode run --help', 'opencode models']);
    // Now that it was asked, the snapshot shows it too, and still starts nothing more.
    expect(Object.keys(await store.snapshot()).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(calls).toHaveLength(4);
  });

  it('refuses a build without a switch Bogen needs, and names it', async () => {
    const { exec } = counting({ 'opencode --version': '0.9.0', 'opencode --help': OPENCODE_HELP.replace('--pure', '--print-logs'), 'opencode run --help': OPENCODE_RUN_HELP.replace('--agent', '--title') });
    const probe = await new RunnerProbes(env, exec).probe('opencode');
    expect(probe.problem).toBe('OpenCode 0.9.0 has no --pure, --agent option, which Bogen needs to keep its runs to the Bogen tools. Update OpenCode, then try again.');
  });

  it('starts nothing for a runner that is not on PATH, or that Bogen does not run', async () => {
    const { exec, calls } = counting({});
    const probes = new RunnerProbes(() => ({ PATH: join(path.bin, 'nowhere') }), exec);
    expect((await probes.probe('opencode')).problem).toMatch(/not found on PATH/);
    const store = new RunSettingsStore(mkdtempSync(join(tmpdir(), 'bogen-runners-home-')), env, probes);
    expect((await store.catalog('hermes')).problem).toMatch(/Bogen cannot run Hermes itself/);
    expect(calls).toEqual([]);
  });

  it('finds an option as an option, not inside another word', () => {
    expect(namesOption('  --pure   run without plugins', '--pure')).toBe(true);
    expect(namesOption('  --purely  something', '--pure')).toBe(false);
    expect(namesOption('[--agent <name>]', '--agent')).toBe(true);
  });
});

describe('runs that cannot be kept to Bogen tools are refused before anything starts', () => {
  const runs = new Runs(new EventHub(), () => ({ url: 'http://127.0.0.1:1/mcp' }));
  const { exec, calls } = counting({});
  runs.probes = new RunnerProbes(() => ({ PATH: '' }), exec);

  it.each(['grok', 'hermes', 'omp'] as const)('%s fails closed with its reason, and no fallback', async (runner) => {
    await expect(runs.start(req({ runner }))).rejects.toThrow(RUNNERS[runner].blocked!);
    expect(runs.count()).toBe(0);
  });

  it('refuses what an adapter does not take: images, a live project, a model it has no switch for', async () => {
    await expect(runs.start(req({ images: [{ data: Buffer.from('x'), mime: 'image/png', name: 'a.png' }] }))).rejects.toThrow(/take no images/);
    await expect(runs.start(req({ live: { dir: '/tmp/x', mcpUrl: 'http://x', instructions: '', label: 'x' } }))).rejects.toThrow(/live project/);
    await expect(runs.start(req({ runner: 'opencode', effort: 'high' }))).rejects.toThrow(/no effort setting/);
    // OpenCode is not on this PATH: said so, and nothing else was tried.
    await expect(runs.start(req())).rejects.toThrow(/OpenCode \(opencode\) was not found on PATH/);
    expect(calls).toEqual([]);
    expect(() => buildCommand('grok', req({ runner: 'grok' }), { url: 'u' }, 'c', 'd', 'r')).toThrow(/Bogen cannot run Grok/);
  });
});

describe('the OpenCode adapter', () => {
  const endpoint = { url: 'http://127.0.0.1:4500/mcp', token: 'tok-secret-123' };
  const ids = { agent: 'opencode', fileId: 'file1', runId: 'Run42ab' };

  it('runs a fresh agent of its own, with only this run\'s Bogen tools, and puts no secret in argv', () => {
    const cmd = buildOpencodeCommand(req({ model: 'anthropic/claude-sonnet-4-5' }), 'You are drawing in Bogen.', endpoint, ids);
    const names = opencodeNames(ids.runId);
    expect(names).toEqual({ server: 'bogen_run_Run42ab', agent: 'bogen-run-Run42ab' });
    expect(cmd.command).toBe('opencode');
    expect(cmd.args.slice(0, -1)).toEqual(['--pure', 'run', '--format', 'json', '--agent', 'bogen-run-Run42ab', '--model', 'anthropic/claude-sonnet-4-5']);
    expect(cmd.args.at(-1)).toBe('You are drawing in Bogen.\n\nMake the title bigger');
    expect(cmd.args.join(' ')).not.toContain('tok-secret-123');
    expect(cmd.stdin).toBe('');
    expect(Object.keys(cmd.env)).toEqual(['OPENCODE_CONFIG_CONTENT']);
    const config = JSON.parse(cmd.env.OPENCODE_CONFIG_CONTENT!);
    expect(Object.keys(config.mcp)).toEqual(['bogen_run_Run42ab']);
    expect(config.mcp.bogen_run_Run42ab).toEqual({ type: 'remote', url: endpoint.url, headers: { 'X-Bogen-Agent': 'opencode', 'X-Bogen-File': 'file1', 'X-Bogen-Run': 'Run42ab', Authorization: 'Bearer tok-secret-123' }, enabled: true, oauth: false });
    // Ordered rules, deny first, then the one allow: last match wins in OpenCode's permissions.
    expect(Object.entries(config.agent['bogen-run-Run42ab'].permission)).toEqual([['*', 'deny'], ['bogen_run_Run42ab_*', 'allow']]);
    expect(config.agent['bogen-run-Run42ab'].mode).toBe('primary');
    expect(config.permission).toEqual(opencodeRules('bogen_run_Run42ab'));
    // Nothing is allowed by name but this run's own server: not bash, not edit, not a `bogen` the person registered.
    expect(JSON.stringify(config)).not.toMatch(/"(bash|edit|read|webfetch|bogen_\*)"\s*:\s*"allow"/);
  });

  it('leaves the model to OpenCode when none was chosen, and refuses a request too long for argv', () => {
    expect(buildOpencodeCommand(req(), 'You are drawing in Bogen.', endpoint, ids).args).not.toContain('--model');
    expect(() => buildOpencodeCommand(req({ prompt: 'x'.repeat(MAX_ARG_BYTES) }), 'You are drawing in Bogen.', endpoint, ids)).toThrow(/too long for OpenCode's command line/);
    expect(() => buildOpencodeCommand(req(), '--version', endpoint, ids)).toThrow(/must not start with "-"/);
  });

  it('builds the same command through buildCommand, with the shared system prompt', () => {
    const cmd = buildCommand('opencode', req({ threadId: 'thr1' }), endpoint, 'unused', '/tmp/run', 'Run42ab');
    expect(cmd.args.at(-1)).toMatch(/^You are drawing in Bogen, a design canvas, in the file "Landing"/);
    expect(cmd.args.at(-1)).toContain('Only the person resolves or reopens the thread');
  });

  it('reads its JSON events: text, this run\'s tools by their Bogen name, errors, and nothing else', () => {
    expect(parseOpencodeLine(JSON.stringify({ type: 'text', sessionID: 's', part: { type: 'text', text: 'Made it 44 px.' } }))).toEqual([{ kind: 'text', text: 'Made it 44 px.' }]);
    expect(parseOpencodeLine(JSON.stringify({ type: 'tool_use', part: { tool: 'bogen_run_Run42ab_layer_text', state: { status: 'completed' } } }))).toEqual([{ kind: 'tool', tool: 'layer_text' }]);
    expect(parseOpencodeLine(JSON.stringify({ type: 'tool_use', part: { tool: 'bogen_run_Run42ab_canvas_screenshot' } }))).toEqual([{ kind: 'tool', tool: 'canvas_screenshot' }]);
    // A denied tool, or one of a `bogen` server registered without a run, is no step of this run.
    expect(parseOpencodeLine(JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'error' } } }))).toEqual([]);
    expect(parseOpencodeLine(JSON.stringify({ type: 'tool_use', part: { tool: 'bogen_layer_text' } }))).toEqual([]);
    expect(parseOpencodeLine(JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError', data: { message: 'No API key for anthropic' } } }))).toEqual([{ kind: 'error', text: 'No API key for anthropic' }]);
    expect(parseOpencodeLine(JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }))).toEqual([]);
    expect(parseOpencodeLine('null')).toEqual([]);
    expect(parseOpencodeLine('[1,2]')).toEqual([]);
    expect(() => parseOpencodeLine('{"type":"text","part":{"te')).toThrow();
  });
});

describe('external MCP registration for Grok, Hermes and Oh My Pi', () => {
  const path = sandboxPath();
  const log = join(path.bin, 'calls.jsonl');
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CONFIG_DIR: process.env.PI_CONFIG_DIR, OMP_PROFILE: process.env.OMP_PROFILE };
  let home: string;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  const command = { command: '/opt/bogen/bin/bogen', args: ['mcp'] };

  beforeAll(() => {
    for (const name of ['grok', 'hermes']) stand(path.bin, name, `process.getBuiltinModule('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');`);
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bogen-runners-home-'));
    rmSync(log, { force: true });
    Object.assign(process.env, { PATH: path.bin, HOME: home, HERMES_HOME: join(home, 'hermes-home') });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CONFIG_DIR;
    delete process.env.OMP_PROFILE;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    path.done();
  });

  it('registers with Grok and Hermes through their own documented commands, exactly', async () => {
    const results = await install(['grok', 'hermes'], { command });
    expect(results.map((r) => [r.client, r.ok, r.how])).toEqual([['grok', true, 'ran grok mcp add with the grouped tool list'], ['hermes', true, 'ran hermes mcp add with the grouped tool list']]);
    expect(calls()).toEqual([
      ['grok', '--no-auto-update', 'mcp', 'remove', 'bogen'],
      ['grok', '--no-auto-update', 'mcp', 'add', 'bogen', '--', '/opt/bogen/bin/bogen', 'mcp', '--tools', 'grouped'],
      ['hermes', 'mcp', 'remove', 'bogen'],
      ['hermes', 'mcp', 'add', 'bogen', '--command', '/opt/bogen/bin/bogen', '--args', 'mcp', '--tools', 'grouped'],
    ]);
  });

  it('writes Oh My Pi\'s user mcp.json, keeping comments and other servers, and takes it out again', async () => {
    const dir = join(home, '.omp', 'agent');
    mkdirSync(dir, { recursive: true });
    const before = '{\n  // my servers\n  "mcpServers": {\n    "notes": { "command": "notes-mcp" }\n  },\n  "other": true\n}\n';
    writeFileSync(join(dir, 'mcp.json'), before);
    expect((await install(['omp'], { command }))[0]).toMatchObject({ ok: true, how: `wrote ${join(dir, 'mcp.json')} with the grouped tool list` });
    const text = readFileSync(join(dir, 'mcp.json'), 'utf8');
    expect(text).toContain('// my servers');
    expect(text).toContain('"notes": { "command": "notes-mcp" }');
    expect(JSON.parse(text.replace(/\/\/.*$/gm, '')).mcpServers.bogen).toEqual({ command: '/opt/bogen/bin/bogen', args: ['mcp', '--tools', 'grouped'] });
    expect(await registration('omp')).toMatchObject({ registered: true, where: join(dir, 'mcp.json') });
    await uninstall(['omp']);
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toBe(before);
    expect(calls()).toEqual([]);
  });

  it('follows PI_CODING_AGENT_DIR, and does not guess under PI_CONFIG_DIR alone', async () => {
    process.env.PI_CODING_AGENT_DIR = join(home, 'agent-here');
    await install(['omp'], { command });
    expect(existsSync(join(home, 'agent-here', 'mcp.json'))).toBe(true);
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CONFIG_DIR = join(home, 'cfg');
    const [result] = await install(['omp'], { command });
    expect(result).toMatchObject({ ok: false });
    expect(result!.how).toMatch(/PI_CONFIG_DIR is set/);
    expect(existsSync(join(home, 'cfg'))).toBe(false);
  });

  it('says plainly when a CLI it registers through is missing, and reads status without starting anything', async () => {
    process.env.PATH = join(path.bin, 'nowhere');
    const [result] = await install(['grok'], { command });
    expect(result).toMatchObject({ ok: false, how: 'Grok (grok) is not on PATH. Install it first; Bogen registers itself with Grok\'s own command.' });
    expect(await registration('grok')).toMatchObject({ registered: null });
    mkdirSync(join(home, 'hermes-home'), { recursive: true });
    writeFileSync(join(home, 'hermes-home', 'config.yaml'), 'model: x\nmcp_servers:\n  bogen:\n    command: bogen\n');
    expect(await registration('hermes')).toMatchObject({ registered: true, where: join(home, 'hermes-home', 'config.yaml') });
    expect(calls()).toEqual([]);
  });

  it('reads Hermes\' mcp_servers by its lines only, and says "not known" for YAML it does not follow', () => {
    expect(hermesHasServer('mcp_servers:\n  notes:\n    command: n\n  bogen:\n    command: bogen\n')).toBe(true);
    expect(hermesHasServer('mcp_servers:\n  notes:\n    bogen: nested\n')).toBe(false);
    expect(hermesHasServer('# mcp_servers:\n#   bogen:\n')).toBe(false);
    expect(hermesHasServer('')).toBe(false);
    // Valid YAML, just not lines this reader follows: a flow map, an alias, several documents.
    expect(hermesHasServer('other:\n  bogen: x\nmcp_servers: {bogen: {command: bogen}}\n')).toBeNull();
    expect(hermesHasServer('mcp_servers:\n  <<: *shared\n')).toBeNull();
    expect(hermesHasServer('model: x\n---\nmcp_servers:\n  notes: {}\n')).toBeNull();
  });

  it('leaves an explicit Hermes uninstall to Hermes\' own command, whatever the reader sees', async () => {
    mkdirSync(join(home, 'hermes-home'), { recursive: true });
    writeFileSync(join(home, 'hermes-home', 'config.yaml'), 'mcp_servers: {bogen: {command: bogen}}\n');
    expect(await registration('hermes')).toMatchObject({ registered: null });
    expect((await uninstall(['hermes']))[0]).toMatchObject({ ok: true, how: 'ran hermes mcp remove' });
    expect(calls()).toEqual([['hermes', 'mcp', 'remove', 'bogen']]);
  });

  it('does not write the default Oh My Pi file while a named profile is active', async () => {
    process.env.OMP_PROFILE = 'work';
    try {
      const [result] = await install(['omp'], { command });
      expect(result).toMatchObject({ ok: false });
      expect(result!.how).toMatch(/OMP_PROFILE is set \(work\)/);
      expect(existsSync(join(home, '.omp'))).toBe(false);
      expect(await registration('omp')).toMatchObject({ registered: null });
      process.env.PI_CODING_AGENT_DIR = join(home, 'profiles', 'work', 'agent');
      expect((await install(['omp'], { command }))[0]).toMatchObject({ ok: true });
      expect(existsSync(join(home, 'profiles', 'work', 'agent', 'mcp.json'))).toBe(true);
      expect(existsSync(join(home, '.omp'))).toBe(false);
    } finally {
      delete process.env.OMP_PROFILE;
    }
  });
});
