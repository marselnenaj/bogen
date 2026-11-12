import { describe, expect, it } from 'vitest';
import { DESIGN_DISCIPLINES, DESIGN_RECIPES, DESIGN_SOURCES, DESIGN_PLAYBOOKS, DESIGN_WORKFLOW, playbook, disciplineSkill, inferDiscipline, readKnowledge } from '../src/design-knowledge/index.ts';
import { findTemplate } from '../src/templates/index.ts';

describe('authored, actionable design playbooks', () => {
  it('keeps unique decisions with actionable conditions, checks and repairs', () => {
    const sourceIds = new Set(DESIGN_SOURCES.map((s) => s.id));
    expect(sourceIds.size).toBe(DESIGN_SOURCES.length);
    const rules = DESIGN_DISCIPLINES.flatMap((d) => d.rules);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    for (const source of DESIGN_SOURCES) {
      expect(new URL(source.url).protocol).toBe('https:');
      expect(source.publisher.length).toBeGreaterThan(2);
      expect(source.scope.length).toBeGreaterThan(30);
      expect(source.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const rule of rules) {
      expect(rule.sources, rule.id).toEqual([]);
      expect(rule.when!.length, rule.id).toBeGreaterThan(10);
      expect(rule.repair!.length, rule.id).toBeGreaterThan(15);
      expect(rule.sources.every((s) => sourceIds.has(s)), rule.id).toBe(true);
      expect(rule.verify.length, rule.id).toBeGreaterThan(15);
      expect(rule.caveat.length, rule.id).toBeGreaterThan(15);
      expect(rule.evidence).toBe('heuristic');
    }
  });
  it('returns a relevant searchable slice without requiring external sources', () => {
    const result = readKnowledge({ action: 'rules', discipline: 'forms', query: 'label' }) as any;
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((r: any) => r.discipline === 'forms')).toBe(true);
    const refs = new Set(result.items.flatMap((r: any) => r.sources));
    expect(result.sources).toEqual([]);
    expect(refs.size).toBe(0);
    expect(result.items.some((r: any) => r.guidance.includes('visible'))).toBe(true);
  });
  it('paginates without losing or repeating rules', () => {
    const ids: string[] = []; let offset: number | null = 0;
    while (offset !== null) {
      const page = readKnowledge({ action: 'rules', offset, limit: 3 }) as any;
      ids.push(...page.items.map((r: any) => r.id)); offset = page.next_offset;
    }
    expect(ids).toEqual(DESIGN_DISCIPLINES.flatMap((d) => d.rules.map((r) => r.id)));
  });
  it('shares the same contextual style policy across the catalog, playbooks and exported skills', () => {
    const {version: _version, groups, ...policy} = readKnowledge({action:'style'}) as any;
    expect(groups.flatMap((g: any) => g.ids).sort()).toEqual(policy.rules.map((r: any) => r.id).sort());
    expect(policy).toEqual(DESIGN_WORKFLOW.antiSlop);
    expect(new Set(policy.rules.map((r: any) => r.id)).size).toBe(policy.rules.length);
    expect((readKnowledge() as any).counts.styleRules).toBe(policy.rules.length);
    for (const discipline of DESIGN_DISCIPLINES) {
      expect((readKnowledge({action:'playbook',discipline:discipline.id}) as any).workflow.antiSlop).toEqual(policy);
      for (const rule of policy.rules) expect(disciplineSkill(discipline.id)).toContain(rule.id);
    }
    expect(policy.precedence).toContain('brief');
    expect(policy.review).toContain('task consequence');
  });
  it('does not force fixed-format work through website reflow', () => {
    for (const id of ['social', 'pitch-decks', 'brand', 'motion', 'themes']) expect(DESIGN_DISCIPLINES.find((d) => d.id === id)?.responsive).toBe(false);
    for (const id of ['websites', 'forms', 'mobile-apps', 'widgets']) expect(DESIGN_DISCIPLINES.find((d) => d.id === id)?.responsive).toBe(true);
  });
  it('connects original recipes to real templates without source dependencies', () => {
    for (const recipe of DESIGN_RECIPES) {
      expect(DESIGN_DISCIPLINES.some((d) => d.id === recipe.discipline)).toBe(true);
      if (recipe.template) expect(findTemplate(recipe.template)).toBeDefined();
      expect(recipe.sources).toEqual([]);
      expect(recipe.requiredContent.length).toBeGreaterThan(0);
      expect(recipe.avoid.length).toBeGreaterThan(0);
    }
  });
  it.each(DESIGN_DISCIPLINES)('exports a self-contained skill for $id without unrelated disciplines', (d) => {
    const skill = disciplineSkill(d.id);
    expect(skill.startsWith(`---\nname: bogen-${d.id}\n`)).toBe(true);
    expect(skill).toContain(d.rules[0]!.guidance);
    expect(skill).toContain('design_verify');
    expect(skill).not.toMatch(/https?:\/\//);
    expect(skill.length).toBeLessThan(14000);
    expect(skill).toContain(d.rules[0]!.repair);
  });
  it.each([
    ['Erstelle ein Pitchdeck für Investoren', 'pitch-decks'], ['Design a desktop app workspace', 'desktop-apps'],
    ['Make an Android app UI', 'mobile-apps'], ['Design a newsletter', 'email'], ['Make a landing page', 'websites'], ['Tighten the selected title', 'foundations'],
    ['Design a social campaign for the Windows app', 'foundations'],
  ])('routes %s conservatively', (text, expected) => expect(inferDiscipline(text)).toBe(expected));
  it.each(DESIGN_PLAYBOOKS)('returns one complete, bounded playbook for $id', p => {
    const result = readKnowledge({ action: 'playbook', discipline: p.id }) as any;
    expect(result.playbook).toBe(p);
    expect(result.workflow).toBe(DESIGN_WORKFLOW);
    expect(result.playbook.decisions.map((d: any) => d.id)).toEqual(DESIGN_DISCIPLINES.find(d => d.id === p.id)!.rules.map(r => r.id));
    expect(p.brief.length).toBeGreaterThan(1);
    expect(p.states.length).toBeGreaterThan(2);
    expect(p.deliver.length).toBeGreaterThan(0);
    expect(new Set(p.review.map(r => r.id))).toEqual(new Set(['priority','content','context']));
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });
  it('keeps optional historical records out of normal knowledge responses', () => {
    const catalog=readKnowledge() as any;
    expect(catalog.counts.sources).toBe(0);
    expect(catalog.counts.playbooks).toBe(DESIGN_PLAYBOOKS.length);
    expect((readKnowledge({action:'sources',limit:1}) as any).legacy).toBe(true);
    expect(()=>readKnowledge({action:'playbook'})).toThrow('Choose one discipline');
    expect(()=>playbook('unknown')).toThrow('Unknown design discipline');
  });
  it.each([['Design an omarchy theme','themes'],['Make a sidebar widget','widgets']])('routes %s to its dedicated operating contract', (prompt,id)=>{
    expect(inferDiscipline(prompt)).toBe(id);
  });
  it('rejects an unknown discipline instead of silently inventing advice', () => expect(() => readKnowledge({ action: 'rules', discipline: 'made-up' })).toThrow('Unknown design discipline'));
});
