import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync, writeSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { MIN_SPEECH_MS, noiseVerdict, preferenceLine, spokenPart, type BogenDoc, type CallContext, type CallHistoryLine, type CallLanguage, type DraftText, type NoiseReason, type PersonaKind, type PersonaRequest, type RecentRun } from '@bogen/core';
import type { CallLine } from '../conversations.ts';
import { screenContext, type ScreenSource } from './context.ts';
import { findFfmpeg } from '../media.ts';
import { fetchPublic } from '../net-guard.ts';
import { atomicWrite, errorMessage, HttpError } from '../util.ts';
import { cleanTranscript, voiceExtension, VOICE_LIMIT } from '../voice.ts';
import { HEAR_MODEL, LISTEN_MODEL, PARAKEET_MODEL, TALK_MODELS, VAD_MODEL, callLanguages, offeredVoices, voiceFor, type SpeechFile, type TalkModel, type VoiceEntry } from './catalog.ts';
import { ClaudePersona, LocalPersona, type PersonaEngine } from './persona.ts';
import { PiperEngine, TinyVocaEngine, type TtsEngine } from './tts.ts';
import { hearPrompt, hearVariant, pcmOf, ResidentParakeet, ResidentVad, ResidentWhisper } from './hear.ts';
import { CallPreferences, clean as cleanPreference } from './preferences.ts';

/**
 * How a call writes down what the person says: `parakeet` is NVIDIA Parakeet v3 on the CPU (the default, on every
 * computer), `whisper-gpu` Whisper large-v3-turbo on a GPU (a setting), `voxtype` Whisper base through Voxtype when
 * neither model is here.
 */
export type HearEngine = 'parakeet' | 'whisper-gpu' | 'voxtype';
/** What the person chose for listening: Bogen's pick, or Whisper on the GPU. */
export type HearChoice = 'auto' | 'whisper';

/** What one stretch of the person's speech became: its words, or nothing and why, with which engine heard it. */
export interface Heard {
  text: string;
  ms: number;
  engine: HearEngine;
  /** Milliseconds of speech the voice activity model found, when it ran. */
  speechMs?: number;
  /** Set when the stretch was taken for noise; `heard` is what Whisper wrote anyway, for the record. */
  dropped?: NoiseReason;
  heard?: string;
}

/**
 * A voice call with the agent: the person's words come in as short recordings, cut where they stop speaking, and
 * become text with Whisper through Voxtype on this computer; the agent's words go out as one WAV per sentence. Audio
 * stays in memory and in a temporary folder that is removed after each utterance. Models are downloaded only when the
 * person at this computer asks for them, and checked against their SHA-256 before they are kept.
 */

const LISTEN_TIMEOUT_MS = 60_000;
const SAY_MAX_CHARS = 600;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface CallStatus {
  voices: { id: string; language: CallLanguage; name: string; licence: string; source: string; attribution?: string; bytes: number; installed: boolean; preferred: boolean }[];
  /**
   * How the call hears: `whisper-gpu` is Whisper large-v3-turbo in this process on the GPU, `voxtype` is Whisper base
   * through a Voxtype process per sentence. `installed` is whether the model that engine needs is here.
   */
  listen: { installed: boolean; bytes: number; licence: string; voxtype: boolean; ffmpeg: boolean; engine: HearEngine; model: string; attribution?: string; whisper?: { gpu: boolean; installed: boolean; bytes: number }; parakeet?: { installed: boolean; bytes: number; licence: string; attribution: string } };
  installing: string[];
  ready: Record<CallLanguage, boolean>;
  /** The languages a call speaks here (catalog.ts callLanguages). */
  languages: CallLanguage[];
  talk: TalkStatus;
  /** The call this server talks for, or null: one at a time, the one that opened last (`POST /api/call/talk` warm). */
  call: ActiveCall | null;
}

/** A call as the server knows it: the id its editor gave it, and since when. */
export interface ActiveCall { id: string; since: number }

/**
 * Who speaks for the agent: a local model, a Claude Code session on the person's plan (`claude` is the model picked
 * by measurement, the others a model the person chose), or plain rules.
 */
export type TalkChoice = 'auto' | 'local' | 'claude' | 'claude-sonnet' | 'claude-opus' | 'rules';
const CLAUDE_TALK_MODELS = ['sonnet', 'opus'] as const;
/**
 * The Claude model the call speaks with unless the person picks another, at low effort so that it answers quickly:
 * the person's choice (Opus); measured with scripts/voice-harness/persona-latency.ts and sense.ts on replayed calls.
 * Haiku is not offered: it answered slowest of the three and often missed the call's three-second window. The design
 * agent behind the call keeps its own model and effort from the run settings.
 */
export const CLAUDE_TALK_DEFAULT: (typeof CLAUDE_TALK_MODELS)[number] = 'opus';
export const CLAUDE_TALK_EFFORT = 'low';

export interface TalkStatus {
  /** The GPU llama.cpp would use (vulkan, cuda, metal), false for the CPU, null before it was looked at. */
  gpu: string | false | null;
  models: { id: string; label: string; licence: string; source: string; bytes: number; installed: boolean; recommended: boolean }[];
  claude: boolean;
  /** What `auto` picks now. */
  auto: Exclude<TalkChoice, 'auto'>;
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
  }
  return null;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${command.split('/').at(-1)} failed: ${(String(stderr).trim().split('\n').at(-1) || error.message).slice(0, 300)}`));
      resolve(String(stdout));
    });
  });
}

function hasFile(dir: string, f: SpeechFile): boolean {
  try { return statSync(join(dir, f.name)).size === f.bytes; } catch { return false; }
}

export class CallSpeech {
  private engines: Record<VoiceEntry['engine'], TtsEngine> = { piper: new PiperEngine(), 'tiny-voca': new TinyVocaEngine() };
  private installing = new Map<string, Promise<void>>();
  readonly voicesDir: string;
  readonly listenDir: string;
  readonly talkDir: string;

  constructor(home: string) {
    this.voicesDir = join(home, 'speech', 'voices');
    this.listenDir = join(home, 'speech', 'whisper');
    this.talkDir = join(home, 'speech', 'talk');
  }

  installed(voice: VoiceEntry): boolean {
    return voice.files.every((f) => hasFile(this.voicesDir, f));
  }

  /** Parakeet is here and loads. */
  private parakeetReady(): boolean {
    return !this.parakeetFailed && PARAKEET_MODEL.files.every((f) => hasFile(this.listenDir, f));
  }

  /** Whisper turbo is here and this computer has a GPU for it. */
  private whisperReady(): boolean {
    return Boolean(hearVariant(this.gpu)) && !this.hearFailed && hasFile(this.listenDir, HEAR_MODEL);
  }

  /**
   * The listening engine: Parakeet when it is here (unless the person chose Whisper on the GPU and that is here), then
   * Whisper turbo on a GPU, then Voxtype. Before anything is downloaded, the engine a download would bring.
   */
  hearEngine(choice: HearChoice = 'auto'): HearEngine {
    if (choice === 'whisper' && this.whisperReady()) return 'whisper-gpu';
    if (this.parakeetReady()) return 'parakeet';
    if (this.whisperReady()) return 'whisper-gpu';
    if (!this.parakeetFailed && !hasFile(this.listenDir, LISTEN_MODEL)) return 'parakeet';
    return 'voxtype';
  }

  status(): CallStatus {
    const engine = this.hearEngine();
    const model = engine === 'parakeet' ? { name: 'parakeet-tdt-0.6b-v3', bytes: PARAKEET_MODEL.bytes, licence: PARAKEET_MODEL.licence } : engine === 'whisper-gpu' ? HEAR_MODEL : LISTEN_MODEL;
    const listenInstalled = engine === 'parakeet' ? this.parakeetReady() : hasFile(this.listenDir, model as SpeechFile);
    const voxtype = Boolean(onPath('voxtype'));
    const ffmpeg = Boolean(findFfmpeg());
    const languages = callLanguages();
    const voices = offeredVoices().map((v) => ({ id: v.id, language: v.language, name: v.name, licence: v.licence, source: v.source, ...(v.attribution ? { attribution: v.attribution } : {}), bytes: v.files.reduce((n, f) => n + f.bytes, 0), installed: this.installed(v), preferred: Boolean(v.preferred) }));
    // The editor sends 16 kHz WAV, which the GPU engine reads directly; Voxtype needs ffmpeg for its own WAV.
    const canListen = this.parakeetReady() || this.whisperReady() || (hasFile(this.listenDir, LISTEN_MODEL) && voxtype && ffmpeg);
    return {
      voices,
      listen: {
        installed: listenInstalled, bytes: model.bytes, licence: model.licence, voxtype, ffmpeg, engine, model: model.name,
        ...(engine === 'parakeet' ? { attribution: PARAKEET_MODEL.attribution } : {}),
        // Whisper turbo on the GPU stays a choice: whether this computer can take it, and whether it is here.
        whisper: { gpu: Boolean(hearVariant(this.gpu)), installed: hasFile(this.listenDir, HEAR_MODEL), bytes: HEAR_MODEL.bytes },
        parakeet: { installed: this.parakeetReady(), bytes: PARAKEET_MODEL.bytes, licence: PARAKEET_MODEL.licence, attribution: PARAKEET_MODEL.attribution },
      },
      installing: [...this.installing.keys()],
      ready: { de: canListen && voices.some((v) => v.language === 'de' && v.installed), en: canListen && voices.some((v) => v.language === 'en' && v.installed) },
      languages,
      talk: this.talkStatus(),
      call: this.call,
    };
  }

  // ---------------------------------------------------------------- the talking layer

  private gpu: string | false | null = null;
  private gpuProbe: Promise<void> | null = null;
  private talkers = new Map<string, PersonaEngine>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  /**
   * The one call going on. A browser holds one call at a time (its windows hand it on), so a second call opening means
   * the first was handed on: it is replaced, and its late end no longer closes the talking layer the new one uses.
   */
  private call: ActiveCall | null = null;

  /** A call opened: it is the one call now. */
  beginCall(id: string): void {
    this.call = { id, since: Date.now() };
  }

  get activeCall(): ActiveCall | null { return this.call; }

  /**
   * A call ended: the talking layer closes, unless `id` names a call that was already replaced by a newer one. An end
   * without an id (an older editor) ends whatever is going on. Returns whether it ended the call going on.
   */
  async endCall(id?: string): Promise<boolean> {
    if (id && this.call && this.call.id !== id) return false;
    this.call = null;
    await this.endTalk();
    return true;
  }

  /** Asks llama.cpp once which GPU it would use. Loads its binaries, not a model. */
  probeGpu(): Promise<void> {
    this.gpuProbe ??= (async () => {
      try {
        const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');
        const llama = await getLlama({ gpu: 'auto', logLevel: LlamaLogLevel.error });
        this.gpu = llama.gpu;
      } catch {
        this.gpu = false;
      }
    })();
    return this.gpuProbe;
  }

  private recommendedModel(): TalkModel {
    const gpu = Boolean(this.gpu);
    return TALK_MODELS.find((m) => m.forGpu === gpu) ?? TALK_MODELS[0]!;
  }

  talkStatus(): TalkStatus {
    const recommended = this.recommendedModel();
    const models = TALK_MODELS.map((m) => ({ id: m.id, label: m.label, licence: m.licence, source: m.source, bytes: m.bytes, installed: hasFile(this.talkDir, m), recommended: m.id === recommended.id }));
    const claude = Boolean(onPath('claude'));
    const local = models.find((m) => m.recommended && m.installed) ?? models.find((m) => m.installed);
    // What the voice says has to be true to what the agent did. Measured with scripts/voice-harness/sense.ts, a
    // signed-in Claude Code (Opus at low effort) retells the agent faithfully; Qwen3 4B on the GPU is faster but sometimes invents
    // details when it turns an English answer into German. So Claude Code speaks when it is there, the local model
    // when it is not, and the rules when neither is.
    const auto: TalkStatus['auto'] = claude ? 'claude' : local ? 'local' : 'rules';
    return { gpu: this.gpu, models, claude, auto };
  }

  private engineFor(choice: TalkChoice): PersonaEngine | null {
    const status = this.talkStatus();
    const pick = choice === 'auto' ? status.auto : choice;
    if (pick === 'rules') return null;
    if (pick === 'claude' || pick.startsWith('claude-')) {
      if (!status.claude) return null;
      const model = pick === 'claude' ? CLAUDE_TALK_DEFAULT : pick.slice('claude-'.length);
      const key = `claude:${model}`;
      let e = this.talkers.get(key);
      if (!e) { e = new ClaudePersona({ model, effort: CLAUDE_TALK_EFFORT }); this.talkers.set(key, e); }
      return e;
    }
    const installed = status.models.find((m) => m.recommended && m.installed) ?? status.models.find((m) => m.installed);
    if (!installed) return null;
    const model = TALK_MODELS.find((m) => m.id === installed.id)!;
    const key = `local:${model.id}`;
    let e = this.talkers.get(key);
    if (!e) {
      for (const [k, other] of this.talkers) if (k.startsWith('local:')) { void other.dispose(); this.talkers.delete(k); }
      e = new LocalPersona({ modelPath: join(this.talkDir, model.name), gpu: 'auto', family: model.family });
      this.talkers.set(key, e);
    }
    return e;
  }

  /** Loads the talking layer when a call opens, so its first answer is quick. */
  async warmTalk(choice: TalkChoice): Promise<void> {
    await this.probeGpu();
    this.keepAlive();
    await Promise.all([
      this.engineFor(choice)?.warm(),
      this.hearEngine() === 'parakeet' ? this.parakeetHearer().warm().catch(() => undefined) : this.hearer()?.warm().catch(() => undefined),
    ]);
  }

  private whisper: ResidentWhisper | null = null;
  private parakeet: ResidentParakeet | null = null;
  /** Parakeet failed to load once in this process; the next engine hears instead. */
  private parakeetFailed = false;
  /** The GPU model failed once in this process; Voxtype hears instead. */
  private hearFailed = false;

  private parakeetHearer(): ResidentParakeet {
    this.parakeet ??= new ResidentParakeet(this.listenDir);
    return this.parakeet;
  }

  /** The resident listening model, when this computer has a GPU and the model is here. */
  private hearer(): ResidentWhisper | null {
    const variant = hearVariant(this.gpu);
    if (!variant || !hasFile(this.listenDir, HEAR_MODEL)) return null;
    this.whisper ??= new ResidentWhisper(join(this.listenDir, HEAR_MODEL.name), variant);
    return this.whisper;
  }

  /** One spoken line, or null: then the call's rules speak. */
  async talk(req: PersonaRequest, choice: TalkChoice, signal?: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void): Promise<{ text: string | null; source: string; firstTokenMs: number; totalMs: number }> {
    await this.probeGpu();
    this.keepAlive();
    const engine = this.engineFor(choice);
    if (!engine) return { text: null, source: 'rules', firstTokenMs: 0, totalMs: 0 };
    const r = await engine.reply(req, signal, onFirst, onText);
    return { text: r.text, source: engine.id, firstTokenMs: r.firstTokenMs, totalMs: r.totalMs };
  }

  /** Frees the model's memory and closes the session when the call ends, or after ten quiet minutes. */
  async endTalk(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const all = [...this.talkers.values()];
    this.talkers.clear();
    const whisper = this.whisper;
    this.whisper = null;
    const vad = this.vad;
    this.vad = null;
    await Promise.all([...all.map((e) => e.dispose().catch(() => undefined)), whisper?.release(), vad?.release()]);
  }

  private keepAlive(): void {
    if (this.idle) clearTimeout(this.idle);
    // Ten quiet minutes: the editor that held the call is gone (closed, asleep), so the call is over too.
    this.idle = setTimeout(() => { this.call = null; void this.endTalk(); }, 10 * 60_000);
    this.idle.unref();
  }

  /** Downloads what a language needs (its preferred voice and the listening model), checked by SHA-256. */
  install(what: 'listen' | string): Promise<void> {
    const talk = TALK_MODELS.find((m) => `talk:${m.id}` === what);
    if (talk) return this.installLarge(what, this.talkDir, talk);
    // The voice activity model comes with listening, whichever engine writes the words down.
    if (what === 'listen' && !hasFile(this.listenDir, VAD_MODEL)) void this.installLarge('vad', this.listenDir, VAD_MODEL).catch(() => undefined);
    if (what === 'listen:whisper') return this.installLarge('listen:whisper', this.listenDir, HEAR_MODEL);
    if (what === 'listen' && !this.parakeetFailed) return this.installParakeet();
    const voice = what === 'listen' ? null : offeredVoices().find((v) => v.id === what);
    if (what !== 'listen' && !voice) throw new HttpError(404, 'There is no such voice.');
    const running = this.installing.get(what);
    if (running) return running;
    const job = (async () => {
      const dir = voice ? this.voicesDir : this.listenDir;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const f of voice ? voice.files : [LISTEN_MODEL]) {
        if (hasFile(dir, f)) continue;
        const got = await fetchPublic(f.url, { maxBytes: f.bytes + 1024, timeoutMs: DOWNLOAD_TIMEOUT_MS, headers: { 'user-agent': 'Bogen voice call (https://bogen.dev)' } });
        const sum = createHash('sha256').update(got.bytes).digest('hex');
        if (sum !== f.sha256) throw new Error(`${f.name} did not match its checksum, so it was not kept.`);
        await atomicWrite(join(dir, f.name), Buffer.from(got.bytes));
      }
    })();
    this.installing.set(what, job);
    job.finally(() => this.installing.delete(what)).catch(() => undefined);
    return job;
  }

  /** Parakeet's four files, one after the other, each checked by SHA-256. */
  private installParakeet(): Promise<void> {
    const running = this.installing.get('listen');
    if (running) return running;
    const job = (async () => {
      for (const f of PARAKEET_MODEL.files) await this.installLarge(`listen:${f.name}`, this.listenDir, f);
    })();
    this.installing.set('listen', job);
    job.finally(() => this.installing.delete('listen')).catch(() => undefined);
    return job;
  }

  /** A file of a few GB: written to disk as it arrives, hashed on the way, kept only when the hash matches. */
  private installLarge(key: string, dir: string, f: SpeechFile): Promise<void> {
    const running = this.installing.get(key);
    if (running) return running;
    const job = (async () => {
      if (hasFile(dir, f)) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const part = join(dir, `${f.name}.part`);
      const hash = createHash('sha256');
      const fd = openSync(part, 'w', 0o600);
      try {
        await fetchPublic(f.url, {
          maxBytes: f.bytes + 1024, timeoutMs: DOWNLOAD_TIMEOUT_MS, headers: { 'user-agent': 'Bogen voice call (https://bogen.dev)' },
          sink: (chunk) => { hash.update(chunk); writeSync(fd, chunk); },
        });
      } finally {
        closeSync(fd);
      }
      if (hash.digest('hex') !== f.sha256) {
        await rm(part, { force: true });
        throw new Error(`${f.name} did not match its checksum, so it was not kept.`);
      }
      await rename(part, join(dir, f.name));
    })();
    this.installing.set(key, job);
    job.finally(() => this.installing.delete(key)).catch(() => undefined);
    return job;
  }

  async say(text: string, language: CallLanguage, voiceId?: string, signal?: AbortSignal): Promise<Buffer> {
    // A language the call does not speak here is spoken in the first one it does.
    if (!callLanguages().includes(language)) { language = callLanguages()[0]!; voiceId = undefined; }
    let voice = voiceFor(language, voiceId);
    // Without a choice, a voice of the language that is already here speaks until the preferred one is downloaded.
    if (!voiceId && voice && !this.installed(voice)) voice = offeredVoices().find((v) => v.language === language && this.installed(v)) ?? voice;
    if (!voice || !this.installed(voice)) throw new HttpError(409, language === 'de' ? 'Die deutsche Stimme ist noch nicht geladen.' : 'The English voice is not downloaded yet.');
    const engine = this.engines[voice.engine];
    await engine.load(voice, this.voicesDir);
    return engine.synthesize(voice, text.slice(0, SAY_MAX_CHARS), signal);
  }

  /** One utterance to text. `language` is a hint; `auto` lets Whisper decide. */
  /** The voice activity model, once it is here; it is fetched in the background the first time it is missing. */
  private vadFor(): ResidentVad | null {
    if (!hasFile(this.listenDir, VAD_MODEL)) {
      if (!this.installing.has('vad')) void this.installLarge('vad', this.listenDir, VAD_MODEL).catch((err) => console.error(`bogen: could not fetch the voice activity model: ${errorMessage(err)}`));
      return null;
    }
    this.vad ??= new ResidentVad(join(this.listenDir, VAD_MODEL.name));
    return this.vad;
  }

  private vad: ResidentVad | null = null;

  /** How much of a stretch is speech, or undefined when that cannot be told here. */
  private async speechIn(pcm: ArrayBuffer | null): Promise<number | undefined> {
    const vad = pcm ? this.vadFor() : null;
    if (!vad || !pcm) return undefined;
    try { return await vad.speechMs(pcm); } catch { return undefined; }
  }

  /**
   * One stretch of the person's speech as text. A stretch with no speech in it (silence, noise, typing, the voice heard
   * back) is not sent to Whisper at all; a line Whisper is known to make up with little speech behind it is dropped.
   */
  async listen(audio: Buffer, ext: string, language: CallLanguage | 'auto', prompt = '', names: string[] = [], choice: HearChoice = 'auto'): Promise<Heard> {
    await this.probeGpu();
    const started = Date.now();
    let pcm: ArrayBuffer | null = ext === 'wav' ? pcmOf(audio) : null;
    if (!pcm && findFfmpeg()) pcm = await this.toPcm(audio, ext).catch(() => null);
    // The voice activity check and the words run side by side: the check takes a few milliseconds, and a stretch
    // without speech only throws its words away.
    const [speechMs, heard] = await Promise.all([this.speechIn(pcm), this.transcribe(audio, ext, pcm, language, prompt, names, choice)]);
    const ms = pcm ? Math.round(pcm.byteLength / 32) : 0;
    if (speechMs !== undefined && speechMs < MIN_SPEECH_MS) {
      return { text: '', ms: Date.now() - started, engine: heard.engine, speechMs, dropped: 'no-speech', ...(heard.text ? { heard: heard.text } : {}) };
    }
    const text = spokenPart(heard.text);
    // Parakeet guesses the language itself: a line in neither German nor English was misheard.
    const dropped = noiseVerdict(heard.text, { ms, ...(speechMs !== undefined ? { speechMs } : {}) }) ?? (heard.engine === 'parakeet' && otherLanguage(heard.text) ? 'language' : null);
    if (dropped) return { text: '', ms: Date.now() - started, engine: heard.engine, ...(speechMs !== undefined ? { speechMs } : {}), dropped, ...(heard.text ? { heard: heard.text } : {}) };
    return { text, ms: Date.now() - started, engine: heard.engine, ...(speechMs !== undefined ? { speechMs } : {}) };
  }

  private async transcribe(audio: Buffer, ext: string, pcm: ArrayBuffer | null, language: CallLanguage | 'auto', prompt: string, names: string[] = [], choice: HearChoice = 'auto'): Promise<{ text: string; engine: HearEngine }> {
    const engine = this.hearEngine(choice);
    // A recording that cannot be read is that recording's fault, not the engine's: it must not turn Parakeet or the
    // GPU off for the rest of the service's life, as one did.
    if (!pcm && (engine === 'parakeet' || engine === 'whisper-gpu')) {
      try { pcm = await this.toPcm(audio, ext); } catch (err) { throw new HttpError(400, `The recording could not be read: ${errorMessage(err)}`); }
    }
    if (engine === 'parakeet') {
      this.keepAlive();
      try {
        const data = pcm!;
        return { text: cleanTranscript(await this.parakeetHearer().transcribe(data, names)), engine: 'parakeet' };
      } catch (err) {
        // A computer where sherpa-onnx will not load must not end the call: the next engine hears from here on.
        this.parakeetFailed = true;
        this.parakeet = null;
        console.error(`bogen: listening with Parakeet failed, using the next engine: ${errorMessage(err)}`);
      }
    }
    const whisper = this.hearFailed ? null : this.hearer();
    if (whisper) {
      this.keepAlive();
      try {
        const data = pcm ?? await this.toPcm(audio, ext);
        // German or English, whichever the person speaks: a German sentence in an English call was forced into English
        // before, and came out as nonsense. Another language detected is heard again as the call's.
        const text = cleanTranscript((await whisper.transcribeDeEn(data, language === 'auto' ? 'de' : language, prompt)).trim());
        return { text, engine: 'whisper-gpu' };
      } catch (err) {
        // A GPU that will not take the model (a driver, too little memory) must not end the call: Voxtype hears
        // from here on, when it is set up.
        if (!hasFile(this.listenDir, LISTEN_MODEL) || !onPath('voxtype')) throw err;
        this.hearFailed = true;
        console.error(`bogen: listening on the GPU failed, using Voxtype: ${errorMessage(err)}`);
        void whisper.release();
        this.whisper = null;
      }
    }
    return { text: (await this.listenVoxtype(audio, ext, language)).text, engine: 'voxtype' };
  }

  /** Any recording as 16 kHz mono 16-bit PCM, through ffmpeg. */
  private async toPcm(audio: Buffer, ext: string): Promise<ArrayBuffer> {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) throw new HttpError(409, 'This recording needs ffmpeg to be converted.');
    const dir = await mkdtemp(join(tmpdir(), 'bogen-call-'));
    try {
      const input = join(dir, `in.${ext}`);
      const raw = join(dir, 'speech.pcm');
      await writeFile(input, audio, { mode: 0o600 });
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-f', 's16le', raw], 20_000);
      const b = await readFile(raw);
      const out = new ArrayBuffer(b.length - (b.length % 2));
      new Uint8Array(out).set(b.subarray(0, out.byteLength));
      return out;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async listenVoxtype(audio: Buffer, ext: string, language: CallLanguage | 'auto'): Promise<{ text: string; ms: number }> {
    const voxtype = onPath('voxtype');
    const ffmpeg = findFfmpeg();
    if (!voxtype || !ffmpeg) throw new HttpError(409, 'Listening needs Voxtype and ffmpeg on this computer.');
    if (!hasFile(this.listenDir, LISTEN_MODEL)) throw new HttpError(409, 'The listening model is not downloaded yet.');
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'bogen-call-'));
    try {
      const input = join(dir, `in.${ext}`);
      const wavPath = join(dir, 'speech-16k.wav');
      await writeFile(input, audio, { mode: 0o600 });
      if (ext === 'wav' && isPcm16k(audio)) await writeFile(wavPath, audio, { mode: 0o600 });
      else await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], 20_000);
      const out = await run(voxtype, ['-q', '--engine', 'whisper', '--whisper-mode', 'local', '--model', join(this.listenDir, LISTEN_MODEL.name), '--language', language, 'transcribe', wavPath], LISTEN_TIMEOUT_MS);
      const text = cleanTranscript(out.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '');
      return { text, ms: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** A WAV that is already 16 kHz mono 16-bit, as the editor sends it, needs no conversion. */
function isPcm16k(b: Buffer): boolean {
  return b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16;
}

const KINDS: PersonaKind[] = ['result', 'question', 'error', 'chat', 'route', 'progress', 'brief', 'summary', 'turn', 'event', 'more'];

function talkChoice(raw: unknown): TalkChoice {
  if (raw === 'local' || raw === 'claude' || raw === 'rules') return raw;
  if (typeof raw === 'string' && raw.startsWith('claude-') && (CLAUDE_TALK_MODELS as readonly string[]).includes(raw.slice(7))) return raw as TalkChoice;
  return 'auto';
}

/** What the call routes need from the server: its data folder, the open files by name, and the chats. */
export interface CallApp {
  options: { home: string };
  rooms?: { get(id: string): Promise<{ doc: BogenDoc }> };
  storage?: { get(id: string): { name?: string } | undefined; list?(): { id: string; name: string; updatedAt: number; folder?: string; recentEdits?: { at?: number }[] }[]; listBrands?(): { id: string; name: string; updatedAt: number }[] };
  conversations?: {
    addCallLines(fileId: string, id: string, lines: CallLine[]): Promise<void>;
    setCallSummary?(fileId: string, id: string, summary: string): Promise<void>;
    calls?(fileId: string): Promise<{ id: string; lastAt: number; call: CallLine[]; callSummary?: string }[]>;
    list?(fileId: string): Promise<{ id: string; updatedAt: number }[]>;
    get?(fileId: string, id: string): Promise<{ call?: CallLine[] } | undefined>;
  };
  /** The file's agent runs, newest first: what the voice can tell about, also from before the call. */
  history?: { list(fileId: string, limit?: number): Promise<{ status: string; title?: string; prompt: string; result?: string; nudged?: boolean; firstReply?: string; startedAt: number; endedAt?: number; layers?: unknown[] }[]> };
}

/** Words that say nothing about which file: articles, prepositions. */
const FILE_STOP = new Set(['the', 'die', 'der', 'das', 'den', 'dem', 'vom', 'von', 'a', 'an', 'my', 'meine', 'mein', 'meinem', 'meiner', 'zu', 'zur', 'zum', 'mit', 'bei', 'auf', 'for', 'für', 'of', 'und', 'and', 'in', 'im', 'mal', 'bitte', 'please']);
/** Words many file names share ("Website", "Logo"): they tell two files of one client apart, but name no client. */
const FILE_WEAK = new Set(['website', 'seite', 'page', 'logo', 'datei', 'file', 'design']);
/** Too general to pick a file on their own. */
const FILE_GENERIC = new Set(['datei', 'file', 'design'])

/** Lower case, umlauts and ß spelled out, punctuation gone: how a spoken name and a file name are compared. */
export function normaliseName(s: string): string[] {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

export type FileMatch = { match: { id: string; name: string } } | { ambiguous: { id: string; name: string }[] } | { none: true };

/**
 * Which file the person means by what they said ("die Datei vom Logo", "Trauermusik"): the words of their name that
 * appear in a file's name, with the file's own weak words (website, Seite, Datei) counting less, and recency to
 * break a near tie. One clear winner is a match; two close ones are asked back; nothing close is "not found". Only
 * files are searched, never brands or anything outside the list, and a name that is an id or a path finds nothing.
 */
export function resolveFile(said: string, files: { id: string; name: string; updatedAt: number; folder?: string; recentEdits?: { at?: number }[] }[], now = Date.now()): FileMatch {
  // A path or a file id said (or misheard) as a name opens nothing.
  if (/[\\/~]/.test(said) || /^(?=[a-z]*\d)[a-z0-9]{10}$/i.test(said.trim())) return { none: true };
  const asked = normaliseName(said).filter((w) => !FILE_STOP.has(w));
  const strong = asked.filter((w) => !FILE_WEAK.has(w) && w.length > 1);
  const weakSaid = asked.filter((w) => FILE_WEAK.has(w) && !FILE_GENERIC.has(w));
  if (!strong.length && !weakSaid.length) return { none: true };
  const scored = files.map((f) => {
    const name = normaliseName(`${f.name} ${f.folder ?? ''}`);
    // Whole words count fully; a misheard one (one letter off) or the start of a longer one nearly so.
    const hits = (words: string[]) => words.reduce((n, w) => n + (name.includes(w) ? 1
      : w.length >= 5 && name.some((x) => oneEditApart(w, x)) ? 0.8
        : w.length >= 4 && name.some((x) => x.startsWith(w) || (w.startsWith(x) && x.length >= 4)) ? 0.7 : 0), 0);
    const weak = weakSaid.filter((w) => name.includes(w)).length;
    const last = Math.max(f.updatedAt, ...(f.recentEdits ?? []).map((e) => e.at ?? 0));
    const days = (now - last) / 86_400_000;
    // The client's own words decide; a shared word that is in the name ("Website", "Logo") tells two of one client apart.
    const base = strong.length ? hits(strong) / strong.length + Math.min(0.3, weak * 0.2) : weak / weakSaid.length;
    const score = base + (days < 1 ? 0.05 : days < 7 ? 0.02 : 0);
    return { id: f.id, name: f.name, score };
  }).sort((x, y) => y.score - x.score);
  const [top, second] = scored;
  if (!top || top.score < 0.6) return { none: true };
  if (second && top.score - second.score < 0.15) return { ambiguous: [top, second].map(({ id, name }) => ({ id, name })) };
  return { match: { id: top.id, name: top.name } };
}

/** Whether two words differ by one letter added, left out or changed: "Tomaco" for "Tomacco". */
export function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x: string, y: string) => x.slice(i + (a.length >= b.length ? 1 : 0)) === y.slice(i + (b.length >= a.length ? 1 : 0));
  return rest(a, b);
}

/** The names of the files worked on lately, for the listening model to expect them. */
export function recentFileNames(app: CallApp, n = 8): string[] {
  return (app.storage?.list?.() ?? []).slice().sort((x, y) => y.updatedAt - x.updatedAt).slice(0, n).map((f) => f.name);
}

/**
 * The file's last three runs for the talking layer: when, how they ended or that one still runs, what was asked (the
 * title, without the call's brief around it) and the start of what the agent answered.
 */
export async function recentRuns(app: CallApp, fileId: string | undefined, now = Date.now()): Promise<RecentRun[]> {
  if (!fileId || !app.history) return [];
  const records = await app.history.list(fileId, 3).catch(() => []);
  return records.slice(0, 3).map((r) => ({
    minutesAgo: Math.max(0, Math.round((now - (r.endedAt ?? r.startedAt)) / 60_000)),
    status: r.status,
    asked: (r.title || r.prompt).replace(/^\[Voice call[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 240),
    // A run continued once that again changed nothing answered before the continuation; both parts count.
    ...(r.result || r.firstReply ? { result: (r.nudged && r.firstReply && r.firstReply !== r.result ? `${r.firstReply} ${r.result ?? ''}` : r.result ?? '').replace(/<\/?say>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200) } : {}),
    ...(Array.isArray(r.layers) && r.layers.length ? { layers: r.layers.length } : {}),
  }));
}

/**
 * The server's record is the truth about whether the agent works: the editor can lose track of a run (a reload, a run
 * started from the chat or a comment, a turn that ended in an error inside a longer run), and the voice must not say
 * "nothing is running" while one runs, nor "still on it" after it ended.
 */
export function runTruth(context: CallContext, runs: RecentRun[]): void {
  if (runs[0]?.status === 'running') {
    context.working = true;
    if (context.workingMinutes === undefined) context.workingMinutes = runs[0].minutesAgo;
    return;
  }
  // The file's latest run has ended, and the call has not moved on from a run in another file: nothing runs here.
  if (context.working && runs[0] && !context.runFile) {
    context.working = false;
    delete context.workingMinutes;
    delete context.activity;
  }
}

/** The last lines of the previous call about a file (not the one going on now), for "what did we do last time?". */
export async function earlierCall(app: CallApp, fileId: string | undefined, now = Date.now()): Promise<string[]> {
  if (!fileId) return [];
  if (app.conversations?.calls) {
    // The call's own notes say what it was about; its last lines how it ended.
    for (const c of (await app.conversations.calls(fileId).catch(() => [])).slice(0, 5)) {
      const lines = c.call.filter((l) => l.kind !== 'noise' && l.kind !== 'end-note' && l.text);
      if (!lines.length || now - c.lastAt < 5 * 60_000) continue;
      const ago = Math.round((now - c.lastAt) / 60_000);
      const when = ago < 90 ? `${ago} min ago` : ago < 36 * 60 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} days ago`;
      return [
        ...(c.callSummary ? [`(That call, ${when}, in short: ${c.callSummary})`] : [`(That call ended ${when}.)`]),
        ...lines.slice(c.callSummary ? -4 : -6).map((l) => `${l.who === 'person' ? 'Person' : 'You'}: ${l.text}`),
      ];
    }
    return [];
  }
  if (!app.conversations?.list || !app.conversations.get) return [];
  const chats = (await app.conversations.list(fileId).catch(() => [])).slice().sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 5);
  for (const chat of chats) {
    const lines = ((await app.conversations.get(fileId, chat.id).catch(() => undefined))?.call ?? []).filter((l) => l.kind !== 'noise' && l.text);
    const last = lines.at(-1);
    // A call that is still going (its last line minutes old at most) is the one the voice is in.
    if (!last || now - last.at < 5 * 60_000) continue;
    return lines.slice(-6).map((l) => `${l.who === 'person' ? 'Person' : 'You'}: ${l.text}`);
  }
  return [];
}

/** Up to three other files worked on lately, with what was asked there last. */
export async function otherFiles(app: CallApp, fileId: string | undefined): Promise<{ name: string; lastAsked?: string }[]> {
  const files = (app.storage?.list?.() ?? []).filter((f) => f.id !== fileId).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, 3);
  return Promise.all(files.map(async (f) => {
    const last = (await app.history?.list(f.id, 1).catch(() => []))?.[0];
    const asked = last ? (last.title || last.prompt).replace(/^\[Voice call[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return { name: f.name, ...(asked ? { lastAsked: asked } : {}) };
  }));
}

function screenSource(app: CallApp): ScreenSource {
  return {
    fileName: (id) => app.storage?.get(id)?.name,
    doc: async (id) => (app.rooms && app.storage?.get(id) ? (await app.rooms.get(id)).doc : null),
  };
}

const ID = /^[\w-]{1,80}$/;
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : undefined);

/** The call's own part of the context, as the editor sends it, held to sane sizes. */
function cleanContext(raw: unknown): CallContext {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const history = Array.isArray(o.history) ? o.history.slice(-16).flatMap((h) => {
    const x = h as Record<string, unknown>;
    const who: CallHistoryLine['who'] | null = x?.who === 'person' || x?.who === 'voice' || x?.who === 'agent' ? x.who : null;
    const text = str(x?.text, 800);
    return who && text ? [{ who, text }] : [];
  }) : [];
  return {
    working: o.working === true,
    ...(str(o.lastRequest, 1200) ? { lastRequest: str(o.lastRequest, 1200) } : {}),
    ...(typeof o.lastResult === 'string' && o.lastResult.trim() ? { lastResult: o.lastResult.slice(0, 6000) } : {}),
    ...(str(o.pendingQuestion, 600) ? { pendingQuestion: str(o.pendingQuestion, 600) } : {}),
    ...(str(o.callSummary, 600) ? { callSummary: str(o.callSummary, 600) } : {}),
    ...(o.working === true && str(o.activity, 600) ? { activity: str(o.activity, 600) } : {}),
    ...(o.working === true && typeof o.workingMinutes === 'number' && Number.isFinite(o.workingMinutes) ? { workingMinutes: Math.max(0, Math.min(600, Math.round(o.workingMinutes))) } : {}),
    ...(str(o.runFile, 200) ? { runFile: str(o.runFile, 200) } : {}),
    ...(Array.isArray(o.drafting) ? { drafting: o.drafting.slice(-6).flatMap((d) => (str(d, 400) ? [str(d, 400)!] : [])) } : {}),
    ...(o.readBack === true ? { readBack: true } : {}),
    ...(o.working === true && Array.isArray(o.toldThisRun) ? { toldThisRun: o.toldThisRun.slice(-6).flatMap((t) => (str(t, 300) ? [str(t, 300)!] : [])) } : {}),
    ...(o.lastResultSpoken === true ? { lastResultSpoken: true } : {}),
    ...(Array.isArray(o.resultTold) ? { resultTold: o.resultTold.slice(0, 14).flatMap((t) => (str(t, 320) ? [str(t, 320)!] : [])) } : {}),
    ...(Array.isArray(o.resultLeft) ? { resultLeft: o.resultLeft.slice(0, 14).flatMap((t) => (str(t, 320) ? [str(t, 320)!] : [])) } : {}),
    ...(o.working === true && Array.isArray(o.steps) ? { steps: o.steps.slice(-3).flatMap((x) => {
      const step = x as Record<string, unknown>;
      const what = str(step?.what, 80);
      if (!what) return [];
      const names = Array.isArray(step.names) ? step.names.slice(0, 4).flatMap((n) => (str(n, 80) ? [str(n, 80)!] : [])) : [];
      const secondsAgo = typeof step.secondsAgo === 'number' && Number.isFinite(step.secondsAgo) ? Math.max(0, Math.min(36_000, Math.round(step.secondsAgo))) : 0;
      return [{ what, ...(names.length ? { names } : {}), secondsAgo }];
    }) } : {}),
    ...(history.length ? { history } : {}),
  };
}

function cleanLines(raw: unknown): CallLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((l) => {
    const x = l as Record<string, unknown>;
    const who = x?.who === 'person' || x?.who === 'voice' ? x.who : null;
    const text = typeof x?.text === 'string' ? x.text.trim() : '';
    if (!who || !text) return [];
    const routes: NonNullable<CallLine['route']>[] = ['agent', 'answer', 'clarify', 'steer', 'queue', 'voice'];
    const route = routes.find((r) => r === x.route);
    const reasons: NonNullable<CallLine['reason']>[] = ['no-speech', 'made-up', 'echo', 'empty'];
    const reason = reasons.find((r) => r === x.reason);
    const source = x.source === 'persona' || x.source === 'rules' || x.source === 'instant' ? x.source : undefined;
    return [{
      at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : Date.now(), who, text,
      ...(typeof x.kind === 'string' ? { kind: x.kind.slice(0, 20) } : {}),
      ...(route ? { route } : {}), ...(source ? { source } : {}), ...(reason ? { reason } : {}),
      ...(typeof x.engine === 'string' && /^[a-z-]{1,20}$/.test(x.engine) ? { engine: x.engine } : {}),
      ...(typeof x.ms === 'number' && Number.isFinite(x.ms) ? { ms: Math.max(0, Math.round(x.ms)) } : {}),
    }];
  });
}

const preferenceStores = new WeakMap<object, CallPreferences>();
/** The person's standing wishes for the call, one store per server. */
export function callPreferences(app: { options: { home: string } }): CallPreferences {
  let found = preferenceStores.get(app);
  if (!found) { found = new CallPreferences(app.options.home); preferenceStores.set(app, found); }
  return found;
}

const calls = new WeakMap<object, CallSpeech>();
export function callSpeech(app: { options: { home: string } }): CallSpeech {
  let found = calls.get(app);
  if (!found) { found = new CallSpeech(app.options.home); calls.set(app, found); }
  return found;
}

function language(raw: string | null, allowAuto: true): CallLanguage | 'auto';
function language(raw: string | null, allowAuto?: false): CallLanguage;
function language(raw: string | null, allowAuto = false): CallLanguage | 'auto' {
  if (raw === 'de' || raw === 'en') return raw;
  if (allowAuto && (raw === 'auto' || raw === null)) return 'auto';
  throw new HttpError(400, 'The language is de or en.');
}

/** The language the call answers in: the one asked for if the call speaks it here, else the first it does. */
function spoken(asked: CallLanguage): CallLanguage {
  const langs = callLanguages();
  return langs.includes(asked) ? asked : langs[0]!;
}

async function readLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'That recording is too long for one turn.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * `POST /api/call/log` `{ fileId, conversationId, lines }` keeps the call's lines with the chat.
 * `GET /api/call/status`, `POST /api/call/install` `{ what }` (this computer only), `POST /api/call/say` `{ text,
 * language, voice? }` (WAV back), `POST /api/call/listen?language=` with the recording as the body. Only for the
 * person at this computer or on a paired phone, like voice notes.
 */
export async function handleCallRoute(app: CallApp, req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], gates: { owner: boolean; thisDevice: boolean }, send: (res: ServerResponse, status: number, body: unknown) => void, json: (req: IncomingMessage) => Promise<unknown>): Promise<void> {
  const method = req.method ?? 'GET';
  if (!gates.owner) {
    req.resume();
    throw new HttpError(403, 'A call is only for the person at this computer, or on a phone paired with it.');
  }
  const speech = callSpeech(app);
  const [, name] = parts;
  if (name === 'resolve-file' && method === 'POST') {
    const body = (await json(req)) as { said?: unknown };
    const said = typeof body?.said === 'string' ? body.said.slice(0, 200) : '';
    if (!said.trim()) throw new HttpError(400, 'Say which file.');
    return send(res, 200, resolveFile(said, app.storage?.list?.() ?? []));
  }
  if (name === 'resolve-brand' && method === 'POST') {
    const body = (await json(req)) as { said?: unknown };
    const said = typeof body?.said === 'string' ? body.said.slice(0, 200) : '';
    if (!said.trim()) throw new HttpError(400, 'Say which brand.');
    // Brands are looked for among the brands only, by the same measure as files; nothing is made.
    return send(res, 200, resolveFile(said, app.storage?.listBrands?.() ?? []));
  }
  if (name === 'preferences') {
    const store = callPreferences(app);
    if (method === 'GET') { req.resume(); return send(res, 200, { items: await store.list() }); }
    if (method === 'POST') {
      const item = cleanPreference((await json(req)) as unknown)[0];
      if (!item) throw new HttpError(400, 'A preference is a kind (length, name, language or other), a value and the words said.');
      return send(res, 200, { items: await store.add(item) });
    }
    if (method === 'DELETE') {
      req.resume();
      const id = parts[2];
      if (id !== undefined && !/^[0-9a-f]{6,20}$/.test(id)) throw new HttpError(400, 'Not a preference.');
      return send(res, 200, { items: await store.remove(id) });
    }
  }
  if (name === 'status' && method === 'GET') {
    await speech.probeGpu();
    return send(res, 200, speech.status());
  }
  if (name === 'install' && method === 'POST') {
    if (!gates.thisDevice) throw new HttpError(403, 'Voices are downloaded from the computer Bogen runs on.');
    const body = (await json(req)) as { what?: unknown };
    const what = typeof body?.what === 'string' ? body.what : '';
    try {
      await speech.install(what);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, errorMessage(err));
    }
    return send(res, 200, speech.status());
  }
  if (name === 'talk' && method === 'POST') {
    const body = (await json(req)) as { kind?: unknown; language?: unknown; said?: unknown; agent?: unknown; choice?: unknown; warm?: unknown; context?: unknown; fileId?: unknown; pageId?: unknown; selection?: unknown; draft?: unknown; stream?: unknown; ranIn?: unknown };
    const choice = talkChoice(body?.choice);
    if (body?.warm === true) {
      const call = callIdOf((body as { call?: unknown }).call);
      if (call) speech.beginCall(call);
      await speech.warmTalk(choice).catch(() => undefined);
      return send(res, 200, speech.talkStatus());
    }
    const kind = typeof body?.kind === 'string' && (KINDS as string[]).includes(body.kind) ? body.kind as PersonaKind : null;
    if (!kind) throw new HttpError(400, 'The kind is result, question, error or chat.');
    const request: PersonaRequest = {
      kind, language: spoken(language(typeof body.language === 'string' ? body.language : null)),
      said: typeof body.said === 'string' ? body.said.slice(0, 2000) : '',
      ...(typeof body.agent === 'string' ? { agent: body.agent.slice(0, 8000) } : {}),
      ...(cleanDraft(body.draft) ? { draft: cleanDraft(body.draft)! } : {}),
      ...(str(body.ranIn, 120) ? { ranIn: str(body.ranIn, 120)! } : {}),
    };
    const fileId = typeof body.fileId === 'string' && ID.test(body.fileId) ? body.fileId : undefined;
    const pageId = typeof body.pageId === 'string' && ID.test(body.pageId) ? body.pageId : undefined;
    const selection = Array.isArray(body.selection) ? body.selection.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 12) : [];
    const screen = await screenContext(screenSource(app), { fileId, pageId, selection }).catch(() => ({}));
    const said = cleanContext(body.context);
    // What the voice knows besides this call: the file's runs, the end of the last call about it while this one is
    // young, and the other files worked on lately. Kept short: the prompt stays within a few thousand tokens.
    const young = (said.history?.length ?? 0) < 6;
    const notes = kind === 'summary';
    const [runs, before, others, wishes] = await Promise.all([
      notes ? Promise.resolve([]) : recentRuns(app, fileId), young && !notes ? earlierCall(app, fileId) : Promise.resolve([]),
      notes ? Promise.resolve([]) : otherFiles(app, fileId), callPreferences(app).list().catch(() => []),
    ]);
    const preferences = wishes.map(preferenceLine);
    request.context = { ...said, ...screen, ...(runs.length ? { recentRuns: runs } : {}), ...(before.length ? { earlierCall: before } : {}), ...(others.length ? { otherFiles: others } : {}), ...(preferences.length && !notes ? { preferences } : {}) };
    runTruth(request.context, runs);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    if (body.stream === true || body.stream === 'text') {
      // One JSON line with the first piece to speak as soon as it is written (or, for `text`, everything written so far
      // after each piece), then one with the whole answer.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      const line = (o: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };
      try {
        line(body.stream === 'text'
          ? await speech.talk(request, choice, abort.signal, undefined, (soFar) => line({ soFar }))
          : await speech.talk(request, choice, abort.signal, (first) => line({ first })));
      } catch (err) {
        line({ text: null, source: 'rules', error: errorMessage(err), firstTokenMs: 0, totalMs: 0 });
      }
      res.end();
      return;
    }
    try {
      return send(res, 200, await speech.talk(request, choice, abort.signal));
    } catch (err) {
      return send(res, 200, { text: null, source: 'rules', error: errorMessage(err), firstTokenMs: 0, totalMs: 0 });
    }
  }
  if (name === 'log' && method === 'POST') {
    const body = (await json(req)) as { fileId?: unknown; conversationId?: unknown; lines?: unknown; summary?: unknown };
    const fileId = typeof body?.fileId === 'string' && ID.test(body.fileId) ? body.fileId : null;
    const conversationId = typeof body?.conversationId === 'string' && ID.test(body.conversationId) ? body.conversationId : null;
    if (!fileId || !conversationId) throw new HttpError(400, 'A call line needs its file and chat.');
    if (!app.storage?.get(fileId)) throw new HttpError(404, 'There is no such file.');
    await app.conversations?.addCallLines(fileId, conversationId, cleanLines(body.lines));
    const summary = str(body.summary, 600);
    if (summary) await app.conversations?.setCallSummary?.(fileId, conversationId, summary);
    return send(res, 200, { ok: true });
  }
  if (name === 'end' && method === 'POST') {
    const body = (await json(req)) as { call?: unknown };
    // The end of a call that another window took over since is late news: the call going on keeps its voice.
    const ended = await speech.endCall(callIdOf(body?.call));
    return send(res, 200, { ok: true, ended });
  }
  if (name === 'say' && method === 'POST') {
    const body = (await json(req)) as { text?: unknown; language?: unknown; voice?: unknown };
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'Nothing to say.');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const started = Date.now();
    const audio = await speech.say(text, language(typeof body.language === 'string' ? body.language : null), typeof body.voice === 'string' ? body.voice : undefined, abort.signal);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Bogen-Ms': String(Date.now() - started) });
    res.end(audio);
    return;
  }
  if (name === 'listen' && method === 'POST') {
    const ext = voiceExtension(String(req.headers['content-type'] ?? ''));
    if (!ext) { req.resume(); throw new HttpError(415, 'Send the recording as audio.'); }
    const audio = await readLimited(req, VOICE_LIMIT);
    if (!audio.length) return send(res, 200, { text: '', ms: 0 });
    const lang = language(url.searchParams.get('language'), true);
    const fileId = url.searchParams.get('fileId');
    const pageId = url.searchParams.get('pageId');
    const screen: Pick<CallContext, 'file' | 'page' | 'boards' | 'selection'> = fileId && ID.test(fileId) ? await screenContext(screenSource(app), { fileId, ...(pageId && ID.test(pageId) ? { pageId } : {}) }).catch(() => ({})) : {};
    // The files worked on lately too, so that "lass uns an der Trauermusik-Website weitermachen" is heard as named.
    const names = [screen.file, screen.page, ...(screen.boards ?? []), ...(screen.selection ?? []), ...recentFileNames(app)].filter((n): n is string => Boolean(n));
    const choice: HearChoice = url.searchParams.get('engine') === 'whisper' ? 'whisper' : 'auto';
    // A short line with the design words and what is on screen: a long list made Whisper large-v3 repeat it (hearing-call.md).
    return send(res, 200, await speech.listen(audio, ext, lang, hearPrompt(lang === 'auto' ? 'de' : lang, names), names, choice));
  }
  throw new HttpError(405, 'Method not allowed.');
}

export const _test = { hasFile, isPcm16k };

/** A call's id as its editor made it: a short word of letters and digits, or nothing. */
function callIdOf(v: unknown): string | undefined {
  return typeof v === 'string' && /^[\w-]{6,40}$/.test(v) ? v : undefined;
}

/** A draft for a brief as the editor sent it: lists of short strings, nothing else. */
function cleanDraft(v: unknown): DraftText | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 1200)).slice(0, 12) : []);
  const said = list(o.said);
  if (!said.length) return null;
  return { said, corrections: list(o.corrections), aside: list(o.aside), ...(o.steer === true ? { steer: true } : {}) };
}

const OTHER_WORDS = /^(?:que|qué|más|mas|por|para|con|los|las|una|uno|el|la|y|é|não|nao|uma|um|perguntas|est|les|des|une|et|pas|dans|il|che|non|sono|di|per|una|nie|jest|się|że|и|в|не|на|что)$/;
const OUR_WORDS = /^(?:und|der|die|das|ich|du|nicht|ist|mit|mach|bitte|ja|nein|auf|ein|eine|the|and|you|it|is|to|of|this|that|make|please|yes|no|can|what|with|on|a|i)$/;

/** Whether a line reads as another language than German or English: more of its words are another language's than ours. */
export function otherLanguage(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const other = words.filter((w) => OTHER_WORDS.test(w)).length;
  const ours = words.filter((w) => OUR_WORDS.test(w)).length;
  return other > 0 && other > ours;
}
