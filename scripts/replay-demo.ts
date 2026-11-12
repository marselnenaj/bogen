#!/usr/bin/env -S npx tsx
// Builds a landing page in a throwaway Bogen server, as two agents over MCP and a person over the editor's socket
// would, then films its replay through the real export. Nothing touches your data folder or a running Bogen.
//
//   npx tsx scripts/replay-demo.ts [out.mp4] [--keep]
//
// FORMAT=webm|gif, SPEED=2, CAMERA=fit|follow and WIDTH/HEIGHT change the film. --keep leaves the server running
// and prints its address and the file, to look at the replay in the editor (build it first with npm run build).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebsocketProvider } from 'y-websocket';
import { WebSocket } from 'ws';
import { BogenDoc, Y } from '../packages/core/src/index.ts';
import { BogenServer } from '../packages/server/src/http/server.ts';
import { call, connectAgent, until } from '../packages/server/test/helpers.ts';

const keep = process.argv.includes('--keep');
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(process.cwd(), 'bogen-replay.mp4');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = mkdtempSync(join(tmpdir(), 'bogen-replay-demo-'));
const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports'), timeline: { coalesceMs: 300 } });
await server.listen();
const base = server.localUrl();
const claude = await connectAgent(base, 'Claude');
const codex = await connectAgent(base, 'Codex');
const file = await call(claude, 'file_create', { name: 'Bogen launch' });
const fileId = file.id as string;

await call(claude, 'tokens_set', { file_id: fileId, tokens: [
  { name: 'paper', kind: 'color', value: '#f4f2ec' }, { name: 'ink', kind: 'color', value: '#0e0e0c' },
  { name: 'dim', kind: 'color', value: '#5f5d55' }, { name: 'blue', kind: 'color', value: '#2b3df2' },
  { name: 'rule', kind: 'color', value: '#c9c6bb' }, { name: 'sans', kind: 'font-family', value: 'Archivo, "Helvetica Neue", Arial, sans-serif' },
] });
await sleep(600);
const board = await call(claude, 'artboard_create', { file_id: fileId, name: 'Home, desktop', width: 1280, background: 'var(--paper)' });
const B = board.id as string;
await sleep(700);
const write = async (who: typeof claude, html: string, target = B, wait = 650) => {
  const r = await call(who, 'html_write', { file_id: fileId, target_id: target, html });
  await sleep(wait);
  return r.ids[0] as string;
};
await write(claude, '<nav style="display:flex;justify-content:space-between;align-items:center;padding:28px 64px;font-family:var(--sans);color:var(--ink)"><span style="font:800 24px var(--sans);letter-spacing:-0.02em">Bogen</span><span style="display:flex;gap:28px;font:500 15px var(--sans);color:var(--dim)"><span>Docs</span><span>Agents</span><span>Devices</span><span>GitHub</span></span></nav>');
const hero = await write(claude, '<header style="display:flex;flex-direction:column;gap:20px;padding:72px 64px 40px;font-family:var(--sans);color:var(--ink)"></header>');
const h1 = await write(claude, '<h1 style="margin:0;font:800 84px/0.95 var(--sans);letter-spacing:-0.035em;max-width:900px">A design canvas your agents draw on.</h1>', hero);
await write(claude, '<p style="margin:0;font:400 21px/1.45 var(--sans);color:var(--dim);max-width:620px">Every layer is real HTML and CSS. Claude Code, Codex and you edit the same file, live, on your own machine.</p>', hero);
const ctas = await write(claude, '<div style="display:flex;gap:12px;margin-top:12px"><span style="padding:16px 26px;background:var(--ink);color:var(--paper);font:700 17px var(--sans)">npm i -g bogen-design</span><span style="padding:14px 24px;border:2px solid var(--ink);font:700 17px var(--sans)">Read the guide</span></div>', hero);

// A person joins and edits the headline.
const y = new Y.Doc();
const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/sync`, fileId, y, { WebSocketPolyfill: WebSocket as never, disableBc: true });
provider.awareness.setLocalStateField('user', { name: 'Mara', color: '#2b3df2' });
await until(() => provider.synced, 5000);
const person = new BogenDoc(y);
await sleep(900);
person.updateFields(h1, { text: 'The design canvas your agents draw on.' });
await sleep(1200);
person.updateStyle(h1, { color: 'var(--ink)', maxWidth: '980px' });
await sleep(900);

const grid = await write(codex, '<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:48px 64px 0;border-top:2px solid var(--ink);font-family:var(--sans);color:var(--ink)"></section>');
await write(codex, '<article style="display:flex;flex-direction:column;gap:10px;padding:28px 28px 32px 0"><h3 style="margin:0;font:800 22px var(--sans)">Real HTML</h3><p style="margin:0;font:16px/1.5 var(--sans);color:var(--dim)">Flexbox, grid, tokens and text styles. What you see is what ships.</p></article>', grid);
await write(codex, '<article style="display:flex;flex-direction:column;gap:10px;padding:28px 28px 32px;border-left:1px solid var(--rule)"><h3 style="margin:0;font:800 22px var(--sans)">Your own agents</h3><p style="margin:0;font:16px/1.5 var(--sans);color:var(--dim)">Over MCP, on your plan. No account, no usage cap.</p></article>', grid);
await write(codex, '<article style="display:flex;flex-direction:column;gap:10px;padding:28px 0 32px 28px;border-left:1px solid var(--rule)"><h3 style="margin:0;font:800 22px var(--sans)">Every step undoable</h3><p style="margin:0;font:16px/1.5 var(--sans);color:var(--dim)">A timeline of who did what, and undo per agent.</p></article>', grid);
await call(codex, 'tokens_set', { file_id: fileId, tokens: [{ name: 'blue', kind: 'color', value: '#2438f0' }] });
await sleep(700);
await write(claude, '<section style="display:flex;justify-content:space-between;align-items:center;margin:56px 64px 64px;padding:36px 40px;background:var(--blue);color:var(--paper);font-family:var(--sans)"><span style="font:800 32px/1.1 var(--sans);letter-spacing:-0.02em;max-width:560px">Watch it being built. Then ship the code.</span><span style="padding:14px 22px;background:var(--paper);color:var(--ink);font:700 16px var(--sans)">Start in a minute</span></section>');
await sleep(400);
person.updateStyle(ctas, { gap: '16px' });
await sleep(1400);
await write(claude, '<footer style="display:flex;justify-content:space-between;padding:24px 64px 32px;border-top:1px solid var(--rule);font:500 14px var(--sans);color:var(--dim)"><span>MIT licensed. Local first.</span><span>Made on Omarchy</span></footer>');
await server.timeline.flush(fileId);

if (keep) {
  console.log(`READY ${base}/#/file/${fileId}`);
  await new Promise(() => {});
}
const started = Date.now();
const film = {
  format: process.env.FORMAT ?? 'mp4', speed: Number(process.env.SPEED ?? 1),
  ...(process.env.CAMERA ? { camera: process.env.CAMERA } : {}),
  ...(process.env.WIDTH ? { width: Number(process.env.WIDTH) } : {}),
  ...(process.env.HEIGHT ? { height: Number(process.env.HEIGHT) } : {}),
};
const res = await fetch(`${base}/api/files/${fileId}/replay/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(film) });
if (!res.ok) throw new Error(await res.text());
writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
console.log(`Wrote ${out}: ${decodeURIComponent(res.headers.get('x-bogen-export-report') ?? '')}, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
provider.destroy();
await claude.close();
await codex.close();
await server.close();
rmSync(home, { recursive: true, force: true });
process.exit(0);
