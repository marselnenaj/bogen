import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertContent, fontFaceKey, type ContentNode, type DesignContent } from '@bogen/core';
import { Storage } from './storage.ts';

/**
 * A design as a folder of text, for reading diffs in Git:
 *
 *   design.json            name, page order, keyframes
 *   tokens.json            design tokens, by name
 *   fonts.json             stored font faces (`fonts.json` only when the design has them, and so on below)
 *   states.json            hover and focus rules of captured pages
 *   repeats.json           live-data templates
 *   extra.json             other document-wide data, such as theme modes and text styles
 *   pages/<slug>--<id>.json  one page: its layers, parents before children
 *   libraries.json         copies of shared library components the design uses, on no page
 *   assets/<sha256>.<ext>  images, video and fonts, named by their content
 *
 * Keys are sorted, nothing volatile is written, and writing the same design twice gives the same bytes.
 */
export const FOLDER_FORMAT = 1;

export interface DesignFolder { name: string; content: DesignContent }

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().filter((k) => object[k] !== undefined).map((k) => [k, sortKeys(object[k])]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'page';
}

const PAGE_FILE = /^pages\/[^/\\]+\.json$/;

/** Every file except the assets, as path and text. */
export function folderFiles(folder: DesignFolder): Map<string, string> {
  const { content } = folder;
  const files = new Map<string, string>();
  const byParent = new Map<string, ContentNode[]>();
  const pageOf = new Map<string, string>();
  for (const page of content.pages) pageOf.set(page.id, page.id);
  const library: ContentNode[] = [];
  const inLibrary = new Set<string>();
  for (const node of content.nodes) {
    const page = pageOf.get(node.parent);
    if (!page) {
      if (node.parent.startsWith('lib:') || inLibrary.has(node.parent)) {
        inLibrary.add(node.id);
        library.push(node);
      }
      continue;
    }
    pageOf.set(node.id, page);
    const list = byParent.get(page);
    if (list) list.push(node);
    else byParent.set(page, [node]);
  }
  const pages = content.pages.map((page) => {
    const file = `pages/${slug(page.name)}--${page.id}.json`;
    files.set(file, stableJson({ id: page.id, name: page.name, order: page.order, layers: byParent.get(page.id) ?? [] }));
    return { file, id: page.id, name: page.name };
  });
  files.set('design.json', stableJson({ format: FOLDER_FORMAT, name: folder.name, pages, ...(content.keyframes.length ? { keyframes: content.keyframes } : {}) }));
  files.set('tokens.json', stableJson([...content.tokens].sort((a, b) => (a.name < b.name ? -1 : 1))));
  if (content.fontFaces.length) files.set('fonts.json', stableJson([...content.fontFaces].sort((a, b) => (fontFaceKey(a) < fontFaceKey(b) ? -1 : 1))));
  if (content.interactionStates.length) files.set('states.json', stableJson([...content.interactionStates].sort((a, b) => (a.artboardId < b.artboardId ? -1 : 1))));
  if (content.repeats && Object.keys(content.repeats).length) files.set('repeats.json', stableJson(content.repeats));
  if (content.extra && Object.keys(content.extra).length) files.set('extra.json', stableJson(content.extra));
  if (library.length) files.set('libraries.json', stableJson(library));
  return files;
}

/** Asset names a design refers to, wherever it refers to them. */
export function contentAssets(content: DesignContent): string[] {
  const names = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/bogen-asset:([a-f0-9]{64}\.[a-z0-9]{2,5})/g)) names.add(m[1]!);
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  scan(content.nodes);
  scan(content.fontFaces);
  return [...names].sort();
}

/**
 * Writes the folder. In a folder that already is a design, files that no longer belong go away, as a
 * diff should show. Any other folder with something in it is left alone, and that is an error.
 */
export async function writeFolder(dir: string, folder: DesignFolder, readAsset: (name: string) => Promise<Uint8Array | null>): Promise<{ files: number; assets: number; missingAssets: string[] }> {
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir);
  if (existing.some((name) => !name.startsWith('.')) && !existsSync(join(dir, 'design.json'))) throw new Error(`${dir} has other things in it and is not a design folder. Pick an empty folder.`);
  const files = folderFiles(folder);
  const names = contentAssets(folder.content);
  const assetFiles = new Set(names);
  for (const sub of ['pages', 'assets']) {
    for (const entry of await readdir(join(dir, sub)).catch(() => [] as string[])) {
      const path = `${sub}/${entry}`;
      if (sub === 'pages' ? !files.has(path) : !assetFiles.has(entry)) await rm(join(dir, path), { force: true });
    }
  }
  for (const optional of ['fonts.json', 'states.json', 'repeats.json', 'extra.json', 'libraries.json']) if (!files.has(optional)) await rm(join(dir, optional), { force: true });
  for (const [path, text] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  const missingAssets: string[] = [];
  if (names.length) await mkdir(join(dir, 'assets'), { recursive: true });
  for (const name of names) {
    const target = join(dir, 'assets', name);
    if (existsSync(target)) continue;
    const bytes = await readAsset(name);
    if (bytes) await writeFile(target, bytes);
    else missingAssets.push(name);
  }
  return { files: files.size, assets: names.length - missingAssets.length, missingAssets };
}

async function readJson<T>(path: string, fallback?: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Could not read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function readFolder(dir: string): Promise<DesignFolder> {
  const design = await readJson<{ format?: number; name?: string; pages?: { file?: string; id?: string; name?: string }[]; keyframes?: string[] }>(join(dir, 'design.json'));
  if (design.format !== FOLDER_FORMAT) throw new Error(`${dir} is a design folder of format ${design.format}, and this version reads format ${FOLDER_FORMAT}.`);
  if (!Array.isArray(design.pages)) throw new Error(`${join(dir, 'design.json')} lists no pages.`);
  const pages: DesignContent['pages'] = [];
  const nodes: ContentNode[] = [];
  for (const entry of design.pages) {
    // The list is text anyone could have changed, so a path in it must stay inside the folder.
    if (typeof entry.file !== 'string' || !PAGE_FILE.test(entry.file) || entry.file.includes('..')) throw new Error(`${JSON.stringify(entry.file)} is not a page file.`);
    const page = await readJson<{ id: string; name: string; order: string; layers?: ContentNode[] }>(join(dir, entry.file));
    pages.push({ id: page.id, name: page.name, order: page.order });
    nodes.push(...(page.layers ?? []));
  }
  nodes.push(...await readJson<ContentNode[]>(join(dir, 'libraries.json'), []));
  const content: DesignContent = {
    format: 1, pages, nodes,
    tokens: await readJson(join(dir, 'tokens.json'), []),
    keyframes: design.keyframes ?? [],
    fontFaces: await readJson(join(dir, 'fonts.json'), []),
    interactionStates: await readJson(join(dir, 'states.json'), []),
  };
  const repeats = await readJson<NonNullable<DesignContent['repeats']>>(join(dir, 'repeats.json'), {});
  if (Object.keys(repeats).length) content.repeats = repeats;
  const extra = await readJson<NonNullable<DesignContent['extra']>>(join(dir, 'extra.json'), {});
  if (Object.keys(extra).length) content.extra = extra;
  assertContent(content);
  return { name: typeof design.name === 'string' && design.name ? design.name : 'Imported design', content };
}

/** The assets in a folder, each checked against the hash in its name. */
export async function readFolderAssets(dir: string): Promise<{ name: string; bytes: Uint8Array; mime: string }[]> {
  const out: { name: string; bytes: Uint8Array; mime: string }[] = [];
  for (const name of await readdir(join(dir, 'assets')).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    if (!Storage.isAssetName(name)) throw new Error(`assets/${name} does not have the name of an asset.`);
    const bytes = await readFile(join(dir, 'assets', name));
    if (createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) throw new Error(`assets/${name} does not match the hash in its name.`);
    out.push({ name, bytes, mime: Storage.mimeOf(name) });
  }
  return out;
}

export interface FolderDiff {
  name?: { from: string; to: string };
  pages: { added: string[]; removed: string[]; renamed: { from: string; to: string }[]; reordered: boolean };
  layers: { page: string; added: string[]; removed: string[]; changed: { name: string; id: string; fields: string[] }[] }[];
  tokens: { added: string[]; removed: string[]; changed: string[] };
  keyframes: { added: number; removed: number };
  fonts: { added: string[]; removed: string[] };
  assets: { added: string[]; removed: string[] };
  /** True when nothing differs. */
  same: boolean;
}

function fieldChanges(a: ContentNode, b: ContentNode): string[] {
  const out = new Set<string>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'id') continue;
    if (key === 'style') {
      for (const prop of new Set([...Object.keys(a.style), ...Object.keys(b.style)])) if (a.style[prop] !== b.style[prop]) out.add(`style.${prop}`);
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.add(key);
  }
  return [...out].sort();
}

/** What changed from A to B, by meaning instead of by line. */
export function diffFolders(a: DesignFolder, b: DesignFolder, assetsA: string[] = contentAssets(a.content), assetsB: string[] = contentAssets(b.content)): FolderDiff {
  const pagesA = new Map(a.content.pages.map((p) => [p.id, p]));
  const pagesB = new Map(b.content.pages.map((p) => [p.id, p]));
  const pageOf = (content: DesignContent) => {
    const owner = new Map<string, string>(content.pages.map((p) => [p.id, p.id]));
    for (const n of content.nodes) owner.set(n.id, owner.get(n.parent) ?? n.parent);
    return owner;
  };
  const ownerA = pageOf(a.content);
  const ownerB = pageOf(b.content);
  const nodesA = new Map(a.content.nodes.map((n) => [n.id, n]));
  const nodesB = new Map(b.content.nodes.map((n) => [n.id, n]));
  const perPage = new Map<string, FolderDiff['layers'][number]>();
  const entry = (pageId: string) => {
    const name = pagesB.get(pageId)?.name ?? pagesA.get(pageId)?.name ?? pageId;
    let e = perPage.get(pageId);
    if (!e) {
      e = { page: name, added: [], removed: [], changed: [] };
      perPage.set(pageId, e);
    }
    return e;
  };
  for (const node of b.content.nodes) {
    const old = nodesA.get(node.id);
    const page = ownerB.get(node.id) ?? '';
    if (!old) entry(page).added.push(node.name);
    else {
      const fields = fieldChanges(old, node);
      if (fields.length) entry(page).changed.push({ id: node.id, name: node.name, fields });
    }
  }
  for (const node of a.content.nodes) if (!nodesB.has(node.id)) entry(ownerA.get(node.id) ?? '').removed.push(node.name);

  const tokensA = new Map(a.content.tokens.map((t) => [t.name, t]));
  const tokensB = new Map(b.content.tokens.map((t) => [t.name, t]));
  const facesA = new Set(a.content.fontFaces.map(fontFaceKey));
  const facesB = new Set(b.content.fontFaces.map(fontFaceKey));
  const setA = new Set(assetsA);
  const setB = new Set(assetsB);
  const kfA = new Set(a.content.keyframes);
  const kfB = new Set(b.content.keyframes);
  const orderOf = (content: DesignContent) => content.pages.filter((p) => pagesA.has(p.id) && pagesB.has(p.id)).map((p) => p.id).join();
  const diff: FolderDiff = {
    ...(a.name !== b.name ? { name: { from: a.name, to: b.name } } : {}),
    pages: {
      added: b.content.pages.filter((p) => !pagesA.has(p.id)).map((p) => p.name),
      removed: a.content.pages.filter((p) => !pagesB.has(p.id)).map((p) => p.name),
      renamed: b.content.pages.flatMap((p) => {
        const old = pagesA.get(p.id);
        return old && old.name !== p.name ? [{ from: old.name, to: p.name }] : [];
      }),
      reordered: orderOf(a.content) !== orderOf(b.content),
    },
    layers: [...perPage.values()],
    tokens: {
      added: [...tokensB.keys()].filter((n) => !tokensA.has(n)).sort(),
      removed: [...tokensA.keys()].filter((n) => !tokensB.has(n)).sort(),
      changed: [...tokensB.values()].filter((t) => tokensA.has(t.name) && (tokensA.get(t.name)!.value !== t.value || tokensA.get(t.name)!.kind !== t.kind)).map((t) => t.name).sort(),
    },
    keyframes: { added: [...kfB].filter((k) => !kfA.has(k)).length, removed: [...kfA].filter((k) => !kfB.has(k)).length },
    fonts: { added: [...facesB].filter((k) => !facesA.has(k)).sort(), removed: [...facesA].filter((k) => !facesB.has(k)).sort() },
    assets: { added: [...setB].filter((n) => !setA.has(n)).sort(), removed: [...setA].filter((n) => !setB.has(n)).sort() },
    same: false,
  };
  diff.same = !diff.name && !diff.pages.added.length && !diff.pages.removed.length && !diff.pages.renamed.length && !diff.pages.reordered && !diff.layers.length
    && !diff.tokens.added.length && !diff.tokens.removed.length && !diff.tokens.changed.length && !diff.keyframes.added && !diff.keyframes.removed
    && !diff.fonts.added.length && !diff.fonts.removed.length && !diff.assets.added.length && !diff.assets.removed.length;
  return diff;
}

function short(list: string[], limit = 6): string {
  const names = list.map((n) => n.replace(/\s+/g, ' ').slice(0, 40));
  return names.length > limit ? `${names.slice(0, limit).join(', ')} and ${names.length - limit} more` : names.join(', ');
}

/** The diff as lines for a terminal. */
export function formatDiff(diff: FolderDiff): string {
  if (diff.same) return 'No differences.\n';
  const lines: string[] = [];
  if (diff.name) lines.push(`Name: ${diff.name.from} -> ${diff.name.to}`);
  if (diff.pages.added.length) lines.push(`Pages added: ${short(diff.pages.added)}`);
  if (diff.pages.removed.length) lines.push(`Pages removed: ${short(diff.pages.removed)}`);
  for (const r of diff.pages.renamed) lines.push(`Page renamed: ${r.from} -> ${r.to}`);
  if (diff.pages.reordered) lines.push('Pages reordered');
  for (const page of diff.layers) {
    lines.push(`Page ${page.page}: ${page.added.length} layers added, ${page.removed.length} removed, ${page.changed.length} changed`);
    if (page.added.length) lines.push(`  + ${short(page.added)}`);
    if (page.removed.length) lines.push(`  - ${short(page.removed)}`);
    for (const c of page.changed.slice(0, 20)) lines.push(`  ~ ${c.name.replace(/\s+/g, ' ').slice(0, 40)}: ${short(c.fields, 8)}`);
    if (page.changed.length > 20) lines.push(`  ~ and ${page.changed.length - 20} more`);
  }
  if (diff.tokens.added.length) lines.push(`Tokens added: ${short(diff.tokens.added)}`);
  if (diff.tokens.removed.length) lines.push(`Tokens removed: ${short(diff.tokens.removed)}`);
  if (diff.tokens.changed.length) lines.push(`Tokens changed: ${short(diff.tokens.changed)}`);
  if (diff.keyframes.added || diff.keyframes.removed) lines.push(`Keyframes: ${diff.keyframes.added} added, ${diff.keyframes.removed} removed`);
  if (diff.fonts.added.length) lines.push(`Font faces added: ${diff.fonts.added.length}`);
  if (diff.fonts.removed.length) lines.push(`Font faces removed: ${diff.fonts.removed.length}`);
  if (diff.assets.added.length) lines.push(`Assets added: ${diff.assets.added.length}`);
  if (diff.assets.removed.length) lines.push(`Assets removed: ${diff.assets.removed.length}`);
  return `${lines.join('\n')}\n`;
}
