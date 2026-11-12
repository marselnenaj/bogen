import { afterEach, describe, expect, it } from 'vitest';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** The edges of the brand loop: bad input, a deleted brand, a brand with one thing in it, a version with no change. */

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function start(): Promise<Harness> {
  const h = await startServer();
  harnesses.push(h);
  return h;
}

async function rest(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { 'Content-Type': 'application/json' }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

const errorOf = async (client: Awaited<ReturnType<typeof connectAgent>>, name: string, args: Record<string, unknown>) => {
  const out = await callRaw(client, name, args);
  expect(out.isError).toBe(true);
  return out.content[0]?.text ?? '';
};

const PALETTE = [
  { section: 'colors', name: 'Ink', role: 'text', value: '#101010', token: 'ink' },
  { section: 'colors', name: 'Paper', role: 'background', value: '#f8f6f0', token: 'paper' },
];

describe('brand_update says no instead of guessing', () => {
  it('refuses a value that is not one of the choices, and writes nothing of the call', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Strict input' });

    // Read leniently, kind "don't" would have become "do": the opposite of what was meant.
    const kind = await errorOf(client, 'brand_update', { brand_id: id, confirmed: true, items: [...PALETTE, { section: 'rules', text: 'Set anything in all caps.', kind: "don't", severity: 'hard' }] });
    expect(kind).toMatch(/Item 3, rules: kind must be one of "do", "dont"/);
    expect(kind).toMatch(/Nothing was changed/);
    expect((await call(client, 'brand_get', { brand_id: id, raw: true })).raw.colors).toEqual([]);

    expect(await errorOf(client, 'brand_update', { brand_id: id, items: [{ section: 'rules', text: 'Use sentence case.', severity: 'must' }] })).toMatch(/severity must be one of "hard", "soft"/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, items: [{ section: 'words', word: 'synergy', use: 'never' }] })).toMatch(/use must be one of "use", "avoid"/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, items: [{ section: 'rules', text: 'No gradients.', check: { type: 'no-gradients' } }] })).toMatch(/check is not one this brand can run/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, items: [{ section: 'colors', name: 'Broken', value: 'not a colour' }] })).toMatch(/Item 1: That is not a valid item for colors/);

    expect(await errorOf(client, 'brand_update', { brand_id: id, fields: { shadows: 'no' } })).toMatch(/shadows must be one of "any", "none", not "no"/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, fields: { minContrast: 'high' } })).toMatch(/minContrast must be a number/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, fields: { strict: 'yes' } })).toMatch(/strict must be true or false/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, fields: { colour: 'red' } })).toMatch(/There is no brand field "colour"/);
    const raw = (await call(client, 'brand_get', { brand_id: id, raw: true })).raw;
    expect(raw.fields.shadows).toBe('any');
    expect(raw.rules).toEqual([]);
    expect(raw.words).toEqual([]);
    await client.close();
  });

  it('refuses a pairing of colours the brand does not have, and takes one whose colours come in the same call', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Pairs' });
    // A pair like this was stored and then shown nowhere: not in the panel, the sheet or the check.
    expect(await errorOf(client, 'brand_update', { brand_id: id, confirmed: true, items: [{ section: 'pairings', fg: 'Ink', bg: 'Paper', verdict: 'allow' }] })).toMatch(/names a colour this brand does not have, "Ink"/);
    expect(await errorOf(client, 'brand_update', { brand_id: id, confirmed: true, items: [...PALETTE, { section: 'pairings', fg: 'Ink', bg: 'Paper', verdict: 'allowed' }] })).toMatch(/verdict must be one of "allow", "forbid"/);
    const out = await call(client, 'brand_update', { brand_id: id, confirmed: true, items: [...PALETTE, { section: 'pairings', fg: 'Ink', bg: 'paper', verdict: 'allow' }] });
    expect(out.summary_of_pairs).toEqual([expect.stringMatching(/^Ink on Paper: allow, /)]);
    await client.close();
  });

  it('answers with the fields as stored, and with what it could not delete', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Echo' });
    const added = await call(client, 'brand_update', { brand_id: id, confirmed: true, fields: { minContrast: '7', container: 1200, gradients: 'none', tone: '  Plain  ' }, items: PALETTE });
    expect(added.fields).toEqual({ minContrast: 7, container: 1200, gradients: 'none', tone: 'Plain' });
    const inkId = added.updated[0].id;
    const removed = await call(client, 'brand_update', { brand_id: id, delete_ids: [inkId, 'nothinghere'] });
    expect(removed.deleted).toEqual([inkId]);
    expect(removed.not_found).toEqual(['nothinghere']);
    expect(removed.fields).toBeUndefined();
    await client.close();
  });
});

describe('a field an agent proposed', () => {
  it('binds nobody until it is confirmed: not the check, not strict mode, not the brief, and not a version', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Fields' });
    await call(client, 'brand_update', { brand_id: id, confirmed: true, fields: { minContrast: 7 }, items: PALETTE });
    const file = await call(client, 'file_create', { name: 'Linked' });
    await call(client, 'brand_link', { brand_id: id, file_id: file.id });
    const board = await call(client, 'artboard_create', { name: 'A', width: 400, background: 'var(--paper)' });
    const gradient = '<div style="background:linear-gradient(#101010,#f8f6f0);height:40px"></div>';

    // Not told to by anyone: no gradients, strict mode on, and a contrast minimum low enough to pass anything.
    const proposed = await call(client, 'brand_update', { brand_id: id, fields: { gradients: 'none', strict: true, minContrast: 1, tone: 'Loud' } });
    expect(proposed.fields).toEqual({ gradients: 'none', strict: true, minContrast: 1, tone: 'Loud' });
    expect(proposed.suggestions).toBe(4);

    const written = await call(client, 'html_write', { target_id: board.id, html: gradient });
    expect(JSON.stringify(written.brand_warnings ?? {})).not.toMatch(/gradient/i);
    const loose = await call(client, 'brand_check', {});
    expect(loose.violations.filter((v: any) => /gradient/.test(v.rule))).toEqual([]);
    const got = await call(client, 'brand_get', { brand_id: id });
    expect(got.unconfirmed_suggestions).toBe(4);
    expect(got.brand).toMatchObject({ gradients: 'allowed', pairs: { min_contrast: 7 } });
    expect(got.brand.voice.tone).toBeUndefined();
    expect(got.rules).toContain('Text contrast at least 7:1.');
    expect(got.rules).toContain('Suggested, not binding until confirmed: minContrast 1.');
    expect(got.rules).toContain('Suggested, not binding until confirmed: gradients "none".');
    expect(got.rules).toContain('Suggested, not binding until confirmed: tone "Loud".');
    expect((await call(client, 'file_open', { file_id: file.id })).brand.summary).not.toMatch(/strict/);
    // The stored values are what the panel shows for review.
    expect((await call(client, 'brand_get', { brand_id: id, raw: true })).raw).toMatchObject({ fields: { gradients: 'none', strict: true, minContrast: 1 }, priorFields: { gradients: 'any', strict: false, minContrast: 7 } });

    // Publishing records what binds, and confirms nothing.
    await call(client, 'brand_publish', { brand_id: id });
    const pending = await call(client, 'brand_diff', { brand_id: id });
    expect(pending.changes.map((c: any) => c.id).sort()).toEqual(['gradients', 'minContrast', 'strict', 'tone']);
    expect((await call(client, 'brand_check', {})).violations.filter((v: any) => /gradient/.test(v.rule))).toEqual([]);

    // A person says yes: now it binds, and strict mode refuses the same write.
    expect((await call(client, 'brand_confirm', { brand_id: id, ids: ['gradients', 'strict'] })).suggestions).toBe(2);
    const bound = await call(client, 'brand_check', {});
    expect(bound.violations.some((v: any) => /gradient/.test(v.rule))).toBe(true);
    expect(await errorOf(client, 'html_write', { target_id: board.id, html: gradient })).toMatch(/strict mode/);
    const after = await call(client, 'brand_get', { brand_id: id });
    expect(after.brand).toMatchObject({ gradients: 'not allowed', pairs: { min_contrast: 7 } });
    await client.close();
  });
});

describe('a brand name', () => {
  it('is trimmed, and is never empty, from a tool or the panel', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Before' });
    expect(await errorOf(client, 'brand_rename', { brand_id: id, name: '   ' })).toMatch(/needs a name/);
    expect((await call(client, 'brand_rename', { brand_id: id, name: '  After  ' })).name).toBe('After');
    const listed = await call<any[]>(client, 'brand_list');
    expect(listed.map((b) => b.name)).toEqual(['After']);
    expect((await call(client, 'brand_get', { brand_id: id })).brand.name).toBe('After');
    expect((await rest(h.base, `/api/brands/${id}`, { method: 'PATCH', body: { name: '   ' } })).status).toBe(400);
    expect((await rest(h.base, `/api/brands/${id}`, { method: 'PATCH', body: { name: ' Third ' } })).body.name).toBe('Third');
    await client.close();
  });
});

describe('a file whose brand was deleted', () => {
  it('says so with the way out, can be unlinked or linked to another brand, and new files stop taking the default', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id: gone } = await call(client, 'brand_create', { name: 'Gone' });
    const { id: other } = await call(client, 'brand_create', { name: 'Other' });
    await call(client, 'brand_update', { brand_id: gone, confirmed: true, items: PALETTE });
    await call(client, 'brand_update', { brand_id: other, confirmed: true, items: PALETTE });
    await call(client, 'brand_default', { brand_id: gone });
    const file = await call(client, 'file_create', { name: 'Linked' });
    expect(file.brand.id).toBe(gone);
    const board = await call(client, 'artboard_create', { name: 'A', width: 400 });
    await call(client, 'html_write', { target_id: board.id, html: '<p style="color:var(--ink)">Hello</p>' });

    const deleted = await call(client, 'brand_delete', { brand_id: gone });
    expect(deleted).toMatchObject({ deleted: 'Gone', linked_files: 1, files: [{ id: file.id, name: 'Linked' }] });
    expect(deleted.next).toMatch(/brand_link/);
    // Deleting a brand no file links to has nothing to add.
    const { id: unused } = await call(client, 'brand_create', { name: 'Unused' });
    expect(await call(client, 'brand_delete', { brand_id: unused })).toEqual({ deleted: 'Unused', linked_files: 0 });

    const opened = await call(client, 'file_open', { file_id: file.id });
    expect(opened.brand).toMatchObject({ id: gone, missing: true });
    // Each tool that needs the brand names the same way out, rather than "no brand with id".
    for (const [tool, args] of [['brand_get', {}], ['brand_check', {}], ['brand_asset_use', { target_id: board.id }], ['brand_template_use', { template_id: 'anything' }], ['voice_check', {}], ['brand_book_get', {}]] as const) {
      const message = await errorOf(client, tool, args);
      expect(message, tool).toMatch(/not on this device/);
      expect(message, tool).toMatch(/brand_link/);
    }
    // The tokens the brand set stay, so the design still draws.
    expect((await call<any[]>(client, 'tokens_get')).find((t) => t.name === 'ink')?.value).toBe('#101010');
    // Another brand can be checked against without linking it.
    expect((await call(client, 'brand_check', { brand_id: other })).score).toBeGreaterThan(0);
    expect((await rest(h.base, `/api/files/${file.id}/brand`)).body.note.missing).toBe(true);
    expect((await rest(h.base, `/api/files/${file.id}/brand/check`, { method: 'POST', body: {} })).status).toBe(409);

    // The default went with the brand: a new file is linked to nothing.
    expect((await call(client, 'file_create', { name: 'After' })).brand).toBeUndefined();
    expect((await call<any[]>(client, 'brand_list')).map((b) => [b.name, b.isDefault])).toEqual([['Other', false]]);

    await call(client, 'brand_link', { brand_id: other, file_id: file.id });
    expect((await call(client, 'file_open', { file_id: file.id })).brand).toMatchObject({ id: other, name: 'Other' });
    await call(client, 'brand_link', { brand_id: null, file_id: file.id });
    expect((await call(client, 'file_open', { file_id: file.id })).brand).toBeUndefined();
    await client.close();
  });
});

describe('two brands and no default', () => {
  it('links nothing by itself, keeps each file with its own brand, and has one default at a time', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id: a } = await call(client, 'brand_create', { name: 'Client A' });
    const { id: b } = await call(client, 'brand_create', { name: 'Client B' });
    await call(client, 'brand_update', { brand_id: a, confirmed: true, items: [{ section: 'colors', name: 'Red', role: 'primary', value: '#cc0000', token: 'main' }] });
    await call(client, 'brand_update', { brand_id: b, confirmed: true, items: [{ section: 'colors', name: 'Blue', role: 'primary', value: '#0000cc', token: 'main' }] });
    const plain = await call(client, 'file_create', { name: 'Plain' });
    expect(plain.brand).toBeUndefined();
    expect(await errorOf(client, 'brand_get', {})).toMatch(/Which brand\? The current file links to none/);

    const fa = await call(client, 'file_create', { name: 'For A' });
    await call(client, 'brand_link', { brand_id: a, file_id: fa.id });
    const fb = await call(client, 'file_create', { name: 'For B' });
    await call(client, 'brand_link', { brand_id: b, file_id: fb.id });
    expect((await call<any[]>(client, 'tokens_get', { file_id: fa.id })).find((t) => t.name === 'main')?.value).toBe('#cc0000');
    expect((await call<any[]>(client, 'tokens_get', { file_id: fb.id })).find((t) => t.name === 'main')?.value).toBe('#0000cc');
    // Moving a file from one brand to the other takes the other's values.
    await call(client, 'brand_link', { brand_id: b, file_id: fa.id });
    expect((await call<any[]>(client, 'tokens_get', { file_id: fa.id })).find((t) => t.name === 'main')?.value).toBe('#0000cc');
    const listed = await call<any[]>(client, 'brand_list');
    expect(Object.fromEntries(listed.map((x) => [x.name, x.linkedFiles]))).toEqual({ 'Client A': 0, 'Client B': 2 });

    await call(client, 'brand_default', { brand_id: a });
    await call(client, 'brand_default', { brand_id: b });
    expect((await call<any[]>(client, 'brand_list')).filter((x) => x.isDefault).map((x) => x.name)).toEqual(['Client B']);
    await call(client, 'brand_default', { brand_id: null });
    expect((await call(client, 'file_create', { name: 'Still plain' })).brand).toBeUndefined();
    await client.close();
  });
});

describe('a brand with only a logo', () => {
  it('links, places its logo, checks without inventing violations, and a template lists what is missing', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Logo only' });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#123456"/></svg>';
    await call(client, 'brand_asset_add', { brand_id: id, kind: 'logo', name: 'Mark', data_base64: Buffer.from(svg).toString('base64'), mime_type: 'image/svg+xml', min_width: 48, confirmed: true });
    const file = await call(client, 'file_create', { name: 'With a logo' });
    const linked = await call(client, 'brand_link', { brand_id: id, file_id: file.id });
    expect(linked.tokens_set).toEqual([]);
    const board = await call(client, 'artboard_create', { name: 'A', width: 400 });
    await call(client, 'html_write', { target_id: board.id, html: '<p style="color:#123456;font-family:Georgia;font-size:17px">Any colour, any font</p>' });
    const placed = await call(client, 'brand_asset_use', { target_id: board.id, width: 20 });
    expect(placed).toMatchObject({ logo: 'Mark', width: 48, raised_to_minimum: 48 });

    const report = await call(client, 'brand_check', {});
    // Nothing is off a palette or a scale the brand does not have.
    expect(report.violations).toEqual([]);
    expect(report.not_checked.join(' ')).toMatch(/colours: the brand has none/);
    expect(report.not_checked.join(' ')).toMatch(/fonts: the brand has none/);
    expect((await call(client, 'brand_book_get', { brand_id: id })).readiness.foundationGaps).toEqual(['Positioning', 'Audience', 'Colour roles', 'Typography']);

    const made = await call(client, 'template_use', { template: 'brand-system', brand_id: id });
    expect(made.boards).toHaveLength(7);
    expect(made.gaps.join(' ')).toMatch(/No colours yet/);
    expect(made.gaps.join(' ')).not.toMatch(/No logo yet/);
    const guide = await fetch(`${h.base}/api/brands/${id}/guide.md`).then((r) => r.text());
    expect(guide).toContain('| Mark | any | 48px |');
    expect(guide).not.toContain('## Colour\n');
    await client.close();
  });
});

describe('publishing', () => {
  it('says how much changed since the version before, and when nothing did', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Versions' });
    const first = await call(client, 'brand_publish', { brand_id: id, note: 'Empty' });
    expect(first).toMatchObject({ version: 1 });
    expect(first.changes_since_previous).toBeUndefined();
    expect(first.note).toBeUndefined();
    const again = await call(client, 'brand_publish', { brand_id: id });
    expect(again).toMatchObject({ version: 2, changes_since_previous: 0 });
    expect(again.note).toMatch(/Nothing changed since version 1/);
    await call(client, 'brand_update', { brand_id: id, confirmed: true, items: PALETTE });
    const third = await call(client, 'brand_publish', { brand_id: id });
    expect(third).toMatchObject({ version: 3, changes_since_previous: 2 });
    expect(third.note).toBeUndefined();
    expect((await call(client, 'brand_diff', { brand_id: id, from: '1', to: '3' })).changes).toHaveLength(2);
    expect((await call(client, 'brand_diff', { brand_id: id })).changes).toEqual([]);
    expect(await errorOf(client, 'brand_diff', { brand_id: id, from: '9' })).toMatch(/No version "9"/);
    await client.close();
  });
});

describe('applying a brand', () => {
  it('says which files it passed over, and neither applies nor publishes when there is no file to carry it into', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'Apply' });
    await call(client, 'brand_update', { brand_id: id, confirmed: true, items: PALETTE });
    const other = await call(client, 'file_create', { name: 'Not linked' });

    const none = await call(client, 'brand_apply', { brand_id: id });
    expect(none).toMatchObject({ version: 0, files: [] });
    expect(none.note).toMatch(/No files link to this brand yet/);
    expect(await call(client, 'brand_versions', { brand_id: id })).toEqual([]);

    const linked = await call(client, 'file_create', { name: 'Linked' });
    await call(client, 'brand_link', { brand_id: id, file_id: linked.id });
    const wrong = await call(client, 'brand_apply', { brand_id: id, file_ids: [other.id, 'nopenope'] });
    expect(wrong.files).toEqual([]);
    expect(wrong.skipped).toEqual([{ file_id: other.id, why: 'This file is not linked to this brand.' }, { file_id: 'nopenope', why: 'There is no file with this id.' }]);
    expect(await call(client, 'brand_versions', { brand_id: id })).toHaveLength(1);

    // A field that is only proposed is no reason to publish, however often the brand is applied.
    await call(client, 'brand_update', { brand_id: id, fields: { gradients: 'none' } });
    const first = await call(client, 'brand_apply', { brand_id: id, file_ids: [linked.id, other.id] });
    expect(first).toMatchObject({ version: 1, files: [{ file_id: linked.id }], skipped: [{ file_id: other.id }] });
    expect((await call(client, 'brand_apply', { brand_id: id })).version).toBe(1);

    const versions = await rest(h.base, `/api/brands/${id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.map((v: any) => [v.n, v.note])).toEqual([[1, 'First linked']]);
    expect(versions.body).toEqual((await rest(h.base, `/api/brands/${id}`)).body.versions);
    await client.close();
  });
});

describe('a brand from a live page', () => {
  it('looks first and applies second without capturing the page twice', async () => {
    const h = await start();
    const client = await connectAgent(h.base, 'claude');
    const { id } = await call(client, 'brand_create', { name: 'From a site' });
    const url = 'https://brand.example/';
    // What a first brand_extract with this url leaves behind: the capture on the Reference page, recorded with its address.
    const { recordCapture } = await import('../src/capture-modes.ts');
    const room = await h.server.rooms.get(id);
    const page = room.doc.createPage('Reference');
    const nodeId = room.doc.insert(page, { type: 'frame', name: 'Brand Example', artboard: true, style: { width: '1440px', backgroundColor: '#f8f6f0' }, children: [{ type: 'text', tag: 'h1', text: 'Plain tools', style: { color: '#101010', fontFamily: 'Fraunces', fontSize: '56px' } }] });
    recordCapture(room.doc, nodeId, url, 'dark', 'test');

    const applied = await call(client, 'brand_extract', { brand_id: id, url, apply: true });
    expect(applied.capture).toMatchObject({ node_id: nodeId, reused: true, title: 'Brand Example', layers: 2 });
    expect(applied.source).toBe(`capture:${url}`);
    expect(applied.colors.map((c: any) => c.value)).toEqual(expect.arrayContaining(['#f8f6f0', '#101010']));
    expect(room.doc.getChildren(page)).toHaveLength(1);
    const raw = (await call(client, 'brand_get', { brand_id: id, raw: true })).raw;
    expect(raw.artboards).toEqual([expect.objectContaining({ nodeId, name: 'Brand Example', verdict: 'good', suggested: true, source: `capture:${url}` })]);
    expect(raw.families.map((f: any) => f.family)).toEqual(['Fraunces']);
    await client.close();
  });
});
