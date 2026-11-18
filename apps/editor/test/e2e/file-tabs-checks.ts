/**
 * Bogen's own checks over the tab strip as it renders: the editor with a file open is captured into a temporary
 * Bogen (its own server, its own data), and design_lint and a11y_audit run on the captured strip, dark and light.
 *
 *   (cd apps/editor && npx vite build)
 *   node --import tsx apps/editor/test/e2e/file-tabs-checks.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import { call, connectAgent } from '../../../../packages/server/test/helpers.ts';

const root = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-tabs-checks-'));
const server = new BogenServer({ home: join(root, 'bogen'), port: 0, exportDir: join(root, 'exports'), thumbnails: false });
await server.listen();
const base = server.localUrl();
let bad = 0;
try {
  const shown = server.storage.create('Trauermusik Wien · Website');
  const room = await server.rooms.get(shown.id);
  room.doc.insert(room.doc.getPages()[0]!.id, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '800px', height: '500px', background: '#f4f2ec' } });
  room.doc.invalidate();
  const target = server.storage.create('Checks');
  const agent = await connectAgent(base, 'claude');
  for (const scheme of ['dark', 'light'] as const) {
    const cap = await server.capturePageInto(target.id, { url: `${base}/#/file/${shown.id}`, width: 1440, height: 900, colorScheme: scheme, allowLocal: true, name: `Editor with tabs, ${scheme}` });
    const tree: string = await call(agent, 'layer_tree', { file_id: target.id, page_id: cap.pageId, node_id: cap.nodeId, depth: 6 }).then((r: unknown) => (typeof r === 'string' ? r : JSON.stringify(r)));
    const strip = /^\s*(\w+) frame <div> "[^"]*tabstrip[^"]*"/im.exec(tree)?.[1] ?? /^\s*(\w+) .*tablist/im.exec(tree)?.[1];
    if (!strip) {
      console.log(`FAIL  ${scheme}: the strip is not in the capture`);
      console.log(tree.split('\n').slice(0, 30).join('\n'));
      bad++;
      continue;
    }
    const lint = await call(agent, 'design_lint', { file_id: target.id, page_id: cap.pageId, node_id: strip });
    const a11y = await call(agent, 'a11y_audit', { file_id: target.id, page_id: cap.pageId, node_id: strip });
    const real = (lint.issues ?? []).filter((i: { rule: string; message: string }) => !/equals the token|make one a component|share this structure/i.test(i.message) && i.rule !== 'token' && i.rule !== 'repeated');
    console.log(`${scheme}: design_lint hard ${lint.hard}, total ${lint.total}, after capture noise ${real.length}; a11y ${JSON.stringify(a11y.counts)}`);
    for (const i of real) console.log(`   ${i.severity ?? ''} ${i.rule} ${i.name}: ${i.message}`);
    for (const l of a11y.layers ?? []) for (const i of l.issues) console.log(`   a11y ${i.rule} ${i.layer}: ${i.message}`);
    if (lint.hard || Object.values(a11y.counts as Record<string, number>).some((n) => n > 0)) bad++;
  }
  await agent.close();
} finally {
  await server.close();
}
process.exit(bad ? 1 : 0);
