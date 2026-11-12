import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BogenDoc } from '@bogen/core';
import { probeState, type Connection } from './daemon.ts';
import { editorRoot } from './http/static.ts';
import { CLIENTS, detected, registration } from './install.ts';
import { findBrowser, Renderer } from './render.ts';
import { phonePolicy, policyHint, readPhoneSettings, serveOwner } from './phone.ts';
import { tailscaleCli, tailscaleIp, tailscaleCommands } from './tailnet.ts';
import { bogenHome, errorMessage } from './util.ts';
import { FULL_VERSION } from './version.ts';

export type CheckState = 'ok' | 'fail' | 'note';
export interface Check { state: CheckState; label: string; detail?: string; fix?: string }

const UFW_RULE = 'sudo ufw allow in on tailscale0 to any port 29990 proto tcp comment bogen-sync';
const NODE_MIN = [22, 18];

function run(command: string, args: string[], timeout = 5000): Promise<{ ok: boolean; out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout) + String(stderr), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 });
    });
    child.stdin?.end();
  });
}

/** Whether something answers TCP there, and if not, how it failed: a refusal comes from the machine, silence from a filter on the way. */
export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<'open' | 'refused' | 'silent' | 'error'> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: 'open' | 'refused' | 'silent' | 'error') => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('silent'));
    socket.once('connect', () => done('open'));
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'silent' : 'error'));
  });
}

interface PeerRow { id: string; name: string; url?: string; state?: string; error?: string; version?: string; versionMismatch?: boolean }
interface PeersReply { device?: { name: string; tailnetUrl: string | null }; tailnet?: boolean; peers: PeerRow[] }

async function peersFromServer(conn: Connection): Promise<PeersReply | null> {
  try {
    const res = await fetch(`${conn.url}/api/peers`, { headers: conn.token ? { Authorization: `Bearer ${conn.token}` } : {}, signal: AbortSignal.timeout(3000) });
    return res.ok ? (await res.json()) as PeersReply : null;
  } catch {
    return null;
  }
}

function peersFromConfig(home: string): PeersReply {
  try {
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { peers?: { id: string; name: string; url: string }[]; tailnet?: boolean };
    return { tailnet: config.tailnet === true, peers: (config.peers ?? []).map(({ id, name, url }) => ({ id, name, url })) };
  } catch {
    return { peers: [] };
  }
}

/** Every check changes nothing: it reads files, asks programs for their status, and looks at ports. */
export async function runChecks(conn: Connection, emit: (check: Check) => void): Promise<void> {
  const line = (state: CheckState, label: string, detail?: string, fix?: string) => emit({ state, label, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const nodeOk = major > NODE_MIN[0]! || (major === NODE_MIN[0] && minor >= NODE_MIN[1]!);
  line(nodeOk ? 'ok' : 'fail', 'Node', `${process.version} at ${process.execPath}`, nodeOk ? undefined : 'mise use -g node@24');

  const home = bogenHome();
  try {
    accessSync(home, existsSync(home) ? constants.W_OK : constants.F_OK);
    line('ok', 'Data folder', home);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') line('note', 'Data folder', `${home} does not exist yet; the server makes it`, 'bogen start');
    else line('fail', 'Data folder', `${home}: ${errorMessage(e)}`, `chown -R "$USER" ${home}`);
  }

  const unit = join(homedir(), '.config/systemd/user/bogen.service');
  const probed = await probeState(conn);
  const status = probed.state === 'running' ? probed.status : null;
  if (existsSync(unit)) {
    const active = await run('systemctl', ['--user', 'is-active', 'bogen.service']);
    const enabled = await run('systemctl', ['--user', 'is-enabled', 'bogen.service']);
    if (active.out.trim() === 'active' && enabled.out.trim() === 'enabled') line('ok', 'Service', 'bogen.service is enabled and active');
    else if (active.out.trim() !== 'active') line(status ? 'note' : 'fail', 'Service', `bogen.service is ${active.out.trim() || 'unknown'}${status ? ', and something else answers on the port' : ''}`, status ? 'bogen stop && systemctl --user enable --now bogen.service' : 'systemctl --user enable --now bogen.service');
    else line('note', 'Service', `bogen.service runs, but is ${enabled.out.trim() || 'not enabled'}, so it will not start at login`, 'systemctl --user enable bogen.service');
  } else {
    line('note', 'Service', 'no user service here; the server starts by itself with `bogen mcp` or `bogen start`', process.platform === 'linux' ? 'bogen omarchy install' : undefined);
  }

  if (status) {
    line('ok', 'Server', `running at ${conn.url}, ${status.files} files, version ${status.version}`);
    if (status.version !== FULL_VERSION) line('fail', 'Server version', `the running server is ${status.version}, this command is ${FULL_VERSION}`, existsSync(unit) ? 'systemctl --user restart bogen.service' : 'bogen stop && bogen start');
  } else if (probed.state === 'busy') line('fail', 'Server', `something on ${conn.url} took the connection and did not reply within 2 s, most likely Bogen waiting on a busy disk`, existsSync(unit) ? 'journalctl --user -u bogen -n 50' : undefined);
  else line('note', 'Server', 'not running', existsSync(unit) ? 'systemctl --user start bogen.service' : 'bogen start');

  const editor = editorRoot();
  line(editor ? 'ok' : 'note', 'Editor', editor ?? 'not built, MCP still works', editor ? undefined : 'npm run build');

  const browser = findBrowser();
  if (!browser) line('fail', 'Browser', 'none found, and screenshots and exports need one', 'sudo pacman -S chromium, or set BOGEN_BROWSER to a Chromium-based browser');
  else {
    const renderer = new Renderer(async () => null);
    try {
      const doc = new BogenDoc();
      doc.ensureFirstPage();
      const page = doc.getPages()[0]!.id;
      doc.insert(page, { type: 'frame', style: { position: 'absolute', left: '0px', top: '0px', width: '40px', height: '40px', backgroundColor: '#123456' } });
      const shot = await renderer.screenshot(doc, { pageId: page });
      line(shot.bytes.length > 0 ? 'ok' : 'fail', 'Browser', `${browser} rendered a test image`);
    } catch (e) {
      line('fail', 'Browser', `${browser}: ${errorMessage(e)}`, 'set BOGEN_BROWSER to a Chromium-based browser that starts');
    } finally {
      await renderer.close();
    }
  }

  const tailscale = (await Promise.all(tailscaleCommands().map(async (c) => ((await run(c, ['version'], 2000)).ok ? c : null)))).find(Boolean) ?? null;
  const address = await tailscaleIp();
  const reply = (status ? await peersFromServer(conn) : null) ?? peersFromConfig(home);
  const wantsTailnet = reply.tailnet === true || reply.peers.length > 0;
  if (address) line('ok', 'Tailnet address', address);
  else if (!tailscale) line('note', 'Tailnet address', 'Tailscale is not installed; device sync needs it', 'sudo pacman -S tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up');
  else line(wantsTailnet ? 'fail' : 'note', 'Tailnet address', 'Tailscale is installed but not up', 'sudo tailscale up');

  if (address) {
    const listening = await tcpProbe(address, 29990, 1500);
    if (listening === 'open') line('ok', 'Tailnet listener', `Bogen answers on ${address}:29990`);
    else line(wantsTailnet ? 'fail' : 'note', 'Tailnet listener', `nothing listens on ${address}:29990`, status ? 'bogen peer tailnet on' : 'bogen serve --tailnet');
  }

  await ufwCheck(line, wantsTailnet);

  for (const peer of reply.peers) {
    const label = `Peer ${peer.name}`;
    let host = '';
    let port = 29990;
    try {
      const url = new URL(peer.url ?? '');
      host = url.hostname.replace(/^\[|\]$/g, '');
      port = Number(url.port) || 80;
    } catch {
      line('fail', label, `the saved address "${peer.url}" is not a URL`, `bogen peer remove ${peer.id}, then pair again`);
      continue;
    }
    const reach = await tcpProbe(host, port);
    if (reach === 'open') {
      line(peer.state === 'offline' ? 'note' : 'ok', label, `${host}:${port} answers${peer.state ? `, sync is ${peer.state}` : ''}${peer.error ? `: ${peer.error}` : ''}`, peer.state === 'offline' ? `bogen peer status` : undefined);
    } else {
      const ping = tailscale ? await run(tailscale, ['ping', '--c', '1', '--timeout', '3s', host], 6000) : null;
      if (ping?.ok && reach === 'refused') line('fail', label, `${host} is up, and nothing listens on ${port} there`, `on ${peer.name}: bogen peer tailnet on, or systemctl --user start bogen.service`);
      else if (ping?.ok) line('fail', label, `${host} answers Tailscale ping but not TCP ${port}: the firewall there, or your tailnet policy, is in the way`, `on ${peer.name}: ${UFW_RULE}; and allow tcp:${port} between these devices in the Tailscale access controls`);
      else line('fail', label, `${host} does not answer`, `check that ${peer.name} is on: tailscale status`);
    }
    if (peer.versionMismatch) line('fail', `${label} version`, `it runs ${peer.version}, this server ${status?.version ?? FULL_VERSION}`, `bogen peer deploy <ssh-host of ${peer.name}>`);
    else if (peer.version) line('ok', `${label} version`, peer.version);
    else if (status) line('note', `${label} version`, 'it has not said which version it runs: an older build, or not heard from yet', `bogen peer deploy <ssh-host of ${peer.name}>`);
  }

  await phoneChecks(line, home, tailscale !== null);

  const { Runs } = await import('./agents.ts');
  const { EventHub } = await import('./events.ts');
  // Only Claude and Codex are started for their version here; the others are looked up on PATH.
  for (const r of await new Runs(new EventHub(), () => ({ url: '' })).runners()) {
    if (r.id === 'claude' || r.id === 'codex') {
      line(r.available ? 'ok' : 'note', `Runner ${r.id}`, r.available ? r.version : 'not installed', r.available ? undefined : r.id === 'claude' ? 'mise use -g npm:@anthropic-ai/claude-code' : 'mise use -g npm:@openai/codex');
    } else if (r.available) line('ok', `Runner ${r.id}`, r.version ?? 'found on PATH; its version and options are checked when it is picked');
    else if (r.installed) line('note', `Runner ${r.id}`, 'installed, but Bogen does not run it itself', `bogen install ${r.id}`);
    else line('note', `Runner ${r.id}`, r.reason ?? 'not installed');
  }

  for (const client of CLIENTS) {
    if (!detected(client)) continue;
    const info = await registration(client);
    // Being installed is no promise to use it with Bogen, so this is a note and not a failure.
    if (info.registered === null) line('note', `MCP ${client}`, `installed here; whether Bogen is registered is not in a file Bogen reads (${info.where})`, `bogen install ${client}`);
    else if (!info.registered) line('note', `MCP ${client}`, `installed here, and not registered in ${info.where}`, `bogen install ${client}`);
    else if (info.skill === false) line('note', `MCP ${client}`, `registered, but without the Bogen skill`, `bogen install ${client}`);
    else line('ok', `MCP ${client}`, `registered in ${info.where}${info.skill ? ', with the skill' : ''}`);
  }
}

/**
 * The phone listener, when it is on: the loopback port, this one port in `tailscale serve`, and whether the
 * tailnet policy lets the owner's phones reach it. The policy is read from the packet filter Tailscale gives
 * this node, which is what decides whether a phone gets in.
 */
async function phoneChecks(line: (state: CheckState, label: string, detail?: string, fix?: string) => void, home: string, hasTailscale: boolean): Promise<void> {
  let saved: ReturnType<typeof readPhoneSettings> = null;
  try {
    saved = readPhoneSettings(JSON.parse(readFileSync(join(home, 'phone.json'), 'utf8')));
  } catch {
    // Never turned on.
  }
  if (!saved?.on) return;
  const serveCommand = `tailscale serve --bg --https=${saved.httpsPort} http://127.0.0.1:${saved.port}`;
  const listening = await tcpProbe('127.0.0.1', saved.port, 1500);
  line(listening === 'open' ? 'ok' : 'fail', 'Phone listener', listening === 'open' ? `answers on 127.0.0.1:${saved.port}` : `nothing listens on 127.0.0.1:${saved.port}`, listening === 'open' ? undefined : 'systemctl --user restart bogen.service, or bogen phone on');
  if (!hasTailscale) {
    line('fail', 'Phone serve', 'Tailscale is not installed, and the phone reaches Bogen through it');
    return;
  }
  const cli = tailscaleCli();
  const [self, config] = await Promise.all([cli.self(), cli.serveStatus()]);
  const owner = serveOwner(config, saved.httpsPort, saved.port);
  if (owner === 'ours') line('ok', 'Phone serve', `tailscale serve sends https port ${saved.httpsPort} to Bogen${self ? `: https://${self.dnsName}:${saved.httpsPort}/` : ''}`);
  else if (owner === 'free') line('fail', 'Phone serve', `tailscale serve has nothing on https port ${saved.httpsPort}`, serveCommand);
  else if (owner === 'taken') line('fail', 'Phone serve', `another app uses https port ${saved.httpsPort} in tailscale serve`, 'bogen phone off, then bogen phone on --https-port <a free port>');
  else line('note', 'Phone serve', 'the tailscale serve config cannot be read', serveCommand);
  if (!self) return;
  const logins = saved.logins?.length ? saved.logins.map((l) => l.toLowerCase()) : [self.ownerLogin.toLowerCase()].filter(Boolean);
  line(logins.length ? 'ok' : 'fail', 'Phone logins', logins.length ? `${logins.join(', ')}${saved.logins?.length ? '' : ', the owner of this computer'}` : 'Tailscale did not say who owns this computer', logins.length ? undefined : 'bogen phone on --login <your login>');
  const policy = phonePolicy(self, await cli.packetFilter(), logins, saved.httpsPort);
  const hint = policyHint(logins, self.ips.find((a) => !a.includes(':')), saved.httpsPort).join('  or  ');
  const phones = policy.devices.filter((d) => /ios|android/i.test(d.os));
  if (!policy.checked) line('note', 'Phone policy', `the tailnet policy cannot be read here. It must allow tcp:${saved.httpsPort} from your phone to this computer`, `in the Tailscale admin console, Access controls: ${hint}`);
  else if (!phones.length) line('note', 'Phone policy', `no phone or tablet of ${logins.join(', ')} is on the tailnet`);
  else for (const d of phones) {
    if (d.allowed) line('ok', `Phone policy ${d.name}`, `may reach tcp:${saved.httpsPort}`);
    else line('fail', `Phone policy ${d.name}`, `the tailnet policy blocks tcp:${saved.httpsPort} from ${d.name} to this computer, so the page will not load there`, `in the Tailscale admin console, Access controls: ${hint}`);
  }
  line(saved.devices ? 'ok' : 'note', 'Paired phones', saved.devices ? String(saved.devices) : 'none yet', saved.devices ? undefined : 'bogen phone pair');
}

/** ufw's rules are only readable as root. Without a password prompt this says what it can, and never asks for one. */
async function ufwCheck(line: (state: CheckState, label: string, detail?: string, fix?: string) => void, wanted: boolean): Promise<void> {
  const active = await run('systemctl', ['is-active', 'ufw']);
  if (active.out.trim() !== 'active') {
    line('note', 'Firewall', 'ufw is not active, so it is not what stops another device');
    return;
  }
  const status = await run('sudo', ['-n', 'ufw', 'status'], 4000);
  if (!status.ok) {
    line(wanted ? 'note' : 'note', 'Firewall', 'ufw is active, and its rules can only be read as root. If another device cannot reach this one, this is the rule it needs', UFW_RULE);
    return;
  }
  const has = status.out.split('\n').some((l) => /29990/.test(l) && /tailscale0/.test(l) && /ALLOW/i.test(l));
  if (has) line('ok', 'Firewall', 'ufw allows 29990 on tailscale0');
  else line(wanted ? 'fail' : 'note', 'Firewall', 'ufw has no rule for 29990 on tailscale0, so other devices cannot reach this one', UFW_RULE);
}

export async function doctor(conn: Connection, json = false): Promise<number> {
  const checks: Check[] = [];
  let bad = 0;
  await runChecks(conn, (check) => {
    checks.push(check);
    if (check.state === 'fail') bad++;
    if (json) return;
    const mark = check.state === 'ok' ? 'ok  ' : check.state === 'fail' ? 'FAIL' : 'note';
    process.stdout.write(`${mark}  ${check.label}${check.detail ? `: ${check.detail}` : ''}\n`);
    if (check.fix) process.stdout.write(`      fix: ${check.fix}\n`);
  });
  if (json) process.stdout.write(`${JSON.stringify(checks, null, 1)}\n`);
  return bad ? 1 : 0;
}
