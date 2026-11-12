import type { CommentMessage, CommentThread } from '@bogen/core';

/**
 * What a comment that calls an agent actually asks for. People often write their request first and then call the
 * agent with a bare "@claude" in a message of its own, or send only a picture. The run must answer that request,
 * not the bare mention. This reads it from the thread, without changing the thread: the human messages before the
 * call that no agent reply has answered yet. An agent's own words never become the request, and a request an agent
 * already answered, or one whose own run is still waiting or going, is not replayed.
 */

/** Who writes notes into threads for the server. See `comment-runs.ts`. */
export const SYSTEM_AUTHOR = 'Bogen';

/** The most human messages, and characters, a carried request takes. Newest kept. */
const CARRY_MESSAGES = 6;
const CARRY_CHARS = 4000;

const MENTION = /(^|[\s([{,;:'"])@(claude|codex)(?![\w-]|\.\w)/gi;
/** Words that only fill out a call: "@claude bitte", "please @codex", "hey @claude ?". */
const FILLER = /^(?:please|pls|plz|bitte|hey|hi|hallo|ok(?:ay)?|now|jetzt|dann|then|go|los|mal|you|du|thanks?|danke|and|und)$/i;

/** An agent's name as the CLIs and connected clients use it: "claude", "codex", "claude-code", "codex 2". */
const AGENT_NAME = /^(?:claude|codex)(?![a-z])/i;

/** Whether a message was written by an agent or by the server, rather than by a person. */
export function isAgentMessage(m: Pick<CommentMessage, 'author' | 'by'>): boolean {
  return m.by === 'agent' || AGENT_NAME.test(m.author.trim());
}

export function isSystemMessage(m: Pick<CommentMessage, 'author' | 'by'>): boolean {
  return m.by === 'system' || m.author === SYSTEM_AUTHOR;
}

/** The words of a message without its agent mentions and filler, or '' when that is all there is. */
export function requestWords(text: string): string {
  const rest = text.replace(MENTION, '$1').replace(/[\s.,;:!?…()[\]{}"'„“”«»-]+/g, ' ').trim();
  if (!rest) return '';
  return rest.split(' ').every((w) => FILLER.test(w)) ? '' : rest;
}

const hasFiles = (m: CommentMessage) => (m.attachments ?? []).some((a) => typeof a?.src === 'string');

export interface EffectiveRequest {
  /** What the run answers: the message itself, or the human messages its bare call stands for. */
  text: string;
  /**
   * `message`: the message says what it wants. `carried`: it only calls the agent, and the request is the human
   * messages just before it. `files`: it only calls the agent and attaches files, which are the subject. `none`:
   * it only calls the agent, and nothing was asked since the last agent reply.
   */
  kind: 'message' | 'carried' | 'files' | 'none';
  /** The human messages the request was read from, oldest first, when it was carried over. */
  from: CommentMessage[];
}

/**
 * What an agent reply has answered: everything up to the request of the run that wrote it (`answers`), or, for a
 * reply without that mark (an older reply, or an agent connected from outside), everything before the reply.
 * An agent's progress reply from an older run can land after a newer human message; that message is still open.
 */
function answeredUpTo(messages: CommentMessage[], before: number): number {
  let upTo = -1;
  for (let i = 0; i < before; i++) {
    const m = messages[i]!;
    if (!isAgentMessage(m) || isSystemMessage(m)) continue;
    const asked = typeof m.answers === 'string' ? messages.findIndex((x) => x.id === m.answers) : -1;
    upTo = Math.max(upTo, asked >= 0 && asked < i ? asked : i);
  }
  return upTo;
}

/**
 * The request behind a message in a thread. Explicit words in the message itself always win. A bare call takes
 * the human messages no agent has answered yet, skipping messages that are their own request with a run still
 * waiting or going (`inFlight`, by message id), so that nothing already being worked on is asked twice.
 */
export function effectiveRequest(thread: Pick<CommentThread, 'messages'>, messageId: string, inFlight: ReadonlySet<string> = new Set()): EffectiveRequest {
  const index = thread.messages.findIndex((m) => m.id === messageId);
  const asked = thread.messages[index];
  if (!asked) return { text: '', kind: 'none', from: [] };
  if (requestWords(asked.text)) return { text: asked.text, kind: 'message', from: [] };
  const from: CommentMessage[] = [];
  let chars = 0;
  for (let i = index - 1, stop = answeredUpTo(thread.messages, index); i > stop && from.length < CARRY_MESSAGES; i--) {
    const m = thread.messages[i]!;
    // Agent replies and server notes, such as a stopped or failed run, are not requests.
    if (isSystemMessage(m) || isAgentMessage(m)) continue;
    if (inFlight.has(m.id)) continue;
    if (!requestWords(m.text) && !hasFiles(m)) continue;
    if (chars + m.text.length > CARRY_CHARS && from.length) break;
    from.unshift(m);
    chars += m.text.length;
  }
  if (from.length) return { text: from.map((m) => m.text.trim() || '(files only)').join('\n'), kind: 'carried', from };
  if (hasFiles(asked)) return { text: asked.text, kind: 'files', from: [] };
  return { text: asked.text, kind: 'none', from: [] };
}

/** The request as a single line, for a run's title, the queue and the classifiers that read requests. */
export function requestTitle(request: EffectiveRequest): string {
  if (request.kind === 'carried') return request.from.map((m) => m.text.replace(MENTION, '$1').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 4000);
  return request.text;
}

/** What the prompt says about the request, under the message the run answers. Empty for an explicit message. */
export function requestLines(request: EffectiveRequest, author: string): string[] {
  if (request.kind === 'message') return [];
  if (request.kind === 'carried') {
    return [
      `That message only calls you. What it calls you for is what people wrote before it that no agent has answered yet. Answer this as the request:`,
      ...request.from.map((m) => `${m.author}: ${m.text.trim() || '(files only)'}${hasFiles(m) ? ' (its files come with this request)' : ''}`),
    ];
  }
  if (request.kind === 'files') return [`That message only calls you, and attaches files. The files are the subject: look at them, and read the thread for what ${author} wants done with them.`];
  return [
    'That message only calls you, and nothing was asked since the last agent reply. Do not redo a request that was already answered.',
    'Read the thread and the layer: if something is clearly still open, do that; otherwise ask one specific question about what to do next.',
  ];
}
