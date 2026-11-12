import type { Connection } from './daemon.ts';
import type { PeerStatus } from './peers.ts';

interface PeersAnswer {
  device: { id: string; name: string; tailnetUrl: string | null };
  tailnet: boolean;
  peers: (PeerStatus & { url: string })[];
}

interface Flags {
  token?: string;
  name?: string;
  json?: boolean;
  'insecure-allow-any-host'?: boolean;
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
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Refused(`Bogen at ${conn.url} took the request and did not answer in 30 s. It may still be doing it: check with bogen peer status.`);
    throw new Refused(`No Bogen server answers at ${conn.url}.`);
  }
  const text = await res.text();
  let parsed: { error?: string } & T;
  try {
    parsed = JSON.parse(text) as { error?: string } & T;
  } catch {
    throw new Refused(`The server at ${conn.url} gave an unexpected answer (${res.status}).`);
  }
  if (res.status === 404 && path.startsWith('/api/peers') && /No route/.test(parsed.error ?? '')) {
    throw new Refused(`The server at ${conn.url} is older than this command. Restart it: systemctl --user restart bogen, or bogen stop.`);
  }
  if (!res.ok) throw new Refused(parsed.error ?? `The server answered ${res.status}.`);
  return parsed;
}

function ago(at: number | null): string {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

const USAGE = 'Usage: bogen peer pair | add <url> --token <t> [--name <n>] | list | status | remove <id> | tailnet <on|off> | deploy <ssh-host> [--dry-run]';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** `bogen peer ...`. All of it goes through the local server, the only writer of config.json. */
export async function peerCommand(conn: Connection, positionals: string[], flags: Flags): Promise<void> {
  const [action, argument] = positionals;
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  const insecure = flags['insecure-allow-any-host'] ? { insecure: true } : {};
  try {
    switch (action) {
      case 'pair': {
        const pair = await call<{ url: string; token: string; name: string; command: string }>(conn, 'POST', '/api/peers/pair', { ...(flags.name ? { name: flags.name } : {}), ...insecure });
        if (flags.json) return out(JSON.stringify(pair));
        out(`This device: ${pair.name}`);
        out(`Address:     ${pair.url}`);
        out(`Token:       ${pair.token}`);
        out('');
        out('On the other device, run:');
        out(`  ${pair.command}`);
        return;
      }
      case 'add': {
        const token = flags.token ?? process.env.BOGEN_PEER_TOKEN;
        if (!argument || !token) throw new Refused('Usage: bogen peer add <url> --token <t> [--name <n>]');
        const added = await call<{ id: string; name: string; url: string }>(conn, 'POST', '/api/peers', { url: argument, token, ...(flags.name ? { name: flags.name } : {}), ...insecure });
        out(`Paired with ${added.name} at ${added.url}, both ways.`);
        for (let i = 0; i < 20; i++) {
          const { peers } = await call<PeersAnswer>(conn, 'GET', '/api/peers');
          const peer = peers.find((p) => p.id === added.id);
          if (peer?.state === 'connected') return out('Connected. Files sync from now on.');
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        out('Not connected yet. It keeps trying; see: bogen peer status');
        return;
      }
      case 'list': {
        const { peers } = await call<PeersAnswer>(conn, 'GET', '/api/peers');
        if (flags.json) return out(JSON.stringify(peers));
        if (!peers.length) return out('No paired devices. Start with: bogen peer pair');
        for (const p of peers) out(`${p.id}  ${p.name}  ${p.url}`);
        return;
      }
      case 'status': {
        const answer = await call<PeersAnswer>(conn, 'GET', '/api/peers');
        if (flags.json) return out(JSON.stringify(answer));
        out(`This device: ${answer.device.name} (${answer.device.id})`);
        out(`Tailnet:     ${answer.device.tailnetUrl ?? (answer.tailnet ? 'waiting for Tailscale' : 'off')}`);
        if (!answer.peers.length) return out('No paired devices.');
        for (const p of answer.peers) {
          out(`${p.name}: ${p.state}, last sync ${ago(p.lastSyncAt)}, ${p.pending} pending${p.error ? `, ${p.error}` : ''}`);
          out(`  transferred ${formatBytes(p.bytesIn ?? 0)} in, ${formatBytes(p.bytesOut ?? 0)} out since this server started`);
          out(`  last error: ${p.lastError ? `${p.lastError} (${ago(p.lastErrorAt ?? null)})` : 'none'}`);
          out(`  version: ${p.version ?? 'not reported, an older build'}${p.versionMismatch ? `, this device differs. Update with: bogen peer deploy <its ssh host>` : ''}`);
          for (const here of p.here ?? []) out(`  has a file open: ${here.fileId}, ${here.people.map((who) => `${who.name}, ${who.selection} selected`).join('; ')}`);
        }
        return;
      }
      case 'remove': {
        if (!argument) throw new Refused('Usage: bogen peer remove <id>');
        const removed = await call<{ removed: string; rotated: boolean }>(conn, 'DELETE', `/api/peers/${encodeURIComponent(argument)}`);
        out(`Removed ${removed.removed}. Run this on that device too, or it keeps trying to reach this one.`);
        out(removed.rotated ? 'No devices are left, so this device has a new token.' : 'Your other devices share this device\'s token, so it did not change.');
        return;
      }
      case 'tailnet': {
        if (argument !== 'on' && argument !== 'off') throw new Refused('Usage: bogen peer tailnet <on|off>');
        const state = await call<{ on: boolean; url: string | null; onAtStart?: boolean }>(conn, 'POST', '/api/peers/tailnet', { on: argument === 'on' });
        if (state.on) out(state.url ? `Listening on ${state.url}, token required.` : 'On. Waiting for Tailscale to come up.');
        else if (state.url) out(`Saved as off, but the listener on ${state.url} did not stop. Restart Bogen.`);
        else out(state.onAtStart ? 'Off. This server was started with --tailnet, so it listens again when it starts next. To keep it off, take --tailnet out of the bogen.service ExecStart line.' : 'Off.');
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
