import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { install, selfCommand } from '../src/install.ts';

describe('install, with no client CLIs on PATH', () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG: process.env.XDG_CONFIG_HOME, CODEX: process.env.CODEX_HOME };
  const command = { command: '/usr/bin/bogen', args: ['mcp'] };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bogen-install-'));
    process.env.HOME = home;
    process.env.PATH = '';
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    if (saved.XDG) process.env.XDG_CONFIG_HOME = saved.XDG;
    if (saved.CODEX) process.env.CODEX_HOME = saved.CODEX;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes every client config from scratch', async () => {
    const results = await install(['claude-code', 'codex', 'cursor', 'vscode', 'opencode', 'gemini', 'zed'], { command });
    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);
    const read = (...parts: string[]) => JSON.parse(readFileSync(join(home, ...parts), 'utf8'));
    expect(read('.claude.json').mcpServers.bogen).toEqual({ type: 'stdio', command: '/usr/bin/bogen', args: ['mcp'] });
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.bogen]');
    expect(read('.cursor', 'mcp.json').mcpServers.bogen.command).toBe('/usr/bin/bogen');
    expect(read('.config', 'Code', 'User', 'mcp.json').servers.bogen.type).toBe('stdio');
    expect(read('.config', 'opencode', 'opencode.json').mcp.bogen.command).toEqual(['/usr/bin/bogen', 'mcp']);
    expect(read('.gemini', 'settings.json').mcpServers.bogen.args).toEqual(['mcp']);
    expect(read('.config', 'zed', 'settings.json').context_servers.bogen.command).toBe('/usr/bin/bogen');
  });

  it('preserves what is already there, and is repeatable', async () => {
    mkdirSync(join(home, '.config', 'zed'), { recursive: true });
    const zed = join(home, '.config', 'zed', 'settings.json');
    writeFileSync(zed, '// hand written\n{\n  "vim_mode": true, // yes\n}\n');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { other: { command: 'x' } } }, null, 2));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), '# mine\nmodel = "m"\n');
    for (let i = 0; i < 2; i++) await install(['zed', 'claude-code', 'codex'], { command });
    const text = readFileSync(zed, 'utf8');
    expect(text).toContain('// hand written');
    expect(text).toContain('"vim_mode": true, // yes');
    expect(text.match(/"bogen"/g)).toHaveLength(1);
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(claude.numStartups).toBe(7);
    expect(claude.mcpServers.other.command).toBe('x');
    expect(claude.mcpServers.bogen.command).toBe('/usr/bin/bogen');
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('# mine\nmodel = "m"');
    expect(toml.match(/\[mcp_servers\.bogen\]/g)).toHaveLength(1);
  });

  it('leaves a malformed config alone and says so', async () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{ broken');
    const [result] = await install(['cursor'], { command });
    expect(result!.ok).toBe(false);
    expect(result!.how).toMatch(/left alone/);
    expect(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{ broken');
  });

  it('with onlyDetected, skips clients that are not here', async () => {
    mkdirSync(join(home, '.cursor'));
    const results = await install(['cursor', 'zed'], { command, onlyDetected: true });
    expect(results.find((r) => r.client === 'cursor')!.skipped).toBeUndefined();
    expect(results.find((r) => r.client === 'zed')!.skipped).toBe(true);
  });

  it('names the command install.sh wrote for this script when bogen is not on PATH', () => {
    const script = join(home, '.local', 'share', 'bogen-app', 'lib', 'node_modules', 'bogen-design', 'dist', 'cli.js');
    expect(selfCommand(script).args.slice(-2)).toEqual([script, 'mcp']);
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const wrapper = join(home, '.local', 'bin', 'bogen');
    writeFileSync(wrapper, `#!/bin/sh\n# Written by Bogen's install.sh.\nnode='/usr/bin/node'\nexec "$node" '${script}' "$@"\n`);
    expect(selfCommand(script)).toEqual({ command: wrapper, args: ['mcp'] });
    // A wrapper for another copy is not this one.
    expect(selfCommand(join(home, 'elsewhere', 'dist', 'cli.js')).command).toBe(process.execPath);
  });
});
