import { readFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/render.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
import { fixturePdf } from './pdf-fixture.ts';
import { makeRepoFixture, type RepoFixture } from './repo-fixture.ts';
import type { PullDraft } from '../src/pull-requests.ts';

/** The import and export formats through the MCP tools: DESIGN.md, Mermaid, PDF and PowerPoint. */

const TOKENS = [
  { name: 'surface', kind: 'color', value: '#ffffff', modes: { dark: '#16181b' } },
  { name: 'text', kind: 'color', value: '#1c1d1f', modes: { dark: '#f1f1ee' } },
  { name: 'border', kind: 'color', value: '#c9c6bf' },
  { name: 'accent', kind: 'color', value: '#c2410c' },
  { name: 'radius-md', kind: 'radius', value: '8px' },
  { name: 'space-4', kind: 'spacing', value: '16px' },
  { name: 'font-body', kind: 'font-family', value: 'Inter, sans-serif' },
];

describe('import and export formats over MCP', () => {
  let h: Harness;
  let client: Client;
  let fileId: string;

  beforeAll(async () => {
    h = await startServer();
    client = await connectAgent(h.base, 'claude');
    fileId = (await call(client, 'file_create', { name: 'Formats' })).id;
    await call(client, 'tokens_set', { file_id: fileId, tokens: TOKENS });
  }, 60_000);
  afterAll(async () => {
    await client.close();
    await h.cleanup();
  });

  it('exports a DESIGN.md with tokens_export and reads it back into another file as the same tokens', async () => {
    const text = await call<string>(client, 'tokens_export', { file_id: fileId, format: 'design-md' });
    expect(text).toMatch(/^---\nversion: alpha\nname: Formats\n/);
    const other = (await call(client, 'file_create', { name: 'Round trip' })).id;
    const dry = await call(client, 'design_md_import', { file_id: other, text, dry_run: true });
    expect(dry.applied).toBe(false);
    expect(dry.lint.filter((f: { severity: string }) => f.severity === 'error')).toEqual([]);
    const done = await call(client, 'design_md_import', { file_id: other, text });
    expect(done.tokens.tokens.sort()).toEqual(TOKENS.map((t) => t.name).sort());
    const back = await call<{ name: string; kind: string; value: string; modes?: Record<string, string> }[]>(client, 'tokens_get', { file_id: other });
    const norm = (list: typeof back) => list.map((t) => ({ name: t.name, kind: t.kind, value: t.value, ...(t.modes && Object.keys(t.modes).length ? { modes: t.modes } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
    expect(norm(back)).toEqual(norm(TOKENS as typeof back));
  });

  it('puts a DESIGN.md into a brand only as suggestions', async () => {
    const brand = (await call(client, 'brand_create', { name: 'Harbour' })).id;
    const out = await call(client, 'design_md_import', { into: 'brand', brand_id: brand, text: '---\nname: Harbour\ncolors:\n  primary: "#0b3d5c"\n---\n\n## Do\'s and Don\'ts\n\n- Don\'t use gradients\n' });
    expect(out.brand.added).toMatchObject({ colors: 1, rules: 1 });
    const read = await call(client, 'brand_get', { brand_id: brand });
    expect(JSON.stringify(read)).toContain('suggest');
  });

  it.skipIf(!findBrowser())('draws a Mermaid flowchart as layers in the file\'s tokens', async () => {
    const out = await call(client, 'diagram_insert', { file_id: fileId, source: 'flowchart LR\n  A[Draft] --> B{Approved?}\n  B -- yes --> C[Publish]\n  B -- no --> A' });
    expect(out.type).toMatch(/flowchart/);
    expect(out.counts).toMatchObject({ nodes: 3, connectors: 3 });
    expect(out.tokens).toMatchObject({ surface: 'surface', text: 'text', line: 'border', font: 'font-body' });
    const { doc } = await h.server.rooms.get(fileId);
    const board = doc.getNode(out.id)!;
    expect(board.artboard).toBe(true);
    const texts = doc.descendants(out.id).filter((n) => n.type === 'text').map((n) => n.text);
    expect(texts).toEqual(expect.arrayContaining(['Draft', 'Approved?', 'Publish', 'yes', 'no']));
  });

  it.skipIf(!findBrowser())('brings a PDF in as boards of text, vector and image layers, and reports what became a picture', async () => {
    const out = await call(client, 'pdf_import', { file_id: fileId, data_base64: Buffer.from(await fixturePdf()).toString('base64') });
    expect(out.ids.length).toBe(2);
    expect(out.total_pages).toBe(2);
    expect(out.report[0]).toMatchObject({ page: 1, text: 3, images: 1, pictures: [{ reason: 'gradient', drawn: true }] });
    expect(out.summary).toContain('1 part as a picture (gradient)');
    const { doc } = await h.server.rooms.get(fileId);
    expect(doc.descendants(out.ids[0]).filter((n) => n.type === 'text').map((n) => n.text)).toEqual(['Quarterly report', 'Revenue grew in every region.', 'Costs stayed flat.']);
  });

  it.skipIf(!findBrowser())('exports the pitch deck template as a PowerPoint file with editable text boxes', async () => {
    const brand = (await call(client, 'brand_create', { name: 'Sparse' })).id;
    await call(client, 'brand_update', { brand_id: brand, confirmed: true, items: [
      { section: 'colors', name: 'Night', role: 'background', value: '#101418', token: 'night' },
      { section: 'colors', name: 'Snow', role: 'text', value: '#f5f7fa', token: 'snow' },
      { section: 'colors', name: 'Lime', role: 'primary', value: '#b6f23a', token: 'lime' },
    ] });
    const deck = await call(client, 'template_use', { template: 'pitch-deck', brand_id: brand });
    expect(deck.boards.length).toBe(10);
    const out = await call(client, 'export_file', { file_id: deck.file_id, format: 'pptx' });
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0]).toMatch(/\.pptx$/);
    const report = out.reports[0];
    expect(report.native).toBeGreaterThan(20);
    expect(report.notes[0]).toBe('10 slides.');
    const zip = await JSZip.loadAsync(readFileSync(out.paths[0]));
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slides.length).toBe(10);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    // 1920 x 1080 px is 20 x 11.25 in, in EMU.
    expect(presentation).toContain('cx="18288000" cy="10287000"');
    const first = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const boxes = first.match(/<p:sp>[\s\S]*?<\/p:sp>/g)!.filter((sp) => sp.includes('<a:t>'));
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    const words = [...first.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');
    expect(words).toContain('Sparse');
    expect(words).toContain('01 of 10');
    for (const p of report.pictures ?? []) expect(p.reason.length).toBeGreaterThan(3);
  }, 120_000);
});

describe('DESIGN.md in a linked repository', () => {
  let fx: RepoFixture;
  let h: Harness;
  let agent: Client;
  let fileId = '';
  const savedPath = process.env.PATH;
  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    fx = makeRepoFixture({
      'package.json': '{"name":"site","private":true}',
      'src/theme.css': ':root {\n  --ink: #111111;\n}\n',
      'DESIGN.md': '---\nname: Site\ncolors:\n  ink: "#111111"\n  paper: "#faf8f2"\nrounded:\n  md: 8px\n---\n\n## Overview\n\nWritten by hand.\n',
    });
    process.env.PATH = `${fx.bin}:${savedPath}`;
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Site' })).id;
    await call(agent, 'code_project_link', { dir: fx.repo });
  }, 30_000);
  afterAll(async () => {
    process.env.PATH = savedPath;
    await agent?.close();
    await h?.cleanup();
    fx?.cleanup();
  });

  it('reads the repository\'s DESIGN.md as a token source and pulls from it, with the DESIGN.md for the agent', async () => {
    const diff = await call(agent, 'tokens_repo_diff', {});
    expect(diff.sources.map((s: { file: string; format: string }) => [s.file, s.format])).toEqual([['src/theme.css', 'css'], ['DESIGN.md', 'design-md']]);
    const pulled = await call(agent, 'tokens_repo_pull', { names: ['paper', 'md'], design_md: true });
    expect(pulled.pulled.sort()).toEqual(['md', 'paper']);
    expect(pulled.design_md).toMatchObject({ relative: 'DESIGN.md', exists: true });
    expect(pulled.design_md.text).toContain('paper: "#faf8f2"');
  });

  it('updates the repository\'s DESIGN.md in a token pull request, keeping its prose', async () => {
    await call(agent, 'tokens_set', { tokens: [{ name: 'accent', kind: 'color', value: '#c2410c' }] });
    const res = await fetch(`${h.base}/api/code/pulls/tokens`, post({ fileId, names: ['accent'], target: 'src/theme.css' }));
    expect(res.status, await res.clone().text()).toBe(201);
    const d = await res.json() as PullDraft;
    expect(d.files.map((f) => f.path).sort()).toEqual(['DESIGN.md', 'src/theme.css']);
    const md = fx.git(['show', `${d.commit}:DESIGN.md`]);
    expect(md).toContain('accent: "#c2410c"');
    expect(md).toContain('Written by hand.');
    expect(md).toContain('ink: "#111111"');
  });
});
