import { createDesignBranch, setContentLanguage, switchDesignBranch } from '@bogen/core';
import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('translation tools', () => {
  it('ask only for new and changed text, remember translations, and keep the version in step with its original', async () => {
    h = await startServer();
    const c = await connectAgent(h.base, 'claude');
    try {
      const file = (await call(c, 'file_create', { name: 'Trains' })).id;
      const board = (await call(c, 'artboard_create', { file_id: file, name: 'Home', width: 400, height: 300 })).id;
      const ids = (await call(c, 'html_write', { file_id: file, target_id: board, html: '<h1>Night trains</h1><p>Book a Couchette</p><code>npm i bogen</code>' })).ids as string[];
      // A German version made the way a run makes one: a branch whose design language is German.
      const room = await h.server.rooms.get(file);
      setContentLanguage(room.doc, 'en');
      createDesignBranch(room.doc, { name: 'German (de)', by: 'claude', checkout: true });
      setContentLanguage(room.doc, 'de');
      switchDesignBranch(room.doc, 'main');

      const listed = await call(c, 'translation_status', { file_id: file });
      expect(listed.versions).toEqual([expect.objectContaining({ name: 'German (de)', language: 'de', status: 'include' })]);

      await call(c, 'translation_rules_set', { file_id: file, keep: ['Couchette'] });
      const status = await call(c, 'translation_status', { file_id: file, language: 'de' });
      expect(status.needed.map((n: { source: string }) => n.source).sort()).toEqual(['Book a Couchette', 'Night trains']);

      const applied = await call(c, 'translation_apply', { file_id: file, language: 'de', translations: [{ source: 'Night trains', target: 'Nachtzüge' }, { source: 'Book a Couchette', target: 'Eine Couchette buchen' }] });
      expect(applied).toMatchObject({ stored: 2, filled: 2, still_needed: 0 });

      // The original gets a new line: only that one is asked for.
      await call(c, 'html_write', { file_id: file, target_id: board, html: '<p>Since 1998</p>' });
      const again = await call(c, 'translation_status', { file_id: file, language: 'de' });
      expect(again.needed.map((n: { source: string }) => n.source)).toEqual(['Since 1998']);
      expect(again.behind_original).toBe(true);
      await call(c, 'translation_apply', { file_id: file, language: 'de', translations: [{ source: 'Since 1998', target: 'Seit 1998' }] });

      const branch = listed.versions[0].branch_id;
      const res = await fetch(`${h.base}/api/files/${file}/compare?from=branch:main&to=branch:${branch}`);
      expect(res.status).toBe(200);
      await call(c, 'design_branch_switch', { file_id: file, branch_id: branch });
      const tree = JSON.stringify(await call(c, 'layer_tree', { file_id: file }));
      expect(tree).toContain('Nachtzüge');
      expect(tree).toContain('Seit 1998');
      expect(tree).toContain('npm i bogen');
      void ids;

      // Hidden: nothing is asked for, and the pre-publish check says so before it goes out.
      await call(c, 'translation_rules_set', { file_id: file, language: 'de', status: 'hidden' });
      expect((await call(c, 'translation_status', { file_id: file, language: 'de' })).needed).toEqual([]);
      const checked = await call(c, 'publish_check', { file_id: file, node_id: board, summaries: false });
      expect(checked.findings.map((f: { check: string }) => f.check)).toContain('translation');
    } finally {
      await c.close();
    }
  }, 60_000);
});
