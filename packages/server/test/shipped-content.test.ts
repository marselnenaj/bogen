import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { craftFindings, designReview, readBrand, voiceFindings, type BogenDoc, type BrandData } from '@bogen/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyIssues } from '../src/mcp/copy-check.ts';
import { staticIssues } from '../src/mcp/lint.ts';
import { writeBrandSpec } from '../src/templates/brand-spec.ts';
import { TEMPLATES } from '../src/templates/index.ts';
import { SECTIONS } from '../src/templates/web-sections.ts';
import { BOGEN_BRAND } from '../src/templates/welcome.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * Everything Bogen ships as starting content, run through the checks that need no browser: the craft checks of
 * design_lint, design_review and design_verify, the copy check, the brand's voice, the spacing scale and rhythm, and
 * design_review's own observations. A product must not fail its own checks, so each must come out with no finding.
 *
 * The welcome file and the four examples bring their own brand. Templates build from the brand a person has, so they
 * are made from each example brand, Bogen's own brand, and a brand of three colours and nothing else.
 *
 * What needs a render (contrast as drawn, overflow, text under 12px, target size, the type hierarchy as rendered) is
 * in design_lint's browser half and not here.
 */

/**
 * Findings that are wrong about what they look at, with why. Each names the source, the board, the rule and the layer,
 * so that a new finding of the same rule elsewhere still fails. None are listed: a finding that misreads shipped
 * content is a defect in its check, to be fixed there. What a template shows rather than designs carries
 * data-brand-example (dont or specimen), and an Omarchy theme file is read as a preview of the system; see the checks.
 */
const FALSE_POSITIVES: { source: RegExp; board: RegExp; rule: string; layer: RegExp; why: string }[] = [];

let h: Harness;
let client: Client;
const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, PATH: process.env.PATH, OMAMOBILE_PATH: process.env.OMAMOBILE_PATH };
let root = '';
const brands: { id: string; name: string }[] = [];

beforeAll(async () => {
  // Omarchy themes read the person's folders and screens: here a home of their own and a stand-in hyprctl.
  root = mkdtempSync(join(tmpdir(), 'bogen-shipped-'));
  const bin = join(root, 'bin');
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'omarchy', 'themes'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '[{"width":1920,"height":1080,"transform":0}]'\n`);
  writeFileSync(join(bin, 'omarchy'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'hyprctl'), 0o755);
  chmodSync(join(bin, 'omarchy'), 0o755);
  process.env.HOME = join(root, 'home');
  process.env.OMARCHY_PATH = join(root, 'omarchy');
  process.env.OMAMOBILE_PATH = join(root, 'omamobile');
  process.env.PATH = `${bin}:${saved.PATH}`;
  h = await startServer({ welcome: true });
  client = await connectAgent(h.base, 'claude');
  // The example brands, made the way using an example makes them.
  for (const t of TEMPLATES.filter((x) => x.brand)) brands.push({ id: (await call(client, 'template_use', { template: t.id })).brand_id, name: t.brand!.name });
  const bogen = await h.server.brands.create('Bogen', 'Bogen');
  writeBrandSpec((await h.server.brands.read(bogen.id)).room.doc, BOGEN_BRAND, 'test');
  brands.push({ id: bogen.id, name: 'Bogen' });
  const sparse = (await call(client, 'brand_create', { name: 'Sparse' })).id;
  await call(client, 'brand_update', { brand_id: sparse, confirmed: true, items: [
    { section: 'colors', name: 'Night', role: 'background', value: '#101418', token: 'night' },
    { section: 'colors', name: 'Snow', role: 'text', value: '#f5f7fa', token: 'snow' },
    { section: 'colors', name: 'Lime', role: 'primary', value: '#b6f23a', token: 'lime' },
  ] });
  brands.push({ id: sparse, name: 'Sparse' });
}, 120_000);

afterAll(async () => {
  await client?.close();
  await h?.cleanup();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Every finding on a board, as "board / layer: rule: message". */
function findings(source: string, doc: BogenDoc, boardId: string, brand?: BrandData): string[] {
  const board = doc.getNode(boardId)!;
  const nodes = [board, ...doc.descendants(boardId)];
  const name = (id: string) => doc.getNode(id)?.name ?? id;
  const width = Number.parseFloat(board.style.width ?? '') || 1440;
  const out: { rule: string; layer: string; message: string }[] = [];
  // design_lint reads clamp() sizes at 1440, design_review at the width asked for: both.
  for (const vw of new Set([1440, width])) for (const f of craftFindings(doc, boardId, vw)) out.push({ rule: f.rule, layer: name(f.nodeId), message: f.message });
  for (const i of staticIssues(doc, nodes)) if (i.rule === 'spacing') out.push({ rule: i.rule, layer: i.name, message: i.message });
  for (const c of copyIssues(nodes, [], { doc })) out.push({ rule: 'copy', layer: c.name, message: c.message });
  if (brand) {
    const texts = nodes.filter((n) => !n.virtual && n.text?.trim()).map((n) => ({ id: n.id, name: n.name, tag: n.tag, text: n.text! }));
    for (const v of voiceFindings(brand, texts)) out.push({ rule: 'voice', layer: v.layer, message: v.message });
  }
  // design_review's own observations; the ones with a rule are the craft checks above.
  for (const o of designReview(doc, boardId, width).observations) if (!o.rule) out.push({ rule: `review-${o.aspect}`, layer: o.layers.map(name).slice(0, 3).join(', '), message: o.message });
  const kept = out.filter((f) => !FALSE_POSITIVES.some((fp) => fp.source.test(source) && fp.board.test(board.name) && fp.rule === f.rule && fp.layer.test(f.layer)));
  return [...new Set(kept.map((f) => `${board.name} / ${f.layer}: ${f.rule}: ${f.message}`))];
}

async function boardsOf(fileId: string, ids: string[], source: string, brandId?: string): Promise<string[]> {
  const { doc } = await h.server.rooms.get(fileId);
  const brand = brandId ? readBrand((await h.server.brands.read(brandId)).room.doc) : undefined;
  const out = ids.flatMap((id) => findings(source, doc, id, brand));
  if (process.env.DUMP) writeFileSync(join(process.env.DUMP, `${source.replace(/\W+/g, '_')}.txt`), out.join('\n'));
  return out;
}

describe('shipped content passes its own checks', () => {
  it('the welcome file', async () => {
    const { id } = await h.server.welcome.open();
    const { doc } = await h.server.rooms.get(id);
    const boards = doc.getPages().flatMap((p) => doc.getChildren(p.id).map((b) => b.id));
    expect(boards.length).toBeGreaterThan(0);
    expect(await boardsOf(id, boards, 'welcome')).toEqual([]);
  });

  for (const t of TEMPLATES.filter((x) => x.brand)) {
    it(`the example ${t.id}`, async () => {
      const out = await call(client, 'template_use', { template: t.id });
      expect(await boardsOf(out.file_id, out.boards.map((b: { id: string }) => b.id), t.id, out.brand_id)).toEqual([]);
    });
  }

  for (const t of TEMPLATES.filter((x) => !x.brand)) {
    it(`the template ${t.id}, from each shipped brand and a sparse one`, async () => {
      const all: string[] = [];
      for (const b of brands) {
        const out = await call(client, 'template_use', { template: t.id, brand_id: b.id });
        all.push(...(await boardsOf(out.file_id, out.boards.map((x: { id: string }) => x.id), `${t.id}@${b.name}`, b.id)).map((f) => `${b.name}: ${f}`));
      }
      expect(all).toEqual([]);
    }, 60_000);
  }

  it('the web sections, as one page, without tokens and on the fluid scale', async () => {
    const all: string[] = [];
    for (const fluid of [false, true]) {
      const file = (await call(client, 'file_create', { name: `Sections${fluid ? ', fluid' : ''}` })).id;
      if (fluid) await call(client, 'type_scale_set', { file_id: file });
      const board = (await call(client, 'artboard_create', { file_id: file, name: 'Page', width: 1440 })).id;
      for (const s of SECTIONS) await call(client, 'section_insert', { file_id: file, kind: s.kind, into: board });
      all.push(...await boardsOf(file, [board], `sections${fluid ? '@fluid' : ''}`));
    }
    expect(all).toEqual([]);
  });

  for (const target of ['desktop', 'mobile'] as const) {
    it(`a new Omarchy theme file, ${target}`, async () => {
      // One theme per session: each target from an agent of its own.
      const agent = await connectAgent(h.base, `theme-${target}`);
      const out = await call(agent, 'omarchy_theme_create', { name: `Shipped ${target}`, target });
      await agent.close();
      expect(await boardsOf(out.file_id, out.boards.map((b: { id: string }) => b.id), `omarchy-${target}`)).toEqual([]);
    });
  }
});
