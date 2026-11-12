import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { redactText, redactValue } from '../src/redact.ts';
import { collectReport, failedRuns, reportCommand, tail, tarGz } from '../src/report.ts';

/** Secrets of the shapes a report must never carry. Made up for the test; none of them is real. */
const SECRETS = {
  bearer: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA',
  deviceToken: 'k3J9vQ2mX8pL5nR7tY1wZ4aB6cD0eF2g',
  figma: 'figd_ABCDEFGHIJKLMNOPQRSTUV123456',
  github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  anthropic: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  tailscale: 'tskey-auth-kABCDEF1CNTRL-ABCDEFGHIJKLMNOP',
  cookie: 'bogen_token=s3cr3tc00ki3v4lu3',
  login: 'someone.private@example.org',
  githubLogin: 'privateperson@github',
  tailnet: 'tail9f8e7d',
  phoneCode: 'QWERTYUP',
  pem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n-----END PRIVATE KEY-----',
};

describe('masking secrets', () => {
  it('masks tokens, keys, cookies and Tailscale logins in text', () => {
    const text = [
      `Authorization: Bearer ${SECRETS.bearer}`,
      `Cookie: ${SECRETS.cookie}`,
      `GET /?token=${SECRETS.deviceToken} 200`,
      `BOGEN_TOKEN=${SECRETS.deviceToken} bogen serve`,
      `bogen peer add http://100.64.1.2:29990 --token ${SECRETS.deviceToken}`,
      `{"figmaToken": "${SECRETS.figma}", "openaiApiKey": "sk-proj-${SECRETS.bearer}"}`,
      `git said ${SECRETS.github} and claude ${SECRETS.anthropic}, tailscale up --auth-key=${SECRETS.tailscale}`,
      `Tailscale-User-Login: ${SECRETS.login}`,
      `logins ${SECRETS.githubLogin} and ${SECRETS.login}`,
      `https://omarchy.${SECRETS.tailnet}.ts.net:29443/`,
      `https://user:hunter2@example.com/x`,
      SECRETS.pem,
    ].join('\n');
    const masked = redactText(text, '/home/someone');
    for (const secret of Object.values(SECRETS)) expect(masked, secret).not.toContain(secret);
    expect(masked).not.toContain('hunter2');
    expect(masked).toContain('omarchy.[tailnet].ts.net');
    expect(masked).toContain('[login]');
    expect(masked).toContain('[redacted private key]');
    // What explains a problem stays: addresses, commands and status codes.
    expect(masked).toContain('bogen peer add http://100.64.1.2:29990');
    expect(masked).toContain('200');
  });

  it('empties secret fields and logins in JSON, and keeps the rest', () => {
    const value = redactValue({
      token: SECRETS.deviceToken, deviceToken: SECRETS.deviceToken, openaiApiKey: 'x', tokenHash: 'abc',
      logins: [SECRETS.login, SECRETS.githubLogin], ownerLogin: SECRETS.login, code: SECRETS.phoneCode,
      peers: [{ name: 'MacBook', url: `http://mac.${SECRETS.tailnet}.ts.net:29990`, state: 'connected' }],
      path: '/home/someone/.local/share/bogen', port: 29990, on: true,
    }, '/home/someone') as Record<string, unknown>;
    const text = JSON.stringify(value);
    for (const secret of Object.values(SECRETS)) expect(text, secret).not.toContain(secret);
    expect(value).toMatchObject({ token: '[redacted]', logins: ['[login]', '[login]'], port: 29990, on: true, path: '~/.local/share/bogen' });
    expect((value.peers as { name: string }[])[0]!.name).toBe('MacBook');
  });
});

describe('bogen report', () => {
  const home = mkdtempSync(join(tmpdir(), 'bogen-report-home-'));
  const userHome = mkdtempSync(join(tmpdir(), 'bogen-report-user-'));
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  // A data folder as a server leaves it, with secrets in the places they could leak from.
  mkdirSync(join(home, 'runs'));
  writeFileSync(join(home, 'server.log'), `${'old line\n'.repeat(20_000)}Bogen 0.1.0 on http://127.0.0.1:29990\nData in ${userHome}/.local/share/bogen\nGET /?token=${SECRETS.deviceToken}\nbogen: peer MacBook: 401 from mac.${SECRETS.tailnet}.ts.net, Authorization: Bearer ${SECRETS.bearer}\n`);
  writeFileSync(join(home, 'runs', 'file1.json'), JSON.stringify([
    { id: 'r3', fileId: 'file1', runner: 'claude', status: 'done', startedAt: 3, prompt: 'fine', tools: [], layers: [], nodeIds: [], source: 'prompt' },
    { id: 'r2', fileId: 'file1', runner: 'codex', status: 'failed', startedAt: 2, prompt: `use my key ${SECRETS.anthropic}`, error: `401: ${SECRETS.github}`, result: 'a long answer', tools: [{ name: 'html_write', count: 2 }], layers: [], nodeIds: [], source: 'comment' },
    { id: 'r1', fileId: 'file1', runner: 'claude', status: 'interrupted', startedAt: 1, prompt: 'cut off', tools: [], layers: [], nodeIds: [], source: 'prompt' },
  ]));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ token: SECRETS.deviceToken, figmaToken: SECRETS.figma, tailnet: true, peers: [{ id: 'p1', name: 'MacBook', url: `http://mac.${SECRETS.tailnet}.ts.net:29990`, token: SECRETS.deviceToken }] }));
  writeFileSync(join(home, 'phone.json'), JSON.stringify({ on: true, port: 29991, httpsPort: 29443, logins: [SECRETS.login], devices: [{ id: 'd1', name: 'iPhone', hash: 'h'.repeat(64), login: SECRETS.githubLogin, pairedAt: 1 }] }));
  // Nothing listens there: the report reads the folder, as it does with the server stopped.
  const conn = { url: 'http://127.0.0.1:1', port: 1 };

  it('keeps failed and interrupted runs only, newest first', () => {
    expect(failedRuns(home).map((r) => [r.id, r.status])).toEqual([['r2', 'failed'], ['r1', 'interrupted']]);
    expect(failedRuns(home)[0]).not.toHaveProperty('result');
  });

  it('holds the version, the log tail, failed runs, peers and phones, with every secret masked', async () => {
    const { files } = await collectReport({ conn, home, doctor: false, userHome });
    expect(files.map(([n]) => n)).toEqual(['README.txt', 'version.json', 'doctor.json', 'status.json', 'server.log', 'runs.json', 'peers.json', 'phone.json']);
    const all = files.map(([, text]) => text).join('\n');
    for (const secret of Object.values(SECRETS)) expect(all, secret).not.toContain(secret);
    expect(all).not.toContain('h'.repeat(64));
    expect(all).not.toContain(userHome);
    const get = (name: string) => files.find(([n]) => n === name)![1];
    expect(get('server.log').length).toBeLessThanOrEqual(64 * 1024);
    expect(get('server.log')).toContain('Data in ~/.local/share/bogen');
    expect(get('server.log')).toContain('peer MacBook: 401');
    expect(JSON.parse(get('version.json'))).toMatchObject({ platform: process.platform, node: process.version });
    expect(JSON.parse(get('peers.json'))).toMatchObject({ tailnet: true, peers: [{ id: 'p1', name: 'MacBook', url: 'http://mac.[tailnet].ts.net:29990' }] });
    expect(JSON.parse(get('phone.json'))).toMatchObject({ on: true, httpsPort: 29443, logins: ['[login]'], devices: [{ name: 'iPhone' }] });
    expect(JSON.parse(get('runs.json'))[0]).toMatchObject({ status: 'failed', error: '401: [redacted]' });
  });

  it('writes an owner-only .tar.gz that tar reads, and sends nothing', async () => {
    const output = join(home, 'out', 'report.tar.gz');
    const printed: string[] = [];
    const previous = process.env.BOGEN_HOME;
    process.env.BOGEN_HOME = home;
    try {
      expect(await reportCommand(conn, { output, doctor: false, json: true, userHome }, (t) => printed.push(t))).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.BOGEN_HOME;
      else process.env.BOGEN_HOME = previous;
    }
    expect(JSON.parse(printed.join(''))).toMatchObject({ path: output, sent: false });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const unpacked = mkdtempSync(join(tmpdir(), 'bogen-report-unpacked-'));
    try {
      execFileSync('tar', ['-xzf', output, '-C', unpacked]);
      expect(readdirSync(join(unpacked, 'bogen-report')).sort()).toEqual(['README.txt', 'doctor.json', 'peers.json', 'phone.json', 'runs.json', 'server.log', 'status.json', 'version.json']);
      expect(readFileSync(join(unpacked, 'bogen-report', 'README.txt'), 'utf8')).toContain('Nothing was sent anywhere.');
    } finally {
      rmSync(unpacked, { recursive: true, force: true });
    }
  });

  it('writes archives that tar lists byte for byte, and tails a log from a whole line', () => {
    const archive = tarGz([['a.txt', 'one'], ['b/c.json', Buffer.alloc(1000, 120)]], 'x', 0);
    const dir = mkdtempSync(join(tmpdir(), 'bogen-tar-'));
    try {
      writeFileSync(join(dir, 'a.tar.gz'), archive);
      expect(execFileSync('tar', ['-tvzf', join(dir, 'a.tar.gz')], { encoding: 'utf8' })).toMatch(/x\/a\.txt[\s\S]*1000 [\s\S]*x\/b\/c\.json/);
      writeFileSync(join(dir, 'log'), 'first line that is long\nsecond\nthird\n');
      expect(tail(join(dir, 'log'), 20)).toBe('second\nthird\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
