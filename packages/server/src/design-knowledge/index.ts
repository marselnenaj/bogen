import { ANTI_SLOP_GROUPS, ANTI_SLOP_POLICY, ANTI_SLOP_RULES } from './anti-slop.ts';
import { RUBRIC, RUBRIC_CAP, RUBRIC_FAIL, RUBRIC_MAX, RUBRIC_STRONG, rubricText } from './rubric.ts';
import { DESIGN_DISCIPLINES } from './disciplines.ts';
import { DESIGN_RECIPES } from './recipes.ts';
import { DESIGN_SOURCES } from './sources.ts';
import { DESIGN_PLAYBOOKS, DESIGN_WORKFLOW } from './playbooks.ts';
export { DESIGN_DISCIPLINES, DESIGN_RECIPES, DESIGN_SOURCES, DESIGN_PLAYBOOKS, DESIGN_WORKFLOW, ANTI_SLOP_POLICY, ANTI_SLOP_RULES, ANTI_SLOP_GROUPS, RUBRIC };
export type { DesignDiscipline, DesignRecipe, DesignRule, DesignSource } from './types.ts';
export type { DesignPlaybook, DesignDecision } from './playbooks.ts';

export const KNOWLEDGE_ACTIONS = ['catalog', 'style', 'playbook', 'rules', 'recipes', 'sources', 'skill', 'original', 'rubric'] as const;
export const KNOWLEDGE_VERSION = '2026-11-10.1';
/** How the scored self-review is passed and judged, said once for every place that shows it. */
export const RUBRIC_RULES = `Score each criterion from 1 to 5 from a fresh screenshot, with what you see as evidence, and pass the scores as rubric to design_verify. ${RUBRIC_FAIL} or lower on any criterion is not finished work. A criterion with measured findings against it cannot score above ${RUBRIC_CAP}. Under ${RUBRIC_STRONG} of ${RUBRIC_MAX} is adequate, not strong: repair the lowest criteria or build a second direction.`;
export const DISCIPLINE_IDS = DESIGN_DISCIPLINES.map(d => d.id) as [string, ...string[]];
export function discipline(id: string) {
  const found = DESIGN_DISCIPLINES.find(d => d.id === id);
  if (!found) throw new Error(`Unknown design discipline: ${id}. Read design_knowledge action catalog.`);
  return found;
}
export function playbook(id: string) {
  discipline(id);
  return DESIGN_PLAYBOOKS.find(p => p.id === id)!;
}
export function inferDiscipline(text: string): string {
  const q = text.toLocaleLowerCase();
  const scored = DESIGN_DISCIPLINES.filter(d => d.id !== 'foundations').map(d => ({
    id: d.id, score: d.aliases.reduce((score, alias) => score + (new RegExp(`(?:^|[^\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\p{L}\\p{N}])`, 'u').test(q) ? alias.length : 0), 0),
  })).sort((a,b) => b.score - a.score);
  // Mixed deliverables need a scoped choice, rather than a guess based on one platform word.
  return scored[0]?.score && !scored[1]?.score ? scored[0].id : 'foundations';
}
export function knowledgeCatalog() {
  return {
    version: KNOWLEDGE_VERSION, authorship: DESIGN_WORKFLOW.authorship,
    disciplines: DESIGN_DISCIPLINES.map(({ rules, ...d }) => ({ ...d, rules: rules.length, recipes: DESIGN_RECIPES.filter(r => r.discipline === d.id).length })),
    counts: { disciplines: DESIGN_DISCIPLINES.length, playbooks: DESIGN_PLAYBOOKS.length, styleRules: ANTI_SLOP_RULES.length, rules: DESIGN_DISCIPLINES.reduce((n,d) => n + d.rules.length, 0), recipes: DESIGN_RECIPES.length, sources: 0 },
    policy: 'Bogen-authored decision playbooks. Each decision names its trigger, action, check, repair and exception. Heuristics adapt to the brief; they do not prove conversion, native behavior, accessibility conformance or artistic quality. No online reading is required. Legacy reference records remain available only on explicit action sources for older clients.',
    next: 'Choose one discipline and read action playbook for its complete working contract, or action skill for a compact SKILL.md. Read action rules for searchable decisions and action recipes for alternate compositions. Do not load every discipline. Only the person accepts proposals or resolves threads.',
  };
}
export function readKnowledge(options: { action?: string; discipline?: string; query?: string; id?: string; offset?: number; limit?: number } = {}) {
  const action = options.action ?? 'catalog';
  const limit = Math.min(30, Math.max(1, Math.floor(options.limit ?? 10))), offset = Math.max(0, Math.floor(options.offset ?? 0));
  const q = (options.query ?? '').trim().toLocaleLowerCase();
  const matches = (row: unknown) => !q || JSON.stringify(row).toLocaleLowerCase().includes(q);
  const selected = options.discipline ? discipline(options.discipline) : null;
  const paginate = <T>(rows: T[]) => ({ total: rows.length, offset, items: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null });
  if (action === 'catalog') return knowledgeCatalog();
  // The whole policy by default; a query or id narrows the rules, for an agent that wants one replacement and its check.
  if (action === 'style') return { version: KNOWLEDGE_VERSION, ...ANTI_SLOP_POLICY, ...(q || options.id ? { rules: ANTI_SLOP_RULES.filter((r) => (!options.id || r.id === options.id) && matches(r)) } : {}), groups: ANTI_SLOP_GROUPS };
  if (action === 'rubric') return { version: KNOWLEDGE_VERSION, bar: DESIGN_WORKFLOW.bar, rubric: RUBRIC, rules: RUBRIC_RULES };
  if (action === 'sources') return { version: KNOWLEDGE_VERSION, legacy: true, note: 'Optional historical references. Current Bogen playbooks are authored working instructions and do not depend on these links.', ...paginate(DESIGN_SOURCES.filter(s => (!options.id || s.id === options.id) && matches(s))) };
  if (action === 'playbook') {
    if (!selected) throw new Error('Choose one discipline for its playbook; read catalog to choose.');
    return { version: KNOWLEDGE_VERSION, workflow: DESIGN_WORKFLOW, playbook: playbook(selected.id) };
  }
  if (action === 'recipes') return { version: KNOWLEDGE_VERSION, ...paginate(DESIGN_RECIPES.filter(r => (!selected || r.discipline === selected.id) && (!options.id || r.id === options.id) && matches(r))) };
  if (action === 'skill' || action === 'original') {
    if (!selected) throw new Error('Choose a discipline for its skill.');
    return { version: KNOWLEDGE_VERSION, discipline: selected.id, markdown: disciplineSkill(selected.id) };
  }
  if (action !== 'rules') throw new Error(`Unknown knowledge action: ${action}.`);
  const rows = (selected ? [selected] : DESIGN_DISCIPLINES).flatMap(d => d.rules.map(r => ({ ...r, discipline: d.id }))).filter(r => (!options.id || r.id === options.id) && matches(r));
  return { version: KNOWLEDGE_VERSION, ...paginate(rows), sources: [], ...(selected ? { purpose: selected.purpose, visual_review: selected.review, responsive: selected.responsive } : {}) };
}

/**
 * A single discipline, no bibliography and no duplicate representation of the same decisions. What decides whether
 * work is accepted comes first, then the loop, since an agent follows the start of a long text best.
 */
export function disciplineSkill(id: string): string {
  const p = playbook(id), recipes = DESIGN_RECIPES.filter(r => r.discipline === id), w = DESIGN_WORKFLOW;
  return `---
name: bogen-${id}
description: Design and review ${p.name.toLowerCase()} in Bogen using conditional decisions, explicit states and a bounded repair loop.
---

# ${p.name}

${p.goal}

Bogen-authored working guidance, version ${KNOWLEDGE_VERSION}. Heuristics, not empirical proof. No online sources are required. ${w.invariants[0]}

## Quality bar

${w.bar.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Work loop

${w.sequence.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Brief and scope

Resolve: ${p.brief.join('; ')}. ${w.briefPolicy}

${w.invariants.slice(1).map(s => `- ${s}`).join('\n')}

## Decisions

${p.decisions.map(d => `- **${d.title}** [${d.id}]\n  WHEN: ${d.when}.\n  DO: ${d.action}.\n  CHECK: ${d.check}.\n  REPAIR: ${d.repair}.\n  EXCEPTION: ${d.exception}.`).join('\n')}

## Rubric

${RUBRIC_RULES}

${rubricText()}

## Anti-slop review

${ANTI_SLOP_POLICY.precedence} Each id names a habit to remove; design_knowledge action style with that id gives the replacement and its check. design_lint and design_review find many of them as craft findings.
${ANTI_SLOP_GROUPS.map(g => `- ${g.name}: ${g.ids.join(', ')}.`).join('\n')}

## States and deliverables

States to consider, where applicable: ${p.states.join('; ')}.
Deliver: ${p.deliver.join('; ')}. Do not add states or screens without a task-specific reason.

## Review and repair

${w.priorities.join('\n')}
For each finding record: ${w.finding.fields.join('; ')}.
After the last edit, capture the complete affected artboard with canvas_screenshot and call design_verify using ${id}, with specific observations for priority, content and context and the scored rubric. Fix measured errors, capture again and recheck. The built-in completion gate permits at most two additional repair turns; unresolved work remains explicit. External clients cannot be forced to continue.

${p.review.map(r => `- ${r.id}: ${r.question}`).join('\n')}

## Alternate compositions

${recipes.map(r => `- ${r.name} [${r.id}]: ${r.useWhen}${r.template ? ` Start with template_use ${r.template} when suitable.` : ''} Read action recipes for its sequence.`).join('\n')}

## Completion

${w.completion.map(s => `- ${s}`).join('\n')}
`;
}
