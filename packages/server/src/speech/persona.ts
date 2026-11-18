import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstChunk, personaPrompt, type CallLanguage, type PersonaRequest } from '@bogen/core';
import { childEnv } from '../agents.ts';

/**
 * The talking layer of a call: what the voice says, as opposed to what the agent does. It never edits anything and
 * has no tools. Two kinds, behind one interface:
 *
 * - `local`: a small open model (GGUF) run by llama.cpp on this computer, on the GPU through Vulkan when there is
 *   one. Nothing leaves the machine and nothing is billed.
 * - `claude`: a Claude Code session on the person's own subscription, kept open for the whole call with the cheapest
 *   model, no tools and no MCP servers. Each turn is one more message in that session, so there is no start-up cost
 *   per turn.
 *
 * Both answer within a call's time limit or the rules speak instead (`CallBrain`).
 */

export interface PersonaReply { text: string; firstTokenMs: number; totalMs: number }

export interface PersonaEngine {
  readonly id: string;
  /** Loads the model or opens the session, so the first turn is fast. */
  warm(): Promise<void>;
  /**
   * `onFirst`: the first piece that can be spoken (a sentence, or a clause before a comma) as soon as it is written;
   * `onText`: everything written so far, after each piece. Both only for engines that stream.
   */
  reply(req: PersonaRequest, signal?: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): Promise<PersonaReply>;
  dispose(): Promise<void>;
}

/** Spoken lines are short; a routing decision is a small JSON object with a line in it. */
const maxTokens = (req: PersonaRequest) => (req.kind === 'brief' ? 260 : req.kind === 'summary' ? 160 : req.kind === 'turn' ? 220 : req.kind === 'route' ? 120 : 80);

// ---------------------------------------------------------------- local, llama.cpp

type LlamaModule = typeof import('node-llama-cpp');

export interface LocalPersonaOptions {
  modelPath: string;
  /** 'auto' takes Vulkan, CUDA or Metal when there is one, else the CPU. */
  gpu?: 'auto' | false;
  /** Model families that think before answering are told not to. */
  family?: 'qwen3' | 'smollm3' | 'phi4' | 'other';
  /** How a request becomes a prompt; the measurements use it to compare an older way of asking. */
  prompt?: typeof personaPrompt;
}

export class LocalPersona implements PersonaEngine {
  readonly id = 'local';
  private loading: Promise<void> | null = null;
  private llamaMod: LlamaModule | null = null;
  private session: import('node-llama-cpp').LlamaChatSession | null = null;
  private model: import('node-llama-cpp').LlamaModel | null = null;
  private context: import('node-llama-cpp').LlamaContext | null = null;
  /** Which backend llama.cpp chose: vulkan, cuda, metal or false for the CPU. */
  gpu: string | false = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: LocalPersonaOptions) {}

  warm(): Promise<void> {
    this.loading ??= (async () => {
      this.llamaMod = await import('node-llama-cpp');
      const llama = await this.llamaMod.getLlama({ gpu: this.opts.gpu ?? 'auto', logLevel: this.llamaMod.LlamaLogLevel.error });
      this.gpu = llama.gpu;
      this.model = await llama.loadModel({ modelPath: this.opts.modelPath });
      this.context = await this.model.createContext({ contextSize: 8192 });
      this.session = new this.llamaMod.LlamaChatSession({ contextSequence: this.context.getSequence() });
    })();
    return this.loading;
  }

  reply(req: PersonaRequest, signal?: AbortSignal): Promise<PersonaReply> {
    // One sequence, one turn at a time.
    const run = this.queue.then(() => this.answer(req, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async answer(req: PersonaRequest, signal?: AbortSignal): Promise<PersonaReply> {
    await this.warm();
    const session = this.session!;
    const { system, user } = (this.opts.prompt ?? personaPrompt)(req);
    const noThink = this.opts.family === 'smollm3' ? '\n/no_think' : '';
    // The same system text every turn, so llama.cpp reuses its cache and only reads the new part.
    session.setChatHistory([{ type: 'system', text: system + noThink }]);
    const started = performance.now();
    let first = 0;
    const text = await session.prompt(this.opts.family === 'qwen3' ? `${user} /no_think` : user, {
      maxTokens: maxTokens(req),
      temperature: req.kind === 'route' || req.kind === 'brief' || req.kind === 'summary' ? 0.1 : 0.4,
      topP: 0.9,
      signal,
      stopOnAbortSignal: true,
      budgets: { thoughtTokens: 0 },
      onTextChunk: (chunk) => { if (!first && chunk.trim()) first = performance.now() - started; },
    });
    return { text: stripThinking(text), firstTokenMs: Math.round(first || performance.now() - started), totalMs: Math.round(performance.now() - started) };
  }

  /** Bytes the model holds in memory, for the measurements. */
  memory(): { modelBytes: number } {
    return { modelBytes: this.model?.size ?? 0 };
  }

  async dispose(): Promise<void> {
    await this.context?.dispose();
    await this.model?.dispose();
    this.session = null;
    this.context = null;
    this.model = null;
    this.loading = null;
  }
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*<\/?think>\s*/g, '').trim();
}

// ---------------------------------------------------------------- Claude Code on the person's subscription

/**
 * The session's own system text. The instructions for one kind of request (deciding a turn, a spoken line, a brief)
 * go after it, so that a session for that kind sends them once, cached, and each message holds only the call's
 * context and the person's words.
 */
const CLAUDE_SYSTEM = 'You are the voice layer of a design tool in a phone call. Follow the instructions below exactly and output only what they ask for, nothing else. Each message holds the call as it is now and what the person just said; earlier messages in this session are older states of the same call. You have no tools and change nothing yourself.';

/**
 * Turns before the session is replaced, so its history stays small: each turn carries the call's context, and a long
 * history makes every answer slower. A fresh session starts in the background a few turns before, so that no turn
 * waits for a process to start.
 */
const CLAUDE_TURNS = 16;
const CLAUDE_SPARE_AT = 12;

/** One open Claude Code process, answering one message at a time. */
class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private dir: string | null = null;
  private buffer = '';
  private waiting: { resolve(r: PersonaReply): void; reject(e: Error): void; started: number; first: number; text: string; onFirst?: (sentence: string) => void; onText?: (soFar: string) => void; told?: boolean } | null = null;
  private turns = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: SessionOptions) {}

  warm(): Promise<void> {
    this.starting ??= this.open();
    return this.starting;
  }

  /** Turns answered in this process so far. */
  get used(): number { return this.turns; }

  /** Whether all asked turns have been answered: then it can be closed without losing one. */
  idle(): Promise<void> { return this.queue.then(() => undefined); }

  private async open(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), 'bogen-voice-'));
    const mcp = join(this.dir, 'mcp.json');
    await writeFile(mcp, '{"mcpServers":{}}', { mode: 0o600 });
    const child = spawn(this.opts.command ?? 'claude', [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcp, '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--disable-slash-commands',
      '--model', this.opts.model ?? 'opus',
      ...(this.opts.effort ? ['--effort', this.opts.effort] : []),
      '--append-system-prompt', this.opts.system ? `${CLAUDE_SYSTEM}\n\n${this.opts.system}` : CLAUDE_SYSTEM,
    ], { cwd: this.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.read(d));
    child.stderr.resume();
    child.on('exit', () => {
      this.waiting?.reject(new Error('The voice session ended.'));
      this.waiting = null;
      this.child = null;
      this.starting = null;
    });
  }

  private read(data: string): void {
    this.buffer += data;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let m: { type?: string; result?: string; is_error?: boolean; event?: { type?: string; delta?: { type?: string; text?: string } } };
      try { m = JSON.parse(line); } catch { continue; }
      const w = this.waiting;
      if (!w) continue;
      if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta' && m.event.delta.text) {
        if (!w.first && m.event.delta.text.trim()) w.first = performance.now() - w.started;
        w.text += m.event.delta.text;
        w.onText?.(w.text);
        if (w.onFirst && !w.told) {
          const piece = firstChunk(w.text);
          if (piece) { w.told = true; w.onFirst(piece); }
        }
      }
      if (m.type === 'result') {
        this.waiting = null;
        const total = performance.now() - w.started;
        if (m.is_error) w.reject(new Error('The voice session could not answer.'));
        else w.resolve({ text: (m.result ?? w.text).trim(), firstTokenMs: Math.round(w.first || total), totalMs: Math.round(total) });
      }
    }
  }

  /**
   * One turn in the session. A turn given up on (its caller's time ran out) still runs to its end in the CLI, so the
   * next turn is only sent once that answer is in and thrown away; otherwise each answer would land one turn late.
   */
  ask(text: string, signal?: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): Promise<PersonaReply> {
    let settled!: Promise<unknown>;
    const run = this.queue.then(() => {
      if (signal?.aborted) { settled = Promise.resolve(); throw new Error('aborted'); }
      const { reply, done } = this.send(text, signal, onFirst, onText);
      settled = done;
      return reply;
    });
    this.queue = run.then(() => undefined, () => settled ?? undefined).catch(() => undefined);
    return run;
  }

  /** `reply` settles for the caller (early, on abort); `done` when the CLI has answered this turn, whoever waits. */
  private send(text: string, signal?: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): { reply: Promise<PersonaReply>; done: Promise<void> } {
    let markDone!: () => void;
    const done = new Promise<void>((r) => { markDone = r; });
    const reply = (async () => {
      if (this.turns >= CLAUDE_TURNS * 2) { await this.dispose(); this.turns = 0; }
      await this.warm();
      if (!this.child) { markDone(); throw new Error('The voice session is not open.'); }
      this.turns++;
      return new Promise<PersonaReply>((resolve, reject) => {
        let given = false;
        this.waiting = {
          resolve: (r) => { markDone(); if (!given) resolve(r); },
          reject: (e) => { markDone(); if (!given) reject(e); },
          started: performance.now(), first: 0, text: '', ...(onFirst ? { onFirst: (s: string) => { if (!given) onFirst(s); } } : {}),
          ...(onText ? { onText: (t: string) => { if (!given) onText(t); } } : {}),
        };
        // The caller stops waiting; the slot stays, so this turn's answer is not taken for the next one.
        signal?.addEventListener('abort', () => { given = true; reject(new Error('aborted')); }, { once: true });
        this.child!.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
      });
    })();
    reply.catch(() => undefined);
    return { reply, done };
  }

  async dispose(): Promise<void> {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.starting = null;
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.dir = null;
  }
}

/**
 * The talking layer on the person's Claude Code plan. Two sessions, one for deciding what a turn is (JSON) and one
 * for the spoken lines, so that the format of one never leaks into the other.
 */
/** A session that is replaced by a warm one every few turns, so that its history stays short and no turn waits. */
interface SessionOptions { model?: string; effort?: string; command?: string; /** Instructions for every message, sent once as system text. */ system?: string }

class FreshSession {
  private current: ClaudeSession;
  private spare: ClaudeSession | null = null;

  constructor(private readonly opts: SessionOptions) {
    this.current = new ClaudeSession(opts);
  }

  warm(): Promise<void> { return this.current.warm(); }

  ask(text: string, signal?: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): Promise<PersonaReply> {
    if (this.current.used >= CLAUDE_SPARE_AT && !this.spare) {
      this.spare = new ClaudeSession(this.opts);
      void this.spare.warm().catch(() => undefined);
    }
    if (this.current.used >= CLAUDE_TURNS && this.spare) {
      const old = this.current;
      this.current = this.spare;
      this.spare = null;
      void old.idle().then(() => old.dispose());
    }
    return this.current.ask(text, signal, onFirst, onText);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.current.dispose(), this.spare?.dispose()]);
    this.spare = null;
  }
}

export class ClaudePersona implements PersonaEngine {
  readonly id = 'claude';
  /**
   * One session per kind of request and its instructions, which it holds as system text: deciding turns; spoken lines
   * about runs; answers to the person's questions (so a long retell never holds one up); briefs (2 to 3.5 s, so the
   * next turn never waits behind one); the call's notes (opened the first time notes are written). A session per
   * language, since the instructions name it.
   */
  private readonly sessions = new Map<string, FreshSession>();

  constructor(private readonly opts: { model?: string; effort?: string; command?: string; prompt?: typeof personaPrompt } = {}) {}

  private session(req: PersonaRequest, system: string): FreshSession {
    const group = req.kind === 'turn' || req.kind === 'route' ? 'turn' : req.kind === 'chat' || req.kind === 'event' ? 'status' : req.kind === 'brief' || req.kind === 'summary' ? req.kind : 'speak';
    const key = `${group}:${req.language}:${system}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new FreshSession({ model: this.opts.model, effort: this.opts.effort, command: this.opts.command, system });
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Opens the sessions a call needs first (deciding turns, speaking, briefs) in its language, so no turn waits for a start. */
  async warm(language: CallLanguage = 'en'): Promise<void> {
    const prompt = this.opts.prompt ?? personaPrompt;
    const kinds: PersonaRequest['kind'][] = ['turn', 'result', 'chat', 'brief'];
    await Promise.all(kinds.map((kind) => { const req: PersonaRequest = { kind, language, said: '' }; return this.session(req, prompt(req).system).warm(); }));
    // One message to the session that decides turns before the call's first, so its instructions are in the model's
    // cache and the first answer is as quick as the rest.
    const first: PersonaRequest = { kind: 'turn', language, said: '' };
    await this.session(first, prompt(first).system).ask('The call is starting; nobody has spoken yet. Reply with @listen only.').catch(() => undefined);
  }

  reply(req: PersonaRequest, signal?: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): Promise<PersonaReply> {
    const { system, user } = (this.opts.prompt ?? personaPrompt)(req);
    return this.session(req, system).ask(user, signal, onFirst, onText);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
    this.sessions.clear();
  }
}

/** For the call status: which talking layers this computer can use. */
export type PersonaChoice = 'local' | 'claude' | 'rules';

export function languageName(language: CallLanguage): string {
  return language === 'de' ? 'Deutsch' : 'English';
}
