import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findFfmpeg } from './media.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * Voice notes and dictation, from the phone's comment sheet and from the editor's chat and comment boxes on this
 * computer. The audio comes from this machine, or over the phone listener, which has already checked the paired
 * phone's token, and stays here: in `$BOGEN_HOME/voice/`, never among the assets, so
 * that it is neither synced to other devices nor part of a `.bogen` file. If a local speech model is installed it
 * becomes text, and the audio is deleted at once. Nothing here installs or downloads a model, and nothing is sent
 * anywhere. Without a model the recording is kept as a voice note on the comment, until it is removed, its file is
 * deleted, or it is older than the retention period.
 */

export const VOICE_LIMIT = 10 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 300;
export const VOICE_RETENTION_MS = 30 * 86_400_000;
const SWEEP_MS = 6 * 3_600_000;
const DETECT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;
const CONVERT_TIMEOUT_MS = 60_000;

const TYPES: Record<string, string> = {
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
};
const MIME_OF: Record<string, string> = { m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav' };
const NAME = /^([a-f0-9]{24})\.(m4a|aac|webm|ogg|mp3|wav)$/;
const FILE_ID = /^[a-z0-9]{6,40}$/;

/** The kind of a body, without its parameters: `audio/webm;codecs=opus` is `audio/webm`. */
export function voiceExtension(contentType: string): string | null {
  return TYPES[contentType.split(';')[0]!.trim().toLowerCase()] ?? null;
}

export interface VoiceEntry { id: string; ext: string; fileId: string; at: number; bytes: number; duration?: number }

export interface Transcriber {
  kind: 'command' | 'whisper.cpp' | 'voxtype' | 'faster-whisper';
  /** In words, for the phone. */
  name: string;
  run: (audio: string) => Promise<string>;
}

function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const path = join(dir, name);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Next.
      }
    }
  }
  return null;
}

function run(command: string, args: string[], options: { timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024, env: options.env ?? process.env, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${command.split('/').at(-1)} failed: ${(String(stderr).trim().split('\n').at(-1) || error.message).slice(0, 300)}`));
      resolve(String(stdout));
    });
  });
}

/** whisper.cpp reads 16 kHz mono WAV. */
async function toWav(ffmpeg: string, input: string, output: string): Promise<void> {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeoutMs: CONVERT_TIMEOUT_MS });
}

/** Where people put whisper.cpp models. Only files already there are used. */
export function whisperModel(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BOGEN_WHISPER_MODEL) return existsSync(env.BOGEN_WHISPER_MODEL) ? env.BOGEN_WHISPER_MODEL : null;
  const home = env.HOME ?? homedir();
  const data = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const dirs = [
    join(data, 'whisper.cpp', 'models'), join(data, 'whisper-cpp', 'models'), join(data, 'whisper', 'models'),
    join(home, 'whisper.cpp', 'models'), join(home, '.cache', 'whisper.cpp'), join(home, '.cache', 'whisper-cpp'),
    '/usr/share/whisper.cpp/models', '/usr/share/whisper-cpp/models', '/usr/local/share/whisper.cpp/models', '/opt/whisper.cpp/models',
  ];
  // Small and base read speech well and quickly; bigger ones are slower than a comment is worth.
  const rank = (name: string) => ['small', 'base', 'medium', 'tiny', 'large'].findIndex((size) => name.includes(`-${size}`)) + 1 || 9;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => /^ggml-.+\.bin$/.test(n) && !/-encoder|for-tests/.test(n));
    } catch {
      continue;
    }
    names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const name of names) {
      try {
        if (statSync(join(dir, name)).size > 1_000_000) return join(dir, name);
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return null;
}

/**
 * A Whisper model Voxtype (Omarchy's dictation, Install > AI > Dictation) has already downloaded, by its name:
 * `ggml-base.en.bin` is `base.en`. Only files already there are used.
 */
export function voxtypeModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const data = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), '.local', 'share');
  const dir = join(data, 'voxtype', 'models');
  const rank = (name: string) => ['small', 'base', 'medium', 'tiny', 'large'].findIndex((size) => name.startsWith(size)) + 1 || 9;
  let names: string[];
  try {
    names = readdirSync(dir).map((n) => /^ggml-(.+)\.bin$/.exec(n)?.[1] ?? '').filter((n) => n && !/encoder|for-tests/.test(n));
  } catch {
    return null;
  }
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const name of names) {
    try {
      if (statSync(join(dir, `ggml-${name}.bin`)).size > 1_000_000) return name;
    } catch {
      // Gone meanwhile.
    }
  }
  return null;
}

/** What `voxtype transcribe` prints is its progress first, then the text. */
export function voxtypeText(out: string): string {
  return out.split('\n').filter((line) => !/^(Loading audio file|Audio format|Processing \d+ samples)/.test(line.trim())).join(' ');
}

/** A faster-whisper model already in the Hugging Face cache, by size. Never one that would have to be downloaded. */
function fasterWhisperModel(env: NodeJS.ProcessEnv): string | null {
  if (env.BOGEN_FASTER_WHISPER_MODEL) return env.BOGEN_FASTER_WHISPER_MODEL;
  const hub = env.HF_HUB_CACHE ?? join(env.HF_HOME ?? join(env.HOME ?? homedir(), '.cache', 'huggingface'), 'hub');
  for (const size of ['small', 'base', 'small.en', 'base.en', 'medium', 'tiny', 'large-v3']) {
    if (existsSync(join(hub, `models--Systran--faster-whisper-${size}`, 'snapshots'))) return size;
  }
  return null;
}

const FASTER_WHISPER = [
  'import sys',
  'from faster_whisper import WhisperModel',
  'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", local_files_only=True)',
  'segments, _ = model.transcribe(sys.argv[2], vad_filter=True)',
  'print(" ".join(s.text.strip() for s in segments))',
].join('\n');

/**
 * The transcriber this computer has, if any, in this order: `BOGEN_TRANSCRIBER` (a command given the audio's path,
 * which prints the text; `off` turns transcription off), whisper.cpp with a model file, Voxtype with a Whisper model
 * it downloaded, faster-whisper with a cached model. Found by looking, never by installing.
 */
export async function findTranscriber(env: NodeJS.ProcessEnv = process.env): Promise<Transcriber | null> {
  const given = env.BOGEN_TRANSCRIBER?.trim();
  if (given === 'off') return null;
  if (given) {
    const [command, ...args] = given.split(/\s+/);
    return { kind: 'command', name: command!.split('/').at(-1)!, run: (audio) => run(command!, [...args, audio], { timeoutMs: TRANSCRIBE_TIMEOUT_MS }) };
  }
  const ffmpeg = findFfmpeg(env);
  const whisper = onPath(['whisper-cli', 'whisper-cpp', 'whisper.cpp'], env);
  const model = whisper && ffmpeg ? whisperModel(env) : null;
  if (whisper && ffmpeg && model) {
    return {
      kind: 'whisper.cpp', name: 'whisper.cpp',
      run: async (audio) => {
        const dir = await mkdtemp(join(tmpdir(), 'bogen-voice-'));
        try {
          const wav = join(dir, 'note.wav');
          await toWav(ffmpeg, audio, wav);
          return await run(whisper, ['-m', model, '-f', wav, '-l', 'auto', '-nt', '-np'], { timeoutMs: TRANSCRIBE_TIMEOUT_MS });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    };
  }
  // Voxtype, with a Whisper model it already has, run locally whatever its own configuration says (it can also be
  // set to a remote server or a cloud engine, which Bogen never uses).
  const voxtype = ffmpeg ? onPath(['voxtype'], env) : null;
  const voxModel = voxtype ? voxtypeModel(env) : null;
  if (voxtype && ffmpeg && voxModel) {
    return {
      kind: 'voxtype', name: 'Voxtype',
      run: async (audio) => {
        const dir = await mkdtemp(join(tmpdir(), 'bogen-voice-'));
        try {
          const wav = join(dir, 'note.wav');
          await toWav(ffmpeg, audio, wav);
          return voxtypeText(await run(voxtype, ['-q', '--engine', 'whisper', '--whisper-mode', 'local', '--model', voxModel, 'transcribe', wav], { timeoutMs: TRANSCRIBE_TIMEOUT_MS }));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    };
  }
  const python = onPath(['python3'], env);
  const size = python ? fasterWhisperModel(env) : null;
  if (python && size) {
    const offline = { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    const present = await run(python, ['-c', 'import faster_whisper'], { timeoutMs: 15_000, env: offline }).then(() => true, () => false);
    if (present) return { kind: 'faster-whisper', name: 'faster-whisper', run: (audio) => run(python, ['-c', FASTER_WHISPER, size, audio], { timeoutMs: TRANSCRIBE_TIMEOUT_MS, env: offline }) };
  }
  return null;
}

/** What a transcriber printed, as the text of a comment: one paragraph, no timestamps or bracketed noise. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[\d{2}:\d{2}[^\]]*\]/g, ' ')
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]|\((silence|music|noise)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10_000);
}

export interface VoiceAnswer {
  transcript: string | null;
  /** The computer it happened on. */
  device: string;
  transcriber?: string;
  /** Without a transcript: the attachment for the comment, and why. */
  attachment?: { src: string; kind: 'audio'; name: string; duration?: number; device: string };
  reason?: string;
}

export class VoiceNotes {
  private index: VoiceEntry[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private detected: { at: number; found: Promise<Transcriber | null> } | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly options: { home: string; deviceName: () => string; fileExists: (id: string) => boolean; env?: () => NodeJS.ProcessEnv }) {}

  get dir(): string {
    return join(this.options.home, 'voice');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(fn);
    this.queue = next;
    return next;
  }

  private async entries(): Promise<VoiceEntry[]> {
    if (this.index) return this.index;
    try {
      const parsed = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as { notes?: VoiceEntry[] };
      this.index = (parsed.notes ?? []).filter((e) => NAME.test(`${e.id}.${e.ext}`));
    } catch {
      this.index = [];
    }
    return this.index;
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(join(this.dir, 'index.json'), JSON.stringify({ notes: this.index ?? [] }, null, 1), 0o600);
  }

  /** Looked for again after a minute, or when asked to, so a model installed meanwhile is found without a restart. */
  transcriber(fresh = false): Promise<Transcriber | null> {
    const env = this.options.env?.() ?? process.env;
    if (fresh || !this.detected || Date.now() - this.detected.at > DETECT_MS) this.detected = { at: Date.now(), found: findTranscriber(env).catch(() => null) };
    return this.detected.found;
  }

  async status(fresh = false): Promise<{ transcriber: { kind: string; name: string } | null; device: string; limit: number; maxSeconds: number; retentionDays: number }> {
    this.startSweeping();
    const found = await this.transcriber(fresh);
    return { transcriber: found ? { kind: found.kind, name: found.name } : null, device: this.options.deviceName(), limit: VOICE_LIMIT, maxSeconds: VOICE_MAX_SECONDS, retentionDays: VOICE_RETENTION_MS / 86_400_000 };
  }

  /** Streams the body to disk with the limit, then transcribes it or keeps it. */
  async receive(req: IncomingMessage, res: ServerResponse, fileId: string, duration: number | undefined): Promise<VoiceAnswer> {
    this.startSweeping();
    const ext = voiceExtension(String(req.headers['content-type'] ?? ''));
    if (!ext) throw new HttpError(415, 'A voice note has to be audio: mp4, aac, webm, ogg, mpeg or wav.');
    if (!FILE_ID.test(fileId) || !this.options.fileExists(fileId)) throw new HttpError(404, 'No such file.');
    const refuse = (error: HttpError) => {
      res.setHeader('Connection', 'close');
      return error;
    };
    const tooBig = () => new HttpError(413, `A voice note can be ${VOICE_LIMIT / 1048576} MB at most.`);
    if (Number(req.headers['content-length'] ?? 0) > VOICE_LIMIT) {
      req.resume();
      throw refuse(tooBig());
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = randomBytes(12).toString('hex');
    const path = join(this.dir, `${id}.${ext}`);
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > VOICE_LIMIT) return done(tooBig());
        done(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, createWriteStream(path, { mode: 0o600 }));
    } catch (e) {
      await rm(path, { force: true });
      if (e instanceof HttpError) throw refuse(e);
      throw new HttpError(400, 'The recording did not arrive in full.');
    }
    if (!size) {
      await rm(path, { force: true });
      throw new HttpError(400, 'The recording is empty.');
    }
    const device = this.options.deviceName();
    const transcriber = await this.transcriber();
    let reason = 'Transcription is unavailable on this computer: no local speech model is installed.';
    if (transcriber) {
      try {
        const text = cleanTranscript(await transcriber.run(path));
        if (text) {
          await rm(path, { force: true });
          return { transcript: text, device, transcriber: transcriber.name };
        }
        reason = 'Nothing was understood in the recording.';
      } catch (e) {
        reason = `Transcription failed: ${errorMessage(e)}`;
      }
    }
    const seconds = duration !== undefined && Number.isFinite(duration) ? Math.max(0, Math.min(VOICE_MAX_SECONDS * 2, Math.round(duration * 10) / 10)) : undefined;
    await this.serial(async () => {
      (await this.entries()).push({ id, ext, fileId, at: Date.now(), bytes: size, ...(seconds !== undefined ? { duration: seconds } : {}) });
      await this.save();
    });
    return {
      transcript: null, device, reason,
      ...(transcriber ? { transcriber: transcriber.name } : {}),
      attachment: { src: `bogen-voice:${id}.${ext}`, kind: 'audio', name: 'Voice note', ...(seconds !== undefined ? { duration: seconds } : {}), device },
    };
  }

  /** A kept recording, or null when it is not on this computer. */
  async read(name: string): Promise<{ bytes: Buffer; mime: string } | null> {
    const m = NAME.exec(name);
    if (!m) return null;
    if (!(await this.entries()).some((e) => e.id === m[1] && e.ext === m[2])) return null;
    const bytes = await readFile(join(this.dir, name)).catch(() => null);
    return bytes ? { bytes, mime: MIME_OF[m[2]!]! } : null;
  }

  async remove(name: string): Promise<boolean> {
    const m = NAME.exec(name);
    if (!m) return false;
    return this.serial(async () => {
      const list = await this.entries();
      const at = list.findIndex((e) => e.id === m[1] && e.ext === m[2]);
      await rm(join(this.dir, name), { force: true });
      if (at < 0) return false;
      list.splice(at, 1);
      await this.save();
      return true;
    });
  }

  /** Every recording kept for a file, when the file is deleted. */
  forgetFile(fileId: string): Promise<number> {
    return this.drop((e) => e.fileId === fileId);
  }

  /** Recordings past the retention period, of files that are gone, and leftovers no index lists. */
  async sweep(now = Date.now()): Promise<number> {
    const dropped = await this.drop((e) => now - e.at > VOICE_RETENTION_MS || !this.options.fileExists(e.fileId));
    const listed = new Set((await this.entries()).map((e) => `${e.id}.${e.ext}`));
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (name === 'index.json' || listed.has(name)) continue;
      // A recording being received or transcribed right now is not in the index yet.
      const age = await stat(join(this.dir, name)).then((s) => now - s.mtimeMs, () => 0);
      if (age > 3_600_000) await rm(join(this.dir, name), { force: true });
    }
    return dropped;
  }

  private drop(which: (e: VoiceEntry) => boolean): Promise<number> {
    return this.serial(async () => {
      const list = await this.entries();
      const gone = list.filter(which);
      if (!gone.length) return 0;
      for (const e of gone) await rm(join(this.dir, `${e.id}.${e.ext}`), { force: true });
      this.index = list.filter((e) => !gone.includes(e));
      await this.save();
      return gone.length;
    });
  }

  private startSweeping(): void {
    if (this.sweeper) return;
    void this.sweep().catch(() => {});
    this.sweeper = setInterval(() => void this.sweep().catch(() => {}), SWEEP_MS);
    this.sweeper.unref();
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

const notes = new WeakMap<object, VoiceNotes>();

/** One per server, made on first use. */
export function voiceNotes(app: { options: { home: string }; storage: { get: (id: string) => unknown }; peers: { deviceName: string } }): VoiceNotes {
  let found = notes.get(app);
  if (!found) {
    found = new VoiceNotes({ home: app.options.home, deviceName: () => app.peers.deviceName, fileExists: (id) => Boolean(app.storage.get(id)) });
    notes.set(app, found);
  }
  return found;
}

/**
 * `GET /api/voice/status[?fresh=1]`, `POST /api/voice?fileId=&duration=`, `GET|DELETE /api/voice/:name`. Only for the
 * owner: this machine, or a phone paired with it. Not on the tailnet listener.
 */
export async function handleVoiceRoute(app: Parameters<typeof voiceNotes>[0], req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], owner: boolean, send: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
  const method = req.method ?? 'GET';
  if (!owner) {
    req.resume();
    throw new HttpError(403, 'Voice notes are only for the person at this computer, or on a phone paired with it.');
  }
  const voice = voiceNotes(app);
  const [, name] = parts;
  if (name === 'status' && method === 'GET') return send(res, 200, await voice.status(url.searchParams.get('fresh') === '1'));
  if (!name && method === 'POST') {
    const duration = url.searchParams.has('duration') ? Number(url.searchParams.get('duration')) : undefined;
    return send(res, 201, await voice.receive(req, res, url.searchParams.get('fileId') ?? '', duration));
  }
  if (name && method === 'GET') {
    const found = await voice.read(name);
    if (!found) throw new HttpError(404, 'That voice note is not on this computer.');
    res.writeHead(200, { 'Content-Type': found.mime, 'Content-Length': found.bytes.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    res.end(found.bytes);
    return;
  }
  if (name && method === 'DELETE') {
    if (!(await voice.remove(name))) throw new HttpError(404, 'That voice note is not on this computer.');
    return send(res, 200, { ok: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}
