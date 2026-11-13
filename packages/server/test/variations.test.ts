import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aspectOfStyle, cleanVariation, heldAspects, listProposals, proposalMark, variationBrief } from '@bogen/core';
import { splitSections } from '../src/race.ts';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('variation words', () => {
  it('sorts CSS into layout, colour and type, and holds what is not varied', () => {
    expect(aspectOfStyle('backgroundColor')).toBe('colour');
    expect(aspectOfStyle('--accent')).toBe('colour');
    expect(aspectOfStyle('fontSize')).toBe('type');
    expect(aspectOfStyle('letterSpacing')).toBe('type');
    expect(aspectOfStyle('gap')).toBe('layout');
    expect(heldAspects({ vary: ['layout'] })).toEqual(['colour', 'type', 'copy']);
    expect(heldAspects({ vary: [] })).toEqual([]);
    expect(cleanVariation({ range: 'wild', vary: ['copy', 'nonsense', 'layout'] })).toEqual({ range: 'explore', vary: ['layout', 'copy'] });
    expect(cleanVariation({ range: 'refine', vary: ['layout', 'colour', 'type', 'copy'] })).toEqual({ range: 'refine', vary: [] });
    const brief = variationBrief({ range: 'reimagine', vary: ['layout'] }, 3).join(' ');
    expect(brief).toMatch(/^Reimagine/);
    expect(brief).toMatch(/Hold fixed colour/);
    expect(brief).toMatch(/3 copies differ from each other/);
  });

  it('shares sections out over lanes in runs next to each other', () => {
    expect(splitSections([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]]);
    expect(splitSections([1, 2], 2)).toEqual([[1], [2]]);
  });
});

describe('proposals and races with a range and aspects', () => {
  let h: Harness;
  let agent: Client;
  let bin = '';
  let log = '';
  let fileId = '';
  let board = '';
  let title = '';
  const saved = { path: process.env.PATH, browser: process.env.BOGEN_BROWSER };

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), 'bogen-vary-'));
    log = join(bin, 'log.jsonl');
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BOGEN_BROWSER = join(bin, 'no-browser-here');
    h = await startServer();
    h.server.runs.beforeFinish = async () => ({ ok: true, message: 'Variation fixture.' });
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Pricing' })).id;
    board = (await call(agent, 'artboard_create', { name: 'Pricing', width: 960 })).id;
    await call(agent, 'html_write', { target_id: board, html: '<section style="display:flex;gap:24px;padding:48px"><h1 style="font-size:40px;color:#111111">Simple pricing</h1></section><section style="padding:32px"><p style="color:#444444">Three plans.</p></section><footer style="padding:24px"><p>Contact</p></footer>' });
    title = (await call(agent, 'layer_find', { text: 'Simple pricing' })).layers[0].id;
  }, 40_000);

  afterAll(async () => {
    process.env.PATH = saved.path;
    if (saved.browser === undefined) delete process.env.BOGEN_BROWSER;
    else process.env.BOGEN_BROWSER = saved.browser;
    await agent?.close();
    await h?.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('keeps the range and aspects on each copy, briefs the agent, and reports what a copy changed outside them', async () => {
    const made = await call(agent, 'proposal_create', { node_id: board, count: 2, range: 'explore', vary: ['layout'] });
    expect(made.variation).toEqual({ range: 'explore', vary: ['layout'] });
    expect(made.brief).toMatch(/Vary only layout/);
    expect(made.proposals.map((p: { note: string }) => p.note)).toEqual(['Explore: layout 1', 'Explore: layout 2']);
    const [one, two] = made.proposals as { id: string; layers: Record<string, string> }[];
    const { doc } = await h.server.rooms.get(fileId);
    expect(proposalMark(doc, one!.id)?.variation).toEqual({ range: 'explore', vary: ['layout'] });
    // One copy changes only its layout; the other also its colour, which it was to hold.
    await call(agent, 'layer_style', { node_ids: [one!.layers[title]!], style: { padding: '12px' } });
    await call(agent, 'layer_style', { node_ids: [two!.layers[title]!], style: { color: '#e11d48', padding: '8px' } });
    const listed = (await call(agent, 'proposal_list', {})).proposals as { id: string; held: { aspect: string; change: string }[] }[];
    expect(listed.find((p) => p.id === one!.id)!.held).toEqual([]);
    expect(listed.find((p) => p.id === two!.id)!.held).toEqual([expect.objectContaining({ aspect: 'colour', change: 'color #111111 -> #e11d48' })]);
    await call(agent, 'proposal_discard', { proposal_id: one!.id, all: true });
  });

  it('tells a Propose run how many copies, how far and what to vary', async () => {
    const { doc } = await h.server.rooms.get(fileId);
    const pageId = doc.getPages()[0]!.id;
    const res = await fetch(`${h.base}/api/runs`, json({ fileId, pageId, nodeIds: [board], runner: 'claude', review: 'proposal', prompt: `Tighten it. ${fake({ reply: 'Done.' })}`, variation: { count: 3, range: 'refine', vary: ['type', 'copy'] } }));
    expect(res.status, await res.clone().text()).toBe(201);
    const { runId } = await res.json() as { runId: string };
    await until(() => !h.server.runs.isActive(runId), 15_000);
    const sent = fakeLog(log).filter((c) => c.kind === 'call').at(-1)!;
    expect(sent.text).toContain('Call proposal_create on the layer you would change with count 3, range "refine", vary ["type","copy"]');
    expect(sent.text).toContain('Hold fixed layout');
    expect(sent.text).toMatch(/Refine: small, careful changes/);
  });

  it('splits a race over the sections of a page, each lane with its own, and takes lanes in one by one', async () => {
    const res = await fetch(`${h.base}/api/races`, json({ fileId, nodeId: board, prompt: `Polish the page. ${fake({ reply: 'Done.' })}`, lanes: [{ runner: 'claude' }, { runner: 'codex' }], split: true, range: 'refine', vary: ['colour'] }));
    expect(res.status, await res.clone().text()).toBe(201);
    const race = await res.json() as { id: string; split: boolean; variation: unknown; lanes: { id: string; sections: { original: string; proposalId: string; name: string }[]; runId?: string }[] };
    expect(race.split).toBe(true);
    expect(race.variation).toEqual({ range: 'refine', vary: ['colour'] });
    expect(race.lanes.map((l) => l.sections.length)).toEqual([2, 1]);
    const { doc } = await h.server.rooms.get(fileId);
    const sections = doc.getChildren(board).map((n) => n.id);
    expect(race.lanes.flatMap((l) => l.sections.map((x) => x.original))).toEqual(sections);
    for (const lane of race.lanes) for (const x of lane.sections) expect(proposalMark(doc, x.proposalId)).toMatchObject({ of: x.original, race: { id: race.id, lane: lane.id }, variation: { range: 'refine', vary: ['colour'] } });
    await until(async () => ((await (await fetch(`${h.base}/api/races?fileId=${fileId}`)).json()) as { id: string; lanes: { status: string }[] }[]).find((r) => r.id === race.id)!.lanes.every((l) => l.status === 'done'), 20_000);
    const calls = fakeLog(log).filter((c) => c.kind === 'call').slice(-2);
    const first = calls.find((c) => c.text?.includes(race.lanes[0]!.sections[0]!.proposalId))!;
    expect(first.text).toContain('This is a split race');
    expect(first.text).toMatch(/not in the other agents' sections \("Footer"\)/i);
    expect(first.text).toContain('Vary only colour');
    // Taking the first lane in leaves the other lane's copy where it is.
    const accepted = await fetch(`${h.base}/api/races/${race.id}/accept`, json({ laneId: race.lanes[0]!.id }));
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const open = listProposals(doc).filter((p) => p.race?.id === race.id).map((p) => p.id);
    expect(open).toEqual([race.lanes[1]!.sections[0]!.proposalId]);
    const second = await fetch(`${h.base}/api/races/${race.id}/accept`, json({ laneId: race.lanes[1]!.id }));
    expect(second.status).toBe(200);
    const after = ((await (await fetch(`${h.base}/api/races?fileId=${fileId}`)).json()) as { id: string; decided?: unknown; lanes: { decision?: string }[] }[]).find((r) => r.id === race.id)!;
    expect(after.lanes.map((l) => l.decision)).toEqual(['accepted', 'accepted']);
    expect(after.decided).toBeTruthy();
    expect(doc.getChildren(board).map((n) => n.id)).toEqual(sections);
  }, 40_000);

  it('refuses a split with more runs than sections', async () => {
    const small = (await call(agent, 'artboard_create', { name: 'Tiny', width: 400 })).id;
    await call(agent, 'html_write', { target_id: small, html: '<p>One</p>' });
    const res = await fetch(`${h.base}/api/races`, json({ fileId, nodeId: small, prompt: 'x', lanes: [{ runner: 'claude' }, { runner: 'codex' }], split: true }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/fewer than the 2 runs/);
  });
});
