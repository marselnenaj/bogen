import { afterEach, expect, it } from 'vitest';
import { updateBrandBookChapter } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';
let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); });
it('creates a canonical book, edits through MCP, detects conflicts and protects human review', async () => {
  h = await startServer(); const c = await connectAgent(h.base, 'book-agent');
  try {
    const { id } = await call(c, 'brand_create', { name: 'Brandbook fixture' });
    const outline = await call(c, 'brand_book_get', { brand_id: id });
    expect(outline.chapters).toHaveLength(16); expect(outline.readiness.ready).toBe(false);
    const input = { brand_id: id, chapter: 'strategy', markdown: 'A concrete proposal.', source: 'Owner brief', questions: '', status: 'draft', expected_revision: null };
    const a = await call(c, 'brand_book_update', input);
    expect((await callRaw(c, 'brand_book_update', input)).isError).toBe(true);
    // The person confirms in the brand document itself, as the editor does: there is no HTTP route that writes chapters.
    const room = await h.server.brands.room(id);
    const confirm = (revision: string | null) => updateBrandBookChapter(room.doc, { id: 'strategy', markdown: input.markdown, source: input.source, questions: '', status: 'confirmed', expectedRevision: revision }, 'owner', true);
    expect(() => confirm(null)).toThrow('changed');
    const b = { chapter: confirm(a.chapter.revision) };
    const url = `${h.base}/api/brands/${id}/book`;
    expect((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405);
    expect((await fetch(url).then((r) => r.json())).outline).toHaveLength(16);
    const refused = await callRaw(c, 'brand_book_update', { ...input, expected_revision: b.chapter.revision });
    expect(refused.isError).toBe(true);
    const read = await call(c, 'brand_book_get', { brand_id: id, chapter: 'strategy' });
    expect(read.chapter.status).toBe('confirmed');
    const md = await fetch(`${h.base}/api/brands/${id}/guide.md`).then((r) => r.text());
    expect(md).toContain('A concrete proposal.');
    expect((await call<any[]>(c, 'file_list')).length).toBe(0);
  } finally { await c.close(); }
});

it('reuses an existing visual system and coalesces repeated create clicks', async () => {
  h = await startServer(); const c = await connectAgent(h.base, 'book-agent');
  try {
    const { id } = await call(c, 'brand_create', { name: 'One identity' });
    const url = `${h.base}/api/brands/${id}/system-file`;
    const results = await Promise.all([fetch(url, { method: 'POST' }), fetch(url, { method: 'POST' })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const [a, b] = await Promise.all(results.map((r) => r.json()));
    expect(a.file_id).toBe(b.file_id);
    expect((await call<any[]>(c, 'file_list'))).toHaveLength(1);
    const again = await fetch(url, { method: 'POST' }).then((r) => r.json());
    expect(again.file_id).toBe(a.file_id);
    expect((await call<any[]>(c, 'file_list'))).toHaveLength(1);
  } finally { await c.close(); }
});
