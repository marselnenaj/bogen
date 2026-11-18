import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Y } from '@bogen/core';

vi.mock('../src/lib/events.ts', () => ({ onServerEvent: () => () => {} }));

const store = new Map<string, string>();
let features: string[] = ['teams-1'];
let next = 1000;
let offline = false;
const asked: string[] = [];

beforeEach(() => {
  vi.resetModules();
  store.clear();
  asked.length = 0;
  next = 1000;
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ features }) };
    if (offline) throw new TypeError('Failed to fetch');
    if (url === '/api/teams/spares') return { ok: true, json: async () => ({ spares: { teamfile01: next++, teamfile02: next++ } }) };
    const { file } = JSON.parse(init?.body ?? '{}');
    asked.push(file);
    const team = file === 'teamfile01';
    return { ok: true, json: async () => (team ? { clientID: next++, spare: next++ } : { clientID: null, spare: null }) };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  features = ['teams-1'];
  offline = false;
});

describe('the id a tab writes a team file with (N6)', () => {
  it('takes the id the computer hands out before anything is written, and keeps a spare for next time', async () => {
    const { bindTeamWriter } = await import('../src/doc/team-writer.ts');
    const y = new Y.Doc();
    const w = bindTeamWriter('teamfile01', y);
    await w.ready;
    expect(y.clientID).toBe(1000);
    expect(store.get('bogen.writer.teamfile01')).toBe('1001');
    w.destroy();
    // A reload (or the phone, offline) starts with the spare at once, before the computer answers: a new session.
    const again = new Y.Doc();
    const w2 = bindTeamWriter('teamfile01', again);
    expect(again.clientID).toBe(1001);
    await w2.ready;
    expect(again.clientID).toBe(1001);
    // A fresh spare for next time (the spares asked for ahead of time took numbers in between).
    expect(store.get('bogen.writer.teamfile01')).toBeDefined();
    expect(store.get('bogen.writer.teamfile01')).not.toBe('1001');
    w2.destroy();
  });

  it('goes back to one of its own ids when Yjs picks a random one', async () => {
    const { bindTeamWriter } = await import('../src/doc/team-writer.ts');
    const y = new Y.Doc();
    const w = bindTeamWriter('teamfile01', y);
    await w.ready;
    // What Yjs does when a remote change advances the tab's own id.
    y.clientID = 424242;
    y.transact(() => y.getMap('m').set('a', 1));
    expect(y.clientID).toBe(1001);
    w.destroy();
  });

  it('changes nothing for a file in no team, or with teams off', async () => {
    const { bindTeamWriter } = await import('../src/doc/team-writer.ts');
    const y = new Y.Doc();
    const before = y.clientID;
    const w = bindTeamWriter('plainfile1', y);
    await w.ready;
    expect(y.clientID).toBe(before);
    w.destroy();
    vi.resetModules();
    features = [];
    const { bindTeamWriter: off } = await import('../src/doc/team-writer.ts');
    const z = new Y.Doc();
    const id = z.clientID;
    await off('teamfile01', z).ready;
    expect(z.clientID).toBe(id);
    expect(asked).toEqual(['plainfile1']);
  });

  it('keeps a spare for every team file ahead of time, so one never opened before writes with this device\'s id offline', async () => {
    const { bindTeamWriter, fetchSpares } = await import('../src/doc/team-writer.ts');
    await fetchSpares();
    expect(store.get('bogen.writer.teamfile02')).toBeDefined();
    expect(JSON.parse(store.get('bogen.teamfiles')!)).toEqual(['teamfile01', 'teamfile02']);
    offline = true;
    const spare = Number(store.get('bogen.writer.teamfile02'));
    const y = new Y.Doc();
    const w = bindTeamWriter('teamfile02', y);
    expect(y.clientID).toBe(spare);
    await w.ready;
    expect(y.clientID).toBe(spare);
    w.destroy();
  });

  it('says so when a known team file opens offline without one of this device\'s ids', async () => {
    const { bindTeamWriter, fetchSpares, teamWriteState } = await import('../src/doc/team-writer.ts');
    await fetchSpares();
    store.delete('bogen.writer.teamfile02');
    offline = true;
    const w = bindTeamWriter('teamfile02', new Y.Doc());
    await w.ready;
    expect(teamWriteState('teamfile02')).toEqual({ unsent: 0, noId: true });
    w.destroy();
  });

  it('tells the session when it switches ids, so presence follows', async () => {
    const { bindTeamWriter } = await import('../src/doc/team-writer.ts');
    const y = new Y.Doc();
    const w = bindTeamWriter('teamfile01', y);
    const switches: [number, number][] = [];
    w.onSwitch((from, to) => switches.push([from, to]));
    await w.ready;
    y.clientID = 424242;
    y.transact(() => y.getMap('m').set('a', 1));
    expect(switches.at(-1)).toEqual([424242, 1001]);
    w.destroy();
  });
});
