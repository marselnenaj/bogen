import type { DesignDiscipline } from './types.ts';
import { DESIGN_PLAYBOOKS } from './playbooks.ts';

/** Human browsing, agent rules and exported skills all read the same authored decisions. */
export const DESIGN_DISCIPLINES: readonly DesignDiscipline[] = DESIGN_PLAYBOOKS.map(p => ({
  id: p.id, name: p.name, aliases: p.aliases, responsive: p.responsive, purpose: p.goal, review: p.review,
  rules: p.decisions.map(d => ({ id: d.id, title: d.title, when: d.when, guidance: d.action, verify: d.check, repair: d.repair, caveat: d.exception, sources: [], evidence: 'heuristic' as const })),
}));
