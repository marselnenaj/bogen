import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

interface Issue { rule: string; nodeId: string; message: string; fix?: { style: Record<string, string>; safe: boolean } }

/** design_lint's spacing rhythm and type hierarchy, through MCP as an agent calls it. */
describe('design_lint rhythm and hierarchy', () => {
  let h: Harness;
  let agent: Client;
  let file: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'linter');
    file = (await call(agent, 'file_create', { name: 'Lint' })).id;
    await call(agent, 'tokens_set', { file_id: file, tokens: [
      { name: 'space-2', kind: 'spacing', value: '8px' },
      { name: 'space-4', kind: 'spacing', value: '1rem' },
      { name: 'space-6', kind: 'spacing', value: '24px' },
      { name: 'text-base', kind: 'font-size', value: '16px' },
      { name: 'text-xl', kind: 'font-size', value: '24px' },
    ] });
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const lint = async (node_id: string, fix = false) => call(agent, 'design_lint', { file_id: file, node_id, fix });
  const of = (issues: Issue[], rule: string, id?: string) => issues.filter((i) => i.rule === rule && (!id || i.nodeId === id));

  it('finds spacing off the scale and siblings spaced unlike the rest, and fixes the safe ones in one step', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Rhythm', width: 800 })).id;
    const [section] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <section style="display:flex;flex-direction:column;gap:18px;padding:24px 30px">
        <div style="display:flex;gap:var(--space-4)">
          <article style="padding:24px">One</article><article style="padding:24px">Two</article>
          <article style="padding:24px">Three</article><article style="padding:22px">Four</article>
        </div>
      </section>` })).ids;
    const row = (await call(agent, 'layer_get', { file_id: file, node_id: section })).children[0].id;
    const cards: string[] = (await call(agent, 'layer_get', { file_id: file, node_id: row })).children.map((c: { id: string }) => c.id);

    const before = await lint(section);
    const spacing = of(before.issues, 'spacing');
    const gap = of(spacing, 'spacing', section).find((i) => i.message.startsWith('gap'))!;
    expect(gap.message).toBe("gap is 18px, off the file's spacing scale (--space-2 8px, --space-4 16px, --space-6 24px). Use var(--space-4).");
    expect(gap.fix).toEqual({ style: { gap: 'var(--space-4)' }, safe: true });
    // 30px is 6px from the nearest step: a suggestion, not a safe fix.
    const padding = of(spacing, 'spacing', section).find((i) => i.message.startsWith('padding'))!;
    expect(padding.fix).toEqual({ style: { padding: 'var(--space-6) var(--space-6)' }, safe: false });
    expect(padding.message).toContain('or add a token if this step is meant');
    // The odd card out, against the three that agree.
    const odd = of(spacing, 'spacing', cards[3]).find((i) => i.message.includes('siblings'))!;
    expect(odd.message).toBe(`padding is 22px, where 3 of its 3 siblings of the same kind use 24px (${cards.slice(0, 3).join(', ')}). Make it 24px, or make the difference bigger if it is meant.`);
    expect(odd.fix).toEqual({ style: { padding: '24px' }, safe: true });
    // Off the scale is the finding; off the 4px grid would say the same again.
    expect(of(before.issues, 'grid', section)).toEqual([]);
    expect(before.counts.spacing).toBe(of(before.issues, 'spacing').length);
    // A value that equals a token can be written as the token with nothing moving.
    expect(of(before.issues, 'token', cards[0])[0]!.fix).toEqual({ style: { padding: 'var(--space-6)' }, safe: true });

    const fixed = await lint(section, true);
    expect(fixed.fixed.map((f: { node_id: string; style: Record<string, string> }) => `${f.node_id} ${JSON.stringify(f.style)}`).sort()).toEqual([
      `${cards[0]} {"padding":"var(--space-6)"}`, `${cards[1]} {"padding":"var(--space-6)"}`, `${cards[2]} {"padding":"var(--space-6)"}`,
      `${cards[3]} {"padding":"var(--space-6)"}`, `${section} {"gap":"var(--space-4)"}`,
    ].sort());
    const style = async (id: string) => (await call(agent, 'layer_get', { file_id: file, node_id: id })).style;
    expect((await style(section)).gap).toBe('var(--space-4)');
    expect((await style(section)).padding).toBe('24px 30px');
    expect((await style(cards[3]!)).padding).toBe('var(--space-6)');
    // What is left after fixing is only what needs a person's eye.
    expect(of(fixed.issues, 'spacing').map((i: Issue) => i.nodeId)).toEqual([section]);
    expect(of(fixed.issues, 'token')).toEqual([]);

    // All of it was one step.
    await call(agent, 'agent_undo', { file_id: file });
    expect((await style(section)).gap).toBe('18px');
    expect((await style(cards[3]!)).padding).toBe('22px');
    expect((await style(cards[0]!)).padding).toBe('24px');
  }, 60_000);

  it('finds headings that do not stand out, levels out of order, and too many sizes', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Type', width: 800 })).id;
    const [flat, body, h1, h3] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <h2 style="font-size:16px;margin:0">Pricing</h2>
      <p style="font-size:16px;margin:0">Body copy long enough to be what most of the words on this board are set in.</p>
      <h1 style="font-size:28px;margin:0">Plans</h1>
      <h3 style="font-size:36px;margin:0">Details</h3>` })).ids;
    const report = await lint(board);
    const hierarchy = of(report.issues, 'hierarchy');
    expect(of(hierarchy, 'hierarchy', flat)[0]).toMatchObject({
      message: 'This h2 is 16px, no larger than the body text at 16px, so it does not read as a heading. Make it var(--text-xl) (24px) or larger, or use a body tag if it is not a heading.',
      fix: { style: { fontSize: 'var(--text-xl)' }, safe: false },
    });
    expect(of(hierarchy, 'hierarchy', h3)[0]!.message).toBe(`This h3 is 36px, larger than the h1 "Plans" (${h1}) at 28px. Levels should get smaller from h1 to h6: swap the tags or the sizes.`);
    expect(of(hierarchy, 'hierarchy', body)).toEqual([]);
    expect(of(hierarchy, 'hierarchy', h1)).toEqual([]);
    // A change of size is for the agent to decide: fix true leaves it.
    expect((await lint(board, true)).fixed.filter((f: { rule: string }) => f.rule === 'hierarchy')).toEqual([]);

    const crowded = (await call(agent, 'artboard_create', { file_id: file, name: 'Crowded', width: 600 })).id;
    const sizes = [12, 13, 14, 16, 16, 16, 18, 20, 24];
    const ids = (await call(agent, 'html_write', { file_id: file, target_id: crowded, html: sizes.map((s) => `<p style="font-size:${s}px;margin:0">Size ${s}</p>`).join('') })).ids;
    const many = of((await lint(crowded)).issues, 'hierarchy', crowded);
    expect(many).toHaveLength(1);
    expect(many[0]!.message).toBe(`This artboard uses 7 font sizes (12, 13, 14, 16, 18, 20, 24px). 6 or fewer make a clear hierarchy; merge 12px and 13px into 14px (${ids[0]}, ${ids[1]}), using the font-size tokens.`);
  }, 60_000);

  it('reads contrast through layered backgrounds, shared between many texts, and skips text over images', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Contrast', width: 800, background: '#000000' })).id;
    // A little white over black is a dark grey: grey and faded text on it fail, white passes. Each row repeats, as a big page does.
    const row = `<div style="display:flex;gap:8px;padding:8px;background:rgba(255,255,255,0.15)">
      <span style="color:#777777;font-size:16px">Grey</span><span style="color:#ffffff;font-size:16px">White</span>
      <span style="color:#ffffff;font-size:16px;opacity:0.3">Faded</span></div>`;
    const ids = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `${row.repeat(30)}
      <div style="background-image:linear-gradient(#000,#fff);padding:8px"><span style="color:#808080">On a gradient</span></div>` })).ids as string[];
    const issues = (await call(agent, 'design_lint', { file_id: file, node_id: board, limit: 100 })).issues as Issue[];
    const contrast = of(issues, 'contrast');
    const kids = await Promise.all(ids.slice(0, 30).map(async (id) => (await call(agent, 'layer_get', { file_id: file, node_id: id })).children as { id: string; name: string }[]));
    const named = (name: string) => kids.map((k) => k.find((c) => c.name === name)!.id);
    expect(contrast.map((i) => i.nodeId).sort()).toEqual([...named('Grey'), ...named('Faded')].sort());
    expect(contrast[0]!.message).toMatch(/^Text contrast is \d\.\d\d:1, under WCAG AA 4.5:1/);
  }, 60_000);
});

/** What a captured app brings: tokens of every kind filed as spacing, scroll lists, a canvas, screen-reader labels, controls that are off. */
describe('design_lint on an app view', () => {
  let h: Harness;
  let agent: Client;
  let file: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'app-linter');
    file = (await call(agent, 'file_create', { name: 'App lint' })).id;
    // As older captures filed them: every length as spacing, the corner first.
    await call(agent, 'tokens_set', { file_id: file, tokens: [
      { name: 'radius', kind: 'spacing', value: '4px' },
      { name: 'space-xs', kind: 'spacing', value: '4px' },
      { name: 'space-sm', kind: 'spacing', value: '8px' },
      { name: 'text-sm', kind: 'spacing', value: '12px' },
      { name: 'row', kind: 'spacing', value: '26px' },
      { name: 'corner', kind: 'spacing', value: '6px' },
    ] });
  });
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const lint = async (node_id: string) => call(agent, 'design_lint', { file_id: file, node_id });
  const of = (issues: Issue[], rule: string, id?: string) => issues.filter((i) => i.rule === rule && (!id || i.nodeId === id));

  it('offers only steps of space for space: not a corner, a type size or the size of a control', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Scale', width: 600 })).id;
    const [row, chip, tight] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <div style="display:flex;gap:6px;padding:12px">One</div>
      <div style="margin-right:4px;border-radius:var(--corner)">Two</div>
      <div style="padding:26px">Three</div>` })).ids;
    const issues = (await lint(board)).issues as Issue[];
    const gap = of(issues, 'spacing', row).find((i) => i.message.startsWith('gap'))!;
    expect(gap.message).toBe("gap is 6px, off the file's spacing scale (--space-xs 4px, --space-sm 8px). Use var(--space-xs).");
    expect(of(issues, 'spacing', row).find((i) => i.message.startsWith('padding'))!.message).toContain('Use var(--space-sm)');
    expect(of(issues, 'token', chip).map((i) => i.message)).toEqual(['marginRight is 4px, which equals the token --space-xs. Use var(--space-xs).']);
    expect(issues.filter((i) => /--(radius|text-sm|row|corner)\b/.test(i.message))).toEqual([]);
    expect(of(issues, 'token', tight)).toEqual([]);
  }, 60_000);

  it('leaves out what a scroll list or a canvas hides, and still finds what is cut', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Clip', width: 600 })).id;
    const ids = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <div style="height:60px;overflow:auto">${'<div style="height:24px">Row</div>'.repeat(10)}</div>
      <div style="position:relative;width:200px;height:100px;overflow:hidden">
        <div style="position:absolute;left:2000px;top:0;width:300px;height:300px">Far away</div>
        <div style="position:absolute;left:150px;top:0;width:900px;height:50px">Half in view</div>
      </div>
      <div style="position:relative;width:100px;height:100px;overflow:hidden">
        <div style="position:absolute;left:-300px;top:0;width:40px;height:40px">Out of view</div>
        <div style="position:absolute;left:80px;top:0;width:60px;height:40px">Cut</div>
      </div>` })).ids as string[];
    const kids = async (id: string) => ((await call(agent, 'layer_get', { file_id: file, node_id: id })).children as { id: string }[]).map((c) => c.id);
    const [list, canvas, card] = ids;
    const report = await lint(board);
    const overflow = of(report.issues, 'overflow');
    const rows = await kids(list!);
    const [, cut] = await kids(card!);
    const inCanvas = await kids(canvas!);
    expect(overflow.filter((i) => rows.includes(i.nodeId) || inCanvas.includes(i.nodeId))).toEqual([]);
    expect(overflow.map((i) => i.nodeId)).toEqual([cut]);
    expect(overflow[0]).toMatchObject({ message: 'Clipped by its parent by 40px on the right.', severity: 'hard' });
  }, 60_000);

  it('takes up to 2px of an inline run past its line as a glyph overhang', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Overhang', width: 600, background: '#000000' })).id;
    const [hang, past] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <p style="width:max-content;color:#fff"><span style="position:relative;left:2px">Quoted words</span></p>
      <p style="width:max-content;color:#fff"><span style="position:relative;left:8px">Quoted words</span></p>` })).ids as string[];
    const issues = of((await lint(board)).issues as Issue[], 'overflow');
    const inner = async (id: string) => ((await call(agent, 'layer_get', { file_id: file, node_id: id })).children as { id: string }[])[0]!.id;
    const [a, b] = [await inner(hang!), await inner(past!)];
    expect(issues.filter((i) => i.nodeId === a)).toEqual([]);
    expect(issues.filter((i) => i.nodeId === b).map((i) => i.message)).toEqual(['Overflows its parent by 8px on the right.']);
  }, 60_000);

  it('takes an ellipsis as shortened on purpose only where the whole text can be read', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Shortened', width: 600, background: '#000000' })).id;
    const [titled, named, bare] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <p title="A long layer name that does not fit" style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#fff">A long layer name that does not fit</p>
      <button aria-label="Another long name that does not fit" style="width:80px;height:28px;color:#fff;background:#000"><span style="display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Another long name that does not fit</span></button>
      <p style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#fff">A third long name that does not fit</p>` })).ids as string[];
    const issues = of((await lint(board)).issues as Issue[], 'overflow');
    const inside = ((await call(agent, 'layer_get', { file_id: file, node_id: named })).children as { id: string }[])[0]!.id;
    expect(issues.filter((i) => i.nodeId === titled || i.nodeId === inside)).toEqual([]);
    expect(issues.filter((i) => i.nodeId === bare).map((i) => i.message)).toEqual(['The text ends in an ellipsis, and nothing gives the rest: set its whole text as the title of the layer or of the control it is in.']);
  }, 60_000);

  it('skips text for screen readers and the contrast of controls that are off', async () => {
    const board = (await call(agent, 'artboard_create', { file_id: file, name: 'Quiet', width: 600, background: '#000000' })).id;
    const [close, cut, off, ariaOff, on] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <button style="position:relative;width:32px;height:32px;color:#fff"><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap">Close the panel</span>X</button>
      <p style="width:40px;overflow:hidden;white-space:nowrap;color:#fff">A long line that does not fit</p>
      <button disabled style="width:80px;height:28px;color:#555;background:#333">Ask</button>
      <div role="button" aria-disabled="true" style="width:80px;height:28px;color:#555;background:#333"><span>Later</span></div>
      <button style="width:80px;height:28px;color:#555;background:#333">Run</button>` })).ids as string[];
    const issues = (await lint(board)).issues as Issue[];
    const label = ((await call(agent, 'layer_get', { file_id: file, node_id: close })).children as { id: string }[])[0]!.id;
    expect(issues.filter((i) => i.nodeId === label)).toEqual([]);
    expect(of(issues, 'overflow', cut).map((i) => i.message)).toEqual(['The text is cut off by its own box.']);
    expect(of(issues, 'contrast').map((i) => i.nodeId)).toEqual([on]);
    expect(of(issues, 'contrast', off)).toEqual([]);
    expect(of(issues, 'contrast', ariaOff)).toEqual([]);
    // The label still names the button for a screen reader.
    const a11y = await call(agent, 'a11y_audit', { file_id: file, node_id: board });
    const named = (a11y.layers as { issues: { node_id: string; rule: string }[] }[]).flatMap((l) => l.issues).filter((i) => i.rule === 'name');
    expect(named.filter((i) => i.node_id === close)).toEqual([]);
  }, 60_000);
});
