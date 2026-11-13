import { getComplianceMarks, type BogenDoc, type BogenNode, type ComplianceMark } from '@bogen/core';
import { auditA11y } from '../a11y.ts';
import type { Renderer } from '../render.ts';
import { checkWidths } from '../width-check.ts';
import { profile as profileOf, type Criterion, type ProfileId } from './criteria.ts';
import { addA11y, addAxe, addLayers, addProbe, addReflow, collected } from './evidence.ts';
import { layerChecks, statementLink, type LayerFacts } from './layers.ts';
import { legalReminders, type LegalReport } from './legal.ts';
import { AXE_DISABLED, AXE_ENABLED, AXE_TAGS, complianceProbe, PROBE_LIMITS, type ProbeResult } from './probe.ts';
import { judge, judgeProcedure, score, type CriterionResult, type Evidence, type Score } from './score.ts';

export const DISCLAIMER = 'A technical aid, not legal advice, an audit or a certification. It checks a design, not the built product, and many criteria need a person to test them.';
const MAX_BOARDS = 12;
const LAYER_RULES = ['bogen:lang-page', 'bogen:lang-parts', 'bogen:autocomplete', 'bogen:required-label', 'bogen:error-identification', 'bogen:password', 'bogen:tabindex', 'bogen:label-in-name', 'bogen:sticky', 'bogen:endless-motion', 'bogen:duplicate-id', 'bogen:page-title', 'bogen:media'];

export interface ComplianceReport {
  profile: { id: ProfileId; name: string; description: string };
  scope: { page_id: string; page: string; node_id?: string; boards: { id: string; name: string }[]; marks: string };
  checked_at: number;
  engines: { axe: string | null };
  score: Score;
  criteria: CriterionResult[];
  /** WCAG 2.2 criteria the standard behind the law does not contain yet. Not counted. */
  advisory: CriterionResult[];
  /** Duties of the law that are not success criteria. */
  procedures: CriterionResult[];
  /** Findings about criteria beyond the profile, such as AAA. Not counted. */
  beyond: (Evidence & { criterion: string })[];
  facts: LayerFacts;
  not_checked: string[];
  disclaimer: string;
  legal?: LegalReport;
}

let axeSource: { source: string; version: string } | null = null;
async function axe(): Promise<{ source: string; version: string }> {
  if (!axeSource) {
    const mod = (await import('axe-core')).default as unknown as { source: string; version: string };
    axeSource = { source: mod.source, version: mod.version };
  }
  return axeSource;
}

const pxWidth = (n: BogenNode) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec((n.style.width ?? '').trim());
  return m ? Math.round(Number(m[1])) : 1440;
};

export async function complianceCheck(doc: BogenDoc, renderer: Renderer, scope: { pageId: string; nodeId?: string }, profileId: ProfileId, options: { legal?: boolean } = {}): Promise<ComplianceReport> {
  const prof = profileOf(profileId);
  const page = doc.getPages().find((p) => p.id === scope.pageId);
  if (!page) throw new Error(`No page with id ${scope.pageId}.`);
  const allBoards = scope.nodeId ? [scope.nodeId] : doc.getChildren(scope.pageId).filter((n) => !n.hidden).map((n) => n.id);
  const boards = allBoards.slice(0, MAX_BOARDS);
  const notChecked: string[] = [];
  if (allBoards.length > boards.length) notChecked.push(`Only the first ${MAX_BOARDS} of ${allBoards.length} artboards were rendered; check the others one at a time.`);
  const nodes = boards.flatMap((b) => [doc.getNode(b)!, ...doc.descendants(b)]).filter((n) => n && !n.virtual);
  const names = (id: string) => doc.getNode(id)?.name ?? '';
  const c = collected();

  if (boards.length) {
    const audit = await auditA11y(doc, renderer, scope.nodeId ? { nodeId: scope.nodeId } : { pageId: scope.pageId });
    addA11y(c, audit);
    notChecked.push(...audit.not_checked.filter((n) => !/design_lint/.test(n)));
  }
  const { source, version } = await axe();
  const narrow = boards.some((b) => pxWidth(doc.getNode(b)!) <= 480);
  const twoD = (id: string) => [id, ...doc.ancestors(id)].some((a) => {
    const n = doc.getNode(a);
    return Boolean(n && (n.tag === 'table' || /^(auto|scroll)$/.test(n.style.overflowX ?? n.style.overflow ?? '')));
  });
  let axeRan = false;
  for (const b of boards) {
    const node = doc.getNode(b)!;
    const width = pxWidth(node);
    try {
      const [res] = await renderer.atWidths(doc, b, [width], complianceProbe, { source, root: b, tags: AXE_TAGS, disabled: AXE_DISABLED, enabled: AXE_ENABLED, maxNodes: PROBE_LIMITS.maxNodes });
      // The probe is async; the page awaits it, so the result is the value, not a promise.
      const probed = res?.result as unknown as ProbeResult | undefined;
      if (probed) {
        if (probed.axeError) notChecked.push(`axe-core could not run on "${node.name}": ${probed.axeError}`);
        else axeRan = true;
        addAxe(c, probed.axe, names);
        addProbe(c, probed.nonText, probed.spacing, names);
      }
    } catch (e) {
      notChecked.push(`"${node.name}" could not be rendered: ${(e as Error).message}`);
    }
    if (width > 320) {
      try {
        const widths = await checkWidths(doc, renderer, b, width > 640 ? [320, 640] : [320]);
        addReflow(c, b, widths.report.widths, twoD, narrow && width > 480, names);
      } catch (e) {
        notChecked.push(`Reflow of "${node.name}" could not be measured: ${(e as Error).message}`);
      }
    } else {
      c.ran.add('bogen:reflow');
    }
  }
  const layers = layerChecks(doc, boards, nodes);
  addLayers(c, layers.findings, boards.length ? LAYER_RULES : []);

  const marks = getComplianceMarks(doc, scope.pageId);
  const fileMarks = getComplianceMarks(doc, 'file');
  const judgeAll = (list: Criterion[], advisory = false) => list.map((cr) => ({ ...judge(cr, c.by.get(cr.id) ?? [], c.ran, layers.facts, marks[cr.key]), ...(advisory ? { advisory: true } : {}) }));
  const criteria = judgeAll(prof.criteria);
  const advisory = judgeAll(prof.advisory, true);
  const statement = statementLink(doc, nodes);
  const procedures = prof.procedures.map((p) => {
    const ev: Evidence[] = p.rules.includes('bogen:statement-link') ? [statement
      ? { rule: 'bogen:statement-link', outcome: 'pass', node_id: statement.id, layer: statement.name, message: `This page links "${statement.name}", which looks like the accessibility statement or information.` }
      : { rule: 'bogen:statement-link', outcome: 'review', message: 'No link on this page looks like an accessibility statement ("Barrierefreiheit", "Accessibility"). The start page needs one.' }] : [];
    return judgeProcedure(p, ev, fileMarks[p.key] ?? marks[p.key]);
  });
  const inProfile = new Set([...prof.criteria, ...prof.advisory].map((cr) => cr.id));
  const beyond = [...c.by].filter(([id]) => !inProfile.has(id)).flatMap(([id, list]) => list.filter((e) => e.outcome !== 'pass').map((e) => ({ ...e, criterion: id })));
  if (!axeRan && boards.length) notChecked.push('axe-core did not run, so criteria it covers rely on Bogen\'s own checks.');
  notChecked.push('Keyboard use, screen reader output, focus order in the built page, media, and anything that happens over time are tested by a person.');
  return {
    profile: { id: prof.id, name: prof.name, description: prof.description },
    scope: { page_id: scope.pageId, page: page.name, ...(scope.nodeId ? { node_id: scope.nodeId } : {}), boards: boards.map((b) => ({ id: b, name: names(b) })), marks: scope.pageId },
    checked_at: Date.now(),
    engines: { axe: axeRan ? version : null },
    score: score(prof, criteria, procedures),
    criteria, advisory, procedures, beyond, facts: layers.facts, not_checked: notChecked, disclaimer: DISCLAIMER,
    ...(options.legal ? { legal: withMarks(legalReminders(doc, boards, nodes), marks) } : {}),
  };
}

/** A person's marks on legal reminders and checklist items. They are findings to look at, never a block. */
function withMarks(report: LegalReport, marks: Record<string, ComplianceMark>): LegalReport {
  const mark = <T extends { key: string }>(r: T) => (marks[r.key] ? { ...r, mark: marks[r.key] } : r);
  return { ...report, reminders: report.reminders.map(mark), manual: report.manual.map(mark) };
}

/** The report without what an agent does not need to act: passed rules and tests of criteria that passed. */
export function compactReport(r: ComplianceReport): Record<string, unknown> {
  const slim = (c: CriterionResult) => ({ key: c.key, name: c.name, level: c.level, en: c.en, status: c.status, decided_by: c.decided_by, reason: c.reason, ...(c.evidence.length ? { evidence: c.evidence.slice(0, 12) } : {}), ...(c.evidence.length > 12 ? { more: c.evidence.length - 12 } : {}), ...(c.status === 'needs-person' ? { test: c.test } : {}), ...(c.mark ? { mark: c.mark } : {}), ...(c.source ? { source: c.source } : {}) });
  return {
    profile: r.profile, scope: r.scope, score: r.score, engines: r.engines, disclaimer: r.disclaimer,
    failed: r.criteria.filter((c) => c.status === 'failed').map(slim),
    needs_person: r.criteria.filter((c) => c.status === 'needs-person').map(slim),
    passed: r.criteria.filter((c) => c.status === 'passed').map((c) => `${c.id} ${c.name}`),
    not_applicable: r.criteria.filter((c) => c.status === 'not-applicable').map((c) => `${c.id} ${c.name}: ${c.reason}`),
    procedures: r.procedures.map(slim),
    advisory: r.advisory.filter((c) => c.status !== 'passed' && c.status !== 'not-applicable').map(slim),
    beyond: r.beyond.slice(0, 20),
    not_checked: r.not_checked,
    ...(r.legal ? { legal: r.legal } : {}),
  };
}
