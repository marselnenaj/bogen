import type { CommentAttachment } from '@bogen/core';
import type { VoiceResult, VoiceStatus } from '../phone/voice.ts';

/**
 * Speaking instead of typing, in the editor's chat and comment boxes, apart from React. The recording goes to this
 * computer's server, which writes it out with a local speech model when it has one (packages/server/src/voice.ts).
 * The words land in the field for the person to check; nothing is sent by itself.
 */

/** Where the microphone is: the chat wants words only, a comment can keep a recording as a voice note. */
export type VoiceUse = 'chat' | 'comment';
export type VoicePhase = 'idle' | 'recording' | 'transcribing';
/** What stands in the way: no local model, a blocked or missing microphone, a browser that cannot record, or a failure. */
export type VoiceProblem = 'no-model' | 'denied' | 'no-mic' | 'unsupported' | 'nothing' | 'failed';

/** What getUserMedia's error means for the person. */
export function micProblem(error: unknown): VoiceProblem {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError' || name === 'NotReadableError') return 'no-mic';
  return 'failed';
}

/** Whether to record at all: the chat has no use for a recording that cannot become words. */
export function canStart(use: VoiceUse, status: VoiceStatus | null | undefined): VoiceProblem | null {
  if (use === 'chat' && status && !status.transcriber) return 'no-model';
  return null;
}

/** The words, added after what is already written. */
export function joinWords(current: string, words: string): string {
  const add = words.trim();
  if (!add) return current;
  return current.trim() ? `${current.trimEnd()} ${add}` : add;
}

export type VoiceOutcome =
  | { kind: 'text'; text: string; transcriber: string }
  | { kind: 'attach'; attachment: CommentAttachment; reason: string }
  | { kind: 'drop'; problem: VoiceProblem; reason: string; attachment: CommentAttachment };

/**
 * What a recording became. Words go into the field. Without words, a comment keeps the recording as a voice note;
 * the chat drops it (an agent cannot hear), and says why: no model, or nothing understood.
 */
export function voiceOutcome(result: VoiceResult, use: VoiceUse): VoiceOutcome {
  if (result.transcript !== null) return { kind: 'text', text: result.transcript, transcriber: result.transcriber };
  if (use === 'comment') return { kind: 'attach', attachment: result.attachment, reason: result.reason };
  const problem: VoiceProblem = !result.transcriber ? 'no-model' : /^Nothing was understood/.test(result.reason) ? 'nothing' : 'failed';
  return { kind: 'drop', problem, reason: result.reason, attachment: result.attachment };
}

/** The bars of the level meter, newest last, from 0 to 1. */
export function pushLevel(levels: readonly number[], level: number, bars = 20): number[] {
  return [...levels.slice(-(bars - 1)), Math.max(0, Math.min(1, level))];
}
