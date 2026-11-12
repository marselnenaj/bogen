import { rollbackUpdate } from '../src/update-install.ts';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/release-key.ts';
import { applyUpdate, checkDue, checkForUpdate, compareVersions, installation, parseManifest, readCheck, releaseSource, updateSettings, UpdateWatch } from '../src/updates.ts';
import { VERSION } from '../src/version.ts';
import { startServer } from './helpers.ts';
import { signInto, throwawayKey } from './release-helpers.ts';

const ROOT = resolve(import.meta.dirname, '../../..');

/**
 * A stand-in for GitHub's release assets: a folder served over loopback HTTP, the way `latest/download/<name>`
 * answers. It records each request with its headers, so the tests can say exactly what a check sends.
 */
class FakeReleases {
  readonly dir = mkdtempSync(join(tmpdir(), 'bogen-releases-'));
  readonly requests: { url: string; headers: Record<string, unknown> }[] = [];
  private server: Server = createServer((req, res) => {
    this.requests.push({ url: req.url ?? '', headers: { ...req.headers } });
    const name = decodeURIComponent((req.url ?? '').replace(/^\/download\//, ''));
    const path = join(this.dir, name);
    if (!/^[\w.+-]+$/.test(name) || !existsSync(path)) {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(readFileSync(path));
  });
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((done) => this.server.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/download`;
  }

  async stop(): Promise<void> {
    await new Promise((done) => this.server.close(done));
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** A release with a real npm package of `version` that installs offline: no dependencies. */
  publish(version: string, key: ReturnType<typeof throwawayKey>, options: { tamper?: boolean; badActivation?: boolean } = {}): void {
    for (const f of execFileSync('ls', [this.dir], { encoding: 'utf8' }).split('\n').filter(Boolean)) rmSync(join(this.dir, f));
    const pkg = mkdtempSync(join(tmpdir(), 'bogen-fake-package-'));
    mkdirSync(join(pkg, 'dist'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'bogen-design', version, type: 'module', bin: { bogen: 'dist/cli.js' }, files: ['dist'] }));
    writeFileSync(join(pkg, 'dist', 'cli.js'), `#!/usr/bin/env node\n${options.badActivation ? "if (!import.meta.url.includes('.bogen-stage-')) throw Error('activation failed');" : ''}\nconsole.log('${version}');\n`);
    const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', this.dir], { cwd: pkg, encoding: 'utf8' }).trim().split('\n').pop()!;
    rmSync(pkg, { recursive: true, force: true });
    const tarball = join(this.dir, file);
    signInto(tarball, key.privateKey);
    if (options.tamper) writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from('extra')]));
    const bytes = readFileSync(tarball);
    const manifest = join(this.dir, 'bogen-release.json');
    writeFileSync(manifest, JSON.stringify({ schema: 1, name: 'bogen-design', version, tag: `v${version}`, package: { file, sha256: sha256(bytes), size: bytes.length }, notes: `https://github.com/marselnenaj/bogen/releases/tag/v${version}` }));
    signInto(manifest, key.privateKey);
  }
}

describe('update checks against a local release server', () => {
  const releases = new FakeReleases();
  const key = throwawayKey();
  const home = mkdtempSync(join(tmpdir(), 'bogen-update-home-'));

  beforeAll(() => releases.start());
  afterAll(async () => {
    await releases.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('orders versions the way semantic versions are ordered', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0+abc123')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0);
    expect(compareVersions('nonsense', '1.0.0')).toBeNaN();
  });

  it('takes the release source only as https, or plain http to this machine', () => {
    expect(() => releaseSource('http://example.com/releases')).toThrow(/https/);
    expect(() => releaseSource('https://user:pw@example.com/x')).toThrow(/credentials/);
    expect(releaseSource('http://127.0.0.1:9/x').host).toBe('127.0.0.1:9');
    expect(updateSettings(home, { BOGEN_UPDATE_URL: 'https://mirror.example/bogen/' })).toMatchObject({ url: 'https://mirror.example/bogen', urlFrom: 'environment', check: true });
    expect(updateSettings(home, { BOGEN_UPDATE_CHECK: 'off' })).toMatchObject({ check: false, forcedOff: true });
  });

  it('finds a newer release with one GET of the manifest, which carries nothing about this installation', async () => {
    releases.publish('9.0.0', key);
    releases.requests.length = 0;
    const result = await checkForUpdate({ home, url: releases.url, current: '0.1.0' });
    expect(result).toMatchObject({ state: 'update_available', latest: '9.0.0', notes: 'https://github.com/marselnenaj/bogen/releases/tag/v9.0.0' });
    expect(releases.requests).toHaveLength(1);
    const [request] = releases.requests;
    expect(request!.url).toBe('/download/bogen-release.json');
    expect(request!.headers['user-agent']).toBe('bogen');
    expect(request!.headers.cookie).toBeUndefined();
    expect(request!.headers.authorization).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('0.1.0');
    expect(readCheck(home)).toMatchObject({ state: 'update_available', latest: '9.0.0' });
  });

  it('says up to date, no release, or offline, and asks again sooner after a failure', async () => {
    releases.publish('0.1.0', key);
    expect(await checkForUpdate({ home, url: releases.url, current: '0.1.0' })).toMatchObject({ state: 'up_to_date' });
    rmSync(join(releases.dir, 'bogen-release.json'));
    expect(await checkForUpdate({ home, url: releases.url, current: '0.1.0' })).toMatchObject({ state: 'no_release' });
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const port = (closed.address() as { port: number }).port;
    await new Promise((done) => closed.close(done));
    const offline = await checkForUpdate({ home, url: `http://127.0.0.1:${port}/download`, current: '0.1.0', now: 1_000 });
    expect(offline.state).toBe('offline');
    expect(checkDue(offline, offline.url, 1_000 + 3 * 3600_000)).toBe(false);
    expect(checkDue(offline, offline.url, 1_000 + 7 * 3600_000)).toBe(true);
    expect(checkDue({ ...offline, state: 'up_to_date' }, offline.url, 1_000 + 7 * 3600_000)).toBe(false);
    expect(checkDue({ ...offline, state: 'up_to_date' }, 'https://elsewhere.example', 1_001)).toBe(true);
  });

  it('refuses a manifest that does not describe a Bogen release', () => {
    expect(() => parseManifest(Buffer.from(JSON.stringify({ schema: 1, name: 'other', version: '1.0.0' })))).toThrow(/does not describe/);
    expect(() => parseManifest(Buffer.from(JSON.stringify({ schema: 1, name: 'bogen-design', version: '1.0.0', package: { file: '../../evil.tgz', sha256: '0'.repeat(64), size: 1 } })))).toThrow(/does not describe/);
  });

  it('installs a verified package into the npm prefix, and refuses one whose signature does not hold', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'bogen-update-prefix-'));
    const install = { kind: 'npm' as const, prefix, dir: join(prefix, 'lib', 'node_modules', 'bogen-design') };
    const installed = () => {
      const file = join(prefix, 'lib', 'node_modules', 'bogen-design', 'package.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version as string : null;
    };
    try {
      releases.publish('9.1.0', key, { tamper: true });
      await expect(applyUpdate({ home, url: releases.url, keys: [key.raw], install, current: '0.1.0' })).rejects.toThrow(/Refused the update: the package does not match the digest|Refused the update: the package:/);
      expect(installed()).toBeNull();

      releases.publish('9.1.0', key);
      const stranger = throwawayKey();
      await expect(applyUpdate({ home, url: releases.url, keys: [stranger.raw], install, current: '0.1.0' })).rejects.toThrow(/Refused the update: the release manifest/);
      expect(installed()).toBeNull();

      // The manifest is signed, the package re-signed by another key: still refused.
      signInto(join(releases.dir, 'bogen-design-9.1.0.tgz'), stranger.privateKey);
      await expect(applyUpdate({ home, url: releases.url, keys: [key.raw], install, current: '0.1.0' })).rejects.toThrow(/Refused the update: the package: the signature does not match/);
      expect(installed()).toBeNull();

      releases.publish('9.1.0', key);
      const lines: string[] = [];
      const result = await applyUpdate({ home, url: releases.url, keys: [key.raw], install, current: '0.1.0', log: (l) => lines.push(l) });
      expect(result).toMatchObject({ state: 'installed', from: '0.1.0', to: '9.1.0' });
      expect(installed()).toBe('9.1.0');
      expect(execFileSync(join(prefix, 'bin', 'bogen'), { encoding: 'utf8' }).trim()).toBe('9.1.0');
      expect(lines.some((l) => l.startsWith('Verified bogen-design-9.1.0.tgz'))).toBe(true);

      expect(await applyUpdate({ home, url: releases.url, keys: [key.raw], install, current: '9.1.0' })).toMatchObject({ state: 'up_to_date' });
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it('preserves the app and its previous backup after failed activation, then rolls back without changing documents', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'bogen-update-recovery-'));
    const install = { kind: 'npm' as const, prefix, dir: join(prefix, 'lib/node_modules/bogen-design') };
    const document = join(home, 'release-recovery-user-document');
    writeFileSync(document, 'Personal document remains unchanged');
    const apply = () => applyUpdate({ home, url: releases.url, keys: [key.raw], install, current: '0.1.0' });
    const version = () => JSON.parse(readFileSync(join(install.dir, 'package.json'), 'utf8')).version;
    try {
      releases.publish('9.1.0', key); await apply();
      releases.publish('9.2.0', key); await apply(); expect(version()).toBe('9.2.0');
      releases.publish('9.3.0', key, { badActivation: true });
      await expect(apply()).rejects.toThrow('previous installation was preserved');
      expect(version()).toBe('9.2.0');
      expect(execFileSync(join(prefix, 'bin/bogen'), { encoding: 'utf8' }).trim()).toBe('9.2.0');
      expect(await rollbackUpdate(install)).toMatchObject({ state: 'rolled_back', from: '9.2.0', to: '9.1.0' });
      expect(version()).toBe('9.1.0');
      expect(execFileSync(join(prefix, 'bin/bogen'), { encoding: 'utf8' }).trim()).toBe('9.1.0');
      expect(readFileSync(document, 'utf8')).toBe('Personal document remains unchanged');
      await expect(rollbackUpdate(install)).rejects.toThrow('No previous');
    } finally { rmSync(prefix, { recursive: true, force: true }); rmSync(document, { force: true }); }
  }, 120_000);

  it('updates only an npm install, and says how to update the others', async () => {
    await expect(applyUpdate({ home, url: releases.url, keys: [key.raw], install: { kind: 'checkout', dir: ROOT } })).rejects.toThrow(/git pull/);
    await expect(applyUpdate({ home, url: releases.url, keys: [key.raw], install: { kind: 'system', prefix: '/usr', dir: '/usr/lib/node_modules/bogen-design' } })).rejects.toThrow(/system package/);
    await expect(applyUpdate({ home, url: releases.url, keys: [], install: { kind: 'npm', prefix: home, dir: home } })).rejects.toThrow(/no release key/);
    expect(installation(join(ROOT, 'packages/server/src/updates.ts'))).toMatchObject({ kind: 'checkout' });
    expect(installation('/opt/node/lib/node_modules/bogen-design/dist/cli.js').kind).toMatch(/npm|system/);
  });

  it('tells the editor and the bar widget through /api/status, and stops when checks are turned off', async () => {
    const own = mkdtempSync(join(tmpdir(), 'bogen-update-status-'));
    releases.publish('99.0.0', key);
    await checkForUpdate({ home: own, url: releases.url });
    const h = await startServer({}, own);
    try {
      const status = await (await fetch(`${h.base}/api/status`)).json() as { update: { version: string; current: string; how: string } | null };
      expect(status.update).toMatchObject({ version: '99.0.0', current: VERSION });
      expect(status.update!.how).toContain('git pull');
      writeFileSync(join(own, 'update-settings.json'), JSON.stringify({ check: false }));
      expect(new UpdateWatch(own).note()).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  it('checks from the server only when due, and never when turned off', async () => {
    const own = mkdtempSync(join(tmpdir(), 'bogen-update-watch-'));
    try {
      releases.publish('9.2.0', key);
      const env = { BOGEN_UPDATE_URL: releases.url };
      releases.requests.length = 0;
      await new UpdateWatch(own, { env }).tick();
      await new UpdateWatch(own, { env }).tick();
      expect(releases.requests).toHaveLength(1);
      writeFileSync(join(own, 'update-settings.json'), JSON.stringify({ check: false }));
      rmSync(join(own, 'update-check.json'));
      await new UpdateWatch(own, { env }).tick();
      expect(releases.requests).toHaveLength(1);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('runs as bogen update check and update off, from source', async () => {
    releases.publish('9.3.0', key);
    const own = mkdtempSync(join(tmpdir(), 'bogen-update-cli-'));
    const env = { ...process.env, BOGEN_HOME: own, BOGEN_UPDATE_URL: releases.url, BOGEN_UPDATE_CHECK: '' };
    const cli = (...args: string[]) => new Promise<{ code: number; out: string }>((done) => {
      execFile('npx', ['tsx', 'packages/server/src/cli.ts', 'update', ...args], { cwd: ROOT, env, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, out: `${stdout}${stderr}` }));
    });
    try {
      const checked = await cli('check', '--json');
      expect(checked.code).toBe(0);
      expect(JSON.parse(checked.out)).toMatchObject({ state: 'update_available', latest: '9.3.0' });
      expect((await cli('off')).out).toContain('no longer checks');
      expect(JSON.parse(readFileSync(join(own, 'update-settings.json'), 'utf8'))).toEqual({ check: false });
      expect((await cli()).out).toContain('Daily check: off');
      const refused = await cli('apply');
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('checkout');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  }, 60_000);
});
