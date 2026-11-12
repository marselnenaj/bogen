/**
 * The phone app and its devices, end to end, in a sandboxed Chromium (~/.local/bin/secure-chromium, its sandbox
 * on): notifications, photos, offline changes and their conflict notes, the list of computers, the iPad side
 * panel, and "Update the other device" in the desktop editor.
 *
 * Two real servers (packages/server) run in this process, paired as devices, and a TLS stand-in plays
 * `tailscale serve`: it ends HTTPS on a port of localhost, adds the Tailscale-User-Login header and passes
 * requests and sockets to the phone listener. The stand-in Tailscale CLI names this computer `localhost`, so the
 * Host and Origin rules of the phone listener hold as they do for a ts.net name. The browser can only reach
 * loopback ports it was given, which is why the name is localhost rather than a ts.net name here.
 *
 * Needs the built editor (npm run build) and openssl. Run: npx tsx apps/editor/test/e2e/phone-devices.ts
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { BogenServer } from '../../../../packages/server/src/http/server.ts';
import type { PushFetch } from '../../../../packages/server/src/push.ts';
import type { ServeStatus, TailscaleCli } from '../../../../packages/server/src/tailnet.ts';

const OWNER = 'owner@example.com';
const CHROMIUM = resolve(process.env.HOME ?? '', '.local/bin/secure-chromium');
const SHOTS = process.env.BOGEN_SHOTS ?? mkdtempSync(join(tmpdir(), 'bogen-phone-shots-'));
mkdirSync(SHOTS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'bogen-phone-e2e-'));

let passed = 0;
const failed: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed.push(`${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------- a certificate, a picture

function certificate(): { key: Buffer; cert: Buffer; spki: string } {
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}

/** A PNG of one colour, larger than the phone sends, so that it has to be scaled down. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([43, 61, 242], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Width and height of a JPEG, from its first frame header. */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** What the phone's browser does with a push message: RFC 8291 in reverse. */
function decrypt(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return plain.subarray(0, -1).toString('utf8');
}

// ---------------------------------------------------------------- stand-ins

function fakeTailscale(name: string): TailscaleCli {
  const config: ServeStatus = { TCP: {}, Web: {} };
  return {
    self: async () => ({ dnsName: name, ownerLogin: OWNER, ips: ['100.64.0.10'], peers: [] }),
    serveStatus: async () => structuredClone(config),
    serve: async (port, target) => {
      config.TCP![port] = { HTTPS: true };
      config.Web![`${name}:${port}`] = { Handlers: { '/': { Proxy: target } } };
    },
    serveOff: async () => {},
    packetFilter: async () => [],
  };
}

/** `tailscale serve` in small: TLS here, the login header added, everything else passed through to the phone listener. */
class ServeStandIn {
  private server: HttpsServer | null = null;
  private sockets = new Set<Duplex>();
  port = 0;
  constructor(private readonly tls: { key: Buffer; cert: Buffer }, private readonly target: () => number) {}

  async start(port = 0): Promise<void> {
    const server = createHttps(this.tls, (req, res) => {
      const headers = { ...req.headers, 'tailscale-user-login': OWNER };
      const out = request({ host: '127.0.0.1', port: this.target(), path: req.url, method: req.method, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on('error', () => res.destroy());
      req.pipe(out);
    });
    server.on('upgrade', (req, socket, head) => {
      const up = connect(this.target(), '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() !== 'tailscale-user-login') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        lines.push(`Tailscale-User-Login: ${OWNER}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      this.sockets.add(socket).add(up);
      const close = () => { socket.destroy(); up.destroy(); };
      up.on('error', close);
      socket.on('error', close);
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }

  /** The computer goes out of reach: every connection ends, nothing answers. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }
}

// ---------------------------------------------------------------- the run

async function boot(): Promise<{ pc: BogenServer; mac: BogenServer; serve: ServeStandIn; sent: { url: string; body: Buffer }[]; deployLog: string; spki: string }> {
  const tls = certificate();
  let pcRef: BogenServer | null = null;
  const serve = new ServeStandIn(tls, () => pcRef!.phone.boundPort);
  await serve.start();
  const sent: { url: string; body: Buffer }[] = [];
  const pushFetch: PushFetch = async (url, init) => {
    sent.push({ url, body: init.body });
    return { status: 201 };
  };
  const deployLog = join(work, 'deploy.log');
  const script = join(work, 'deploy.sh');
  writeFileSync(script, `#!/bin/bash\necho "$*" >> "${deployLog}"\nif [[ " $* " == *" --dry-run "* ]]; then echo "Dry run. Nothing will change on either device."; echo "Deploying Bogen 0.1.0+aaaaaaa to $1"; echo "  dist: would change 12 file(s)"; else echo "Deploying Bogen 0.1.0+aaaaaaa to $1"; echo "  dist: 12 file(s) changed"; echo "It answers: 0.1.0+aaaaaaa"; fi\n`);
  chmodSync(script, 0o755);
  const pcHome = join(work, 'pc');
  const macHome = join(work, 'mac');
  const pc = new BogenServer({ home: pcHome, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(pcHome, 'exports'), tailscale: fakeTailscale('localhost'), phonePort: 0, phoneHttpsPort: serve.port, pushFetch, deployScript: script, reportVersion: '0.1.0+aaaaaaa' });
  pcRef = pc;
  const mac = new BogenServer({ home: macHome, port: 0, insecureAllowAnyHost: true, peerCatchUpMs: 60_000, exportDir: join(macHome, 'exports'), tailscale: fakeTailscale('my-laptop.tail123456.ts.net'), phonePort: 0, phoneHttpsPort: 29443, reportVersion: '0.1.0+bbbbbbb' });
  await pc.listen();
  await mac.listen();
  const post = (s: BogenServer, path: string, body: unknown) => fetch(`${s.localUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post(pc, '/api/phone', { on: true });
  await post(mac, '/api/phone', { on: true });
  await post(mac, '/api/peers/pair', { insecure: true, name: 'MacBook' });
  const info = await (await post(pc, '/api/peers/pair', { insecure: true, name: 'omarchy' })).json() as { url: string; token: string };
  await post(mac, '/api/peers', { url: info.url, token: info.token, insecure: true, name: 'omarchy' });
  await until(() => pc.peers.status().some((p) => p.phoneUrl && p.versionMismatch), 10_000);
  return { pc, mac, serve, sent, deployLog, spki: tls.spki };
}

async function phonePage(browser: Browser, width: number, height: number, push: { endpoint: string; p256dh: string; auth: string }): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'.replace(/iPhone/g, width >= 700 ? 'iPad' : 'iPhone'));
  // tsx names functions with a helper that the page does not have.
  await page.evaluateOnNewDocument('window.__name = (f) => f');
  // Headless Chromium has no push service. The stand-in gives the subscription a phone would: an address at
  // Apple's push service and a key pair the test holds, so that it can read what the computer sends.
  await page.evaluateOnNewDocument((sub: { endpoint: string; p256dh: string; auth: string }) => {
    const b = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
    let current: unknown = null;
    const make = (key: ArrayBuffer) => ({
      endpoint: sub.endpoint, options: { applicationServerKey: key },
      toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }),
      getKey: (n: string) => b(n === 'p256dh' ? sub.p256dh : sub.auth),
      unsubscribe: async () => { current = null; return true; },
    });
    if ('PushManager' in window) {
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) { current = make(options!.applicationServerKey as ArrayBuffer); return current as PushSubscription; };
      PushManager.prototype.getSubscription = async function () { return current as PushSubscription | null; };
    }
    Notification.requestPermission = async () => 'granted';
  }, push);
  return page;
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) as `${string}.png` });
const text = (page: Page, selector: string) => page.$eval(selector, (el) => (el as HTMLElement).innerText).catch(() => '');
async function tap(page: Page, selector: string): Promise<void> {
  await page.waitForSelector(selector, { visible: true, timeout: 10_000 });
  await page.tap(selector);
}
async function pickFile(page: Page, selector: string, path: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), tap(page, selector)]);
  await chooser.accept([path]);
}

async function main(): Promise<void> {
  const { pc, mac, serve, sent, deployLog, spki } = await boot();
  const origin = `https://localhost:${serve.port}`;
  const room = async (id: string) => pc.rooms.get(id);

  // A file with a board, a card on it and colour tokens.
  const { id: fileId } = await (await fetch(`${pc.localUrl()}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Landing page' }) })).json() as { id: string };
  const r0 = await room(fileId);
  const pageId = r0.doc.getPages()[0]!.id;
  let cardId = '';
  r0.doc.transact(() => {
    r0.doc.setToken('ink', 'color', '#0e0e0c');
    r0.doc.setToken('tomato', 'color', '#f2361f');
    const board = r0.doc.insert(pageId, { type: 'frame', name: 'Home', artboard: true, style: { position: 'absolute', left: '0px', top: '0px', width: '393px', height: '852px', backgroundColor: '#f4f2ec' } });
    cardId = r0.doc.insert(board, { type: 'frame', name: 'Card', style: { position: 'absolute', left: '40px', top: '120px', width: '300px', height: '200px', backgroundColor: '#ffffff' } });
  });

  const phoneKey = createECDH('prime256v1');
  phoneKey.generateKeys();
  const auth = randomBytes(16);
  const push = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH-e2e', p256dh: phoneKey.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  // The browser runs in its own filesystem; this folder is the one it is given to read from.
  const transfer = join(work, 'transfer');
  mkdirSync(transfer);
  const photo = join(transfer, 'photo.png');
  writeFileSync(photo, png(3000, 2000));

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM, pipe: true, headless: true, env: { ...process.env, SECURE_BROWSER_TRANSFER_DIR: transfer },
    args: [`--secure-local-port=${serve.port}`, `--secure-local-port=${pc.port}`, `--ignore-certificate-errors-spki-list=${spki}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    await browser.defaultBrowserContext().overridePermissions(origin, ['notifications']);
    const errors: string[] = [];

    // ------------------------------------------------ pair at 393 x 852, with touch
    const page = await phonePage(browser, 393, 852, push);
    page.on('pageerror', (e) => errors.push(String((e as Error).stack ?? (e as Error).message).slice(0, 1500)));
    const { code } = await (await fetch(`${pc.localUrl()}/api/phone/code`, { method: 'POST' })).json() as { code: string };
    await page.goto(`${origin}/#/pair/${code}`);
    await tap(page, '.pair-secondary');
    await page.waitForSelector('[data-testid="phone-inbox"]', { timeout: 15_000 });
    check('phone: pairs through the TLS stand-in and opens the inbox', true);
    check('phone: the shell says which computer it is', (await page.$eval('meta[name="bogen-host"]', (m) => m.getAttribute('content'))) === 'omarchy');
    check('phone: four tabs, Settings among them', (await page.$$('.phone-tab')).length === 4 && Boolean(await page.$('[data-testid="phone-tab-settings"]')));

    // ------------------------------------------------ settings: computers and notifications
    await tap(page, '[data-testid="phone-tab-settings"]');
    await page.waitForSelector('[data-testid="set-host-other"]', { timeout: 10_000 });
    const hosts = await text(page, '[data-testid="set-hosts"]');
    check('settings: this app is omarchy, and the MacBook has its own app', hosts.includes('omarchy') && hosts.includes('This app') && hosts.includes('MacBook') && hosts.includes('Has its own Bogen app'), hosts);
    check('settings: the MacBook\'s address is its own phone address', (await page.$eval('[data-testid="set-host-other"] a', (a) => a.getAttribute('href'))) === 'https://my-laptop.tail123456.ts.net:29443/');
    await page.waitForSelector('[data-testid="set-push-toggle"]:not([disabled])', { timeout: 10_000 });
    await tap(page, '[data-testid="set-push-toggle"]');
    await page.waitForSelector('[data-testid="set-push-test"]', { timeout: 10_000 }).catch(async (e) => {
      console.log('settings said:', await page.$eval('[data-testid="set-push"]', (el) => el.outerHTML).catch(() => ''), errors);
      await shot(page, 'phone-devices-debug');
      throw e;
    });
    check('notifications: the toggle turns them on, with the push service named', (await text(page, '[data-testid="set-push"]')).includes("Apple's push service"));
    const stored = JSON.parse(readFileSync(join(pc.options.home, 'push.json'), 'utf8')) as { devices: Record<string, { subscription: { endpoint: string } | null }> };
    check('notifications: the computer keeps the subscription for this phone', Object.values(stored.devices)[0]?.subscription?.endpoint === push.endpoint);
    await shot(page, 'phone-devices-settings-393');
    await tap(page, '[data-testid="set-push-test"]');
    await until(() => sent.length >= 1);
    const test = sent[0] ? JSON.parse(decrypt(sent[0].body, phoneKey, auth)) as { title: string } : null;
    check('notifications: Send a test reaches the push service, readable only with the phone\'s key', test?.title === 'Notifications are on', test);
    pc.fileEvents.append(fileId, 'agent_finished', { source: 'agent', actor: 'claude' }, { agent: 'claude', run_id: 'e2e', status: 'done' });
    await until(() => sent.length >= 2);
    const finished = sent[1] ? JSON.parse(decrypt(sent[1].body, phoneKey, auth)) as Record<string, string> : null;
    check('notifications: an agent that finished, with the file\'s name and nothing else', finished?.title === 'Claude finished' && finished.body === 'Landing page' && Object.keys(finished).sort().join() === 'body,kind,tag,title,url', finished);

    // The service worker shows a message as it would arrive, and a tap would open its route.
    const cdp = await page.createCDPSession();
    const registrations: { registrationId: string; scopeURL: string }[] = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => registrations.push(...e.registrations));
    await cdp.send('ServiceWorker.enable');
    await until(() => registrations.length > 0, 5000);
    const reg = registrations.find((r) => r.scopeURL.startsWith(origin));
    if (reg) {
      await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data: JSON.stringify({ title: 'Codex has a proposal ready', body: 'Landing page', url: `#/review/${fileId}/p1`, tag: 'bogen-proposal-x', kind: 'proposal' }) });
      const shown = await until(async () => (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}|${n.body}|${(n.data as { url: string }).url}`))).some((n) => n.startsWith('Codex has a proposal ready|Landing page|#/review/')), 6000);
      check('service worker: a push message becomes a notification with its route', shown);
    } else check('service worker: registered on the phone origin', false, registrations);

    // ------------------------------------------------ a file: photos
    await tap(page, '[data-testid="phone-tab-files"]');
    await tap(page, `[data-file-id="${fileId}"] .phone-file-open`);
    await page.waitForSelector('[data-testid="pf-tool-photo"]:not([disabled])', { timeout: 15_000 });
    check('file: the tools have a Photo', true);
    await tap(page, '[data-testid="pf-tool-photo"]');
    await page.waitForSelector('[data-testid="pf-photo"]');
    await shot(page, 'phone-devices-photo-sheet-393');
    await pickFile(page, '[data-testid="pf-photo-library"]', photo);
    const placed = await until(async () => (await text(page, '[data-testid="toast"]')).startsWith('Placed'), 15_000);
    const toast = await text(page, '[data-testid="toast"]');
    if (!placed) console.log('photo status:', await text(page, '[data-testid="pf-photo-status"]'), errors);
    check('photo: placed on the board, scaled and without camera data', placed && toast.includes('2048 × 1365') && toast.includes('Location'), toast);
    const image = [...(await room(fileId)).doc.nodes.keys()].map((id) => r0.doc.getNode(id)).find((n) => n?.type === 'image');
    const name = image?.src?.replace('bogen-asset:', '') ?? '';
    const size = name ? jpegSize(readFileSync(join(pc.options.home, 'assets', name))) : null;
    check('photo: an image layer on the board, a JPEG of 2048 x 1365 on the computer', Boolean(image) && name.endsWith('.jpg') && size?.width === 2048 && size?.height === 1365 && image?.parent !== pageId, { name, size, parent: image?.parent });
    await shot(page, 'phone-devices-photo-placed-393');

    // A photo with a comment.
    await tap(page, '[data-testid="pf-tool-comment"]');
    await page.waitForSelector('[data-testid="pf-comment-hint"]');
    const canvasBox = (await (await page.$('[data-testid="phone-canvas"]'))!.boundingBox())!;
    await page.touchscreen.tap(canvasBox.x + 60, canvasBox.y + 60);
    await page.waitForSelector('[data-testid="pf-comment-input-attach"]', { timeout: 8000 });
    await pickFile(page, '[data-testid="pf-comment-input-attach"]', photo);
    await page.waitForSelector('[data-testid="pf-comment-input-photo"]', { timeout: 15_000 });
    await page.type('[data-testid="pf-comment-input"]', 'Like this, but darker');
    await tap(page, '[data-testid="pf-comment-input-send"]');
    await page.waitForSelector('[data-testid="pf-message-photo"]', { timeout: 10_000 });
    const thread = (await room(fileId)).doc.getComments().at(-1);
    check('photo: a comment carries it as an image attachment', thread?.messages[0]?.attachments?.[0]?.kind === 'image' && thread.messages[0].attachments[0].src.endsWith('.jpg'), thread?.messages[0]);
    await shot(page, 'phone-devices-comment-photo-393');
    await tap(page, '[data-testid="pf-tool-comment"]');

    // A photo with Ask: the run is asked with the image. No CLI runs here, so only the request is looked at.
    const runBodies: string[] = [];
    page.on('request', (req) => { if (req.url().endsWith('/api/runs') && req.method() === 'POST') runBodies.push(req.postData() ?? ''); });
    await tap(page, '[data-testid="pf-tool-ask"]');
    await pickFile(page, '[data-testid="pf-ask-attach"]', photo);
    await page.waitForSelector('[data-testid="pf-ask-photo"]', { timeout: 15_000 });
    await page.type('[data-testid="pf-ask-input"]', 'Use this photo in the hero');
    await tap(page, '[data-testid="pf-ask-send"]');
    await until(() => runBodies.length > 0, 6000);
    const run = runBodies[0] ? JSON.parse(runBodies[0]) as { images?: string[] } : null;
    check('photo: Ask sends it with the request as an image', Boolean(run?.images?.[0]?.startsWith('bogen-asset:')), run);
    await tap(page, '[data-testid="pf-tool-ask"]');

    // ------------------------------------------------ offline: the queue, last synced, a conflict note
    await tap(page, '[data-testid="pf-tool-layers"]');
    await tap(page, `[data-layer-id="${cardId}"] .pf-layer-pick`);
    await tap(page, `[data-layer-id="${cardId}"] [data-testid="pf-layer-edit"]`);
    await tap(page, '[data-testid="pf-edit-fill"]');
    await page.waitForSelector('[data-testid="pf-swatch"][data-swatch]', { timeout: 8000 });
    await serve.stop();
    const offline = await until(async () => (await text(page, '[data-testid="connection-banner"]')).includes('Offline'), 15_000);
    check('offline: the file says so when the computer is out of reach', offline, await text(page, '[data-testid="connection-banner"]'));
    const swatches = await page.$$eval('[data-testid="pf-swatch"]', (els) => els.map((e) => e.getAttribute('data-swatch')));
    const tomato = swatches.find((s) => s && /tomato/.test(s)) ?? swatches.find((s) => s && s !== 'none');
    await tap(page, `[data-testid="pf-swatch"][data-swatch="${tomato}"]`);
    const queued = await until(async () => /1 change waits for omarchy\. Last synced (just now|1 min ago)\./.test(await text(page, '[data-testid="connection-banner"]')), 6000);
    check('offline: the change waits, counted, with the last sync time', queued, await text(page, '[data-testid="connection-banner"]'));
    await shot(page, 'phone-devices-offline-queue-393');
    // Meanwhile on the computer: the same fill, another value.
    (await room(fileId)).doc.updateStyle(cardId, { backgroundColor: '#0000ff' });
    await serve.start(serve.port);
    const noted = await until(async () => Boolean(await page.$('[data-testid="pf-conflicts"]')), 25_000);
    check('back online: the change goes over first, and a note says both sides set the fill', noted);
    const notes = pc.peers.conflicts.list(fileId);
    check('back online: the computer keeps the note, from this phone', notes.length === 1 && notes[0]!.field === 'style.backgroundColor' && notes[0]!.ours === '#0000ff' && notes[0]!.device === 'iPhone', notes);
    const banner = await until(async () => !(await page.$('[data-testid="connection-banner"]')), 10_000);
    check('back online: in sync, the banner goes', banner);
    await tap(page, '[data-testid="pf-conflicts-toggle"]');
    const note = await text(page, '[data-testid="pf-conflict"]');
    check('conflict note: both values, whose they are, and which stayed', note.includes('omarchy: #0000ff') && note.includes('This phone: var(--') && note.includes('Kept the one from'), note);
    await shot(page, 'phone-devices-conflict-393');
    const kept = notes[0]!.kept;
    await tap(page, '[data-testid="pf-conflict-use"]');
    const after = await until(async () => {
      const v = (await room(fileId)).doc.getNode(cardId)?.style.backgroundColor;
      return kept === 'ours' ? v !== '#0000ff' : v === '#0000ff';
    }, 6000);
    check('conflict note: the other value comes back with one tap, and the note goes', after && await until(() => pc.peers.conflicts.list(fileId).length === 0, 4000));

    await tap(page, '[data-testid="phone-back"]');
    await page.waitForSelector(`[data-file-id="${fileId}"] [data-testid="phone-file-sync"]`, { timeout: 10_000 });
    const row = await text(page, `[data-file-id="${fileId}"] [data-testid="phone-file-sync"]`);
    check('files: each file says when it last synced', /synced (just now|1 min ago)/.test(row), row);
    await shot(page, 'phone-devices-files-393');

    // ------------------------------------------------ the iPad: a side panel, and the canvas gets the rest
    const pad = await phonePage(browser, 820, 1180, push);
    pad.on('pageerror', (e) => errors.push(String((e as Error).message)));
    await pad.goto(`${origin}/#/file/${fileId}`);
    await pad.waitForSelector('[data-testid="pf-tool-layers"]:not([disabled])', { timeout: 15_000 });
    const before = (await (await pad.$('[data-testid="phone-canvas"]'))!.boundingBox())!;
    await tap(pad, '[data-testid="pf-tool-layers"]');
    await pad.waitForSelector('.pf-sheet');
    await sleep(300);
    const sheet = (await (await pad.$('.pf-sheet'))!.boundingBox())!;
    const canvas = (await (await pad.$('[data-testid="phone-canvas"]'))!.boundingBox())!;
    check('iPad: the sheet is a panel at the right, as tall as the canvas', Math.round(sheet.x + sheet.width) === 820 && sheet.width >= 360 && sheet.width <= 400 && Math.abs(sheet.height - canvas.height) < 2, { sheet, canvas });
    check('iPad: the canvas gets the rest of the width', Math.abs(canvas.width + sheet.width - 820) < 2 && canvas.width < before.width, { before: before.width, after: canvas.width });
    const boardBox = await pad.evaluate((id) => {
      const el = document.querySelector(`[data-bogen-id="${id}"]`);
      const r = el?.getBoundingClientRect();
      return r ? { x: r.x, width: r.width } : null;
    }, (await room(fileId)).doc.getNode(cardId)!.parent);
    check('iPad: the board fits the narrower canvas again', Boolean(boardBox) && boardBox!.x >= canvas.x - 1 && boardBox!.x + boardBox!.width <= canvas.x + canvas.width + 1, { boardBox, canvas });
    const viewport = await pad.evaluate(() => document.querySelector('[data-testid="phone-canvas"] .canvas')?.getBoundingClientRect().width ?? 0);
    check('iPad: the canvas itself is measured at that width', Math.abs(viewport - canvas.width) < 2, viewport);
    check('iPad: no drag handle, a close button instead', !(await pad.$eval('.pf-handle', (el) => (el as HTMLElement).offsetParent !== null)) && await pad.$eval('[data-testid="pf-sheet-close"]', (el) => (el as HTMLElement).offsetParent !== null));
    await shot(pad, 'phone-devices-ipad-panel-820');
    await tap(pad, '[data-testid="pf-sheet-close"]');
    check('iPad: the close button closes the panel', await until(async () => !(await pad.$('.pf-sheet')), 3000));
    await pad.goto(`${origin}/#/settings`);
    await pad.waitForSelector('[data-testid="phone-settings"]');
    const set = (await (await pad.$('.phone-sets'))!.boundingBox())!;
    check('iPad: settings keep a readable width in the middle', set.width <= 720 && Math.abs(set.x - (820 - set.width) / 2) < 2, set);
    await shot(pad, 'phone-devices-ipad-settings-820');
    await pad.close();

    // A phone at 393 still has bottom sheets.
    await page.goto(`${origin}/#/file/${fileId}`);
    await page.waitForSelector('[data-testid="pf-tool-layers"]:not([disabled])', { timeout: 15_000 }).catch(async (e) => {
      await shot(page, 'phone-devices-debug');
      console.log('393 again:', page.url(), errors, await page.evaluate(() => document.body.innerText.slice(0, 300)));
      throw e;
    });
    await tap(page, '[data-testid="pf-tool-layers"]');
    await page.waitForSelector('.pf-sheet');
    const bottom = (await (await page.$('.pf-sheet'))!.boundingBox())!;
    check('phone: at 393 the sheet stays at the bottom, full width, with its handle', bottom.width === 393 && bottom.x === 0 && await page.$eval('.pf-handle', (el) => (el as HTMLElement).offsetParent !== null), bottom);
    await page.close();

    // ------------------------------------------------ the desktop: update the other device
    const desk = await browser.newPage();
    await desk.setViewport({ width: 1440, height: 900 });
    await desk.evaluateOnNewDocument('window.__name = (f) => f');
    desk.on('pageerror', (e) => errors.push(String((e as Error).message)));
    await desk.goto(`${pc.localUrl()}/#/file/${fileId}`);
    await desk.waitForSelector('[data-testid="sync-update"]', { timeout: 15_000 });
    check('desktop: the sync indicator offers to update the device with another build', (await text(desk, '[data-testid="sync-status"]')).includes('Update the other device'));
    await desk.click('[data-testid="sync-status"]');
    await desk.waitForSelector('[data-testid="peer-deploy-host"]');
    const versions = await text(desk, '[data-testid="peer-deploy-versions"]');
    check('desktop: the dialog names both builds', versions.includes('0.1.0+bbbbbbb') && versions.includes('0.1.0+aaaaaaa'), versions);
    check('desktop: Update waits for a dry run', await desk.$eval('[data-testid="peer-deploy-run"]', (b) => (b as HTMLButtonElement).disabled));
    await desk.$eval('[data-testid="peer-deploy-host"]', (el) => (el as HTMLInputElement).select());
    await desk.type('[data-testid="peer-deploy-host"]', 'my-laptop@127.0.0.1');
    await desk.click('[data-testid="peer-deploy-dry"]');
    await desk.waitForSelector('[data-testid="peer-deploy-result"][data-dry="yes"]', { timeout: 10_000 });
    check('desktop: the dry run shows what would change', (await text(desk, '[data-testid="peer-deploy-result"]')).includes('would change 12 file(s)'));
    await shot(desk, 'phone-devices-deploy-dry-1440');
    await desk.click('[data-testid="peer-deploy-run"]');
    await desk.waitForSelector('[data-testid="peer-deploy-result"][data-dry="no"]', { timeout: 10_000 });
    const calls = readFileSync(deployLog, 'utf8').trim().split('\n');
    check('desktop: then the update runs bogen peer deploy for that host', (await text(desk, '[data-testid="peer-deploy-result"]')).includes('restarted with this build') && calls.length === 2 && calls[0]!.startsWith('my-laptop@127.0.0.1 --dry-run') && !calls[1]!.includes('--dry-run'), calls);
    await shot(desk, 'phone-devices-deploy-done-1440');
    await desk.close();

    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    await serve.stop();
    await pc.close();
    await mac.close();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed.length} checks passed. Pictures in ${SHOTS}`);
  for (const f of failed) console.log(`  FAIL ${f}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
