import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesignBranch, switchDesignBranch } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

// Stock themes as Omarchy ships them, in a temp $OMARCHY_PATH: only colors.toml, which is all a theme file needs.
const colors = (bg: string, accent: string) => `mode = "dark"\n\naccent = "${accent}"\nbackground = "${bg}"\nforeground = "#cdd6f4"\nred = "#f38ba8"\nyellow = "#f9e2af"\ngreen = "#a6e3a1"\nblue = "#89b4fa"\n`;
const STOCK: Record<string, string> = {
  'tokyo-night': colors('#1a1b26', '#7aa2f7'),
  catppuccin: colors('#1e1e2e', '#89b4fa'),
  everforest: colors('#2d353b', '#a7c080'),
  gruvbox: colors('#282828', '#d79921'),
  nord: colors('#2e3440', '#88c0d0'),
  kanagawa: colors('#1f1f28', '#7e9cd8'),
};

describe('theme projects: one file per logical theme', () => {
  let h: Harness;
  let root: string;
  let home: string;
  const saved = { HOME: process.env.HOME, OMARCHY_PATH: process.env.OMARCHY_PATH, PATH: process.env.PATH };
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${h.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() as any : null };
  };
  const count = () => h.server.storage.list().length;
  const themeFiles = (from: string) => h.server.storage.list().filter((e) => e.theme?.from === from);
  // A run going on a file, as far as the guards and the activity tap read one: what it was asked, and what it changed.
  const runOn = (fileId: string, intent: string) => ({ fileId, intent, touched: new Set<string>(), touchedFiles: new Map<string, Set<string>>() });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bogen-theme-projects-'));
    home = join(root, 'home');
    const omarchyPath = join(root, 'omarchy');
    const bin = join(root, 'bin');
    for (const [name, toml] of Object.entries(STOCK)) {
      mkdirSync(join(omarchyPath, 'themes', name), { recursive: true });
      writeFileSync(join(omarchyPath, 'themes', name, 'colors.toml'), toml);
    }
    mkdirSync(join(home, '.local', 'state', 'omarchy', 'current'), { recursive: true });
    writeFileSync(join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'), 'tokyo-night\n');
    mkdirSync(join(home, '.config', 'omarchy', 'themes'), { recursive: true });
    // Stand-ins: hyprctl reports one small screen; omarchy is never run here.
    mkdirSync(bin);
    writeFileSync(join(bin, 'hyprctl'), `#!/bin/sh\necho '[{"width":320,"height":180,"transform":0}]'\n`);
    writeFileSync(join(bin, 'omarchy'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'hyprctl'), 0o755);
    chmodSync(join(bin, 'omarchy'), 0o755);
    process.env.HOME = home;
    process.env.OMARCHY_PATH = omarchyPath;
    process.env.PATH = `${bin}:${saved.PATH}`;
    h = await startServer();
  });

  afterAll(async () => {
    await h?.cleanup();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('opens the same project again for the same stock theme, over HTTP and MCP, with and without its name', async () => {
    const first = await api('/api/omarchy/themes', { from: 'tokyo-night' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: 'Tokyo Night Custom', branch: { id: 'main' } });
    expect(first.body.project_id).toMatch(/^[0-9a-z]{10}$/);
    const after = count();
    const agent = await connectAgent(h.base, 'claude');
    const again = [
      await api('/api/omarchy/themes', { from: 'tokyo-night' }),
      await api('/api/omarchy/themes', { from: 'tokyo-night', name: 'Tokyo Night Custom' }),
      { status: 200, body: await call(agent, 'omarchy_theme_create', { from: 'tokyo-night' }) },
      { status: 200, body: await call(agent, 'omarchy_theme_create', { from: 'tokyo-night', name: 'Tokyo Night Custom' }) },
      { status: 200, body: await call(agent, 'omarchy_theme_create', { name: 'tokyo night custom' }) },
    ];
    for (const r of again) {
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ file_id: first.body.file_id, reused: true, branch: { id: 'main', name: 'Main' } });
      expect(r.body.next).toContain('design_branch_create');
    }
    expect(count()).toBe(after);
    expect(themeFiles('tokyo-night')).toHaveLength(1);
    await agent.close();
  });

  it('makes one file for concurrent identical requests, and leaves none behind when making one fails', async () => {
    const before = count();
    const a = await connectAgent(h.base, 'codex');
    const b = await connectAgent(h.base, 'claude');
    const results = await Promise.all([
      api('/api/omarchy/themes', { from: 'catppuccin' }),
      call(a, 'omarchy_theme_create', { from: 'catppuccin' }),
      api('/api/omarchy/themes', { from: 'catppuccin', name: 'Catppuccin Custom' }),
      call(b, 'omarchy_theme_create', { from: 'catppuccin' }),
      api('/api/omarchy/themes', { from: 'catppuccin' }),
    ]);
    expect(count()).toBe(before + 1);
    const ids = new Set(results.map((r: any) => (r.body ?? r).file_id));
    expect(ids.size).toBe(1);
    expect(themeFiles('catppuccin')).toHaveLength(1);

    // A failure after the file is made: the file goes again.
    const spy = vi.spyOn(h.server.rooms, 'get').mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    const failed = await api('/api/omarchy/themes', { from: 'catppuccin', new_project: true });
    spy.mockRestore();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(count()).toBe(before + 1);
    expect(themeFiles('catppuccin')).toHaveLength(1);
    await a.close();
    await b.close();
  });

  it('finds a renamed project by where it started, and keeps deliberate new themes and mobile apart', async () => {
    const made = await api('/api/omarchy/themes', { from: 'everforest' });
    const id = made.body.file_id;
    const renamed = await api(`/api/omarchy/theme/${id}`, { name: 'Forest Dusk' }, 'PATCH');
    expect(renamed.status).toBe(200);
    expect(h.server.storage.get(id)!.name).toBe('Forest Dusk · Omarchy theme');
    expect(h.server.storage.get(id)!.theme).toMatchObject({ name: 'Forest Dusk', from: 'everforest', project: made.body.project_id });
    expect((await api('/api/omarchy/themes', { from: 'everforest' })).body).toMatchObject({ file_id: id, reused: true, project_id: made.body.project_id });
    expect((await api('/api/omarchy/themes', { name: 'Forest Dusk' })).body).toMatchObject({ file_id: id, reused: true });

    // A separate theme on purpose: a new file, with a name of its own, and a project id of its own.
    const separate = await api('/api/omarchy/themes', { from: 'everforest', new_project: true });
    expect(separate.status).toBe(201);
    expect(separate.body.file_id).not.toBe(id);
    expect(separate.body.project_id).not.toBe(made.body.project_id);

    // Mobile is never the desktop theme, and the other way round.
    const before = count();
    const mobile = await api('/api/omarchy/themes', { from: 'everforest', target: 'mobile' });
    expect(mobile.status).toBe(201);
    expect(mobile.body).toMatchObject({ target: 'mobile', profile: 'komodo' });
    expect((await api('/api/omarchy/themes', { from: 'everforest', target: 'mobile' })).body).toMatchObject({ file_id: mobile.body.file_id, reused: true });
    expect(count()).toBe(before + 1);
  });

  it('asks for a choice among legacy duplicates and makes nothing', async () => {
    const dupes = [];
    for (const extra of [{ new_project: true }, { new_project: true }, { copy: true }]) {
      dupes.push((await api('/api/omarchy/themes', { from: 'gruvbox', name: 'Gruvbox Custom', ...extra })).body.file_id);
    }
    expect(new Set(dupes).size).toBe(3);
    const before = count();
    const agent = await connectAgent(h.base, 'claude');
    for (const args of [{ from: 'gruvbox' }, { from: 'gruvbox', name: 'Gruvbox Custom' }, { from: 'gruvbox', name: 'Gruvbox Remix' }]) {
      const out = await call(agent, 'omarchy_theme_create', args);
      expect(out.needs_choice).toBe(true);
      expect(out.candidates.map((c: any) => c.file_id).sort()).toEqual([...dupes].sort());
      expect(out.candidates[0]).toMatchObject({ from: 'gruvbox', target: 'desktop', branch: { current: 'main' } });
      expect(out.next).toContain('new_project');
    }
    const http = await api('/api/omarchy/themes', { from: 'gruvbox' });
    expect(http.status).toBe(409);
    expect(http.body.choose).toHaveLength(3);
    expect(http.body.message).toContain('Nothing was made');
    // An explicit file id continues that one.
    expect(await call(agent, 'omarchy_theme_create', { file_id: dupes[1] })).toMatchObject({ file_id: dupes[1], reused: true });
    expect(count()).toBe(before);

    // With no name and no source, themes of one's own are a choice too; Home's New theme says new_project. (Dusk is
    // made by a session not working on a theme: this one, on main in Gruvbox, would need new_project for it.)
    const unbound = await connectAgent(h.base, 'claude');
    const own = await call(unbound, 'omarchy_theme_create', { name: 'Dusk' });
    await unbound.close();
    expect(own.reused).toBeUndefined();
    const vague = await call(agent, 'omarchy_theme_create', {});
    expect(vague.needs_choice).toBe(true);
    expect(vague.candidates.map((c: any) => c.file_id)).toContain(own.file_id);
    const fresh = await api('/api/omarchy/themes', { new_project: true });
    expect(fresh.status).toBe(201);
    // A file that is not a theme is refused as file_id.
    const plain = await call(agent, 'file_create', { name: 'Not a theme' });
    expect((await api('/api/omarchy/themes', { file_id: plain.id })).status).toBe(422);
    await agent.close();
  });

  it('binds the session to a reused project, away from an unrelated current file', async () => {
    const agent = await connectAgent(h.base, 'claude');
    const unrelated = await call(agent, 'file_create', { name: 'Unrelated' });
    const theme = await call(agent, 'omarchy_theme_create', { from: 'tokyo-night' });
    expect(theme.reused).toBe(true);
    const pages = await call(agent, 'page_list', {});
    expect(pages.map((p: any) => p.name)).toEqual(['Theme']);
    await call(agent, 'tokens_set', { tokens: [{ name: 'probe-accent', kind: 'color', value: '#123456' }] });
    expect((await h.server.rooms.get(theme.file_id)).doc.getTokens().some((t) => t.name === 'probe-accent')).toBe(true);
    expect((await h.server.rooms.get(unrelated.id)).doc.getTokens().some((t) => t.name === 'probe-accent')).toBe(false);
    await agent.close();
  });

  it('lists drafts and groups duplicates from the index, without loading the theme files', async () => {
    // forest-dusk is installed and in use; nothing else is.
    mkdirSync(join(home, '.config', 'omarchy', 'themes', 'forest-dusk'), { recursive: true });
    writeFileSync(join(home, '.config', 'omarchy', 'themes', 'forest-dusk', 'colors.toml'), STOCK.everforest!);
    writeFileSync(join(home, '.local', 'state', 'omarchy', 'current', 'theme.name'), 'forest-dusk\n');
    for (const room of h.server.rooms.loaded()) await h.server.rooms.unload(room.id);
    // An entry from before the index is read lazily, without a room, and indexed for good.
    const legacy = themeFiles('gruvbox')[0]!.id;
    h.server.storage.update(legacy, { theme: undefined });
    expect(h.server.rooms.loaded()).toHaveLength(0);

    const { status, body } = await api('/api/omarchy/library');
    expect(status).toBe(200);
    expect(h.server.rooms.loaded()).toHaveLength(0);
    expect(h.server.storage.get(legacy)!.theme).toMatchObject({ name: 'Gruvbox Custom', from: 'gruvbox' });
    expect(body).toMatchObject({ onOmarchy: true, host: 'desktop', current: 'forest-dusk' });
    const byName = (n: string) => body.projects.filter((p: any) => p.name === n);
    expect(byName('Gruvbox Custom')).toHaveLength(3);
    expect(byName('Gruvbox Custom').every((p: any) => p.status === 'draft' && p.branch.current === 'main' && p.group)).toBe(true);
    expect(byName('Forest Dusk')[0]).toMatchObject({ status: 'in-use', from: 'everforest', target: 'desktop' });
    expect(body.projects.find((p: any) => p.target === 'mobile')).toMatchObject({ status: 'draft', profile: 'komodo' });
    const group = body.groups.find((g: any) => g.label.startsWith('Gruvbox Custom'));
    expect(group.file_ids.sort()).toEqual(byName('Gruvbox Custom').map((p: any) => p.file_id).sort());
    expect(body.groups.some((g: any) => g.file_ids.includes(byName('Forest Dusk')[0].file_id))).toBe(false);
    const installed = body.installed.find((t: any) => t.name === 'forest-dusk');
    expect(installed.project_file_ids).toEqual([byName('Forest Dusk')[0].file_id]);
    expect(body.installed.find((t: any) => t.name === 'gruvbox').project_file_ids).toHaveLength(3);

    const agent = await connectAgent(h.base, 'claude');
    const listed = await call(agent, 'omarchy_theme_projects', {});
    expect(listed.projects.map((p: any) => p.file_id).sort()).toEqual(body.projects.map((p: any) => p.file_id).sort());
    expect(listed.groups).toHaveLength(body.groups.length);
    expect(h.server.rooms.loaded()).toHaveLength(0);
    await agent.close();
  });

  it('keeps the project name and identity when a branch renames its theme', async () => {
    const made = await api('/api/omarchy/themes', { from: 'nord' });
    const id = made.body.file_id;
    const room = await h.server.rooms.get(id);
    const { branch } = createDesignBranch(room.doc, { name: 'Warmer', by: 'person', checkout: true }, 'person:editor');
    const patched = await api(`/api/omarchy/theme/${id}`, { name: 'Nord Warm' }, 'PATCH');
    expect(patched.body.theme).toMatchObject({ name: 'Nord Warm' });
    const entry = h.server.storage.get(id)!;
    expect(entry.name).toBe('Nord Custom · Omarchy theme');
    expect(entry.theme).toMatchObject({ name: 'Nord Custom', slug: 'nord-custom', from: 'nord', project: made.body.project_id, branch: branch.id, branchName: 'Warmer' });
    expect(entry.theme!.branches.map((b) => b.name)).toEqual(['Main', 'Warmer']);
    // Still the same project, on the branch that is checked out.
    expect((await api('/api/omarchy/themes', { from: 'nord' })).body).toMatchObject({ file_id: id, reused: true, name: 'Nord Warm', branch: { id: branch.id, name: 'Warmer' } });
    expect((await api('/api/omarchy/themes', { name: 'Nord Custom' })).body).toMatchObject({ file_id: id, reused: true });
    const lib = await api('/api/omarchy/library');
    expect(lib.body.projects.find((p: any) => p.file_id === id)).toMatchObject({ name: 'Nord Custom', branch: { current: branch.id, current_name: 'Warmer' } });
    // Back on main, main's name is the identity again.
    switchDesignBranch(room.doc, 'main', 'person:editor');
    expect(h.server.storage.get(id)!.theme).toMatchObject({ name: 'Nord Custom', branch: 'main' });
  });

  it('after three copies are brought together, an ordinary create reuses the chosen project and the library shows one theme', async () => {
    const copies: string[] = [];
    for (let i = 0; i < 3; i++) copies.push((await api('/api/omarchy/themes', { from: 'kanagawa', new_project: true })).body.file_id);
    // Legacy copies of one theme: same name, same starting theme, each its own design.
    for (const [i, id] of copies.entries()) {
      const room = await h.server.rooms.get(id);
      room.doc.setToken('omarchy-accent', 'color', `#00000${i}`);
      room.doc.meta.set('omarchyTheme', { ...(room.doc.meta.get('omarchyTheme') as object), name: 'Kanagawa Custom' });
      if (i === 1) room.doc.addThread({ pageId: room.doc.getPages()[0]!.id, x: 0, y: 0, author: 'Mara', text: 'This accent?' });
      await h.server.storage.flushDoc(id);
    }
    const age = () => { for (const id of copies) h.server.storage.update(id, { updatedAt: Date.now() - 3_600_000 }); };
    age();
    expect((await api('/api/omarchy/themes', { from: 'kanagawa' })).status).toBe(409);
    const [target, ...sources] = copies as [string, string, string];
    const before = (await api('/api/omarchy/library')).body;
    expect(before.groups.some((g: any) => copies.every((id) => g.file_ids.includes(id)))).toBe(true);

    const plan = await api('/api/omarchy/consolidate/plan', { target, sources });
    expect(plan.body.ok).toBe(true);
    // A comment written after the review makes the plan out of date.
    (await h.server.rooms.get(sources[0]!)).doc.addThread({ pageId: (await h.server.rooms.get(sources[0]!)).doc.getPages()[0]!.id, x: 1, y: 1, author: 'Mara', text: 'Late note' });
    age();
    expect((await api('/api/omarchy/consolidate', { target, sources, plan_hash: plan.body.plan_hash })).status).toBe(409);
    const fresh = await api('/api/omarchy/consolidate/plan', { target, sources });
    const files = count();
    const done = await api('/api/omarchy/consolidate', { target, sources, plan_hash: fresh.body.plan_hash });
    expect(done.status).toBe(200);
    expect(done.body.imported).toHaveLength(2);
    expect(count()).toBe(files);

    // Ordinary creation, with and without the name, now means the chosen project.
    for (const args of [{ from: 'kanagawa' }, { from: 'kanagawa', name: 'Kanagawa Custom' }]) {
      const again = await api('/api/omarchy/themes', args);
      expect(again.status).toBe(200);
      expect(again.body.file_id).toBe(target);
    }
    const agent = await connectAgent(h.base, 'codex-mcp-client');
    const viaMcp = await call(agent, 'omarchy_theme_create', { from: 'kanagawa' });
    expect(viaMcp.file_id).toBe(target);
    // A source asked for by id continues as the project it went into.
    const asked = await call(agent, 'omarchy_theme_create', { file_id: sources[0] });
    expect(asked.file_id).toBe(target);
    expect(asked.consolidated_from.file_id).toBe(sources[0]);
    // Agents cannot keep writing into a source; its work is in the branch.
    const refused = await callRaw(agent, 'tokens_set', { file_id: sources[1], tokens: [{ name: 'omarchy-accent', kind: 'color', value: '#ffffff' }] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/brought into the theme/);
    await agent.close();

    const after = (await api('/api/omarchy/library')).body;
    expect(after.projects.filter((p: any) => copies.includes(p.file_id)).map((p: any) => p.file_id)).toEqual([target]);
    const row = after.projects.find((p: any) => p.file_id === target);
    expect(row.merged_copies.map((c: any) => c.file_id).sort()).toEqual([...sources].sort());
    expect(row.branch.open.length).toBe(3);
    expect(after.groups.some((g: any) => g.file_ids.includes(target))).toBe(false);
    // The sources keep their design and History; a person's later edit shows, and brings in again without loss.
    const src = await h.server.rooms.get(sources[1]!);
    expect(src.doc.getTokens().find((t) => t.name === 'omarchy-accent')?.value).toBe('#000002');
    // Unchanged right after: the record it got is not a change of its design.
    expect((await api('/api/omarchy/library')).body.projects.find((p: any) => p.file_id === target).merged_copies.every((c: any) => !c.changed_after)).toBe(true);
    // An edit a moment later is seen by content, whatever the clocks say.
    src.doc.setToken('omarchy-accent', 'color', '#123456');
    const flagged = async () => (await api('/api/omarchy/library')).body.projects.find((p: any) => p.file_id === target).merged_copies.find((c: any) => c.file_id === sources[1]).changed_after === true;
    await vi.waitFor(async () => expect(await flagged()).toBe(true), { timeout: 5000, interval: 200 });
    // A comment alone counts too.
    const other = await h.server.rooms.get(sources[0]!);
    other.doc.addThread({ pageId: other.doc.getPages()[0]!.id, x: 2, y: 2, author: 'Mara', text: 'After' });
    await vi.waitFor(async () => expect((await api('/api/omarchy/library')).body.projects.find((p: any) => p.file_id === target).merged_copies.find((c: any) => c.file_id === sources[0]).changed_after).toBe(true), { timeout: 5000, interval: 200 });
    // Home reads GET /api/files: each theme file carries its compact index, the sources their consolidation record, so
    // the grid can list one project with its kept copies.
    const rest = (await api('/api/files')).body as any[];
    const restTarget = rest.find((f) => f.id === target);
    expect(restTarget.theme).toMatchObject({ name: 'Kanagawa Custom', from: 'kanagawa', target: 'desktop', branch: 'main' });
    expect(restTarget.theme.branches.length).toBe(3);
    for (const id of sources) expect(rest.find((f) => f.id === id).theme.consolidatedInto).toMatchObject({ fileId: target });
    const { canonicalFiles } = await import('../../../apps/editor/src/lib/theme-library.ts');
    const grid = canonicalFiles(rest).filter((f: any) => copies.includes(f.id));
    expect(grid.map((f: any) => f.id)).toEqual([target]);
    expect((grid[0] as any).keptCopies.map((f: any) => f.id).sort()).toEqual([...sources].sort());
    // file_list shows the project once, with its kept copies; on request the copies too.
    const lister = await connectAgent(h.base, 'claude');
    const listed = await call(lister, 'file_list', {});
    expect(listed.filter((f: any) => copies.includes(f.id)).map((f: any) => f.id)).toEqual([target]);
    expect(listed.find((f: any) => f.id === target).kept_copies.map((k: any) => k.id).sort()).toEqual([...sources].sort());
    expect((await call(lister, 'file_list', { include_copies: true })).filter((f: any) => copies.includes(f.id))).toHaveLength(3);
    await lister.close();
    h.server.storage.update(sources[1]!, { updatedAt: Date.now() - 3_600_000 });
    h.server.storage.update(target, { updatedAt: Date.now() - 3_600_000 });
    const replan = await api('/api/omarchy/consolidate/plan', { target, sources });
    // The first only has a new comment: its design is in its branch already, so only its threads come along.
    expect(replan.body.sources.map((x: any) => [x.file_id, x.action])).toEqual([[sources[0], 'comments'], [sources[1], 'import']]);
  });

  it('refuses to bring in a copy that has branches of its own', async () => {
    const a = (await api('/api/omarchy/themes', { from: 'kanagawa', name: 'Kanagawa Solo', new_project: true })).body.file_id;
    const b = (await api('/api/omarchy/themes', { from: 'kanagawa', name: 'Kanagawa Solo', new_project: true })).body.file_id;
    createDesignBranch((await h.server.rooms.get(b)).doc, { name: 'Own idea', by: 'person' });
    for (const id of [a, b]) h.server.storage.update(id, { updatedAt: Date.now() - 3_600_000 });
    const plan = await api('/api/omarchy/consolidate/plan', { target: a, sources: [b] });
    expect(plan.body.ok).toBe(false);
    expect(plan.body.problems.join(' ')).toMatch(/branches of its own/);
  });
  it('makes no new theme file from a bound run, a revision or a branch, under any name; reuse and explicit separate themes still work', async () => {
    const outside = await connectAgent(h.base, 'claude');
    const foo = await call(outside, 'omarchy_theme_create', { name: 'Foo' });
    expect(foo.reused).toBeUndefined();
    await outside.close();
    const before = count();
    // An edit run of Foo, as the server records one when the person asks to change it.
    const runs = (h.server.runs as unknown as { runs: Map<string, unknown> }).runs;
    for (const intent of ['edit', 'revise'] as const) {
      runs.set(`guard${intent}`, runOn(foo.file_id, intent));
      const run = await connectAgent(h.base, 'claude', { 'x-bogen-run': `guard${intent}`, 'x-bogen-file': foo.file_id });
      try {
        for (const args of [{ name: 'Foo v2' }, { name: 'Foo-v2', new_project: true }, { name: 'Foo copy', copy: true }]) {
          const refused = await callRaw(run, 'omarchy_theme_create', args);
          expect(refused.isError).toBe(true);
          expect(refused.content[0]!.text).toMatch(intent === 'edit' ? /asked to change existing work/ : /asked to redo existing work/);
          expect(refused.content[0]!.text).toContain('Nothing was made');
        }
        // The same theme is reopened, not refused.
        expect(await call(run, 'omarchy_theme_create', { name: 'Foo' })).toMatchObject({ file_id: foo.file_id, reused: true });
      } finally {
        await run.close();
        runs.delete(`guard${intent}`);
      }
    }
    expect(count()).toBe(before);

    // An outside session on a branch of Foo: no new file either, while Foo itself still opens.
    const branched = await connectAgent(h.base, 'claude');
    try {
      await call(branched, 'omarchy_theme_create', { file_id: foo.file_id });
      await call(branched, 'design_branch_create', { name: 'Warmer' });
      const refused = await callRaw(branched, 'omarchy_theme_create', { name: 'Foo-v2', new_project: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/works in a branch of its file/);
      expect(await call(branched, 'omarchy_theme_create', { name: 'Foo' })).toMatchObject({ file_id: foo.file_id, reused: true, branch: { name: 'Warmer' } });
      await call(branched, 'design_branch_switch', { branch_id: 'main' });
    } finally {
      await branched.close();
    }
    expect(count()).toBe(before);

    // On main, a session working on Foo makes another theme only when asked for a separate one.
    const onMain = await connectAgent(h.base, 'claude');
    try {
      await call(onMain, 'omarchy_theme_create', { file_id: foo.file_id });
      const vague = await callRaw(onMain, 'omarchy_theme_create', { name: 'Foo v2' });
      expect(vague.isError).toBe(true);
      expect(vague.content[0]!.text).toMatch(/is working on an Omarchy theme, Foo · Omarchy theme/);
      expect(vague.content[0]!.text).toContain('new_project: true');
      expect(count()).toBe(before);
      const separate = await call(onMain, 'omarchy_theme_create', { name: 'Foo v2', new_project: true });
      expect(separate.file_id).not.toBe(foo.file_id);
      expect(count()).toBe(before + 1);
    } finally {
      await onMain.close();
    }
    // An unbound session's first theme, and Home's deliberate New over HTTP, are made as before.
    const fresh = await connectAgent(h.base, 'claude');
    try {
      expect((await call(fresh, 'omarchy_theme_create', { name: 'Unbound Bar' })).reused).toBeUndefined();
    } finally {
      await fresh.close();
    }
    expect((await api('/api/omarchy/themes', { new_project: true })).status).toBe(201);
    expect(count()).toBe(before + 3);
  });
  it('lets an edit run of a page that is not a theme make its first theme, but not a second; a cold branch pin still refuses', async () => {
    const runs = (h.server.runs as unknown as { runs: Map<string, unknown> }).runs;
    const site = h.server.createFile('Landing page');
    runs.set('guardsite', runOn(site.id, 'edit'));
    const before = count();
    const run = await connectAgent(h.base, 'claude', { 'x-bogen-run': 'guardsite', 'x-bogen-file': site.id });
    try {
      const first = await call(run, 'omarchy_theme_create', { name: 'Edit Born Theme' });
      expect(first.reused).toBeUndefined();
      expect(count()).toBe(before + 1);
      // Bound to that theme now: a variant is refused, even as a separate project; the theme itself reopens.
      for (const args of [{ name: 'Edit Born Theme v2' }, { name: 'Edit Born Theme v2', new_project: true }]) {
        const refused = await callRaw(run, 'omarchy_theme_create', args);
        expect(refused.isError).toBe(true);
        expect(refused.content[0]!.text).toMatch(/asked to change existing work, an Omarchy theme/);
      }
      expect(await call(run, 'omarchy_theme_create', { name: 'Edit Born Theme' })).toMatchObject({ file_id: first.file_id, reused: true });
    } finally {
      await run.close();
      runs.delete('guardsite');
    }
    expect(count()).toBe(before + 1);

    // A session on a branch whose room was unloaded (large-file eviction) is still on that branch.
    const cold = await connectAgent(h.base, 'claude');
    try {
      const theme = await call(cold, 'omarchy_theme_create', { name: 'Cold Branch Theme' });
      await call(cold, 'design_branch_create', { name: 'Night' });
      const made = count();
      await h.server.rooms.unload(theme.file_id);
      expect(h.server.rooms.peek(theme.file_id)).toBeUndefined();
      for (const args of [{ name: 'Cold Branch Theme v2' }, { name: 'Cold Branch Theme v2', new_project: true }]) {
        const refused = await callRaw(cold, 'omarchy_theme_create', args);
        expect(refused.isError).toBe(true);
        expect(refused.content[0]!.text).toMatch(/works in a branch of its file/);
      }
      expect(count()).toBe(made);
      expect(await call(cold, 'omarchy_theme_create', { name: 'Cold Branch Theme' })).toMatchObject({ file_id: theme.file_id, reused: true, branch: { name: 'Night' } });
      await call(cold, 'design_branch_switch', { branch_id: 'main' });
    } finally {
      await cold.close();
    }
  });
  it('file_create keeps refusing with a cold room: theme and design branches, an edit-run theme, and a theme bound since', async () => {
    const runs = (h.server.runs as unknown as { runs: Map<string, unknown> }).runs;
    const refusedCreate = async (agent: Awaited<ReturnType<typeof connectAgent>>, pattern: RegExp) => {
      const before = count();
      const out = await callRaw(agent, 'file_create', { name: 'Neutral notes' });
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toMatch(pattern);
      expect(count()).toBe(before);
    };
    // A theme's branch, its room unloaded.
    const themed = await connectAgent(h.base, 'claude');
    try {
      const theme = await call(themed, 'omarchy_theme_create', { name: 'Cold File Theme' });
      await call(themed, 'design_branch_create', { name: 'Dusk' });
      await h.server.rooms.unload(theme.file_id);
      await refusedCreate(themed, /works in a branch of its file/);
    } finally {
      await themed.close();
    }
    // An ordinary design's branch, its room unloaded.
    const plain = await connectAgent(h.base, 'claude');
    try {
      const page = await call(plain, 'file_create', { name: 'Poster draft' });
      await call(plain, 'file_open', { file_id: page.id });
      await call(plain, 'design_branch_create', { name: 'Bolder' });
      await h.server.rooms.unload(page.id);
      await refusedCreate(plain, /works in a branch of its file/);
    } finally {
      await plain.close();
    }
    // An edit run of a theme whose room was unloaded: known from the index.
    const target = await (async () => { const a = await connectAgent(h.base, 'claude'); const t = await call(a, 'omarchy_theme_create', { name: 'Cold Edit Theme' }); await a.close(); return t; })();
    await h.server.rooms.unload(target.file_id);
    runs.set('coldedit', runOn(target.file_id, 'edit'));
    const edit = await connectAgent(h.base, 'claude', { 'x-bogen-run': 'coldedit' });
    try {
      expect(h.server.rooms.peek(target.file_id)).toBeUndefined();
      await refusedCreate(edit, /asked to change a theme/);
    } finally {
      await edit.close();
      runs.delete('coldedit');
    }
    // An edit run started on a plain page whose session has since made and bound a theme.
    const page = h.server.createFile('Plain run page');
    runs.set('plainrun', runOn(page.id, 'edit'));
    const mixed = await connectAgent(h.base, 'claude', { 'x-bogen-run': 'plainrun', 'x-bogen-file': page.id });
    try {
      const first = await call(mixed, 'omarchy_theme_create', { name: 'Bound Since Theme' });
      expect(first.reused).toBeUndefined();
      await refusedCreate(mixed, /asked to change a theme/);
    } finally {
      await mixed.close();
      runs.delete('plainrun');
    }
    // A session bound to nothing still makes files.
    const free = await connectAgent(h.base, 'claude');
    try {
      const before = count();
      expect((await call(free, 'file_create', { name: 'Fresh idea' })).id).toBeTruthy();
      expect(count()).toBe(before + 1);
    } finally {
      await free.close();
    }
  });
  it('keeps a session on its branch after someone else switched the file back to main, until its own file_open', async () => {
    const a = await connectAgent(h.base, 'claude');
    try {
      const theme = await call(a, 'omarchy_theme_create', { name: 'Pinned Theme' });
      await call(a, 'design_branch_create', { name: 'Alt' });
      // The person switches the document back to main in the editor; session A still holds its branch.
      expect((await api(`/api/files/${theme.file_id}/design-branches/main/switch`, { by: 'person' })).status).toBe(200);
      const before = count();
      for (const [tool, args] of [['file_create', { name: 'Neutral notes' }], ['omarchy_theme_create', { name: 'Pinned Theme v2' }], ['omarchy_theme_create', { name: 'Pinned Theme v3', new_project: true }]] as const) {
        const refused = await callRaw(a, tool, args);
        expect(refused.isError).toBe(true);
        expect(refused.content[0]!.text).toMatch(/works in a branch of its file/);
      }
      expect(count()).toBe(before);
      // Its own file_open takes what is checked out now (main): ordinary new designs are made again.
      await call(a, 'file_open', { file_id: theme.file_id });
      expect((await call(a, 'file_create', { name: 'Unrelated poster' })).id).toBeTruthy();
      expect(count()).toBe(before + 1);
    } finally {
      await a.close();
    }
  });
});
