import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bogen-doc-links-')); roots.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'docs'));
  cpSync(new URL('../../../scripts/check-doc-links.mjs', import.meta.url), join(root, 'scripts/check-doc-links.mjs'));
  writeFileSync(join(root, 'README.md'), '[Guide](docs/guide.md#start)\n');
  writeFileSync(join(root, 'docs/guide.md'), '# Start\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', 'README.md', 'docs/guide.md'], { cwd: root });
  return { root, run: (...args: string[]) => spawnSync(process.execPath, ['scripts/check-doc-links.mjs', ...args], { cwd: root, encoding: 'utf8' }) };
}
it('checks release inputs without treating untracked evidence as shipped documentation', () => {
  const f = fixture(); writeFileSync(join(f.root, 'local-notes.md'), '[Old log](missing.log)\n');
  expect(f.run().status).toBe(0);
  const expanded = f.run('--include-untracked'); expect(expanded.status).toBe(1); expect(expanded.stderr).toContain('local-notes.md: missing.log does not exist');
});
it('still fails a broken tracked document and an invalid tracked anchor', () => {
  const f = fixture(); writeFileSync(join(f.root, 'docs/guide.md'), '# Renamed\n');
  expect(f.run().stderr).toContain('has no heading "#start"');
  writeFileSync(join(f.root, 'README.md'), '[Guide](missing.md)\n');
  expect(f.run().status).toBe(1); expect(f.run().stderr).toContain('missing.md does not exist');
});
it('rejects unknown options rather than silently narrowing a check', () => {
  const f = fixture(); expect(f.run('--skip').status).toBe(2);
});
