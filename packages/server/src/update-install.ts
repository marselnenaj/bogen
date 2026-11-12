import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { atomicWrite, errorMessage } from './util.ts';

interface NpmInstallation { kind: 'npm'; prefix: string; dir: string }
interface SavedUpdate { schema: 1; current: string; previous: string | null }
const PACKAGE = 'bogen-design';
const exists = async (path: string) => { try { return await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
const run = (command: string, args: string[], home: string): Promise<string> => new Promise((done, reject) => {
  execFile(command, args, { env: { ...process.env, BOGEN_HOME: home, BOGEN_UPDATE_CHECK: 'off' }, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`)) : done(String(stdout).trim()));
});
async function packageVersion(dir: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (pkg.name !== PACKAGE || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) throw new Error('The staged package has an invalid name or version.');
  return pkg.version;
}
async function probe(dir: string, version: string, home: string): Promise<void> {
  if (await packageVersion(dir) !== version) throw new Error('The package version differs from the signed release.');
  const reported = await run(process.execPath, [join(dir, 'dist/cli.js'), '--version'], home);
  if (reported.split('+')[0] !== version) throw new Error(`The new CLI reports ${reported}, expected ${version}.`);
}
async function paths(install: NpmInstallation) {
  const modules = join(resolve(install.prefix), 'lib/node_modules');
  if (resolve(install.dir) !== join(modules, PACKAGE)) throw new Error('Unexpected npm installation path.');
  await mkdir(modules, { recursive: true });
  if ((await lstat(modules)).isSymbolicLink()) throw new Error('The npm modules directory is a symlink; update this installation manually.');
  const current = await exists(install.dir);
  if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error('The installed package is not an ordinary directory.');
  const bin = join(resolve(install.prefix), 'bin/bogen');
  const cli = await exists(bin);
  if (cli && (!cli.isSymbolicLink() || resolve(dirname(bin), await readlink(bin)) !== join(resolve(install.dir), 'dist/cli.js'))) throw new Error('The bogen command belongs to another installation. Nothing was replaced.');
  const backup = join(modules, '.bogen-design-previous');
  const prior = await exists(backup);
  if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) throw new Error('The update backup is not an ordinary directory.');
  return { modules, bin, backup, state: join(modules, '.bogen-update.json'), lock: join(modules, '.bogen-update-lock'), hadBin: !!cli, hadCurrent: !!current };
}
async function lock(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another update may be running. Inspect ${path}; after an interrupted update, inspect the staged/previous installation before removing this lock.`); throw e; }
}

/** npm prepares a complete dependency tree beside the installed app. A failed prepare/probe never touches it. */
export async function installVerifiedPackage(install: NpmInstallation, tarball: string, version: string, npm = 'npm', log: (line: string) => void = () => {}): Promise<{ previous: string | null }> {
  const p = await paths(install); await lock(p.lock);
  let stage = '', moved = false, promoted = false, priorMoved = false, linked = false, preserve = false;
  try {
    stage = await mkdtemp(join(p.modules, '.bogen-stage-'));
    const prefix = join(stage, 'prefix'), candidate = join(prefix, 'lib/node_modules', PACKAGE), testHome = join(stage, 'probe-home');
    log('Preparing the verified package without changing the installed app');
    await run(npm, ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', tarball], testHome);
    await probe(candidate, version, testHome);
    const previous = p.hadCurrent ? await packageVersion(install.dir) : null;
    try {
      if (await exists(p.backup)) { await rename(p.backup, join(stage, 'older-backup')); priorMoved = true; }
      if (p.hadCurrent) { await rename(install.dir, p.backup); moved = true; }
      await rename(candidate, install.dir); promoted = true;
      await probe(install.dir, version, testHome);
      if (!p.hadBin) { await mkdir(dirname(p.bin), { recursive: true }); await symlink(relative(dirname(p.bin), join(install.dir, 'dist/cli.js')), p.bin); linked = true; }
      await atomicWrite(p.state, JSON.stringify({ schema: 1, current: version, previous } satisfies SavedUpdate) + '\n', 0o600);
    } catch (error) {
      try {
        if (linked) await rm(p.bin);
        if (promoted) await rename(install.dir, join(stage, 'rejected-package'));
        if (moved) await rename(p.backup, install.dir);
        if (priorMoved) await rename(join(stage, 'older-backup'), p.backup);
      } catch (recovery) { preserve = true; throw new Error(`Update failed (${errorMessage(error)}); recovery also failed (${errorMessage(recovery)}). Keep ${stage} and ${p.backup} for recovery.`); }
      throw new Error(`Update failed; the previous installation was preserved: ${errorMessage(error)}`);
    }
    log(previous ? `Previous Bogen ${previous} preserved. Run bogen update rollback to return to it.` : 'Installed the verified package.');
    return { previous };
  } finally {
    if (stage && !preserve) await rm(stage, { recursive: true, force: true });
    if (!preserve) await rm(p.lock, { recursive: true, force: true });
  }
}

/** Explicit local recovery. Does not download, change documents, start a service or run itself automatically. */
export async function rollbackUpdate(install: { kind: string; prefix?: string; dir: string }): Promise<{ state: 'rolled_back'; from: string; to: string }> {
  if (install.kind !== 'npm' || !install.prefix) throw new Error('Rollback is available only for an npm installation updated by Bogen.');
  const p = await paths(install as NpmInstallation); await lock(p.lock);
  let stage = '', moved = false, swapped = false, preserve = false;
  try {
    const state = JSON.parse(await readFile(p.state, 'utf8')) as SavedUpdate;
    if (state.schema !== 1 || !state.previous || !(await exists(p.backup))) throw new Error('No previous Bogen installation is available.');
    stage = await mkdtemp(join(p.modules, '.bogen-rollback-'));
    await probe(p.backup, state.previous, join(stage, 'probe-home'));
    if (await packageVersion(install.dir) !== state.current) throw new Error('This installation changed outside the updater; inspect it before rolling back.');
    await rename(install.dir, join(stage, 'current')); moved = true;
    try {
      await rename(p.backup, install.dir); swapped = true;
      await probe(install.dir, state.previous, join(stage, 'probe-home'));
      await atomicWrite(p.state, JSON.stringify({ schema: 1, current: state.previous, previous: null } satisfies SavedUpdate) + '\n', 0o600);
    } catch (error) {
      try { if (swapped) await rename(install.dir, p.backup); if (moved) await rename(join(stage, 'current'), install.dir); }
      catch (recovery) { preserve = true; throw new Error(`Rollback failed (${errorMessage(error)}); recovery also failed (${errorMessage(recovery)}). Keep ${stage} for recovery.`); }
      throw error;
    }
    return { state: 'rolled_back', from: state.current, to: state.previous };
  } finally {
    if (stage && !preserve) await rm(stage, { recursive: true, force: true });
    if (!preserve) await rm(p.lock, { recursive: true, force: true });
  }
}
