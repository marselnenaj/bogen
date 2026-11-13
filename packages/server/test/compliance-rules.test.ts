import { BogenDoc, getComplianceMarks, setComplianceMark } from '@bogen/core';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { CRITERIA, EN_96, PROFILE_IDS, profile, type Criterion } from '../src/compliance/criteria.ts';
import { addAxe, collected, criteriaOfTags } from '../src/compliance/evidence.ts';
import type { AxeRuleResult } from '../src/compliance/probe.ts';
import type { ComplianceReport } from '../src/compliance/run.ts';
import { judge, judgeProcedure, score, type CriterionResult, type Evidence } from '../src/compliance/score.ts';
import { statementDraft } from '../src/compliance/statement.ts';
import type { LayerFacts } from '../src/compliance/layers.ts';

/** WCAG 2.2 (W3C Recommendation, 12 December 2024): its A and AA criteria, and 4.1.1, which 2.2 removed. */
const WCAG22_A = ['1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.3.1', '1.3.2', '1.3.3', '1.4.1', '1.4.2', '2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2', '2.3.1', '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.5.1', '2.5.2', '2.5.3', '2.5.4', '3.1.1', '3.2.1', '3.2.2', '3.2.6', '3.3.1', '3.3.2', '3.3.7', '4.1.2'];
const WCAG22_AA = ['1.2.4', '1.2.5', '1.3.4', '1.3.5', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '2.4.5', '2.4.6', '2.4.7', '2.4.11', '2.5.7', '2.5.8', '3.1.2', '3.2.3', '3.2.4', '3.3.3', '3.3.4', '3.3.8', '4.1.3'];
const NEW_IN_22 = ['2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8'];

const facts = (over: Partial<LayerFacts> = {}): LayerFacts => ({ media: 0, audio: 0, fields: 0, timed: 0, moving: 0, language: { tag: 'de', from: 'file' }, ...over });
const crit = (id: string) => CRITERIA.find((c) => c.id === id)!;

describe('the criterion map', () => {
  it('has every WCAG 2.2 A and AA criterion, and 4.1.1, exactly once, at its level', () => {
    const ids = CRITERIA.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...WCAG22_A, ...WCAG22_AA, '4.1.1'].sort());
    for (const id of WCAG22_A) expect(crit(id).level).toBe('A');
    for (const id of WCAG22_AA) expect(crit(id).level).toBe('AA');
    expect(crit('4.1.1')).toMatchObject({ level: 'A', removedIn22: true });
  });

  it('gives each profile its own set: 55 for WCAG 2.2, 50 for WCAG 2.1 and for EN 301 549 V3.2.1 plus clause 9.6', () => {
    const ids = (c: Criterion[]) => c.map((x) => x.id);
    expect(profile('wcag-2.2-aa').criteria).toHaveLength(55);
    expect(ids(profile('wcag-2.2-aa').criteria)).not.toContain('4.1.1');
    expect(profile('wcag-2.1-aa').criteria).toHaveLength(50);
    expect(ids(profile('wcag-2.1-aa').criteria).filter((id) => NEW_IN_22.includes(id))).toEqual([]);
    for (const p of ['en-301-549', 'eaa-bafg', 'wzg'] as const) {
      const prof = profile(p);
      expect(prof.criteria).toHaveLength(51);
      expect(prof.criteria.at(-1)).toBe(EN_96);
      expect(ids(prof.advisory).sort()).toEqual([...NEW_IN_22].sort());
    }
    expect(profile('wzg').procedures.map((x) => x.key)).toEqual(['proc:wzg-statement', 'proc:wzg-feedback', 'proc:wzg-enforcement']);
    expect(PROFILE_IDS).toHaveLength(5);
  });

  it('names the EN 301 549 clause of every WCAG 2.1 criterion, and none for a WCAG 2.2 addition', () => {
    for (const c of CRITERIA) {
      if (NEW_IN_22.includes(c.id)) expect(c.en).toBeNull();
      else expect(c.en).toBe(`9.${c.id}`);
      expect(c.en4).toBe(c.id === '4.1.1' ? null : `9.${c.id}`);
    }
  });

  it('says how each criterion is checked, with a test for a person, and a rule for anything automatic', () => {
    for (const c of CRITERIA) {
      expect(['auto', 'partial', 'manual']).toContain(c.coverage);
      expect(c.test.length).toBeGreaterThan(30);
      if (c.coverage !== 'manual') expect(c.rules.length).toBeGreaterThan(0);
    }
    const count = (k: Criterion['coverage']) => profile('wcag-2.2-aa').criteria.filter((c) => c.coverage === k).length;
    expect(count('auto') + count('partial') + count('manual')).toBe(55);
    expect(count('auto')).toBeLessThan(count('partial'));
  });
});

describe('scoring', () => {
  const fail: Evidence = { rule: 'axe:color-contrast', outcome: 'fail', node_id: 'a', layer: 'Button', message: 'Text contrast is 2:1.' };
  const mark = { result: 'pass' as const, by: 'Marsel', at: Date.UTC(2026, 10, 13) };

  it('fails a criterion a check failed, even when a person marked it as passing', () => {
    const r = judge(crit('1.4.3'), [fail], new Set(['axe@1.4.3']), facts(), mark);
    expect(r.status).toBe('failed');
    expect(r.decided_by).toBe('check');
    expect(r.reason).toMatch(/finding stands/);
  });

  it('passes an automatic criterion only when its checks ran, and never a partial one', () => {
    expect(judge(crit('1.4.3'), [], new Set(['axe@1.4.3']), facts(), undefined).status).toBe('passed');
    expect(judge(crit('1.4.3'), [], new Set(), facts(), undefined).status).toBe('needs-person');
    const partial = judge(crit('1.1.1'), [{ rule: 'axe:image-alt', outcome: 'pass', message: 'ok' }], new Set(['axe@1.1.1', 'a11y:alt']), facts(), undefined);
    expect(partial.status).toBe('needs-person');
    expect(partial.reason).toMatch(/not a pass/);
    expect(judge(crit('1.4.3'), [{ ...fail, outcome: 'review' }], new Set(['axe@1.4.3']), facts(), undefined).status).toBe('needs-person');
  });

  it('lets a person decide what only a person can, and says who and when', () => {
    const r = judge(crit('2.1.1'), [], new Set(), facts(), mark);
    expect(r).toMatchObject({ status: 'passed', decided_by: 'person', mark });
    expect(judge(crit('2.1.1'), [], new Set(), facts(), { ...mark, result: 'na' }).status).toBe('not-applicable');
  });

  it('leaves out criteria about content the design does not have', () => {
    expect(judge(crit('1.2.2'), [], new Set(), facts(), undefined)).toMatchObject({ status: 'not-applicable', decided_by: 'design' });
    expect(judge(crit('1.2.2'), [], new Set(), facts({ media: 1 }), undefined).status).toBe('needs-person');
    expect(judge(crit('3.3.1'), [], new Set(), facts(), undefined).status).toBe('not-applicable');
  });

  const result = (status: CriterionResult['status'], decided: CriterionResult['decided_by'], extra: Partial<CriterionResult> = {}): CriterionResult => ({ key: 'wcag:x', id: 'x', name: 'x', level: 'A', en: null, since: '2.0', coverage: 'partial', status, decided_by: decided, reason: '', evidence: [], passed_rules: [], test: '', ...extra });

  it('never claims the profile while anything failed or is open, and reports the automated pass rate apart', () => {
    const p = profile('wcag-2.2-aa');
    const failing = score(p, [result('failed', 'check'), result('passed', 'check'), result('passed', 'check'), result('needs-person', null)], []);
    expect(failing.overall).toBe('fails');
    expect(failing.automated).toMatchObject({ passed: 2, failed: 1, decided: 3, pass_rate: 66.7 });
    expect(failing.summary).toMatch(/^Does not meet/);
    const open = score(p, [result('passed', 'check'), result('needs-person', null)], []);
    expect(open.overall).toBe('incomplete');
    expect(open.automated.pass_rate).toBe(100);
    expect(open.summary).not.toMatch(/conform|meets/i);
    const advisoryOnly = score(p, [result('passed', 'check'), result('failed', 'check', { advisory: true })], []);
    expect(advisoryOnly.overall).toBe('all-criteria-met');
    expect(advisoryOnly.summary).toMatch(/not a certification/);
  });

  it('keeps a profile open while a duty of the law is unconfirmed', () => {
    const p = profile('wzg');
    const proc = judgeProcedure(p.procedures[0]!, [], undefined);
    expect(proc.status).toBe('needs-person');
    expect(score(p, [result('passed', 'check')], [proc]).overall).toBe('incomplete');
    const done = judgeProcedure(p.procedures[0]!, [], { result: 'pass', by: 'A', at: 1 });
    expect(score(p, [result('passed', 'check')], [done]).overall).toBe('all-criteria-met');
  });
});

describe('axe-core results', () => {
  it('maps a rule to the criteria of its WCAG tags', () => {
    expect(criteriaOfTags(['cat.color', 'wcag2aa', 'wcag143', 'EN-301-549', 'EN-9.1.4.3'])).toEqual(['1.4.3']);
    expect(criteriaOfTags(['wcag2a', 'wcag412', 'wcag244'])).toEqual(['4.1.2', '2.4.4']);
    expect(criteriaOfTags(['wcag1410'])).toEqual(['1.4.10']);
  });

  it('turns violations into failures on their layers, incomplete into a look, and records what ran', () => {
    const results: AxeRuleResult[] = [
      { id: 'color-contrast', tags: ['wcag2aa', 'wcag143'], impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast', outcome: 'violation', count: 2, nodes: [{ layer: 'btn', summary: 'Fix any of the following: Element has insufficient color contrast', data: { fgColor: '#777777', bgColor: '#ffffff', contrastRatio: 4.48, expectedContrastRatio: '4.5:1' } }, { layer: 'btn', summary: 'again' }] },
      { id: 'image-alt', tags: ['wcag2a', 'wcag111'], impact: null, help: 'Images must have alternative text', helpUrl: '', outcome: 'pass', count: 0, nodes: [] },
      { id: 'video-caption', tags: ['wcag2a', 'wcag122'], impact: null, help: 'Videos must have captions', helpUrl: '', outcome: 'inapplicable', count: 0, nodes: [] },
      { id: 'link-in-text-block', tags: ['wcag2a', 'wcag141'], impact: 'serious', help: 'Links must be distinguishable', helpUrl: '', outcome: 'incomplete', count: 1, nodes: [{ layer: 'link', summary: 'Check' }] },
    ];
    const c = collected();
    addAxe(c, results, (id) => ({ btn: 'Order button', link: 'Terms link' })[id] ?? '');
    const contrast = c.by.get('1.4.3')!;
    expect(contrast).toHaveLength(1);
    expect(contrast[0]).toMatchObject({ rule: 'axe:color-contrast', outcome: 'fail', node_id: 'btn', layer: 'Order button', message: 'Text contrast is 4.48:1 (#777777 on #ffffff), under 4.5:1.' });
    expect(c.by.get('1.4.1')![0]).toMatchObject({ outcome: 'review', layer: 'Terms link' });
    expect(c.by.get('1.1.1')![0]).toMatchObject({ outcome: 'pass' });
    expect([...c.ran].sort()).toEqual(['axe@1.1.1', 'axe@1.2.2', 'axe@1.4.1', 'axe@1.4.3']);
  });
});

describe('the manual checklist', () => {
  it('is stored in the file per page and criterion, says who and when, and survives a copy of the file', () => {
    const doc = new BogenDoc(new Y.Doc());
    setComplianceMark(doc, 'page1', 'wcag:2.1.1', { result: 'pass', by: 'Marsel', note: 'Keyboard only, Firefox', at: 1_700_000_000_000 });
    setComplianceMark(doc, 'page1', 'wcag:1.2.2', { result: 'na', by: 'Marsel' });
    setComplianceMark(doc, 'file', 'proc:wzg-statement', { result: 'fail', by: 'Lena' });
    const copy = new BogenDoc(new Y.Doc());
    Y.applyUpdate(copy.y, Y.encodeStateAsUpdate(doc.y));
    const marks = getComplianceMarks(copy, 'page1');
    expect(Object.keys(marks).sort()).toEqual(['wcag:1.2.2', 'wcag:2.1.1']);
    expect(marks['wcag:2.1.1']).toEqual({ result: 'pass', by: 'Marsel', at: 1_700_000_000_000, note: 'Keyboard only, Firefox' });
    expect(marks['wcag:1.2.2']!.at).toBeGreaterThan(1_700_000_000_000);
    expect(getComplianceMarks(copy, 'file')['proc:wzg-statement']!.by).toBe('Lena');
    expect(getComplianceMarks(copy, 'page2')).toEqual({});
    setComplianceMark(copy, 'page1', 'wcag:2.1.1', null);
    expect(getComplianceMarks(copy, 'page1')['wcag:2.1.1']).toBeUndefined();
  });

  it('refuses keys, results and names it does not know', () => {
    const doc = new BogenDoc(new Y.Doc());
    expect(() => setComplianceMark(doc, 'p', 'wcag:../x', { result: 'pass', by: 'A' })).toThrow();
    expect(() => setComplianceMark(doc, 'p', 'wcag:1.1.1', { result: 'maybe' as never, by: 'A' })).toThrow();
    expect(() => setComplianceMark(doc, 'p', 'wcag:1.1.1', { result: 'pass', by: '  ' })).toThrow();
    doc.meta.set('compliance:p:wcag:1.1.1', { result: 'pass' });
    expect(getComplianceMarks(doc, 'p')).toEqual({});
  });
});

describe('the statement draft', () => {
  const report = (overall: 'fails' | 'incomplete', failed: CriterionResult[]): ComplianceReport => ({
    profile: { id: 'wzg', name: 'WZG', description: '' }, scope: { page_id: 'p', page: 'Start', boards: [], marks: 'p' }, checked_at: Date.UTC(2026, 10, 13), engines: { axe: '4.14.0' },
    score: { overall, summary: '', counts: { failed: failed.length, passed: 10, not_applicable: 5, needs_person: 20, total: 35 }, automated: { passed: 10, failed: failed.length, decided: 10 + failed.length, pass_rate: 90, partial_clean: 0 }, person: { marked: 0, open: 20, by: [] }, procedures: { open: 3, failed: 0, total: 3 } },
    criteria: [...failed, ...Array.from({ length: 10 }, (_, i) => ({ ...failed[0]!, id: `p${i}`, status: 'passed' as const, evidence: [] }))], advisory: [], procedures: [], beyond: [], facts: facts(), not_checked: [], disclaimer: '',
  });
  const contrast: CriterionResult = { key: 'wcag:1.4.3', id: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', en: '9.1.4.3', since: '2.0', coverage: 'auto', status: 'failed', decided_by: 'check', reason: '', evidence: [{ rule: 'axe:color-contrast', outcome: 'fail', message: 'Text contrast is 3.1:1 (#ffffff on #7d8bff), under 4.5:1.' }], passed_rules: [], test: '' };

  it('writes the model sections in German, with the FFG for the WZG and marked fields', () => {
    const d = statementDraft(report('fails', [contrast]), 'de', { organisation: 'Stadtwerke Muster', contact: 'barrierefrei@example.at' });
    for (const h of ['# Erklärung zur Barrierefreiheit', '## Stand der Vereinbarkeit mit den Anforderungen', '## Nicht barrierefreie Inhalte', '## Erstellung dieser Erklärung', '## Feedback und Kontaktangaben', '## Durchsetzungsverfahren']) expect(d.markdown).toContain(h);
    expect(d.markdown).toContain('teilweise vereinbar');
    expect(d.markdown).toContain('Stadtwerke Muster ist bemüht');
    expect(d.markdown).toContain('WCAG 1.4.3 Contrast (Minimum): Text contrast is 3.1:1');
    expect(d.markdown).toContain('https://www.digitalbarrierefrei.at/de/beschwerdestelle/kontaktformular-beschwerdestelle');
    expect(d.markdown).toContain('13. November 2026');
    expect(d.markdown).toContain('[Ausfüllen: Adresse der Website oder Name der App]');
    expect(d.open_fields).toContain('Adresse der Website oder Name der App');
    expect(d.open_fields).not.toContain('Name der Stelle oder des Unternehmens');
    expect(d.html).toContain('<mark>[Ausfüllen: Adresse der Website oder Name der App]</mark>');
    expect(d.html).toMatch(/^<article lang="de"/);
  });

  it('claims no status while criteria are open, in English too', () => {
    const d = statementDraft(report('incomplete', []), 'en');
    expect(d.markdown).toContain('[Fill in after a person has tested: fully, partially or not compliant with EN 301 549 V3.2.1 (WCAG 2.1 AA). 20 criteria are still open.]');
    expect(d.markdown).not.toMatch(/is fully compliant/);
    expect(d.open_fields).toContain('compliance status');
  });
});
