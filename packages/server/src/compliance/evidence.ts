import { A11Y_RULES, type A11yReport } from '../a11y.ts';
import type { WidthReport } from '../width-check.ts';
import type { AxeRuleResult, NonTextFinding, SpacingFinding } from './probe.ts';
import type { LayerFinding } from './layers.ts';
import type { Evidence } from './score.ts';

/** Evidence per WCAG number, and the rules that ran: `a11y:alt`, `bogen:reflow`, and `axe@1.4.3` for an axe rule of that criterion. */
export interface Collected { by: Map<string, Evidence[]>; ran: Set<string> }

export function collected(): Collected {
  return { by: new Map(), ran: new Set() };
}

function push(c: Collected, criterion: string, e: Evidence): void {
  const list = c.by.get(criterion) ?? [];
  // One finding per rule and layer is enough to act on.
  if (e.outcome !== 'pass' && list.some((x) => x.rule === e.rule && x.node_id === e.node_id && x.outcome === e.outcome)) return;
  if (e.outcome === 'pass' && list.some((x) => x.rule === e.rule && x.outcome === 'pass')) return;
  list.push(e);
  c.by.set(criterion, list);
}

/** `wcag143` is 1.4.3. axe tags each rule with the success criteria it tests. */
export function criteriaOfTags(tags: string[]): string[] {
  return tags.flatMap((t) => {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
    return m ? [`${m[1]}.${m[2]}.${m[3]}`] : [];
  });
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);

function axeMessage(rule: AxeRuleResult, node: AxeRuleResult['nodes'][number]): string {
  const d = node.data ?? {};
  if (rule.id === 'color-contrast' && Number.isFinite(num(d.contrastRatio)) && d.fgColor) {
    return `Text contrast is ${num(d.contrastRatio)}:1 (${String(d.fgColor)} on ${String(d.bgColor)}), under ${String(d.expectedContrastRatio ?? '4.5:1')}.`;
  }
  return `${rule.help}.${node.summary ? ` ${node.summary.replace(/^Fix (any|all) of the following:\s*/i, '')}` : ''}`.slice(0, 400);
}

export function addAxe(c: Collected, results: AxeRuleResult[], names: (id: string) => string): void {
  for (const rule of results) {
    for (const id of criteriaOfTags(rule.tags)) {
      if (rule.outcome === 'pass' || rule.outcome === 'inapplicable') {
        c.ran.add(`axe@${id}`);
        if (rule.outcome === 'pass') push(c, id, { rule: `axe:${rule.id}`, outcome: 'pass', message: rule.help, help_url: rule.helpUrl });
        continue;
      }
      c.ran.add(`axe@${id}`);
      for (const node of rule.nodes) push(c, id, { rule: `axe:${rule.id}`, outcome: rule.outcome === 'violation' ? 'fail' : 'review', node_id: node.layer, layer: names(node.layer), message: rule.outcome === 'incomplete' ? `Needs a look: ${axeMessage(rule, node)}` : axeMessage(rule, node), help_url: rule.helpUrl });
    }
  }
}

/** a11y_audit's issues name their criterion as text, such as `1.3.1 Info and Relationships`. */
export function addA11y(c: Collected, report: A11yReport): void {
  if (report.checked.layers > 0) for (const r of A11Y_RULES) c.ran.add(`a11y:${r}`);
  for (const layer of report.layers) for (const issue of layer.issues) {
    const id = /^(\d\.\d\.\d{1,2})/.exec(issue.wcag)?.[1];
    if (!id) continue;
    push(c, id, { rule: `a11y:${issue.rule}`, outcome: issue.severity === 'error' ? 'fail' : 'review', node_id: issue.node_id, layer: issue.layer, message: issue.message, ...(issue.fix ? { fix: issue.fix.description } : {}) });
  }
}

export function addLayers(c: Collected, findings: LayerFinding[], ran: string[]): void {
  for (const r of ran) c.ran.add(r);
  for (const f of findings) push(c, f.criterion, { rule: f.rule, outcome: f.outcome, node_id: f.node_id, layer: f.layer, message: f.message, ...(f.fix ? { fix: f.fix } : {}) });
}

export function addProbe(c: Collected, nonText: NonTextFinding[], spacing: SpacingFinding[], names: (id: string) => string): void {
  c.ran.add('bogen:non-text-contrast');
  c.ran.add('bogen:text-spacing');
  for (const f of nonText) push(c, '1.4.11', { rule: 'bogen:non-text-contrast', outcome: 'fail', node_id: f.layer, layer: names(f.layer), message: f.what === 'field' ? `This field's edge has a contrast of ${f.ratio}:1 against what is around it (${f.colors}), under 3:1, so it is hard to see where to type.` : `This icon has a contrast of ${f.ratio}:1 (${f.colors}), under 3:1.`, fix: f.what === 'field' ? 'Give it a border or fill that reaches 3:1 against the background.' : 'Use a darker or lighter icon colour that reaches 3:1.' });
  for (const f of spacing) push(c, '1.4.12', { rule: 'bogen:text-spacing', outcome: 'fail', node_id: f.layer, layer: names(f.layer), message: `With wider text spacing, "${f.text.slice(0, 40)}" is cut off${f.clippedBy !== f.layer ? ` by "${names(f.clippedBy).slice(0, 40)}"` : ''}.`, fix: 'Let the box grow with its text: no fixed height, and no overflow hidden around text.' });
}

/**
 * Reflow (1.4.10) at 320 CSS px, and text cut off at 640 px as a stand-in for 200 % zoom (1.4.4). Content inside a
 * table or a scrolling container may need two dimensions, which 1.4.10 allows; those are for a person to judge. When
 * the page has its own narrow artboard, a wide one is the desktop design, and the narrow one is what counts.
 */
export function addReflow(c: Collected, board: string, reports: WidthReport[], twoDimensional: (id: string) => boolean, hasNarrowBoard: boolean, names: (id: string) => string): void {
  c.ran.add('bogen:reflow');
  c.ran.add('bogen:resize-text');
  const at320 = reports.find((r) => r.width === 320);
  const at640 = reports.find((r) => r.width === 640);
  if (at320 && !at320.ok) {
    const outcome = hasNarrowBoard ? 'review' : 'fail';
    const extra = hasNarrowBoard ? ' This page has a narrow artboard too; if that is the phone version of this one, check that one instead.' : '';
    for (const o of at320.overflow) push(c, '1.4.10', { rule: 'bogen:reflow', outcome: twoDimensional(o.id) ? 'review' : outcome, node_id: o.id, layer: o.name, message: `At 320 CSS px wide this sticks out ${o.side === 'left' ? 'to the left' : 'to the right'} by ${o.by}px, so people scroll sideways.${twoDimensional(o.id) ? ' It is inside a table or a scrolling area, which may need two dimensions.' : extra}`, fix: o.fixed_width ? `Replace width ${o.fixed_width} with width:100% and a max-width.` : 'Let it wrap or shrink: flex-wrap, min-width:0, max-width:100%.' });
    for (const t of at320.clipped_text) push(c, '1.4.10', { rule: 'bogen:reflow', outcome, node_id: t.id, layer: t.name, message: `At 320 CSS px wide the text "${(t.text ?? '').slice(0, 40)}" is cut off.${extra}`, fix: 'Let its box grow with the text.' });
    if (!at320.overflow.length && !at320.clipped_text.length && at320.content_wider_by > 0) push(c, '1.4.10', { rule: 'bogen:reflow', outcome, node_id: board, layer: names(board), message: `At 320 CSS px the content is ${at320.content_wider_by}px wider than the screen.${extra}` });
  }
  if (at640) for (const t of at640.clipped_text) push(c, '1.4.4', { rule: 'bogen:resize-text', outcome: 'review', node_id: t.id, layer: t.name, message: `At 640 px, as at 200 % zoom on a 1280 px screen, the text "${(t.text ?? '').slice(0, 40)}" is cut off.`, fix: 'Let its box grow with the text.' });
}
