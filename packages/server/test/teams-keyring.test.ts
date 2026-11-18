import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TeamStore } from '../src/teams/store.ts';
import { newEd } from '../src/teams/crypto.ts';

/**
 * Where the person key is kept. None of these tests touch the person's real keyring: they use a fake
 * `secret-tool` on PATH, or a throwaway D-Bus session with its own GNOME Keyring, no service activation and a
 * temporary home.
 */

const saved = { path: process.env.PATH, ring: process.env.BOGEN_TEAMS_KEYRING, bus: process.env.DBUS_SESSION_BUS_ADDRESS };
const restore = () => {
  process.env.PATH = saved.path;
  if (saved.ring === undefined) delete process.env.BOGEN_TEAMS_KEYRING; else process.env.BOGEN_TEAMS_KEYRING = saved.ring;
  if (saved.bus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = saved.bus;
};
const homes: string[] = [];
const home = async () => { const h = await mkdtemp(join(tmpdir(), 'bogen-keyring-')); homes.push(h); return h; };
afterEach(async () => {
  restore();
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

describe('the person key without a keyring', () => {
  it('is kept in identity.json, mode 0600, and keyStorage says file', async () => {
    process.env.BOGEN_TEAMS_KEYRING = 'off';
    const store = new TeamStore(await home());
    const id = await store.identity('Laptop');
    id.person = newEd();
    await store.saveIdentity(id);
    expect(store.keyStorage).toBe('file');
    const path = join(store.dir, 'identity.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, 'utf8')).person.priv).toBe(id.person.priv);
  });
});

describe.runIf(process.platform === 'linux')('the keyring tool never gets the secret on its command line', () => {
  it('secret-tool store reads the key from stdin, lookup prints it', async () => {
    const bin = await home();
    const log = join(bin, 'calls.log');
    const kept = join(bin, 'kept');
    // A stand-in secret-tool: records its arguments and stdin, keeps what it was given, prints it on lookup.
    await writeFile(join(bin, 'secret-tool'), `#!/bin/sh
printf '%s\\n' "ARGS $*" >> "${log}"
if [ "$1" = store ]; then cat > "${kept}"; printf 'STDIN %s\\n' "$(cat "${kept}")" >> "${log}"; exit 0; fi
if [ "$1" = lookup ] && [ -f "${kept}" ]; then cat "${kept}"; exit 0; fi
exit 1
`);
    await chmod(join(bin, 'secret-tool'), 0o755);
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BOGEN_TEAMS_KEYRING = 'on';
    const store = new TeamStore(await home());
    const id = await store.identity('Laptop');
    id.person = newEd();
    await store.saveIdentity(id);
    expect(store.keyStorage).toBe('keyring');
    const calls = await readFile(log, 'utf8');
    const secret = (await readFile(kept, 'utf8')).trim();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const argLines = calls.split('\n').filter((l) => l.startsWith('ARGS'));
    expect(argLines.length).toBeGreaterThan(0);
    for (const line of argLines) expect(line).not.toContain(secret);
    expect(calls).toContain(`STDIN ${secret}`);
    // The person key itself is not in the file any more, only sealed.
    const onDisk = JSON.parse(await readFile(join(store.dir, 'identity.json'), 'utf8'));
    expect(onDisk.person).toBeUndefined();
    expect(onDisk.sealed).toBeTruthy();
  });

  it('a keyring tool that says yes but keeps nothing leaves the key in the file', async () => {
    const bin = await home();
    await writeFile(join(bin, 'secret-tool'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
    await chmod(join(bin, 'secret-tool'), 0o755);
    process.env.PATH = `${bin}:${saved.path}`;
    process.env.BOGEN_TEAMS_KEYRING = 'on';
    const store = new TeamStore(await home());
    const id = await store.identity('Laptop');
    id.person = newEd();
    await store.saveIdentity(id);
    expect(store.keyStorage).toBe('file');
  });
});

// ---- A real Secret Service, private to this test ------------------------------------------------------------

const have = async (cmd: string) => new Promise<boolean>((resolve) => {
  const c = spawn('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  c.on('exit', (code) => resolve(code === 0));
  c.on('error', () => resolve(false));
});
const live = { ok: false, why: '', dir: '', bus: '', procs: [] as ChildProcess[] };
beforeAll(async () => {
  if (process.platform !== 'linux') { live.why = 'not Linux'; return; }
  for (const cmd of ['dbus-daemon', 'gnome-keyring-daemon', 'secret-tool', 'dbus-send']) if (!(await have(cmd))) { live.why = `${cmd} is not installed`; return; }
  live.dir = await mkdtemp(join(tmpdir(), 'bogen-secret-service-'));
  const sock = join(live.dir, 'bus');
  // No <servicedir>: nothing can be started by activation, so the person's own keyring daemon never comes up here.
  await writeFile(join(live.dir, 'bus.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${sock}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`);
  live.bus = `unix:path=${sock}`;
  const bus = spawn('dbus-daemon', [`--config-file=${join(live.dir, 'bus.conf')}`, '--nofork', '--nopidfile'], { stdio: 'ignore' });
  live.procs.push(bus);
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: live.bus, HOME: live.dir, XDG_DATA_HOME: join(live.dir, 'data'), XDG_RUNTIME_DIR: join(live.dir, 'run'), XDG_CONFIG_HOME: join(live.dir, 'config') };
  await mkdir(join(live.dir, 'run'), { mode: 0o700 });
  for (let i = 0; i < 50 && !(await stat(sock).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 50));
  const ring = spawn('gnome-keyring-daemon', ['--foreground', '--components=secrets', '--unlock'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  ring.stdin!.end('throwaway-test-password');
  live.procs.push(ring);
  for (let i = 0; i < 60; i++) {
    const owned = await new Promise<boolean>((resolve) => {
      const c = spawn('dbus-send', [`--bus=${live.bus}`, '--print-reply', '--dest=org.freedesktop.DBus', '/', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout!.on('data', (d) => { out += d; });
      c.on('exit', () => resolve(/boolean true/.test(out)));
      c.on('error', () => resolve(false));
    });
    if (owned) { live.ok = true; return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  live.why = 'the throwaway GNOME Keyring did not come up on its private bus';
}, 20_000);
afterAll(async () => {
  for (const p of live.procs) p.kill('SIGTERM');
  if (live.dir) await rm(live.dir, { recursive: true, force: true });
});

describe('with a real, throwaway Secret Service', () => {
  it('stores the sealing key, reads it back after a restart, and reports locked when it is gone', async (ctx) => {
    if (!live.ok) { console.warn(`Skipped the live keyring test: ${live.why}.`); ctx.skip(); return; }
    // Everything below talks to the private bus only.
    process.env.DBUS_SESSION_BUS_ADDRESS = live.bus;
    process.env.BOGEN_TEAMS_KEYRING = 'on';
    const h = await home();
    const store = new TeamStore(h);
    const id = await store.identity('Laptop');
    id.person = newEd();
    await store.saveIdentity(id);
    expect(store.keyStorage).toBe('keyring');
    const onDisk = JSON.parse(await readFile(join(store.dir, 'identity.json'), 'utf8'));
    expect(onDisk.person).toBeUndefined();
    // A new process reading the same home gets the person key back from the keyring.
    const again = new TeamStore(h);
    const read = await again.identity('Laptop');
    expect(again.keyStorage).toBe('keyring');
    expect(read.person?.priv).toBe(id.person.priv);
    // Delete the entry: the key cannot be opened, and the store says so instead of making up a new person.
    const account = (again as unknown as { keyringAccount(): string }).keyringAccount();
    await new Promise<void>((resolve) => spawn('secret-tool', ['clear', 'service', 'bogen-teams', 'account', account], { env: process.env, stdio: 'ignore' }).on('exit', () => resolve()));
    const third = new TeamStore(h);
    const locked = await third.identity('Laptop');
    expect(third.keyStorage).toBe('locked');
    expect(locked.person).toBeUndefined();
  }, 30_000);
});
