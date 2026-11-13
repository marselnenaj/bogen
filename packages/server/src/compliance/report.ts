import { BogenDoc, importHtml } from '@bogen/core';
import * as Y from 'yjs';
import { exportTarget } from '../exporter.ts';
import type { Renderer } from '../render.ts';
import type { Storage } from '../storage.ts';
import type { ComplianceReport } from './run.ts';
import type { CriterionResult } from './score.ts';
import type { StatementDraft } from './statement.ts';

/**
 * The check as a document to keep or pass on: status and numbers first, then what failed with its layers and fixes,
 * what a person has to test with their marks, what passed and what does not apply, the duties of the law, legal
 * reminders, and the statement draft. It becomes layers of a temporary file and leaves through the same HTML and PDF
 * export as any design.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS: Record<CriterionResult['status'], string> = { failed: 'Failed', passed: 'Passed', 'not-applicable': 'Not applicable', 'needs-person': 'Needs a person' };
const OVERALL = { fails: 'Does not meet the profile', incomplete: 'Not decided yet', 'all-criteria-met': 'All criteria met as checked' } as const;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function criterionBlock(c: CriterionResult): string {
  const label = `${c.id} ${c.name}${c.level ? ` (${c.level})` : ''}${c.en ? ` · EN 301 549 ${c.en}` : ''}`;
  const ev = c.evidence.slice(0, 15).map((e) => `<li>${e.layer ? `<strong>${esc(e.layer)}</strong>: ` : ''}${esc(e.message)}${e.fix ? ` <em>Fix: ${esc(e.fix)}</em>` : ''}</li>`).join('');
  const mark = c.mark ? `<p class="mark">${esc(STATUS[c.mark.result === 'pass' ? 'passed' : c.mark.result === 'fail' ? 'failed' : 'not-applicable'])}, marked by ${esc(c.mark.by)} on ${day(c.mark.at)}${c.mark.note ? `: "${esc(c.mark.note)}"` : ''}</p>` : '';
  return `<section class="criterion"><h3>${esc(label)}</h3><p class="reason">${esc(STATUS[c.status])}. ${esc(c.reason)}</p>${ev ? `<ul>${ev}</ul>` : ''}${c.evidence.length > 15 ? `<p>And ${c.evidence.length - 15} more.</p>` : ''}${c.status === 'needs-person' ? `<p class="test">Test: ${esc(c.test)}</p>` : ''}${c.source ? `<p class="source">Source: ${esc(c.source)}</p>` : ''}${mark}</section>`;
}

export function reportBody(r: ComplianceReport, statement?: StatementDraft): string {
  const s = r.score;
  const by = (status: CriterionResult['status']) => r.criteria.filter((c) => c.status === status);
  const rate = s.automated.pass_rate === null ? 'none decided' : `${s.automated.passed} of ${s.automated.decided} (${s.automated.pass_rate} %)`;
  const list = (items: CriterionResult[]) => items.length ? `<ul>${items.map((c) => `<li>${esc(`${c.id} ${c.name}`)}${c.level ? ` (${c.level})` : ''}: ${esc(c.reason)}</li>`).join('')}</ul>` : '<p>None.</p>';
  const legal = r.legal ? `<h2>Legal reminders</h2><p>${esc(r.legal.disclaimer)}</p><ul>${r.legal.reminders.map((m) => `<li><strong>${esc(m.topic)}</strong> (${m.state === 'found' ? 'found' : m.state === 'look' ? 'look at this' : 'note'})${m.layer ? `, ${esc(m.layer)}` : ''}: ${esc(m.message)} <span class="source">Source: ${esc(m.source)}</span></li>`).join('')}</ul><h3>For a person to check</h3><ul>${r.legal.manual.map((m) => `<li><strong>${esc(m.topic)}</strong>: ${esc(m.test)} <span class="source">Source: ${esc(m.source)}</span></li>`).join('')}</ul>` : '';
  return `<style>
.report { width: 840px; padding: 48px; background: #ffffff; color: #1d1d1c; font-family: system-ui, Arial, sans-serif; font-size: 15px; line-height: 1.5; display: flex; flex-direction: column; gap: 10px; }
.report h1 { font-size: 28px; line-height: 1.2; margin: 0; }
.report h2 { font-size: 20px; margin: 24px 0 4px; border-top: 1px solid #c9c6bb; padding-top: 16px; }
.report h3 { font-size: 16px; margin: 0; }
.report p, .report ul { margin: 0; }
.report .meta, .report .source, .report .test, .report .reason { color: #5f5d55; }
.report .status { font-size: 20px; font-weight: 600; }
.report .numbers { display: flex; gap: 32px; }
.report .criterion { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px solid #ebe8df; }
.report .mark { color: #1b27a8; }
.report .statement { display: flex; flex-direction: column; gap: 8px; padding: 24px; background: #f4f2ec; }
.report mark { background: #ffe08a; color: #1d1d1c; }
</style><article class="report" lang="en">
<h1>${esc(`Accessibility check: ${r.scope.page}`)}</h1>
<p class="meta">${esc(`${r.profile.name}. Checked ${day(r.checked_at)} by Bogen${r.engines.axe ? ` with axe-core ${r.engines.axe}` : ''}. ${r.scope.boards.length} artboard${r.scope.boards.length === 1 ? '' : 's'}: ${r.scope.boards.map((b) => b.name).join(', ')}.`)}</p>
<p class="meta">${esc(r.disclaimer)}</p>
<p class="status">${esc(OVERALL[s.overall])}</p>
<p>${esc(s.summary)}</p>
<div class="numbers"><p><strong>${s.counts.failed}</strong> failed</p><p><strong>${s.counts.passed}</strong> passed</p><p><strong>${s.counts.not_applicable}</strong> not applicable</p><p><strong>${s.counts.needs_person}</strong> need a person</p></div>
<p>${esc(`Automated pass rate: ${rate} of the criteria the checks decided. Marked by a person: ${s.person.marked}${s.person.by.length ? ` (${s.person.by.join(', ')})` : ''}.`)}</p>
<h2>Failed</h2>${by('failed').map(criterionBlock).join('') || '<p>None.</p>'}
<h2>Needs a person</h2>${by('needs-person').map(criterionBlock).join('') || '<p>None.</p>'}
${r.procedures.length ? `<h2>Duties of the law</h2>${r.procedures.map(criterionBlock).join('')}` : ''}
<h2>Passed</h2>${list(by('passed'))}
<h2>Not applicable</h2>${list(by('not-applicable'))}
${r.advisory.length ? `<h2>WCAG 2.2 additions (advice)</h2><p>Not in EN 301 549 V3.2.1, the version cited in the Official Journal; in V4.1.1 (2026-09). Not counted.</p>${r.advisory.map(criterionBlock).join('')}` : ''}
${r.beyond.length ? `<h2>Beyond the profile</h2><ul>${r.beyond.slice(0, 20).map((b) => `<li>${esc(`${b.criterion}: ${b.layer ? `${b.layer}: ` : ''}${b.message}`)}</li>`).join('')}</ul>` : ''}
<h2>Not checked</h2><ul>${r.not_checked.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
${legal}
${statement ? `<h2>Draft statement</h2>${statement.html}` : ''}
</article>`;
}

/** The report as a standalone HTML page or a PDF, through Bogen's own export. */
export async function exportReport(r: ComplianceReport, renderer: Renderer, storage: Storage, format: 'html' | 'pdf', statement?: StatementDraft): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const doc = new BogenDoc(new Y.Doc());
  try {
    doc.ensureFirstPage('Report');
    const pageId = doc.getPages()[0]!.id;
    const { nodes } = importHtml(reportBody(r, statement));
    const root = nodes[0];
    if (!root) throw new Error('The report came out empty.');
    root.style = { ...root.style, position: 'absolute', left: '0px', top: '0px' };
    root.name = `Accessibility check: ${r.scope.page}`;
    const rootId = doc.insert(pageId, root);
    const out = await exportTarget(doc, renderer, storage, { nodeIds: [rootId] }, format);
    return { bytes: out.bytes, mime: out.mime, ext: out.ext };
  } finally {
    doc.y.destroy();
  }
}
