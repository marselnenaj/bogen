/**
 * What the chat gained this round, through the real editor, a real server in a temporary BOGEN_HOME, stand-in CLIs
 * and secure-chromium with its sandbox on (craft-harness.ts launch()):
 *
 * - Propose with copies, a range and aspects, and the brief the run gets; Directions with the split of a page;
 * - a run's trace downloads from the chat;
 * - / lists the playbooks and adds one as a skill, @ mentions a layer and the run gets its id;
 * - Save these decisions as a skill drafts a section, the person reviews it in the skill editor and saves it;
 * - the chat's branch in a linked repository, ready to push, then merged and the chat closed;
 * - in the review inbox, client comments picked and sent to one run.
 *
 * Deterministic: no provider is called, nothing leaves the machine.
 *
 *   (cd apps/editor && npx vite build --outDir <dir>)
 *   BOGEN_EDITOR_DIR=<dir> node --import tsx apps/editor/test/e2e/chat-extras.ts
 *
 * Screenshots go to the folder printed at the end (or $BOGEN_SHOTS).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { importHtml, type NewNode } from '@bogen/core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { linkFileToProject } from '../../../../packages/server/src/http/code-routes.ts';
import { createCommit } from '../../../../packages/server/src/history-ops.ts';
import { writeFakeClis } from '../../../../packages/server/test/fake-cli.ts';
import { makeRepoFixture } from '../../../../packages/server/test/repo-fixture.ts';
import { freshPage, launch } from './craft-harness.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-chat-extras-'));
const shots = process.env.BOGEN_SHOTS ?? join(root, 'shots');
const bin = join(root, 'bin');
const codexBin = join(root, 'codex-bin');
for (const d of [shots, bin, codexBin]) mkdirSync(d, { recursive: true });
const log = join(root, 'cli.log');
writeFakeClis(bin, log);
// The repository, with a stand-in codex that edits its files through the file tools of a pull request run.
const fx = makeRepoFixture({ 'package.json': '{"name":"summer-site","private":true,"dependencies":{"react":"^19"}}', 'src/Hero.tsx': "export function Hero() {\n  return <h1 style={{ color: '#111111' }}>Simple pricing</h1>;\n}\n" }, root);
copyFileSync(join(fx.bin, 'codex'), join(codexBin, 'codex'));
copyFileSync(join(fx.bin, 'package.json'), join(codexBin, 'package.json'));
process.env.PATH = `${codexBin}:${bin}:${process.env.PATH}`;

const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
server.runs.beforeFinish = undefined;
await server.listen();
const base = server.localUrl();
const browser = await launch(Number(new URL(base).port));

let passed = 0;
const failures: string[] = [];
const errors: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) {
    passed++;
    console.log(`pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      // Between states.
    }
    await wait(60);
  }
  return false;
}
const exists = (page: Page, sel: string) => page.$(sel).then(Boolean);
const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => '');
const value = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLTextAreaElement).value).catch(() => '');
const shot = async (page: Page, name: string, sel = '[data-testid="chat-slot"]') => {
  const el = await page.$(sel);
  if (el) await el.screenshot({ path: join(shots, `${name}.png`) });
  else await page.screenshot({ path: join(shots, `${name}.png`) });
};
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text?: string }).filter((c) => c.kind === 'call');

// A pricing page with three sections, a token, and the repository linked.
const entry = server.storage.create('Pricing');
const room = await server.rooms.get(entry.id);
const { doc } = room;
const pageId = doc.getPages()[0]!.id;
const board = doc.insert(pageId, { type: 'frame', tag: 'main', name: 'Pricing', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '960px', display: 'flex', flexDirection: 'column', backgroundColor: '#ffffff' } });
doc.invalidate();
doc.insertMany(board, importHtml('<section style="padding:48px;gap:24px;display:flex;flex-direction:column"><h1 style="font-size:40px;color:#111111;margin:0">Simple pricing</h1><p style="font-size:18px;color:#444444;margin:0">Three plans, no surprises.</p></section><section style="padding:32px;display:grid;gap:16px"><p style="margin:0">Starter, Team, Business</p></section><footer style="padding:24px"><p style="margin:0">Questions? Write to us.</p></footer>').nodes as NewNode[]);
doc.invalidate();
const [hero, plans, footer] = doc.getChildren(board);
doc.transact(() => { doc.updateFields(hero!.id, { name: 'Hero' }); doc.updateFields(plans!.id, { name: 'Plans' }); doc.updateFields(footer!.id, { name: 'Footer' }); });
doc.setToken('accent', 'color', '#b4410c');
const project = await server.codeProjects.link(fx.repo);
await linkFileToProject(server, entry.id, project, 'person:e2e');

async function open(intercept?: (req: HTTPRequest) => void): Promise<Page> {
  const page = await freshPage(browser);
  page.on('pageerror', (e) => errors.push(String(e)));
  if (intercept) {
    await page.setRequestInterception(true);
    page.on('request', intercept);
  }
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${base}/#/file/${entry.id}`);
  await page.waitForSelector('[data-testid="editor"]', { timeout: 20_000 });
  await page.waitForSelector('[data-testid="layer-row"]', { timeout: 20_000 });
  return page;
}
const chord = async (page: Page, key: string, mods: string[]) => {
  for (const m of mods) await page.keyboard.down(m as never);
  await page.keyboard.press(key as never);
  for (const m of mods.reverse()) await page.keyboard.up(m as never);
};
const review = (page: Page, mode: string) => page.select('select[data-testid="prompt-review"]', mode);
const typeIn = async (page: Page, words: string) => {
  await page.click('[data-testid="prompt-input"]');
  await page.keyboard.type(words);
};
const clearField = async (page: Page) => {
  await page.$eval('[data-testid="prompt-input"]', (e) => { (e as HTMLTextAreaElement).select(); });
  await page.keyboard.press('Backspace');
};
const runDone = (page: Page) => until(async () => !(await exists(page, '[data-testid="prompt-stop"]')) && (await exists(page, '[data-testid="prompt-send"]')), 20_000);

try {
  const page = await open();
  await chord(page, '3', ['Control', 'Alt']);
  await page.waitForSelector('[data-testid="chat-slot"][data-dock="docked"]', { timeout: 10_000 });
  // The artboard, selected: the subject of every message below.
  await page.click('[data-testid="layer-row"]');
  await until(async () => (await text(page, '[data-testid="chat-chip"]')).includes('Pricing'));

  // ---------------------------------------------------------------- Propose with copies, a range and aspects
  await review(page, 'proposal');
  check('Propose shows copies, range and aspects', await until(() => exists(page, '[data-testid="chat-vary"] [data-testid="chat-vary-count"]')));
  await page.click('[data-testid="chat-vary-more"]');
  await page.click('[data-testid="chat-vary-more"]');
  await page.click('[data-testid="chat-vary-range-refine"]');
  await page.click('[data-testid="chat-vary-layout"]');
  check('three copies', (await text(page, '[data-testid="chat-vary-count"]')) === '3');
  check('the hint says what varies and what is held', (await text(page, '[data-testid="chat-vary-hint"]')).startsWith('Varies: Layout. Holds: Colour, Type'), await text(page, '[data-testid="chat-vary-hint"]'));
  check('the target line counts the copies', (await text(page, '[data-testid="prompt-target"]')).includes('3 copies next to Pricing'), await text(page, '[data-testid="prompt-target"]'));
  await typeIn(page, 'Give the plans more room FAKE{"reply":"Made three copies."}');
  await shot(page, '1-propose-variations');
  await page.keyboard.press('Enter');
  await runDone(page);
  const proposeCall = calls().at(-1)?.text ?? '';
  check('the run is told count, range and aspects', proposeCall.includes('count 3, range "refine", vary ["layout"]') && proposeCall.includes('Hold fixed colour'), proposeCall.slice(-600));

  // ---------------------------------------------------------------- the trace of that run
  check('the finished run has a trace to download', await until(() => exists(page, '[data-testid="chat-trace"]'), 10_000));
  const trace = await page.$eval('[data-testid="chat-trace"]', async (a) => {
    const href = (a as HTMLAnchorElement).getAttribute('href')!;
    const res = await fetch(href);
    return { href, download: (a as HTMLAnchorElement).hasAttribute('download'), disposition: res.headers.get('content-disposition'), body: await res.json() as { format: string; prompt: { request: string } } };
  });
  check('it is the JSON trace of the run, as a file', trace.download && /attachment; filename="bogen-trace-/.test(trace.disposition ?? '') && trace.body.format === 'bogen-run-trace' && trace.body.prompt.request.includes('Give the plans more room'), trace);
  await page.hover('[data-testid="chat-trace"]');
  await shot(page, '6-run-trace');

  // ---------------------------------------------------------------- Directions, split over the sections
  await review(page, 'directions');
  await until(() => exists(page, '[data-testid="chat-vary-split"]'));
  await page.click('[data-testid="chat-vary-split"]');
  const lanes = await page.$$eval('[data-testid="prompt-lane"]', (l) => l.length);
  const splitText = await text(page, '[data-testid="chat-vary-hint"]');
  check('the split says which sections each run takes', lanes >= 2 && splitText.startsWith('Run 1: Hero') && splitText.includes(`Run ${lanes}:`), { lanes, splitText });
  await shot(page, '2-directions-split');
  await page.click('[data-testid="chat-vary-split"]');
  await review(page, 'direct');
  check('Change it has no variation controls', await until(async () => !(await exists(page, '[data-testid="chat-vary"]'))));

  // ---------------------------------------------------------------- / for a skill, @ for a layer
  await typeIn(page, '/web');
  check('/ lists the design playbooks', await until(async () => (await text(page, '[data-testid="chat-picker"]')).includes('Websites')));
  await shot(page, '3-slash-menu');
  await page.keyboard.press('Enter');
  check('Enter adds the skill as a chip and takes the word out', await until(async () => (await text(page, '[data-testid="chat-skill-chip"]')).includes('Skill: Websites')) && (await value(page, '[data-testid="prompt-input"]')) === '');
  await typeIn(page, 'Tighten @Her');
  check('@ lists layers, components and tokens that match', await until(async () => (await text(page, '[data-testid="chat-picker"]')).includes('Hero')));
  await shot(page, '4-mention-menu');
  await page.keyboard.press('Enter');
  check('the mention goes into the message', (await value(page, '[data-testid="prompt-input"]')) === 'Tighten @Hero ', await value(page, '[data-testid="prompt-input"]'));
  await page.keyboard.type('and use @acc');
  await until(async () => (await text(page, '[data-testid="chat-picker"]')).includes('--accent'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('FAKE{"reply":"Tightened."}');
  await page.keyboard.press('Enter');
  await runDone(page);
  const mentionCall = calls().at(-1)?.text ?? '';
  check('what was typed after a mention stays in order', (await text(page, '[data-testid="chat-you"]:last-of-type')).includes('use @--accent FAKE') || mentionCall.includes('use @--accent FAKE'), mentionCall.slice(-200));
  check('the run gets the skill and the ids of what was mentioned', mentionCall.includes('Design guidance already supplied for websites') && mentionCall.includes(`@Hero is layer ${hero!.id}`) && mentionCall.includes('@--accent is the token --accent'), mentionCall.slice(0, 400));

  // ---------------------------------------------------------------- save these decisions as a skill
  await typeIn(page, '/save');
  await until(async () => (await text(page, '[data-testid="chat-picker"]')).includes('Save these decisions as a skill'));
  await page.keyboard.press('Enter');
  check('the sheet drafts a section from the artboard', await until(async () => (await text(page, '[data-testid="chat-skill-preview"]')).startsWith('## Decisions from "Pricing"')));
  const preview = await text(page, '[data-testid="chat-skill-preview"]');
  check('with what it settled on', preview.includes('Type sizes, largest first: 40px, 18px'), preview);
  await shot(page, '5-save-skill', '[data-testid="chat-skill-sheet"]');
  await page.click('[data-testid="chat-skill-review"]');
  check('Review and edit opens the skill editor on the draft', await until(async () => (await value(page, '[data-knowledge-skill] textarea')).includes('## Decisions from "Pricing"')));
  check('nothing is saved yet', !server.knowledge.skill('websites').markdown.includes('Decisions from "Pricing"'));
  check('it drafts into the skill chosen with /', (await page.$eval('[data-testid="knowledge-skill-preview"]', (e) => e.textContent ?? '')).includes('bogen-websites'));
  await shot(page, '5b-skill-editor', '[data-testid="chat-skill-sheet"]');
  await page.click('[data-testid="knowledge-skill-save"]');
  check('the person saves it there, into the skill chosen with /', await until(() => server.knowledge.skill('websites').markdown.includes('## Decisions from "Pricing"')));
  await page.click('[data-testid="knowledge-skill-back"]');
  await until(async () => !(await exists(page, '[data-testid="chat-skill-sheet"]')));

  // ---------------------------------------------------------------- the chat's branch in the repository
  const conversationId = await page.evaluate((id) => localStorage.getItem(`bogen-conversation:${id}`), entry.id);
  await createCommit(server, entry.id, { message: 'Before red', author: 'e2e', authorKind: 'person' });
  const title = doc.descendants(board).find((n) => n.tag === 'h1')!;
  doc.transact(() => doc.updateStyle(title.id, { color: '#e11d48' }), 'person:e2e');
  const draft = await server.pulls.startDesign({ fileId: entry.id, source: { kind: 'selection', nodeIds: [board] }, runner: 'codex', pictures: false, title: 'Red pricing title', conversationId: conversationId! });
  check('the chat shows its branch, ready to push', await until(async () => (await page.$eval('[data-testid="chat-branch"]', (e) => e.getAttribute('data-status')).catch(() => '')) === 'ready', 30_000), await server.pulls.get(draft.id).then((d) => d.error));
  await shot(page, '8-branch-ready');
  const ready = await server.pulls.get(draft.id);
  await server.pulls.open(ready.id, ready.digest!);
  fx.git(['merge', '--quiet', '--no-ff', '-m', 'Merge it', ready.branch]);
  await server.pulls.checkMerges();
  check('once merged, the chat says it is closed', await until(async () => (await page.$eval('[data-testid="chat-branch"]', (e) => e.getAttribute('data-status')).catch(() => '')) === 'merged', 10_000));
  await shot(page, '8b-branch-merged');
  await page.click('[data-testid="chat-branch-new"]');
  check('New chat starts over', await until(async () => !(await exists(page, '[data-testid="chat-branch"]'))));
  await page.close();

  // ---------------------------------------------------------------- client comments to one run
  let sent: unknown = null;
  const inbox = [
    { id: 'a1b2c3d4e5f6', shareId: 's1', siteId: 'x', versionId: 'v', page: 0, name: 'Anna', text: 'The headline is too long.', at: Date.now() - 60_000, mentionsRemoved: false },
    { id: 'b1b2c3d4e5f6', shareId: 's1', siteId: 'x', versionId: 'v', page: 0, name: 'Jonas', text: 'Bigger button, please.', at: Date.now() - 30_000, mentionsRemoved: false },
    { id: 'c1b2c3d4e5f6', shareId: 's1', siteId: 'x', versionId: 'v', page: 0, name: 'Mia', text: 'Love the colours.', at: Date.now(), mentionsRemoved: false },
  ];
  const share = await open((req) => {
    const url = req.url();
    if (url.includes('/api/publish?fileId=') && req.method() === 'GET') {
      return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ sites: [], requests: [], shares: [{ id: 's1', siteId: 'x', versionId: 'v', label: 'Anna', createdAt: Date.now(), expiresAt: Date.now() + 86_400_000, views: 2, comments: true, state: 'active' }], inbox: sent ? inbox.slice(2) : inbox, listeners: { site: { on: false }, review: { on: true } }, funnelPolicy: [] }) });
    }
    if (url.endsWith('/api/shares/inbox/run') && req.method() === 'POST') {
      sent = JSON.parse(req.postData() ?? '{}');
      return void req.respond({ status: 201, contentType: 'application/json', body: JSON.stringify({ runId: 'r1', fileId: entry.id, threads: ['t1', 't2'] }) });
    }
    void req.continue();
  });
  await chord(share, 'p', ['Control']);
  await share.keyboard.type('Share for review');
  await share.keyboard.press('Enter');
  check('the inbox lists the client comments to pick', await until(async () => (await share.$$('[data-testid="client-comment-pick"]')).length === 3, 10_000));
  const picks = await share.$$('[data-testid="client-comment-pick"]');
  await picks[0]!.click();
  await picks[1]!.click();
  check('picking shows how many go to one run', await until(async () => (await text(share, '[data-testid="client-run-bar"]')).includes('2 selected')));
  await shot(share, '7-client-comments', '[role="dialog"]');
  await share.click('[data-testid="client-run-send"]');
  check('Send to one run sends the picked comments, from the editor', await until(() => Boolean(sent)) && JSON.stringify((sent as { ids: string[] }).ids) === JSON.stringify(['a1b2c3d4e5f6', 'b1b2c3d4e5f6']), sent);
  check('the bar goes once they are sent', await until(async () => !(await exists(share, '[data-testid="client-run-bar"]'))));
  await share.close();

  check('no page errors', errors.length === 0, errors);
} finally {
  await browser.close();
  await server.close();
  fx.cleanup();
}
console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${shots}`);
process.exit(failures.length ? 1 : 0);
