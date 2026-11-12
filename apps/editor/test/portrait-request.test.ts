import { describe, expect, it } from 'vitest';
import type { DisplayChoices, ThemeWallpaper, WallpaperStatus } from '../src/lib/agent-api.ts';
import { agentLabel, chooseAgent, IDLE, portraitNeed, portraitPrompt, portraitRequests, shapeRequest, PORTRAIT_TITLE, type PortraitDeps, type RunStart } from '../src/panels/portrait-request.ts';

const board = { id: 'b916', name: 'Portrait background · 9:16 · 2160 × 3840', width: 2160, height: 3840 };
const wallpaper = (status: WallpaperStatus, extra: Partial<ThemeWallpaper> = {}): ThemeWallpaper => ({
  aspect: '9:16', orientation: 'portrait', component: 'Wallpaper · portrait 9:16', board, status, reason: `It is ${status}.`, ...extra,
});
const choices: DisplayChoices = { presets: [{ id: 'portrait-1080x1920', label: 'Portrait 1080 × 1920', note: '', present: false }], monitors: [] };

describe('when Add 9:16 layout is offered', () => {
  it('for a desktop theme whose 9:16 composition is missing or not designed, and for one with no 9:16 shape yet', () => {
    for (const status of ['needs-design', 'mismatch', 'unverified', 'missing'] as const) expect(portraitNeed({ target: 'desktop', wallpapers: [wallpaper(status)] }).show).toBe(true);
    expect(portraitNeed({ target: 'desktop', wallpapers: [] })).toEqual({ show: true });
    // A 10:16 composition is another shape: 9:16 is still missing.
    expect(portraitNeed({ target: 'desktop', wallpapers: [wallpaper('composed', { aspect: '10:16' })] }).show).toBe(true);
  });

  it('not once the 9:16 layout is designed, and never for a mobile theme', () => {
    expect(portraitNeed({ target: 'desktop', wallpapers: [wallpaper('composed')] }).show).toBe(false);
    expect(portraitNeed({ target: 'desktop', wallpapers: [wallpaper('artwork')] }).show).toBe(false);
    expect(portraitNeed({ target: 'mobile', wallpapers: [] }).show).toBe(false);
  });

  it('adds the shape from a 9:16 monitor of this computer when there is one, else the 1080 x 1920 preset', () => {
    expect(shapeRequest(null)).toEqual({ preset: 'portrait-1080x1920' });
    const monitor = (name: string, width: number, height: number, present = false) => ({ name, label: name, width, height, usable: true, present });
    expect(shapeRequest({ ...choices, monitors: [monitor('DP-5', 2160, 3840)] })).toEqual({ monitor: 'DP-5' });
    expect(shapeRequest({ ...choices, monitors: [monitor('DP-5', 1200, 1920)] })).toEqual({ preset: 'portrait-1080x1920' });
    expect(shapeRequest({ ...choices, monitors: [monitor('DP-5', 2160, 3840, true)] })).toEqual({ preset: 'portrait-1080x1920' });
  });
});

describe('who is asked', () => {
  const both = [{ id: 'claude', available: true }, { id: 'codex', available: true }];
  it('the agent chosen in the prompt while it is here, else the one found first, as the prompt does', () => {
    expect(chooseAgent('codex', both)).toEqual({ ok: true, runner: 'codex' });
    expect(chooseAgent(null, both)).toEqual({ ok: true, runner: 'claude' });
    expect(chooseAgent(null, [{ id: 'claude', available: false }, { id: 'codex', available: true }])).toEqual({ ok: true, runner: 'codex' });
  });

  it('never swaps a chosen agent that is not here for another, and asks for a choice when there is none', () => {
    const gone = chooseAgent('codex', [{ id: 'claude', available: true }, { id: 'codex', available: false }]);
    expect(gone.ok).toBe(false);
    expect(chooseAgent('claude@phone1', both).ok).toBe(false);
    // Not even listed: still not swapped for the one that is.
    expect(chooseAgent('codex', [{ id: 'claude', available: true }]).ok).toBe(false);
    expect(chooseAgent(null, [{ id: 'claude', available: false }])).toEqual({ ok: false, why: 'No agent was found on this computer. Choose one in the prompt.' });
  });

  it('names the model and effort set for the prompt', () => {
    const settings = { runners: { claude: { prompt: { model: 'opus', effort: 'high' }, comment: {} } }, shareCursors: false };
    const catalogs = { claude: { id: 'claude', models: [{ id: 'opus', label: 'Opus' }], efforts: ['high'], cheap: {}, source: 'cli' as const } };
    expect(agentLabel('claude', settings, catalogs)).toBe('Claude Code · Opus · High');
    expect(agentLabel('codex', settings, catalogs)).toBe('Codex · CLI default');
  });
});

describe('what the agent is told', () => {
  const prompt = portraitPrompt({ theme: 'Wide Desk', board, component: 'Wallpaper · portrait 9:16', status: 'needs-design', reason: 'This is Bogen\'s placeholder.' });
  it('works on the existing board and component of this file, and makes nothing new', () => {
    expect(prompt).toContain('"Portrait background · 9:16 · 2160 × 3840" (id b916)');
    expect(prompt).toContain('"Wallpaper · portrait 9:16"');
    expect(prompt).toMatch(/Make no new file, page, board, copy or "Custom" variant/);
    expect(prompt).toMatch(/with its id/);
  });
  it('asks for a real composition from the theme, never a crop, stretch, rotation or generic rainbow', () => {
    expect(prompt).toMatch(/palette tokens/);
    expect(prompt).toMatch(/Never crop, stretch or rotate a landscape picture/);
    expect(prompt).toMatch(/no generic rainbow/);
  });
  it('leaves installing, applying and the person\'s threads alone, and needs no @-mention', () => {
    expect(prompt).toMatch(/Do not export, install or apply the theme/);
    expect(prompt).toMatch(/reply to, resolve or close comment threads/);
    expect(prompt).not.toMatch(/@claude|@codex/);
  });
  it('asks to make a missing component again under its own name', () => {
    expect(portraitPrompt({ theme: 'T', board, component: 'Wallpaper · portrait 9:16', status: 'missing' })).toMatch(/Make it again with exactly that name/);
  });
});

/** Stand-ins that record every call, in order. Nothing here runs an agent. */
function harness(over: Partial<PortraitDeps> = {}, state: { wallpapers: ThemeWallpaper[] } = { wallpapers: [wallpaper('needs-design')] }) {
  const calls: string[] = [];
  const runs: RunStart[] = [];
  let release: (v: { runId: string }) => void = () => {};
  const deps: PortraitDeps = {
    savedRunner: () => 'claude',
    fileBusy: async () => false,
    runners: async () => [{ id: 'claude', available: true }],
    runSettings: async () => null,
    checkpoint: async (_f, message) => { calls.push(`checkpoint:${message}`); },
    addDisplays: async (_f, add) => {
      calls.push(`add:${JSON.stringify(add)}`);
      state.wallpapers = [wallpaper('needs-design')];
      return { added: [{ width: 1080, height: 1920 }], skipped: [] };
    },
    displays: async () => ({ wallpapers: state.wallpapers, ...choices }),
    findBoard: () => undefined,
    pageOf: (id) => (id === board.id ? 'page1' : undefined),
    conversationId: () => 'c1',
    beforeStart: () => { calls.push('shown'); },
    startRun: (body) => {
      calls.push('start');
      runs.push(body);
      return new Promise((r) => { release = r; });
    },
    startFailed: (_f, message) => { calls.push(`failed:${message}`); },
    stopRun: async (runId) => { calls.push(`stop:${runId}`); },
    ...over,
  };
  const requests = portraitRequests(deps);
  return { requests, calls, runs, release: (runId: string) => release({ runId }), state };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const theme = (wallpapers: ThemeWallpaper[]) => ({ name: 'Wide Desk', target: 'desktop' as const, wallpapers });

describe('a click', () => {
  it('saves a checkpoint, then starts exactly one run on the existing 9:16 board; more clicks start nothing', async () => {
    const h = harness();
    const info = theme([wallpaper('needs-design')]);
    const first = h.requests.start('f1', info, choices);
    void h.requests.start('f1', info, choices);
    await tick();
    void h.requests.start('f1', info, choices);
    expect(h.requests.get('f1').at).toBe('starting');
    h.release('run1');
    await first;
    await h.requests.start('f1', info, choices);
    expect(h.calls).toEqual(['checkpoint:Before adding the 9:16 layout', 'shown', 'start']);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ fileId: 'f1', pageId: 'page1', nodeIds: ['b916'], title: PORTRAIT_TITLE, runner: 'claude', intent: 'edit', conversationId: 'c1' });
    expect(h.requests.get('f1')).toEqual({ at: 'running', runId: 'run1', agent: 'Claude Code' });
  });

  it('adds the 9:16 shape after the checkpoint when the theme has none, then asks for its new board', async () => {
    const h = harness({}, { wallpapers: [] });
    const done = h.requests.start('f1', theme([]), choices);
    await tick();
    h.release('run1');
    await done;
    expect(h.calls).toEqual(['checkpoint:Before adding the 9:16 layout', 'add:[{"preset":"portrait-1080x1920"}]', 'shown', 'start']);
    expect(h.runs[0]!.prompt).toContain('Bogen has just added the 1080 × 1920 display');
  });

  it('changes nothing and starts nothing while another run goes in the file', async () => {
    const h = harness({ fileBusy: async () => true });
    await h.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    expect(h.calls).toEqual([]);
    expect(h.requests.get('f1')).toEqual({ at: 'failed', error: 'A run is already going on this file. Wait for it to finish, or stop it.' });
  });

  it('asks for a choice in the prompt, with no checkpoint, when no agent can be asked', async () => {
    const h = harness({ runners: async () => [{ id: 'claude', available: false }] });
    await h.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    expect(h.calls).toEqual([]);
    expect(h.requests.get('f1').at).toBe('choose');
  });

  it('says so, and does not claim a run, when the server refuses it', async () => {
    const h = harness({ startRun: async () => { throw new Error('The claude CLI was not found on this machine.'); } });
    await h.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    expect(h.requests.get('f1')).toEqual({ at: 'failed', error: 'The claude CLI was not found on this machine.' });
    expect(h.calls.at(-1)).toBe('failed:The claude CLI was not found on this machine.');
  });

  it('starts nothing when the composition turns out designed already', async () => {
    const h = harness({}, { wallpapers: [wallpaper('composed')] });
    await h.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    expect(h.runs).toHaveLength(0);
    expect(h.requests.get('f1').at).toBe('idle');
  });
});

describe('the run', () => {
  async function running() {
    const h = harness();
    const done = h.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    await tick();
    h.release('run1');
    await done;
    return h;
  }

  it('ends with its own run only, as done, stopped or failed', async () => {
    const h = await running();
    h.requests.ended('f1', 'other', 'done');
    expect(h.requests.get('f1').at).toBe('running');
    h.requests.ended('f1', 'run1', 'done', 'Stopped.');
    expect(h.requests.get('f1')).toMatchObject({ at: 'ended', outcome: 'stopped' });
    const g = await running();
    g.requests.ended('f1', 'run1', 'error', 'Rate limited.');
    expect(g.requests.get('f1')).toMatchObject({ at: 'ended', outcome: 'failed', error: 'Rate limited.' });
  });

  it('is stopped through the run route, and a run that ends before its start is answered is still seen to end', async () => {
    const h = await running();
    await h.requests.stop('f1');
    expect(h.calls.at(-1)).toBe('stop:run1');

    const g = harness();
    const done = g.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    await tick();
    g.requests.ended('f1', 'run2', 'done');
    g.release('run2');
    await done;
    expect(g.requests.get('f1')).toMatchObject({ at: 'ended', runId: 'run2', outcome: 'done' });
  });
});

describe('the state React reads', () => {
  it('is the same object on every read until something changes, for a file never asked about too', async () => {
    const h = harness();
    // useSyncExternalStore re-renders forever if two reads of an unchanged store differ.
    expect(h.requests.get('never')).toBe(h.requests.get('never'));
    expect(h.requests.get('never')).toBe(IDLE);
    expect(Object.isFrozen(IDLE)).toBe(true);
    const done = h.requests.start('f1', theme([wallpaper('needs-design')]), choices);
    const starting = h.requests.get('f1');
    expect(h.requests.get('f1')).toBe(starting);
    await tick();
    h.release('run1');
    await done;
    const running = h.requests.get('f1');
    expect(running).not.toBe(starting);
    expect(h.requests.get('f1')).toBe(running);
  });

  it('tells its listeners only when it changes', async () => {
    const h = harness();
    let told = 0;
    const off = h.requests.subscribe(() => { told++; });
    h.requests.get('f1');
    h.requests.ended('f1', 'nothing', 'done');
    expect(told).toBe(0);
    off();
  });
});

describe('what is reused', () => {
  it('the existing 9:16 board of a composition of the wrong picture, without adding a shape', async () => {
    const mismatch = wallpaper('mismatch', { reason: 'A 16:9 picture fills it.' });
    const h = harness({}, { wallpapers: [mismatch] });
    const done = h.requests.start('f1', theme([mismatch]), choices);
    await tick();
    h.release('run1');
    await done;
    expect(h.calls.some((c) => c.startsWith('add:'))).toBe(false);
    expect(h.runs[0]).toMatchObject({ nodeIds: ['b916'], pageId: 'page1' });
    expect(h.runs[0]!.prompt).toContain('A 16:9 picture fills it.');
  });

  it('nothing at all for 9:16 artwork or a composed 9:16 layout: no checkpoint, no shape, no run', async () => {
    for (const status of ['artwork', 'composed'] as const) {
      const h = harness({}, { wallpapers: [wallpaper(status)] });
      await h.requests.start('f1', theme([wallpaper(status)]), choices);
      expect(h.calls).toEqual([]);
      expect(h.requests.get('f1')).toBe(IDLE);
    }
  });

  it('the board of a composition whose component is gone, found by its name', async () => {
    const gone = wallpaper('missing', { board: undefined });
    const h = harness({ findBoard: (prefix) => (prefix === 'Portrait background · 9:16' ? { id: 'b916', name: board.name } : undefined) }, { wallpapers: [gone] });
    const done = h.requests.start('f1', theme([gone]), choices);
    await tick();
    h.release('run1');
    await done;
    expect(h.calls.some((c) => c.startsWith('add:'))).toBe(false);
    expect(h.runs[0]!.nodeIds).toEqual(['b916']);
  });
});

describe('the agent last chosen', () => {
  it('is not swapped for another when it is not here: nothing is saved, added or run', async () => {
    const h = harness({ savedRunner: () => 'codex', runners: async () => [{ id: 'claude', available: true }, { id: 'codex', available: false }] });
    expect((await h.requests.preview()).ok).toBe(false);
    await h.requests.start('f1', theme([]), choices);
    expect(h.calls).toEqual([]);
    expect(h.requests.get('f1')).toEqual({ at: 'choose', why: 'Codex is not available on this computer. Choose another agent in the prompt.' });
  });
});
