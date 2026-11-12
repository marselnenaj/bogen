import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driftOfFile, type Drift, type DriftReport } from '../src/drift.ts';
import { callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** The page as the design was made from it. */
const STYLE = `
body { margin: 0; background: #f4efe6; color: #1f1a14; font-family: serif }
header { display: flex; justify-content: space-between; padding: 18px 28px; font-family: Arial, sans-serif; font-size: 14px }
.hero { display: flex; flex-direction: column; gap: 12px; padding: 56px 28px 32px }
h1 { font-size: 56px; line-height: 1.1; margin: 0; font-weight: 400 }
.lead { font-family: Arial, sans-serif; font-size: 18px; margin: 0 }
.book { align-self: flex-start; font: 600 15px Arial, sans-serif; padding: 10px 18px; border-radius: 4px; background: #c8472b; color: #fff; border: 0 }
.routes { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; padding: 0 28px }
.route { height: 120px; background: #e6dccb; padding: 12px; font-family: Arial, sans-serif }
.note { margin: 20px 28px; font-family: Arial, sans-serif; font-size: 14px }
footer { padding: 24px 28px; font-family: Arial, sans-serif; font-size: 13px; background: #1f1a14; color: #f4efe6 }
.cookie { margin: 0 28px 24px; padding: 12px; border: 1px solid #1f1a14; font-family: Arial, sans-serif; font-size: 13px }
header strong::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px; background: #c8472b }
.faq { margin: 0 28px; font-family: Arial, sans-serif }
/* Longer than one 8192px screenshot, so that the live page is taken in tiles. */
.archive { height: 8400px; margin: 0 28px; border-left: 4px solid #e6dccb }
`;

const page = (body: string, extraStyle = '') => `<!doctype html><html><head><title>Couchette</title><style>${STYLE}${extraStyle}</style></head><body>${body}</body></html>`;

const HEADER = '<header><strong>Couchette</strong><nav><a href="/routes">Routes</a> <a href="/fares">Fares</a></nav></header>';
const ROUTES = '<section class="routes"><div class="route">Vienna to Rome</div><div class="route">Paris to Berlin</div><div class="route">Oslo to Malmo</div></section>';
// A closed details, whose inside is not painted, and a long archive.
const FOOTER = '<details class="faq"><summary>Can I bring a bike?</summary><p>Yes, on most routes, for 10 euros.</p></details><div class="archive"></div><footer>Night trains since 2019</footer>';

const ORIGINAL = page(`${HEADER}<section class="hero"><h1>Sleep your way across Europe</h1><p class="lead">Night trains to 40 cities, booked in a minute.</p><button class="book">Book a berth</button></section>${ROUTES}<p class="note">Fares from 49 euros, couchette included</p>${FOOTER}`);

// What a developer changed since: a smaller heading, a lighter button, a wider gap, new words, a note gone and a notice added.
const CHANGED = page(
  `${HEADER}<section class="hero"><h1>Sleep your way across Europe</h1><p class="lead">Night trains to 52 cities, booked in a minute.</p><button class="book">Book a berth</button></section>${ROUTES}<div class="cookie">This site uses one cookie, for your basket.</div>${FOOTER}`,
  'h1 { font-size: 48px } .book { background: #e0562f } .routes { gap: 32px }',
);

describe('drift', () => {
  let h: Harness;
  let site: Server;
  let base: string;
  let fileId: string;
  let artboard: string;
  let served = ORIGINAL;

  beforeAll(async () => {
    site = createServer((_req, res) => void res.writeHead(200, { 'Content-Type': 'text/html' }).end(served));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    h = await startServer();
    fileId = h.server.storage.create('Couchette').id;
    artboard = (await h.server.capturePageInto(fileId, { url: base, width: 1000, colorScheme: 'light', name: 'Home' })).nodeId;
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
    site.close();
  });

  const check = async () => (await driftOfFile(h.server, fileId, { nodeId: artboard, allowLocal: true })).report;
  const find = (report: DriftReport, test: (d: Drift) => boolean) => report.drifts.filter(test);

  it('finds next to nothing when the page is what the design was made from', async () => {
    served = ORIGINAL;
    const report = await check();
    expect(report.url).toBe(base);
    expect(report.width).toBe(1000);
    expect(report.color_scheme).toBe('light');
    expect(report.pixels.different_percent).toBeLessThan(1);
    expect(report.drifts, JSON.stringify(report.drifts.slice(0, 5), null, 1)).toEqual([]);
    expect(report.matched).toBeGreaterThan(10);
    // Down to the footer below the long archive, at full size.
    expect(report.pixels.live_size.height).toBeGreaterThan(8192);
    expect(report.notes).toEqual([]);
  }, 60_000);

  describe('after the page changed', () => {
    let report: DriftReport;
    beforeAll(async () => {
      served = CHANGED;
      report = await check();
    }, 60_000);

    it('measures the pixels and stores an overlay', () => {
      // A small share, since most of the page is the long archive, which did not change.
      expect(report.pixels.different_percent).toBeGreaterThan(0.2);
      expect(report.pixels.bounds!.y).toBeLessThan(400);
      expect(report.pixels.overlay.url).toMatch(/^\/assets\/[a-f0-9]{64}\.png$/);
      expect(report.pixels.overlay.width).toBe(1000);
    });

    it('lists each injected difference with the values of both sides', () => {
      const all = JSON.stringify(report.drifts, null, 1);
      expect(find(report, (d) => d.kind === 'font' && d.property === 'font-size' && d.design === '56px' && d.live === '48px'), all).toHaveLength(1);
      expect(find(report, (d) => d.kind === 'color' && d.property === 'background-color' && d.design === '#c8472b' && d.live === '#e0562f'), all).toHaveLength(1);
      expect(find(report, (d) => d.kind === 'spacing' && d.property === 'column-gap' && d.design === '24px' && d.live === '32px'), all).toHaveLength(1);
      expect(find(report, (d) => d.kind === 'text' && d.design === 'Night trains to 40 cities, booked in a minute.' && d.live === 'Night trains to 52 cities, booked in a minute.'), all).toHaveLength(1);
      expect(find(report, (d) => d.kind === 'missing' && /Fares from/.test(h.server.rooms.peek(fileId)!.doc.getNode(d.layer_id!)?.text ?? '')), all).toHaveLength(1);
      expect(find(report, (d) => d.kind === 'extra' && /cookie/.test(d.live_element?.selector ?? '')), all).toHaveLength(1);
    });

    it('points at the layers and the live elements', () => {
      const doc = h.server.rooms.peek(fileId)!.doc;
      const heading = find(report, (d) => d.property === 'font-size')[0]!;
      expect(doc.getNode(heading.layer_id!)?.tag).toBe('h1');
      expect(heading.live_element?.selector).toMatch(/h1/);
      const button = find(report, (d) => d.property === 'background-color')[0]!;
      expect(doc.getNode(button.layer_id!)?.tag).toBe('button');
    });

    it('reports nothing else, since sizes that follow from these are left out', () => {
      expect(report.drifts.length, JSON.stringify(report.drifts, null, 1)).toBeLessThanOrEqual(7);
    });
  });

  it('keeps Capture\'s rule: an agent cannot compare with a page on this computer', async () => {
    const agent = await connectAgent(h.base, 'drift-agent');
    const result = await callRaw(agent, 'drift_check', { node_id: artboard, file_id: fileId });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/command line or the editor/);
    const privateAddress = await callRaw(agent, 'drift_check', { node_id: artboard, file_id: fileId, url: 'http://192.168.0.1/' });
    expect(privateAddress.content[0]!.text).toMatch(/private address/);
    await agent.close();
  }, 30_000);

  it('answers the editor from this computer, with the defaults first', async () => {
    served = CHANGED;
    const defaults = await (await fetch(`${h.base}/api/files/${fileId}/drift?node=${artboard}`)).json() as { url: string; width: number; color_scheme: string };
    expect(defaults).toMatchObject({ url: base, width: 1000, color_scheme: 'light' });
    const res = await fetch(`${h.base}/api/files/${fileId}/drift`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: artboard }) });
    expect(res.status).toBe(200);
    const out = await res.json() as DriftReport;
    expect(out.counts.text).toBe(1);
  }, 60_000);
});
