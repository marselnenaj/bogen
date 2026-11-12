#!/usr/bin/env node
// Rehearsal of the actual tarball. Only temporary prefixes/homes; no host desktop, theme or service changes.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), [packageArg, outputArg] = process.argv.slice(2);
if (!packageArg || !outputArg) throw new Error('Usage: check-package-lifecycle.mjs <actual-package.tgz> <evidence-folder>');
const tarball = resolve(packageArg), out = resolve(outputArg); mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'bogen-lifecycle-')), prefix = join(work, 'prefix'), home = join(work, 'home'), restored = join(work, 'restored');
const env = (dir) => ({ ...process.env, BOGEN_HOME: dir, BOGEN_UPDATE_CHECK: 'off', BOGEN_WELCOME: '0', BOGEN_THUMBNAILS_DELAY: '3600000' });
const run = (cmd, args, dir = home) => execFileSync(cmd, args, { env: env(dir), encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (data) => createHash('sha256').update(data).digest('hex');
function hashes(folder, base = folder) { return Object.fromEntries(readdirSync(folder).sort().flatMap((name) => { const p = join(folder, name); return statSync(p).isDirectory() ? Object.entries(hashes(p, base)) : [[p.slice(base.length + 1), sha(readFileSync(p))]]; })); }
let server, client, base, log = '';
async function stop() { await client?.close(); client = null; if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((done) => { server.once('exit', done); setTimeout(() => { server.kill('SIGKILL'); done(); }, 5000).unref(); }); } server = null; }
async function start(dir) {
  const port = await new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
  base = `http://127.0.0.1:${port}`;
  server = spawn(join(prefix, 'bin/bogen'), ['serve', '--port', String(port)], { env: env(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => log += d); server.stderr.on('data', (d) => log += d);
  for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error('Packed server stopped: ' + log.slice(-1500)); try { if ((await fetch(base + '/api/status')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  client = new Client({ name: 'release-lifecycle-fixture', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
}
async function call(name, args = {}) { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(name + ': ' + JSON.stringify(r.content)); return r.structuredContent ?? JSON.parse(r.content.find(c => c.type === 'text').text); }
try {
  run('npm', ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', tarball]);
  const version = run(join(prefix, 'bin/bogen'), ['--version']);
  await start(home);
  const file = await call('file_create', { name: 'Recovery fixture' });
  const board = await call('artboard_create', { file_id: file.id, name: 'Home', width: 900, height: 600 });
  const image = await call('asset_upload', { file_id: file.id, data_base64: readFileSync(join(root, 'apps/editor/test/fixtures/pixel.png')).toString('base64'), mime_type: 'image/png' });
  await call('html_write', { file_id: file.id, target_id: board.id, html: `<h1>Recovery proof</h1><img src="${image.src}" alt="Fixture" />` });
  const brand = await call('brand_create', { name: 'Recovery brand' });
  await call('brand_book_update', { brand_id: brand.id, chapter: 'strategy', markdown: 'Keep this authored draft and its source.', source: 'Synthetic release fixture', questions: 'An unresolved decision remains unresolved.', status: 'draft', expected_revision: null });
  await call('brand_link', { file_id: file.id, brand_id: brand.id });
  await call('commit_create', { file_id: file.id, message: 'Recovery checkpoint' });
  const branch = await call('design_branch_create', { file_id: file.id, name: 'Unmerged alternative' });
  await call('design_branch_switch', { file_id: file.id, branch_id: 'main' });
  const originalAsset = await fetch(base + '/assets/' + image.src.slice('bogen-asset:'.length)).then(r => { if (!r.ok) throw Error('Missing fixture asset'); return r.arrayBuffer(); });
  await stop();
  mkdirSync(join(home, 'personal-skills'), { recursive: true }); writeFileSync(join(home, 'personal-skills/owner-note.md'), 'Owner guidance is part of the whole-folder backup.');
  const before = hashes(home), backup = join(out, 'synthetic-data-backup.tar.gz');
  if (existsSync(backup)) throw new Error('Evidence destination contains a backup already.');
  run('tar', ['-czf', backup, '-C', home, '.']); execFileSync('chmod', ['600', backup]);
  mkdirSync(restored); run('tar', ['-xzf', backup, '-C', restored]);
  if (JSON.stringify(before) !== JSON.stringify(hashes(restored))) throw new Error('Backup/restore byte mismatch');
  run('npm', ['uninstall', '--global', '--prefix', prefix, '--no-fund', '--no-audit', 'bogen-design']);
  if (existsSync(join(prefix, 'bin/bogen'))) throw new Error('Uninstall left the CLI');
  if (JSON.stringify(before) !== JSON.stringify(hashes(home))) throw new Error('Uninstall changed documents');
  run('npm', ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', tarball]);
  await start(restored);
  const opened = await call('file_open', { file_id: file.id });
  const book = await call('brand_book_get', { brand_id: brand.id, chapter: 'strategy' });
  const branches = await call('design_branch_list', { file_id: file.id });
  const commits = await call('commit_list', { file_id: file.id });
  const asset = await fetch(base + '/assets/' + image.src.slice('bogen-asset:'.length)).then(r => r.arrayBuffer());
  if (book.chapter.status !== 'draft' || !book.chapter.questions || sha(Buffer.from(asset)) !== sha(Buffer.from(originalAsset))) throw new Error('Restored semantic state differs');
  const text = JSON.stringify({ branches, commits }); if (!text.includes('Unmerged alternative') || !text.includes('Recovery checkpoint')) throw new Error('Branches/history missing after restore');
  await stop();
  const result = { passed: true, version, packageSha256: sha(readFileSync(tarball)), backupSha256: sha(readFileSync(backup)), fileId: file.id, brandId: brand.id, restoredFiles: Object.keys(before).length, wholeFolderByteMatchBeforeOpen: true, uninstallPreservedDocuments: true, bookDraftAndQuestionsPreserved: true, unmergedBranchAndHistoryPreserved: true, assetSha256: sha(Buffer.from(asset)), scope: 'Actual npm tarball, temporary prefix, stopped-folder backup/restore, uninstall/reinstall. No host desktop/plugin/service integration.' };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await stop(); writeFileSync(join(out, 'server.log'), log); rmSync(work, { recursive: true, force: true }); }
