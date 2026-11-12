import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Renderer, sharesLocalPorts } from '../src/render.ts';

// Stand-in browsers that only write down how they were started, then exit: no Chromium is needed.
function standIn(name: string): { path: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'bogen-ports-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  const log = join(dir, 'calls.txt');
  const path = join(dir, 'bin', name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []) };
}
const dirs: string[] = [];
const saved = process.env.BOGEN_BROWSER;

afterEach(() => {
  if (saved === undefined) delete process.env.BOGEN_BROWSER;
  else process.env.BOGEN_BROWSER = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('local ports for a browser that reaches only the ports it is started with', () => {
  it('knows secure-chromium by its name, and nothing else', () => {
    expect(sharesLocalPorts('/home/someone/.local/bin/secure-chromium')).toBe(true);
    expect(sharesLocalPorts('secure-chromium')).toBe(true);
    expect(sharesLocalPorts('/usr/bin/chromium')).toBe(false);
    expect(sharesLocalPorts('/usr/bin/secure-chromium-old')).toBe(false);
  });

  it('starts secure-chromium with every port shared for a local page, and only with those', async () => {
    const browser = standIn('secure-chromium');
    process.env.BOGEN_BROWSER = browser.path;
    const renderer = new Renderer(async () => null);
    expect(renderer.shareLocalPort(4321)).toBe(true);
    await expect(renderer.withBrowser(async () => 'never')).rejects.toThrow(/Could not start/);
    const first = browser.calls().at(-1)!;
    expect(first.filter((a) => a.startsWith('--secure-local-port='))).toEqual(['--secure-local-port=4321']);
    // Never a way around its sandbox.
    expect(first).not.toContain('--no-sandbox');
    renderer.shareLocalPort(5173);
    renderer.shareLocalPort(0);
    await expect(renderer.withBrowser(async () => 'never')).rejects.toThrow(/Could not start/);
    expect(browser.calls().at(-1)!.filter((a) => a.startsWith('--secure-local-port=')).sort()).toEqual(['--secure-local-port=4321', '--secure-local-port=5173']);
    await renderer.close();
  });

  it('gives an ordinary browser no such flag', async () => {
    const browser = standIn('chromium');
    process.env.BOGEN_BROWSER = browser.path;
    const renderer = new Renderer(async () => null);
    expect(renderer.shareLocalPort(4321)).toBe(true);
    await expect(renderer.withBrowser(async () => 'never')).rejects.toThrow(/Could not start/);
    expect(browser.calls().at(-1)!.some((a) => a.startsWith('--secure-local-port'))).toBe(false);
    await renderer.close();
  });
});
