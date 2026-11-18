/**
 * The call's own sounds, made here with WebAudio, so there is no file to ship and nothing borrowed: soft sine tones
 * on the notes of one chord (A major: A4, C#5, E5, A5), quiet by default. Each says one thing:
 *
 * - dialling: two low notes, repeated while the call connects
 * - connected: a rising third
 * - ended: the same third falling
 * - mute / unmute: one short tick, lower for mute
 * - incoming: a gentle three-note figure, repeated while an agent rings
 * - failed: two low notes, falling a fifth
 * - moved: one short step up, when the call went along to the file the person opened
 *
 * The person can turn them off; the incoming ring is the only one that repeats, and it stops with the ring.
 * Nothing plays while the voice speaks: a sound never covers what the agent says.
 */

const SOUNDS_KEY = 'bogen-call-sounds';
const VOLUME = 0.06;

type Note = [frequency: number, at: number, length: number];

const A4 = 440, CS5 = 554.37, E5 = 659.25, A5 = 880, E4 = 329.63, A3 = 220;

const SHAPES: Record<CallSound, Note[]> = {
  dialling: [[A3 * 2, 0, 0.22], [E4, 0.3, 0.22]],
  connected: [[A4, 0, 0.16], [CS5, 0.12, 0.28]],
  ended: [[CS5, 0, 0.16], [A4, 0.12, 0.3]],
  mute: [[E4, 0, 0.08]],
  unmute: [[E5, 0, 0.08]],
  incoming: [[E5, 0, 0.16], [CS5, 0.18, 0.16], [A5, 0.36, 0.34]],
  failed: [[E4, 0, 0.2], [A3, 0.24, 0.36]],
  moved: [[CS5, 0, 0.1], [E5, 0.1, 0.18]],
};

export type CallSound = 'dialling' | 'connected' | 'ended' | 'mute' | 'unmute' | 'incoming' | 'failed' | 'moved';

export function soundsOn(): boolean {
  try { return localStorage.getItem(SOUNDS_KEY) !== 'off'; } catch { return true; }
}

export function setSoundsOn(on: boolean): void {
  try { localStorage.setItem(SOUNDS_KEY, on ? 'on' : 'off'); } catch { /* per session */ }
}

let ctx: AudioContext | null = null;
let voiceBusy: () => boolean = () => false;

/** Who says whether the voice speaks right now: the call session. */
export function setVoiceBusy(fn: () => boolean): void { voiceBusy = fn; }

/** Plays one sound, unless sounds are off or the voice is speaking. Returns its length in seconds. */
export function playSound(sound: CallSound): number {
  if (!soundsOn() || voiceBusy()) return 0;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + 0.01;
    let end = 0;
    for (const [freq, at, length] of SHAPES[sound]) {
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, start + at);
      gain.gain.exponentialRampToValueAtTime(VOLUME, start + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(start + at);
      osc.stop(start + at + length + 0.02);
      end = Math.max(end, at + length);
    }
    return end;
  } catch {
    return 0;
  }
}

/** Repeats a sound every `everyMs` until the returned function is called. */
export function repeatSound(sound: CallSound, everyMs: number): () => void {
  playSound(sound);
  const id = window.setInterval(() => playSound(sound), everyMs);
  return () => window.clearInterval(id);
}
