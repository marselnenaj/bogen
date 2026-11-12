import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { appScreenRecords, insertAppScreen, SCREEN_LAYER, SCREENSHOT_LAYER, type AppScreenRecord, type BogenDoc, type NewNode } from '@bogen/core';
import { z } from 'zod';
import { readLocalImage } from './images.ts';
import type { Renderer } from './render.ts';
import type { Storage } from './storage.ts';

/**
 * App screens from Tomacco, the mobile development tool, in its documented `tomacco.screen` export format
 * (version 1): a directory with `screen.png` and `screen.json`, which holds the device, the display and every
 * element on the screen with its bounds. Bogen only reads that format, and calls `tomaccoctl` when it is
 * installed and asked to; it installs nothing and changes nothing on the device.
 *
 * Two things are made from a screen:
 * - an artboard at the device's size in dp or points: the screenshot at the bottom, then the elements as
 *   layers, nested as the hierarchy is. Text becomes real text, in the colour and at about the size read off
 *   the pixels; pictures and controls become crops of the screenshot, which look right and can be moved;
 * - a comparison of a design artboard with the screen: the pixels, and the elements matched to layers.
 */

export const SCREEN_FORMAT = 'tomacco.screen';
export const SCREEN_VERSION = 1;
export const MAX_SCREEN_JSON = 8 * 1024 * 1024;
export const MAX_SCREEN_PNG = 40 * 1024 * 1024;
const MAX_ELEMENTS = 3000;

const Box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number(), width: z.number().optional(), height: z.number().optional() });
const nullish = <T extends z.ZodType>(t: T) => t.nullable().optional();

const Element = z.object({
  id: z.string().min(1).max(64),
  parent: nullish(z.string().max(64)),
  depth: nullish(z.number()),
  source: nullish(z.string().max(40)),
  role: nullish(z.string().max(40)),
  class: nullish(z.string().max(300)),
  resource_id: nullish(z.string().max(300)),
  text: nullish(z.string().max(5000)),
  description: nullish(z.string().max(5000)),
  label: nullish(z.string().max(5000)),
  bounds: z.object({ px: Box, dp: nullish(Box) }),
  clickable: nullish(z.boolean()),
  editable: nullish(z.boolean()),
  checked: nullish(z.boolean()),
  password: nullish(z.boolean()),
  mark: nullish(z.number()),
});

const Screen = z.object({
  format: z.literal(SCREEN_FORMAT),
  version: z.number().int(),
  tomacco_version: nullish(z.string().max(40)),
  captured_at: nullish(z.string().max(60)),
  device: z.object({
    platform: z.string().max(20),
    id: nullish(z.string().max(200)),
    model: nullish(z.string().max(200)),
    os_name: nullish(z.string().max(60)),
    os_version: nullish(z.string().max(60)),
    form_factor: nullish(z.string().max(20)),
  }),
  display: z.object({
    width_px: z.number().int().min(1).max(20000),
    height_px: z.number().int().min(1).max(20000),
    scale: nullish(z.number().positive()),
    width_dp: nullish(z.number().positive()),
    height_dp: nullish(z.number().positive()),
    unit: nullish(z.string().max(4)),
    orientation: nullish(z.string().max(20)),
  }),
  insets: nullish(z.object({
    status_bar: nullish(Box),
    navigation_bar: nullish(Box),
  })),
  theme: nullish(z.object({ mode: nullish(z.string().max(20)) })),
  app: nullish(z.object({ package: nullish(z.string().max(300)), activity: nullish(z.string().max(300)) })),
  screenshot: nullish(z.object({ file: nullish(z.string().max(200)), sha256: nullish(z.string().max(80)) })),
  elements_source: nullish(z.string().max(20)),
  elements: z.array(Element).max(MAX_ELEMENTS).default([]),
  warnings: z.array(z.string().max(2000)).max(200).default([]),
});

export type ScreenJson = z.output<typeof Screen>;
export type ScreenElement = z.output<typeof Element>;

export interface Rect { x: number; y: number; width: number; height: number }

/** One element as Bogen uses it: in dp (or points) from the top left of the screen. */
export interface AppElement {
  id: string;
  parent: string | null;
  role: string;
  label: string;
  text: string;
  resource: string;
  /** In dp or points. */
  box: Rect;
  /** In pixels of the screenshot. */
  px: Rect;
}

export interface AppScreen {
  json: ScreenJson;
  png: Uint8Array;
  platform: 'android' | 'ios' | string;
  /** Pixels per dp or point. */
  scale: number;
  /** True when the export did not say, and Bogen took a likely value. */
  scaleGuessed: boolean;
  width: number;
  height: number;
  unit: 'dp' | 'pt';
  elements: AppElement[];
  warnings: string[];
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const rect = (b: z.output<typeof Box>, k = 1): Rect => ({ x: b.left / k, y: b.top / k, width: (b.right - b.left) / k, height: (b.bottom - b.top) / k });

/** Reads the JSON of an export and its picture. Another format or a newer version is refused; unknown fields are not read. */
export function parseScreen(raw: unknown, png: Uint8Array): AppScreen {
  const head = (raw && typeof raw === 'object' ? raw : {}) as { format?: unknown; version?: unknown };
  if (head.format !== SCREEN_FORMAT) throw new Error(`This is not a screen export: format is ${JSON.stringify(head.format ?? null)}, not "${SCREEN_FORMAT}".`);
  if (typeof head.version !== 'number' || !Number.isInteger(head.version) || head.version < 1) throw new Error('The screen export has no valid version.');
  if (head.version > SCREEN_VERSION) throw new Error(`The screen export is version ${head.version}, and this Bogen reads version ${SCREEN_VERSION}. Update Bogen to read it.`);
  const parsed = Screen.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`The screen export is not valid at ${issue.path.join('.') || 'the top'}: ${issue.message}.`);
  }
  const json = parsed.data;
  const size = pngSize(png);
  if (!size) throw new Error('The screenshot is not a PNG.');
  const warnings = [...json.warnings];
  const d = json.display;
  if (size.width !== d.width_px || size.height !== d.height_px) warnings.push(`The screenshot is ${size.width}x${size.height} px, and the export says ${d.width_px}x${d.height_px}.`);
  const hash = json.screenshot?.sha256;
  if (hash && createHash('sha256').update(png).digest('hex') !== hash.toLowerCase()) warnings.push('The screenshot is not the one the export names: its sha256 differs.');
  let scale = d.scale ?? (d.width_dp ? d.width_px / d.width_dp : 0);
  const scaleGuessed = !scale;
  if (!scale) {
    // A phone at 1080 px across or more is almost always 3x, below that 2x.
    scale = Math.min(size.width, size.height) >= 1080 ? 3 : 2;
    warnings.push(`The export does not say how many pixels make a ${d.unit === 'dp' ? 'dp' : 'point'}, so Bogen took ${scale}.`);
  }
  const elements: AppElement[] = json.elements.map((e) => ({
    id: e.id,
    parent: e.parent ?? null,
    role: e.role ?? 'view',
    label: (e.label || e.text || e.description || '').trim(),
    text: (e.text ?? '').trim(),
    resource: e.resource_id ?? '',
    box: e.bounds.dp && !scaleGuessed ? rect(e.bounds.dp) : rect(e.bounds.px, scale),
    px: rect(e.bounds.px),
  }));
  return {
    json, png, platform: json.device.platform, scale, scaleGuessed,
    width: round(d.width_dp ?? size.width / scale), height: round(d.height_dp ?? size.height / scale),
    unit: d.unit === 'pt' || json.device.platform === 'ios' ? 'pt' : 'dp',
    elements, warnings,
  };
}

const round = (v: number, step = 0.01) => Math.round(v / step) * step;
const px = (v: number) => `${Math.round(v * 100) / 100}px`;

function expand(given: string): string {
  return given.startsWith('~/') ? join(homedir(), given.slice(2)) : given;
}

/** An export on this computer: its directory, or the path of its `screen.json`. Under the home or temp folder only. */
export async function readBundle(given: string): Promise<AppScreen> {
  const path = expand(given.trim());
  if (!isAbsolute(path)) throw new Error('The export must be an absolute path, such as ~/exports/login or /tmp/screen/screen.json.');
  const isDir = await stat(path).then((s) => s.isDirectory(), () => false);
  const jsonPath = isDir ? join(path, 'screen.json') : path;
  const text = (await readLocalImage(jsonPath, MAX_SCREEN_JSON)).toString('utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${jsonPath} is not JSON.`);
  }
  const file = (raw as { screenshot?: { file?: unknown } })?.screenshot?.file;
  const name = typeof file === 'string' && file === basename(file) && /\.png$/i.test(file) ? file : 'screen.png';
  const png = await readLocalImage(join(dirname(jsonPath), name), MAX_SCREEN_PNG);
  return parseScreen(raw, new Uint8Array(png));
}

// ---------------------------------------------------------------- tomaccoctl

export function findTomaccoctl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BOGEN_TOMACCOCTL === 'none') return null;
  if (env.BOGEN_TOMACCOCTL) return env.BOGEN_TOMACCOCTL;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, 'tomaccoctl');
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

/** One `tomaccoctl call`. It answers one JSON envelope, also when it fails. */
async function tomaccoCall(operation: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const bin = findTomaccoctl();
  if (!bin) throw new Error('tomaccoctl is not installed on this computer, so no device can be read. Import an export instead.');
  const out = await new Promise<string>((resolve, reject) => {
    execFile(bin, ['call', operation, JSON.stringify(args)], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (stdout?.trim()) return resolve(stdout);
      reject(new Error(`tomaccoctl ${operation} failed: ${error?.message ?? 'no answer'}`));
    });
  });
  let envelope: { ok?: boolean; result?: unknown; error?: { message?: string; code?: string } | string };
  try {
    envelope = JSON.parse(out.trim().split('\n').at(-1)!) as typeof envelope;
  } catch {
    throw new Error(`tomaccoctl ${operation} did not answer JSON.`);
  }
  if (!envelope.ok) {
    const e = envelope.error;
    throw new Error(`tomaccoctl ${operation}: ${typeof e === 'string' ? e : e?.message ?? e?.code ?? 'failed'}`);
  }
  return envelope.result;
}

export interface AppDevice { id: string; platform: string; name: string; state?: string }

/** Devices `tomaccoctl` sees now. Not installed is an answer, not an error. */
export async function listDevices(): Promise<{ available: boolean; devices: AppDevice[]; notes: string[] }> {
  if (!findTomaccoctl()) return { available: false, devices: [], notes: ['tomaccoctl is not installed on this computer.'] };
  const result = await tomaccoCall('device.list', {}, 30_000) as { devices?: Record<string, unknown>[]; diagnostics?: { message?: string; platform?: string }[] };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const devices = (result.devices ?? []).flatMap((d): AppDevice[] => {
    const id = str(d.id) ?? str(d.serial) ?? str(d.udid);
    if (!id) return [];
    const platform = str(d.platform) ?? (id === 'virtual-iphone' ? 'ios' : 'android');
    return [{ id, platform, name: str(d.model) ?? str(d.name) ?? str(d.product) ?? id, ...(str(d.state) ? { state: str(d.state) } : {}) }];
  });
  const notes = (result.diagnostics ?? []).map((n) => `${n.platform ? `${n.platform}: ` : ''}${n.message ?? ''}`.trim()).filter(Boolean);
  return { available: true, devices, notes };
}

/** The screen of a device now, through `screen.export` into a temporary folder that is removed afterwards. */
export async function exportLive(device: string, platform?: 'android' | 'ios'): Promise<AppScreen> {
  if (!/^[\w.:-]{1,200}$/.test(device)) throw new Error('That is not a device id from the device list.');
  const dir = await mkdtemp(join(tmpdir(), 'bogen-app-screen-'));
  try {
    await tomaccoCall('screen.export', { device, directory: dir, ...(platform === 'ios' ? { platform } : {}) }, 120_000);
    return await readBundle(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tomacco's own install line, from its README, for when `tomaccoctl` is not found. */
export const TOMACCO_INSTALL = 'curl -fsSL https://tomacco.dev/install.sh | bash';

/** One of `doctor`'s next steps: what is left to set up and the command that does it. Bogen shows it, never runs it. */
export interface TomaccoStep { goal: string | null; what: string; how: string | null; askFirst: boolean }

/**
 * Whether a screen can be taken now, for the editor's "not installed / not ready" state:
 * - `missing`: no `tomaccoctl`; `fix` is the install line
 * - `no-device`: installed, but no emulator, device or virtual iPhone is running; `steps` are `doctor`'s next steps
 * - `ready`: at least one device to take a screen from
 */
export interface TomaccoStatus {
  state: 'missing' | 'no-device' | 'ready';
  version: string | null;
  devices: AppDevice[];
  notes: string[];
  steps: TomaccoStep[];
  /** The one command to run next, when there is one. */
  fix: string | null;
  checkedAt: number;
}

const clip = (v: unknown, n = 600): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/** `doctor`'s `next_steps`, read loosely: at most eight, each bounded. Unknown fields are not read. */
export function doctorSteps(result: unknown): TomaccoStep[] {
  const raw = (result && typeof result === 'object' ? (result as { next_steps?: unknown }).next_steps : null);
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap((s): TomaccoStep[] => {
    if (!s || typeof s !== 'object') return [];
    const step = s as Record<string, unknown>;
    const what = clip(step.what);
    return what ? [{ goal: clip(step.goal, 40), what, how: clip(step.how, 1000), askFirst: step.ask_first === true }] : [];
  });
}

/** The state from what was found, kept apart from the calls so that it can be tested on its own. */
export function readiness(input: { installed: boolean; version?: string | null; devices?: AppDevice[]; notes?: string[]; steps?: TomaccoStep[] }, now = Date.now()): TomaccoStatus {
  const devices = input.devices ?? [];
  const steps = input.steps ?? [];
  if (!input.installed) return { state: 'missing', version: null, devices: [], notes: [], steps: [], fix: TOMACCO_INSTALL, checkedAt: now };
  const state = devices.length ? 'ready' : 'no-device';
  return { state, version: input.version ?? null, devices, notes: input.notes ?? [], steps: state === 'ready' ? [] : steps, fix: state === 'ready' ? null : steps.find((s) => s.how)?.how ?? null, checkedAt: now };
}

function tomaccoVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000, maxBuffer: 64 * 1024 }, (_error, stdout) => resolve(/tomaccoctl\s+(\S+)/.exec(String(stdout ?? ''))?.[1]?.slice(0, 40) ?? null));
  });
}

let statusCache: { at: number; status: Promise<TomaccoStatus> } | null = null;
const STATUS_TTL_MS = 60_000;

/**
 * Whether Tomacco can give a screen now: its version, the devices it sees, and, only when none is running, the
 * next steps of `doctor` (which reads only and takes a few seconds). Kept for a minute; `fresh` asks again.
 */
export function tomaccoStatus(options: { fresh?: boolean } = {}): Promise<TomaccoStatus> {
  if (!options.fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.status;
  const status = (async () => {
    const bin = findTomaccoctl();
    if (!bin) return readiness({ installed: false });
    const [version, list] = await Promise.all([tomaccoVersion(bin), listDevices().catch((e: Error) => ({ available: true, devices: [] as AppDevice[], notes: [e.message] }))]);
    if (list.devices.length) return readiness({ installed: true, version, devices: list.devices, notes: list.notes });
    const steps = await tomaccoCall('doctor', {}, 60_000).then(doctorSteps, () => [] as TomaccoStep[]);
    return readiness({ installed: true, version, devices: [], notes: list.notes, steps });
  })();
  statusCache = { at: Date.now(), status };
  status.catch(() => { statusCache = null; });
  return status;
}

// ---------------------------------------------------------------- reading the pixels

interface Sample { id: string; bg: string; fg?: string; ink?: Rect; bands?: number; density?: number; stroke?: number }

/** Runs in a page: the background of each box from a ring inside its edges, and for text the ink in it. */
async function sampleInPage(arg: { url: string; boxes: { id: string; x: number; y: number; width: number; height: number; text: boolean }[] }): Promise<Sample[]> {
  const img = new Image();
  img.src = arg.url;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const out: Sample[] = [];
  for (const box of arg.boxes) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(w, Math.ceil(box.x + box.width));
    const y1 = Math.min(h, Math.ceil(box.y + box.height));
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      out.push({ id: box.id, bg: '#ffffff' });
      continue;
    }
    // Inside a border and past rounded corners, where the background of the element itself is.
    const inset = Math.max(1, Math.min(8, Math.round(Math.min(x1 - x0, y1 - y0) * 0.12)));
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    const take = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    };
    const top = Math.min(y1 - 1, y0 + inset), bottom = Math.max(y0, y1 - 1 - inset);
    const left = Math.min(x1 - 1, x0 + inset), right = Math.max(x0, x1 - 1 - inset);
    for (let x = left; x <= right; x++) { take(x, top); take(x, bottom); }
    for (let y = top; y <= bottom; y++) { take(left, y); take(right, y); }
    let best = { n: 0, r: 255, g: 255, b: 255 };
    for (const bucket of buckets.values()) if (bucket.n > best.n) best = bucket;
    const bg = [best.r / Math.max(1, best.n), best.g / Math.max(1, best.n), best.b / Math.max(1, best.n)] as const;
    const sample: Sample = { id: box.id, bg: best.n ? hex(...bg) : '#ffffff' };
    if (box.text) {
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0, maxDist = 0;
      const rows = new Uint32Array(bottom - top + 1);
      const step = (right - left) * (bottom - top) > 600_000 ? 2 : 1;
      for (let y = top + 1; y < bottom; y += step) {
        for (let x = left + 1; x < right; x += step) {
          const i = (y * w + x) * 4;
          const dist = Math.abs(data[i]! - bg[0]) + Math.abs(data[i + 1]! - bg[1]) + Math.abs(data[i + 2]! - bg[2]);
          if (dist < 90) continue;
          count++;
          rows[y - top]!++;
          if (dist > maxDist) maxDist = dist;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (count) {
        // The colour of the text is that of its strongest pixels, not of the antialiased edges.
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = minY; y <= maxY; y += step) {
          for (let x = minX; x <= maxX; x += step) {
            const i = (y * w + x) * 4;
            const dist = Math.abs(data[i]! - bg[0]) + Math.abs(data[i + 1]! - bg[1]) + Math.abs(data[i + 2]! - bg[2]);
            if (dist < maxDist * 0.75) continue;
            r += data[i]!;
            g += data[i + 1]!;
            b += data[i + 2]!;
            n++;
          }
        }
        // How thick the strokes are: the middle length of the runs of solid ink across each row.
        const runs: number[] = [];
        for (let y = minY; y <= maxY; y++) {
          let run = 0;
          for (let x = minX; x <= maxX + 1; x++) {
            const i = (y * w + x) * 4;
            const solid = x <= maxX && Math.abs(data[i]! - bg[0]) + Math.abs(data[i + 1]! - bg[1]) + Math.abs(data[i + 2]! - bg[2]) >= maxDist * 0.5;
            if (solid) run++;
            else if (run) {
              runs.push(run);
              run = 0;
            }
          }
        }
        runs.sort((a, b) => a - b);
        sample.stroke = runs.length ? runs[Math.floor(runs.length / 2)]! : 0;
        let bands = 0;
        let inBand = false;
        let gap = 0;
        for (let y = minY - top; y <= maxY - top; y++) {
          if (rows[y]) {
            if (!inBand && (bands === 0 || gap >= 3)) bands++;
            inBand = true;
            gap = 0;
          } else {
            inBand = false;
            gap++;
          }
        }
        sample.fg = hex(r / n, g / n, b / n);
        sample.ink = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
        sample.bands = Math.max(1, bands);
        sample.density = (count * step * step) / ((maxX - minX + 1) * (maxY - minY + 1));
      }
    }
    out.push(sample);
  }
  return out;
}

async function sampleScreen(renderer: Renderer, screen: AppScreen, boxes: { id: string; x: number; y: number; width: number; height: number; text: boolean }[]): Promise<Map<string, Sample>> {
  const url = `data:image/png;base64,${Buffer.from(screen.png).toString('base64')}`;
  const list = await renderer.withBrowser(async (browser) => {
    const page = await browser.newPage();
    try {
      await page.evaluate('globalThis.__name = (f) => f');
      return await page.evaluate(sampleInPage, { url, boxes });
    } finally {
      await page.close().catch(() => {});
    }
  });
  return new Map(list.map((s) => [s.id, s]));
}

// ---------------------------------------------------------------- the artboard

export interface ImportOptions {
  /** Text as real text layers. Off: text stays a crop of the screenshot like everything else. */
  text?: boolean;
  /** A phone around the screen. */
  frame?: boolean;
  /** The whole screenshot at the bottom, locked, as a reference. */
  screenshot?: boolean;
  name?: string;
  x?: number;
  y?: number;
}

export interface ImportPlan {
  spec: NewNode;
  /** Ids are known only after insert: the layer names that mark the screenshot and the screen frame. */
  stats: { frames: number; texts: number; crops: number; elements: number };
  width: number;
  height: number;
  warnings: string[];
}

const ROLE_ATTR: Record<string, string> = { button: 'button', text_field: 'textbox', switch: 'switch', checkbox: 'checkbox', radio: 'radio', image: 'img', list: 'list', progress: 'progressbar', dropdown: 'combobox', scroll: 'region' };
const IMAGE_ROLES = new Set(['image', 'switch', 'checkbox', 'radio', 'progress', 'web_view']);

function distance(a: string, b: string): number {
  const v = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [v(a), v(b)];
  return Math.abs(x[0]! - y[0]!) + Math.abs(x[1]! - y[1]!) + Math.abs(x[2]! - y[2]!);
}

const near = (a: Rect, b: Rect, tolerance = 1) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;

/** A name for a layer: a control by what it says, a group by its resource id, since its label is all of its text. */
function shortName(e: AppElement, group = false): string {
  const resource = (e.resource.split(':id/').at(-1) ?? '').replace(/_/g, ' ');
  const own = group ? e.text || resource : e.label || resource;
  return (own || `${e.role.replace(/_/g, ' ')} ${e.id}`).replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** The elements worth a layer, each under the nearest kept ancestor. Wrappers that only repeat a child's box go. */
export function keptElements(screen: AppScreen): { list: AppElement[]; parentOf: Map<string, string | null>; children: Map<string | null, AppElement[]> } {
  const screenBox: Rect = { x: 0, y: 0, width: screen.width, height: screen.height };
  const byId = new Map(screen.elements.map((e) => [e.id, e]));
  const rawChildren = new Map<string, AppElement[]>();
  for (const e of screen.elements) if (e.parent && byId.has(e.parent)) rawChildren.set(e.parent, [...(rawChildren.get(e.parent) ?? []), e]);
  const visible = (e: AppElement) => e.box.width >= 0.5 && e.box.height >= 0.5 && e.box.x < screen.width && e.box.y < screen.height && e.box.x + e.box.width > 0 && e.box.y + e.box.height > 0;
  const dropped = new Set<string>();
  for (const e of screen.elements) {
    const kids = rawChildren.get(e.id) ?? [];
    const wrapsOne = kids.length === 1 && near(kids[0]!.box, e.box);
    const isRoot = near(e.box, screenBox, 2) && !e.text;
    if (!visible(e) || ((isRoot || wrapsOne) && kids.length)) dropped.add(e.id);
  }
  const parentOf = new Map<string, string | null>();
  const children = new Map<string | null, AppElement[]>();
  const list: AppElement[] = [];
  for (const e of screen.elements) {
    if (dropped.has(e.id)) continue;
    let p = e.parent;
    const seen = new Set<string>();
    while (p && (dropped.has(p) || !byId.has(p)) && !seen.has(p)) {
      seen.add(p);
      p = byId.get(p)?.parent ?? null;
    }
    const parent = p && byId.has(p) && !dropped.has(p) ? p : null;
    parentOf.set(e.id, parent);
    children.set(parent, [...(children.get(parent) ?? []), e]);
    list.push(e);
  }
  return { list, parentOf, children };
}

/** About how large the type is, from the height of its ink and which letters it has. */
function fontSizeFrom(inkHeight: number, bands: number, text: string, boxHeight: number): number {
  const line = inkHeight / bands;
  const tall = /[A-Z0-9bdfhklt'"!?()[\]{}/\\|ÄÖÜ]/.test(text);
  const deep = /[gjpqy,;()[\]{}]/.test(text);
  const share = (tall ? 0.72 : /^[\s•*.·]+$/.test(text) ? 0.32 : 0.52) + (deep ? 0.2 : 0);
  return Math.max(6, Math.min(boxHeight / bands, line / share));
}

/** Works out the layers of an artboard for a screen. The pixels are read in Chromium; nothing is written yet. */
export async function planImport(renderer: Renderer, screen: AppScreen, src: string, options: ImportOptions = {}): Promise<ImportPlan> {
  const wantText = options.text !== false;
  const keepShot = options.screenshot !== false;
  const { list, children } = keptElements(screen);
  const isText = (e: AppElement) => wantText && !IMAGE_ROLES.has(e.role) && !(children.get(e.id)?.length) && Boolean(e.text || (e.role !== 'container' && e.role !== 'view' && e.label));
  const samples = await sampleScreen(renderer, screen, [
    { id: '#screen', x: 0, y: 0, width: screen.json.display.width_px, height: screen.json.display.height_px, text: false },
    ...list.map((e) => ({ id: e.id, ...e.px, text: isText(e) })),
  ]);
  const k = screen.scale;
  const font = screen.platform === 'ios' ? '-apple-system, "SF Pro Text", Inter, sans-serif' : 'Roboto, sans-serif';
  const stats = { frames: 0, texts: 0, crops: 0, elements: list.length };
  const crop = (box: Rect): Record<string, string> => ({
    backgroundImage: `url("${src}")`, backgroundRepeat: 'no-repeat',
    backgroundSize: `${px(screen.width)} ${px(screen.height)}`, backgroundPosition: `${px(-box.x)} ${px(-box.y)}`,
  });
  const place = (box: Rect, origin: Rect) => ({ position: 'absolute', left: px(box.x - origin.x), top: px(box.y - origin.y), width: px(box.width), height: px(box.height) });
  const screenBg = samples.get('#screen')?.bg ?? '#ffffff';

  const layer = (e: AppElement, origin: Rect, parentBg: string): NewNode => {
    const sample = samples.get(e.id);
    const kids = children.get(e.id) ?? [];
    const attrs: Record<string, string> = {};
    if (ROLE_ATTR[e.role]) attrs.role = ROLE_ATTR[e.role]!;
    if (e.label && !isText(e)) attrs['aria-label'] = e.label.slice(0, 200);
    if (isText(e) && sample?.ink && sample.fg) {
      stats.texts++;
      const text = (e.text || e.label).slice(0, 2000);
      const ink: Rect = { x: sample.ink.x / k, y: sample.ink.y / k, width: sample.ink.width / k, height: sample.ink.height / k };
      const bands = sample.bands ?? 1;
      const size = Math.round(fontSizeFrom(ink.height, bands, text, e.box.height) * 2) / 2;
      const centred = Math.abs((ink.x - e.box.x) - (e.box.x + e.box.width - ink.x - ink.width)) <= 4 && ink.width < e.box.width * 0.85;
      const words: NewNode = { type: 'text', tag: e.role === 'button' ? 'span' : 'p', name: text.replace(/\s+/g, ' ').slice(0, 60), text, attrs: e.role === 'text' ? attrs : {}, style: {} };
      const type = {
        margin: '0', fontFamily: font, fontSize: px(size), color: sample.fg,
        fontWeight: (sample.stroke ?? 0) / (size * k) > 0.12 && !/^[\s\u2022*.]+$/.test(text) ? '700' : '400', whiteSpace: bands > 1 ? 'normal' : 'nowrap', textAlign: centred ? 'center' : 'left',
      };
      if (e.role === 'text' && e.box.height <= (ink.height / bands) * 2.6 * bands) {
        // A text view is about as tall as its lines: the layer takes its place, and its lines share the height.
        // Over the screenshot, its background hides the pixels of the same words.
        words.style = { ...place(e.box, origin), ...type, lineHeight: px(round(e.box.height / bands, 0.5)), ...(keepShot ? { backgroundColor: sample.bg } : {}) };
        return words;
      }
      // A field or a button: the control is a crop of the screenshot, with its border and corners, and the words lie
      // over their own pixels, covering them with the control's background. They stay clear of its edges.
      const lineHeight = bands > 1 ? (ink.height + (ink.height / bands) * 0.3) / bands : Math.round(size * 1.25);
      const edge = Math.max(2, Math.min(8, Math.min(e.box.width, e.box.height) * 0.12));
      const top = Math.max(e.box.y + edge, bands > 1 ? ink.y - (lineHeight * bands - ink.height) / 2 : ink.y + ink.height / 2 - lineHeight / 2);
      const left = centred ? e.box.x + edge : Math.max(e.box.x + edge, ink.x - 1);
      const right = centred ? e.box.x + e.box.width - edge : Math.min(e.box.x + e.box.width - edge, ink.x + ink.width * 1.2 + 4);
      const bottom = Math.min(e.box.y + e.box.height - edge, top + lineHeight * bands);
      const fits = bottom - top >= lineHeight * bands - 0.5;
      words.style = { ...place({ x: left, y: top, width: right - left, height: bottom - top }, e.box), ...type, lineHeight: px(fits ? lineHeight : (bottom - top) / bands), backgroundColor: sample.bg };
      stats.crops++;
      return { type: 'frame', tag: 'div', name: shortName(e), attrs, style: { ...place(e.box, origin), ...crop(e.box) }, children: [words] };
    }
    if (!kids.length && (IMAGE_ROLES.has(e.role) || !isText(e))) {
      stats.crops++;
      return { type: 'frame', tag: 'div', name: shortName(e), attrs, style: { ...place(e.box, origin), ...crop(e.box) } };
    }
    stats.frames++;
    const bg = sample?.bg ?? parentBg;
    const own = distance(bg, parentBg) > 24;
    return {
      type: 'frame', tag: 'div', name: shortName(e, true), attrs,
      style: { ...place(e.box, origin), ...(own ? { backgroundColor: bg } : {}) },
      children: kids.map((c) => layer(c, e.box, own ? bg : parentBg)),
    };
  };

  const screenRect: Rect = { x: 0, y: 0, width: screen.width, height: screen.height };
  const bars: NewNode[] = [];
  for (const [name, bar] of [['Status bar', screen.json.insets?.status_bar], ['Navigation bar', screen.json.insets?.navigation_bar]] as const) {
    if (!bar || bar.right <= bar.left || bar.bottom <= bar.top) continue;
    const box = rect(bar, k);
    stats.crops++;
    bars.push({ type: 'frame', tag: 'div', name, style: { ...place(box, screenRect), ...crop(box) } });
  }
  const content: NewNode[] = [
    ...(keepShot ? [{ type: 'image' as const, tag: 'img', name: SCREENSHOT_LAYER, src, attrs: { alt: 'Screenshot of the app' }, style: { position: 'absolute', left: '0px', top: '0px', width: px(screen.width), height: px(screen.height), objectFit: 'fill' } }] : []),
    ...bars,
    ...(children.get(null) ?? []).map((e) => layer(e, screenRect, screenBg)),
  ];
  const json = screen.json;
  const title = options.name ?? [json.app?.package?.split('.').at(-1), json.device.model].filter(Boolean).join(', ') ?? 'App screen';
  const left = px(options.x ?? 0);
  const topY = px(options.y ?? 0);
  const base = { fontFamily: font };
  let spec: NewNode;
  let width = screen.width;
  let height = screen.height;
  if (options.frame) {
    const bezel = 12;
    const radius = screen.platform === 'ios' ? 44 : 28;
    width += bezel * 2;
    height += bezel * 2;
    spec = {
      type: 'frame', tag: 'main', name: title || 'App screen', artboard: true,
      style: { position: 'absolute', left, top: topY, width: px(width), height: px(height), padding: px(bezel), boxSizing: 'border-box', display: 'flex', backgroundColor: '#0e0e0c', borderRadius: px(radius + bezel), ...base },
      children: [{ type: 'frame', tag: 'div', name: SCREEN_LAYER, style: { position: 'relative', width: px(screen.width), height: px(screen.height), flex: 'none', overflow: 'hidden', borderRadius: px(radius), backgroundColor: screenBg }, children: content }],
    };
  } else {
    spec = {
      type: 'frame', tag: 'main', name: title || 'App screen', artboard: true,
      style: { position: 'absolute', left, top: topY, width: px(width), height: px(height), overflow: 'hidden', backgroundColor: screenBg, ...base },
      children: content,
    };
  }
  return { spec, stats, width, height, warnings: screen.warnings };
}

/** What the file records about the artboard, besides the layers. */
export function recordFor(screen: AppScreen, src: string): Omit<AppScreenRecord, 'screenshotLayer' | 'screen'> {
  const json = screen.json;
  return {
    platform: screen.platform, unit: screen.unit, width: screen.width, height: screen.height, screenshot: src,
    ...(json.device.id ? { device: json.device.id } : {}), ...(json.device.model ? { model: json.device.model } : {}),
    ...(json.captured_at ? { capturedAt: json.captured_at } : {}), ...(json.app?.package ? { app: json.app.package } : {}),
  };
}

/** Inserts the plan as one change: call inside the caller's transaction. Returns the artboard's id. */
export function insertImport(doc: BogenDoc, pageId: string, screen: AppScreen, plan: ImportPlan, src: string): string {
  return insertAppScreen(doc, pageId, plan.spec, recordFor(screen, src));
}

export async function storeScreenshot(storage: Storage, screen: AppScreen): Promise<string> {
  return (await storage.putAsset(screen.png, 'image/png')).src;
}

// ---------------------------------------------------------------- design versus app

export interface MatchedPair {
  /** Boxes in dp or points from the top left of the screen. */
  layer: { id: string; name: string; text?: string; box: Rect };
  element: { id: string; role: string; label: string; name: string; box: Rect };
  /** In dp or points, design minus app: positive dx is further right, positive dy lower. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** null when both have the same words, or neither has any. */
  text: { design: string; app: string } | null;
  /** How the two boxes overlap, 0 to 1. */
  overlap: number;
  /** In words, such as "4 dp lower, 2 dp wider", or "same". */
  summary: string;
}

export interface Comparison {
  percent: number;
  differentPixels: number;
  totalPixels: number;
  /** Where the pixels differ, in pixels of the design rendered at the screen's size. */
  bounds: Rect | null;
  diff: Uint8Array;
  design: Uint8Array;
  matched: MatchedPair[];
  onlyInDesign: { id: string; name: string; text?: string; box: Rect }[];
  onlyInApp: { id: string; role: string; label: string; name: string; box: Rect }[];
  /** How the design's size relates to the screen's: 1 when the artboard is the screen's size. */
  scale: number;
  unit: string;
  warnings: string[];
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}@.]+/gu, ' ').trim();

function iou(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function similar(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return 1 - prev[n]! / Math.max(m, n);
}

function describeDelta(d: { dx: number; dy: number; dw: number; dh: number }, unit: string): string {
  const parts: string[] = [];
  const say = (v: number, plus: string, minus: string) => {
    if (Math.abs(v) >= 1) parts.push(`${Math.round(Math.abs(v))} ${unit} ${v > 0 ? plus : minus}`);
  };
  say(d.dx, 'further right', 'further left');
  say(d.dy, 'lower', 'higher');
  say(d.dw, 'wider', 'narrower');
  say(d.dh, 'taller', 'shorter');
  return parts.join(', ') || 'same';
}

export interface DesignLayer { id: string; name: string; text?: string; box: Rect }

/** Pairs layers with elements: the same words first, then similar words in about the same place, then the place alone. */
export function matchElements(layers: DesignLayer[], elements: AppElement[], unit: string): Pick<Comparison, 'matched' | 'onlyInDesign' | 'onlyInApp'> {
  const freeLayers = new Set(layers);
  const freeElements = new Set(elements);
  const matched: MatchedPair[] = [];
  const pair = (l: DesignLayer, e: AppElement) => {
    freeLayers.delete(l);
    freeElements.delete(e);
    const d = { dx: round(l.box.x - e.box.x, 0.5), dy: round(l.box.y - e.box.y, 0.5), dw: round(l.box.width - e.box.width, 0.5), dh: round(l.box.height - e.box.height, 0.5) };
    const lt = (l.text ?? '').trim();
    const et = e.text || e.label;
    const text = (lt || et) && words(lt) !== words(et) ? { design: lt, app: et } : null;
    matched.push({ layer: { id: l.id, name: l.name, ...(l.text !== undefined ? { text: l.text } : {}), box: l.box }, element: { id: e.id, role: e.role, label: e.label, name: shortName(e), box: e.box }, ...d, text, overlap: round(iou(l.box, e.box)), summary: [text ? 'other words' : '', describeDelta(d, unit)].filter((s) => s && s !== 'same').join(', ') || 'same' });
  };
  const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const gap = (a: Rect, b: Rect) => Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);
  const rounds: ((l: DesignLayer, e: AppElement) => number | null)[] = [
    (l, e) => (l.text && words(l.text) && words(l.text) === words(e.text || e.label) ? gap(l.box, e.box) : null),
    (l, e) => {
      const s = similar(words(l.text ?? ''), words(e.text || e.label));
      const o = iou(l.box, e.box);
      return s >= 0.6 && o > 0.1 ? (1 - s) * 100 + (1 - o) * 50 : null;
    },
    (l, e) => {
      const o = iou(l.box, e.box);
      // Two texts with nothing alike are not the same thing in the same place.
      if (l.text && (e.text || e.label) && similar(words(l.text), words(e.text || e.label)) < 0.3) return null;
      return o >= 0.5 ? (1 - o) * 100 : null;
    },
  ];
  for (const score of rounds) {
    const candidates: { l: DesignLayer; e: AppElement; s: number }[] = [];
    for (const l of freeLayers) for (const e of freeElements) {
      const s = score(l, e);
      if (s !== null) candidates.push({ l, e, s });
    }
    candidates.sort((a, b) => a.s - b.s);
    for (const c of candidates) if (freeLayers.has(c.l) && freeElements.has(c.e)) pair(c.l, c.e);
  }
  return {
    matched,
    onlyInDesign: [...freeLayers].map((l) => ({ id: l.id, name: l.name, ...(l.text !== undefined ? { text: l.text } : {}), box: l.box })),
    onlyInApp: [...freeElements].map((e) => ({ id: e.id, role: e.role, label: e.label, name: shortName(e), box: e.box })),
  };
}

/** Elements that stand for something on their own: text and leaves. Containers only group. */
export function comparableElements(screen: AppScreen): AppElement[] {
  const { list, children } = keptElements(screen);
  return list.filter((e) => !(children.get(e.id)?.length) || Boolean(e.text));
}

/**
 * A design artboard against a screen. The artboard is rendered at the screenshot's size and compared pixel by
 * pixel; its text layers and leaf layers are matched to the app's elements. An artboard imported with a device
 * frame is compared by its screen.
 */
export async function compareWithScreen(doc: BogenDoc, renderer: Renderer, nodeId: string, screen: AppScreen): Promise<Comparison> {
  const node = doc.getNode(nodeId);
  if (!node) throw new Error(`No layer with id ${nodeId}.`);
  const records = appScreenRecords(doc);
  const record = records[nodeId];
  const target = record?.screen && doc.getNode(record.screen) ? record.screen : nodeId;
  const skip = new Set<string>();
  for (const rec of Object.values(records)) if (rec.screenshotLayer) skip.add(rec.screenshotLayer);
  const layout = await renderer.layout(doc, { nodeIds: [target] });
  const own = layout.find((l) => l.id === target);
  if (!own || !own.width || !own.height) throw new Error('The layer has no size, so there is nothing to compare.');
  const k = screen.width / own.width;
  const warnings = [...screen.warnings];
  if (Math.abs(own.height * k - screen.height) > 2) warnings.push(`The design is ${Math.round(own.width)}x${Math.round(own.height)} and the screen ${screen.width}x${screen.height} ${screen.unit}: the pixels line up at the top left.`);
  const shot = await renderer.screenshot(doc, { nodeIds: [target] }, { format: 'png', scale: screen.json.display.width_px / own.width, maxDimension: 8000 });
  const diff = await renderer.compareImages({ bytes: shot.bytes, mime: 'image/png' }, { bytes: screen.png, mime: 'image/png' }, { threshold: 0.1, fit: true, maxDimension: 1600, maxBytes: 8 * 1024 * 1024 });
  const inside = new Set(doc.descendants(target).map((n) => n.id));
  const layers: DesignLayer[] = [];
  for (const entry of layout) {
    if (!inside.has(entry.id) || skip.has(entry.id) || !entry.width || !entry.height) continue;
    const n = doc.getNode(entry.id);
    if (!n || n.hidden) continue;
    const hasKids = doc.getChildren(entry.id).length > 0;
    if (n.type !== 'text' && hasKids) continue;
    layers.push({
      id: entry.id, name: n.name, ...(n.type === 'text' ? { text: n.text ?? '' } : {}),
      box: { x: (entry.x - own.x) * k, y: (entry.y - own.y) * k, width: entry.width * k, height: entry.height * k },
    });
  }
  const matches = matchElements(layers, comparableElements(screen), screen.unit);
  return {
    percent: diff.total ? Math.round((diff.different / diff.total) * 10000) / 100 : 0,
    differentPixels: diff.different, totalPixels: diff.total, bounds: diff.bounds,
    diff: diff.png, design: shot.bytes, ...matches, scale: round(k, 0.001), unit: screen.unit, warnings,
  };
}
