import { describe, expect, it, vi } from 'vitest';
import { Y } from '@bogen/core';
import { Awareness } from 'y-protocols/awareness';

vi.mock('y-websocket', () => ({ WebsocketProvider: class {} }));

describe('presence after the Yjs id switches (teams-1)', () => {
  it('shows the same state under the new id, and the old id leaves', async () => {
    const { moveAwareness } = await import('../src/doc/session.ts');
    const y = new Y.Doc();
    y.clientID = 111;
    const aw = new Awareness(y);
    aw.setLocalState({ user: 'Anna' });
    const seen: { added: number[]; removed: number[] }[] = [];
    aw.on('change', (c: { added: number[]; removed: number[] }) => seen.push({ added: c.added, removed: c.removed }));
    moveAwareness(aw, 222);
    expect(aw.clientID).toBe(222);
    expect(aw.getLocalState()).toEqual({ user: 'Anna' });
    expect(aw.getStates().has(111)).toBe(false);
    expect(aw.getStates().get(222)).toEqual({ user: 'Anna' });
    expect(seen).toEqual([{ added: [], removed: [111] }, { added: [222], removed: [] }]);
    aw.destroy();
  });
});
