/**
 * How a voice call with the agent talks, as a conversation and not a reading. Two channels: the agent's words, tools
 * and details stay in the chat; what is spoken comes from a separate talking layer, a small local model (or plain
 * rules when there is none), held to one or two short sentences in the person's language. While the agent works the
 * call is quiet: one soft sound after a while, never a running commentary. The person may pause mid-thought without
 * being cut off, can talk over the voice at once, and "mhm" or "ja" while the voice speaks is not an interruption.
 *
 * The brain has no audio, network or timers of its own: the editor and the test harness feed it events and a clock,
 * and it answers through the sinks. That keeps the same logic in the call and in the measurements.
 */
import { callCommand, guessLanguage, speakable, takeSentences, type CallCommand, type CallLanguage } from './speech.ts';
import { isEcho, noiseVerdict, type NoiseReason, type SpokenLine } from './call-noise.ts';
import { asksForChange } from './asks-for-change.ts';
import { isRunSize, type RunSize } from './run-size.ts';
import { ASKS_REST, resultPoints, resultSay, resultText, tells } from './call-result.ts';
import { brandNote, brandTarget, callPreference, cleanSummary, durableWish, wordsFor, type CallPreference } from './call-memory.ts';

export type PersonaKind = 'result' | 'question' | 'error' | 'chat' | 'route' | 'progress' | 'brief' | 'summary' | 'turn' | 'event' | 'more';

/** One line of what was said in the call or written by the agent, oldest first, for the talking layer. */
export interface CallHistoryLine { who: 'person' | 'voice' | 'agent'; text: string }

/**
 * What the talking layer knows besides the words just said. The call fills the conversation part; the server adds
 * what is on screen (file, page, artboards, selection), so the voice can answer "which design?" without the agent.
 */
export interface CallContext {
  file?: string;
  page?: string;
  /** Names of the artboards on the page, in order. */
  boards?: string[];
  /** Names of the selected layers. */
  selection?: string[];
  /** The agent is working on a request right now. */
  working?: boolean;
  /** What the person asked the agent last, and the agent's whole last answer. */
  lastRequest?: string;
  lastResult?: string;
  /** A question or proposal the agent ended its last answer with, still open. */
  pendingQuestion?: string;
  /** While the agent works: what it did last (its latest words or tool), for progress updates. */
  activity?: string;
  history?: CallHistoryLine[];
  /**
   * The file's latest agent runs, newest first, as the server recorded them: also those from before the call, and
   * one still running even when the editor lost track of it. Added by the server for the talking layer.
   */
  recentRuns?: RecentRun[];
  /** The end of the last call about this file, for "what did we do last time?". Added by the server. */
  earlierCall?: string[];
  /** Other files worked on lately, with what was asked last, for "and the logo?". Added by the server. */
  otherFiles?: { name: string; lastAsked?: string }[];
  /**
   * The call so far in two sentences, kept by the talking layer every few turns: what the person wants, what was
   * decided and done, what is open. With it, only the newest lines of the call go along word for word.
   */
  callSummary?: string;
  /** How the person wants the voice to talk, said in this or an earlier call, as instructions. Added by the server. */
  preferences?: string[];
  /** The call moved on while the agent still works in this file: that run finishes there. */
  runFile?: string;
  /** The person is in the middle of saying a task: their words for it so far, not yet sent. */
  drafting?: string[];
  /** The voice read the task back and it starts unless the person says no or changes it. */
  readBack?: boolean;
  /** When the agent started working, in minutes, as far as the call knows. */
  workingMinutes?: number;
  /** While the agent works: what the voice already told the person since it started, so it is not said again. */
  toldThisRun?: string[];
  /** The agent's last answer has been told to the person already; it is there only to answer questions about it. */
  lastResultSpoken?: boolean;
  /** The points of the agent's last answer the voice has told, and those it has not told yet, in order. */
  resultTold?: string[];
  resultLeft?: string[];
  /** While the agent works: its latest steps, newest last, with the layers they touched and how long ago. */
  steps?: RunStep[];
}

/** One step of a running agent, for the voice: what it did, on which layers or artboards, and how long ago. */
export interface RunStep { what: string; names?: string[]; secondsAgo: number }

export interface RecentRun { minutesAgo: number; status: string; asked: string; result?: string; layers?: number }

/** What the talking layer is asked to say. `agent` is the agent's whole text for the run; it is never read out. */
/** `ranIn`, for a result: the run was in this file, which the call has left; the voice names it. */
export interface PersonaRequest { kind: PersonaKind; language: CallLanguage; said: string; agent?: string; context?: CallContext; draft?: DraftText; ranIn?: string }

/** What a brief is made from: the person's own words for one task, the corrections they made, and what else they said to the voice. */
export interface DraftText { said: string[]; corrections: string[]; aside: string[]; steer?: boolean }

/** Turns a request into words to speak (or, for `route`, a small JSON decision). Null or a throw means: use the rules. */
/**
 * `onFirst`, when the talking layer streams: its first whole sentence, as soon as it is written, so that the voice can
 * start speaking while the rest is still coming.
 */
/**
 * `onText`, when the talking layer streams: everything written so far, after each piece, for a turn whose action line
 * is acted on before the words below it are done.
 */
export type Persona = (req: PersonaRequest, signal: AbortSignal, onFirst?: (sentence: string) => void, onText?: (soFar: string) => void) => Promise<string | null>;

/** The first whole sentence of a text being written, once it is there: at least two words and a closing mark. */
export function firstSentence(text: string): string | null {
  const m = /^\s*(.+?[.!?…])(?=\s|$)/s.exec(text);
  if (!m || wordCount(m[1]!) < 2) return null;
  return m[1]!.trim();
}

/**
 * The first piece of a line being written that can be spoken on its own: its first sentence, or what comes before a
 * comma once three words stand before it and more follows ("Yes, it's on the redo," of "…, about a minute in."), so
 * the voice starts before the sentence is done.
 */
export function firstChunk(text: string): string | null {
  const sentence = firstSentence(text);
  // The first comma with three words before it, followed by more ("Yes, it's still going, about a minute in.").
  for (const m of text.matchAll(/,(?=\s+\S)/g)) {
    const before = text.slice(0, m.index).trim();
    if (sentence && before.length >= sentence.length) break;
    if (/[.!?…]/.test(before)) break;
    if (wordCount(before) >= 3) return `${before},`;
  }
  return sentence;
}

/** What is left of `whole` after its first words that are `first` (case and punctuation aside), or '' when it does not start so. */
export function restAfter(whole: string, first: string): string {
  const target = bare(first);
  if (!target) return whole.trim();
  // Word by word as written, compared without case and punctuation ("We're" is one written word and two bare ones).
  const w = whole.trim().split(/\s+/);
  for (let i = 1; i <= w.length; i++) {
    const head = bare(w.slice(0, i).join(' '));
    if (head === target) return w.slice(i).join(' ').trim();
    if (head.length > target.length) break;
  }
  return '';
}

const STOP_WORDS = new Set('a an the and or but so to of in on at for with it its it s is are was be been am i you he she we they me my your this that these those there here what which who how do does did not no yes yeah okay ok just still now then also very really about up out as by from will would can could should has have had im its youre thats hes ich du er es sie wir ja nein der die das ein eine und oder aber noch jetzt schon nur'.split(' '));

/** The words of a line that carry its meaning: no fillers, articles or pronouns. */
export function contentWords(text: string): Set<string> {
  return new Set(bare(text).replace(/['’]/g, '').split(' ').filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
}

/** How much two lines say the same: shared meaning words over all of them (0 to 1). */
export function similarity(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Lines this alike say the same thing again. */
export const SAME_NEWS = 0.6;

/**
 * A file's name as said on a call. A short one is said whole ("Tirava · Website" as "Tirava Website"); a long one by
 * its part before "·", ":", " - " or "|", at most four words ("Lindenhof · Bakery orders and pickup" is
 * "Lindenhof").
 */
export function spokenName(name: string): string {
  const whole = name.replace(/\s*[·|]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (whole.length <= 28) return whole;
  const head = name.split(/\s+[·|:–—-]\s+|\s*·\s*|:\s+/)[0]!.trim() || whole;
  const words = head.split(/\s+/);
  return words.length > 4 ? words.slice(0, 4).join(' ') : head;
}

/**
 * What to do with what the person said: hand it to the agent (with a short spoken acknowledgement), answer it here from
 * what the call knows, or ask back because it is too vague to act on. While the agent works there is more: `steer`
 * gives the running agent a change or addition to what it is doing now, `queue` keeps a separate new task for after
 * the run, and `voice` is about how the call itself talks ("keep me updated", "be quiet").
 */
export type RouteAction = 'agent' | 'answer' | 'clarify' | 'steer' | 'queue' | 'voice' | 'switch' | 'none';
/**
 * `recap`: answer by retelling the agent's last answer ("what did you just do?"), worded by the talking layer.
 * `updates`: for `voice`, whether the person wants short progress updates while the agent works.
 */
/** `soft`: the rules' answer is a fallback; the talking layer is asked first. */
/** `target`, for `switch`: the file as the person named it, or `here` for the file in front of them. */
export interface Route { action: RouteAction; say: string; recap?: boolean; updates?: boolean; soft?: boolean; word?: boolean; target?: string }

/** How a file the person named was found: the one, two close ones to choose from, or none. */
export type SwitchResult = { kind: 'switched'; name: string } | { kind: 'ambiguous'; names: string[] } | { kind: 'none' } | { kind: 'same'; name: string };

/**
 * One line of the call as it happened, kept with the chat so that a call can be looked at afterwards. A person's line
 * says which engine wrote it down; a stretch taken for noise is kept as `kind: 'noise'` with its `reason`.
 */
/** `source` `instant`: the short "Okay." said the moment a clear request ends, before the talking layer's own words. */
export interface CallLogLine { at: number; who: 'person' | 'voice'; text: string; kind?: string; route?: RouteAction; source?: LineSource; ms?: number; engine?: string; reason?: NoiseReason }
export type LineSource = 'persona' | 'rules' | 'agent' | 'instant';

export type SpokenKind = 'ack' | 'reply' | 'result' | 'queued' | 'command' | 'steer' | 'progress' | 'voice' | 'confirm';

/**
 * What goes to the agent besides the brief itself: a short title for the chat and the run lists, and the words shown
 * as the person's message in the chat (their request, not the whole brief).
 */
export interface SendMeta { title: string; display: string; /** How big the talking layer took the request to be, for the run's model. */ size?: RunSize }

export interface BrainSinks {
  /** Speak this line and show it as the call's caption. */
  say(text: string, kind: SpokenKind, language: CallLanguage): void;
  /**
   * Send a task to the agent. `text` is a brief the call made from what the person said (a goal, constraints and
   * their own words, marked as speech recognition), never a raw transcript.
   */
  send(text: string, language: CallLanguage, meta?: SendMeta): void;
  /**
   * Give the running agent a change to what it is doing now. The call stops the run where it is (what it changed so
   * far stays) and starts it again with the person's words as the next message, so the agent goes on from there.
   */
  steer?(text: string, language: CallLanguage, meta?: SendMeta): void;
  /**
   * Moves the call to the file the person named ("lass uns an der Website weitermachen"), or to the one in front of
   * them for `here`. The editor finds it on the server and calls `refocus` when it moved.
   */
  switchTo?(target: string, language: CallLanguage): Promise<SwitchResult>;
  /**
   * A spoken command: stop the run, undo it, hang up, mute, repeat. `quiet`: the call says its own words for it, so
   * the editor's line for the command is left out.
   */
  command(command: CallCommand, language: CallLanguage, opts?: { quiet?: boolean }): void;
  stopVoice(): void;
  /** Lower the voice while the person makes a sound over it, and bring it back. */
  duck(on: boolean): void;
  /** One soft sound: still working. */
  earcon(): void;
  /** The person's whole turn, as it goes to the agent or is answered here. */
  heard?(text: string): void;
  /** Every line of the call, for the record kept with the chat. */
  log?(line: CallLogLine): void;
  /** What is on screen now, for the talking layer: file, page, artboards and selection. Optional; the server adds it too. */
  screen?(): Pick<CallContext, 'file' | 'page' | 'boards' | 'selection'>;
  /** The call's notes were brought up to date: kept with the chat, for later calls about the file. */
  summary?(text: string): void;
  /** The person stated how the voice should talk; kept for every later call. */
  remember?(preference: CallPreference): void;
  /** Finds a brand by the name the person said, among the brands on this computer. Nothing is created. */
  findBrand?(said: string): Promise<{ kind: 'found'; id: string; name: string } | { kind: 'ambiguous'; names: string[] } | { kind: 'none' }>;
  /** Moves the call to another language; false when that language cannot be spoken here (its voice is missing). */
  setLanguage?(language: CallLanguage): boolean;
  /** The languages the call speaks here; a wish for one left out is answered as coming later. */
  languages?(): CallLanguage[];
}

export const CALL_TIMING = {
  /** After a turn that sounds unfinished ("und …", "mit dem"), how long to wait for more before taking it as said. */
  unfinishedWaitMs: 1800,
  /** However unfinished it sounds, a turn is taken as said this long after it began. */
  turnCeilingMs: 12_000,
  /** A request is collected this long after the person's last words before it goes to the agent, so that what they add goes with it. */
  draftQuietMs: 2500,
  /**
   * A request said in one finished sentence, whose brief the talking layer already wrote with its decision, goes once
   * the person has been quiet this long since their turn ended: they can still add to it, but it does not wait.
   */
  draftQuickMs: 1200,
  /** Changes said while the agent works go together once the person has been quiet this long. */
  steerQuietMs: 3000,
  /** The same for one clear change to the running task. */
  steerQuickMs: 1400,
  /** Making a brief from what was said must be quick, or the call's own wording goes. */
  briefTimeoutMs: 4500,
  /** After a read-back, the request starts unless the person says no or changes it within this long. */
  confirmWaitMs: 6000,
  /** Speech over the voice this long is a real interruption, not a "mhm". */
  bargeInMs: 500,
  /** A run this long with nothing said since the acknowledgement gets one soft sound. */
  nudgeAfterMs: 10_000,
  /** The talking layer must answer within this, or the rules speak. */
  personaTimeoutMs: 3000,
  /** Deciding what to do with a turn must be quick, or the rules decide. */
  routeTimeoutMs: 1800,
  /** With the talking layer deciding every turn: how long it may take to start its answer before the rules step in. */
  turnTimeoutMs: 4500,
  /** While the agent works, a change for it must reach it fast: the talking layer gets this long, then the rules act. */
  steerDecideMs: 1500,
  /** Hard ceiling for one spoken turn, in words. */
  maxWords: 25,
  /** With updates on, a short line about what the agent is doing, this often while it works. */
  updateEveryMs: 50_000,
  /**
   * Without them, a long run still gets one short line this often, from its latest steps, so the call is never silent
   * for minutes. The news budget holds a line that would repeat; "be quiet" stops them.
   */
  signOfLifeMs: 90_000,
  /** The call's notes are brought up to date after this many of the person's turns, when the call is quiet. */
  summaryEveryTurns: 4,
  /** The talking layer gets this long to write the notes; they wait for the next time otherwise. */
  summaryTimeoutMs: 9000,
  /** A half sentence left hanging gets at most one "Mm?" this often; otherwise the call just listens. */
  fragmentNudgeEveryMs: 60_000,
};

// ---------------------------------------------------------------- words

const BACKCHANNEL = /^(mhm+|mm+|hm+|aha|ah|ja+|jaja|jep|jo|okay|ok|o k|genau|richtig|stimmt|klar|gut|super|schön|passt|yes|yeah|yep|yup|right|alright|uh huh|sure|cool|nice|great|fine|i see)$/;

function bare(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:"„“”'’…-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A short sound of listening ("mhm", "ja", "okay"), which is not a turn of its own. */
export function isBackchannel(text: string): boolean {
  const t = bare(text);
  if (!t) return false;
  if (BACKCHANNEL.test(t)) return true;
  const words = t.split(' ');
  // "yeah yeah yeah", "ja ja", "okay okay": still only listening.
  return words.length <= 4 && words.every((w) => BACKCHANNEL.test(w));
}

/** Words a thought does not end on: conjunctions, articles, fillers. A turn ending on one waits for more. */
const DANGLING: Record<CallLanguage, RegExp> = {
  de: /(?:^|\s)(und|oder|aber|also|dann|äh+m?|öh+m?|hm+|der|die|das|den|dem|des|ein|eine|einen|einem|einer|weil|dass|ob|wenn|sowie|bzw|wie|ich|du|vielleicht|irgendwie|sondern)$/,
  en: /(?:^|\s)(and|or|but|then|uh+|um+|erm|er|with|the|a|an|because|that|if|like|maybe|which|i|kind of|sort of)$/,
};

/**
 * Words a sentence may well end on ("Schau dir das an.", "Mach das mal.", "Put it on."), but that also start a
 * phrase. They mean "unfinished" only when Whisper wrote no full stop after them.
 */
const PARTICLES: Record<CallLanguage, RegExp> = {
  de: /(?:^|\s)(mit|in|im|auf|an|am|zu|zum|zur|für|von|vom|bei|nach|über|unter|so|noch|etwas|mehr|mal|es)$/,
  en: /(?:^|\s)(so|in|on|at|to|for|of|from|more|some|it)$/,
};

const GREETING = /^(hallo|hi|hey|servus|moin|guten (morgen|tag|abend)|hörst du mich|kannst du mich hören|bist du da|danke|danke schön|vielen dank|wer bist du|hello|hey there|can you hear me|are you there|thanks|thank you|who are you)( .{0,20})?$/;

/**
 * Whether what the person said so far sounds like a finished turn. Mid-thought pauses usually come after a
 * conjunction, an article or a filler, or a trailing comma; one lone word that is not a command or an answer is also
 * taken as unfinished. Everything else is finished, so normal turns are not slowed down.
 */
export function endOfTurn(text: string, language: CallLanguage): 'complete' | 'unfinished' {
  const raw = text.trim();
  if (!raw) return 'unfinished';
  if (/[,–-]\s*$|(\.\.\.|…)\s*$/.test(raw)) return 'unfinished';
  const t = bare(raw);
  if (callCommand(raw) || isBackchannel(raw) || GREETING.test(t)) return 'complete';
  // A question or an exclamation is finished, whatever word it ends on ("Welches Design meinst du?").
  if (/[?!]\s*$/.test(raw)) return 'complete';
  // The words of the language the turn is in: "an" ends a German sentence ("Schau dir das an.") but not an English one.
  const lang = guessLanguage(raw, language);
  if (DANGLING[lang].test(t)) return 'unfinished';
  if (!/[.!?]\s*$/.test(raw) && PARTICLES[lang].test(t)) return 'unfinished';
  if (t.split(' ').length < 2 && !/[?!]\s*$/.test(raw)) return 'unfinished';
  return 'complete';
}

/** The longest run of words that `spoken` and `source` share, case and punctuation aside. */
export function verbatimRun(spoken: string, source: string): number {
  const a = bare(spoken).split(' ').filter(Boolean);
  const b = bare(source).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { row[j] = prev[j - 1]! + 1; if (row[j]! > best) best = row[j]!; }
    }
    prev = row;
  }
  return best;
}

/** A spoken line copies the agent when it shares this many words in a row with the agent's text. */
export const VERBATIM_WORDS = 8;

export function wordCount(text: string): number {
  return bare(text).split(' ').filter(Boolean).length;
}

/**
 * Makes any text fit to be heard: no markdown, code, paths, ids, colour codes or links; units and decimals said the
 * way people say them; at most two sentences and `maxWords` words.
 */
export function shapeSpoken(text: string, language: CallLanguage, maxWords = CALL_TIMING.maxWords, maxSentences = 2): string {
  const de = language === 'de';
  let s = speakable(text)
    .replace(/^["'„“”]+|["'„“”]+$/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/var\(\s*--[\w-]+\s*\)|--[a-z][\w-]*/gi, ' ')
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, ' ')
    .replace(/\b[\w-]+\.(?:tsx?|jsx?|css|html?|json|md|png|svg|jpe?g|webp|ydoc|bogen)\b/gi, ' ')
    .replace(/#[0-9a-f]{3,8}\b/gi, ' ')
    .replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,14}\b/g, ' ')
    .replace(/\b[a-z]+_[a-z_]+\b/g, ' ')
    .replace(/(\d+(?:[.,]\d+)?)\s?px\b/g, de ? '$1 Pixel' : '$1 pixels')
    .replace(/(\d+(?:[.,]\d+)?)\s?%/g, de ? '$1 Prozent' : '$1 percent')
    .replace(/(\d+(?:[.,]\d+)?)\s?:\s?1\b/g, de ? '$1 zu 1' : '$1 to 1')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (de) s = s.replace(/(\d)\.(\d)/g, '$1,$2');
  const { sentences } = takeSentences(s, language, true, 400);
  const out: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const n = wordCount(sentence);
    if (!out.length && n > maxWords) {
      const cut = sentence.split(/\s+/).slice(0, maxWords).join(' ').replace(/[,;:]$/, '');
      out.push(/[.!?]$/.test(cut) ? cut : `${cut}.`);
      break;
    }
    if (words + n > maxWords || out.length >= maxSentences) break;
    out.push(sentence);
    words += n;
  }
  return out.join(' ').trim();
}

/** "a, b und c", for names said aloud; at most `max` of them, then how many more. */
export function spokenList(names: string[], language: CallLanguage, max = 3): string {
  const and = language === 'de' ? 'und' : 'and';
  const clean = names.map((n) => n.replace(/\s*[,·|]\s*/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) return '';
  const shown = clean.slice(0, max);
  const more = clean.length - shown.length;
  if (more > 0) return `${shown.join(', ')} ${and} ${more} ${language === 'de' ? (more === 1 ? 'weiteres' : 'weitere') : (more === 1 ? 'more' : 'more')}`;
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(', ')} ${and} ${shown.at(-1)}`;
}

const FILLER = /^(okay|ok|great|so|yeah|yes|well|right|alright|and|also|cool|nice|good|super|please|after that|afterwards|then|ja|gut|und|genau|na ja|naja|perfekt|prima|bitte|danach|dann|noch)\b[,.!]?\s*/i;

/**
 * The gist of what the person said, short enough to say back: fillers at the start dropped, at most `max` words, no
 * end punctuation. "Great, so just use Fable as an advisor." becomes "just use Fable as an advisor".
 */
export function gist(said: string, max = 12): string {
  const clean = (x: string) => { let t = x.replace(/\s+/g, ' ').trim(); for (let i = 0; i < 4 && FILLER.test(t); i++) t = t.replace(FILLER, ''); return t; };
  const sentences = takeSentences(clean(said), 'en', true, 400).sentences.map(clean).filter((x) => x.split(' ').length >= 3);
  // The sentence that asks for something carries the request; remarks around it ("that's pretty rough") do not.
  const asks = /\b(use|make|add|keep|try|take|put|turn|change|move|give|show|ask)\b|\b(nimm|mach|füg|nutze|verwende|benutze|probier|setz|zeig|änder|gib|frag)\w*\b|\b(more|less|bigger|smaller|mehr|weniger|größer|kleiner|moderner|edler)\b/i;
  const pick = sentences.find((x) => asks.test(x)) ?? sentences[0] ?? clean(said);
  const words = pick.split(' ');
  let out = words.slice(0, max).join(' ');
  if (words.length > max) {
    // Cut at the last comma inside the limit, so the line does not stop mid-phrase.
    const comma = out.lastIndexOf(',');
    if (comma > out.length / 3) out = out.slice(0, comma);
  }
  const cut = out.replace(/[.,!?;:…]+$/, '').trim();
  return cut ? cut.charAt(0).toLowerCase() + cut.slice(1) : '';
}

/** "Hello?", "are you there?": the person checks the line, and "yes, I can hear you" is the answer. */
const PRESENCE = /^(?:(?:hallo|hello|hi|hey|ja|yeah|yes|okay|ok|so|also)\s*)*(?:bist du (?:noch )?da|are you (?:still )?there|can you hear me|do you hear me|hörst du mich|hörst du|kannst du mich hören)?$/;

/** The rules' lines, used when there is no talking model, it is slow, or it says something unusable. */
export function ruleLine(kind: PersonaKind | 'ack' | 'next' | 'queued' | 'clarify' | 'steer' | 'updates-on' | 'updates-off', language: CallLanguage, said = '', n = 0): string {
  const de = language === 'de';
  const pick = <T,>(list: T[]): T => list[Math.abs(n) % list.length]!;
  switch (kind) {
    case 'ack': return pick(de ? ['Mach ich.', 'Okay, mach ich.', 'Alles klar.', 'Gut, mach ich.'] : ['On it.', 'Okay, doing it.', 'Sure.', 'Got it.']);
    // The person's words are never read back to them: "passing that on: what's up" turned chat into a task out loud.
    case 'steer': return pick(de ? ['Verstanden, ich gebe das weiter.', 'Okay, ich sage es ihm gleich.', 'Alles klar, das kommt dazu.'] : ['Got it, I will pass that on.', 'Okay, I will tell it.', 'Understood, that goes in too.']);
    case 'queued': return pick(de ? ['Notiert, das kommt danach.', 'Okay, das mache ich als Nächstes.', 'Gut, das kommt gleich danach.'] : ['Noted, that comes right after.', 'Okay, that is next.', 'Sure, right after this one.']);
    case 'next': return pick(de ? ['Jetzt das Nächste, wie besprochen.', 'Weiter mit dem, was du vorhin gesagt hast.'] : ['Now the next thing you asked for.', 'On to what you asked for earlier.']);
    case 'updates-on': return de ? 'Klar, ich melde mich zwischendurch kurz, solange er arbeitet.' : 'Sure, I will check in now and then while it works.';
    case 'updates-off': return de ? 'Okay, ich bin still, bis es fertig ist.' : 'Okay, I will stay quiet until it is done.';
    case 'progress': return progressLine(said, language);
    case 'result': return pick(de ? ['Fertig. Die Details stehen im Chat.', 'Erledigt. Schau mal, ob es passt.'] : ['Done. The details are in the chat.', 'Done. Have a look and tell me if it works.']);
    case 'question': return de ? 'Ich habe eine Rückfrage, sie steht im Chat.' : 'I have a question for you, it is in the chat.';
    case 'error': return de ? 'Das hat nicht geklappt. Die Details stehen im Chat.' : 'That did not work. The details are in the chat.';
    case 'clarify': return de ? 'Was genau soll ich ändern?' : 'What exactly should I change?';
    case 'brief':
    case 'summary': return '';
    case 'event': return '';
    case 'more': return de ? 'Mehr steht im Chat.' : 'The rest is in the chat.';
    case 'route':
    case 'turn':
    case 'chat': {
      const t = bare(said);
      if (/^(danke|vielen dank|thanks|thank you)/.test(t)) return de ? 'Gern.' : 'You are welcome.';
      if (/^(wer bist du|who are you)/.test(t)) return de ? 'Ich bin die Stimme deines Agenten. Sag mir, was sich ändern soll.' : 'I am your agent\'s voice. Tell me what should change.';
      if (!t || PRESENCE.test(t)) return de ? 'Ja, ich höre dich. Was soll ich ändern?' : 'Yes, I can hear you. What should I change?';
      // Anything else that nobody could answer: say so, rather than act as if it was a "hello?".
      return de ? 'Das habe ich nicht ganz verstanden. Sagst du es noch mal anders?' : 'Sorry, I did not quite get that. Can you say it another way?';
    }
  }
}

/** What a tool of the agent means, said in a few words. */
const TOOL_WORDS: [RegExp, string, string][] = [
  [/screenshot|visual_diff|responsive_check/, 'looking at the result', 'schaut es sich das Ergebnis an'],
  [/lint|review|verify|a11y|check|audit|stress/, 'checking the design', 'prüft es das Design'],
  [/html_write|layer_|artboard|section_insert|batch|script_run|instance|component/, 'building the layers', 'baut es an den Ebenen'],
  [/token|text_style|type_scale|mode_/, 'working on the styles', 'arbeitet es an den Stilen'],
  [/brand/, 'working on the brand', 'arbeitet es an der Marke'],
  [/image|asset|mockup|pattern|icon/, 'working on images and graphics', 'arbeitet es an Bildern und Grafiken'],
  [/keyframes|motion|interaction|prototype/, 'working on the motion', 'arbeitet es an der Bewegung'],
  [/context_get|layer_tree|layer_find|guide_get|tokens_get|page_list|file_list/, 'reading the file', 'liest es die Datei'],
];

/** What a tool of the agent means, in a few words ("building the layers"). */
export function toolPhrase(tool: string): string {
  const name = tool.replace(/^mcp__[a-z0-9-]+__/i, '');
  const hit = TOOL_WORDS.find(([re]) => re.test(name));
  return hit ? hit[1] : name.replace(/_/g, ' ');
}

/** The last sentence of a text, for what the agent said last while it works. */
function lastSentence(text: string): string {
  const all = takeSentences(speakable(text), 'en', true, 800).sentences;
  return (all.at(-1) ?? text).trim().slice(0, 240);
}

/** The rules' progress line: what the agent's last tool means, or that it is still at it. */
export function progressLine(activity: string, language: CallLanguage): string {
  const de = language === 'de';
  const tool = /^tool:(\S+)/.exec(activity)?.[1] ?? '';
  const hit = tool ? TOOL_WORDS.find(([re]) => re.test(tool)) : undefined;
  if (hit) return de ? `Ich bin noch dran, gerade ${hit[2]}.` : `Still on it, it is ${hit[1]} now.`;
  return de ? 'Ich bin noch dran.' : 'Still on it.';
}

/** The last sentence of the agent's answer when it is a question or a proposal the person should answer. */
export function openQuestion(agentText: string): string | null {
  const sentences = takeSentences(speakable(agentText), 'en', true, 400).sentences;
  const last = (sentences.at(-1) ?? '').trim();
  if (/\?\s*$/.test(last)) return last;
  // "Tell me which artboard, or say go and I fix those first." and "If you want, I'll fix the weekdays first." are
  // proposals waiting for an answer too.
  if (/^(tell me|say |let me know|if you want|if you like|want me to|shall i|should i|sag mir|sag |gib mir bescheid|wenn du willst|wenn du möchtest|soll ich)/i.test(last)) return last;
  return null;
}

/**
 * The chat message that carries a change the person made while the agent worked. The run was stopped where it was, so
 * the message says to go on from the file as it is now and keep what is done unless the change says otherwise.
 */
export function steerMessage(said: string, language: CallLanguage): string {
  const words = said.replace(/\s+/g, ' ').trim();
  return language === 'de'
    ? `Während du gearbeitet hast, habe ich noch gesagt: "${words}" Bezieh das ein und mach dort weiter, wo die Datei jetzt steht. Was schon gemacht ist, bleibt, außer es widerspricht dem.`
    : `While you were working I added: "${words}" Take this into account and carry on from where the file is now. Keep what you already did unless this changes it.`;
}

// ---------------------------------------------------------------- briefs

/** "No, I said …", "nein, ich meinte …", "not X but Y": the person corrects what was understood. */
const CORRECTION = /^(?:(?:no|nope|nein|nee|not|nicht)[,.!]?\s+)?(?:i said|i meant|i mean|what i said|i didn t say|ich (?:hab|habe) (?:doch )?gesagt|ich meinte|ich meine|ich sagte|das habe ich nicht gesagt)\b|^(?:no|nein|nee)[,.!]?\s+(?:not|nicht|kein|keine)\b|^(?:not|nicht)\s+\S+(?:\s+\S+)?[,]?\s+(?:but|sondern)\b/;
/** "Go", "los", "that's it": the person is done describing and wants it started. */
const GO = /(?:^|\s)(?:go|go ahead|start|do it|that s it|that s all|thats it|los|leg los|fang an|mach los|das war s|das wars|das ist alles|mach das jetzt|jetzt los)$/;
/** Requests that change a lot at once: they are read back before they go. */
const RISKY = /\b(?:from scratch|start over|start again|redo (?:it|everything|the whole)|rebuild (?:it|everything|the whole)|whole (?:page|file|design) again|delete (?:all|everything|the page|the file)|remove everything|von vorne|von vorn|neu anfangen|komplett neu|ganz neu|alles neu|alles löschen|alles weg|die ganze seite neu)\b/;
/** Asking for a look, a review or an opinion: work for the agent, though it changes nothing. */
const REVIEW_ASK = /\b(?:check|review|look at|have a look|take a look|give (?:me )?(?:your )?(?:feedback|opinion|thoughts)|what do you think|how do you like|critique|schau dir|anschauen|ansehen|guck dir|prüf|pruef|wie findest du|was hältst du|was haeltst du|feedback)\b/;
/**
 * What a spoken request is about: the design and its parts, or how to work on it. A plain remark without any of these
 * ("that's awesome", "I'm waiting", "you didn't understand") is chat, however it is phrased.
 */
const DESIGN_WORD = /(?<![\p{L}\p{N}])(?:design|designs|page|pages|file|layout|colou?rs?|fonts?|type|typography|headlines?|heading|hero|buttons?|text|copy|images?|photos?|pictures?|sections?|logo|spacing|style|styles|modern|classy|class|elegant|minimal|3d|animations?|motion|full ?screen|mobile|desktop|artboards?|layers?|components?|tokens?|brand|concept|content|footer|header|nav|menu|grid|cards?|icons?|background|dark|light|bigger|smaller|big|small|wide|narrow|tall|short|bold|bolder|darker|lighter|blue|red|green|black|white|grey|gray|orange|yellow|purple|pink|fable|advisor|advice|redo|scratch|path|rules|version|seite|datei|farben?|schrift|überschrift|bild|bilder|abstand|abstände|stil|modern|edler|edel|animation|vollbild|handy|ebene|komponente|marke|konzept|inhalt|hintergrund|größer|kleiner|groß|gross|klein|breit|schmal|dunkler|heller|blau|rot|grün|schwarz|weiß|grau|gelb|fett|neu|von vorne)(?![\p{L}\p{N}])/u;
/** Verbs a spoken request opens with, also after "so", "and" or "just". */
const DO_VERB = /(?:^|[.,!?]\s*|\b(?:so|and|und|just|einfach|also|dann|then|please|bitte)\s+)(?:make|change|add|remove|use|put|move|fix|redo|rebuild|try|give|set|turn|ask|swap|replace|delete|keep|let s|mach|mache|ändere?|nimm|füg|entfern|lösch|setz|probier|frag|verwende|benutze|lass uns)\b/;
const QUESTION_LIKE = /^(?:what|why|how|which|where|who|when|is|are|am|was|were|does|did|do you|can you tell|have you|has it|warum|wieso|weshalb|wie|welche[srnm]?|wo|wer|wann|ist|sind|bist|hast|hat|gibt es|machst du|meinst du|kannst du mir sagen)\b/;

/** Whether the person corrects what the call understood. */
export function isCorrection(text: string): boolean { return CORRECTION.test(bare(text)); }

/** Whether the person asks something, rather than asking for something to be done. */
export function isQuestion(text: string): boolean {
  const raw = text.trim();
  if (/\?\s*$/.test(raw)) return true;
  return QUESTION_LIKE.test(bare(raw));
}

/**
 * Whether a turn is work for the agent: a change ("make it more modern"), or a look at the design ("what do you think
 * of it?"). Thanks, remarks and questions about the call are not, and never reach the agent or its queue.
 */
export function asksForWork(text: string): boolean {
  const t = bare(text);
  if (!t || isBackchannel(text)) return false;
  if (REVIEW_ASK.test(t)) return true;
  // Said, not typed: a request names something of the design or opens with a verb that does something to it.
  const aboutDesign = DESIGN_WORD.test(t) || DO_VERB.test(t);
  if (/\?\s*$/.test(text.trim())) {
    // "Can you make it bigger?" is a request; "is it still working?" is not.
    return /^(?:can|could|would|will) (?:you|u)\b|^(?:kannst|könntest|koenntest|würdest|wuerdest) du\b/.test(t) && aboutDesign && asksForChange(text);
  }
  return aboutDesign && asksForChange(text);
}

/** How long the end of a run may be when spoken: the gist and the top two or three points, in up to three sentences. */
export const RESULT_WORDS = 45;

/** The agent's words for the voice: the last `<say>…</say>` block of its answer, if it wrote one. */
export function sayTag(text: string): string | null {
  const all = [...text.matchAll(/<say>([\s\S]*?)<\/say>/gi)];
  const last = all.at(-1)?.[1]?.trim();
  return last ? last : null;
}

/** The agent's answer as shown in the chat: the `<say>` block's tags go, its words stay. */
export function stripSayTags(text: string): string {
  return text.replace(/<\/?say>/gi, '');
}

/** What the talking layer made of a draft: one goal and the conditions that go with it. */
export interface Brief { goal: string; constraints: string[]; /** small, large or answer, when the talking layer said. */ size?: RunSize }

/** Reads the talking layer's brief: `{"goal": "...", "constraints": [...]}`, tolerating fences and prose around it. */
export function parseBrief(raw: string): Brief | null {
  const m = /\{[\s\S]*\}/.exec(raw.replace(/```(json)?/g, ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { goal?: unknown; constraints?: unknown; size?: unknown };
    const goal = typeof o.goal === 'string' ? o.goal.replace(/\s+/g, ' ').trim() : '';
    if (!goal || wordCount(goal) > 60) return null;
    const constraints = Array.isArray(o.constraints) ? o.constraints.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.replace(/\s+/g, ' ').trim()).slice(0, 8) : [];
    return { goal, constraints, ...(isRunSize(o.size) ? { size: o.size } : {}) };
  } catch {
    return null;
  }
}

const quoteLines = (lines: string[]) => lines.map((l) => `"${l.replace(/\s+/g, ' ').trim()}"`).join('\n');

/**
 * The message the agent gets for a task said in a call: the call's reading of it (goal and conditions, when the
 * talking layer made one), then the person's own words marked as speech recognition, their corrections, and what else
 * they said to the voice since the agent's last turn. A change made while the agent worked says that it was
 * interrupted for it and should carry on from where the file is.
 */
export function briefMessage(draft: DraftText, brief: Brief | null, language: CallLanguage): string {
  const de = language === 'de';
  const out: string[] = [];
  out.push(draft.steer
    ? (de ? '[Sprachanruf. Gesagt, während du gearbeitet hast; du wurdest dafür unterbrochen.]' : '[Voice call. Said while you were working; you were interrupted for it.]')
    : (de ? '[Sprachanruf. Die Stimme des Anrufs hat das aus dem Gesagten zusammengefasst.]' : '[Voice call. Prepared by the call\'s voice from what the person said.]'));
  if (brief) {
    out.push(`${draft.steer ? (de ? 'Änderung an der Aufgabe' : 'Change to the task') : (de ? 'Ziel' : 'Goal')}: ${brief.goal}`);
    if (brief.constraints.length) out.push(`${de ? 'Bedingungen' : 'Constraints'}:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  out.push(`${de ? 'Wörtlich gesagt (Spracherkennung, kann Fehler enthalten)' : 'Said verbatim (speech recognition, may contain errors)'}:\n${quoteLines(draft.said)}`);
  if (draft.corrections.length) out.push(`${de ? 'Korrekturen (sie ersetzen, was sie korrigieren)' : 'Corrections (they replace what they correct)'}:\n${quoteLines(draft.corrections)}`);
  if (draft.aside.length) out.push(`${de ? 'Seit deinem letzten Zug zur Stimme gesagt' : 'Said to the voice since your last turn'}:\n${quoteLines(draft.aside)}`);
  if (draft.steer) out.push(de ? 'Mach dort weiter, wo die Datei jetzt steht. Was schon gemacht ist, bleibt, außer das hier ändert es.' : 'Carry on from where the file is now. Keep what you already did unless this changes it.');
  return out.join('\n\n');
}

/** The person's own words in a brief made by `briefMessage`, for tests and measurements. Any other text is returned whole. */
export function briefSaid(message: string): string {
  if (!message.startsWith('[')) return message;
  const block = /(?:Said verbatim|Wörtlich gesagt)[^:\n]*:\n((?:".*"\n?)+)/.exec(message)?.[1] ?? '';
  return block.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean).join(' ');
}

/** A brief from the rules: the person's request sentences as the goal, without the remarks around them. */
export function rulesBrief(draft: DraftText): Brief {
  const words = draft.said.join(' ').replace(/\s+/g, ' ').trim();
  const sentences = takeSentences(words, 'en', true, 1000).sentences.map((x) => x.trim()).filter(Boolean);
  const asks = sentences.filter((x) => asksForWork(x) || DESIGN_WORD.test(bare(x)));
  const goal = (asks.length ? asks : sentences).join(' ').slice(0, 400) || words.slice(0, 400);
  return { goal, constraints: draft.corrections.map((c) => `Correction: ${c}`) };
}

/** Whether a draft is read back before it goes: several turns, a correction, or a request that redoes a lot. */
export function needsReadBack(draft: DraftText): boolean {
  return draft.said.length > 1 || draft.corrections.length > 0 || draft.said.some((s) => RISKY.test(bare(s)));
}

/** The same answer in other words, for when it would otherwise be said twice in a row. */
export function otherWay(line: string, language: CallLanguage, n = 0): string {
  const de = language === 'de';
  const pick = (list: string[]) => list[Math.abs(n) % list.length]!;
  if (/still on it|noch dran/i.test(line)) return pick(de ? ['Er arbeitet noch daran.', 'Noch nicht fertig, ich melde mich.', 'Dauert noch einen Moment.'] : ['It is still working on it.', 'Not done yet, I will tell you.', 'Still going, give it a moment.']);
  if (/done and waiting|fertig und warte/i.test(line)) return pick(de ? ['Es läuft gerade nichts. Was soll ich machen?', 'Ich warte auf dich.'] : ['Nothing is running right now. What should I do?', 'I am waiting for you.']);
  if (/hear you|höre dich/i.test(line)) return de ? 'Ja, ich bin da.' : 'Yes, I am here.';
  return pick(de ? [`Wie gesagt: ${line}`, line] : [`As I said: ${line}`, line]);
}

/** The kind of answer the end of a run calls for. */
export function resultKind(agentText: string, ok: boolean): PersonaKind {
  if (!ok) return 'error';
  return openQuestion(agentText) ? 'question' : 'result';
}

const ASKS_WHICH = /\b(welche[snmr]?|was f[üu]r ein(e|en)?|wie hei(ß|ss)t)\s+(datei|design|seite|file|projekt|artboard|board|entwurf)\b|\b(which|what)\s+(file|design|page|project|artboard|board)\b|\bwo (bin ich|sind wir)\b|\bwhere am i\b|\bwhat am i looking at\b|\bworan arbeiten wir\b|\bwhat are we (working on|talking about)\b|\bwor[üu]ber reden wir\b/;
const ASKS_CONTENT = /\bwas (ist|steht|liegt|gibt es) (auf|hier|drauf|da)\b|\bwhat( s| is) on (the|this) page\b|\bwhat( is| s) (here|there)\b|\bwas ist (alles )?drauf\b/;
const ASKS_STATUS = /\b(bist du (fertig|noch dran|dabei)|wie weit bist du|wie lange (noch|dauert)|was (passiert|ist los|macht (er|der agent))|arbeitet (er|der agent) (noch|wieder)|are you (done|finished|still)|how (long|far)|what (are you|is he|is it|is the agent) doing|what s (going on|happening|up)|what is (going on|happening|up)|is (he|it|the agent) (still |again )?(working|done|finished)|if he s working|what is he (changing|looking at)|was machst du (gerade)?)\b/;
const ASKS_LAST = /\b(was hast du (gerade |eben |vorhin )?(gemacht|geändert|vorgeschlagen|gesagt|gefunden)|was hat (er|der agent) (gerade |eben |vorhin )?(gemacht|geändert)|what did (you|he|it|the agent) (just )?(do|change|suggest|say|find)|was war (das|dein vorschlag)|what was (that|your suggestion)|(what|which) (were|are) the (last|latest|recent) changes|what (has )?changed|was (waren|sind) die (letzten|neuesten) änderungen|was hat sich (geändert|getan)|(you re|you are|he s|he is|it s|it is) done with what|done with what|what (are|is) (you|he|it) done with|womit (bist du|ist er) fertig|was ist fertig)\b/;
const VAGUE = /^(bitte )?(änder|ändere|mach|tu|verbessere|change|do|fix|improve|make)( mal)? (etwas|was|irgendwas|irgendetwas|something|anything|it better|es besser|das besser)( bitte| please)?$/;
const YES = /^(ja|jo|jep|klar|gerne|gern|mach|mach das|mach mal|los|leg los|go|go ahead|yes|yeah|sure|do it|please do|okay mach|ok mach|bitte)\b/;
const NO = /^(nein|nee|no|nope|lass|lass es|don't|dont|nicht)\b/;
/** "Did you get that?": whether the call understood the person, answered from what they asked for. */
const ASKS_UNDERSTOOD = /\b(did you (get|understand) (that|it|me|my message)|(not sure|unsure) (if|whether) you (got|understood)|you got (that|it|me)|do you understand|hast du (das|mich|es) (verstanden|mitbekommen)|verstehst du (mich|das)|ob du (mich|das) (richtig )?verstanden hast)\b/;
/**
 * Working on another file: "lass uns an der Website weitermachen", "mach die Datei vom Logo auf", "öffne X",
 * "wechsel zu X", "switch to X", "open the file X", "let's work on X". The name is what follows.
 */
const FILE_WORD = '(?:datei|file|design|website|webseite|logo|marke|brand|präsentation|deck|seite)';
const SWITCH: RegExp[] = [
  /^(?:okay |ok |gut |also )?lass uns (?:jetzt |mal |noch )?(?:an|mit|bei|in) (.+?) (?:weiter ?machen|weiter ?arbeiten|arbeiten|weitermachen)$/,
  /^(?:okay |ok |also )?mach (?:mal )?(?:die datei |das design )(?:vom |von der |von dem |von )?(.+?) auf$/,
  new RegExp(`^(?:okay |ok |also )?mach (?:mal )?(.*\\b${FILE_WORD}\\b.*?) auf$`),
  /^(?:okay |ok |also )?(?:geh zu|geh in|wechsel(?:e)? (?:zu|zur|zum|in)) (?:die datei |das design |der datei )?(.+)$/,
  // "Öffne" and "open" also open menus and layers: only with a file word they mean a file.
  new RegExp(`^(?:okay |ok |also )?(?:öffne|oeffne) ((?:die datei|das design) .+|.*\\b${FILE_WORD}\\b.*)$`),
  /^(?:okay |ok |so )?(?:switch|go|move) (?:over )?to (?:the file |the design )?(.+)$/,
  new RegExp(`^(?:okay |ok |so )?open (?:up )?((?:the file|the design) .+|.*\\b${FILE_WORD}\\b.*)$`),
  /^(?:okay |ok |so )?let s (?:work on|continue with|go to|switch to|move to) (?:the file |the design )?(.+)$/,
];
const HERE = /^(?:diese|dieser|diesem|die|der|this|the) (?:datei|file|design)(?: hier| here)?$|^hier$|^here$|^(?:die|diese|dieser) hier$/;

/** The file a turn asks to work in, or null: `here` for the one in front of the person. */
export function switchTarget(said: string): string | null {
  const t = bare(said);
  for (const re of SWITCH) {
    const m = re.exec(t);
    if (!m) continue;
    const name = m[1]!.replace(/^(?:die datei|das design|the file|the design) /, '').replace(/^(?:der|die|das|den|dem|the|a) /, '').replace(/\b(bitte|please|mal|jetzt|now)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) return null;
    return HERE.test(name) ? 'here' : name;
  }
  return null;
}

/** Which of two named files the person picked: by order ("die erste", "the second") or by a word only one name has. */
export function pickName(said: string, names: string[]): string | null {
  const t = bare(said);
  if (/\b(erste|ersten|first|former)\b/.test(t)) return names[0] ?? null;
  if (/\b(zweite|zweiten|andere|anderen|second|latter|other)\b/.test(t)) return names[1] ?? null;
  const words = t.split(' ').filter((w) => w.length > 2 && !/^(die|der|das|den|dem|the|und|and|bitte|please|datei|file|meine|mein)$/.test(w));
  const fits = names.filter((n) => { const name = bare(n); return words.some((w) => name.includes(w)); });
  const only = fits.length === 1 ? fits[0]! : null;
  // A word both names share ("Trauermusik") picks nothing; one that only one has picks it.
  return only && !names.every((n) => words.every((w) => bare(n).includes(w))) ? only : null;
}

/** "Keep me updated": short progress updates while the agent works. */
const UPDATES_ON = /\b(keep (me )?(updated|posted|in the loop)|keep narrating|narrate|tell me what (he|it|the agent) (is|s) doing|keep (on )?updating( me)?|update me|give me (an )?updates?|tell me (how it|what s|what is) going|(halt|halte) mich( \w+)? (auf dem laufenden|informiert)|sag mir (zwischendurch|ab und zu|immer wieder) bescheid|gib mir (zwischendurch )?(updates|bescheid)|meld dich zwischendurch)\b/;
/** "Be quiet": no updates until the run ends. */
const UPDATES_OFF = /\b(be quiet|stay quiet|no (more )?updates|stop (the )?updates|don t update me|sei (mal )?still|sei ruhig|keine updates|hör auf mit den updates|nicht mehr melden)\b/;
/** A separate task for after the run: "after that", "danach", "next". */
const NEW_TASK = /^(after (that|this|you re done|you are done)|afterwards|when you re done|when you are done|once you re done|then also|next|later|danach|anschließend|wenn du fertig bist|als nächstes|später|außerdem danach)\b/;

/**
 * What to do with a turn when the talking layer cannot decide: questions about what is on screen, about the last
 * answer or about progress are answered here; a request too vague to act on is asked back; everything else goes to
 * the agent. Never invents: an answer is built only from what the context holds.
 */
export function routeByRules(said: string, ctx: CallContext, language: CallLanguage): Route {
  const de = language === 'de';
  const t = bare(said);
  const target = switchTarget(said);
  if (target) return { action: 'switch', say: '', target };
  if (ASKS_WHICH.test(t)) {
    if (ctx.file) {
      const page = ctx.page ? (de ? `, auf der Seite ${ctx.page}` : `, on the page ${ctx.page}`) : '';
      return { action: 'answer', say: de ? `Um die Datei ${ctx.file}${page}.` : `The file ${ctx.file}${page}.` };
    }
    return { action: 'answer', say: de ? 'Gerade ist keine Datei offen.' : 'No file is open right now.' };
  }
  if (ASKS_CONTENT.test(t)) {
    const boards = ctx.boards ?? [];
    if (!boards.length) return { action: 'answer', say: de ? 'Die Seite ist leer.' : 'The page is empty.' };
    const n = boards.length;
    return { action: 'answer', say: de ? `${n === 1 ? 'Ein Artboard' : `${n} Artboards`}: ${spokenList(boards, language)}.` : `${n === 1 ? 'One artboard' : `${n} artboards`}: ${spokenList(boards, language)}.` };
  }
  if (ASKS_STATUS.test(t)) {
    if (ctx.working) return { action: 'answer', say: ctx.activity ? progressLine(ctx.activity, language) : (de ? 'Ich bin noch dran, ich sage Bescheid, wenn es fertig ist.' : 'Still on it, I will tell you when it is done.'), soft: true };
    // Idle: what it finished, not a bare "done". Without a result in this call the talking layer answers from the
    // file's run history, which the server adds; the line here is only for when there is no talking layer.
    if (ctx.lastResult) return { action: 'answer', say: '', recap: true };
    return { action: 'answer', say: de ? 'Gerade läuft nichts. Was soll ich machen?' : 'Nothing is running right now. What should I do?', soft: true, word: true };
  }
  if (ASKS_LAST.test(t)) {
    if (ctx.lastResult) return { action: 'answer', say: '', recap: true };
    return { action: 'answer', say: de ? 'In diesem Gespräch hat er noch nichts fertig gemacht.' : 'Nothing has been finished in this call yet.', soft: true, word: true };
  }
  if (ASKS_UNDERSTOOD.test(t)) {
    const what = gist(ctx.lastRequest ?? '', 14);
    if (!what) return { action: 'clarify', say: de ? 'Noch nicht ganz. Was soll ich machen?' : 'Not quite yet. What should I do?' };
    const doing = ctx.working ? (de ? ' Daran arbeitet er gerade.' : ' It is working on that now.') : '';
    // The talking layer, which has the whole call, may say it better.
    return { action: 'answer', say: de ? `Ja: ${what}.${doing}` : `Yes: ${what}.${doing}`, soft: true, word: true };
  }
  if (UPDATES_OFF.test(t)) return { action: 'voice', say: ruleLine('updates-off', language), updates: false };
  if (UPDATES_ON.test(t)) {
    // "Keep updating me" alone is about the call. With a request in it too, the request goes on as well.
    const rest = t.replace(UPDATES_ON, ' ').replace(/\b(and|und|please|bitte|here and there|ab und zu|zwischendurch)\b/g, ' ').replace(/\s+/g, ' ').trim();
    // "Keep narrating what the agent is doing" is about the call too: what is left names nothing of the design.
    if (rest.split(' ').filter(Boolean).length < 3 || !DESIGN_WORD.test(rest)) return { action: 'voice', say: ruleLine('updates-on', language), updates: true };
  }
  if (VAGUE.test(t)) return { action: 'clarify', say: ruleLine('clarify', language) };
  if (ctx.pendingQuestion && NO.test(t) && t.split(' ').length <= 6) return { action: 'answer', say: de ? 'Okay, dann lasse ich es. Was soll ich stattdessen machen?' : 'Okay, I will leave it. What should I do instead?' };
  if (ctx.working) {
    // While it works, a request is almost always about the same task: more detail, a change of mind, how to go about
    // it. Only a task marked as coming after waits for the run to end. Remarks, chat and questions never touch the
    // run: a question is answered from what the call knows, and the rest is only listened to.
    if (isCorrection(said) && DESIGN_WORD.test(t)) return { action: 'steer', say: '' };
    if (asksForWork(said) && wordCount(said) >= 3) return { action: NEW_TASK.test(t) ? 'queue' : 'steer', say: '' };
    if (isQuestion(said)) return { action: 'answer', say: progressLine(ctx.activity ?? '', language), soft: true };
    return { action: 'none', say: '' };
  }
  if (ctx.pendingQuestion && YES.test(t)) return { action: 'agent', say: de ? 'Gut, ich mache das.' : 'Good, doing that.' };
  if (isCorrection(said) && (DESIGN_WORD.test(t) || ctx.lastRequest)) return { action: 'agent', say: '' };
  // A question about the design goes to the agent, which answers it without changing anything. "What?", "really?"
  // or "what do you mean?" are about what the voice said, and the voice answers them.
  if (isQuestion(said) && DESIGN_WORD.test(t)) return { action: 'agent', say: '' };
  if (isQuestion(said)) {
    const last = [...(ctx.history ?? [])].reverse().find((h) => h.who === 'voice')?.text;
    return { action: 'answer', say: last ? (de ? `Ich sagte: ${last}` : `I said: ${last}`) : (de ? 'Ja?' : 'Yes?'), soft: true, word: true };
  }
  if (asksForWork(said) && wordCount(said) >= 2) return { action: 'agent', say: '' };
  return { action: 'none', say: '' };
}

/** Reads the talking layer's routing answer: `{"action": "...", "say": "..."}`, tolerating fences and prose around it. */
export function parseRoute(raw: string): Route | null {
  const m = /\{[\s\S]*\}/.exec(raw.replace(/```(json)?/g, ''));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { action?: unknown; say?: unknown; updates?: unknown };
    const actions: RouteAction[] = ['agent', 'answer', 'clarify', 'steer', 'queue', 'voice', 'none'];
    const action = actions.find((a) => a === o.action) ?? null;
    if (!action) return null;
    return { action, say: typeof o.say === 'string' ? o.say : '', ...(typeof o.updates === 'boolean' ? { updates: o.updates } : {}) };
  } catch {
    return null;
  }
}

/**
 * What the talking layer decided to do with a turn, when it decides every turn (`turnModel`). It writes an action tag
 * on the first line and the words to speak below it, so the first sentence can be spoken while the rest is written.
 */
export type TurnAction = 'answer' | 'clarify' | 'agent' | 'steer' | 'queue' | 'stop' | 'undo' | 'switch' | 'brand' | 'listen' | 'updates-on' | 'updates-off';
/** `brief`: for work, the goal and conditions the talking layer wrote on the action line, so no second call makes one. */
export interface TurnDecision { action: TurnAction; arg: string; say: string; brief?: Brief }
const TURN_ACTIONS: TurnAction[] = ['answer', 'clarify', 'agent', 'steer', 'queue', 'stop', 'undo', 'switch', 'brand', 'listen', 'updates-on', 'updates-off'];

/**
 * Reads `@action [argument]` and the spoken words below it. `partial`: the text is still being written, so a header
 * without its line break yet is not taken (a file name could go on). Null when there is no valid header.
 */
export function parseTurn(raw: string, partial = false): TurnDecision | null {
  const text = raw.replace(/```[a-z]*\n?/g, '').replace(/^\s+/, '');
  const m = /^@([a-z-]+)[ \t]*([^\n]*)(\n|$)/.exec(text);
  if (!m) return null;
  if (partial && m[3] !== '\n') return null;
  const action = TURN_ACTIONS.find((a) => a === m[1]!.toLowerCase());
  if (!action) return null;
  const say = text.slice(m[0].length).replace(/^\s*say:\s*/i, '').trim();
  const arg = m[2]!.replace(/^["“„']|["“”']$/g, '').trim();
  const brief = action === 'agent' || action === 'steer' || action === 'queue' ? headerBrief(arg) : null;
  return { action, arg, say, ...(brief ? { brief } : {}) };
}

/** "goal: Redo the start page as a magazine | keep: the brand colours; the portraits" from an action line. */
export function headerBrief(arg: string): Brief | null {
  const m = /^goal:\s*(.+?)\s*(?:\|\s*keep:\s*(.*?))?\s*(?:\|\s*size:\s*(small|large|answer)\b[^|]*)?$/i.exec(arg.trim());
  if (!m) return null;
  const goal = m[1]!.replace(/\s+/g, ' ').trim();
  if (!goal || wordCount(goal) > 60) return null;
  const constraints = (m[2] ?? '').split(/\s*;\s*/).map((c) => c.trim()).filter((c) => c && !/^(none|-|nothing)$/i.test(c)).slice(0, 8);
  const size = m[3]?.toLowerCase();
  return { goal, constraints, ...(isRunSize(size) ? { size } : {}) };
}

// ---------------------------------------------------------------- the conversation

export interface BrainOptions {
  language: CallLanguage;
  now(): number;
  persona: Persona | null;
  sinks: BrainSinks;
  timing?: Partial<typeof CALL_TIMING>;
  /**
   * Let the talking layer decide what a turn is (answer, request, steer, queue). Off by default: the rules decide,
   * so a turn is routed the same way with any talking layer, at once and before anything is awaited, and the talking
   * layer only words what is said and writes the brief. On only for experiments.
   */
  personaRoutes?: boolean;
  /**
   * The talking layer decides every turn and words it in one go: whether to answer, ask back, hand work to the agent,
   * change the running task, stop it, move to another file, or just listen. The rules only speak when it does not
   * answer in time. On with a talking layer that is good enough for it (Claude Code).
   */
  turnModel?: boolean;
  /**
   * With `turnModel`: the moment a clear request for design work ends, say a short "Okay." (a cached clip in the
   * editor), so the first sound comes at once; the talking layer's own acknowledgement follows.
   */
  instantAck?: boolean;
}

const INSTANT_ACK: Record<CallLanguage, string> = { en: 'Okay.', de: 'Okay.' };
/** "Okay," "Sure," "Got it," at the start of an acknowledgement, left out after the instant "Okay.". */
const LEAD_ACK = /^(?:okay|ok|sure|alright|all right|got it|right|great|good|klar|gut|alles klar|gerne?)[,.!]?\s+(?=\S)/i;
/** Thanks and compliments: no answer needed, and none at all with the person's wish for quiet. */
const THANKS = /^(?:(?:okay|ok|oh|great|cool|nice|ah|so)[,.!]?\s+)?(?:thanks?(?: you)?(?: so much| a lot| very much)?|thank you|cheers|danke(?: schön| dir| sehr)?|vielen dank|you(?: re| are) (?:amazing|great|the best|awesome)|(?:that s|this is|sounds) (?:great|cool|nice|good|awesome|amazing|perfect)|awesome|perfect|nice|great|cool|super|toll|klasse|wunderbar|perfekt)(?:[,.!]?\s+(?:thanks|thank you|danke|man|mate))?$/;
/** Words that carry a complaint or a doubt: worth an answer, even said in passing. */
const DOUBT = /\b(not|wrong|isn t|doesn t|don t|didn t|no|never|broken|annoying|ugh|weird|strange|frustrat\w*|nicht|falsch|kaputt|komisch|nervig)\b/;
/** Requests that are likely asked back about ("make it better", "redo the whole thing"): no instant "Okay." for them. */
const VAGUE_ASK = /\b(better|worse|nicer|improve|redo|the whole thing|everything|something|anything|besser|schöner|alles|irgendwas)\b/;
/** Checking the line: always answered. */
const LINE_CHECK = /^(?:hallo|hello|hi|hey|servus|are you there|can you hear me|bist du da|hörst du mich|anybody there)\b/;

const HISTORY_LINES = 12;
/** With notes on the call, this many of its newest lines go along word for word. */
const SUMMARY_LINES = 6;
const HISTORY_CHARS = 700;

export class CallBrain {
  language: CallLanguage;
  private readonly timing: typeof CALL_TIMING;
  private parts: string[] = [];
  private deadline: number | null = null;
  private inSpeech = false;
  /** Stretches of speech that ended but whose words have not come back yet. */
  private transcribing = 0;
  private speechStartedAt = 0;
  private voicePlaying = false;
  private overlap = false;
  private running = false;
  private runStartedAt = 0;
  private nudged = false;
  private spokeThisRun = false;
  /** Tasks said for after the current run, in order, each as its own draft. */
  private queue: { draft: DraftText; language: CallLanguage }[] = [];
  /** The request being said: the person's turns for one task, until they are quiet long enough or say go. */
  private draft: DraftText | null = null;
  private draftLanguage: CallLanguage;
  private draftDeadline: number | null = null;
  /** The draft was read back; a yes sends it, a no or a change edits it. */
  private confirming = false;
  private confirmDeadline: number | null = null;
  /** A brief is being made and sent: nothing else may send meanwhile. */
  private sending = false;
  /** What the person said to the voice since the agent's last turn (answers, chat, call settings), for the next brief. */
  private aside: string[] = [];
  /** Changes said while the agent works, sent together once the person is quiet. */
  private steerParts: string[] = [];
  private steerCorrections: string[] = [];
  private steerDeadline: number | null = null;
  /** When the first words of the turn being said came, for the hard ceiling on one turn. */
  private firstPartAt = 0;
  private lastSaid = '';
  private lastSpokenWasQuestion = false;
  private turns = 0;
  private pending: AbortController | null = null;
  private history: CallHistoryLine[] = [];
  private lastResult = '';
  /** The points of the last answer, and which of them the voice has told, so "the rest" goes on from there. */
  private points: string[] = [];
  private toldPoints = new Set<number>();
  /** The voice just offered the rest of the answer: a "yes" takes it. */
  private offeredMore = false;
  private pendingQuestion: string | null = null;
  /** When the person's last turn ended, for the latency in the record. */
  private turnEndedAt = 0;
  /** The run was stopped to take a change from the person; its end is not a result to speak. */
  private steering = false;
  /** The person stopped the run: the voice said so already, and its end is not a result to tell. */
  private stopping = false;
  /** Short progress updates while the agent works, asked for with "keep me updated". */
  private updates = false;
  /** The person said "be quiet" while it works: not even the line now and then of a long run. */
  private silenced = false;
  private lastUpdateAt = 0;
  private updating = false;
  private activity = '';
  /** What the voice said lately, to tell the person from the voice heard back through the speakers. */
  private spoken: SpokenLine[] = [];
  private lastLine = '';
  /** The engine that wrote the latest stretch down, for the record. */
  private engine: string | undefined;
  /** The person's last turn went to the agent: an "I mean …" after it corrects that request. */
  private lastTurnWasWork = false;
  /** The latest change the person made while the agent worked: what "did you get that?" is about. */
  private lastSteer = '';
  /** The call moved to another file while the agent works in this one: that run ends in its own file, named. */
  private runFile: string | null = null;
  /** Two files fit what the person named; their next words pick one ("die Website", "die erste"). */
  private pendingSwitch: string[] | null = null;
  /** The call's notes in two sentences, and how many of the person's turns came since they were written. */
  private summary = '';
  private turnsSinceSummary = 0;
  private summarising = false;
  /**
   * What the person asked for that the voice asked back about ("redo the whole thing" -> "the whole file or one
   * screen?"): when the next turns make it a task, these words go with it, so the agent gets the whole request.
   */
  private asked: { text: string; at: number }[] = [];
  /** Two brands fit what the person named; the next words pick one, and the turn that named it goes on then. */
  private pendingBrand: { names: string[]; text: string; language: CallLanguage } | null = null;
  /** For each stretch of speech not yet written down, whether it began while the voice played (or just after). */
  private stretchDuringVoice: boolean[] = [];
  private voiceEndedAt = -Infinity;
  /** What the voice said since the agent started this run, so it is not told again. */
  private told: string[] = [];
  /** The voice's latest lines, for saying the same news twice. */
  private recentLines: string[] = [];
  /** The agent's last answer has been told to the person. */
  private resultSpoken = false;
  /** The running agent's latest steps, for "what is it doing?". */
  private steps: { what: string; names: string[]; at: number }[] = [];
  /** The agent's latest words while it works (not a tool). */
  private lastWords = '';
  /** The person asked for no answer to thanks and compliments. */
  private quiet = false;
  /** When the call last said "Mm?" to a half sentence. */
  private lastNudgeAt = -Infinity;
  /** The goal and conditions the talking layer wrote with its decision on a turn of work, for that turn's brief. */
  private turnBrief: { text: string; brief: Brief } | null = null;
  /** Lines spoken so far, to tell whether a step spoke. */
  private spokenCount = 0;
  /** The person's last turn asked something. */
  private lastTurnQuestion = false;

  constructor(private readonly opts: BrainOptions) {
    this.language = opts.language;
    this.draftLanguage = opts.language;
    this.timing = { ...CALL_TIMING, ...opts.timing };
  }

  get agentRunning(): boolean { return this.running; }
  get waitingForMore(): boolean { return this.deadline !== null || this.draftDeadline !== null || this.steerDeadline !== null; }
  /** The request being collected, for tests and the harness. */
  get drafting(): DraftText | null { return this.draft; }
  get updatesOn(): boolean { return this.updates; }
  /** How many stretches of the turn being said are in, not yet taken as said: the editor hears them again with the next. */
  get openParts(): number { return this.parts.length; }
  /** The run is being stopped to take a change from the person: its end is not a result. */
  get steeringRun(): boolean { return this.steering; }
  /** The call's notes so far, empty until the talking layer wrote them. */
  get notes(): string { return this.summary; }
  /** A request, a change or a read-back is being said: moving the call now would drop it. */
  get busy(): boolean { return this.waitingForMore || Boolean(this.draft) || this.confirming || this.sending || this.parts.length > 0 || this.inSpeech || this.transcribing > 0; }

  /** How many words a spoken line may have, from the person's wish for shorter or longer answers. */
  setMaxWords(words: number): void { this.timing.maxWords = Math.max(8, Math.min(40, Math.round(words))); }

  /** No answer to thanks, compliments and "okay", as the person asked (a stored wish, or said in this call). */
  setQuiet(on: boolean): void { this.quiet = on; }

  /** What the talking layer gets with every request. */
  context(): CallContext {
    return {
      ...(this.opts.sinks.screen?.() ?? {}),
      working: this.running,
      ...(this.running ? { workingMinutes: Math.floor((this.opts.now() - this.runStartedAt) / 60_000) } : {}),
      ...(this.runFile ? { runFile: this.runFile } : {}),
      ...(this.draft ? { drafting: [...this.draft.said, ...this.draft.corrections] } : {}),
      ...(this.confirming ? { readBack: true } : {}),
      ...(this.lastSteer || this.lastSaid ? { lastRequest: this.lastSteer || this.lastSaid } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
      ...(this.pendingQuestion ? { pendingQuestion: this.pendingQuestion } : {}),
      ...(this.running && this.activity ? { activity: this.activity } : {}),
      ...(this.running && this.told.length ? { toldThisRun: this.told.slice(-6) } : {}),
      ...(this.lastResult && this.resultSpoken ? { lastResultSpoken: true } : {}),
      ...(this.points.length && this.toldPoints.size ? { resultTold: this.points.filter((_, i) => this.toldPoints.has(i)) } : {}),
      ...(this.points.length ? { resultLeft: this.pointsLeft().map((i) => this.points[i]!) } : {}),
      ...(this.running && this.steps.length ? { steps: this.steps.map((x) => ({ what: x.what, ...(x.names.length ? { names: x.names } : {}), secondsAgo: Math.max(0, Math.round((this.opts.now() - x.at) / 1000)) })) } : {}),
      ...(this.summary ? { callSummary: this.summary } : {}),
      // With notes on the call so far, only its newest lines go along word for word.
      history: this.history.slice(this.summary ? -SUMMARY_LINES : -HISTORY_LINES),
    };
  }

  private remember(who: CallHistoryLine['who'], text: string): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (who === 'person') this.turnsSinceSummary++;
    this.history.push({ who, text: t.length > HISTORY_CHARS ? `${t.slice(0, HISTORY_CHARS - 1)}…` : t });
    if (this.history.length > HISTORY_LINES * 2) this.history.splice(0, this.history.length - HISTORY_LINES * 2);
  }

  // ---- the person

  speechStart(): void {
    const now = this.opts.now();
    // A stretch that begins while the voice plays may be the voice coming back; one that begins in quiet is the person.
    if (!this.inSpeech) this.stretchDuringVoice.push(this.voicePlaying || now - this.voiceEndedAt < 400);
    this.inSpeech = true;
    this.speechStartedAt = now;
    // More words are coming: whatever was said so far is not the whole turn yet.
    this.deadline = null;
    if (this.voicePlaying && !this.overlap) {
      this.overlap = true;
      this.opts.sinks.duck(true);
    }
  }

  speechEnd(): void {
    if (this.inSpeech) this.transcribing++;
    this.inSpeech = false;
  }

  /**
   * The words of one stretch of speech, once they are written down. `ms` is how long the stretch was; `speechMs`, when
   * a voice activity model ran, how much of it was speech. Noise, Whisper's made-up lines and the voice heard back are
   * not a turn: they are kept in the record as noise and otherwise ignored.
   */
  segment(text: string, ms: number, meta: { speechMs?: number; engine?: string; dropped?: NoiseReason; replaces?: number; duringVoice?: boolean } = {}): void {
    this.transcribing = Math.max(0, this.transcribing - 1);
    this.engine = meta.engine ?? this.engine;
    let words = text.trim();
    const now = this.opts.now();
    const began = this.stretchDuringVoice.shift();
    const duringVoice = meta.duringVoice ?? began;
    const reason = meta.dropped ?? (words ? noiseVerdict(words, { ms, ...(meta.speechMs !== undefined ? { speechMs: meta.speechMs } : {}) }) ?? (isEcho(words, this.spoken, now, duringVoice === undefined ? {} : { duringVoice }) ? 'echo' : null) : null);
    if (reason && reason !== 'empty') {
      this.opts.sinks.log?.({ at: Date.now(), who: 'person', text: words || '…', kind: 'noise', reason, ...(this.engine ? { engine: this.engine } : {}) });
    }
    if (reason) words = '';
    if (this.overlap) {
      this.overlap = false;
      if (!words || (isBackchannel(words) && ms < this.timing.bargeInMs + 500)) {
        this.opts.sinks.duck(false);
        return;
      }
      this.opts.sinks.stopVoice();
      this.voicePlaying = false;
      this.cutOff();
    }
    if (!words) {
      if (this.parts.length && this.deadline === null) this.deadline = this.opts.now() + this.timing.unfinishedWaitMs;
      return;
    }
    if (!this.parts.length) this.firstPartAt = now;
    // The stretch was heard again together with the turn's earlier pieces: its words stand for them too, and are
    // better for it, since the engine heard the whole sentence and not two halves of it.
    const replaces = Math.min(meta.replaces ?? 0, this.parts.length);
    if (replaces > 0) this.parts.splice(this.parts.length - replaces, replaces);
    this.parts.push(words);
    const so = this.parts.join(' ');
    const wait = endOfTurn(so, this.language) === 'complete' ? 0 : this.timing.unfinishedWaitMs;
    // However unfinished it sounds, a turn does not wait past its ceiling.
    this.deadline = Math.min(now + wait, this.firstPartAt + this.timing.turnCeilingMs);
    // Words keep a draft or a change open: the person is still describing.
    if (this.draftDeadline !== null) this.draftDeadline = Math.max(this.draftDeadline, now + this.timing.draftQuietMs);
    if (this.steerDeadline !== null) this.steerDeadline = Math.max(this.steerDeadline, now + this.timing.steerQuietMs);
    this.tick();
  }

  // ---- time

  tick(): void {
    const now = this.opts.now();
    if (this.overlap && this.inSpeech && now - this.speechStartedAt >= this.timing.bargeInMs) {
      // Not a "mhm": the person is really talking. The voice stops for good.
      this.overlap = false;
      this.voicePlaying = false;
      this.opts.sinks.stopVoice();
      this.cutOff();
    }
    if (this.deadline !== null && !this.inSpeech && this.transcribing === 0 && now >= this.deadline) this.commit();
    const quiet = !this.inSpeech && this.transcribing === 0 && this.deadline === null;
    if (this.draftDeadline !== null && quiet && now >= this.draftDeadline) { this.draftDeadline = null; void this.finishDraft(); }
    if (this.steerDeadline !== null && quiet && now >= this.steerDeadline) { this.steerDeadline = null; void this.flushSteer(); }
    // A read-back starts the request unless the person says no or changes it: a call does not wait for a yes forever.
    if (this.confirming && this.confirmDeadline !== null && quiet && !this.voicePlaying && now >= this.confirmDeadline && this.draft) {
      this.confirmDeadline = null;
      this.confirming = false;
      void this.sendDraft(this.draft, this.draftLanguage);
    }
    if (this.running && !this.updates && !this.nudged && !this.spokeThisRun && !this.voicePlaying && !this.inSpeech
      && now - this.runStartedAt >= this.timing.nudgeAfterMs) {
      this.nudged = true;
      this.opts.sinks.earcon();
    }
    if (this.running && this.updates && !this.updating && !this.voicePlaying && !this.inSpeech && this.deadline === null
      && now - Math.max(this.lastUpdateAt, this.runStartedAt) >= this.timing.updateEveryMs) {
      void this.progress();
    }
    if (this.running && !this.updates && !this.silenced && !this.updating && !this.voicePlaying && !this.inSpeech && this.deadline === null && !this.pending && !this.sending
      && now - Math.max(this.lastUpdateAt, this.runStartedAt, this.voiceEndedAt) >= this.timing.signOfLifeMs) {
      void this.progress();
    }
    // The notes are written while nobody speaks and nothing waits for the talking layer, so no answer waits for them.
    if (this.opts.persona && !this.summarising && this.turnsSinceSummary >= this.timing.summaryEveryTurns && this.history.length >= 8
      && quiet && !this.voicePlaying && !this.pending && !this.sending && !this.updating) {
      void this.writeNotes();
    }
  }

  /** Brings the call's notes up to date from the old notes and the lines since, in the talking layer's words. */
  private async writeNotes(): Promise<void> {
    this.summarising = true;
    const turns = this.turnsSinceSummary;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context: CallContext = { ...this.context(), history: this.history.slice(-HISTORY_LINES * 2) };
      const raw = await Promise.race([
        this.opts.persona!({ kind: 'summary', language: this.language, said: '', context }, abort.signal),
        new Promise<null>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(null); }, this.timing.summaryTimeoutMs); }),
      ]);
      const notes = raw ? cleanSummary(raw) : '';
      if (notes) {
        this.summary = notes;
        this.turnsSinceSummary = Math.max(0, this.turnsSinceSummary - turns);
        this.opts.sinks.summary?.(notes);
      } else this.turnsSinceSummary = Math.max(0, this.turnsSinceSummary - 2);
    } catch {
      this.turnsSinceSummary = Math.max(0, this.turnsSinceSummary - 2);
    } finally {
      if (timer) clearTimeout(timer);
      this.summarising = false;
    }
  }

  /** One short line about what the agent is doing now, from its latest words or tool. */
  private async progress(): Promise<void> {
    this.updating = true;
    this.lastUpdateAt = this.opts.now();
    try {
      const started = this.opts.now();
      // Its latest steps, oldest first, then its latest words: what the line is made from, never read out.
      const steps = [...this.steps.map((s) => s.what), this.lastWords].filter(Boolean).join('; ');
      const { line, source } = await this.talk({ kind: 'progress', language: this.language, said: this.activity, agent: steps || this.activity, context: this.context() });
      if (this.running && !this.inSpeech) this.say(line, 'progress', this.language, { source, ms: Math.round(this.opts.now() - started) });
    } finally {
      this.updating = false;
      this.lastUpdateAt = this.opts.now();
    }
  }

  // ---- the voice

  voiceStart(): void { this.voicePlaying = true; }
  voiceEnd(): void {
    if (this.voicePlaying) this.voiceEndedAt = this.opts.now();
    this.voicePlaying = false;
    if (this.overlap) { this.overlap = false; this.opts.sinks.duck(false); }
  }

  // ---- the agent

  agentStart(): void {
    this.running = true;
    this.runStartedAt = this.opts.now();
    this.nudged = false;
    this.spokeThisRun = false;
    this.activity = '';
    this.told = [];
    this.steps = [];
    this.lastWords = '';
  }

  /**
   * What the agent is doing while it works: its latest words, or `tool:<name>` for a tool it called. Kept for the
   * progress updates and for "what are you doing?"; never read out.
   */
  agentActivity(note: string): void {
    const n = note.replace(/\s+/g, ' ').trim();
    if (!n) return;
    this.activity = n.length > 600 ? `${n.slice(0, 599)}…` : n;
    const tool = /^tool:(\S+)/.exec(n)?.[1];
    if (tool) {
      const what = toolPhrase(tool);
      const last = this.steps.at(-1);
      // The same kind of step again is one step that goes on, not a new one.
      if (last && last.what === what) last.at = this.opts.now();
      else this.steps = [...this.steps, { what, names: [], at: this.opts.now() }].slice(-3);
    } else this.lastWords = lastSentence(n);
  }

  /** The layers or artboards the agent's latest step changed, by name, for "what is it working on?". */
  agentTouched(names: string[]): void {
    const last = this.steps.at(-1);
    if (!last) return;
    const clean = names.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    last.names = [...new Set([...last.names, ...clean])].slice(0, 4);
  }

  /** The voice was talked over: the line it was saying is marked, so it is not taken as heard. */
  private cutOff(): void {
    const last = [...this.history].reverse().find((h) => h.who === 'voice');
    if (last && !last.text.endsWith('(cut off)')) last.text = `${last.text} (cut off)`;
  }

  /**
   * The call works in another file now. What was being said for the old one is dropped (a request, changes, a
   * read-back); the call's history stays. A run going in the old file finishes there, and is named when it ends.
   */
  refocus(name: string, from: string | null): void {
    this.draft = null;
    this.draftDeadline = null;
    this.confirming = false;
    this.confirmDeadline = null;
    this.steerParts = [];
    this.steerCorrections = [];
    this.steerDeadline = null;
    this.pendingQuestion = null;
    this.pendingSwitch = null;
    this.lastResult = '';
    this.points = [];
    this.toldPoints.clear();
    this.offeredMore = false;
    // Back in the file the run works in, it is the call's run again: what is said changes it, as before the move.
    if (this.runFile && name === this.runFile) this.runFile = null;
    else if (this.running && from && !this.runFile) this.runFile = from;
    this.remember('voice', `(Now working in the file "${name}".)`);
  }

  /**
   * The run ended. `text` is everything the agent wrote in it; it goes to the talking layer, never to the voice. When
   * the agent ended with a `<say>` block for the call, those words are spoken (held to the call's length).
   */
  async agentFinish(text: string, ok: boolean): Promise<void> {
    // A run in a file the call has moved away from: its result is said with the file's name, and is not what "what
    // did you change?" means in the new file.
    const elsewhere = this.runFile;
    this.runFile = null;
    // Without a talking layer to name it, the rules say which file the result is about.
    if (elsewhere && !this.steering && !this.opts.persona) this.say(this.language === 'de' ? `Zu ${spokenName(elsewhere)}:` : `About ${spokenName(elsewhere)}:`, 'result', this.language, { source: 'rules', ms: 0 });
    this.running = false;
    this.steps = [];
    if (this.stopping) {
      // Stopped on the person's word: "okay, stopping" was said; what it did so far is in the chat.
      this.stopping = false;
      this.keepResult(text);
      this.resultSpoken = true;
      this.remember('agent', text);
      const next = this.queue.shift();
      if (next) this.startQueued(next.draft, next.language);
      return;
    }
    if (this.steering) {
      // Stopped to take the person's change: the run that takes it starts next, and its end is the one to speak.
      this.steering = false;
      return;
    }
    // The agent's own words for the voice, without what it only left alone ("so I left the design as it was").
    const pick = resultSay(text);
    const said = pick?.line ?? null;
    const kind = resultKind(said ?? text, ok);
    const asked = this.lastSaid;
    this.keepResult(text);
    this.resultSpoken = false;
    this.pendingQuestion = ok ? openQuestion(said ?? text) : null;
    const started = this.opts.now();
    let spoken: { line: string; source: 'persona' | 'rules' | 'agent' };
    const own = said ? shapeSpoken(said, this.language, RESULT_WORDS, 3) : '';
    // A block that led with what it did not do says little of the result: the talking layer says it from the whole answer.
    const useOwn = own && guessLanguage(own, this.language) === this.language && !(pick?.metaLed && this.opts.persona);
    if (useOwn) spoken = { line: own, source: 'agent' };
    // The first sentence is spoken as soon as it is written; `spoken.line` is then the rest, or nothing.
    else {
      // When the talking layer fails: the agent's own words for the voice, without what it left alone, rather than
      // "the details are in the chat". Its chat text is never read out.
      const fallbackLine = ok && kind === 'result' ? own : '';
      spoken = await this.talk({ kind, language: this.language, said: asked, agent: this.lastResult || said || text, context: this.context(), ...(elsewhere ? { ranIn: spokenName(elsewhere) } : {}) }, { ...(fallbackLine ? { fallbackLine } : {}), onFirst: (first) => this.say(first, 'result', this.language, { source: 'persona', ms: Math.round(this.opts.now() - started) }) });
    }
    this.remember('agent', said ?? this.lastResult);
    this.say(spoken.line, 'result', this.language, { source: spoken.source, ms: Math.round(this.opts.now() - started) });
    this.resultSpoken = true;
    // A review or an answer with more in it than was said: the voice offers the rest, once.
    const looked = ok && kind === 'result' && !asksForChange(asked);
    if (looked && this.pointsLeft().length >= 2 && !elsewhere) {
      this.say(this.language === 'de' ? 'Es hat noch mehr gesagt, willst du den Rest hören?' : 'It said more. Want the rest?', 'result', this.language, { source: 'rules', ms: Math.round(this.opts.now() - started) });
      this.offeredMore = true;
    }
    if (elsewhere) { this.lastResult = ''; this.points = []; this.toldPoints.clear(); }
    const next = this.queue.shift();
    if (next) this.startQueued(next.draft, next.language);
  }

  /** Keeps a run's answer whole (within `RESULT_MAX`) with its points, none of them told yet. */
  private keepResult(text: string): void {
    this.lastResult = resultText(text);
    this.points = resultPoints(text);
    this.toldPoints.clear();
    this.offeredMore = false;
  }

  /** The points of the last answer the voice has not told yet, in order. */
  private pointsLeft(): number[] {
    return this.points.flatMap((_, i) => (this.toldPoints.has(i) ? [] : [i]));
  }

  /** The person asks for the rest of the agent's last answer, or says yes to the voice's offer of it. */
  private wantsMore(text: string): boolean {
    if (!this.lastResult || !this.points.length || this.confirming || this.draft || this.pendingSwitch || this.pendingBrand) return false;
    const t = bare(text);
    if (this.offeredMore && YES.test(t) && wordCount(t) <= 4) return true;
    if (!ASKS_REST.test(t) || (asksForWork(text) && !isQuestion(text))) return false;
    // While a new run works, only an explicit "what else did it say" is about the last answer.
    return !this.running || /(said|say|found|suggested|gesagt|gefunden|vorgeschlagen)/.test(t);
  }

  /**
   * Tells the next points of the last answer, two or three at a time, from the whole answer the call kept: never the
   * agent asked again for what it already said, never a point said twice. When none are left, it says so.
   */
  private async tellMore(text: string, language: CallLanguage): Promise<void> {
    const de = language === 'de';
    this.offeredMore = false;
    this.aside.push(text);
    const left = this.pointsLeft();
    const ms = () => Math.round(this.opts.now() - this.turnEndedAt);
    if (!left.length) {
      this.say(de ? 'Das war alles, was es gesagt hat.' : 'That was everything it said.', 'reply', language, { route: 'answer', source: 'rules', ms: ms() });
      return;
    }
    // About 45 words of points, at least one.
    const next: number[] = [];
    let words = 0;
    for (const i of left) {
      const n = wordCount(this.points[i]!);
      if (next.length && (words + n > 45 || next.length === 3)) break;
      next.push(i);
      words += n;
    }
    const points = next.map((i) => this.points[i]!);
    const fallback = shapeSpoken(points.join(' '), language, RESULT_WORDS, 3);
    const r = await this.talk({ kind: 'more', language, said: text, agent: points.join('\n'), context: this.context() }, { fallbackLine: fallback });
    for (const i of next) this.toldPoints.add(i);
    this.say(r.line, 'reply', language, { route: 'answer', source: r.source, ms: ms() });
    if (this.pointsLeft().length) {
      this.say(de ? 'Da ist noch mehr, soll ich weitermachen?' : 'There is more. Shall I go on?', 'reply', language, { route: 'answer', source: 'rules', ms: ms() });
      this.offeredMore = true;
    }
  }

  /** Ends whatever is waiting, for hang-up. */
  dispose(): void {
    this.pending?.abort();
    this.parts = [];
    this.deadline = null;
    this.queue = [];
    this.draft = null;
    this.draftDeadline = null;
    this.steerParts = [];
    this.steerCorrections = [];
    this.steerDeadline = null;
    this.transcribing = 0;
  }

  // ---- inside

  private commit(): void {
    const text = this.parts.join(' ').replace(/\s+/g, ' ').trim();
    this.parts = [];
    this.deadline = null;
    if (!text) return;
    this.turnEndedAt = this.opts.now();
    this.lastTurnQuestion = isQuestion(text) || LINE_CHECK.test(bare(text));
    this.opts.sinks.heard?.(text);
    this.opts.sinks.log?.({ at: Date.now(), who: 'person', text, ...(this.engine ? { engine: this.engine } : {}) });
    // The reply follows the language the person speaks, when the call can speak it here; else the call's own.
    const heard = guessLanguage(text, this.language);
    const language = this.opts.sinks.languages && !this.opts.sinks.languages().includes(heard) ? this.language : heard;
    const command = callCommand(text);
    if (command) {
      if (command === 'stop' && this.running) this.stopping = true;
      this.opts.sinks.command(command, language);
      return;
    }
    const wish = callPreference(text, DESIGN_WORD);
    if (wish) {
      this.remember('person', text);
      this.keepWish(wish, language);
      return;
    }
    if (this.wantsMore(text)) {
      this.remember('person', text);
      void this.tellMore(text, language);
      return;
    }
    this.offeredMore = false;
    if (this.opts.turnModel && this.opts.persona && !isBackchannel(text) && endOfTurn(text, language) === 'unfinished' && wordCount(text) < 6
      && !this.pendingSwitch && !this.pendingBrand && !this.confirming) {
      // A half sentence left hanging ("Could you...", "What a..."): nothing to act on. At most one "Mm?" now and then,
      // when the line is otherwise quiet; else the call just listens.
      this.remember('person', text);
      this.aside.push(text);
      const now = this.opts.now();
      if (!this.running && !this.voicePlaying && now - this.lastNudgeAt >= this.timing.fragmentNudgeEveryMs) {
        this.lastNudgeAt = now;
        this.say('Mm?', 'reply', language, { route: 'answer', source: 'rules', ms: Math.round(now - this.turnEndedAt) });
      }
      return;
    }
    if (this.opts.turnModel && this.opts.persona && !isBackchannel(text)) {
      // A yes or no to the read-back of a request answers it; everything else the talking layer decides.
      if (this.confirming && !this.running) {
        const t = bare(text);
        if (YES.test(t) && !isCorrection(text)) { void this.answerReadBack(true, text, language); return; }
        if (NO.test(t) && t.split(' ').length <= 3) { void this.answerReadBack(false, text, language); return; }
      }
      void this.turn(text, language);
      return;
    }
    if (isBackchannel(text)) {
      // "Ja" to a question the call just asked answers it: the read-back of a request, or the agent's open question.
      if (this.confirming) { void this.answerReadBack(true, text, language); return; }
      // A plain "ja" answers the agent's open question; "yeah yeah yeah" is only listening.
      if (this.pendingQuestion && !this.running && YES.test(bare(text)) && bare(text).split(' ').length <= 2) { void this.dispatch(text, language); return; }
      return;
    }
    if (GREETING.test(bare(text))) {
      this.remember('person', text);
      const t = bare(text);
      // Thanks need no answer: a voice that says "you're welcome" to every "thank you" talks too much.
      if (/^(danke|vielen dank|thanks|thank you)/.test(t)) return;
      // "Can you hear me?", "who are you": the rules' line is right, and a small model tends to echo.
      if (/hörst du|kannst du mich|bist du da|hear me|are you there|wer bist du|who are you/.test(t)) {
        this.say(ruleLine('chat', language, text), 'reply', language, { route: 'answer', source: 'rules', ms: Math.round(this.opts.now() - this.turnEndedAt) });
        return;
      }
      void this.talk({ kind: 'chat', language, said: text, context: this.context() }).then(({ line, source }) => this.say(line, 'reply', language, { source, ms: Math.round(this.opts.now() - this.turnEndedAt) }));
      return;
    }
    if (this.confirming && !this.running) {
      const t = bare(text);
      if (YES.test(t) && !isCorrection(text)) { void this.answerReadBack(true, text, language); return; }
      if (NO.test(t) && t.split(' ').length <= 3) { void this.answerReadBack(false, text, language); return; }
    }
    void this.dispatch(text, language);
  }

  /** Starts a task the person asked for while the last run was going: no new decision, it was already made. */
  private startQueued(draft: DraftText, language: CallLanguage): void {
    const fallback = this.ackLine('', 'next', language, draft.said.join(' ')).text;
    void this.event(`Starting the task the person asked for earlier, for after the last one: "${gist(draft.said.join(' '), 16)}"`, fallback, 'ack', language, 'agent');
    void this.sendDraft({ ...draft, aside: [...draft.aside, ...this.aside] }, language);
  }

  /** Something the call did, worded by the talking layer from the whole call; the rules' line when it is slow. */
  private async event(what: string, fallback: string, kind: SpokenKind, language: CallLanguage, route?: RouteAction): Promise<void> {
    const started = this.opts.now();
    const r = await this.talk({ kind: 'event', language, said: what, context: this.context() }, { fallbackLine: fallback });
    this.say(r.line, kind, language, { ...(route ? { route } : {}), source: r.source, ms: Math.round(this.opts.now() - started) });
  }

  /** Decides what a turn is, then answers it here, asks back, collects it for the agent, or lets it pass. */
  private async dispatch(text: string, language: CallLanguage): Promise<void> {
    // After "which of the two brands?", the next words pick one, and the turn that named it goes on.
    if (this.pendingBrand) {
      const asked = this.pendingBrand;
      this.pendingBrand = null;
      const picked = pickName(text, asked.names);
      if (picked) {
        this.remember('person', text);
        await this.withBrand(asked.text, picked, asked.language);
        return;
      }
    }
    const brand = this.opts.sinks.findBrand ? brandTarget(text) : null;
    if (brand) {
      await this.withBrand(text, brand, language);
      return;
    }
    await this.route(text, language);
  }

  /**
   * A turn that names a brand: the brand is found by its name (never made or guessed), and the turn goes on as a
   * request with the brand's id for the agent. Two close names are asked back; an unknown one is said so.
   */
  private async withBrand(text: string, name: string, language: CallLanguage): Promise<void> {
    const de = language === 'de';
    const ms = () => Math.round(this.opts.now() - this.turnEndedAt);
    let found: Awaited<ReturnType<NonNullable<BrainSinks['findBrand']>>>;
    try { found = await this.opts.sinks.findBrand!(name); } catch { found = { kind: 'none' }; }
    if (found.kind === 'ambiguous') {
      this.remember('person', text);
      this.pendingBrand = { names: found.names, text, language };
      const [a, b] = found.names;
      this.say(de ? `Meinst du die Marke „${a}“ oder „${b}“?` : `Do you mean the brand "${a}" or "${b}"?`, 'reply', language, { route: 'clarify', source: 'rules', ms: ms() });
      return;
    }
    if (found.kind === 'none') {
      this.remember('person', text);
      this.say(de ? `Eine Marke „${name}“ finde ich nicht.` : `I cannot find a brand called "${name}".`, 'reply', language, { route: 'answer', source: 'rules', ms: ms() });
      return;
    }
    this.aside.push(brandNote(found.name, found.id));
    const ack = de ? `Okay, mit der Marke „${found.name}“.` : `Okay, with the brand "${found.name}".`;
    await this.route(text, language, { action: 'agent', say: ack });
  }

  /** Keeps a wish about how the voice talks, applies it now, and says so in a few words. */
  private keepWish(wish: CallPreference, language: CallLanguage): void {
    const ms = Math.round(this.opts.now() - this.turnEndedAt);
    if (wish.kind === 'language') {
      const to = wish.value as CallLanguage;
      if (this.opts.sinks.languages && !this.opts.sinks.languages().includes(to)) {
        this.say(to === 'de' ? 'German is coming soon. Until then I speak English.' : 'English is coming soon.', 'voice', this.language, { route: 'voice', source: 'rules', ms });
        return;
      }
      const can = this.opts.sinks.setLanguage ? this.opts.sinks.setLanguage(to) : true;
      if (!can) {
        this.say(language === 'de' ? (to === 'en' ? 'Die englische Stimme ist hier noch nicht geladen.' : 'Die deutsche Stimme ist hier noch nicht geladen.') : (to === 'de' ? 'The German voice is not here yet.' : 'The English voice is not here yet.'), 'voice', language, { route: 'voice', source: 'rules', ms });
        return;
      }
      this.language = to;
      // "Sprich Englisch" is for now; with "ab jetzt" or "immer" it is for every call.
      if (durableWish(wish.text)) this.opts.sinks.remember?.(wish);
      this.say(to === 'de' ? 'Gut, ab jetzt auf Deutsch.' : 'Sure, English from here on.', 'voice', to, { route: 'voice', source: 'rules', ms });
      return;
    }
    if (wish.kind === 'length') this.setMaxWords(wordsFor([wish], CALL_TIMING.maxWords));
    if (wish.kind === 'quiet') this.quiet = true;
    this.opts.sinks.remember?.(wish);
    const de = language === 'de';
    const line = wish.kind === 'name' ? (de ? `Okay, ${wish.value}, merke ich mir.` : `Okay, ${wish.value}, noted.`)
      : wish.kind === 'length' && wish.value === 'short' ? (de ? 'Okay, kürzer.' : 'Okay, shorter.')
        : wish.kind === 'quiet' ? (de ? 'Gut, dann sage ich dazu nichts mehr.' : 'Got it, I will skip those.')
          : de ? 'Okay, merke ich mir.' : 'Okay, I will keep to that.';
    this.say(line, 'voice', language, { route: 'voice', source: 'rules', ms });
  }

  /**
   * Decides what a turn is (or takes the decision given), then answers it here, asks back, collects it for the agent, or
   * lets it pass. `quietAck`: the talking layer speaks the acknowledgement itself, as it writes it. `quick`: a clear
   * request in one sentence, whose brief is already written, goes after a short quiet.
   */
  private async route(text: string, language: CallLanguage, given?: Route, opts: { quietAck?: boolean; quick?: boolean } = {}): Promise<void> {
    const context = this.context();
    // After "which of the two?", the next words pick one: "die Website", "die erste", "the second one".
    const picked = this.pendingSwitch ? pickName(text, this.pendingSwitch) : null;
    const rules: Route = given ?? (picked ? { action: 'switch', say: '', target: picked } : routeByRules(text, context, language));
    this.pendingSwitch = null;
    this.remember('person', text);
    let route = rules;
    let source: 'persona' | 'rules' = 'rules';
    // The rules are sure about questions on screen, about the call's own settings and about vague requests; the
    // talking layer decides the rest and words the acknowledgement for what was asked.
    if (!given && this.opts.persona && this.opts.personaRoutes && (rules.action === 'agent' || rules.action === 'steer' || rules.action === 'queue' || rules.soft || (rules.action === 'clarify' && context.pendingQuestion))) {
      const decided = await this.decide(text, language, context, this.running && rules.action === 'steer' ? this.timing.steerDecideMs : this.timing.routeTimeoutMs);
      // The gate is trusted over the talking layer: a request for work it would only answer, or let pass, still goes on.
      const overruled = decided && (decided.action === 'answer' || decided.action === 'none') && !decided.recap
        && (rules.action === 'agent' || rules.action === 'steer' || rules.action === 'queue') && asksForWork(text) && !isQuestion(text);
      if (decided && !overruled) { route = decided; source = 'persona'; }
      else if (overruled) route = { ...rules, say: '' };
    }
    // Only work reaches the agent or its queue: a change, a look at the design, a correction, a yes to its question,
    // and while it is idle a question about the design. Remarks and chat while it works never stop a run.
    const yes = Boolean(context.pendingQuestion && YES.test(bare(text)));
    // "I mean …" corrects a request only when the turn before was one, or it names something of the design.
    const correction = isCorrection(text) && (this.lastTurnWasWork || DESIGN_WORD.test(bare(text)));
    const work = Boolean(given && (given.action === 'agent' || given.action === 'steer' || given.action === 'queue')) || correction || yes || asksForWork(text) || (!this.running && isQuestion(text) && DESIGN_WORD.test(bare(text)));
    if (!work && (route.action === 'agent' || route.action === 'steer' || route.action === 'queue')) {
      route = rules.action === 'agent' || rules.action === 'steer' || rules.action === 'queue' ? { action: 'none', say: '' } : rules;
    }
    // What the run cannot take: steering and queueing only mean something while the agent works, and a request made
    // while it works changes the task it is on unless it is clearly for after.
    if (!this.running && (route.action === 'steer' || route.action === 'queue')) route = { ...route, action: 'agent' };
    if (this.running && route.action === 'agent') route = { ...route, action: rules.action === 'queue' ? 'queue' : 'steer' };
    if (route.action === 'steer' && !this.opts.sinks.steer) route = { ...route, action: 'queue' };
    // The agent works in the file the call came from: a request for this one waits until that run is done.
    if (this.runFile && (route.action === 'steer' || route.action === 'agent')) route = { ...route, action: 'queue', say: language === 'de' ? `Erst läuft noch „${this.runFile}“, das kommt danach.` : `First "${this.runFile}" finishes, this comes after.` };
    const ms = Math.round(this.opts.now() - this.turnEndedAt);
    this.lastTurnWasWork = route.action === 'agent' || route.action === 'steer' || route.action === 'queue';
    if (route.action === 'none') {
      this.aside.push(text);
      return;
    }
    if (route.action === 'switch') {
      this.aside.push(text);
      void this.switchFile(route.target ?? '', language);
      return;
    }
    if (route.action === 'voice') {
      const on = route.updates ?? rules.updates ?? true;
      this.updates = on;
      this.silenced = !on;
      this.lastUpdateAt = this.opts.now();
      this.aside.push(text);
      this.say(shapeSpoken(route.say, language) || ruleLine(on ? 'updates-on' : 'updates-off', language), 'voice', language, { route: 'voice', source, ms });
      return;
    }
    if (route.action === 'answer' && route.recap && this.lastResult) {
      this.aside.push(text);
      await this.speakTalk({ kind: resultKind(this.lastResult, true), language, said: text, agent: this.lastResult, context: this.context() }, 'reply', { route: 'answer' });
      return;
    }
    if (route.action === 'answer' && route === rules && rules.word && this.opts.persona && !this.opts.personaRoutes) {
      // The rules decided this is a question for the voice; the talking layer, which has the whole call, words it.
      this.aside.push(text);
      // When the talking layer cannot answer, the rules' own line for this question is said, not a generic one.
      const fallback = shapeSpoken(rules.say, language) || ruleLine('chat', language, text);
      void this.speakTalk({ kind: 'chat', language, said: text, context }, 'reply', { route: 'answer' }, fallback);
      return;
    }
    if (route.action === 'answer' || route.action === 'clarify') {
      this.aside.push(text);
      this.pendingQuestion = route.action === 'clarify' ? null : this.pendingQuestion;
      const line = shapeSpoken(route.say, language) || ruleLine(route.action === 'clarify' ? 'clarify' : 'chat', language, text);
      // The same answer twice in a row sounds canned: the second time it is said another way.
      this.say(line === this.lastLine ? otherWay(line, language, this.turns++) : line, 'reply', language, { route: route.action, source, ms });
      return;
    }
    // The talking layer says the acknowledgement as it writes it, unless the call changed what happens (and says so).
    const quiet = Boolean(opts.quietAck && !route.say);
    if (route.action === 'steer') {
      this.lastSteer = text;
      this.pendingQuestion = null;
      if (isCorrection(text)) this.steerCorrections.push(text); else this.steerParts.push(text);
      const one = this.steerParts.length + this.steerCorrections.length === 1;
      this.steerDeadline = opts.quick && one ? Math.max(this.opts.now(), this.turnEndedAt + this.timing.steerQuickMs) : this.opts.now() + this.timing.steerQuietMs;
      if (quiet) return;
      const line = this.ackLine(route.say, 'steer', language, text);
      this.say(line.text, 'steer', language, { route: 'steer', source: line.persona ? source : 'rules', ms });
      return;
    }
    if (route.action === 'queue') {
      // Each task for after stays its own, and they start in the order said.
      this.queue.push({ draft: { said: [text], corrections: [], aside: [] }, language });
      if (quiet) return;
      const line = this.ackLine(route.say, 'queued', language, text);
      this.say(line.text, 'queued', language, { route: 'queue', source: line.persona ? source : 'rules', ms });
      return;
    }
    // A request: it is collected until the person has said it, then made into a brief for the agent.
    this.pendingQuestion = yes ? this.pendingQuestion : null;
    const first = !this.draft;
    if (!this.draft) {
      // A correction of what was just sent goes with that request again.
      this.draft = isCorrection(text) && this.lastSaid ? { said: [this.lastSaid], corrections: [text], aside: [] } : { said: [text], corrections: [], aside: [] };
      this.draftLanguage = language;
    } else if (isCorrection(text)) this.draft.corrections.push(text);
    else this.draft.said.push(text);
    if (yes && context.pendingQuestion) this.draft.aside.push(`${language === 'de' ? 'Antwort auf deine Frage' : 'Answer to your question'} "${context.pendingQuestion}": ${text}`);
    this.lastSaid = this.draft.said.join(' ');
    this.lastSteer = '';
    if (this.confirming) {
      // Changed after the read-back: read it back again once the person is done.
      this.confirming = false;
      this.confirmDeadline = null;
    }
    if (!quiet) {
      const ack = this.ackLine(route.say, first ? 'ack' : 'steer', language, text);
      this.say(ack.text, 'ack', language, { route: 'agent', source: ack.persona ? source : 'rules', ms });
    }
    // A clear request goes once the person has been quiet a little since the end of their turn; the talking layer's
    // decision took most of that already.
    this.draftDeadline = GO.test(bare(text)) || yes ? this.opts.now()
      : opts.quick && first ? Math.max(this.opts.now(), this.turnEndedAt + this.timing.draftQuickMs)
        : this.opts.now() + this.timing.draftQuietMs;
  }

  /**
   * Whether a turn needs no answer at all, decided without the talking layer: thanks and compliments when the person
   * asked for quiet, and while the agent works, once the voice has said its part, a short remark that asks nothing
   * ("alright", "got it", "you're amazing"). Questions, checks of the line, doubts and work always go on.
   */
  private quietTurn(text: string): boolean {
    if (this.pendingSwitch || this.pendingBrand || this.draft || this.confirming || this.pendingQuestion) return false;
    if (this.asked.some((a) => this.opts.now() - a.at < 120_000)) return false;
    const t = bare(text);
    if (isQuestion(text) || LINE_CHECK.test(t) || DOUBT.test(t) || asksForWork(text) || switchTarget(text) || brandTarget(text)) return false;
    if (YES.test(t) || GO.test(t)) return false;
    if (this.quiet && THANKS.test(t)) return true;
    return this.running && wordCount(text) < 5;
  }

  /**
   * One turn decided and worded by the talking layer (`turnModel`). It writes its action line first: the call acts on
   * it at once (work goes to the agent through the same paths as before, a stop stops, a move to another file starts),
   * and speaks the words below it piece by piece as they are written.
   */
  private async turn(text: string, language: CallLanguage): Promise<void> {
    // After "which of the two?", the next words pick one.
    if (this.pendingSwitch) {
      const picked = pickName(text, this.pendingSwitch);
      this.pendingSwitch = null;
      if (picked) { this.remember('person', text); this.aside.push(text); void this.switchFile(picked, language); return; }
    }
    if (this.pendingBrand) {
      const asked = this.pendingBrand;
      this.pendingBrand = null;
      const picked = pickName(text, asked.names);
      if (picked) { this.remember('person', text); await this.withBrand(asked.text, picked, asked.language); return; }
    }
    if (this.quietTurn(text)) {
      this.remember('person', text);
      this.aside.push(text);
      this.opts.sinks.log?.({ at: Date.now(), who: 'voice', text: '', kind: 'listen', route: 'none', source: 'rules', ms: 0 });
      return;
    }
    const context = this.context();
    const ms = () => Math.round(this.opts.now() - this.turnEndedAt);
    const question = isQuestion(text) || LINE_CHECK.test(bare(text));
    // A clear request for design work: one short sound at once, the talking layer's own words follow.
    let instant = false;
    if (this.opts.instantAck && !this.running && !this.draft && !question && wordCount(text) >= 5 && asksForWork(text) && !VAGUE_ASK.test(bare(text)) && !RISKY.test(bare(text))
      && !switchTarget(text) && !brandTarget(text)) {
      instant = true;
      this.say(INSTANT_ACK[language], 'ack', language, { route: 'agent', source: 'instant', ms: ms() });
    }
    this.pending?.abort();
    const abort = new AbortController();
    this.pending = abort;
    let head: TurnDecision | null = null;
    let acted: Promise<unknown> = Promise.resolve();
    /** The talking layer's words already spoken, as written. */
    let spoke = '';
    /** The call said something of its own for this turn (it changed what happens): the talking layer's words are not said. */
    let overruled = false;
    let doneWords!: (w: string) => void;
    const words = new Promise<string>((r) => { doneWords = r; });
    const speaks = (a: TurnAction) => a === 'answer' || a === 'clarify' || a === 'agent' || a === 'steer' || a === 'queue' || a === 'stop' || a === 'updates-on' || a === 'updates-off';
    const kindOf = (a: TurnAction): SpokenKind => (a === 'agent' ? 'ack' : a === 'steer' ? 'steer' : a === 'queue' ? 'queued' : a === 'updates-on' || a === 'updates-off' ? 'voice' : a === 'stop' ? 'command' : 'reply');
    const routeOf = (a: TurnAction): RouteAction => (a === 'agent' || a === 'steer' || a === 'queue' || a === 'answer' || a === 'clarify' ? a : a === 'updates-on' || a === 'updates-off' ? 'voice' : 'none');
    // One question at a time: what follows a first question is left out ("…the whole file or one screen? And how?").
    const oneQuestion = (say: string) => { const q = say.indexOf('?'); return q >= 0 && say.indexOf('?', q + 1) > q ? say.slice(0, q + 1) : say; };
    const tidy = (say: string) => oneQuestion(instant ? say.replace(LEAD_ACK, '').replace(/^./, (c) => c.toUpperCase()) : say);
    const speakFirst = (d: TurnDecision, done: boolean) => {
      if (spoke || overruled || !speaks(d.action)) return;
      const say = tidy(d.say);
      const chunk = done ? say : firstChunk(say);
      if (!chunk) return;
      const line = shapeSpoken(chunk, language, this.timing.maxWords);
      if (!line) return;
      spoke = chunk;
      this.say(line, kindOf(d.action), language, { route: routeOf(d.action), source: 'persona', ms: ms(), answers: question });
    };
    const act = (d: TurnDecision) => {
      head = d;
      acted = this.actOnTurn(d, text, language, words).then((said) => { if (said) overruled = true; });
    };
    const onText = (soFar: string) => {
      if (abort.signal.aborted) return;
      const d = parseTurn(soFar, true);
      if (!d) return;
      if (!head) act(d);
      // Acting on the line may have said the call's own words; they go first.
      void acted.then(() => speakFirst(d, false));
    };
    let raw: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([
        this.opts.persona!({ kind: 'turn', language, said: text, context }, abort.signal, undefined, onText),
        new Promise<null>((resolve) => { timer = setTimeout(() => { if (!head) { abort.abort(); resolve(null); } }, this.timing.turnTimeoutMs); }),
      ]);
    } catch {
      raw = null;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pending === abort) this.pending = null;
    }
    const decided = (raw ? parseTurn(raw) : null) ?? head;
    if (!decided) {
      doneWords('');
      await this.fallbackTurn(text, language, context, instant);
      return;
    }
    // A talking layer that does not stream: act on its whole answer now.
    if (!head) act(decided);
    const action = (head as TurnDecision | null)?.action ?? decided.action;
    const say = tidy(decided.action === action ? decided.say : '');
    doneWords(say);
    await acted;
    if (overruled || !speaks(action)) return;
    if (!spoke) {
      if (say) speakFirst({ ...decided, action, say: decided.say }, true);
      // Work handed on without any words of its own: a short acknowledgement still says it was heard.
      else if ((action === 'agent' || action === 'steer' || action === 'queue') && !instant) {
        const line = this.ackLine('', action === 'agent' ? 'ack' : action === 'steer' ? 'steer' : 'queued', language, text);
        this.say(line.text, kindOf(action), language, { route: routeOf(action), source: 'rules', ms: ms() });
      } else if (action === 'stop') this.say(language === 'de' ? 'Okay, ich höre auf.' : 'Okay, stopping.', 'command', language, { source: 'rules', ms: ms() });
      return;
    }
    const rest = restAfter(say, spoke);
    const room = this.timing.maxWords - wordCount(spoke);
    if (rest && room > 2) {
      const line = shapeSpoken(rest, language, room);
      if (line) this.say(line, kindOf(action), language, { route: routeOf(action), source: 'persona', ms: ms(), answers: question });
    }
  }

  /**
   * Does what the talking layer decided for a turn, the moment its action line is written. Returns whether the call
   * said words of its own for it (then the talking layer's are left out). `words`: the talking layer's words once
   * written, for a move to another file, which are said only when the move worked.
   */
  private async actOnTurn(d: TurnDecision, text: string, language: CallLanguage, words: Promise<string>): Promise<boolean> {
    const before = this.spokenCount;
    switch (d.action) {
      case 'answer':
      case 'clarify':
        this.remember('person', text);
        this.aside.push(text);
        if (d.action === 'clarify') {
          this.asked = [...this.asked.filter((a) => this.opts.now() - a.at < 120_000), { text, at: this.opts.now() }].slice(-4);
          this.pendingQuestion = null;
        }
        return false;
      case 'agent':
      case 'steer':
      case 'queue': {
        // The request the voice asked back about goes with its answer: "redo the whole thing" + "the whole file, go".
        const asked = this.asked.filter((a) => this.opts.now() - a.at < 120_000).map((a) => a.text);
        this.asked = [];
        if (d.action === 'agent' && asked.length && !this.draft && !this.running) {
          this.draft = { said: asked, corrections: [], aside: [] };
          this.draftLanguage = language;
        }
        if (d.brief) this.turnBrief = { text, brief: d.brief };
        const quick = Boolean(d.brief) && endOfTurn(text, language) === 'complete' && takeSentences(text, language, true, 600).sentences.length <= 1;
        await this.route(text, language, { action: d.action, say: '' }, { quietAck: true, quick });
        // The call changed what happens (a run elsewhere goes first) and said so.
        return this.spokenCount > before;
      }
      case 'brand':
        if (d.arg) { await this.withBrand(text, d.arg, language); return true; }
        await this.route(text, language, { action: 'agent', say: '' }, { quietAck: true });
        return false;
      case 'switch':
        this.remember('person', text);
        this.aside.push(text);
        await this.switchFile(d.arg || text, language, words);
        return true;
      case 'stop':
        this.remember('person', text);
        if (this.running) this.stopping = true;
        this.opts.sinks.command('stop', language, { quiet: true });
        return false;
      case 'undo':
        this.remember('person', text);
        this.opts.sinks.command('undo', language);
        return true;
      case 'updates-on':
      case 'updates-off':
        this.remember('person', text);
        this.aside.push(text);
        this.updates = d.action === 'updates-on';
        this.silenced = !this.updates;
        this.lastUpdateAt = this.opts.now();
        return false;
      case 'listen':
        this.remember('person', text);
        this.aside.push(text);
        return false;
    }
    return false;
  }

  /**
   * The talking layer did not answer in time. The rules act only where they are sure: questions about the screen, a
   * file to move to, a clear request. Chat and fragments are never handed to the agent, and a turn they cannot place
   * gets one short line at most.
   */
  private async fallbackTurn(text: string, language: CallLanguage, context: CallContext, acked = false): Promise<void> {
    const rules = routeByRules(text, context, language);
    const clearWork = asksForWork(text) && wordCount(text) >= 4 && !isQuestion(text);
    if ((rules.action === 'agent' || rules.action === 'steer' || rules.action === 'queue') && clearWork) {
      await this.route(text, language, rules, { quietAck: acked });
      return;
    }
    if (rules.action === 'switch') { await this.route(text, language, rules); return; }
    this.remember('person', text);
    this.aside.push(text);
    const asked = isQuestion(text) || GREETING.test(bare(text));
    if (rules.action === 'answer' && rules.say && !rules.soft) { this.say(shapeSpoken(rules.say, language), 'reply', language, { route: 'answer', source: 'rules', ms: Math.round(this.opts.now() - this.turnEndedAt) }); return; }
    if (asked) this.say(language === 'de' ? 'Entschuldige, ich hänge kurz. Sagst du das noch mal?' : 'Sorry, I lagged for a second. Can you say that again?', 'reply', language, { route: 'answer', source: 'rules', ms: Math.round(this.opts.now() - this.turnEndedAt) });
  }

  /** The person has said the request: read it back if it needs that, else send it. */
  private async finishDraft(): Promise<void> {
    const draft = this.draft;
    if (!draft || this.sending) return;
    if (this.confirming) return;
    if (this.running) {
      // The agent started meanwhile (a queued task): this one waits for it.
      this.queue.push({ draft, language: this.draftLanguage });
      this.draft = null;
      return;
    }
    // With the talking layer deciding every turn, its acknowledgement already says what will happen, and it asks first
    // when a request is unclear or throws away a lot; a second read-back only repeated it.
    if (needsReadBack(draft) && !this.opts.turnModel) {
      this.confirming = true;
      const brief = await this.makeBrief({ ...draft, aside: [...draft.aside, ...this.aside] }, this.draftLanguage);
      if (this.draft !== draft || !this.confirming) return;
      const de = this.draftLanguage === 'de';
      const what = brief ? shapeSpoken(brief.goal, this.draftLanguage, 22).replace(/[.!?]+$/, '') : gist(draft.said.join('. '), 14);
      const line = what ? (de ? `Also: ${what}. Ich lege los, außer du sagst nein.` : `So: ${what}. Starting unless you say no.`) : (de ? 'Ich lege los, außer du sagst nein.' : 'Starting unless you say no.');
      this.say(line, 'confirm', this.draftLanguage, { route: 'agent', source: brief ? 'persona' : 'rules' });
      this.confirmDeadline = this.opts.now() + this.timing.confirmWaitMs;
      return;
    }
    await this.sendDraft(draft, this.draftLanguage);
  }

  /** The person's yes or no to the read-back. */
  private async answerReadBack(yes: boolean, text: string, language: CallLanguage): Promise<void> {
    this.remember('person', text);
    const draft = this.draft;
    this.confirming = false;
    this.confirmDeadline = null;
    if (!draft) return;
    if (yes) {
      this.say(ruleLine('ack', language, '', this.turns++), 'ack', language, { route: 'agent', source: 'rules' });
      await this.sendDraft(draft, this.draftLanguage);
      return;
    }
    this.say(language === 'de' ? 'Okay. Was soll anders sein?' : 'Okay. What should be different?', 'reply', language, { route: 'clarify', source: 'rules' });
  }

  /** Makes the brief and sends it to the agent. */
  private async sendDraft(draft: DraftText, language: CallLanguage): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const full: DraftText = { ...draft, aside: [...draft.aside, ...this.aside].slice(-8) };
      const brief = this.briefFromTurn(full) ?? await this.makeBrief(full, language);
      if (this.draft === draft) this.draft = null;
      this.aside = [];
      this.lastSaid = brief?.goal ?? draft.said.join(' ');
      this.pendingQuestion = null;
      this.opts.sinks.send(briefMessage(full, brief, language), language, this.meta(full, brief));
    } finally {
      this.sending = false;
    }
  }

  /** The changes said while the agent works, as one brief: the run is interrupted for it and goes on in the same session. */
  private async flushSteer(): Promise<void> {
    const said = this.steerParts.splice(0);
    const corrections = this.steerCorrections.splice(0);
    if (!said.length && !corrections.length) return;
    const draft: DraftText = { said: said.length ? said : corrections, corrections: said.length ? corrections : [], aside: this.aside.splice(0).slice(-6), steer: true };
    const brief = this.briefFromTurn(draft) ?? await this.makeBrief(draft, this.language);
    if (!this.running) {
      // The run ended meanwhile: this is a request of its own now.
      await this.sendDraft({ ...draft, steer: false }, this.language);
      return;
    }
    this.steering = true;
    this.opts.sinks.steer!(briefMessage(draft, brief, this.language), this.language, this.meta(draft, brief));
  }

  /**
   * The brief the talking layer wrote with its decision on the draft's last turn: it saw the whole call, so it covers
   * what was asked back about too. Not after a correction, which it may not have seen.
   */
  private briefFromTurn(draft: DraftText): Brief | null {
    const t = this.turnBrief;
    this.turnBrief = null;
    if (!t || draft.corrections.length || draft.said.at(-1) !== t.text) return null;
    return t.brief;
  }

  private meta(draft: DraftText, brief: Brief | null): SendMeta {
    const words = draft.said.join(' ').replace(/\s+/g, ' ').trim();
    const title = (brief?.goal ?? (gist(words, 14) || words)).slice(0, 190);
    return { title, display: brief?.goal ?? words, ...(brief?.size ? { size: brief.size } : {}) };
  }

  /**
   * The talking layer's reading of a draft as a goal and conditions. When it has none in time, the rules make one from
   * the person's words, so a brief always has a goal.
   */
  private async makeBrief(draft: DraftText, language: CallLanguage): Promise<Brief> {
    return (await this.personaBrief(draft, language)) ?? rulesBrief(draft);
  }

  private async personaBrief(draft: DraftText, language: CallLanguage): Promise<Brief | null> {
    if (!this.opts.persona) return null;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.opts.persona({ kind: 'brief', language, said: draft.said.join(' '), draft, context: this.context() }, abort.signal),
        new Promise<null>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(null); }, this.timing.briefTimeoutMs); }),
      ]);
      return raw ? parseBrief(raw) : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The acknowledgement to speak: the talking layer's own words when they are short and not the line just said,
   * otherwise a rules line that names what was understood. Never the same line twice in a row.
   */
  private ackLine(proposed: string, kind: 'ack' | 'next' | 'steer' | 'queued', language: CallLanguage, said: string): { text: string; persona: boolean } {
    // An acknowledgement is a few words: a long one is held to its first sentence, which says the gist.
    const own = wordCount(proposed) <= 16 ? shapeSpoken(proposed, language, 16) : shapeSpoken(firstSentence(proposed) ?? '', language, 16);
    if (own && own !== this.lastLine) return { text: own, persona: true };
    for (let i = 0; i < 4; i++) {
      const line = shapeSpoken(ruleLine(kind, language, said, this.turns++), language);
      if (line !== this.lastLine) return { text: line, persona: false };
    }
    return { text: shapeSpoken(ruleLine(kind, language, said, this.turns++), language), persona: false };
  }

  /** The talking layer's routing decision, or null when it is slow or unclear. */
  private async decide(text: string, language: CallLanguage, context: CallContext, budgetMs = this.timing.routeTimeoutMs): Promise<Route | null> {
    if (!this.opts.persona) return null;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.opts.persona({ kind: 'route', language, said: text, context }, abort.signal),
        new Promise<null>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(null); }, budgetMs); }),
      ]);
      const route = raw ? parseRoute(raw) : null;
      if (!route) return null;
      // An answer must come from what the call knows; when it cannot, the agent answers instead.
      if (route.action === 'answer' && !route.say.trim()) return { action: 'agent', say: '' };
      if (route.action === 'clarify' && !route.say.trim()) return { action: 'clarify', say: ruleLine('clarify', language) };
      return route;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Speaks a line, held to the news budget: what the voice said in its last few lines is not said again. A line that
   * mostly repeats one of them is cut to its first part, or left out while the agent works and nobody asked.
   * `answers`: the line answers the person's question, so it is said even when it repeats (shorter if it can be).
   */
  private say(text: string, kind: SpokenKind, language = this.language, meta: { route?: RouteAction; source?: LineSource; ms?: number; answers?: boolean } = {}): void {
    if (!text) return;
    if (kind !== 'result' && kind !== 'confirm') {
      const answers = meta.answers ?? (meta.route === 'answer' && this.lastTurnQuestion);
      const same = (line: string) => this.recentLines.some((l) => similarity(line, l) >= SAME_NEWS);
      if (same(text)) {
        const part = text.split(/(?<=[,.;!?])\s+/)[0]!.trim();
        const shorter = part !== text && wordCount(part) >= 2 && !same(part) ? part.replace(/[,;]$/, '.') : '';
        if (shorter) text = shorter;
        else if (!answers && (kind === 'reply' || kind === 'progress') && (this.running || meta.source === 'persona')) {
          this.opts.sinks.log?.({ at: Date.now(), who: 'voice', text, kind: 'held', ...(meta.source ? { source: meta.source } : {}) });
          return;
        }
      }
    }
    const { answers: _answers, ...logged } = meta;
    meta = logged;
    if (this.running) { this.spokeThisRun = true; this.told = [...this.told, text].slice(-6); }
    // What the voice says of the last answer counts as told, however it came to say it.
    if (this.points.length && (kind === 'result' || kind === 'reply')) this.points.forEach((p, i) => { if (tells(text, p)) this.toldPoints.add(i); });
    this.recentLines = [...this.recentLines, text].slice(-3);
    this.spokenCount++;
    this.lastLine = text;
    const now = this.opts.now();
    this.spoken = [...this.spoken.filter((l) => now - l.at < 30_000), { text, at: now }];
    this.lastSpokenWasQuestion = /\?\s*$/.test(text);
    this.remember('voice', text);
    this.opts.sinks.log?.({ at: Date.now(), who: 'voice', text, kind, ...meta });
    this.opts.sinks.say(text, kind, language);
  }

  /**
   * Moves the call to the file the person named, or asks which of two, or says it is not there. Nothing is created.
   * `words`: what the talking layer wrote to say once there, said instead of the rules' line when the move worked
   * (a promise: it may still be written while the move is made).
   */
  private async switchFile(target: string, language: CallLanguage, words?: Promise<string>): Promise<SwitchResult> {
    const de = language === 'de';
    const ms = () => Math.round(this.opts.now() - this.turnEndedAt);
    if (!this.opts.sinks.switchTo || !target) {
      this.say(de ? 'Das kann ich in diesem Anruf nicht wechseln.' : 'I cannot switch files in this call.', 'reply', language, { route: 'switch', source: 'rules', ms: ms() });
      return { kind: 'none' };
    }
    let r: SwitchResult;
    try { r = await this.opts.sinks.switchTo(target, language); } catch { r = { kind: 'none' }; }
    if (r.kind === 'switched') {
      const name = spokenName(r.name);
      const run = this.runFile ? spokenName(this.runFile) : '';
      const own = words ? shapeSpoken(await words.catch(() => ''), language, this.timing.maxWords) : '';
      // The talking layer's words, unless a run elsewhere goes on, which they would not mention.
      if (own && !run) { this.say(own, 'reply', language, { route: 'switch', source: 'persona', ms: ms() }); return r; }
      const line = run
        ? (de ? `Okay, jetzt ${name}. ${run} läuft noch fertig.` : `Okay, now ${name}. ${run} finishes first.`)
        : (de ? `Okay, wir sind jetzt bei ${name}.` : `Okay, we are in ${name} now.`);
      this.say(line, 'reply', language, { route: 'switch', source: 'rules', ms: ms() });
    } else if (r.kind === 'same') {
      this.say(de ? `Wir sind schon bei ${spokenName(r.name)}.` : `We are already in ${spokenName(r.name)}.`, 'reply', language, { route: 'switch', source: 'rules', ms: ms() });
    } else if (r.kind === 'ambiguous') {
      this.pendingSwitch = r.names;
      const [a, b] = r.names;
      this.say(de ? `Meinst du „${a}“ oder „${b}“?` : `Do you mean "${a}" or "${b}"?`, 'reply', language, { route: 'switch', source: 'rules', ms: ms() });
    } else {
      this.say(de ? `Eine Datei „${target}“ finde ich nicht.` : `I cannot find a file called "${target}".`, 'reply', language, { route: 'switch', source: 'rules', ms: ms() });
    }
    return r;
  }

  /**
   * Asks the talking layer and speaks its answer, the first sentence as soon as it is written. `fallbackLine` is what
   * the rules would say; a line the same as the last one is said another way.
   */
  private async speakTalk(req: PersonaRequest, kind: SpokenKind, meta: { route?: RouteAction } = {}, fallbackLine?: string): Promise<void> {
    const ms = () => Math.round(this.opts.now() - this.turnEndedAt);
    const r = await this.talk(req, { ...(fallbackLine ? { fallbackLine } : {}), onFirst: (first) => this.say(first, kind, req.language, { ...meta, source: 'persona', ms: ms() }) });
    if (r.streamed) { if (r.line) this.say(r.line, kind, req.language, { ...meta, source: 'persona', ms: ms() }); return; }
    this.say(r.line === this.lastLine ? otherWay(r.line, req.language, this.turns++) : r.line, kind, req.language, { ...meta, source: r.source, ms: ms() });
  }

  /**
   * Asks the talking layer, holds its answer to the rules, and falls back to `fallbackLine`, else the rules' line.
   * With `onFirst`, the first sentence is handed over as soon as it is written (and spoken by the caller); the line
   * returned is then only the rest, and `streamed` is set, so that nothing is said twice and no fallback follows.
   */
  private async talk(req: PersonaRequest, opts: { fallbackLine?: string; onFirst?: (sentence: string) => void } = {}): Promise<{ line: string; source: 'persona' | 'rules'; streamed?: boolean }> {
    const fallback = { line: opts.fallbackLine || ruleLine(req.kind, req.language, req.said, this.turns), source: 'rules' as const };
    if (!this.opts.persona) return fallback;
    // The end of a run and the rest of it are told in up to three sentences; everything else in one or two.
    const long = req.kind === 'result' || req.kind === 'question' || req.kind === 'more';
    const shape = (line: string) => (long ? shapeSpoken(line, req.language, Math.max(RESULT_WORDS, this.timing.maxWords), 3) : shapeSpoken(line, req.language, this.timing.maxWords));
    this.pending?.abort();
    const abort = new AbortController();
    this.pending = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = '';
    const onFirst = opts.onFirst ? (sentence: string) => {
      if (first || abort.signal.aborted || /^\s*[{[]/.test(sentence) || /"(action|say)"\s*:/.test(sentence)) return;
      const line = shape(sentence);
      if (!line || (req.agent && verbatimRun(line, req.agent) >= VERBATIM_WORDS)) return;
      first = line;
      opts.onFirst!(line);
    } : undefined;
    try {
      const answer = await Promise.race([
        this.opts.persona(req, abort.signal, onFirst),
        new Promise<null>((resolve) => { timer = setTimeout(() => { if (!first) abort.abort(); resolve(null); }, this.timing.personaTimeoutMs); }),
      ]);
      if (first) {
        // The first sentence is out; the rest follows when it comes, within the line's word limit, or not at all.
        const whole = answer && !/^\s*[{[]/.test(answer) ? shape(answer) : '';
        const rest = restAfter(whole, first);
        return { line: rest && !(req.agent && verbatimRun(rest, req.agent) >= VERBATIM_WORDS) ? rest : '', source: 'persona', streamed: true };
      }
      if (!answer) return fallback;
      // A talking layer that also routes turns can slip into its JSON; that is never spoken.
      if (/^\s*[{[]/.test(answer) || /"(action|say)"\s*:/.test(answer)) return fallback;
      const line = shape(answer);
      if (!line || wordCount(line) < 1) return fallback;
      if (req.agent && verbatimRun(line, req.agent) >= VERBATIM_WORDS) return fallback;
      return { line, source: 'persona' };
    } catch {
      return fallback;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pending === abort) this.pending = null;
    }
  }
}

// ---------------------------------------------------------------- the talking layer's instructions

const EXAMPLES: Record<CallLanguage, string> = {
  de: [
    'Beispiele:',
    'Agent schrieb: "I set the hero headline from 72 to 96 px and broke it after Borrow." -> Die Überschrift ist jetzt größer und steht auf zwei Zeilen.',
    'Agent schrieb: "I have not changed anything. The weekdays are wrong and the mobile slots wrap badly. Should I fix the dates and the wrapping first?" -> Ich habe nichts geändert. Die Wochentage stimmen nicht und mobil bricht Text schlecht um. Soll ich das zuerst beheben?',
    'Agent scheiterte: "Error: layer x7k2m9q1pz not found." -> Das hat nicht geklappt, ich finde die Ebene nicht. Zeigst du sie mir?',
  ].join('\n'),
  en: [
    'Examples:',
    'Agent wrote: "I set the hero headline from 72 to 96 px and broke it after Borrow." -> The headline is bigger now and sits on two lines.',
    'Agent wrote: "I have not changed anything. The weekdays are wrong and the mobile slots wrap badly. Should I fix the dates and the wrapping first?" -> I have not changed anything. The weekdays are wrong and the mobile text wraps badly. Should I fix those first?',
    'Agent failed: "Error: layer x7k2m9q1pz not found." -> That did not work, I cannot find that layer. Can you point me to it?',
  ].join('\n'),
};

const ROUTE_EXAMPLES: Record<CallLanguage, string> = {
  en: [
    'Examples (context: file "Sprechstunde", page "Produkt, Porträts", 7 artboards):',
    '"Which design do you mean?" -> {"action":"answer","say":"The file Sprechstunde, the page Produkt, Porträts."}',
    '"Change something." -> {"action":"clarify","say":"What should I change, the layout, the colours or the text?"}',
    '"Change something." (the agent had offered to fix the weekdays and the mobile wrapping) -> {"action":"clarify","say":"Do you mean the weekdays and the mobile wrapping I suggested?"}',
    '"Make the headline bigger." -> {"action":"agent","say":"Okay, making the headline bigger."}',
    '"Could you check the design? How do you like it?" -> {"action":"agent","say":"Sure, I will look at it and tell you."}',
    '"Yes, do that." (the agent asked whether to fix the dates first) -> {"action":"agent","say":"Good, fixing the dates first."}',
    '"No, leave it." (the agent asked whether to fix the dates) -> {"action":"answer","say":"Okay, I will leave it. What next?"}',
    'While the agent works on "make the design more classy":',
    '"Not just classy, more modern, like full screen. 3D animations like a VC funded company." -> {"action":"steer","say":"Got it, I will tell it: more modern, full screen, with 3D motion."}',
    '"You can also use Fable as an advisor for design choices." -> {"action":"steer","say":"Okay, I will tell it to ask Fable on design choices."}',
    '"Keep updating me here and there." -> {"action":"voice","say":"Sure, I will check in now and then while it works.","updates":true}',
    '"I\'m not sure you got my message." -> {"action":"answer","say":"I did: more modern, full screen, with 3D motion. It is working on that now."}',
    '"After that, make a mobile version too." -> {"action":"queue","say":"Okay, the mobile version comes right after."}',
  ].join('\n'),
  de: [
    'Beispiele (Kontext: Datei "Sprechstunde", Seite "Produkt, Porträts", 7 Artboards):',
    '"Welches Design meinst du?" -> {"action":"answer","say":"Die Datei Sprechstunde, die Seite Produkt, Porträts."}',
    '"Ändere was." -> {"action":"clarify","say":"Was soll ich ändern, das Layout, die Farben oder den Text?"}',
    '"Ändere was." (der Agent hatte angeboten, die Wochentage und den Umbruch am Handy zu korrigieren) -> {"action":"clarify","say":"Meinst du die Wochentage und den Umbruch, die ich vorgeschlagen habe?"}',
    '"Mach die Überschrift größer." -> {"action":"agent","say":"Okay, ich mache die Überschrift größer."}',
    '"Schau dir das Design an. Wie findest du es?" -> {"action":"agent","say":"Gern, ich schaue es mir an und sage dir Bescheid."}',
    '"Ja, mach das." (der Agent fragte, ob er zuerst die Daten korrigieren soll) -> {"action":"agent","say":"Gut, ich korrigiere zuerst die Daten."}',
    '"Nein, lass es." (der Agent fragte, ob er die Daten korrigieren soll) -> {"action":"answer","say":"Okay, dann lasse ich es. Was als Nächstes?"}',
    'Während der Agent an "mach das Design edler" arbeitet:',
    '"Nicht nur edler, moderner, Vollbild, mit 3D-Animationen wie ein VC-finanziertes Startup." -> {"action":"steer","say":"Verstanden, ich sage es ihm: moderner, Vollbild, mit 3D-Bewegung."}',
    '"Du kannst auch Fable als Berater für Designfragen nehmen." -> {"action":"steer","say":"Okay, ich sage ihm, dass er Fable fragen soll."}',
    '"Halt mich zwischendurch auf dem Laufenden." -> {"action":"voice","say":"Klar, ich melde mich zwischendurch kurz, solange er arbeitet.","updates":true}',
    '"Ich weiß nicht, ob du mich richtig verstanden hast." -> {"action":"answer","say":"Doch: moderner, Vollbild, mit 3D-Bewegung. Daran arbeitet er gerade."}',
    '"Danach bitte noch eine mobile Version." -> {"action":"queue","say":"Okay, die mobile Version kommt gleich danach."}',
  ].join('\n'),
};

/** The call context as compact text for a prompt. Nothing is added that the call does not know. */
export function contextText(ctx: CallContext | undefined, withResult = true): string {
  if (!ctx) return '';
  const lines: string[] = [];
  if (ctx.file) {
    const short = spokenName(ctx.file);
    lines.push(`Open file: "${short}"${short !== ctx.file ? ` (full name "${ctx.file}"; say "${short}")` : ''}${ctx.page ? `, page "${ctx.page}"` : ''}.`);
  }
  if (ctx.boards?.length) lines.push(`Artboards on the page (${ctx.boards.length}): ${ctx.boards.slice(0, 12).map((b) => `"${b}"`).join(', ')}${ctx.boards.length > 12 ? ', …' : ''}.`);
  if (ctx.selection?.length) lines.push(`Selected: ${ctx.selection.slice(0, 6).map((b) => `"${b}"`).join(', ')}.`);
  lines.push(ctx.working
    ? `The agent is working on a request right now${ctx.workingMinutes ? `, for about ${ctx.workingMinutes} min` : ', for under a minute'}${ctx.runFile ? `, in the file "${ctx.runFile}" (the call has moved on from it)` : ''}.`
    : 'The agent is idle.');
  if (ctx.drafting?.length) lines.push(`The person is still saying a task for the agent, not sent yet: ${ctx.drafting.map((d) => `"${d}"`).join(' ')}`);
  if (ctx.readBack) lines.push('You read that task back to them; it starts unless they say no or change it.');
  if (ctx.lastRequest) lines.push(`Last request to the agent: "${ctx.lastRequest}"`);
  if (withResult && ctx.lastResult) {
    // The whole answer, so "what else did it say?" is answered from it and never asked of the agent again. Once told,
    // the points said are marked, and the next ones are the rest.
    const whole = ctx.lastResult.length > 6000 ? `…${ctx.lastResult.slice(-6000)}` : ctx.lastResult;
    lines.push(ctx.lastResultSpoken
      ? `The agent's whole last answer (you already told them its outcome; it is here for questions about it and for the rest):\n"""${whole}"""`
      : `The agent's last answer:\n"""${whole}"""`);
    if (ctx.resultTold?.length) lines.push(`Points of it you already told them (do not say them again): ${ctx.resultTold.map((t) => `"${t.slice(0, 200)}"`).join(' ')}`);
    if (ctx.lastResultSpoken && ctx.resultLeft) {
      lines.push(ctx.resultLeft.length
        ? `Points of it not told yet, in order (for "the rest" or "what else", tell the next two or three in your own words; never ask the agent for them): ${ctx.resultLeft.slice(0, 10).map((t) => `"${t.slice(0, 200)}"`).join(' ')}`
        : 'You have told them every point of it: for "the rest", say that was all.');
    }
  }
  if (ctx.pendingQuestion) lines.push(`Open question from the agent: "${ctx.pendingQuestion}"`);
  if (ctx.working && ctx.steps?.length) {
    lines.push(`What the agent did lately, newest last: ${ctx.steps.map((x) => `${x.what}${x.names?.length ? ` on ${x.names.map((n) => `"${n}"`).join(', ')}` : ''} (${x.secondsAgo < 5 ? 'now' : `${x.secondsAgo} s ago`})`).join('; ')}.`);
    if (ctx.activity && !ctx.activity.startsWith('tool:')) lines.push(`Its latest words: ${ctx.activity.slice(0, 300)}`);
  } else if (ctx.working && ctx.activity) lines.push(`What the agent did last: ${ctx.activity.slice(0, 400)}`);
  if (ctx.working && ctx.toldThisRun?.length) lines.push(`Already told them since the agent started (do not say any of it again): ${ctx.toldThisRun.map((t) => `"${t}"`).join(' ')}`);
  if (ctx.recentRuns?.length) {
    lines.push('Agent runs on this file, newest first (also before this call):');
    for (const r of ctx.recentRuns.slice(0, 3)) {
      const when = r.minutesAgo < 1 ? 'just now' : r.minutesAgo < 90 ? `${r.minutesAgo} min ago` : `${Math.round(r.minutesAgo / 60)} h ago`;
      lines.push(`- ${when}, ${r.status === 'running' ? 'STILL RUNNING' : r.status}: asked "${r.asked.slice(0, 200)}"${r.layers ? ` (changed ${r.layers} layers)` : ''}${r.result ? `; it said: """${r.result.slice(0, withResult ? 900 : 300)}"""` : ''}`);
    }
  }
  if (ctx.earlierCall?.length) lines.push('The end of the last call about this file:', ...ctx.earlierCall.slice(-6).map((l) => `  ${l.slice(0, 200)}`));
  if (ctx.otherFiles?.length) lines.push(`Other files worked on lately: ${ctx.otherFiles.slice(0, 3).map((f) => `"${f.name}"${f.lastAsked ? ` (last asked: "${f.lastAsked.slice(0, 80)}")` : ''}`).join(', ')}.`);
  if (ctx.preferences?.length) lines.push(`How the person wants you to talk (said in calls, keep to it):\n${ctx.preferences.slice(0, 8).map((p) => `- ${p.slice(0, 240)}`).join('\n')}`);
  if (ctx.callSummary) lines.push(`Notes on this call so far: ${ctx.callSummary.slice(0, 600)}`);
  if (ctx.history?.length) {
    // The newest lines, within about 2,500 characters, so a small local model's context holds the rest too.
    const kept: string[] = [];
    let used = 0;
    for (const h of [...ctx.history].reverse()) {
      const line = `${h.who === 'person' ? 'Person' : h.who === 'voice' ? 'You' : 'Agent'}: ${h.who === 'agent' ? h.text.slice(0, 400) : h.text}`;
      if (used + line.length > 2500 && kept.length) break;
      kept.unshift(line);
      used += line.length;
    }
    lines.push(`The call so far (oldest first):\n${kept.join('\n')}`);
  }
  return lines.join('\n');
}

const VOICE_RULES = (lang: string) => `Rules: answer in ${lang} only. One or two short spoken sentences, at most 22 words. Use your own simple words, never copy the agent's sentences. No lists, file names with extensions, layer IDs, code, colour codes or markdown. Round numbers. Ask at most one question. Never claim something the agent did not say, and never say something changed when the agent says it did not. When the agent wrote in another language, translate its meaning literally and name things exactly as it did (a cap stays a cap, a caption stays a caption). Output only the words to speak.`;

/**
 * The talking layer's instructions when it decides every turn: one action tag, then the words to speak. Written for
 * how people really talk on a call: fragments, "hello?", "what's up?", questions about the agent, half a request.
 */
function turnSystem(lang: string, language: CallLanguage): string {
  const other = language === 'de' ? 'English' : 'German';
  return [
    'You are the voice on a phone call with a person who is designing in Bogen. You do the talking. A separate design agent does the design work in the open file, and only when you hand it a task. For each thing the person says, you decide what happens and say your part.',
    'Write exactly this, nothing else: the first line is one action tag; the lines after it are the words you speak (leave them out where noted).',
    [
      '@answer: talk. Greetings, small talk, "hello?", questions about you, the call, the open file, what is on screen, whether the agent is working, what it is doing, what it did, changed or found. Use only the facts below. The agent\'s whole last answer is below: "the rest" or "what else did it say" is answered from it with the points not told yet, never handed to the agent.',
      '@clarify: they want something done but it is too vague or garbled to act on. Ask one short question.',
      '@agent goal: <the task as one instruction to the design agent> | keep: <conditions they set, separated by ";"> | size: <small, large or answer>: they want design work, a look at or opinion on the design, or they say yes to the agent\'s open question, and the agent is idle. The goal covers the whole request, also what you asked back about and their answer; repair words speech recognition clearly misheard; add nothing they did not ask for. Leave out "| keep: ..." when there are no conditions. size: small for one local change (text, colour, size or spacing of named layers, or a fix of listed findings), answer for a question or a look that changes nothing, large for new screens, a redesign, a direction or anything unclear. Below it, a short acknowledgement in your own words, at most 10 words.',
      '@steer goal: <the change, as an instruction to the agent> | keep: <conditions>: while the agent works, a change or addition to the task it is doing, or advice on how to do it. Short acknowledgement in your own words.',
      '@queue goal: <the task> | keep: <conditions> | size: <as for @agent>: while the agent works, a separate task meant for after it ("after that", "next"). Short acknowledgement.',
      '@stop: stop the agent\'s run ("stop", "cancel that", "never mind, I changed my mind"). Below it, a few words ("Okay, stopping it.").',
      '@undo: take back what the agent just changed. No words.',
      '@switch <file name>: they want to work in another file ("let\'s continue with X", "open X", "go to X", "back to X"). Write the name as in the file list below if one fits (also when speech recognition garbled it), else as they said it. Below it, a few words for once you are there, naming the file by its short name ("Sure, over to Tirava.").',
      '@brand <brand name>: a task that names a brand to use ("use the Tirava brand"). Short acknowledgement.',
      '@listen: nothing to answer. A fragment, "okay", "mhm", "so...", laughing, thinking aloud, an unfinished half sentence, thanks. No words.',
      '@updates-on or @updates-off: "keep me updated" or "be quiet while it works". Confirm in a few words.',
    ].join('\n'),
    [
      'How you talk:',
      '- Like a sharp, relaxed human assistant on the phone. One or two short sentences, at most 22 words. Plain words.',
      '- News only: never say again what you already told them (see "Already told" and the call so far). If the honest answer is the same, say it in a few new words ("Still at it."), or nothing if they did not ask.',
      '- While the agent works and they only acknowledge, thank you or think aloud, @listen. Silence is fine on a call while work is going.',
      '- Name files by their short name, the part before "·", never the whole long name.',
      '- A greeting gets a greeting back in a few words. Do not add the open file or the agent\'s state unless they ask.',
      '- If they say "go" or "yes" to a task the agent has already started, say in a few words that it is on it (@answer).',
      '- You are the voice, not the agent. Say "it" or "the agent" for its work and "I" only for yourself. Never say you are designing.',
      '- The agent\'s state below is the truth. If it says the agent is working, it is working, whatever was said before in the call.',
      '- Small talk, greetings, complaints and questions are never tasks for the agent. "What\'s up?" is small talk: answer it lightly, maybe with what the agent is up to.',
      '- Never read the person\'s words back to them, and never read out the agent\'s text. Retell in your own words.',
      '- If the person is frustrated ("this is not working"), acknowledge it in a few words and ask what is wrong or offer what you can do.',
      '- If you did not get it, say so and ask them to say it again. Do not guess a task from garbled words.',
      '- Before handing over a change that throws away a lot of work ("redo everything", "start over"), make sure they mean it: if they have not said clearly what and how, ask once with @clarify. Your @agent acknowledgement then says in a few words what will happen; there is no second confirmation.',
      '- Asked whether you understood, say in a few words what you understood.',
      '- After thanks or a compliment a few words are enough; do not add a status update you just gave.',
      '- Say what the agent is doing only from the facts; if they hold no detail, say it is working, without inventing steps.',
      `- Speak ${lang} only. They may speak ${other}: understand it and answer in ${lang}.`,
      '- No lists, IDs, file extensions, code or colour codes. Round numbers.',
    ].join('\n'),
    [
      'Examples:',
      'Agent idle. "Hello?" -> @answer\nYes, I\'m here.',
      'Agent working on the redo. "Hello?" -> @answer\nHi, still here. The redo is going.',
      'Agent working on the booking card. "So, what\'s up?" -> @answer\nNot much, the agent is still on the booking card.',
      'Agent working. "Is the agent working?" -> @answer\nYes, it\'s still on it, about two minutes in.',
      '"So..." -> @listen',
      '"Could you... if he\'s..." -> @listen',
      '"Thanks." -> @listen',
      'Agent working, you already said it is on the redo. "Is it still going?" -> @answer\nStill at it, about three minutes in.',
      'Agent working. "Alright, cool." -> @listen',
      'Agent idle. "Make the headline on the start page bigger." -> @agent goal: Make the headline on the start page bigger. | size: small\nSure, a bigger headline on the start page.',
      'Agent idle, you asked "the whole file or one screen?". "The whole file, more like a magazine, keep the portraits." -> @agent goal: Redo the whole file as a magazine-style layout. | keep: the founder portraits | size: large\nGot it, the whole file as a magazine.',
      'Agent working on the fonts. "Also make sure it follows the brand rules." -> @steer goal: Make sure the new fonts follow the brand rules.\nGot it, I\'ll tell it to stick to the brand rules.',
      '"Let\'s continue with the Tirava website." -> @switch Tirava · Website\nSure, over to Tirava.',
      '"Stop, I changed my mind." -> @stop\nOkay, stopping it.',
      'Agent idle. "Hey, how are you?" -> @answer\nGood, thanks. What are we working on?',
      'Agent just started the redo they asked for. "Yes, go." -> @answer\nIt\'s already on it.',
      '"Make it better." -> @clarify\nBetter how: the layout, the colours or the text?',
      '"This is not working, right?" -> @answer\nSorry about that. What isn\'t working, the call or the design?',
    ].join('\n'),
  ].join('\n\n');
}

/** The system and user text for the talking layer. Kept here so the call and the harness ask the same way. */
export function personaPrompt(req: PersonaRequest): { system: string; user: string } {
  const de = req.language === 'de';
  const lang = de ? 'German' : 'English';
  const ctx = contextText(req.context, req.kind === 'route' || req.kind === 'chat' || req.kind === 'brief' || req.kind === 'turn');
  if (req.kind === 'route') {
    const system = [
      'You are the voice of a design assistant in a phone call. Another program, the agent, does the design work in the open file; it can look at the design, review it and change it. You decide what to do with what the person just said, and you speak.',
      'Answer with JSON only: {"action": "agent" | "answer" | "clarify" | "steer" | "queue" | "voice", "say": "...", "updates": true | false}.',
      '- "answer": a question you can answer from the context below (which file, page or design; what is on the page; what the agent did, found or proposed; whether it is still working; whether you understood the person). "say" is the answer.',
      '- "clarify": a request too vague to act on ("change something", "make it better" without saying what). "say" is one short question back.',
      '- "agent" (only when the agent is idle): anything that needs looking at or changing the design, a review or opinion, or a yes or no to the agent\'s open question. "say" is a short acknowledgement that names what will happen, at most 12 words.',
      '- "steer" (only while the agent works): more detail on, a change to, or advice on how to do the task it is working on now (also "use Fable as an advisor", "keep it in one file"). It goes to the agent at once. "say" names what you understood and that you pass it on, at most 14 words, never the same words as your last line.',
      '- "queue" (only while the agent works): a separate task meant for after the current one ("after that", "next"). "say" names it, at most 12 words.',
      '- "voice": about how you talk in the call: "keep me updated" ("updates": true) or "be quiet" ("updates": false). "say" confirms it.',
      `"say" is ALWAYS in ${lang}, whatever language the context is in; spoken, at most 22 words for an answer and at most 10 for an acknowledgement, no lists or IDs. Use only facts from the context; if the context does not hold the answer, choose "agent".`,
      ROUTE_EXAMPLES[req.language],
    ].join('\n\n');
    return { system, user: `${ctx}\n\nThe person just said: "${req.said}"\nJSON:` };
  }
  if (req.kind === 'turn') return { system: turnSystem(lang, req.language), user: `${ctx}\n\nThe person just said: "${req.said}"` };
  if (req.kind === 'summary') {
    const system = [
      'You keep the notes of a voice call between a person and a design assistant. The notes replace the older lines of the call for the rest of it, and for the next call about the same file.',
      'Write what matters: what the person wants and in which file, what was decided or done, what is still open or was asked. At most two sentences and 60 words, in English, plain text, no lists or labels. Keep names of files, brands and people exactly. Never add anything that was not said; when nothing new happened, repeat the old notes.',
    ].join('\n\n');
    const old = req.context?.callSummary ? `Notes so far: "${req.context.callSummary}"\n\n` : '';
    // The call itself, not what the voice knows besides it.
    const { callSummary: _notes, preferences: _wishes, otherFiles: _others, earlierCall: _before, ...call } = req.context ?? {};
    return { system, user: `${old}${contextText(call, false)}\n\nNew notes:` };
  }
  if (req.kind === 'brief') {
    const d = req.draft ?? { said: [req.said], corrections: [], aside: [] };
    const system = [
      'You are the host of a voice call between a person and a design agent. You turn what the person said for one task into a clear brief for the agent, which then does the work in the open design file.',
      'Answer with JSON only: {"goal": "...", "constraints": ["...", "..."], "size": "small" | "large" | "answer"}.',
      `- "goal": one sentence in ${lang}, at most 25 words: what the person wants done, in their sense, worded as an instruction to the agent ("Redo the start page as a magazine layout"), never about "the person". ${d.steer ? 'This was said while the agent was already working: describe the change to its current task.' : ''}`,
      '- "constraints": conditions they set (keep this, use that, ask someone, a style, a reference), each a short phrase. Leave it empty when there are none.',
      '- "size": "small" for one local change (text, colour, size or spacing of named layers, or a fix of listed findings), "answer" for a question or a look that changes nothing, "large" for new screens or pages, a redesign, a direction, several screens, or anything unclear.',
      'Speech recognition writes what it heard and makes mistakes: repair words that are clearly misheard from the context ("witch design" means "which design", "Präda" may be a name on screen). Corrections replace what they correct ("no, I said NOT happy" turns "happy" into "not happy"). What the person said to the voice about other things is only context.',
      'Never add wishes the person did not say, and never drop one they did say. No markdown.',
    ].join('\n\n');
    const user = [
      ctx,
      `What the person said for this task (oldest first):\n${d.said.map((x) => `"${x}"`).join('\n')}`,
      d.corrections.length ? `Their corrections:\n${d.corrections.map((x) => `"${x}"`).join('\n')}` : '',
      d.aside.length ? `Said to the voice meanwhile:\n${d.aside.map((x) => `"${x}"`).join('\n')}` : '',
      'JSON:',
    ].filter(Boolean).join('\n\n');
    return { system, user };
  }
  const system = [
    'You are the voice of a design assistant in a phone call. Another program, the agent, does the actual design work and writes its details into a chat. You only talk.',
    VOICE_RULES(lang),
    EXAMPLES[req.language],
  ].join('\n\n');
  const agent = (req.agent ?? '').slice(0, 6000);
  const said = req.said && req.kind !== 'event' ? `The person had said: "${req.said}"\n` : '';
  const pre = ctx ? `${ctx}\n\n` : '';
  const ranIn = req.ranIn ? `\nThis run was in the file "${req.ranIn}", which the call has left: start by naming it.` : '';
  let task = '';
  switch (req.kind) {
    case 'result': task = `${pre}${said}Answer in plain spoken words, not JSON. The agent finished and wrote:\n"""${agent}"""\nTell the person in ${lang} the result itself, faithfully, in one to three short sentences and at most 45 words. If it changed the design: what changed. If it only looked, reviewed or answered: the gist, then its top two or three points. Start with the result; never with what it did not do (not "I left the design as it was").${ranIn}`; break;
    case 'more': task = `${pre}Answer in plain spoken words, not JSON. The person asked for more of the agent's last answer: "${req.said}". The next points of it, not told yet:\n"""${agent}"""\nTell them these points in ${lang}, in your own words, in one to three short sentences and at most 45 words. Do not repeat what you already told them, and do not say you will ask the agent.`; break;
    case 'question': task = `${pre}${said}Answer in plain spoken words, not JSON. The agent finished and wrote:\n"""${agent}"""\nIn ${lang}: say in a few words what it did or found (say plainly if it changed nothing), then ask its question or proposal so the person can answer yes or no.${ranIn}`; break;
    case 'error': task = `${pre}${said}Answer in plain spoken words, not JSON. The agent could not do it and wrote:\n"""${agent}"""\nTell the person in ${lang} that it did not work, and what they could try.${ranIn}`; break;
    case 'event': task = `${pre}Answer in plain spoken words, not JSON. Something just happened in the call: ${req.said}\nTell the person in ${lang}, in one short sentence of at most 12 words.`; break;
    case 'chat': task = `${pre}${said}Answer in plain spoken words, not JSON. The person said: "${req.said}". Reply in ${lang}, short and natural.`; break;
    case 'progress': task = `${pre}Answer in plain spoken words, not JSON. The agent is still working. What it did last:\n"""${agent}"""\nTell the person in ${lang}, in one short sentence of at most 14 words, what it is doing now. Do not say it is done, and do not read its words out.`; break;
  }
  return { system, user: task };
}
