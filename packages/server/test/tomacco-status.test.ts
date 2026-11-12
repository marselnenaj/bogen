import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { besideArtboard } from '../src/mcp/kit.ts';
import { doctorSteps, readiness, TOMACCO_INSTALL, tomaccoStatus } from '../src/tomacco.ts';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

/**
 * Whether Tomacco can give a screen now, and where an imported screen goes. None of this needs a browser or Tomacco:
 * stand-ins for tomaccoctl answer as the real one does (one JSON envelope per call, `--version` as one line).
 */

const work = mkdtempSync(join(tmpdir(), 'bogen-tomacco-status-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The shape of `tomaccoctl call doctor` 1.5.0 on a computer without the Android SDK, shortened. */
const DOCTOR = {
  host: { kvm: { ready: false } },
  tools: [{ name: 'adb', available: false }],
  next_steps: [
    { goal: 'android', what: 'Install the Android SDK and create an emulator', how: 'Run: tomaccoctl setup --yes. It downloads about 5 GB and accepts Google\'s Android SDK license, so tell the person that first.', ask_first: true },
    { goal: 'android', what: 'Make KVM usable for a fast Android emulator', how: 'sudo modprobe kvm_intel', ask_first: true },
  ],
};

function standIn(name: string, devices: object[], log = join(work, `${name}.log`)): string {
  const path = join(work, name);
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs');
const [, , cmd, op] = process.argv;
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
if (cmd === '--version') { console.log('tomaccoctl 1.5.0 (Tomacco)'); process.exit(0); }
if (cmd !== 'call') process.exit(2);
if (op === 'device.list') { console.log(JSON.stringify({ ok: true, result: { devices: ${JSON.stringify(devices)}, diagnostics: [{ platform: 'android', message: 'adb is not installed' }] } })); process.exit(0); }
if (op === 'doctor') { console.log(JSON.stringify({ ok: true, result: ${JSON.stringify(DOCTOR)} })); process.exit(0); }
console.log(JSON.stringify({ ok: false, error: { code: 'refused', message: 'The stand-in answers only device.list and doctor.' } }));
process.exit(1);
`);
  chmodSync(path, 0o755);
  return path;
}

const idle = standIn('tomaccoctl-idle', []);
const running = standIn('tomaccoctl-running', [{ id: 'emulator-5554', platform: 'android', model: 'sdk_gphone64_x86_64', state: 'device' }]);

describe('the state of Tomacco', () => {
  const before = process.env.BOGEN_TOMACCOCTL;
  afterAll(() => {
    if (before === undefined) delete process.env.BOGEN_TOMACCOCTL;
    else process.env.BOGEN_TOMACCOCTL = before;
  });

  it('reads doctor\'s next steps loosely and bounded', () => {
    expect(doctorSteps({ next_steps: DOCTOR.next_steps })).toEqual([
      { goal: 'android', what: 'Install the Android SDK and create an emulator', how: DOCTOR.next_steps[0]!.how, askFirst: true },
      { goal: 'android', what: 'Make KVM usable for a fast Android emulator', how: 'sudo modprobe kvm_intel', askFirst: true },
    ]);
    expect(doctorSteps(null)).toEqual([]);
    expect(doctorSteps({ next_steps: 'no' })).toEqual([]);
    const many = doctorSteps({ next_steps: [...Array(20)].map((_, i) => ({ what: `Step ${i} ${'x'.repeat(2000)}`, how: 7, extra: { a: 1 } })) });
    expect(many).toHaveLength(8);
    expect(many[0]!.what.length).toBe(600);
    expect(many[0]!.how).toBeNull();
    expect(doctorSteps({ next_steps: [{ how: 'only a command' }, 3, null] })).toEqual([]);
  });

  it('is missing, no-device or ready, with the command to run next', () => {
    expect(readiness({ installed: false }, 1)).toEqual({ state: 'missing', version: null, devices: [], notes: [], steps: [], fix: TOMACCO_INSTALL, checkedAt: 1 });
    const steps = doctorSteps(DOCTOR);
    const none = readiness({ installed: true, version: '1.5.0', steps }, 1);
    expect([none.state, none.fix, none.steps.length]).toEqual(['no-device', steps[0]!.how, 2]);
    expect(readiness({ installed: true, steps: [{ goal: null, what: 'Start a device', how: null, askFirst: false }] }).fix).toBeNull();
    // With a device running, a screen can be taken: what is left to set up for builds does not matter here.
    const ready = readiness({ installed: true, version: '1.5.0', devices: [{ id: 'emulator-5554', platform: 'android', name: 'Pixel' }], steps }, 1);
    expect([ready.state, ready.fix, ready.steps]).toEqual(['ready', null, []]);
  });

  it('asks tomaccoctl: doctor only when no device is running, and never anything that changes state', async () => {
    process.env.BOGEN_TOMACCOCTL = 'none';
    expect((await tomaccoStatus({ fresh: true })).state).toBe('missing');

    const log = join(work, 'tomaccoctl-idle.log');
    writeFileSync(log, '');
    process.env.BOGEN_TOMACCOCTL = idle;
    const none = await tomaccoStatus({ fresh: true });
    expect(none).toMatchObject({ state: 'no-device', version: '1.5.0', devices: [], notes: ['android: adb is not installed'], fix: DOCTOR.next_steps[0]!.how });
    expect(none.steps.map((s) => s.what)).toEqual(['Install the Android SDK and create an emulator', 'Make KVM usable for a fast Android emulator']);
    // Kept for a minute: a second ask within it calls nothing.
    expect(await tomaccoStatus()).toEqual(none);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ')).sort();
    expect(calls).toEqual(['--version', 'call device.list', 'call doctor']);

    process.env.BOGEN_TOMACCOCTL = running;
    const ready = await tomaccoStatus({ fresh: true });
    expect(ready).toMatchObject({ state: 'ready', devices: [{ id: 'emulator-5554', platform: 'android', name: 'sdk_gphone64_x86_64', state: 'device' }], steps: [], fix: null });
    expect(readFileSync(join(work, 'tomaccoctl-running.log'), 'utf8')).not.toMatch(/doctor/);
  });
});

describe('Tomacco for the editor and the agent', () => {
  let h: Harness;
  let agent: Client;
  let fileId: string;
  const before = process.env.BOGEN_TOMACCOCTL;

  beforeAll(async () => {
    process.env.BOGEN_TOMACCOCTL = idle;
    h = await startServer();
    agent = await connectAgent(h.base, 'claude');
    fileId = (await call(agent, 'file_create', { name: 'Beside' })).id;
  }, 30_000);
  afterAll(async () => {
    if (before === undefined) delete process.env.BOGEN_TOMACCOCTL;
    else process.env.BOGEN_TOMACCOCTL = before;
    await agent?.close();
    await h?.cleanup();
  });

  it('tells the editor the state, on this computer only', async () => {
    const res = await fetch(`${h.base}/api/tomacco/status?fresh=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'no-device', fix: DOCTOR.next_steps[0]!.how });
    const proxied = await fetch(`${h.base}/api/tomacco/status`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    expect(proxied.status).toBe(403);
  });

  it('tells the agent the state and what to say, read-only', async () => {
    const out = await call(agent, 'tomacco_status', { fresh: true });
    expect(out.state).toBe('no-device');
    expect(out.steps[0]).toMatchObject({ what: 'Install the Android SDK and create an emulator', ask_first: true });
    expect(out.next).toMatch(/ask before any step with ask_first/);
    const tools = await agent.listTools();
    const tool = tools.tools.find((t) => t.name === 'tomacco_status')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tools.tools.find((t) => t.name === 'tomacco_import')!.inputSchema.properties).toHaveProperty('beside');
  });

  it('puts a screen beside an artboard, past whatever is already to its right', async () => {
    const design = await call(agent, 'artboard_create', { name: 'Design', width: 360, height: 780, x: 0, y: 200, file_id: fileId });
    const room = await h.server.rooms.get(fileId);
    expect(besideArtboard(room.doc, design.id, 360, 780)).toMatchObject({ x: 440, y: 200 });
    // A layer inside the artboard stands for its artboard.
    await call(agent, 'html_write', { file_id: fileId, target_id: design.id, html: '<p>Sign in</p>' });
    const inner = room.doc.getChildren(design.id)[0]!.id;
    expect(besideArtboard(room.doc, inner, 360, 780)).toMatchObject({ x: 440, y: 200 });
    // Something already there: the screen goes past it. Something far below is not in the way.
    await call(agent, 'artboard_create', { name: 'Taken', width: 400, height: 600, x: 440, y: 400, file_id: fileId });
    await call(agent, 'artboard_create', { name: 'Below', width: 400, height: 300, x: 920, y: 2000, file_id: fileId });
    expect(besideArtboard(room.doc, design.id, 360, 780)).toMatchObject({ x: 920, y: 200 });
    expect(besideArtboard(room.doc, 'nope', 360, 780)).toBeNull();
    const missing = await callRaw(agent, 'tomacco_import', { bundle: join(import.meta.dirname, 'fixtures/tomacco/android-login'), beside: 'nope', file_id: fileId });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/No layer with id nope/);
  });
});
