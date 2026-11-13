import { createHash } from 'node:crypto';
import { contentLanguageOf, currentBranchId, readCanvasPlan, confirmed, fileKeyframes, type BogenDoc } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import type { RunRequest } from './agents.ts';
import { auditA11y } from './a11y.ts';
import { craftIssues, lintIssues, type LintIssue } from './mcp/lint.ts';
import { responsiveReport } from './mcp/tools-check.ts';
import { discipline, inferDiscipline, KNOWLEDGE_VERSION } from './design-knowledge/index.ts';
import { scoreRubric, type RubricKept, type RubricResult, type RubricScore } from './design-knowledge/rubric.ts';

export const MAX_REPAIR_TURNS = 2;
const MAX_LAYERS = 1600;
const MAX_AUTO_BOARDS = 4;
const MAX_RECORDS = 200;
export interface VisualObservation { criterion: string; verdict: 'pass' | 'needs-work' | 'not-applicable'; evidence: string }
/** `criterion` is the rubric criterion a finding counts against, where it has one. */
/** `hard` is an objective defect that keeps the rubric from counting; `advisory` a choice of taste, with `why`. */
export interface QualityFinding { rule: string; node_id: string; message: string; severity: 'error' | 'warning'; width?: number; criterion?: string; hard?: boolean; advisory?: boolean; why?: string }
export interface QualityReport {
  node_id: string; discipline: string; version: string; fingerprint: string; checkedAt: number;
  automated: { state: 'passed' | 'needs-work' | 'unverified'; findings: QualityFinding[]; total: number; note?: string };
  visual: { state: 'self-assessed' | 'needs-work' | 'missing'; screenshot: boolean; observations: VisualObservation[]; criteria: { id: string; question: string }[] };
  /** The scored self-review, held against the measured findings. Only `scored` counts as done. */
  rubric: RubricResult;
  /** The result is not an accessibility certificate or an independent taste verdict. */
  limitations: string[];
}
export interface FinishCheck { ok: boolean; message: string; retryable?: boolean }

function subtree(doc: BogenDoc, id: string) {
  const root = doc.getNode(id);
  if (!root) throw new Error(`No layer ${id}.`);
  const nodes = [root, ...doc.descendants(id)];
  if (nodes.length > MAX_LAYERS) throw new Error(`This review is limited to ${MAX_LAYERS} layers. Review smaller artboards or sections; the large scope remains unverified.`);
  return nodes;
}
export function reviewFingerprint(doc: BogenDoc, id: string): string {
  return createHash('sha256').update(JSON.stringify({ branch: currentBranchId(doc), nodes: subtree(doc, id), tokens: doc.getTokens(), modes: doc.modes.toJSON(), textStyles: doc.textStyles.toJSON(), variables: doc.variables.toJSON(), language: contentLanguageOf(doc), keyframes: fileKeyframes(doc) })).digest('hex');
}
function rootsOf(doc: BogenDoc, ids: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const id of ids) {
    if (doc.pages.has(id)) {
      for (const child of doc.getChildren(id)) if (child.artboard) roots.add(child.id);
      continue;
    }
    const node = doc.getNode(id);
    if (!node) continue;
    const board = [id, ...doc.ancestors(id)].find((key) => doc.getNode(key)?.artboard);
    if (board) roots.add(board);
  }
  return [...roots];
}

/** Bounded, on-demand review. Nothing polls or loads other files; reading creates no document content. */
export class DesignQuality {
  private reports = new Map<string, QualityReport>();
  private screenshots = new Map<string, string>();
  private initialScreens = new Map<string, Set<string>>();
  beginRun(file: string, run: string, doc: BogenDoc): void {
    this.bounded(this.initialScreens, `${file}:${run}`, new Set(doc.getPages().flatMap(p => doc.getChildren(p.id).filter(n => n.artboard).map(n => n.id))));
  }
  constructor(private readonly app: BogenServer) {}
  private key(file: string, node: string, run?: string) { return `${file}:${run ?? 'external'}:${node}`; }
  private bounded<T>(map: Map<string, T>, key: string, value: T) {
    map.delete(key); map.set(key, value);
    while (map.size > MAX_RECORDS) map.delete(map.keys().next().value!);
  }
  capture(doc: BogenDoc, ids: readonly string[]): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    // A screenshot of one button is not visual evidence for the entire artboard.
    const complete = ids.flatMap((id) => doc.getNode(id)?.artboard ? [id] : doc.pages.has(id) && doc.getChildren(id).filter((n) => n.artboard).length === 1 ? doc.getChildren(id).filter((n) => n.artboard).map((n) => n.id) : []);
    for (const id of complete.slice(0, MAX_AUTO_BOARDS)) {
      try { result.set(id, reviewFingerprint(doc, id)); } catch { /* A large scope is not silently certified. */ }
    }
    return result;
  }
  seen(file: string, doc: BogenDoc, ids: readonly string[], run?: string, captured = this.capture(doc, ids)): void {
    for (const [id, before] of captured) {
      try { if (reviewFingerprint(doc, id) === before) this.bounded(this.screenshots, this.key(file, id, run), before); } catch { /* A changed or removed scope remains unverified. */ }
    }
  }
  forgetRun(run: string): void {
    for (const map of [this.reports, this.screenshots, this.initialScreens]) for (const key of map.keys()) if (key.split(':')[1] === run) map.delete(key);
  }
  async review(file: string, node: string, disciplineId: string, observations: VisualObservation[] = [], run?: string, rubric: RubricScore[] = [], kept: RubricKept[] = []): Promise<QualityReport> {
    const { doc } = await this.app.rooms.get(file);
    const d = discipline(disciplineId);
    const nodes = subtree(doc, node);
    const before = reviewFingerprint(doc, node);
    const findings: QualityFinding[] = [];
    const fromLint = (issue: LintIssue): QualityFinding => ({ rule: issue.rule === 'craft' || issue.check ? `${issue.rule === 'craft' ? 'craft' : 'lint'}:${issue.check ?? issue.rule}` : `lint:${issue.rule}`, node_id: issue.nodeId, message: issue.message, severity: issue.rule === 'contrast' ? 'error' : 'warning', ...(issue.criterion ? { criterion: issue.criterion } : issue.rule === 'copy' ? { criterion: 'content' } : {}), ...(issue.severity === 'hard' ? { hard: true } : {}), ...(issue.severity === 'advisory' || (issue.rule === 'copy' && issue.severity !== 'hard') ? { advisory: true, ...(issue.why ? { why: issue.why } : {}) } : {}) });
    const report: QualityReport = {
      node_id: node, discipline: d.id, version: KNOWLEDGE_VERSION, fingerprint: before, checkedAt: Date.now(),
      automated: { state: 'unverified', findings, total: 0 },
      visual: { state: 'missing', screenshot: false, observations: [], criteria: d.review },
      rubric: scoreRubric([], []),
      limitations: ['Visual observations are the agent’s self-assessment, not independent human approval.', 'Static rendering does not prove native behavior, screen-reader behavior, real email-client support, data truth or complete WCAG conformance.', 'Spacing, aesthetic conventions and intentional two-dimensional overflow require judgement; they are not automatic hard failures.'],
    };
    try {
      const cached = this.reports.get(this.key(file, node, run));
      if (cached?.fingerprint === before && cached.discipline === disciplineId && cached.automated.state !== 'unverified' && cached.automated.total === cached.automated.findings.length) {
        findings.push(...cached.automated.findings);
      } else {
      const brand = await this.app.brands.forRoom(await this.app.rooms.get(file));
      const avoid = brand?.data ? confirmed(brand.data.words).filter((w) => w.use === 'avoid').map((w) => ({ word: w.word, ...(w.instead ? { instead: w.instead } : {}) })) : [];
      for (const issue of await lintIssues(doc, this.app.renderer, { nodeIds: [node] }, nodes, { avoid })) findings.push(fromLint(issue));
      if (d.responsive) {
        const a11y = await auditA11y(doc, this.app.renderer, { nodeId: node });
        for (const layer of a11y.layers) for (const issue of layer.issues) findings.push({ rule: `a11y:${issue.rule}`, node_id: issue.node_id, message: `${issue.message} (${issue.wcag})`, severity: ['name', 'alt', 'focus-visible'].includes(issue.rule) && issue.severity === 'error' ? 'error' : 'warning' });
        const raw = await responsiveReport(doc, this.app.renderer, { node_id: node, widths: [320, 768, 1440] });
        const responsive = JSON.parse(raw.content.find((c) => c.type === 'text')!.text) as { widths: { width: number; clipped_text: { id: string }[]; overflow: { id: string }[] }[] };
        for (const width of responsive.widths) {
          for (const issue of width.clipped_text) findings.push({ rule: 'responsive:clipped-text', node_id: issue.id, message: `Text clips at ${width.width} CSS px. Inspect whether this is intentional truncation with an accessible full value.`, severity: 'warning', width: width.width });
          for (const issue of width.overflow) findings.push({ rule: 'responsive:overflow', node_id: issue.id, message: `Content overflows at ${width.width} CSS px. Inspect the task and any legitimate two-dimensional exception.`, severity: 'warning', width: width.width });
        }
      }
      }
      report.automated.state = findings.some((f) => f.severity === 'error') ? 'needs-work' : 'passed';
    } catch (e) {
      report.automated.state = 'unverified';
      report.automated.note = e instanceof Error ? e.message : String(e);
      // The craft checks read the document only, so they still stand when nothing could be rendered.
      if (!findings.some((f) => f.rule.startsWith('craft:'))) try { findings.push(...craftIssues(doc, nodes).map(fromLint)); } catch { /* The scope stays unverified. */ }
    }
    report.automated.total = findings.length;
    if (findings.length > 100) {
      const errors = findings.filter((f) => f.severity === 'error').length;
      if (errors > 100) report.automated.state = 'unverified';
      report.automated.note = `${findings.length} findings; output limited to 100, errors first. ${errors > 100 ? 'Too many errors for complete verification; narrow the scope.' : 'Every measured error is included; remaining heuristic warnings need visual judgement.'}`;
      findings.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error') || Number(!!b.hard) - Number(!!a.hard) || Number(b.rule.startsWith('craft:')) - Number(a.rule.startsWith('craft:')));
    }
    // Scored against every finding, before the list is cut for output.
    report.rubric = scoreRubric(rubric, findings, report.automated.state !== 'unverified', kept);
    if (findings.length > 100) findings.length = 100;
    if (reviewFingerprint(doc, node) !== before) {
      report.automated.state = 'unverified'; report.automated.note = 'The design changed while it was measured. Read the new state and review again.';
    }
    const screenshot = this.screenshots.get(this.key(file, node, run)) === before;
    const valid = observations.filter((o) => d.review.some((c) => c.id === o.criterion) && o.evidence.trim().length >= 24);
    const complete = d.review.every((c) => valid.filter((o) => o.criterion === c.id).length === 1);
    report.visual = { state: valid.some((o) => o.verdict === 'needs-work') ? 'needs-work' : screenshot && complete ? 'self-assessed' : 'missing', screenshot, observations: valid, criteria: d.review };
    this.bounded(this.reports, this.key(file, node, run), report);
    return report;
  }
  /** The server checks this after a CLI exits; an agent cannot mark its process successful by saying “done”. */
  async beforeFinish(req: RunRequest, run: string, touched: readonly string[]): Promise<FinishCheck> {
    if (req.live || req.review === 'critique') return { ok: true, message: '' };
    const { doc } = await this.app.rooms.get(req.fileId);
    if (req.branch && currentBranchId(doc) !== req.branch.id) return { ok: false, retryable: false, message: 'The design branch changed. Stop and report that the intended branch could not be verified; do not switch or edit someone else’s branch.' };
    const initial = this.initialScreens.get(`${req.fileId}:${run}`);
    const touchedRoots = new Set(rootsOf(doc, touched.filter(id => !doc.pages.has(id))));
    if (initial) for (const page of doc.getPages()) {
      const created = doc.getChildren(page.id).filter(n => n.artboard && !n.hidden && !initial.has(n.id) && touchedRoots.has(n.id));
      if (created.length < 3) continue;
      const plan = readCanvasPlan(doc, page.id);
      const assigned = new Set(plan.sections.flatMap(s => s.lanes.flatMap(l => l.node_ids)));
      const missing = created.filter(n => !assigned.has(n.id));
      if (missing.length || plan.layout_pending) return { ok: false, retryable: true, message: `Canvas organization is incomplete on page ${page.id}. ${missing.length} new screens are unassigned${plan.layout_pending ? '; the planned arrangement is pending' : ''}. Read canvas_plan_get, then canvas_plan_set with a meaningful section title and purpose, named lanes for main paths, states and alternatives, and only genuine flow connections. Inspect measured bounds for hugging screens. Dry-run and apply the arrangement, then inspect the headings and canvas map. Organize only these new screens: ${created.map(n => `${n.id} (${n.name})`).join(', ')}. Preserve unrelated existing organization. A generic grid or an endless row is not a task-based plan.` };
    }
    if (touched.includes('!scope-truncated')) return { ok: false, retryable: false, message: 'More than 2000 changed layer ids were reported. Completion remains unverified; divide the work into smaller scoped requests.' };
    // A run that made no layer changes still reviews its assigned copy, never the protected original or
    // unrelated artboards. Creating an empty page does not invalidate an older page's design review.
    const assigned = req.race ? [req.race.proposalId] : req.revision ? req.revision.artboards.map(a => a.copy)
      : req.intent === 'new_page' ? [] : req.nodeIds?.length ? req.nodeIds : req.pageId ? [req.pageId] : doc.getPages().map(p => p.id);
    const roots = rootsOf(doc, touched.length ? touched : assigned);
    if (!roots.length) return { ok: true, message: 'No surviving visual artboard was changed.' };
    const affected = new Set(touched);
    for (const id of touched) if (doc.getNode(id)) {
      // A change to a container can affect its descendants. Bound the work for large files.
      const children = doc.descendants(id);
      if (children.length > MAX_LAYERS) return { ok: false, retryable: false, message: `Changed scope exceeds ${MAX_LAYERS} layers. Review smaller affected boards; do not rerender the whole file.` };
      for (const child of children) affected.add(child.id);
    }
    const notes: string[] = []; let measured = 0, retryable = true;
    for (const root of roots) {
      let report = this.reports.get(this.key(req.fileId, root, run));
      const fingerprint = reviewFingerprint(doc, root);
      const known = doc.getNode(root)?.attrs?.['data-bogen-discipline'];
      const expected = known ?? inferDiscipline(req.prompt);
      // A clear task/profile cannot be bypassed by asking for an easier medium's checks.
      if (report && expected !== 'foundations' && report.discipline !== expected) report = undefined;
      if (!report || report.fingerprint !== fingerprint) {
        if (measured >= MAX_AUTO_BOARDS) { notes.push(`Review remaining artboard ${root} explicitly; automatic completion checks are limited to ${MAX_AUTO_BOARDS} new boards per pass.`); continue; }
        measured++;
        report = await this.review(req.fileId, root, expected, [], run);
      }
      if (report.automated.state === 'unverified') {
        notes.push(`${root}: unverified: ${report.automated.note ?? 'measurement incomplete'}`);
        if (/sandbox|low on memory|no chromium|failed to launch|browser.*closed/i.test(report.automated.note ?? '')) retryable = false;
      }
      const blocking = report.automated.findings.filter((f) => f.severity === 'error' && (!affected.size || affected.has(f.node_id)));
      for (const issue of blocking.slice(0, 8)) notes.push(`${root}: ${issue.node_id} ${issue.rule}: ${issue.message}`);
      if (report.visual.state !== 'self-assessed') notes.push(`${root}: inspect a fresh canvas_screenshot, then design_verify with discipline ${report.discipline} and evidence for priority, content and context. Current visual state: ${report.visual.state}.`);
      if (report.rubric.state !== 'scored') notes.push(`${root}: the self-review rubric is ${report.rubric.state}. ${report.rubric.next} Pass it as rubric to design_verify, after the last edit.`);
    }
    return { ok: !notes.length, message: notes.slice(0, 20).join('\n'), retryable };
  }
}
