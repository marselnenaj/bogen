import { describe, expect, it } from 'vitest';
import { addImages, appendReply, atBottom, chatOpenFor, chatTurns, clampChatWidth, contextChips, elapsed, lastUserMessage, rememberChatOpen, replyText } from '../src/panels/chat-state.ts';
import { chatLayout, chromeLayout, CANVAS_MIN } from '../src/state/chrome-layout.ts';
import type { PromptMessage } from '../src/state/store.ts';
import { inline, parseMarkdown, plainText, safeHref } from '../src/ui/markdown.ts';
import { canStart, joinWords, micProblem, pushLevel, voiceOutcome } from '../src/ui/voice-state.ts';

const status = (name: string | null) => ({ transcriber: name ? { kind: 'command', name } : null, device: 'PC', limit: 1, maxSeconds: 300, retentionDays: 30 });
const audio = { src: 'bogen-voice:aaaaaaaaaaaaaaaaaaaaaaaa.webm', kind: 'audio' as const, name: 'Voice note', duration: 3 };

describe('the chat as turns', () => {
  const messages: PromptMessage[] = [
    { role: 'agent', text: 'Rebuilt.', runId: 'r0' },
    { role: 'user', text: 'Tighten the hero', runner: 'claude' },
    { role: 'tool', text: 'layer_tree' },
    { role: 'agent', text: 'Looking first.', runId: 'r1' },
    { role: 'tool', text: 'layer_style' },
    { role: 'agent', text: 'Done.', runId: 'r1' },
    { role: 'user', text: 'Now the footer' },
    { role: 'error', text: 'The run failed.' },
    { role: 'user', text: 'Try again' },
    { role: 'note', text: 'Stopped.' },
  ];

  it('groups what came back under each message, and keeps an answer with no question here', () => {
    const turns = chatTurns(messages);
    expect(turns.map((t) => [t.index, t.user?.text, t.replies.length, t.steps, t.error?.text, t.notes.length, t.runId])).toEqual([
      [-1, undefined, 1, [], undefined, 0, 'r0'],
      [1, 'Tighten the hero', 2, ['layer_tree', 'layer_style'], undefined, 0, 'r1'],
      [6, 'Now the footer', 0, [], 'The run failed.', 0, undefined],
      [8, 'Try again', 0, [], undefined, 1, undefined],
    ]);
    expect(replyText(turns[1]!)).toBe('Looking first.\n\nDone.');
    expect(lastUserMessage(messages)?.text).toBe('Try again');
    expect(lastUserMessage([])).toBeUndefined();
  });

  it('adds a block of words to the reply of its run as a paragraph, and starts a new one for another run', () => {
    let list: PromptMessage[] = [{ role: 'user', text: 'Hi' }];
    list = appendReply(list, 'r1', 'First block. ');
    list = appendReply(list, 'r1', '\n\nSecond block.');
    expect(list.at(-1)).toMatchObject({ role: 'agent', text: 'First block.\n\nSecond block.', runId: 'r1' });
    list = appendReply([...list, { role: 'tool', text: 'html_write' }], 'r1', 'After a tool.');
    expect(list.filter((m) => m.role === 'agent')).toHaveLength(2);
    expect(appendReply([{ role: 'agent', text: 'Other', runId: 'r0' }], 'r2', 'New').map((m) => m.runId)).toEqual(['r0', 'r2']);
  });

  it('follows new words only while the list is at its end', () => {
    expect(atBottom({ scrollTop: 560, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(atBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(atBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });

  it('shows a few layers by name and counts the rest, and takes at most four images', () => {
    const layers = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    expect(contextChips(layers)).toEqual({ shown: layers.slice(0, 3), more: 2 });
    expect(contextChips(layers.slice(0, 2))).toEqual({ shown: layers.slice(0, 2), more: 0 });
    expect(addImages(['x'], ['x', 'y', 'z', 'w', 'v'])).toEqual({ images: ['x', 'y', 'z', 'w'], dropped: 1 });
    expect(elapsed(38_400)).toBe('0:38');
    expect(elapsed(125_000)).toBe('2:05');
  });

  it('remembers per file whether it was open, and keeps its width in bounds', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(chatOpenFor('f1', storage)).toBe(false);
    rememberChatOpen('f1', true, storage);
    expect(chatOpenFor('f1', storage)).toBe(true);
    expect(chatOpenFor('f2', storage)).toBe(false);
    rememberChatOpen('f1', false, storage);
    expect(chatOpenFor('f1', storage)).toBe(false);
    expect([clampChatWidth(100), clampChatWidth(400.4), clampChatWidth(9000), clampChatWidth(Number.NaN)]).toEqual([280, 400, 640, 340]);
  });
});

describe('where the chat sits', () => {
  const base = { height: 900, scale: 1, leftWidth: 248, rightWidth: 280, chatWidth: 340 };

  it('changes nothing while it is closed', () => {
    for (const width of [1600, 1100, 700, 420]) {
      const { chat, chatPx, ...rest } = chatLayout({ ...base, width, chatOpen: false });
      expect(chat).toBe('closed');
      expect(chatPx).toBe(340);
      expect(rest).toEqual(chromeLayout({ ...base, width }));
    }
  });

  it('docks between canvas and inspector when the canvas keeps its minimum, else moves layers into a drawer, else opens over the canvas', () => {
    const wide = chatLayout({ ...base, width: 1440, chatOpen: true });
    expect(wide).toMatchObject({ mode: 'wide', left: 'docked', right: 'docked', chat: 'docked', chatPx: 340 });
    expect(1440 - wide.leftPx - wide.rightPx - wide.chatPx).toBeGreaterThanOrEqual(CANVAS_MIN);
    expect(chatLayout({ ...base, width: 1100, chatOpen: true })).toMatchObject({ mode: 'compact', left: 'drawer', right: 'docked', chat: 'docked' });
    const narrow = chatLayout({ ...base, width: 860, chatOpen: true });
    expect(narrow).toMatchObject({ chat: 'drawer', right: 'docked' });
    expect(narrow.chatPx).toBeLessThanOrEqual(860 - narrow.rightPx - 40);
    expect(chatLayout({ ...base, width: 420, chatOpen: true })).toMatchObject({ mode: 'narrow', chat: 'drawer' });
  });

  it('counts the UI scale', () => {
    expect(chatLayout({ ...base, width: 1600, scale: 1.25, chatOpen: true })).toMatchObject({ chat: 'docked', chatPx: 425 });
    expect(chatLayout({ ...base, width: 1440, scale: 1.5, chatOpen: true }).chat).not.toBe('closed');
  });
});

describe('markdown from an agent', () => {
  it('reads paragraphs, headings, lists, quotes and code', () => {
    const blocks = parseMarkdown('# Done\n\nThe hero is **48 px** shorter,\nand _calmer_.\n\n- Gap `24px`\n- Button\n  stays blue\n\n3. three\n4. four\n\n> quoted\n\n```css\na { color: red }\n```');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'pre']);
    expect(blocks[2]).toMatchObject({ t: 'ul', items: [[{ t: 'text', text: 'Gap ' }, { t: 'code', text: '24px' }], [{ t: 'text', text: 'Button' }, { t: 'br' }, { t: 'text', text: 'stays blue' }]] });
    expect(blocks[3]).toMatchObject({ t: 'ol', start: 3 });
    expect(blocks[5]).toEqual({ t: 'pre', lang: 'css', text: 'a { color: red }' });
    expect(plainText(blocks)).toContain('The hero is 48 px shorter,\nand calmer.');
  });

  it('never makes HTML or a dangerous link: tags stay words, only web links stay links', () => {
    expect(inline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', text: '<img src=x onerror=alert(1)>' }]);
    expect(inline('[open](javascript:alert(1))')).toEqual([{ t: 'text', text: 'open' }]);
    expect(inline('[docs](https://example.com/a)')).toEqual([{ t: 'link', href: 'https://example.com/a', children: [{ t: 'text', text: 'docs' }] }]);
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref(' HTTP://example.com ')).toBe('http://example.com/');
  });

  it('leaves snake_case, lone stars and escapes alone', () => {
    expect(inline('layer_tree and design_lint')).toEqual([{ t: 'text', text: 'layer_tree and design_lint' }]);
    expect(inline('2 * 3 * 4')).toEqual([{ t: 'text', text: '2 * 3 * 4' }]);
    expect(inline('\\*not bold\\*')).toEqual([{ t: 'text', text: '*not bold*' }]);
    expect(inline('**bold** and *it*')).toEqual([{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }, { t: 'text', text: ' and ' }, { t: 'em', children: [{ t: 'text', text: 'it' }] }]);
  });
});

describe('speaking instead of typing', () => {
  it('says what a microphone error means', () => {
    expect(micProblem({ name: 'NotAllowedError' })).toBe('denied');
    expect(micProblem({ name: 'NotFoundError' })).toBe('no-mic');
    expect(micProblem(new Error('x'))).toBe('failed');
  });

  it('does not record for the chat without a local model, but does for a comment', () => {
    expect(canStart('chat', status(null))).toBe('no-model');
    expect(canStart('chat', status('Voxtype'))).toBeNull();
    expect(canStart('comment', status(null))).toBeNull();
    // Not known yet: record, and let the computer say.
    expect(canStart('chat', null)).toBeNull();
  });

  it('puts words in the field, keeps a comment\'s recording as a voice note, and drops the chat\'s', () => {
    expect(voiceOutcome({ transcript: 'Make it ink.', device: 'PC', transcriber: 'Voxtype' }, 'chat')).toEqual({ kind: 'text', text: 'Make it ink.', transcriber: 'Voxtype' });
    const none = { transcript: null, device: 'PC', reason: 'Transcription is unavailable on this computer: no local speech model is installed.', attachment: audio };
    expect(voiceOutcome(none, 'comment')).toMatchObject({ kind: 'attach', attachment: audio });
    expect(voiceOutcome(none, 'chat')).toMatchObject({ kind: 'drop', problem: 'no-model' });
    expect(voiceOutcome({ ...none, transcriber: 'Voxtype', reason: 'Nothing was understood in the recording.' }, 'chat')).toMatchObject({ kind: 'drop', problem: 'nothing' });
    expect(voiceOutcome({ ...none, transcriber: 'Voxtype', reason: 'Transcription failed: boom' }, 'chat')).toMatchObject({ kind: 'drop', problem: 'failed' });
  });

  it('adds the words after what is written, and keeps the meter bounded', () => {
    expect(joinWords('', ' Make it ink. ')).toBe('Make it ink.');
    expect(joinWords('The footer:  ', 'make it ink.')).toBe('The footer: make it ink.');
    expect(joinWords('Keep', '  ')).toBe('Keep');
    const levels = Array.from({ length: 30 }, (_, i) => i / 10).reduce<number[]>((acc, l) => pushLevel(acc, l), []);
    expect(levels).toHaveLength(20);
    expect(Math.max(...levels)).toBe(1);
  });
});
