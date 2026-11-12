import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkSignature, sha256, trustedKeys } from './release-key.ts';
import { errorMessage } from './util.ts';

/**
 * `bogen verify <file>`: checks a release file against its `.sha256` and its detached Ed25519 `.sig` with the
 * release keys built into this program, the check `bogen update apply` makes before it installs. A provenance
 * statement is also checked against the files it lists that lie beside it, and an SBOM against the package it
 * describes, when that is there too.
 */

const FILE_LIMIT = 512 * 1024 * 1024;
const SMALL_LIMIT = 4096;
const STATEMENT = 'https://in-toto.io/Statement/v1';

type State = 'ok' | 'absent' | 'mismatch' | 'unreadable';
export interface Subject { name: string; sha256: string; state: State | 'invalid' }
export interface VerifyReport {
  file: string;
  size: number;
  sha256: string;
  checksum: { state: State; path: string; expected?: string; reason?: string };
  signature: { state: 'ok' | 'missing' | 'invalid' | 'no_key'; path: string; key?: 'current' | 'next'; reason?: string };
  provenance?: { ref: string; commit: string; builtAt: string; subjects: Subject[] };
  sbom?: { specVersion: string; components: number; package?: Subject };
  verified: boolean;
}

function readLimited(path: string, limit: number): Buffer {
  const size = statSync(path).size;
  if (size > limit) throw new Error(`${path} is larger than ${limit} bytes`);
  return readFileSync(path);
}

/** Only a plain file name beside the checked file is looked at, never a path. */
function besideFile(dir: string, name: string, expected: string): Subject {
  const plain = /^[\w.+-]+$/.test(name) && name !== '.' && name !== '..';
  if (!plain) return { name, sha256: expected, state: 'invalid' };
  const path = join(dir, name);
  if (!existsSync(path)) return { name, sha256: expected, state: 'absent' };
  try {
    return { name, sha256: expected, state: sha256(readLimited(path, FILE_LIMIT)) === expected ? 'ok' : 'mismatch' };
  } catch {
    return { name, sha256: expected, state: 'unreadable' };
  }
}

function provenanceOf(file: string, data: Buffer): VerifyReport['provenance'] | undefined {
  let statement: any;
  try {
    statement = JSON.parse(data.toString('utf8'));
  } catch {
    return undefined;
  }
  if (statement?._type !== STATEMENT) return undefined;
  const dir = dirname(file);
  const subjects: Subject[] = (Array.isArray(statement.subject) ? statement.subject : [])
    .map((s: any) => besideFile(dir, String(s?.name ?? ''), String(s?.digest?.sha256 ?? '').toLowerCase()));
  const definition = statement.predicate?.buildDefinition ?? {};
  const commit = (definition.resolvedDependencies ?? []).map((d: any) => d?.digest?.gitCommit).find(Boolean) ?? '';
  return { ref: String(definition.externalParameters?.ref ?? ''), commit: String(commit), builtAt: String(statement.predicate?.runDetails?.metadata?.startedOn ?? ''), subjects };
}

function sbomOf(file: string, data: Buffer): VerifyReport['sbom'] | undefined {
  let bom: any;
  try {
    bom = JSON.parse(data.toString('utf8'));
  } catch {
    return undefined;
  }
  if (bom?.bomFormat !== 'CycloneDX') return undefined;
  const main = bom.metadata?.component;
  const hash = (main?.hashes ?? []).find((h: any) => h?.alg === 'SHA-256')?.content;
  const name = main?.properties?.find((p: any) => p?.name === 'bogen:file')?.value;
  return {
    specVersion: String(bom.specVersion ?? ''),
    components: Array.isArray(bom.components) ? bom.components.length : 0,
    ...(typeof name === 'string' && typeof hash === 'string' ? { package: besideFile(dirname(file), name, hash.toLowerCase()) } : {}),
  };
}

export function verifyFile(file: string, options: { sig?: string; sha256?: string } = {}, keys = trustedKeys()): VerifyReport {
  const data = readLimited(file, FILE_LIMIT);
  const actual = sha256(data);
  const checksumPath = options.sha256 ?? `${file}.sha256`;
  let checksum: VerifyReport['checksum'];
  if (!options.sha256 && !existsSync(checksumPath)) checksum = { state: 'absent', path: checksumPath };
  else {
    try {
      const expected = (readLimited(checksumPath, SMALL_LIMIT).toString('utf8').trim().split(/\s+/)[0] ?? '').toLowerCase();
      checksum = { state: expected === actual ? 'ok' : 'mismatch', path: checksumPath, expected };
    } catch (e) {
      checksum = { state: 'unreadable', path: checksumPath, reason: errorMessage(e) };
    }
  }
  const signaturePath = options.sig ?? `${file}.sig`;
  let signature: VerifyReport['signature'];
  if (!keys.length) signature = { state: 'no_key', path: signaturePath, reason: 'this build of Bogen has no release key' };
  else {
    let bytes: Buffer | null = null;
    try {
      bytes = readLimited(signaturePath, SMALL_LIMIT);
    } catch (e) {
      signature = { state: 'missing', path: signaturePath, reason: errorMessage(e) };
    }
    if (bytes) {
      const result = checkSignature(keys, data, bytes);
      signature = result.ok ? { state: 'ok', path: signaturePath, key: result.key === 0 ? 'current' : 'next' } : { state: 'invalid', path: signaturePath, reason: result.reason };
    }
  }
  const report: VerifyReport = { file, size: data.length, sha256: actual, checksum, signature: signature!, verified: false };
  const provenance = provenanceOf(file, data);
  if (provenance) report.provenance = provenance;
  const sbom = provenance ? undefined : sbomOf(file, data);
  if (sbom) report.sbom = sbom;
  report.verified = (checksum.state === 'ok' || checksum.state === 'absent') && report.signature.state === 'ok'
    && !provenance?.subjects.some((s) => s.state === 'mismatch' || s.state === 'unreadable')
    && sbom?.package?.state !== 'mismatch';
  return report;
}

export function reportText(r: VerifyReport): string {
  const lines = [r.file];
  const c = r.checksum;
  lines.push(c.state === 'ok' ? `  SHA-256     ok        ${r.sha256}`
    : c.state === 'absent' ? `  SHA-256     -         ${r.sha256} (no ${c.path})`
      : c.state === 'mismatch' ? `  SHA-256     MISMATCH  ${r.sha256}, but ${c.path} says ${c.expected}`
        : `  SHA-256     FAILED    ${c.reason}`);
  const s = r.signature;
  lines.push(s.state === 'ok' ? `  Signature   ok        Bogen release key (${s.key}), ${s.path}` : `  Signature   FAILED    ${s.reason}`);
  if (r.provenance) {
    const p = r.provenance;
    lines.push(`  Provenance  ${p.ref || 'no ref'} at commit ${p.commit || 'unknown'}, built ${p.builtAt || 'at an unknown time'}`);
    for (const f of p.subjects) lines.push(`  File        ${{ ok: 'ok      ', absent: '-       ', mismatch: 'MISMATCH', unreadable: 'FAILED  ', invalid: 'skipped ' }[f.state]}  ${f.name}${f.state === 'absent' ? ' (not here)' : f.state === 'invalid' ? ' (not a file name)' : ''}`);
  }
  if (r.sbom) {
    lines.push(`  SBOM        CycloneDX ${r.sbom.specVersion}, ${r.sbom.components} components`);
    const p = r.sbom.package;
    if (p) lines.push(`  Package     ${p.state === 'ok' ? 'ok      ' : p.state === 'absent' ? '-       ' : 'MISMATCH'}  ${p.name}${p.state === 'absent' ? ' (not here)' : ''}`);
  }
  lines.push(r.verified ? 'Verified.' : 'Not verified: do not install this file.');
  return `${lines.join('\n')}\n`;
}

/** `bogen verify <file> [--sig <file>] [--sha256 <file>] [--json]`. Exits 0 only when the file is verified. */
export function verifyCommand(file: string | undefined, options: { sig?: string; sha256?: string; json?: boolean }, out: (text: string) => void): number {
  if (!file) {
    out('Usage: bogen verify <file> [--sig <file.sig>] [--sha256 <file.sha256>] [--json]\n');
    return 2;
  }
  let report: VerifyReport;
  try {
    report = verifyFile(file, options);
  } catch (e) {
    out(options.json ? `${JSON.stringify({ file, verified: false, error: errorMessage(e) }, null, 2)}\n` : `${file}\n  Cannot read it: ${errorMessage(e)}\nNot verified.\n`);
    return 1;
  }
  out(options.json ? `${JSON.stringify(report, null, 2)}\n` : reportText(report));
  return report.verified ? 0 : 1;
}
