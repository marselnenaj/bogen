/**
 * Bogen's own checks over the brand book of real brands: design_lint (hard findings) per page and the a11y audit
 * over the whole book. BOGEN_HOME=<data folder> npx tsx scripts/check-brand-book.ts <brand id>...
 */
import { BogenServer } from '../packages/server/src/http/server.ts';
import { lintIssues } from '../packages/server/src/mcp/lint.ts';
import { auditA11y } from '../packages/server/src/a11y.ts';
const s = new BogenServer({ home: process.env.BOGEN_HOME!, port: 0, thumbnails: false });
await s.listen();
for (const id of process.argv.slice(2)) {
  const { room, data } = await s.brands.read(id);
  const book = await s.brands.sheetDoc(data, room.doc, 'pages');
  let hard = 0, adv = 0, a11y = 0; const counts: Record<string, number> = {}; const samples: string[] = [];
  for (const [i, pid] of book.pageIds.entries()) {
    const nodes = [book.doc.getNode(pid)!, ...book.doc.descendants(pid)];
    const issues = await lintIssues(book.doc, s.renderer, { nodeIds: [pid] }, nodes);
    for (const x of issues) { if (x.severity === 'hard') { hard++; if (samples.length < 12) samples.push(`p${i + 1} ${book.titles[i]} ${x.rule}: ${x.message.slice(0, 100)} [${book.doc.getNode(x.nodeId)?.name} < ${book.doc.getNode(book.doc.getParentId?.(x.nodeId) ?? "")?.name ?? ""}] ${JSON.stringify(book.doc.getNode(x.nodeId)?.text ?? "").slice(0,80)}`); } else { adv++; counts[x.rule] = (counts[x.rule] ?? 0) + 1; } }
  }
  const whole = await s.brands.sheetDoc(data, room.doc, 'book');
  const rep = await auditA11y(whole.doc, s.renderer, { nodeId: whole.rootId });
  for (const l of rep.layers) for (const x of l.issues) { a11y++; samples.push(`a11y ${(x as {rule?: string}).rule ?? ''}: ${((x as {message?: string}).message ?? '').slice(0, 160)}`); }
  console.log(`${data.fields.name}: ${book.pageIds.length} pages, hard ${hard}, advisory ${adv}, a11y ${a11y}`);
  for (const x of samples) console.log('   ', x);
  console.log('   ', JSON.stringify(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)));
  book.doc.y.destroy();
}
process.exit(0);
