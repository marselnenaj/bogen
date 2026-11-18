import { afterEach, describe, expect, it } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });

describe('a call\'s run works only in its file', () => {
  it('reads other files, but changes only its own and creates none', async () => {
    h = await startServer();
    const setup = await connectAgent(h.base, 'setup');
    const a = await call(setup, 'file_create', { name: 'Trauermusik Wien · Website' });
    const b = await call(setup, 'file_create', { name: 'Trauermusik Wien · Logo' });
    await call(setup, 'html_write', { file_id: b.id, html: '<div data-name="Mark" style="width:40px;height:40px"></div>' });
    // A run going in A, held to A, as the call starts them.
    const runs = h.server.runs as unknown as { bindingOf(id: string): unknown; allowedFilesOf(id: string): string[] | undefined };
    runs.bindingOf = (id: string) => (id === 'callrun1' ? { fileId: a.id, agent: 'claude' } : undefined);
    runs.allowedFilesOf = (id: string) => (id === 'callrun1' ? [a.id] : undefined);
    const agent = await connectAgent(h.base, 'claude', { 'X-Bogen-Run': 'callrun1', 'X-Bogen-File': a.id });
    expect((await callRaw(agent, 'layer_tree', { file_id: b.id })).isError).toBe(false);
    expect((await callRaw(agent, 'html_write', { file_id: a.id, html: '<p>ok</p>' })).isError).toBe(false);
    const elsewhere = await callRaw(agent, 'html_write', { file_id: b.id, html: '<p>not here</p>' });
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.content[0]!.text).toMatch(/may only change the file it was asked to work in/);
    const created = await callRaw(agent, 'file_create', { name: 'Stray' });
    expect(created.isError).toBe(true);
    expect(h.server.storage.list().some((f) => f.name === 'Stray')).toBe(false);
    await agent.close();
    await setup.close();
  });
});

describe('finding the file the person names in a call', () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const files = [
    { id: 'aaaaaaaaa1', name: 'Trauermusik Wien · Website', updatedAt: now - 3600_000 },
    { id: 'aaaaaaaaa2', name: 'Trauermusik Wien · Logo', updatedAt: now - 7200_000 },
    { id: 'aaaaaaaaa3', name: 'Sprechstunde · Praxis-Website', updatedAt: now - 86_400_000 * 3 },
    { id: 'aaaaaaaaa4', name: 'Tomacco Shop', updatedAt: now - 86_400_000 * 30 },
  ];
  it('asks back between two close ones and takes a clear one', async () => {
    const { resolveFile } = await import('../src/speech/call.ts');
    expect(resolveFile('Trauermusik', files, now)).toEqual({ ambiguous: [{ id: 'aaaaaaaaa1', name: 'Trauermusik Wien · Website' }, { id: 'aaaaaaaaa2', name: 'Trauermusik Wien · Logo' }] });
    expect(resolveFile('die Datei vom Logo', files, now)).toEqual({ match: { id: 'aaaaaaaaa2', name: 'Trauermusik Wien · Logo' } });
    expect(resolveFile('die Trauermusik Website', files, now)).toEqual({ match: { id: 'aaaaaaaaa1', name: 'Trauermusik Wien · Website' } });
    expect(resolveFile('Sprechstunde', files, now)).toMatchObject({ match: { id: 'aaaaaaaaa3' } });
    expect(resolveFile('Tomaco Shop', files, now)).toMatchObject({ match: { id: 'aaaaaaaaa4' } });
  });
  it('finds nothing for an unknown name, an id or a path, and never just the newest', async () => {
    const { resolveFile } = await import('../src/speech/call.ts');
    expect(resolveFile('Hochzeitsfotos', files, now)).toEqual({ none: true });
    expect(resolveFile('aaaaaaaaa3', files, now)).toEqual({ none: true });
    expect(resolveFile('~/.ssh/id_ed25519', files, now)).toEqual({ none: true });
    expect(resolveFile('die Datei', files, now)).toEqual({ none: true });
  });
});

describe('what the voice remembers across calls', () => {
  it('the end of the last call about the file, not the one going on, and the other recent files', async () => {
    const { earlierCall, otherFiles } = await import('../src/speech/call.ts');
    const now = Date.UTC(2026, 10, 17, 12);
    const app = {
      options: { home: '' },
      storage: { get: () => undefined, list: () => [{ id: 'f1', name: 'Website', updatedAt: now }, { id: 'f2', name: 'Logo', updatedAt: now - 1000 }] },
      conversations: {
        addCallLines: async () => {},
        list: async () => [{ id: 'now', updatedAt: now }, { id: 'before', updatedAt: now - 86_400_000 }],
        get: async (_f: string, id: string) => (id === 'now'
          ? { call: [{ at: now - 1000, who: 'person' as const, text: 'Hallo?' }] }
          : { call: [{ at: now - 86_400_000, who: 'person' as const, text: 'Mach den Hero ruhiger.' }, { at: now - 86_400_000 + 1, who: 'person' as const, text: '…', kind: 'noise' as const }, { at: now - 86_400_000 + 2, who: 'voice' as const, text: 'Erledigt, der Hero ist jetzt ruhiger.' }] }),
      },
      history: { list: async (id: string) => (id === 'f2' ? [{ status: 'done', prompt: 'Mach das Zeichen dunkler.', startedAt: now - 5000 }] : []) },
    };
    expect(await earlierCall(app as never, 'f1', now)).toEqual(['Person: Mach den Hero ruhiger.', 'You: Erledigt, der Hero ist jetzt ruhiger.']);
    expect(await otherFiles(app as never, 'f1')).toEqual([{ name: 'Logo', lastAsked: 'Mach das Zeichen dunkler.' }]);
  });
});
