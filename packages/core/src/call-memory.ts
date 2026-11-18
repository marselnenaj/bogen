/**
 * What a voice call keeps beyond its last few lines: wishes the person states about how the voice talks ("sprich
 * kürzer", "nenn mich Sam"), which stay for every later call, and brands the person names ("nimm die Marke
 * Sprechstunde"). Plain functions on text, so the call, the server and the tests read them the same way.
 */
import type { CallLanguage } from './speech.ts';

/**
 * A standing wish about the call. `length` is `short` or `long`; `name` the name to call the person; `language` the
 * call's language (`de` or `en`); `quiet` no answer to thanks, compliments or "okay"; `other` anything else said for
 * the future, kept in the person's words.
 */
export type CallPreferenceKind = 'length' | 'name' | 'language' | 'quiet' | 'other';
export interface CallPreference { kind: CallPreferenceKind; value: string; text: string }

/** A stated preference as kept on the server: with an id and when it was said. */
export interface StoredCallPreference extends CallPreference { id: string; at: number }

function bare(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:"„“”'’…]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Words that make a wish one for later calls too, not only for the next answer. */
const DURABLE = /\b(ab jetzt|ab sofort|von jetzt an|in zukunft|künftig|immer|nie|niemals|bitte immer|from now on|going forward|in future|in the future|always|never|don t ever|do not ever|every time)\b/;
const SHORT = /\b(?:(?:sprich|rede|red|antworte|antwort|sei|fass dich)\b.*\b(?:kürzer|kurz|knapper|knapp)|kürzere antworten|nicht so (?:lang|viel) (?:reden|labern)|weniger (?:reden|labern)|be (?:more )?(?:brief|concise)|shorter (?:answers|replies|sentences)|keep (?:it|your answers|them) short|talk less|speak (?:more )?briefly|less talking)\b/;
const LONG = /\b(?:(?:sprich|rede|antworte|erklär|erklaer)\b.*\b(?:ausführlicher|länger|mehr details)|ausführlichere antworten|more detail(?:ed)? answers|longer answers|(?:explain|answer|speak) (?:in )?more detail|elaborate more)\b/;
const LANG_DE = /\b(?:(?:sprich|rede|red)\b(?: \w+){0,3} (?:deutsch|auf deutsch)|(?:speak|talk)(?: to me)?(?: in)? german)\b|^(?:(?:ab jetzt|bitte|lieber|nur noch|from now on|please) )*(?:(?:auf|in) )?(?:deutsch|german)(?: (?:bitte|please|ab jetzt|from now on))*$/;
const LANG_EN = /\b(?:(?:sprich|rede|red)\b(?: \w+){0,3} (?:englisch|auf englisch)|(?:speak|talk)(?: to me)?(?: in)? english)\b|^(?:(?:ab jetzt|bitte|lieber|nur noch|from now on|please) )*(?:(?:auf|in) )?(?:englisch|english)(?: (?:bitte|please|ab jetzt|from now on))*$/;
/** "nenn mich Sam", "call me Sam": a name, then the turn ends. */
const NAME_DE = /\b(?:nenn|nenne) mich ([\p{L}][\p{L}'-]{1,30})(?: bitte)?\s*[.!]?\s*$/iu;
const NAME_EN = /\bcall me ([\p{L}][\p{L}'-]{1,30})(?: please)?\s*[.!]?\s*$/iu;
const NOT_A_NAME = /^(bitte|an|später|zurück|wenn|sobald|back|later|when|if|once|again|please|du|ihr|sie|now|tomorrow|today|morgen|heute|jetzt|maybe|vielleicht)$/i;
/** "You don't need to reply to every thanks": the voice stays quiet on thanks, compliments and "okay". */
const QUIET = /\b(?:(?:you )?(?:don t|do not|dont|no) need (?:to )?(?:reply|answer|respond|say anything)|(?:don t|do not|dont|no need to) (?:reply|answer|respond) (?:to|when|if|every|each)|(?:du )?(?:musst|brauchst) (?:nicht|nichts) (?:auf|zu|bei) (?:jedes|jeden|jede|danke)|(?:antworte|antwort|sag) (?:nicht|nichts) (?:auf|bei|wenn) (?:jedes |ein |)(?:danke|thanks|okay|ok))\b.*\b(?:thanks|thank you|thank|okay|ok|compliment|compliments|danke|lob|everything|every time|alles|jedes)\b|\bstop (?:saying|answering) (?:you(?: are| re) welcome|to thanks)\b|\bhör auf (?:mit )?(?:gern|gerne)\b/;
/** A wish for later about how the voice itself talks: it names talking or asking. */
const TALK_VERB = /\b(sag|sagst|sprich|sprichst|rede|redest|antworte|antwortest|frag|fragst|wiederhol|wiederholst|lies|liest|say|talk|speak|answer|ask|repeat|read|tell)\b/;
/** A wish that is about the agent or the design, not the voice: that goes to the agent. */
const ABOUT_AGENT = /\b(agent|dem agenten|claude|codex|er soll|it should|the design|das design|datei|file)\b/;

/**
 * A preference the person states in a call, or null. A wish for shorter or longer answers, a name or a language is
 * one at once; anything else counts only with a word for later ("ab jetzt", "from now on", "nie") and about how the
 * voice talks, so "ab jetzt immer blaue Buttons" stays a request for the agent. `designWords` is the call's own test
 * for words of the design.
 */
export function callPreference(said: string, designWords?: RegExp): CallPreference | null {
  const text = said.replace(/\s+/g, ' ').trim();
  const t = bare(text);
  if (!t || t.split(' ').length > 24) return null;
  const name = NAME_DE.exec(text) ?? NAME_EN.exec(text);
  if (name && !NOT_A_NAME.test(name[1]!)) return { kind: 'name', value: name[1]!.replace(/^./, (c) => c.toUpperCase()), text };
  if (SHORT.test(t)) return { kind: 'length', value: 'short', text };
  if (LONG.test(t)) return { kind: 'length', value: 'long', text };
  if (LANG_EN.test(t)) return { kind: 'language', value: 'en', text };
  if (LANG_DE.test(t)) return { kind: 'language', value: 'de', text };
  if (QUIET.test(t)) return { kind: 'quiet', value: '', text };
  if (DURABLE.test(t) && TALK_VERB.test(t) && !ABOUT_AGENT.test(t) && !(designWords?.test(t))) return { kind: 'other', value: '', text };
  return null;
}

/** Whether a language wish is for later calls too, not only for this one. */
export function durableWish(said: string): boolean {
  return DURABLE.test(bare(said));
}

/** One stored preference as an instruction for the talking layer. */
export function preferenceLine(p: CallPreference): string {
  switch (p.kind) {
    case 'length': return p.value === 'short' ? 'Keep every answer very short: one sentence, about ten words.' : 'The person likes a little more detail: up to three short sentences.';
    case 'name': return `The person's name is "${p.value.slice(0, 40)}". Use it rarely, as people do on the phone: in a greeting or a goodbye, at most in one answer out of five, never in two answers in a row.`;
    case 'language': return `Speak ${p.value === 'de' ? 'German' : 'English'} unless the person speaks the other language.`;
    case 'quiet': return 'Do not answer thanks, compliments or "okay": stay quiet (@listen).';
    default: return `The person asked: "${p.text.slice(0, 200)}". Keep to it.`;
  }
}

/** How a preference reads in a list the person sees. */
export function preferenceLabel(p: CallPreference, language: CallLanguage): string {
  const de = language === 'de';
  switch (p.kind) {
    case 'length': return p.value === 'short' ? (de ? 'Kurze Antworten' : 'Short answers') : (de ? 'Ausführlichere Antworten' : 'More detailed answers');
    case 'name': return de ? `Nenn mich ${p.value}` : `Call me ${p.value}`;
    case 'language': return p.value === 'de' ? (de ? 'Auf Deutsch sprechen' : 'Speak German') : (de ? 'Auf Englisch sprechen' : 'Speak English');
    case 'quiet': return de ? 'Kein „Gern“ auf jedes Danke' : 'No reply to every thanks';
    default: return `“${p.text}”`;
  }
}

/** The words a spoken answer may have with this preference: fewer for short, more for long, else the default. */
export function wordsFor(prefs: CallPreference[], fallback: number): number {
  const length = prefs.filter((p) => p.kind === 'length').at(-1)?.value;
  return length === 'short' ? 14 : length === 'long' ? 34 : fallback;
}

/**
 * Adds a preference to a list: a new length, name or language replaces the old one of its kind; another wish is kept
 * once. The newest twenty stay.
 */
export function mergePreference<T extends CallPreference>(list: T[], next: T): T[] {
  const kept = list.filter((p) => (next.kind === 'other' ? !(p.kind === 'other' && bare(p.text) === bare(next.text)) : p.kind !== next.kind));
  return [...kept, next].slice(-20);
}

// ---------------------------------------------------------------- brands

const BRAND_WORD = '(?:marke|brand)';
const BRAND_PATTERNS = [
  new RegExp(`\\b(?:nimm|nehm|nehmt|verwende|verwend|benutze|benutz|nutze|nutz|wende|apply|use|take|pick|switch to|wechsel(?:e)? (?:zu|zur|auf)) (?:(?:die|der|den|unsere|meine|the|our|my) )?${BRAND_WORD} (?:namens |called |named )?(.+?)(?: (?:an|bitte|please|for (?:this|it)|dafür|hier|here))*$`),
  new RegExp(`\\b(?:in|mit|im stil) (?:der|unserer|meiner) ${BRAND_WORD} (.+?)(?: (?:an|bitte|please|dafür|hier|um|neu|machen|gestalten))*$`),
  new RegExp(`\\b(?:in|with) (?:the|our|my) (.+?) ${BRAND_WORD}\\b`),
  new RegExp(`\\b(?:use|apply|take) (?:the |our |my )?(.+?) ${BRAND_WORD}\\b`),
];
const BRAND_STOP = /^(?:die|der|den|das|the|a|an|this|that|diese|neue|new|andere|other|bogen|eine|einer|unsere|our|my|meine)$/;

/** The brand a turn names ("nimm die Marke Sprechstunde", "use the Tomacco brand"), as the person said it, or null. */
export function brandTarget(said: string): string | null {
  const t = bare(said);
  for (const re of BRAND_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const name = m[1]!.replace(/\b(bitte|please|mal|jetzt|now)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || BRAND_STOP.test(name) || name.split(' ').length > 5) continue;
    return name;
  }
  return null;
}

/** What the agent is told about the brand the person named: its id, so it does not have to guess among similar names. */
export function brandNote(name: string, id: string): string {
  return `The brand the person named is "${name}", Bogen brand ${id}. Use that brand (brand_get, and brand_link or brand_apply when the file should follow it).`;
}

// ---------------------------------------------------------------- the call's own notes

/** Holds the talking layer's notes on the call to two sentences and 400 characters, without quotes or labels. */
export function cleanSummary(raw: string): string {
  let s = raw.replace(/^\s*(?:notes?|summary|new notes)\s*:\s*/i, '').replace(/^["„“']+|["“”']+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s || /^\s*[{[]/.test(s)) return '';
  const sentences = s.match(/[^.!?]+[.!?]+(?=\s|$)/g);
  if (sentences && sentences.length > 2) s = sentences.slice(0, 2).map((x) => x.trim()).join(' ');
  return s.length > 400 ? `${s.slice(0, 399).replace(/\s+\S*$/, '')}…` : s;
}
