import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Connection } from './daemon.ts';
import { diffFolders, formatDiff, readFolder, readFolderAssets, writeFolder, type DesignFolder } from './design-folder.ts';

type Values = Record<string, string | boolean | undefined>;

/** Where a design folder keeps the brand its design links to: a design folder of its own. */
const BRAND_FOLDER = 'brand';

function headers(conn: Connection, json = true): Record<string, string> {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}) };
}

async function answer<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`The server answered ${res.status}.`);
  }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `The server answered ${res.status}.`);
  return body as T;
}

function numbers(value: string | boolean | undefined, name: string): number[] | undefined {
  if (typeof value !== 'string') return undefined;
  const list = value.split(',').map((v) => Number(v.trim()));
  if (list.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error(`--${name} takes whole numbers with commas, such as 1440,768,390.`);
  return list;
}

/** `bogen capture --site <url>`: follows the server's progress and ends with a report. */
export async function siteCapture(conn: Connection, url: string, values: Values, out: (line: string) => void): Promise<boolean> {
  const widths = numbers(values.widths, 'widths');
  const schemes = typeof values.schemes === 'string' ? values.schemes.split(',').map((s) => s.trim()) : undefined;
  if (schemes?.some((s) => s !== 'dark' && s !== 'light')) throw new Error('--schemes takes dark, light or both, such as dark,light.');
  const limit = typeof values.limit === 'string' ? Number(values.limit) : undefined;
  const res = await fetch(`${conn.url}/api/capture/site`, {
    method: 'POST', headers: headers(conn),
    body: JSON.stringify({
      url,
      ...(widths ? { widths } : {}), ...(schemes ? { schemes } : {}), ...(limit ? { limit } : {}),
      ...(typeof values.file === 'string' ? { fileId: values.file } : {}), ...(typeof values.name === 'string' ? { name: values.name } : {}),
      ...(values['no-fonts'] ? { captureFonts: false } : {}),
    }),
  });
  if (!res.ok || !res.body) await answer(res);
  let buffer = '';
  let ok = true;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += Buffer.from(chunk).toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, any>;
      if (event.t === 'file') out(`Capturing into "${event.name}" (${event.fileId})`);
      else if (event.t === 'found') out(event.sources.length ? `Sitemap: ${event.sitemap} routes in ${event.sources.join(', ')}` : 'No sitemap found. Following links from the first page.');
      else if (event.t === 'page') out(`  ${event.route}  ${event.artboards} artboards, ${event.layers} layers  (${event.done} done, ${event.queued} waiting)`);
      else if (event.t === 'failed') out(`  failed: ${event.url}: ${event.reason}`);
      else if (event.t === 'error') {
        out(`Stopped: ${event.error}`);
        ok = false;
      } else if (event.t === 'done') {
        const r = event.report;
        out('');
        out(`${r.pages.length} routes captured, ${r.pages.reduce((sum: number, p: any) => sum + p.artboards.length, 0)} artboards, limit ${r.limit}.`);
        out(`Fonts: ${r.fonts.stored} files stored${r.fonts.families.length ? ` (${r.fonts.families.join(', ')})` : ''}${r.fonts.google.length ? `, by name from Google Fonts: ${r.fonts.google.join(', ')}` : ''}.`);
        out(`Hover and focus rules kept: ${r.interactionRules}.`);
        if (r.fonts.failed.length) out(`Fonts not kept: ${r.fonts.failed.join('; ')}`);
        if (r.failed.length) {
          out(`Failed (${r.failed.length}):`);
          for (const f of r.failed) out(`  ${f.url}: ${f.reason}`);
          ok = false;
        }
        if (r.skipped.length) {
          out(`Skipped (${r.skipped.length}):`);
          for (const s of r.skipped.slice(0, 40)) out(`  ${s.url}: ${s.reason}`);
          if (r.skipped.length > 40) out(`  and ${r.skipped.length - 40} more`);
        }
        out(`File id: ${r.fileId}`);
      }
    }
  }
  return ok;
}

export async function figmaImport(conn: Connection, url: string, values: Values, figmaTokenArg: string | undefined, out: (line: string) => void): Promise<void> {
  const res = await fetch(`${conn.url}/api/import/figma`, {
    method: 'POST', headers: headers(conn),
    body: JSON.stringify({
      url,
      ...(figmaTokenArg ? { token: figmaTokenArg } : {}),
      ...(values['save-token'] ? { saveToken: true } : {}),
      ...(typeof values.name === 'string' ? { name: values.name } : {}),
    }),
  });
  const report = await answer<Record<string, any>>(res);
  out(`Imported "${report.file}" as "${report.name}" (${report.fileId}): ${report.pages.length} pages, ${report.layers} layers, ${report.images} images, ${report.vectors} vectors.`);
  if (report.fonts.length) out(`Fonts by name: ${report.fonts.join(', ')}. Google Fonts load by name; others need to be on this machine.`);
  for (const u of report.unsupported) out(`Not exact: ${u.what} (${u.count}, such as "${u.example}")`);
  for (const f of report.failed) out(`Failed: ${f}`);
  if (values['save-token']) out('The token is saved in config.json, readable by you only.');
}

/**
 * The editor's address for `bogen open <file>[#<layer>]`: the file by id or name, and a layer by id or name, which
 * the editor selects and brings into view. A file whose whole name has a # in it is found as it is.
 */
export async function openTarget(conn: Connection, target: string): Promise<{ hash: string; name: string }> {
  const files = await answer<{ id: string; name: string }[]>(await fetch(`${conn.url}/api/files`, { headers: headers(conn, false) }));
  const whole = files.some((f) => f.id === target || f.name === target);
  const cut = whole ? -1 : target.indexOf('#');
  const file = await findFile(conn, cut < 0 ? target : target.slice(0, cut), files);
  const layer = cut < 0 ? '' : target.slice(cut + 1).trim();
  return { hash: `#/file/${file.id}${layer ? `?layer=${encodeURIComponent(layer)}` : ''}`, name: layer ? `${file.name}, layer ${layer}` : file.name };
}

async function findFile(conn: Connection, nameOrId: string, known?: { id: string; name: string }[]): Promise<{ id: string; name: string }> {
  const files = known ?? await answer<{ id: string; name: string }[]>(await fetch(`${conn.url}/api/files`, { headers: headers(conn, false) }));
  const byId = files.find((f) => f.id === nameOrId);
  if (byId) return byId;
  const named = files.filter((f) => f.name === nameOrId);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`Several files are called "${nameOrId}": ${named.map((f) => f.id).join(', ')}. Use an id.`);
  throw new Error(`No file has the id or name "${nameOrId}".`);
}

/** The Git layer. The server does the work, on this machine. */
export async function gitCommand(conn: Connection, action: string, file: string, dirArg: string | undefined, values: Values, out: (line: string) => void): Promise<void> {
  const entry = await findFile(conn, file);
  const dir = dirArg ? resolve(dirArg) : undefined;
  if (action === 'init' && !dir) throw new Error('Usage: bogen git init <file> <dir>');
  const body: Record<string, unknown> = { action, ...(dir ? { dir } : {}) };
  if (typeof values.message === 'string') body.message = values.message;
  if (typeof values.rev === 'string') body.rev = values.rev;
  if (typeof values.limit === 'string') body.limit = Number(values.limit);
  const res = await answer<Record<string, any>>(await fetch(`${conn.url}/api/files/${entry.id}/git`, { method: 'POST', headers: headers(conn), body: JSON.stringify(body) }));
  if (action === 'init') out(`${res.created ? 'Made a Git repository' : 'Using the Git repository'} in ${res.dir}, bound to "${entry.name}". First commit: ${res.commit ?? 'nothing to commit'}.`);
  else if (action === 'commit') out(res.commit ? `Committed ${res.commit} in ${res.dir}.` : `Nothing changed in ${res.dir}. A Bogen commit was still made: ${res.bogenCommit}.`);
  else if (action === 'log') for (const c of res.log as { hash: string; at: number; author: string; subject: string }[]) out(`${c.hash.slice(0, 10)}  ${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}  ${c.author}  ${c.subject}`);
  else out(`Restored ${res.restored}: ${res.pages} pages, ${res.layers} layers. What it replaced is commit ${res.savedAs}.`);
}

type FolderAnswer = DesignFolder & { brand?: { id: string; name: string; content: DesignFolder['content'] }; brandNote?: { id: string; name?: string; why?: string } };

/** With the linked brand, unless --no-brand: as a design folder of its own, in brand/. */
export async function exportFolder(conn: Connection, file: string, dir: string, values: Values, out: (line: string) => void): Promise<void> {
  const entry = await findFile(conn, file);
  const folder = await answer<FolderAnswer>(await fetch(`${conn.url}/api/files/${entry.id}/folder${values['no-brand'] ? '?brand=0' : ''}`, { headers: headers(conn, false) }));
  const readAsset = async (name: string) => {
    const res = await fetch(`${conn.url}/assets/${name}`, { headers: headers(conn, false) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  };
  const result = await writeFolder(dir, { name: folder.name, content: folder.content }, readAsset);
  out(`Wrote "${folder.name}" to ${dir}: ${result.files} text files, ${result.assets} assets.`);
  const brandDir = join(dir, BRAND_FOLDER);
  if (folder.brand) {
    const brand = await writeFolder(brandDir, { name: folder.brand.name, content: folder.brand.content }, readAsset);
    out(`With its brand "${folder.brand.name}" in ${brandDir}: ${brand.files} text files, ${brand.assets} assets.`);
    result.missingAssets.push(...brand.missingAssets);
  } else {
    // A brand written there before is not this design's any more. Only a folder Bogen wrote is taken away.
    if (existsSync(join(brandDir, 'design.json'))) await rm(brandDir, { recursive: true, force: true });
    if (folder.brandNote) out(folder.brandNote.why === 'left out' ? 'Without its brand, as asked.' : `Without its brand: it links to one that is not on this device (${folder.brandNote.id}).`);
  }
  if (result.missingAssets.length) out(`Missing on this device: ${result.missingAssets.join(', ')}`);
}

export async function importFolder(conn: Connection, dir: string, values: Values, out: (line: string) => void): Promise<void> {
  const folder = await readFolder(dir);
  const assets = await readFolderAssets(dir);
  const brandDir = join(dir, BRAND_FOLDER);
  const brand = existsSync(join(brandDir, 'design.json')) ? await readFolder(brandDir) : null;
  if (brand) assets.push(...await readFolderAssets(brandDir));
  for (const asset of assets) {
    await answer(await fetch(`${conn.url}/api/assets`, { method: 'POST', headers: { ...headers(conn, false), 'Content-Type': asset.mime }, body: Buffer.from(asset.bytes) }));
  }
  const created = await answer<{ id: string; name: string; pages: number; layers: number; brand?: { message: string } }>(await fetch(`${conn.url}/api/files/import-folder`, {
    method: 'POST', headers: headers(conn),
    body: JSON.stringify({ name: typeof values.name === 'string' ? values.name : folder.name, content: folder.content, ...(brand ? { brand: { name: brand.name, content: brand.content } } : {}) }),
  }));
  out(`Imported "${created.name}" (${created.id}): ${created.pages} pages, ${created.layers} layers, ${assets.length} assets.`);
  if (created.brand) out(created.brand.message);
}

/** `bogen export <file or brand> [<path>] [--no-brand]`: a .bogen file, with the brand the file links to. */
export async function exportBogenFile(conn: Connection, nameOrId: string, target: string | undefined, values: Values, out: (line: string) => void): Promise<void> {
  const entry = await findFileOrBrand(conn, nameOrId);
  const path = resolve(target ?? `${entry.name.replace(/[^\p{L}\p{N}._ -]+/gu, '-').trim() || 'design'}.bogen`);
  if (!values.force && existsSync(path)) throw new Error(`${path} exists already. Pass --force to replace it.`);
  const res = await fetch(`${conn.url}/api/files/${entry.id}/download${values['no-brand'] ? '?brand=0' : ''}`, { headers: headers(conn, false) });
  if (!res.ok) await answer(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(path, bytes);
  const raw = res.headers.get('x-bogen-brand');
  const brand = raw ? JSON.parse(decodeURIComponent(raw)) as { included: boolean; name?: string; version?: number; why?: string; id: string } : null;
  out(`Wrote ${path}, ${Math.max(1, Math.round(bytes.length / 1024))} KB.`);
  if (brand?.included) out(entry.kind === 'brand' ? `The brand "${brand.name}" on its own, version ${brand.version}.` : `With its brand "${brand.name}", version ${brand.version}.`);
  else if (brand) out(brand.why === 'left out' ? 'Without its brand, as asked.' : `Without its brand: it links to one that is not on this device (${brand.id}).`);
}

/** `bogen import <file.bogen>`: makes a file of it, and adds the brand it carries unless this device has it. */
export async function importBogenFile(conn: Connection, path: string, out: (line: string) => void): Promise<void> {
  const bytes = await readFile(resolve(path));
  const res = await fetch(`${conn.url}/api/files/import`, {
    method: 'POST',
    headers: { ...headers(conn, false), 'Content-Type': 'application/x-bogen', 'X-Bogen-Filename': basename(path).replace(/[^\x20-\x7e]/g, '_') },
    body: bytes,
  });
  const created = await answer<{ id: string; name: string; kind: 'file' | 'brand'; brand?: { message: string } }>(res);
  out(created.kind === 'brand' ? `Imported the brand "${created.name}" (${created.id}).` : `Imported "${created.name}" (${created.id}).`);
  if (created.brand) out(created.brand.message);
}

async function findFileOrBrand(conn: Connection, nameOrId: string): Promise<{ id: string; name: string; kind: 'file' | 'brand' }> {
  try {
    return { ...await findFile(conn, nameOrId), kind: 'file' };
  } catch (e) {
    const brands = await answer<{ id: string; name: string }[]>(await fetch(`${conn.url}/api/brands`, { headers: headers(conn, false) }));
    const found = brands.filter((b) => b.id === nameOrId || b.name === nameOrId);
    if (found.length === 1) return { ...found[0]!, kind: 'brand' };
    if (found.length > 1) throw new Error(`Several brands are called "${nameOrId}": ${found.map((b) => b.id).join(', ')}. Use an id.`);
    if (/^Several files/.test((e as Error).message)) throw e;
    throw new Error(`No file or brand has the id or name "${nameOrId}".`);
  }
}

async function assetNames(dir: string): Promise<string[]> {
  return (await readFolderAssets(dir)).map((a) => a.name);
}

export async function diffCommand(a: string, b: string, values: Values, out: (text: string) => void): Promise<void> {
  for (const dir of [a, b]) {
    const info = await stat(dir).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`${dir} is not a folder.`);
  }
  const diff = diffFolders(await readFolder(a), await readFolder(b), await assetNames(a), await assetNames(b));
  out(values.json ? `${JSON.stringify(diff, null, 2)}\n` : formatDiff(diff));
}


/** Films a replay on the server and writes it here. */
export async function replayCommand(conn: Connection, file: string, values: Values, out: (line: string) => void): Promise<void> {
  const entry = await findFile(conn, file);
  const named = typeof values.output === 'string' ? /\.(mp4|webm|gif)$/i.exec(values.output)?.[1]?.toLowerCase() : undefined;
  const format = typeof values.format === 'string' ? values.format : named ?? 'mp4';
  if (!['mp4', 'webm', 'gif'].includes(format)) throw new Error('--format is mp4, webm or gif.');
  const number = (name: string): number | undefined => {
    const v = values[name];
    if (typeof v !== 'string') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} takes a positive number.`);
    return n;
  };
  const camera = typeof values.camera === 'string' ? values.camera : undefined;
  if (camera && !['auto', 'grow', 'fit', 'follow'].includes(camera)) throw new Error('--camera is auto, grow, fit or follow.');
  const maxIdle = number('max-idle');
  const body = {
    format,
    ...(typeof values.page === 'string' ? { page: values.page } : {}),
    ...(typeof values.from === 'string' ? { from: values.from } : {}),
    ...(typeof values.to === 'string' ? { to: values.to } : {}),
    ...(typeof values.run === 'string' ? { run: values.run } : {}),
    ...(number('speed') ? { speed: number('speed') } : {}),
    ...(maxIdle ? { maxIdleMs: maxIdle * 1000 } : {}),
    ...(number('width') ? { width: Math.round(number('width')!) } : {}),
    ...(number('height') ? { height: Math.round(number('height')!) } : {}),
    ...(number('fps') ? { fps: Math.round(number('fps')!) } : {}),
    ...(camera ? { camera } : {}),
    ...(values['no-captions'] ? { captions: false } : {}),
    ...(values['no-cursors'] ? { cursors: false } : {}),
  };
  out(`Filming "${entry.name}"...`);
  const res = await fetch(`${conn.url}/api/files/${entry.id}/replay/export`, { method: 'POST', headers: headers(conn), body: JSON.stringify(body) });
  if (!res.ok) await answer(res);
  const path = resolve(typeof values.output === 'string' ? values.output : `${entry.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-replay.${format}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(path, bytes);
  const raw = res.headers.get('x-bogen-export-report');
  const report = raw ? JSON.parse(decodeURIComponent(raw)) as { width?: number; height?: number; frames?: number; fps?: number; encoder?: string; notes?: string[] } : {};
  out(`Wrote ${path}: ${report.width}x${report.height}, ${report.frames} frames at ${report.fps} fps, ${Math.round(bytes.length / 1024)} KB, by ${report.encoder}.`);
  for (const note of report.notes ?? []) out(note);
}
