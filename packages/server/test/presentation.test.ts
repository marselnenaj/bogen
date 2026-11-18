import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCKUP_ATTR, PATTERN_ATTR } from '@bogen/core';
import { SLIDE_ATTR } from '../src/templates/brand-presentation.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const story = {
  insight: 'People do not run out of seeds. They run out of reasons to save them.',
  idea: 'Borrow a season.',
  idea_line: 'Every packet goes out in spring and comes back in autumn.',
  rationale: { logo: 'The o is a tray cell.', colour: 'Kraft and loam come from the packet and the soil.', type: 'A catalogue serif.', device: 'Cells fill from the bottom.', motion: 'Growth first, logo last.', logo_story: 'A planting cell.', voice: 'Like a packet.' },
  campaign_lines: ['Twelve seeds out. Four hundred back.', 'Sow in March. Return in October.'],
  social: { posts: [{ headline: 'Sow two per cell.', caption: 'Half a finger deep.' }, { headline: 'Bring back a handful.', caption: 'Dry them for a week.' }, { headline: 'Open Saturdays.', caption: 'The blue door.' }], stories: ['Borrow a season.'] },
  voice: { principles: [{ name: 'Say when', line: 'A month, a depth or a number.' }] },
  motion_rule: 'Cells fill in 120 ms steps; with reduced motion they show at once.',
  proof_points: ['It asks for one thing back.'],
  next_steps: [{ when: 'March', what: 'First lending day' }],
  close: 'See you in October.',
};

describe('brand_presentation', () => {
  let h: Harness;
  let fileId: string;
  beforeAll(async () => {
    h = await startServer();
    const agent = await connectAgent(h.base, 'deck-agent');
    const brand = await call(agent, 'brand_create', { name: 'Loam' });
    await call(agent, 'brand_update', { brand_id: brand.id, items: [
      { section: 'colors', name: 'Kraft', role: 'ground', value: '#e8dcc2', token: 'kraft' },
      { section: 'colors', name: 'Loam', role: 'ink', value: '#2a2019', token: 'loam' },
      { section: 'colors', name: 'Stamp', role: 'action', value: '#2b3cae', token: 'stamp' },
      { section: 'colors', name: 'Card', role: 'action-ink', value: '#f6f1e4', token: 'card' },
      { section: 'devices', name: 'Seed tray', spec: { cell: 'circle', fill: 'gradient', angle: 90, colors: ['var(--stamp)'] } },
    ] });
    fileId = (await call(agent, 'file_create', { name: 'Deck' })).id;
    await call(agent, 'brand_link', { brand_id: brand.id, file_id: fileId });
    await agent.close();
  }, 60_000);
  afterAll(() => h.cleanup());

  it('lays out the deck and the book from the brand and the story, without placeholders', async () => {
    const agent = await connectAgent(h.base, 'deck-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const out = await call(agent, 'brand_presentation', { story, output: 'both' });
    const [deck, book] = out.outputs;
    expect(deck.boards.length).toBeGreaterThan(18);
    // No photos, no contact, no email: those slides are left out and named.
    expect(deck.skipped.map((s: { slide: string }) => s.slide)).toEqual(expect.arrayContaining(['Where we started', 'Photography', 'Print and email']));
    expect(deck.check.findings.filter((f: { severity: string }) => f.severity === 'hard')).toEqual([]);
    expect(book.boards.length).toBeGreaterThanOrEqual(5);
    const doc = (await h.server.rooms.get(fileId)).doc;
    const all = doc.getChildren(deck.page_id);
    expect(all.every((b) => b.attrs?.[SLIDE_ATTR])).toBe(true);
    const nodes = all.flatMap((b) => doc.descendants(b.id));
    // Placements became mockups and tiles of live applications; devices stayed editable patterns.
    expect(nodes.some((n) => n.attrs?.[MOCKUP_ATTR])).toBe(true);
    expect(nodes.some((n) => n.attrs?.[PATTERN_ATTR])).toBe(true);
    const apps = all.filter((b) => b.name.startsWith('App · '));
    expect(apps.length).toBeGreaterThan(5);
    expect(apps.every((a) => a.component)).toBe(true);
    expect(nodes.some((n) => /lorem|placeholder/i.test(n.text ?? ''))).toBe(false);
    const check = await call(agent, 'presentation_check', { page_id: deck.page_id });
    expect(check.slides).toBe(deck.boards.length);
    expect((await callRaw(agent, 'presentation_check', { page_id: 'nope' })).isError).toBe(true);
    await agent.close();
  }, 120_000);
});
