import { getChecks, resolveCheck, kebabCss, type BogenDoc, type CheckRule } from '@bogen/core';
import type { Renderer } from './render.ts';
import { auditA11y } from './a11y.ts';
import { lintIssues, lintReport } from './mcp/lint.ts';
import { responsiveReport } from './mcp/tools-check.ts';

export interface CheckFinding { rule: string; id: string; message: string; severity: 'warning' | 'error'; width?: number; actual?: string | number | null; expected?: string | number }
/** Executes only declarative assertions against the rendered subtree. Runs inside the renderer. */
function assertions(arg: { root: string; rules: CheckRule[] }): { findings: CheckFinding[]; total: number; truncated: boolean } {
  const root = document.querySelector<HTMLElement>(`[data-bogen-id="${arg.root}"]`)!;
  const findings: CheckFinding[] = [];
  let total = 0;
  let truncated = false;
  const add = (finding: CheckFinding) => { total++; if (findings.length < 100) findings.push(finding); };
  const compare = (actual: string | number | null, r: CheckRule): boolean => {
    if (r.operator === 'present') return actual !== null;
    if (r.operator === 'absent') return actual === null;
    if (r.operator === 'min' || r.operator === 'max' || typeof r.value === 'number') {
      const n = typeof actual === 'number' ? actual : actual === null ? NaN : parseFloat(actual);
      if (!Number.isFinite(n)) return false;
      return r.operator === 'min' ? n >= Number(r.value) : r.operator === 'max' ? n <= Number(r.value) : n === r.value;
    }
    return r.operator === 'not-equals' ? actual !== r.value : actual === r.value;
  };
  for (const r of arg.rules) {
    if (r.enabled === false) continue;
    let matches: Element[];
    try { matches = [...(root.matches(r.selector) ? [root] : []), ...root.querySelectorAll(r.selector)]; }
    catch { add({ rule: r.id, id: arg.root, severity: r.severity ?? 'warning', message: `Invalid CSS selector: ${r.selector}` }); continue; }
    const bad = (id: string, actual: string | number | null, fallback?: string) => add({ rule: r.id, id, severity: r.severity ?? 'warning', message: r.message || fallback || `${r.selector}: ${r.property ?? 'count'} must be ${r.operator} ${r.value ?? ''}.`, actual, ...(r.value !== undefined ? { expected: r.value } : {}) });
    if (r.kind === 'count') { if (!compare(matches.length, r)) bad(arg.root, matches.length); continue; }
    if (!matches.length) { bad(arg.root, null, `No elements match ${r.selector}.`); continue; }
    if (matches.length > 2000) truncated = true;
    for (const el of matches.slice(0, 2000)) {
      const id = el.closest<HTMLElement>('[data-bogen-id]')?.dataset.bogenId ?? arg.root;
      let actual: string | number | null;
      if (r.kind === 'style') actual = getComputedStyle(el).getPropertyValue(r.property!);
      else if (r.kind === 'attribute') actual = el.getAttribute(r.property!);
      else {
        const box = el.getBoundingClientRect();
        const parent = root.getBoundingClientRect();
        const prop = r.property as 'width' | 'height' | 'top' | 'left' | 'right' | 'bottom';
        actual = box[prop] - (prop === 'width' || prop === 'height' ? 0 : (prop === 'top' || prop === 'bottom' ? parent.top : parent.left));
      }
      if (!compare(actual, r)) bad(id, actual);
    }
  }
  return { findings, total, truncated };
}
export async function runCustomCheck(doc: BogenDoc, renderer: Renderer, checkId: string, nodeId: string) {
  const definition = resolveCheck(doc, checkId);
  const root = doc.getNode(nodeId);
  if (!root) throw new Error(`No layer named ${nodeId}.`);
  if (definition.enabled === false) return { id: checkId, name: definition.name, skipped: true, ok: true, total: 0, findings: [] };
  const findings: CheckFinding[] = [];
  let total = 0;
  const results: Record<string, unknown> = {};
  const add = (finding: CheckFinding) => { total++; if (findings.length < 100) findings.push(finding); };
  if (definition.lint) {
    const nodes = [root, ...doc.descendants(nodeId)];
    const issues = await lintIssues(doc, renderer, { nodeIds: [nodeId] }, nodes);
    results.lint = lintReport(issues, nodes);
    for (const issue of issues) add({ rule: `lint:${issue.rule}`, id: issue.nodeId, message: issue.message, severity: 'warning' });
  }
  if (definition.a11y) {
    const audit = await auditA11y(doc, renderer, { nodeId });
    results.a11y = { ok: audit.ok, counts: audit.counts, checked: audit.checked };
    for (const layer of audit.layers) for (const issue of layer.issues) add({ rule: `a11y:${issue.rule}`, id: issue.node_id, message: `${issue.message} (WCAG ${issue.wcag})`, severity: issue.severity === 'error' ? 'error' : 'warning' });
  }
  if (definition.responsive || definition.viewport_heights) {
    const raw = await responsiveReport(doc, renderer, { node_id: nodeId, widths: definition.widths ?? [1440, 768, 390], viewport_heights: definition.viewport_heights, viewport_tolerance: definition.tolerance });
    const report = JSON.parse(raw.content.find((c) => c.type === 'text')!.text);
    results.responsive = report;
    if (definition.responsive) for (const width of report.widths) {
      for (const issue of width.overflow) add({ rule: 'responsive:overflow', id: issue.id, message: `Overflows ${issue.side} by ${issue.by}px at ${width.width}px.`, severity: 'warning', width: width.width });
      for (const issue of width.clipped_text) add({ rule: 'responsive:clipped-text', id: issue.id, message: `Text is clipped at ${width.width}px.`, severity: 'warning', width: width.width });
      if (!width.ok && !width.overflow.length && !width.clipped_text.length) add({ rule: 'responsive:overflow', id: nodeId, message: `Content is ${width.content_wider_by}px wider than the frame at ${width.width}px.`, severity: 'warning', width: width.width });
    }
    for (const width of report.viewport_stability?.widths ?? []) for (const sample of width.samples) if (!sample.stable) add({ rule: 'viewport:stability', id: nodeId, severity: 'warning', width: width.width, message: `At ${width.width}×${sample.viewport_height}, content height is ${sample.content_height}px (baseline ${width.baseline_height}px); ${sample.changed_layer_count} layers changed. Inspect the changes while preserving the scroll effect.` });
  }
  const rules = (definition.rules ?? []).map((r) => r.kind === 'style' && r.property ? { ...r, property: kebabCss(r.property) } : r);
  let incomplete = false;
  if (rules.some((r) => r.enabled !== false)) {
    const rendered = await renderer.atWidths(doc, nodeId, definition.widths ?? [1440, 768, 390], assertions, { root: nodeId, rules });
    for (const result of rendered) {
      total += result.result.total;
      incomplete ||= result.result.truncated;
      for (const finding of result.result.findings) if (findings.length < 100) findings.push({ ...finding, width: result.width });
    }
  }
  const skipped = !definition.lint && !definition.a11y && !definition.responsive && !definition.viewport_heights && !rules.some((r) => r.enabled !== false);
  return { id: checkId, name: definition.name, ...(skipped ? { skipped: true } : {}), ok: total === 0 && !incomplete, total, findings, truncated: total > findings.length, incomplete, results };
}

export async function runSavedChecks(doc: BogenDoc, renderer: Renderer, nodeId: string, ids?: string[]) {
  const checks = ids ?? getChecks(doc).filter((c) => c.enabled !== false).map((c) => c.id);
  if (checks.length > 8) throw new Error('Choose at most eight checks per run.');
  const reports = [];
  for (const id of [...new Set(checks)]) reports.push(await runCustomCheck(doc, renderer, id, nodeId));
  return { ok: reports.every((r) => r.ok), reports, ...(reports.length ? {} : { note: 'No enabled saved checks. Create one, or choose a built-in from check_list.' }) };
}
