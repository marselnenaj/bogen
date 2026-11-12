import type { RunReview } from './agents.ts';

/**
 * A run asked to change something that ends having changed nothing usually agreed instead of working: "You're
 * right, that should be bigger." The guard notices, and continues the run once with a short nudge. It needs to
 * know whether the person asked for a change at all, which is what `asksForChange` guesses, in English and German.
 */

/** Said to a run that replied without changing anything. */
export const NUDGE = 'You replied without changing anything. If the person asked for a change, make it now; if it truly was only a question, say so in one sentence.';

/** Tools that write to the document without changing the design: talking in a thread is not doing the work. */
export const TALK_TOOLS = new Set(['comment_add', 'comment_reply']);

const L = '\\p{L}\\p{N}_';
/** A word list as a regex part, bounded by letters in any script, since \b only knows ASCII. */
const words = (list: string) => `(?<![${L}])(?:${list})(?![${L}])`;

/** Verbs that open a request when a sentence starts with them. */
const IMPERATIVE_EN = 'make|change|add|remove|delete|drop|move|fix|use|set|put|replace|rename|swap|switch|tighten|loosen|increase|decrease|reduce|raise|lower|enlarge|shrink|scale|align|center|centre|bump|darken|lighten|rewrite|reword|write|draw|design|create|build|rebuild|turn|give|try|apply|update|adjust|resize|shorten|lengthen|hide|unhide|split|merge|group|ungroup|wrap|duplicate|convert|restyle|redo|clean|simplify|tidy|polish|round|translate|crop|flip|rotate|style|colou?r|recolou?r|fill|insert|place|stack|soften|declutter|organi[sz]e|arrange|reorder|sort|match|go|bring|push|pull|cut|trim|space|pad|widen|narrow|thicken|emphasi[sz]e|highlight|do (?:it|that|this|so|the|a|an|what|something)|mach|mache|macht|ändere?|aendere?|füge?|fuege|entferne?|lösche?|loesche|verschiebe?|setze?|nimm|ersetze?|benenne?|tausche?|vergrößere?|vergroessere?|verkleinere?|richte|zentriere?|schreibe?|zeichne|erstelle?|baue?|gib|probiere?|passe?|korrigiere?|behebe?|verbessere?|kürze?|kuerze?|straffe?|erhöhe?|erhoehe?|reduziere?|verringere?|dunkle|helle|färbe?|faerbe?|tu|versuche?|übersetze?|uebersetze?|formuliere?|gestalte?|räume?|raeume?|vereinfache?|vereinheitliche?|teile?|gruppiere?|drehe?|ziehe?|lege?|stelle?|hole?|fülle?|fuelle?|hebe?|rücke?|ruecke?|schiebe?';
/** German infinitives that end a telegraphic request: "Abstände vereinheitlichen", "das größer machen". */
const INFINITIVE_DE = 'machen|ändern|aendern|hinzufügen|hinzufuegen|einfügen|einfuegen|entfernen|löschen|loeschen|verschieben|setzen|ersetzen|vergrößern|vergroessern|verkleinern|zentrieren|ausrichten|anpassen|korrigieren|beheben|verbessern|kürzen|kuerzen|straffen|erhöhen|erhoehen|reduzieren|tauschen|umbenennen|vereinheitlichen|vereinfachen|umschreiben|schreiben|übersetzen|uebersetzen|zeichnen|bauen|erstellen|gestalten|färben|faerben|einfärben|aufräumen|aufraeumen|nehmen|verwenden|benutzen|ziehen|rücken|ruecken|schieben|hervorheben|ausblenden|einblenden|tun|umbauen|neu machen';
/** "can you", "kannst du", "bitte": polite requests, even with a question mark. */
const POLITE = new RegExp(words([
  "(?:can|could|would|will|won't|wouldn't|couldn't) (?:you|u|we)", 'would you mind', '(?:is|would) it (?:be )?possible to', '(?:ist|wäre|waere) es möglich', '(?:ist|wäre|waere) es moeglich', "let'?s", 'please', 'pls', 'plz',
  "i(?:'d| would) (?:like|love|prefer)", 'i want', 'i need', 'we need', 'i wish',
  '(?:kannst|könntest|koenntest|würdest|wuerdest|magst|willst) du', '(?:können|koennen|könnten|koennten|würden|wuerden) (?:sie|wir)', 'kann man', 'lass uns', 'lasst uns', 'bitte',
  'ich (?:möchte|moechte|will|hätte gerne?|haette gerne?|brauche|wünsche mir|wuensche mir)', 'wir brauchen',
].join('|')), 'iu');
/** What follows "can you" when the person wants to know something rather than have it done. */
const INFO_VERBS = new RegExp(words("tell|explain|say|describe|clarify|summari[sz]e|remind|check (?:if|whether)|find out|figure out|confirm|let me know|what|why|how|which|sagen|erklären|erklaeren|beschreiben|verraten|nennen|zusammenfassen|warum|wieso|weshalb|welche[rsmn]?"), 'iu');
/** Judgements that ask for a change when said, not asked: "too small", "zu lang", "should be bold". */
const JUDGEMENT = new RegExp(words([
  'too \\p{L}+', 'should (?:be|have|use|look|read|say|go|sit|match|not)', 'shouldn\'t', 'needs? (?:to|more|less|a|an|some)', 'instead', 'rather', 'is (?:wrong|off|broken|cut off|misaligned|too)', "doesn't (?:fit|work|match|look|read)",
  'bigger|smaller|larger|darker|lighter|bolder|wider|narrower|shorter|longer|tighter|looser|higher|lower|brighter|calmer|simpler|cleaner',
  'zu (?:groß|gross|klein|eng|weit|dunkel|hell|lang|kurz|breit|schmal|dick|dünn|duenn|viel|wenig|laut|leise|blass|grell|voll|leer|hoch|tief|nah|knapp|bunt)',
  'sollte|soll|sollten|muss|müsste|muesste|müssen|muessen', 'stattdessen', 'lieber', 'passt nicht', 'ist (?:falsch|kaputt|verrutscht|abgeschnitten|schief)',
  'größer|groesser|grösser|kleiner|dunkler|heller|breiter|schmaler|kürzer|kuerzer|länger|laenger|enger|weiter|fetter|höher|hoeher|tiefer|ruhiger|einfacher|klarer',
].join('|')), 'iu');
// "do" alone opens requests too ("do it"), so it only counts as a question with a subject after it.
const QUESTION_START = new RegExp(`^${words("what|why|how|which|where|who|whom|whose|when|is|are|am|was|were|does|did|doesn't|didn't|has|have|had|can|could|should|would|will|shall|may|might|isn't|aren't|do (?:you|we|i|they|people|users)|don't (?:you|we|i|they)|warum|wieso|weshalb|weswegen|wie|welche[rsmn]?|wo|wer|wem|wen|wann|woher|wohin|womit|wozu|ist|sind|war|hat|hast|haben|gibt|gibt's|gibts|kann|kannst|könnte|koennte|könntest|koenntest|sollte|soll|würde|wuerde|würdest|wuerdest|magst|willst|findest|meinst|siehst|denkst|stimmt")}`, 'iu');
/** Thanks, approval and greetings: none of them asks for anything. */
const ACK = /^(?:(?:ok(?:ay)?|thanks?(?: you)?(?: (?:a lot|so much|very much))?|thx|ty|danke(?: (?:dir|schön|schoen|sehr|euch))?|vielen dank|merci|great|perfect|perfekt|super|nice|cool|passt(?: so)?|top|sieht gut aus|looks (?:good|great|fine)|lgtm|gut|good|alles klar|prima|klasse|toll|genau|yes|yep|ja|nein|no|nope|hey|hi|hallo|moin|yo|servus|well done|gut gemacht|gefällt mir|gefaellt mir|love it|nice work)[ !.]*)+$/iu;
const FILLER = new RegExp(`^(?:${words('ok(?:ay)?|so|and|und|dann|then|now|jetzt|also|hey|hi|please|pls|bitte|noch|mal|just|nur|einfach|aber|but|yes|ja|nun|gern|gerne|hmm+|ah|oh|na')}[ ,]*)+`, 'iu');
const IMPERATIVE = new RegExp(`^${words(IMPERATIVE_EN)}`, 'iu');
/**
 * Imperatives that ask for an answer, not a change: "antworte nur mit dem Text", "tell me which", "erkläre das".
 * Found by `bogen agents check`: "Wie lautet der Text? Antworte nur mit dem Text, und ändere nichts." was nudged.
 */
const ANSWER_VERB = new RegExp(`^${words('answer|reply|respond|tell|explain|describe|list|summari[sz]e|say|antworte|antwortet|antworten|sag|sage|sagt|erkläre|erklaere|erklärt|beschreibe|nenne|liste|zähle|zaehle|fasse|verrate')}`, 'iu');
/** "antworte auf Deutsch und mach es größer": a change after all. */
const AND_CHANGE = new RegExp(`\\s(?:und|and)\\s+(?:${words('dann|then|bitte|please')}\\s+)?${words(IMPERATIVE_EN)}`, 'iu');
/** Telling the agent not to change anything: "ändere nichts", "change nothing", "don't touch it", "nichts ändern", "lass es so". */
const KEEP_AS_IS = new RegExp(`^(?:${words("don'?t|do not|never|nicht|nichts|nothing|no changes?|keine änderungen|keine aenderungen")}|\\S+ ${words('nichts|nothing|not|nicht|kein|keine|keinen|keines')}|${words('lass|lasst|leave|keep')} (?:es|alles|das|it|everything|this|that)(?: \\S+)? ${words('so|alone|as is|unverändert|unveraendert|wie es ist|as it is')})`, 'iu');
const INFINITIVE_END = new RegExp(`${words(INFINITIVE_DE)}[ .!]*$`, 'iu');
const INFINITIVE = new RegExp(words(INFINITIVE_DE), 'iu');

interface Clause { text: string; question: boolean }

/** Clauses with whether each is asked. "warum ist das so klein, mach größer" is a question and then a request. */
function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  for (const sentence of text.split(/(?<=[.!?;\n])/)) {
    const asked = /\?\s*$/.test(sentence);
    const parts = sentence.split(/,|\s(?:and then|und dann|then|dann)\s/i);
    for (const [i, part] of parts.entries()) {
      const clean = part.replace(/[.!?;]+\s*$/, '').trim().replace(FILLER, '').trim();
      if (!clean) continue;
      // Only the clause the question mark ends is asked, unless the clause itself opens like a question.
      out.push({ text: clean, question: (asked && i === parts.length - 1) || QUESTION_START.test(clean) });
    }
  }
  return out;
}

/**
 * Whether a message asks for a change, as against asking for information. A request phrased as a question is a
 * request ("kannst du das größer machen?", "can you tighten this?"); only a question that wants to know something
 * is not ("what font is this?", "kannst du mir erklären, warum?"). Plain statements about a design count as
 * requests, since they were said to an agent that can act on them; thanks and approval do not.
 */
export function asksForChange(message: string): boolean {
  const text = message.replace(/@[\w-]+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return false;
  const parts = clauses(text);
  // What only asks for an answer, or says to leave things as they are, asks for no change.
  const asks = parts.filter((c) => !c.question && !(ANSWER_VERB.test(c.text) && !AND_CHANGE.test(c.text)) && !KEEP_AS_IS.test(c.text));
  for (const c of asks) {
    if (IMPERATIVE.test(c.text) || INFINITIVE_END.test(c.text)) return true;
  }
  const polite = POLITE.exec(text);
  if (polite) {
    // The rest of that sentence. "can you tell me which…", "kannst du mir sagen, welche…" want to know something,
    // unless a change is asked for in the same breath ("kannst du das größer machen und mir sagen, warum").
    const after = text.slice(polite.index + polite[0].length).split(/[?.!]/)[0] ?? '';
    if (!INFO_VERBS.test(after) || INFINITIVE.test(after)) return true;
  }
  for (const c of asks) {
    if (ACK.test(c.text)) continue;
    if (JUDGEMENT.test(c.text)) return true;
    // A plain statement to an agent: "the hero feels heavy". It was said to be acted on.
    if (!polite) return true;
  }
  return false;
}

/** Whether a run that has just ended should be continued once with the nudge. Never a critique, never twice. */
export function needsNudge(run: { request: string; review?: RunReview; live?: boolean; changed: boolean; nudged: boolean }): boolean {
  if (run.nudged || run.changed || run.live || run.review === 'critique') return false;
  return asksForChange(run.request);
}

/** What the continuation is told: everything the run was told, what it said, and the nudge. */
export function nudgePrompt(prompt: string, reply: string): string {
  const said = reply.trim() ? reply.trim().slice(-3000) : '(nothing)';
  return `${prompt}\n\n---\nYou already answered this request once. Your reply was:\n${said}\n\n${NUDGE}`;
}
