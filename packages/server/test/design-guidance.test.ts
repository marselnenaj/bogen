import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BogenDoc, importHtml, type BogenNode } from '@bogen/core';
import { ANTI_SLOP_GROUPS, ANTI_SLOP_RULES, DESIGN_PLAYBOOKS, DESIGN_WORKFLOW, RUBRIC, disciplineSkill, playbook, readKnowledge } from '../src/design-knowledge/index.ts';
import { RUBRIC_IDS, scoreRubric } from '../src/design-knowledge/rubric.ts';
import { copyIssues } from '../src/mcp/copy-check.ts';
import { DESIGN_CORE, DESIGN_EXAMPLES, GUIDES, INSTRUCTIONS } from '../src/mcp/guide.ts';
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
    expect(high.next).toContain('score 3 or lower and name the reason');
    // Scored honestly, or with the findings fixed, it counts.
    expect(scoreRubric(scores(5, { hierarchy: 3, colour: 3 }), findings).state).toBe('scored');
    expect(scoreRubric(scores(5), []).state).toBe('scored');
  });

  it('does not count while an objective defect stands; advisory findings never block or cap, and a kept one records why', () => {
    const findings = [
      { rule: 'lint:overflow', hard: true, message: 'Overflows its parent by 14px on the right.' },
      { rule: 'lint:placeholder', criterion: 'content', hard: true, message: 'The text says "Lorem ipsum", which reads as placeholder copy.' },
      { rule: 'craft:caps-label', criterion: 'type', advisory: true, why: 'A small tracked capital label over the heading is the eyebrow of generated pages.', message: '2 small labels are set in letter-spaced capitals.' },
      { rule: 'craft:one-hue', criterion: 'colour', advisory: true, why: 'Neutrals and one accent is the default palette, not a decision.', message: 'All 4 screens are neutrals and one hue.' },
    ];
    const out = scoreRubric(scores(3), findings);
    expect(out.state).toBe('blocked');
    expect(out.blocking.map((b) => b.check)).toEqual(['overflow', 'placeholder']);
    expect(out.next).toContain('objective defects stand (overflow on 1, placeholder on 1)');
    // Advisory findings alone: scored, even at 5 on the criteria they concern, and the next step names them with why.
    const taste = scoreRubric(scores(5), findings.slice(2));
    expect(taste.state).toBe('scored');
    expect(taste.capped).toEqual([]);
    expect(taste.advisory.map((a) => a.check)).toEqual(['caps-label', 'one-hue']);
    expect(taste.next).toContain('Advisory, your call: caps-label (A small tracked capital label');
    // Kept with the direction's reason: recorded, and no longer asked about.
    const reason = 'The direction is a 1960s airline timetable, set in tracked capitals.';
    const kept = scoreRubric(scores(5), findings.slice(2), true, [{ check: 'caps-label', reason }, { check: 'glow', reason }]);
    expect(kept.advisory.find((a) => a.check === 'caps-label')!.kept).toBe(reason);
    expect(kept.kept.map((k) => k.check)).toEqual(['caps-label']);
    expect(kept.next).not.toContain('caps-label (');
    // A short reason keeps nothing; a hard finding kept for the brief no longer blocks but still caps.
    expect(scoreRubric(scores(5), findings.slice(2), true, [{ check: 'caps-label', reason: 'I like it' }]).kept).toEqual([]);
    const briefed = scoreRubric(scores(5), findings.slice(1, 2), true, [{ check: 'placeholder', reason: 'The brief asks for a wireframe with placeholder text.' }]);
    expect(briefed.state).toBe('capped');
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

  it('names emoji and placeholder copy, and marks only the placeholder hard', () => {
    const hard = (text: string) => copyIssues([node('a', text)]).map((f) => f.check ?? 'soft');
    expect(copyIssues([node('a', 'Ship faster \u{1F680}')])[0]!.hard).toBe(false);
    expect(copyIssues([node('a', 'Lorem ipsum dolor sit amet')])[0]!.hard).toBe(true);
    expect(hard('Ship faster \u{1F680}')).toEqual(['emoji']);
    expect(hard('Read more →')).toEqual(['emoji']);
    expect(hard('Lorem ipsum dolor sit amet')).toEqual(['placeholder']);
    expect(hard('Signed, Jane Doe')).toEqual(['placeholder']);
    expect(hard('Elevate your workflow.')).toEqual(['soft']);
    expect(hard('Your customer pays from the message.')).toEqual([]);
  });
});

describe('what an agent reads first', () => {
  it('puts the design core first in the instructions, in order, positive and with an ambition bar', () => {
    // Every MCP client carries the instructions in every session. 3,872 characters before the direction step and the
    // ambition bar; the skill no longer repeats them for Claude Code, which shows the instructions itself.
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(6600);
    expect(INSTRUCTIONS.indexOf(DESIGN_CORE)).toBeLessThan(200);
    const order = ['1. Direction, before the first html_write', '2. System', '3. Build with ambition', '4. Check', 'Canvas structure'].map((s) => INSTRUCTIONS.indexOf(s));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The direction is written out, with the parts a default leaves open, and checked against a similar brief.
    for (const word of ['Audience and job', 'Idea:', 'two real references', 'Type:', 'Colour:', 'named hex values', 'Layout:', 'a similar brief would also get', 'sketch three directions', 'Decide yourself']) expect(DESIGN_CORE).toContain(word);
    // The bar against simple work, held to every section and screen.
    for (const word of ['Show the real thing large', 'Density', 'A layout idea per section', 'States and detail', 'every section and every screen']) expect(DESIGN_CORE).toContain(word);
    // The house looks are named once, with the reason a ban alone does not work.
    // The defaults are named once, with why they read as default and that the direction may choose one.
    for (const word of ['one grotesk with monospace labels', 'cream with terracotta', 'hairline-ruled rows', 'first thing a model reaches for', 'fine when the direction chose it']) expect(DESIGN_CORE).toContain(word);
    // Capabilities, not prohibitions: the means are named.
    for (const word of ['palette_suggest', 'kit_use', 'icon_insert', 'motion_preset', 'interaction_set', 'image_filter', 'art director']) expect(DESIGN_CORE).toContain(word);
    for (const word of ['design_review', 'scored rubric', 'hard findings, the objective defects', 'Advisory findings', 'guide_get design', 'design_knowledge action skill', 'not a design: recompose']) expect(INSTRUCTIONS).toContain(word);
  });

  it('does not repeat the instructions in the skill for a client that shows them, and carries the core for one that may not', () => {
    const claude = skillText('claude-code'), codex = skillText('codex');
    expect(claude).not.toContain(DESIGN_CORE);
    expect(claude).toContain('The bogen server instructions give the order');
    expect(codex).toContain(DESIGN_CORE);
    for (const text of [claude, codex]) {
      expect(text).toContain('## Worked examples, each a default and a decision made for the subject');
      expect(text).toContain('## Writing copy');
      expect(text).toContain('wait_for_event');
    }
    // 7,417 characters before, with the instructions inside.
    expect(claude.length).toBeLessThan(6500);
    expect(codex.length).toBeLessThan(10400);
  });

  it('gives worked examples as a default and a decision, from subjects of their own', () => {
    const examples = DESIGN_EXAMPLES.split('\n').slice(1);
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const line of examples) expect(line, line).toMatch(/Default: .+ Decided/);
    expect(GUIDES.design).toContain(DESIGN_EXAMPLES);
    expect(GUIDES.design).toContain('A direction, written out');
  });

  it('opens every discipline skill with what strong work holds, before its decisions, and carries the rubric', () => {
    for (const id of DESIGN_PLAYBOOKS.map((p) => p.id)) {
      const skill = disciplineSkill(id);
      const at = ['## What strong looks like', '## Brief and scope', '## Decisions', '## Review and repair', '## Rubric', '## What often reads as default', '## Completion'].map((h) => skill.indexOf(h));
      expect(at.every((i) => i > 0), id).toBe(true);
      expect([...at].sort((a, b) => a - b), id).toEqual(at);
      expect(playbook(id).ambition.length, id).toBeGreaterThanOrEqual(3);
      for (const line of playbook(id).ambition) expect(skill, id).toContain(line);
      for (const c of RUBRIC) expect(skill, id).toContain(`- ${c.id}: ${c.question}`);
      // 13,051 to 13,343 characters before; the bar and the loop live in the instructions now, not in every skill.
      expect(skill.length, id).toBeLessThan(10700);
    }
    expect(DESIGN_WORKFLOW.bar[0]).toContain('Direction first');
    expect(DESIGN_WORKFLOW.sequence[0]).toContain('Sketch three directions');
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

  it('tells the design guide the lines the checks draw, hard and soft, and the rubric', () => {
    expect(GUIDES.design).toContain('more than 2 font families');
    expect(GUIDES.design).toContain('Hard findings are objective defects');
    expect(GUIDES.design).toContain('design_lint, advisory:');
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

    it('asks for the direction when a screen is made, and names the format\'s discipline', async () => {
      const agent = await connectAgent(h.base, 'starter');
      const file = (await call(agent, 'file_create', { name: 'Formats' })).id;
      const web = await call(agent, 'artboard_create', { file_id: file, name: 'Page', width: 1440 });
      expect(web.next).toContain('Before the first html_write: write the direction');
      expect(web.next).not.toContain('design_knowledge');
      const ad = await call(agent, 'artboard_create', { file_id: file, name: 'Ad', preset: 'Social portrait' });
      expect(ad.next).toContain('discipline social');
      expect((await call(agent, 'artboard_create', { file_id: file, name: 'Phone', width: 390 })).next).toContain('discipline mobile-apps');
      await agent.close();
    });

    it('reach design_review and hold the rubric of design_verify to account, with or without a browser', async () => {
      const agent = await connectAgent(h.base, 'designer');
      const file = (await call(agent, 'file_create', { name: 'Guidance' })).id;
      const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Landing', width: 1440 })).id;
      // Without the photo section, so that nothing is fetched.
      await call(agent, 'html_write', { file_id: file, target_id: board, html: GENERATED.split('<section data-name="Photo"')[0]! });
      const review = await call(agent, 'design_review', { file_id: file, node_id: board });
      const found = review.observations.filter((o: any) => o.rule).map((o: any) => o.rule);
      // One grotesk with a monospace face is reported as the pairing, not again as decorative monospace.
      for (const rule of ['grotesk-mono', 'caps-label', 'loud-type', 'primary-actions', 'glow', 'tilt', 'window-chrome', 'pattern-background', 'default-gradient', 'boxes', 'nested-boxes']) expect(found, rule).toContain(rule);

      const unscored = await call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites' });
      expect(unscored.rubric.state).toBe('missing');
      expect(unscored.rubric.open).toHaveLength(8);
      expect(unscored.automated.findings.some((f: any) => f.rule === 'craft:glow' && f.criterion === 'originality')).toBe(true);
      // The generated look is advisory: it neither blocks nor caps, it says why, and a kept choice is recorded.
      const flattering = await call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites', rubric: scores(5) });
      expect(flattering.rubric.blocking).toEqual([]);
      const advisory: string[] = flattering.rubric.advisory.map((a: any) => a.check);
      expect(advisory).toEqual(expect.arrayContaining(['glow', 'tilt', 'window-chrome', 'pattern-background', 'default-gradient', 'grotesk-mono', 'caps-label', 'boxes']));
      expect(flattering.rubric.advisory.every((a: any) => a.why.length > 20)).toBe(true);
      expect(flattering.rubric.capped.map((c: any) => c.criterion)).not.toEqual(expect.arrayContaining(['originality']));
      expect(flattering.rubric.next).toContain('Advisory, your call');
      const kept = await call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites', rubric: scores(3), kept: [{ check: 'glow', reason: 'The brief asks for a parody of a 2023 AI landing page.' }] });
      expect(kept.rubric.advisory.find((a: any) => a.check === 'glow').kept).toContain('parody');
      expect(kept.rubric.kept).toHaveLength(1);
      await expect(call(agent, 'design_verify', { file_id: file, node_id: board, discipline: 'websites', rubric: scores(3), kept: [{ check: 'glow', reason: 'I like it' }] })).rejects.toThrow();
      expect(kept.rubric.state).not.toBe('blocked');
      expect((await call(agent, 'design_knowledge', { action: 'rubric' })).rubric).toHaveLength(8);
      await agent.close();
    }, 120_000);
  });
});
