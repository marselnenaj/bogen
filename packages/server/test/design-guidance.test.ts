import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BogenDoc, importHtml, type BogenNode } from '@bogen/core';
import { ANTI_SLOP_GROUPS, ANTI_SLOP_RULES, DESIGN_WORKFLOW, RUBRIC, disciplineSkill, readKnowledge } from '../src/design-knowledge/index.ts';
import { RUBRIC_IDS, scoreRubric } from '../src/design-knowledge/rubric.ts';
import { copyIssues } from '../src/mcp/copy-check.ts';
import { GUIDES, INSTRUCTIONS } from '../src/mcp/guide.ts';
import { craftIssues, staticIssues } from '../src/mcp/lint.ts';
import { skillText } from '../src/skill.ts';
import { CONSIDERED, GENERATED } from '../../core/test/fixtures/design-craft.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const scores = (score: number, over: Record<string, number> = {}) => RUBRIC_IDS.map((criterion) => ({ criterion, score: over[criterion] ?? score, evidence: `What the screenshot shows for ${criterion}, named by layer and size.` }));

describe('the scored self-review', () => {
  it('has eight criteria, each with a question and both anchors', () => {
    expect(RUBRIC.map((c) => c.id)).toEqual(['hierarchy', 'type', 'spacing', 'colour', 'content', 'craft', 'originality', 'fit']);
    for (const c of RUBRIC) {
      expect(c.question.endsWith('?'), c.id).toBe(true);
      expect(c.five.length, c.id).toBeGreaterThan(40);
      expect(c.two.length, c.id).toBeGreaterThan(30);
    }
  });

  it('is missing or incomplete until every criterion has one score with evidence', () => {
    expect(scoreRubric([], [])).toMatchObject({ state: 'missing', total: 0, max: 40 });
    const partial = scoreRubric(scores(4).slice(0, 5), []);
    expect(partial.state).toBe('incomplete');
    expect(partial.open.map((c) => c.id)).toEqual(['craft', 'originality', 'fit']);
    expect(partial.next).toContain('Score craft, originality, fit from 1 to 5');
    // "Looks good" is not evidence, a score given twice is not a score, and 6 is not on the scale.
    expect(scoreRubric(scores(4).map((s) => ({ ...s, evidence: 'looks good' })), []).state).toBe('missing');
    expect(scoreRubric([...scores(4), ...scores(5).slice(0, 1)], []).open.map((c) => c.id)).toEqual(['hierarchy']);
    expect(scoreRubric(scores(6), []).state).toBe('missing');
  });

  it('does not let a 2 pass, and names what to fix', () => {
    const out = scoreRubric(scores(4, { type: 2, content: 1 }), []);
    expect(out.state).toBe('needs-work');
    expect(out.next).toContain('Fix type, content');
  });

  it('caps a criterion at 3 while measured findings stand against it', () => {
    const findings = [
      { rule: 'craft:loud-type', criterion: 'hierarchy', message: '6 texts are set at or near the largest size.' },
      { rule: 'lint:contrast', message: 'Text contrast is 2.1:1.' },
      { rule: 'lint:token', message: 'color equals the token --ink.' },
    ];
    const high = scoreRubric(scores(5), findings);
    expect(high.state).toBe('capped');
    expect(high.capped.map((c) => c.criterion)).toEqual(['hierarchy', 'colour']);
    expect(high.capped[0]).toMatchObject({ score: 5, findings: 1, example: '6 texts are set at or near the largest size.' });
    expect(high.next).toContain('score 3 or lower and name the exception');
    // Scored honestly, or with the findings fixed, it counts.
    expect(scoreRubric(scores(5, { hierarchy: 3, colour: 3 }), findings).state).toBe('scored');
    expect(scoreRubric(scores(5), []).state).toBe('scored');
  });

  it('asks for another pass or a second direction under 32 of 40, and for the scores in the report', () => {
    const adequate = scoreRubric(scores(4, { originality: 3, fit: 3 }), []);
    expect(adequate).toMatchObject({ state: 'scored', total: 30 });
    expect(adequate.next).toContain('30 of 40: adequate, not strong. Improve originality (3) and fit (3), or build a second direction with proposal_create');
    const strong = scoreRubric(scores(4), []);
    expect(strong).toMatchObject({ state: 'scored', total: 32 });
    expect(strong.next).toBe('32 of 40. Report the scores with the lowest criterion and what is still open.');
    expect(scoreRubric(scores(4), [], false).next).toContain('The measured checks did not run');
  });
});

describe('copy that reads like a report or a hedge', () => {
  const node = (id: string, text: string, tag = 'p'): BogenNode => ({ id, type: 'text', tag, name: id, text, style: {} }) as unknown as BogenNode;
  const quotes = (text: string, tag?: string) => copyIssues([node('a', text, tag)]).map((f) => f.quote);

  it('finds hedges and test-report language in English and German', () => {
    expect(quotes('Ledgerline aims to make invoicing easier.')).toEqual(['aims to']);
    expect(quotes('This may help your team save time.')).toEqual(['may help']);
    expect(quotes('All checks passed on 12 devices.')).toEqual(['All checks passed']);
    expect(quotes('Die App wurde erfolgreich getestet.')).toEqual(['erfolgreich getestet']);
    expect(copyIssues([node('a', 'It has been verified by our team.')])[0]!.message).toContain('That is a test report, not a reason to buy.');
    expect(quotes('Your customer pays from the message, by card or bank transfer.')).toEqual([]);
    expect(quotes('Help is one tap away: call us from the app.')).toEqual([]);
  });

  it('finds a heading chopped into fragments, and leaves sentences and paragraphs alone', () => {
    expect(quotes('No setup. No fees.', 'h2')).toEqual(['No setup. No fees.']);
    expect(copyIssues([node('a', 'Built for vans. Not desks.', 'h1')])[0]!.message).toContain('is chopped into fragments. Write one sentence');
    expect(quotes('No setup. No fees.')).toEqual([]);
    expect(quotes('Send the invoice before you leave the site.', 'h1')).toEqual([]);
    // Three one-word claims stay with the rule that already names them.
    expect(copyIssues([node('a', 'Fast. Simple. Secure.', 'h2')]).map((f) => f.message)).toEqual([expect.stringContaining('three short claims in a row')]);
  });
});

describe('what an agent reads first', () => {
  it('keeps the instructions no larger than before, with the loop in order and the generated look named', () => {
    // 3,872 characters before the loop was put first; every MCP client carries them in every session.
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(3872);
    const order = ['Brief first', 'System before screens', 'small chunks', 'Not the generated look', 'Before you report', 'Canvas structure'].map((s) => INSTRUCTIONS.indexOf(s));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const word of ['one primary action', 'design_review', 'scored rubric', 'grotesk plus mono', 'overcorrection', 'do not hand choices back', 'design_knowledge action skill']) expect(INSTRUCTIONS).toContain(word);
    expect(skillText().length).toBeLessThan(7500);
  });

  it('opens every discipline skill with the quality bar and the loop, before its decisions, and carries the rubric', () => {
    for (const id of ['foundations', 'websites', 'social', 'themes']) {
      const skill = disciplineSkill(id);
      const at = ['## Quality bar', '## Work loop', '## Brief and scope', '## Decisions', '## Rubric', '## Anti-slop review', '## Completion'].map((h) => skill.indexOf(h));
      expect(at.every((i) => i > 0), id).toBe(true);
      expect([...at].sort((a, b) => a - b), id).toEqual(at);
      // The first 3,000 characters are what an agent follows best: the bar has to be inside them.
      expect(skill.indexOf('## Work loop'), id).toBeLessThan(3400);
      for (const c of RUBRIC) expect(skill, id).toContain(`- ${c.id}: ${c.question}`);
      for (const line of DESIGN_WORKFLOW.bar) expect(skill, id).toContain(line);
      // 13,051 to 13,343 characters before; the added bar, loop and rubric are paid for by naming the habits by id.
      expect(skill.length, id).toBeLessThan(13350);
    }
    expect(DESIGN_WORKFLOW.bar[0]).toContain('One message, one action');
    expect(DESIGN_WORKFLOW.sequence[0]).toContain('Brief and point of view');
    expect(DESIGN_WORKFLOW.sequence.at(-1)).toContain('Score the rubric');
  });

  it('groups every habit once, and answers for one of them or for the rubric on its own', () => {
    const grouped = ANTI_SLOP_GROUPS.flatMap((g) => g.ids);
    expect([...grouped].sort()).toEqual(ANTI_SLOP_RULES.map((r) => r.id).sort());
    for (const id of ['equal-loudness', 'mono-decoration', 'caps-labels', 'window-chrome', 'beige-overcorrection', 'report-copy', 'first-screen-only', 'narrow-demo', 'delegated-taste']) expect(grouped).toContain(id);
    const one = readKnowledge({ action: 'style', id: 'mono-decoration' }) as any;
    expect(one.rules).toHaveLength(1);
    expect(one.rules[0].instead).toContain('keep monospace for code');
    expect((readKnowledge({ action: 'style' }) as any).rules).toHaveLength(ANTI_SLOP_RULES.length);
    const rubric = readKnowledge({ action: 'rubric' }) as any;
    expect(rubric.rubric).toBe(RUBRIC);
    expect(rubric.bar).toBe(DESIGN_WORKFLOW.bar);
    expect(rubric.rules).toContain('cannot score above 3');
  });

  it('tells the design guide the same bar, the lines the checks draw and the rubric', () => {
    expect(GUIDES.design).toContain(DESIGN_WORKFLOW.bar[0]);
    expect(GUIDES.design).toContain('more than 2 font families');
    expect(GUIDES.design).toContain('- originality: Could this only be for this subject?');
    expect(GUIDES.design).toContain('Writing copy:');
  });
});

describe('copy in what a template shows rather than writes', () => {
  const quotes = (html: string, template = true) => {
    const d = new BogenDoc();
    d.ensureFirstPage();
    const id = d.insert(d.getPages()[0]!.id, { type: 'frame', name: 'Voice', artboard: true, style: { width: '1440px' } });
    d.insertMany(id, importHtml(html, { counterExamples: template }).nodes);
    d.invalidate();
    return copyIssues([d.getNode(id)!, ...d.descendants(id)], [], { doc: d }).map((f) => f.quote);
  };
  const bad = '<p>Unleash a revolutionary workflow!</p>';

  it('leaves out a counter-example, and still reads the same line written as copy', () => {
    expect(quotes(`<div data-brand-example="dont">${bad}</div>`)).toEqual([]);
    expect(quotes(`<div data-brand-example="dont">${bad}</div>${bad}`)).toEqual(['Unleash', 'revolutionary', '!']);
    // An agent's html cannot carry the mark.
    expect(quotes(`<div data-brand-example="dont">${bad}</div>`, false)).toEqual(['Unleash', 'revolutionary', '!']);
  });

  it('shows the characters of a specimen, and still reads its words', () => {
    const characters = '<p>ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 &amp;?!</p>';
    expect(quotes(`<div data-brand-example="specimen">${characters}</div>`)).toEqual([]);
    expect(quotes(characters)).toEqual(['!']);
    expect(quotes(`<div data-brand-example="specimen"><p>A seamless sample line!</p></div>`)).toEqual(['seamless']);
  });
});

describe('questions as headings', () => {
  const quotes = (html: string) => {
    const d = new BogenDoc();
    d.ensureFirstPage();
    const id = d.insert(d.getPages()[0]!.id, { type: 'frame', name: 'Page', artboard: true, style: { width: '1440px' } });
    d.insertMany(id, importHtml(html).nodes);
    d.invalidate();
    return copyIssues([d.getNode(id)!, ...d.descendants(id)], [], { doc: d }).map((f) => f.quote);
  };
  const qa = (q: string, a = 'Three to four weeks, glaze cured.') => `<h3>${q}</h3><p>${a}</p>`;

  it('reads the questions of an FAQ, each with its answer, as questions a reader asks', () => {
    expect(quotes(`<section><h2>Before you order</h2>${qa('How long does a set take?')}${qa('Can it go in the dishwasher?')}</section>`)).toEqual([]);
    expect(quotes(`<section><h2>Before you order</h2><div>${qa('How long does a set take?')}</div><div>${qa('Can it go in the dishwasher?')}</div></section>`)).toEqual([]);
  });

  it('still calls a headline that asks for effect rhetorical, alone or without answers', () => {
    expect(quotes('<h1>Tired of chasing invoices?</h1><p>Ledgerline sends the reminders.</p>')).toEqual(['Tired of chasing invoices?']);
    expect(quotes('<section><h2>Tired of chasing invoices?</h2><h2>Ready to get paid?</h2></section>')).toEqual(['Tired of chasing invoices?', 'Ready to get paid?']);
    // One question in a list of statements is not an FAQ.
    expect(quotes(`<section>${qa('Why Ledgerline?')}${qa('Built for vans and sites')}</section>`)).toEqual(['Why Ledgerline?']);
  });
});

describe('copy and the grid in a theme file, which previews the system', () => {
  const file = (html: string, theme: boolean) => {
    const d = new BogenDoc();
    d.ensureFirstPage();
    if (theme) d.meta.set('omarchyTheme', { name: 'Test', target: 'desktop' });
    const id = d.insert(d.getPages()[0]!.id, { type: 'frame', name: 'Preview', artboard: true, style: { width: '1440px' } });
    d.insertMany(id, importHtml(html).nodes);
    d.invalidate();
    return { d, nodes: [d.getNode(id)!, ...d.descendants(id)] };
  };
  const quotes = (html: string, theme = true) => {
    const { d, nodes } = file(html, theme);
    return copyIssues(nodes, [], { doc: d }).map((f) => f.quote);
  };
  const terminal = '<p> ! contrast of muted on background is 3.9</p><p> \u2713\uFE0E install refuses to overwrite</p><p>\u21E7</p>';

  it('shows terminal output and key glyphs as the system shows them, and still reads the words', () => {
    expect(quotes(terminal)).toEqual([]);
    expect(quotes(terminal, false)).toEqual(['!', '\u2713', '\u21E7']);
    expect(quotes('<p>Seamless sync for every desktop!</p>')).toEqual(['Seamless']);
  });

  it('reads a file name or a link as a name, in any file, and the same word in a sentence as hype', () => {
    expect(quotes('<p>unlock.png is missing</p>', false)).toEqual([]);
    expect(quotes('<p>See https://example.com/unlock for the steps.</p>', false)).toEqual([]);
    expect(quotes('<p>Unlock your team. Now with exports.</p>', false)).toEqual(['Unlock']);
  });

  it('takes the system\'s sizes rather than a 4px grid there', () => {
    const bar = '<div style="display:flex;padding:3px 9px"><p>Bar</p></div>';
    const grid = (theme: boolean) => {
      const { d, nodes } = file(bar, theme);
      return staticIssues(d, nodes).filter((i) => i.rule === 'grid').length;
    };
    expect(grid(true)).toBe(0);
    expect(grid(false)).toBe(1);
  });
});

describe('spacing rhythm compares siblings that are alike', () => {
  const rhythm = (html: string) => {
    const d = new BogenDoc();
    d.ensureFirstPage();
    const id = d.insert(d.getPages()[0]!.id, { type: 'frame', name: 'Page', artboard: true, style: { width: '1440px' } });
    d.insertMany(id, importHtml(html).nodes);
    d.invalidate();
    return staticIssues(d, [d.getNode(id)!, ...d.descendants(id)]).filter((i) => i.rule === 'spacing').map((i) => i.name);
  };
  const column = (name: string, gap: number) => `<div data-name="${name}" style="display:flex;flex-direction:column;gap:${gap}px"><p>${name}</p></div>`;
  const grid = (name: string, gap: number, columns = '1fr 2fr') => `<div data-name="${name}" style="display:grid;grid-template-columns:${columns};gap:${gap}px"><p>${name}</p></div>`;

  it('reports a card spaced unlike the cards beside it', () => {
    expect(rhythm(`<section>${column('Card A', 24)}${column('Card B', 24)}${column('Card C', 20)}</section>`)).toEqual(['Card C']);
    expect(rhythm(`<section>${grid('Row A', 24, 'repeat(2, 1fr)')}${grid('Row B', 24)}${grid('Row C', 40, '7fr 5fr')}</section>`)).toEqual(['Row C']);
  });

  it('does not hold a two-column block to the gap of the columns of buttons beside it', () => {
    expect(rhythm(`<section>${column('Variants', 24)}${grid('Size block', 48)}${column('Never', 24)}</section>`)).toEqual([]);
    expect(rhythm(`<section>${grid('In use', 88, '7fr 5fr')}${column('Button block', 24)}${grid('Basics', 88, '1fr 1fr')}</section>`)).toEqual([]);
    // A grid of four is not a grid of two.
    expect(rhythm(`<section>${grid('Logos', 24, 'repeat(4, 1fr)')}${grid('Pair', 48)}${grid('Pair 2', 48)}${grid('Pair 3', 48)}</section>`)).toEqual([]);
  });
});

describe('craft findings where an agent meets them', () => {
  const doc = (html: string) => {
    const d = new BogenDoc();
    d.ensureFirstPage();
    const id = d.insert(d.getPages()[0]!.id, { type: 'frame', name: 'Page', artboard: true, style: { width: '1440px' } });
    d.insertMany(id, importHtml(html).nodes);
    d.invalidate();
    return { d, id };
  };

  it('become craft issues of design_lint, with the check and the criterion, and none on the considered page', () => {
    const bad = doc(GENERATED);
    const issues = craftIssues(bad.d, bad.d.descendants(bad.d.getPages()[0]!.id));
    expect(issues.length).toBe(16);
    expect(issues.every((i) => i.rule === 'craft' && i.check && i.criterion && i.message.length > 60)).toBe(true);
    expect(issues.find((i) => i.check === 'glow')).toMatchObject({ criterion: 'originality', name: 'Start free trial' });
    // A layer on its own is checked as its own root.
    const hero = bad.d.getChildren(bad.id)[0]!;
    expect(craftIssues(bad.d, [hero, ...bad.d.descendants(hero.id)]).map((i) => i.check)).toContain('primary-actions');
    const good = doc(CONSIDERED);
    expect(craftIssues(good.d, good.d.descendants(good.d.getPages()[0]!.id))).toEqual([]);
  });

  describe('over MCP', () => {
    let h: Harness;
    beforeAll(async () => { h = await startServer(); });
    afterAll(async () => { await h.cleanup(); });

    it('reach design_review and hold the rubric of design_verify to account, with or without a browser', async () => {
      const agent = await connectAgent(h.base, 'designer');
      const file = (await call(agent, 'file_create', { name: 'Guidance' })).id;
      const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Landing', width: 1440 })).id;
      // Without the photo section, so that nothing is fetched.
      await call(agent, 'html_write', { file_id: file, target_id: board, html: GENERATED.split('<section data-name="Photo"')[0]! });
      const review = await call(agent, 'design_review', { file_id: file, node_id: board });
      const found = review.observations.filter((o: any) => o.rule).map((o: any) => o.rule);
      for (const rule of ['decorative-mono', 'loud-type', 'primary-actions', 'glow', 'tilt', 'window-chrome', 'pattern-background', 'default-gradient', 'boxes', 'nested-boxes']) expect(found, rule).toContain(rule);

      const unscored = await call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites' });
      expect(unscored.rubric.state).toBe('missing');
      expect(unscored.rubric.open).toHaveLength(8);
      expect(unscored.automated.findings.some((f: any) => f.rule === 'craft:glow' && f.criterion === 'originality')).toBe(true);
      const flattering = await call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites', rubric: scores(5) });
      expect(flattering.rubric.state).toBe('capped');
      expect(flattering.rubric.capped.map((c: any) => c.criterion)).toEqual(expect.arrayContaining(['hierarchy', 'type', 'craft', 'originality']));
      const honest = await call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites', rubric: scores(3) });
      expect(honest.rubric).toMatchObject({ state: 'scored', total: 24 });
      expect(honest.rubric.next).toContain('adequate, not strong');
      expect((await call(agent, 'design_knowledge', { action: 'rubric' })).rubric).toHaveLength(8);
      await agent.close();
    }, 120_000);
  });
});
