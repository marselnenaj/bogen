import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Token } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PullDraft } from '../src/pull-requests.ts';
import { diffTokens, readCssTokens, readDtcg, readTailwindConfig, writeCssTokens, writeDtcg } from '../src/repo-tokens.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
import { makeRepoFixture, type RepoFixture } from './repo-fixture.ts';

const THEME_CSS = `@import "tailwindcss";

/* The brand. */
:root {
  --brand: #e5484d;
  --surface: #ffffff;
  --radius-card: 12px;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.1);
}

.dark {
  --brand: #ff6369;
  --surface: #111111;
}

@theme inline {
  --color-brand: var(--brand);
  --color-surface: var(--surface);
}

@theme {
  --color-ink: oklch(0.2 0 0);
  --font-sans: "Inter", sans-serif;
  --text-sm: 14px;
  --text-sm--line-height: 20px;
}
`;

describe('reading and writing tokens', () => {
  it('reads CSS variables, mode blocks and the Tailwind theme, and knows a mapping from a token', () => {
    const read = readCssTokens(THEME_CSS, 'src/index.css');
    const byName = Object.fromEntries(read.tokens.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['brand', 'ink', 'font-sans', 'radius-card', 'surface', 'text-sm'].sort());
    expect(byName.brand).toMatchObject({ kind: 'color', value: '#e5484d', modes: { dark: '#ff6369' }, format: 'css' });
    expect(byName.ink).toMatchObject({ kind: 'color', value: 'oklch(0.2 0 0)', format: 'tailwind' });
    expect(byName['font-sans']).toMatchObject({ kind: 'font-family', format: 'tailwind' });
    expect(byName['text-sm']).toMatchObject({ kind: 'font-size', value: '14px' });
    expect(byName['radius-card']).toMatchObject({ kind: 'radius' });
    expect(read.unclassified.map((u) => u.name)).toEqual(expect.arrayContaining(['shadow-card', 'text-sm--line-height']));
  });

  it('writes values where they are, new ones at the end of their block, modes into their block', () => {
    const tokens: Token[] = [
      { name: 'brand', kind: 'color', value: '#d93036', modes: { dark: '#ff7a7f' } },
      { name: 'surface', kind: 'color', value: '#ffffff' },
      { name: 'accent', kind: 'color', value: '#2563eb', modes: { dark: '#60a5fa' } },
      { name: 'ink', kind: 'color', value: 'oklch(0.25 0 0)' },
    ];
    const css = writeCssTokens(THEME_CSS, tokens.filter((t) => t.name !== 'ink'), 'css');
    expect(css).toContain('  --brand: #d93036;');
    expect(css).toContain('  --brand: #ff7a7f;');
    expect(css).toMatch(/--shadow-card: 0 1px 2px rgb\(0 0 0 \/ 0\.1\);\n  --accent: #2563eb;\n}/);
    expect(css).toMatch(/\.dark \{[^}]*--accent: #60a5fa;/);
    expect(css).toContain('/* The brand. */');
    // Nothing else moved.
    expect(css.replace(/\n  --accent: [^;]+;/g, '').replace('#d93036', '#e5484d').replace('#ff7a7f', '#ff6369')).toBe(THEME_CSS);
    const theme = writeCssTokens(THEME_CSS, tokens.filter((t) => t.name === 'ink'), 'tailwind');
    expect(theme).toContain('--color-ink: oklch(0.25 0 0);');
    expect(writeCssTokens('', [tokens[2]!], 'css')).toBe(':root {\n  --accent: #2563eb;\n}\n\n[data-mode="dark"] {\n  --accent: #60a5fa;\n}\n');
  });

  it('goes to DTCG and back to the same tokens, kinds, modes and aliases', () => {
    const tokens: Token[] = [
      { name: 'brand', kind: 'color', value: '#e5484d', modes: { dark: '#ff6369' } },
      { name: 'brand-strong', kind: 'color', value: 'var(--brand)' },
      { name: 'space-4', kind: 'spacing', value: '16px' },
      { name: 'radius-card', kind: 'radius', value: '0.75rem' },
      { name: 'container-page', kind: 'container', value: '1200px' },
      { name: 'font-body', kind: 'font-family', value: '"Inter Tight", sans-serif' },
      { name: 'weight-bold', kind: 'font-weight', value: '700' },
      { name: 'leading-tight', kind: 'line-height', value: '1.2' },
      { name: 'tracking-wide', kind: 'letter-spacing', value: '0.02em' },
    ];
    const json = writeDtcg(null, tokens);
    const parsed = JSON.parse(json);
    expect(parsed['space-4']).toMatchObject({ $type: 'dimension', $value: { value: 16, unit: 'px' } });
    expect(parsed['brand-strong'].$value).toBe('{brand}');
    expect(parsed['font-body'].$value).toEqual(['Inter Tight', 'sans-serif']);
    const back = readDtcg(parsed, 'tokens.json').tokens.map(({ name, kind, value, modes }) => ({ name, kind, value, ...(modes ? { modes } : {}) }));
    expect(back).toEqual(tokens);
    // Twice is the same as once.
    expect(writeDtcg(json, tokens)).toBe(json);
  });

  it('reads DTCG files from other tools, with groups, inherited types and object values', () => {
    const read = readDtcg({
      color: { $type: 'color', brand: { $value: '#e5484d' }, text: { $value: { colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' } } },
      size: { $type: 'dimension', gap: { $value: { value: 8, unit: 'px' } }, radius: { sm: { $value: '4px' } } },
      font: { body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] } },
      shadow: { card: { $type: 'shadow', $value: { color: '#000', offsetX: '0px' } } },
      alias: { $type: 'color', link: { $value: '{color.brand}' } },
    }, 'tokens.json');
    expect(read.tokens.map((t) => [t.name, t.kind, t.value])).toEqual([
      ['color-brand', 'color', '#e5484d'], ['color-text', 'color', '#000000'], ['size-gap', 'spacing', '8px'], ['size-radius-sm', 'radius', '4px'],
      ['font-body', 'font-family', 'Inter, sans-serif'], ['alias-link', 'color', 'var(--color-brand)'],
    ]);
    expect(read.unclassified.map((u) => u.name)).toEqual(['shadow-card']);
    // Updating keeps the groups: a token changes where it is.
    const out = JSON.parse(writeDtcg(JSON.stringify({ color: { $type: 'color', brand: { $value: '#e5484d', $description: 'Ours' } } }), [{ name: 'color-brand', kind: 'color', value: '#d93036' }]));
    expect(out.color.brand).toMatchObject({ $value: '#d93036', $description: 'Ours' });
    expect(out['color-brand']).toBeUndefined();
  });

  it('reads a Tailwind 3 config as text', () => {
    const read = readTailwindConfig(`module.exports = { content: ['./src/**/*.tsx'], theme: { extend: { colors: { brand: { DEFAULT: '#e5484d', 600: '#d93036' }, ink: 'var(--ink)' }, borderRadius: { card: '12px' }, fontFamily: { sans: ['Inter', 'sans-serif'] }, spacing: { gutter: computeGutter() } } }, plugins: [require('x')] };`, 'tailwind.config.js');
    expect(read.map((t) => [t.name, t.kind, t.value]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1))).toEqual([['brand', 'color', '#e5484d'], ['brand-600', 'color', '#d93036'], ['font-sans', 'font-family', 'Inter, sans-serif'], ['ink', 'color', 'var(--ink)'], ['radius-card', 'radius', '12px']]);
  });

  it('tells the file and the repository apart, mode by mode', () => {
    const rows = diffTokens([
      { name: 'brand', kind: 'color', value: '#E5484D', modes: { dark: '#ff0000' } },
      { name: 'same', kind: 'color', value: '#000' },
      { name: 'mine', kind: 'spacing', value: '4px' },
    ], [
      { name: 'brand', kind: 'color', value: '#e5484d', modes: { dark: '#ff6369' }, file: 'a.css', format: 'css' },
      { name: 'same', kind: 'color', value: '#000', file: 'a.css', format: 'css' },
      { name: 'theirs', kind: 'radius', value: '8px', file: 'a.css', format: 'css' },
    ]);
    expect(rows.map((r) => [r.name, r.status])).toEqual([['brand', 'changed'], ['mine', 'file'], ['same', 'same'], ['theirs', 'repo']]);
    expect(rows[0]!.modes).toEqual([{ mode: 'dark', file: '#ff0000', repo: '#ff6369' }]);
  });
});

describe('token sync with a repository', () => {
  let fx: RepoFixture;
  let h: Harness;
  let agent: Client;
  let fileId = '';
  let project = '';
  const savedPath = process.env.PATH;
  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    fx = makeRepoFixture({
      'package.json': '{"name":"tokens-app","private":true}',
      'src/index.css': THEME_CSS,
      'design/tokens.json': JSON.stringify({ space: { $type: 'dimension', md: { $value: '16px' } } }, null, 2),
    });
    process.env.PATH = `${fx.bin}:${savedPath}`;
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Tokens' })).id;
    project = (await call(agent, 'code_project_link', { dir: fx.repo })).project.id;
    await call(agent, 'tokens_set', { tokens: [{ name: 'brand', kind: 'color', value: '#d93036' }, { name: 'accent', kind: 'color', value: '#2563eb' }] });
  }, 30_000);

  afterAll(async () => {
    process.env.PATH = savedPath;
    await agent?.close();
    await h?.cleanup();
    fx?.cleanup();
  });

  it('shows the repository next to the file', async () => {
    const res = await (await fetch(`${h.base}/api/code/${project}/tokens?fileId=${fileId}`)).json() as { sources: { file: string; format: string; writable: boolean }[]; rows: { name: string; status: string; repo?: string; file?: string }[] };
    expect(res.sources.map((s) => [s.file, s.format])).toEqual([['design/tokens.json', 'dtcg'], ['src/index.css', 'tailwind']]);
    const rows = Object.fromEntries(res.rows.map((r) => [r.name, r]));
    expect(rows.brand).toMatchObject({ status: 'changed', file: '#d93036', repo: '#e5484d' });
    expect(rows.accent!.status).toBe('file');
    expect(rows['space-md']!.status).toBe('repo');
    const tool = await call(agent, 'tokens_repo_diff', { status: 'changed' });
    expect(tool.rows.map((r: { name: string }) => r.name)).toEqual(['brand']);
    expect((await fetch(`${h.base}/api/code/${project}/tokens?fileId=${fileId}`, { headers: { 'X-Forwarded-For': '10.0.0.2' } })).status).toBe(403);
  });

  it('pulls from the repository into the file, with modes', async () => {
    const pulled = await (await fetch(`${h.base}/api/code/${project}/tokens/pull`, post({ fileId, names: ['surface', 'space-md'] }))).json() as { pulled: string[] };
    expect(pulled.pulled.sort()).toEqual(['space-md', 'surface']);
    const { doc } = await h.server.rooms.get(fileId);
    const surface = doc.getTokens().find((t) => t.name === 'surface');
    expect(surface).toMatchObject({ kind: 'color', value: '#ffffff', modes: { dark: '#111111' } });
    expect(doc.getTokens().find((t) => t.name === 'brand')!.value).toBe('#d93036');
    const viaTool = await call(agent, 'tokens_repo_pull', { names: ['ink'] });
    expect(viaTool.pulled).toEqual(['ink']);
  });

  it('pushes the file\'s tokens as a pull request, only after confirmation', async () => {
    const res = await fetch(`${h.base}/api/code/pulls/tokens`, post({ fileId, target: 'src/index.css' }));
    expect(res.status, await res.clone().text()).toBe(201);
    const d = await res.json() as PullDraft;
    expect(d.status).toBe('ready');
    expect(d.kind).toBe('tokens');
    expect(d.branch).toBe('bogen/design-tokens-from-tokens');
    expect(d.tokens).toMatchObject({ target: 'src/index.css', format: 'tailwind' });
    expect(d.tokens!.names.sort()).toEqual(['accent', 'brand']);
    expect(d.body).toContain('| `--brand` | `#e5484d` | `#d93036` |');
    expect(d.body).toContain('| `--accent` | new | `#2563eb` |');
    expect(d.body).toContain(`/#/file/${fileId}?version=${d.version.id}`);
    const css = fx.git(['show', `${d.commit}:src/index.css`]);
    expect(css).toContain('--color-brand: var(--brand);');
    expect(css).toMatch(/@theme \{[\s\S]*--color-accent: #2563eb;/);
    expect(readFileSync(join(fx.repo, 'src/index.css'), 'utf8')).toBe(THEME_CSS);
    expect(fx.ghCalls()).toEqual([]);
    expect((await fetch(`${h.base}/api/code/pulls/${d.id}/open`, post({ digest: 'wrong' }))).status).toBe(409);
    expect(fx.git(['ls-remote', '--heads', fx.remote])).not.toContain('bogen/');
    const opened = await (await fetch(`${h.base}/api/code/pulls/${d.id}/open`, post({ digest: d.digest }))).json() as PullDraft;
    expect(opened.status).toBe('opened');
    expect(fx.git(['ls-remote', '--heads', fx.remote])).toContain('refs/heads/bogen/design-tokens-from-tokens');
    expect(fx.ghCalls()[0]!.body).toBe(d.body);
  });

  it('writes DTCG when that is the source, and says when there is nothing to push', async () => {
    const res = await fetch(`${h.base}/api/code/pulls/tokens`, post({ fileId, names: ['accent'], title: 'Accent into DTCG' }));
    const d = await res.json() as PullDraft;
    expect(d.tokens).toMatchObject({ target: 'design/tokens.json', format: 'dtcg' });
    const json = JSON.parse(fx.git(['show', `${d.commit}:design/tokens.json`]));
    expect(json.space.md.$value).toBe('16px');
    expect(json.accent).toMatchObject({ $type: 'color', $value: '#2563eb', $extensions: { 'dev.bogen': { kind: 'color' } } });
    expect((await fetch(`${h.base}/api/code/pulls/${d.id}`, { method: 'DELETE' })).status).toBe(200);
    // ink came from the repository unchanged: nothing to push.
    expect((await fetch(`${h.base}/api/code/pulls/tokens`, post({ fileId, names: ['ink'], target: 'src/index.css' }))).status).toBe(409);
  });
});
