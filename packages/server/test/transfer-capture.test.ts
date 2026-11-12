import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFontFaces, exportDocument, fontFacesCss, getFontFaces, getInteractionRecords, BogenDoc, Y } from '@bogen/core';
import { packBogenFile, unpackBogenFile } from '../src/bogen-file.ts';
import { exportTarget } from '../src/exporter.ts';
import { parseSitemap } from '../src/site-capture.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const FONT = readFileSync(resolve(import.meta.dirname, '../../../node_modules/@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2'));

const page = (body: string, head = '') => `<!doctype html><html><head><title>Site fixture</title>
<link rel="stylesheet" href="/site.css">${head}</head><body>${body}</body></html>`;

const SITE_CSS = `
@font-face { font-family: "Not On Google Test"; src: url(/fonts/face.woff2) format("woff2"); font-weight: 200 900; font-display: swap; }
@font-face { font-family: "Declared Never Used"; src: url(/fonts/unused.woff2) format("woff2"); }
@font-face { font-family: "Size Fallback"; src: local("Arial"); size-adjust: 95%; ascent-override: 90%; }
body { margin: 0; font-family: "Not On Google Test", serif; font-size: 18px; line-height: 1.45; background: #101014; color: #fafafa }
@media (prefers-color-scheme: light) { body { background: #ffffff; color: #111111 } }
a.cta { display: inline-block; padding: 8px 14px; background: #2255ff; color: #fff }
a.cta:hover { background: #0033cc; transform: translateY(-1px) }
a.cta:focus-visible { outline: 2px solid #ffcc00 }
.card { padding: 12px }
.card:hover .title { color: #ff0066 }
@media (hover: hover) { .only-on-hover:hover { opacity: 0.5 } }
.gone:hover { color: red }
`;

describe('whole-site capture, fonts and interaction rules', () => {
  let h: Harness;
  let site: Server;
  let other: Server;
  let base: string;
  let requests: string[];
  let unusedAsked = false;

  beforeAll(async () => {
    requests = [];
    other = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/css' }).end('.external:hover { text-decoration: underline }');
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const otherPort = (other.address() as AddressInfo).port;
    const pages: Record<string, string> = {
      '/': page(`<nav><a href="#pricing">Pricing</a> <a href="/about">About</a> <a href="/from-link">Linked</a> <a href="https://example.com/elsewhere">Away</a></nav>
        <h1 style="font-size:64px">Home</h1><a class="cta only-on-hover external" href="/about">Start</a>
        <div class="card"><p class="title">Card</p></div>
        <section id="pricing"><h2>Pricing</h2></section><section id="not-linked"><h2>Other</h2></section>`, `<link rel="stylesheet" href="http://localhost:${otherPort}/x.css">`),
      '/about': page('<h1>About</h1><a href="/about#team">Team</a><div id="team">The team</div>'),
      '/pricing': page('<h1>Prices</h1>'),
      '/from-link': page('<h1>Only found through a link</h1>'),
      '/extra-1': page('<h1>Extra one</h1>'),
      '/extra-2': page('<h1>Extra two</h1>'),
    };
    site = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      requests.push(path);
      if (path === '/site.css') return void res.writeHead(200, { 'Content-Type': 'text/css' }).end(SITE_CSS);
      if (path === '/fonts/face.woff2') return void res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(FONT);
      if (path === '/fonts/unused.woff2') {
        unusedAsked = true;
        return void res.writeHead(200).end(FONT);
      }
      if (path === '/robots.txt') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`User-agent: *\nSitemap: http://127.0.0.1:${(site.address() as AddressInfo).port}/index-sitemap.xml\n`);
      if (path === '/index-sitemap.xml') return void res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>http://127.0.0.1:${(site.address() as AddressInfo).port}/pages.xml</loc></sitemap><sitemap><loc>https://another.example/sitemap.xml</loc></sitemap></sitemapindex>`);
      if (path === '/pages.xml') {
        const port = (site.address() as AddressInfo).port;
        return void res.writeHead(200, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:${port}/</loc></url><url><loc>http://127.0.0.1:${port}/about</loc></url><url><loc>http://127.0.0.1:${port}/pricing</loc></url><url><loc>http://127.0.0.1:${port}/missing</loc></url><url><loc>http://127.0.0.1:${port}/extra-1</loc></url><url><loc>http://127.0.0.1:${port}/extra-2</loc></url><url><loc>http://127.0.0.1:${port}/brochure.pdf</loc></url></urlset>`);
      }
      const html = pages[path];
      if (!html) return void res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>Not found</h1>');
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    h = await startServer();
    // The site's own port is shared with a port-scoped browser (secure-chromium) by the capture; this second local
    // origin, which only its style sheet comes from, is shared here, as a person would start it with both.
    h.server.renderer.shareLocalPort(otherPort);
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
    site.close();
    other.close();
  });

  describe('fonts', () => {
    let fileId: string;
    let nodeId: string;

    beforeAll(async () => {
      fileId = h.server.storage.create('Fonts').id;
      const placed = await h.server.capturePageInto(fileId, { url: `${base}/`, width: 1000, name: 'Home' });
      nodeId = placed.nodeId;
      expect(placed.fonts.stored).toBe(1);
    }, 60_000);

    const doc = async () => (await h.server.rooms.get(fileId)).doc;

    it('stores the file the page served, with its descriptors and source', async () => {
      const faces = getFontFaces(await doc());
      const face = faces.find((f) => f.family === 'Not On Google Test')!;
      expect(face.src).toMatch(/^bogen-asset:[a-f0-9]{64}\.woff2$/);
      expect(face.weight).toBe('200 900');
      expect(face.display).toBe('swap');
      expect(face.from).toBe(`${base}/fonts/face.woff2`);
      const asset = await h.server.storage.readAsset(face.src!.slice('bogen-asset:'.length));
      expect(Buffer.from(asset!.bytes).equals(FONT)).toBe(true);
    });

    it('takes nothing the page only declared for a family it never used', async () => {
      const families = getFontFaces(await doc()).map((f) => f.family);
      expect(families).not.toContain('Declared Never Used');
      expect(unusedAsked).toBe(false);
    });

    it('loads the font in a render, with no request to Google for that family', async () => {
      const d = await doc();
      const seen = await h.server.renderer.probe(d, { nodeIds: [nodeId] }, () => ({
        faces: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
        google: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => (l as HTMLLinkElement).href).filter((u) => u.includes('googleapis') && u.includes('Google')),
      }), null);
      expect(seen.faces).toContain('Not On Google Test');
      expect(seen.google).toEqual([]);
    }, 30_000);

    it('changes how text really measures, compared with the same page without the file', async () => {
      const d = await doc();
      const measure = (n: BogenDoc, id: string) => h.server.renderer.probe(n, { nodeIds: [id] }, (key: string) => {
        const el = [...document.querySelectorAll('h1')][0]!;
        const range = document.createRange();
        range.selectNodeContents(el);
        return { key, width: range.getBoundingClientRect().width };
      }, 'x');
      const withFont = await measure(d, nodeId);
      const copy = new BogenDoc(new Y.Doc());
      Y.applyUpdate(copy.y, Y.encodeStateAsUpdate(d.y));
      copy.y.getMap('fontFaces').clear();
      const without = await measure(copy, nodeId);
      expect(Math.abs(withFont.width - without.width)).toBeGreaterThan(1);
    }, 30_000);

    it('inlines the font in an HTML export, so that it stands alone', async () => {
      const out = await exportTarget(await doc(), h.server.renderer, h.server.storage, { nodeIds: [nodeId] }, 'html');
      const html = Buffer.from(out.bytes).toString();
      expect(html).toContain('@font-face{font-family:"Not On Google Test"');
      expect(html).toMatch(/src:url\("data:font\/woff2;base64,/);
    }, 30_000);

    it('carries the font in a .bogen file', async () => {
      const d = await doc();
      const packed = await packBogenFile(Y.encodeStateAsUpdate(d.y), (name) => h.server.storage.readAsset(name));
      const parsed = unpackBogenFile(packed);
      const face = getFontFaces(d)[0]!;
      expect(parsed.assets.map((a) => a.name)).toContain(face.src!.slice('bogen-asset:'.length));
    });

    it('writes only what passes the checks, whoever stored it', () => {
      const d = new BogenDoc(new Y.Doc());
      const asset = `bogen-asset:${'a'.repeat(64)}.woff2`;
      addFontFaces(d, [
        { family: 'Good Face', src: asset, weight: '400', display: 'swap' },
        { family: 'x}body{display:none}@font-face{font-family:y', src: asset },
        { family: 'Evil Source', src: 'https://evil.example/f.woff2' },
        { family: 'Evil Descriptor', src: asset, weight: '400;src:url(https://evil.example/f)', style: 'normal}*{color:red' },
        { family: 'Local Only', local: 'Arial' },
        { family: 'Evil Local', local: 'x")}*{color:red' },
      ]);
      const css = fontFacesCss(d, (s) => `/assets/${s.slice(12)}`);
      expect(css).toContain('Good Face');
      expect(css).toContain('local("Arial")');
      expect(css).not.toMatch(/evil\.example|display:none|color:red/i);
      expect(css).toContain('@font-face{font-family:"Evil Descriptor"');
      expect(exportDocument(d, [], {}).match(/@font-face/g)!.length).toBe(3);
    });

    it('can be turned off', async () => {
      const off = h.server.storage.create('No fonts').id;
      const placed = await h.server.capturePageInto(off, { url: `${base}/about`, width: 800, captureFonts: false });
      expect(placed.fonts.stored).toBe(0);
      expect(getFontFaces((await h.server.rooms.get(off)).doc)).toEqual([]);
    }, 60_000);
  });

  describe('interaction rules', () => {
    let fileId: string;
    let nodeId: string;
    let agent: Awaited<ReturnType<typeof connectAgent>>;

    beforeAll(async () => {
      fileId = h.server.storage.create('Rules').id;
      nodeId = (await h.server.capturePageInto(fileId, { url: `${base}/`, width: 1000 })).nodeId;
      agent = await connectAgent(h.base, 'rules-agent');
      await call(agent, 'file_open', { file_id: fileId });
    }, 60_000);

    afterAll(async () => {
      await agent.close();
    });

    it('keeps hover and focus rules, with the layers they match', async () => {
      const out = await call(agent, 'interaction_rules', { state: 'hover' });
      const rules = out.records[0].rules as { selector: string; declarations: string; layers: string[]; condition?: string }[];
      const cta = rules.find((r) => r.selector === 'a.cta:hover')!;
      expect(cta.declarations).toContain('background: rgb(0, 51, 204)');
      expect(cta.layers.length).toBe(1);
      const d = (await h.server.rooms.get(fileId)).doc;
      expect(d.getNode(cta.layers[0]!)?.text ?? d.getNode(cta.layers[0]!)?.tag).toMatch(/Start|a/);
      expect(rules.find((r) => r.selector.includes('only-on-hover'))!.condition).toContain('hover');
      const focus = await call(agent, 'interaction_rules', { state: 'focus-visible' });
      expect(focus.records[0].rules[0].selector).toBe('a.cta:focus-visible');
    });

    it('reads style sheets from another origin too', async () => {
      const out = await call(agent, 'interaction_rules', { state: 'hover' });
      expect(out.records[0].rules.map((r: { selector: string }) => r.selector)).toContain('.external:hover');
    });

    it('filters to a layer, and leaves out rules that match nothing on the page', async () => {
      const d = (await h.server.rooms.get(fileId)).doc;
      const card = d.descendants(nodeId).find((n) => n.text === 'Card')!;
      const out = await call(agent, 'interaction_rules', { node_id: card.id });
      expect(out.records[0].rules.map((r: { selector: string }) => r.selector)).toEqual(['.card:hover .title']);
      const all = getInteractionRecords(d)[0]!.rules.map((r) => r.selector);
      expect(all).not.toContain('.gone:hover');
    });

    it('never reaches a render', async () => {
      const d = (await h.server.rooms.get(fileId)).doc;
      const html = exportDocument(d, [nodeId]);
      expect(html).not.toContain(':hover');
    });
  });

  describe('sitemap reading', () => {
    it('reads both kinds of sitemap', () => {
      expect(parseSitemap('<urlset><url><loc> https://a.test/x?a=1&amp;b=2 </loc></url></urlset>').urls).toEqual(['https://a.test/x?a=1&b=2']);
      expect(parseSitemap('<sitemapindex><sitemap><loc><![CDATA[https://a.test/s.xml]]></loc></sitemap></sitemapindex>').sitemaps).toEqual(['https://a.test/s.xml']);
    });
  });

  describe('a whole site', () => {
    let report: any;
    let events: any[];

    beforeAll(async () => {
      const res = await fetch(`${h.base}/api/capture/site`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `${base}/`, widths: [1000, 400], schemes: ['dark', 'light'], limit: 4 }),
      });
      expect(res.status).toBe(200);
      events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
      report = events.at(-1).report;
    }, 180_000);

    const doc = async () => (await h.server.rooms.get(report.fileId)).doc;

    it('finds routes through the sitemap index, in order, up to the limit', () => {
      expect(report.sitemaps).toContain(`${base}/index-sitemap.xml`);
      expect(report.sitemapRoutes).toBe(6);
      expect(report.pages.map((p: { route: string }) => p.route)).toEqual(['/', '/about', '/pricing', '/extra-1']);
    });

    it('reports what it left out, and why', () => {
      const failed = report.failed.map((f: { url: string; reason: string }) => f.url);
      expect(failed).toContain(`${base}/missing`);
      expect(report.failed.find((f: { url: string }) => f.url.endsWith('/missing')).reason).toContain('404');
      const skipped = report.skipped.map((s: { url: string }) => s.url);
      expect(skipped).toEqual(expect.arrayContaining([`${base}/extra-2`, `${base}/from-link`]));
      expect(report.skipped.find((s: { url: string }) => s.url.endsWith('/extra-2')).reason).toContain('limit of 4');
    });

    it('never goes to another origin or a file that is not a page', () => {
      expect(requests.filter((r) => r === '/brochure.pdf')).toEqual([]);
      expect(JSON.stringify(report.pages)).not.toContain('example.com');
    });

    it('makes one page per route and one artboard per size and scheme', async () => {
      const d = await doc();
      expect(d.getPages().map((p) => p.name)).toEqual(['/', '/about', '/pricing', '/extra-1']);
      for (const p of d.getPages()) {
        const boards = d.getChildren(p.id);
        expect(boards.map((b) => b.name)).toEqual(['1000 dark', '1000 light', '400 dark', '400 light']);
        expect(boards.every((b) => b.artboard)).toBe(true);
        // Side by side, none on top of another.
        const lefts = boards.map((b) => parseFloat(b.style.left!));
        expect(new Set(lefts).size).toBe(4);
      }
    });

    it('gives each scheme its own colours, whatever the tokens say', async () => {
      const d = await doc();
      const home = d.getPages()[0]!;
      const [dark, light] = d.getChildren(home.id);
      expect(dark!.style.backgroundColor).toBe('rgb(16, 16, 20)');
      expect(light!.style.backgroundColor).toBe('rgb(255, 255, 255)');
    });

    it('keeps same-page anchors internal, with their targets', async () => {
      const d = await doc();
      const home = d.getPages()[0]!;
      const board = d.getChildren(home.id)[0]!;
      const links = d.descendants(board.id).filter((n) => n.attrs?.href);
      expect(links.find((n) => n.text === 'Pricing')!.attrs!.href).toBe('#pricing');
      expect(links.find((n) => n.text === 'About')!.attrs!.href).toBe(`${base}/about`);
      const target = d.descendants(board.id).find((n) => n.attrs?.id === 'pricing')!;
      expect(target.tag).toBe('section');
      // Only ids a link points at are kept.
      expect(d.descendants(board.id).some((n) => n.attrs?.id === 'not-linked')).toBe(false);
      const html = exportDocument(d, [board.id]);
      expect(html).toContain('href="#pricing"');
      expect(html).toContain('id="pricing"');
      // A link back to the same route with a hash counts too.
      const about = d.getPages()[1]!;
      const aboutBoard = d.getChildren(about.id)[0]!;
      expect(d.descendants(aboutBoard.id).find((n) => n.text === 'Team')!.attrs!.href).toBe('#team');
    });

    it('streams progress as it goes', () => {
      expect(events[0]).toMatchObject({ t: 'file' });
      expect(events.find((e) => e.t === 'found')).toMatchObject({ sitemap: 6 });
      expect(events.filter((e) => e.t === 'page').length).toBe(4);
    });

    it('refuses this computer and private addresses to an agent', async () => {
      const agent = await connectAgent(h.base, 'site-agent');
      for (const url of [`${base}/`, 'http://192.168.0.1/', 'http://169.254.169.254/']) {
        const result = await callRaw(agent, 'site_capture', { url, limit: 1, wait_seconds: 5 });
        const text = result.content[0]!.text!;
        expect(text).toMatch(/not captured|command line/);
      }
      await agent.close();
    }, 30_000);
  });
});
