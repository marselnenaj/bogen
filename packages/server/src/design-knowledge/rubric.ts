import type { CraftCriterion } from '@bogen/core';

/**
 * The self-review an agent scores before it reports work as done. One rubric for every discipline, so that scores can
 * be compared across runs. A score is the agent's own judgement from a screenshot, never a person's approval; the
 * measured checks hold it to account (see `scoreRubric`).
 */
export interface RubricCriterion { id: CraftCriterion; question: string; five: string; two: string }
export interface RubricScore { criterion: string; score: number; evidence: string }

export const RUBRIC: readonly RubricCriterion[] = [
  { id: 'hierarchy', question: 'Does one message and one primary action lead each screen?', five: 'Blurred, one thing still leads; a long page has two or three loud peaks with quiet stretches between.', two: 'Several things are equally loud; the eye has no first place to land.' },
  { id: 'type', question: 'Is the type designed, or only big?', five: 'At most two families, every size from the declared scale, large type with tightened tracking, leading and chosen line breaks.', two: 'Sizes off the scale, or monospace, capitals and small labels as decoration.' },
  { id: 'spacing', question: 'Does spacing show the structure?', five: 'One spacing scale; related things sit closer than unrelated ones; the gap between sections is at least twice the gap inside them.', two: 'Gaps differ without reason, or everything is equally far apart.' },
  { id: 'colour', question: 'Does colour carry meaning and stay readable?', five: 'Neutrals and one accent, the accent kept for what matters; all text passes contrast, over imagery too.', two: 'Several accents, a default gradient, or text that is hard to read.' },
  { id: 'content', question: 'Would the customer care about these words, and are they true?', five: 'Specific copy from the customer\'s side; every number, name and quote comes from the brief, the file or the brand.', two: 'Filler, hedging, report language, placeholders or a claim nobody supplied.' },
  { id: 'craft', question: 'Does anything look unfinished at the size it is really seen?', five: 'Nothing clipped or covered, edges aligned, no text too small where it is seen, narrow widths and long content checked.', two: 'Cut-off elements, uneven edges, text over a picture without a scrim, or tiny text.' },
  { id: 'originality', question: 'Could this only be for this subject?', five: 'A stated idea taken from the subject; with the name swapped it would no longer fit another product.', two: 'A default look: grotesk plus mono, cards and glow, or the beige and serif overcorrection.' },
  { id: 'fit', question: 'Does the whole deliverable answer the brief?', five: 'Audience, brand and medium are met; the real product or material is shown; every screen holds up, not only the first; the set shows range.', two: 'A striking first screen over a thin rest, one layout repeated, or no real product in sight.' },
];
export const RUBRIC_IDS = RUBRIC.map((c) => c.id) as [CraftCriterion, ...CraftCriterion[]];
export const RUBRIC_MAX = RUBRIC.length * 5;
/** A score at or under this fails the criterion. */
export const RUBRIC_FAIL = 2;
/** With measured findings open against a criterion, it cannot be scored above this. */
export const RUBRIC_CAP = 3;
/** Under this total the work is adequate rather than strong, which calls for another pass or a second direction. */
export const RUBRIC_STRONG = 32;
export const RUBRIC_MIN_EVIDENCE = 24;

/** The lint rules that count against a criterion. Craft findings carry their own. */
const LINT_CRITERION: Record<string, CraftCriterion> = {
  'lint:hierarchy': 'hierarchy', 'lint:spacing': 'spacing', 'lint:grid': 'spacing', 'lint:contrast': 'colour', 'lint:copy': 'content',
  'lint:overflow': 'craft', 'lint:small-text': 'craft', 'lint:target': 'craft', 'lint:alt': 'craft',
};
export function criterionOf(finding: { rule: string; criterion?: string }): CraftCriterion | undefined {
  return (RUBRIC_IDS as string[]).includes(finding.criterion ?? '') ? finding.criterion as CraftCriterion : LINT_CRITERION[finding.rule];
}

export interface RubricResult {
  /** `scored` is the only state that counts as a finished self-review. */
  state: 'missing' | 'incomplete' | 'needs-work' | 'capped' | 'scored';
  total: number; max: number;
  scores: RubricScore[];
  /** Criteria still to score, with their questions and anchors. */
  open: RubricCriterion[];
  /** Criteria scored higher than the measured findings against them allow. */
  capped: { criterion: string; score: number; findings: number; example: string }[];
  next: string;
}

/**
 * Holds the scores against the rules: all eight criteria, one score each with evidence; nothing at 2 or under; and
 * nothing above 3 on a criterion that measured findings count against. The last is what keeps a self-score honest.
 */
export function scoreRubric(scores: readonly RubricScore[], findings: readonly { rule: string; criterion?: string; message: string }[], measured = true): RubricResult {
  const valid = RUBRIC.flatMap((c) => {
    const given = scores.filter((s) => s.criterion === c.id && Number.isInteger(s.score) && s.score >= 1 && s.score <= 5 && s.evidence.trim().length >= RUBRIC_MIN_EVIDENCE);
    return given.length === 1 ? [given[0]!] : [];
  });
  const open = RUBRIC.filter((c) => !valid.some((s) => s.criterion === c.id));
  const total = valid.reduce((sum, s) => sum + s.score, 0);
  const against = new Map<string, string[]>();
  for (const f of findings) {
    const c = criterionOf(f);
    if (c) against.set(c, [...(against.get(c) ?? []), f.message]);
  }
  const capped = valid.filter((s) => s.score > RUBRIC_CAP && against.has(s.criterion)).map((s) => ({ criterion: s.criterion, score: s.score, findings: against.get(s.criterion)!.length, example: against.get(s.criterion)![0]!.slice(0, 200) }));
  const failed = valid.filter((s) => s.score <= RUBRIC_FAIL);
  const lowest = [...valid].sort((a, b) => a.score - b.score).slice(0, 2).map((s) => `${s.criterion} (${s.score})`).join(' and ');
  const state: RubricResult['state'] = !valid.length ? 'missing' : open.length ? 'incomplete' : failed.length ? 'needs-work' : capped.length ? 'capped' : 'scored';
  const next = state === 'missing' || state === 'incomplete' ? `Score ${open.map((c) => c.id).join(', ')} from 1 to 5, each once, with what you see in the screenshot as evidence (${RUBRIC_MIN_EVIDENCE} characters or more).`
    : state === 'needs-work' ? `Fix ${failed.map((s) => s.criterion).join(', ')}: a score of ${RUBRIC_FAIL} or lower is not finished work. Then take a fresh screenshot and score again.`
    : state === 'capped' ? `Measured findings stand against ${capped.map((c) => c.criterion).join(', ')}, so a score above ${RUBRIC_CAP} does not hold. Fix those findings, or score ${RUBRIC_CAP} or lower and name the exception in the evidence.`
    : total < RUBRIC_STRONG ? `${total} of ${RUBRIC_MAX}: adequate, not strong. Improve ${lowest}, or build a second direction with proposal_create and compare the two screenshots, before you report. Report the scores either way.`
    : `${total} of ${RUBRIC_MAX}. Report the scores with the lowest criterion and what is still open.${measured ? '' : ' The measured checks did not run, so nothing held these scores to account: say so.'}`;
  return { state, total, max: RUBRIC_MAX, scores: valid, open, capped, next };
}

/** The rubric as the compact text a skill or guide carries. */
export function rubricText(): string {
  return RUBRIC.map((c) => `- ${c.id}: ${c.question} 5: ${c.five} 2: ${c.two}`).join('\n');
}
