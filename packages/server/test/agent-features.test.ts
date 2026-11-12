import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BogenDoc, listProposals, proposalMark, readBrand } from '@bogen/core';
import { buildCommand, claudeImageMessage } from '../src/agents.ts';
import { designFeatures, suggestRules, type Decision, type DesignFeatures } from '../src/memory.ts';
import { laneNames } from '../src/race.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Stand-ins for both CLIs. They log how they were called and what images they got, then use the MCP server
 * they were given, the way each real CLI is told to: Claude through --mcp-config, Codex through -c flags.
 */
function fakeClis(bin: string, log: string): void {
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0 (Fake)'); process.exit(0); }
if (args[0] === '--help') { console.log("  --model <model>  Provide an alias (e.g. 'opus', or 'sonnet')."); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({ models: [{ slug: 'small', display_name: 'Small', description: 'Fast and affordable', visibility: 'list', priority: 1 }] })); process.exit(0); }
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
const sys = args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : '';
const text = sys + '\\n' + stdin;
const images = [];
for (let i = 0; i < args.length; i++) if (args[i] === '-i') images.push({ via: 'file', base64: fs.readFileSync(args[i + 1]).toString('base64') });
if (args.includes('--input-format')) for (const line of stdin.split('\\n')) {
  if (!line.trim()) continue;
  for (const part of JSON.parse(line).message.content) if (part.type === 'image') images.push({ via: 'stream', base64: part.source.data, mime: part.source.media_type });
}
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ runner: ${JSON.stringify(name)}, ...o }) + '\\n');
log({ kind: 'call', args, text: text.slice(0, 40000), images });
const say = (o) => console.log(JSON.stringify(o));
const finish = () => { say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }); say({ type: 'result', is_error: false }); };
const mode = (/fake:(\\w+)/.exec(text) || [])[1];
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
let config = null;
if (args.includes('--mcp-config')) config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.bogen;
else {
  const url = args.find((a) => a.startsWith('mcp_servers.bogen.url='));
  const headers = args.find((a) => a.startsWith('mcp_servers.bogen.http_headers='));
  if (url) config = { url: JSON.parse(url.slice(url.indexOf('=') + 1)), headers: JSON.parse(headers.slice(headers.indexOf('=') + 1).replace(/"=/g, '":')) };
}
if (!config) { finish(); process.exit(0); }
const rpc = async (session, id, method, params) => {
  const res = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
  return { session: res.headers.get('mcp-session-id'), body: id ? await res.json() : null };
};
(async () => {
  const { session } = await rpc(null, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  await rpc(session, null, 'notifications/initialized', {});
  let n = 10;
  const tool = async (name, args) => (await rpc(session, n++, 'tools/call', { name, arguments: args })).body.result;
  if (mode === 'race') {
    const proposal = /Yours is proposal (\\w+)/.exec(text)[1];
    const agent = config.headers['X-Bogen-Agent'];
    const r = await tool('layer_rename', { node_id: proposal, name: 'by ' + agent });
    log({ kind: 'race', agent, proposal, ok: !r.isError });
    const screenshot = await tool('canvas_screenshot', { node_id: proposal });
    const review = await tool('design_verify', { node_id: proposal, discipline: 'foundations', observations: [
      { criterion: 'priority', verdict: 'pass', evidence: 'The single Hello title is the only content on this small card.' },
      { criterion: 'content', verdict: 'pass', evidence: 'The supplied Hello message remains unchanged after renaming the copy.' },
      { criterion: 'context', verdict: 'pass', evidence: 'The dark title is readable on its white 320 by 200 card, with no other controls.' },
    ] , rubric: ['hierarchy', 'type', 'spacing', 'colour', 'content', 'craft', 'originality', 'fit'].map((c) => ({ criterion: c, score: 3, evidence: 'The fixture screen holds one supplied heading, judged for ' + c + '.' })) });
    log({ kind: 'review', agent, screenshot: !screenshot.isError, result: review });
  }
  if (mode === 'critique') {
    const listed = (await rpc(session, 2, 'tools/list', {})).body.result.tools;
    const layer = /selected these layers: (\\w+)/.exec(text)[1];
    const write = await tool('layer_style', { node_ids: [layer], style: { color: 'red' } });
    const lint = await tool('design_lint', { node_id: layer, fix: true });
    const comment = await tool('comment_add', { node_id: layer, text: 'Too tight.', suggestion: 'Set gap to 16px.', check: 'lint' });
    log({ kind: 'critique', tools: listed.map((t) => ({ name: t.name, readOnly: t.annotations.readOnlyHint })), write: write.isError ? 'refused' : 'allowed', lint: lint.isError ? lint.content[0].text : 'ran', comment: comment.isError ? 'refused' : 'added' });
  }
  finish();
})();
`);
    chmodSync(join(bin, name), 0o755);
  }
}

describe('agent features with stand-in CLIs', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-features-bin-'));
  const log = join(bin, 'calls.jsonl');
  const savedPath = process.env.PATH;
  let h: Harness;
  let file: string;
  let page: string;
  let card: string;
  const entries = (kind?: string): any[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => !kind || e.kind === kind) : []);
  const races = async () => (await fetch(`${h.base}/api/races?fileId=${file}`)).json() as Promise<any[]>;
  const idle = () => until(() => !h.server.runs.activeFor(file), 8000);

  beforeAll(async () => {
    fakeClis(bin, log);
    process.env.PATH = `${bin}:${savedPath}`;
    h = await startServer();
    file = (await (await fetch(`${h.base}/api/files`, json({ name: 'Features' }))).json() as { id: string }).id;
    const room = await h.server.rooms.get(file);
    page = room.doc.getPages()[0]!.id;
    card = room.doc.insert(page, { type: 'frame', name: 'Card', style: { position: 'absolute', left: '0px', top: '0px', width: '320px', height: '200px', backgroundColor: '#ffffff' }, artboard: true });
    room.doc.insert(card, { type: 'text', name: 'Title', text: 'Hello', style: { color: '#111111' } });
  });

  afterAll(async () => {
    process.env.PATH = savedPath;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  beforeEach(() => rmSync(log, { force: true }));

  describe('a race', () => {
    it('names lanes apart, so two Claudes get two cursors and two undos', () => {
      expect(laneNames([{ runner: 'claude', model: 'sonnet' }, { runner: 'codex' }, { runner: 'claude', model: 'sonnet' }, { runner: 'claude', model: 'opus[1m]' }])).toEqual(['claude sonnet', 'codex', 'claude sonnet 2', 'claude opus1m']);
    });

    it('starts one run per lane, each in its own proposal, under its own name and colour', async () => {
      const res = await fetch(`${h.base}/api/races`, json({ fileId: file, nodeId: card, prompt: 'Make it calmer fake:race', lanes: [{ runner: 'claude' }, { runner: 'codex' }, { runner: 'claude', model: 'opus' }], who: 'Mara' }));
      expect(res.status).toBe(201);
      const race = await res.json() as any;
      expect(race.lanes.map((l: any) => l.agent)).toEqual(['claude', 'codex', 'claude opus']);
      const room = await h.server.rooms.get(file);
      const copies = listProposals(room.doc).filter((p) => p.race?.id === race.id);
      expect(copies).toHaveLength(3);
      expect(new Set(copies.map((p) => p.race!.color)).size).toBe(3);
      expect(copies.map((p) => p.by)).toEqual(['claude', 'codex', 'claude opus']);
      // One group: accepting one discards the others.
      expect(new Set(copies.map((p) => proposalMark(room.doc, p.id)!.group)).size).toBe(1);

      await until(async () => (await races())[0].lanes.every((l: any) => l.status === 'done'), 10_000);
      const worked = entries('race');
      expect(worked).toHaveLength(3);
      expect(entries('review')).toHaveLength(3);
      for (const reviewed of entries('review')) {
        expect(reviewed.screenshot).toBe(true);
        expect(reviewed.result.isError).not.toBe(true);
        const report = JSON.parse(reviewed.result.content.find((c: any) => c.type === 'text').text);
        expect(report.automated.state).toBe('passed');
        expect(report.visual.state).toBe('self-assessed');
      }
      // Each lane changed only its own copy, and was told which one that is.
      for (const lane of race.lanes) {
        expect(worked.find((w) => w.agent === lane.agent)).toMatchObject({ proposal: lane.proposalId, ok: true });
        expect(room.doc.getNode(lane.proposalId)!.name).toBe(`by ${lane.agent}`);
      }
      expect(entries('call').every((c) => !/proposal_create on the layer with count 3/.test(c.text))).toBe(true);
      // Codex got the lane's name too, not just its runner's.
      expect(entries('call').find((c) => c.runner === 'codex').args.join(' ')).toContain('"X-Bogen-Agent"="codex"');

      // Undo is per lane: the second Claude takes back only its own rename.
      expect(room.undoAgent('claude opus')).toBe(true);
      expect(room.doc.getNode(race.lanes[2].proposalId)!.name).not.toBe('by claude opus');
      expect(room.doc.getNode(race.lanes[0].proposalId)!.name).toBe('by claude');

      // Done, so the names go back to their usual cursor colours.
      expect(h.server.rooms.agentColors.size).toBe(0);
      const history = await (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as any[];
      expect(history.filter((r) => r.race?.id === race.id).map((r) => r.race.agent).sort()).toEqual(['claude', 'claude opus', 'codex']);

      // Accept one: the others go, and the original takes the copy's content.
      const accepted = await (await fetch(`${h.base}/api/races/${race.id}/accept`, json({ laneId: 'l2', keep: 'discard', who: 'Mara' }))).json() as any;
      expect(accepted.node_id ?? accepted.nodeId).toBe(card);
      expect(accepted.discarded.sort()).toEqual([race.lanes[0].proposalId, race.lanes[2].proposalId].sort());
      expect(listProposals(room.doc)).toHaveLength(0);
      const after = (await races()).find((r) => r.id === race.id);
      expect(after.lanes.map((l: any) => l.decision)).toEqual(['discarded', 'accepted', 'discarded']);
    }, 20_000);

    it('waits for a free slot of a runner, stops one lane or all, and keeps the rest as a branch', async () => {
      await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', limit: 1 }, 'PATCH'));
      const race = await (await fetch(`${h.base}/api/races`, json({ fileId: file, nodeId: card, prompt: 'Bolder fake:hang', lanes: [{ runner: 'claude' }, { runner: 'codex' }, { runner: 'claude' }] }))).json() as any;
      await until(async () => (await races())[0].lanes.filter((l: any) => l.status === 'working' && l.runId).length === 2, 8000);
      let lanes = (await races())[0].lanes;
      expect(lanes.map((l: any) => l.status)).toEqual(['working', 'working', 'queued']);
      expect(lanes[2].waiting).toMatch(/free claude: 1 at once/);
      // While a race runs, nothing else starts on the file.
      expect((await fetch(`${h.base}/api/runs`, json({ fileId: file, prompt: 'x', runner: 'codex' }))).status).toBe(409);

      // Stopping the first Claude lets the second start.
      await fetch(`${h.base}/api/races/${race.id}/stop`, json({ laneId: 'l1' }));
      await until(async () => (await races())[0].lanes[2].status === 'working' && Boolean((await races())[0].lanes[2].runId), 8000);
      lanes = (await races())[0].lanes;
      expect(lanes[0].status).toBe('stopped');

      // Accepting stops whatever still runs, and keeps the copies in a branch inside the file first: no other file.
      const files = h.server.storage.list().length;
      const out = await (await fetch(`${h.base}/api/races/${race.id}/accept`, json({ laneId: 'l2', keep: 'branch' }))).json() as any;
      expect(out.branch.name).toMatch(/^race: Bolder/);
      expect(out.branch).toMatchObject({ fileId: file, internal: true });
      expect(h.server.storage.list().length).toBe(files);
      await idle();
      lanes = (await races())[0].lanes;
      expect(lanes.map((l: any) => l.status)).toEqual(['stopped', 'stopped', 'stopped']);
      const { branchContent, currentBranchId, docFromContent } = await import('@bogen/core');
      const doc = (await h.server.rooms.get(file)).doc;
      expect(currentBranchId(doc)).toBe('main');
      expect(listProposals(docFromContent(branchContent(doc, out.branch.id))).filter((p) => p.race?.id === race.id)).toHaveLength(3);
      expect(listProposals((await h.server.rooms.get(file)).doc)).toHaveLength(0);
      await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', limit: 2 }, 'PATCH'));
    });

    it('admits sixteen lanes and stops all of them, rejecting seventeen', async () => {
      const bad = await fetch(`${h.base}/api/races`, json({ fileId: file, nodeId: card, prompt: 'fake:hang', lanes: Array.from({ length: 17 }, () => ({ runner: 'claude' })) }));
      expect(bad.status).toBe(400);
      await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', limit: 16 }, 'PATCH'));
      const res = await fetch(`${h.base}/api/races`, json({ fileId: file, nodeId: card, prompt: 'Sixteen fake:hang', lanes: Array.from({ length: 16 }, () => ({ runner: 'claude' })) }));
      expect(res.status).toBe(201);
      const race = await res.json() as any;
      await until(async () => (await races()).find((r: any) => r.id === race.id).lanes.every((l: any) => Boolean(l.runId)), 15000);
      expect(h.server.runs.count()).toBe(16);
      expect(new Set(race.lanes.map((l: any) => l.agent)).size).toBe(16);
      expect((await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', limit: 17 }, 'PATCH'))).status).toBe(400);
      await fetch(`${h.base}/api/races/${race.id}/stop`, json({}));
      await idle();
      expect(h.server.runs.count()).toBe(0);
      for (const lane of race.lanes) {
        expect((await fetch(`${h.base}/api/races/${race.id}/discard`, json({ laneId: lane.id }))).status).toBe(200);
      }
      await fetch(`${h.base}/api/run-settings`, json({ runner: 'claude', limit: 2 }, 'PATCH'));
    });

    it('stops all lanes at once, and refuses a race of one', async () => {
      expect((await fetch(`${h.base}/api/races`, json({ fileId: file, nodeId: card, prompt: 'x', lanes: [{ runner: 'claude' }] }))).status).toBe(400);
      const race = await (await fetch(`${h.base}/api/races`, json({ fileId: file, nodeId: card, prompt: 'Again fake:hang', lanes: [{ runner: 'claude' }, { runner: 'codex' }] }))).json() as any;
      await until(async () => (await races())[0].lanes.every((l: any) => l.runId), 8000);
      await fetch(`${h.base}/api/races/${race.id}/stop`, json({}));
      await idle();
      expect((await races())[0].lanes.map((l: any) => l.status)).toEqual(['stopped', 'stopped']);
      await fetch(`${h.base}/api/races/${race.id}/discard`, json({ laneId: 'l1' }));
      await fetch(`${h.base}/api/races/${race.id}/discard`, json({ laneId: 'l2' }));
      expect(listProposals((await h.server.rooms.get(file)).doc)).toHaveLength(0);
    });
  });

  describe('a critique', () => {
    it('gets only tools that read and comment, and leaves its notes pinned with a suggestion', async () => {
      const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, nodeIds: [card], prompt: 'Critique this fake:critique', runner: 'codex', review: 'critique' }));
      expect(res.status).toBe(201);
      await idle();
      const seen = entries('critique')[0];
      const names: string[] = seen.tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(['layer_tree', 'canvas_screenshot', 'design_lint', 'responsive_check', 'brand_check', 'comment_add', 'comment_reply']));
      for (const write of ['html_write', 'layer_style', 'layer_delete', 'batch', 'proposal_create', 'proposal_accept', 'tokens_set', 'agent_undo', 'comment_resolve', 'export_file', 'asset_upload']) expect(names).not.toContain(write);
      expect(seen.tools.filter((t: any) => !t.readOnly).map((t: any) => t.name).sort()).toEqual(['brand_check', 'comment_add', 'comment_reply', 'design_lint', 'file_open']);
      expect(seen.write).toBe('refused');
      expect(seen.lint).toMatch(/critique and fixes nothing/);
      expect(seen.comment).toBe('added');
      expect(entries('call')[0].text).toContain('This is a critique.');

      const thread = (await h.server.rooms.get(file)).doc.getComments().find((t) => t.suggestion);
      expect(thread).toMatchObject({ nodeId: card, suggestion: { text: 'Set gap to 16px.', check: 'lint', by: 'codex' } });
      expect(thread!.messages[0]!.text).toBe('Too tight.');
      expect((await h.server.rooms.get(file)).doc.getNode(card)!.style.color).toBeUndefined();
    });

    it('gives the same agent all its tools in a run that is not a critique', async () => {
      const agent = await connectAgent(h.base, 'normal');
      const names = (await agent.listTools()).tools.map((t) => t.name);
      expect(names).toContain('html_write');
      expect(names).toContain('batch');
      await agent.close();
    });
  });

  describe('an image to layers', () => {
    // 1x1 PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    let image: string;

    beforeAll(async () => {
      const asset = await (await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json() as { src: string };
      const room = await h.server.rooms.get(file);
      image = room.doc.insert(page, { type: 'image', name: 'Whiteboard', src: asset.src, style: { position: 'absolute', left: '0px', top: '600px', width: '400px', height: '300px' } });
    });

    it('reaches Codex as -i, before the flags, and Claude as an image block', async () => {
      for (const runner of ['codex', 'claude']) {
        rmSync(log, { force: true });
        const res = await fetch(`${h.base}/api/runs/rebuild`, json({ fileId: file, nodeId: image, runner }));
        expect(res.status).toBe(201);
        await idle();
        const called = entries('call')[0];
        expect(called.images).toHaveLength(1);
        expect(called.images[0].base64).toBe(png.toString('base64'));
        if (runner === 'codex') expect(called.args.slice(0, 3)).toEqual(['exec', '-i', expect.stringMatching(/image-1\.png$/)]);
        else {
          expect(called.images[0]).toMatchObject({ via: 'stream', mime: 'image/png' });
          expect(called.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
        }
        expect(called.text).toContain(`Rebuild the attached image as editable layers. It is image layer ${image}`);
        expect(called.text).toContain(`other_node_id ${image}`);
      }
      const record = (await (await fetch(`${h.base}/api/runs?fileId=${file}`)).json() as any[])[0];
      expect(record).toMatchObject({ rebuildOf: image, title: 'Rebuild as layers: Whiteboard' });
    });

    it('refuses a layer that is not an image', async () => {
      expect((await fetch(`${h.base}/api/runs/rebuild`, json({ fileId: file, nodeId: card, runner: 'claude' }))).status).toBe(400);
    });

    it('puts the image in the first message as Claude expects it', () => {
      const line = JSON.parse(claudeImageMessage('Look', [{ data: png, mime: 'image/png', name: 'a.png' }]));
      expect(line).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] } });
      const { args, stdin } = buildCommand('claude', { fileId: 'f', fileName: 'F', prompt: 'Look', runner: 'claude', images: [{ data: png, mime: 'image/png', name: 'a.png' }] }, { url: 'http://x/mcp' }, '/tmp/c.json', '/tmp');
      expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json']));
      expect(stdin.endsWith('\n')).toBe(true);
    });
  });
});

describe('memory from decisions', () => {
  const f = (over: Partial<DesignFeatures>): DesignFeatures => ({ layers: 5, gradient: false, shadow: false, uppercase: false, radius: 4, spacing: 16, contrast: 12, fonts: 1, colors: 3, ...over });
  const d = (decision: Decision['decision'], features: Partial<DesignFeatures>, i = 0): Decision => ({ id: `p${i}${Math.random()}`, fileId: 'f', decision, at: i, by: 'claude', features: f(features) });

  it('measures gradients, shadows, radius, spacing, contrast and fonts from styles and tokens', async () => {
    const doc = new BogenDoc();
    const pageId = doc.createPage('P');
    doc.setToken('round', 'radius', '12px');
    const root = doc.insert(pageId, { type: 'frame', name: 'A', style: { background: 'linear-gradient(#fff, #000)', borderRadius: 'var(--round)', padding: '24px', gap: '8px', backgroundColor: '#000000' } });
    doc.insert(root, { type: 'text', name: 'T', text: 'x', style: { color: '#333333', textTransform: 'uppercase', fontFamily: '"Inter", sans-serif', boxShadow: '0 1px 2px #000' } });
    const out = designFeatures(doc, root)!;
    expect(out).toMatchObject({ layers: 2, gradient: true, shadow: true, uppercase: true, radius: 12, spacing: 16, fonts: 1 });
    expect(out.contrast).toBeLessThan(2);
  });

  it('suggests a rule after repeated discards, and nothing before', () => {
    const three = [d('discarded', { gradient: true }, 1), d('discarded', { gradient: true }, 2), d('accepted', {}, 3)];
    expect(suggestRules(three.slice(0, 2), null)).toEqual([]);
    const four = [...three, d('discarded', { gradient: true }, 4), d('discarded', { gradient: true }, 5)];
    const [rule] = suggestRules(four, null);
    expect(rule).toMatchObject({ id: 'no-gradient', why: 'You discarded 4 of 4 proposals with gradients.', action: { rule: { kind: 'dont', check: { type: 'no-gradient' } } } });
    // Dismissed, or already a rule of the brand: not again.
    expect(suggestRules(four, null, ['no-gradient'])).toEqual([]);
    const brand = readBrand(new BogenDoc());
    expect(suggestRules(four, { ...brand, fields: { ...brand.fields, gradients: 'none' } })).toEqual([]);
  });

  it('sees accepted proposals keep tighter corners and more room', () => {
    const list = [
      d('accepted', { radius: 4, spacing: 32 }), d('accepted', { radius: 0, spacing: 40 }),
      d('discarded', { radius: 16, spacing: 12 }), d('discarded', { radius: 20, spacing: 16 }),
    ];
    const ids = suggestRules(list, null).map((s) => s.id);
    expect(ids).toEqual(['radius-max-4', 'spacing-min-32']);
    const square = suggestRules([d('accepted', { radius: 0 }), d('accepted', { radius: 0 }), d('discarded', { radius: 16 }), d('discarded', { radius: 12 })], null).find((s) => s.id === 'radius-max-0');
    expect(square).toMatchObject({ text: 'Keep corners square: no radius', why: 'Accepted proposals had square corners; discarded ones had 14px.' });
  });

  it('records decisions per brand over the real loop, suggests a rule, tells agents, and adds it only when asked', async () => {
    const h = await startServer();
    try {
      const brand = await (await fetch(`${h.base}/api/brands`, json({ name: 'Calm' }))).json() as { id: string };
      const fileId = (await (await fetch(`${h.base}/api/files`, json({ name: 'Decisions' }))).json() as { id: string }).id;
      expect((await fetch(`${h.base}/api/files/${fileId}/brand`, json({ brandId: brand.id }, 'PUT'))).status).toBe(200);
      const agent = await connectAgent(h.base, 'designer');
      await call(agent, 'file_open', { file_id: fileId });
      const board = (await call(agent, 'artboard_create', { name: 'Hero', width: 400, height: 300 })).id;
      for (let round = 0; round < 2; round++) {
        const made = await call(agent, 'proposal_create', { node_id: board, count: 3, notes: ['Flat', 'Glow', 'Shine'] });
        const [flat, glow, shine] = made.proposals.map((p: any) => p.id);
        await call(agent, 'layer_style', { node_ids: [glow, shine], style: { background: 'linear-gradient(90deg, #a0f, #0af)' } });
        // The person picks the flat one; the server measures the copies before they go.
        expect((await fetch(`${h.base}/api/files/${fileId}/proposals/${flat}/accept`, json({ who: 'Mara' }))).status).toBe(200);
      }
      await h.server.memory.flush();
      await until(async () => (await (await fetch(`${h.base}/api/brands/${brand.id}/memory`)).json() as any).decisions === 6);
      const view = await (await fetch(`${h.base}/api/brands/${brand.id}/memory`)).json() as any;
      expect(view).toMatchObject({ accepted: 2, discarded: 4, files: 1 });
      expect(view.recent[0]).toMatchObject({ fileId, brandId: brand.id, by: 'designer' });
      expect(Object.keys(view.recent[0]).sort()).toEqual(['at', 'brandId', 'by', 'decision', 'features', 'fileId', 'id', 'note']);
      const suggestion = view.suggestions.find((s: any) => s.id === 'no-gradient');
      expect(suggestion.why).toBe('You discarded 4 of 4 proposals with gradients.');

      // Nothing was applied: the brand has no rule yet. Agents hear a short summary.
      const before = readBrand((await h.server.rooms.get(brand.id)).doc);
      expect(before.rules).toEqual([]);
      const got = await call(agent, 'brand_get', { brand_id: brand.id });
      expect(got.decisions).toMatch(/^6 proposals decided in linked files: 2 accepted, 4 discarded\. Seen: You discarded 4 of 4 proposals with gradients\. A preference, not a rule/);

      expect((await fetch(`${h.base}/api/brands/${brand.id}/memory/no-gradient`, json({ action: 'add', by: 'Mara' }))).status).toBe(200);
      const rules = readBrand((await h.server.rooms.get(brand.id)).doc).rules;
      expect(rules).toEqual([expect.objectContaining({ text: 'No gradients', kind: 'dont', check: { type: 'no-gradient' }, source: 'memory' })]);
      expect(rules[0]!.suggested).toBeUndefined();
      const again = await (await fetch(`${h.base}/api/brands/${brand.id}/memory`)).json() as any;
      expect(again.suggestions.find((s: any) => s.id === 'no-gradient')).toBeUndefined();

      // A critique changed nothing, so its end brings no new score; any other run does.
      await h.server.brands.runEnded({ runId: 'crit', fileId, runner: 'claude', status: 'done', review: 'critique' });
      expect(h.server.brands.lastReport(fileId)).toBeUndefined();
      await h.server.brands.runEnded({ runId: 'work', fileId, runner: 'claude', status: 'done', review: 'proposal' });
      expect(h.server.brands.lastReport(fileId)?.runId).toBe('work');
      await agent.close();
    } finally {
      await h.cleanup();
    }
  });
});
