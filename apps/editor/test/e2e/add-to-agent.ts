/**
 * Settings, Agents, Add to agent: the clients found on this computer, and Connect, through the loopback API.
 * The server runs with a made-up home and a PATH with only Node, so nothing of the real setup is read or written.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/add-to-agent.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

async function until(check: () => Promise<boolean>, ms = 10000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bogen-clients-'));
  // Cursor and OpenCode are "here" by their folders; no client CLI is on this PATH.
  mkdirSync(join(home, '.cursor'));
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const bin = join(home, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  const npx = execFileSync('sh', ['-c', 'command -v npx'], { encoding: 'utf8' }).trim();
  symlinkSync(npx, join(bin, 'npx'));
  // A client CLI in /usr/bin would be run for real by Connect: then this test stops before it starts the server.
  const clis = ['claude', 'codex', 'cursor', 'code', 'opencode', 'gemini', 'zed', 'grok', 'hermes', 'omp'].filter((c) => existsSync(join('/usr/bin', c)));
  if (clis.length) throw new Error(`${clis.join(', ')} in /usr/bin: this test keeps client CLIs off its PATH and cannot here.`);
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: `${bin}:/usr/bin`, CODEX_HOME: join(home, '.codex') } });
  const browser = await launch(server.port);
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (!ok) failed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  };
  try {
    const page = await freshPage(browser);
    const errors: string[] = [];
    watchErrors(page, errors);
    await page.goto(`${server.base}/`);
    await sleep(1500);
    await page.keyboard.down('Control');
    await page.keyboard.press('Comma');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="settings-nav-agents"]', { timeout: 10000 });
    await page.click('[data-testid="settings-nav-agents"]');
    await page.waitForSelector('[data-testid="add-to-agent"] .add-to-agent-row', { timeout: 15000 });
    const rows = () => page.$$eval('.add-to-agent-row', (els) => els.map((e) => ({ client: e.getAttribute('data-client'), connected: e.getAttribute('data-connected'), text: e.textContent })));
    const before = await rows();
    check('lists the clients found here', before.map((r) => r.client).sort().join() === 'cursor,opencode', before);
    check('says what each would get', before.find((r) => r.client === 'opencode')?.text?.includes('Short tool list') === true && before.find((r) => r.client === 'cursor')?.text?.includes('One tool per area') === true, before);
    const away = await page.$eval('[data-testid="add-to-agent"]', (e) => e.textContent ?? '');
    check('names the clients that are not here', /Not on this computer: .*Claude Code/.test(away), away);
    await page.$eval('[data-testid="add-to-agent"]', (e) => e.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: process.env.SHOT_BEFORE ?? '/dev/null' });

    await page.click('[data-testid="add-to-agent-cursor"]');
    check('Connect connects it', await until(async () => (await rows()).find((r) => r.client === 'cursor')?.connected === 'yes'), await rows());
    const written = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    check('with the entry bogen install writes, grouped', JSON.stringify(written.mcpServers.bogen.args.slice(-3)) === '["mcp","--tools","grouped"]', written);
    check('the button then says Connect again', (await page.$eval('[data-testid="add-to-agent-cursor"]', (e) => e.textContent)) === 'Connect again');
    await page.screenshot({ path: process.env.SHOT_AFTER ?? '/dev/null' });

    // A client whose config is broken says why, in the row, and offers to try again.
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{ broken');
    await page.click('[data-testid="add-to-agent-opencode"]');
    check('a failure is shown in its row', await until(async () => (await page.$eval('[data-client="opencode"]', (e) => e.textContent ?? '')).includes('left alone')));
    check('with Try again', (await page.$eval('[data-testid="add-to-agent-opencode"]', (e) => e.textContent)) === 'Try again');

    const foreign = await fetch(`${server.base}/api/clients`, { headers: { Origin: 'https://example.com' } });
    check('the API refuses another site', foreign.status === 403, foreign.status);
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}

void main();
