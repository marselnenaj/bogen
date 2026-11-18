import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudePersona } from '../src/speech/persona.ts';

/**
 * A turn the call gave up on (too slow) still ends in the Claude Code session. Its answer must be thrown away, not
 * handed to the next turn: in a replay of a real call every answer landed one turn late ("I said: I said: …").
 */
describe('the talking layer on Claude Code', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bogen-persona-bin-'));
  // Answers each message after 300 ms with the message's last line, as stream-json.
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const text = JSON.parse(line).message.content[0].text.split('\\n').pop();
    setTimeout(() => console.log(JSON.stringify({ type: 'result', is_error: false, result: 'answer to ' + text })), 300);
  }
});
`);
  chmodSync(join(bin, 'claude'), 0o755);
  afterAll(() => rmSync(bin, { recursive: true, force: true }));

  it('throws away the answer of a turn it gave up on', async () => {
    const persona = new ClaudePersona({ command: join(bin, 'claude'), prompt: (req) => ({ system: 's', user: req.said }) });
    const late = new AbortController();
    const first = persona.reply({ kind: 'route', language: 'en', said: 'one' }, late.signal);
    setTimeout(() => late.abort(), 50);
    await expect(first).rejects.toThrow('aborted');
    const second = await persona.reply({ kind: 'route', language: 'en', said: 'two' });
    expect(second.text).toBe('answer to two');
    await persona.dispose();
  }, 10_000);
});
