import { qrMatrix, qrTerminal } from '@bogen/core';
import type { Connection } from './daemon.ts';
import { policyHint, type PhoneStatus, type ServeOutcome } from './phone.ts';

type Answer = PhoneStatus & { serveCommand: string; serveOffCommand: string; served?: ServeOutcome | null };

interface Flags {
  json?: boolean;
  login?: string;
  'phone-port'?: string;
  'https-port'?: string;
}

class Refused extends Error {}

async function call<T>(conn: Connection, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      method,
      headers: { ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Refused(`No Bogen server answers at ${conn.url}.`);
  }
  const text = await res.text();
  let parsed: { error?: string } & T;
  try {
    parsed = JSON.parse(text) as { error?: string } & T;
  } catch {
    throw new Refused(`The server at ${conn.url} gave an unexpected answer (${res.status}).`);
  }
  if (res.status === 404 && /No route/.test(parsed.error ?? '')) {
    throw new Refused(`The server at ${conn.url} is older than this command. Restart it: systemctl --user restart bogen, or bogen stop.`);
  }
  if (!res.ok) throw new Refused(parsed.error ?? `The server answered ${res.status}.`);
  return parsed;
}

function ago(at: number | null): string {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function port(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Refused(`--${name} "${value}" is not a port.`);
  return n;
}

const USAGE = 'Usage: bogen phone on [--login <a,b>] [--https-port 29443] [--phone-port 29991] | off | pair | list | remove <id> | status';

/** The lines about the tailnet policy, which only the owner of the tailnet can change. */
function policyLines(state: Answer, out: (text: string) => void): void {
  const ip = state.ips.find((a) => !a.includes(':'));
  const blocked = state.policy?.devices.filter((d) => d.allowed === false) ?? [];
  const allowed = state.policy?.devices.filter((d) => d.allowed) ?? [];
  if (state.policy?.checked && allowed.length && !blocked.some((d) => /ios|android/i.test(d.os))) {
    out(`Tailnet policy: ${allowed.map((d) => d.name).join(', ')} may reach tcp:${state.httpsPort}.`);
    return;
  }
  out(blocked.length ? `Your tailnet policy does not let ${blocked.map((d) => d.name).join(', ')} reach this computer on tcp:${state.httpsPort} yet.` : `Your tailnet policy must let your phone reach this computer on tcp:${state.httpsPort}.`);
  out('In the Tailscale admin console, under Access controls, add a rule like one of these (or add the port to a rule that already lets your phone in):');
  for (const line of policyHint(state.logins, ip, state.httpsPort)) out(`  ${line}`);
  out('bogen doctor tells you when it is in place.');
}

/** `bogen phone ...`. Everything goes through the local server, which owns phone.json and the listener. */
export async function phoneCommand(conn: Connection, positionals: string[], flags: Flags): Promise<void> {
  const [action, argument] = positionals;
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  try {
    switch (action) {
      case 'on': {
        const logins = flags.login?.split(',').map((l) => l.trim()).filter(Boolean);
        const state = await call<Answer>(conn, 'POST', '/api/phone?policy', {
          on: true, ...(logins ? { logins } : {}),
          ...(flags['phone-port'] ? { port: port(flags['phone-port'], 'phone-port') } : {}),
          ...(flags['https-port'] ? { httpsPort: port(flags['https-port'], 'https-port') } : {}),
        });
        if (flags.json) return out(JSON.stringify(state));
        out(`Phone listener on 127.0.0.1:${state.port}${state.listening ? '' : ', not listening yet'}.`);
        if (state.served) out(state.served.message);
        if (state.served && (state.served.state === 'taken' || state.served.state === 'failed')) process.exitCode = 1;
        out(`Allowed Tailscale logins: ${state.logins.join(', ') || 'none yet: Tailscale did not say who owns this computer. Is it up?'}${state.loginsFrom === 'owner' ? ' (the owner of this computer)' : ''}`);
        if (!state.url) {
          out('Bogen does not know this computer\'s tailnet name yet. Start Tailscale and run this again.');
          return;
        }
        out('');
        out(`Open on your phone: ${state.url}`);
        out(qrTerminal(qrMatrix(state.url)));
        out('');
        policyLines(state, out);
        out('');
        out('Next, to pair a phone: bogen phone pair');
        return;
      }
      case 'off': {
        const state = await call<Answer>(conn, 'POST', '/api/phone', { on: false });
        if (flags.json) return out(JSON.stringify(state));
        out('The phone listener is off, and stays off after a restart.');
        if (state.served) out(state.served.message);
        if (state.devices.length) out(`${state.devices.length} paired ${state.devices.length === 1 ? 'phone keeps its' : 'phones keep their'} pairing for when it is on again. To end one: bogen phone remove <id>`);
        return;
      }
      case 'pair': {
        const pair = await call<{ code: string; expiresAt: number; url: string | null }>(conn, 'POST', '/api/phone/code');
        if (flags.json) return out(JSON.stringify(pair));
        if (!pair.url) throw new Refused('Bogen does not know this computer\'s tailnet name yet. Start Tailscale and try again.');
        // The code also rides in the fragment, which never reaches a server, so Safari can show it.
        const link = `${pair.url}#/pair/${pair.code}`;
        out('On your iPhone or iPad:');
        out('  1. Scan this with the camera and open the link in Safari.');
        out('  2. Tap Share, then Add to Home Screen, then Add.');
        out('  3. Open Bogen from the Home Screen and type the code below.');
        out('');
        out(qrTerminal(qrMatrix(link)));
        out('');
        out(`Pairing code: ${pair.code}`);
        out(`It works once, until ${new Date(pair.expiresAt).toLocaleTimeString()}. Address: ${pair.url}`);
        return;
      }
      case 'list': {
        const state = await call<Answer>(conn, 'GET', '/api/phone');
        if (flags.json) return out(JSON.stringify(state.devices));
        if (!state.devices.length) return out('No paired phones. Pair one with: bogen phone pair');
        for (const d of state.devices) out(`${d.id}  ${d.name}  paired ${new Date(d.pairedAt).toLocaleDateString()}, last seen ${ago(d.seenAt)}`);
        return;
      }
      case 'remove': {
        if (!argument) throw new Refused('Usage: bogen phone remove <id>');
        const gone = await call<{ removed: string; name: string }>(conn, 'DELETE', `/api/phone/devices/${encodeURIComponent(argument)}`);
        out(`Removed ${gone.name} (${gone.removed}). Its token no longer works, and its open connections are closed.`);
        out('Files it kept for offline use stay on it until the app is deleted there.');
        return;
      }
      case 'status': {
        const state = await call<Answer>(conn, 'GET', '/api/phone?policy');
        if (flags.json) return out(JSON.stringify(state));
        out(`Phone:     ${state.on ? (state.listening ? `on, listening on 127.0.0.1:${state.port}` : 'on, but not listening') : 'off'}`);
        out(`Address:   ${state.url ?? 'unknown until Tailscale says this computer\'s name'}`);
        const serve = { ours: `https port ${state.httpsPort} goes here`, free: `nothing on https port ${state.httpsPort}. Run: ${state.serveCommand}`, taken: `another app uses https port ${state.httpsPort}. Pick another with bogen phone on --https-port <n>`, unknown: 'cannot be read' }[state.serve];
        out(`Serve:     ${serve}`);
        out(`Logins:    ${state.logins.join(', ') || 'none'}${state.loginsFrom === 'owner' ? ' (the owner of this computer)' : ''}`);
        out(`Phones:    ${state.devices.length ? state.devices.map((d) => `${d.name} (${d.id}), last seen ${ago(d.seenAt)}`).join('; ') : 'none paired'}`);
        if (state.on) policyLines(state, out);
        return;
      }
      default:
        throw new Refused(USAGE);
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`bogen: ${e.message}\n`);
    process.exitCode = 1;
  }
}
