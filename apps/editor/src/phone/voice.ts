import type { CommentAttachment } from '@bogen/core';
import { t } from '../i18n/store.ts';

/**
 * Voice notes and dictation, on the phone and in the editor: recorded with MediaRecorder, sent to the computer (over
 * the phone listener, or straight to this machine's own server) and turned into text there by a local model, if it
 * has one. See packages/server/src/voice.ts. Nothing goes anywhere else.
 */

/** As long as a comment is worth speaking. The computer refuses more than 10 MB in any case. */
export const MAX_RECORD_SECONDS = 180;

export interface VoiceStatus { transcriber: { kind: string; name: string } | null; device: string; limit: number; maxSeconds: number; retentionDays: number }

export type VoiceResult =
  | { transcript: string; device: string; transcriber: string }
  | { transcript: null; device: string; transcriber?: string; reason: string; attachment: CommentAttachment };

/** What this browser records in, best first: iOS only writes MP4 (AAC), others WebM or Ogg with Opus. */
export function recordingType(supported: (type: string) => boolean): string | null {
  for (const type of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    try {
      if (supported(type)) return type;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/** Whether recording can work here at all. When not, the keyboard's own dictation is the way to speak. */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

let statusOnce: Promise<VoiceStatus | null> | null = null;

/** Whether the computer can transcribe, asked once per session, or again when `fresh` (Check again, after a setup). */
export function voiceStatus(fresh = false): Promise<VoiceStatus | null> {
  if (fresh) statusOnce = null;
  statusOnce ??= fetch(fresh ? '/api/voice/status?fresh=1' : '/api/voice/status').then((res) => (res.ok ? res.json() as Promise<VoiceStatus> : null), () => null);
  return statusOnce;
}

export async function sendRecording(fileId: string, blob: Blob, seconds: number): Promise<VoiceResult> {
  const type = (blob.type || 'audio/mp4').split(';')[0]!;
  const res = await fetch(`/api/voice?fileId=${encodeURIComponent(fileId)}&duration=${seconds.toFixed(1)}`, { method: 'POST', headers: { 'Content-Type': type }, body: blob });
  const body = await res.json().catch(() => ({})) as VoiceResult & { error?: string };
  if (!res.ok) throw new Error(body.error ?? t('The recording was not sent ({status}).', { status: res.status }));
  return body;
}

/** A recording that was attached and then taken off the comment, or never sent, goes from the computer too. */
export function dropRecording(attachment: CommentAttachment): void {
  const name = /^bogen-voice:(.+)$/.exec(attachment.src)?.[1];
  if (name) void fetch(`/api/voice/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
}

export interface Recording {
  stop: () => Promise<{ blob: Blob; seconds: number }>;
  cancel: () => void;
}

/**
 * Starts recording from the microphone. `onLevel` gets the loudness from 0 to 1 a few times a second, for a meter.
 * Stops by itself at the length limit, through `onLimit`.
 */
export async function startRecording(onLevel: (level: number) => void, onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const type = recordingType((mime) => MediaRecorder.isTypeSupported(mime));
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const started = performance.now();
  let context: AudioContext | null = null;
  let frame = 0;
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Context) {
      context = new Context();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let last = 0;
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        if (now - last < 70) return;
        last = now;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      };
      frame = requestAnimationFrame(tick);
    }
  } catch {
    // No meter, the recording still works.
  }
  const limit = setTimeout(onLimit, MAX_RECORD_SECONDS * 1000);
  const release = () => {
    clearTimeout(limit);
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => {});
  };
  recorder.start(1000);
  return {
    stop: () => new Promise((resolve, reject) => {
      recorder.onstop = () => {
        release();
        const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/mp4' });
        if (!blob.size) reject(new Error(t('Nothing was recorded.')));
        else resolve({ blob, seconds: Math.min(MAX_RECORD_SECONDS, (performance.now() - started) / 1000) });
      };
      if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
      else recorder.stop();
    }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
