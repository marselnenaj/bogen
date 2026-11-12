import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
it('recovers the same Ed25519 identity from an authenticated encrypted copy without printing secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-key-recovery-'));
  const key = join(dir, 'key.pem'), encrypted = join(dir, 'encrypted.json'), code = join(dir, 'code.txt'), restored = join(dir, 'restored.pem');
  const run = (...args: string[]) => execFileSync(process.execPath, ['scripts/release-key-backup.mjs', ...args], { encoding: 'utf8' });
  try {
    execFileSync(process.execPath, ['scripts/release-keygen.mjs', key]);
    const result = run('create', key, encrypted, code);
    expect(JSON.parse(result).verified).toBe(true);
    expect(result).not.toContain(readFileSync(code, 'utf8').trim());
    expect(readFileSync(encrypted, 'utf8')).not.toContain('PRIVATE KEY');
    expect(statSync(encrypted).mode & 0o777).toBe(0o600);
    expect(statSync(code).mode & 0o777).toBe(0o600);
    run('restore', encrypted, code, restored);
    expect(readFileSync(restored)).toEqual(readFileSync(key));
    const verified = JSON.parse(run('verify', encrypted, code));
    expect(verified.publicKey).toBe(JSON.parse(result).publicKey);
    expect(() => run('create', key, encrypted, code)).toThrow();
    const wrong = join(dir, 'wrong-code'); writeFileSync(wrong, 'wrong', { mode: 0o600 });
    expect(() => run('verify', encrypted, wrong)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
