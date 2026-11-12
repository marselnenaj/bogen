import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeToHtml } from '@bogen/core';
import { convertNode, parseFigmaUrl } from '../src/figma.ts';
import { call, callRaw, connectAgent, pngStats, startServer, type Harness } from './helpers.ts';

/**
 * These run against recorded JSON written by hand from Figma's public REST documentation, served by a
 * local stand-in that checks the same headers. None of this has ever talked to the real API.
 */
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const FILE = readFileSync(resolve(import.meta.dirname, 'fixtures/figma/file.json'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'figd_fixture_token_value';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path d="M0 0L40 0L40 40L0 40Z" fill="white"/><script>alert(1)</script></svg>';

describe('Figma import against recorded responses', () => {
  let h: Harness;
  let api: Server;
  let base: string;
  let requests: { url: string; token?: string }[];

  beforeAll(async () => {
    requests = [];
    api = createServer((req, res) => {
      const url = req.url ?? '';
      const token = req.headers['x-figma-token'] as string | undefined;
      requests.push({ url, token });
      const port = (api.address() as AddressInfo).port;
      if (url.startsWith('/download/')) {
        // Download URLs are public and must never get the token.
        if (url.endsWith('.svg')) return void res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(SVG);
        return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
      }
      if (token !== TOKEN) return void res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"status":403,"err":"Invalid token"}');
      if (url.startsWith('/v1/files/FIXTUREKEY123/images')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: false, status: 200, meta: { images: { 'img-photo-ref': `http://127.0.0.1:${port}/download/photo.png` } } }));
      if (url.startsWith('/v1/files/FIXTUREKEY123')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(FILE);
      if (url.startsWith('/v1/images/FIXTUREKEY123')) {
        expect(url).toContain('format=svg');
        return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ err: null, images: { '1:7': `http://127.0.0.1:${port}/download/icon.svg` } }));
      }
      if (url.startsWith('/v1/files/RATELIMITED123')) return void res.writeHead(429, { 'Retry-After': '30' }).end('{}');
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    h = await startServer({ figmaApiBase: base });
  });

  afterAll(async () => {
    await h.cleanup();
    api.close();
  });

  const post = (body: object) => fetch(`${h.base}/api/import/figma`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const URL_OK = 'https://www.figma.com/design/FIXTUREKEY123/My-File?node-id=0-1&t=abc';

  it('reads file keys and frame links', () => {
    expect(parseFigmaUrl('https://www.figma.com/file/AbC123xyz/Name')).toEqual({ key: 'AbC123xyz' });
    expect(parseFigmaUrl('https://www.figma.com/design/AbC123xyz/Name?node-id=12-34')).toEqual({ key: 'AbC123xyz', nodeId: '12:34' });
    expect(parseFigmaUrl('https://www.figma.com/design/AbC123xyz/Name/branch/BrAnCh456/Other')).toEqual({ key: 'BrAnCh456' });
    expect(() => parseFigmaUrl('https://evil.example/file/AbC123xyz/Name')).toThrow(/not a Figma/);
  });

  it('says clearly when the token is wrong, and does not echo it', async () => {
    const res = await post({ url: URL_OK, token: 'wrong-secret-value' });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('refused this token');
    expect(text).not.toContain('wrong-secret-value');
    const limited = await post({ url: 'https://www.figma.com/file/RATELIMITED123/x', token: TOKEN });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain('30 seconds');
    const none = await post({ url: URL_OK });
    expect(none.status).toBe(400);
  });

  describe('an imported file', () => {
    let report: any;
    let doc: Awaited<ReturnType<Harness['server']['rooms']['get']>>['doc'];
    const find = (name: string) => {
      let found: ReturnType<typeof doc.getNode>;
      doc.nodes.forEach((m, id) => {
        if (m.get('name') === name) found = doc.getNode(id);
      });
      return found!;
    };

    beforeAll(async () => {
      const res = await post({ url: 'https://www.figma.com/design/FIXTUREKEY123/My-File', token: TOKEN });
      expect(res.status).toBe(201);
      report = await res.json();
      doc = (await h.server.rooms.get(report.fileId)).doc;
    });

    it('makes a page per canvas and an artboard per top frame', () => {
      expect(report.pages.map((p: { name: string }) => p.name)).toEqual(['Landing', 'Components']);
      expect(doc.getPages().map((p) => p.name)).toEqual(['Landing', 'Components']);
      const boards = doc.getChildren(doc.getPages()[0]!.id);
      expect(boards.map((b) => [b.name, b.artboard])).toEqual([['Hero frame', true], ['Free layout', true]]);
      expect(boards[0]!.style).toMatchObject({ position: 'absolute', left: '100px', top: '200px', width: '800px', height: '500px' });
    });

    it('turns auto layout into flex', () => {
      expect(find('Hero frame').style).toMatchObject({ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', rowGap: '16px', padding: '32px 40px 32px 40px', overflow: 'hidden' });
      expect(find('Row').style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', rowGap: '4px', alignSelf: 'stretch' });
      expect(find('Row').style.columnGap).toBeUndefined();
      expect(find('Button').style).toMatchObject({ flex: '1 1 0', height: '44px' });
      expect(find('Secondary').style).toMatchObject({ width: '170px', height: '44px', flexShrink: '0' });
      expect(find('Grid').style).toMatchObject({ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });
    });

    it('keeps absolute children absolute, relative to the frame', () => {
      expect(find('Floating badge').style).toMatchObject({ position: 'absolute', left: '760px', top: '10px', opacity: '0.8', mixBlendMode: 'multiply', filter: 'blur(2px)' });
      expect(find('Group of things').style).toMatchObject({ position: 'absolute', left: '20px', top: '20px' });
    });

    it('places a rotated layer by its centre, with its real size', () => {
      const s = find('Tilted').style;
      expect(s).toMatchObject({ width: '180px', height: '40px', transform: 'matrix(0.866, -0.5, 0.5, 0.866, 0, 0)', left: '10px', top: '30px' });
    });

    it('stacks fills with the top one first, as CSS does', () => {
      const s = find('Hero frame').style;
      expect(s.backgroundColor).toBe('#101014');
      expect(s.backgroundImage).toMatch(/^linear-gradient\(122\.005deg, rgba\(255, 0, 102, 0\.5\) 0%, rgba\(0, 102, 255, 0\.5\) 100%\)$/);
    });

    it('converts all gradient kinds', () => {
      expect(find('Button').style.backgroundImage).toBe('radial-gradient(ellipse 70px 22px at 70px 22px, #ffffff 0%, #000000 100%)');
      expect(find('Secondary').style.backgroundImage).toBe('conic-gradient(from 0deg at 85px 22px, #ff0000 0%, #0000ff 100%)');
    });

    it('converts strokes without changing the layout', () => {
      expect(find('Hero frame').style.boxShadow).toContain('inset 0 0 0 2px rgba(255, 255, 255, 0.25)');
      expect(find('Button').style.boxShadow).toContain('0 0 0 1px #0000ff');
      expect(find('Secondary').style).toMatchObject({ outline: '2px dashed #ff00ff', outlineOffset: '-1px' });
      // A stroke on one side that Figma does not count in the layout takes no room here either.
      expect(find('Row').style).toMatchObject({ boxShadow: 'inset 0px -2px 0 0 #00ff00', padding: '0px 0px 6px 0px' });
      expect(find('Row').style.borderBottom).toBeUndefined();
    });

    it('converts effects, and leaves out what is switched off', () => {
      const s = find('Hero frame').style;
      expect(s.boxShadow).toContain('0px 8px 24px 2px rgba(0, 0, 0, 0.4)');
      expect(s.boxShadow).toContain('inset 0px 1px 4px 0px rgba(255, 255, 255, 0.2)');
      expect(s.boxShadow).not.toContain('99px');
      expect(s.backdropFilter).toBe('blur(8px)');
      expect(find('Title').style.textShadow).toBe('0px 1px 2px rgba(0, 0, 0, 0.5)');
    });

    it('converts text, with ranges for its style overrides', () => {
      const t = find('Title');
      expect(t).toMatchObject({ type: 'text', text: 'Ship with Bogen' });
      expect(t.style).toMatchObject({ fontFamily: '"Inter", sans-serif', fontSize: '64px', fontWeight: '700', letterSpacing: '-1.28px', lineHeight: '76px', textAlign: 'center', color: '#ffffff', whiteSpace: 'pre' });
      expect(t.style.width).toBeUndefined();
      expect(t.spans).toEqual([
        { start: 5, end: 9, style: { fontWeight: '300', fontStyle: 'italic', color: '#ffcc00' } },
        { start: 11, end: 15, style: { textDecorationLine: 'underline' }, href: 'https://example.com/bogen' },
      ]);
      const m = find('Middle aligned');
      expect(m.style).toMatchObject({ textTransform: 'uppercase', textAlign: 'right', lineHeight: 'normal', display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '80px' });
    });

    it('keeps hidden layers hidden', () => {
      const hidden = find('Hidden note');
      expect(hidden.hidden).toBe(true);
      expect(hidden.style).toMatchObject({ overflow: 'hidden', textOverflow: 'ellipsis', WebkitLineClamp: '2' });
    });

    it('stores image fills through the image endpoint, without sending the token to the download', async () => {
      const photo = find('Photo');
      expect(photo).toMatchObject({ type: 'image' });
      expect(photo.src).toMatch(/^bogen-asset:.*\.png$/);
      expect(photo.style).toMatchObject({ objectFit: 'cover', borderRadius: '12px' });
      expect(await h.server.storage.hasAsset(photo.src!.slice('bogen-asset:'.length))).toBe(true);
      const downloads = requests.filter((r) => r.url.startsWith('/download/'));
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.every((r) => r.token === undefined)).toBe(true);
    });

    it('renders vectors from the SVG endpoint, sanitized', () => {
      const icon = find('Icon');
      expect(icon.type).toBe('svg');
      expect(icon.svg).toContain('<path');
      expect(icon.svg).not.toContain('script');
      expect(requests.some((r) => r.url.includes('/v1/images/FIXTUREKEY123') && r.url.includes('ids=1%3A7'))).toBe(true);
      expect(requests.some((r) => r.url.includes('/v1/files/FIXTUREKEY123?geometry=paths'))).toBe(true);
    });

    it('reports what it could not bring over exactly', () => {
      const whats = report.unsupported.map((u: { what: string }) => u.what);
      expect(whats).toEqual(expect.arrayContaining(['noise effects', 'instances of components not in the import, as plain frames']));
      expect(report.components).toBe(1);
      expect(report.instances).toBe(0);
      expect(report.fonts).toEqual(['Inter', 'Space Grotesk']);
      expect(report.images).toBe(1);
      expect(report.vectors).toBe(1);
      expect(report.failed).toEqual([]);
    });

    it('renders through the same rules as everything else', async () => {
      const page = doc.getPages()[0]!.id;
      const shot = await h.server.renderer.screenshot(doc, { pageId: page }, { format: 'png' });
      const stats = await pngStats(shot.bytes);
      expect(stats.width).toBeGreaterThan(1200);
      expect(stats.distinctColors).toBeGreaterThan(8);
      const html = nodeToHtml(doc, find('Title').id);
      expect(html).toContain('href="https://example.com/bogen"');
    }, 30_000);
  });

  it('imports only the frame a link points at', async () => {
    const res = await post({ url: 'https://www.figma.com/design/FIXTUREKEY123/My-File?node-id=2-1', token: TOKEN });
    const report = await res.json() as { pages: { name: string }[]; fileId: string; layers: number };
    expect(report.pages.map((p) => p.name)).toEqual(['Landing']);
    const doc = (await h.server.rooms.get(report.fileId)).doc;
    expect(doc.getChildren(doc.getPages()[0]!.id).map((b) => b.name)).toEqual(['Free layout']);
  });

  describe('the token', () => {
    it('is only stored when asked, in a file only this user can read, and never in a document', async () => {
      const config = join(h.home, 'config.json');
      await post({ url: URL_OK, token: TOKEN });
      expect(await fetch(`${h.base}/api/config/figma`).then((r) => r.json())).toMatchObject({ saved: false });
      const res = await post({ url: URL_OK, token: TOKEN, saveToken: true });
      expect(res.status).toBe(201);
      expect(statSync(config).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(config, 'utf8')).figmaToken).toBe(TOKEN);
      expect(await fetch(`${h.base}/api/config/figma`).then((r) => r.text())).not.toContain(TOKEN);
      // A saved one works without giving it again.
      expect((await post({ url: URL_OK })).status).toBe(201);
      const { id } = (await (await fetch(`${h.base}/api/files`)).json() as { id: string }[])[0]!;
      await h.server.storage.flushDoc(id);
      expect((await fetch(`${h.base}/api/files/${id}/download`).then((r) => r.text()))).not.toContain(TOKEN);
      await fetch(`${h.base}/api/config/figma`, { method: 'DELETE' });
      expect(JSON.parse(readFileSync(config, 'utf8')).figmaToken).toBeUndefined();
    });
  });

  it('works through MCP, and through the command line', async () => {
    const agent = await connectAgent(h.base, 'figma-agent');
    const bad = await callRaw(agent, 'figma_import', { file_url: URL_OK });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('personal access token');
    const out = await call(agent, 'figma_import', { file_url: URL_OK, token: TOKEN, name: 'From MCP' });
    expect(out.name).toBe('From MCP');
    expect(out.layers).toBeGreaterThan(5);
    const tree = await call(agent, 'layer_tree', {});
    expect(JSON.stringify(tree)).toContain('Hero frame');
    await agent.close();

    const home = mkdtempSync(join(tmpdir(), 'bogen-cli-'));
    const { stdout } = await run('npx', ['tsx', 'packages/server/src/cli.ts', 'import', 'figma', URL_OK, '--token', TOKEN, '--name', 'From CLI'], { cwd: ROOT, env: { ...process.env, BOGEN_URL: h.base, BOGEN_HOME: home } });
    expect(stdout).toContain('as "From CLI"');
    expect(stdout).toContain('Not exact: noise effects');
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it('leaves unknown node kinds out and says so', () => {
    const ctx = { images: new Map(), vectors: new Map(), fonts: new Set<string>(), notes: { add: (w: string) => seen.push(w), list: () => [] } } as never;
    const seen: string[] = [];
    expect(convertNode({ id: '1', type: 'STICKY', name: 'Note' }, null, ctx)).toBeNull();
    expect(seen).toEqual(['sticky layers, left out']);
  });
});
