/**
 * How big a request to an agent is, so that a run the person did not choose a model for can use one that fits it:
 * a small local change does not need the slowest model at full effort, and most of a run is the model thinking. The
 * person's choice always wins over this (run-settings.ts); this only fills the gap where nothing was chosen.
 *
 * - small: one target and a local change (text, colour, size or spacing of named layers), or a fix of listed findings.
 * - large: new screens or pages, a redesign, art direction, several screens, a brand book.
 * - answer: a question or a look that changes nothing.
 *
 * Ambiguous requests count as large: a large model on a small task costs time, a small model on a large task costs
 * the work.
 */
import { inferIntent, type RunIntent } from './run-intent.ts';

export type RunSize = 'small' | 'large' | 'answer';
export const RUN_SIZES: readonly RunSize[] = ['small', 'large', 'answer'];

export function isRunSize(value: unknown): value is RunSize {
  return typeof value === 'string' && (RUN_SIZES as readonly string[]).includes(value);
}

export interface RunSizeInput {
  /** The message as it goes to the agent. A call's brief is read for its goal and the person's words. */
  prompt: string;
  /** How many layers the person selected for it. */
  selected?: number;
  /** A size the call's talking layer wrote with its brief. */
  hint?: RunSize;
  intent?: RunIntent;
  review?: string;
  images?: number;
}

export interface RunSizeVerdict { size: RunSize; reason: string }

/** Whole screens, pages or a new direction: always large. */
const LARGE = [
  /\b(re-?design|re-?do|rework|rebuild|from scratch|start (?:it )?over|art direction|direction|brand ?book|brand guidelines?|style guide|design system|new (?:screens?|pages?|sections?|layout|flow|app|site|website|version|look|design|concept)|(?:several|multiple|all|every|each|the other|more|three|four|five|\d+) (?:screens?|pages?|artboards?|sections?|variants?|states?)|whole (?:page|file|design|site|app|thing|flow)|landing page|onboarding|illustrations?|graphics|mode for|from (?:the )?brief)\b/i,
  /\b(?:design|create|build|make|draw|add) (?:a|an|the|me a|me an) (?:\w+ ){0,3}(?:screen|page|site|website|app|dashboard|flow|deck|poster|ad|logo|section|hero|layout|component|menu|form|modal|sheet|state)s?\b/i,
  /(?<!\p{L})(neu gestalten|neu machen|überarbeite|umgestalten|komplett neu|von vorne|von vorn|neue (?:seite|seiten|screens?|bildschirme?|ansicht|version)|alle (?:seiten|screens|bildschirme|abschnitte)|mehrere (?:seiten|screens|bildschirme)|ganze (?:seite|datei)|markenbuch|gestaltungsrichtung|illustrationen?|entwirf|entwerfe|gestalte)(?!\p{L})/iu,
];
/** What a local change is made of: words, a colour, a size, a gap, a weight, an alignment. */
const LOCAL = [
  /\b(text|copy|wording|words?|label|title|headline|heading|subtitle|caption|typo|spelling|rename|colou?rs?|tint|shade|darker|lighter|brighter|background|font[- ]?size|font[- ]?weight|weight|bold|bolder|italic|size|bigger|smaller|larger|taller|shorter|wider|narrower|px|pt|rem|spacing|padding|margin|gap|align|aligned|alignment|centre|center|radius|rounded|corner|border|opacity|line[- ]?height|tracking|letter[- ]?spacing|icon)\b/i,
  /(?<!\p{L})(text|überschrift|titel|farbe|farben|dunkler|heller|größer|groesser|kleiner|breiter|schmaler|abstand|abstände|abstaende|rand|fett|schrift|schriftgröße|ausrichten|zentrieren|tippfehler|umbenennen|symbol)(?!\p{L})/iu,
];
/** A fix of findings that were listed, from a review or a check. */
const LISTED_FIX = /\b(?:fix|repair|address|resolve)\b[^.\n]{0,80}\b(?:findings?|defects?|issues?|problems?|points?|notes?|comments?|errors?|overflows?|contrast)\b|(?<!\p{L})(?:behebe?|korrigiere?)(?!\p{L})[^.\n]{0,80}(?<!\p{L})(?:fehler|befunde?|punkte|probleme?)(?!\p{L})/iu;
/** More than one target in a local change. */
const MANY = /\b(?:all|every|each|everywhere|throughout|across|whole|entire|screens|pages|artboards)\b|(?<!\p{L})(?:alle|überall|ueberall|sämtliche|ganze|seiten|bildschirme)(?!\p{L})/iu;
const QUESTION_START = /^\s*(?:what|why|how|which|where|who|when|is|are|was|were|does|did|do you|have you|has it|warum|wieso|weshalb|was|wie|welche[srnm]?|wo|wer|wann|ist|sind|hast|hat|gibt es)\b/iu;
const REQUEST_START = /^\s*(?:can|could|would|will|please|kannst|könntest|koenntest|würdest|wuerdest|bitte)\b/iu;
const LOOK = /\b(?:what do you think|how do you like|your (?:opinion|thoughts|feedback|take)|give (?:me )?(?:an? |your )?(?:opinion|feedback|review)|review|critique|check (?:the|this|it|my)|look at|have a look|take a look|tell me|explain (?:to me|why|what|how|this|that)|list the|summari[sz]e)\b|(?<!\p{L})(?:wie findest du|was hältst du|was haeltst du|schau dir|erklär|erklaer|sag mir)(?!\p{L})/iu;
const CHANGE_VERB = /\b(?:make|change|add|remove|delete|move|fix|set|turn|swap|replace|use|put|increase|decrease|reduce|enlarge|shrink|rename|align|redo|rebuild|create|draw|apply|update|improve|generate)\b|(?<!\p{L})(?:mach|mache|ändere?|aendere?|füg|fuege?|entfern|lösch|loesch|setz|nimm|verschieb|ersetz|vergrößer|verkleiner|richte)(?!\p{L})/iu;

/** The part of a message that says what is wanted: a call brief's goal and verbatim words, else the whole message. */
export function requestText(prompt: string): string {
  if (!prompt.startsWith('[')) return prompt;
  const goal = /^(?:Goal|Ziel|Change to the task|Änderung an der Aufgabe): (.+)$/m.exec(prompt)?.[1] ?? '';
  const said = /(?:Said verbatim|Wörtlich gesagt)[^:\n]*:\n((?:".*"\n?)+)/.exec(prompt)?.[1] ?? '';
  const words = said.split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean).join(' ');
  return goal || words ? [goal, goal ? '' : words].filter(Boolean).join(' ') : prompt.replace(/^\[[^\]]*\]\s*/, '');
}

const any = (patterns: RegExp[], text: string) => patterns.some((re) => re.test(text));

/** The size of a request, and why, in a few words for the run's record. */
export function classifyRun(input: RunSizeInput): RunSizeVerdict {
  if (input.hint && isRunSize(input.hint)) return { size: input.hint, reason: `the call's brief says ${input.hint}` };
  const text = requestText(input.prompt).replace(/\s+/g, ' ').trim();
  if (!text) return { size: 'large', reason: 'nothing to read the size from' };
  if (input.review === 'proposal' || input.review === 'directions') return { size: 'large', reason: 'copies to review' };
  if (input.images) return { size: 'large', reason: 'an image goes with it' };
  const intent = input.intent ?? inferIntent(text);
  if (intent !== 'edit') return { size: 'large', reason: intent === 'new_page' ? 'a new page' : 'a redo of existing work' };
  if (any(LARGE, text)) return { size: 'large', reason: 'new screens, a redesign or a direction' };
  // A question or a look that asks for no change.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const asking = sentences.every((s) => (/\?\s*$/.test(s) || QUESTION_START.test(s)) && !REQUEST_START.test(s));
  if (asking || (LOOK.test(text) && !CHANGE_VERB.test(text.replace(LOOK, ' ')))) return { size: 'answer', reason: 'a question or a look, nothing to change' };
  if (input.review === 'critique') return { size: 'answer', reason: 'notes only, nothing changes' };
  if (LISTED_FIX.test(text) && (input.selected ?? 0) <= 1) return { size: 'small', reason: 'a fix of listed findings' };
  const local = any(LOCAL, text);
  const oneTarget = (input.selected ?? 0) <= 3 && !MANY.test(text);
  // A local change is said briefly: a long message usually holds more than one thing.
  const short = text.length <= 280 && sentences.length <= 3;
  if (local && oneTarget && short) return { size: 'small', reason: 'one target, a local change' };
  return { size: 'large', reason: local ? 'a change of more than one target' : 'not clearly small' };
}
