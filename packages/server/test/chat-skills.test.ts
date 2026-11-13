import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptProposal, createProposals } from '@bogen/core';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('skills and mentions in the chat', () => {
  let h: Harness;
  let agent: Client;
  let bin = '';
  let log = '';
  let fileId = '';
  let pageId = '';
  let board = '';
  let title = '';
  let button = '';
  const saved = { path: process.env.PATH, browser: process.env.BOGEN_BROWSER };

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), 'bogen-chat-skills-'));
    log = join(bin, 'log.jsonl');
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BOGEN_BROWSER = join(bin, 'no-browser-here');
    h = await startServer();
    h.server.runs.beforeFinish = async () => ({ ok: true, message: 'Chat fixture.' });
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Shop' })).id;
    await call(agent, 'tokens_set', { tokens: [{ name: 'accent', kind: 'color', value: '#b4410c' }, { name: 'space-m', kind: 'spacing', value: '24px' }] });
    board = (await call(agent, 'artboard_create', { name: 'Pricing', width: 960 })).id;
    await call(agent, 'html_write', { target_id: board, html: '<section style="display:flex;flex-direction:column;gap:var(--space-m);padding:48px;font-family:Inter, sans-serif"><h1 style="font-size:40px;font-weight:700;color:#111111">Simple pricing</h1><p style="font-size:18px;color:#444444">Three plans.</p><button style="background:var(--accent);border-radius:8px;padding:12px 20px;color:#ffffff">Start free</button></section>' });
    title = (await call(agent, 'layer_find', { text: 'Simple pricing' })).layers[0].id;
    button = (await call(agent, 'layer_find', { text: 'Start free' })).layers[0].id;
    await call(agent, 'component_create', { node_ids: [button], name: 'Button' });
    pageId = (await h.server.rooms.get(fileId)).doc.getPages()[0]!.id;
  }, 40_000);

  afterAll(async () => {
    process.env.PATH = saved.path;
    if (saved.browser === undefined) delete process.env.BOGEN_BROWSER;
    else process.env.BOGEN_BROWSER = saved.browser;
    await agent?.close();
    await h?.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  const lastCall = () => fakeLog(log).filter((c) => c.kind === 'call').at(-1)!;

  it('lists the playbooks for /, with the ones the person saved their own version of', async () => {
    const { skills } = await (await fetch(`${h.base}/api/runs/skills`)).json() as { skills: { id: string; name: string; customized: boolean }[] };
    expect(skills.find((s) => s.id === 'websites')).toMatchObject({ customized: false });
    const current = h.server.knowledge.skill('websites');
    h.server.knowledge.change({ discipline: 'websites', revision: current.revision, action: 'save', markdown: `${current.markdown}\n\nMine.`, reason: 'Test' }, 'person');
    const again = await (await fetch(`${h.base}/api/runs/skills`)).json() as { skills: { id: string; customized: boolean }[] };
    expect(again.skills.find((s) => s.id === 'websites')!.customized).toBe(true);
  });

  it('gives a run the skill chosen with / and the ids of what was mentioned with @', async () => {
    const res = await fetch(`${h.base}/api/runs`, json({
      fileId, pageId, runner: 'claude', prompt: `Make @Simple pricing use @--accent like @Button. ${fake({ reply: 'Done.' })}`, discipline: 'email',
      mentions: [{ kind: 'layer', id: title }, { kind: 'token', id: 'accent' }, { kind: 'component', id: button }, { kind: 'layer', id: 'gone' }, { kind: 'component', id: title }],
    }));
    expect(res.status, await res.clone().text()).toBe(201);
    const { runId } = await res.json() as { runId: string };
    await until(() => !h.server.runs.isActive(runId), 15_000);
    const text = lastCall().text;
    expect(text).toContain('Design guidance already supplied for email');
    expect(text).toContain(`@Simple pricing is layer ${title} (text <h1> "Simple pricing" on page`);
    expect(text).toContain('@--accent is the token --accent (color #b4410c)');
    expect(text).toContain(`@Button is component ${button}`);
    expect(text).not.toContain('gone');
    // A layer that is not a component is not mentioned as one.
    expect(text!.match(new RegExp(`component ${title}`))).toBeNull();
    const record = await h.server.history.get(fileId, runId);
    expect(record?.knowledge?.discipline).toBe('email');
  });

  it('drafts a skill from a refined artboard and its accepted proposals, and saves nothing itself', async () => {
    const room = await h.server.rooms.get(fileId);
    const { doc } = room;
    // A proposal the person accepted on the artboard, with what was asked.
    const [copy] = doc.transact(() => createProposals(doc, board, { by: 'claude', count: 1, notes: ['Tighter'] }), 'agent:claude');
    h.server.memory.noteOrigin(fileId, copy!, { request: 'Tighten the pricing header', runner: 'claude' });
    h.server.memory.refresh(fileId);
    doc.transact(() => acceptProposal(doc, copy!), 'person:editor');
    await until(async () => (await h.server.memory.decisionsOf(`file-${fileId}`, [copy!])).length === 1, 5000);
    const before = h.server.knowledge.skill('websites');
    const res = await fetch(`${h.base}/api/runs/skill-draft`, json({ fileId, nodeId: board, discipline: 'websites' }));
    expect(res.status, await res.clone().text()).toBe(200);
    const draft = await res.json() as { discipline: string; revision: string; section: string; markdown: string; decisions: number };
    expect(draft.discipline).toBe('websites');
    expect(draft.revision).toBe(before.revision);
    expect(draft.decisions).toBe(1);
    expect(draft.section).toMatch(/^## Decisions from "Pricing"/);
    expect(draft.section).toContain('Type sizes, largest first: 40px, 18px');
    expect(draft.section).toContain('Tokens it relies on: --space-m, --accent');
    expect(draft.section).toContain('Accepted: Tighten the pricing header (Tighter).');
    expect(draft.markdown.startsWith(before.markdown.trimEnd())).toBe(true);
    expect(draft.markdown.endsWith(`${draft.section}\n`)).toBe(true);
    // Nothing changed until the person saves it, through the usual skill save.
    expect(h.server.knowledge.skill('websites').revision).toBe(before.revision);
    const savedRes = await fetch(`${h.base}/api/design-knowledge`, json({ discipline: 'websites', revision: draft.revision, action: 'save', markdown: draft.markdown, reason: 'The person saved decisions from Pricing.' }, 'PATCH'));
    expect(savedRes.status, await savedRes.clone().text()).toBe(200);
    expect(h.server.knowledge.skill('websites').markdown).toContain('## Decisions from "Pricing"');
    expect((await fetch(`${h.base}/api/runs/skill-draft`, json({ fileId, nodeId: 'nope' }))).status).toBe(404);
    expect((await fetch(`${h.base}/api/runs/skill-draft`, json({ fileId, nodeId: board, discipline: 'nope' }))).status).toBe(400);
  });
});
