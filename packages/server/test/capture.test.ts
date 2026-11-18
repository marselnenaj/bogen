import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeToHtml } from '@bogen/core';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';
import { settleTokenRefs } from '../src/capture.ts';

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

const APP = `<!doctype html><html><head><title>App</title><style>
:root { --space-xs: 4px; --space-sm: 8px; --radius: 4px; --text-sm: 12px; --row: 26px; --ui-fg: #e8e8e8; --half: 0.5rem }
body { margin: 0; font: 13px/1.4 sans-serif; background: #111; color: var(--ui-fg) }
.bar { display: flex; align-items: center; gap: var(--space-sm); padding: 0 var(--space-sm); height: 40px; width: 600px }
.when { margin-left: auto }
.checks { display: flex; gap: 6px; width: 300px }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 10px; border-radius: var(--radius); flex: 1 }
.field { display: flex; width: 120px; height: var(--row) }
.field input { flex: 1 1 auto; width: 100%; min-width: 0; border: 0; padding: 0 }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
.half { padding: var(--half) }
.lane { padding-inline-start: var(--space-sm); font: var(--text-sm)/16px sans-serif }
.ic { margin-right: var(--space-xs); width: 14px; height: 14px }
.rows li:hover { background: #222 }
.pin::after { content: "3"; font-size: var(--text-sm); padding: 0 var(--space-xs) }
</style></head><body>
<div class="bar"><span>Title</span><span class="when">Nov 9</span></div>
<div class="checks"><button class="btn">Run checks</button><button class="btn" disabled>Ask</button></div>
<label class="field"><input value="x"></label>
<button class="close"><span class="sr">Close panel</span>X</button>
<div class="half">Half</div>
<div class="lane">Main views</div>
<div style="padding-left: calc(var(--space-sm) + 2 * var(--space-xs))">Deep layer</div>
<label><input type="checkbox"> Remember</label>
<div style="font-size: var(--text-sm)"><h2 style="font: inherit; margin: 0">Inherit me</h2></div>
<select style="font-size: 13px"><option>First choice</option><option>Second choice</option></select>
<div class="pin">Pin</div>
<div style="padding-left: max(var(--space-sm), env(safe-area-inset-left))">Notch</div>
<ul class="rows"><li><b>Alpha</b> <span>first</span></li><li><b>Beta</b> <span>second</span></li><li><b>Gamma</b> <span>third</span></li></ul>
<div style="display: flex"><svg class="ic" viewBox="0 0 10 10"><rect width="10" height="10"/></svg><span>Icon row</span></div>
<div style="padding-left: calc(var(--half) + 1px)">Not a token sum</div>
</body></html>`;

describe('capture of an app view', () => {
  let h: Harness;
  let site: Server;
  let fileId: string;
  let nodeId: string;

  beforeAll(async () => {
    site = createServer((_req, res) => void res.writeHead(200, { 'Content-Type': 'text/html' }).end(APP));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    h = await startServer();
    fileId = h.server.storage.create('App').id;
    ({ nodeId } = await h.server.capturePageInto(fileId, { url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`, width: 800, name: 'App' }));
  }, 60000);

  afterAll(async () => {
    await h.cleanup();
    site.close();
  });

  const layers = async () => (await h.server.rooms.get(fileId)).doc.descendants(nodeId);
  const byText = async (text: string) => (await layers()).find((n) => n.text === text)!;

  it('files a length token as what its name says: a corner and a type size are not steps of space', async () => {
    const kinds = Object.fromEntries((await h.server.rooms.get(fileId)).doc.getTokens().map((t) => [t.name, t.kind]));
    expect(kinds).toMatchObject({ 'space-sm': 'spacing', radius: 'radius', 'text-sm': 'font-size', 'ui-fg': 'color' });
  });

  it('keeps the variables the page set a property with, where they give the same value', async () => {
    const all = await layers();
    const bar = all.find((n) => n.style.height === '40px')!;
    expect(bar.style.columnGap).toBe('var(--space-sm)');
    expect(bar.style.paddingLeft).toBe('var(--space-sm)');
    expect(bar.style.paddingRight).toBe('var(--space-sm)');
    const run = await byText('Run checks');
    expect(run.style.borderRadius).toBe('var(--radius)');
    // A literal in the page stays the literal, and a rem is left as the pixels it gave, since the canvas may differ.
    const checks = all.find((n) => n.style.columnGap === '6px');
    expect(checks).toBeTruthy();
    expect((await byText('Half')).style.padding).toBe('8px');
    // Said with a logical side, or inside the font shorthand.
    expect((await byText('Main views')).style).toMatchObject({ paddingLeft: 'var(--space-sm)', fontSize: 'var(--text-sm)' });
  });

  it('makes what the page repeats one component, with what differs as overrides', async () => {
    const { doc } = await h.server.rooms.get(fileId);
    const all = await layers();
    const main = all.find((n) => n.component && n.tag === 'li')!;
    expect(main).toBeTruthy();
    const instances = all.filter((n) => n.instanceOf === main.id);
    expect(instances).toHaveLength(2);
    const words = (id: string) => doc.descendants(id).map((n) => n.text?.trim()).filter(Boolean).join(' ');
    expect([main.id, ...instances.map((n) => n.id)].map(words)).toEqual(['Alpha first', 'Beta second', 'Gamma third']);
  });

  it('leaves out what a checkbox or an option has by default anyway', async () => {
    const all = await layers();
    const box = all.find((n) => n.tag === 'input' && n.attrs?.type === 'checkbox')!;
    expect(Object.keys(box.style).filter((k) => k.startsWith('margin'))).toEqual([]);
    const options = all.filter((n) => n.tag === 'option');
    expect(options.length).toBe(2);
    for (const o of options) expect([o.style.rowGap, o.style.columnGap, o.style.fontSize]).toEqual([undefined, undefined, undefined]);
  });

  it('keeps a heading or a control that takes its font from the text around it as inherit', async () => {
    expect((await byText('Inherit me')).style).toMatchObject({ fontSize: 'inherit', fontWeight: 'inherit' });
  });

  it('keeps a token held off a safe area, as the canvas has none', async () => {
    expect((await byText('Notch')).style.paddingLeft).toBe('max(var(--space-sm), env(safe-area-inset-left))');
  });

  it('keeps the tokens of what a ::before or ::after puts in', async () => {
    const count = (await layers()).find((n) => n.text === '3')!;
    expect(count.style).toMatchObject({ fontSize: 'var(--text-sm)', paddingLeft: 'var(--space-xs)' });
  });

  it('keeps the tokens of an icon', async () => {
    const icon = (await layers()).find((n) => n.type === 'svg' && n.style.width === '14px')!;
    expect(icon.style.marginRight).toBe('var(--space-xs)');
  });

  it('keeps a sum of tokens, such as an indent, where it gives the same value', async () => {
    expect((await byText('Deep layer')).style.paddingLeft).toBe('calc(var(--space-sm) + 2 * var(--space-xs))');
    // A rem token can come out differently on the canvas, so that sum stays the pixels it gave.
    expect((await byText('Not a token sum')).style.paddingLeft).toBe('9px');
  });

  it('keeps an auto margin as auto, not as the space it took', async () => {
    expect((await byText('Nov 9')).style.marginLeft).toBe('auto');
  });

  it('keeps the height of buttons that hold each other up in a row', async () => {
    const agent = await connectAgent(h.base, 'app-capture');
    const ids = [(await byText('Run checks')).id, (await byText('Ask')).id];
    const computed = await call(agent, 'layer_styles_computed', { file_id: fileId, node_ids: ids, properties: ['height'] });
    for (const id of ids) expect(computed[id].box.height).toBe(28);
    // A field that may shrink in its row keeps the min-width that lets it.
    const input = (await layers()).find((n) => n.tag === 'input')!;
    expect(input.style.minWidth).toBe('0px');
    const field = await call(agent, 'layer_styles_computed', { file_id: fileId, node_ids: [input.id], properties: ['width'] });
    expect(field[input.id].box.width).toBe(120);
    await agent.close();
  }, 30000);

  it('carries that a control is switched off', async () => {
    expect((await byText('Ask')).attrs?.disabled).toBe('');
    expect((await byText('Run checks')).attrs?.disabled).toBeUndefined();
  });
});

describe('token references of a capture', () => {
  it('fall back to the page value where the file has no token of that name', () => {
    const root = { type: 'frame' as const, style: { gap: 'var(--space-sm)', color: 'var(--ink)', padding: '0 var(--gone)' }, children: [{ type: 'frame' as const, style: { borderRadius: 'var(--radius)' } }] };
    settleTokenRefs(root, new Set(['ink']), new Map([['space-sm', '8px'], ['radius', '4px']]));
    expect(root.style).toEqual({ gap: '8px', color: 'var(--ink)', padding: '0 var(--gone)' });
    expect(root.children[0]!.style.borderRadius).toBe('4px');
  });
});
