import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.ts';
import { resetForTests, showLanguage } from '../src/i18n/store.ts';

afterEach(() => { vi.unstubAllGlobals(); resetForTests(); });

describe('REST errors shown in the chat', () => {
  const request = { fileId: 'file1', nodeIds: [], prompt: 'Make it calmer', runner: 'codex' };
  const busy = 'A run is already going on this file. Wait for it to finish, or stop it.';

  it('shows the server reason instead of only the request path and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: busy }, { status: 409 })));
    await expect(api.startRun(request)).rejects.toThrow(busy);
  });

  it('translates a known server reason into the interface language', async () => {
    await showLanguage('de');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: busy }, { status: 409 })));
    await expect(api.startRun(request)).rejects.toThrow('In dieser Datei läuft bereits ein Lauf.');
  });

  it.each([
    ['text/html', '<h1>Proxy error</h1>'],
    ['application/json', '{broken'],
    ['application/json', '{"error":{"message":"wrong shape"}}'],
    ['application/json', '{"error":" "}'],
    ['application/json', 'null'],
  ])('keeps a useful fallback for a %s response without a readable reason', async (type, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 502, headers: { 'Content-Type': type } })));
    await expect(api.startRun(request)).rejects.toThrow('POST /api/runs failed with 502');
  });

  it('still reads a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ runId: 'run1' })));
    await expect(api.startRun(request)).resolves.toEqual({ runId: 'run1' });
  });
});
