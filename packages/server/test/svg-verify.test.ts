import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * Each case is drawn on its own artboard, exported as SVG, drawn again by rsvg-convert (a renderer
 * that is not a browser and shows no foreignObject) and by Chromium as an <img>, and compared pixel
 * by pixel with Bogen's own render of the artboard. The limits are what the export reaches now, with
 * a little room for font hinting; a case that gets worse fails.
 */
const run = promisify(execFile);
const RSVG = spawnSync('rsvg-convert', ['--version'], { stdio: 'ignore' }).status === 0;
const W = 260;
const H = 180;
const FONT = 'font-family:Arial,Helvetica,sans-serif';

interface Case {
  name: string;
  html: string;
  /** Different pixels in percent, rsvg-convert and Chromium, at most. */
  rsvg: number;
  chromium: number;
  /** Fallback reasons the report may give. */
  fallbacks?: string[];
}

const CASES: Case[] = [
  {
    name: 'linear gradients',
    rsvg: 1, chromium: 1,
    html: `<div style="position:absolute;left:10px;top:10px;width:110px;height:70px;background:linear-gradient(90deg,#e11d48,#f59e0b 40%,#10b981)"></div>
      <div style="position:absolute;left:140px;top:10px;width:110px;height:70px;background:linear-gradient(135deg,rgba(37,99,235,1),rgba(37,99,235,0))"></div>
      <div style="position:absolute;left:10px;top:95px;width:110px;height:70px;border-radius:14px;background:linear-gradient(to top right,#111827,#a78bfa)"></div>
      <div style="position:absolute;left:140px;top:95px;width:110px;height:70px;background:linear-gradient(0.25turn,#fde68a 20px,#be123c 80px)"></div>`,
  },
  {
    name: 'radial gradients',
    rsvg: 1, chromium: 1,
    html: `<div style="position:absolute;left:10px;top:10px;width:110px;height:70px;background:radial-gradient(#fef3c7,#b45309)"></div>
      <div style="position:absolute;left:140px;top:10px;width:110px;height:70px;background:radial-gradient(circle at 30% 40%,#ffffff,#0f766e 70%)"></div>
      <div style="position:absolute;left:10px;top:95px;width:240px;height:70px;background:radial-gradient(ellipse,rgba(219,39,119,.9),rgba(219,39,119,0))"></div>`,
  },
  {
    name: 'text',
    // Most of what differs in rsvg is how Pango and Skia smooth the edges of glyphs: lines sit within 0.6 px.
    rsvg: 5.5, chromium: 1.5,
    html: `<p style="position:absolute;left:10px;top:6px;width:240px;margin:0;${FONT};font-size:15px;line-height:19px;color:#111">A paragraph that wraps onto a second line, with <b>bold</b> and <i>italic</i>.</p>
      <p style="position:absolute;left:10px;top:52px;width:240px;margin:0;${FONT};font-size:13px;letter-spacing:3px;text-align:center;text-transform:uppercase;color:#1d4ed8">Spaced and centred</p>
      <p style="position:absolute;left:10px;top:76px;width:240px;margin:0;${FONT};font-size:14px;text-align:right;font-weight:700;color:#7c2d12">Right aligned</p>
      <p style="position:absolute;left:10px;top:100px;width:240px;margin:0;${FONT};font-size:16px;color:#064e3b;text-decoration:underline">Underlined text</p>
      <p style="position:absolute;left:10px;top:124px;width:240px;margin:0;${FONT};font-size:16px;color:#444;text-decoration:line-through">Struck through</p>
      <p style="position:absolute;left:10px;top:148px;width:240px;margin:0;${FONT};font-size:18px;font-weight:700;color:#0f172a;text-shadow:2px 2px 0 #f59e0b">With a shadow</p>`,
  },
  {
    name: 'clips',
    rsvg: 1, chromium: 1,
    html: `<div style="position:absolute;left:10px;top:10px;width:110px;height:110px;border-radius:24px;overflow:hidden;background:#e5e7eb"><div style="width:160px;height:60px;background:#2563eb"></div><div style="width:60px;height:160px;background:#16a34a"></div></div>
      <div style="position:absolute;left:140px;top:10px;width:110px;height:150px;overflow:hidden;background:#fee2e2"><div style="margin:20px;width:120px;height:120px;border-radius:60px;overflow:hidden;background:#dc2626"><div style="width:200px;height:50px;background:#facc15"></div></div></div>`,
  },
  {
    name: 'masks',
    rsvg: 1.5, chromium: 1.5,
    html: `<div style="position:absolute;left:10px;top:10px;width:110px;height:150px;background:#7c3aed;mask-image:linear-gradient(to bottom,#000,transparent)"></div>
      <div style="position:absolute;left:140px;top:10px;width:110px;height:150px;background:#059669;-webkit-mask-image:linear-gradient(90deg,transparent 10%,#000 60%);mask-image:linear-gradient(90deg,transparent 10%,#000 60%)"></div>`,
  },
  {
    name: 'shadows',
    rsvg: 2, chromium: 2,
    html: `<div style="position:absolute;left:20px;top:20px;width:90px;height:50px;border-radius:10px;background:#fff;box-shadow:0 6px 14px rgba(0,0,0,.35)"></div>
      <div style="position:absolute;left:150px;top:20px;width:90px;height:50px;background:#fff;box-shadow:0 0 0 4px #2563eb,6px 6px 0 6px rgba(234,88,12,.6)"></div>
      <div style="position:absolute;left:20px;top:105px;width:90px;height:55px;border-radius:12px;background:#f1f5f9;box-shadow:inset 0 4px 10px rgba(0,0,0,.45)"></div>
      <div style="position:absolute;left:150px;top:105px;width:90px;height:55px;background:#fde68a;box-shadow:inset 6px 6px 0 #b45309"></div>`,
  },
  {
    name: 'pseudo-elements',
    rsvg: 3, chromium: 3,
    html: `<style>
        .tag::before { content: ""; position: absolute; left: 0; top: 0; width: 8px; height: 100%; background: #dc2626 }
        .tag::after { content: "NEW"; position: absolute; right: 8px; top: 8px; ${FONT}; font-size: 11px; font-weight: 700; color: #fff; background: #111827; padding: 2px 6px; border-radius: 4px }
        .quote::before { content: "\\201C"; ${FONT}; font-size: 40px; line-height: 1; color: #2563eb; margin-right: 4px }
      </style>
      <div class="tag" style="position:absolute;left:10px;top:10px;width:240px;height:70px;background:#fef2f2"></div>
      <p class="quote" style="position:absolute;left:10px;top:100px;width:240px;margin:0;${FONT};font-size:16px;line-height:40px;color:#111">Quoted line</p>`,
  },
  {
    name: 'borders, opacity, transforms',
    rsvg: 1.5, chromium: 1.5,
    html: `<div style="position:absolute;left:10px;top:10px;width:100px;height:60px;border:4px solid #0f766e;border-radius:12px;background:#ccfbf1"></div>
      <div style="position:absolute;left:140px;top:10px;width:100px;height:60px;border:3px dashed #9333ea;background:#faf5ff"></div>
      <div style="position:absolute;left:20px;top:100px;width:80px;height:50px;background:#f97316;opacity:.5"></div>
      <div style="position:absolute;left:150px;top:100px;width:80px;height:50px;background:#0ea5e9;transform:rotate(20deg) scale(.9);border-radius:8px"></div>`,
  },
  {
    name: 'combinations',
    rsvg: 3, chromium: 3,
    html: `<style>
        .code::before { content: attr(data-lang); position: absolute; right: 6px; top: 4px; ${FONT}; font-size: 10px; color: #64748b }
      </style>
      <div style="position:absolute;left:14px;top:14px;width:100px;height:60px;border-radius:12px;background:rgba(255,255,255,.4);box-shadow:0 8px 16px rgba(15,23,42,.5)"></div>
      <div style="position:absolute;left:140px;top:14px;width:100px;height:60px;border:6px solid #1e293b;border-radius:16px;overflow:hidden;box-shadow:4px 4px 0 #f43f5e"><div style="width:200px;height:200px;background:#38bdf8"></div></div>
      <div style="position:absolute;left:14px;top:100px;width:100px;height:66px;background:linear-gradient(90deg,#f97316,transparent,#2563eb),#e2e8f0;mask-image:radial-gradient(circle,#000 50%,transparent 70%)"></div>
      <div class="code" data-lang="tsx" style="position:absolute;left:140px;top:100px;width:100px;height:66px;background:#0f172a;border-radius:6px"></div>`,
  },
];

describe.skipIf(!RSVG)('SVG export against the canvas render', () => {
  let h: Harness;
  let dir: string;
  let fileId: string;
  const boards = new Map<string, string>();
  const results: { name: string; rsvg: number; chromium: number; fallbacks: string[] }[] = [];

  beforeAll(async () => {
    h = await startServer();
    dir = process.env.BOGEN_SVG_VERIFY_OUT ?? mkdtempSync(join(tmpdir(), 'bogen-svg-'));
    const agent = await connectAgent(h.base, 'svg-verify');
    fileId = (await call(agent, 'file_create', { name: 'SVG verify' })).id;
    let x = 0;
    for (const c of CASES) {
      const board = await call(agent, 'artboard_create', { name: c.name, width: W, height: H, background: '#fafaf7', x });
      x += W + 40;
      await call(agent, 'html_write', { target_id: board.id, html: c.html });
      boards.set(c.name, board.id);
    }
    await agent.close();
  }, 120_000);

  afterAll(async () => {
    console.table(results.map((r) => ({ case: r.name, rsvg: `${r.rsvg.toFixed(2)} %`, chromium: `${r.chromium.toFixed(2)} %`, fallbacks: r.fallbacks.join('; ') })));
    await h.cleanup();
    if (!process.env.BOGEN_SVG_VERIFY_OUT) rmSync(dir, { recursive: true, force: true });
  });

  const percent = async (a: Uint8Array, b: Uint8Array) => {
    const diff = await h.server.renderer.compareImages({ bytes: a, mime: 'image/png' }, { bytes: b, mime: 'image/png' }, { threshold: 0.1, fit: false, maxDimension: 1000, maxBytes: 4_000_000 });
    return (diff.different / diff.total) * 100;
  };

  for (const c of CASES) {
    it(`${c.name} look the same in rsvg-convert and in Chromium`, async () => {
      const id = boards.get(c.name)!;
      const doc = (await h.server.rooms.get(fileId)).doc;
      const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [id], format: 'svg' }) });
      expect(res.status).toBe(200);
      const svg = await res.text();
      const report = JSON.parse(decodeURIComponent(res.headers.get('x-bogen-export-report')!)) as { fallbacks: { reason: string }[] };
      const slug = c.name.replace(/\W+/g, '-');
      const svgPath = join(dir, `${slug}.svg`);
      writeFileSync(svgPath, svg);
      const direct = (await h.server.renderer.screenshot(doc, { nodeIds: [id] }, { format: 'png' })).bytes;
      writeFileSync(join(dir, `${slug}-bogen.png`), direct);

      const rsvgPath = join(dir, `${slug}-rsvg.png`);
      await run('rsvg-convert', ['-o', rsvgPath, svgPath]);
      const rsvg = new Uint8Array(readFileSync(rsvgPath));

      const chromium = await h.server.renderer.withBrowser(async (browser) => {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
          const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
          await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><img src="${src}" style="display:block"></body></html>`, { waitUntil: 'load' });
          await page.evaluate(() => document.querySelector('img')!.decode());
          return new Uint8Array(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } }));
        } finally {
          await page.close();
        }
      });
      writeFileSync(join(dir, `${slug}-chromium.png`), chromium);

      const result = { name: c.name, rsvg: await percent(direct, rsvg), chromium: await percent(direct, chromium), fallbacks: report.fallbacks.map((f) => f.reason) };
      results.push(result);
      expect(result.fallbacks).toEqual(c.fallbacks ?? []);
      expect(result.rsvg).toBeLessThanOrEqual(c.rsvg);
      expect(result.chromium).toBeLessThanOrEqual(c.chromium);
    }, 60_000);
  }
});
