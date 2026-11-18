import { useSyncExternalStore } from 'react';
import { CallBrain, CALL_TIMING, turn, wordsFor, type StoredCallPreference, type CallPreference, type SwitchResult, type CallCommand, type CallLanguage, type CallLogLine, type NoiseReason, type PersonaRequest, type SendMeta, type SpokenKind, type TurnEvent, type TurnState } from '@bogen/core';
import { conversationFor } from '../lib/conversation.ts';
import { maybeSession } from '../doc/session.ts';
import { api } from '../lib/api.ts';
import { collabApi } from '../lib/collab-api.ts';
import { loadUser } from '../lib/user.ts';
import { editor } from '../state/store.ts';
import { sendPrompt, setChatOpen } from '../panels/prompt-actions.ts';
import { onReachableChange, onServerEvent, serverReachable, type ServerEvent } from '../lib/events.ts';
import { playSound, repeatSound, setVoiceBusy } from './call-sounds.ts';
import { encodeWav16k, Mic } from './mic.ts';
import { msg } from '../i18n/core.ts';

/**
 * A voice call with the agent, as a conversation. The person's words go to the agent's chat as a message, and the
 * agent's answer, tools and details stay in that chat. What is spoken comes from a separate talking layer (a small
 * model on this computer, a Claude Code session on the person's plan, or plain rules), held to a sentence or two:
 * an instant "Mach ich." when a request is in, quiet while the agent works with one soft sound after a while, and a
 * short spoken result at the end. `CallBrain` in core decides all of that; this file is the audio and the wiring.
 *
 * The call belongs to the file it started in, and lives above the editor: leaving the file, going home or opening
 * another one keeps the microphone, the voice and the server call going, and what is said still goes to that file.
 * The call bar (`CallBar.tsx`) shows it everywhere; the agent's runs are followed through the server's events, not
 * through the open editor, so they are followed wherever the person is.
 */

export interface Caption { who: 'you' | 'agent'; text: string; at: number; kind?: SpokenKind }

export type TalkChoice = 'auto' | 'local' | 'claude' | 'claude-sonnet' | 'claude-opus' | 'rules';

export interface TalkStatusAnswer {
  gpu: string | false | null;
  models: { id: string; label: string; licence: string; source: string; bytes: number; installed: boolean; recommended: boolean }[];
  claude: boolean;
  auto: Exclude<TalkChoice, 'auto'>;
}

export interface CallStatusAnswer {
  voices: { id: string; language: CallLanguage; name: string; licence: string; attribution?: string; bytes: number; installed: boolean; preferred: boolean }[];
  listen: { installed: boolean; bytes: number; licence: string; voxtype: boolean; ffmpeg: boolean; engine?: 'parakeet' | 'whisper-gpu' | 'voxtype'; model?: string; attribution?: string; whisper?: { gpu: boolean; installed: boolean; bytes: number }; parakeet?: { installed: boolean; bytes: number; licence: string; attribution: string } };
  installing: string[];
  ready: Record<CallLanguage, boolean>;
  /** The languages a call speaks here; an older server leaves it out and speaks both. */
  languages?: CallLanguage[];
  talk: TalkStatusAnswer;
  /** The one call the server talks for now; an older server leaves it out. */
  call?: { id: string; since: number } | null;
}

/** The languages a call can speak, from the server's status. */
export function callLanguagesOf(status: CallStatusAnswer | null | undefined): CallLanguage[] {
  return status?.languages?.length ? status.languages : ['de', 'en'];
}

export interface CallState {
  active: boolean;
  turn: TurnState;
  language: CallLanguage;
  mode: 'open' | 'hold';
  muted: boolean;
  level: number;
  captions: Caption[];
  status: CallStatusAnswer | null;
  installing: boolean;
  error: string | null;
  /** What the error is about, for the call's title: the microphone was refused, or something else. */
  errorKind: 'mic' | 'other' | null;
  /** Speech end to the first sound of the answer, for the last turn. */
  latencyMs: number | null;
  startedAt: number | null;
  speaking: string | null;
  talk: TalkChoice;
  /** The agent is working on the last request. */
  working: boolean;
  /** The voice chosen per language; none means the language's preferred voice. */
  voices: Partial<Record<CallLanguage, string>>;
  /** How the call hears: Bogen's pick (Parakeet), or Whisper on the graphics card. */
  hear: 'auto' | 'whisper';
  /** The file the call belongs to: requests go there, wherever the person is. */
  fileId: string | null;
  fileName: string | null;
  /** What the agent does right now, in a few words, for the call bar. */
  activity: string | null;
  /** The server stopped answering during the call. */
  reconnecting: boolean;
  /**
   * The last call after it ended: how long it was, where its words are, and the files it changed with their requests.
   * Without a note it goes after a few seconds; with one it stays until the person closes it.
   */
  ended: { at: number; seconds: number; fileId: string | null; fileName: string | null; note: CallNoteFile[] } | null;
  /** The mic is being opened. */
  connecting: boolean;
  /** The call moves to the file the person opens in the editor (on by default). */
  follow: boolean;
  /** The call just moved with the person to another file: for a few seconds the bar names it. */
  followed: { at: number; name: string; runIn: string | null } | null;
  /**
   * The file a run of this call still finishes in, by name, when the call has moved on from it. That run is not a
   * second agent of the call: it ends there, and what is asked now goes to the call's file after it.
   */
  runFile: string | null;
  /** What the person asked of the voice for good, as kept on this computer. Null before it was read. */
  preferences: StoredCallPreference[] | null;
}

/** One file the call worked in, with the requests that ran there: the call's end note. */
export interface CallNoteFile { fileId: string; fileName: string; runs: { title: string; status: 'done' | 'failed' | 'stopped' | 'running' }[] }

const LANGUAGE_KEY = 'bogen-call-language';
const TALK_KEY = 'bogen-call-talk';
const VOICE_KEY = 'bogen-call-voice';
const HEAR_KEY = 'bogen-call-hear';
const FOLLOW_KEY = 'bogen-call-follow';

function storedVoices(): Partial<Record<CallLanguage, string>> {
  try {
    const v = JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([k, id]) => (k === 'de' || k === 'en') && typeof id === 'string')) as Partial<Record<CallLanguage, string>>;
  } catch { return {}; }
}

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key); if (v && (allowed as readonly string[]).includes(v)) return v as T; } catch { /* default */ }
  return fallback;
}

let state: CallState = {
  active: false, turn: 'ended', language: stored(LANGUAGE_KEY, ['de', 'en'], navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en'),
  mode: 'open', muted: false, level: 0, captions: [], status: null, installing: false, error: null, errorKind: null, latencyMs: null, startedAt: null,
  speaking: null, talk: stored(TALK_KEY, ['auto', 'local', 'claude', 'claude-sonnet', 'claude-opus', 'rules'], 'auto'), working: false, voices: storedVoices(), hear: stored(HEAR_KEY, ['auto', 'whisper'], 'auto'),
  fileId: null, fileName: null, activity: null, reconnecting: false, ended: null, connecting: false,
  follow: stored(FOLLOW_KEY, ['on', 'off'], 'on') === 'on', followed: null, runFile: null, preferences: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<CallState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export function callState(): CallState { return state; }
// A narrow door for UI captures and tests: puts the call in a given state without a microphone. Nothing in the app uses it.
// `utter` is the microphone hearing someone speak for `ms` (a stretch of silence, which the test's listening answers).
if (typeof window !== 'undefined') {
  (window as unknown as { __bogenCall?: unknown }).__bogenCall = {
    set: (patch: Partial<CallState>) => set(patch),
    get: () => state,
    utter: (ms = 900) => {
      if (!mic) return false;
      micStart();
      micEnd(encodeWav16k([new Float32Array(Math.round(16 * ms))], 16000), ms);
      return true;
    },
  };
}
export function useCall<T>(pick: (s: CallState) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => pick(state));
}

function event(e: TurnEvent): void {
  const r = turn(state.turn, e);
  if (r.state !== state.turn) set({ turn: r.state });
}

function caption(c: Omit<Caption, 'at'>): void {
  set({ captions: [...state.captions, { ...c, at: Date.now() }].slice(-40) });
}

// ---------------------------------------------------------------- the voice

/**
 * The call's one voice. Lines are said one after the other by a single loop: a line that comes while the one before is
 * still being made (the talking layer's first sentence, then the rest a few milliseconds later) waits its turn. Two
 * loops would play two lines over each other, which sounds like two agents talking at once.
 */
class Voice {
  private queue: { text: string; audio: Promise<Blob> }[] = [];
  private playing: HTMLAudioElement | null = null;
  private url: string | null = null;
  private generation = 0;
  /** The loop is on: a line is being made or played. */
  private looping = false;
  /** Ends the wait for the line playing now, when the voice is stopped. */
  private release: (() => void) | null = null;
  private ducked = false;
  waitingSince: number | null = null;
  private cache = new Map<string, Promise<Blob>>();

  private fetch(text: string, language: CallLanguage): Promise<Blob> {
    const chosen = chosenVoice(language);
    const key = `${language}:${chosen ?? ''}:${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const got = fetch('/api/call/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language, ...(chosen ? { voice: chosen } : {}) }) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `The voice answered ${r.status}.`); return r.blob(); });
    if (text.length < 60) { this.cache.set(key, got); got.catch(() => this.cache.delete(key)); }
    return got;
  }

  warm(texts: string[], language: CallLanguage): void { for (const t of texts) void this.fetch(t, language).catch(() => undefined); }

  say(text: string, language: CallLanguage): void {
    if (!text) return;
    // Made at once, so the next line is ready when this one ends; played only after it.
    this.queue.push({ text, audio: this.fetch(text, language) });
    if (!this.looping) void this.run(this.generation);
  }

  get busy(): boolean { return this.looping || Boolean(this.playing) || this.queue.length > 0; }

  stop(): void {
    this.generation++;
    this.queue = [];
    this.looping = false;
    if (this.playing) { this.playing.pause(); this.playing = null; }
    this.release?.();
    this.release = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.ducked = false;
    mic?.agentSpeakingOff();
    set({ speaking: null });
    brain?.voiceEnd();
  }

  /** Quieter while the person makes a sound over it; back up if it was only a "mhm". */
  duck(on: boolean): void {
    this.ducked = on;
    if (this.playing) this.playing.volume = on ? 0.25 : 1;
  }

  private async run(gen: number): Promise<void> {
    this.looping = true;
    while (gen === this.generation) {
      const item = this.queue.shift();
      if (!item) break;
      await this.play(item, gen);
    }
    if (gen === this.generation) this.looping = false;
  }

  private async play(item: { text: string; audio: Promise<Blob> }, gen: number): Promise<void> {
    let blob: Blob;
    try { blob = await item.audio; } catch (err) { if (gen === this.generation) set({ error: (err as Error).message }); return; }
    if (gen !== this.generation) return;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    const audio = new Audio(this.url);
    audio.volume = this.ducked ? 0.25 : 1;
    this.playing = audio;
    mic?.agentSpeakingOn();
    set({ speaking: item.text });
    brain?.voiceStart();
    audio.onplaying = () => {
      if (this.waitingSince) { set({ latencyMs: Math.round(performance.now() - this.waitingSince) }); this.waitingSince = null; }
    };
    event({ t: 'voice-start' });
    await new Promise<void>((resolve) => {
      let over = false;
      const done = () => { if (over) return; over = true; if (this.release === done) this.release = null; resolve(); };
      this.release = done;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
    if (gen !== this.generation) return;
    this.playing = null;
    mic?.agentSpeakingOff();
    set({ speaking: null });
    if (!this.queue.length) brain?.voiceEnd();
    event({ t: 'voice-end', queued: this.queue.length > 0 });
  }
}

const voice = new Voice();
setVoiceBusy(() => voice.busy);

/** One soft two-note sound: still working. Made here, so there is no file to ship. */
function earcon(): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    for (const [freq, at] of [[660, 0], [880, 0.14]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.3);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch { /* no audio */ }
}

// ---------------------------------------------------------------- the mic and the brain

class CallMic extends Mic {
  agentSpeakingOn(): void { this.agentSpeaking = true; }
  agentSpeakingOff(): void { this.agentSpeaking = false; }
}
let mic: CallMic | null = null;
let brain: CallBrain | null = null;
let ticker: number | null = null;

/** Whether the person has the call's own file open right now. */
function inCallFile(): boolean {
  // The editor's store keeps the last file after leaving it, so the address says whether its editor is up.
  return Boolean(state.fileId) && editor().fileId === state.fileId && location.hash.startsWith(`#/file/${state.fileId}`);
}

/** The call's file, and the page and selection when the person is in it, so the server can say what is on screen. */
function where(): { fileId?: string; pageId?: string; selection: string[] } {
  const s = editor();
  const here = inCallFile();
  return { ...(state.fileId ? { fileId: state.fileId } : {}), ...(here && s.pageId ? { pageId: s.pageId } : {}), selection: here ? s.selection.slice(0, 12) : [] };
}

/** What is on screen, by name, for the voice's own answers ("which design?") before any request leaves this tab. */
function screen(): { file?: string; page?: string; boards?: string[]; selection?: string[] } {
  const s = editor();
  if (!inCallFile()) return state.fileName ? { file: state.fileName } : {};
  const doc = maybeSession()?.doc;
  if (!doc) return s.fileName ? { file: s.fileName } : {};
  const pages = doc.getPages();
  const page = pages.find((p) => p.id === s.pageId) ?? pages[0];
  const boards = page ? doc.getChildren(page.id).map((n) => n.name).filter(Boolean).slice(0, 24) : [];
  const selection = s.selection.slice(0, 12).flatMap((id) => { const n = doc.getNode(id); return n?.name ? [n.name] : []; });
  return { ...(s.fileName ? { file: s.fileName } : {}), ...(page ? { page: page.name } : {}), ...(boards.length ? { boards } : {}), ...(selection.length ? { selection } : {}) };
}

async function persona(req: PersonaRequest, signal: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): Promise<string | null> {
  if (state.talk === 'rules') return null;
  const stream = onText ? 'text' : Boolean(onFirst);
  const r = await fetch('/api/call/talk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req, ...where(), choice: state.talk, stream }), signal });
  if (!r.ok) return null;
  if ((!onFirst && !onText) || !r.body) return ((await r.json()) as { text?: string | null }).text ?? null;
  // The first piece to speak (or, for `text`, everything written so far) comes on lines of its own as it is written;
  // the whole answer on the last line.
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let text: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const o = JSON.parse(line) as { first?: string; soFar?: string; text?: string | null };
        if (typeof o.first === 'string') onFirst?.(o.first);
        else if (typeof o.soFar === 'string') onText?.(o.soFar);
        else text = o.text ?? null;
      } catch { /* a broken line is skipped */ }
    }
    if (done) break;
  }
  return text;
}

// ---------------------------------------------------------------- the record

let pendingLines: CallLogLine[] = [];
let flushTimer: number | null = null;

/** Keeps every heard and spoken line with the chat, a few at a time, so a call can be looked at afterwards. */
function logLine(line: CallLogLine): void {
  // A line the call held back (it would only repeat itself) or a turn it only listened to was never spoken.
  if (line.kind === 'held' || line.kind === 'listen') return;
  pendingLines.push(line);
  if (flushTimer === null) flushTimer = window.setTimeout(flushLines, 1500);
}

function flushLines(): void {
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = null;
  const fileId = state.fileId;
  const lines = pendingLines;
  pendingLines = [];
  if (!fileId || !lines.length) return;
  void fetch('/api/call/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, conversationId: conversationFor(fileId), lines }) }).catch(() => undefined);
}

/** The microphone heard someone start speaking. */
function micStart(): void { brain?.speechStart(); event({ t: 'speech-start' }); }
/** A stretch of speech ended: it is heard. */
function micEnd(wav: Blob, ms: number): void { brain?.speechEnd(); event({ t: 'speech-end' }); void transcribe(wav, ms); }

function makeBrain(): CallBrain {
  const talker = state.talk === 'auto' ? state.status?.talk.auto : state.talk;
  return new CallBrain({
    language: state.language,
    now: () => performance.now(),
    persona,
    // Claude Code answers in about 1.3 to 2 s; a local model in a few hundred ms.
    timing: talker?.startsWith('claude') ? { routeTimeoutMs: 2600 } : {},
    // With Claude Code the talking layer decides and words every turn; a small local model is not good enough for
    // that, and the rules decide with it.
    turnModel: Boolean(talker?.startsWith('claude')),
    // The short "Okay." at the end of a clear request is a cached clip, so the first sound comes at once.
    instantAck: Boolean(talker?.startsWith('claude')),
    sinks: {
      say: (text, kind, language) => { caption({ who: 'agent', text, kind }); voice.say(text, language); },
      send: (text, language, meta) => void send(text, language, meta),
      steer: (text, language, meta) => void steer(text, language, meta),
      command: (command, language, opts) => obey(command, language, opts?.quiet),
      stopVoice: () => voice.stop(),
      duck: (on) => voice.duck(on),
      earcon,
      heard: (text) => caption({ who: 'you', text }),
      log: logLine,
      screen,
      switchTo,
      summary: saveNotes,
      remember: (p) => void rememberPreference(p),
      findBrand,
      languages: () => callLanguagesOf(state.status),
      setLanguage: (language) => {
        if (!state.status?.ready[language]) return false;
        setCallLanguage(language);
        return true;
      },
    },
  });
}

/** The call's notes on itself go with the chat of its file, for later calls about it. */
function saveNotes(summary: string): void {
  const fileId = state.fileId;
  if (!fileId) return;
  void fetch('/api/call/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, conversationId: conversationFor(fileId), lines: [], summary }) }).catch(() => undefined);
}

/** A brand by the name the person said, found among this computer's brands. */
async function findBrand(said: string): Promise<{ kind: 'found'; id: string; name: string } | { kind: 'ambiguous'; names: string[] } | { kind: 'none' }> {
  const r = await fetch('/api/call/resolve-brand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ said }) });
  if (!r.ok) return { kind: 'none' };
  const body = await r.json() as { match?: { id: string; name: string }; ambiguous?: { id: string; name: string }[] };
  if (body.ambiguous?.length) return { kind: 'ambiguous', names: body.ambiguous.map((b) => b.name) };
  return body.match ? { kind: 'found', id: body.match.id, name: body.match.name } : { kind: 'none' };
}

// ---------------------------------------------------------------- what the call remembers

/** Reads what the person asked of the voice for good. */
export async function loadPreferences(): Promise<StoredCallPreference[]> {
  try {
    const r = await fetch('/api/call/preferences');
    if (!r.ok) throw new Error(String(r.status));
    const { items } = await r.json() as { items: StoredCallPreference[] };
    set({ preferences: items });
    return items;
  } catch {
    if (!state.preferences) set({ preferences: [] });
    return state.preferences ?? [];
  }
}

async function rememberPreference(p: CallPreference): Promise<void> {
  try {
    const r = await fetch('/api/call/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    if (r.ok) set({ preferences: ((await r.json()) as { items: StoredCallPreference[] }).items });
  } catch { /* kept for this call only */ }
}

/** Forgets one preference, or all of them; a call going on talks as before it was said. */
export async function forgetPreference(id?: string): Promise<void> {
  const r = await fetch(`/api/call/preferences${id ? `/${encodeURIComponent(id)}` : ''}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Forgetting answered ${r.status}.`);
  const items = ((await r.json()) as { items: StoredCallPreference[] }).items;
  set({ preferences: items });
  brain?.setMaxWords(wordsFor(items, CALL_TIMING.maxWords));
  brain?.setQuiet(items.some((p) => p.kind === 'quiet'));
}

/** Whether the call moves to the file the person opens. */
export function setFollow(on: boolean): void {
  try { localStorage.setItem(FOLLOW_KEY, on ? 'on' : 'off'); } catch { /* per session */ }
  set({ follow: on });
}

// ---------------------------------------------------------------- moving with the person

/** The file whose editor the address shows, or null (home, a preview, settings). */
function routeFile(): string | null {
  return /^#\/file\/([\w-]+)(?!\/preview)/.exec(location.hash)?.[1] ?? null;
}

/** The file seen last in the address during this call, and one the person opened that the call has not moved to yet. */
const seen: { file: string | null; pending: { id: string; since: number } | null } = { file: null, pending: null };
/** How long the person stays in a file before the call moves there: flicking through tabs moves nothing. */
const FOLLOW_SETTLE_MS = 1200;
/** How long the bar names the file the call moved to. */
const FOLLOWED_SHOW_MS = 5000;
let followedTimer: number | null = null;

/**
 * Called on every tick of the call: when the person opened another file in the editor and stayed there, the call
 * goes with them. Not while a request is being said (it would be dropped); then it moves once that went out.
 */
function followEditor(): void {
  const now = performance.now();
  const file = routeFile();
  if (file !== seen.file) {
    seen.file = file;
    seen.pending = file && file !== state.fileId ? { id: file, since: now } : null;
  }
  const want = seen.pending;
  if (!want || !state.follow || !state.active || !brain || state.connecting) return;
  if (want.id === state.fileId) { seen.pending = null; return; }
  if (now - want.since < FOLLOW_SETTLE_MS || brain.busy) return;
  const s = editor();
  if (s.fileId !== want.id) return;
  seen.pending = null;
  moveTo({ id: want.id, name: s.fileName || want.id }, true);
}

/** Moves the call to another file. What was said goes to the old file's chat first; a run going there finishes there. */
function moveTo(found: { id: string; name: string }, followed: boolean): void {
  flushLines();
  const from = state.fileName;
  pieces.pieces = []; pieces.parts = 0; pieces.ms = 0;
  // A run of the call working in another file finishes there; back in its file, it is the call's run again.
  const runIn = tracked.active && tracked.fileId && tracked.fileId !== found.id ? tracked.fileName || from : null;
  set({ fileId: found.id, fileName: found.name, runFile: runIn, ...(followed ? { followed: { at: Date.now(), name: found.name, runIn } } : {}) });
  brain?.refocus(found.name, from);
  if (!followed) return;
  // A tone and the bar, no spoken line: the person chose the file, the voice need not say so.
  playSound('moved');
  if (followedTimer !== null) window.clearTimeout(followedTimer);
  followedTimer = window.setTimeout(() => { followedTimer = null; set({ followed: null }); }, FOLLOWED_SHOW_MS);
}

/**
 * Moves the call to another file: the one the person named (found on the server, never created or guessed), or the
 * one in front of them. What was said goes to the old file's chat first; a run going there finishes there.
 */
async function switchTo(target: string): Promise<SwitchResult> {
  let found: { id: string; name: string } | null = null;
  if (target === 'here') {
    const s = editor();
    if (!s.fileId) return { kind: 'none' };
    found = { id: s.fileId, name: s.fileName || state.fileName || '' };
  } else {
    const r = await fetch('/api/call/resolve-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ said: target }) });
    if (!r.ok) return { kind: 'none' };
    const body = await r.json() as { match?: { id: string; name: string }; ambiguous?: { id: string; name: string }[] };
    if (body.ambiguous?.length) return { kind: 'ambiguous', names: body.ambiguous.map((f) => f.name) };
    if (!body.match) return { kind: 'none' };
    found = body.match;
  }
  if (found.id === state.fileId) return { kind: 'same', name: found.name };
  // The person said where the call goes: a file opened a moment ago does not take it somewhere else 1.2 s later.
  seen.file = routeFile();
  seen.pending = null;
  moveTo(found, false);
  return { kind: 'switched', name: found.name };
}

/**
 * The pieces of the turn being said: when the person pauses mid-sentence the microphone cuts there, and the turn's
 * earlier pieces are heard again together with the next one, as one stretch. An engine that hears "Arbeitet der
 * Agent" and "gerade noch?" apart guesses at both halves; heard together it gets the sentence.
 */
const pieces = { pieces: [] as Blob[], parts: 0, ms: 0, hearing: 0 };
/** Longer than this, a turn is not heard again as a whole: the engines take 30 s at most. */
const TURN_AUDIO_MAX_MS = 25_000;
const PIECE_GAP_MS = 250;

/** WAVs of 16 kHz mono 16-bit, one after the other with a short silence between, as one WAV. */
async function joinWavs(wavs: Blob[]): Promise<Blob> {
  const bodies = await Promise.all(wavs.map(async (w) => new Uint8Array(await w.arrayBuffer()).subarray(44)));
  const gap = new Uint8Array(Math.round((PIECE_GAP_MS / 1000) * 16000) * 2);
  const parts = bodies.flatMap((b, i) => (i ? [gap, b] : [b]));
  const size = parts.reduce((n, p) => n + p.length, 0);
  const header = new Uint8Array(await wavs[0]!.slice(0, 44).arrayBuffer());
  const d = new DataView(header.buffer);
  d.setUint32(4, 36 + size, true);
  d.setUint32(40, size, true);
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

async function transcribe(wav: Blob, ms: number): Promise<void> {
  voice.waitingSince = performance.now();
  let text = '';
  let meta: { engine?: string; speechMs?: number; dropped?: NoiseReason; replaces?: number } = {};
  // The turn's earlier pieces go along when the brain still holds them as its open parts, and none is still out.
  const open = brain?.openParts ?? 0;
  if (open === 0 || open !== pieces.parts || pieces.hearing > 0) { pieces.pieces = []; pieces.parts = 0; pieces.ms = 0; }
  const together = pieces.pieces.length > 0 && pieces.ms + ms <= TURN_AUDIO_MAX_MS;
  const replaces = together ? pieces.parts : 0;
  pieces.hearing++;
  try {
    const w = where();
    const audio = together ? await joinWavs([...pieces.pieces, wav]) : wav;
    const q = new URLSearchParams({ language: state.language, ...(w.fileId ? { fileId: w.fileId } : {}), ...(w.pageId ? { pageId: w.pageId } : {}), ...(state.hear === 'whisper' ? { engine: 'whisper' } : {}) });
    const r = await fetch(`/api/call/listen?${q}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio });
    const body = await r.json() as { text?: string; error?: string; engine?: string; speechMs?: number; dropped?: NoiseReason; heard?: string };
    if (!r.ok) throw new Error(body.error ?? `Listening answered ${r.status}.`);
    text = (body.text ?? '').trim();
    meta = { ...(body.engine ? { engine: body.engine } : {}), ...(typeof body.speechMs === 'number' ? { speechMs: body.speechMs } : {}), ...(body.dropped ? { dropped: body.dropped } : {}) };
    // A stretch taken for noise comes back without words; what Whisper wrote anyway goes to the record, not the call.
    if (body.dropped && body.heard) text = body.heard.trim();
  } catch (err) {
    set({ error: (err as Error).message });
  }
  pieces.hearing--;
  event({ t: 'transcribed', empty: !text || Boolean(meta.dropped) });
  const before = brain?.openParts ?? 0;
  brain?.segment(text, ms, { ...meta, ...(replaces && text && !meta.dropped ? { replaces } : {}) });
  const after = brain?.openParts ?? 0;
  // The pieces kept must cover exactly the brain's open parts, or the next piece must not replace them.
  const reset = () => { pieces.pieces = []; pieces.parts = 0; pieces.ms = 0; };
  const took = Boolean(text) && !meta.dropped && after > 0;
  if (!took) { if (after === 0) reset(); return; }
  if (together) { pieces.pieces.push(wav); pieces.ms += ms; pieces.parts = after; }
  else if (before === 0) { pieces.pieces = [wav]; pieces.ms = ms; pieces.parts = after; }
  else reset();
}

/** A brief to the agent. The chat shows what the person asked for; the agent gets the whole brief. */
async function send(text: string, language: CallLanguage, meta?: SendMeta, steering = false): Promise<void> {
  // The request belongs to the file the call is in as it is sent, also when the call moves while the runner is looked up.
  const fileId = state.fileId;
  const fileName = state.fileName;
  const runner = await chosenRunner();
  if (!runner) {
    const de = state.language === 'de';
    const line = de ? 'Ich finde keinen Agenten auf diesem Computer.' : 'I cannot find an agent on this computer.';
    caption({ who: 'agent', text: line });
    voice.say(line, state.language);
    return;
  }
  if (!fileId) {
    sayRule('Öffne zuerst ein Design, dann mache ich das.', 'Open a design first, then I will do that.', language);
    return;
  }
  nextTitle = (meta?.title || meta?.display || text).replace(/\s+/g, ' ').trim().slice(0, 120);
  beginRun(fileId, fileName);
  const call = { language, ...(steering ? { steer: true } : {}) };
  if (inCallFile() && state.fileId === fileId) {
    // In the file, the message shows in its chat as if typed, and the editor follows the run as always.
    await sendPrompt(text, runner, { call, ...(meta?.title ? { title: meta.title } : {}), ...(meta?.size ? { size: meta.size } : {}) }, meta?.display ? { display: meta.display } : {});
    const s = editor();
    if (s.fileId === fileId && s.prompt.runId) adopt(s.prompt.runId);
    else if (s.fileId === fileId && !s.prompt.running) void finishRun();
    return;
  }
  // Elsewhere, straight to the server: the chat of that file shows it when the person goes back.
  try {
    const { runId } = await api.startRun({ fileId, nodeIds: [], prompt: text, runner, conversationId: conversationFor(fileId), call, ...(meta?.title ? { title: meta.title } : {}), ...(meta?.size ? { size: meta.size } : {}) });
    adopt(runId);
  } catch (err) {
    tracked.texts.push((err as Error).message);
    tracked.failed = true;
    void finishRun();
  }
}

// ---------------------------------------------------------------- following the agent

/**
 * The run the call waits for, followed through the server's events for the call's file, so that it is followed
 * from home or from another file too. A run the person types in that file's chat during the call is followed as well.
 */
const tracked: { active: boolean; fileId: string | null; fileName: string | null; runId: string | null; lastRunId: string | null; texts: string[]; failed: boolean } = { active: false, fileId: null, fileName: null, runId: null, lastRunId: null, texts: [], failed: false };

/** The requests of this call, in order, with the file each ran in: what the end note lists. */
let callRuns: { fileId: string; fileName: string; runId: string; title: string; status: CallNoteFile['runs'][number]['status'] }[] = [];
/** The title of the request being sent, until its run has an id. */
let nextTitle: string | null = null;
/** Events of a run whose id the call does not know yet: its request may still be on the way back. */
const early = new Map<string, Extract<ServerEvent, { t: 'agent' }>[]>();

/** Bumped when a run begins, so that a wait for an older run's real end lapses. */
let finishToken = 0;

interface ServerRun { id: string; status: string; result?: string; title?: string; prompt?: string }

/** The server's record of a run of the call's file: the truth about whether it still runs, and what it answered. */
async function serverRun(runId: string): Promise<ServerRun | null> {
  const fileId = tracked.fileId ?? state.fileId;
  if (!fileId) return null;
  try {
    const r = await fetch(`/api/runs?fileId=${encodeURIComponent(fileId)}`);
    if (!r.ok) return null;
    return ((await r.json()) as ServerRun[]).find((x) => x.id === runId) ?? null;
  } catch {
    return null;
  }
}

function beginRun(fileId = state.fileId, fileName = state.fileName): void {
  if (tracked.active) return;
  finishToken++;
  tracked.active = true;
  // The run stays bound to the file it started in, also when the call moves to another one meanwhile.
  tracked.fileId = fileId;
  tracked.fileName = fileName;
  tracked.runId = null;
  tracked.texts = [];
  tracked.failed = false;
  early.clear();
  brain?.agentStart();
  set({ working: true, activity: null, runFile: null });
  event({ t: 'working' });
}

function adopt(runId: string): void {
  if (!tracked.active) beginRun();
  tracked.runId = runId;
  tracked.lastRunId = runId;
  if (tracked.fileId && !callRuns.some((r) => r.runId === runId)) {
    callRuns.push({ fileId: tracked.fileId, fileName: tracked.fileName ?? '', runId, title: nextTitle ?? '', status: 'running' });
  }
  nextTitle = null;
  const waiting = early.get(runId) ?? [];
  early.clear();
  for (const e of waiting) runEvent(e);
}

/**
 * The run ended, as an event or the chat says. The call believes the server's record: a turn that ended in an error
 * inside a longer run, or a design-review repair turn, is not the end, and the voice must not say "nothing is
 * running" meanwhile. The answer spoken is the server's when the call's own copy of the run's words is shorter.
 */
async function finishRun(): Promise<void> {
  if (!tracked.active) return;
  const token = finishToken;
  const runId = tracked.runId ?? tracked.lastRunId;
  let record = runId && !(brain?.steeringRun ?? false) ? await serverRun(runId) : null;
  while (record?.status === 'running' && token === finishToken && state.active) {
    await new Promise((r) => window.setTimeout(r, 1500));
    record = await serverRun(runId!);
  }
  if (token !== finishToken || !tracked.active) return;
  const own = tracked.texts.join('\n\n');
  const text = record?.result && record.result.length > own.length ? record.result : own || record?.result || '';
  const ok = record ? record.status !== 'failed' : !tracked.failed;
  noteRun(runId, record, ok);
  tracked.active = false;
  tracked.runId = null;
  tracked.texts = [];
  tracked.failed = false;
  set({ working: false, activity: null, runFile: null });
  // Everything the agent wrote in this run goes to the talking layer, which says what it means; the text itself
  // stays in the chat.
  void brain?.agentFinish(text, ok).then(() => event({ t: 'idle' }));
}

/** How a run of this call ended, for the end note. A run stopped to take the person's change goes on as the next one. */
function noteRun(runId: string | null, record: ServerRun | null, ok: boolean): void {
  const entry = runId ? callRuns.find((r) => r.runId === runId) : undefined;
  if (!entry) return;
  if (brain?.steeringRun) { callRuns = callRuns.filter((r) => r !== entry); return; }
  const status = record?.status;
  entry.status = status === 'stopped' || status === 'interrupted' ? 'stopped' : status === 'failed' || !ok ? 'failed' : 'done';
  if (!entry.title) entry.title = (record?.title || record?.prompt || '').replace(/^\[Voice call[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** The call's requests by file, in the order the files were first worked in. */
export function callNote(runs: typeof callRuns): CallNoteFile[] {
  const files: CallNoteFile[] = [];
  for (const r of runs) {
    let f = files.find((x) => x.fileId === r.fileId);
    if (!f) { f = { fileId: r.fileId, fileName: r.fileName, runs: [] }; files.push(f); }
    f.runs.push({ title: r.title, status: r.status });
  }
  return files;
}

/** The end note as one written line for the record kept with each file's chat. */
function noteLine(file: CallNoteFile, seconds: number, language: CallLanguage): string {
  const de = language === 'de';
  const word = (s: CallNoteFile['runs'][number]['status']) => s === 'done' ? '' : de ? (s === 'stopped' ? 'gestoppt: ' : s === 'failed' ? 'nicht geklappt: ' : 'läuft noch: ') : (s === 'stopped' ? 'stopped: ' : s === 'failed' ? 'failed: ' : 'still running: ');
  const runs = file.runs.map((r) => `${word(r.status)}${r.title || (de ? 'eine Anfrage' : 'a request')}`).join('; ');
  const length = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return de ? `Anruf beendet nach ${length}. In dieser Datei: ${runs}.` : `Call ended after ${length}. In this file: ${runs}.`;
}

/** A tool's name in a few words, for the bar: `mcp__bogen__html_write` is "Drawing". */
export function describeTool(tool: string | undefined): string | null {
  if (!tool) return null;
  const name = tool.replace(/^mcp__[a-z0-9-]+__/i, '');
  const words: Record<string, string> = {
    html_write: msg('Drawing'), layer_style: msg('Changing styles'), layer_text: msg('Changing text'), canvas_screenshot: msg('Looking at the result'),
    design_lint: msg('Checking the design'), a11y_audit: msg('Checking accessibility'), design_verify: msg('Checking its work'), layer_tree: msg('Reading the layers'),
    layer_get: msg('Reading the layers'), layer_find: msg('Looking for layers'), tokens_get: msg('Reading the tokens'), brand_get: msg('Reading the brand'),
    artboard_create: msg('Making a screen'), component_create: msg('Making a component'), layer_delete: msg('Removing layers'), comment_reply: msg('Answering'),
  };
  return words[name] ?? name.replace(/_/g, ' ');
}

function runEvent(e: Extract<ServerEvent, { t: 'agent' }>): void {
  if (e.kind === 'tool') {
    brain?.agentActivity(`tool:${e.tool ?? e.text ?? ''}`);
    set({ activity: describeTool(e.tool ?? e.text) });
  } else if (e.kind === 'text' && e.text) {
    tracked.texts.push(e.text);
    brain?.agentActivity(e.text);
  } else if (e.kind === 'error') {
    tracked.failed = true;
    tracked.texts.push(e.text ?? 'The run failed.');
    void finishRun();
  } else if (e.kind === 'done') void finishRun();
}

function onCallEvent(e: ServerEvent): void {
  // What the running agent changed, by layer name, for "what is it working on?".
  if (e.t === 'activity' && state.active && tracked.active && e.runId && e.runId === tracked.runId) {
    const doc = inCallFile() ? maybeSession()?.doc : null;
    if (doc) brain?.agentTouched(e.nodeIds.slice(0, 12).flatMap((id) => { const n = doc.getNode(id); return n?.name ? [n.name] : []; }));
    return;
  }
  // The run this call follows is in the file it started in, which may not be the call's file any more.
  if (e.t !== 'agent' || !state.active || e.fileId !== (tracked.active && tracked.fileId ? tracked.fileId : state.fileId)) return;
  if (tracked.runId === e.runId) return runEvent(e);
  if (tracked.active && !tracked.runId) {
    // Ours, most likely, before its id came back: kept until it does.
    const list = early.get(e.runId) ?? [];
    list.push(e);
    early.set(e.runId, list);
    return;
  }
  // A run the person started in the file's chat while the call is on.
  const s = editor();
  if (!tracked.active && s.fileId === state.fileId && s.prompt.runId === e.runId) {
    adopt(e.runId);
    runEvent(e);
  }
}

// ---------------------------------------------------------------- steering a run

let steerNext: { text: string; meta?: SendMeta } | null = null;
let steeringNow = false;

function until(done: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (done()) return resolve(true);
      if (performance.now() - started > timeoutMs) return resolve(false);
      window.setTimeout(check, 50);
    };
    check();
  });
}

/**
 * A change the person made while the agent works: the run's turn is ended the way Ctrl+C does (what it changed
 * stays), and the brief goes as the next message in the same Claude Code session, so the agent carries on with what
 * it knew. A later brief said while the run is being stopped replaces this one (the brain already joined them).
 */
async function steer(text: string, language: CallLanguage, meta?: SendMeta): Promise<void> {
  steerNext = { text, ...(meta ? { meta } : {}) };
  if (steeringNow) return;
  steeringNow = true;
  try {
    if (tracked.active) {
      // A run that has only just started has no id to stop yet.
      await until(() => Boolean(tracked.runId) || !tracked.active, 5000);
      if (tracked.active && tracked.runId) void api.stopRun(tracked.runId, true);
      await until(() => !tracked.active, 20_000);
    }
    const next = steerNext;
    steerNext = null;
    if (next && state.active) await send(next.text, language, next.meta, true);
  } finally {
    steeringNow = false;
    steerNext = null;
  }
}

async function chosenRunner(): Promise<string | null> {
  let saved: string | null = null;
  try { saved = localStorage.getItem('bogen-prompt-runner'); } catch { /* none */ }
  if (saved) return saved;
  const list = await api.runners().catch(() => []);
  return list.find((r) => r.available)?.id ?? null;
}

function sayRule(de: string, en: string, language: CallLanguage): void {
  const text = language === 'de' ? de : en;
  caption({ who: 'agent', text, kind: 'command' });
  voice.say(text, language);
}

/** `quiet`: the talking layer says its own words for the command. */
function obey(command: CallCommand, language: CallLanguage, quiet = false): void {
  if (command === 'stop') {
    voice.stop();
    if (tracked.active && tracked.runId) void api.stopRun(tracked.runId);
    if (!quiet) sayRule('Okay, ich höre auf.', 'Okay, stopping.', language);
  } else if (command === 'undo') {
    voice.stop();
    const runId = tracked.lastRunId ?? (inCallFile() ? [...editor().prompt.messages].reverse().find((x) => x.runId)?.runId : undefined);
    const fileId = state.fileId;
    if (!runId || !fileId) { sayRule('Ich habe noch nichts geändert.', 'I have not changed anything yet.', language); return; }
    void collabApi.undoRun(fileId, runId, loadUser().name).then(
      () => sayRule('Erledigt, ich habe es zurückgenommen.', 'Done, I took it back.', language),
      () => sayRule('Das konnte ich nicht zurücknehmen.', 'I could not take that back.', language),
    );
  } else if (command === 'hangup') endCall();
  else if (command === 'mute') setMuted(true);
  else if (command === 'repeat') {
    const last = [...state.captions].reverse().find((c) => c.who === 'agent');
    if (last) voice.say(last.text, language);
  }
}

// ---------------------------------------------------------------- the call

export async function refreshCallStatus(): Promise<CallStatusAnswer | null> {
  try {
    const r = await fetch('/api/call/status');
    if (!r.ok) throw new Error(`${r.status}`);
    const status = await r.json() as CallStatusAnswer;
    // A language the call does not speak here (German for now) falls back to one it does, for this session only.
    const offered = callLanguagesOf(status);
    set(offered.includes(state.language) ? { status } : { status, language: offered[0]! });
    if (brain && !offered.includes(brain.language)) brain.language = offered[0]!;
    return status;
  } catch {
    set({ status: null });
    return null;
  }
}

async function install(what: string): Promise<void> {
  const r = await fetch('/api/call/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Download answered ${r.status}.`);
  set({ status: await r.json() as CallStatusAnswer });
}

/** Downloads what the call language still needs: its voice and the listening model, and the talking model if asked. */
export async function installForCall(language: CallLanguage, withTalkModel = false): Promise<void> {
  const status = state.status ?? await refreshCallStatus();
  if (!status) return;
  set({ installing: true, error: null });
  try {
    const wanted = state.voices[language];
    const voice = status.voices.find((v) => v.language === language && (wanted ? v.id === wanted : v.preferred));
    const needs = [...(status.listen.installed ? [] : ['listen']), ...(voice && !voice.installed ? [voice.id] : [])];
    const model = status.talk.models.find((m) => m.recommended);
    if (withTalkModel && model && !model.installed) needs.push(`talk:${model.id}`);
    for (const what of needs) await install(what);
  } catch (err) {
    set({ error: (err as Error).message });
  } finally {
    set({ installing: false });
  }
}

// ---------------------------------------------------------------- one call per browser

/**
 * One call per browser profile. Every Bogen window of the browser runs this file (the tabs inside one window share it,
 * and a file loaded behind another tab has no call of its own), so a second window could open a second microphone
 * and a second voice. A call that opens says so to the other windows, and a window with an older call hands it on:
 * it ends quietly, without closing the server's talking layer that the new call uses. The newest call wins.
 */
const CALL_CHANNEL = 'bogen-call';
let callId: string | null = null;
let callSince = 0;
const calls: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CALL_CHANNEL);
calls?.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { t?: unknown; id?: unknown; since?: unknown } | null;
  if (m?.t !== 'started' || typeof m.id !== 'string' || typeof m.since !== 'number' || !state.active || !callId || m.id === callId) return;
  // Two calls opened at the same moment: the later id wins, so exactly one is left.
  if (m.since > callSince || (m.since === callSince && m.id > callId)) endCall({ handedOn: true });
});

function newCallId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

let stopDialling: (() => void) | null = null;
let endedTimer: number | null = null;
let stopEvents: (() => void) | null = null;
let stopReach: (() => void) | null = null;
/** A question the voice asks first, when the person answered an agent's call. */
let firstQuestion: string | null = null;

/**
 * Starts a call in the open file, or in `fileId` (an agent's call that the person answered, before its editor is up).
 * One call at a time: a call in another file ends first.
 */
export async function startCall(options: { fileId?: string; fileName?: string; ask?: string } = {}): Promise<void> {
  const s = editor();
  const fileId = options.fileId ?? s.fileId ?? null;
  if (state.active && state.fileId === fileId) return;
  if (state.active) endCall();
  if (s.fileId && s.fileId === fileId && location.hash.startsWith(`#/file/${fileId}`)) setChatOpen(true);
  if (endedTimer !== null) window.clearTimeout(endedTimer);
  firstQuestion = options.ask?.trim() || null;
  callId = newCallId();
  callSince = Date.now();
  set({
    active: true, connecting: true, turn: 'listening', captions: [], error: null, errorKind: null, latencyMs: null, startedAt: Date.now(), muted: false, working: false,
    fileId, fileName: options.fileName ?? (s.fileId === fileId ? s.fileName || null : null), activity: null, reconnecting: false, ended: null, runFile: null,
  });
  // A call in another window of this browser ends: one microphone and one voice.
  calls?.postMessage({ t: 'started', id: callId, since: callSince });
  seen.file = routeFile();
  seen.pending = null;
  callRuns = [];
  stopEvents = onServerEvent(onCallEvent);
  stopReach = onReachableChange(() => { if (state.active) set({ reconnecting: serverReachable() === false }); });
  stopDialling = repeatSound('dialling', 1600);
  const [status, prefs] = await Promise.all([refreshCallStatus(), loadPreferences()]);
  // "Ab jetzt auf Englisch" from an earlier call, when that language can be spoken here.
  const lang = prefs.filter((p) => p.kind === 'language').at(-1)?.value as CallLanguage | undefined;
  if (lang && lang !== state.language && status?.ready[lang]) set({ language: lang });
  if (!status?.ready[state.language]) {
    stopDialling?.();
    stopDialling = null;
    set({ connecting: false });
    return;
  }
  await openMic();
}

async function openMic(): Promise<void> {
  if (mic) return;
  brain = makeBrain();
  brain.setMaxWords(wordsFor(state.preferences ?? [], CALL_TIMING.maxWords));
  brain.setQuiet((state.preferences ?? []).some((p) => p.kind === 'quiet'));
  mic = new CallMic({
    onStart: micStart,
    onEnd: micEnd,
    onLevel: (level) => { if (Math.abs(level - state.level) > 0.04) set({ level }); },
  });
  mic.hold = state.mode === 'hold';
  try {
    await mic.start();
  } catch (err) {
    mic = null;
    brain = null;
    stopDialling?.();
    stopDialling = null;
    playSound('failed');
    const blocked = (err as Error).name === 'NotAllowedError';
    set({ connecting: false, errorKind: blocked ? 'mic' : 'other', error: blocked ? 'The microphone is blocked for Bogen. Allow it in the browser to talk.' : (err as Error).message });
    return;
  }
  stopDialling?.();
  stopDialling = null;
  playSound('connected');
  ticker = window.setInterval(() => { brain?.tick(); followEditor(); }, 100);
  const lang = state.language;
  voice.warm(lang === 'de' ? ['Okay.', 'Mm?', 'Mach ich.', 'Okay, mach ich.', 'Alles klar.', 'Gut, mach ich.', 'Gut.', 'Was genau soll ich ändern?'] : ['Okay.', 'Mm?', 'On it.', 'Okay, doing it.', 'Sure.', 'Got it.', 'Good.', 'What exactly should I change?'], lang);
  void fetch('/api/call/talk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warm: true, choice: state.talk, ...(callId ? { call: callId } : {}) }) }).catch(() => undefined);
  set({ turn: 'listening', connecting: false });
  if (firstQuestion) {
    // The agent called because it needs an answer: the voice asks its question first.
    const question = firstQuestion;
    firstQuestion = null;
    window.setTimeout(() => {
      if (!state.active) return;
      caption({ who: 'agent', text: question });
      logLine({ at: Date.now(), who: 'voice', text: question, kind: 'reply', source: 'rules' });
      voice.say(question, state.language);
    }, 450);
  }
}

export async function continueAfterInstall(): Promise<void> {
  if (state.active && state.status?.ready[state.language]) await openMic();
}

/** `handedOn`: a newer call in another window of this browser took over; the server's call is that one now. */
export function endCall(options: { handedOn?: boolean } = {}): void {
  if (!state.active) return;
  event({ t: 'hangup' });
  voice.stop();
  stopDialling?.();
  stopDialling = null;
  mic?.stop();
  const wasOpen = Boolean(mic);
  mic = null;
  brain?.dispose();
  brain = null;
  if (ticker) window.clearInterval(ticker);
  ticker = null;
  stopEvents?.();
  stopEvents = null;
  stopReach?.();
  stopReach = null;
  tracked.active = false;
  tracked.runId = null;
  early.clear();
  flushLines();
  if (!options.handedOn) void fetch('/api/call/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(callId ? { call: callId } : {}) }).catch(() => undefined);
  callId = null;
  if (wasOpen) playSound('ended');
  const seconds = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  // What the call changed, written down with each file's chat; nothing of it is spoken.
  const note = callNote(callRuns);
  callRuns = [];
  nextTitle = null;
  seen.file = null;
  seen.pending = null;
  for (const f of note) {
    void fetch('/api/call/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: f.fileId, conversationId: conversationFor(f.fileId), lines: [{ at: Date.now(), who: 'voice', kind: 'end-note', text: noteLine(f, seconds, state.language) }] }) }).catch(() => undefined);
  }
  if (followedTimer !== null) window.clearTimeout(followedTimer);
  followedTimer = null;
  set({ active: false, connecting: false, level: 0, speaking: null, startedAt: null, working: false, activity: null, reconnecting: false, followed: null, runFile: null, ended: { at: Date.now(), seconds, fileId: state.fileId, fileName: state.fileName, note } });
  if (endedTimer !== null) window.clearTimeout(endedTimer);
  // With a note of what changed, it stays until the person closes it; without, it goes after a few seconds.
  endedTimer = note.length ? null : window.setTimeout(() => { endedTimer = null; set({ ended: null }); }, 8000);
}

/** Forgets the ended call's note before its time, when the person closes it. */
export function dismissEnded(): void {
  if (endedTimer !== null) window.clearTimeout(endedTimer);
  endedTimer = null;
  set({ ended: null });
}

/** Goes to the call's file, with its chat open where the full call panel is. */
export function backToCall(fileId = state.fileId ?? state.ended?.fileId ?? null): void {
  if (!fileId) return;
  if (editor().fileId === fileId && location.hash.startsWith(`#/file/${fileId}`)) {
    setChatOpen(true);
    return;
  }
  openChatWhenIn(fileId);
  location.hash = `#/file/${fileId}`;
}

/** Opens the chat once the editor of `fileId` is up. */
export function openChatWhenIn(fileId: string, then?: () => void): void {
  let tries = 0;
  const check = () => {
    if (editor().fileId === fileId && location.hash.startsWith(`#/file/${fileId}`)) {
      setChatOpen(true);
      then?.();
      return;
    }
    if (++tries < 100) window.setTimeout(check, 50);
  };
  window.setTimeout(check, 0);
}

export function setMuted(on: boolean): void {
  if (mic) mic.muted = on;
  if (on !== state.muted) playSound(on ? 'mute' : 'unmute');
  set({ muted: on });
  event({ t: 'mute', on });
}

export function setMode(mode: 'open' | 'hold'): void {
  if (mic) mic.hold = mode === 'hold';
  set({ mode });
}

export function holdToTalk(down: boolean): void {
  if (!mic) return;
  if (down) { mic.held = true; voice.stop(); } else mic.release();
}

export function setCallLanguage(language: CallLanguage): void {
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* per session */ }
  set({ language });
  if (brain) brain.language = language;
  if (state.active && state.status?.ready[language]) void openMic();
}

/** The voice that speaks a language: the person's choice if it is downloaded, else the server picks. */
function chosenVoice(language: CallLanguage): string | undefined {
  const id = state.voices[language];
  return id && state.status?.voices.some((v) => v.id === id && v.installed) ? id : undefined;
}

/** Chooses the voice for a language, and downloads it first when it is not here yet. */
export async function setVoice(language: CallLanguage, id: string): Promise<void> {
  const voices = { ...state.voices, [language]: id };
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(voices)); } catch { /* per session */ }
  set({ voices });
  const entry = state.status?.voices.find((v) => v.id === id);
  if (entry && !entry.installed) {
    set({ installing: true, error: null });
    try { await install(id); } catch (err) { set({ error: (err as Error).message }); } finally { set({ installing: false }); }
  }
  voice.warm(language === 'de' ? ['Mach ich.', 'Okay, mach ich.', 'Alles klar.'] : ['On it.', 'Okay, doing it.', 'Sure.'], language);
}

export function setTalk(choice: TalkChoice): void {
  try { localStorage.setItem(TALK_KEY, choice); } catch { /* per session */ }
  set({ talk: choice });
  if (state.active) void fetch('/api/call/talk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warm: true, choice, ...(callId ? { call: callId } : {}) }) }).then(() => refreshCallStatus()).catch(() => undefined);
}

/** Downloads Parakeet, the listening model Bogen uses by default, after the call is set up. */
export async function installHearing(): Promise<void> {
  if (!state.status || state.status.listen.parakeet?.installed) return;
  set({ installing: true, error: null });
  try { await install('listen'); } catch (err) { set({ error: (err as Error).message }); } finally { set({ installing: false }); }
}

/** Chooses how the call hears: Parakeet on this computer, or Whisper on the graphics card. */
export function setHear(hear: 'auto' | 'whisper'): void {
  try { localStorage.setItem(HEAR_KEY, hear); } catch { /* per session */ }
  set({ hear });
}

/** Downloads the talking model for this computer after the call is set up. */
export async function installTalkModel(): Promise<void> {
  const model = state.status?.talk.models.find((m) => m.recommended);
  if (!model || model.installed) return;
  set({ installing: true, error: null });
  try { await install(`talk:${model.id}`); } catch (err) { set({ error: (err as Error).message }); } finally { set({ installing: false }); }
}

export function interruptAgent(): void { voice.stop(); }
