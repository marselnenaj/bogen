import { execFile } from 'node:child_process';
import { sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSignature, rawKey, sha256 } from '../src/release-key.ts';
import { verifyFile } from '../src/release-verify.ts';
import { checksumInto, signInto, throwawayKey } from './release-helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env) => new Promise<{ code: number; out: string }>((done) => {
  execFile(command, args, { cwd: ROOT, env, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, out: `${stdout}${stderr}` }));
});

describe('release signatures and bogen verify', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-release-'));
  const key = throwawayKey();
  const other = throwawayKey();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const release = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    checksumInto(path);
    signInto(path, key.privateKey);
    return path;
  };

  it('verifies a file with its checksum and signature, and says which key signed it', () => {
    const file = release('bogen-design-9.0.0.tgz', 'the package');
    const report = verifyFile(file, {}, [key.raw]);
    expect(report).toMatchObject({ verified: true, checksum: { state: 'ok' }, signature: { state: 'ok', key: 'current' } });
    expect(verifyFile(file, {}, [other.raw, key.raw]).signature.key).toBe('next');
  });

  it('refuses a changed file, a signature by another key, a missing signature and a build without a key', () => {
    const file = release('changed.tgz', 'original');
    writeFileSync(file, 'changed');
    const changed = verifyFile(file, {}, [key.raw]);
    expect(changed.verified).toBe(false);
    expect(changed.checksum.state).toBe('mismatch');
    expect(changed.signature.state).toBe('invalid');

    const foreign = release('foreign.tgz', 'by someone else');
    signInto(foreign, other.privateKey);
    expect(verifyFile(foreign, {}, [key.raw])).toMatchObject({ verified: false, signature: { state: 'invalid' } });

    const bare = join(dir, 'bare.tgz');
    writeFileSync(bare, 'no signature');
    expect(verifyFile(bare, {}, [key.raw])).toMatchObject({ verified: false, checksum: { state: 'absent' }, signature: { state: 'missing' } });
    expect(verifyFile(release('keyless.tgz', 'x'), {}, [])).toMatchObject({ verified: false, signature: { state: 'no_key' } });
  });

  it('accepts only a well-formed Ed25519 signature', () => {
    const data = Buffer.from('message');
    expect(checkSignature([key.raw], data, 'not base64 at all!')).toMatchObject({ ok: false });
    expect(checkSignature([key.raw], data, Buffer.alloc(64).toString('base64'))).toMatchObject({ ok: false });
    expect(checkSignature([key.raw], data, sign(null, data, key.privateKey).toString('base64'))).toEqual({ ok: true, key: 0 });
  });

  it('checks each file a provenance lists, beside it', () => {
    const pkg = release('bogen-design-9.1.0.tgz', 'package 9.1.0');
    const sbom = release('bogen-design-9.1.0.cdx.json', JSON.stringify({
      bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ name: 'yjs' }, { name: 'ws' }],
      metadata: { component: { hashes: [{ alg: 'SHA-256', content: sha256(readFileSync(pkg)) }], properties: [{ name: 'bogen:file', value: 'bogen-design-9.1.0.tgz' }] } },
    }));
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [pkg, sbom].map((p) => ({ name: p.split('/').pop(), digest: { sha256: sha256(readFileSync(p)) } })).concat([{ name: 'gone.tgz', digest: { sha256: '0'.repeat(64) } }, { name: '../escape', digest: { sha256: '0'.repeat(64) } }]),
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: { buildDefinition: { externalParameters: { ref: 'refs/tags/v9.1.0' }, resolvedDependencies: [{ digest: { gitCommit: 'abc123' } }] }, runDetails: { metadata: { startedOn: '2026-11-02T10:00:00Z' } } },
    };
    const provenance = release('bogen-design-9.1.0-provenance.intoto.json', JSON.stringify(statement));
    const report = verifyFile(provenance, {}, [key.raw]);
    expect(report.verified).toBe(true);
    expect(report.provenance).toMatchObject({ ref: 'refs/tags/v9.1.0', commit: 'abc123' });
    expect(report.provenance!.subjects.map((s) => s.state)).toEqual(['ok', 'ok', 'absent', 'invalid']);

    const bom = verifyFile(sbom, {}, [key.raw]);
    expect(bom.sbom).toMatchObject({ specVersion: '1.6', components: 2, package: { state: 'ok' } });

    writeFileSync(pkg, 'swapped package');
    expect(verifyFile(provenance, {}, [key.raw]).verified).toBe(false);
    expect(verifyFile(sbom, {}, [key.raw]).verified).toBe(false);
  });

  it('runs as bogen verify, from source with a test key, and exits 1 when not verified', async () => {
    const file = release('cli.tgz', 'for the command line');
    const env = { ...process.env, BOGEN_RELEASE_TEST_PUBLIC_KEY: key.publicKey };
    const ok = await run('npx', ['tsx', 'packages/server/src/cli.ts', 'verify', file], env);
    expect(ok.out).toContain('Verified.');
    expect(ok.code).toBe(0);
    const json = await run('npx', ['tsx', 'packages/server/src/cli.ts', 'verify', file, '--json'], { ...env, BOGEN_RELEASE_TEST_PUBLIC_KEY: other.publicKey });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ verified: false, signature: { state: 'invalid' } });
  }, 60_000);
});

describe('release scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-release-scripts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('makes a key pair owner-only, prints only the public key, and never overwrites or writes into the repository', async () => {
    const path = join(dir, 'keys', 'release.pem');
    const made = await run('node', ['scripts/release-keygen.mjs', path]);
    expect(made.code).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const pem = readFileSync(path, 'utf8');
    expect(pem).toContain('BEGIN PRIVATE KEY');
    expect(made.out).not.toContain(pem.split('\n')[1]);
    const printed = /Public key: (\S+)/.exec(made.out)?.[1];
    expect(rawKey(printed!)).not.toBeNull();

    expect((await run('node', ['scripts/release-keygen.mjs', path])).out).toContain('never overwrites');
    expect(readFileSync(path, 'utf8')).toBe(pem);
    const inside = await run('node', ['scripts/release-keygen.mjs', join(ROOT, 'release', 'key.pem')]);
    expect(inside.code).toBe(1);
    expect(inside.out).toContain('outside the repository');
  });

  it('refuses an outside path whose parent symlink points into the repository', async () => {
    const alias = join(dir, 'repository-alias'); symlinkSync(ROOT, alias, 'dir');
    const target = join(ROOT, 'release', 'symlink-guard-test.pem');
    try {
      const made = await run('node', ['scripts/release-keygen.mjs', join(alias, 'release', 'symlink-guard-test.pem')]);
      expect(made.code).toBe(1); expect(made.out).toContain('outside the repository');
      expect(existsSync(target)).toBe(false);
    } finally { rmSync(target, { force: true }); }
  });

  it("extracts one version's notes with links into the tag", async () => {
    const notes = await run('node', ['scripts/changelog-notes.mjs', '0.1.0']);
    expect(notes.code).toBe(0);
    expect(notes.out).toContain('The first version.');
    expect(notes.out).not.toMatch(/^## /m);
    expect(notes.out).toContain('https://github.com/marselnenaj/bogen/blob/v0.1.0/docs/guide/canvas.md');
    expect((await run('node', ['scripts/changelog-notes.mjs', '9.9.9'])).code).toBe(1);
  });

  it('finds one version in every file that states it', async () => {
    const checked = await run('node', ['scripts/set-version.mjs', '--check']);
    expect(checked.code).toBe(0);
    expect(checked.out).toMatch(/Every file says \d+\.\d+\.\d+/);
  });
});
