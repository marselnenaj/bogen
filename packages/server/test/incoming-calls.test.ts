import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEnd } from '../src/agents.ts';
import { askedQuestion, FILE_COOLDOWN_MS, GLOBAL_COOLDOWN_MS, inQuietHours, IncomingCalls, RING_MS, type IncomingEvent } from '../src/incoming-calls.ts';
import { call, connectAgent, startServer, until, withoutDesignReview, type Harness } from './helpers.ts';

describe('askedQuestion', () => {
  it('finds the question a reply ends on, and nothing else', () => {
    expect(askedQuestion('Ich habe den Seitenkopf gefunden.\n\nSoll er auf allen 6 Seiten gleich hoch sein, oder nur auf der Startseite?')).toBe('Soll er auf allen 6 Seiten gleich hoch sein, oder nur auf der Startseite?');
    expect(askedQuestion('Done. The header is 32px taller. Should the footer match?')).toBe('Should the footer match?');
    expect(askedQuestion('The header is 32px taller now.')).toBeNull();
    expect(askedQuestion('Is it good? I made it bigger.')).toBeNull();
    expect(askedQuestion('Changed it.\n<say>Willst du das so?</say>')).toBeNull();
    expect(askedQuestion('**Which one do you want, A or B?**')).toBe('Which one do you want, A or B?');
    expect(askedQuestion(undefined)).toBeNull();
    expect(askedQuestion('Ok?')).toBeNull();
  });
});

describe('quiet hours', () => {
  it('wraps past midnight, and needs both ends', () => {
    const night = { enabled: true, quietFrom: '22:00', quietTo: '07:00' };
    expect(inQuietHours(night, 23 * 60)).toBe(true);
    expect(inQuietHours(night, 6 * 60 + 59)).toBe(true);
    expect(inQuietHours(night, 7 * 60)).toBe(false);
    expect(inQuietHours(night, 12 * 60)).toBe(false);
    expect(inQuietHours({ enabled: true, quietFrom: '12:00', quietTo: '13:00' }, 12 * 60 + 30)).toBe(true);
    expect(inQuietHours({ enabled: true, quietFrom: null, quietTo: null }, 0)).toBe(false);
  });
});

function harness(options: { local?: number } = {}) {
  let now = 1_000_000;
  const events: IncomingEvent[] = [];
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const phones: string[] = [];
  const calls = new IncomingCalls({
    home: mkdtempSync(join(tmpdir(), 'bogen-incoming-')),
    broadcast: (e) => events.push(e),
    fileName: (id) => `File ${id}`,
    replyOf: async (end) => end.reply,
    notifyPhones: (c) => phones.push(c.fileId),
    now: () => now,
    localMinutes: () => options.local ?? 12 * 60,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) if (!t.cancelled && t.at <= now) { t.cancelled = true; t.fn(); }
  };
  const end = (fileId: string, reply: string, extra: Partial<RunEnd & { origin: 'prompt' | 'comment' | 'remote' | 'race' | 'live'; call: boolean }> = {}) =>
    calls.runEnded({ runId: `r${Math.random().toString(36).slice(2, 8)}`, fileId, runner: 'claude', status: 'done', reply, origin: 'prompt', ...extra });
  return { calls, events, phones, advance, end };
}

const ASK = 'I changed the header.\n\nShould the footer get the same padding?';

describe('IncomingCalls', () => {
  it('rings only when turned on, once at a time, and holds both cooldowns', async () => {
    const h = harness();
    expect(await h.end('a', ASK)).toBeNull();
    await h.calls.setSettings({ enabled: true });
    expect(await h.end('a', 'Done, no question.')).toBeNull();
    const first = await h.end('a', ASK);
    expect(first?.question).toBe('Should the footer get the same padding?');
    expect(h.phones).toEqual(['a']);
    // Another run asking while it rings: no second call.
    expect(await h.end('b', ASK)).toBeNull();
    expect(h.events.filter((e) => e.t === 'incoming-call')).toHaveLength(1);
    // It rings out after thirty seconds.
    h.advance(RING_MS);
    expect(h.events.at(-1)).toMatchObject({ t: 'incoming-call-end', reason: 'missed', fileId: 'a' });
    // The global cooldown, then the file's own.
    expect(await h.end('b', ASK)).toBeNull();
    h.advance(GLOBAL_COOLDOWN_MS);
    expect(await h.end('a', ASK)).toBeNull();
    const second = await h.end('b', ASK);
    expect(second?.fileId).toBe('b');
    expect(h.calls.respond(second!.id, 'decline')?.id).toBe(second!.id);
    expect(h.calls.respond(second!.id, 'answer')).toBeNull();
    h.advance(FILE_COOLDOWN_MS);
    expect((await h.end('a', ASK))?.fileId).toBe('a');
  });

  it('never rings in quiet hours, for a call run, a stopped run, a race or live mode', async () => {
    const quiet = harness({ local: 23 * 60 });
    await quiet.calls.setSettings({ enabled: true, quietFrom: '22:00', quietTo: '07:00' });
    expect(await quiet.end('a', ASK)).toBeNull();
    const h = harness();
    await h.calls.setSettings({ enabled: true });
    expect(await h.end('a', ASK, { call: true })).toBeNull();
    expect(await h.end('a', ASK, { status: 'stopped' })).toBeNull();
    expect(await h.end('a', ASK, { origin: 'race' })).toBeNull();
    expect(await h.end('a', ASK, { origin: 'live' })).toBeNull();
    expect((await h.end('a', ASK, { origin: 'comment' }))?.fileId).toBe('a');
    await expect(h.calls.setSettings({ quietFrom: '22:00' })).rejects.toThrow(/start and an end/);
  });
});

describe('a stand-in run that asks a question', () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const x of harnesses.splice(0)) await x.cleanup();
  });

  it('rings exactly once when agent calls are on, and not when they are off', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'bogen-ask-bin-'));
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('stand-in 1'); process.exit(0); }
require('node:fs').readFileSync(0);
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ich habe zwei Seitenköpfe gefunden.\\n\\nSoll ich beide gleich hoch machen?' }] } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
`);
    chmodSync(join(bin, 'claude'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const h = await startServer();
      harnesses.push(h);
      withoutDesignReview(h.server);
      const agent = await connectAgent(h.base, 'claude');
      const file = await call(agent, 'file_create', { name: 'Site' });
      await agent.close();
      const rings: unknown[] = [];
      const real = h.server.hub.broadcast.bind(h.server.hub);
      h.server.hub.broadcast = (e) => { if (e.t === 'incoming-call') rings.push(e); real(e); };
      const post = async (path: string, method: string, body: unknown) => {
        const r = await fetch(`${h.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, json: await r.json() as any };
      };
      const run = async () => {
        const { json } = await post('/api/runs', 'POST', { fileId: file.id, prompt: 'Mach den Seitenkopf höher', runner: 'claude' });
        await until(() => !h.server.runs.activeFor(file.id), 15_000);
        return json.runId as string;
      };
      // Off by default: the run ends on a question, nothing rings.
      await run();
      await new Promise((r) => setTimeout(r, 100));
      expect(rings).toHaveLength(0);
      expect((await post('/api/call/incoming/settings', 'PUT', { enabled: true })).status).toBe(200);
      const runId = await run();
      await until(() => rings.length === 1, 5000);
      const ringing = h.server.incomingCalls.current.ringing!;
      expect(ringing).toMatchObject({ fileId: file.id, runId, runner: 'claude', question: 'Soll ich beide gleich hoch machen?', fileName: 'Site' });
      // A second run right after: the cooldown holds, still one ring.
      await run();
      await new Promise((r) => setTimeout(r, 100));
      expect(rings).toHaveLength(1);
      expect((await post(`/api/call/incoming/${ringing.id}`, 'POST', { action: 'answer' })).status).toBe(200);
      expect((await post(`/api/call/incoming/${ringing.id}`, 'POST', { action: 'answer' })).status).toBe(409);
      expect((await post('/api/call/incoming/settings', 'PUT', { quietFrom: '25:00', quietTo: '07:00' })).status).toBe(400);
    } finally {
      process.env.PATH = saved;
    }
  }, 60_000);
});
