import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BogenDoc, inferIntent, type CommentMessage } from '@bogen/core';
import { buildCommand } from '../src/agents.ts';
import { cleanTarget, CommentRuns, threadPrompt } from '../src/comment-runs.ts';
import { ReplyTargets } from '../src/reply-targets.ts';
import { asksForChange } from '../src/run-guard.ts';
import { effectiveRequest, isAgentMessage, requestTitle, requestWords } from '../src/thread-request.ts';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { startServer, until, withoutDesignReview, type Harness } from './helpers.ts';

// Generic fixtures only: a product called "Lumen", a page called "Landing".
let n = 0;
const msg = (author: string, text: string, extra: Partial<CommentMessage> = {}): CommentMessage => ({ id: `m${++n}`, author, text, at: n, ...extra });

describe('the request behind a bare mention', () => {
  it('reads criticism written just before a bare @mention as the request, without replaying what an agent answered', () => {
    const thread = {
      messages: [
        msg('Alex', '@claude write the hero copy for Lumen'),
        msg('claude', 'I wrote a first version. What does Lumen do exactly?'),
        msg('Alex', 'the description of Lumen makes no sense and generally this is not good enough'),
        msg('Alex', '@claude'),
      ],
    };
    const asked = thread.messages.at(-1)!.id;
    const req = effectiveRequest(thread, asked);
    expect(req.kind).toBe('carried');
    expect(req.from.map((m) => m.text)).toEqual(['the description of Lumen makes no sense and generally this is not good enough']);
    // The old request, answered by the agent, is not part of it.
    expect(req.text).not.toContain('write the hero copy');
    const title = requestTitle(req);
    expect(title).toBe('the description of Lumen makes no sense and generally this is not good enough');
    // The classifiers see the request, not "@claude": it asks for a change and is an edit, not a new page.
    expect(asksForChange(title)).toBe(true);
    expect(asksForChange('@claude')).toBe(false);
    expect(inferIntent(title)).toBe('edit');
  });

  it('keeps an explicit request in the message itself authoritative', () => {
    const thread = { messages: [msg('Alex', 'this is all wrong'), msg('claude', 'Which part?'), msg('Alex', 'not good'), msg('Alex', '@claude make the heading two lines shorter')] };
    const req = effectiveRequest(thread, thread.messages.at(-1)!.id);
    expect(req).toMatchObject({ kind: 'message', text: '@claude make the heading two lines shorter', from: [] });
  });

  it('answers a genuine information question as asked, and leaves it a question', () => {
    const thread = { messages: [msg('Alex', 'nice'), msg('Alex', '@claude which font does the Landing heading use?')] };
    const req = effectiveRequest(thread, thread.messages.at(-1)!.id);
    expect(req.kind).toBe('message');
    expect(asksForChange(requestTitle(req))).toBe(false);
  });

  it('says nothing is open when the last word was an agent reply, rather than redoing an answered request', () => {
    const thread = { messages: [msg('Alex', '@claude make it blue'), msg('claude', 'Made it blue.'), msg('Alex', '@claude bitte')] };
    const req = effectiveRequest(thread, thread.messages.at(-1)!.id);
    expect(req.kind).toBe('none');
    expect(requestWords('@claude bitte ?')).toBe('');
  });

  it('collects adjacent human turns from aliases and skips server notes, but never takes agent text as the request', () => {
    const thread = {
      messages: [
        msg('codex', 'Done, it is green now.'),
        msg('Alex (phone)', 'too green'),
        msg('Bogen', 'claude stopped with an error: boom', { by: 'system' }),
        msg('alex', 'and the button text is cut off'),
        msg('Alex', '@claude'),
      ],
    };
    const req = effectiveRequest(thread, thread.messages.at(-1)!.id);
    expect(req.from.map((m) => m.author)).toEqual(['Alex (phone)', 'alex']);
    // An agent connected under its own name, or marked as an agent, ends the search like claude does.
    expect(isAgentMessage({ author: 'claude-code' })).toBe(true);
    expect(isAgentMessage({ author: 'Helper', by: 'agent' })).toBe(true);
    expect(isAgentMessage({ author: 'Claudia' })).toBe(false);
    const marked = { messages: [msg('Alex', 'old ask'), msg('Helper', 'answer', { by: 'agent' }), msg('Alex', '@codex')] };
    expect(effectiveRequest(marked, marked.messages.at(-1)!.id).kind).toBe('none');
  });

  it('treats files sent with a bare mention as the subject, with what was written before them', () => {
    const file = { src: 'bogen-asset:' + 'a'.repeat(64) + '.png', name: 'Ref' };
    const only = { messages: [msg('Alex', '@claude', { attachments: [file] })] };
    expect(effectiveRequest(only, only.messages[0]!.id).kind).toBe('files');
    const after = { messages: [msg('Alex', 'use this photo in the Landing hero'), msg('Alex', '@claude', { attachments: [file] })] };
    expect(effectiveRequest(after, after.messages.at(-1)!.id)).toMatchObject({ kind: 'carried', text: 'use this photo in the Landing hero' });
  });

  it('keeps a human request that an older run\'s progress reply landed after, and still never replays an answered one', () => {
    const ask = msg('Alex', '@claude build the Lumen pricing section');
    const thread = {
      messages: [
        ask,
        msg('Alex', 'the Lumen description makes no sense'),
        // Progress from the run that the first message started, arriving after the criticism.
        msg('claude', 'Working on the pricing section now.', { by: 'agent', answers: ask.id }),
        msg('Alex', '@claude'),
      ],
    };
    const req = effectiveRequest(thread, thread.messages.at(-1)!.id);
    expect(req).toMatchObject({ kind: 'carried', text: 'the Lumen description makes no sense' });
    // The answered request itself is not carried again.
    expect(req.text).not.toContain('pricing section');
    // A reply without the mark (from before it existed, or an outside agent) is taken to answer everything before it.
    const legacy = { messages: [thread.messages[0]!, thread.messages[1]!, msg('claude', 'Working on it.'), msg('Alex', '@claude')] };
    expect(effectiveRequest(legacy, legacy.messages.at(-1)!.id).kind).toBe('none');
  });

  it('skips a request whose own run still waits or works, and repeats one whose run failed without an answer', () => {
    const ask = msg('Alex', '@claude make the Landing hero darker');
    const thread = { messages: [ask, msg('Alex', 'and the logo is too small'), msg('Alex', '@claude')] };
    const asked = thread.messages.at(-1)!.id;
    expect(effectiveRequest(thread, asked, new Set([ask.id])).from.map((m) => m.text)).toEqual(['and the logo is too small']);
    const failed = { messages: [ask, msg('Bogen', 'claude stopped with an error: boom', { by: 'system' }), msg('Alex', '@claude')] };
    expect(effectiveRequest(failed, failed.messages.at(-1)!.id)).toMatchObject({ kind: 'carried', text: '@claude make the Landing hero darker' });
  });

  it('puts the carried request in the prompt under the bare mention, and leaves the stored thread as it was', () => {
    const doc = new BogenDoc();
    doc.ensureFirstPage();
    const pageId = doc.getPages()[0]!.id;
    const id = doc.addThread({ pageId, x: 0, y: 0, author: 'Alex', text: '@claude draft the Landing page' });
    doc.replyThread(id, 'claude', 'Drafted it.', undefined, undefined, 'agent');
    doc.replyThread(id, 'Alex', 'the Lumen description is wrong');
    doc.replyThread(id, 'Alex', '@claude');
    const thread = doc.getComments()[0]!;
    const prompt = threadPrompt(doc, id, thread.messages.at(-1)!.id);
    expect(prompt).toContain('The message to answer, from Alex: @claude');
    expect(prompt).toContain('Answer this as the request:\nAlex: the Lumen description is wrong');
    expect(doc.getComments()[0]!.messages.map((m) => m.text)).toEqual(['@claude draft the Landing page', 'Drafted it.', 'the Lumen description is wrong', '@claude']);
    expect(doc.getComments()[0]!.messages[1]!.by).toBe('agent');
  });
});

describe('where an agent looks before it asks', () => {
  const req = { fileId: 'f1', fileName: 'Landing', prompt: 'x', runner: 'claude' as const };
  const system = (extra: Record<string, unknown>) => {
    const cmd = buildCommand('claude', { ...req, ...extra }, { url: 'http://127.0.0.1:1/mcp' }, '/tmp/c.json', '/tmp');
    return cmd.args[cmd.args.indexOf('--append-system-prompt') + 1]!;
  };

  it('tells comment and prompt runs to read related files and brands, never to invent product facts, and to ask one specific question', () => {
    for (const text of [system({ threadId: 't1' }), system({})]) {
      expect(text).toContain('file_list and brand_list');
      expect(text).toContain('by file_id rather than with file_open');
      expect(text).toContain('Never invent product descriptions, claims, URLs or screenshots of a product');
      expect(text).toContain('ask one specific question');
      expect(text).toContain('There is no shell');
      expect(text).not.toContain('comment_resolve');
    }
    // Pure questions stay answers without changes.
    expect(system({ threadId: 't1' })).toContain('Only a question that asks for information, such as "which font is this?", gets an answer without changes.');
  });

  it('keeps only valid targets from stored history', () => {
    expect(cleanTarget({ runner: 'claude', model: 'opus', effort: 'high', at: 5 })).toEqual({ runner: 'claude', model: 'opus', effort: 'high', at: 5 });
    expect(cleanTarget({ runner: 'claude' })).toEqual({ runner: 'claude', model: 'default', effort: 'default', at: 0 });
    expect(cleanTarget({ runner: 'sh', model: 'opus' })).toBeUndefined();
    expect(cleanTarget({ runner: 'codex', model: '--yolo; rm -rf', effort: 'insane' })).toEqual({ runner: 'codex', model: 'default', effort: 'default', at: 0 });
  });

  it('takes a stored target over a run in the history that started after it, which a queued request does', async () => {
    // claude was asked first and waited in the queue; codex was asked while it waited; claude's run started after that.
    const addressed = async () => new Map<string, unknown>([['t1', { runner: 'claude', model: 'opus', at: 300 }], ['t2', { runner: 'claude', at: 50 }]]);
    const store = { load: async () => ({ t1: { runner: 'codex', model: 'default', effort: 'medium', at: 200 } }), save: async () => {} };
    const runs = new CommentRuns({ addressed, store } as unknown as ConstructorParameters<typeof CommentRuns>[0]);
    const targets = await runs.targetsOf('f1');
    expect(targets.t1).toEqual({ runner: 'codex', model: 'default', effort: 'medium', at: 200 });
    // A thread from before targets were stored still follows its newest run.
    expect(targets.t2).toMatchObject({ runner: 'claude', at: 50 });
  });
});

describe('replies follow the thread, with stand-in CLIs', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-routing-bin-'));
  const log = join(bin, 'calls.jsonl');
  const savedPath = process.env.PATH;
  const home = mkdtempSync(join(tmpdir(), 'bogen-routing-home-'));
  let h: Harness;
  let file: string;
  let page: string;
  let board: string;
  // A run that changes a layer and answers in the thread, so that it is not asked once more.
  const work = (reply = 'Done.') => fake({ tools: [{ name: 'layer_style', args: { node_ids: [board], style: { padding: `${++n}px` } } }], thread: 'reply', reply });
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  type Call = { runner: string; args: string[]; text: string; images: { mime?: string; via: string }[] };
  const calls = () => fakeLog(log).filter((c) => c.kind === 'call') as unknown as Call[];
  const idle = () => until(() => !h.server.runs.activeFor(file) && !h.server.commentRuns.list(file).length, 8000);
  type Sent = { threadId: string; started: string[]; refused?: string; target?: { runner: string; model: string; effort: string; how: string } };
  const send = async (body: Record<string, unknown>): Promise<Sent> => {
    const res = await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Alex', pageId: page, ...body }));
    expect(res.status).toBe(201);
    return (await res.json()) as Sent;
  };
  const targets = async () => (await (await fetch(`${h.base}/api/comments/targets?fileId=${file}`)).json()) as Record<string, { runner: string; model: string; effort: string }>;
  const flag = (c: Call, name: 'model' | 'effort') => {
    if (c.runner === 'claude') {
      const i = c.args.indexOf(name === 'model' ? '--model' : '--effort');
      return i < 0 ? undefined : c.args[i + 1];
    }
    if (name === 'model') {
      const i = c.args.indexOf('-m');
      return i < 0 ? undefined : c.args[i + 1];
    }
    return /model_reasoning_effort="(\w+)"/.exec(c.args.join(' '))?.[1];
  };
  const threadOf = async (id: string) => (await h.server.rooms.get(file)).doc.getComments().find((t) => t.id === id)!;
  const stopAll = async () => {
    for (const r of h.server.commentRuns.list(file)) await h.server.commentRuns.cancel(r.queueId!, 'Alex');
    await idle();
  };

  beforeAll(async () => {
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer({}, home);
    withoutDesignReview(h.server);
  });

  // A file of its own for each case, so that the per-file limits of one never touch the next.
  beforeEach(async () => {
    rmSync(log, { force: true });
    file = ((await (await fetch(`${h.base}/api/files`, json({ name: 'Routing' }))).json()) as { id: string }).id;
    const room = await h.server.rooms.get(file);
    page = room.doc.getPages()[0]!.id;
    board = room.doc.insert(page, { type: 'frame', name: 'Landing', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '400px', height: '200px' } });
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  it('sends a reply without a mention to the agent, model and effort of the last request, and keeps the thread open', async () => {
    const first = await send({ text: `@claude write the Lumen headline ${work('Wrote it.')}`, model: 'opus', effort: 'high' });
    expect(first.target).toMatchObject({ runner: 'claude', model: 'opus', effort: 'high', how: 'mention' });
    await idle();
    const reply = await send({ threadId: first.threadId, text: `shorter please ${work('Shortened.')}` });
    expect(reply.started).toEqual(['claude']);
    expect(reply.target).toMatchObject({ runner: 'claude', model: 'opus', effort: 'high', how: 'inherited' });
    await idle();
    const [a, b] = calls();
    expect([flag(a!, 'model'), flag(a!, 'effort')]).toEqual(['opus', 'high']);
    expect([b!.runner, flag(b!, 'model'), flag(b!, 'effort')]).toEqual(['claude', 'opus', 'high']);
    // The run answered the reply itself, and saw the whole conversation.
    expect(b!.text).toContain('The message to answer, from Alex: shorter please');
    expect(b!.text).toContain('claude: Wrote it.');
    const thread = await threadOf(first.threadId);
    expect(thread.resolved).toBe(false);
    // Exactly one run per send: the agent's own replies started nothing.
    expect(calls().length).toBe(2);
    // Each agent reply says which request it answered.
    const replies = thread.messages.filter((m) => m.author === 'claude');
    expect(replies.map((m) => m.by)).toEqual(['agent', 'agent']);
    expect(replies.map((m) => thread.messages.find((x) => x.id === m.answers)?.text.split(' FAKE')[0])).toEqual(['@claude write the Lumen headline', 'shorter please']);
  }, 20_000);

  it('a bare mention of the same agent keeps the thread model, and an explicit model or agent overrides it', async () => {
    const first = await send({ text: `@claude Lumen hero ${work()}`, model: 'opus', effort: 'high' });
    await idle();
    // Bare mention: no drop to the cheap comment default.
    const bare = await send({ threadId: first.threadId, text: '@claude' });
    expect(bare.target).toMatchObject({ runner: 'claude', model: 'opus', effort: 'high', how: 'mention' });
    await idle();
    // An explicit choice in the composer wins, and the next reply follows it.
    const chosen = await send({ threadId: first.threadId, text: 'try once more', to: 'claude', model: 'sonnet' });
    expect(chosen.target).toMatchObject({ runner: 'claude', model: 'sonnet', effort: 'high', how: 'chosen' });
    await idle();
    const next = await send({ threadId: first.threadId, text: 'and the subline' });
    expect(next.target).toMatchObject({ runner: 'claude', model: 'sonnet', effort: 'high', how: 'inherited' });
    await idle();
    // Another agent named in the text takes over with its own settings, not Claude's model.
    const other = await send({ threadId: first.threadId, text: '@codex your take' });
    expect(other.target).toMatchObject({ runner: 'codex', how: 'mention' });
    expect(other.target!.model).not.toBe('sonnet');
    await idle();
    const after = await send({ threadId: first.threadId, text: 'once more with feeling' });
    expect(after.target?.runner).toBe('codex');
    await idle();
    expect(calls().map((c) => [c.runner, flag(c, 'model')])).toEqual([['claude', 'opus'], ['claude', 'opus'], ['claude', 'sonnet'], ['claude', 'sonnet'], ['codex', 'small'], ['codex', 'small']]);
  }, 30_000);

  it('keeps plain comments plain: comment only, new threads and threads no agent was asked in', async () => {
    const plain = await send({ text: 'just a note for later' });
    expect(plain.started).toEqual([]);
    const reply = await send({ threadId: plain.threadId, text: 'agreed' });
    expect(reply.started).toEqual([]);
    expect(reply.refused).toBeUndefined();
    const asked = await send({ text: `@claude Lumen pricing card ${work()}` });
    await idle();
    const commentOnly = await send({ threadId: asked.threadId, text: 'note to self, not for the agent', to: 'comment' });
    expect(commentOnly.started).toEqual([]);
    expect(commentOnly.target).toBeUndefined();
    expect(calls().length).toBe(1);
    // Comment only is a choice for one message: the thread still goes to claude next time.
    const all = await targets();
    expect(all[asked.threadId]?.runner).toBe('claude');
    expect(all[plain.threadId]).toBeUndefined();
  }, 20_000);

  it('starts nothing from elsewhere: another device, a client thread, or a malformed choice', async () => {
    const asked = await send({ text: `@claude Lumen footer ${work()}` });
    await idle();
    const before = calls().length;
    // Not the person on this device: an inherited reply stays a comment, without a refusal; a named agent is refused.
    const away = await h.server.commentRuns.submit({ fileId: file, author: 'Teammate', threadId: asked.threadId, text: 'looks fine' }, false);
    expect(away.started).toEqual([]);
    expect(away.refused).toBeUndefined();
    const named = await h.server.commentRuns.submit({ fileId: file, author: 'Teammate', threadId: asked.threadId, text: '@claude go' }, false);
    expect(named.refused).toMatch(/only start for a person/);
    const chosenAway = await h.server.commentRuns.submit({ fileId: file, author: 'Teammate', threadId: asked.threadId, text: 'go', to: 'codex' }, false);
    expect(chosenAway.refused).toMatch(/only start for a person/);
    // A client's thread never starts an agent, also when one is chosen.
    const room = await h.server.rooms.get(file);
    const clientThread = room.doc.addThread({ pageId: page, x: 0, y: 0, author: 'Client', text: 'please change everything', client: true });
    const clientReply = await send({ threadId: clientThread, text: 'ok', to: 'claude' });
    expect(clientReply.started).toEqual([]);
    expect(clientReply.refused).toMatch(/client never starts/);
    // Malformed choices are refused at the door, before anything is written.
    const count = (await threadOf(asked.threadId)).messages.length;
    for (const bad of [{ to: 'sh' }, { model: 'opus; rm -rf ~' }, { effort: 'unbounded' }, { to: 'claude', model: 'x'.repeat(200) }]) {
      const res = await fetch(`${h.base}/api/comments`, json({ fileId: file, author: 'Alex', threadId: asked.threadId, text: 'x', ...bad }));
      expect(res.status).toBe(400);
    }
    expect((await threadOf(asked.threadId)).messages.length).toBe(count);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls().length).toBe(before);
    // Nothing the doc says moves the target: a forged mark on a message is not where replies go.
    room.doc.replyThread(asked.threadId, 'Peer', 'hi', 'peer', undefined, 'agent', 'nonsense');
    expect((await targets())[asked.threadId]).toMatchObject({ runner: 'claude' });
  }, 20_000);

  it('during a run, a reply follows the agent last named, not the one whose progress is in the thread', async () => {
    const first = await send({ text: `@claude Lumen nav ${fake({ tools: [{ name: 'comment_reply', args: { thread_id: '$thread', text: 'Working on the nav.' } }], hang: true })}` });
    await until(async () => (await threadOf(first.threadId)).messages.some((m) => m.author === 'claude'));
    const codex = await send({ threadId: first.threadId, text: '@codex you do the footer instead' });
    expect(codex.target?.runner).toBe('codex');
    const plain = await send({ threadId: first.threadId, text: 'and keep it short' });
    expect(plain.target).toMatchObject({ runner: 'codex', how: 'inherited' });
    // One running, two waiting: one run per send, not every earlier turn again.
    expect(h.server.commentRuns.list(file).map((r) => [r.runner, r.status])).toEqual([['claude', 'working'], ['codex', 'queued'], ['codex', 'queued']]);
    expect((await targets())[first.threadId]?.runner).toBe('codex');
    await stopAll();
  }, 20_000);

  it('runs a bare mention after criticism on the criticism, with the files that came with it, also when progress arrived in between', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
    const asset = (await (await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json()) as { src: string };
    // An older run is still going and reports progress after the person has written their criticism.
    const first = await send({ text: `@claude Lumen intro ${fake({ tools: [{ name: 'comment_reply', args: { thread_id: '$thread', text: 'Still on the intro.' } }], delayMs: 400, hang: true })}` });
    await until(() => h.server.commentRuns.list(file)[0]?.status === 'working');
    // This time the stand-in only talks, as the run in the finding did.
    const criticism = `the Lumen description makes no sense, not good enough ${fake({ thread: 'reply', reply: 'What does Lumen do?' })}`;
    await send({ threadId: first.threadId, text: criticism, to: 'comment', attachments: [{ src: asset.src, name: 'reference.png', width: 1, height: 1 }] });
    await until(async () => (await threadOf(first.threadId)).messages.some((m) => m.text === 'Still on the intro.'));
    await send({ threadId: first.threadId, text: '@claude' });
    // The older run ends; the bare mention runs next.
    for (const r of h.server.commentRuns.list(file)) if (r.status === 'working') await h.server.commentRuns.cancel(r.queueId!, 'Alex');
    await idle();
    const call = calls().at(-1)!;
    expect(call.text).toContain(`Answer this as the request:\nAlex: ${criticism} (its files come with this request)`);
    // The picture attached to the criticism reached the CLI as an image, not just as words.
    expect(call.images).toEqual([expect.objectContaining({ via: 'stream', mime: 'image/png' })]);
    const records = await (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as { threadId?: string; title?: string; nudged?: boolean }[];
    const latest = records.find((r) => r.threadId === first.threadId)!;
    expect(latest.title).toBe(criticism);
    // It changed nothing, so the request (not "@claude") was read as asking for a change, and it was asked once more.
    expect(latest.nudged).toBe(true);
    const texts = (await threadOf(first.threadId)).messages.map((m) => m.text);
    expect(texts.indexOf('Still on the intro.')).toBeGreaterThan(texts.indexOf(criticism));
    expect(texts.at(texts.indexOf('Still on the intro.') + 1)).toBe('@claude');
    expect((await threadOf(first.threadId)).resolved).toBe(false);
  }, 30_000);

  it('keeps the last addressed target through a restart, also when its request was still waiting', async () => {
    const first = await send({ text: `@claude Lumen card ${fake({ hang: true })}`, model: 'opus' });
    await until(() => h.server.commentRuns.list(file)[0]?.status === 'working');
    // Addressed but never started: only the waiting queue and the stored target know it.
    const waiting = await send({ threadId: first.threadId, text: '@codex the card footer', effort: 'medium' });
    expect(waiting.target).toMatchObject({ runner: 'codex', effort: 'medium' });
    const stored = await new ReplyTargets(home).load(file);
    expect(stored[first.threadId]).toMatchObject({ runner: 'codex', effort: 'medium' });
    // The server goes away with the queue, and comes back on the same home.
    await h.server.close();
    h = await startServer({}, home);
    withoutDesignReview(h.server);
    expect(h.server.commentRuns.list(file)).toEqual([]);
    expect((await targets())[first.threadId]).toMatchObject({ runner: 'codex', effort: 'medium' });
    const reply = await send({ threadId: first.threadId, text: `the footer, please ${work()}` });
    expect(reply.target).toMatchObject({ runner: 'codex', effort: 'medium', how: 'inherited' });
    await idle();
    expect(calls().at(-1)!.runner).toBe('codex');
    expect(flag(calls().at(-1)!, 'effort')).toBe('medium');
  }, 30_000);

  it('falls back to the run history for threads from before targets were stored', async () => {
    const first = await send({ text: `@codex Lumen badge ${work()}`, effort: 'low' });
    await idle();
    await h.server.replyTargets.forget(file);
    (h.server.commentRuns as unknown as { targets: Map<string, unknown> }).targets.clear();
    expect((await targets())[first.threadId]).toMatchObject({ runner: 'codex', effort: 'low' });
  }, 20_000);
});
