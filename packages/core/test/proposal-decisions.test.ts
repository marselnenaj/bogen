import { describe, expect, it } from 'vitest';
import { BogenDoc, Y, acceptProposal, createProposals, discardProposal, proposalDecision } from '../src/index.ts';

function fixture() {
  const doc = new BogenDoc(); doc.ensureFirstPage();
  const board = doc.insert(doc.getPages()[0]!.id, { type: 'frame', artboard: true, style: { width: '400px', height: '300px' } });
  return { doc, board };
}

describe('explicit proposal decisions', () => {
  it('syncs an unchanged acceptance and sibling discards, and undoes the receipts with the decision', () => {
    const { doc, board } = fixture();
    const [picked, other] = createProposals(doc, board, { by: 'designer', count: 2 });
    const peer = new BogenDoc(); Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    const origin = 'person:fixture';
    const undo = new Y.UndoManager([doc.nodes, doc.meta], { trackedOrigins: new Set([origin]) });
    acceptProposal(doc, picked!, origin);
    expect(proposalDecision(doc, picked!)).toMatchObject({ source: board, decision: 'accepted' });
    expect(proposalDecision(doc, other!)).toMatchObject({ source: board, decision: 'discarded' });
    Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y, Y.encodeStateVector(peer.y)));
    expect(proposalDecision(peer, picked!)).toEqual(proposalDecision(doc, picked!));
    undo.undo();
    expect(doc.getNode(picked!)).toBeTruthy();
    expect(proposalDecision(doc, picked!)).toBeUndefined();
    undo.redo();
    expect(doc.getNode(picked!)).toBeUndefined();
    expect(proposalDecision(doc, picked!)?.decision).toBe('accepted');
    undo.destroy(); peer.y.destroy(); doc.y.destroy();
  });

  it('keeps concurrent decisions on independent keys and bounds receipts from repeated decisions', () => {
    const { doc, board } = fixture();
    const first = createProposals(doc, board, { by: 'designer' })[0]!;
    const second = createProposals(doc, board, { by: 'designer' })[0]!;
    const peer = new BogenDoc(); Y.applyUpdate(peer.y, Y.encodeStateAsUpdate(doc.y));
    discardProposal(doc, first); discardProposal(peer, second);
    Y.applyUpdate(doc.y, Y.encodeStateAsUpdate(peer.y, Y.encodeStateVector(doc.y)));
    expect(proposalDecision(doc, first)?.decision).toBe('discarded');
    expect(proposalDecision(doc, second)?.decision).toBe('discarded');
    for (let i = 0; i < 505; i++) discardProposal(doc, createProposals(doc, board, { by: 'designer' })[0]!);
    expect([...doc.meta.keys()].filter(k => k.startsWith('proposal-decision:'))).toHaveLength(500);
    expect(doc.getNode(board)).toBeTruthy();
    peer.y.destroy(); doc.y.destroy();
  });
});
