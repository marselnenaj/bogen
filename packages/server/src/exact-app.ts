import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExactApp } from '@bogen/core';
import type { Storage } from './storage.ts';

/** Where an Exact app goes in `dir`: a new folder named after it, or that folder itself when `overwrite`. */
export async function exactFolder(dir: string, name: string, overwrite: boolean): Promise<string> {
  const exists = (p: string) => stat(p).then(() => true, () => false);
  if (overwrite || !(await exists(join(dir, name)))) return join(dir, name);
  for (let i = 2; i < 10_000; i++) if (!(await exists(join(dir, `${name}-${i}`)))) return join(dir, `${name}-${i}`);
  throw new Error('Could not find a free folder name. Pass overwrite true to write into the existing one.');
}

/**
 * Writes an Exact app (toExactApp) into `folder`: its text files, and its pictures under assets/, copied from the
 * file's assets or decoded from inline pictures. Returns the files written and the pictures that could not be.
 */
export async function writeExactApp(app: ExactApp, folder: string, storage: Storage, overwrite: boolean): Promise<{ files: string[]; missing: string[] }> {
  await mkdir(folder, { recursive: true });
  const files: string[] = [];
  const missing: string[] = [];
  const put = async (path: string, data: string | Uint8Array) => {
    const at = join(folder, path);
    await mkdir(dirname(at), { recursive: true });
    // wx: a file that is already there is not replaced, unless asked.
    await writeFile(at, data, { flag: overwrite ? 'w' : 'wx' });
    files.push(path);
  };
  for (const [path, text] of Object.entries(app.files)) await put(path, text);
  for (const asset of app.assets) {
    let bytes: Uint8Array | null = null;
    if (asset.src.startsWith('bogen-asset:')) bytes = (await storage.readAsset(asset.src.slice('bogen-asset:'.length)))?.bytes ?? null;
    else {
      const data = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(asset.src);
      if (data) bytes = Buffer.from(data[1]!, 'base64');
    }
    if (bytes) await put(asset.path, bytes);
    else missing.push(asset.path);
  }
  return { files, missing };
}

/** Writes code files (handoffFiles) into `folder`, and returns their paths in it. */
export async function writeCodeFiles(list: { path: string; text: string }[], folder: string, overwrite: boolean): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const files: string[] = [];
  for (const f of list) {
    // Paths come from Bogen's own writer: names it made, one folder deep at most.
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(f.path) || f.path.includes('..')) throw new Error(`Not a file name: ${f.path}`);
    const at = join(folder, f.path);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, f.text, { flag: overwrite ? 'w' : 'wx' });
    files.push(f.path);
  }
  return files;
}
