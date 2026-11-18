import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });

async function req(path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${h!.base}${path}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

describe('what a call remembers for later calls', () => {
  it('keeps wishes in call-preferences.json, one per kind, readable only by this user, and forgets them on request', async () => {
    h = await startServer();
    expect((await req('/api/call/preferences')).json).toEqual({ items: [] });
    await req('/api/call/preferences', 'POST', { kind: 'length', value: 'short', text: 'Sprich kürzer.' });
    await req('/api/call/preferences', 'POST', { kind: 'name', value: 'Sam', text: 'Nenn mich Sam.' });
    const { json } = await req('/api/call/preferences', 'POST', { kind: 'length', value: 'long', text: 'Ausführlicher bitte.' });
    expect(json.items.map((p: { kind: string; value: string }) => `${p.kind}:${p.value}`)).toEqual(['name:Sam', 'length:long']);
    const path = join(h.home, 'call-preferences.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).items).toHaveLength(2);
    // Held to its kinds and sizes.
    expect((await req('/api/call/preferences', 'POST', { kind: 'length', value: 'huge', text: 'x' })).status).toBe(400);
    expect((await req('/api/call/preferences', 'POST', { kind: 'script', value: '', text: 'x' })).status).toBe(400);
    expect((await req('/api/call/preferences/..%2Fx', 'DELETE')).status).toBe(400);
    const name = json.items.find((p: { kind: string }) => p.kind === 'name');
    expect((await req(`/api/call/preferences/${name.id}`, 'DELETE')).json.items).toHaveLength(1);
    expect((await req('/api/call/preferences', 'DELETE')).json.items).toEqual([]);
  });

  it('finds a brand by name among the brands only, never a design file, and makes none', async () => {
    h = await startServer();
    const setup = await connectAgent(h.base, 'setup');
    await call(setup, 'file_create', { name: 'Sprechstunde · Website' });
    await h.server.brands.create('Sprechstunde', 'test');
    await h.server.brands.create('Trauermusik', 'test');
    await h.server.brands.create('Trauermusik dunkel', 'test');
    const found = (await req('/api/call/resolve-brand', 'POST', { said: 'sprechstunde' })).json;
    expect(found.match.name).toBe('Sprechstunde');
    expect(h.server.storage.get(found.match.id)?.kind).toBe('brand');
    expect((await req('/api/call/resolve-brand', 'POST', { said: 'trauermusik' })).json.ambiguous).toHaveLength(2);
    expect((await req('/api/call/resolve-brand', 'POST', { said: 'Hochzeit' })).json).toEqual({ none: true });
    expect(h.server.storage.listBrands()).toHaveLength(3);
    await setup.close();
  });

  it('keeps the call\'s notes with the chat, and a later call about the file starts from them', async () => {
    h = await startServer();
    const setup = await connectAgent(h.base, 'setup');
    const file = await call(setup, 'file_create', { name: 'Trauermusik Wien · Website' });
    const at = Date.now() - 3 * 3600_000;
    expect((await req('/api/call/log', 'POST', { fileId: file.id, conversationId: 'c1', lines: [{ at, who: 'person', text: 'Mach den Seitenkopf höher.' }, { at: at + 1, who: 'voice', text: 'Erledigt.' }] })).status).toBe(200);
    expect((await req('/api/call/log', 'POST', { fileId: file.id, conversationId: 'c1', lines: [], summary: 'The person raised the header on all pages. Open: the footer links.' })).status).toBe(200);
    const saved = await h.server.conversations.get(file.id, 'c1');
    expect(saved?.callSummary).toBe('The person raised the header on all pages. Open: the footer links.');
    const { earlierCall } = await import('../src/speech/call.ts');
    const before = await earlierCall(h.server as never, file.id);
    expect(before[0]).toMatch(/^\(That call, 3 h ago, in short: The person raised the header/);
    expect(before.slice(1)).toEqual(['Person: Mach den Seitenkopf höher.', 'You: Erledigt.']);
    await setup.close();
  });
});
