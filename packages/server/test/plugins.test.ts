// The client plugins: generated from the server's own text, in the formats each client documents.
//
// With BOGEN_TEST_PLUGIN_CLIS=1 the official validators run too, when they are installed: `claude plugin validate`
// for the Claude Code plugin and marketplace, and with MCPB_CLI=<path to @anthropic-ai/mcpb's dist/cli/cli.js>,
// `mcpb validate` and `mcpb info` for the Claude Desktop extension. They are left out by default: they are other
// programs, and the Claude CLI reports to its own telemetry.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ICONS, pluginFiles } from '../../../scripts/gen-plugins.ts';
// @ts-expect-error: a plain script without types.
import { buildMcpb } from '../../../scripts/build-mcpb.mjs';
import { parseToolMode } from '../src/mcp/tool-modes.ts';
import { skillText } from '../src/skill.ts';
import { VERSION } from '../src/version.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const json = (path: string) => JSON.parse(read(path)) as Record<string, any>;

/** The files of a zip, read from its central directory. */
function unzip(bytes: Buffer): Record<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(at + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    at += 46 + nameLength + extra;
  }
  return out;
}

describe('client plugins', () => {
  it('are up to date with the skill, the version and the icon', () => {
    for (const [path, text] of Object.entries(pluginFiles())) expect(read(path), `${path}: run npx tsx scripts/gen-plugins.ts`).toBe(text);
    const icon = readFileSync(join(ROOT, 'apps/editor/public/icons/icon-512.png'));
    for (const path of PLUGIN_ICONS) expect(readFileSync(join(ROOT, path)).equals(icon), path).toBe(true);
    expect(read('integrations/claude-code/skills/bogen/SKILL.md')).toContain(skillText('claude-code').split('\n# Bogen\n')[1]!.slice(0, 400));
    expect(read('integrations/codex/skills/bogen/SKILL.md')).not.toContain('Managed by Bogen');
  });

  it('give Claude Code a marketplace and a plugin in its documented format', () => {
    const market = json('.claude-plugin/marketplace.json');
    expect(market.name).toBe('bogen');
    expect(market.owner.name).toBeTruthy();
    const entry = market.plugins[0];
    expect(entry).toMatchObject({ name: 'bogen', source: './integrations/claude-code', version: VERSION });
    const plugin = json('integrations/claude-code/.claude-plugin/plugin.json');
    expect(plugin.name).toBe(entry.name);
    expect(plugin.name).toMatch(/^[a-z0-9-]+$/);
    expect(plugin.icon).toMatch(/^\.\//);
    for (const p of [plugin.icon]) expect(() => readFileSync(join(ROOT, 'integrations/claude-code', p))).not.toThrow();
  });

  it('give Codex a marketplace and a portable plugin', () => {
    const market = json('.agents/plugins/marketplace.json');
    expect(market.plugins[0]).toMatchObject({ name: 'bogen', source: { source: 'local', path: './integrations/codex' }, policy: { installation: 'AVAILABLE' } });
    const plugin = json('integrations/codex/plugin.json');
    expect(plugin).toMatchObject({ name: 'bogen', version: VERSION });
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(json('integrations/codex/mcp.json').mcpServers.bogen.type).toBe('stdio');
  });

  it('start bogen mcp over stdio, on this machine only, with arguments it takes', () => {
    const servers = [json('integrations/claude-code/.mcp.json').mcpServers.bogen, json('integrations/codex/mcp.json').mcpServers.bogen, json('integrations/claude-desktop/manifest.json').server.mcp_config];
    for (const s of servers) {
      expect(s.url).toBeUndefined();
      expect(s.command).toMatch(/(^|\/)bogen$/);
      expect(s.args[0]).toBe('mcp');
      const tools = s.args.indexOf('--tools');
      if (tools >= 0) expect(parseToolMode(s.args[tools + 1].replace('${user_config.tools}', 'full')).warning).toBeUndefined();
    }
  });

  it('pack the Claude Desktop extension the same way twice, with its manifest and icon', () => {
    const manifest = json('integrations/claude-desktop/manifest.json');
    expect(manifest).toMatchObject({ manifest_version: '0.3', name: 'bogen', version: VERSION, server: { type: 'binary' } });
    for (const key of ['name', 'version', 'description', 'author', 'server']) expect(manifest[key], key).toBeTruthy();
    expect(manifest.user_config.tools.default).toBe('full');
    const first = buildMcpb();
    expect(buildMcpb().bytes.equals(first.bytes)).toBe(true);
    expect(first.version).toBe(VERSION);
    const files = unzip(first.bytes);
    expect(Object.keys(files).sort()).toEqual(['icon.png', 'manifest.json']);
    expect(files['manifest.json']!.toString('utf8')).toBe(read('integrations/claude-desktop/manifest.json'));
    expect(files['icon.png']!.subarray(1, 4).toString()).toBe('PNG');
  });

  it.runIf(process.env.BOGEN_TEST_PLUGIN_CLIS === '1')('pass the official validators', () => {
    const claude = (args: string[]) => execFileSync('claude', args, { cwd: ROOT, encoding: 'utf8' });
    expect(claude(['plugin', 'validate', 'integrations/claude-code'])).toMatch(/Validation passed/);
    expect(claude(['plugin', 'validate', '.'])).toMatch(/Validation passed/);
    const cli = process.env.MCPB_CLI;
    if (!cli) return;
    expect(execFileSync(process.execPath, [cli, 'validate', 'integrations/claude-desktop/manifest.json'], { cwd: ROOT, encoding: 'utf8' })).toMatch(/validation passes/);
    const dir = mkdtempSync(join(tmpdir(), 'bogen-mcpb-'));
    try {
      const file = join(dir, 'bogen.mcpb');
      writeFileSync(file, buildMcpb().bytes);
      expect(execFileSync(process.execPath, [cli, 'info', file], { encoding: 'utf8' })).toMatch(/File: bogen\.mcpb/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
