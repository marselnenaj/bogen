// The built product end to end: real server, real browser with the real CSP, real coding agent.
// Usage: npx tsx apps/editor/test/e2e/integration.ts <out-dir> [--agent]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { BogenDoc, Y } from '@bogen/core';

const out = process.argv[2]!;
const withAgent = process.argv.includes('--agent');
const port = 39990;
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), 'bogen-int-'));
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
};

const server = spawn('node', ['packages/server/dist/cli.js', 'serve', '--port', String(port)], { env: { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0' }, stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  if (await fetch(`${base}/api/status`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const json = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1600, height: 1000 } });
try {
  const page = await browser.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror ${(e as Error).message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|favicon/.test(m.text())) problems.push(m.text()); });
  await page.evaluateOnNewDocument(() => document.addEventListener('securitypolicyviolation', (e) => ((window as any).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));

  const fonts = await json('/api/fonts?q=inter');
  check('font search answers', Array.isArray(fonts.google ?? fonts.families ?? fonts) || typeof fonts === 'object', Object.keys(fonts).join(','));

  // A hostile file must not run anything when opened.
  const doc = new BogenDoc(new Y.Doc());
  doc.ensureFirstPage();
  const pageId = doc.getPages()[0]!.id;
  doc.insert(pageId, { type: 'frame', artboard: true, name: 'Hostile', style: { position: 'absolute', left: '0', top: '0', width: '600px', height: '400px', background: '#fff' }, children: [
    { type: 'svg', style: { width: '50px', height: '50px' }, svg: '<svg onload="window.__pwned=1"><img src=x onerror="window.__pwned=2"/></svg>' },
    { type: 'svg', style: { width: '50px', height: '50px' }, svg: '<svg><!--><img src=x onerror="window.__pwned=3">--></svg>' },
    { type: 'frame', tag: 'iframe', attrs: { srcdoc: '<script>parent.__pwned=4</script>' } },
    { type: 'embed', src: 'javascript:parent.__pwned=5' },
    { type: 'frame', tag: 'a', attrs: { href: 'javascript:window.__pwned=6', onmouseover: 'window.__pwned=7' }, style: { width: '30px', height: '30px' } },
    { type: 'text', tag: 'img', text: 'x', attrs: { src: 'x', onerror: 'window.__pwned=8' } },
    { type: 'text', text: '<img src=x onerror="window.__pwned=9">' },
  ] });
  const state = Y.encodeStateAsUpdate(doc.y);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(state.length);
  const file = Buffer.concat([Buffer.from('BOGEN\x01\n', 'latin1'), header, Buffer.from(state)]);
  const hostile = await (await fetch(`${base}/api/files/import`, { method: 'POST', headers: { 'X-Bogen-Filename': 'hostile.bogen' }, body: file })).json() as { id: string };
  await page.goto(`${base}/#/file/${hostile.id}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-bogen-id], .bogen-world', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.mouse.move(300, 300);
  check('hostile file ran nothing', (await page.evaluate(() => (window as any).__pwned)) === undefined);
  check('hostile file still opens and lists layers', (await page.content()).includes('Hostile'));
  check('no CSP violations from the app itself', ((await page.evaluate(() => (window as any).__csp)) ?? []).length === 0, JSON.stringify(await page.evaluate(() => (window as any).__csp)));
  await page.screenshot({ path: join(out, 'hostile.png') });

  // Home screen, then a new design that the agent draws while the editor watches.
  const { id } = await json('/api/files', { name: 'Harbour' });
  await page.goto(`${base}/#/file/${id}`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.bogen-world', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));

  if (withAgent) {
    const runners = await json('/api/runners');
    check('claude runner found', runners.some((r: any) => r.id === 'claude' && r.available), JSON.stringify(runners));
    const events: any[] = [];
    await page.evaluate(() => {
      (window as any).__seen = 0;
      new MutationObserver(() => { (window as any).__seen = document.querySelectorAll('.bogen-world *').length; }).observe(document.body, { subtree: true, childList: true });
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/events`);
    socket.onmessage = (m) => events.push(JSON.parse(String(m.data)));
    await new Promise((r) => (socket.onopen = r));
    const prompt = 'Design one desktop landing page for Harbour, a fictional tide-table app for small-boat sailors. Use one artboard 1440 wide with a hero, three concrete features with real-sounding tide data, and a footer. Pick a distinctive palette and a serif headline font. Create colour tokens first. Check it once with a screenshot, fix what is wrong, then stop.';
    const run = await json('/api/runs', { fileId: id, nodeIds: [], prompt, runner: 'claude', model: 'sonnet' }).catch((e) => ({ error: String(e) }));
    check('run started', Boolean(run.runId), JSON.stringify(run).slice(0, 200));
    const started = Date.now();
    let shot = 0;
    while (run.runId && Date.now() - started < 420000) {
      if (events.some((e) => e.t === 'agent' && e.runId === run.runId && (e.kind === 'done' || e.kind === 'error'))) break;
      await new Promise((r) => setTimeout(r, 15000));
      if (shot < 2) await page.screenshot({ path: join(out, `agent-live-${shot++}.png`) });
    }
    const final = events.filter((e) => e.t === 'agent' && e.runId === run.runId).at(-1);
    check('agent finished', final?.kind === 'done', String(JSON.stringify(final)).slice(0, 300));
    const tools = events.filter((e) => e.t === 'activity').map((e) => e.tool);
    console.log('tools used:', [...new Set(tools)].join(', '), 'calls', tools.length, 'seconds', Math.round((Date.now() - started) / 1000));
    check('editor saw the layers live', (await page.evaluate(() => (window as any).__seen)) > 10, String(await page.evaluate(() => (window as any).__seen)));
    socket.close();
    await new Promise((r) => setTimeout(r, 1000));
    await page.keyboard.press('Escape');
    await page.keyboard.down('Shift');
    await page.keyboard.press('1');
    await page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: join(out, 'agent-final.png') });
    const families = await page.$$eval('.bogen-world h1, .bogen-world p', (els) => els.slice(0, 40).map((e) => getComputedStyle(e as Element).fontFamily.split(',')[0]!.replace(/"/g, '')));
    const rendered = await page.evaluate(async (list) => {
      await document.fonts.ready;
      return list.filter((f) => !document.fonts.check(`16px "${f}"`) || ![...document.fonts].some((x) => x.family.replace(/"/g, '') === f && x.status === 'loaded'));
    }, [...new Set(families)].filter((f) => !/^(serif|sans-serif|monospace|system-ui)$/.test(f)));
    check('the fonts the design names are really loaded on the canvas', rendered.length === 0, `${[...new Set(families)].join(', ')}; missing: ${rendered.join(', ')}`);
    const rows = await page.$$eval('[data-testid="layer-row"]', (e) => e.map((x) => x.getAttribute('data-name') ?? ''));
    const iHeader = rows.findIndex((n) => /^(Header|Hero)/i.test(n));
    const iFooter = rows.findIndex((n) => /^Footer/i.test(n));
    check('the layer list reads top of page first', iHeader < 0 || iFooter < 0 || iHeader < iFooter, `${rows.slice(0, 6).join(' / ')}`);

    const exported = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: id, nodeIds: [], format: 'png', scale: 1 }) });
    check('page exported', exported.ok, `${exported.status}`);
    if (exported.ok) writeFileSync(join(out, 'agent-export.png'), Buffer.from(await exported.arrayBuffer()));
  }
  check('no page errors', problems.length === 0, problems.slice(0, 5).join(' | '));
} finally {
  await browser.close();
  server.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
