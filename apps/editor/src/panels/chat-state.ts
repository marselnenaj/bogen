import type { PromptMessage } from '../state/store.ts';

/**
 * The chat panel's own logic, apart from React: how the flat list of messages reads as turns, when the list follows
 * new words, what Ask again repeats, what goes with a message, and what the panel remembers per file.
 */

/** One exchange: what the person asked, and what came back for it. */
export interface ChatTurn {
  /** Index of the person's message in the list, or -1 for an answer with no question here (a rebuild, a race). */
  index: number;
  user?: PromptMessage;
  /** The agent's words, block by block, in order. */
  replies: PromptMessage[];
  /** The tools it used, in order. */
  steps: string[];
  error?: PromptMessage;
  notes: PromptMessage[];
  /** The run that answered, once known. */
  runId?: string;
}

/** The messages as turns: each person's message opens one, and everything after it belongs to it. */
export function chatTurns(messages: readonly PromptMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const open = (index: number, user?: PromptMessage): ChatTurn => {
    const turn: ChatTurn = { index, ...(user ? { user } : {}), replies: [], steps: [], notes: [] };
    turns.push(turn);
    return turn;
  };
  messages.forEach((m, i) => {
    if (m.role === 'user') return void open(i, m);
    const turn = turns.at(-1) ?? open(-1);
    if (m.role === 'agent') {
      // The words of a run that ends Bogen's note go under the turn too.
      turn.replies.push(m);
      if (m.runId) turn.runId = m.runId;
    } else if (m.role === 'tool') turn.steps.push(m.text);
    else if (m.role === 'error') turn.error = m;
    else turn.notes.push(m);
  });
  return turns;
}

/** The words of a turn as one text, for Copy and for markdown. Blocks are paragraphs. */
export function replyText(turn: Pick<ChatTurn, 'replies'>): string {
  return turn.replies.map((r) => r.text.trim()).filter(Boolean).join('\n\n');
}

/** Appends a block of words to the list: to the agent's last message of the same run, as a new paragraph. */
export function appendReply(messages: readonly PromptMessage[], runId: string, text: string): PromptMessage[] {
  const next = [...messages];
  const last = next.at(-1);
  if (last?.role === 'agent' && (!last.runId || last.runId === runId)) {
    const before = last.text.trimEnd();
    const add = text.trim();
    next[next.length - 1] = { ...last, text: before && add ? `${before}\n\n${add}` : before || add, runId };
  } else next.push({ role: 'agent', text: text.trim(), runId, at: Date.now() });
  return next;
}

/** The person's last message, which Ask again sends once more and Edit puts back in the field. */
export function lastUserMessage(messages: readonly PromptMessage[]): PromptMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return messages[i];
  return undefined;
}

/** How close to the bottom, in pixels, still counts as being at it. */
export const STICK_PX = 48;

/** Whether the list is scrolled to its end: new words then keep it there; scrolled up, it stays where it is. */
export function atBottom(m: { scrollTop: number; scrollHeight: number; clientHeight: number }, slack = STICK_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slack;
}

/** The layers that go with a message, as chips: a few by name, the rest counted. */
export function contextChips<T extends { id: string }>(layers: readonly T[], max = 3): { shown: T[]; more: number } {
  return { shown: layers.slice(0, max), more: Math.max(0, layers.length - max) };
}

/** How long a run has taken: 0:38, 2:05. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** At most this many images go with one message: the server takes four. */
export const MAX_CHAT_IMAGES = 4;

/** Adds stored images to the ones a message has, without doubles and up to the limit. */
export function addImages(current: readonly string[], add: readonly string[], max = MAX_CHAT_IMAGES): { images: string[]; dropped: number } {
  const images = [...current];
  let dropped = 0;
  for (const src of add) {
    if (images.includes(src)) continue;
    if (images.length >= max) dropped++;
    else images.push(src);
  }
  return { images, dropped };
}

// What the panel remembers, in this browser.

const OPEN_PREFIX = 'bogen-chat-open:';
/** The chat's width in UI pixels; the width itself is kept with the other panels' (`bogen-layout`). */
export const CHAT_WIDTH = { min: 280, max: 640, initial: 340 };

/** Whether the chat was open the last time this file was. Closed for a file never seen. */
export function chatOpenFor(fileId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(OPEN_PREFIX + fileId) === '1';
  } catch {
    return false;
  }
}

export function rememberChatOpen(fileId: string, open: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
  try {
    if (open) storage?.setItem(OPEN_PREFIX + fileId, '1');
    else storage?.removeItem(OPEN_PREFIX + fileId);
  } catch {
    // It lasts for this tab then.
  }
}

export function clampChatWidth(width: number): number {
  return Math.round(Math.max(CHAT_WIDTH.min, Math.min(CHAT_WIDTH.max, Number.isFinite(width) ? width : CHAT_WIDTH.initial)));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
