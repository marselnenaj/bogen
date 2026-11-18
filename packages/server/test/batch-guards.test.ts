import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * A batch runs its steps on a private copy, where the per-write checks do not see the real file. What it applies must
 * pass the same checks as any write: the branch the session started on, and an open revision's copies.
 */
describe('batch keeps to the checks every write passes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('refuses, in a dry run too, when the file was switched to another branch since the agent started', async () => {
    const builder = await connectAgent(h.base, 'claude');
    const agent = await connectAgent(h.base, 'codex');
    try {
      const file = await call(builder, 'file_create', { name: 'Batch branch pin' });
      await call(builder, 'file_open', { file_id: file.id });
      const board = await call(builder, 'artboard_create', { name: 'Home', width: 800 });
      const section = (await call(builder, 'html_write', { target_id: board.id, html: '<section style="display:flex"><button>Buy</button></section>' })).ids[0] as string;
      await call(agent, 'file_open', { file_id: file.id });
      await call(agent, 'layer_get', { node_id: section });
      await call(builder, 'design_branch_create', { name: 'Warmer' });
      const before = JSON.stringify(await call(agent, 'layer_get', { node_id: section }));
      const steps = [{ tool: 'layer_style', args: { node_ids: [section], style: { opacity: '0.5' } } }];

      const dry = await call(agent, 'batch', { steps, dry_run: true });
      expect(dry).toMatchObject({ ok: false, applied: false, error: expect.stringMatching(/switched to "Warmer"/) });
      const real = await callRaw(agent, 'batch', { steps });
      expect(real.isError).toBe(true);
      expect(real.content[0]!.text).toMatch(/switched to "Warmer"/);
      expect(JSON.stringify(await call(agent, 'layer_get', { node_id: section }))).toBe(before);
    } finally {
      await builder.close();
      await agent.close();
    }
  });

  it('changes only the copies of an open revision', async () => {
    const agent = await connectAgent(h.base, 'claude');
    try {
      const file = await call(agent, 'file_create', { name: 'Batch revision' });
      await call(agent, 'file_open', { file_id: file.id });
      const board = await call(agent, 'artboard_create', { name: 'Home', width: 800 });
      const section = (await call(agent, 'html_write', { target_id: board.id, html: '<section style="display:flex;gap:8px"><p>One</p></section>' })).ids[0] as string;
      const rev = await call(agent, 'revision_start', { intent: 'revise', name: 'Second pass', node_ids: [board.id] });
      const before = JSON.stringify(await call(agent, 'layer_get', { node_id: section }));

      const outside = [{ tool: 'layer_style', args: { node_ids: [section], style: { gap: '40px' } } }];
      expect(await call(agent, 'batch', { steps: outside, dry_run: true })).toMatchObject({ ok: false, applied: false, error: expect.stringMatching(/revision/) });
      const refused = await callRaw(agent, 'batch', { steps: outside });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/revision/);
      expect(JSON.stringify(await call(agent, 'layer_get', { node_id: section }))).toBe(before);

      const copy = rev.artboards[0].layers[section] as string;
      const inside = [{ tool: 'layer_style', args: { node_ids: [copy], style: { gap: '40px' } } }];
      expect(await call(agent, 'batch', { steps: inside, dry_run: true })).toMatchObject({ ok: true, applied: false });
      expect(await call(agent, 'batch', { steps: inside })).toMatchObject({ ok: true, applied: true });
      expect((await call(agent, 'layer_get', { node_id: copy })).style.gap).toBe('40px');
    } finally {
      await agent.close();
    }
  });
});
