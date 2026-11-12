import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, parseRecords } from '@bogen/core';
import { contentAssets, diffFolders, folderFiles, formatDiff, readFolder, stableJson, writeFolder } from '../src/design-folder.ts';
import { parseRange } from '../src/http/assets.ts';
import { makeZip } from '../src/zip.ts';
import { call, callRaw, connectAgent, pngStats, startServer, type Harness } from './helpers.ts';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const has = (tool: string) => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0 || spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
const FFPROBE = has('ffprobe');
const FFMPEG = has('ffmpeg');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

describe('assets over HTTP', () => {
  let h: Harness;
  let url: string;
  let body: Buffer;

  beforeAll(async () => {
    h = await startServer();
    body = Buffer.alloc(300_000);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const res = await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: body as unknown as BodyInit });
    expect(res.status).toBe(201);
    url = `${h.base}${(await res.json() as { url: string }).url}`;
  });

  afterAll(() => h.cleanup());

  it('answers ranges, for seeking in a video', async () => {
    const res = await fetch(url, { headers: { Range: 'bytes=1000-1999' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1999/${body.length}`);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(Buffer.from(await res.arrayBuffer()).equals(body.subarray(1000, 2000))).toBe(true);
    const open = await fetch(url, { headers: { Range: `bytes=${body.length - 10}-` } });
    expect((await open.arrayBuffer()).byteLength).toBe(10);
    const suffix = await fetch(url, { headers: { Range: 'bytes=-20' } });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer()).equals(body.subarray(body.length - 20))).toBe(true);
  });

  it('says so for a range past the end, and serves everything for what it does not understand', async () => {
    const past = await fetch(url, { headers: { Range: `bytes=${body.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${body.length}`);
    const several = await fetch(url, { headers: { Range: 'bytes=0-1,5-6' } });
    expect(several.status).toBe(200);
    expect(parseRange('bytes=-0', 10)).toBe('invalid');
    expect(parseRange('items=0-1', 10)).toBeNull();
  });

  it('caches by content: immutable, an ETag, a 304, and HEAD with no body', async () => {
    const first = await fetch(url);
    const etag = first.headers.get('etag')!;
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    await first.arrayBuffer();
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(body.length));
    const stale = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': '"something-else"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();
    const fresh = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();
  });

  it('is private behind a token', async () => {
    const secured = await startServer({ token: 'sekret' });
    const res = await fetch(`${secured.base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: 'Bearer sekret' }, body: PNG as unknown as BodyInit });
    const asset = await res.json() as { url: string };
    const got = await fetch(`${secured.base}${asset.url}`, { headers: { Authorization: 'Bearer sekret' } });
    expect(got.headers.get('cache-control')).toContain('private');
    await secured.cleanup();
  });

  it('keeps images small, lets a video be big, and leaves nothing behind when refusing', async () => {
    const refused = await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(65 * 1024 * 1024) as unknown as BodyInit });
    expect(refused.status).toBe(413);
    const video = await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(65 * 1024 * 1024, 1) as unknown as BodyInit });
    expect(video.status).toBe(201);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 70; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const undeclared = await fetch(`${h.base}/api/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: stream, duplex: 'half' } as RequestInit).catch(() => null);
    if (undeclared) expect(undeclared.status).toBe(413);
    expect(readdirSync(join(h.home, 'assets')).filter((n) => n.startsWith('.upload-'))).toEqual([]);
  }, 60_000);
});

describe('export formats', () => {
  let h: Harness;
  let fileId: string;
  let pageId: string;
  let boxId: string;
  let boardId: string;
  let shaderBoard: string;
  let dir: string;

  const exportTo = async (format: string, name: string, extra: object = {}) => {
    const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [boardId], format, ...extra }) });
    if (!res.ok) throw new Error(await res.text());
    const bytes = Buffer.from(await res.arrayBuffer());
    const path = join(dir, name);
    writeFileSync(path, bytes);
    const report = res.headers.get('x-bogen-export-report');
    return { path, bytes, report: report ? JSON.parse(decodeURIComponent(report)) as Record<string, any> : null };
  };

  const frameAt = async (video: string, seconds: number, name: string) => {
    const out = join(dir, name);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(seconds), '-i', video, '-frames:v', '1', out]);
    return readFileSync(out);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bogen-export-'));
    h = await startServer();
    const agent = await connectAgent(h.base, 'export-agent');
    const file = await call(agent, 'file_create', { name: 'Export' });
    fileId = file.id;
    await call(agent, 'keyframes_set', { name: 'slide', css: '@keyframes slide { from { left: 0px } to { left: 200px } }' }).catch(async () => {
      (await h.server.rooms.get(fileId)).doc.meta.set('keyframes', ['@keyframes slide { from { left: 0px } to { left: 200px } }']);
    });
    const board = await call(agent, 'artboard_create', { name: 'Board', width: 320, height: 180, background: '#102030' });
    boardId = board.id;
    pageId = board.page_id;
    await call(agent, 'html_write', { target_id: board.id, html: '<div data-name="Mover" style="position:absolute;left:0;top:40px;width:80px;height:80px;background:#ff3366;animation:slide 2s linear forwards"></div>' });
    const doc = (await h.server.rooms.get(fileId)).doc;
    boxId = doc.getChildren(board.id)[0]!.id;
    const shaderB = await call(agent, 'artboard_create', { name: 'Shader', width: 200, height: 120, x: 800 });
    shaderBoard = shaderB.id;
    doc.insert(shaderB.id, { type: 'shader', name: 'Noise', style: { position: 'absolute', left: '0px', top: '0px', width: '200px', height: '120px' }, attrs: { type: 'mesh-gradient', colors: '["#ff0000","#00ff00","#0000ff","#ffff00"]', speed: '1' } });
    await agent.close();
  }, 60_000);

  afterAll(async () => {
    await h.cleanup();
    if (process.env.KEEP_EXPORTS) console.log(dir);
    else rmSync(dir, { recursive: true, force: true });
  });

  describe('video', () => {
    it.runIf(FFMPEG && FFPROBE)('makes an MP4 with ffmpeg, at the size, rate and length asked for', async () => {
      const out = await exportTo('mp4', 'a.mp4', { duration: 2, fps: 10 });
      expect(out.report).toMatchObject({ encoder: 'ffmpeg', codec: 'h264', frames: 20, fps: 10, width: 320, height: 180 });
      const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out.path])).stdout);
      const video = probe.streams[0];
      expect(video).toMatchObject({ codec_name: 'h264', width: 320, height: 180, r_frame_rate: '10/1', pix_fmt: 'yuv420p' });
      expect(Number(video.nb_frames)).toBe(20);
      expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
    }, 120_000);

    it.runIf(FFMPEG && FFPROBE)('makes a WebM with ffmpeg', async () => {
      const out = await exportTo('webm', 'a.webm', { duration: 1, fps: 10, scale: 2 });
      expect(out.report).toMatchObject({ encoder: 'ffmpeg', codec: 'vp9', width: 640, height: 360 });
      const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out.path])).stdout);
      expect(probe.streams[0]).toMatchObject({ codec_name: 'vp9', width: 640, height: 360 });
    }, 120_000);

    it.runIf(FFPROBE)('makes both with WebCodecs in the page, without ffmpeg', async () => {
      const webm = await exportTo('webm', 'wc.webm', { duration: 1, fps: 10, encoder: 'webcodecs' });
      expect(webm.report!.encoder).toBe('webcodecs');
      const probeWebm = JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', webm.path])).stdout);
      expect(probeWebm.streams[0].codec_name).toMatch(/vp9|vp8|av1/);
      expect(Number(probeWebm.streams[0].nb_read_frames)).toBe(10);
      const mp4 = await exportTo('mp4', 'wc.mp4', { duration: 1, fps: 10, encoder: 'webcodecs' });
      expect(mp4.report!.encoder).toBe('webcodecs');
      const probeMp4 = JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', mp4.path])).stdout);
      expect(probeMp4.streams[0].codec_name).toMatch(/h264|vp9|av1/);
      expect(Number(probeMp4.streams[0].nb_read_frames)).toBe(10);
    }, 120_000);

    it.runIf(FFMPEG)('follows CSS animations at exact times, and two runs give the same frames', async () => {
      const a = await exportTo('webm', 'r1.webm', { duration: 2, fps: 5 });
      const b = await exportTo('webm', 'r2.webm', { duration: 2, fps: 5 });
      const hash = async (p: string) => (await run('ffmpeg', ['-v', 'error', '-i', p, '-f', 'framemd5', '-'])).stdout.replace(/^#.*$/gm, '').trim();
      expect(await hash(a.path)).toBe(await hash(b.path));
      const first = await frameAt(a.path, 0, 'f0.png');
      const later = await frameAt(a.path, 1.8, 'f9.png');
      expect(first.equals(later)).toBe(false);
      // The box moves left to right: at the start it covers x=20, near the end it does not.
      const fractionAt = async (png: Buffer) => {
        const diff = await h.server.renderer.compareImages({ bytes: png, mime: 'image/png' }, { bytes: first, mime: 'image/png' }, { threshold: 0.2, fit: false, maxDimension: 1000, maxBytes: 4_000_000 });
        return diff;
      };
      const moved = await fractionAt(later);
      expect(moved.bounds!.x).toBeLessThan(20);
      expect(moved.bounds!.x + moved.bounds!.width).toBeGreaterThan(200);
    }, 180_000);

    it.runIf(FFMPEG)('moves shaders frame by frame too, and repeatably', async () => {
      const res = async () => {
        const r = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [shaderBoard], format: 'webm', duration: 1, fps: 4 }) });
        expect(r.status).toBe(200);
        return Buffer.from(await r.arrayBuffer());
      };
      const one = join(dir, 's1.webm');
      const two = join(dir, 's2.webm');
      writeFileSync(one, await res());
      writeFileSync(two, await res());
      const frames = async (p: string) => (await run('ffmpeg', ['-v', 'error', '-i', p, '-f', 'framemd5', '-'])).stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
      const a = await frames(one);
      const b = await frames(two);
      expect(a).toEqual(b);
      expect(new Set(a).size).toBeGreaterThan(1);
    }, 180_000);

    it('refuses nonsense', async () => {
      const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [boardId], format: 'mp4', duration: 9999 }) });
      expect(res.status).toBe(400);
    });

    it('works through MCP', async () => {
      const agent = await connectAgent(h.base, 'video-agent');
      await call(agent, 'file_open', { file_id: fileId });
      const out = await call(agent, 'export_file', { format: 'webm', node_ids: [boardId], duration: 0.5, fps: 4 });
      expect(out.paths[0]).toMatch(/\.webm$/);
      expect(out.reports[0].frames).toBe(2);
      await agent.close();
    }, 60_000);
  });

  describe('AVIF and presets', () => {
    it('makes an AVIF that decoders read', async () => {
      const out = await exportTo('avif', 'a.avif', { scale: 2 });
      expect(out.bytes.subarray(4, 12).toString('latin1')).toBe('ftypavif');
      expect(out.report!.encoder).toMatch(/webcodecs|ffmpeg/);
      const decoded = await h.server.renderer.compareImages({ bytes: out.bytes, mime: 'image/avif' }, { bytes: out.bytes, mime: 'image/avif' }, { threshold: 0, fit: false, maxDimension: 2000, maxBytes: 8_000_000 });
      expect(decoded.sizeA).toEqual({ width: 640, height: 360 });
      if (has('ffprobe')) {
        const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out.path])).stdout);
        expect(probe.streams[0].codec_name).toBe('av1');
      }
      const avifdec = spawnSync('avifdec', ['--info', out.path], { encoding: 'utf8' });
      if (avifdec.status !== null) expect(`${avifdec.stdout}${avifdec.stderr}`).toMatch(/Resolution\s*:\s*640x360/);
    }, 60_000);

    it('zips several sizes at once, with a name for each', async () => {
      const res = await fetch(`${h.base}/api/export/presets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, nodeIds: [boardId], presets: [{ format: 'png', scale: 1 }, { format: 'png', scale: 2 }, { format: 'webp', width: 160 }, { format: 'avif', scale: 1, suffix: '-small' }, { format: 'svg' }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      const zip = join(dir, 'set.zip');
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const out = join(dir, 'unzipped');
      const py = `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());z.extractall(sys.argv[2]);print('\\n'.join(sorted(z.namelist())))`;
      const { stdout } = await run('python3', ['-c', py, zip, out]);
      const lines = stdout.trim().split('\n');
      expect(lines[0]).toBe('None');
      expect(lines.slice(1)).toEqual(['Board-160w.webp', 'Board-small.avif', 'Board.png', 'Board.svg', 'Board@2x.png']);
      expect((await pngStats(readFileSync(join(out, 'Board@2x.png')))).width).toBe(640);
    }, 120_000);

    it('writes a zip that deflates text', () => {
      const made = makeZip([{ name: 'a.svg', bytes: Buffer.from('<svg>'.repeat(100)) }, { name: 'b.png', bytes: PNG }]);
      expect(made.subarray(0, 4).toString('hex')).toBe('504b0304');
    });
  });

  describe('vector SVG', () => {
    let doc: Awaited<ReturnType<Harness['server']['rooms']['get']>>['doc'];
    let vectorBoard: string;

    beforeAll(async () => {
      const agent = await connectAgent(h.base, 'svg-agent');
      await call(agent, 'file_open', { file_id: fileId });
      const asset = await h.server.storage.putAsset(PNG, 'image/png');
      const board = await call(agent, 'artboard_create', { name: 'Vector', width: 500, height: 400, background: '#f4f4f0', x: 2000 });
      vectorBoard = board.id;
      await call(agent, 'html_write', {
        target_id: board.id,
        html: `<div data-name="Gradient" style="position:absolute;left:20px;top:20px;width:200px;height:100px;border-radius:16px;background:linear-gradient(90deg,#ff0000,#0000ff);box-shadow:0 4px 12px rgba(0,0,0,.3)"></div>
          <div data-name="Radial" style="position:absolute;left:240px;top:20px;width:100px;height:100px;background:radial-gradient(circle,#ffffff,#000000)"></div>
          <div data-name="Bordered" style="position:absolute;left:20px;top:140px;width:120px;height:60px;border:3px solid #006600;border-radius:8px;background-color:#ccffcc"></div>
          <div data-name="Bottom line" style="position:absolute;left:160px;top:140px;width:120px;height:60px;border-bottom:2px solid #333333"></div>
          <p data-name="Copy" style="position:absolute;left:20px;top:220px;width:200px;font-family:Arial,sans-serif;font-size:16px;line-height:20px;color:#111111;margin:0">Two lines of text that wrap, with <b style="color:#aa0000">bold</b> inside</p>
          <img src="${asset.src}" alt="dot" style="position:absolute;left:300px;top:140px;width:60px;height:60px;border-radius:30px">
          <svg style="position:absolute;left:380px;top:140px;width:60px;height:60px" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#ff8800"/></svg>
          <div data-name="Turned" style="position:absolute;left:300px;top:240px;width:80px;height:40px;background-color:#663399;transform:rotate(30deg);opacity:.8"></div>
          <div data-name="Clipped" style="position:absolute;left:400px;top:240px;width:60px;height:60px;overflow:hidden;background-color:#dddddd"><div style="width:100px;height:100px;background-color:#008888"></div></div>`,
      });
      await agent.close();
      doc = (await h.server.rooms.get(fileId)).doc;
    }, 60_000);

    const exportSvg = async (nodeId: string) => {
      const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [nodeId], format: 'svg' }) });
      expect(res.status).toBe(200);
      return { text: await res.text(), report: JSON.parse(decodeURIComponent(res.headers.get('x-bogen-export-report')!)) };
    };

    it('writes native elements, and nothing falls back', async () => {
      const { text, report } = await exportSvg(vectorBoard);
      expect(report.fallbacks).toEqual([]);
      expect(report.native).toBeGreaterThan(8);
      expect(text).not.toContain('foreignObject');
      expect(text).toMatch(/<linearGradient[^>]*gradientUnits="userSpaceOnUse"/);
      expect(text).toContain('<radialGradient');
      expect(text).toContain('feGaussianBlur');
      expect(text).toMatch(/<rect[^>]*rx="16"/);
      expect(text).toMatch(/<text [^>]*font-size="16"[^>]*>Two lines of text/);
      expect((text.match(/<text /g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect(text).toContain('<image href="data:image/png;base64');
      expect(text).toContain('<circle');
      expect(text).toMatch(/<g [^>]*opacity="0\.8"[^>]*transform="[^"]*matrix\(/);
      expect(text).toContain('clip-path="url(#');
      expect(text).toMatch(/<line [^>]*stroke="#333333"/);
    }, 60_000);

    it('opens in tools that are not browsers', async () => {
      const { text } = await exportSvg(vectorBoard);
      const path = join(dir, 'vector.svg');
      writeFileSync(path, text);
      if (has('xmllint')) await run('xmllint', ['--noout', path]);
      if (spawnSync('rsvg-convert', ['--version'], { stdio: 'ignore' }).status === 0) {
        const out = join(dir, 'vector-rsvg.png');
        await run('rsvg-convert', ['-o', out, path]);
        const stats = await pngStats(readFileSync(out));
        expect(stats.width).toBe(500);
        expect(stats.distinctColors).toBeGreaterThan(8);
      }
    }, 30_000);

    it('looks like the layer does', async () => {
      const { text } = await exportSvg(vectorBoard);
      const direct = await h.server.renderer.screenshot(doc, { nodeIds: [vectorBoard] }, { format: 'png' });
      writeFileSync(join(dir, 'vector-direct.png'), direct.bytes);
      const diff = await h.server.renderer.withBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setViewport({ width: 500, height: 400, deviceScaleFactor: 1 });
        await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${text}</body></html>`, { waitUntil: 'load' });
        const shot = await page.screenshot({ type: 'png' });
        await page.close();
        return new Uint8Array(shot);
      });
      writeFileSync(join(dir, 'vector-svg.png'), diff);
      const compared = await h.server.renderer.compareImages({ bytes: direct.bytes, mime: 'image/png' }, { bytes: diff, mime: 'image/png' }, { threshold: 0.2, fit: false, maxDimension: 1000, maxBytes: 4_000_000 });
      expect(compared.different / compared.total).toBeLessThan(0.02);
    }, 60_000);

    it('reports per layer what stays HTML, and the rest is still native', async () => {
      const agent = await connectAgent(h.base, 'svg-agent2');
      await call(agent, 'file_open', { file_id: fileId });
      const board = await call(agent, 'artboard_create', { name: 'Hard', width: 300, height: 200, x: 3000 });
      await call(agent, 'html_write', { target_id: board.id, html: `<div data-name="Glass" style="position:absolute;left:0;top:0;width:100px;height:100px;backdrop-filter:blur(4px)"></div><div data-name="Cone" style="position:absolute;left:100px;top:0;width:100px;height:100px;background:conic-gradient(#f00,#00f)"></div><div data-name="Plain" style="position:absolute;left:200px;top:0;width:100px;height:100px;background-color:#0f0"></div>` });
      const { text, report } = await exportSvg(board.id);
      expect(report.fallbacks.map((f: { reason: string }) => f.reason)).toEqual(['backdrop-filter', 'conic-gradient']);
      expect(report.fallbacks[0].id).toBeTruthy();
      expect(text).toContain('foreignObject');
      expect(text).toMatch(/<rect[^>]*fill="#00ff00"/);
      const res = await call(agent, 'export_file', { format: 'svg', node_ids: [board.id] });
      expect(res.reports[0].fallbacks).toHaveLength(2);
      await agent.close();
    }, 60_000);

    it('can still give the old foreignObject form', async () => {
      const res = await fetch(`${h.base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeIds: [vectorBoard], format: 'svg', svgMode: 'foreignObject' }) });
      expect(await res.text()).toContain('foreignObject');
    }, 30_000);

    it('keeps exports of a box unharmed', () => {
      expect(doc.getNode(boxId)).toBeTruthy();
      expect(pageId).toBeTruthy();
    });
  });
});

describe('design folders', () => {
  let h: Harness;
  let fileId: string;
  let dirs: string;
  const cli = async (...args: string[]) => (await run('npx', ['tsx', 'packages/server/src/cli.ts', ...args], { cwd: ROOT, env: { ...process.env, BOGEN_URL: h.base, BOGEN_HOME: h.home } })).stdout;

  beforeAll(async () => {
    dirs = mkdtempSync(join(tmpdir(), 'bogen-folder-'));
    h = await startServer();
    const agent = await connectAgent(h.base, 'folder-agent');
    const file = await call(agent, 'file_create', { name: 'Folder test' });
    fileId = file.id;
    await call(agent, 'tokens_set', { tokens: [{ name: 'zeta', kind: 'color', value: '#000000' }, { name: 'alpha', kind: 'spacing', value: '4px' }] });
    const asset = await h.server.storage.putAsset(PNG, 'image/png');
    const board = await call(agent, 'artboard_create', { name: 'Home', width: 400, height: 300 });
    await call(agent, 'html_write', { target_id: board.id, html: `<div style="padding:8px"><p style="color:var(--zeta)">Hello</p><img src="${asset.src}" alt="x"></div>` });
    const second = await call(agent, 'page_create', { name: 'Second page' });
    await call(agent, 'artboard_create', { name: 'Other', width: 200, height: 100, page_id: second.id });
    await agent.close();
  }, 30_000);

  afterAll(async () => {
    await h.cleanup();
    rmSync(dirs, { recursive: true, force: true });
  });

  it('writes the same bytes every time, sorted, parents before children', async () => {
    const a = join(dirs, 'a');
    const b = join(dirs, 'b');
    expect(await cli('export-folder', fileId, a)).toContain('Folder test');
    await cli('export-folder', 'Folder test', b);
    const tree = (d: string): Record<string, string> => Object.fromEntries((readdirSync(d, { recursive: true }) as string[]).filter((f) => /\.\w+$/.test(f)).sort().map((f) => [f, readFileSync(join(d, f)).toString('base64')]));
    expect(tree(a)).toEqual(tree(b));
    expect(Object.keys(tree(a)).filter((f) => !f.startsWith('assets'))).toEqual(expect.arrayContaining(['design.json', 'tokens.json']));
    expect(readdirSync(join(a, 'pages')).length).toBe(2);
    const tokens = JSON.parse(readFileSync(join(a, 'tokens.json'), 'utf8'));
    expect(tokens.map((t: { name: string }) => t.name)).toEqual(['alpha', 'zeta']);
    const page = readdirSync(join(a, 'pages')).find((n) => n.startsWith('page-1'))!;
    const text = readFileSync(join(a, 'pages', page), 'utf8');
    const parsed = JSON.parse(text) as { layers: { id: string; parent: string }[] };
    const seen = new Set<string>([(parsed as unknown as { id: string }).id]);
    for (const layer of parsed.layers) {
      expect(seen.has(layer.parent)).toBe(true);
      seen.add(layer.id);
      const keys = Object.keys(layer);
      expect(keys).toEqual([...keys].sort());
    }
    expect(text.split('\n').length).toBeGreaterThan(20);
    expect(text.endsWith('}\n')).toBe(true);
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  }, 60_000);

  it('round trips through import to the same bytes', async () => {
    const a = join(dirs, 'rt-a');
    const b = join(dirs, 'rt-b');
    await cli('export-folder', fileId, a);
    const out = await cli('import-folder', a, '--name', 'Folder test');
    const id = /\(([0-9a-z]+)\)/.exec(out)![1]!;
    expect(id).not.toBe(fileId);
    await cli('export-folder', id, b);
    const diff = await cli('diff', a, b);
    expect(diff.trim()).toBe('No differences.');
    const files = readdirSync(a, { recursive: true }) as string[];
    for (const f of files) if (/\.json$/.test(f)) expect(readFileSync(join(b, f), 'utf8')).toBe(readFileSync(join(a, f), 'utf8'));
    const doc = (await h.server.rooms.get(id)).doc;
    expect(doc.getPages().map((p) => p.name)).toEqual(['Page 1', 'Second page']);
    const shot = await h.server.renderer.screenshot(doc, { pageId: doc.getPages()[0]!.id });
    expect(shot.bytes.length).toBeGreaterThan(100);
  }, 90_000);

  it('summarizes a diff by meaning', async () => {
    const a = join(dirs, 'd-a');
    const b = join(dirs, 'd-b');
    await cli('export-folder', fileId, a);
    const agent = await connectAgent(h.base, 'diff-agent');
    await call(agent, 'file_open', { file_id: fileId });
    const doc = (await h.server.rooms.get(fileId)).doc;
    const page = doc.getPages()[0]!.id;
    const board = doc.getChildren(page)[0]!;
    await call(agent, 'layer_style', { node_ids: [board.id], style: { backgroundColor: '#00ff00', padding: '4px' } });
    await call(agent, 'html_write', { target_id: board.id, html: '<h2>New heading</h2>' });
    await call(agent, 'tokens_set', { tokens: [{ name: 'zeta', kind: 'color', value: '#ffffff' }, { name: 'gamma', kind: 'spacing', value: '8px' }] });
    await call(agent, 'page_rename', { page_id: doc.getPages()[1]!.id, name: 'Renamed page' });
    await agent.close();
    await cli('export-folder', fileId, b);
    const text = await cli('diff', a, b);
    expect(text).toContain('Page renamed: Second page -> Renamed page');
    expect(text).toMatch(/Page Page 1: 1 layers added, 0 removed, 1 changed/);
    expect(text).toContain('style.backgroundColor');
    expect(text).toContain('Tokens added: gamma');
    expect(text).toContain('Tokens changed: zeta');
    const json = JSON.parse(await cli('diff', a, b, '--json'));
    expect(json.same).toBe(false);
    expect(json.layers[0].changed[0].fields).toEqual(expect.arrayContaining(['style.backgroundColor', 'style.padding']));
    const folderA = await readFolder(a);
    expect(diffFolders(folderA, folderA).same).toBe(true);
    expect(formatDiff(diffFolders(folderA, folderA))).toBe('No differences.\n');
  }, 90_000);

  it('cleans up what no longer belongs, and refuses a folder that is something else', async () => {
    const a = join(dirs, 'clean');
    const folder = await readFolder(join(dirs, 'd-b'));
    await writeFolder(a, folder, async () => PNG);
    const one = { ...folder, content: { ...folder.content, pages: folder.content.pages.slice(0, 1), nodes: folder.content.nodes.filter((n) => !folder.content.pages[1] || n.parent !== folder.content.pages[1]!.id) } };
    const nested = folderFiles(one);
    await writeFolder(a, one, async () => PNG);
    expect(readdirSync(join(a, 'pages')).length).toBe([...nested.keys()].filter((f) => f.startsWith('pages/')).length);
    const other = join(dirs, 'other');
    await run('mkdir', ['-p', other]);
    writeFileSync(join(other, 'notes.txt'), 'mine');
    await expect(writeFolder(other, folder, async () => PNG)).rejects.toThrow(/not a design folder/);
    expect(contentAssets(folder.content).length).toBe(1);
  });

  it('refuses a folder that points outside itself or has been tampered with', async () => {
    const a = join(dirs, 'evil');
    await cli('export-folder', fileId, a);
    const design = JSON.parse(readFileSync(join(a, 'design.json'), 'utf8'));
    design.pages[0].file = '../../secret.json';
    writeFileSync(join(a, 'design.json'), JSON.stringify(design));
    await expect(readFolder(a)).rejects.toThrow(/not a page file/);
    const res = await fetch(`${h.base}/api/files/import-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bad', content: { format: 1, pages: [], nodes: [], tokens: [] } }) });
    expect(res.status).toBe(400);
    const orphan = await fetch(`${h.base}/api/files/import-folder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bad', content: { format: 1, pages: [{ id: 'p', name: 'P', order: 'a' }], nodes: [{ id: 'x', parent: 'nobody', order: 'a', type: 'frame', name: 'x', tag: 'div', style: {} }], tokens: [], keyframes: [], fontFaces: [], interactionStates: [] } }) });
    expect(orphan.status).toBe(400);
    expect((await orphan.json() as { error: string }).error).toContain('before its parent');
  }, 60_000);
});

describe('live data', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof connectAgent>>;
  let data: Server;
  let doc: Awaited<ReturnType<Harness['server']['rooms']['get']>>['doc'];
  let grid: string;
  let template: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'data-agent');
    await call(agent, 'file_create', { name: 'Data' });
    const board = await call(agent, 'artboard_create', { name: 'List', width: 800, height: 600 });
    await call(agent, 'html_write', {
      target_id: board.id,
      html: `<div data-name="Grid" style="display:flex;gap:8px;flex-wrap:wrap"><div data-name="Card {{name}}" style="width:100px;background-color:{{color}};padding:4px"><p>{{name}}</p><p>{{price.amount}} {{price.unit}}</p><img src="{{image}}" alt="{{name}}" style="width:20px;height:20px"></div></div>`,
    });
    doc = (await h.server.rooms.get((await call(agent, 'file_list', {}))[0].id)).doc;
    const gridNode = doc.descendants(board.id).find((n) => n.style.display === 'flex')!;
    grid = gridNode.id;
    template = doc.getChildren(grid)[0]!.id;
    data = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"items":[{"name":"X"}]}'));
    await new Promise<void>((r) => data.listen(0, '127.0.0.1', r));
  }, 30_000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
    data.close();
  });

  const texts = (id: string) => doc.descendants(id).filter((n) => n.type === 'text').map((n) => n.text);

  it('makes one copy per record, filling text, sources and styles', async () => {
    const out = await call(agent, 'layer_repeat', {
      node_id: template,
      data: JSON.stringify([
        { name: 'Alpha', color: '#ff0000', price: { amount: 10, unit: 'EUR' }, image: 'https://example.com/a.png' },
        { name: 'Beta', color: '#00ff00', price: { amount: 20, unit: 'USD' }, image: 'https://example.com/b.png' },
      ]),
    });
    expect(out).toMatchObject({ copies: 2, fields: ['color', 'image', 'name', 'price.amount', 'price.unit'], missing: [], refused: [] });
    const kids = doc.getChildren(grid);
    expect(kids.map((k) => k.hidden ?? false)).toEqual([true, false, false]);
    const first = kids[1]!;
    expect(first.name).toBe('Card Alpha');
    expect(first.style.backgroundColor).toBe('#ff0000');
    expect(texts(first.id)).toEqual(['Alpha', '10 EUR']);
    const img = doc.descendants(first.id).find((n) => n.type === 'image')!;
    expect(img.src).toBe('https://example.com/a.png');
    expect(img.attrs?.alt).toBe('Alpha');
    // The template keeps its placeholders.
    expect(texts(template)[0]).toBe('{{name}}');
  });

  it('lays out in the flex parent, with the template out of the way', async () => {
    const boxes = await h.server.renderer.layout(doc, { nodeIds: [grid] }, doc.getChildren(grid).map((k) => k.id));
    const [hiddenBox, a, b] = doc.getChildren(grid).map((k) => boxes.find((r) => r.id === k.id)!);
    expect(hiddenBox!.width).toBe(0);
    expect(a!.width).toBe(100);
    expect(b!.x - a!.x).toBe(108);
  }, 30_000);

  it('replaces the copies when it runs again, from new data or from what it had', async () => {
    const out = await call(agent, 'layer_repeat', { node_id: template, data: 'name,color\nOne,#111111\nTwo,#222222\nThree,#333333\n', format: 'csv' });
    expect(out.copies).toBe(3);
    expect(out.missing).toEqual(['image', 'price.amount', 'price.unit']);
    expect(doc.getChildren(grid).length).toBe(4);
    expect(doc.getChildren(grid)[3]!.style.backgroundColor).toBe('#333333');
    const again = await call(agent, 'layer_repeat', { node_id: template });
    expect(again.copies).toBe(3);
    expect(doc.getChildren(grid).length).toBe(4);
  });

  it('takes it all back with one undo', async () => {
    await call(agent, 'layer_repeat', { node_id: template, data: '[{"name":"Solo","color":"red"}]' });
    expect(doc.getChildren(grid).length).toBe(2);
    await call(agent, 'agent_undo', {});
    expect(doc.getChildren(grid).length).toBe(4);
  });

  it('never lets a record reach beyond its value', async () => {
    const out = await call(agent, 'layer_repeat', {
      node_id: template,
      data: JSON.stringify([{ name: '<img src=x onerror=alert(1)>', color: 'red;background:url(https://evil.example/x)', image: 'javascript:alert(1)', price: { amount: 1, unit: 'x' } }]),
    });
    expect(out.refused.length).toBe(2);
    const copy = doc.getChildren(grid)[1]!;
    expect(copy.style.backgroundColor).toBeUndefined();
    const img = doc.descendants(copy.id).find((n) => n.type === 'image')!;
    expect(img.src).toBeUndefined();
    const { nodeToHtml } = await import('@bogen/core');
    const html = nodeToHtml(doc, copy.id);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('&lt;img src=x');
  });

  it('fetches public addresses only, and never in a dry run', async () => {
    const port = (data.address() as AddressInfo).port;
    for (const url of [`http://127.0.0.1:${port}/data.json`, 'http://localhost:1/', 'http://192.168.1.1/x.json', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
      const result = await callRaw(agent, 'layer_repeat', { node_id: template, url });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/private|Only http|not fetched|resolve/i);
    }
    const rest = await fetch(`${h.base}/api/data/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${port}/` }) });
    expect(rest.status).toBe(400);
  });

  it('reads tables and finds the list', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n1,\n')).toEqual([{ a: 'x, y', b: 'say "hi"' }, { a: '1', b: '' }]);
    expect(parseCsv('a;b\n1;2\n')).toEqual([{ a: '1', b: '2' }]);
    expect(parseRecords('{"items":[{"a":1}],"total":1}')).toEqual([{ a: 1 }]);
    expect(parseRecords('{"data":{"rows":[{"a":2}]},"x":[1]}', { path: 'data.rows' })).toEqual([{ a: 2 }]);
    expect(() => parseRecords('{"a":[1],"b":[2]}')).toThrow(/several lists/);
    expect(parseRecords('["x","y"]')).toEqual([{ value: 'x' }, { value: 'y' }]);
  });

  it('refuses a layer with nothing to fill, a copy, and too many records', async () => {
    const plain = await call(agent, 'html_write', { target_id: grid, html: '<p>Nothing here</p>' });
    expect(plain).toBeTruthy();
    const none = doc.getChildren(grid).at(-1)!;
    expect((await callRaw(agent, 'layer_repeat', { node_id: none.id, data: '[{"a":1}]' })).content[0]!.text).toContain('placeholders');
    const copy = doc.getChildren(grid)[1]!;
    expect((await callRaw(agent, 'layer_repeat', { node_id: copy.id, data: '[{"a":1}]' })).content[0]!.text).toContain('its template');
    const many = JSON.stringify(Array.from({ length: 501 }, () => ({ name: 'x' })));
    expect((await callRaw(agent, 'layer_repeat', { node_id: template, data: many })).content[0]!.text).toContain('at most 500');
  });
});
