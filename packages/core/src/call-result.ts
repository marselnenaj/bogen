/**
 * What a call does with the end of a run. The agent writes its whole answer into the chat and a short `<say>` block
 * for the voice. The voice says the result itself (what changed, or what a review found), never only what the agent did
 * not do ("I left the design as it was"), and it keeps the whole answer to go on from when the person asks for the
 * rest. Found in a call: a review ended with "That was a review, so I left the design as it was", the voice then knew
 * only the start of the review, said "the rest got cut off for me" and asked the agent again.
 */

/** How much of a run's answer the call keeps for follow-ups. */
export const RESULT_MAX = 8000;

/** The note the server writes into a run it continued once because it changed nothing. */
const NUDGE_NOTE = /Bogen: nothing was changed, so it was asked once more[^\n]*/;

/**
 * A sentence that only says what the agent did not do, or why: no news for the person, who asked for the result.
 * "That was a review, so I left the design as it was.", "I changed nothing.", "Ich habe nichts geändert."
 */
const META = /\b(?:left (?:the design|it|everything|the file|the page|the screens?|things)(?: \w+){0,2} (?:as (?:it|they) (?:was|were|is|are)|unchanged|untouched|alone)|(?:changed|touched|edited) nothing|(?:did not|didn't|have not|haven't) (?:change|touch|edit)(?:d)? (?:anything|the design|it)|without changing anything|nothing (?:was|has been) changed|only (?:asked|wanted) (?:for )?(?:a|my|the)? ?(?:review|opinion|look|answer|rest)|(?:habe|hab) (?:nichts|das design nicht|es nicht) (?:geändert|angefasst|verändert)|(?:unverändert|so) gelassen|nichts geändert)\b/i;

/** Whether a sentence only says what the agent left alone. */
export function isMetaSentence(sentence: string): boolean {
  return META.test(sentence);
}

function sentencesOf(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"„])/u).map((s) => s.trim()).filter(Boolean);
}

/** A spoken block without its sentences about what was left alone. */
export function withoutMeta(text: string): string {
  return sentencesOf(text).filter((s) => !isMetaSentence(s)).join(' ').trim();
}

/** Whether the first sentence of a block says only what was left alone. */
function metaLed(text: string): boolean {
  const first = sentencesOf(text)[0];
  return Boolean(first && isMetaSentence(first));
}

/**
 * The agent's words for the voice, from the `<say>` blocks of a run: the last one with news in it, without its
 * sentences about what it left alone. A run the server continued once ("nothing was changed") that again changed
 * nothing said its result before the continuation, so that block is the one. `metaLed`: the block chosen opened with
 * such a sentence, so the agent did not lead with the result and the talking layer should say it from the whole answer.
 */
export function resultSay(text: string): { line: string; metaLed: boolean } | null {
  const blocks = [...text.matchAll(/<say>([\s\S]*?)<\/say>/gi)].map((m) => ({ at: m.index ?? 0, text: (m[1] ?? '').trim() })).filter((b) => b.text);
  if (!blocks.length) return null;
  const nudge = text.search(NUDGE_NOTE);
  if (nudge >= 0) {
    const after = blocks.filter((b) => b.at > nudge);
    const before = blocks.filter((b) => b.at < nudge);
    const last = after.at(-1);
    const earlier = before.at(-1);
    if (earlier && withoutMeta(earlier.text) && (!last || metaLed(last.text) || !withoutMeta(last.text))) {
      return { line: withoutMeta(earlier.text), metaLed: metaLed(earlier.text) };
    }
  }
  for (const b of [...blocks].reverse()) {
    const line = withoutMeta(b.text);
    if (line) return { line, metaLed: metaLed(b.text) };
  }
  return null;
}

/** A run's answer as the call keeps it: the say blocks and the server's note out, within `RESULT_MAX`. */
export function resultText(text: string): string {
  const clean = text.replace(/<say>[\s\S]*?<\/say>/gi, ' ').replace(new RegExp(NUDGE_NOTE.source, 'g'), ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const kept = clean || text.replace(/<\/?say>/gi, '').trim();
  // The end holds the answer; a long run's first words are its plans.
  return kept.length > RESULT_MAX ? kept.slice(-RESULT_MAX) : kept;
}

const ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|#{1,4})\s+/;
const MARKDOWN = /\*\*|__|`|^#+\s*/g;

/**
 * The points of a run's answer, in order, for telling them a few at a time: its list items when it wrote a list
 * (with the line before a list as the gist), else its sentences. Sentences about what it left alone are not points.
 */
export function resultPoints(text: string, max = 14): string[] {
  const body = resultText(text);
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => ITEM.test(l));
  const raw = items.length >= 2
    ? [...lines.filter((l, i) => !ITEM.test(l) && i < lines.findIndex((x) => ITEM.test(x))).slice(-1), ...items]
    : sentencesOf(lines.join(' '));
  const out: string[] = [];
  for (const r of raw) {
    const p = r.replace(ITEM, '').replace(MARKDOWN, '').replace(/\s+/g, ' ').trim();
    if (!p || isMetaSentence(p) || !/[\p{L}]{3}/u.test(p)) continue;
    // A heading line ending in a colon introduces the list; it is not news of its own.
    if (/:$/.test(p) && p.split(' ').length <= 6) continue;
    out.push(p.length > 320 ? `${p.slice(0, 319)}…` : p);
    if (out.length >= max) break;
  }
  return out;
}

const SMALL = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'are', 'was', 'its', 'it', 'is', 'of', 'to', 'in', 'on', 'a', 'an', 'der', 'die', 'das', 'und', 'mit', 'ist', 'ein', 'eine', 'den', 'dem', 'auf', 'zu', 'im', 'von', 'your', 'you', 'they', 'their', 'there', 'when', 'while', 'from', 'has', 'have', 'but', 'not']);

function stems(text: string): string[] {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !SMALL.has(w)).map((w) => w.slice(0, 6));
}

/** Whether a spoken line tells a point: most of the point's meaning words are in it. */
export function tells(spoken: string, point: string): boolean {
  const said = new Set(stems(spoken));
  const words = [...new Set(stems(point))];
  if (!words.length || !said.size) return false;
  const shared = words.filter((w) => said.has(w)).length;
  return shared >= Math.min(3, words.length) && shared / words.length >= (words.length > 10 ? 0.3 : 0.34);
}

/**
 * The person asks for more of what the agent said: "what about the rest?", "what else did it say?", "go on",
 * "und der Rest?", "was noch?". Not a request for more work ("do the rest" is work, and the caller checks that).
 */
export const ASKS_REST = /\b(?:the rest|rest of (?:it|that|the (?:review|list|points|answer))|what else|anything else (?:it|he|she) (?:said|found|suggested|mentioned)|other (?:points|things|suggestions|findings)|more (?:points|details|of (?:it|that|the review))|tell me more|go on|keep going|carry on|and then|next (?:one|point)|der rest|den rest|vom rest|was noch|was sonst noch|was hat (?:er|es|der agent) noch|noch was|weitere(?:n)? punkte|mehr davon|erzähl (?:mir )?mehr|erzähl weiter|mach weiter mit (?:dem|den) (?:rest|punkten)|und weiter|weiter bitte|nächste(?:r|n)? punkt)\b/i;
