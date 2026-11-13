/** A real server from source in a temp BOGEN_HOME on a spare port, and a real browser. Nothing else is touched. */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '../../../..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RealServer { base: string; port: number; home: string; pid: number; close: () => Promise<void> }

export interface SeedFile { id: string; name: string; ydocPath: string }

/** With homeFrom, a copy of that data folder is the server's home, such as one from scripts/gen-perf-fixture.ts. */
export async function startRealServer(options: { editorDir?: string; seed?: SeedFile[]; thumbnailsDelay?: string; homeFrom?: string; env?: Record<string, string> } = {}): Promise<RealServer> {
  const home = mkdtempSync(join(process.env.BOGEN_E2E_TMP ?? tmpdir(), 'bogen-e2e-'));
  if (options.homeFrom) cpSync(options.homeFrom, home, { recursive: true });
  mkdirSync(join(home, 'files'), { recursive: true });
  if (options.seed?.length) {
    const entries: Record<string, unknown>[] = [];
    for (const f of options.seed) {
      copyFileSync(f.ydocPath, join(home, 'files', `${f.id}.ydoc`));
      entries.push({ id: f.id, name: f.name, createdAt: Date.now(), updatedAt: Date.now() });
    }
    writeFileSync(join(home, 'index.json'), JSON.stringify({ files: entries }));
  }
  const port = 29100 + Math.floor(Math.random() * 800);
  const env = { ...process.env, BOGEN_HOME: home, BOGEN_WELCOME: '0', ...(options.editorDir ? { BOGEN_EDITOR_DIR: options.editorDir } : {}), ...options.env };
  const child: ChildProcess = spawn('npx', ['tsx', 'packages/server/src/cli.ts', 'serve', '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout?.on('data', (d: Buffer) => { log += d; });
  child.stderr?.on('data', (d: Buffer) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) break;
    } catch { /* not up yet */ }
    if (i > 120) throw new Error(`The server did not come up.\n${log}`);
    await sleep(250);
  }
  return {
    base, port, home, pid: child.pid!,
    close: async () => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
      await sleep(300);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Chromium for the suite. `BOGEN_BROWSER` names another one, which runs with its own sandbox on, never
 * `--no-sandbox`; a wrapper that keeps the browser off the network, such as secure-chromium, is given the
 * server's port with `--secure-local-port` and talks over a pipe.
 */
/** `ports`: more local ports to share, such as a fixture site's. `extensions`: unpacked extension folders to load. */
export async function launch(localPort?: number, options: { fakeMedia?: boolean; ports?: number[]; extensions?: string[] } = {}): Promise<Browser> {
  const named = process.env.BOGEN_BROWSER ?? join(homedir(), '.local/bin/secure-chromium');
  // A made-up microphone, allowed without a prompt, for tests of recording. These are media flags, not sandbox flags.
  const media = options.fakeMedia ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : [];
  const gl = ['--enable-webgl', '--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--window-size=1500,960', ...media];
  const launchSandboxed = async ({ chromiumSandbox }: { chromiumSandbox: true }): Promise<Browser> => {
    if (chromiumSandbox !== true) throw new Error('Browser tests require the Chromium sandbox.');
    const wrapped = /secure-chromium$/.test(named);
    if (!wrapped) throw new Error('Browser tests require ~/.local/bin/secure-chromium; no unsandboxed fallback is allowed.');
    return puppeteer.launch({
      executablePath: named,
      headless: true,
      pipe: wrapped,
      args: [...gl, ...[localPort, ...(options.ports ?? [])].flatMap((p) => (wrapped && p ? [`--secure-local-port=${p}`] : [])),
        // The wrapper shares an extension's folder read-only with the browser when it is named this way.
        ...(options.extensions?.length ? [`--disable-extensions-except=${options.extensions.join(',')}`, `--load-extension=${options.extensions.join(',')}`] : [])],
      ...(options.extensions?.length ? { enableExtensions: true } : {}),
      defaultViewport: { width: 1500, height: 960 },
    });
  };
  return launchSandboxed({ chromiumSandbox: true });
}

export async function freshPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  // tsx names the functions it compiles, including those sent to the page.
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  return page;
}
