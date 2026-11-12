import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { applyReplayWrites, docToContent, rebuildHistory, replayClock, replayDoc, replayFrameAt, replayFrames, type ReplayEntry, type ReplayStepInfo } from '@bogen/core';
import { findFfmpeg } from '../src/media.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** What ffprobe says about a video: frames, size, seconds. */
function probe(path: string): { frames: number; width: number; height: number; seconds: number; codec: string } {
  const out = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', path], { encoding: 'utf8' });
  const parsed = JSON.parse(out.stdout) as { streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[]; format: { duration: string } };
  const s = parsed.streams[0]!;
  return { frames: Number(s.nb_read_frames), width: s.width, height: s.height, seconds: Number(parsed.format.duration), codec: s.codec_name };
}

describe('replay clock and frames', () => {
  const steps: ReplayStepInfo[] = [
    { id: 'a:1', at: 1_000, actor: 'claude', source: 'agent', tool: 'artboard_create', summary: 'Added "Home"', focus: { x: 0, y: 0, width: 800, height: 600 } },
    { id: 'a:2', at: 1_200, actor: 'claude', source: 'agent', tool: 'html_write', summary: 'Added "Hero"', focus: { x: 40, y: 40, width: 400, height: 120 } },
    { id: 'b:1', at: 61_200, actor: 'Ana', source: 'person', summary: 'Changed color on "Title"', focus: { x: 40, y: 200, width: 200, height: 40 } },
    { id: 'a:3', at: 61_900, actor: 'claude', source: 'agent', tool: 'tokens_set', summary: 'Changed tokens', focus: null },
  ];
  const view = { frame: { x: -20, y: -20, width: 840, height: 640 }, aspect: 16 / 9, camera: 'fit' as const };

  it('gives each step a beat: at least the shortest, at most the idle cap, divided by the speed', () => {
    const clock = replayClock(steps, { speed: 1, maxIdleMs: 1500, minStepMs: 700, headMs: 900, tailMs: 1800 });
    // 700 for the first, 200 real is raised to 700, a minute is capped at 1500, 700 real stays.
    expect(clock.gaps).toEqual([700, 700, 1500, 700]);
    expect(clock.at).toEqual([1600, 2300, 3800, 4500]);
    expect(clock.duration).toBe(6300);
    const fast = replayClock(steps, { speed: 2, maxIdleMs: 1500, minStepMs: 700, headMs: 900, tailMs: 1800 });
    expect(fast.gaps).toEqual([350, 350, 750, 350]);
    expect(fast.duration).toBe(900 + 1800 + 1800);
  });

  it('shows the page before the first step, then each step after a short cross-fade', () => {
    const clock = replayClock(steps);
    const first = replayFrameAt(steps, clock, view, 0);
    expect(first).toMatchObject({ step: -1, top: 0, under: null, fade: 1, caption: null, highlight: null, cursors: [] });
    const landing = replayFrameAt(steps, clock, view, clock.at[1]!);
    expect(landing).toMatchObject({ step: 1, top: 2, under: 1, fade: 0 });
    expect(landing.cursors).toEqual([expect.objectContaining({ actor: 'claude', x: 180, y: 96, pressed: 1, opacity: 1 })]);
    expect(landing.caption).toMatchObject({ actor: 'claude', tool: 'html_write', summary: 'Added "Hero"' });
    expect(landing.highlight?.rect).toEqual(steps[1]!.focus);
    const settled = replayFrameAt(steps, clock, view, clock.at[1]! + 300);
    expect(settled).toMatchObject({ step: 1, top: 2, under: null, fade: 1 });
  });

  it('moves each cursor on its own, and keeps it where its last step was', () => {
    const clock = replayClock(steps);
    const atAna = replayFrameAt(steps, clock, view, clock.at[2]!);
    const claude = atAna.cursors.find((c) => c.actor === 'claude')!;
    const ana = atAna.cursors.find((c) => c.actor === 'Ana')!;
    expect([claude.x, claude.y]).toEqual([180, 96]);
    expect([ana.x, ana.y]).toEqual([140, 220]);
    expect(atAna.caption?.actor).toBe('Ana');
    expect(atAna.caption?.tool).toBeUndefined();
    // A token change has no place: the cursor stays, the caption still says it.
    const tokens = replayFrameAt(steps, clock, view, clock.at[3]!);
    expect(tokens.cursors.find((c) => c.actor === 'claude')).toMatchObject({ x: 180, y: 96 });
    expect(tokens.caption).toMatchObject({ tool: 'tokens_set' });
    expect(tokens.highlight).toBeNull();
  });

  it('is the same sequence however often it is made, one frame per tick', () => {
    const clock = replayClock(steps, { speed: 2 });
    const a = replayFrames(steps, clock, view, 24);
    const b = replayFrames(steps, clock, view, 24);
    expect(a).toEqual(b);
    expect(a.length).toBe(Math.ceil((clock.duration / 1000) * 24));
    expect(a.map((f) => f.step)).toEqual([...a.map((f) => f.step)].sort((x, y) => x - y));
    expect(new Set(a.map((f) => f.top))).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('follows the work closely, inside the frame, and ends on the whole', () => {
    const tall = { frame: { x: 0, y: 0, width: 1440, height: 5000 }, aspect: 16 / 9, camera: 'follow' as const };
    const deep: ReplayStepInfo[] = [
      { id: '1', at: 0, actor: 'claude', source: 'agent', summary: 'Added "Hero"', focus: { x: 0, y: 0, width: 1440, height: 700 } },
      { id: '2', at: 500, actor: 'claude', source: 'agent', summary: 'Added "Footer"', focus: { x: 0, y: 4600, width: 1440, height: 400 } },
    ];
    const clock = replayClock(deep);
    const atFooter = replayFrameAt(deep, clock, tall, clock.at[1]!);
    expect(atFooter.camera.width).toBeLessThan(5000);
    expect(atFooter.camera.y + atFooter.camera.height).toBeCloseTo(5000, 0);
    expect(atFooter.camera.width / atFooter.camera.height).toBeCloseTo(16 / 9, 3);
    const end = replayFrameAt(deep, clock, tall, clock.duration);
    expect(end.camera.height).toBeCloseTo(5000, 0);
  });

  it('grows with the page: close on the first section, wider as it gets longer, the whole at the end', () => {
    const frame = { x: 0, y: 0, width: 1280, height: 2400 };
    const extents = [null, { x: 0, y: 0, width: 1280, height: 400 }, { x: 0, y: 0, width: 1280, height: 1200 }, { x: 0, y: 0, width: 1280, height: 2400 }];
    const view = { frame, aspect: 16 / 9, camera: 'grow' as const, minWidth: 1280, extents };
    const built: ReplayStepInfo[] = [
      { id: '1', at: 0, actor: 'claude', source: 'agent', summary: 'Added "Hero"', focus: { x: 0, y: 0, width: 1280, height: 400 } },
      { id: '2', at: 500, actor: 'claude', source: 'agent', summary: 'Added "Features"', focus: { x: 0, y: 400, width: 1280, height: 800 } },
      { id: '3', at: 1000, actor: 'claude', source: 'agent', summary: 'Added "Footer"', focus: { x: 0, y: 1200, width: 1280, height: 1200 } },
    ];
    const clock = replayClock(built);
    // Before anything is built it already frames where the first section lands, from its top.
    const start = replayFrameAt(built, clock, view, 0);
    expect(start.camera.width).toBeGreaterThanOrEqual(1280);
    expect(start.camera.width).toBeLessThan(1400);
    expect(start.camera.y).toBe(0);
    const widths = [0, 1, 2].map((k) => replayFrameAt(built, clock, view, clock.at[k]! + 600).camera.width);
    expect(widths[0]).toBeLessThan(widths[1]!);
    expect(widths[1]).toBeLessThan(widths[2]!);
    const end = replayFrameAt(built, clock, view, clock.duration);
    expect(end.camera.height).toBeGreaterThanOrEqual(2400);
    expect(end.camera.width / end.camera.height).toBeCloseTo(16 / 9, 3);
    // Without the pictures' places it is the whole page throughout.
    expect(replayFrameAt(built, clock, { ...view, extents: undefined }, 0).camera.height).toBeGreaterThanOrEqual(2400);
  });
});

describe('replay of a page an agent built', () => {
  let h: Harness;
  let claude: Client;
  let codex: Client;
  let fileId: string;
  let pageId: string;
  const ffmpeg = findFfmpeg();

  beforeAll(async () => {
    h = await startServer();
    claude = await connectAgent(h.base, 'claude');
    codex = await connectAgent(h.base, 'codex');
    const file = await call(claude, 'file_create', { name: 'Replay test' });
    fileId = file.id;
    pageId = file.pages[0].id;
    const board = await call(claude, 'artboard_create', { file_id: fileId, name: 'Home', width: 640, height: 360, background: '#f4f2ec' });
    await call(claude, 'html_write', { file_id: fileId, target_id: board.id, html: '<header style="padding:24px 32px;font:700 28px sans-serif;color:#0e0e0c">Couchette</header>' });
    await call(claude, 'html_write', { file_id: fileId, target_id: board.id, html: '<section style="padding:0 32px;display:flex;flex-direction:column;gap:12px"><h1 style="margin:0;font:800 40px sans-serif">Sleep through the Alps.</h1><p style="margin:0;font:16px sans-serif;color:#5f5d55">Night trains with a bed.</p></section>' });
    await call(codex, 'tokens_set', { file_id: fileId, tokens: [{ name: 'accent', kind: 'color', value: '#f2361f' }] });
    await call(codex, 'html_write', { file_id: fileId, target_id: board.id, html: '<div style="padding:16px 32px"><span style="display:inline-block;padding:12px 20px;background:var(--accent);color:#fff;font:700 15px sans-serif">Find a train</span></div>' });
    // A second page, which the replay of the first leaves out.
    const other = await call(claude, 'page_create', { file_id: fileId, name: 'Other' });
    await call(claude, 'artboard_create', { file_id: fileId, page_id: other.id ?? other.page_id, name: 'Elsewhere', width: 200, height: 200 });
    await h.server.timeline.flush(fileId);
  }, 60_000);

  afterAll(async () => {
    await claude?.close();
    await codex?.close();
    await h?.cleanup();
  });

  it('rebuilds every state, from an empty page to the file as it is', async () => {
    const { doc } = await h.server.rooms.get(fileId);
    const entries = (await h.server.timeline.all(fileId)) as ReplayEntry[];
    const rebuilt = rebuildHistory(doc, entries);
    expect(rebuilt.thinnedAt).toBeUndefined();
    const replay = replayDoc(rebuilt.start);
    expect(replay.nodes.size).toBe(0);
    for (const step of rebuilt.steps) applyReplayWrites(replay, step.writes);
    const now = docToContent(doc);
    const again = docToContent(replay);
    expect(again.nodes).toEqual(now.nodes);
    expect(again.tokens).toEqual(now.tokens);
  });

  async function plan(body: Record<string, unknown>): Promise<{ events: { t: string; done?: number; total?: number }[]; replay: any; error?: string }> {
    const res = await fetch(`${h.base}/api/files/${fileId}/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { t: string; done?: number; total?: number; replay?: unknown; error?: string });
    const done = events.find((e) => e.t === 'done');
    return { events, replay: done?.replay, error: events.find((e) => e.t === 'error')?.error };
  }

  it('plans the page step by step, with who did what, and serves its pictures', async () => {
    const { events, replay, error } = await plan({ pageId });
    expect(error).toBeUndefined();
    expect(events.filter((e) => e.t === 'progress').at(-1)).toMatchObject({ done: replay.steps.length + 1, total: replay.steps.length + 1 });
    expect(replay.steps.map((s: ReplayStepInfo) => [s.actor, s.tool])).toEqual([
      ['claude', 'artboard_create'], ['claude', 'html_write'], ['claude', 'html_write'], ['codex', 'tokens_set'], ['codex', 'html_write'],
    ]);
    expect(replay.notes.join(' ')).toMatch(/did not touch this page/);
    // Before the board there is nothing; after it, a picture as big as the board and its shadow.
    expect(replay.shots[0]).toBeNull();
    expect(replay.shots[1].width).toBeGreaterThanOrEqual(640);
    expect(replay.steps[0].focus).toMatchObject({ width: 640, height: 360 });
    expect(replay.colors.claude).toMatch(/^#[0-9a-f]{6}$/);
    const shot = await fetch(`${h.base}/api/files/${fileId}/replay/${replay.id}/shot/5`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get('content-type')).toBe('image/png');
    expect((await fetch(`${h.base}/api/files/${fileId}/replay/nope/shot/1`)).status).toBe(404);
    // The same range again is the same replay, from memory.
    expect((await plan({ pageId })).replay.id).toBe(replay.id);
  }, 60_000);

  it('takes a range by change id and by run, and says when there is nothing', async () => {
    const changes = await call<{ id: string; tool?: string; actor: string }[]>(claude, 'change_list', { file_id: fileId, limit: 50 });
    const tokens = changes.find((c) => c.tool === 'tokens_set')!;
    const from = await plan({ pageId, from: tokens.id });
    expect(from.replay.steps.map((s: ReplayStepInfo) => s.tool)).toEqual(['tokens_set', 'html_write']);
    const upTo = await plan({ page: 'Page 1', to: tokens.id });
    expect(upTo.replay.steps).toHaveLength(4);
    const none = await plan({ pageId, from: String(Date.now() + 60_000) });
    expect(none.error).toMatch(/no changes/);
    const wrong = await fetch(`${h.base}/api/files/${fileId}/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 'Nowhere' }) });
    expect(wrong.status).toBe(404);
  }, 60_000);

  it.skipIf(!ffmpeg)('films it as WebM and GIF through ffmpeg, at the size and speed asked for', async () => {
    const res = await fetch(`${h.base}/api/files/${fileId}/replay/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, format: 'webm', width: 480, height: 270, fps: 10, speed: 4, captions: true }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/webm');
    const report = JSON.parse(decodeURIComponent(res.headers.get('x-bogen-export-report')!));
    expect(report).toMatchObject({ width: 480, height: 270, fps: 10, encoder: 'ffmpeg', codec: 'vp9' });
    const path = join(h.home, 'replay.webm');
    writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
    const info = probe(path);
    expect(info).toMatchObject({ width: 480, height: 270, codec: 'vp9', frames: report.frames });
    // Five steps at a quarter of 700 ms, the head and the tail.
    expect(info.seconds).toBeCloseTo((900 + 5 * 175 + 1800) / 1000, 0);

    const gif = await fetch(`${h.base}/api/files/${fileId}/replay/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, format: 'gif', width: 320, height: 180, fps: 8, speed: 8, captions: false }) });
    expect(gif.status).toBe(200);
    const bytes = new Uint8Array(await gif.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 6)).toString('latin1')).toBe('GIF89a');
  }, 120_000);

  it('films MP4 in the browser when told to, without ffmpeg', async () => {
    const res = await fetch(`${h.base}/api/files/${fileId}/replay/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, format: 'mp4', width: 320, height: 180, fps: 6, speed: 8, encoder: 'webcodecs' }) });
    expect(res.status).toBe(200);
    const report = JSON.parse(decodeURIComponent(res.headers.get('x-bogen-export-report')!));
    expect(report.encoder).toBe('webcodecs');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.subarray(4, 8)).toString('latin1')).toBe('ftyp');
    if (ffmpeg) {
      const path = join(h.home, 'replay.mp4');
      writeFileSync(path, bytes);
      expect(probe(path)).toMatchObject({ width: 320, height: 180, frames: report.frames });
    }
  }, 120_000);

  it.skipIf(!ffmpeg)('writes a file over MCP, and refuses a path that does not fit', async () => {
    const out = await call(claude, 'replay_export', { file_id: fileId, page_id: pageId, format: 'mp4', width: 320, height: 180, fps: 6, speed: 8 });
    expect(out.path).toMatch(/Replay-test-replay\.mp4$/);
    expect(out).toMatchObject({ format: 'mp4', steps: 5, width: 320, height: 180 });
    expect(readFileSync(out.path).subarray(4, 8).toString('latin1')).toBe('ftyp');
    const bad = await callRaw(claude, 'replay_export', { file_id: fileId, page_id: pageId, format: 'gif', path: join(h.home, 'exports', 'x.mp4') });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/needs a path ending in \.gif/);
  }, 120_000);
});
