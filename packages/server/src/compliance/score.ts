import type { ComplianceMark } from '@bogen/core';
import type { Criterion, Procedure, Profile } from './criteria.ts';
import type { LayerFacts } from './layers.ts';

/**
 * How a check becomes a result, criterion by criterion, and the result a score. The rules, in order:
 *
 * 1. A failure found by a check fails the criterion. A person's mark does not lift it: fix the design, then check again.
 * 2. Otherwise a person's mark decides: pass, fail or not applicable, with their name and the date.
 * 3. Otherwise a criterion Bogen checks itself (`auto`) passes when its checks ran and found nothing to look at.
 * 4. Otherwise a criterion about content the design does not have (video, sound, forms, time limits) does not apply.
 * 5. Everything else needs a person, including every `partial` criterion whose checks found nothing.
 *
 * The overall status never says conformant while anything failed or is unchecked. The automated pass rate counts only
 * what the checks decided, and is reported next to the status, not instead of it.
 */

export type Status = 'failed' | 'passed' | 'not-applicable' | 'needs-person';
export type DecidedBy = 'check' | 'person' | 'design' | null;

export interface Evidence {
  /** `axe:color-contrast`, `a11y:alt`, `bogen:reflow`. */
  rule: string;
  outcome: 'fail' | 'review' | 'pass';
  node_id?: string;
  layer?: string;
  message: string;
  fix?: string;
  help_url?: string;
}

export interface CriterionResult {
  key: string;
  id: string;
  name: string;
  level: Criterion['level'] | null;
  en: string | null;
  since: Criterion['since'] | null;
  coverage: Criterion['coverage'];
  status: Status;
  decided_by: DecidedBy;
  /** Why, in one sentence. */
  reason: string;
  /** Failures and things to look at, per layer. */
  evidence: Evidence[];
  /** Rules that ran and found nothing wrong. */
  passed_rules: string[];
  test: string;
  mark?: ComplianceMark;
  advisory?: boolean;
  source?: string;
}

export type Overall = 'fails' | 'incomplete' | 'all-criteria-met';

export interface Score {
  overall: Overall;
  summary: string;
  counts: { failed: number; passed: number; not_applicable: number; needs_person: number; total: number };
  automated: { passed: number; failed: number; decided: number; pass_rate: number | null; partial_clean: number };
  person: { marked: number; open: number; by: string[] };
  procedures: { open: number; failed: number; total: number };
}

const NEEDS_NONE: Record<NonNullable<Criterion['needs']>, (f: LayerFacts) => boolean> = {
  media: (f) => f.media === 0,
  audio: (f) => f.media === 0 && f.audio === 0,
  forms: (f) => f.fields === 0,
  time: (f) => f.timed === 0,
  motion: (f) => f.moving === 0,
};
const NONE_REASON: Record<NonNullable<Criterion['needs']>, string> = {
  media: 'The design has no video or audio.',
  audio: 'The design has no sound.',
  forms: 'The design has no form fields.',
  time: 'The design has no time limit.',
  motion: 'Nothing in the design moves by itself.',
};

export function judge(c: Criterion, evidence: Evidence[], ran: Set<string>, facts: LayerFacts, mark: ComplianceMark | undefined): CriterionResult {
  const fails = evidence.filter((e) => e.outcome === 'fail');
  const reviews = evidence.filter((e) => e.outcome === 'review');
  const passed = [...new Set(evidence.filter((e) => e.outcome === 'pass').map((e) => e.rule))];
  const base = { key: c.key, id: c.id, name: c.name, level: c.level, en: c.en, since: c.since, coverage: c.coverage, evidence: [...fails, ...reviews], passed_rules: passed, test: c.test, ...(mark ? { mark } : {}) };
  if (fails.length) return { ...base, status: 'failed', decided_by: 'check', reason: `${fails.length === 1 ? 'A check found a failure' : `Checks found ${fails.length} failures`}${mark?.result === 'pass' ? '; a person marked it as passing, but the finding stands until the design changes' : ''}.` };
  if (mark) return { ...base, status: mark.result === 'pass' ? 'passed' : mark.result === 'fail' ? 'failed' : 'not-applicable', decided_by: 'person', reason: `Marked by ${mark.by}.` };
  const checked = c.rules.some((r) => ran.has(r) || (r === 'axe' && ran.has(`axe@${c.id}`)));
  if (c.coverage === 'auto' && checked && !reviews.length) return { ...base, status: 'passed', decided_by: 'check', reason: 'Bogen\'s checks of this criterion found nothing.' };
  if (c.needs && NEEDS_NONE[c.needs](facts) && !reviews.length) return { ...base, status: 'not-applicable', decided_by: 'design', reason: NONE_REASON[c.needs] };
  const why = c.coverage === 'manual' ? 'Only a person can test this.' : reviews.length ? `${reviews.length === 1 ? 'One thing' : `${reviews.length} things`} to look at; then mark it.` : checked ? 'Bogen\'s checks found nothing, which is not a pass: a person decides.' : 'Bogen could not check it here; a person decides.';
  return { ...base, status: 'needs-person', decided_by: null, reason: why };
}

export function judgeProcedure(p: Procedure, evidence: Evidence[], mark: ComplianceMark | undefined): CriterionResult {
  const base = { key: p.key, id: p.key.slice(5), name: p.name, level: null, en: null, since: null, coverage: 'manual' as const, evidence, passed_rules: [], test: p.test, source: p.source, ...(mark ? { mark } : {}) };
  if (mark) return { ...base, status: mark.result === 'pass' ? 'passed' : mark.result === 'fail' ? 'failed' : 'not-applicable', decided_by: 'person', reason: `Marked by ${mark.by}.` };
  return { ...base, status: 'needs-person', decided_by: null, reason: 'A duty of the law that a person confirms.' };
}

export function score(profile: Profile, criteria: CriterionResult[], procedures: CriterionResult[]): Score {
  const counted = criteria.filter((c) => !c.advisory);
  const n = (s: Status) => counted.filter((c) => c.status === s).length;
  const counts = { failed: n('failed'), passed: n('passed'), not_applicable: n('not-applicable'), needs_person: n('needs-person'), total: counted.length };
  const autoPassed = counted.filter((c) => c.status === 'passed' && c.decided_by === 'check').length;
  const autoFailed = counted.filter((c) => c.status === 'failed' && c.decided_by === 'check').length;
  const decided = autoPassed + autoFailed;
  const partialClean = counted.filter((c) => c.status === 'needs-person' && c.coverage !== 'manual' && !c.evidence.length && c.passed_rules.length).length;
  const marks = [...counted, ...procedures].filter((c) => c.decided_by === 'person');
  const procOpen = procedures.filter((p) => p.status === 'needs-person').length;
  const procFailed = procedures.filter((p) => p.status === 'failed').length;
  const overall: Overall = counts.failed || procFailed ? 'fails' : counts.needs_person || procOpen ? 'incomplete' : 'all-criteria-met';
  const open = counts.needs_person + procOpen;
  const summary = overall === 'fails'
    ? `Does not meet ${profile.name}: ${counts.failed + procFailed} ${counts.failed + procFailed === 1 ? 'criterion fails' : 'criteria fail'}${open ? `, and ${open} still ${open === 1 ? 'needs' : 'need'} a person` : ''}.`
    : overall === 'incomplete'
      ? `Not decided: nothing failed the checks, and ${open} ${open === 1 ? 'criterion needs' : 'criteria need'} a person before anything can be said about ${profile.name}.`
      : `Every criterion of ${profile.name} passed or does not apply, by Bogen's checks and the marks of ${[...new Set(marks.map((m) => m.mark!.by))].join(', ') || 'nobody'}. This records checks of a design; it is not a certification or legal advice.`;
  return {
    overall, summary, counts,
    automated: { passed: autoPassed, failed: autoFailed, decided, pass_rate: decided ? Math.round((autoPassed / decided) * 1000) / 10 : null, partial_clean: partialClean },
    person: { marked: marks.length, open, by: [...new Set(marks.map((m) => m.mark!.by))] },
    procedures: { open: procOpen, failed: procFailed, total: procedures.length },
  };
}
