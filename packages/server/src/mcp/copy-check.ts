import { previewsSystem, type BogenDoc, type BogenNode } from '@bogen/core';

/**
 * Copy that reads as generated: filler phrases, hype, invented placeholders, glyphs that phones draw as emoji.
 * design_lint reports each as a `copy` issue on the text layer, with the phrase quoted and what to write instead.
 * The lists are short on purpose: each entry is one that an agent writes again and again, and a person never misses.
 */

export interface CopyRule { pattern: RegExp; hint: string }
export interface AvoidWord { word: string; instead?: string }
export interface CopyFinding { nodeId: string; name: string; quote: string; message: string }

const L = '\\p{L}\\p{N}';
const word = (list: string) => new RegExp(`(?<![${L}])(?:${list})(?![${L}])`, 'iu');

/** Hype and filler, in English and German. */
export const COPY_PHRASES: CopyRule[] = [
  { pattern: word('elevates?|elevating|elevated'), hint: 'Say what it does for the customer, such as "cuts setup to ten minutes".' },
  { pattern: word('unlocks?|unlocking|unleash(?:es|ing)?|entfesseln?|entfesselt'), hint: 'Name what the customer can do now that they could not before.' },
  { pattern: word('seamless(?:ly)?|nahtlos(?:e[nmrs]?)?'), hint: 'Say what works together, and how.' },
  { pattern: word('supercharge[sd]?|supercharging|turbocharge[sd]?'), hint: 'Give the concrete gain, with a number only if the file, the brand or the person states it.' },
  { pattern: word('game[- ]?chang(?:er|ers|ing)'), hint: 'Say what changes for the customer, plainly.' },
  { pattern: word('revolutioni[sz](?:e|es|ed|ing)|revolutionary|revolutionär(?:e[nmrs]?)?|revolutioniert|revolutionieren'), hint: 'Describe the actual difference instead of announcing a revolution.' },
  { pattern: word('empower(?:s|ed|ing|ment)?|befähig(?:en|t|e)'), hint: 'Say what the person can do with it.' },
  { pattern: word('next[- ]level|(?:auf )?(?:das |ein )?(?:nächste|naechste|neue)[sn]? level'), hint: 'Say what is better, and by how much if that is known.' },
  { pattern: word("in today'?s fast[- ]paced world|fast[- ]paced world|in der heutigen (?:schnelllebigen|digitalen) welt|schnelllebigen welt"), hint: 'Start with the customer\'s problem instead of the state of the world.' },
  { pattern: /whether you(?:'re| are) [^,.;:!?]{1,40} or /iu, hint: 'Speak to the one reader the page is for.' },
  { pattern: /(?<![\p{L}])(?:egal )?ob (?:du|sie|ihr) [^,.;:!?]{1,40} oder /iu, hint: 'Speak to the one reader the page is for.' },
  { pattern: /not just (?:an? |the )?[^,.;:!?]{1,40}[,;:–—-]+ ?(?:it'?s|it is|but|this is)/iu, hint: 'Say what it is, once.' },
  { pattern: /nicht (?:einfach )?nur (?:ein[e]? )?[^.;:!?]{1,40}[,;–—-]? ?sondern/iu, hint: 'Say what it is, once.' },
  { pattern: word('the future of|die zukunft (?:der|des|von)'), hint: 'Say what it does today.' },
  { pattern: word('cutting[- ]edge|state[- ]of[- ]the[- ]art|best[- ]in[- ]class|world[- ]class|innovative|innovativ(?:e[nmrs]?)?|bahnbrechend(?:e[nmrs]?)?'), hint: 'Replace the claim with the fact behind it.' },
  { pattern: word('effortless(?:ly)?|mühelos(?:e[nmrs]?)?|muehelos'), hint: 'Say which steps it saves.' },
  { pattern: word('harness the power|look no further|say goodbye to|take (?:it|your \\p{L}+) to the next level|we\'ve got you covered|dive (?:in|into)'), hint: 'Cut the phrase and keep the fact.' },
  // Hedging and report language: the page talks about itself instead of to the customer.
  { pattern: word('aims? to|strives? to|is designed to help|are designed to help|may help|might help|can help you|we believe|we think|soll (?:dir|ihnen) helfen|kann (?:dir|ihnen) helfen|zielt darauf ab'), hint: 'A hedge sells nothing. Say what it does, as a fact you can stand behind, or leave the sentence out.' },
  { pattern: word('successfully (?:tested|verified|validated)|all (?:checks|tests) pass(?:ed)?|passes all (?:checks|tests)|has been (?:tested|verified|validated)|erfolgreich (?:getestet|geprüft|verifiziert)|alle (?:tests|prüfungen) bestanden'), hint: 'That is a test report, not a reason to buy. Say what the customer gets from it, such as "works offline on site".' },
  { pattern: word('lorem ipsum|dolor sit amet|consectetur adipiscing'), hint: 'Write real copy from what the file, the brand or the person says.' },
  { pattern: word('john doe|jane doe|max mustermann|erika mustermann|acme(?: corp| inc)?'), hint: 'A placeholder name reads like an invented testimonial or logo. Use a real one the person gave you, or leave it out.' },
];

/** Emoji, and glyphs that phones draw as emoji: arrows, copyright and trademark signs, checks and stars. */
const EMOJI = /[\p{Extended_Pictographic}\u2190-\u21FF\u2713\u2714\u2715\u2716\u2605\u2606\u00A9\u00AE\u2122]/u;
const RULE_OF_THREE = /^(\p{L}+(?: \p{L}+)?)[.,] (\p{L}+(?: \p{L}+)?)[.,] (?:(?:and|und|&) )?(\p{L}+(?: \p{L}+)?)\.?$/iu;
/** A heading cut into fragments of one to three words, such as "No setup. No fees." */
const CHOPPED = /^(?:\p{L}[\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]+){0,2}\. ){1,3}\p{L}[\p{L}\p{N}'’-]*(?: [\p{L}\p{N}'’-]+){0,2}\.$/u;
const HEADING = /^h[1-3]$/;
/** A file name such as unlock.png or a link: a name, not prose, so "unlock" in it is not hype. */
const NAMES = /\b[a-z][a-z0-9+.-]*:\/\/\S+|[\p{L}\p{N}_~-]+(?:\.[\p{L}\p{N}_~-]+)*\.(?=[\p{N}]*\p{L})[\p{L}\p{N}]{1,5}(?![\p{L}\p{N}])/gu;

const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

function glyphHint(glyph: string): string {
  if (glyph === '\u00A9') return 'Write "Copyright" instead, since phones draw the sign as an emoji.';
  if (glyph === '\u00AE' || glyph === '\u2122') return 'Leave the sign out, since phones draw it as an emoji.';
  if (/[\u2190-\u21FF]/u.test(glyph)) return 'Use icon_insert with an arrow icon, or a word, since phones draw the arrow as an emoji.';
  return 'Use icon_insert for an icon, or say it in words.';
}

/** The mark a template puts on what it shows rather than designs; see `exampleKindOf` in core. */
const EXAMPLE_ATTR = 'data-brand-example';

/**
 * Findings in the text layers given, one per phrase and text. `avoid` is the brand's words to avoid, or, for a brand of
 * several languages, those for the language of each layer. With `doc`, a layer's ancestors outside `nodes` count too.
 *
 * What a template marks with data-brand-example is not judged as copy written for the page: a counter-example
 * (`dont`) is wrong on purpose and left out, and in a specimen (`specimen`, such as a typeface's character set) the
 * punctuation and glyphs are on show, so only its words are judged. The same holds for every text of a file that
 * previews a system's screens (an Omarchy theme file), which shows key glyphs, status marks and terminal output as
 * the system shows them. File names and links are names, not prose, so their words are not read as hype.
 */
export function copyIssues(nodes: BogenNode[], avoid: AvoidWord[] | ((node: BogenNode) => AvoidWord[]) = [], context: { doc?: BogenDoc } = {}): CopyFinding[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nodeOf = (id: string) => byId.get(id) ?? context.doc?.getNode(id);
  const marks = new Map<string, Set<string>>();
  /** The data-brand-example marks on a layer and its ancestors. */
  const marksOf = (n: BogenNode): Set<string> => {
    const known = marks.get(n.id);
    if (known) return known;
    const parent = n.parent ? nodeOf(n.parent) : undefined;
    const own = new Set(parent && parent.id !== n.id ? marksOf(parent) : []);
    const mark = n.attrs?.[EXAMPLE_ATTR];
    if (mark) own.add(mark);
    marks.set(n.id, own);
    return own;
  };
  const system = context.doc ? previewsSystem(context.doc) : false;
  const kids = (parent: string) => (context.doc ? context.doc.getChildren(parent) : nodes.filter((c) => c.parent === parent)).filter((c) => !c.hidden);
  const question = (x: BogenNode | undefined, tag: string) => !!x && x.type === 'text' && x.tag === tag && !!x.text?.trim().endsWith('?');
  /**
   * A question heading that is one of a set, each followed by its answer: the questions of an FAQ, set flat (h3, p,
   * h3, p) or one item each. Those are questions a reader asks, not a headline asking one for effect.
   */
  const answered = (h: BogenNode): boolean => {
    const siblings = kids(h.parent);
    const next = siblings[siblings.findIndex((c) => c.id === h.id) + 1];
    if (!next || (next.type === 'text' && /^h[1-6]$/.test(next.tag))) return false;
    if (siblings.some((c) => c.id !== h.id && question(c, h.tag))) return true;
    const item = nodeOf(h.parent);
    return !!item && kids(item.parent).some((other) => other.id !== item.id && kids(other.id).some((c) => question(c, h.tag)));
  };
  const out: CopyFinding[] = [];
  const seen = new Set<string>();
  const add = (n: BogenNode, quote: string, message: string) => {
    // An instance shows its main's words, so the same text is reported once.
    const key = `${quote.toLowerCase()}|${n.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ nodeId: n.id, name: n.name, quote, message });
  };
  const compiled = new Map<AvoidWord[], (AvoidWord & { pattern: RegExp })[]>();
  const wordsFor = (list: AvoidWord[]) => {
    if (!compiled.has(list)) compiled.set(list, list.filter((w) => w.word.trim()).map((w) => ({ ...w, pattern: word(w.word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })));
    return compiled.get(list)!;
  };
  for (const n of nodes) {
    if (n.type !== 'text' || !n.text?.trim()) continue;
    const shown = marksOf(n);
    if (shown.has('dont')) continue;
    // A specimen's and a system's characters are what they show; their words are still read.
    const prose = !shown.has('specimen') && !system;
    const brandWords = wordsFor(typeof avoid === 'function' ? avoid(n) : avoid);
    const text = n.text.replace(/\s+/g, ' ').trim();
    const words = text.replace(NAMES, (m) => ' '.repeat(m.length));
    for (const rule of COPY_PHRASES) {
      const m = rule.pattern.exec(words);
      if (m) add(n, m[0].trim(), `The text says "${m[0].trim()}", which reads as filler. ${rule.hint}`);
    }
    for (const w of brandWords) {
      const m = w.pattern.exec(words);
      if (m) add(n, m[0], `The text says "${m[0]}", which the brand avoids. ${w.instead ? `Say "${w.instead}".` : 'Rewrite the sentence without it.'}`);
    }
    if (!prose) continue;
    const glyph = EMOJI.exec(text);
    if (glyph) add(n, glyph[0], `The text has "${glyph[0]}". ${glyphHint(glyph[0])}`);
    if (text.includes('!')) add(n, '!', `"${short(text)}" has an exclamation mark. Drop it and let the claim stand on its own.`);
    if (HEADING.test(n.tag) && text.endsWith('?')) {
      if (!answered(n)) add(n, text, `The heading "${short(text)}" is a rhetorical question. State the answer instead.`);
    }
    else if (HEADING.test(n.tag) && CHOPPED.test(text) && !RULE_OF_THREE.test(text)) add(n, text, `The heading "${short(text)}" is chopped into fragments. Write one sentence that says what the customer gets.`);
    if (RULE_OF_THREE.test(text)) add(n, text, `"${short(text)}" is three short claims in a row. Keep the one that matters most and back it with a fact.`);
  }
  return out;
}
