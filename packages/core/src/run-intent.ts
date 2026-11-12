/**
 * What a request to an agent means for existing work: change it in place, redo it as a revision next to the original,
 * or make a new page. The prompt bar shows this as the person types and the server decides with the same function
 * when a request comes without one (a comment, the phone, another client), so "make the page again, I don't like it"
 * never becomes another page by accident. The person can always switch it for one message in the prompt bar.
 */

export type RunIntent = 'edit' | 'revise' | 'new_page';

// Words people use for "do it again", in English and German, as phrases rather than single words. German phrases are
// bounded by "not a letter", since \b does not see letters such as Ü.
const REDO: RegExp[] = [
  /\b(re-?do|redesign|rework|start (it )?over|from scratch|make (it|this|the \w+) (again|over|new)|try again|another (take|pass|go)|(do|build|design) (it|this|the \w+) again|i (don'?t|do not) like (it|this|the \w+))\b/gi,
  /(?<!\p{L})(neu (machen|gestalten|bauen|aufbauen|entwerfen)|mach(e|t)? (es|das|die \p{L}+|den \p{L}+) (nochmal|noch ?einmal|neu)|nochmal (von vorne|neu)|von (vorne|vorn|null)|gef[äa]llt mir (so )?nicht|[üu]berarbeite|umgestalten|komplett neu)(?!\p{L})/giu,
];
const NEW_PAGE: RegExp[] = [
  /\b(new|another|separate|extra|add an?) page\b/gi,
  /(?<!\p{L})(neue|weitere|zus[äa]tzliche|eigene) (seite|page)(?!\p{L})/giu,
];
/** A negation shortly before a phrase turns it around: "don't redesign it", "bitte nicht neu machen", "without a new page". */
const NEGATION = /(\b(don'?t|do not|never|no need to|no|not|without|instead of|rather than|stop)\b|(?<!\p{L})(nicht|kein(e|en)?|ohne|statt|anstatt)(?!\p{L}))[^.!?;]{0,24}$/iu;
/** A question that asks about something rather than for something: why, what, how … but not "can you redo …". */
const ASKING = /^\s*(why|what|how|when|who|where|which|is|are|was|were|did|does|warum|wieso|weshalb|was|wie|wann|wer|wo|welche[rsn]?|ist|sind|war|hast|habt)\b/iu;
const REQUESTING = /^\s*(can|could|would|will|please|kannst|k[öo]nntest|w[üu]rdest|bitte)\b/iu;

/** Quoted words are content being discussed, not the request itself: "the button that says 'start over'". */
function withoutQuotes(text: string): string {
  return text.replace(/"[^"\n]{0,200}"|“[^”\n]{0,200}”|„[^“”\n]{0,200}[“”]|«[^»\n]{0,200}»|`[^`\n]{0,200}`|(?<![\p{L}])'[^'\n]{1,200}'(?![\p{L}])/gu, ' ');
}

/** Whether one of the phrases occurs in the text without a negation just before it. */
function asked(patterns: RegExp[], text: string): boolean {
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      // "I don't like it" is itself the request, so its own "don't" is not a negation of it.
      if (/^i (don'?t|do not) like/i.test(m[0])) return true;
      if (!NEGATION.test(before)) return true;
    }
  }
  return false;
}

/** The intent a request reads as. New page only when it says so; redo when it asks for the work again; else edit. */
export function inferIntent(prompt: string): RunIntent {
  const text = withoutQuotes(prompt.slice(0, 2000));
  // Every sentence that is a question about something (not a polite request) asks nothing to be done.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const acting = sentences.filter((s) => !(s.endsWith('?') && ASKING.test(s) && !REQUESTING.test(s))).join(' ');
  if (!acting) return 'edit';
  if (asked(NEW_PAGE, acting)) return 'new_page';
  if (asked(REDO, acting)) return 'revise';
  return 'edit';
}
