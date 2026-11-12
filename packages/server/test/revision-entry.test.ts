import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferIntent, listRevisions } from '@bogen/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('reading what a request means for existing work', () => {
  it('tells a redo from an edit and from a request for a new page, in English and German', () => {
    for (const p of ['Mach die Seite neu, gefällt mir nicht', 'redo the hero', 'I don\'t like it, start over', 'Überarbeite das Pricing', 'make the page again']) expect(inferIntent(p), p).toBe('revise');
    for (const p of ['Add a new page for pricing', 'Mach eine neue Seite für das Impressum']) expect(inferIntent(p), p).toBe('new_page');
    for (const p of ['Make the heading 48px', 'Ändere die Farbe des Buttons', 'fix the typo in the footer', 'neue Farbe für den Button']) expect(inferIntent(p), p).toBe('edit');
  });

  it('does not read a negated, quoted or merely asked redo as a request to redo', () => {
    for (const p of [
      "Don't redesign it, just explain the spacing",
      'Bitte nicht neu machen, nur die Farbe ändern',
      'Why did you redo the hero?',
      'What does start over mean here?',
      'Change the button label to "Start over"',
      'Rename the link „Komplett neu“ to „Neu“',
      'No need to start over, tighten the spacing',
      'Warum hast du das überarbeitet?',
      "Don't make a new page, put it below the hero",
    ]) expect(inferIntent(p), p).toBe('edit');
    // A polite question is still a request, and an asked question next to a request keeps the request.
    expect(inferIntent('Can you redo the hero?')).toBe('revise');
    expect(inferIntent('Kannst du die Seite neu machen?')).toBe('revise');
    expect(inferIntent('Why is it so busy? Start over with less.')).toBe('revise');
    expect(inferIntent('Could you add a new page for the imprint?')).toBe('new_page');
  });
});

describe('a plain prompt to redo existing work, through the real run path', () => {
  let h: Harness;
  let bin: string;
  let log: string;
  let file: string;
  let page: string;
  let board: string;
  let heading: string;
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), 'bogen-fake-'));
    log = join(bin, 'log.jsonl');
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    file = h.server.storage.create('Landing').id;
    const room = await h.server.rooms.get(file);
    page = room.doc.getPages()[0]!.id;
    board = room.doc.insert(page, { type: 'frame', name: 'Landing', artboard: true, attrs: { 'data-bogen-discipline': 'websites' }, style: { position: 'absolute', left: '0px', top: '0px', width: '1200px', height: '700px' } });
    heading = room.doc.insert(board, { type: 'text', name: 'Heading', tag: 'h1', text: 'Chairs, made slowly' });
    room.doc.setToken('accent', 'color', '#1d4ed8');
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  afterEach(() => vi.restoreAllMocks());

  async function run(body: Record<string, unknown>): Promise<{ status: number; runId?: string; error?: string }> {
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', ...body }));
    const out = await res.json() as { runId?: string; error?: string };
    if (out.runId) {
      await until(() => !h.server.runs.isActive(out.runId!), 15_000);
      const record = await h.server.history.get(file, out.runId);
      expect(record?.status, record?.error).toBe('done');
    }
    return { status: res.status, ...out };
  }
  const calls = (runId: string) => fakeLog(log).filter((c) => c.kind === 'tool' && (c as { run?: string }).run !== 'x');
  void calls;

  it('opens a revision before the run, refuses a new page and the original, and keeps the original as it was', async () => {
    const room = await h.server.rooms.get(file);
    const pages = room.doc.getPages().length;
    const before = fakeLog(log).length;
    const out = await run({
      prompt: `Mach die Seite neu, gefällt mir nicht. ${fake({ tools: [{ name: 'page_create', args: { name: 'Landing v2' } }, { name: 'layer_text', args: { node_id: heading, text: 'Something else' } }, { name: 'tokens_set', args: { tokens: [{ name: 'accent', kind: 'color', value: '#ff0000' }] } }], verify: 'revision', verifyDiscipline: 'websites' })}`,
      conversationId: 'chat-redo',
    });
    expect(out.status).toBe(201);
    const entries = fakeLog(log).slice(before);
    const prompt = entries.find((e) => e.kind === 'call')!.text as string;
    expect(prompt).toMatch(/runs in the revision ".*" \(r[\w]+\)/);
    const tools = entries.filter((e) => e.kind === 'tool' && !['canvas_screenshot', 'design_verify'].includes(e.name!)) as { name: string; error: string | null }[];
    expect(tools.map((t) => [t.name, Boolean(t.error)])).toEqual([['page_create', true], ['layer_text', true], ['tokens_set', true]]);
    expect(tools[0]!.error).toMatch(/revision/);
    expect(tools[2]!.error).toMatch(/shared by the whole file/);
    room.doc.invalidate();
    expect(room.doc.getPages()).toHaveLength(pages);
    expect(room.doc.getNode(heading)!.text).toBe('Chairs, made slowly');
    expect(room.doc.getTokens().find((t) => t.name === 'accent')!.value).toBe('#1d4ed8');
    const revs = listRevisions(room.doc);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ status: 'draft', targets: [board], conversation: 'chat-redo' });
    expect(revs[0]!.checkpoint).toBeTruthy();
  }, 30_000);

  it('continues on the same draft with the next message, and changes the copy, including a local colour', async () => {
    const room = await h.server.rooms.get(file);
    const rev = listRevisions(room.doc)[0]!;
    const copy = rev.copies[0]!;
    const copyHeading = room.doc.getChildren(copy).find((n) => n.name === 'Heading')!.id;
    const out = await run({
      prompt: `Etwas wärmer bitte. ${fake({ tools: [{ name: 'layer_text', args: { node_id: copyHeading, text: 'Chairs, made by hand' } }, { name: 'layer_style', args: { node_ids: [copy], style: { '--accent': '#b4410c' } } }], verify: [copy], verifyDiscipline: 'websites' })}`,
      conversationId: 'chat-redo',
    });
    expect(out.status).toBe(201);
    room.doc.invalidate();
    expect(listRevisions(room.doc)).toHaveLength(1);
    expect(room.doc.getNode(copyHeading)!.text).toBe('Chairs, made by hand');
    expect(room.doc.getNode(copy)!.style['--accent']).toBe('#b4410c');
    expect(room.doc.getNode(heading)!.text).toBe('Chairs, made slowly');
  }, 30_000);

  it('edits in place when the request is an edit, and still does not grow a page', async () => {
    const room = await h.server.rooms.get(file);
    // The draft above is decided first, so this is a fresh conversation on a calm file.
    const before = fakeLog(log).length;
    const out = await run({ prompt: `Make the heading 48px. ${fake({ tools: [{ name: 'layer_style', args: { node_ids: [heading], style: { fontSize: '48px' } } }, { name: 'page_create', args: { name: 'Scratch' } }], verify: [board, ...listRevisions(room.doc).filter(r => r.status === 'draft').flatMap(r => r.copies)], verifyDiscipline: 'websites' })}`, conversationId: 'chat-edit' });
    expect(out.status).toBe(201);
    const tools = fakeLog(log).slice(before).filter((e) => e.kind === 'tool' && !['canvas_screenshot', 'design_verify'].includes(e.name!)) as { name: string; error: string | null }[];
    expect(tools.map((t) => [t.name, Boolean(t.error)])).toEqual([['layer_style', false], ['page_create', true]]);
    room.doc.invalidate();
    expect(room.doc.getNode(heading)!.style.fontSize).toBe('48px');
    expect(listRevisions(room.doc)).toHaveLength(1);
  }, 30_000);

  it('makes a new page when the person asks for one', async () => {
    const room = await h.server.rooms.get(file);
    const pages = room.doc.getPages().length;
    const out = await run({ prompt: `Pricing, please. ${fake({ tools: [{ name: 'page_create', args: { name: 'Pricing' } }], verify: [board, ...listRevisions(room.doc).filter(r => r.status === 'draft').flatMap(r => r.copies)], verifyDiscipline: 'websites' })}`, intent: 'new_page', conversationId: 'chat-new' });
    expect(out.status).toBe(201);
    room.doc.invalidate();
    expect(room.doc.getPages().map((p) => p.name)).toContain('Pricing');
    expect(room.doc.getPages()).toHaveLength(pages + 1);
  }, 30_000);

  it('withdraws the empty draft of a stopped run, and keeps one the run had changed', async () => {
    const room = await h.server.rooms.get(file);
    const open = listRevisions(room.doc).find((r) => r.status === 'draft');
    if (open) room.doc.transact(() => room.doc.meta.set('revisions', Object.fromEntries(listRevisions(room.doc).map((r) => [r.id, { ...r, status: r.id === open.id ? 'discarded' : r.status }]))));
    // Stopped before it did anything: the copies go, the record and its commit stay.
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', prompt: `start over with the landing page ${fake({ hang: true })}`, conversationId: 'chat-stop' }));
    const started = await res.json() as { runId: string; error?: string };
    expect(started.error).toBeUndefined();
    const runId = started.runId;
    await until(() => listRevisions(room.doc).some((r) => r.conversation === 'chat-stop'), 5000);
    await fetch(`${h.base}/api/runs/${runId}/stop`, { method: 'POST' });
    await until(() => !h.server.runs.isActive(runId), 10_000);
    await until(() => listRevisions(room.doc).find((r) => r.conversation === 'chat-stop')?.status === 'discarded', 5000);
    const stopped = listRevisions(room.doc).find((r) => r.conversation === 'chat-stop')!;
    expect(room.doc.getNode(stopped.copies[0]!)).toBeUndefined();
    expect(stopped.checkpoint).toBeTruthy();

    // A run stopped after its draft was worked on leaves the draft for the person.
    const res2 = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', prompt: `redo the landing page ${fake({ hang: true })}`, conversationId: 'chat-work' }));
    const second = (await res2.json() as { runId: string }).runId;
    await until(() => listRevisions(room.doc).some((r) => r.conversation === 'chat-work'), 5000);
    const working = listRevisions(room.doc).find((r) => r.conversation === 'chat-work')!;
    const copyHeading = room.doc.getChildren(working.copies[0]!).find((n) => n.name === 'Heading')!.id;
    room.doc.updateFields(copyHeading, { text: 'Worked on' });
    await fetch(`${h.base}/api/runs/${second}/stop`, { method: 'POST' });
    await until(() => !h.server.runs.isActive(second), 10_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(listRevisions(room.doc).find((r) => r.id === working.id)?.status).toBe('draft');
    expect(room.doc.getNode(working.copies[0]!)).toBeTruthy();
  }, 40_000);

  it('protects a redo asked in a comment thread the same way, and continues it with the next mention', async () => {
    const room = await h.server.rooms.get(file);
    for (const r of listRevisions(room.doc).filter((x) => x.status === 'draft')) room.doc.transact(() => room.doc.meta.set('revisions', Object.fromEntries(listRevisions(room.doc).map((y) => [y.id, { ...y, status: y.id === r.id ? 'discarded' : y.status }]))));
    const pages = room.doc.getPages().length;
    const comment = async (text: string) => (await (await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Mara', pageId: page, nodeId: board, text }))).json()) as { threadId: string };
    const before = fakeLog(log).length;
    const { threadId } = await comment(`@claude make this again, I don't like it ${fake({ tools: [{ name: 'page_create', args: { name: 'From the comment' } }, { name: 'layer_text', args: { node_id: heading, text: 'Changed from a comment' } }], thread: 'resolve', verify: 'revision', verifyDiscipline: 'websites' })}`);
    await until(() => listRevisions(room.doc).some((r) => r.conversation === `thread:${threadId}`), 8000);
    await until(() => fakeLog(log).slice(before).some((e) => e.kind === 'tool' && (e as { name: string }).name === 'layer_text'), 15_000);
    await until(() => h.server.runs.list().length === 0, 15_000);
    const tools = fakeLog(log).slice(before).filter((e) => e.kind === 'tool' && !['canvas_screenshot', 'design_verify'].includes(e.name!)) as { name: string; error: string | null }[];
    expect(tools.filter((t) => t.name === 'page_create' || t.name === 'layer_text').every((t) => t.error)).toBe(true);
    room.doc.invalidate();
    expect(room.doc.getPages()).toHaveLength(pages);
    expect(room.doc.getNode(heading)!.text).not.toBe('Changed from a comment');
    expect(listRevisions(room.doc).find((r) => r.conversation === `thread:${threadId}`)?.status).toBe('draft');
  }, 40_000);

  it('asks for a choice instead of copying a page of many screens', async () => {
    const big = h.server.storage.create('Screens').id;
    const room = await h.server.rooms.get(big);
    const p = room.doc.getPages()[0]!.id;
    const ids: string[] = [];
    room.doc.transact(() => {
      for (let i = 0; i < 30; i++) ids.push(room.doc.insert(p, { type: 'frame', name: `Screen ${i}`, artboard: true, style: { position: 'absolute', left: `${i * 500}px`, top: '0px', width: '420px', height: '935px' } }));
    });
    const refused = await fetch(`${h.base}/api/runs`, json({ fileId: big, pageId: p, runner: 'claude', prompt: 'redo all of these screens', conversationId: 'chat-big' }));
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toMatch(/30 artboards .* Select the artboards/);
    expect(listRevisions(room.doc)).toEqual([]);
    const chosen = await fetch(`${h.base}/api/runs`, json({ fileId: big, pageId: p, nodeIds: [ids[3]!], runner: 'claude', prompt: `redo this screen ${fake({ verify: 'revision' })}`, conversationId: 'chat-big' }));
    expect(chosen.status).toBe(201);
    const { runId } = await chosen.json() as { runId: string };
    await until(() => !h.server.runs.isActive(runId), 10_000);
    expect(listRevisions(room.doc)[0]!.targets).toEqual([ids[3]]);
  }, 30_000);

  it('refuses to start a redo when the checkpoint cannot be written, before any copy exists', async () => {
    const room = await h.server.rooms.get(file);
    const copiesBefore = listRevisions(room.doc).length;
    const nodesBefore = room.doc.nodes.size;
    vi.spyOn(h.server.commits, 'commit').mockRejectedValue(new Error('ENOSPC: no space left on device'));
    const out = await run({ prompt: 'redo the landing page, start over', conversationId: 'chat-full-disk' });
    expect(out.status).toBe(503);
    expect(out.error).toMatch(/could not be committed before the revision \(ENOSPC/);
    room.doc.invalidate();
    expect(listRevisions(room.doc)).toHaveLength(copiesBefore);
    expect(room.doc.nodes.size).toBe(nodesBefore);
  }, 30_000);
});
