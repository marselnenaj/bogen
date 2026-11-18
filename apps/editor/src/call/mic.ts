/**
 * The microphone side of a call: the browser's echo cancellation and noise suppression on, an energy-based voice
 * activity detector, and each utterance cut where the person stops speaking, as 16 kHz mono WAV with a little of
 * the sound just before it began. Runs on the main thread with a ScriptProcessor, so it needs no worklet script.
 */

export interface MicEvents {
  onStart(): void;
  onEnd(wav: Blob, ms: number): void;
  onLevel(level: number): void;
}

const PREROLL_MS = 350;
const START_MS = 120;
/** Over the agent's voice it takes longer and louder speech to count as an interruption. */
const BARGE_START_MS = 200;
/** A stretch of speech ends after this much silence; whether the turn is over is decided by CallBrain. */
const END_SILENCE_MS = 550;
const MAX_UTTERANCE_MS = 30_000;

export function encodeWav16k(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(total / ratio));
  let pos = 0;
  let src = 0;
  const all = new Float32Array(total);
  for (const c of chunks) { all.set(c, src); src += c.length; }
  for (let i = 0; i < out.length; i++) {
    // Average over the source samples of this output sample: a plain low-pass before decimating.
    const from = Math.floor(i * ratio);
    const to = Math.min(all.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += all[j]!;
    const v = to > from ? sum / (to - from) : 0;
    out[pos++] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
  const header = new ArrayBuffer(44);
  const d = new DataView(header);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); d.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
  d.setUint16(22, 1, true); d.setUint32(24, 16000, true); d.setUint32(28, 32000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  w(36, 'data'); d.setUint32(40, out.length * 2, true);
  return new Blob([header, out.buffer], { type: 'audio/wav' });
}

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private inSpeech = false;
  private voicedMs = 0;
  private silenceMs = 0;
  private spokenMs = 0;
  private floor = 0.004;
  muted = false;
  /** Push to talk: only what is said while `held` counts. */
  hold = false;
  held = false;
  /** The agent is speaking: barge-in needs more. */
  agentSpeaking = false;

  constructor(private readonly events: MicEvents) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => this.frame(e.inputBuffer.getChannelData(0), e.inputBuffer.sampleRate);
    source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  stop(): void {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = this.stream = this.node = null;
  }

  /** Ends push-to-talk speech at once when the key or button is let go. */
  release(): void {
    this.held = false;
    if (this.inSpeech) this.finish();
  }

  private frame(input: Float32Array, rate: number): void {
    const data = new Float32Array(input);
    const ms = (data.length / rate) * 1000;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const rms = Math.sqrt(sum / data.length);
    this.events.onLevel(this.muted ? 0 : Math.min(1, rms * 12));
    if (this.muted || (this.hold && !this.held && !this.inSpeech)) { this.reset(); return; }
    if (!this.inSpeech) this.floor = this.floor * 0.95 + Math.min(rms, 0.05) * 0.05;
    const threshold = Math.max(this.agentSpeaking ? 0.012 : 0.008, this.floor * (this.agentSpeaking ? 5 : 2));
    const loud = this.hold ? this.held : rms > threshold;
    this.rate = rate;
    if (this.inSpeech) {
      this.utterance.push(data);
      this.spokenMs += ms;
      this.silenceMs = loud ? 0 : this.silenceMs + ms;
      if ((!this.hold && this.silenceMs >= END_SILENCE_MS) || this.spokenMs >= MAX_UTTERANCE_MS) this.finish();
      return;
    }
    this.preroll.push(data);
    let held = this.preroll.reduce((n, c) => n + (c.length / rate) * 1000, 0);
    while (held > PREROLL_MS && this.preroll.length > 1) { held -= (this.preroll.shift()!.length / rate) * 1000; }
    this.voicedMs = loud ? this.voicedMs + ms : Math.max(0, this.voicedMs - ms);
    if (this.voicedMs >= (this.agentSpeaking ? BARGE_START_MS : START_MS)) {
      this.inSpeech = true;
      this.utterance = [...this.preroll];
      this.spokenMs = held;
      this.silenceMs = 0;
      this.events.onStart();
    }
  }

  private rate = 48000;

  private finish(): void {
    const chunks = this.utterance;
    const ms = this.spokenMs;
    this.reset();
    this.events.onEnd(encodeWav16k(chunks, this.rate), ms);
  }

  private reset(): void {
    this.inSpeech = false;
    this.utterance = [];
    this.voicedMs = this.silenceMs = this.spokenMs = 0;
  }
}
