import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BogenDoc, type BogenNode } from '@bogen/core';
import { buildCommand, type RunRequest } from '../src/agents.ts';
import { threadPrompt, type EarlierRun } from '../src/comment-runs.ts';
import { Conversations, transcript, type Turn } from '../src/conversations.ts';
import { EventHub } from '../src/events.ts';
import { copyIssues } from '../src/mcp/copy-check.ts';
import { asksForChange, needsNudge, NUDGE, nudgePrompt } from '../src/run-guard.ts';

const turn = (i: number, extra: Partial<Turn> = {}): Turn => ({ runId: `r${i}`, at: i, runner: i % 2 ? 'codex' : 'claude', message: `Message ${i}`, reply: `Reply ${i}`, layers: [`n${i}`], status: 'done', ...extra });

describe('the transcript of a conversation', () => {
  it('keeps the newest turns, oldest first, and counts the ones it leaves out', () => {
    const text = transcript(Array.from({ length: 12 }, (_, i) => turn(i)));
    expect(text).toMatch(/^Earlier in this conversation, oldest first \(4 older turns left out\):/);
    expect(text).not.toContain('Message 3\n');
    expect(text.indexOf('Message 4')).toBeLessThan(text.indexOf('Message 11'));
    expect(text).toContain('The person: Message 11\ncodex answered: Reply 11\nLayers it created or changed: n11');
    expect(text).toMatch(/Read them again before you rely on an id\.$/);
  });

  it('stays under its character cap, cuts long messages and layer lists, and leaves out what is still running', () => {
    const long = 'word '.repeat(2000);
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => turn(i, { message: long, reply: long })),
      turn(6, { layers: Array.from({ length: 30 }, (_, i) => `l${i}`) }),
      turn(7, { status: 'stopped', reply: undefined }),
      turn(8, { status: 'running' }),
    ];
    const text = transcript(turns);
    expect(text.length).toBeLessThan(6000 + 400);
    expect(text).toContain('…');
    expect(text).toContain('l23 and 6 more');
    expect(text).toContain('codex answered (stopped): (nothing)');
    expect(text).not.toContain('Message 8');
    expect(transcript([])).toBe('');
  });
});

describe('the conversation store', () => {
  const home = mkdtempSync(join(tmpdir(), 'bogen-chat-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const req = (prompt: string, runner: 'claude' | 'codex', extra: Partial<RunRequest> = {}): RunRequest => ({ fileId: 'file1', fileName: 'F', prompt, runner, conversationId: 'c1', ...extra });

  it('records turns with what was said and touched, and hands them to the next run, across a restart', async () => {
    const hub = new EventHub();
    const store = new Conversations(home, hub);
    store.started('run1', req('Draw a hero', 'claude'));
    hub.broadcast({ t: 'activity', fileId: 'file1', agent: 'claude', tool: 'html_write', nodeIds: ['a', 'b'], at: 1, runId: 'run1' });
    // Talking in a thread is not a change to the design.
    hub.broadcast({ t: 'activity', fileId: 'file1', agent: 'claude', tool: 'comment_add', nodeIds: ['c'], at: 2, runId: 'run1' });
    store.event('run1', { kind: 'text', text: 'Thinking.' });
    store.event('run1', { kind: 'text', text: 'Made the hero.' });
    store.ended({ runId: 'run1', fileId: 'file1', runner: 'claude', status: 'done' });
    // A run in no conversation, and one in a thread, are not turns.
    store.started('run2', req('Elsewhere', 'claude', { conversationId: undefined }));
    store.started('run3', req('In a thread', 'claude', { threadId: 't1' }));
    store.started('run4', req('Still going', 'codex'));
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.get('file1', 'c1'))!.turns.map((t) => [t.message, t.reply, t.layers, t.status])).toEqual([
      ['Draw a hero', 'Made the hero.', ['a', 'b'], 'done'],
      ['Still going', undefined, [], 'running'],
    ]);
    await store.close();

    const reopened = new Conversations(home, new EventHub());
    const turns = (await reopened.get('file1', 'c1'))!.turns;
    expect(turns.map((t) => t.status)).toEqual(['done', 'interrupted']);
    const next = await reopened.prepare(req('Make it bigger', 'codex'));
    expect(next.context).toContain('The person: Draw a hero\nclaude answered: Made the hero.\nLayers it created or changed: a, b');
    expect(next.context).toContain('codex answered (cut off): (nothing)');
    expect(next.prompt).toBe('Make it bigger');
    expect((await reopened.prepare(req('New', 'claude', { conversationId: 'other' }))).context).toBeUndefined();
    // The file's chats as a list, named by what was said first, the one talked in last first.
    reopened.started('run5', req('Another   chat\nabout the footer', 'codex', { conversationId: 'c2' }));
    await new Promise((r) => setTimeout(r, 20));
    const list = await reopened.list('file1');
    expect(list.map((c) => [c.id, c.title, c.turns, c.runners, c.running])).toEqual([
      ['c2', 'Another chat about the footer', 1, ['codex'], true],
      ['c1', 'Draw a hero', 2, ['claude', 'codex'], false],
    ]);
    reopened.ended({ runId: 'run5', fileId: 'file1', runner: 'codex', status: 'done' });
    await reopened.forget('file1');
    expect(await new Conversations(home, new EventHub()).get('file1', 'c1')).toBeUndefined();
  });
});

describe('prompt assembly', () => {
  const base: RunRequest = { fileId: 'f', fileName: 'F', prompt: 'Make it bigger', runner: 'claude', context: 'Earlier in this conversation, oldest first:\n\nThe person: Draw a hero' };

  it('puts the transcript ahead of the new message for both runners', () => {
    const claude = buildCommand('claude', base, { url: 'http://x' }, '/tmp/c', '/tmp');
    expect(claude.stdin).toBe("Earlier in this conversation, oldest first:\n\nThe person: Draw a hero\n\nThe person's new message:\nMake it bigger");
    const codex = buildCommand('codex', { ...base, runner: 'codex' }, { url: 'http://x' }, '/tmp/c', '/tmp');
    expect(codex.stdin).toMatch(/Treat the earlier turns as context[^\n]*\n\nEarlier in this conversation[\s\S]*The person's new message:\nMake it bigger$/);
    const images = buildCommand('claude', { ...base, images: [{ data: Buffer.from('x'), mime: 'image/png', name: 'a.png' }] }, { url: 'http://x' }, '/tmp/c', '/tmp');
    expect(JSON.parse(images.stdin).message.content[0].text).toContain("The person's new message:\nMake it bigger");
    expect(buildCommand('claude', { ...base, context: undefined }, { url: 'http://x' }, '/tmp/c', '/tmp').stdin).toBe('Make it bigger');
  });

  it('tells prompt and comment runs to do a request phrased as a question, and to reply plainly after', () => {
    for (const req of [base, { ...base, threadId: 't1' }]) {
      const system = buildCommand('codex', { ...req, runner: 'codex' }, { url: 'http://x' }, '/tmp/c', '/tmp').stdin;
      expect(system).toContain('A request is a request even when it is phrased as a question');
      expect(system).toContain('kannst du das größer machen?');
      expect(system).toContain('No "you\'re right", no praise for the request, no apology, and no promise of later work.');
    }
    expect(buildCommand('claude', { ...base, review: 'critique' }, { url: 'http://x' }, '/tmp/c', '/tmp').args.join(' ')).not.toContain('A request is a request');
  });
});

describe('a comment thread as a request', () => {
  it('says what earlier runs on the thread changed, newest kept', () => {
    const doc = new BogenDoc();
    const pageId = doc.createPage('Page 1');
    const threadId = doc.addThread({ pageId, x: 0, y: 0, author: 'Mara', text: '@codex make it bigger' });
    doc.replyThread(threadId, 'codex', 'Made the heading 48px.');
    doc.replyThread(threadId, 'Mara', '@codex and darker');
    const messageId = doc.getComments()[0]!.messages.at(-1)!.id;
    const earlier: EarlierRun[] = Array.from({ length: 6 }, (_, i) => ({
      runner: i === 5 ? 'codex' : 'claude', status: 'done', startedAt: Date.UTC(2026, 10, 4, 10, i), layers: i === 5 ? ['h1', 'h2'] : [],
      tools: [{ name: 'layer_style', count: 2 }, { name: 'comment_reply', count: 1 }], result: i === 5 ? 'Made the heading 48px.' : undefined, ...(i === 5 ? { nudged: true } : {}),
    }));
    const prompt = threadPrompt(doc, threadId, messageId, earlier);
    expect(prompt).toContain('What agents did on this thread before (the last 4 of 6 runs), oldest first.');
    expect(prompt).toContain('- codex, 2026-11-04 10:05 UTC, done after being asked again to make the change: changed layers h1, h2 (tools: layer_style x2). It ended with: Made the heading 48px.');
    expect(prompt).not.toContain('10:01 UTC');
    expect(prompt.indexOf('What agents did')).toBeLessThan(prompt.indexOf('The message to answer'));
    expect(threadPrompt(doc, threadId, messageId)).not.toContain('What agents did');
  });
});

describe('asked to change, or asked a question', () => {
  // Including the phrasings from the report that started this.
  const changes = [
    'kannst du das größer machen?', 'warum ist das so klein, mach größer', 'can you tighten this?', 'could you make the cards less busy?',
    'mach den Button rot', 'make the headline shorter', '@claude tighten this.', 'Bitte die Abstände vereinheitlichen', 'Der Titel ist zu lang',
    'this should be bold', 'Überschrift größer', 'The hero feels heavy', 'Why is the spacing so tight? Fix it.', "I'd like the logo on the left",
    'Mach mal größer bitte', 'Rebuild as layers: Hero', 'do it', 'Is it possible to make the header sticky?', 'kann man das größer machen?',
    '@codex kannst du den Text kürzer machen?', 'Könntest du die Farbe anpassen?', 'Gib dem Hero mehr Luft', 'Would you mind swapping the two images?',
    'Den Schatten bitte weg', 'Kannst du das größer machen und mir sagen, warum es so klein war?',
    'Antworte auf Deutsch und mach es größer', "Don't make it bigger, make it bolder", 'Nicht so groß bitte',
  ];
  const questions = [
    'what font is this?', 'warum ist das so klein?', 'which colour is the accent?', 'can you tell me which font this is?',
    'Kannst du mir erklären, warum das so gesetzt ist?', 'wie viele Varianten gibt es?', 'is this accessible?', 'thanks!', 'danke, passt so',
    'looks good', 'Was hältst du davon?', 'Should this be bold?', 'Could you explain the spacing?', 'Kannst du mir sagen, welche Farbe das ist?',
    'Do you think the hero should be darker?', 'Super, danke!', 'Welche Schrift ist das?', '@claude', '',
    // From `bogen agents check` with real models: this one was nudged, and cost a second run.
    'Wie lautet der Text auf dem Button? Antworte nur mit dem Text, und ändere nichts.', 'Tell me what the accent colour is.',
    'Ändere nichts, sag mir nur, welche Schrift das ist.', 'Lass es so.', "Don't change anything, just explain the grid.", 'Change nothing. Which font is this?',
  ];
  it.each(changes)('"%s" asks for a change', (text) => expect(asksForChange(text)).toBe(true));
  it.each(questions)('"%s" does not', (text) => expect(asksForChange(text)).toBe(false));

  it('nudges a run that changed nothing, once, and never a critique or a live run', () => {
    const run = { request: 'mach größer', changed: false, nudged: false };
    expect(needsNudge(run)).toBe(true);
    expect(needsNudge({ ...run, changed: true })).toBe(false);
    expect(needsNudge({ ...run, nudged: true })).toBe(false);
    expect(needsNudge({ ...run, review: 'critique' })).toBe(false);
    expect(needsNudge({ ...run, live: true })).toBe(false);
    expect(needsNudge({ ...run, request: 'welche Schrift ist das?' })).toBe(false);
    expect(nudgePrompt('mach größer', "You're right.")).toBe(`mach größer\n\n---\nYou already answered this request once. Your reply was:\nYou're right.\n\n${NUDGE}`);
    expect(nudgePrompt('mach größer', '  ')).toContain('Your reply was:\n(nothing)');
  });
});

describe('the copy check', () => {
  const node = (id: string, text: string, tag = 'p'): BogenNode => ({ id, type: 'text', tag, name: id, text, style: {} }) as unknown as BogenNode;

  it('quotes filler in English and German, and says what to write instead', () => {
    const found = copyIssues([
      node('a', 'Elevate your invoicing with seamless sync.'),
      node('b', 'Unsere nahtlose Lösung bringt dich auf das nächste Level.'),
      node('c', 'Whether you\'re a freelancer or an agency, it works.'),
      node('d', 'Not just a tool, it\'s a partner.'),
      node('e', 'Lorem ipsum dolor sit amet.'),
      node('f', 'Send an invoice in two clicks.'),
    ]);
    const by = (id: string) => found.filter((f) => f.nodeId === id).map((f) => f.quote);
    expect(by('a')).toEqual(['Elevate', 'seamless']);
    expect(by('b')).toEqual(['nahtlose', 'auf das nächste Level']);
    expect(by('c')[0]).toMatch(/^Whether you're a freelancer or/);
    expect(by('d')[0]).toMatch(/^Not just a tool, it's/);
    expect(by('e')[0]).toMatch(/lorem ipsum/i);
    expect(by('f')).toEqual([]);
    expect(found.find((f) => f.quote === 'Elevate')!.message).toMatch(/^The text says "Elevate", which reads as filler\. Say what it does/);
  });

  it('finds exclamation marks, rhetorical headings, empty triplets, emoji glyphs and the brand\'s own avoid words', () => {
    const found = copyIssues([
      node('h', 'Tired of slow invoices?', 'h1'),
      node('q', 'Is this a question in a paragraph?'),
      node('x', 'Get started today!'),
      node('t', 'Fast. Simple. Secure.'),
      node('g', 'Read more ↗'),
      node('c', '© 2026 Tomacco'),
      node('w', 'A cheap plan for teams.'),
    ], [{ word: 'cheap', instead: 'affordable' }]);
    const of = (id: string) => found.filter((f) => f.nodeId === id).map((f) => f.message).join(' ');
    expect(of('h')).toContain('rhetorical question');
    expect(of('q')).toBe('');
    expect(of('x')).toContain('exclamation mark');
    expect(of('t')).toContain('three short claims');
    expect(of('g')).toContain('icon_insert');
    expect(of('c')).toContain('Write "Copyright" instead');
    expect(of('w')).toBe('The text says "cheap", which the brand avoids. Say "affordable".');
  });
});
