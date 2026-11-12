import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BlockList, isIP, type Socket } from 'node:net';
import { errorMessage } from './util.ts';

const tailnetRanges = new BlockList();
tailnetRanges.addSubnet('100.64.0.0', 10, 'ipv4');
tailnetRanges.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** True for an address Tailscale hands out: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return tailnetRanges.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

const TS_NET_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/;

/**
 * Checks a peer's address and returns its normal form, `scheme://host[:port]`. Peers talk plain HTTP, which is
 * only private inside WireGuard, so anything off the tailnet is refused unless the caller was given explicit
 * test permission.
 */
export function normalizePeerUrl(raw: string, allowAnyHost = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`A peer URL must be http or https, not ${url.protocol}`);
  if (url.username || url.password) throw new Error('A peer URL cannot carry a user or password.');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('A peer URL is only a scheme, host and port.');
  if (!allowAnyHost) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowed = isIP(host) ? isTailnetAddress(host) : TS_NET_NAME.test(host.replace(/\.$/, ''));
    if (!allowed) throw new Error(`${url.hostname} is not on a tailnet. A peer must be in 100.64.0.0/10, fd7a:115c:a1e0::/48 or *.ts.net.`);
  }
  return url.origin;
}

/** Where the Tailscale CLI may be. A LaunchAgent's PATH is short, and on a Mac the CLI often lives in the app. */
export function tailscaleCommands(platform: NodeJS.Platform = process.platform, home = homedir()): string[] {
  const common = ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  if (platform !== 'darwin') return common;
  return [
    ...common, '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale', join(home, 'Applications/Tailscale.app/Contents/MacOS/Tailscale'),
  ];
}

type Exec = (command: string, args: string[]) => Promise<string>;

const realExec: Exec = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** This machine's Tailscale IPv4, or null when Tailscale is missing, stopped or logged out. */
export async function tailscaleIp(commands = tailscaleCommands(), exec: Exec = realExec): Promise<string | null> {
  for (const command of commands) {
    let out: string;
    try {
      out = await exec(command, ['ip', '-4']);
    } catch {
      continue;
    }
    const address = out.split('\n').map((line) => line.trim()).find((line) => isIP(line) === 4 && isTailnetAddress(line));
    if (address) return address;
  }
  return null;
}

/** What `tailscale status --json` says about this node and the others, as far as the phone needs it. */
export interface TailnetSelf {
  /** The MagicDNS name without the trailing dot, e.g. `omarchy.tail123456.ts.net`. */
  dnsName: string;
  /** The login that owns this node. */
  ownerLogin: string;
  ips: string[];
  peers: { name: string; dnsName: string; os: string; login: string; ips: string[] }[];
  /** Whether the tailnet policy gives this node the `funnel` attribute. Null when the status does not say. */
  funnel?: boolean | null;
}

/** One rule of the packet filter this node enforces on what comes in. */
export interface FilterRule { srcIps: string[]; dst: { ip: string; first: number; last: number }[]; protos: number[] }

/**
 * The parts of the Tailscale CLI that the phone listener uses. Only `serve` and `serveOff` change anything, and
 * only the one HTTPS port they are given: other apps own the rest of the serve config.
 */
export interface TailscaleCli {
  self(): Promise<TailnetSelf | null>;
  /** `tailscale serve status --json`, or null when it cannot be read. */
  serveStatus(): Promise<ServeStatus | null>;
  serve(httpsPort: number, target: string): Promise<void>;
  serveOff(httpsPort: number): Promise<void>;
  /** `tailscale funnel --bg --https=<port> <target>`: the same entry, open to the internet. Only that port. */
  funnel?(httpsPort: number, target: string): Promise<void>;
  /** `tailscale funnel --https=<port> off`, which takes the port's entry away. */
  funnelOff?(httpsPort: number): Promise<void>;
  /** Null when the netmap cannot be read. */
  packetFilter(): Promise<FilterRule[] | null>;
}

export interface ServeStatus {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
  /** `host:port` of the entries that Funnel opens to the internet. */
  AllowFunnel?: Record<string, boolean>;
}

export function parseTailscaleStatus(raw: unknown): TailnetSelf | null {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw as { Self?: { DNSName?: string; UserID?: number; TailscaleIPs?: string[]; CapMap?: Record<string, unknown>; Capabilities?: string[] }; User?: Record<string, { LoginName?: string }>; Peer?: Record<string, { HostName?: string; DNSName?: string; OS?: string; UserID?: number; TailscaleIPs?: string[] }> };
  const self = status.Self;
  const users = status.User ?? {};
  const login = (id: number | undefined) => (id === undefined ? '' : users[String(id)]?.LoginName ?? '');
  const dnsName = (self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  if (!self || !dnsName) return null;
  const caps = [...Object.keys(self.CapMap ?? {}), ...(self.Capabilities ?? [])];
  const said = self.CapMap !== undefined || self.Capabilities !== undefined;
  return {
    dnsName, ownerLogin: login(self.UserID), ips: self.TailscaleIPs ?? [],
    funnel: said ? caps.some((c) => c === 'funnel' || c === 'https://tailscale.com/cap/funnel') : null,
    peers: Object.values(status.Peer ?? {}).map((p) => ({ name: p.HostName ?? '', dnsName: (p.DNSName ?? '').replace(/\.$/, '').toLowerCase(), os: p.OS ?? '', login: login(p.UserID), ips: p.TailscaleIPs ?? [] })),
  };
}

type RawPorts = { First?: number; Last?: number };
type RawRule = { SrcIPs?: string[]; Srcs?: string[]; DstPorts?: { IP?: string; Ports?: RawPorts }[]; Dsts?: { Net?: string; Ports?: RawPorts }[]; IPProto?: number[] };

/**
 * `tailscale debug netmap` carries the policy twice: `PacketFilterRules` as the control server sent it
 * (SrcIPs, DstPorts with IP), and `PacketFilter` as the client compiled it (Srcs, Dsts with Net).
 * Either will do, so this reads the first that is there, in whichever of the two shapes.
 */
export function parsePacketFilter(raw: unknown): FilterRule[] | null {
  const netmap = raw as { PacketFilterRules?: unknown; PacketFilter?: unknown } | null;
  const rules = Array.isArray(netmap?.PacketFilterRules) ? netmap.PacketFilterRules : netmap?.PacketFilter;
  if (!Array.isArray(rules)) return null;
  return rules.map((r: RawRule) => ({
    srcIps: r.SrcIPs ?? r.Srcs ?? [],
    dst: [
      ...(r.DstPorts ?? []).map((d) => ({ ip: d.IP ?? '', first: d.Ports?.First ?? 0, last: d.Ports?.Last ?? 0 })),
      ...(r.Dsts ?? []).map((d) => ({ ip: d.Net ?? '', first: d.Ports?.First ?? 0, last: d.Ports?.Last ?? 0 })),
    ],
    protos: r.IPProto ?? [],
  }));
}

function inRange(address: string, range: string): boolean {
  if (range === '*') return true;
  const family = isIP(address);
  if (!family) return false;
  const [base, bits] = range.split('/');
  if (!base || isIP(base) !== family) return false;
  if (bits === undefined) return base === address;
  const list = new BlockList();
  list.addSubnet(base, Number(bits), family === 4 ? 'ipv4' : 'ipv6');
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether the filter lets any of `from` open TCP `port` on any of `to`. An empty protocol list means TCP and UDP. */
export function filterAllows(rules: FilterRule[], from: string[], to: string[], port: number): boolean {
  return rules.some((rule) => (!rule.protos.length || rule.protos.includes(6))
    && from.some((src) => rule.srcIps.some((range) => inRange(src, range)))
    && rule.dst.some((d) => port >= d.first && port <= d.last && to.some((ip) => inRange(ip, d.ip))));
}

/** The real CLI, tried at each place it may be. */
export function tailscaleCli(commands = tailscaleCommands()): TailscaleCli {
  const first = async (args: string[], maxBuffer = 1024 * 1024): Promise<string> => {
    let last: unknown = new Error('Tailscale is not installed.');
    for (const command of commands) {
      try {
        return await execBig(command, args, maxBuffer);
      } catch (e) {
        last = e;
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') break;
      }
    }
    throw last;
  };
  const json = async (args: string[]): Promise<unknown> => JSON.parse(await first(args, 32 * 1024 * 1024));
  return {
    self: async () => parseTailscaleStatus(await json(['status', '--json']).catch(() => null)),
    serveStatus: async () => (await json(['serve', 'status', '--json']).catch(() => null)) as ServeStatus | null,
    serve: async (httpsPort, target) => { await first(['serve', '--bg', `--https=${httpsPort}`, target]); },
    serveOff: async (httpsPort) => { await first(['serve', `--https=${httpsPort}`, 'off']); },
    funnel: async (httpsPort, target) => { await first(['funnel', '--bg', `--https=${httpsPort}`, target]); },
    funnelOff: async (httpsPort) => { await first(['funnel', `--https=${httpsPort}`, 'off']); },
    packetFilter: async () => parsePacketFilter(await json(['debug', 'netmap']).catch(() => null)),
  };
}

const execBig = (command: string, args: string[], maxBuffer: number): Promise<string> => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 10_000, maxBuffer }, (error, stdout, stderr) => {
    // Its own words say why, such as a port that is taken or serve not being allowed for this user.
    if (error) reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? error : new Error(String(stderr).trim() || error.message));
    else resolve(stdout);
  });
});

export interface TailnetListenerOptions {
  /** Builds a fresh server for each bind. */
  create: () => Server;
  port: () => number;
  resolve: () => Promise<string | null>;
  onChange?: () => void;
  retryMs?: number;
}

/**
 * The second listener. It binds only to the address `resolve` gives, never to a wildcard, and keeps trying,
 * since at boot Tailscale often comes up after this server. It follows the address if it changes.
 */
export class TailnetListener {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError = '';
  private ticking: Promise<void> | null = null;
  /** Every socket this listener accepted. An upgraded one, a peer's live link, is no longer the HTTP server's to close. */
  private sockets = new Set<Socket>();
  address: string | null = null;

  constructor(private readonly options: TailnetListenerOptions) {}

  get url(): string | null {
    return this.address ? `http://${this.address}:${this.options.port()}` : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** One attempt now, for a caller that wants the address right away. */
  async refresh(): Promise<string | null> {
    if (this.running) await this.tick();
    return this.url;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    const retry = this.options.retryMs ?? 5000;
    // Bound, this only watches for a changed address.
    this.timer = setTimeout(() => void this.tick(), this.address ? retry * 6 : retry);
    this.timer.unref();
  }

  /** Only one at a time, or two overlapping attempts would fight over the port. */
  private tick(): Promise<void> {
    this.ticking ??= this.attempt().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async attempt(): Promise<void> {
    const wanted = await this.options.resolve().catch(() => null);
    if (!this.running) return;
    if (wanted && wanted !== this.address) {
      await this.unbind();
      await this.bind(wanted);
    }
    this.schedule();
  }

  private bind(address: string): Promise<void> {
    return new Promise((resolve) => {
      const server = this.options.create();
      server.once('error', (e) => {
        const message = errorMessage(e);
        if (message !== this.lastError) console.error(`bogen: cannot listen on ${address}: ${message}. Trying again.`);
        this.lastError = message;
        resolve();
      });
      server.listen(this.options.port(), address, () => {
        if (!this.running) {
          server.close();
          return resolve();
        }
        server.removeAllListeners('error');
        server.on('error', (e) => console.error(`bogen: tailnet listener: ${errorMessage(e)}`));
        server.on('connection', (socket: Socket) => {
          this.sockets.add(socket);
          socket.once('close', () => this.sockets.delete(socket));
        });
        this.server = server;
        this.address = address;
        this.lastError = '';
        console.error(`bogen: listening on the tailnet at ${this.url}, token required`);
        this.options.onChange?.();
        resolve();
      });
    });
  }

  private unbind(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.address = null;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      // Off means off: the links that came in on this address go too, or the close above never finishes.
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.unbind();
    this.options.onChange?.();
  }
}
