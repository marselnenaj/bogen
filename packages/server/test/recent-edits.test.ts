import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BogenDoc, Y, encodeKey, type ChangeOp } from '@bogen/core';
import { BogenServer } from '../src/http/server.ts';
import { editLocations, rememberEdit, toRecentEdit } from '../src/recent-edits.ts';
import type { ChangeEntry } from '../src/timeline.ts';

const servers = new Set<BogenServer>(), homes: string[] = [];
afterEach(async () => { for (const s of servers) await s.close(); servers.clear(); for (const h of homes) rmSync(h, { recursive: true, force: true }); homes.length = 0; });
function change(id: string, at = 1, ops: ChangeOp[] = []): ChangeEntry { return { id, at, ops, seq: at, device: 'fixture', deviceName: 'Fixture', source: 'person', actor: 'Designer', summary: 'Update screen', layers: [], layerCount: 0 }; }
function fixture() {
  const doc = new BogenDoc(), a = doc.createPage('Overview'), b = doc.createPage('Checkout');
  const boardA = doc.insert(a, { type: 'frame', name: 'Landing', artboard: true });
  const boardB = doc.insert(b, { type: 'frame', name: 'Payment', artboard: true });
  const textA = doc.insert(boardA, { type: 'text', name: 'Headline', text: 'Welcome' });
  const textB = doc.insert(boardB, { type: 'text', name: 'Pay', text: 'Pay now' });
  return { doc, a, b, boardA, boardB, textA, textB };
}
async function boot(home = mkdtempSync('/tmp/bogen-recent-test-')) {
  if (!homes.includes(home)) homes.push(home);
  const s = new BogenServer({ home, port: 0, insecureAllowAnyHost: true, thumbnails: false, timeline: { coalesceMs: 5 } }); await s.listen(); servers.add(s); return s;
}
describe('recent edit navigation metadata', () => {
  it('finds each affected page and screen, including off-page nested text, without scanning all nodes', () => {
    const f = fixture(); const ops = [f.textA, f.textB].map(id => ({ p: ['nodes', id, 'text'], a: 'New' }));
    expect(editLocations(f.doc, ops)).toEqual({ locationCount: 2, locations: [{ pageId: f.a, pageName: 'Overview', screenId: f.boardA, screenName: 'Landing' }, { pageId: f.b, pageName: 'Checkout', screenId: f.boardB, screenName: 'Payment' }] });
  });
  it('keeps the page/screen of a deleted layer from its before-value and does not invent a location for token changes', () => {
    const f = fixture(); const before = encodeKey(f.doc, 'nodes', f.textB); f.doc.delete([f.textB]);
    expect(editLocations(f.doc, [{ p: ['nodes', f.textB], b: before }]).locations[0]?.pageId).toBe(f.b);
    expect(editLocations(f.doc, [{ p: ['tokens', 'ink'], a: '#111' }])).toEqual({ locations: [], locationCount: 0 });
  });
  it('backfills older layer-only records from the current document and bounds replicated metadata', () => {
    const f = fixture(), entry = { ...change('old'), layers: [f.textB] }; delete entry.ops;
    expect(toRecentEdit(entry, f.doc)?.locations[0]?.screenName).toBe('Payment');
    expect(toRecentEdit({ ...change('bad'), at: NaN })).toBeNull();
    expect(toRecentEdit({ ...change('bounded'), locations: Array.from({ length: 100 }, (_, i) => ({ pageId: String(i), pageName: 'x'.repeat(300) })) })?.locations).toHaveLength(16);
  });
  it('keeps another affected page visible when a large first page exceeds the location limit', () => {
    const f = fixture(), ids = Array.from({ length: 60 }, (_, i) => f.doc.insert(f.a, { type: 'frame', artboard: true, name: `Screen ${i}` }));
    const ops = [...ids, f.textB].map(id => ({ p: ['nodes', id, 'style', 'color'], a: '#222' }));
    const visitAllNodes = vi.spyOn(f.doc.nodes, 'forEach');
    const result = editLocations(f.doc, ops);
    expect(result.locations).toHaveLength(16); expect(result.locationCount).toBe(61); expect(result.locations[1]?.pageId).toBe(f.b); expect(visitAllNodes).not.toHaveBeenCalled();
  });
  it('persists a bounded chronological index, replacing duplicate records without changing the design', async () => {
    const s = await boot(); const file = s.createFile('Fixture'); const room = await s.rooms.get(file.id); const before = Buffer.from(Y.encodeStateAsUpdate(room.doc.y)).toString('base64');
    for (let i = 0; i < 55; i++) rememberEdit(s.storage, file.id, change('fixture:'+i, i));
    rememberEdit(s.storage, file.id, change('fixture:54', 54));
    const rows = s.storage.get(file.id)!.recentEdits!; expect(rows).toHaveLength(40); expect(rows[0]!.id).toBe('fixture:54'); expect(rows.at(-1)!.at).toBe(15);
    expect(Buffer.from(Y.encodeStateAsUpdate(room.doc.y)).toString('base64')).toBe(before);
    await s.close(); servers.delete(s); const next = await boot(s.options.home); expect(next.storage.get(file.id)?.recentEdits).toHaveLength(40);
    const hydrate = vi.spyOn(next.rooms, 'get'); const list = await (await fetch(next.localUrl()+'/api/files')).json() as { id: string; lastEdit: { id: string } }[];
    const recent = await (await fetch(next.localUrl()+`/api/files/${file.id}/recent-edits`)).json() as unknown[];
    expect(list.find(f => f.id === file.id)?.lastEdit.id).toBe('fixture:54'); expect(recent).toHaveLength(40); expect(hydrate).not.toHaveBeenCalled();
  });
  it('records the page automatically for actual transactions and retains it across reload', async () => {
    const s = await boot(), file = s.createFile('Live fixture'), room = await s.rooms.get(file.id), doc = room.doc;
    const page = doc.createPage('Agent work'), board = doc.insert(page, { type: 'frame', name: 'Latest screen', artboard: true });
    doc.transact(() => doc.updateStyle(board, { width: '430px' }), 'person:Fixture'); await s.timeline.flush(file.id); await new Promise(r => setTimeout(r, 20));
    expect(s.storage.get(file.id)?.recentEdits?.[0]?.locations[0]?.pageId).toBe(page);
    const timeline = await s.timeline.all(file.id); expect(timeline.at(-1)?.locations?.[0]?.screenName).toBe('Latest screen');
  });
  it('indexes location metadata received from a paired device without opening that file', async () => {
    const s = await boot(), file = s.createFile('Remote fixture');
    await s.timeline.receive(file.id, 'fixture-remote', [{ ...change('fixture-remote:1'), device: 'fixture-remote', seq: 1, locations: [{ pageId: 'remote-page', pageName: 'Remote work' }], locationCount: 1 }]);
    expect(s.rooms.peek(file.id)).toBeUndefined(); expect(s.storage.get(file.id)?.recentEdits?.[0]?.locations[0]?.pageName).toBe('Remote work');
  });
  it('backfills from a bounded log tail, skipping an oversized older record and retaining recent valid records', async () => {
    const s = await boot(), file = s.createFile('Large old log'), dir = join(s.storage.home, 'history', file.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'changes-fixture-remote.jsonl'), [JSON.stringify({ ...change('large', 1), padding: 'x'.repeat(900_000) }), JSON.stringify(change('recent-a', 2)), JSON.stringify(change('recent-b', 3))].join('\n')+'\n');
    expect((await s.timeline.recent(file.id)).map(e => e.id)).toEqual(['recent-a', 'recent-b']); expect(s.rooms.peek(file.id)).toBeUndefined();
  });
  it('coalesces a replicated batch into one file-list notification instead of flooding Home', async () => {
    const s = await boot(), file = s.createFile('Batched remote edits'), notices = vi.spyOn(s.hub, 'broadcast');
    await s.timeline.receive(file.id, 'fixture-remote', Array.from({ length: 40 }, (_, i) => ({ ...change(`fixture-remote:${i+1}`, i+1), device: 'fixture-remote', seq: i+1 })));
    await new Promise(r => setTimeout(r, 1100));
    expect(notices.mock.calls.filter(([event]) => event.t === 'files')).toHaveLength(1);
  });
});
