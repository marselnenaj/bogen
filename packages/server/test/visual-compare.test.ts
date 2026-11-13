import { afterEach, describe, expect, it } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const get = async (path: string) => {
  const res = await fetch(h!.base + path);
  return { status: res.status, body: await res.json() as any };
};

describe('visual compare of a branch before it merges', () => {
  it('lists the screens that change, renders one screen before and after, and the agent sees the same', async () => {
    h = await startServer();
    const c = await connectAgent(h.base, 'claude');
    try {
      const file = (await call(c, 'file_create', { name: 'Compare' })).id;
      const hero = (await call(c, 'artboard_create', { file_id: file, name: 'Hero', width: 400, height: 300 })).id;
      const title = (await call(c, 'html_write', { file_id: file, target_id: hero, html: '<h1 style="margin:0;padding:24px;background:#fff">Night trains</h1>' })).ids[0];
      const about = (await call(c, 'artboard_create', { file_id: file, name: 'About', width: 400, height: 300 })).id;
      await call(c, 'html_write', { file_id: file, target_id: about, html: '<p>Since 1998</p>' });
      const branch = (await call(c, 'design_branch_create', { file_id: file, name: 'Darker hero' })).branch.id;
      await call(c, 'layer_style', { file_id: file, node_ids: [title], style: { background: '#111', color: '#fff' } });
      await call(c, 'design_branch_switch', { file_id: file, branch_id: 'main' });

      const preview = await get(`/api/files/${file}/design-branches/${branch}/merge`);
      expect(preview.status).toBe(200);
      expect(preview.body.screens).toEqual([expect.objectContaining({ id: hero, name: 'Hero', change: 'changed', layers: 1 })]);
      expect(preview.body.compare).toEqual({ from: 'branch:main', to: `merge:${branch}`, branch: `branch:${branch}` });

      const pageId = preview.body.screens[0].pageId;
      const render = await get(`/api/files/${file}/compare/render?from=${encodeURIComponent(preview.body.compare.from)}&to=${encodeURIComponent(preview.body.compare.to)}&page=${pageId}&screen=${hero}`);
      expect(render.status).toBe(200);
      expect(render.body.before).toBeTruthy();
      expect(render.body.after).toBeTruthy();
      expect(render.body.percent).toBeGreaterThan(5);
      // The other screen did not change, and its pictures agree.
      const same = await get(`/api/files/${file}/compare/render?from=branch:main&to=merge:${branch}&page=${pageId}&screen=${about}`);
      expect(same.body.percent).toBe(0);

      const tool = await callRaw(c, 'design_branch_compare', { file_id: file, branch_id: branch, screen_id: hero });
      const text = JSON.parse((tool.content as { type: string; text?: string }[])[0]!.text!);
      expect(text).toMatchObject({ branch: 'Darker hero', into: 'Main', screens: [{ id: hero, change: 'changed' }], screen: { id: hero } });
      expect(text.screen.different_percent).toBeGreaterThan(5);
      expect((tool.content as { type: string }[]).some((x) => x.type === 'image')).toBe(true);
      // Comparing changed nothing: main is still checked out and has its light hero.
      expect((await call(c, 'design_branch_list', { file_id: file })).current).toBe('main');
    } finally {
      await c.close();
    }
  }, 60_000);

  it('compares a proposal with its original through the same pictures', async () => {
    h = await startServer();
    const c = await connectAgent(h.base, 'claude');
    try {
      const file = (await call(c, 'file_create', { name: 'Proposal' })).id;
      const board = (await call(c, 'artboard_create', { file_id: file, name: 'Card', width: 300, height: 200 })).id;
      await call(c, 'html_write', { file_id: file, target_id: board, html: '<p style="margin:0;padding:20px">Hello</p>' });
      const made = await call(c, 'proposal_create', { file_id: file, node_id: board, note: 'Bolder' });
      const copy = made.proposal_id ?? made.id ?? made.proposals?.[0]?.id ?? made.ids?.[0];
      expect(copy).toBeTruthy();
      const res = await get(`/api/files/${file}/compare/layers?a=${board}&b=${copy}`);
      expect(res.status).toBe(200);
      expect(res.body.before).toBeTruthy();
      expect(res.body.after).toBeTruthy();
      expect(res.body.percent).toBe(0);
    } finally {
      await c.close();
    }
  }, 60_000);
});
