import { accessSync, constants, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportDocument, fontLinks, googleFontsHrefs, hostedFamilies, RESET_CSS, rulesCss, tokensCss, type BogenDoc, type BogenNode } from '@bogen/core';
import { PDFDocument } from 'pdf-lib';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';
import { firstFamily } from './fonts.ts';
import { parseRange } from './http/assets.ts';
import { fetchPublic, isPublicUrl } from './net-guard.ts';
import { embedFontFaces, vectorizeInPage, type VectorSvg } from './svg-vector.ts';
import { errorMessage } from './util.ts';

/** Pages load from this name, answered by request interception. It has no route to the real server. */
const RENDER_ORIGIN = 'http://bogen.render';
const RUNTIME_PATH = '/__bogen/shaders.js';
const IDLE_MS = 60_000;
const MAX_PAGES = 3;
/** Bound preview context lifetime while amortizing page/context startup. */
export const PREVIEW_BATCH_SIZE = 4;
export type PreviewCapture = (doc: BogenDoc, node: string, options: ScreenshotOptions) => Promise<ScreenshotResult>;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const MAX_DIMENSION = 24000;
// One capture holds at most 8192 device pixels each way; past that, Chromium repeats its first rows. Bigger images are taken in tiles.
export const TILE = 8000;
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export type RasterFormat = 'png' | 'jpg' | 'webp';
export interface Target { pageId?: string; nodeIds?: string[] }
export interface Rect { x: number; y: number; width: number; height: number }

export interface ScreenshotOptions {
  /** Internal secondary raster, captured from the same settled page. */
  previewDimension?: number;
  scale?: number;
  format?: RasterFormat;
  quality?: number;
  /** Longest side of the result in pixels. */
  maxDimension?: number;
  /** Largest encoded size. The image is scaled down until it fits. */
  maxBytes?: number;
  transparent?: boolean;
}

export interface ScreenshotResult {
  preview?: Uint8Array;
  cssWidth?: number;
  cssHeight?: number;
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  scale: number;
  format: RasterFormat;
}

export interface LayoutEntry { id: string; x: number; y: number; width: number; height: number }

export interface ImageBytes { bytes: Uint8Array; mime: string }
export interface ImageDiff {
  sizeA: { width: number; height: number };
  sizeB: { width: number; height: number };
  /** Pixels compared: the union of both images, or A's size with `fit`. */
  total: number;
  different: number;
  /** Where the differences are, in pixels of A. */
  bounds: Rect | null;
  /** A's picture faded, with differing pixels in red. */
  png: Uint8Array;
  pngWidth: number;
  pngHeight: number;
  /** With `overlay`: only the differing pixels, in translucent red, the rest transparent, at the size of `png`. */
  overlayPng?: Uint8Array;
}
export interface WidthResult<T> { width: number; height: number; result: T; shot?: Uint8Array }

export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BOGEN_BROWSER) return env.BOGEN_BROWSER;
  // Use the user's isolated, maintained browser when installed, including for background thumbnails.
  const secure = join(homedir(), '.local', 'bin', 'secure-chromium');
  try { accessSync(secure, constants.X_OK); return secure; } catch { /* Ordinary installations use their system browser. */ }
  const names = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable'];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const path = join(dir, name);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        // Try the next one.
      }
    }
  }
  const fixed = [
    ...['/Applications', join(homedir(), 'Applications')].flatMap((apps) => [
      `${apps}/Google Chrome.app/Contents/MacOS/Google Chrome`, `${apps}/Chromium.app/Contents/MacOS/Chromium`,
      `${apps}/Brave Browser.app/Contents/MacOS/Brave Browser`, `${apps}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
    ]),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return fixed.find((p) => existsSync(p)) ?? null;
}

/**
 * Whether the browser is a wrapper that keeps Chromium off this computer's ports unless a port is shared with it when
 * it starts (`--secure-local-port=PORT`), as ~/.local/bin/secure-chromium does. Such a browser answers any other local
 * address with an empty 403 page.
 */
export function sharesLocalPorts(path: string): boolean {
  return /(^|[/\\])secure-chromium$/.test(path);
}

/** Bundled next to the CLI in a build. In development esbuild makes it on first use. */
let runtimeBundle: Promise<string> | null = null;
export function shaderRuntime(): Promise<string> {
  runtimeBundle ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const built = join(here, 'shader-runtime.js');
    if (existsSync(built)) return readFile(built, 'utf8');
    const esbuild = await import('esbuild');
    const result = await esbuild.build({ entryPoints: [join(here, 'shader-runtime.ts')], bundle: true, format: 'iife', minify: true, write: false, platform: 'browser', target: 'chrome110', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    return result.outputFiles[0]!.text;
  })();
  return runtimeBundle;
}

export function usedFamilies(doc: BogenDoc): string[] {
  const families = new Set(fontLinks(doc));
  for (const t of doc.getTokens()) if (t.kind === 'font-family') families.add(firstFamily(t.value));
  const hosted = hostedFamilies(doc);
  return [...families].filter((f) => f && !hosted.has(f.toLowerCase()) && !f.startsWith('var(') && !/^(serif|sans-serif|monospace|system-ui|cursive|fantasy|inherit|initial|ui-[\w-]+)$/i.test(f));
}

export function fontLinkTags(doc: BogenDoc): string {
  return usedFamilies(doc).flatMap(googleFontsHrefs).map((href) => `<link rel="stylesheet" href="${href.replace(/&/g, '&amp;').replace(/"/g, '%22')}">`).join('');
}

/** Parameters for the shader runtime, safe to place inside a `<script>`. */
export function shaderParamsTag(doc: BogenDoc, resolve: (src: string) => string): string {
  const params: Record<string, Record<string, string>> = {};
  const add = (n: BogenNode | undefined) => {
    if (n?.type !== 'shader') return;
    const attrs = { ...(n.attrs ?? {}) };
    const image = attrs.image ?? n.src;
    if (image) attrs.image = resolve(image);
    params[n.id] = attrs;
  };
  doc.nodes.forEach((m, id) => {
    add(doc.getNode(id));
    // A shader inside an instance has an id of its own there, and can have other parameters.
    if (m.get('instanceOf') !== undefined) doc.descendants(id).forEach(add);
  });
  if (!Object.keys(params).length) return '';
  return `<script>window.__BOGEN_SHADERS__=${JSON.stringify(params).replace(/</g, '\\u003c')}</script>`;
}

function resolveAsset(src: string): string {
  return src.startsWith('bogen-asset:') ? `${RENDER_ORIGIN}/assets/${src.slice('bogen-asset:'.length)}` : src;
}

/** Top-level layers that a target needs on the page, so that nested layers keep their context. */
function rootsOf(doc: BogenDoc, target: Target): string[] {
  if (target.nodeIds?.length) {
    const roots = new Set<string>();
    for (const id of target.nodeIds) {
      if (!doc.getNode(id)) throw new Error(`No layer with id ${id}.`);
      roots.add(doc.ancestors(id).at(-1) ?? id);
    }
    return [...roots];
  }
  const pageId = target.pageId ?? doc.getPages()[0]?.id;
  if (!pageId) throw new Error('The file has no pages.');
  const roots = doc.getChildren(pageId).filter((n) => !n.hidden).map((n) => n.id);
  if (!roots.length) throw new Error('The page is empty, so there is nothing to render. Add an artboard first.');
  return roots;
}

/** One headless browser shared by all jobs. Closed after a minute without work. */
export class Renderer {
  private browser: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private active = 0;
  private waiting: (() => void)[] = [];
  private fontCache = new Map<string, { status: number; contentType: string; body: Uint8Array; at: number }>();
  /** Local ports a port-scoped browser wrapper is started with, and whether the running browser lacks one of them. */
  private localPorts = new Set<number>();
  private portsChanged = false;
  /** Pages of code components, which layers load in sandboxed frames from `/api/code/`. Set by the server. */
  codeFrames?: (url: URL) => Promise<{ status: number; headers: Record<string, string>; body: string }> | null;

  constructor(private readonly readAsset: (name: string) => Promise<{ bytes: Uint8Array; mime: string } | null>, private readonly idleMs = IDLE_MS) {}

  /**
   * Asked before a browser starts (not while one runs): a reason not to start one now, such as the machine being out of
   * memory. A render then fails at once with that reason, instead of a new Chromium tipping the system into the OOM killer.
   */
  launchGuard?: () => string | null;

  /** Whether a browser is running or starting. */
  get running(): boolean {
    return this.browser !== null;
  }

  /** Closes the browser now when nothing is rendering, rather than after the idle minute. For memory pressure. */
  async releaseIdle(): Promise<boolean> {
    if (this.active > 0 || !this.browser) return false;
    await this.close();
    return true;
  }

  get busy(): boolean { return this.active > 0 || this.waiting.length > 0; }

  /**
   * Lets a port-scoped browser wrapper (see `sharesLocalPorts`) reach a port of this computer, for a page the person
   * asked for from this device. A wrapper takes its ports only when it starts, so a browser running without this one
   * starts again before the next site page, once nothing else is rendering. Other browsers need nothing.
   * Returns false when the browser is such a wrapper and will not have the port in time.
   */
  shareLocalPort(port: number): boolean {
    const path = findBrowser();
    if (!path || !sharesLocalPorts(path) || !Number.isInteger(port) || port < 1 || port > 65535) return true;
    if (!this.localPorts.has(port)) {
      this.localPorts.add(port);
      if (this.browser) this.portsChanged = true;
    }
    return !this.portsChanged || this.active === 0;
  }

  private launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    const refused = this.launchGuard?.();
    if (refused) return Promise.reject(new Error(refused));
    const path = findBrowser();
    if (!path) throw new Error('No Chromium-based browser was found. Install chromium or set BOGEN_BROWSER to the path of one.');
    const shared = sharesLocalPorts(path) ? [...this.localPorts].map((port) => `--secure-local-port=${port}`) : [];
    this.portsChanged = false;
    this.browser = (async () => {
      const puppeteer = (await import('puppeteer-core')).default;
      const browser = await puppeteer.launch({
        executablePath: path,
        headless: true,
        pipe: true,
        args: [
          '--no-first-run', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none',
          '--disable-background-networking', '--disable-extensions', '--disable-sync', '--mute-audio',
          '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
          ...shared,
          ...(process.env.BOGEN_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
        ],
      });
      browser.once('disconnected', () => {
        this.browser = null;
      });
      return browser;
    })().catch((e) => {
      this.browser = null;
      throw new Error(`Could not start ${path}: ${errorMessage(e)}. In a container without user namespaces, set BOGEN_NO_SANDBOX=1.`);
    });
    return this.browser;
  }

  private scheduleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const pending = this.browser;
    this.browser = null;
    if (pending) await pending.then((b) => b.close()).catch(() => {});
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_PAGES) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
      if (this.active === 0) this.scheduleClose();
    }
  }

  /** The browser, while it is in use by nobody else's clock: for encoders that run in a page. */
  async withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
    return this.slot(async () => fn(await this.launch()));
  }

  /** The target rendered with shaders live instead of as pictures, and its box, for making video. */
  async withLivePage<T>(doc: BogenDoc, target: Target, fn: (page: Page, browser: Browser, rect: Rect) => Promise<T>): Promise<T> {
    const roots = rootsOf(doc, target);
    return this.withPage(doc, roots, async (page) => {
      const whole = await this.alignRoots(page, roots, false);
      if (!whole.width || !whole.height) throw new Error('Nothing to capture: the target is hidden or has no size.');
      await page.setViewport({ width: Math.max(DEFAULT_VIEWPORT.width, Math.min(MAX_DIMENSION, Math.ceil(whole.width))), height: Math.max(DEFAULT_VIEWPORT.height, Math.min(MAX_DIMENSION, Math.ceil(whole.height))), deviceScaleFactor: 1 });
      await page.evaluate(nextPaint);
      const rect = target.nodeIds?.length ? await this.targetRect(page, target.nodeIds) : whole;
      if (!rect) throw new Error('Nothing to capture: the layer is hidden or has no size.');
      return fn(page, await this.launch(), rect);
    }, true);
  }

  /**
   * One tab that shows document after document, for a replay: `load` puts a document's roots in it and waits until
   * they have drawn. A hundred states cost one tab and one slot, not a hundred.
   */
  async withStatePage<T>(fn: (load: (doc: BogenDoc, roots: string[]) => Promise<Page>) => Promise<T>): Promise<T> {
    return this.slot(async () => {
      const browser = await this.launch();
      const page = await browser.newPage();
      let html = '';
      let loads = 0;
      try {
        await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          this.answer(req, html).catch(() => req.abort().catch(() => {}));
        });
        await page.setViewport({ ...DEFAULT_VIEWPORT, deviceScaleFactor: 1 });
        return await fn(async (doc, roots) => {
          html = this.htmlFor(doc, roots);
          await page.setViewport({ ...DEFAULT_VIEWPORT, deviceScaleFactor: 1 });
          await page.goto(`${RENDER_ORIGIN}/?state=${++loads}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await page.evaluate(settle);
          return page;
        });
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** A real web page in its own browser context, for Capture. The caller guards its requests. */
  async withSitePage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.slot(async () => {
      // A port shared since the browser started reaches it only after a restart, which only this job would notice.
      if (this.portsChanged && this.active === 1) await this.close();
      const browser = await this.launch();
      const context = await browser.createBrowserContext();
      try {
        return await fn(await context.newPage());
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  private async answer(req: HTTPRequest, html: string): Promise<void> {
    const url = req.url();
    if (url.startsWith(`${RENDER_ORIGIN}/`)) {
      const path = new URL(url).pathname;
      if (path === '/') return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      if (path === RUNTIME_PATH) return req.respond({ status: 200, contentType: 'text/javascript', body: await shaderRuntime() });
      if (path.startsWith('/assets/')) {
        const asset = await this.readAsset(path.slice('/assets/'.length));
        if (asset) {
          // A video only seeks if it gets the ranges it asks for.
          const range = parseRange(req.headers().range, asset.bytes.length);
          if (range && range !== 'invalid') {
            return req.respond({
              status: 206, contentType: asset.mime, body: Buffer.from(asset.bytes.subarray(range.start, range.end + 1)),
              headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${range.start}-${range.end}/${asset.bytes.length}` },
            });
          }
          return req.respond({ status: 200, contentType: asset.mime, body: Buffer.from(asset.bytes), headers: { 'accept-ranges': 'bytes' } });
        }
      }
      const frame = path.startsWith('/api/code/') ? await this.codeFrames?.(new URL(url)) : null;
      if (frame) return req.respond({ status: frame.status, headers: frame.headers, contentType: frame.headers['Content-Type'], body: frame.body });
      return req.respond({ status: 404, body: '' });
    }
    if (url.startsWith('data:') || url.startsWith('blob:')) return req.continue();
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return this.answerFont(req, url);
    if (await isPublicUrl(url)) return req.continue();
    return req.abort('blockedbyclient');
  }

  /** Fonts go through a cache with short timeouts, so a page never waits long when offline. */
  private async answerFont(req: HTTPRequest, url: string): Promise<void> {
    const ttl = 60_000;
    let entry = this.fontCache.get(url);
    if (!entry || (entry.status !== 200 && Date.now() - entry.at > ttl)) {
      try {
        const res = await fetchPublic(url, { timeoutMs: 2500, maxBytes: 8 * 1024 * 1024, headers: { 'user-agent': CHROME_UA } });
        entry = { status: 200, contentType: res.contentType, body: res.bytes, at: Date.now() };
      } catch {
        entry = { status: 404, contentType: 'text/plain', body: new Uint8Array(), at: Date.now() };
      }
      if (this.fontCache.size > 300) this.fontCache.clear();
      this.fontCache.set(url, entry);
    }
    return req.respond({ status: entry.status, contentType: entry.contentType, headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(entry.body) });
  }

  private htmlFor(doc: BogenDoc, roots: string[], seekable = false): string {
    const params = shaderParamsTag(doc, resolveAsset);
    const head = [
      '<style>html{overflow:visible}body{position:absolute;left:0;top:0;width:100%;min-height:100%;background:#fff;}</style>',
      // Code components say when they have drawn; `settle` waits for all of them.
      "<script>window.__bogenCodeReady=0;addEventListener('message',(e)=>{if(e.data&&e.data.bogenCode==='ready')window.__bogenCodeReady++})</script>",
      fontLinkTags(doc),
      params,
      params ? `<script>window.${seekable ? '__BOGEN_SEEKABLE__' : '__BOGEN_STILL__'}=true</script><script src="${RUNTIME_PATH}"></script>` : '',
    ].join('');
    // Media queries read the artboard's width here, as on the canvas, and not the width of this browser.
    return exportDocument(doc, roots, { ids: true, resolve: resolveAsset, extraHead: head, media: 'artboard' });
  }

  private async withPage<T>(doc: BogenDoc, roots: string[], fn: (page: Page) => Promise<T>, seekable = false, isolated = false): Promise<T> {
    return this.slot(async () => {
      const browser = await this.launch();
      const context = isolated ? await browser.createBrowserContext() : null;
      let page: Page | undefined;
      try {
        page = context ? await context.newPage() : await browser.newPage();
        const html = this.htmlFor(doc, roots, seekable);
        // tsx compiles with keepNames, which puts this helper into functions that run in the page.
        await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          this.answer(req, html).catch(() => req.abort().catch(() => {}));
        });
        await page.setViewport({ ...DEFAULT_VIEWPORT, deviceScaleFactor: 1 });
        await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.evaluate(settle);
        return await fn(page);
      } finally {
        if (context) await context.close().catch(() => {});
        else await page?.close().catch(() => {});
      }
    });
  }

  /** Moves the rendered roots to the origin, so that layers on negative coordinates can be captured. */
  private async alignRoots(page: Page, roots: string[], transparent: boolean): Promise<Rect> {
    return page.evaluate((ids: string[], clear: boolean) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of ids) {
        const el = document.querySelector(`[data-bogen-id="${id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        minX = Math.min(minX, r.left);
        minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right);
        maxY = Math.max(maxY, r.bottom);
      }
      if (clear) document.body.style.background = 'transparent';
      if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
      document.body.style.transform = `translate(${-minX}px,${-minY}px)`;
      return { x: 0, y: 0, width: maxX - minX, height: maxY - minY };
    }, roots, transparent);
  }

  private async targetRect(page: Page, nodeIds: string[]): Promise<Rect | null> {
    return page.evaluate((ids: string[]) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of ids) {
        const r = document.querySelector(`[data-bogen-id="${id}"]`)?.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) continue;
        minX = Math.min(minX, r.left);
        minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right);
        maxY = Math.max(maxY, r.bottom);
      }
      return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }, nodeIds);
  }

  async screenshot(doc: BogenDoc, target: Target, options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const roots = rootsOf(doc, target);
    return this.withPage(doc, roots, page => this.screenshotInPage(page, roots, target, options), false, Boolean(options.previewDimension));
  }

  /** A short-lived isolated context, one page and at most four sequential designs. Never parallel capture. */
  async screenPreviewBatch<T>(fn: (capture: PreviewCapture) => Promise<T>): Promise<T> {
    return this.slot(async () => {
      const context = await (await this.launch()).createBrowserContext();
      try {
        const page = await context.newPage();
        let html = '', captures = 0;
        await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
        await page.setRequestInterception(true);
        page.on('request', req => { this.answer(req, html).catch(() => req.abort().catch(() => {})); });
        return await fn(async (doc, node, options) => {
          if (++captures > PREVIEW_BATCH_SIZE) throw new Error('Preview batch is full.');
          const target = { nodeIds: [node] }, roots = rootsOf(doc, target);
          html = this.htmlFor(doc, roots);
          await page.setViewport({ ...DEFAULT_VIEWPORT, deviceScaleFactor: 1 });
          await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await page.evaluate(settle);
          return this.screenshotInPage(page, roots, target, options);
        });
      } finally { await context.close().catch(() => {}); }
    });
  }

  /** Only meaningful inside a preview batch: yield before its next screen when foreground work arrives. */
  get previewContended(): boolean { return this.active > 1 || this.waiting.length > 0; }

  private async screenshotInPage(page: Page, roots: string[], target: Target, options: ScreenshotOptions): Promise<ScreenshotResult> {
    let format = options.format ?? 'png';
    const transparent = Boolean(options.transparent) && format !== 'jpg';
    const whole = await this.alignRoots(page, roots, transparent);
    if (!whole.width || !whole.height) throw new Error('Nothing to capture: the target is hidden or has no size.');
    const size = { width: Math.min(MAX_DIMENSION, Math.ceil(whole.width)), height: Math.min(MAX_DIMENSION, Math.ceil(whole.height)) };
    const viewport = (s: number) => ({ width: Math.max(DEFAULT_VIEWPORT.width, size.width), height: Math.max(DEFAULT_VIEWPORT.height, size.height), deviceScaleFactor: s });
    // Measure at the same CSS size without allocating a full-resolution surface first.
    // A 24,000px square costs over 2 GB even when the requested thumbnail is only 480px.
    const measuringScale = Math.min(1, 2048 / Math.max(size.width, size.height), clampScale(options.scale ?? 1, whole, options.maxDimension ?? MAX_DIMENSION));
    await page.setViewport(viewport(measuringScale));
    await page.evaluate(nextPaint);
    const box = target.nodeIds?.length ? await this.targetRect(page, target.nodeIds) : whole;
    if (!box) throw new Error('Nothing to capture: the layer is hidden or has no size.');
    // The scale and the size are the layer's own: a small layer on a long artboard comes out at the scale asked for.
    let scale = clampScale(options.scale ?? 1, box, options.maxDimension ?? MAX_DIMENSION);
    let rect = box;
    const capture = async () => {
      if (rect === box && (size.width * scale > MAX_DIMENSION || size.height * scale > MAX_DIMENSION)) {
        // The whole artboard at this density is more than the browser paints at once, so the layer moves to the origin
        // and the viewport only covers it. A transform moves what is painted, not the layout.
        await page.evaluate((r: Rect) => {
          const shift = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\)/.exec(document.body.style.transform);
          document.body.style.transform = `translate(${Number(shift?.[1] ?? 0) - r.x}px,${Number(shift?.[2] ?? 0) - r.y}px)`;
        }, box);
        rect = { x: 0, y: 0, width: box.width, height: box.height };
        if (size.width * scale > MAX_DIMENSION) size.width = Math.ceil(box.width);
        if (size.height * scale > MAX_DIMENSION) size.height = Math.ceil(box.height);
      }
      await page.setViewport(viewport(scale));
      await page.evaluate(nextPaint);
      if (rect.width * scale > TILE || rect.height * scale > TILE) return { bytes: await this.tiled(page, rect, scale, format, transparent, options.quality ?? 90), rect };
      const bytes = await page.screenshot({
        type: format === 'jpg' ? 'jpeg' : format,
        clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
        captureBeyondViewport: false,
        omitBackground: transparent,
        ...(format === 'png' ? {} : { quality: options.quality ?? 90 }),
      });
      return { bytes: new Uint8Array(bytes), rect };
    };
    let shot = await capture();
    // Fit big results for MCP clients: lossy first, as flat designs shrink well, then fewer pixels.
    if (options.maxBytes) {
      if (shot.bytes.length > options.maxBytes && format === 'png' && !transparent) {
        format = 'webp';
        shot = await capture();
      }
      for (let i = 0; i < 6 && shot.bytes.length > options.maxBytes; i++) {
        scale *= 0.75;
        shot = await capture();
      }
    }
    // Derive the tiny image from the completed raster: no second viewport/layout/paint/screenshot.
    let preview: Uint8Array | undefined;
    if (options.previewDimension) {
      const encoded = await page.evaluate(async ({ data, dimension }) => {
        const image = new Image(); image.src = data; await image.decode();
        const ratio = Math.min(1, dimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const context = canvas.getContext('2d'); if (!context) throw new Error('Preview resampling unavailable.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', .75).split(',')[1]!;
      }, { data: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${Buffer.from(shot.bytes).toString('base64')}`, dimension: options.previewDimension });
      preview = new Uint8Array(Buffer.from(encoded, 'base64'));
    }
    return {
      preview, cssWidth: box.width, cssHeight: box.height,
      bytes: shot.bytes, format, scale,
      mime: format === 'jpg' ? 'image/jpeg' : `image/${format}`,
      width: Math.round(shot.rect.width * scale),
      height: Math.round(shot.rect.height * scale),
    };

  }

  /** Stitch oversized captures from bounded device-pixel tiles, then encode once. */
  private async tiled(page: Page, rect: Rect, scale: number, format: 'png' | 'jpg' | 'webp', transparent: boolean, quality: number): Promise<Uint8Array> {
    const width = Math.round(rect.width * scale);
    const height = Math.round(rect.height * scale);
    const base = await page.evaluate(() => document.body.style.transform);
    const tiles: { x: number; y: number; data: string }[] = [];
    try {
      for (let y = 0; y < height; y += TILE) {
        for (let x = 0; x < width; x += TILE) {
          await page.evaluate((t: string, dx: number, dy: number) => {
            document.body.style.transform = `translate(${dx}px,${dy}px) ${t}`;
          }, base, -(rect.x + x / scale), -(rect.y + y / scale));
          await page.evaluate(nextPaint);
          const w = Math.min(TILE, width - x);
          const h = Math.min(TILE, height - y);
          const data = await page.screenshot({ type: 'png', encoding: 'base64', clip: { x: 0, y: 0, width: w / scale, height: h / scale }, captureBeyondViewport: false, omitBackground: transparent });
          tiles.push({ x, y, data });
        }
      }
    } finally {
      await page.evaluate((t: string) => {
        document.body.style.transform = t;
      }, base);
    }
    const joined = await page.evaluate(async (list: typeof tiles, w: number, h: number, type: string, q: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      for (const tile of list) {
        const bytes = Uint8Array.from(atob(tile.data), (c) => c.charCodeAt(0));
        ctx.drawImage(await createImageBitmap(new Blob([bytes], { type: 'image/png' })), tile.x, tile.y);
      }
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q));
      if (!blob) return null;
      const out = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return btoa(text);
    }, tiles, width, height, format === 'jpg' ? 'image/jpeg' : `image/${format}`, quality / 100);
    if (!joined) throw new Error(`An image of ${width}x${height}px is more than the browser can encode${format === 'webp' ? ' as webp (16383px at most each way)' : ''}. Use a lower scale${format === 'webp' ? ' or png' : ''}.`);
    return new Uint8Array(Buffer.from(joined, 'base64'));
  }

  /** One PDF page per target, merged in order. Text stays text. */
  async pdf(doc: BogenDoc, targets: Target[]): Promise<Uint8Array> {
    const merged = await PDFDocument.create();
    for (const target of targets) {
      const roots = rootsOf(doc, target);
      const part = await this.withPage(doc, roots, async (page) => {
        const whole = await this.alignRoots(page, roots, false);
        await page.setViewport({ width: Math.max(DEFAULT_VIEWPORT.width, Math.ceil(whole.width)), height: Math.max(DEFAULT_VIEWPORT.height, Math.ceil(whole.height)), deviceScaleFactor: 1 });
        await page.evaluate(nextPaint);
        const rect = target.nodeIds?.length ? await this.targetRect(page, target.nodeIds) : whole;
        if (!rect) throw new Error('Nothing to export: the layer is hidden or has no size.');
        await page.evaluate((r: Rect) => {
          const style = document.createElement('style');
          style.textContent = '@page{margin:0}html,body{overflow:hidden!important}';
          document.head.append(style);
          const shift = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\)/.exec(document.body.style.transform);
          document.body.style.transform = `translate(${Number(shift?.[1] ?? 0) - r.x}px,${Number(shift?.[2] ?? 0) - r.y}px)`;
          document.documentElement.style.width = `${r.width}px`;
          document.documentElement.style.height = `${r.height}px`;
        }, rect);
        await page.emulateMediaType('screen');
        return page.pdf({ width: `${Math.ceil(rect.width)}px`, height: `${Math.ceil(rect.height)}px`, printBackground: true, pageRanges: '1' });
      });
      const source = await PDFDocument.load(part);
      for (const copied of await merged.copyPages(source, source.getPageIndices())) merged.addPage(copied);
    }
    return merged.save();
  }

  /**
   * An SVG with the layer as `foreignObject`. Exact in browsers and anywhere else that renders HTML in
   * SVG; design tools that only read vector shapes will not show it. A vector layer exports as itself.
   */
  async svg(doc: BogenDoc, target: Target): Promise<string> {
    const only = target.nodeIds?.length === 1 ? doc.getNode(target.nodeIds[0]!) : undefined;
    if (only?.type === 'svg' && only.svg) return only.svg;
    const roots = rootsOf(doc, target);
    const ids = target.nodeIds?.length ? target.nodeIds : roots;
    // An SVG cannot use <link>, and needs these first in its one style block.
    const imports = usedFamilies(doc).flatMap(googleFontsHrefs).map((href) => `@import url("${href}");`).join('');
    const css = [imports, RESET_CSS, tokensCss(doc), rulesCss(doc, roots)].filter(Boolean).join('');
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, true);
      return page.evaluate(async (targets: string[], reset: string, origin: string) => {
        const inline = async (root: Element) => {
          for (const img of root.querySelectorAll('img')) {
            if (!img.src.startsWith(`${origin}/`)) continue;
            const blob = await (await fetch(img.src)).blob();
            img.src = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.readAsDataURL(blob);
            });
          }
        };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const parts: string[] = [];
        const serializer = new XMLSerializer();
        const rects: DOMRect[] = [];
        for (const id of targets) {
          const el = document.querySelector<HTMLElement>(`[data-bogen-id="${id}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          rects.push(r);
          minX = Math.min(minX, r.left);
          minY = Math.min(minY, r.top);
          maxX = Math.max(maxX, r.right);
          maxY = Math.max(maxY, r.bottom);
        }
        let i = 0;
        for (const id of targets) {
          const el = document.querySelector<HTMLElement>(`[data-bogen-id="${id}"]`);
          if (!el) continue;
          const r = rects[i++]!;
          const clone = el.cloneNode(true) as HTMLElement;
          await inline(clone);
          for (const n of [clone, ...clone.querySelectorAll('[data-bogen-id]')]) {
            n.removeAttribute('data-bogen-id');
            n.removeAttribute('data-shader');
          }
          clone.style.position = 'absolute';
          clone.style.left = `${r.left - minX}px`;
          clone.style.top = `${r.top - minY}px`;
          clone.style.width = `${r.width}px`;
          clone.style.height = `${r.height}px`;
          parts.push(serializer.serializeToString(clone));
        }
        const w = Math.ceil(maxX - minX);
        const h = Math.ceil(maxY - minY);
        const style = reset.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${w}px;height:${h}px"><style>${style}</style>${parts.join('')}</div></foreignObject></svg>`;
      }, ids, css, RENDER_ORIGIN);
    });
  }

  /** Layers as native SVG elements, with HTML in `foreignObject` only for what SVG cannot say. */
  async vectorSvg(doc: BogenDoc, target: Target): Promise<VectorSvg> {
    const only = target.nodeIds?.length === 1 ? doc.getNode(target.nodeIds[0]!) : undefined;
    if (only?.type === 'svg' && only.svg) return { svg: only.svg, fallbacks: [], native: 1 };
    const roots = rootsOf(doc, target);
    const ids = target.nodeIds?.length ? target.nodeIds : roots;
    const imports = usedFamilies(doc).flatMap(googleFontsHrefs).map((href) => `@import url("${href}");`).join('');
    const css = [imports, RESET_CSS, tokensCss(doc), rulesCss(doc, roots)].filter(Boolean).join('');
    const faces = await embedFontFaces(doc, this.readAsset);
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, true);
      return page.evaluate(vectorizeInPage, { ids, css, faces, origin: RENDER_ORIGIN });
    });
  }

  /** Measured boxes of layers relative to their top-level root's origin. */
  async layout(doc: BogenDoc, target: Target, ids?: string[]): Promise<LayoutEntry[]> {
    const roots = rootsOf(doc, target);
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, false);
      return page.evaluate((only: string[] | null) => {
        const wanted = only ? new Set(only) : null;
        const out: { id: string; x: number; y: number; width: number; height: number }[] = [];
        for (const el of document.querySelectorAll('[data-bogen-id]')) {
          const id = el.getAttribute('data-bogen-id')!;
          if (wanted && !wanted.has(id)) continue;
          const r = el.getBoundingClientRect();
          out.push({ id, x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 });
        }
        return out;
      }, ids ?? null);
    });
  }

  /**
   * Chromium's computed styles and measured box for each layer, and of its pseudo-element when one is
   * asked for. With `width`, each top-level layer is first laid out at that width, so that its media
   * and container conditions answer as they would there.
   */
  async computed(doc: BogenDoc, ids: string[], properties?: string[], options: { width?: number; pseudo?: string } = {}): Promise<Record<string, { box: Rect; style: Record<string, string> }>> {
    const roots = rootsOf(doc, { nodeIds: ids });
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, false);
      if (options.width) {
        await page.setViewport({ ...DEFAULT_VIEWPORT, width: Math.max(DEFAULT_VIEWPORT.width, options.width), deviceScaleFactor: 1 });
        await page.evaluate((rootIds: string[], w: number) => {
          for (const id of rootIds) {
            const el = document.querySelector<HTMLElement>(`[data-bogen-id="${id}"]`);
            if (!el) continue;
            el.style.width = `${w}px`;
            el.style.minWidth = '0';
            el.style.maxWidth = 'none';
          }
        }, roots, options.width);
        await page.evaluate(nextPaint);
      }
      return page.evaluate((wanted: string[], props: string[], pseudo: string | null) => {
        const out: Record<string, { box: Rect; style: Record<string, string> }> = {};
        for (const id of wanted) {
          const el = document.querySelector(`[data-bogen-id="${id}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const computed = getComputedStyle(el, pseudo);
          const style: Record<string, string> = {};
          for (const p of props) style[p] = computed.getPropertyValue(p);
          out[id] = { box: { x: r.left, y: r.top, width: r.width, height: r.height }, style };
        }
        return out;
      }, ids, properties?.length ? properties : options.pseudo ? ['content', ...DEFAULT_COMPUTED] : DEFAULT_COMPUTED, options.pseudo ?? null);
    });
  }

  /**
   * Joins PNG tiles into one PNG, in a blank page of our own rather than the page they were taken from. Chromium takes
   * at most 8192 device pixels each way in one screenshot, so a long live page is taken in tiles.
   */
  async joinTiles(tiles: { x: number; y: number; bytes: Uint8Array }[], width: number, height: number): Promise<Uint8Array> {
    return this.slot(async () => {
      const browser = await this.launch();
      const page = await browser.newPage();
      try {
        const joined = await page.evaluate(async (list: { x: number; y: number; data: string }[], w: number, h: number) => {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          for (const tile of list) {
            const bytes = Uint8Array.from(atob(tile.data), (c) => c.charCodeAt(0));
            ctx.drawImage(await createImageBitmap(new Blob([bytes], { type: 'image/png' })), tile.x, tile.y);
          }
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (!blob) return null;
          const out = new Uint8Array(await blob.arrayBuffer());
          let text = '';
          for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
          return btoa(text);
        }, tiles.map((t) => ({ x: t.x, y: t.y, data: Buffer.from(t.bytes).toString('base64') })), width, height);
        if (!joined) throw new Error(`An image of ${width}x${height}px is more than the browser can encode.`);
        return new Uint8Array(Buffer.from(joined, 'base64'));
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** Compares two pictures pixel by pixel in the browser, which already decodes every format we store. */
  async compareImages(a: ImageBytes, b: ImageBytes, options: { threshold: number; fit: boolean; maxDimension: number; maxBytes: number; overlay?: boolean; scaleB?: number }): Promise<ImageDiff> {
    const dataUrl = (image: ImageBytes) => `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`;
    return this.slot(async () => {
      const browser = await this.launch();
      const page = await browser.newPage();
      try {
        await page.evaluate('globalThis.__name = (f) => f');
        const out = await page.evaluate(diffInPage, dataUrl(a), dataUrl(b), options);
        return { ...out, png: new Uint8Array(Buffer.from(out.png, 'base64')), overlayPng: out.overlayPng ? new Uint8Array(Buffer.from(out.overlayPng, 'base64')) : undefined };
      } finally {
        await page.close().catch(() => {});
      }
    });
  }

  /** Renders a layer at several widths, and runs a read-only probe at each. */
  async atWidths<T, A>(doc: BogenDoc, nodeId: string, widths: number[], fn: (arg: A) => T, arg: A, options: { shots?: boolean; maxDimension?: number; viewportHeight?: number } = {}): Promise<WidthResult<T>[]> {
    const roots = rootsOf(doc, { nodeIds: [nodeId] });
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, false);
      const results: WidthResult<T>[] = [];
      for (const width of widths) {
        // A toolbar-height probe needs a real mobile viewport too: mixed width/height
        // media queries cannot be rewritten as artboard-width container queries.
        const viewportWidth = options.viewportHeight === undefined ? Math.max(DEFAULT_VIEWPORT.width, width) : width;
        await page.setViewport({ ...DEFAULT_VIEWPORT, height: options.viewportHeight ?? DEFAULT_VIEWPORT.height, width: viewportWidth, deviceScaleFactor: 1 });
        await page.evaluate((id: string, w: number) => {
          const el = document.querySelector<HTMLElement>(`[data-bogen-id="${id}"]`);
          if (!el) return;
          el.style.width = `${w}px`;
          el.style.minWidth = '0';
          el.style.maxWidth = 'none';
        }, nodeId, width);
        await page.evaluate(nextPaint);
        const rect = await this.targetRect(page, [nodeId]);
        if (!rect) throw new Error('Nothing to measure: the layer is hidden or has no size.');
        await page.setViewport({ width: options.viewportHeight === undefined ? Math.max(DEFAULT_VIEWPORT.width, Math.ceil(rect.x + rect.width)) : viewportWidth, height: options.viewportHeight ?? Math.max(DEFAULT_VIEWPORT.height, Math.min(MAX_DIMENSION, Math.ceil(rect.y + rect.height))), deviceScaleFactor: 1 });
        await page.evaluate(nextPaint);
        const result = await page.evaluate(fn as never, arg as never) as T;
        const entry: WidthResult<T> = { width, height: Math.round(rect.height), result };
        if (options.shots) {
          const scale = clampScale(1, rect, options.maxDimension ?? MAX_DIMENSION);
          const bytes = await page.screenshot({ type: 'png', clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: Math.min(rect.height, MAX_DIMENSION), scale }, captureBeyondViewport: false });
          entry.shot = new Uint8Array(bytes);
        }
        results.push(entry);
      }
      return results;
    });
  }

  /** Runs a read-only script in the rendered page, written as an expression, such as a function called with its arguments. */
  async probeScript<T>(doc: BogenDoc, target: Target, script: string): Promise<T> {
    const roots = rootsOf(doc, target);
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, false);
      return page.evaluate(script) as Promise<T>;
    });
  }

  /** Runs a read-only probe in the rendered page. Used by the design linter. */
  async probe<T, A>(doc: BogenDoc, target: Target, fn: (arg: A) => T, arg: A): Promise<T> {
    const roots = rootsOf(doc, target);
    return this.withPage(doc, roots, async (page) => {
      await this.alignRoots(page, roots, false);
      return page.evaluate(fn as never, arg as never) as Promise<T>;
    });
  }
}

const DEFAULT_COMPUTED = [
  'display', 'position', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap', 'flex-grow', 'flex-shrink', 'flex-basis', 'grid-template-columns',
  'width', 'height', 'min-width', 'max-width', 'padding', 'margin', 'overflow', 'color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'opacity',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'white-space', 'z-index', 'transform',
];

function clampScale(requested: number, rect: { width: number; height: number }, maxDimension: number): number {
  const wanted = Math.max(0.1, Math.min(4, requested));
  const largest = Math.max(rect.width, rect.height, 1);
  return Math.min(wanted, Math.max(1, maxDimension) / largest);
}

/** Runs in the page: fonts, images and shaders, each bounded so one bad resource cannot hang a render. */
async function settle(): Promise<void> {
  const limit = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);
  const images = [...document.images].filter((img) => !img.complete).map((img) => new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  }));
  await limit(Promise.all(images), 6000);
  await limit(document.fonts.ready, 4000);
  // Layout after fonts load can request more font faces.
  await limit(document.fonts.ready, 1500);
  const codeFrames = document.querySelectorAll('iframe[data-bogen-code]').length;
  if (codeFrames) await limit(new Promise<void>((resolve) => { const tick = () => ((window as unknown as { __bogenCodeReady?: number }).__bogenCodeReady ?? 0) >= codeFrames ? resolve() : setTimeout(tick, 25); tick(); }), 15_000);
  const shaders = (window as unknown as { __bogenShadersReady?: Promise<void> }).__bogenShadersReady;
  if (shaders) await limit(shaders, 20_000);
}

/** Runs in a blank page, so it can only use its arguments. Pixels outside the smaller picture count as different. */
async function diffInPage(urlA: string, urlB: string, options: { threshold: number; fit: boolean; maxDimension: number; maxBytes: number; overlay?: boolean; scaleB?: number }): Promise<Omit<ImageDiff, 'png' | 'overlayPng'> & { png: string; overlayPng?: string }> {
  const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('A picture could not be decoded.'));
    img.src = url;
  });
  const [a, b] = await Promise.all([load(urlA), load(urlB)]);
  // With scaleB, the second picture is drawn at that scale first, as when the first is a render scaled to fit.
  const bw = Math.round(b.naturalWidth * (options.scaleB ?? 1));
  const bh = Math.round(b.naturalHeight * (options.scaleB ?? 1));
  const width = options.fit ? a.naturalWidth : Math.max(a.naturalWidth, bw);
  const height = options.fit ? a.naturalHeight : Math.max(a.naturalHeight, bh);
  const pixels = (img: HTMLImageElement, w: number, h: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, width, height).data;
  };
  const pa = pixels(a, a.naturalWidth, a.naturalHeight);
  const pb = options.fit ? pixels(b, width, height) : pixels(b, bw, bh);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d')!;
  const image = outCtx.createImageData(width, height);
  const marks = options.overlay ? outCtx.createImageData(width, height) : null;
  const limit = options.threshold * 255;
  let different = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      // Over white, as the renderer paints, so that a transparent corner and a white one agree.
      const alphaA = pa[i + 3]! / 255;
      const alphaB = pb[i + 3]! / 255;
      let delta = 0;
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs((pa[i + c]! * alphaA + 255 * (1 - alphaA)) - (pb[i + c]! * alphaB + 255 * (1 - alphaB))));
      const outside = x >= (options.fit ? width : Math.min(a.naturalWidth, bw)) || y >= (options.fit ? height : Math.min(a.naturalHeight, bh));
      if (delta > limit || outside) {
        different++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        image.data[i] = 229;
        image.data[i + 1] = 40;
        image.data[i + 2] = 40;
        if (marks) {
          marks.data[i] = 229;
          marks.data[i + 1] = 40;
          marks.data[i + 2] = 40;
          marks.data[i + 3] = 150;
        }
      } else {
        const faded = 255 - (255 - (pa[i]! * 0.3 + pa[i + 1]! * 0.59 + pa[i + 2]! * 0.11)) * alphaA * 0.25;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = faded;
      }
      image.data[i + 3] = 255;
    }
  }
  outCtx.putImageData(image, 0, 0);

  let scale = Math.min(1, options.maxDimension / Math.max(width, height, 1));
  let png = '';
  let pngWidth = 0;
  let pngHeight = 0;
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.7) {
    const small = document.createElement('canvas');
    pngWidth = small.width = Math.max(1, Math.round(width * scale));
    pngHeight = small.height = Math.max(1, Math.round(height * scale));
    small.getContext('2d')!.drawImage(out, 0, 0, small.width, small.height);
    png = small.toDataURL('image/png').split(',')[1]!;
    if (png.length * 0.75 <= options.maxBytes) break;
  }
  let overlayPng: string | undefined;
  if (marks) {
    outCtx.putImageData(marks, 0, 0);
    const small = document.createElement('canvas');
    small.width = pngWidth;
    small.height = pngHeight;
    small.getContext('2d')!.drawImage(out, 0, 0, small.width, small.height);
    overlayPng = small.toDataURL('image/png').split(',')[1]!;
  }
  return {
    sizeA: { width: a.naturalWidth, height: a.naturalHeight }, sizeB: { width: b.naturalWidth, height: b.naturalHeight },
    total: width * height, different, bounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    png, pngWidth, pngHeight, ...(overlayPng ? { overlayPng } : {}),
  };
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

