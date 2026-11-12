import { describe, expect, it } from 'vitest';
import type { CommentMessage } from '@bogen/core';
import {
  chosenRoute, clearDraft, conversationTitle, draftKey, getDraft, hasDraftText, isUnread, lastPreview, routeLabel, sendFields, setDraft, subscribeDraft, targetLabel, visibleThreads, visibleMessages,
  type ReplyTarget,
} from '../src/panels/conversation-state.ts';

const opus: ReplyTarget = { runner: 'claude', model: 'opus', effort: 'high', at: 1 };
let n = 0;
const m = (author: string, text: string, extra: Partial<CommentMessage> = {}): CommentMessage => ({ id: `m${++n}`, author, text, at: n * 1000, ...extra });

describe('who a reply goes to', () => {
  it('follows the thread\'s last request without a mention, and leaves the choice of model to the server', () => {
    const route = chosenRoute('shorter please', undefined, opus);
    expect(route).toEqual({ kind: 'agent', runner: 'claude', model: 'opus', effort: 'high', how: 'inherited' });
    // Sent through the server, without overriding what it keeps.
    expect(sendFields(route)).toEqual({});
    expect(routeLabel(route)).toBe('Goes to Claude · Opus · High, like the last request here.');
  });

  it('is a plain comment where no agent was asked, and when Comment only is chosen', () => {
    expect(chosenRoute('agreed', undefined, undefined)).toEqual({ kind: 'comment', why: 'no-agent' });
    expect(sendFields(chosenRoute('agreed', undefined, undefined))).toBeNull();
    const only = chosenRoute('note to self', { to: 'comment' }, opus);
    expect(only).toEqual({ kind: 'comment', why: 'chosen' });
    expect(sendFields(only)).toBeNull();
    expect(routeLabel(only)).toBe('Comment only: no agent runs for this message.');
  });

  it('sends an explicit choice as made, keeping the thread model for the same agent', () => {
    expect(sendFields(chosenRoute('again', { to: 'claude', model: 'sonnet' }, opus))).toEqual({ to: 'claude', model: 'sonnet', effort: 'high' });
    expect(sendFields(chosenRoute('again', { effort: 'low' }, opus))).toEqual({ to: 'claude', model: 'opus', effort: 'low' });
    // Switching agent does not carry Claude's model over to Codex.
    expect(sendFields(chosenRoute('your take', { to: 'codex' }, opus))).toEqual({ to: 'codex' });
  });

  it('lets a mention in the text win, keeping the thread model for the same agent', () => {
    expect(chosenRoute('@claude', { to: 'comment' }, opus)).toEqual({ kind: 'mention', runners: ['claude'], model: 'opus', effort: 'high' });
    expect(sendFields(chosenRoute('@claude', undefined, opus))).toEqual({ model: 'opus', effort: 'high' });
    expect(sendFields(chosenRoute('@codex look', undefined, opus))).toEqual({});
    expect(chosenRoute('@claude @codex both', undefined, opus)).toEqual({ kind: 'mention', runners: ['claude', 'codex'] });
    expect(routeLabel(chosenRoute('@codex look', undefined, opus))).toBe('Asks Codex with the model set for comments, as mentioned.');
    // An address is not a mention.
    expect(chosenRoute('mail me@claude.ai', undefined, undefined).kind).toBe('comment');
  });

  it('labels targets in words, with the names the CLI gives its models', () => {
    expect(targetLabel(opus)).toBe('Claude · Opus · High');
    expect(targetLabel({ runner: 'codex', model: 'default', effort: 'default' })).toBe('Codex · CLI default');
    expect(targetLabel({ runner: 'codex', model: 'gpt-x-mini', effort: 'low' }, { 'gpt-x-mini': 'GPT X mini' })).toBe('Codex · GPT X mini · Low');
    expect(targetLabel(undefined)).toBe('Comment only');
  });
});

describe('drafts per file and thread', () => {
  it('keep what was written through closing and switching, and never show it in another thread or file', () => {
    const a = draftKey('file-1', 'thread-a');
    const b = draftKey('file-1', 'thread-b');
    const other = draftKey('file-2', 'thread-a');
    setDraft(a, { text: 'half a thought' });
    setDraft(b, { to: 'comment' });
    expect(getDraft(a)?.text).toBe('half a thought');
    expect(getDraft(b)).toEqual({ text: '', files: [], to: 'comment' });
    expect(getDraft(other)).toBeUndefined();
    expect(hasDraftText(a)).toBe(true);
    expect(hasDraftText(b)).toBe(false);
    // Emptied, it is gone; sent, it is cleared.
    setDraft(b, { to: undefined });
    expect(getDraft(b)).toBeUndefined();
    clearDraft(a);
    expect(getDraft(a)).toBeUndefined();
  });
});

describe('drafts tell only their own thread', () => {
  it('notifies one thread while the person types, and keeps a stable snapshot for the others', () => {
    const a = draftKey('file-3', 'a');
    const b = draftKey('file-3', 'b');
    const heard: string[] = [];
    const offA = subscribeDraft(a, () => heard.push('a'));
    const offB = subscribeDraft(b, () => heard.push('b'));
    setDraft(b, { text: 'kept' });
    const before = getDraft(b);
    heard.length = 0;
    for (const text of ['h', 'he', 'hel']) setDraft(a, { text });
    expect(heard).toEqual(['a', 'a', 'a']);
    // The other thread's snapshot is the very same object: React has no reason to render it.
    expect(getDraft(b)).toBe(before);
    // A new snapshot per change for the thread being typed in, and an attachment and a recipient are kept with it.
    const one = getDraft(a);
    setDraft(a, { files: [{ src: 'bogen-asset:' + 'b'.repeat(64) + '.png' }], to: 'codex' });
    expect(getDraft(a)).not.toBe(one);
    expect(getDraft(a)).toMatchObject({ text: 'hel', to: 'codex' });
    offA();
    offB();
    clearDraft(a);
    clearDraft(b);
  });
});

describe('which conversations a list shows', () => {
  const t = (id: string, text: string, resolved = false, pageId = 'p1') => ({ id, pageId, resolved, messages: [m('Alex', text)] });
  const threads = [t('one', 'Lumen hero'), t('two', 'Pricing card', true), t('three', 'Footer', false, 'p2')];

  it('filters and searches as the person set it', () => {
    expect(visibleThreads(threads, { query: '', filter: 'open', pageId: 'p1', active: null }).map((x) => x.thread.id)).toEqual(['three', 'one']);
    expect(visibleThreads(threads, { query: 'lumen', filter: 'all', pageId: 'p1', active: null }).map((x) => x.thread.id)).toEqual(['one']);
    expect(visibleThreads(threads, { query: '', filter: 'page', pageId: 'p2', active: null }).map((x) => x.thread.id)).toEqual(['three']);
  });

  it('shows a thread opened from a pin, the queue or a notification even where the filter or search hides it, marked as such', () => {
    // Resolved thread opened while the list shows open ones.
    const byFilter = visibleThreads(threads, { query: '', filter: 'open', pageId: 'p1', active: 'two' });
    expect(byFilter[0]).toEqual({ thread: threads[1], outside: true });
    expect(byFilter.slice(1).every((x) => !x.outside)).toBe(true);
    // A search that matches something else.
    const bySearch = visibleThreads(threads, { query: 'footer', filter: 'all', pageId: 'p1', active: 'one' });
    expect(bySearch.map((x) => [x.thread.id, x.outside])).toEqual([['one', true], ['three', false]]);
    // Already in view: listed once, in its place.
    expect(visibleThreads(threads, { query: '', filter: 'all', pageId: 'p1', active: 'one' }).filter((x) => x.thread.id === 'one')).toEqual([{ thread: threads[0], outside: false }]);
    // A thread that is gone is not invented.
    expect(visibleThreads(threads, { query: 'zzz', filter: 'all', pageId: 'p1', active: 'deleted' })).toEqual([]);
  });
});

describe('compact conversations', () => {
  it('name a thread by its first words without the call, and show the newest message', () => {
    const t = { messages: [m('Alex', '@claude   make the Lumen hero calmer'), m('claude', 'Made it calmer.', { by: 'agent' })] };
    expect(conversationTitle(t)).toBe('make the Lumen hero calmer');
    expect(lastPreview(t)).toMatchObject({ author: 'claude', text: 'Made it calmer.' });
    expect(conversationTitle({ messages: [m('Alex', '@claude')] })).toBe('@claude');
    expect(conversationTitle({ messages: [m('Alex', '', { attachments: [{ src: 'bogen-voice:abc.m4a', kind: 'audio' }] })] })).toBe('Voice note');
    expect(conversationTitle({ messages: [m('Alex', 'x'.repeat(200))] }).length).toBe(80);
  });

  it('show the newest messages of a long thread, the rest one click away', () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    expect(visibleMessages(many, false)).toEqual({ hidden: 14, shown: many.slice(-6) });
    expect(visibleMessages(many, true).hidden).toBe(0);
    expect(visibleMessages(many.slice(0, 7), false).hidden).toBe(0);
  });

  it('mark news from others since the person last looked, never their own messages', () => {
    const t = { messages: [m('Alex', 'hi'), m('claude', 'Done.')] };
    const at = t.messages[1]!.at;
    expect(isUnread(t, 'Alex', at - 1)).toBe(true);
    expect(isUnread(t, 'Alex', at)).toBe(false);
    expect(isUnread({ messages: [m('Alex', 'mine')] }, 'Alex', 0)).toBe(false);
    expect(isUnread(t, 'Alex', undefined)).toBe(false);
  });
});
