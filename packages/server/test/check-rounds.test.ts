import { describe, expect, it } from 'vitest';
import { disciplineSkill, DESIGN_WORKFLOW, DISCIPLINE_IDS } from '../src/design-knowledge/index.ts';
import { DESIGN_CORE, GUIDES, INSTRUCTIONS } from '../src/mcp/guide.ts';
import { runInstructions } from '../src/agents.ts';
import { skillText } from '../src/skill.ts';

/**
 * Fewer check rounds. The traces of call runs showed 9 to 15 design_verify and 24 to 29 canvas_screenshot calls per
 * run: every one is a model step of several seconds. Edits are checked with the layout map or the lint, a picture is
 * for the first and the final look, and design_verify runs once at the end, again only after fixing hard defects.
 */
describe('check rounds in the guidance', () => {
  const maker = runInstructions({ fileId: 'f', fileName: 'Lindenhof', prompt: 'Make the headline bigger', runner: 'claude' });
  const texts: [string, string][] = [
    ['instructions', INSTRUCTIONS], ['design', GUIDES.design], ['apps', GUIDES.apps], ['checks', GUIDES.checks],
    ['playbook', disciplineSkill(DISCIPLINE_IDS[0])], ['maker', maker], ['skill codex', skillText('codex')], ['skill claude', skillText('claude-code')],
  ];

  it('checks edits with the layout map or the lint, and keeps the picture for the first and the final look', () => {
    for (const [name, text] of texts) {
      expect(text, name).toMatch(/map_only/);
      expect(text, name).toMatch(/design_lint/);
    }
    expect(DESIGN_CORE).toContain('checked with canvas_screenshot map_only or design_lint');
    expect(DESIGN_CORE).not.toContain('a canvas_screenshot after each');
    for (const [name, text] of [['instructions', INSTRUCTIONS], ['design', GUIDES.design], ['apps', GUIDES.apps], ['checks', GUIDES.checks], ['maker', maker], ['skill', skillText('codex')]] as const) {
      expect(text, name).toMatch(/picture (only )?for the first and (the )?final look/);
    }
  });

  it('runs design_verify once at the end, and again only after fixing hard defects it found', () => {
    for (const [name, text] of texts) expect(text, name).toMatch(/design_verify once|once more only|again only/);
    expect(DESIGN_WORKFLOW.sequence.join(' ')).toContain('design_verify once per changed artboard');
    expect(INSTRUCTIONS).toContain('again only after fixing its hard defects');
  });

  it('keeps taste advisory: only objective defects block', () => {
    for (const [name, text] of [['instructions', INSTRUCTIONS], ['maker', maker], ['design', GUIDES.design], ['playbook', disciplineSkill(DISCIPLINE_IDS[0])]] as const) {
      expect(text, name).toMatch(/[Aa]dvisory/);
      expect(text, name).toMatch(/objective defect|[Hh]ard findings? block|hard finding stands/);
    }
    expect(maker).toContain('Advisory findings never block');
  });

  it('stays within the instruction budget every MCP client carries', () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(6600);
  });
});
