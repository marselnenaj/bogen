import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, connectAgent, startServer, until, type Harness } from './helpers.ts';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

describe('a comment on a layer inside an instance', () => {
  it('is sent, starts the agent, and tells it about the main', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'bogen-instance-bin-'));
    const log = join(bin, 'calls.jsonl');
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('stand-in 1'); process.exit(0); }
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([...process.argv.slice(2), input]) + '\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
`);
    chmodSync(join(bin, 'claude'), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const h = await startServer();
      harnesses.push(h);
      const agent = await connectAgent(h.base, 'claude');
      const file = await call(agent, 'file_create', { name: 'Site' });
      const { ids } = await call(agent, 'html_write', { file_id: file.id, html: '<header data-name="Kopfzeile" style="display:flex;padding:0 24px"><span data-name="Title">Trauermusik</span></header>' });
      await call(agent, 'component_create', { node_ids: [ids[0]], name: 'Kopfzeile' });
      const inst = await call(agent, 'instance_create', { component: 'Kopfzeile', x: 0, y: 400 });
      const { doc } = await h.server.rooms.get(file.id);
      const title = doc.getChildren(ids[0])[0]!.id;
      const inside = `${inst.id}/${title}`;
      expect(doc.getNode(inside)?.name).toBe('Title');

      const sent = await post(h.base, '/api/comments', { fileId: file.id, text: '@claude the top padding is missing', author: 'M', pageId: doc.pageOf(inst.id), nodeId: inside, x: 4, y: 4 });
      expect(sent.status).toBe(201);
      expect(sent.json.started).toEqual(['claude']);
      expect(doc.getComments().find((t) => t.id === sent.json.threadId)?.nodeId).toBe(inside);
      const seen = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
      await until(() => seen().length === 1, 8000);
      const prompt = seen()[0]!.join('\n');
      expect(prompt).toContain(`instance ${inst.id} of component Kopfzeile`);
      expect(prompt).toContain(`in the main it is layer ${title}`);

      for (const bad of ['../x', 'a//b', `${'a/'.repeat(8)}a`, 'a b']) {
        expect((await post(h.base, '/api/comments', { fileId: file.id, text: 'hi', author: 'M', nodeId: bad })).status).toBe(400);
      }
      await agent.close();
    } finally {
      process.env.PATH = savedPath;
    }
  }, 60_000);
});
