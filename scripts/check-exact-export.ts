#!/usr/bin/env -S node --import tsx
// Builds the Exact export of the test designs (packages/core/test/fixtures/exact-designs.ts) with Exact's own
// compiler, and says what it reports. Optional: Bogen's tests never need Exact.
//
//   node --import tsx scripts/check-exact-export.ts [--contract <path to contract>] [--out <dir>] [--verify]
//
// The compiler is a build of github.com/expo/exact (cargo build --release -p contract). It is found through
// --contract, then $EXACT_CONTRACT, then `contract` on PATH; with none the script says so and exits 0.
// For each design it writes the app to <dir>/<design>/ (a temporary folder unless --out), then runs
// `contract build app.contract --json`, `contract fmt --check` on the .contract files and, with app.tamber,
// `contract tamber check` and `tamber fmt --check`. --verify also runs `contract verify --runner-only`, which runs
// app.test.contract in Exact's runner (it builds Exact's difftest crate with Cargo the first time).
// app.ts is checked by the compiler through Bun; without Bun that one check is skipped, and app.ts is type-checked
// with this repository's TypeScript against the types `contract types` writes instead.
// It exits 1 when the compiler reports an error, a file is not formatted, app.ts does not type-check or a test
// does not hold.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXACT_COMMIT, toExactApp } from '../packages/core/src/index.ts';
import { EXACT_FIXTURES } from '../packages/core/test/fixtures/exact-designs.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const contract = flag('--contract') ?? process.env.EXACT_CONTRACT ?? 'contract';
const out = flag('--out') ?? mkdtempSync(join(tmpdir(), 'bogen-exact-'));
const verify = args.includes('--verify');
const tsc = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'typescript', 'bin', 'tsc');

const probe = spawnSync(contract, ['--help'], { encoding: 'utf8' });
if (probe.error) {
  console.log(`Skipped: no Exact compiler at "${contract}". Build one from github.com/expo/exact at ${EXACT_COMMIT} and pass --contract.`);
  process.exit(0);
}

interface Diagnostic { severity: string; id: string; line: number; col: number; message: string; file?: string }
let failed = false;
for (const [name, make] of Object.entries(EXACT_FIXTURES)) {
  const { doc, root } = make();
  const app = toExactApp(doc, root);
  const dir = join(out, name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [path, text] of Object.entries(app.files)) writeFileSync(join(dir, path), text);
  // The test designs' pictures are stand-ins: a one-pixel PNG.
  for (const a of app.assets) writeFileSync(join(dir, a.path), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const run = (cmd: string[]) => spawnSync(contract, cmd, { cwd: dir, encoding: 'utf8' });

  const build = run(['build', 'app.contract', '--json']);
  let diagnostics: Diagnostic[] = [];
  try {
    diagnostics = JSON.parse(build.stdout || '[]') as Diagnostic[];
  } catch {
    console.log(`${name}: the compiler printed no JSON:\n${build.stdout}${build.stderr}`);
    failed = true;
    continue;
  }
  // The compiler checks app.ts by running Bun; a machine without Bun cannot, which says nothing about the export.
  const noBun = diagnostics.some((d) => d.id === 'analyze-ambient-api' && /No such file|not found/i.test(d.message));
  diagnostics = diagnostics.filter((d) => !(noBun && d.id === 'analyze-ambient-api'));
  let appTs = '';
  if (noBun) {
    run(['types', 'app.contract', '-o', 'app.contract.d.ts']);
    const check = spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions', 'app.ts'], { cwd: dir, encoding: 'utf8' });
    appTs = check.status === 0 ? ', app.ts type-checks (no Bun: tsc)' : ', app.ts does not type-check';
    if (check.status !== 0) {
      failed = true;
      console.log(check.stdout);
    }
  }
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity !== 'error');
  const byId = new Map<string, number>();
  for (const w of warnings) byId.set(w.id, (byId.get(w.id) ?? 0) + 1);
  const fmt = ['app.contract', 'app.test.contract'].map((f) => [f, run(['fmt', '--check', f]).status] as const).filter(([, s]) => s !== 0).map(([f]) => f);
  let tamber = '';
  if (app.files['app.tamber']) {
    const check = run(['tamber', 'check', '.']);
    const tfmt = run(['tamber', 'fmt', '.', '--check']);
    tamber = `, tamber ${check.status === 0 ? 'ok' : 'refused'}${tfmt.status === 0 ? '' : ' (not formatted)'}`;
    if (check.status !== 0 || tfmt.status !== 0) {
      failed = true;
      console.log(`${check.stdout}${check.stderr}${tfmt.stdout}${tfmt.stderr}`.trim());
    }
  }
  let tests = '';
  if (verify) {
    const v = run(['verify', 'app.contract', '--runner-only']);
    const text = `${v.stdout}${v.stderr}`;
    const broken = text.split('\n').filter((l) => /does not hold|^error/i.test(l));
    const delivered = /scripts: (\d+) tests delivered \((\d+) whole/.exec(text);
    tests = `, tests ${v.status === 0 && !broken.length ? 'hold' : 'FAIL'}${delivered ? ` (${delivered[2]} of ${delivered[1]} run whole)` : ''}`;
    if (v.status !== 0 || broken.length) {
      failed = true;
      console.log(broken.join('\n') || text.slice(-2000));
    }
  }
  if (errors.length || fmt.length) failed = true;
  console.log(`${name}: ${errors.length} errors, ${warnings.length} warnings${byId.size ? ` (${[...byId].map(([id, n]) => `${id} ${n}`).join(', ')})` : ''}${fmt.length ? `, not formatted: ${fmt.join(', ')}` : ', formatted'}${tamber}${appTs}${tests}; ${app.dropped.length} left out or approximated. ${dir}`);
  for (const e of errors) console.log(`  ${e.file ?? 'app.contract'}:${e.line}:${e.col} [${e.id}] ${e.message.slice(0, 300)}`);
}
process.exit(failed ? 1 : 0);
