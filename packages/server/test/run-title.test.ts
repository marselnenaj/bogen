import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { startServer, until, withoutDesignReview, type Harness } from './helpers.ts';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * A run asked for by a button of the editor, such as Add 9:16 layout: the agent gets the whole brief, and the person
 * sees the button's short title in the queue, the run list, the chat and the History. One run per file, as always.
 */
describe('a run with a title, through the real run path', () => {
  let h: Harness;
  let bin: string;
  let log: string;
  let file: string;
  let page: string;
  let board: string;
  let note: string;
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), 'bogen-fake-'));
    log = join(bin, 'log.jsonl');
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    withoutDesignReview(h.server);
    file = h.server.storage.create('Wide Desk · Omarchy theme').id;
    const room = await h.server.rooms.get(file);
    page = room.doc.getPages()[0]!.id;
    board = room.doc.insert(page, { type: 'frame', name: 'Portrait background · 9:16 · 2160 × 3840', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '2160px', height: '3840px' } });
    note = room.doc.insert(board, { type: 'text', name: 'Note', text: 'Not designed yet' });
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('gives the agent the brief, shows the title everywhere a person reads it, and refuses a second run meanwhile', async () => {
    const brief = `Add the 9:16 layout of the Omarchy desktop theme "Wide Desk" in this file. Never crop a landscape picture. ${fake({ delayMs: 600, tools: [{ name: 'layer_text', args: { node_id: note, text: 'Wide Desk, tall' } }] })}`;
    const body = { fileId: file, pageId: page, nodeIds: [board], prompt: brief, title: 'Add 9:16 layout', runner: 'claude', intent: 'edit', conversationId: 'chat-portrait' };
    const res = await fetch(`${h.base}/api/runs`, json(body));
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };

    // The same click again, while it runs: refused by the server, so it never runs twice.
    const again = await fetch(`${h.base}/api/runs`, json(body));
    expect(again.status).toBe(409);
    expect((await again.json() as { error: string }).error).toMatch(/already going on this file/);

    const queue = await (await fetch(`${h.base}/api/runs/queue`)).json() as { running: { runId: string; title: string; fileId: string }[] };
    expect(queue.running.filter((r) => r.fileId === file)).toEqual([expect.objectContaining({ runId, title: 'Add 9:16 layout' })]);

    await until(() => !h.server.runs.isActive(runId), 15_000);
    const calls = fakeLog(log).filter((c) => c.kind === 'call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('Never crop a landscape picture.');

    const record = await h.server.history.get(file, runId);
    expect(record).toMatchObject({ title: 'Add 9:16 layout', nodeIds: [board] });
    expect(record!.prompt).toContain('Wide Desk');
    const turns = (await h.server.conversations.get(file, 'chat-portrait'))!.turns;
    expect(turns.map((t) => t.message)).toEqual(['Add 9:16 layout']);
    await until(async () => (await h.server.commits.list(file)).some((c) => c.run === runId), 10_000);
    expect((await h.server.commits.list(file)).find((c) => c.run === runId)!.message).toBe('Add 9:16 layout');
  }, 30_000);

  it('keeps the title when the run is asked again from the run list', async () => {
    const [last] = await h.server.history.list(file);
    const res = await fetch(`${h.base}/api/runs/${last!.id}/rerun`, json({ fileId: file }));
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    await until(() => !h.server.runs.isActive(runId), 15_000);
    expect(await h.server.history.get(file, runId)).toMatchObject({ title: 'Add 9:16 layout' });
  }, 30_000);
});
