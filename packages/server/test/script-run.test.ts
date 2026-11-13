import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** script_run through MCP: the examples from its description, dry runs, undo, and what a script must not get past. */
describe('script_run', () => {
  let h: Harness;
  let client: Client;
  beforeAll(async () => {
    h = await startServer();
    client = await connectAgent(h.base, 'claude');
  });
  afterAll(async () => {
    await client.close();
    await h.cleanup();
  });

  const fail = async (args: Record<string, unknown>) => {
    const raw = await callRaw(client, 'script_run', args);
    expect(raw.isError, raw.content[0]?.text).toBe(true);
    return JSON.parse(raw.content[0]!.text!) as Record<string, any>;
  };

  async function freshFile(name: string) {
    const file = await call(client, 'file_create', { name });
    await call(client, 'file_open', { file_id: file.id });
    const board = await call(client, 'artboard_create', { name: 'Pricing', width: 1200 });
    await call(client, 'tokens_set', { tokens: [{ name: 'accent', kind: 'color', value: '#b4410c' }, { name: 'on-accent', kind: 'color', value: '#ffffff' }] });
    const written = await call(client, 'html_write', { target_id: board.id, html: '<section style="display:flex;gap:16px"><button style="background:#000;color:#fff">Buy</button><button style="background:#333;color:#fff">Try</button><a href="/more">More</a></section>' });
    return { file, board, section: written.ids[0] as string };
  }

  const tree = async (id: string, file_id?: string) => JSON.stringify(await call(client, 'layer_get', { node_id: id, ...(file_id ? { file_id } : {}) }));

  it('is listed with a description that teaches it', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'script_run')!;
    expect(tool.description).toMatch(/bogen\.find/);
    expect(tool.description).toMatch(/agent_undo/);
    expect(tool.description).toMatch(/dry_run/);
    expect(tool.annotations?.openWorldHint).toBe(false);
  });

  it('renames in bulk and binds every button colour to tokens, as one undo step', async () => {
    const { section } = await freshFile('Bulk');
    const before = await tree(section);
    const out = await call(client, 'script_run', { code: `
      const buttons = bogen.find({ tag: "button" });
      buttons.forEach((b, i) => bogen.rename(b, "Button / " + (i + 1)));
      bogen.bind(buttons, { backgroundColor: "accent", color: "on-accent" });
      return buttons.map((b) => b.id);
    ` });
    expect(out).toMatchObject({ ok: true, applied: true });
    const ids = out.result as string[];
    expect(ids).toHaveLength(2);
    for (const [i, id] of ids.entries()) {
      const layer = await call(client, 'layer_get', { node_id: id });
      expect(layer.name).toBe(`Button / ${i + 1}`);
      expect(layer.style.backgroundColor).toBe('var(--accent)');
      expect(layer.style.color).toBe('var(--on-accent)');
    }
    expect(out.changes.map((c: any) => c.op)).toEqual(['rename', 'rename', 'bind']);
    // One agent_undo takes the whole script back.
    const undo = await call(client, 'agent_undo');
    expect(undo.undone).toBe(true);
    expect(await tree(section)).toBe(before);
  });

  it('builds a grid of cards from data through the html sanitizer', async () => {
    const { board } = await freshFile('Grid');
    const out = await call(client, 'script_run', { code: `
      const plans = [{ name: "Solo", price: "9 EUR" }, { name: "Team", price: "29 EUR" }, { name: "Studio", price: "79 EUR" }];
      const [grid] = bogen.create('<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px"></div>', { parent: ${JSON.stringify(board.id)} });
      for (const p of plans) bogen.create("<article><h3>" + p.name + "</h3><p>" + p.price + " a month</p></article>", { parent: grid });
      return { grid, cards: bogen.children(grid).map((c) => bogen.children(c.id).map((t) => t.text)) };
    ` });
    expect(out).toMatchObject({ ok: true, applied: true });
    expect(out.result.cards).toEqual([['Solo', '9 EUR a month'], ['Team', '29 EUR a month'], ['Studio', '79 EUR a month']]);
    const grid = await call(client, 'layer_get', { node_id: out.result.grid });
    expect(grid.style.display).toBe('grid');
    expect(grid.children).toHaveLength(3);
  });

  it('plans in a dry run exactly what it applies, and applies nothing then', async () => {
    const { board, section } = await freshFile('Dry');
    const code = `
      bogen.setStyle(bogen.find({ selector: "section > button" }), { borderRadius: "8px" });
      bogen.setText(bogen.find({ text: "Buy" }).filter((l) => l.kind === "text"), "Buy now");
      bogen.setAttrs(bogen.find({ tag: "a" }), { href: "/pricing" });
      const [note] = bogen.create('<p style="color:#555">Prices include tax.</p>', { parent: ${JSON.stringify(board.id)} });
      bogen.move(note, { parent: ${JSON.stringify(section)}, index: 0 });
      return bogen.get(note).parent;
    `;
    const before = await tree(board.id);
    const dry = await call(client, 'script_run', { code, dry_run: true });
    expect(dry).toMatchObject({ ok: true, applied: false, dry_run: true, result: section });
    expect(await tree(board.id)).toBe(before);
    const applied = await call(client, 'script_run', { code });
    expect(applied).toMatchObject({ ok: true, applied: true, result: section });
    // The same operations on the same layers; only the id of the new paragraph differs between the two runs.
    const shape = (changes: any[]) => changes.map((c) => ({ ...c, ids: c.op === 'create' || c.op === 'move' ? c.ids.length : c.ids }));
    expect(shape(applied.changes)).toEqual(shape(dry.changes));
    expect(applied.layers_after).toBe(dry.layers_after);
    const kids = (await call(client, 'layer_get', { node_id: section })).children;
    expect(kids).toHaveLength(4);
    await call(client, 'agent_undo');
    expect(await tree(board.id)).toBe(before);
  });

  it('applies nothing when the script throws, and says where', async () => {
    const { section } = await freshFile('Throws');
    const before = await tree(section);
    const out = await fail({ code: 'bogen.setStyle(bogen.find({ tag: "button" }), { opacity: "0.5" });\nthrow new Error("changed my mind");' });
    expect(out).toMatchObject({ ok: false, applied: false });
    expect(out.error).toMatch(/changed my mind[\s\S]*script\.js:2/);
    expect(out.changes).toHaveLength(1);
    expect(await tree(section)).toBe(before);
  });

  it('applies nothing on a limit, and names it', async () => {
    const { section } = await freshFile('Limits');
    const before = await tree(section);
    const time = await fail({ code: 'bogen.setStyle(bogen.find({ tag: "button" }), { opacity: "0.5" }); for (;;) {}', timeout_ms: 300 });
    expect(time).toMatchObject({ ok: false, applied: false, limit: 'time' });
    const calls = await fail({ code: 'for (;;) bogen.get("nothing");' });
    expect(calls).toMatchObject({ limit: 'operations' });
    const output = await fail({ code: 'return "x".repeat(400000);' });
    expect(output).toMatchObject({ limit: 'output' });
    const grow = await fail({ code: 'let ids = bogen.find({ tag: "section" }); for (;;) ids = ids.concat(bogen.duplicate(ids.slice(0, 100)));' });
    expect(grow).toMatchObject({ limit: 'changes' });
    expect(await tree(section)).toBe(before);
  });

  it('applies nothing after the script caught its own out of memory or stack overflow error', async () => {
    const { section } = await freshFile('Caught limits');
    const before = await tree(section);
    for (const [limit, trap] of [
      ['memory', 'try { "x".repeat(1e9); } catch (e) {}'],
      ['stack', 'function f() { return f() + 1; } try { f(); } catch (e) {}'],
    ] as const) {
      for (const dry_run of [false, true]) {
        const out = await fail({ code: `bogen.setStyle(bogen.find({ tag: "button" }), { opacity: "0.5" }); ${trap} return "went on";`, dry_run });
        expect(out, `${limit} ${dry_run}`).toMatchObject({ ok: false, applied: false, limit });
      }
    }
    expect(await tree(section)).toBe(before);
  });

  it('cannot change a locked layer, even when the script catches the error', async () => {
    const { section } = await freshFile('Locked');
    const [buy] = (await call(client, 'layer_find', { tag: 'button' })).layers;
    await call(client, 'layer_set_flags', { node_ids: [section], locked: true });
    const before = await tree(buy.id);
    const out = await call(client, 'script_run', { code: `
      const errors = [];
      const b = bogen.find({ tag: "button" })[0];
      for (const attempt of [
        () => bogen.setStyle(b, { color: "red" }), () => bogen.setText(bogen.children(b.id)[0] ?? b, "x"), () => bogen.rename(b, "x"),
        () => bogen.setAttrs(b, { "aria-label": "x" }), () => bogen.remove(b), () => bogen.move(b, { index: 0 }),
        () => bogen.bind(b, { color: "accent" }), () => bogen.create("<p>x</p>", { parent: b.id }),
      ]) { try { attempt(); errors.push("allowed"); } catch (e) { errors.push(/locked/.test(e.message) ? "locked" : e.message); } }
      return errors;
    ` });
    expect(out.result).toEqual(Array(8).fill('locked'));
    expect(out.applied).toBe(false);
    expect(await tree(buy.id)).toBe(before);
    await call(client, 'layer_set_flags', { node_ids: [section], locked: false });
  });

  it('sends created HTML through the sanitizer: no scripts, handlers or script URLs', async () => {
    const { board } = await freshFile('Inject');
    const out = await call(client, 'script_run', { code: `
      const ids = bogen.create('<div><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://evil.example"></iframe><p style="background:url(javascript:alert(4))">t</p></div>', { parent: ${JSON.stringify(board.id)} });
      return ids;
    ` });
    expect(out.ok).toBe(true);
    const markup = JSON.stringify(await call(client, 'layer_tree', { node_id: board.id, depth: 6 })) + JSON.stringify(await Promise.all((await call(client, 'layer_find', { within: board.id, limit: 100 })).layers.map((l: any) => call(client, 'layer_get', { node_id: l.id }))));
    expect(markup).not.toMatch(/alert|onerror|javascript:/i);
    // Setting a handler or a script URL afterwards is refused too.
    const attr = await call(client, 'script_run', { code: `
      const a = bogen.find({ tag: "a" })[0] ?? bogen.find({ kind: "text" })[0];
      const out = [];
      for (const attrs of [{ onclick: "alert(1)" }, { href: "javascript:alert(1)" }]) { try { bogen.setAttrs(a, attrs); out.push("set"); } catch (e) { out.push("refused"); } }
      try { bogen.setStyle(a, { background: "url(javascript:alert(1))" }); out.push("set"); } catch (e) { out.push("refused"); }
      return out;
    ` });
    expect(attr.result).toEqual(['refused', 'refused', 'refused']);
  });

  it('refuses in strict brand mode what would break the brand, in a dry run too', async () => {
    const { file, section } = await freshFile('Brand');
    const { id } = await call(client, 'brand_create', { name: 'Flat' });
    await call(client, 'brand_update', { brand_id: id, confirmed: true, fields: { gradients: 'none', strict: true } });
    await call(client, 'brand_link', { brand_id: id, file_id: file.id });
    await call(client, 'file_open', { file_id: file.id });
    const before = await tree(section);
    const code = 'bogen.setStyle(bogen.find({ tag: "button" }), { backgroundImage: "linear-gradient(90deg, #f00, #00f)" }); return "done";';
    for (const dry_run of [true, false]) {
      const out = await fail({ code, dry_run });
      expect(out).toMatchObject({ ok: false, applied: false, brand: 'Flat' });
      expect(out.error).toMatch(/strict mode/);
    }
    expect(await tree(section)).toBe(before);
    // What keeps to the brand still goes through.
    expect((await call(client, 'script_run', { code: 'bogen.setStyle(bogen.find({ tag: "button" }), { borderRadius: "0px" });' })).applied).toBe(true);
  });

  it('reaches only the one file: other files, other pages ids and unknown layers are refused', async () => {
    const other = await freshFile('Other');
    const { section } = await freshFile('Mine');
    const out = await call(client, 'script_run', { code: `
      const tries = [];
      for (const attempt of [
        () => bogen.get(${JSON.stringify(other.section)}),
        () => bogen.setStyle(${JSON.stringify(other.section)}, { color: "red" }),
        () => bogen.create("<p>x</p>", { parent: ${JSON.stringify(other.file.pages[0].id)} }),
        () => bogen.children(${JSON.stringify(other.board.id)}),
      ]) { try { tries.push(JSON.stringify(attempt()) ?? "undefined"); } catch (e) { tries.push("refused"); } }
      return { tries, pages: bogen.pages().length, all: bogen.find({}).every((l) => l.page === bogen.pages()[0].id) };
    ` });
    expect(out.result).toEqual({ tries: ['null', 'refused', 'refused', 'refused'], pages: 1, all: true });
    expect(await tree(other.section, other.file.id)).not.toMatch(/red/);
    expect(section).toBeTruthy();
  });

  it('keeps to an open revision: the original is refused, the copy changes', async () => {
    // A session of its own, as a revision binds the session that started it.
    const agent = await connectAgent(h.base, 'claude');
    try {
      const file = await call(agent, 'file_create', { name: 'Revision' });
      await call(agent, 'file_open', { file_id: file.id });
      const board = await call(agent, 'artboard_create', { name: 'Home', width: 800 });
      const section = (await call(agent, 'html_write', { target_id: board.id, html: '<section style="display:flex;gap:8px"><p>One</p><p>Two</p></section>' })).ids[0] as string;
      const rev = await call(agent, 'revision_start', { intent: 'revise', name: 'Second pass', node_ids: [board.id] });
      const before = JSON.stringify(await call(agent, 'layer_get', { node_id: section }));
      // A dry run refuses what the real run refuses, with the same words.
      const errors: string[] = [];
      for (const dry_run of [true, false]) {
        const raw = await callRaw(agent, 'script_run', { code: `bogen.setStyle(${JSON.stringify(section)}, { gap: "40px" });`, dry_run });
        expect(raw.isError, `dry_run ${dry_run}`).toBe(true);
        const body = JSON.parse(raw.content[0]!.text!);
        expect(body).toMatchObject({ ok: false, applied: false, error: expect.stringMatching(/revision/) });
        errors.push(body.error);
      }
      expect(errors[0]).toBe(errors[1]);
      const tokens = await callRaw(agent, 'script_run', { code: 'bogen.setStyle(bogen.find({ tag: "section" }), { color: "red" }); return 1;', dry_run: true });
      expect(tokens.isError).toBe(true);
      expect((await callRaw(agent, 'script_run', { code: `bogen.get(${JSON.stringify(section)}); return 1;`, dry_run: true })).isError).toBe(false);
      expect(JSON.stringify(await call(agent, 'layer_get', { node_id: section }))).toBe(before);
      const copy = rev.artboards[0].layers[section] as string;
      expect(copy).toBeTruthy();
      expect((await call(agent, 'script_run', { code: `bogen.setStyle(${JSON.stringify(copy)}, { gap: "40px" });`, dry_run: true })).ok).toBe(true);
      expect((await call(agent, 'script_run', { code: `bogen.setStyle(${JSON.stringify(copy)}, { gap: "40px" });` })).applied).toBe(true);
      expect((await call(agent, 'layer_get', { node_id: copy })).style.gap).toBe('40px');
    } finally {
      await agent.close();
    }
  });

  it('refuses in a dry run, as on apply, when the file was switched to another branch since the agent started', async () => {
    // Sessions of their own, as a branch binds the session that made it. One builds the file and later checks out a
    // branch; the other starts on main by reading.
    const builder = await connectAgent(h.base, 'claude');
    const agent = await connectAgent(h.base, 'codex');
    try {
      const file = await call(builder, 'file_create', { name: 'Branch pin' });
      await call(builder, 'file_open', { file_id: file.id });
      const board = await call(builder, 'artboard_create', { name: 'Home', width: 800 });
      const section = (await call(builder, 'html_write', { target_id: board.id, html: '<section style="display:flex"><button>Buy</button></section>' })).ids[0] as string;
      await call(agent, 'file_open', { file_id: file.id });
      expect((await call(agent, 'script_run', { code: 'return bogen.pages().length;', dry_run: true })).result).toBe(1);
      await call(builder, 'design_branch_create', { name: 'Warmer' });
      const before = JSON.stringify(await call(agent, 'layer_get', { node_id: section }));
      const errors: string[] = [];
      for (const dry_run of [true, false]) {
        const raw = await callRaw(agent, 'script_run', { code: 'bogen.setStyle(bogen.find({ tag: "button" }), { opacity: "0.5" });', dry_run });
        expect(raw.isError, `dry_run ${dry_run}`).toBe(true);
        const out = JSON.parse(raw.content[0]!.text!);
        expect(out, `dry_run ${dry_run}`).toMatchObject({ ok: false, applied: false, error: expect.stringMatching(/switched to "Warmer"/) });
        errors.push(out.error);
      }
      expect(errors[0]).toBe(errors[1]);
      expect(JSON.stringify(await call(agent, 'layer_get', { node_id: section }))).toBe(before);
    } finally {
      await agent.close();
      await builder.close();
    }
  });

  it('runs side by side for two agents, each with its own undo step', async () => {
    const { file, section } = await freshFile('Two agents');
    const other = await connectAgent(h.base, 'codex');
    try {
      await call(other, 'file_open', { file_id: file.id });
      const [mine, theirs] = await Promise.all([
        call(client, 'script_run', { code: 'for (let i = 0; i < 200; i++) bogen.get("x"); bogen.rename(bogen.find({ tag: "button" })[0], "Mine"); return 1;' }),
        call(other, 'script_run', { code: 'bogen.rename(bogen.find({ tag: "a" })[0], "Theirs"); return 2;' }),
      ]);
      expect([mine.result, theirs.result, mine.applied, theirs.applied]).toEqual([1, 2, true, true]);
      await call(client, 'agent_undo');
      const names = (await call(client, 'layer_find', { within: section })).layers.map((l: any) => l.name);
      expect(names).toContain('Theirs');
      expect(names).not.toContain('Mine');
    } finally {
      await other.close();
    }
  });

  it('drops prototype keys from what a script sends, so nothing of the server is polluted', async () => {
    const { section } = await freshFile('Pollution');
    const out = await call(client, 'script_run', { code: `
      const evil = JSON.parse('{"__proto__": {"polluted": "yes", "color": "red"}, "constructor": {"prototype": {"polluted": "yes"}}}');
      const b = bogen.find({ tag: "button" })[0];
      const tries = [];
      for (const attempt of [() => bogen.setStyle(b, evil), () => bogen.setAttrs(b, evil), () => bogen.bind(b, evil), () => bogen.find(evil), () => bogen.create("<p>x</p>", evil)]) {
        try { attempt(); tries.push("ran"); } catch (e) { tries.push("refused"); }
      }
      return { tries, style: bogen.get(b.id).style, polluted: ({}).polluted ?? null };
    `, dry_run: true });
    expect(out.result.polluted).toBeNull();
    expect(out.result.style.color).toBe('#fff');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).color).toBeUndefined();
    expect(await tree(section)).not.toMatch(/polluted/);
  });

  it('does not let a script run another tool, or a script', async () => {
    await freshFile('Tools');
    const out = await call(client, 'script_run', { code: `
      const names = Object.keys(bogen);
      let viaCall = "none";
      try { bogen.find.call(null, { tool: "file_list" }); } catch (e) { viaCall = "refused"; }
      return { names, viaCall, hidden: typeof __bogen_call };
    ` });
    expect(out.result.names.sort()).toEqual(['bind', 'children', 'components', 'create', 'duplicate', 'find', 'get', 'move', 'pages', 'remove', 'rename', 'setAttrs', 'setStyle', 'setText', 'tokens']);
    expect(out.result.viaCall).toBe('refused');
    expect(out.result.hidden).toBe('undefined');
  });

  it('reads tokens and components, and finds by selector, kind and style', async () => {
    const { board } = await freshFile('Reads');
    await call(client, 'html_write', { target_id: board.id, html: '<div style="padding:8px;border:1px solid #ddd"><span>Card</span></div>' });
    const [card] = (await call(client, 'layer_find', { style: { padding: '8px' } })).layers;
    await call(client, 'component_create', { node_ids: [card.id], name: 'Card' });
    const out = await call(client, 'script_run', { code: `
      return {
        tokens: bogen.tokens().map((t) => t.name).sort(),
        components: bogen.components().map((c) => c.name),
        firstButton: bogen.find({ selector: "section > button:first-child" }).map((l) => l.tag),
        texts: bogen.find({ kind: "text" }).length > 0,
        black: bogen.find({ style: { background: "#000" } }).length,
      };
    ` });
    expect(out.result).toMatchObject({ tokens: ['accent', 'on-accent'], components: ['Card'], firstButton: ['button'], texts: true, black: 1 });
    expect(out.applied).toBe(false);
    // Matching runs on the server's thread: a bad selector is an error, and nested :has is refused before it costs.
    const bad = await call(client, 'script_run', { code: `
      const out = [];
      for (const selector of ["button[", "*:has(*:has(*))"]) { try { bogen.find({ selector }); out.push("ran"); } catch (e) { out.push(e.message); } }
      return out;
    ` });
    expect(bad.result[0]).toMatch(/does not parse/);
    expect(bad.result[1]).toMatch(/:has\(\) once/);
  });
});
