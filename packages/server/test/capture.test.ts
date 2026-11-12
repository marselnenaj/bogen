import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeToHtml } from '@bogen/core';
import { callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');
const PAGE = `<!doctype html><html><head><title>Fixture</title><style>
:root { --brand: #f2361f; --ink: #0e0e0c; --sans: "Archivo", Arial, sans-serif; --gut: clamp(1px, 2vw, 3px); --pad: 24px }
body { margin: 0; background: var(--ink); color: var(--brand); font-family: var(--sans) }
.skip { position: absolute; left: 12px; top: -60px; background: var(--brand) }
.bar { position: sticky; top: 0; height: 40px }
.row { display: flex; gap: 8px }
h1 { font-size: 80px; margin: 0 }
.bg { width: 50px; height: 50px; background-image: url(/dot.png) }
.mark { width: 30px; height: 30px; fill: var(--brand) }
p::after { content: "!" }
</style></head><body>
<a class="skip" href="#x">Skip</a>
<svg style="position:absolute;width:0;height:0"><symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></symbol></svg>
<header class="bar"><nav class="row"><a href="/a">One</a> <a href="/b" onclick="evil()">Two</a></nav></header>
<main><h1>Hello</h1><p>Mixed <b>bold</b> text</p><p class="eq"><svg class="mark"><use href="#dot"/></svg><span>next to it</span></p>
<pre>a

b</pre><img src="/dot.png" alt="Dot" width="20" height="20"><div class="bg"></div>
<details><summary>More</summary><div>Hidden until opened</div></details>
<div style="display:none">Never rendered</div></main>
<script>window.ran = 1; document.body.dataset.ran = '1';</script>
</body></html>`;

describe('capture', () => {
  let h: Harness;
  let site: Server;
  let url: string;
  let fileId: string;
  let captured: { nodeId: string; layers: number; images: number; failedImages: string[]; tokens: number };

  beforeAll(async () => {
    site = createServer((req, res) => {
      if (req.url === '/dot.png') return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    h = await startServer();
    fileId = h.server.storage.create('Snap').id;
    captured = await h.server.capturePageInto(fileId, { url, width: 1000, name: 'Home' });
  }, 60000);

  afterAll(async () => {
    await h.cleanup();
    site.close();
  });

  const doc = async () => (await h.server.rooms.get(fileId)).doc;
  const find = async (test: (n: { text?: string; name: string; tag: string }) => boolean) => (await doc()).descendants(captured.nodeId).find(test);

  it('makes one sized artboard with semantic layers', async () => {
    const root = (await doc()).getNode(captured.nodeId)!;
    expect(root).toMatchObject({ artboard: true, name: 'Home' });
    expect(root.style.width).toBe('1000px');
    expect(root.style.height).toBeUndefined();
    expect(await find((n) => n.tag === 'h1')).toMatchObject({ text: 'Hello' });
    expect(await find((n) => n.tag === 'nav')).toBeTruthy();
  });

  it('takes static custom properties as tokens and refers to them', async () => {
    const d = await doc();
    const names = d.getTokens().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['brand', 'ink', 'sans', 'pad']));
    expect(names).not.toContain('gut');
    expect(d.getNode(captured.nodeId)!.style.backgroundColor).toBe('var(--ink)');
    expect(d.getNode(captured.nodeId)!.style.fontFamily).toBe('var(--sans)');
  });

  it('stores images and background images with the file', async () => {
    expect(captured.failedImages).toEqual([]);
    const img = await find((n) => n.tag === 'img');
    expect((img as { src?: string }).src).toMatch(/^bogen-asset:/);
    const d = await doc();
    const bg = d.descendants(captured.nodeId).find((n) => n.style.backgroundImage);
    expect(bg!.style.backgroundImage).toContain('bogen-asset:');
  });

  it('keeps inline flow, pseudo elements and preformatted blank lines', async () => {
    const d = await doc();
    const p = d.descendants(captured.nodeId).find((n) => n.tag === 'p')!;
    expect(d.getChildren(p.id).map((c) => c.text ?? c.tag)).toEqual(['Mixed ', 'bold', ' text', '!']);
    const pre = d.descendants(captured.nodeId).find((n) => n.tag === 'pre')!;
    expect(pre.text).toBe('a\n\nb');
    expect(pre.style.whiteSpace).toBe('pre');
  });

  it('inlines shared symbols so that a vector stands alone', async () => {
    const d = await doc();
    const svgs = d.descendants(captured.nodeId).filter((n) => n.type === 'svg');
    expect(svgs.length).toBe(1);
    expect(svgs[0]!.svg).toContain('<circle');
    expect(svgs[0]!.svg).not.toContain('<use');
    expect(svgs[0]!.svg).toMatch(/fill:\s*rgb\(242, 54, 31\)/);
  });

  it('does not stretch absolute layers or keep sticky behaviour', async () => {
    const skip = await find((n) => n.name === 'Skip' || (n as { text?: string }).text === 'Skip');
    const s = (skip as unknown as { style: Record<string, string> }).style;
    expect(s.bottom).toBeUndefined();
    expect(s.right).toBeUndefined();
    expect(s.height).toMatch(/px$/);
    const bar = await find((n) => n.tag === 'header');
    expect((bar as unknown as { style: Record<string, string> }).style.position).toBe('relative');
  });

  it('drops scripts, handlers, display:none and the closed part of details', async () => {
    const d = await doc();
    const html = nodeToHtml(d, captured.nodeId);
    expect(html).not.toMatch(/evil|onclick|<script|window\.ran|Never rendered|Hidden until opened|data-ran/);
    expect(html).toContain('More');
    expect(html).toContain('disclosure-closed');
  });

  it('lets an agent capture public pages only, never this computer', async () => {
    const agent = await connectAgent(h.base, 'snap-agent');
    await callRaw(agent, 'file_open', { file_id: fileId });
    for (const target of [url, 'http://localhost:1/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
      const result = await callRaw(agent, 'page_capture', { url: target });
      expect(result.isError).toBe(true);
    }
    await agent.close();
  }, 30000);

  it('tells an agent that calls an old tool name what it is called now', async () => {
    const agent = await connectAgent(h.base, 'old-names');
    for (const [old, now] of [['page_snapshot', 'page_capture'], ['site_snapshot', 'site_capture'], ['site_snapshot_status', 'site_capture_status']]) {
      const result = await callRaw(agent, old!, { url });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`${old} is now called ${now}`);
    }
    const listed = (await agent.listTools()).tools.map((t) => t.name);
    expect(listed).toContain('page_capture');
    expect(listed.filter((n) => n.includes('snapshot'))).toEqual([]);
    const unknown = await callRaw(agent, 'no_such_tool');
    expect(unknown.content[0]!.text).toContain('not found');
    await agent.close();
  }, 30000);
});
