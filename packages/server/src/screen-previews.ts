import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { currentBranchId, exportDocument, type BogenDoc } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { atomicWrite } from './util.ts';
import { PREVIEW_BATCH_SIZE, shaderParamsTag, type PreviewCapture } from './render.ts';

export interface ScreenPreview {
  id: string; key: string; layers: number; state: 'pending' | 'ready' | 'unavailable';
  src?: string; smallSrc?: string; width?: number; height?: number;
}
interface Stored { file: string; key: string; width: number; height: number; at: number }
interface Job { file: string; node: string; key: string; fingerprint: string }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const KEY = /^[a-f0-9]{64}$/;

/** Hash the actual expanded design, including component instances and conditional CSS. Never run a browser here. */
export function screenFingerprint(doc: BogenDoc, id: string, shaders = shaderParamsTag(doc, src => src)): { fingerprint: string; layers: number } {
  const html = exportDocument(doc, [id], { ids: true, media: 'artboard' });
  return { fingerprint: sha(JSON.stringify([1, currentBranchId(doc), html, doc.variables.toJSON(), shaders])), layers: Math.max(1, [...html.matchAll(/data-bogen-id=/g)].length) };
}

/** Device-local, derived cache. One background render at a time, no document writes or eager file loading. */
export class ScreenPreviews {
  private readonly folder: string;
  private memo = new Map<string, Map<string, { id: string; fingerprint: string; layers: number }[]>>();
  private queue = new Map<string, Job>();
  private failed = new Map<string, number>();
  private retained = new Map<string, { file: string; branch: string; node: string; preview: ScreenPreview }>();
  private watched = new Map<string, Set<string>>();
  private warmTimers = new Map<string, NodeJS.Timeout>();
  private active: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private activeFile: string | null = null;
  private deleted = new Set<string>();
  constructor(private readonly app: BogenServer) { this.folder = join(app.storage.home, 'screen-previews'); }
  invalidate(file: string): void {
    this.memo.delete(file);
    const room = this.app.rooms.peek(file);
    if (!room || (!this.watched.has(file) && room.doc.nodes.size < 1000)) return;
    this.warmSoon(file, 1200);
  }
  private warmSoon(file: string, delay: number): void {
    if (this.closed || this.deleted.has(file)) return;
    const existing = this.warmTimers.get(file);
    if (existing || this.warmTimers.size >= 16) return;
    const timer = setTimeout(() => {
      this.warmTimers.delete(file);
      void this.warm(file).catch(() => {});
    }, delay); timer.unref(); this.warmTimers.set(file, timer);
  }
  private async warm(file: string): Promise<void> {
    const room = this.app.rooms.peek(file); if (this.closed || !room) return;
    if (this.app.memoryGauge.level() !== 'ok') { this.warmSoon(file, 5000); return; }
    const pages = this.watched.get(file) ?? new Set(room.doc.getPages().slice(0,1).map(p => p.id));
    for (const page of pages) {
      if (this.closed || this.deleted.has(file) || !room.doc.pages.has(page)) continue;
      if (room.doc.getChildren(page).filter(n => n.artboard && !n.hidden).length >= 3) await this.catalog(file, page);
    }
  }
  private async stored(key: string): Promise<Stored | null> {
    try {
      const value = JSON.parse(await readFile(join(this.folder, key + '.json'), 'utf8')) as Stored;
      if (value.key !== key || ![value.width, value.height].every(n => Number.isFinite(n) && n > 0 && n <= 100000)) return null;
      await Promise.all(['.webp', '-small.webp'].map(s => stat(join(this.folder, key + s))));
      return value;
    } catch { return null; }
  }
  async catalog(file: string, page: string, offset = 0): Promise<{ screens: ScreenPreview[]; paused: boolean; total: number; next: number | null; branch: string }> {
    this.deleted.delete(file);
    const { doc } = await this.app.rooms.get(file);
    if (!doc.pages.has(page)) throw new Error('No such page.');
    const branch = currentBranchId(doc);
    if (!this.watched.has(file)) { if (this.watched.size >= 16) this.watched.delete(this.watched.keys().next().value!); this.watched.set(file, new Set()); }
    const watched = this.watched.get(file)!;
    if (watched.size >= 8 && !watched.has(page)) watched.delete(watched.values().next().value!); watched.add(page);
    let pages = this.memo.get(file);
    if (!pages) { if (this.memo.size >= 16) this.memo.delete(this.memo.keys().next().value!); this.memo.set(file, pages = new Map()); }
    let nodes = pages.get(page);
    if (!nodes) {
      nodes = doc.getChildren(page).filter(n => n.artboard && !n.hidden).map(n => ({ id: n.id, fingerprint: '', layers: 0 }));
      pages.set(page, nodes);
    }
    const screens: ScreenPreview[] = [];
    // Bounded IO instead of one filesystem request per screen in parallel.
    const shaders = shaderParamsTag(doc, src => src);
    for (const node of nodes.slice(offset, offset + 200)) {
      if (!node.fingerprint) Object.assign(node, screenFingerprint(doc, node.id, shaders));
      if (screens.length % 5 === 4) await new Promise<void>(done => setImmediate(done));
      const key = sha(`${file}:${node.id}:${node.fingerprint}`), saved = await this.stored(key);
      const item: ScreenPreview = { id: node.id, key, layers: node.layers, state: 'pending' };
      if (saved) Object.assign(item, { state: 'ready', width: saved.width, height: saved.height, src: `/api/files/${file}/screen-previews/${key}`, smallSrc: `/api/files/${file}/screen-previews/${key}?small=1` });
      else if ((this.failed.get(key) ?? 0) > Date.now() || node.layers > 20000) item.state = 'unavailable';
      else if (this.queue.size < 200) this.queue.set(key, { file, node: node.id, key, fingerprint: node.fingerprint });
      const retainedKey = `${file}:${branch}:${node.id}`;
      if (saved) {
        if (this.retained.size >= 2048 && !this.retained.has(retainedKey)) this.retained.delete(this.retained.keys().next().value!);
        this.retained.set(retainedKey, { file, branch, node: node.id, preview: { ...item } });
      } else {
        const previous = this.retained.get(retainedKey)?.preview;
        if (previous) Object.assign(item, { src: previous.src, smallSrc: previous.smallSrc, width: previous.width, height: previous.height });
      }
      screens.push(item);
    }
    this.schedule(100);
    return { screens, paused: this.app.memoryGauge.level() !== 'ok', branch, total: nodes.length, next: offset + 200 < nodes.length ? offset + 200 : null };
  }
  async image(file: string, key: string, small: boolean): Promise<Uint8Array | null> {
    if (!KEY.test(key)) return null;
    // Membership comes from this file's current page catalogs, never from a caller-supplied filesystem path.
    const pages = this.memo.get(file);
    const current = pages && [...pages.values()].some(nodes => nodes.some(n => sha(`${file}:${n.id}:${n.fingerprint}`) === key));
    const doc = this.app.rooms.peek(file)?.doc;
    const retained = doc && [...this.retained.values()].some(v => v.file === file && v.branch === currentBranchId(doc) && v.preview.key === key && Boolean(doc.getNode(v.node)?.artboard));
    if (!current && !retained) return null;
    return readFile(join(this.folder, key + (small ? '-small.webp' : '.webp'))).catch(() => null);
  }
  private schedule(delay: number): void {
    if (this.closed || this.timer || this.active || !this.queue.size) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay); this.timer.unref();
  }
  private pump(): void {
    if (this.closed || this.active || !this.queue.size) return;
    if (this.app.memoryGauge.level() !== 'ok') { void this.app.renderer.releaseIdle().catch(() => {}); this.schedule(1500); return; }
    if (this.app.renderer.busy) { this.schedule(1500); return; }
    const first = this.queue.values().next().value!;
    if (!this.app.rooms.peek(first.file)?.doc.getNode(first.node)?.artboard) { this.queue.delete(first.key); this.schedule(100); return; }
    let retry = 350;
    this.active = this.app.renderer.screenPreviewBatch(async capture => {
      for (let i = 0; i < PREVIEW_BATCH_SIZE && this.queue.size; i++) {
        if (this.closed || this.app.memoryGauge.level() !== 'ok' || this.app.renderer.previewContended) break;
        const [key, job] = this.queue.entries().next().value!; this.queue.delete(key);
        this.activeFile = job.file;
        await this.render(job, capture);
      }
    }).catch(() => { retry = 5000; /* Retain jobs when the browser could not start. */ }).finally(async () => {
      await this.prune().catch(() => {});
      if (!this.queue.size || this.app.memoryGauge.level() !== 'ok') await this.app.renderer.releaseIdle().catch(() => {});
      this.active = null; this.activeFile = null; this.schedule(retry);
    });
  }

  private async render(job: Job, capture: PreviewCapture): Promise<void> {
    // A closed file is not reopened just to finish a cache job.
    const room = this.app.rooms.peek(job.file);
    if (!room || !room.doc.getNode(job.node)?.artboard) return;
    try {
      if (await this.stored(job.key)) return;
      if (screenFingerprint(room.doc, job.node).fingerprint !== job.fingerprint) return;
      const shot = await capture(room.doc, job.node, { format: 'webp', maxDimension: 768, maxBytes: 192 * 1024, previewDimension: 128, quality: 75 });
      if (this.closed || this.deleted.has(job.file) || screenFingerprint(room.doc, job.node).fingerprint !== job.fingerprint) return;
      if (!shot.preview || !shot.cssWidth || !shot.cssHeight) throw new Error('Missing preview geometry');
      await mkdir(this.folder, { recursive: true, mode: 0o700 });
      await atomicWrite(join(this.folder, job.key + '.webp'), shot.bytes, 0o600);
      await atomicWrite(join(this.folder, job.key + '-small.webp'), shot.preview, 0o600);
      await atomicWrite(join(this.folder, job.key + '.json'), JSON.stringify({ file: job.file, key: job.key, width: shot.cssWidth, height: shot.cssHeight, at: Date.now() }), 0o600);
    } catch { this.failed.set(job.key, Date.now() + 60000); if (this.failed.size > 512) this.failed.delete(this.failed.keys().next().value!); }
  }
  private async prune(): Promise<void> {
    let names = (await readdir(this.folder)).filter(n => /^[a-f0-9]{64}(?:-small)?\.(?:json|webp)$/.test(n));
    const complete = new Set(names.filter(n => n.endsWith('.json')).map(n => n.slice(0,64)));
    for (const name of names) if (!complete.has(name.slice(0,64))) await rm(join(this.folder, name), { force: true });
    names = names.filter(n => complete.has(n.slice(0,64)));
    const files = await Promise.all(names.map(async name => ({ name, ...(await stat(join(this.folder, name))) })));
    let size = files.reduce((sum, f) => sum + f.size, 0);
    const records = files.filter(f => f.name.endsWith('.json')).sort((a,b) => a.mtimeMs - b.mtimeMs);
    while ((size > 128 * 1024 * 1024 || records.length > 1024) && records.length) {
      const key = records.shift()!.name.slice(0, -5);
      for (const file of files.filter(f => f.name.startsWith(key))) { await rm(join(this.folder, file.name), { force: true }); size -= file.size; }
    }
  }
  async remove(file: string): Promise<void> {
    this.deleted.add(file); this.memo.delete(file); this.watched.delete(file);
    const timer = this.warmTimers.get(file); if (timer) clearTimeout(timer); this.warmTimers.delete(file);
    for (const [key, value] of this.retained) if (value.file === file) this.retained.delete(key);
    for (const [key, job] of this.queue) if (job.file === file) this.queue.delete(key);
    if (this.activeFile === file) await this.active;
    for (const name of await readdir(this.folder).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const value = JSON.parse(await readFile(join(this.folder, name), 'utf8')) as Stored;
        if (value.file === file) for (const suffix of ['.json', '.webp', '-small.webp']) await rm(join(this.folder, name.slice(0,-5) + suffix), { force: true });
      } catch { /* Another cache eviction may already have removed it. */ }
    }
  }
  async close(): Promise<void> { this.closed = true; for (const timer of this.warmTimers.values()) clearTimeout(timer); this.warmTimers.clear(); if (this.timer) clearTimeout(this.timer); this.queue.clear(); await this.active; }
}
