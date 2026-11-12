import { describe, expect, it } from 'vitest';
import { buildCommand, parseClaudeLine, parseCodexLine, type RunRequest } from '../src/agents.ts';
import { jsoncSet, tomlSetServer } from '../src/install.ts';
import { inferKind, parseCssVars } from '../src/mcp/css-vars.ts';
import { fetchPublic, isPrivateAddress, isPublicUrl } from '../src/net-guard.ts';

describe('net guard', () => {
  it('knows private addresses in every spelling', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses private targets before connecting', async () => {
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost/', 'http://foo.localhost/', 'http://printer.local/', 'file:///etc/passwd', 'ftp://example.com/', 'http://user:pw@example.com/']) {
      await expect(fetchPublic(url), url).rejects.toThrow();
      expect(await isPublicUrl(url), url).toBe(false);
    }
  });
});

describe('css variables', () => {
  it('infers kinds', () => {
    expect(inferKind('accent', '#f00')).toBe('color');
    expect(inferKind('primary', 'var(--x)')).toBe('color');
    expect(inferKind('radius-lg', '12px')).toBe('radius');
    expect(inferKind('font-sans', 'Inter')).toBe('font-family');
    expect(inferKind('font-weight-bold', '700')).toBe('font-weight');
    expect(inferKind('space-4', '1rem')).toBe('spacing');
    expect(inferKind('unknown', 'foo')).toBeNull();
  });

  it('reads theme blocks, layers and bare declarations', () => {
    expect(parseCssVars('--a-color: #fff; --gap: 4px').tokens.map((t) => t.name)).toEqual(['a-color', 'gap']);
    const css = '@layer base { :root { --bg: #fff; } .dark { --bg: #000; } } @theme { --color-x: oklch(0.5 0.1 200); }';
    const parsed = parseCssVars(css);
    expect(parsed.tokens.map((t) => [t.name, t.value])).toEqual([['bg', '#fff'], ['color-x', 'oklch(0.5 0.1 200)']]);
    expect(parsed.skipped[0]!.selector).toBe('.dark');
  });
});

describe('config editing', () => {
  it('adds to JSON with comments and leaves everything else alone', () => {
    const before = `// my settings
{
  "theme": "One Dark", // keep me
  /* and me */
  "context_servers": {
    "other": { "command": "x" },
  },
}
`;
    const after = jsoncSet(before, ['context_servers', 'bogen'], { command: 'bogen', args: ['mcp'] });
    expect(after).toContain('// my settings');
    expect(after).toContain('"theme": "One Dark", // keep me');
    expect(after).toContain('/* and me */');
    expect(after).toContain('"other": { "command": "x" }');
    expect(after).toContain('"bogen": {');
    const parsed = JSON.parse(after.replace(/\/\/.*$/gm, '').replace(/\/\*.*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1'));
    expect(parsed.context_servers.bogen.args).toEqual(['mcp']);
    expect(parsed.context_servers.other.command).toBe('x');
  });

  it('creates missing parents, updates in place, and handles empty files', () => {
    expect(JSON.parse(jsoncSet('', ['a', 'b'], 1))).toEqual({ a: { b: 1 } });
    expect(JSON.parse(jsoncSet('{}', ['a', 'b'], 1))).toEqual({ a: { b: 1 } });
    expect(JSON.parse(jsoncSet('{"x":1}', ['a', 'b'], 1))).toEqual({ x: 1, a: { b: 1 } });
    expect(JSON.parse(jsoncSet('{"a":{"b":0,"c":2}}', ['a', 'b'], 1))).toEqual({ a: { b: 1, c: 2 } });
    expect(JSON.parse(jsoncSet('{"a":5}', ['a', 'b'], 1))).toEqual({ a: { b: 1 } });
    const once = jsoncSet('{"a":1}', ['s', 'bogen'], { c: 1 });
    expect(jsoncSet(once, ['s', 'bogen'], { c: 1 })).toBe(once);
  });

  it('refuses a broken file instead of overwriting it', () => {
    expect(() => jsoncSet('{ "a": ', ['x'], 1)).toThrow();
    expect(() => jsoncSet('[1,2]', ['x'], 1)).toThrow();
  });

  it('edits TOML as text', () => {
    const before = '# mine\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "o"\n';
    const added = tomlSetServer(before, 'bogen', { command: 'bogen', args: ['mcp'] });
    expect(added.startsWith(before)).toBe(true);
    expect(added).toContain('[mcp_servers.bogen]\ncommand = "bogen"\nargs = ["mcp"]');
    const changed = tomlSetServer(`${added}\n[z]\ny = 1\n`, 'bogen', { command: '/new', args: [] });
    expect(changed).toContain('command = "/new"');
    expect(changed).not.toContain('command = "bogen"');
    expect(changed).toContain('[mcp_servers.other]');
    expect(changed).toContain('[z]\ny = 1');
    expect(tomlSetServer('', 'bogen', { command: 'b', args: [] })).toBe('[mcp_servers.bogen]\ncommand = "b"\nargs = []\n');
  });
});

describe('runner command lines', () => {
  const req: RunRequest = { fileId: 'f1', fileName: 'F', pageId: 'p1', nodeIds: ['n1'], prompt: '$(rm -rf /); "quoted"', runner: 'claude', model: 'haiku' };

  it('gives claude only Bogen tools, and keeps the prompt out of its arguments', () => {
    const { command, args, stdin } = buildCommand('claude', req, { url: 'http://127.0.0.1:1/mcp' }, '/tmp/x.json', '/tmp');
    expect(command).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--allowedTools', 'mcp__bogen__*', '--tools', '']));
    expect(args).not.toContain(req.prompt);
    expect(stdin).toBe(req.prompt);
    expect(args.join(' ')).toContain('n1');
  });

  it('gives codex only Bogen tools, without user config or a shell', () => {
    const { command, args, stdin } = buildCommand('codex', { ...req, runner: 'codex' }, { url: 'http://127.0.0.1:1/mcp', token: 't' }, '/tmp/x.json', '/tmp');
    expect(command).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--ignore-user-config', '--disable', 'shell_tool']));
    expect(args.join(' ')).toContain('mcp_servers.bogen.url="http://127.0.0.1:1/mcp"');
    expect(args.join(' ')).not.toContain('Bearer');
    expect(stdin).toContain(req.prompt);
    expect(args.at(-1)).toBe('-');
  });

  it('parses stream events', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'mcp__bogen__html_write' }] } })))
      .toEqual([{ kind: 'text', text: 'hi' }, { kind: 'tool', tool: 'html_write' }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'result', is_error: true, result: 'nope' }))).toEqual([{ kind: 'error', text: 'nope' }]);
    expect(parseClaudeLine(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }))).toEqual([]);
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }))).toEqual([{ kind: 'text', text: 'hi' }]);
    expect(parseCodexLine(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', tool: 'layer_get' } }))).toEqual([{ kind: 'tool', tool: 'layer_get' }]);
    expect(parseCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'x' } }))).toEqual([{ kind: 'error', text: 'x' }]);
  });
});
