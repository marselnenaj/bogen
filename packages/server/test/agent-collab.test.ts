import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MAX_PARALLEL_RUNS } from '@bogen/core';
import { pdfText } from '../src/pdf-text.ts';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { startServer, until, withoutDesignReview, type Harness } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#e5484d"/></svg>');
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function briefPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('Briefing: the heading says Sommerfest.', { x: 50, y: 700, font, size: 14 });
  return doc.save();
}

describe('reading a PDF attached to a comment', () => {
  it('reads the words pdf-lib writes, umlauts and parentheses included', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage();
    page.drawText('Briefing: the heading must say Sommerfest (2026).', { x: 50, y: 700, font, size: 14 });
    page.drawText('Zweite Zeile, größer bitte.', { x: 50, y: 680, font, size: 14 });
    const text = pdfText(await doc.save());
    expect(text).toContain('Briefing: the heading must say Sommerfest (2026).');
    expect(text).toContain('Zweite Zeile, größer bitte.');
    expect(text!.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('reads literal strings with escapes, and plain streams', () => {
    const content = 'BT /F1 12 Tf 72 712 Td (Hello \\(world\\)) Tj 0 -14 Td [(Two) -300 (words)] TJ ET';
    const pdf = `%PDF-1.4\n1 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`;
    expect(pdfText(Buffer.from(pdf, 'latin1'))).toBe('Hello (world)\nTwo words');
  });

  it('gives nothing for a PDF without text, or for what is not a PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect(pdfText(await doc.save())).toBeNull();
    expect(pdfText(Buffer.from('not a pdf'))).toBeNull();
  });
});

describe('the agent loop with people, with stand-in CLIs', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-collab-bin-'));
  const log = join(bin, 'calls.jsonl');
  const savedPath = process.env.PATH;
  let h: Harness;
  let file: string;
  let page: string;
  let board: string;
  const calls = () => fakeLog(log).filter((c) => c.kind === 'call');
  const idle = () => until(() => !h.server.runs.activeFor(file) && !h.server.commentRuns.list(file).length, 8000);
  const upload = async (bytes: Uint8Array, type: string) => (await (await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'content-type': type }, body: Buffer.from(bytes) })).json()) as { src: string };
  const comment = async (body: Record<string, unknown>) => {
    const res = await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Mara', pageId: page, ...body }));
    expect(res.status).toBe(201);
    return (await res.json()) as { threadId: string; started: string[] };
  };

  beforeAll(async () => {
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    withoutDesignReview(h.server);
    file = ((await (await fetch(`${h.base}/api/files`, json({ name: 'Collab' }))).json()) as { id: string }).id;
    const room = await h.server.rooms.get(file);
    page = room.doc.getPages()[0]!.id;
    board = room.doc.insert(page, { type: 'frame', name: 'Hero', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '400px', height: '200px', background: '#ffffff' } });
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  describe('attachments in a thread', () => {
    it('hands images to both CLIs as images, and text and PDF files as text', async () => {
      const png = await upload(PNG, 'image/png');
      const svg = await upload(SVG, 'image/svg+xml');
      const notes = await upload(Buffer.from('# Notes\nUse the word Sommerfest in the heading.\n'), 'text/markdown');
      const pdf = await upload(await briefPdf(), 'application/pdf');
      const attachments = [{ src: png.src, name: 'shot.png', width: 1, height: 1 }, { src: svg.src, name: 'logo.svg', width: 40, height: 20 }, { src: notes.src, name: 'notes.md' }, { src: pdf.src, name: 'brief.pdf' }];
      const first = await comment({ nodeId: board, text: `@claude look at these ${fake({ thread: 'resolve', reply: 'Seen.' })}`, attachments });
      expect(first.started).toEqual(['claude']);
      await idle();
      const claude = calls().at(-1)!;
      expect(claude.runner).toBe('claude');
      expect(claude.args).toContain('--input-format');
      // The PNG as it is, the SVG as a PNG drawn from it.
      expect(claude.images!.map((i) => i.mime)).toEqual(['image/png', 'image/png']);
      expect(claude.images![1]!.bytes).toBeGreaterThan(PNG.length);
      expect(claude.text).toContain('File "notes.md" (text/markdown), attached by Mara:');
      expect(claude.text).toContain('Use the word Sommerfest in the heading.');
      expect(claude.text).toContain('File "brief.pdf" (PDF, its text), attached by Mara:');
      expect(claude.text).toContain('Briefing: the heading says Sommerfest.');
      expect(claude.text).toContain('2 images attached to the thread come with this request: "shot.png", "logo.svg".');
      expect(claude.text).toContain('in files attached to it');

      // Asked again in the same thread, Codex gets the earlier attachments too, as -i files ahead of its flags.
      await comment({ threadId: first.threadId, text: `@codex and you ${fake({ thread: 'resolve' })}` });
      await idle();
      const codex = calls().at(-1)!;
      expect(codex.runner).toBe('codex');
      expect(codex.images!.length).toBe(2);
      expect(codex.args!.indexOf('-i')).toBe(1);
      expect(codex.text).toContain('Use the word Sommerfest in the heading.');
    });

    it('says what it could not pass on, and leaves voice notes out', async () => {
      const empty = await upload(Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf');
      const res = await comment({ nodeId: board, text: `@claude here ${fake({ thread: 'resolve' })}`, attachments: [{ src: empty.src, name: 'scan.pdf' }, { src: 'bogen-voice:0123456789abcdef01234567.webm', kind: 'audio' }] });
      expect(res.started).toEqual(['claude']);
      await idle();
      const call = calls().at(-1)!;
      expect(call.images).toEqual([]);
      expect(call.args).not.toContain('--input-format');
      expect(call.text).toContain('Attached but not passed on: scan.pdf: a PDF whose text cannot be read here');
      expect(call.text).not.toContain('bogen-voice');
    });

  });

  describe('a comment run, followed and stopped in its thread', () => {
    it('reports each step under the thread, also to an editor that opens midway, and stops cleanly', async () => {
      const events: any[] = [];
      const off = h.server.hub.tap((e) => { if (e.t === 'comment-run') events.push(e); });
      const tools = [1, 2, 3].map((n) => ({ name: 'layer_style', args: { node_ids: [board], style: { padding: `${n * 4}px` } } }));
      const { threadId } = await comment({ nodeId: board, text: `@codex tighten this ${fake({ tools, delayMs: 30, hang: true })}` });
      await until(() => h.server.commentRuns.list(file)[0]?.steps?.length === 3);
      const [running] = h.server.commentRuns.list(file);
      expect(running).toMatchObject({ threadId, runner: 'codex', status: 'working' });
      expect(running!.steps!.map((s) => s.tool)).toEqual(['layer_style', 'layer_style', 'layer_style']);
      expect(events.filter((e) => e.tool === 'layer_style').length).toBe(3);
      expect(events.every((e) => e.queueId === running!.queueId || !e.queueId)).toBe(true);
      // The answer to a question the editor asks when it opens.
      const listed = await (await fetch(`${h.base}/api/comments/runs?fileId=${file}`)).json() as any[];
      expect(listed[0].steps.length).toBe(3);

      expect((await fetch(`${h.base}/api/runs/${running!.runId}/stop`, { method: 'POST' })).status).toBe(200);
      await idle();
      off();
      const thread = (await h.server.rooms.get(file)).doc.getComments().find((t) => t.id === threadId)!;
      expect(thread.messages.at(-1)!.text).toBe('codex was stopped after 3 steps. What it changed until then stays, and Undo this run takes it back.');
      expect(events.at(-1)).toMatchObject({ threadId, status: 'stopped' });
      const record = (await (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as any[]).find((r) => r.id === running!.runId);
      expect(record.status).toBe('stopped');
    });
  });

  describe('a thread stays open for the person', () => {
    it('refuses an agent resolving while its run is still going, and after it ends', async () => {
      const room = await h.server.rooms.get(file);
      const threadOf = (id: string) => room.doc.getComments().find((t) => t.id === id)!;
      const tools = [
        { name: 'comment_resolve', args: { thread_id: '$thread' } },
        { name: 'layer_style', args: { node_ids: [board], style: { padding: '12px' } } },
      ];
      const { threadId } = await comment({ nodeId: board, text: `@codex tighten it ${fake({ tools, hang: true })}` });
      await until(() => h.server.commentRuns.list(file)[0]?.steps?.some((s) => s.tool === 'layer_style') === true, 8000);
      // Still running: the call was refused and the thread is open.
      const attempt = fakeLog(log).filter((e) => e.kind === 'tool' && (e as { name: string }).name === 'comment_resolve').at(-1) as { error: string | null } | undefined;
      expect(attempt?.error).toBeTruthy();
      expect(h.server.commentRuns.list(file)[0]).toMatchObject({ threadId, status: 'working' });
      expect(threadOf(threadId).resolved).toBe(false);
      const [running] = h.server.commentRuns.list(file);
      await fetch(`${h.base}/api/runs/${running!.runId}/stop`, { method: 'POST' });
      await idle();
      // Ended: nothing closes it, and the person still can, and can reopen it.
      expect(threadOf(threadId).resolved).toBe(false);
      room.doc.setThreadResolved(threadId, true, 'person:Mara');
      expect(threadOf(threadId).resolved).toBe(true);
      room.doc.setThreadResolved(threadId, false, 'person:Mara');
      expect(threadOf(threadId).resolved).toBe(false);

      // A run that answers and then tries to resolve, as agents did, leaves it open after it is done.
      const done = await comment({ threadId, text: `@claude and the colour ${fake({ thread: 'resolve', reply: 'Changed it.' })}` });
      await idle();
      expect(threadOf(done.threadId).messages.at(-1)).toMatchObject({ author: 'claude', text: 'Changed it.' });
      expect(threadOf(done.threadId).resolved).toBe(false);
      // And the file as saved and loaded again says the same.
      await h.server.rooms.unload(file);
      const reloaded = await h.server.rooms.get(file);
      expect(reloaded.doc.getComments().find((t) => t.id === threadId)!.resolved).toBe(false);
    }, 20_000);
  });

  describe('the run queue', () => {
    const files: string[] = [];
    const queue = async () => (await (await fetch(`${h.base}/api/runs/queue`)).json()) as { limit: number; running: any[]; queued: any[] };
    const hang = (fileId: string) => fetch(`${h.base}/api/runs`, json({ fileId, prompt: `wait ${fake({ hang: true })}`, runner: 'claude' }));

    // Every slot of the computer is taken: A and the others run, and E's comment waits for a free one.
    const limit = MAX_PARALLEL_RUNS;
    const others = Array.from({ length: limit - 1 }, (_, i) => `B${i + 1}`);

    beforeAll(async () => {
      for (const name of ['A', ...others, 'E']) {
        const id = ((await (await fetch(`${h.base}/api/files`, json({ name: `Queue ${name}` }))).json()) as { id: string }).id;
        files.push(id);
      }
    });

    it('lists runs and waiting comments across files, says why each waits, and lets the person reorder and cancel', async () => {
      const [a, ...rest] = files as [string, ...string[]];
      const busy = rest.slice(0, -1);
      const b = busy[0]!;
      const e = rest.at(-1)!;
      const post = async (fileId: string, text: string) => {
        const pageId = (await h.server.rooms.get(fileId)).doc.getPages()[0]!.id;
        return (await (await fetch(`${h.base}/api/comments`, json({ fileId, pageId, author: 'Mara', text }))).json()) as { threadId: string };
      };
      expect((await hang(a)).status).toBe(201);
      const first = await post(a, `@claude one ${fake({ thread: 'resolve' })}`);
      const second = await post(a, `@claude two ${fake({ thread: 'resolve' })}`);
      for (const f of busy) expect((await hang(f)).status).toBe(201);
      await until(() => h.server.runs.count() === limit, 15_000);
      const late = await post(e, `@codex three ${fake({ thread: 'resolve' })}`);

      let view = await queue();
      expect(view.limit).toBe(limit);
      expect(view.running.map((r) => r.fileName).sort()).toEqual(['Queue A', ...others.map((n) => `Queue ${n}`)].sort());
      expect(view.running[0]).toMatchObject({ kind: 'running', runner: 'claude', source: 'prompt' });
      expect(view.queued.map((q) => [q.fileName, q.title.split(' FAKE')[0], q.reason])).toEqual([
        ['Queue A', '@claude one', 'Waits for the run going on this file'],
        ['Queue A', '@claude two', 'Waits behind an earlier comment in this file'],
        ['Queue E', '@codex three', `Waits for a free slot: ${limit} runs are going on this computer`],
      ]);

      // E first, and A's second out of the queue, which its thread is told.
      const [one, two, three] = view.queued;
      expect((await fetch(`${h.base}/api/runs/queue/move`, json({ id: three.id, to: 0 }))).status).toBe(200);
      const cancelled = await fetch(`${h.base}/api/runs/queue/cancel`, json({ id: two.id, who: 'Mara' }));
      view = (await cancelled.json()) as typeof view;
      expect(view.queued.map((q) => q.id)).toEqual([three.id, one.id]);
      const threadOf = async (fileId: string, id: string) => (await h.server.rooms.get(fileId)).doc.getComments().find((t) => t.id === id)!;
      expect((await threadOf(a, second.threadId)).messages.at(-1)!.text).toBe('Mara took the request to claude out of the queue before it started.');
      expect((await fetch(`${h.base}/api/runs/queue/cancel`, json({ id: two.id }))).status).toBe(404);

      // A slot frees on B: E goes, since A is still busy with its own run.
      const onB = view.running.find((r) => r.fileId === b)!;
      await fetch(`${h.base}/api/runs/${onB.runId}/stop`, { method: 'POST' });
      await until(async () => (await threadOf(e, late.threadId)).messages.at(-1)!.author === 'codex', 8000);
      expect((await queue()).queued.map((q) => q.id)).toEqual([one.id]);

      // Then A's run ends, and its first comment starts.
      for (const r of (await queue()).running) await fetch(`${h.base}/api/runs/${r.runId}/stop`, { method: 'POST' });
      await until(async () => (await threadOf(a, first.threadId)).messages.at(-1)!.author === 'claude', 8000);
      await until(() => h.server.runs.count() === 0, 8000);
      view = await queue();
      expect(view.running).toEqual([]);
      expect(view.queued).toEqual([]);
    }, 30_000);

    it('refuses to move what is not waiting', async () => {
      expect((await fetch(`${h.base}/api/runs/queue/move`, json({ id: 'nothing', to: 0 }))).status).toBe(404);
    });
  });

  describe('what a run changed', () => {
    it('names the layers it changed, and keeps a small picture from before and after', async () => {
      const { doc } = await h.server.rooms.get(file);
      const title = doc.insert(board, { type: 'text', name: 'Title', tag: 'h1', text: 'Sommerfest', style: { fontSize: '24px', color: '#111111' } });
      const tools = [
        { name: 'layer_style', args: { node_ids: [title], style: { fontSize: '40px' } } },
        { name: 'layer_rename', args: { node_id: title, name: 'Big title' } },
      ];
      const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: `make the title bigger ${fake({ tools })}`, runner: 'claude' }));
      const { runId } = await res.json() as { runId: string };
      await idle();
      await until(async () => Boolean((await h.server.history.get(file, runId))?.shots), 15_000);
      const summary = await (await fetch(`${h.base}/api/runs/${runId}/summary?fileId=${file}`)).json() as any;
      expect(summary.layers).toEqual([{ id: title, name: 'Big title' }]);
      expect(summary.shots).toEqual({ nodeId: board, before: true, after: true });
      for (const which of ['before', 'after']) {
        const shot = await fetch(`${h.base}/api/runs/${runId}/shot?fileId=${file}&which=${which}`);
        expect(shot.status).toBe(200);
        expect(shot.headers.get('content-type')).toBe('image/webp');
        expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(100);
      }
      const shots = await Promise.all(['before', 'after'].map(async (w) => Buffer.from(await (await fetch(`${h.base}/api/runs/${runId}/shot?fileId=${file}&which=${w}`)).arrayBuffer())));
      expect(shots[0]!.equals(shots[1]!)).toBe(false);
      // The pictures come from the browser after the run ends; the waits above allow for a busy machine, so the test does too.
    }, 30_000);

    it('names the layers without pictures when nothing visible changed', async () => {
      const { doc } = await h.server.rooms.get(file);
      const note = doc.insert(board, { type: 'text', name: 'Hidden note', tag: 'p', text: 'x', hidden: true, style: {} });
      const tools = [{ name: 'layer_text', args: { node_id: note, text: 'still hidden' } }];
      const { runId } = await (await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: `write the note ${fake({ tools })}`, runner: 'codex' }))).json() as { runId: string };
      await idle();
      await until(async () => Boolean((await h.server.history.get(file, runId))?.named), 15_000);
      await new Promise((r) => setTimeout(r, 1500));
      const summary = await (await fetch(`${h.base}/api/runs/${runId}/summary?fileId=${file}`)).json() as any;
      expect(summary.layers).toEqual([{ id: note, name: 'Hidden note' }]);
      expect(summary.shots).toBeUndefined();
      expect((await fetch(`${h.base}/api/runs/${runId}/shot?fileId=${file}&which=after`)).status).toBe(404);
    }, 30_000);
  });

  describe('undo this run', () => {
    it('takes back everything one run changed as one step, and leaves what others did and the thread alone', async () => {
      const room = await h.server.rooms.get(file);
      const { doc } = room;
      doc.updateStyle(board, { padding: '8px', background: '#ffffff', color: '#111111' }, 'person:Mara');
      const tools = [
        { name: 'layer_style', args: { node_ids: [board], style: { padding: '40px', background: '#000000' } } },
        { name: 'artboard_create', args: { name: 'Extra', width: 100, height: 100 } },
      ];
      const { threadId } = await comment({ nodeId: board, text: `@claude make it dark ${fake({ tools, thread: 'resolve', reply: 'Made it dark.' })}` });
      await idle();
      const record = (await (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as any[]).find((r) => r.threadId === threadId);
      expect(record.status).toBe('done');
      const extra = doc.getChildren(page).find((n) => n.name === 'Extra')!;
      expect(extra).toBeTruthy();
      // Someone changes the padding again after the run, and the colour, which the run did not touch.
      doc.updateStyle(board, { padding: '50px', color: '#222222' }, 'person:Ana');
      const before = doc.getComments().find((t) => t.id === threadId)!;
      // The stand-in tried comment_resolve after its reply, as agents used to: refused, and the thread stays open.
      expect(before.resolved).toBe(false);

      const res = await fetch(`${h.base}/api/runs/${record.id}/undo`, json({ fileId: file, who: 'Mara' }));
      expect(res.status).toBe(200);
      const answer = await res.json() as any;
      expect(answer.clean).toBe(false);
      expect(answer.conflicts.map((c: any) => c.field)).toEqual(['style.padding']);
      const node = doc.getNode(board)!;
      expect(node.style.background).toBe('#ffffff');
      expect(node.style.padding).toBe('50px');
      expect(node.style.color).toBe('#222222');
      expect(doc.getNode(extra.id)).toBeUndefined();
      // The conversation stays as it was.
      const after = doc.getComments().find((t) => t.id === threadId)!;
      expect(after.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
      expect(after.resolved).toBe(false);

      // One change in History, a revert of the run's own entries.
      const timeline = await h.server.timeline.all(file);
      const undo = timeline.at(-1)!;
      expect(undo.actor).toBe('Mara');
      // The reply is the run's too, but it is what was said: it is left out.
      const ofRun = timeline.filter((e) => e.run === record.id);
      expect(ofRun.length).toBe(3);
      expect(undo.revertOf!.sort()).toEqual(ofRun.filter((e) => e.ops!.some((op) => op.p[0] !== 'comments')).map((e) => e.id).sort());
      const again = (await (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as any[]).find((r) => r.id === record.id);
      expect(again.undone.by).toBe('Mara');
      const twice = await fetch(`${h.base}/api/runs/${record.id}/undo`, json({ fileId: file, who: 'Mara' }));
      expect(twice.status).toBe(409);
      expect((await twice.json() as any).error).toBe('Mara already took this run back.');
    });

    it('refuses a run that is still going, or that changed nothing', async () => {
      const going = await comment({ nodeId: board, text: `@claude wait ${fake({ hang: true })}` });
      await until(() => Boolean(h.server.commentRuns.list(file)[0]?.runId));
      const runId = h.server.commentRuns.list(file)[0]!.runId!;
      await until(async () => Boolean(await h.server.history.get(file, runId)));
      expect((await fetch(`${h.base}/api/runs/${runId}/undo`, json({ fileId: file }))).status).toBe(409);
      await fetch(`${h.base}/api/runs/${runId}/stop`, { method: 'POST' });
      await idle();
      const nothing = await fetch(`${h.base}/api/runs/${runId}/undo`, json({ fileId: file }));
      expect(nothing.status).toBe(404);
      expect((await nothing.json() as any).error).toBe('This run changed nothing that can be taken back.');
      expect(going.started).toEqual(['claude']);
    });
  });

  describe('assets for comments', () => {
    it('takes PDF and text files as assets, with their own types', async () => {
      const md = await upload(Buffer.from('hello'), 'text/markdown');
      expect(md.src).toMatch(/\.md$/);
      const served = await fetch(`${h.base}/assets/${md.src.slice('bogen-asset:'.length)}`);
      expect(served.headers.get('content-type')).toBe('text/markdown');
      expect(served.headers.get('content-security-policy')).toContain('sandbox');
      expect((await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<script></script>' })).status).toBe(415);
    });
  });
});
