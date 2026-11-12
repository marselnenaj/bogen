import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertClean, cleanPublishedPage, Y } from '@bogen/core';
import { isLocalOnlyPath } from '../src/peers.ts';
import { phoneRefusedPath } from '../src/phone.ts';
import { GhError, gitBlobSha, type GhCli } from '../src/publish-github.ts';
import { plainClientText, stripMentions } from '../src/shares.ts';
import { safeSegments, StaticListener } from '../src/static-listener.ts';
import type { ServeStatus, TailscaleCli } from '../src/tailnet.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const NAME = 'omarchy.tail123456.ts.net';
const OWNER = 'owner@example.com';
const SITE_HTTPS = 10000;
const REVIEW_HTTPS = 29445;

/** A stand-in for the Tailscale CLI, whose serve config already has other apps in it, one of them public. */
function fakeTailscale(funnel: boolean | null = true): TailscaleCli & { calls: string[]; config: ServeStatus } {
  const config: ServeStatus = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: { [`${NAME}:443`]: { Handlers: { '/clip': { Proxy: 'http://127.0.0.1:8787' } } }, [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8766' } } } },
    AllowFunnel: { [`${NAME}:443`]: true },
  };
  const calls: string[] = [];
  const add = (port: number, target: string) => {
    config.TCP![port] = { HTTPS: true };
    config.Web![`${NAME}:${port}`] = { Handlers: { '/': { Proxy: target } } };
  };
  const remove = (port: number) => {
    delete config.TCP![port];
    delete config.Web![`${NAME}:${port}`];
    delete config.AllowFunnel![`${NAME}:${port}`];
  };
  return {
    calls, config,
    self: async () => ({ dnsName: NAME, ownerLogin: OWNER, ips: ['100.64.0.10'], peers: [], funnel }),
    serveStatus: async () => structuredClone(config),
    serve: async (port, target) => { calls.push(`serve ${port} ${target}`); add(port, target); },
    serveOff: async (port) => { calls.push(`off ${port}`); remove(port); },
    funnel: async (port, target) => { calls.push(`funnel ${port} ${target}`); add(port, target); config.AllowFunnel![`${NAME}:${port}`] = true; },
    funnelOff: async (port) => { calls.push(`funnel-off ${port}`); remove(port); },
    packetFilter: async () => [],
  };
}

/** A stand-in for `gh api`: one repository in memory, with git's own blob ids. */
function fakeGh(): GhCli & { repo: { branches: Map<string, string>; trees: Map<string, Map<string, string>>; blobs: Map<string, Buffer> }; calls: string[] } {
  const branches = new Map<string, string>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const trees = new Map<string, Map<string, string>>();
  const blobs = new Map<string, Buffer>();
  const calls: string[] = [];
  const id = (x: unknown) => createHash('sha1').update(JSON.stringify(x)).update(String(Math.random())).digest('hex');
  return {
    calls, repo: { branches, trees, blobs },
    api: async (path, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const body = options.body as Record<string, any>;
      let m: RegExpExecArray | null;
      if (path === 'repos/me/site' && method === 'GET') return { permissions: { push: true } };
      if (!path.startsWith('repos/me/site/')) throw new GhError(404, 'Not Found (HTTP 404)');
      const rest = path.slice('repos/me/site/'.length);
      if ((m = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
        const sha = branches.get(m[1]!);
        if (!sha) throw new GhError(404, 'Not Found (HTTP 404)');
        return { object: { sha } };
      }
      if ((m = /^git\/commits\/(\w+)$/.exec(rest))) return { tree: { sha: commits.get(m[1]!)!.tree } };
      if ((m = /^git\/trees\/(\w+)\?recursive=1$/.exec(rest))) return { tree: [...trees.get(m[1]!)!].map(([p, sha]) => ({ path: p, type: 'blob', sha })) };
      if ((m = /^git\/blobs\/(\w+)$/.exec(rest))) return { content: blobs.get(m[1]!)!.toString('base64') };
      if (rest === 'git/blobs' && method === 'POST') {
        const bytes = Buffer.from(body.content, 'base64');
        const sha = gitBlobSha(bytes);
        blobs.set(sha, bytes);
        return { sha };
      }
      if (rest === 'git/trees' && method === 'POST') {
        const tree = new Map(body.base_tree ? trees.get(body.base_tree) : []);
        for (const e of body.tree) e.sha === null ? tree.delete(e.path) : tree.set(e.path, e.sha);
        const sha = id([...tree]);
        trees.set(sha, tree);
        return { sha };
      }
      if (rest === 'git/commits' && method === 'POST') {
        const sha = id(body);
        commits.set(sha, { tree: body.tree, parents: body.parents });
        return { sha };
      }
      if ((m = /^git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') return void branches.set(m[1]!, body.sha), {};
      if (rest === 'git/refs' && method === 'POST') return void branches.set(body.ref.replace('refs/heads/', ''), body.sha), {};
      throw new GhError(404, `No stand-in for ${method} ${path}`);
    },
  };
}

/** Puts files on a branch of the stand-in as someone else would. */
function seedBranch(gh: ReturnType<typeof fakeGh>, branch: string, files: Record<string, string>): void {
  const tree = new Map<string, string>();
  for (const [p, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    tree.set(p, gitBlobSha(bytes));
    gh.repo.blobs.set(gitBlobSha(bytes), bytes);
  }
  const treeSha = `t${Math.random().toString(16).slice(2)}`;
  gh.repo.trees.set(treeSha, tree);
  void gh.api('repos/me/site/git/commits', { method: 'POST', body: { tree: treeSha, parents: [] } }).then((c) => gh.repo.branches.set(branch, (c as { sha: string }).sha));
}

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }

/** Raw HTTP, since fetch will not send a Host or Origin of our choosing. */
function raw(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

let h: Harness | null = null;
let ts: ReturnType<typeof fakeTailscale>;
let gh: ReturnType<typeof fakeGh>;
const savedHome = process.env.HOME;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  process.env.HOME = savedHome;
  vi.restoreAllMocks();
});

async function boot(funnel: boolean | null = true): Promise<Harness> {
  ts = fakeTailscale(funnel);
  gh = fakeGh();
  h = await startServer({ tailscale: ts, gh, publishFetch: null, sitePort: 0, reviewPort: 0, siteHttpsPort: SITE_HTTPS, reviewHttpsPort: REVIEW_HTTPS });
  return h;
}

const mainPort = () => Number(new URL(h!.base).port);

/** The editor on this machine: a browser's same-origin request. */
function editor(path: string, method: string, body?: unknown): Promise<Answer> {
  return raw(mainPort(), path, { method, headers: { Host: `127.0.0.1:${mainPort()}`, Origin: h!.base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** The CLI, or any local program: no Origin. */
function local(path: string, method: string, body?: unknown): Promise<Answer> {
  return raw(mainPort(), path, { method, headers: { Host: `127.0.0.1:${mainPort()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

const viaServe = (https: number, extra: Record<string, string> = {}) => ({ Host: `${NAME}:${https}`, 'Tailscale-User-Login': OWNER, 'X-Forwarded-For': '100.64.0.11', ...extra });

/** A file with an artboard that has everything that must not be published, and things that must be. */
async function designWithSecrets(): Promise<{ fileId: string; boardId: string; hiddenId: string; agent: Awaited<ReturnType<typeof connectAgent>> }> {
  const agent = await connectAgent(h!.base, 'claude');
  const file = await call(agent, 'file_create', { name: 'Couchette' });
  const board = await call(agent, 'artboard_create', { name: 'Hero', width: 1200, file_id: file.id });
  await call(agent, 'html_write', {
    target_id: board.id, file_id: file.id,
    html: `<style>@media (max-width: 600px) { .title { font-size: 20px } }</style><section style="display:flex;flex-direction:column;gap:12px;padding:40px"><h1 class="title" style="font-size:48px">Night trains</h1><p>Sleep through Europe.</p><img alt="Compartment" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" style="width:200px;height:100px"><p>Hidden note: client budget is 4000</p></section>`,
  });
  const found = await call(agent, 'layer_find', { file_id: file.id, text: 'Hidden note' }) as { layers: { id: string }[] };
  const hiddenId = found.layers[0]!.id;
  await call(agent, 'layer_set_flags', { file_id: file.id, node_ids: [hiddenId], hidden: true });
  await call(agent, 'comment_add', { file_id: file.id, node_id: board.id, text: 'Internal: agent thinks the price is too low' });
  return { fileId: file.id, boardId: board.id, hiddenId, agent };
}

describe('the cleaning pass', () => {
  it('drops scripts, handlers, comments, data attributes, ids and inline styles', () => {
    const source = `<!doctype html><html><head><style>.bgn-abc123defg::before{content:"x"} /* note */</style></head><body><div data-bogen-id="abc123defg" class="bgn-abc123defg" style="position:absolute;left:10px;top:0;width:800px;height:400px;background:#fff" data-mode="dark"><!-- secret --><script>alert(1)</script><p data-agent="claude" onclick="steal()" style="color:red} body{display:none">Hi</p><iframe src="https://evil.example/" data-bogen-id="frm1234567"></iframe><a href="javascript:alert(1)">x</a><a href="https://ok.example/">ok</a><img src="https://elsewhere.example/a.png"><span data-bogen-id="gone123456">hidden words</span></div></body></html>`;
    const out = cleanPublishedPage(source, {
      title: 'T', stylesheet: 'index.css', url: () => null, layer: (id) => (id === 'gone123456' ? { drop: true } : {}), forbidden: ['abc123defg', 'gone123456', 'frm1234567'], csp: "default-src 'none'",
    });
    expect(out.html).not.toMatch(/<script|onclick|data-agent|data-bogen|<!--|javascript:|style=|abc123defg|hidden words|evil\.example|elsewhere\.example/);
    expect(out.html).toMatch(/data-mode="dark"/);
    expect(out.html).toMatch(/href="https:\/\/ok\.example\/"/);
    expect(out.html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;|<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    expect(out.css).not.toMatch(/abc123defg|\/\*|display:none/);
    expect(out.css).toMatch(/\.r1::before\{content:"x"\}/);
    // The top-level layer as a page: in the flow and as wide as the window.
    expect(out.css).toMatch(/width:\s?100%/);
    expect(out.css).not.toMatch(/left:\s?10px/);
    expect(out.notes.join(' ')).toMatch(/Embeds of other sites/);
  });

  it('refuses to let a known id through, even in words', () => {
    expect(() => assertClean('<p>see k3jd8s0a2m</p>', '', ['k3jd8s0a2m'])).toThrow(/layer id/);
    expect(() => assertClean('<p>fine</p>', '.x{}', ['k3jd8s0a2m'])).not.toThrow();
    expect(() => assertClean('<p onload="x()">', '', [])).toThrow(/script/);
  });
});

describe('client words', () => {
  it('lose their mentions and their markup', () => {
    expect(stripMentions('@claude fix it, cc @codex and @anna. Mail me@example.com')).toBe('claude fix it, cc codex and anna. Mail me@example.com');
    expect(stripMentions('(@@claude)')).toBe('(claude)');
    expect(plainClientText('<script>alert(1)</script><b>Big</b> <img src=x onerror=alert(1)>words‮', 100)).toBe('alert(1)Big words');
    expect(plainClientText('a'.repeat(50), 10)).toBe('a'.repeat(10));
    expect(stripMentions('＠claude and ﹫codex')).toBe('claude and codex');
  });

  it('cannot hide a mention behind markup or invisible characters', async () => {
    await boot();
    const { fileId, boardId } = await designWithSecrets();
    const { site, version } = (await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId })).json();
    await editor('/api/publish/listeners/review', 'POST', { on: true });
    const { token } = (await editor('/api/shares', 'POST', { siteId: site.id, versionId: version.id, label: 'A', comments: true })).json();
    const port = h!.server.reviewListener.boundPort;
    const sent = await raw(port, `/r/${token}/_review/comments`, {
      method: 'POST', body: new URLSearchParams({ name: '@<i></i>claude', text: '@\u200bclaude go, @<b></b>codex too' }).toString(),
      headers: viaServe(REVIEW_HTTPS, { Origin: `https://${NAME}:${REVIEW_HTTPS}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }),
    });
    expect(sent.status).toBe(303);
    const [item] = (await local('/api/publish', 'GET')).json().inbox;
    expect(item).toMatchObject({ name: 'claude', text: 'claude go, codex too', mentionsRemoved: true });
  });
});

describe('paths on a static listener', () => {
  it('are plain segments, decoded once', () => {
    expect(safeSegments('/')).toEqual({ segments: [], dir: true });
    expect(safeSegments('/assets/a.png')).toEqual({ segments: ['assets', 'a.png'], dir: false });
    for (const bad of ['/../x', '/a/../../x', '/%2e%2e/x', '/%2E%2E%2Fx', '/a%2fb', '/a%5cb', '/%252e%252e/x', '/a\\b', '/.hidden', '/a//b', '/%00', '/a/./b', 'relative', '/%c0%ae%c0%ae/x']) {
      expect(safeSegments(bad), bad).toBeNull();
    }
  });
});

describe('publishing', () => {
  it('exports static files with no ids, tokens or metadata', async () => {
    await boot();
    const { fileId, boardId, hiddenId } = await designWithSecrets();
    const made = await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId });
    expect(made.status).toBe(201);
    const { site, version } = made.json();
    expect(version.id).toMatch(/^[a-f0-9]{32}$/);
    const files = await h!.server.publisher.files(version.id);
    const names = [...files.keys()].sort();
    expect(names).toContain('index.html');
    expect(names).toContain('index.css');
    expect(names.some((n) => /^assets\/[a-f0-9]{20}\.png$/.test(n))).toBe(true);
    // The review form's picture is made with the version, beside the site and not part of it.
    expect(existsSync(join(h!.server.publisher.versionDir(version.id), 'review', 'shot-0.png'))).toBe(true);
    expect(names.some((n) => n.startsWith('review/'))).toBe(false);
    const all = [...files.values()].map((b) => Buffer.from(b).toString('utf8')).join('\n');
    const room = await h!.server.rooms.get(fileId);
    const ids: string[] = [fileId, site.id, ...room.doc.getPages().map((p) => p.id)];
    room.doc.nodes.forEach((_m, id) => ids.push(id));
    for (const id of ids) expect(all.includes(id), id).toBe(false);
    expect(all).not.toMatch(/<script|data-bogen|bogen-asset|<!--|\/api\/|client budget|Internal: agent|claude/);
    expect(all).toMatch(/@media \(max-width: ?600px\)/);
    expect(all).toMatch(/Night trains/);
    expect(Buffer.from(files.get('index.html')!).toString()).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'/);
    expect(hiddenId).toBeTruthy();
    if (process.env.BOGEN_DUMP) writeFileSync(process.env.BOGEN_DUMP, [...files].map(([k, v]) => `=== ${k}\n${k.endsWith('.png') ? '(png)' : Buffer.from(v).toString()}`).join('\n'));
  });

  it('needs the owner in the editor: not the CLI, not MCP, not the phone, not a peer', async () => {
    await boot();
    const { fileId, boardId, agent } = await designWithSecrets();
    const prepared = await call(agent, 'publish_prepare', { file_id: fileId, node_id: boardId, target: 'listener' });
    expect(prepared.status).toMatch(/owner/);
    const tools = (await agent.listTools()).tools.map((t) => t.name);
    expect(tools.filter((t) => /^(publish|share)_/.test(t)).sort()).toEqual(['publish_list', 'publish_prepare', 'share_list', 'share_prepare']);
    const { sites, requests } = (await local('/api/publish', 'GET')).json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'publish', by: 'claude' });
    const siteId = sites[0].id;
    const body = { version: prepared.version_id, target: 'listener' };
    expect((await local(`/api/publish/sites/${siteId}/publish`, 'POST', body)).status).toBe(403);
    expect((await local('/api/publish/listeners/site', 'POST', { on: true })).status).toBe(403);
    expect((await local('/api/shares', 'POST', { siteId, versionId: prepared.version_id, comments: true })).status).toBe(403);
    // Another site's page cannot send it either.
    const foreign = await raw(mainPort(), `/api/publish/sites/${siteId}/publish`, { method: 'POST', headers: { Host: `127.0.0.1:${mainPort()}`, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(foreign.status).toBe(403);
    // A request through a local proxy is not this machine.
    const proxied = await raw(mainPort(), `/api/publish/sites/${siteId}/publish`, { method: 'POST', headers: { Host: `127.0.0.1:${mainPort()}`, Origin: h!.base, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '1.2.3.4', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(proxied.status).toBe(403);
    expect(isLocalOnlyPath('/api/publish/sites/x/publish')).toBe(true);
    expect(isLocalOnlyPath('/api/shares')).toBe(true);
    expect(phoneRefusedPath('/api/publish')).toBe(true);
    expect(phoneRefusedPath('/api/shares/inbox/x/accept')).toBe(true);
    expect((await editor(`/api/publish/sites/${siteId}/publish`, 'POST', body)).status).toBe(200);
    expect((await local('/api/publish', 'GET')).json().requests).toHaveLength(0);
  });

  it('serves only the published files on its own listener, with strict headers', async () => {
    await boot();
    const { fileId, boardId } = await designWithSecrets();
    const { site, version } = (await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId })).json();
    const port = () => h!.server.siteListener.boundPort;
    expect((await editor(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'listener' })).status).toBe(200);
    const on = await editor('/api/publish/listeners/site', 'POST', { on: true });
    expect(on.json().outcome.state).toBe('added');
    expect(ts.calls).toEqual([`serve ${SITE_HTTPS} http://127.0.0.1:${port()}`]);

    const page = await raw(port(), '/', { headers: viaServe(SITE_HTTPS) });
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/Night trains/);
    expect(page.headers['content-security-policy']).toBe("default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(page.headers['set-cookie']).toBeUndefined();
    const css = await raw(port(), '/index.css', { headers: viaServe(SITE_HTTPS) });
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);

    // Traversal, encoded or not, and everything that is not a file of the site.
    for (const path of ['/../state.json', '/..%2f..%2fstate.json', '/%2e%2e/manifest.json', '/assets/..%2F..%2Fmanifest.json', '/%252e%252e/%252e%252e/state.json', '/..\\..\\state.json', '/.bogen-publish.json', '/manifest.json', '/site/index.html', '//etc/passwd', '/index.html%00.png']) {
      expect((await raw(port(), path, { headers: viaServe(SITE_HTTPS) })).status, path).toBe(404);
    }
    for (const path of ['/api/status', '/api/files', '/mcp', '/live-mcp/abc', '/sync/abc', '/events', '/peer/manifest', '/assets/x.png']) {
      const answer = await raw(port(), path, { headers: viaServe(SITE_HTTPS) });
      expect(answer.status, path).toBe(404);
      expect(answer.body).not.toMatch(/\{/);
    }
    expect((await raw(port(), '/', { method: 'POST', headers: viaServe(SITE_HTTPS) })).status).toBe(405);
    expect((await raw(port(), '/', { method: 'PUT', headers: viaServe(SITE_HTTPS) })).status).toBe(405);
    // On the tailnet only: no login means it did not come through tailscale serve.
    expect((await raw(port(), '/', { headers: { Host: `${NAME}:${SITE_HTTPS}` } })).status).toBe(403);
    // DNS rebinding and the main listener's names.
    expect((await raw(port(), '/', { headers: viaServe(SITE_HTTPS, { Host: `127.0.0.1:${port()}` }) })).status).toBe(403);
    expect((await raw(port(), '/', { headers: viaServe(SITE_HTTPS, { Host: `evil.example:${SITE_HTTPS}` }) })).status).toBe(403);

    // A WebSocket upgrade is closed before anything reads it.
    const upgrade = await new Promise<string>((resolve) => {
      const socket = connect(port(), '127.0.0.1', () => socket.write(`GET /events HTTP/1.1\r\nHost: ${NAME}:${SITE_HTTPS}\r\nTailscale-User-Login: ${OWNER}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
      let got = '';
      socket.on('data', (c) => { got += c; });
      socket.on('close', () => resolve(got));
      socket.on('error', () => resolve(got));
    });
    expect(upgrade).toMatch(/^HTTP\/1\.1 403/);
    expect(upgrade).not.toMatch(/101/);

    // Unpublish: nothing is served, and the listener stays put.
    expect((await local(`/api/publish/sites/${site.id}/unpublish`, 'POST', { target: 'listener' })).json().removed).toEqual(['listener']);
    expect((await raw(port(), '/', { headers: viaServe(SITE_HTTPS) })).status).toBe(404);
    // Off works from the CLI too.
    expect((await local('/api/publish/listeners/site', 'POST', { on: false })).json().outcome.state).toBe('removed');
  });

  it('keeps versions, rolls back and unpublishes', async () => {
    await boot();
    const { fileId, boardId, agent } = await designWithSecrets();
    const first = (await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId })).json();
    await call(agent, 'html_write', { file_id: fileId, target_id: boardId, html: '<p>Second version</p>' });
    const second = (await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId })).json();
    expect(second.site.id).toBe(first.site.id);
    expect(second.version.n).toBe(2);
    await editor('/api/publish/listeners/site', 'POST', { on: true });
    const port = h!.server.siteListener.boundPort;
    await editor(`/api/publish/sites/${first.site.id}/publish`, 'POST', { version: second.version.id, target: 'listener' });
    expect((await raw(port, '/', { headers: viaServe(SITE_HTTPS) })).body).toMatch(/Second version/);
    await editor(`/api/publish/sites/${first.site.id}/publish`, 'POST', { version: first.version.id, target: 'listener' });
    expect((await raw(port, '/', { headers: viaServe(SITE_HTTPS) })).body).not.toMatch(/Second version/);
  });

  it('puts Funnel on its own port only, and takes it away again, leaving every other entry alone', async () => {
    await boot();
    const others = () => {
      const c = structuredClone(ts.config);
      delete c.TCP![SITE_HTTPS];
      delete c.Web![`${NAME}:${SITE_HTTPS}`];
      delete c.AllowFunnel![`${NAME}:${SITE_HTTPS}`];
      return c;
    };
    const before = others();
    const on = await editor('/api/publish/listeners/site', 'POST', { on: true, public: true });
    expect(on.status).toBe(200);
    const port = h!.server.siteListener.boundPort;
    expect(on.json().status).toMatchObject({ public: true, funnel: true, serve: 'ours' });
    expect(ts.config.AllowFunnel![`${NAME}:${SITE_HTTPS}`]).toBe(true);
    expect(others()).toEqual(before);
    // Public: Funnel traffic carries no login, and still gets in.
    expect((await raw(port, '/', { headers: { Host: `${NAME}:${SITE_HTTPS}` } })).status).toBe(404);
    const tailnetOnly = await editor('/api/publish/listeners/site', 'POST', { on: true, public: false });
    expect(tailnetOnly.json().status).toMatchObject({ public: false, funnel: false, serve: 'ours' });
    expect(others()).toEqual(before);
    const off = await local('/api/publish/listeners/site', 'POST', { on: false });
    expect(off.json().outcome.state).toBe('removed');
    expect(ts.calls).toEqual([`funnel ${SITE_HTTPS} http://127.0.0.1:${port}`, `funnel-off ${SITE_HTTPS}`, `serve ${SITE_HTTPS} http://127.0.0.1:${port}`, `off ${SITE_HTTPS}`]);
    expect(ts.config).toEqual(before);
    // A port that belongs to another app is never touched, and Funnel only goes where Funnel can.
    const taken = await editor('/api/publish/listeners/review', 'POST', { on: true, public: true });
    expect(taken.status).toBe(409);
    expect(taken.json().error).toMatch(/Funnel only works on HTTPS port/);
  });

  it('refuses Funnel when the tailnet policy does not allow it', async () => {
    await boot(false);
    const on = await editor('/api/publish/listeners/site', 'POST', { on: true, public: true });
    expect(on.status).toBe(409);
    expect(on.json().error).toMatch(/nodeAttrs.*funnel/);
    expect(ts.calls).toEqual([]);
  });

  it('refuses a folder with files Bogen did not write, and never overwrites one', async () => {
    await boot();
    const home = mkdtempSync(join(tmpdir(), 'bogen-home-'));
    process.env.HOME = home;
    try {
      const { fileId, boardId } = await designWithSecrets();
      const { site, version } = (await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId })).json();
      const dir = join(home, 'Sites', 'couchette');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'notes.txt'), 'mine');
      const send = (extra: Record<string, unknown> = {}) => editor(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'folder', path: dir, ...extra });
      const refused = await send();
      expect(refused.status).toBe(409);
      expect(refused.json().error).toMatch(/did not write/);
      expect(existsSync(join(dir, 'index.html'))).toBe(false);
      expect((await send({ allowForeign: true })).status).toBe(200);
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toMatch(/Night trains/);
      // Republishing over its own files is fine; over someone's edit of them is not.
      expect((await send({ allowForeign: true })).status).toBe(200);
      writeFileSync(join(dir, 'index.html'), 'edited by hand');
      const clash = await send({ allowForeign: true });
      expect(clash.status).toBe(409);
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('edited by hand');
      // A folder of its own outside home, home itself, hidden folders and Bogen's data are refused.
      for (const path of ['/tmp/elsewhere', home, join(home, '.config', 'site'), h!.home]) {
        expect((await send({ path, allowForeign: true })).status, path).toBe(400);
      }
      // Unpublish takes back only what Bogen wrote and nobody changed.
      writeFileSync(join(dir, 'index.html'), Buffer.from(await h!.server.publisher.files(version.id).then((f) => f.get('index.html')!)));
      expect((await local(`/api/publish/sites/${site.id}/unpublish`, 'POST', { target: 'folder' })).status).toBe(200);
      expect(existsSync(join(dir, 'index.html'))).toBe(false);
      expect(existsSync(join(dir, '.bogen-publish.json'))).toBe(false);
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('pushes to GitHub Pages through gh only after the owner saw the plan', async () => {
    await boot();
    const { fileId, boardId } = await designWithSecrets();
    const { site, version } = (await local('/api/publish/prepare', 'POST', { fileId, nodeId: boardId })).json();
    const plan = (await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: version.id, repo: 'me/site', branch: 'gh-pages' })).json();
    expect(plan).toMatchObject({ exists: false, blocked: [], foreign: [], pagesUrl: 'https://me.github.io/site/' });
    expect(plan.upload.map((u: { path: string }) => u.path)).toContain('index.html');
    expect(gh.calls.every((c) => c.startsWith('GET'))).toBe(true);
    expect((await local(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'github', repo: 'me/site', branch: 'gh-pages', fingerprint: plan.fingerprint })).status).toBe(403);
    expect((await editor(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'github', repo: 'me/site', branch: 'gh-pages', fingerprint: '0'.repeat(32) })).status).toBe(409);
    const pushed = await editor(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'github', repo: 'me/site', branch: 'gh-pages', fingerprint: plan.fingerprint });
    expect(pushed.status).toBe(200);
    const again = (await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: version.id, repo: 'me/site', branch: 'gh-pages' })).json();
    expect(again.upload).toEqual([]);
    expect(again.unchanged).toContain('index.html');
    // A branch with someone else's files: they stay, and only with a yes; their index.html blocks it.
    seedBranch(gh, 'main', { 'README.md': 'hello' });
    await new Promise((r) => setTimeout(r, 10));
    const beside = (await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: version.id, repo: 'me/site', branch: 'main' })).json();
    expect(beside.foreign).toEqual(['README.md']);
    expect((await editor(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'github', repo: 'me/site', branch: 'main', fingerprint: beside.fingerprint })).status).toBe(409);
    seedBranch(gh, 'docs', { 'index.html': 'their site' });
    await new Promise((r) => setTimeout(r, 10));
    const blocked = (await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: version.id, repo: 'me/site', branch: 'docs' })).json();
    expect(blocked.blocked).toEqual(['index.html']);
    expect((await editor(`/api/publish/sites/${site.id}/publish`, 'POST', { version: version.id, target: 'github', repo: 'me/site', branch: 'docs', fingerprint: blocked.fingerprint, allowForeign: true })).status).toBe(409);
    expect((await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: version.id, repo: 'me/site', branch: '--upload-pack=x' })).status).toBe(400);
    expect((await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: version.id, repo: '../x', branch: 'main' })).status).toBe(400);
    // Taking it down pushes a commit too: the owner's, in the editor. It removes Bogen's files only.
    expect((await local(`/api/publish/sites/${site.id}/unpublish`, 'POST', { target: 'github' })).status).toBe(403);
    expect((await editor(`/api/publish/sites/${site.id}/unpublish`, 'POST', { target: 'github' })).json().removed).toEqual(['github']);
    const left = (await local(`/api/publish/sites/${site.id}/github-plan`, 'POST', { version: null, repo: 'me/site', branch: 'gh-pages' })).json();
    expect(left).toMatchObject({ exists: true, remove: [], foreign: [], unchanged: [] });
  });
});

describe('review links', () => {
  async function shared(options: { comments?: boolean; maxViews?: number; days?: number } = {}) {
    await boot();
    const design = await designWithSecrets();
    const { site, version } = (await local('/api/publish/prepare', 'POST', { fileId: design.fileId, nodeId: design.boardId })).json();
    await editor('/api/publish/listeners/review', 'POST', { on: true });
    const made = await editor('/api/shares', 'POST', { siteId: site.id, versionId: version.id, label: 'Anna', comments: options.comments ?? true, ...(options.maxViews ? { maxViews: options.maxViews } : {}), ...(options.days ? { days: options.days } : {}) });
    expect(made.status).toBe(201);
    const { token, url, share } = made.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toBe(`https://${NAME}:${REVIEW_HTTPS}/r/${token}/`);
    return { ...design, site, version, token, share, port: h!.server.reviewListener.boundPort };
  }

  const post = (port: number, token: string, form: Record<string, string>, headers: Record<string, string> = {}) => raw(port, `/r/${token}/_review/comments`, {
    method: 'POST', body: new URLSearchParams(form).toString(),
    headers: viaServe(REVIEW_HTTPS, { Origin: `https://${NAME}:${REVIEW_HTTPS}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers }),
  });

  it('opens a frozen copy with the form, and keeps only a hash of the token, which is never logged', async () => {
    const logged: string[] = [];
    for (const k of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    const { token, port, agent, fileId, boardId, version } = await shared();
    // The form's picture was taken with the version, so it cannot show what changed since.
    const picture = readFileSync(join(h!.server.publisher.versionDir(version.id), 'review', 'shot-0.png'));
    await call(agent, 'html_write', { file_id: fileId, target_id: boardId, html: '<p>Changed after sharing</p>' });
    expect((await raw(port, `/r/${token}`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(308);
    const page = await raw(port, `/r/${token}/`, { headers: viaServe(REVIEW_HTTPS) });
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/Night trains/);
    expect(page.body).not.toMatch(/Changed after sharing/);
    expect(page.body).toMatch(/<form method="post" action="\/r\/[\w-]+\/_review\/comments">/);
    expect(page.body).not.toMatch(/<script/);
    expect(page.headers['content-security-policy']).toMatch(/form-action 'self'/);
    expect(page.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-robots-tag']).toMatch(/noindex/);
    // A browser sends the Origin of a form only when the policy lets it, and no-referrer would make it null.
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.body).toMatch(/<meta name="referrer" content="same-origin">/);
    expect(page.body).not.toMatch(/no-referrer/);
    expect(page.headers['set-cookie']).toBeUndefined();
    expect((await raw(port, `/r/${token}/index.css`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(200);
    expect((await raw(port, `/r/${token}/_review/style.css`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(200);
    const served = await new Promise<Buffer>((resolve) => request({ host: '127.0.0.1', port, path: `/r/${token}/_review/shot/0.png`, headers: viaServe(REVIEW_HTTPS) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).end());
    expect(served.equals(picture)).toBe(true);
    for (const path of [`/r/${token}/../${token}/index.html`, `/r/${token}/%2e%2e/x`, '/api/status', '/mcp', `/r/${token}/api/files`]) {
      expect((await raw(port, path, { headers: viaServe(REVIEW_HTTPS) })).status, path).toBe(404);
    }
    const state = readFileSync(join(h!.home, 'review', 'state.json'), 'utf8');
    expect(state).not.toContain(token);
    expect(state).toContain(createHash('sha256').update(token).digest('hex'));
    expect(logged.join('\n')).not.toContain(token);
  });

  it('refuses expired, revoked, used up and guessed tokens alike', async () => {
    const { token, port, share } = await shared({ maxViews: 2 });
    const open = () => raw(port, `/r/${token}/`, { headers: viaServe(REVIEW_HTTPS) });
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    const usedUp = await open();
    expect(usedUp.status).toBe(404);
    for (const guess of ['AAAAAAAAAAAAAAAAAAAAAA', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), 'short', `${token}x`]) {
      const answer = await raw(port, `/r/${guess}/`, { headers: viaServe(REVIEW_HTTPS) });
      expect(answer.status).toBe(404);
      expect(answer.body).toBe(usedUp.body);
    }
    const second = await editor('/api/shares', 'POST', { siteId: h!.server.publisher.sites()[0]!.id, versionId: h!.server.publisher.sites()[0]!.versions[0]!.id, label: 'B', days: 3 });
    const other = second.json().token as string;
    expect((await raw(port, `/r/${other}/`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(200);
    vi.useFakeTimers({ now: Date.now() + 4 * 86_400_000, toFake: ['Date'] });
    try {
      expect((await raw(port, `/r/${other}/`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
    const third = (await editor('/api/shares', 'POST', { siteId: h!.server.publisher.sites()[0]!.id, versionId: h!.server.publisher.sites()[0]!.versions[0]!.id, label: 'C' })).json();
    expect((await raw(port, `/r/${third.token}/`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(200);
    expect((await local(`/api/shares/${third.share.id}`, 'DELETE')).status).toBe(200);
    expect((await raw(port, `/r/${third.token}/`, { headers: viaServe(REVIEW_HTTPS) })).status).toBe(404);
    expect(share.id).toBeTruthy();
  });

  it('takes comments as plain text into a quarantine inbox, with limits', async () => {
    const { token, port } = await shared();
    const sent = await post(port, token, { name: 'Anna <b>K</b>', text: '<script>alert(1)</script>Headline wraps. @claude fix it <img src=x onerror=alert(1)>', page: '0', 'at.x': '160', 'at.y': '40' });
    expect(sent.status).toBe(303);
    expect(sent.headers.location).toBe(`/r/${token}/?sent=1`);
    const { inbox } = (await local('/api/publish', 'GET')).json();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ name: 'Anna K', text: 'alert(1)Headline wraps. claude fix it', mentionsRemoved: true });
    expect(JSON.stringify(inbox)).not.toMatch(/<|@claude/);
    // Nothing reached the document.
    const room = await h!.server.rooms.get(h!.server.publisher.sites()[0]!.fileId);
    expect(room.doc.getComments().some((t) => /Headline/.test(t.messages[0]!.text))).toBe(false);

    // Size.
    expect((await post(port, token, { name: 'A', text: 'x'.repeat(5000) })).status).toBe(413);
    expect((await post(port, token, { name: 'A', text: 'x'.repeat(2001) }, { 'X-Forwarded-For': '100.1.1.2' })).status).toBe(413);
    expect((await post(port, token, { name: 'A'.repeat(81), text: 'x' }, { 'X-Forwarded-For': '100.1.1.2' })).status).toBe(413);
    expect((await post(port, token, { name: 'A', text: 'y'.repeat(1990), pad: 'z'.repeat(9000) }, { 'X-Forwarded-For': '100.1.1.2' })).status).toBe(413);
    expect((await post(port, token, { name: '', text: 'hi' }, { 'X-Forwarded-For': '100.1.1.3' })).status).toBe(400);
    // Rate per address: five in ten minutes.
    for (let i = 0; i < 4; i++) expect((await post(port, token, { name: 'A', text: `n${i}` })).status).toBe(303);
    expect((await post(port, token, { name: 'A', text: 'one too many' })).status).toBe(429);
    // Rate per link: twenty an hour, from any number of addresses.
    let last = 0;
    for (let i = 0; i < 20; i++) last = (await post(port, token, { name: 'B', text: `m${i}` }, { 'X-Forwarded-For': `100.2.0.${i}` })).status;
    expect(last).toBe(429);
  });

  it('refuses comments from another origin, without an origin, and as anything but the form', async () => {
    const { token, port } = await shared();
    expect((await post(port, token, { name: 'A', text: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(port, token, { name: 'A', text: 'x' }, { Origin: `https://${NAME}:443` })).status).toBe(403);
    // A sandboxed frame elsewhere posts with an opaque origin.
    expect((await post(port, token, { name: 'A', text: 'x' }, { Origin: 'null' })).status).toBe(403);
    expect((await post(port, token, { name: 'A', text: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post(port, token, { name: 'A', text: 'x' }, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    const noOrigin = await raw(port, `/r/${token}/_review/comments`, { method: 'POST', body: 'name=A&text=x', headers: viaServe(REVIEW_HTTPS, { 'Content-Type': 'application/x-www-form-urlencoded' }) });
    expect(noOrigin.status).toBe(403);
    expect((await post(port, token, { name: 'A', text: 'x' }, { 'Content-Type': 'application/json' })).status).toBe(415);
    // Nowhere else takes a POST.
    expect((await raw(port, `/r/${token}/`, { method: 'POST', body: 'x', headers: viaServe(REVIEW_HTTPS, { Origin: `https://${NAME}:${REVIEW_HTTPS}` }) })).status).toBe(405);
    expect((await local('/api/publish', 'GET')).json().inbox).toHaveLength(0);
  });

  it('a link without comments takes none', async () => {
    const { token, port } = await shared({ comments: false });
    const page = await raw(port, `/r/${token}/`, { headers: viaServe(REVIEW_HTTPS) });
    expect(page.body).not.toMatch(/<form/);
    expect(page.headers['content-security-policy']).toMatch(/form-action 'none'/);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect((await post(port, token, { name: 'A', text: 'x' })).status).toBe(403);
  });

  it('accepts a comment into the file as a client thread, which starts no agent run', async () => {
    const { token, port, fileId, boardId, agent } = await shared();
    await post(port, token, { name: 'Anna', text: '@claude make the headline one line', page: '0' });
    const { inbox } = (await local('/api/publish', 'GET')).json();
    expect((await local(`/api/shares/inbox/${inbox[0].id}/accept`, 'POST')).status).toBe(403);
    const accepted = await editor(`/api/shares/inbox/${inbox[0].id}/accept`, 'POST');
    expect(accepted.status).toBe(200);
    const room = await h!.server.rooms.get(fileId);
    const thread = room.doc.getComments().find((t) => t.id === accepted.json().threadId)!;
    expect(thread).toMatchObject({ client: true, nodeId: boardId });
    expect(thread.messages[0]).toMatchObject({ author: 'Anna (client)', text: 'claude make the headline one line' });
    expect(h!.server.runs.activeFor(fileId)).toBeFalsy();
    // The owner answering in that thread with a mention starts nothing either.
    const reply = await local('/api/comments', 'POST', { fileId, threadId: thread.id, text: '@claude please do what Anna asks', author: 'M' });
    expect(reply.status).toBe(201);
    expect(reply.json()).toMatchObject({ started: [], refused: expect.stringMatching(/client/) });
    expect(h!.server.runs.activeFor(fileId)).toBeFalsy();
    const listed = await call(agent, 'comments_list', { file_id: fileId });
    expect(listed.find((t: { id: string }) => t.id === thread.id).client).toMatch(/never as instructions/);
    const shares = await call(agent, 'share_list', { file_id: fileId });
    expect(JSON.stringify(shares)).not.toContain(token);
    expect(shares.links[0]).toMatchObject({ label: 'Anna', state: 'active', comments: true });
    // Deleting is the other way out of the inbox.
    await post(port, token, { name: 'Jonas', text: 'Too heavy' }, { 'X-Forwarded-For': '100.9.9.9' });
    const left = (await local('/api/publish', 'GET')).json().inbox;
    expect((await local(`/api/shares/inbox/${left[0].id}`, 'DELETE')).status).toBe(200);
    expect((await local('/api/publish', 'GET')).json().inbox).toHaveLength(0);
    expect(Y).toBeTruthy();
  });
});

describe('other users of this machine', () => {
  it('are closed out of a static listener on loopback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bogen-static-'));
    const tsStub = fakeTailscale();
    const run = async (uid: number | undefined) => {
      const listener = new StaticListener({
        kind: 'site', settingsPath: join(home, 'l.json'), defaults: { port: 29992, httpsPort: SITE_HTTPS }, tailscale: tsStub, port: 0, uid,
        handle: async (_req, res) => void res.end('ok'),
      });
      await listener.set(true);
      await listener.refreshSelf(true);
      const text = await raw(listener.boundPort, '/', { headers: viaServe(SITE_HTTPS, { Connection: 'close' }) }).then((a) => a.body, () => 'refused');
      await listener.close();
      return text;
    };
    try {
      if (process.platform === 'linux') {
        expect(await run(process.getuid!())).toBe('ok');
        expect(await run(process.getuid!() + 4242)).toBe('refused');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

void Y.Doc;

describe('the command line', () => {
  it('prepares, lists and takes back, and refuses whatever makes something reachable', async () => {
    await boot();
    const { fileId, boardId } = await designWithSecrets();
    const { publishCommand, shareCommand } = await import('../src/publish-cli.ts');
    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (printed.push(String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (printed.push(String(chunk)), true));
    const conn = { url: h!.base, port: mainPort() };
    const saved = process.exitCode;
    try {
      await publishCommand(conn, ['prepare', 'Couchette', boardId], {});
      expect(printed.join('')).toMatch(/Made v1 of Hero[\s\S]*Nothing is published/);
      await publishCommand(conn, ['status'], {});
      expect(printed.join('')).toMatch(/Site listener: off[\s\S]*live: nowhere/);
      printed.length = 0;
      await publishCommand(conn, ['on'], {});
      await shareCommand(conn, ['create'], {});
      expect(printed.join('')).toMatch(/in the editor[\s\S]*in the editor/);
      expect(process.exitCode).toBe(1);
      expect(h!.server.siteListener.boundPort).toBe(0);
      expect(h!.server.publisher.sites()[0]!.fileId).toBe(fileId);
    } finally {
      process.exitCode = saved;
    }
  });
});
