import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const DEPLOY = join(ROOT, 'integrations/omarchy/deploy.sh');

const freePort = () => new Promise<number>((done) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});

/**
 * A stand-in for the second device: ssh runs its command here with another HOME and a clean environment, and the
 * programs of a session are small scripts that write down how they were called. rsync, bash, the installer, the
 * bundle and the server are the real ones.
 */
describe('deploying to another device', () => {
  const base = mkdtempSync(join(tmpdir(), 'bogen-deploy-'));
  const remoteHome = join(base, 'remote');
  const bin = join(base, 'bin');
  const omarchy = join(base, 'omarchy');
  const calls = join(base, 'calls.log');
  const dist = join(base, 'dist');
  const farm = join(base, 'system');
  let port = 0;
  let session: ChildProcess;

  const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  const script = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const deploy = (...args: string[]) => new Promise<{ code: number; out: string }>((done) => {
    execFile('bash', [DEPLOY, 'my-laptop@stand-in', '--dist', dist, '--port', String(port), ...args], {
      env: { ...process.env, BOGEN_DEPLOY_SSH: join(bin, 'ssh'), OMARCHY_PATH: '', HYPRLAND_INSTANCE_SIGNATURE: '' }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => done({ code: error ? Number(error.code) || 1 : 0, out: `${stdout}${stderr}` }));
  });

  beforeAll(async () => {
    port = await freePort();
    mkdirSync(remoteHome, { recursive: true });
    mkdirSync(join(remoteHome, '.config/hypr'), { recursive: true });
    execFileSync(process.execPath, [join(ROOT, 'packages/server/scripts/build.mjs')], { env: { ...process.env, BOGEN_DIST_DIR: dist }, stdio: 'ignore', timeout: 90_000 });
    mkdirSync(join(dist, 'editor'), { recursive: true });
    writeFileSync(join(dist, 'editor/index.html'), '<!doctype html><title>stand-in editor</title>');

    // The system's programs, but no node: this device starts without one.
    mkdirSync(farm);
    for (const name of readdirSync('/usr/bin')) if (!/^(node|npm|npx|mise|systemctl|sudo|pgrep|hyprctl|omarchy.*|update-mime-database|update-desktop-database|xdg-mime|bogen)$/.test(name)) symlinkSync(join('/usr/bin', name), join(farm, name));

    // The session: the running shell holds the variables a non-interactive ssh shell does not have.
    session = spawn('sleep', ['300'], { env: { OMARCHY_PATH: omarchy, HYPRLAND_INSTANCE_SIGNATURE: 'stand-in-signature', XDG_RUNTIME_DIR: join(base, 'run'), WAYLAND_DISPLAY: 'wayland-9' }, stdio: 'ignore' });
    script(join(bin, 'pgrep'), `[[ $* == *quickshell* ]] && echo ${session.pid}\nexit 0`);

    script(join(bin, 'ssh'), `
while [[ \${1:-} == -o || \${1:-} == -l ]]; do shift 2; done
shift
cd "${remoteHome}"
exec env -i HOME="${remoteHome}" PATH="${bin}:${farm}" BOGEN_STANDIN_PORT="${port}" bash -c "$*"`);

    // Only reachable through OMARCHY_PATH, as on a real device over ssh.
    script(join(omarchy, 'bin/omarchy'), `echo "omarchy $* OMARCHY_PATH=$OMARCHY_PATH SIG=$HYPRLAND_INSTANCE_SIGNATURE XDG=$XDG_RUNTIME_DIR" >>"${calls}"`);
    script(join(omarchy, 'bin/omarchy-plugin-validate'), `exec /usr/share/omarchy/bin/omarchy-plugin-validate "$@"`);
    script(join(omarchy, 'bin/omarchy-shell'), `echo "omarchy-shell $*" >>"${calls}"`);

    script(join(bin, 'mise'), `
echo "mise $*" >>"${calls}"
dir="$HOME/.local/share/mise/installs/node/24.0.0"
case $1 in
where) [[ -x $dir/bin/node ]] && echo "$dir" || exit 1 ;;
which) [[ -x $dir/bin/node ]] && echo "$dir/bin/node" || exit 1 ;;
use) mkdir -p "$dir/bin"; ln -sf "${process.execPath}" "$dir/bin/node" ;;
esac`);
    script(join(bin, 'npm'), `
echo "npm $* node=$(command -v node)" >>"${calls}"
ln -sfn "${join(ROOT, 'node_modules')}" node_modules`);
    script(join(bin, 'systemctl'), `
echo "systemctl $* XDG=$XDG_RUNTIME_DIR" >>"${calls}"
case " $* " in
*" is-active --quiet ufw "*) exit 1 ;;
*" restart bogen.service "*)
  [[ -f $HOME/server.pid ]] && kill "$(cat "$HOME/server.pid")" 2>/dev/null
  sleep 0.2
  exec_line=$(sed -n 's/^ExecStart=//p' "$HOME/.config/systemd/user/bogen.service")
  # Not the real tailnet, which is this machine's.
  bogen_bin=\${exec_line%% *}
  BOGEN_HOME="$HOME/designs" nohup "$bogen_bin" serve --port "$BOGEN_STANDIN_PORT" >"$HOME/server.log" 2>&1 &
  echo $! >"$HOME/server.pid"
  ;;
esac
exit 0`);
    for (const name of ['hyprctl', 'update-mime-database', 'update-desktop-database', 'xdg-mime', 'sudo']) script(join(bin, name), `echo "${name} $*" >>"${calls}"\nexit 0`);
  }, 120_000);

  afterAll(async () => {
    session?.kill();
    const pidFile = join(remoteHome, 'server.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')));
      } catch {
        // Already gone.
      }
    }
    await new Promise((done) => setTimeout(done, 300));
    rmSync(base, { recursive: true, force: true });
  });

  it('dry run looks and changes nothing', async () => {
    const { code, out } = await deploy('--dry-run');
    expect(out).toContain('Dry run');
    expect(out).toContain('would run there: mise use -g node@24');
    expect(out).toMatch(/program: would change \d+ file/);
    expect(out).toContain('would restart bogen.service there');
    expect(code).toBe(0);
    expect(existsSync(join(remoteHome, '.local/share/bogen-app'))).toBe(false);
    expect(called()).not.toMatch(/systemctl|npm|mise use/);
  }, 60_000);

  it('deploys for real: node through mise, files, installer, service, and reports the version', async () => {
    const version = execFileSync(process.execPath, [join(dist, 'cli.js'), '--version'], { encoding: 'utf8' }).trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+\+/);
    const { code, out } = await deploy();
    expect(out, out).toContain(`runs Bogen ${version}`);
    expect(out).toContain('That is this build.');
    expect(code, out).toBe(0);

    const app = join(remoteHome, '.local/share/bogen-app');
    expect(existsSync(join(app, 'dist/cli.js'))).toBe(true);
    expect(existsSync(join(app, 'dist/editor/index.html'))).toBe(true);
    expect(existsSync(join(app, 'integrations/omarchy/install.sh'))).toBe(true);
    expect(JSON.parse(readFileSync(join(app, 'dist/package.json'), 'utf8')).type).toBe('module');
    expect(called()).toContain('mise use -g node@24');
    expect(called()).toMatch(/npm install .*node=.*node\/24\.0\.0\/bin\/node/);

    // The installer found the session without any of it being set in the ssh shell.
    expect(called()).toContain(`OMARCHY_PATH=${omarchy}`);
    expect(called()).toContain('SIG=stand-in-signature');
    expect(called()).toContain('omarchy webapp install');
    expect(called()).toContain('omarchy hook install theme-set');

    const wrapper = readFileSync(join(remoteHome, '.local/bin/bogen'), 'utf8');
    expect(wrapper).toContain(join(app, 'dist/cli.js'));
    expect(wrapper).toContain('node/24.0.0/bin/node');
    const unit = readFileSync(join(remoteHome, '.config/systemd/user/bogen.service'), 'utf8');
    expect(unit).toContain('serve --tailnet');
    expect(statSync(join(remoteHome, '.config/omarchy/plugins/dev.bogen.bogen/Panel.qml')).isFile()).toBe(true);
    expect(existsSync(join(remoteHome, '.local/bin/bogen-place-screenshot'))).toBe(true);
    expect(called()).toContain('restart bogen.service');
    expect((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json() as { version: string }).version).toBe(version);
    expect(readFileSync(join(remoteHome, '.local/bin/bogen'), 'utf8')).toContain('Managed by Bogen');
  }, 120_000);

  it('running it again changes nothing, and a new build goes over in one file', async () => {
    const before = called();
    const again = await deploy();
    expect(again.out, again.out).toContain('program: unchanged');
    expect(again.out).toContain('integration: unchanged');
    expect(again.out).toContain('puppeteer-core esbuild tailwindcss are there');
    expect(again.code).toBe(0);
    const added = called().slice(before.length);
    expect(added).not.toContain('mise use');
    expect(added).not.toContain('npm install');
    expect(added).toContain('restart bogen.service');

    // A dry run names what differs, and leaves it.
    writeFileSync(join(dist, 'shader-runtime.js'), `${readFileSync(join(dist, 'shader-runtime.js'), 'utf8')}\n// new\n`);
    const dry = await deploy('--dry-run');
    expect(dry.out).toMatch(/program: would change 1 file/);
    expect(readFileSync(join(remoteHome, '.local/share/bogen-app/dist/shader-runtime.js'), 'utf8')).not.toContain('// new');
    const real = await deploy();
    expect(real.out).toMatch(/program: 1 file\(s\) changed/);
    expect(readFileSync(join(remoteHome, '.local/share/bogen-app/dist/shader-runtime.js'), 'utf8')).toContain('// new');

    // Something left behind that a build no longer has goes too, and the driver stays.
    writeFileSync(join(remoteHome, '.local/share/bogen-app/dist/stale.js'), 'old');
    await deploy();
    expect(existsSync(join(remoteHome, '.local/share/bogen-app/dist/stale.js'))).toBe(false);
    expect(existsSync(join(remoteHome, '.local/share/bogen-app/dist/node_modules'))).toBe(true);
  }, 180_000);

  it('runs as `bogen peer deploy`, which starts no server of its own', async () => {
    const tsx = join(ROOT, 'node_modules/.bin/tsx');
    // The build made for these tests, not whatever the checkout has in packages/server/dist (often nothing, or a
    // build another process is rewriting just then).
    const out = execFileSync(tsx, [join(ROOT, 'packages/server/src/cli.ts'), 'peer', 'deploy', 'my-laptop@stand-in', '--dry-run'], {
      env: { ...process.env, BOGEN_DEPLOY_SSH: join(bin, 'ssh'), BOGEN_DEPLOY_DIST: dist, BOGEN_HOME: join(base, 'nothing'), BOGEN_PORT: '1' }, encoding: 'utf8', timeout: 60_000,
    });
    expect(out).toContain('Dry run');
    expect(existsSync(join(base, 'nothing', 'server.json'))).toBe(false);
  }, 90_000);

  it('says so when the device cannot be reached', async () => {
    script(join(bin, 'ssh-down'), 'echo "ssh: connect to host: No route" >&2; exit 255');
    const result = await new Promise<{ code: number; out: string }>((done) => {
      execFile('bash', [DEPLOY, 'nowhere', '--dist', dist], { env: { ...process.env, BOGEN_DEPLOY_SSH: join(bin, 'ssh-down') } }, (error, stdout, stderr) => done({ code: error ? 1 : 0, out: `${stdout}${stderr}` }));
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('could not reach nowhere over ssh');
  });
});

describe('the installer, over ssh', () => {
  it('passes the plugin it installs through the real validator', () => {
    const out = execFileSync('/usr/share/omarchy/bin/omarchy-plugin-validate', [join(ROOT, 'integrations/omarchy/plugin')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toBeDefined();
  });

  it('finds the omarchy command through the session when PATH and OMARCHY_PATH say nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'bogen-lib-'));
    const session = spawn('sleep', ['30'], { env: { OMARCHY_PATH: '/opt/stand-in-omarchy', HYPRLAND_INSTANCE_SIGNATURE: 'sig' }, stdio: 'ignore' });
    try {
      const bin = join(base, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pgrep'), `#!/bin/bash\n[[ $* == *quickshell* ]] && echo ${session.pid}\nexit 0\n`);
      chmodSync(join(bin, 'pgrep'), 0o755);
      const out = execFileSync('bash', ['-c', `source "${join(ROOT, 'integrations/omarchy/lib.sh')}"; printf '%s|%s|%s' "$OMARCHY_PATH" "$HYPRLAND_INSTANCE_SIGNATURE" "$XDG_RUNTIME_DIR"`], {
        env: { HOME: base, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8',
      });
      const [path, sig, runtime] = out.split('|');
      expect(path).toBe('/opt/stand-in-omarchy');
      expect(sig).toBe('sig');
      expect(runtime).toBe(`/run/user/${process.getuid!()}`);
    } finally {
      session.kill();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('bogen doctor', () => {
  it('reports every part, with a fix for what is wrong, and changes nothing', async () => {
    const { runChecks, tcpProbe } = await import('../src/doctor.ts');
    const { connectionFromEnv } = await import('../src/daemon.ts');
    const home = mkdtempSync(join(tmpdir(), 'bogen-doctor-'));
    const saved = { HOME: process.env.HOME, BOGEN_HOME: process.env.BOGEN_HOME, CODEX: process.env.CODEX_HOME, PATH: process.env.PATH };
    const closed = await freePort();
    const open = createServer();
    await new Promise<void>((done) => open.listen(0, '127.0.0.1', () => done()));
    const openPort = (open.address() as { port: number }).port;
    try {
      process.env.HOME = home;
      process.env.BOGEN_HOME = join(home, 'data');
      delete process.env.CODEX_HOME;
      mkdirSync(join(home, 'data'));
      mkdirSync(join(home, '.claude'));
      const peers = [
        { id: 'peer-open', name: 'Reachable', url: `http://127.0.0.1:${openPort}`, token: 'x'.repeat(20) },
        { id: 'peer-closed', name: 'Down', url: `http://127.0.0.1:${closed}`, token: 'y'.repeat(20) },
        { id: 'peer-bad', name: 'Broken', url: 'not a url', token: 'z'.repeat(20) },
      ];
      writeFileSync(join(home, 'data/config.json'), JSON.stringify({ tailnet: true, peers }));
      const checks: { state: string; label: string; detail?: string; fix?: string }[] = [];
      await runChecks({ ...connectionFromEnv(1), url: 'http://127.0.0.1:1', port: 1 }, (c) => checks.push(c));
      const labels = checks.map((c) => c.label);
      for (const expected of ['Node', 'Data folder', 'Service', 'Server', 'Editor', 'Browser', 'Tailnet address', 'Firewall', 'Peer Reachable', 'Peer Down', 'Peer Broken', 'Runner claude', 'Runner codex', 'MCP claude-code']) {
        expect(labels, expected).toContain(expected);
      }
      for (const c of checks.filter((x) => x.state === 'fail')) expect(c.fix, c.label).toBeTruthy();
      expect(checks.find((c) => c.label === 'Peer Reachable')!.state).toBe('ok');
      expect(checks.find((c) => c.label === 'Peer Down')!.state).toBe('fail');
      expect(checks.find((c) => c.label === 'Peer Broken')!.fix).toContain('bogen peer remove peer-bad');
      expect(checks.find((c) => c.label === 'MCP claude-code')!.fix).toBe('bogen install claude-code');
      // Nothing written, and tokens not repeated.
      expect(readFileSync(join(home, 'data/config.json'), 'utf8')).toContain('peer-open');
      expect(readdirSync(join(home, 'data'))).toEqual(['config.json']);
      expect(JSON.stringify(checks)).not.toContain('xxxxxxxxxx');
      expect(await tcpProbe('127.0.0.1', openPort)).toBe('open');
      expect(await tcpProbe('127.0.0.1', closed)).toBe('refused');
    } finally {
      process.env.HOME = saved.HOME;
      process.env.PATH = saved.PATH;
      if (saved.BOGEN_HOME) process.env.BOGEN_HOME = saved.BOGEN_HOME;
      else delete process.env.BOGEN_HOME;
      if (saved.CODEX) process.env.CODEX_HOME = saved.CODEX;
      await new Promise((done) => open.close(done));
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the screenshot script', () => {
  it('places what you choose in the image picker, and nothing when you press Escape', async () => {
    const { startServer, connectAgent, call, until } = await import('./helpers.ts');
    const h = await startServer();
    const base = mkdtempSync(join(tmpdir(), 'bogen-shot-'));
    const shots = join(base, 'shots');
    const image = join(shots, 'screenshot-1.png');
    const picked = join(base, 'picked');
    const told = join(base, 'told');
    try {
      mkdirSync(shots);
      writeFileSync(image, readFileSync(join(ROOT, 'apps/editor/test/fixtures/pixel.png')));
      writeFileSync(join(base, 'omarchy-menu-images'), `#!/bin/bash\necho "$*" >>"${picked}"\ncat "${join(base, 'choice')}"\n`);
      writeFileSync(join(base, 'omarchy-notification-send'), `#!/bin/bash\necho "$*" >>"${told}"\n`);
      chmodSync(join(base, 'omarchy-menu-images'), 0o755);
      chmodSync(join(base, 'omarchy-notification-send'), 0o755);
      const agent = await connectAgent(h.base, 'setup');
      const file = await call(agent, 'file_create', { name: 'Shots' });
      const run = () => new Promise<number>((done) => {
        execFile('bash', [join(ROOT, 'integrations/omarchy/bin/bogen-place-screenshot'), '--pick', shots], { env: { ...process.env, BOGEN_URL: h.base, PATH: `${base}:${process.env.PATH}`, HOME: base } }, (error) => done(error ? 1 : 0));
      });

      writeFileSync(join(base, 'choice'), '');
      expect(await run()).toBe(0);
      expect(readFileSync(picked, 'utf8')).toContain(shots);
      expect(existsSync(told)).toBe(false);

      writeFileSync(join(base, 'choice'), image);
      // The layer lands in the file a person has open, or the one this session knows of.
      expect(await run()).toBe(0);
      const room = await h.server.rooms.get(file.id);
      await until(() => room.doc.getChildren(file.pages[0].id).some((n) => n.type === 'image'));
      expect(readFileSync(told, 'utf8')).toContain('Screenshot placed');
      await agent.close();
    } finally {
      await h.cleanup();
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});
