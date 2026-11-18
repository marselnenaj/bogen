import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CRITIQUE_CALL_WAIT } from '../src/mcp/tools-critique.ts';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

const dirs: string[] = [];
const harnesses: Harness[] = [];
const wait = CRITIQUE_CALL_WAIT.ms;
afterEach(async () => {
  CRITIQUE_CALL_WAIT.ms = wait;
  for (const h of harnesses.splice(0)) await h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A reviewer that takes a second and a half to answer, logging each session it is started for. */
function slowReviewer(): { command: string; log: string } {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-slow-review-'));
  dirs.push(bin);
  const log = join(bin, 'calls.log');
  const command = join(bin, 'claude');
  const answer = JSON.stringify({ score: 7.5, dimensions: { layout: 7 }, verdict: 'Clear. One misaligned folio.', defects: [], taste: [], keep: [] });
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('stand-in 1'); process.exit(0); }
fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, 'session\\n');
setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(answer)}, usage: { input_tokens: 10, output_tokens: 10 } }));
}, 1500);
`);
  chmodSync(command, 0o755);
  return { command, log };
}

it('returns before a client would give up, and the next call waits for the same review instead of starting another', async () => {
  CRITIQUE_CALL_WAIT.ms = 300;
  const stub = slowReviewer();
  const h = await startServer({ critiqueCommand: stub.command });
  harnesses.push(h);
  const agent = await connectAgent(h.base, 'claude');
  const file = await call(agent, 'file_create', { name: 'Book' });
  const a = await call(agent, 'artboard_create', { file_id: file.id, name: '01 Cover', width: 640 });
  await call(agent, 'html_write', { file_id: file.id, target_id: a.id, html: '<div><h1>Kiln</h1></div>' });

  // A client that gave up on its first call asks again while the server still waits for that call: one review.
  const [first, again] = await Promise.all([call(agent, 'design_critique', { file_id: file.id }), new Promise((r) => setTimeout(r, 50)).then(() => call(agent, 'design_critique', { file_id: file.id }))]);
  expect(first.state).toBe('reviewing');
  expect(again.job).toBe(first.job);
  expect(first.next).toMatch(/Call design_critique again with the same arguments/);
  let result = first;
  for (let i = 0; i < 40 && result.state === 'reviewing'; i++) result = await call(agent, 'design_critique', { file_id: file.id });
  expect(result.score).toBe(7.5);
  expect(result.round).toBe(1);
  expect(readFileSync(stub.log, 'utf8').trim().split('\n')).toHaveLength(1);
  await agent.close();
}, 60_000);
