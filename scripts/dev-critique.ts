/**
 * Runs design_critique against a data folder, for working on the reviewer brief. Never point it at the folder the
 * everyday Bogen serves: copy it first (cp -a --reflink=auto).
 *   BOGEN_HOME=<copy> node --import tsx scripts/dev-critique.ts file <fileId> <artboardId>... [--reviewer fable|opus|sonnet]
 *   BOGEN_HOME=<copy> node --import tsx scripts/dev-critique.ts brand <brandId> [first page] [count] [--reviewer ...]
 * Prints the record as JSON. The pictures the reviewer saw are written next to it with BOGEN_SHOTS=<dir>.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentLanguageOf } from '@bogen/core';
import { BogenServer } from '../packages/server/src/http/server.ts';
import { critique, type ReviewerChoice } from '../packages/server/src/design-critique.ts';
import { lintIssues } from '../packages/server/src/mcp/lint.ts';

const home = process.env.BOGEN_HOME;
if (!home) throw new Error('Set BOGEN_HOME to a copy of a data folder.');
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const reviewer = (flag('--reviewer') ?? 'auto') as ReviewerChoice;
const [mode, id, ...rest] = args;
const s = new BogenServer({ home, port: 0, thumbnails: false });
await s.listen();
try {
  let doc, screens: string[], brand = null;
  if (mode === 'brand') {
    const { room, data } = await s.brands.read(id!);
    const book = await s.brands.sheetDoc(data, room.doc, 'pages');
    const from = Number(rest[0] ?? 0), count = Number(rest[1] ?? 16);
    doc = book.doc; screens = book.pageIds.slice(from, from + count); brand = data;
  } else {
    const room = await s.rooms.get(id!);
    doc = room.doc; screens = rest;
    brand = (await s.brands.forRoom(room).catch(() => null))?.data ?? null;
  }
  const shots = process.env.BOGEN_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    for (const [i, sid] of screens.entries()) {
      const shot = await s.renderer.screenshot(doc, { nodeIds: [sid] }, { format: 'jpg', maxDimension: 1568 });
      writeFileSync(join(shots, `screen-${String(i + 1).padStart(2, '0')}.jpg`), shot.bytes);
    }
  }
  const out = await critique({
    doc, screens, flow: mode !== 'brand', reviewer, maxRounds: 1, language: contentLanguageOf(doc) ?? (brand?.fields.language || 'en'), brand,
    ...(mode === 'brand' ? { purpose: `A brand guidelines book generated from the brand data, one 1280x800 page per screen. These are pages ${Number(rest[0] ?? 0) + 1} to ${Number(rest[0] ?? 0) + screens.length} of a longer book, so later chapters are not shown.` } : {}),
    onStep: (step, detail) => process.stderr.write(`${step}${detail ? ` ${detail}` : ''}\n`),
  }, {
    renderer: s.renderer,
    lint: (nodes, target) => lintIssues(doc, s.renderer, target, nodes, brand ? { brand, contentLanguage: contentLanguageOf(doc) } : {}),
    write: (change) => change(doc),
  });
  console.log(JSON.stringify({ ...out.record, next: out.next, note: out.reviewerNote }, null, 1));
} finally {
  await s.close();
}
process.exit(0);
