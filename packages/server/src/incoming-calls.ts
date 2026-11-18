import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunEnd } from './agents.ts';
import { atomicWrite } from './util.ts';

/**
 * The agent calls the person: when a run they started ends on a question it could not answer itself, Bogen rings
 * once in the editor (and on a paired phone) with that question, for thirty seconds. Answering opens the call in that
 * file and the voice asks the question first; declining or letting it ring out leaves the question where it already
 * is, in the chat or the thread, so nothing is lost.
 *
 * Off until the person turns it on. Never during their quiet hours, never while another call rings, never twice in a
 * row from the same file, and never for a run that a call started (the voice is already there to ask). Only runs that
 * came from this person count: a request in the chat, a comment they sent, or one of their paired devices. Nothing
 * that merely arrives in a document starts a run, so nothing that arrives in one rings either.
 */

export const RING_MS = 30_000;
/** After any call, rang out or answered, no other for this long. */
export const GLOBAL_COOLDOWN_MS = 2 * 60_000;
/** After a call from a file, none from the same file for this long. */
export const FILE_COOLDOWN_MS = 10 * 60_000;
const QUESTION_LIMIT = 240;

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const AgentCallSettings = z.object({
  enabled: z.boolean().default(false),
  /** Quiet hours, local time. Both or neither; a start after the end wraps past midnight. */
  quietFrom: Clock.nullable().default(null),
  quietTo: Clock.nullable().default(null),
});
export type AgentCallSettings = z.output<typeof AgentCallSettings>;

export interface IncomingCall {
  id: string;
  fileId: string;
  fileName: string;
  runId: string;
  runner: string;
  question: string;
  threadId?: string;
  conversationId?: string;
  at: number;
  expiresAt: number;
}

export type IncomingEnd = 'answered' | 'declined' | 'text' | 'missed';
export type IncomingEvent = { t: 'incoming-call'; call: IncomingCall } | { t: 'incoming-call-end'; id: string; fileId: string; reason: IncomingEnd };

/** Where a run came from, as far as calling goes. Only what this person asked for may ring them. */
export type RunOrigin = 'prompt' | 'comment' | 'remote' | 'race' | 'live';

export interface IncomingDeps {
  home: string;
  broadcast: (event: IncomingEvent) => void;
  /** The file's name, for the ring. */
  fileName: (fileId: string) => string | undefined;
  /** What the run said last: its reply, or for a comment run its last message in the thread. */
  replyOf: (end: RunEnd) => Promise<string | undefined>;
  /** Tells paired phones, in the words push notices allow: who and which file, never the question. */
  notifyPhones?: (call: IncomingCall) => void;
  now?: () => number;
  /** Local minutes since midnight, for quiet hours. */
  localMinutes?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
  newId?: () => string;
}

/**
 * The question a reply ends on, or nothing: the last sentence of its last paragraph must end with a question mark.
 * A spoken `<say>` block and code are left out. An offer at the end ("Soll ich auch …?") counts, since it waits for
 * the person's word.
 */
export function askedQuestion(reply: string | undefined): string | null {
  if (!reply) return null;
  const text = reply.replace(/<say>[\s\S]*?<\/say>/gi, ' ').replace(/```[\s\S]*?```/g, ' ').trim();
  if (!text) return null;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last) return null;
  const plain = last.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!/[?？]["'»“”)\]]*$/.test(plain)) return null;
  const sentences = plain.match(/[^.!?？]+[.!?？]+["'»“”)\]]*/g) ?? [plain];
  const question = sentences.at(-1)!.trim();
  if (question.length < 6) return null;
  return question.length > QUESTION_LIMIT ? `${question.slice(0, QUESTION_LIMIT - 1).trimEnd()}…` : question;
}

function minutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return h! * 60 + m!;
}

/** Whether `now` (local minutes) falls in the quiet hours. A range that wraps midnight works; equal ends mean none. */
export function inQuietHours(settings: AgentCallSettings, now: number): boolean {
  if (!settings.quietFrom || !settings.quietTo) return false;
  const from = minutes(settings.quietFrom);
  const to = minutes(settings.quietTo);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

const localNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

export class IncomingCalls {
  private settings: AgentCallSettings = AgentCallSettings.parse({});
  private ringing: { call: IncomingCall; timer: { cancel: () => void } } | null = null;
  private lastAny = -Infinity;
  private lastByFile = new Map<string, number>();
  private write: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(private readonly deps: IncomingDeps) {}

  private get path(): string {
    return join(this.deps.home, 'agent-calls.json');
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async load(): Promise<void> {
    try {
      this.settings = AgentCallSettings.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      this.settings = AgentCallSettings.parse({});
    }
  }

  get current(): { settings: AgentCallSettings; ringing: IncomingCall | null } {
    return { settings: this.settings, ringing: this.ringing?.call ?? null };
  }

  async setSettings(patch: Partial<AgentCallSettings>): Promise<AgentCallSettings> {
    const next = AgentCallSettings.parse({ ...this.settings, ...patch });
    if ((next.quietFrom === null) !== (next.quietTo === null)) throw new Error('Quiet hours need a start and an end.');
    this.settings = next;
    if (!next.enabled) this.end('declined');
    const body = `${JSON.stringify(next, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(() => atomicWrite(this.path, body, 0o600));
    await this.write;
    return next;
  }

  /**
   * A run ended. It rings when everything holds: turned on, outside quiet hours, a run this person asked for that
   * finished and ends on a question, no call ringing, and both cooldowns over.
   */
  async runEnded(end: RunEnd & { origin?: RunOrigin; call?: boolean }): Promise<IncomingCall | null> {
    if (!this.settings.enabled || end.status !== 'done' || end.call) return null;
    if (end.origin && end.origin !== 'prompt' && end.origin !== 'comment' && end.origin !== 'remote') return null;
    if (end.review === 'directions') return null;
    if (inQuietHours(this.settings, (this.deps.localMinutes ?? localNow)())) return null;
    const question = askedQuestion(await this.deps.replyOf(end).catch(() => undefined));
    if (!question) return null;
    // Checked after the reply is read, so that two runs ending at once still ring once.
    const at = this.now();
    if (this.ringing) return null;
    if (at - this.lastAny < GLOBAL_COOLDOWN_MS) return null;
    if (at - (this.lastByFile.get(end.fileId) ?? -Infinity) < FILE_COOLDOWN_MS) return null;
    const call: IncomingCall = {
      id: this.deps.newId?.() ?? `in${at.toString(36)}${(this.counter++).toString(36)}`,
      fileId: end.fileId, fileName: this.deps.fileName(end.fileId) ?? 'a design', runId: end.runId, runner: end.runner, question,
      ...(end.threadId ? { threadId: end.threadId } : {}), ...(end.conversationId ? { conversationId: end.conversationId } : {}),
      at, expiresAt: at + RING_MS,
    };
    this.lastAny = at;
    this.lastByFile.set(end.fileId, at);
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
    this.ringing = { call, timer: set(() => this.end('missed', call.id), RING_MS) };
    this.deps.broadcast({ t: 'incoming-call', call });
    try { this.deps.notifyPhones?.(call); } catch { /* the ring in the editor still stands */ }
    return call;
  }

  /** The person's answer to the ring: answer, decline or reply in writing. A stale id changes nothing. */
  respond(id: string, action: 'answer' | 'decline' | 'text'): IncomingCall | null {
    if (!this.ringing || this.ringing.call.id !== id) return null;
    const call = this.ringing.call;
    this.end(action === 'answer' ? 'answered' : action === 'text' ? 'text' : 'declined', id);
    return call;
  }

  private end(reason: IncomingEnd, id?: string): void {
    if (!this.ringing || (id && this.ringing.call.id !== id)) return;
    const { call, timer } = this.ringing;
    timer.cancel();
    this.ringing = null;
    // The cooldown counts from the end of the ring, so a missed call is not followed by another at once.
    this.lastAny = this.now();
    this.deps.broadcast({ t: 'incoming-call-end', id: call.id, fileId: call.fileId, reason });
  }

  close(): void {
    this.ringing?.timer.cancel();
    this.ringing = null;
  }
}
