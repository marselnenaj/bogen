/**
 * Telling speech from noise in a call. Whisper writes words even when nobody spoke: on silence, room noise, typing or
 * the call's own voice coming back through the speakers it tends to answer with the sentences that end videos in its
 * training data ("Thank you.", "Thanks for watching", "Untertitel im Auftrag des ZDF"). A call must never take that
 * for a turn. Three checks, all cheap and without audio: markup Whisper uses for non-speech, the known closing lines
 * when there was little real speech, and the voice's own recent lines heard back.
 */

/** Whisper's ways of writing a sound that is not speech: "[Music]", "(Applause)", "*Fighting*", "♪", "...". */
const NON_SPEECH = /\[[^\]]*\]|\((?:[^)]*)\)|\*[^*]*\*|[♪♫♬🎵🎶]+/g;

/** English contractions written out, so "You're welcome." and "You are welcome." are the same words. */
const CONTRACTIONS: [RegExp, string][] = [
  [/\b(\w+)n['’]t\b/g, '$1 not'], [/\b(i)['’]m\b/g, '$1 am'], [/\b(\w+)['’]re\b/g, '$1 are'], [/\b(\w+)['’]ll\b/g, '$1 will'],
  [/\b(\w+)['’]ve\b/g, '$1 have'], [/\b(\w+)['’]d\b/g, '$1 would'], [/\b(it|that|there|what|here|he|she)['’]s\b/g, '$1 is'],
];

function words(text: string): string[] {
  let t = text.toLowerCase();
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t.replace(/\bcan not\b/g, 'cannot').replace(/\bwo not\b/g, 'will not').replace(/[.,!?;:"„“”'’…\-–]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Subtitle timing as Whisper copies it from its training data: "00:01:02,000 --> 00:01:04,500", "[00:12]", "12:04". */
const TIMESTAMP = /(?<![\p{L}\p{N}])(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?(?:\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)?(?![\p{L}\p{N}])|-->/gu;
/** Timing only a subtitle file has: an arrow between two times, or milliseconds. Removed wherever it stands. */
const SUBTITLE_TIMING = /(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}|-->/g;
/** A web address said by nobody: "www.zdf.de", "https://example.com/watch". */
const URL_ONLY = /^(?:(?:https?:\/\/|www\.)\S+|[\w-]+(?:\.[\w-]+)*\.(?:com|de|org|net|at|ch|tv|io|co|uk|eu|info)(?:\/\S*)?)$/i;
/** Only numbers and the marks around them, with a mark no person's words come with: "07 ·", "1 | 2", "— 3 —". */
const NUMBER_MARKS = /^[\d\s.,:;·•|—–\-#/]+$/u;

/**
 * What is left of a transcript once markup for non-speech is gone: sound descriptions in `*…*`, `[…]` or `(…)`,
 * subtitle timings, a lone web address, numbers between separators. Empty means nothing was said.
 */
export function spokenPart(text: string): string {
  const t = text.replace(NON_SPEECH, ' ').replace(SUBTITLE_TIMING, ' ').replace(/\s+/g, ' ').trim();
  // A time said in a sentence stays ("make it 12:30"); a line of nothing but times is a subtitle's.
  if (!/[\p{L}\p{N}]/u.test(t.replace(TIMESTAMP, ' '))) return '';
  const bare = t.replace(/^[\s"'„“”.,:;!?-]+|[\s"'„“”.,:;!?-]+$/g, '');
  if (URL_ONLY.test(bare)) return '';
  if (NUMBER_MARKS.test(t) && /[·•|—–#/]|^0\d/.test(t)) return '';
  return t;
}

/**
 * Lines Whisper is known to make up on silence, noise and music, in English and German. They are dropped only when
 * there was little real speech, so a person who really says "thank you" is still heard.
 */
const MADE_UP = new Set([
  'thank you', 'thank you very much', 'thank you so much', 'thanks', 'thanks for watching', 'thank you for watching',
  'thanks for watching and see you next time', 'thank you for your attention', 'please subscribe', 'subscribe',
  'like and subscribe', 'bye', 'bye bye', 'goodbye', 'you', 'so', 'okay', 'oh', 'hmm', 'the end', 'see you next time',
  'i ll see you next time', 'we ll see you next time',
  'vielen dank', 'danke', 'danke schön', 'dankeschön', 'vielen dank fürs zuschauen', 'danke fürs zuschauen',
  'tschüss', 'bis zum nächsten mal', 'untertitel im auftrag des zdf', 'untertitel im auftrag des zdf 2017',
  'untertitel im auftrag des zdf 2018', 'untertitel im auftrag des zdf 2020', 'untertitel im auftrag des zdf 2021',
  'untertitel der amara org community', 'untertitelung des zdf 2020', 'untertitel von stephanie geiges',
  'copyright', 'music', 'musik', 'applause', 'beifall', 'lachen', 'silence', 'stille',
]);

export function isMadeUpLine(text: string): boolean {
  const w = words(spokenPart(text));
  if (!w.length) return true;
  const joined = w.join(' ');
  if (MADE_UP.has(joined)) return true;
  // "Thank you. Thank you." and similar repeats of a made-up line.
  const half = w.length % 2 === 0 ? w.slice(0, w.length / 2).join(' ') : '';
  return Boolean(half) && half === w.slice(w.length / 2).join(' ') && MADE_UP.has(half);
}

/** How much speech a stretch held, as far as it is known: from a voice activity model, or only its length. */
export interface SpeechMeasure {
  /** Milliseconds a voice activity model found speech in, when one ran. */
  speechMs?: number;
  /** How long the stretch was, in milliseconds. */
  ms: number;
}

/** Below this much detected speech, a stretch is noise whatever Whisper wrote. */
export const MIN_SPEECH_MS = 250;
/** A known made-up line with less speech than this behind it is dropped. */
export const MADE_UP_SPEECH_MS = 900;

export type NoiseReason = 'no-speech' | 'made-up' | 'echo' | 'empty' | 'language';

/** Whether a transcript is noise rather than a turn, and why. Null means: a real turn. */
export function noiseVerdict(text: string, measure: SpeechMeasure): NoiseReason | null {
  if (!spokenPart(text)) return 'empty';
  if (measure.speechMs !== undefined && measure.speechMs < MIN_SPEECH_MS) return 'no-speech';
  if (isMadeUpLine(text)) {
    const speech = measure.speechMs ?? measure.ms;
    if (speech < MADE_UP_SPEECH_MS) return 'made-up';
  }
  return null;
}

/** A line the call's voice spoke, and when, to tell the person from the voice heard back. */
export interface SpokenLine { text: string; at: number }

/** How long after the voice began a line its sound may still come back through the microphone. */
export function echoWindowMs(text: string): number {
  return 4000 + words(text).length * 450;
}

/** The longest run of words two lists share in the same order. */
function sharedRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { row[j] = prev[j - 1]! + 1; if (row[j]! > best) best = row[j]!; }
    prev = row;
  }
  return best;
}

/**
 * Whether a transcript is the call's own voice coming back. The voice comes back while it plays, so a stretch that
 * began when the voice was quiet (`duringVoice: false`) is the person, whatever its words. Otherwise it must be most of
 * a line the voice just said, in the same order: echo returns a line nearly whole, while a person who asks "Is the
 * agent working?" after "Yes, the agent is still working on your request" reuses four of its twelve words. A question
 * is never taken for echo: the voice asks one at most, and dropping a person's question is the worse mistake.
 */
export function isEcho(text: string, recent: SpokenLine[], now: number, opts: { duringVoice?: boolean } = {}): boolean {
  if (opts.duringVoice === false) return false;
  if (/\?\s*$/.test(text.trim())) return false;
  const heard = words(spokenPart(text));
  if (!heard.length) return false;
  for (const line of recent) {
    if (now - line.at > echoWindowMs(line.text)) continue;
    const saidWords = words(line.text);
    const said = new Set(saidWords);
    if (!said.size) continue;
    const shared = heard.filter((w) => said.has(w)).length;
    if (shared / heard.length < 0.75 || (heard.length < 2 && said.size > 2)) continue;
    // Most of the line, and in its order.
    if (heard.length < 0.5 * said.size) continue;
    if (sharedRun(heard, saidWords) < heard.length - 1) continue;
    return true;
  }
  return false;
}
