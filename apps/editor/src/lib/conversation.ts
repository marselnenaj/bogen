import { api, type ConversationTurn } from './api.ts';

/**
 * Which chat with the agent a file is in, on this device. The server keeps what was said under this id, and each
 * run gets the earlier turns, so the id is all a client remembers. "New chat" makes a new one.
 */

const KEY = 'bogen-conversation:';

function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function save(fileId: string, id: string): void {
  try {
    localStorage.setItem(KEY + fileId, id);
  } catch {
    // It lasts for this tab then.
  }
}

/** The chat this file is in, made the first time. */
export function conversationFor(fileId: string): string {
  try {
    const kept = localStorage.getItem(KEY + fileId);
    if (kept && /^[\w-]{1,64}$/.test(kept)) return kept;
  } catch {
    // A new one, as below.
  }
  const id = newId();
  save(fileId, id);
  return id;
}

/** Starts over: the next message goes to an agent that knows nothing of the chat before. */
export function startConversation(fileId: string): string {
  const id = newId();
  save(fileId, id);
  return id;
}

/** What was said in a chat, oldest first. Empty when the server has nothing or cannot be reached. */
export async function conversationTurns(fileId: string, id: string): Promise<ConversationTurn[]> {
  try {
    return (await api.conversation(fileId, id)).turns;
  } catch {
    return [];
  }
}
