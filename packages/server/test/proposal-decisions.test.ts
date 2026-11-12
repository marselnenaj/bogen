import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BogenDoc, Y, acceptProposal, createProposals, discardProposal } from '@bogen/core';
import { DecisionMemory } from '../src/memory.ts';
import { startServer, until, type Harness } from './helpers.ts';

describe('proposal decisions through synced editor changes', () => {
  let h: Harness;
  beforeEach(async () => { h = await startServer({ thumbnails: false }); });
  afterEach(async () => { await h.cleanup(); });

  for (const changedChild of [false, true]) {
    it(`records exactly the chosen proposal when ${changedChild ? 'a mapped child changes without replacing its id' : 'the accepted content is unchanged'}`, async () => {
      const file = h.server.createFile('Decision fixture').id;
      const { doc } = await h.server.rooms.get(file);
      const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', artboard: true, style: { width: '400px', height: '300px', backgroundColor: '#ffffff' } });
      const child = doc.insert(board, { type: 'text', text: 'Original message', style: { color: '#111111' } });
      const [picked, other, third] = createProposals(doc, board, { by: 'designer', count: 3 });
      doc.updateStyle(other!, { background: 'linear-gradient(#fff, #aaa)' });
      h.server.memory.refresh(file);
      const cursor = h.server.fileEvents.head(file);
      const peer = new BogenDoc(); Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
      if (changedChild) peer.updateFields(peer.getChildren(picked!)[0]!.id, { text: 'Revised message' });
      acceptProposal(peer, picked!, 'person:fixture');
      Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(peer.y, Y.encodeStateVector(doc.y)), 'peer:fixture');
      const key = DecisionMemory.keyOf(file);
      await until(async () => (await h.server.memory.view(key, null)).decisions === 3);
      const memory = await h.server.memory.view(key, null);
      expect(memory).toMatchObject({ accepted: 1, discarded: 2 });
      expect(memory.recent.find(d => d.id === picked)?.decision).toBe('accepted');
      const events = await h.server.fileEvents.wait(file, { cursor, kinds: ['proposal_accepted', 'proposal_discarded'], timeoutMs: 1, limit: 10 });
      expect(events.events.filter(e => e.kind === 'proposal_accepted').map(e => e.proposal_id)).toEqual([picked]);
      expect(events.events.filter(e => e.kind === 'proposal_discarded').map(e => e.proposal_id).sort()).toEqual([other, third].sort());
      expect(doc.getChildren(board).map(n => n.id)).toEqual([child]);
      expect(doc.getNode(child)?.text).toBe(changedChild ? 'Revised message' : 'Original message');
      peer.y.destroy();
    });
  }

  it('does not infer acceptance from an unrelated original edit made while discarding', async () => {
    const file = h.server.createFile('Discard fixture').id;
    const { doc } = await h.server.rooms.get(file);
    const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', artboard: true, style: { width: '400px', height: '300px' } });
    const copy = createProposals(doc, board, { by: 'designer' })[0]!;
    const cursor = h.server.fileEvents.head(file);
    doc.transact(() => { doc.updateStyle(board, { backgroundColor: '#f0f0f0' }); discardProposal(doc, copy); }, 'person:fixture');
    await until(async () => (await h.server.memory.view(DecisionMemory.keyOf(file), null)).decisions === 1);
    expect(await h.server.memory.view(DecisionMemory.keyOf(file), null)).toMatchObject({ accepted: 0, discarded: 1 });
    const events = await h.server.fileEvents.wait(file, { cursor, kinds: ['proposal_accepted', 'proposal_discarded'], timeoutMs: 1, limit: 10 });
    expect(events.events.map(e => [e.kind, e.proposal_id])).toEqual([['proposal_discarded', copy]]);
  });
});
