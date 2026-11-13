import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install, type Client } from '../src/install.ts';
import { parseAgents, setup } from '../src/setup.ts';

describe('parseAgents', () => {
  it('reads lists, all, none and the usual other names', () => {
    expect(parseAgents('claude-code,codex')).toEqual(['claude-code', 'codex']);
    expect(parseAgents(' Claude , codex claude ')).toEqual(['claude-code', 'codex']);
    expect(parseAgents('all')).toBe('all');
    expect(parseAgents('none')).toBe('none');
    expect(parseAgents('')).toBe('none');
    expect(() => parseAgents('claude-code,notepad')).toThrow(/Unknown agent "notepad"/);
  });
});

describe('setup, with no client CLIs on PATH', () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG: process.env.XDG_CONFIG_HOME, CODEX: process.env.CODEX_HOME };
  const command = { command: '/usr/bin/bogen', args: ['mcp'] };
  const connect = (clients: Client[]) => install(clients, { command });
  let home: string;
  let out: string;
  const io = (answers?: (string | null)[]) => {
    const asked: string[] = [];
    return {
      asked,
      write: (text: string) => { out += text; },
      ...(answers ? { ask: async (q: string) => { asked.push(q); out += q; return answers.length ? answers.shift()! : null; } } : {}),
    };
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bogen-setup-'));
    process.env.HOME = home;
    process.env.PATH = '';
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CODEX_HOME;
    out = '';
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.XDG) process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.CODEX) process.env.CODEX_HOME = saved.CODEX;
    rmSync(home, { recursive: true, force: true });
  });

  it('says when no agent is here, and asks nothing', async () => {
    const terminal = io(['y']);
    expect(await setup({ connect }, terminal)).toBe(0);
    expect(terminal.asked).toEqual([]);
    expect(out).toMatch(/No agent found on this computer/);
    expect(out).toMatch(/then run: bogen setup/);
    expect(out).toMatch(/bogen open/);
    expect(out).not.toMatch(/Restart/);
  });

  it('without a terminal or a choice, only says what to run', async () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    expect(await setup({ connect }, io())).toBe(0);
    expect(out).toMatch(/Claude Code {3}found, not connected/);
    expect(out).toContain('  bogen install claude-code\n  bogen install codex\n');
    expect(out).toMatch(/bogen setup --agents all/);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
  });

  it('asks for each agent that is not connected, defaults to yes, and asks nothing the second time', async () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.cursor'));
    const first = io(['', 'n', 'yes']);
    expect(await setup({ connect }, first)).toBe(0);
    expect(first.asked).toEqual(['Connect Claude Code? [Y/n] ', 'Connect Codex? [Y/n] ', 'Connect Cursor? [Y/n] ']);
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.bogen.command).toBe('/usr/bin/bogen');
    expect(existsSync(join(home, '.claude', 'skills', 'bogen', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.bogen.command).toBe('/usr/bin/bogen');
    expect(out).toMatch(/Restart Claude Code and Cursor, or start a new session/);
    expect(out).toMatch(/In Claude Code, \/mcp then lists bogen/);
    expect(out).toContain('To connect it later, run:\n  bogen install codex\n');
    expect(out).toMatch(/Design a pricing page in Bogen/);

    out = '';
    const second = io(['n']);
    expect(await setup({ connect }, second)).toBe(0);
    expect(second.asked).toEqual(['Connect Codex? [Y/n] ']);
    expect(out).toMatch(/Claude Code {3}connected/);
    expect(out).not.toMatch(/Restart/);
  });

  it('asks again on an answer it does not understand, and stops asking at the end of input', async () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.cursor'));
    const terminal = io(['maybe', 'y', null]);
    await setup({ connect }, terminal);
    expect(terminal.asked).toEqual(['Connect Claude Code? [Y/n] ', 'Connect Claude Code? [Y/n] ', 'Connect Cursor? [Y/n] ']);
    expect(existsSync(join(home, '.claude.json'))).toBe(true);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('with agents set, asks nothing: all connects what is here, a list exactly those, none nothing', async () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.cursor'));
    const terminal = io(['n', 'n']);
    expect(await setup({ agents: 'none', connect }, terminal)).toBe(0);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(out).toContain('To connect them later, run:');

    expect(await setup({ agents: 'codex', connect }, terminal)).toBe(0);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.bogen]');
    expect(existsSync(join(home, '.claude.json'))).toBe(false);

    out = '';
    expect(await setup({ agents: 'all', connect }, terminal)).toBe(0);
    expect(terminal.asked).toEqual([]);
    expect(existsSync(join(home, '.claude.json'))).toBe(true);
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
    // Codex is here now, through its config folder, and connected again: the same entry, once.
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/\[mcp_servers\.bogen\]/g)).toHaveLength(1);
    expect(out).not.toMatch(/To connect/);
  });

  it('reports a client it could not connect, and exits 1', async () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ broken');
    expect(await setup({ agents: 'cursor', connect }, io())).toBe(1);
    expect(out).toMatch(/FAIL {2}cursor: .*left alone/);
    expect(out).toMatch(/could not be connected/);
    await expect(setup({ agents: 'nope', connect }, io())).rejects.toThrow(/Unknown agent/);
  });
});
