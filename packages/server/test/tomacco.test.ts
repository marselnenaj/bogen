import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appScreenRecords } from '@bogen/core';
import { keptElements, matchElements, parseScreen, readBundle } from '../src/tomacco.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/** Two colours within a few steps of each other on every channel. */
function close(a: string, b: string, step = 24): boolean {
  const v = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  return v(a).every((x, i) => Math.abs(x - v(b)[i]!) <= step);
}

const FIXTURES = resolve(import.meta.dirname, 'fixtures/tomacco');
const ANDROID = join(FIXTURES, 'android-login');
const IOS = join(FIXTURES, 'ios-settings');
const hasBrowser = Boolean(process.env.BOGEN_BROWSER) || (() => {
  try {
    readFileSync('/usr/bin/chromium');
    return true;
  } catch {
    return false;
  }
})();

/** Copies of the fixtures under the temp folder, which the server reads paths from. */
const work = mkdtempSync(join(tmpdir(), 'bogen-tomacco-'));
cpSync(FIXTURES, join(work, 'fixtures'), { recursive: true });
const android = join(work, 'fixtures/android-login');
const ios = join(work, 'fixtures/ios-settings');

/** A stand-in for tomaccoctl: a device list with one emulator, and screen.export that writes the Android fixture. */
const standIn = join(work, 'tomaccoctl');
writeFileSync(standIn, `#!/usr/bin/env node
const [, , cmd, op, raw] = process.argv;
const fs = require('node:fs');
if (cmd !== 'call') process.exit(2);
if (op === 'device.list') { console.log(JSON.stringify({ ok: true, result: { devices: [{ id: 'emulator-5554', platform: 'android', model: 'sdk_gphone64_x86_64', state: 'device' }], diagnostics: [] } })); process.exit(0); }
if (op === 'screen.export') {
  const args = JSON.parse(raw);
  if (args.device !== 'emulator-5554') { console.log(JSON.stringify({ ok: false, error: { code: 'device_not_found', message: 'No such device.' } })); process.exit(1); }
  fs.cpSync(${JSON.stringify(android)}, args.directory, { recursive: true });
  console.log(JSON.stringify({ ok: true, result: { directory: args.directory } }));
  process.exit(0);
}
process.exit(3);
`);
chmodSync(standIn, 0o755);

describe('reading screen exports', () => {
  it('reads the Android fixture in dp', async () => {
    const screen = await readBundle(android);
    expect(screen.platform).toBe('android');
    expect([screen.width, screen.height, screen.scale, screen.unit]).toEqual([360, 780, 2, 'dp']);
    expect(screen.scaleGuessed).toBe(false);
    const title = screen.elements.find((e) => e.text === 'Sign in')!;
    expect(title.box.x).toBe(24);
    expect(title.px.x).toBe(48);
    // The whole-screen root and nothing else goes: every other element stands for something.
    const { list } = keptElements(screen);
    expect(list.map((e) => e.id)).not.toContain('e0');
    expect(list.length).toBe(screen.elements.length - 1);
  });

  it('takes a likely scale when an iPhone export has none, and says so', async () => {
    const screen = await readBundle(join(ios, 'screen.json'));
    expect(screen.json.display.scale).toBeNull();
    expect([screen.width, screen.height, screen.scale, screen.unit, screen.scaleGuessed]).toEqual([375, 667, 2, 'pt', true]);
    expect(screen.warnings.join(' ')).toMatch(/took 2/);
    expect(screen.elements.find((e) => e.text === 'Wi-Fi')!.box.x).toBe(16);
  });

  it('refuses another format and a newer version, and ignores fields it does not know', () => {
    const json = JSON.parse(readFileSync(join(ANDROID, 'screen.json'), 'utf8'));
    const png = new Uint8Array(readFileSync(join(ANDROID, 'screen.png')));
    expect(() => parseScreen({ ...json, version: 2 }, png)).toThrow(/version 2/);
    expect(() => parseScreen({ ...json, format: 'other.screen' }, png)).toThrow(/not a screen export/);
    expect(() => parseScreen(json, new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
    const extra = parseScreen({ ...json, future_field: { a: 1 }, elements: json.elements.map((e: object) => ({ ...e, new_flag: true })) }, png);
    expect(extra.elements.length).toBe(json.elements.length);
    const tampered = parseScreen({ ...json, screenshot: { ...json.screenshot, sha256: '0'.repeat(64) } }, png);
    expect(tampered.warnings.join(' ')).toMatch(/sha256/);
  });

  it('matches by words first, then by place', () => {
    const el = (id: string, text: string, x: number, y: number) => ({ id, parent: null, role: 'text', label: text, text, resource: '', box: { x, y, width: 100, height: 20 }, px: { x, y, width: 100, height: 20 } });
    const out = matchElements([
      { id: 'a', name: 'Title', text: 'Sign in', box: { x: 20, y: 54, width: 100, height: 20 } },
      { id: 'b', name: 'Button', box: { x: 10, y: 200, width: 100, height: 20 } },
      { id: 'c', name: 'Terms', text: 'Terms', box: { x: 10, y: 400, width: 100, height: 20 } },
      { id: 'd', name: 'Cta', text: 'Continue now', box: { x: 10, y: 300, width: 100, height: 20 } },
    ], [el('e1', 'Sign in', 24, 50), el('e2', '', 10, 202), el('e3', 'Forgot password?', 10, 500), el('e4', 'Continue', 10, 300)], 'dp');
    const by = Object.fromEntries(out.matched.map((m) => [m.layer.id, m]));
    expect(by.a!.element.id).toBe('e1');
    expect([by.a!.dx, by.a!.dy]).toEqual([-4, 4]);
    expect(by.a!.summary).toBe('4 dp further left, 4 dp lower');
    expect(by.b!.element.id).toBe('e2');
    expect(by.d!.text).toEqual({ design: 'Continue now', app: 'Continue' });
    expect(out.onlyInDesign.map((l) => l.id)).toEqual(['c']);
    expect(out.onlyInApp.map((e) => e.id)).toEqual(['e3']);
  });
});

describe.skipIf(!hasBrowser)('app screens on the canvas', () => {
  let h: Harness;
  let agent: Client;
  let fileId: string;
  const before = process.env.BOGEN_TOMACCOCTL;

  beforeAll(async () => {
    process.env.BOGEN_TOMACCOCTL = standIn;
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'App screens' })).id;
  }, 30_000);
  afterAll(async () => {
    if (before === undefined) delete process.env.BOGEN_TOMACCOCTL;
    else process.env.BOGEN_TOMACCOCTL = before;
    await agent?.close();
    await h?.cleanup();
  });

  it('imports the Android screen as an artboard of editable layers', async () => {
    const out = await call(agent, 'tomacco_import', { bundle: android, file_id: fileId });
    expect([out.width, out.height, out.unit]).toEqual([360, 780, 'dp']);
    const room = await h.server.rooms.get(fileId);
    const doc = room.doc;
    const board = doc.getNode(out.node_id)!;
    expect(board.artboard).toBe(true);
    expect([board.style.width, board.style.height]).toEqual(['360px', '780px']);
    const layers = doc.descendants(out.node_id);
    const shot = layers.find((n) => n.name === 'App screenshot')!;
    expect(shot.type).toBe('image');
    expect(shot.locked).toBe(true);
    const title = layers.find((n) => n.type === 'text' && n.text === 'Sign in')!;
    expect(close(title.style.color!, '#0e0e0c')).toBe(true);
    expect(parseFloat(title.style.fontSize!)).toBeGreaterThan(24);
    expect(parseFloat(title.style.fontSize!)).toBeLessThan(32);
    expect(title.style.fontWeight).toBe('700');
    const sub = layers.find((n) => n.type === 'text' && n.text === 'Use your Couchette account')!;
    expect(parseFloat(sub.style.fontSize!)).toBeGreaterThan(13);
    expect(parseFloat(sub.style.fontSize!)).toBeLessThan(19);
    expect(sub.style.fontWeight).toBe('400');
    const button = layers.find((n) => n.type === 'text' && n.text === 'Continue')!;
    expect(close(button.style.color!, '#ffffff')).toBe(true);
    expect(button.style.textAlign).toBe('center');
    // Over the screenshot, the words cover their own pixels with the background they sit on.
    expect(close(button.style.backgroundColor!, '#2b3df2')).toBe(true);
    const logo = layers.find((n) => n.name === 'logo')!;
    expect(logo.style.backgroundImage).toMatch(/bogen-asset:/);
    expect([logo.style.left, logo.style.width]).toEqual(['24px', '48px']);
    const row = layers.find((n) => n.name === 'remember row' && n.type === 'frame')!;
    expect(doc.getChildren(row.id).map((n) => n.type).sort()).toEqual(['frame', 'text']);
    expect(layers.some((n) => n.name === 'Status bar')).toBe(true);
    expect(appScreenRecords(doc)[out.node_id]).toMatchObject({ platform: 'android', device: 'emulator-5554', unit: 'dp', width: 360, screenshotLayer: shot.id });
    // One step: the agent's undo takes the whole artboard away.
    await call(agent, 'agent_undo', { file_id: fileId });
    expect(doc.getNode(out.node_id)).toBeUndefined();
    await call(agent, 'agent_undo', { file_id: fileId, redo: true });
    expect(doc.getNode(out.node_id)).toBeDefined();
  }, 60_000);

  it('puts a frame around the screen, and can leave text as pictures and the screenshot out', async () => {
    const out = await call(agent, 'tomacco_import', { bundle: ios, file_id: fileId, frame: true, text: false, screenshot: false });
    expect([out.width, out.height, out.unit]).toEqual([375 + 24, 667 + 24, 'pt']);
    expect(out.warnings.join(' ')).toMatch(/took 2/);
    const { doc } = await h.server.rooms.get(fileId);
    const screen = doc.getChildren(out.node_id)[0]!;
    expect(screen.name).toBe('Screen');
    expect([screen.style.width, screen.style.height]).toEqual(['375px', '667px']);
    const layers = doc.descendants(out.node_id);
    expect(layers.some((n) => n.type === 'text')).toBe(false);
    expect(layers.some((n) => n.name === 'App screenshot')).toBe(false);
    // The four lines of text and the status bar.
    expect(layers.filter((n) => /bogen-asset:/.test(n.style.backgroundImage ?? '')).length).toBe(5);
    expect(appScreenRecords(doc)[out.node_id]!.screen).toBe(screen.id);
  }, 60_000);

  it('lists devices, imports from one through tomaccoctl, and refuses a device it does not have', async () => {
    const list = await call(agent, 'tomacco_import', { file_id: fileId });
    expect(list.devices).toEqual([{ id: 'emulator-5554', platform: 'android', name: 'sdk_gphone64_x86_64', state: 'device' }]);
    const out = await call(agent, 'tomacco_import', { device: 'emulator-5554', file_id: fileId });
    expect(out.device).toBe('emulator-5554');
    const missing = await callRaw(agent, 'tomacco_import', { device: 'emulator-9999', file_id: fileId });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/No such device/);
    const res = await fetch(`${h.base}/api/tomacco/devices`);
    expect((await res.json()).devices).toHaveLength(1);
  }, 60_000);

  it('compares a design with the app: the imported screen matches, a changed design does not', async () => {
    const imported = await call(agent, 'tomacco_import', { bundle: android, file_id: fileId });
    const same = await call(agent, 'tomacco_compare', { node_id: imported.node_id, bundle: android, file_id: fileId });
    expect(same.different_percent).toBeLessThan(3);
    expect(same.matched.length).toBeGreaterThanOrEqual(8);
    expect(same.matched.find((m: { label: string }) => m.label === 'Sign in').summary).toBe('same');

    // A design of the same screen, drawn by hand, with the fields 8 dp lower, other words on the button, and a line the app lacks.
    const board = await call(agent, 'artboard_create', { name: 'Login, design', width: 360, height: 780, background: '#f4f2ec', file_id: fileId });
    await call(agent, 'html_write', {
      file_id: fileId, target_id: board.id,
      html: `<div style="position:relative;width:360px;height:780px;font-family:Arial,sans-serif;color:#0e0e0c">
<h1 style="position:absolute;left:24px;top:128px;width:312px;margin:0;font-size:28px;font-weight:700;line-height:36px">Sign in</h1>
<p style="position:absolute;left:24px;top:180px;width:312px;margin:0;font-size:16px;line-height:22px;color:#5f5d55">Use your Couchette account</p>
<div style="position:absolute;left:24px;top:226px;width:312px;height:52px;border:2px solid #0e0e0c;background:#fff;padding:0 14px;display:flex;align-items:center;font-size:16px;box-sizing:border-box">ana@example.com</div>
<div style="position:absolute;left:24px;top:410px;width:312px;height:52px;background:#2b3df2;color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700">Log in</div>
<p style="position:absolute;left:24px;top:600px;margin:0;font-size:13px">By continuing you accept the terms</p>
</div>`,
    });
    const raw = await callRaw(agent, 'tomacco_compare', { node_id: board.id, bundle: android, file_id: fileId });
    expect(raw.isError).toBe(false);
    expect(raw.content[1]!.type).toBe('image');
    const diff = JSON.parse(raw.content[0]!.text!);
    expect(diff.different_percent).toBeGreaterThan(same.different_percent);
    const by = (label: string) => diff.matched.find((m: { label: string }) => m.label === label);
    expect(by('Sign in').summary).toBe('same');
    expect(by('ana@example.com').dy).toBe(8);
    expect(by('ana@example.com').summary).toBe('8 dp lower');
    expect(by('Continue').text).toEqual({ design: 'Log in', app: 'Continue' });
    expect(diff.only_in_design.map((l: { text?: string }) => l.text)).toContain('By continuing you accept the terms');
    expect(diff.only_in_app.map((e: { label: string }) => e.label)).toEqual(expect.arrayContaining(['Forgot password?', 'Remember me']));
  }, 90_000);

  it('puts the app screen beside a design artboard, for the agent and the editor, and compares the two', async () => {
    const design = await call(agent, 'artboard_create', { name: 'Login beside', width: 360, height: 780, x: 0, y: 5000, file_id: fileId });
    const out = await call(agent, 'tomacco_import', { device: 'emulator-5554', beside: design.id, file_id: fileId });
    expect(out.next).toMatch(new RegExp(`tomacco_compare, node_id ${design.id}`));
    const { doc } = await h.server.rooms.get(fileId);
    const board = doc.getNode(out.node_id)!;
    expect([board.style.left, board.style.top]).toEqual(['440px', '5000px']);
    const json = readFileSync(join(android, 'screen.json'), 'utf8');
    const png = readFileSync(join(android, 'screen.png')).toString('base64');
    const { screenId } = await (await fetch(`${h.base}/api/tomacco/screen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: { json, png } }) })).json();
    const plan = await (await fetch(`${h.base}/api/tomacco/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, screenId, plan: true, beside: design.id }) })).json();
    // The first spot is taken by the agent's import now, so the editor's goes past it.
    expect([plan.x, plan.y, plan.pageId]).toEqual([880, 5000, board.parent]);
    const compared = await (await fetch(`${h.base}/api/tomacco/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeId: design.id, screenId }) })).json();
    expect(compared.percent).toBeGreaterThan(0);
  }, 90_000);

  it('works over HTTP for the editor: upload, plan and compare, and keeps the machine to itself', async () => {
    const json = readFileSync(join(android, 'screen.json'), 'utf8');
    const png = readFileSync(join(android, 'screen.png')).toString('base64');
    const read = await fetch(`${h.base}/api/tomacco/screen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: { json, png } }) });
    expect(read.status).toBe(200);
    const { screenId, summary } = await read.json();
    expect(summary).toMatchObject({ platform: 'android', width: 360, height: 780, unit: 'dp', elements: 12 });
    const plan = await fetch(`${h.base}/api/tomacco/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, screenId, plan: true, frame: true }) });
    const planned = await plan.json();
    expect(planned.spec.artboard).toBe(true);
    expect(planned.spec.children[0].name).toBe('Screen');
    expect(planned.record).toMatchObject({ device: 'emulator-5554', unit: 'dp' });
    const placed = await fetch(`${h.base}/api/tomacco/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, screenId }) });
    expect(placed.status).toBe(201);
    const { nodeId } = await placed.json();
    const compared = await fetch(`${h.base}/api/tomacco/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeId, screenId }) });
    const out = await compared.json();
    expect(out.percent).toBeLessThan(3);
    expect(out.images.diff.length).toBeGreaterThan(100);
    const bad = await fetch(`${h.base}/api/tomacco/screen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: { json: { ...JSON.parse(json), version: 2 }, png } }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/version 2/);
  }, 90_000);

  it('reads devices and folders only for a request from this computer itself', async () => {
    const proxied = { 'X-Forwarded-For': '203.0.113.9', 'Content-Type': 'application/json' };
    expect((await fetch(`${h.base}/api/tomacco/devices`, { headers: proxied })).status).toBe(403);
    const path = await fetch(`${h.base}/api/tomacco/screen`, { method: 'POST', headers: proxied, body: JSON.stringify({ source: { path: android } }) });
    expect(path.status).toBe(403);
  });
});
