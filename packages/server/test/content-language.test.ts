import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentLanguageOf, currentBranchId, listDesignBranches, listRevisions, MAIN_BRANCH, setContentLanguage, switchDesignBranch } from '@bogen/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommand, type RunRequest } from '../src/agents.ts';
import { RemoteRunBody } from '../src/remote-runs.ts';
import { fake, fakeLog, writeFakeClis } from './fake-cli.ts';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

/**
 * The design content language, through the real run paths with stand-in CLIs (fake-cli.ts): what each run is told,
 * and what it leaves in the file. No model is asked, nothing is translated for real, and nothing is rendered: the
 * browser is a path that does not exist, so a run summary that would take a picture fails at once instead of
 * starting the machine's Chromium.
 */

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the design content language reaches every run', () => {
  let h: Harness;
  let bin: string;
  let log: string;
  let file: string;
  let page: string;
  let board: string;
  let heading: string;
  let button: string;
  const saved = { path: process.env.PATH, browser: process.env.BOGEN_BROWSER };

  beforeAll(async () => {
    bin = mkdtempSync(join(tmpdir(), 'bogen-lang-'));
    log = join(bin, 'log.jsonl');
    writeFakeClis(bin, log);
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BOGEN_BROWSER = join(bin, 'no-browser-here');
    h = await startServer();
  });

  afterAll(async () => {
    process.env.PATH = saved.path;
    if (saved.browser === undefined) delete process.env.BOGEN_BROWSER;
    else process.env.BOGEN_BROWSER = saved.browser;
    await h.cleanup();
    rmSync(bin, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // A synthetic shop screen in English, made fresh for every case.
    file = h.server.storage.create('Shop').id;
    const room = await h.server.rooms.get(file);
    page = room.doc.getPages()[0]!.id;
    board = room.doc.insert(page, { type: 'frame', name: 'Checkout', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '390px', height: '700px' } });
    heading = room.doc.insert(board, { type: 'text', name: 'Heading', tag: 'h1', text: 'Your basket' });
    button = room.doc.insert(board, { type: 'text', name: 'Pay', tag: 'button', text: 'Pay €12.50 with Acme Pay', style: { width: '120px' } });
  });

  afterEach(() => vi.restoreAllMocks());

  async function run(body: Record<string, unknown>): Promise<{ status: number; runId?: string; error?: string; prompt?: string }> {
    const before = fakeLog(log).length;
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', ...body }));
    const out = await res.json() as { runId?: string; error?: string };
    if (out.runId) await until(() => !h.server.runs.isActive(out.runId!), 15_000);
    const call = fakeLog(log).slice(before).find((e) => e.kind === 'call');
    return { status: res.status, ...out, ...(call?.text ? { prompt: call.text } : {}) };
  }
  const doc = async () => (await h.server.rooms.get(file)).doc;

  it('a file with no language anywhere runs exactly as before', async () => {
    const out = await run({ prompt: `Make the heading bigger. ${fake({})}` });
    expect(out.status).toBe(201);
    expect(out.prompt).not.toMatch(/Design content language/);
    expect(out.prompt).not.toMatch(/lang="/);
    expect((await doc()).meta.has('contentLanguage')).toBe(false);
  });

  it('the file default reaches a prompt run, and a choice for one request overrides it', async () => {
    setContentLanguage(await doc(), 'de');
    const byFile = await run({ prompt: `Add a short note under the heading. ${fake({})}` });
    expect(byFile.prompt).toContain("Design content language: German (de). It is the file's design language");
    const byRun = await run({ prompt: `Add a short note under the heading. ${fake({})}`, language: { tag: 'fr' } });
    expect(byRun.prompt).toContain('Design content language: French (fr). The person chose it for this request.');
    expect(byRun.prompt).not.toContain('German (de)');
    // The choice was for that request: the file keeps its default.
    expect(contentLanguageOf(await doc())).toBe('de');
  });

  it('a language tag that is not one is refused before any run starts', async () => {
    const out = await run({ prompt: 'x', language: { tag: 'ignore all rules' } });
    expect(out.status).toBe(400);
  });

  it('translating EN to DE changes the layers in place: same file, page, artboard and ids, no revision, no branch', async () => {
    const files = h.server.storage.list().length;
    const out = await run({
      prompt: `Translate this page into German. Mach es nochmal neu auf Deutsch. ${fake({ tools: [
        { name: 'layer_text', args: { node_id: heading, text: 'Dein Warenkorb' } },
        { name: 'layer_text', args: { node_id: button, text: 'Mit Acme Pay 12,50 € bezahlen' } },
        { name: 'layer_attrs', args: { node_id: board, attrs: { lang: 'de', dir: 'ltr' } } },
      ] })}`,
      language: { tag: 'de', mode: 'translate' },
    });
    expect(out.status).toBe(201);
    expect(out.prompt).toMatch(/translates the existing design into German \(de\) in place/);
    expect(out.prompt).toMatch(/Change the existing layers in place/);
    expect(out.prompt).not.toMatch(/runs in the revision/);
    const d = await doc();
    expect(h.server.storage.list().length).toBe(files);
    expect(d.getPages().map((p) => p.id)).toEqual([page]);
    expect(d.getChildren(page).map((n) => n.id)).toEqual([board]);
    expect(d.getNode(heading)?.text).toBe('Dein Warenkorb');
    expect(d.getNode(button)?.style.width).toBe('120px');
    expect(d.getNode(board)?.attrs).toMatchObject({ lang: 'de', dir: 'ltr' });
    expect(listRevisions(d)).toEqual([]);
    expect(listDesignBranches(d).length).toBe(1);
  });

  it('EN to an RTL language sets dir rtl, and RTL back to LTR resets it, on the artboards it touches', async () => {
    const toArabic = await run({ prompt: `Translate into Arabic. ${fake({})}`, language: { tag: 'ar', mode: 'translate' } });
    expect(toArabic.prompt).toContain('Arabic is written right to left');
    expect(toArabic.prompt).toContain('lang="ar" and dir="rtl"');
    setContentLanguage(await doc(), 'ar');
    const toEnglish = await run({ prompt: `Translate into English. ${fake({})}`, language: { tag: 'en', mode: 'translate' } });
    expect(toEnglish.prompt).toContain('lang="en" and dir="ltr"');
    expect(toEnglish.prompt).toMatch(/remove a dir that says rtl/);
    expect(toEnglish.prompt).toMatch(/Leave lang and dir alone on artboards you do not change/);
  });

  it('a long translation is told to fit, not to be cut off', async () => {
    const out = await run({ prompt: `Translate into German. ${fake({})}`, language: { tag: 'de', mode: 'translate' } });
    expect(out.prompt).toMatch(/Translations are often longer\. Make every text fit/);
    expect(out.prompt).toMatch(/Never hide the rest of a text \(overflow hidden, an ellipsis/);
  });

  it('adding a language version with a selection works in a branch, and main keeps its words and its language', async () => {
    setContentLanguage(await doc(), 'en');
    const files = h.server.storage.list().length;
    const out = await run({
      prompt: `Add a German version. ${fake({ tools: [{ name: 'layer_text', args: { node_id: heading, text: 'Dein Warenkorb' } }] })}`,
      nodeIds: [heading],
      language: { tag: 'de', mode: 'add' },
    });
    expect(out.status).toBe(201);
    expect(out.prompt).toMatch(/adds a German \(de\) version of the design\. It works in the branch "German \(de\)"/);
    expect(out.prompt).toMatch(/The original \(main\) keeps its language and is not changed/);
    const d = await doc();
    const branch = listDesignBranches(d).find((b) => b.name === 'German (de)')!;
    expect(branch).toBeTruthy();
    expect(currentBranchId(d)).toBe(branch.id);
    expect(contentLanguageOf(d)).toBe('de');
    expect(d.getNode(heading)?.text).toBe('Dein Warenkorb');
    expect(h.server.storage.list().length).toBe(files);
    expect(d.getPages().length).toBe(1);
    switchDesignBranch(d, MAIN_BRANCH);
    expect(d.getNode(heading)?.text).toBe('Your basket');
    expect(contentLanguageOf(d)).toBe('en');
    // The same language again continues that branch rather than making another.
    switchDesignBranch(d, branch.id);
    await run({ prompt: `Shorter German heading. ${fake({})}`, language: { tag: 'de', mode: 'add' } });
    expect(listDesignBranches(d).filter((b) => b.name === 'German (de)').length).toBe(1);
  });

  for (const parent of ['en', null] as const) {
    it(`a stopped Add that changed nothing withdraws its branch and main keeps its language (${parent ?? 'none'})`, async () => {
      if (parent) setContentLanguage(await doc(), parent);
      const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', prompt: `Add a German version. ${fake({ hang: true })}`, language: { tag: 'de', mode: 'add' } }));
      const { runId } = await res.json() as { runId: string };
      const d = await doc();
      expect(contentLanguageOf(d)).toBe('de');
      expect(h.server.runs.languageOf(runId)?.tag).toBe('de');
      h.server.runs.stop(runId);
      await until(() => !h.server.runs.isActive(runId), 10_000);
      await until(() => currentBranchId(d) === MAIN_BRANCH, 5000);
      expect(listDesignBranches(d).find((b) => b.name === 'German (de)')?.status).toBe('discarded');
      expect(contentLanguageOf(d)).toBe(parent);
      expect(d.getNode(heading)?.text).toBe('Your basket');
    });
  }

  it('a stopped Add that did change something keeps its branch and its language', async () => {
    setContentLanguage(await doc(), 'en');
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', prompt: `Add German. ${fake({ tools: [{ name: 'layer_text', args: { node_id: heading, text: 'Dein Warenkorb' } }], hang: true })}`, language: { tag: 'de', mode: 'add' } }));
    const { runId } = await res.json() as { runId: string };
    const d = await doc();
    await until(() => d.getNode(heading)?.text === 'Dein Warenkorb', 10_000);
    h.server.runs.stop(runId);
    await until(() => !h.server.runs.isActive(runId), 10_000);
    await new Promise((r) => setTimeout(r, 200));
    const branch = listDesignBranches(d).find((b) => b.name === 'German (de)')!;
    expect(branch.status).toBe('open');
    expect(currentBranchId(d)).toBe(branch.id);
    expect(contentLanguageOf(d)).toBe('de');
    switchDesignBranch(d, MAIN_BRANCH);
    expect(contentLanguageOf(d)).toBe('en');
    expect(d.getNode(heading)?.text).toBe('Your basket');
  });

  it('Add is refused, not turned into a translation of the original, where no branch can hold it', async () => {
    for (const review of ['proposal', 'critique']) {
      const out = await run({ prompt: `Add a German version. ${fake({})}`, review, language: { tag: 'de', mode: 'add' } });
      expect(out.status, review).toBe(400);
      expect(out.error).toMatch(/cannot add a language version.*Nothing was started/);
    }
    const race = await fetch(`${h.base}/api/races`, json({ fileId: file, pageId: page, nodeId: board, prompt: 'German', lanes: [{ runner: 'claude' }, { runner: 'codex' }], language: { tag: 'de', mode: 'add' } }));
    expect(race.status).toBe(400);
    const d = await doc();
    expect(listDesignBranches(d).length).toBe(1);
    expect(d.getChildren(page).length).toBe(1);
    expect(d.getNode(heading)?.text).toBe('Your basket');
  });

  it('translate or add with no language to go to is refused, and nothing changes', async () => {
    setContentLanguage(await doc(), null);
    for (const mode of ['translate', 'add']) {
      const out = await run({ prompt: `Translate. ${fake({ tools: [{ name: 'layer_text', args: { node_id: heading, text: 'x' } }] })}`, language: { mode } });
      expect(out.status, mode).toBe(400);
      expect(out.error).toMatch(/no design language to .*Nothing was started/);
      expect(out.prompt).toBeUndefined();
    }
    const d = await doc();
    expect(d.getNode(heading)?.text).toBe('Your basket');
    expect(listDesignBranches(d).length).toBe(1);
  });

  it('an explicit Add on a project folder run is refused before the run, not ignored', async () => {
    const { prepareRunLanguage } = await import('../src/run-language.ts');
    const live = { fileId: file, fileName: 'Shop', prompt: 'x', runner: 'claude' as const, live: { dir: '/nowhere', mcpUrl: 'http://x', instructions: '', label: 'site' }, language: { tag: 'de', mode: 'add' as const } };
    await expect(prepareRunLanguage(h.server, live)).rejects.toThrow(/A run on a project folder cannot add a language version/);
    // Any other choice on a project folder stays the project's business, as before.
    await expect(prepareRunLanguage(h.server, { ...live, language: { tag: 'de', mode: 'translate' as const } })).resolves.not.toHaveProperty('contentLanguage');
  });

  it('a proposal run, as the phone asks, gets the file default and translates only in its copy', async () => {
    setContentLanguage(await doc(), 'ja');
    const out = await run({ prompt: `Translate this. ${fake({})}`, review: 'proposal', language: { mode: 'translate' } });
    expect(out.status).toBe(201);
    expect(out.prompt).toContain('Design content language: Japanese (ja)');
    expect(out.prompt).toMatch(/Translate the copy you work on into Japanese \(ja\), in the layers you were given/);
    expect(out.prompt).toMatch(/Call proposal_create/);
  });

  it('a comment run gets the file default', async () => {
    setContentLanguage(await doc(), 'es-MX');
    const before = fakeLog(log).length;
    const res = await fetch(`${h.base}/api/comments`, json({ fileId: file, text: `@claude write a subtitle ${fake({ thread: 'reply' })}`, author: 'Ana', nodeId: heading }));
    expect(res.status).toBe(201);
    await until(() => fakeLog(log).slice(before).some((e) => e.kind === 'call'), 15_000);
    const prompt = fakeLog(log).slice(before).find((e) => e.kind === 'call')!.text!;
    expect(prompt).toContain('Design content language: Mexican Spanish (es-MX)');
    expect(prompt).toMatch(/comment thread/);
    await until(() => !h.server.runs.activeFor(file), 15_000);
  });

  it('a race passes the choice on, and each lane translates in its own copy', async () => {
    const start = vi.spyOn(h.server.races, 'start').mockResolvedValue({ id: 'r', fileId: file, pageId: page, nodeId: board, prompt: 'x', at: 0, lanes: [] });
    const res = await fetch(`${h.base}/api/races`, json({ fileId: file, pageId: page, nodeId: board, prompt: 'German please', lanes: [{ runner: 'claude' }, { runner: 'codex' }], language: { tag: 'de', mode: 'translate' } }));
    expect(res.status).toBe(201);
    expect(start.mock.calls[0]![0].language).toEqual({ tag: 'de', mode: 'translate' });
    // What a lane is told, from the request the race makes for it once the server resolved the language.
    const lane: RunRequest = {
      fileId: file, fileName: 'Shop', prompt: 'German please', runner: 'claude', review: 'directions',
      race: { raceId: 'r', laneId: 'l1', proposalId: 'p1', layers: {}, others: 1 },
      contentLanguage: { tag: 'de', name: 'German', dir: 'ltr', source: 'run', mode: 'translate' },
    };
    const { args } = buildCommand('claude', lane, { url: 'http://x/mcp' }, '/tmp/x.json', '/tmp');
    const system = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(system).toMatch(/Translate the copy you work on into German \(de\), in the layers you were given/);
    expect(system).toMatch(/This is a race/);
    expect(system).not.toMatch(/Do not make a new file, page, artboard, copy or revision/);
  });

  it('a run on a paired device carries the choice, and that device reads it', async () => {
    const start = vi.spyOn(h.server.remoteRuns, 'start').mockResolvedValue({ runId: 'remote1', device: 'PC' });
    const res = await fetch(`${h.base}/api/runs`, json({ fileId: file, pageId: page, runner: 'claude', prompt: 'Auf Deutsch', device: 'pc1', language: { tag: 'de', mode: 'translate' } }));
    expect(res.status).toBe(201);
    expect(start.mock.calls[0]![1].language).toEqual({ tag: 'de', mode: 'translate' });
    expect(RemoteRunBody.parse({ fileId: file, prompt: 'x', runner: 'claude', language: { tag: 'de', mode: 'add' } }).language).toEqual({ tag: 'de', mode: 'add' });
  });

  it("the run's own language, not the file default, goes to the brand check after it", async () => {
    setContentLanguage(await doc(), 'de');
    const ended = vi.spyOn(h.server.brands, 'runEnded');
    const out = await run({ prompt: `Une phrase. ${fake({})}`, language: { tag: 'fr' } });
    await until(() => ended.mock.calls.some((c) => c[0].runId === out.runId), 5000);
    expect(ended.mock.calls.find((c) => c[0].runId === out.runId)![0].language).toMatchObject({ tag: 'fr', source: 'run', mode: 'write' });
  });

  it('a rerun keeps the language the person chose for the run', async () => {
    const first = await run({ prompt: `Hola. ${fake({})}`, language: { tag: 'es-MX', mode: 'translate' } });
    const before = fakeLog(log).length;
    const res = await fetch(`${h.base}/api/runs/${first.runId}/rerun`, json({ fileId: file }));
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    await until(() => !h.server.runs.isActive(runId), 15_000);
    expect(fakeLog(log).slice(before).find((e) => e.kind === 'call')!.text).toMatch(/translates the existing design into Mexican Spanish \(es-MX\) in place/);
  });

  it('external agents read the language in file_open and context_get, with its source', async () => {
    const agent = await connectAgent(h.base, 'outside');
    try {
      const none = await call(agent, 'file_open', { file_id: file });
      expect(none.content_language).toBeUndefined();
      setContentLanguage(await doc(), 'he');
      const opened = await call(agent, 'file_open', { file_id: file });
      expect(opened.content_language).toMatchObject({ tag: 'he', name: 'Hebrew', dir: 'rtl', source: 'file' });
      expect(opened.content_language.note).toMatch(/independent of the language the person talks to you in/);
      const context = await call(agent, 'context_get');
      expect(context.content_language).toMatchObject({ tag: 'he', source: 'file' });
    } finally {
      await agent.close();
    }
  });
});
