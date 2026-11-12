import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { BogenDoc } from '@bogen/core';
import { buildSite, typeOf, type BuildDeps, type SitePage } from './publish-export.ts';
import { MARKER, planGithub, pushGithub, type GhCli, type GhPlan } from './publish-github.ts';
import { baseHeaders, refuseText, type Gate } from './static-listener.ts';
import { atomicWrite, errorMessage, HttpError } from './util.ts';

/**
 * Publishing: a page or an artboard as a static website, in versions. A version is a frozen export on disk,
 * made by the owner in the editor or prepared by an agent. Nothing becomes reachable until the owner sends a
 * version somewhere: Bogen's site listener, a folder, or GitHub Pages. Rollback sends an older version, and
 * unpublish takes it back. The state is `publish/state.json`, owner-only; versions are `publish/versions/<id>/`.
 */

const VERSION_ID = /^[a-f0-9]{32}$/;
const SITE_ID = /^[a-f0-9]{12}$/;
const KEEP_VERSIONS = 20;

const Version = z.object({
  id: z.string().regex(VERSION_ID), n: z.number().int(), at: z.number(), by: z.string().max(80),
  files: z.number().int(), bytes: z.number().int(), notes: z.array(z.string()).max(40),
  pages: z.array(z.object({ file: z.string(), title: z.string(), rootId: z.string(), pageId: z.string() })),
});
export type PublishVersion = z.output<typeof Version>;

const Site = z.object({
  id: z.string().regex(SITE_ID), fileId: z.string(), pageId: z.string(), nodeId: z.string().optional(), name: z.string().max(200),
  fit: z.enum(['fluid', 'fixed']).default('fluid'), createdAt: z.number(), versions: z.array(Version).default([]),
  live: z.object({
    listener: z.string().regex(VERSION_ID).optional(),
    folder: z.object({ path: z.string(), version: z.string().regex(VERSION_ID) }).optional(),
    github: z.object({ repo: z.string(), branch: z.string(), version: z.string().regex(VERSION_ID) }).optional(),
  }).default({}),
});
export type PublishSite = z.output<typeof Site>;

const Request = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/), kind: z.enum(['publish', 'share']), siteId: z.string().regex(SITE_ID), versionId: z.string().regex(VERSION_ID),
  by: z.string().max(80), at: z.number(), target: z.enum(['listener', 'folder', 'github']).optional(),
  share: z.object({ label: z.string().max(80), days: z.number().int().min(1).max(90), maxViews: z.number().int().min(1).max(100_000).optional(), comments: z.boolean() }).optional(),
  note: z.string().max(500).optional(),
});
export type PublishRequest = z.output<typeof Request>;

const State = z.object({ sites: z.array(Site).default([]), requests: z.array(Request).default([]) });

interface Manifest { version: string; files: Record<string, { sha256: string; bytes: number; type: string; csp?: string }> }

export interface PublishDeps extends BuildDeps {
  home: string;
  /** The document of a file, loaded. */
  doc: (fileId: string) => Promise<BogenDoc>;
  fileName: (fileId: string) => string | undefined;
  gh: GhCli;
  changed?: () => void;
  /** Versions a review link still shows, which are kept however old. */
  inUse?: () => Set<string>;
  /** A picture of a top-level layer as it is now, for a review form's click-a-place. Null when it cannot be drawn. */
  shot?: (doc: BogenDoc, rootId: string) => Promise<{ png: Uint8Array; width: number } | null>;
}

export type Target = 'listener' | 'folder' | 'github';

const PROTECTED = ['.ssh', '.gnupg', '.aws', '.kube', '.password-store', '.config', '.local', '.cache'];

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

async function realLocation(path: string): Promise<string> {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** A folder the owner may publish into: under home, not home itself, not hidden, not keys or Bogen's data, not a link. */
export async function folderLocation(given: string, dataDir: string, home = homedir()): Promise<string> {
  const expanded = given === '~' || given.startsWith('~/') ? join(home, given.slice(1)) : given;
  if (!isAbsolute(expanded)) throw new HttpError(400, 'Name the folder with a full path, such as ~/Sites/couchette.');
  const wanted = resolve(expanded);
  const realHome = await realLocation(home);
  const real = await realLocation(wanted);
  if (!inside(realHome, real) || real === realHome) throw new HttpError(400, `Publish into a folder of its own under ${home}.`);
  if (relative(realHome, real).split(sep).some((p) => p.startsWith('.'))) throw new HttpError(400, 'Bogen does not publish into a hidden folder.');
  for (const no of [dataDir, ...PROTECTED.map((d) => join(home, d))]) if (inside(await realLocation(no), real)) throw new HttpError(400, 'That folder is protected.');
  const st = await lstat(wanted).catch(() => null);
  if (st?.isSymbolicLink()) throw new HttpError(400, 'That folder is a link. Name the folder it points to.');
  if (st && !st.isDirectory()) throw new HttpError(400, 'That is a file, not a folder.');
  return real;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Every file under a folder, refusing links, so that nothing written there can land elsewhere. */
async function listFolder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new HttpError(409, `${relative(root, full)} in that folder is a link. Bogen does not publish where a link could send files elsewhere.`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
      if (out.length > 5000) throw new HttpError(409, 'That folder holds too many files. Use a folder of its own for the site.');
    }
  };
  await walk(root);
  return out;
}

export class Publisher {
  private state: z.output<typeof State> = { sites: [], requests: [] };
  private loaded = false;
  private write: Promise<void> = Promise.resolve();
  private manifests = new Map<string, Manifest>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PublishDeps) {}

  private get dir(): string {
    return join(this.deps.home, 'publish');
  }

  versionDir(id: string): string {
    if (!VERSION_ID.test(id)) throw new HttpError(404, 'No such version.');
    return join(this.dir, 'versions', id);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.state = State.parse(JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`bogen: publish/state.json was unreadable (${errorMessage(e)}), nothing is published`);
    }
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    this.write = this.write.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await atomicWrite(join(this.dir, 'state.json'), body, 0o600);
    });
    this.deps.changed?.();
    return this.write;
  }

  /** One change at a time: two publishes into one folder must not interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(fn);
    this.queue = run;
    return run;
  }

  sites(): PublishSite[] {
    return this.state.sites;
  }

  requests(): PublishRequest[] {
    return this.state.requests;
  }

  site(id: string): PublishSite {
    const site = this.state.sites.find((s) => s.id === id);
    if (!site) throw new HttpError(404, 'No such site.');
    return site;
  }

  version(siteId: string, versionId: string): PublishVersion {
    const v = this.site(siteId).versions.find((x) => x.id === versionId);
    if (!v) throw new HttpError(404, 'No such version.');
    return v;
  }

  /** The site the listener serves: there is one at a time. */
  listenerSite(): { site: PublishSite; version: string } | null {
    const site = this.state.sites.find((s) => s.live.listener);
    return site ? { site, version: site.live.listener! } : null;
  }

  /** Makes a new version from the design as it is now. Nothing is reachable from it until it is sent somewhere. */
  prepare(input: { fileId: string; pageId?: string; nodeId?: string; title?: string; fit?: 'fluid' | 'fixed'; by: string }): Promise<{ site: PublishSite; version: PublishVersion }> {
    return this.serial(async () => {
      const doc = await this.deps.doc(input.fileId);
      const pageId = input.pageId ?? (input.nodeId ? doc.pageOf(input.nodeId) : doc.getPages()[0]?.id);
      if (!pageId) throw new HttpError(400, 'That page or layer does not exist.');
      let site = this.state.sites.find((s) => s.fileId === input.fileId && s.pageId === pageId && s.nodeId === input.nodeId);
      const name = (input.nodeId ? doc.getNode(input.nodeId)?.name : doc.getPages().find((p) => p.id === pageId)?.name) ?? 'Site';
      // The review form's picture must show this version and nothing newer, so any edit while it is made drops it.
      let edited = false;
      const onUpdate = () => { edited = true; };
      doc.y.on('update', onUpdate);
      let built;
      const shots: ({ png: Uint8Array; width: number } | null)[] = [];
      try {
        built = await buildSite(doc, { pageId, nodeId: input.nodeId, title: input.title, fit: input.fit ?? site?.fit }, this.deps);
        for (const page of built.pages) shots.push(this.deps.shot ? await this.deps.shot(doc, page.rootId).catch(() => null) : null);
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(400, errorMessage(e));
      } finally {
        doc.y.off('update', onUpdate);
      }
      if (!site) {
        site = Site.parse({ id: randomBytes(6).toString('hex'), fileId: input.fileId, pageId, ...(input.nodeId ? { nodeId: input.nodeId } : {}), name, fit: input.fit ?? 'fluid', createdAt: Date.now() });
        this.state.sites.push(site);
      }
      site.name = name;
      if (input.fit) site.fit = input.fit;
      const id = randomBytes(16).toString('hex');
      const root = this.versionDir(id);
      const manifest: Manifest = { version: id, files: {} };
      for (const f of built.files) {
        const path = join(root, 'site', ...f.path.split('/'));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await atomicWrite(path, f.bytes, 0o600);
        manifest.files[f.path] = { sha256: sha256(f.bytes), bytes: f.bytes.length, type: f.type, ...(f.csp ? { csp: f.csp } : {}) };
      }
      await atomicWrite(join(root, 'manifest.json'), JSON.stringify(manifest), 0o600);
      // Beside the site, not in it: only a review link's form shows it.
      if (!edited) {
        for (const [i, shot] of shots.entries()) {
          if (!shot) continue;
          await mkdir(join(root, 'review'), { recursive: true, mode: 0o700 });
          await atomicWrite(join(root, 'review', `shot-${i}.png`), shot.png, 0o600);
          await atomicWrite(join(root, 'review', `shot-${i}.json`), JSON.stringify({ width: shot.width }), 0o600);
        }
      }
      this.manifests.set(id, manifest);
      const version: PublishVersion = {
        id, n: (site.versions.at(-1)?.n ?? 0) + 1, at: Date.now(), by: input.by.slice(0, 80), files: built.files.length,
        bytes: built.files.reduce((s, f) => s + f.bytes.length, 0), notes: built.notes.slice(0, 40), pages: built.pages as SitePage[],
      };
      site.versions.push(version);
      await this.prune(site);
      await this.save();
      return { site, version };
    });
  }

  /** Old versions go, but never one that is live somewhere, waits for the owner, or that a review link still shows. */
  private async prune(site: PublishSite): Promise<void> {
    if (site.versions.length <= KEEP_VERSIONS) return;
    const keep = new Set([site.live.listener, site.live.folder?.version, site.live.github?.version, ...this.state.requests.map((r) => r.versionId), ...(this.deps.inUse?.() ?? [])].filter(Boolean) as string[]);
    const drop = site.versions.slice(0, site.versions.length - KEEP_VERSIONS).filter((v) => !keep.has(v.id));
    for (const v of drop) {
      await rm(this.versionDir(v.id), { recursive: true, force: true });
      this.manifests.delete(v.id);
    }
    site.versions = site.versions.filter((v) => !drop.includes(v));
  }

  /** An agent's or the CLI's wish, which waits for the owner in the editor. */
  async request(input: Omit<PublishRequest, 'id' | 'at'>): Promise<PublishRequest> {
    this.version(input.siteId, input.versionId);
    // One waiting wish per kind and site is enough; the newest replaces the last.
    this.state.requests = this.state.requests.filter((r) => !(r.siteId === input.siteId && r.kind === input.kind));
    const req = Request.parse({ ...input, id: randomBytes(6).toString('hex'), at: Date.now() });
    this.state.requests.push(req);
    if (this.state.requests.length > 50) this.state.requests.shift();
    await this.save();
    return req;
  }

  async dismiss(id: string): Promise<void> {
    this.state.requests = this.state.requests.filter((r) => r.id !== id);
    await this.save();
  }

  async manifest(versionId: string): Promise<Manifest> {
    const known = this.manifests.get(versionId);
    if (known) return known;
    const parsed = JSON.parse(await readFile(join(this.versionDir(versionId), 'manifest.json'), 'utf8')) as Manifest;
    if (parsed.version !== versionId) throw new HttpError(404, 'No such version.');
    this.manifests.set(versionId, parsed);
    return parsed;
  }

  /** The files of a version, read back and checked against the manifest. */
  async files(versionId: string): Promise<Map<string, Uint8Array>> {
    const manifest = await this.manifest(versionId);
    const out = new Map<string, Uint8Array>();
    for (const [path, entry] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(this.versionDir(versionId), 'site', ...path.split('/')));
      if (sha256(bytes) !== entry.sha256) throw new HttpError(500, 'A file of this version changed on disk. Publish a new version.');
      out.set(path, bytes);
    }
    return out;
  }

  /** Sends a version somewhere. Only ever called for the owner in the editor; the route checks that. */
  publish(siteId: string, versionId: string, target: Target, options: { path?: string; repo?: string; branch?: string; allowForeign?: boolean; fingerprint?: string } = {}): Promise<unknown> {
    return this.serial(async () => {
      const site = this.site(siteId);
      this.version(siteId, versionId);
      this.state.requests = this.state.requests.filter((r) => !(r.siteId === siteId && r.versionId === versionId && r.kind === 'publish'));
      if (target === 'listener') {
        // One site on the listener at a time: this one takes the place of any other.
        for (const s of this.state.sites) delete s.live.listener;
        site.live.listener = versionId;
        await this.save();
        return { target, version: versionId };
      }
      if (target === 'folder') {
        if (!options.path) throw new HttpError(400, 'Name the folder.');
        const out = await this.toFolder(options.path, versionId, Boolean(options.allowForeign));
        site.live.folder = { path: out.path, version: versionId };
        await this.save();
        return { target, ...out };
      }
      if (!options.repo || !options.branch || !options.fingerprint) throw new HttpError(400, 'Name the repository and branch, and confirm the plan.');
      const out = await pushGithub(this.deps.gh, options.repo, options.branch, await this.files(versionId), versionId, { fingerprint: options.fingerprint, allowForeign: Boolean(options.allowForeign) });
      site.live.github = { repo: options.repo, branch: options.branch, version: versionId };
      await this.save();
      return { target, ...out };
    });
  }

  /** What a push to GitHub would do. Reads the branch, changes nothing. */
  async planGithub(siteId: string, versionId: string | null, repo: string, branch: string): Promise<GhPlan> {
    this.site(siteId);
    return planGithub(this.deps.gh, repo, branch, versionId ? await this.files(versionId) : new Map(), versionId);
  }

  /** Takes a site back from one target, or from all of them. A folder keeps every file Bogen did not write. */
  unpublish(siteId: string, target?: Target, options: { fingerprint?: string } = {}): Promise<{ removed: Target[]; kept: string[] }> {
    return this.serial(async () => {
      const site = this.site(siteId);
      const removed: Target[] = [];
      const kept: string[] = [];
      if ((!target || target === 'listener') && site.live.listener) {
        delete site.live.listener;
        removed.push('listener');
      }
      if ((!target || target === 'folder') && site.live.folder) {
        kept.push(...await this.clearFolder(site.live.folder.path));
        delete site.live.folder;
        removed.push('folder');
      }
      if (target === 'github' && site.live.github) {
        const { repo, branch } = site.live.github;
        const plan = await planGithub(this.deps.gh, repo, branch, new Map(), null);
        await pushGithub(this.deps.gh, repo, branch, new Map(), null, { fingerprint: options.fingerprint ?? plan.fingerprint, allowForeign: true });
        delete site.live.github;
        removed.push('github');
      }
      await this.save();
      return { removed, kept };
    });
  }

  /** Forgets a site and every version of it, once it is live nowhere. */
  async remove(siteId: string): Promise<void> {
    const site = this.site(siteId);
    if (site.live.listener || site.live.folder || site.live.github) throw new HttpError(409, 'Unpublish it first.');
    if ([...(this.deps.inUse?.() ?? [])].some((v) => site.versions.some((x) => x.id === v))) throw new HttpError(409, 'A review link still shows a version of it. Revoke the link first.');
    for (const v of site.versions) await rm(this.versionDir(v.id), { recursive: true, force: true });
    this.state.sites = this.state.sites.filter((s) => s !== site);
    this.state.requests = this.state.requests.filter((r) => r.siteId !== siteId);
    await this.save();
  }

  private async readMarker(root: string): Promise<Record<string, string>> {
    try {
      const st = await lstat(join(root, MARKER));
      if (!st.isFile()) return {};
      const parsed = JSON.parse(await readFile(join(root, MARKER), 'utf8')) as { publishedBy?: string; files?: Record<string, string> };
      if (parsed.publishedBy !== 'Bogen' || !parsed.files || typeof parsed.files !== 'object') return {};
      return Object.fromEntries(Object.entries(parsed.files).filter(([k, v]) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) && !k.split('/').some((p) => !p || p.startsWith('.'))));
    } catch {
      return {};
    }
  }

  /** Files of the folder that Bogen wrote and nobody changed since; everything else in it is someone else's. */
  private async ownership(root: string): Promise<{ ours: Map<string, string>; foreign: string[] }> {
    const marker = await this.readMarker(root);
    const ours = new Map<string, string>();
    const foreign: string[] = [];
    const present = await lstat(root).then((s) => s.isDirectory(), () => false);
    if (!present) return { ours, foreign };
    for (const path of await listFolder(root)) {
      if (path === MARKER) continue;
      const recorded = marker[path];
      if (recorded && sha256(await readFile(join(root, ...path.split('/')))) === recorded) ours.set(path, recorded);
      else foreign.push(path);
    }
    return { ours, foreign };
  }

  /**
   * Writes a version into a folder. A file Bogen did not write is never overwritten, a folder with such files
   * needs the owner's yes, and files of the last publish that this one no longer has are removed.
   */
  async toFolder(given: string, versionId: string, allowForeign: boolean): Promise<{ path: string; written: number; removed: number; foreign: number }> {
    const root = await folderLocation(given, this.deps.home);
    const files = await this.files(versionId);
    const { ours, foreign } = await this.ownership(root);
    const clash = [...files.keys()].filter((p) => foreign.includes(p));
    if (clash.length) throw new HttpError(409, `Nothing was published: ${clash.slice(0, 5).join(', ')} ${clash.length === 1 ? 'is' : 'are'} in that folder and Bogen did not write ${clash.length === 1 ? 'it' : 'them'}.`);
    if (foreign.length && !allowForeign) throw new HttpError(409, `Nothing was published: that folder holds ${foreign.length} file${foreign.length === 1 ? '' : 's'} Bogen did not write, such as ${foreign.slice(0, 3).join(', ')}. Confirm to publish beside ${foreign.length === 1 ? 'it' : 'them'}.`);
    await mkdir(root, { recursive: true, mode: 0o755 });
    let written = 0;
    for (const [path, bytes] of files) {
      const full = join(root, ...path.split('/'));
      if (!inside(root, full)) throw new HttpError(500, 'A file of the site would land outside the folder.');
      if (ours.get(path) === sha256(bytes)) continue;
      await mkdir(dirname(full), { recursive: true, mode: 0o755 });
      await atomicWrite(full, bytes, 0o644);
      written++;
    }
    let removed = 0;
    for (const path of ours.keys()) {
      if (files.has(path)) continue;
      await unlink(join(root, ...path.split('/'))).catch(() => {});
      removed++;
    }
    await this.pruneDirs(root, [...ours.keys()]);
    const marker = { publishedBy: 'Bogen', version: versionId, files: Object.fromEntries([...files].map(([p, b]) => [p, sha256(b)])) };
    await atomicWrite(join(root, MARKER), `${JSON.stringify(marker, null, 2)}\n`, 0o644);
    return { path: root, written, removed, foreign: foreign.length };
  }

  /** Takes back what Bogen wrote into a folder, and nothing else. Returns the files it left. */
  private async clearFolder(root: string): Promise<string[]> {
    const { ours, foreign } = await this.ownership(root).catch(() => ({ ours: new Map<string, string>(), foreign: [] as string[] }));
    for (const path of ours.keys()) await unlink(join(root, ...path.split('/'))).catch(() => {});
    await unlink(join(root, MARKER)).catch(() => {});
    await this.pruneDirs(root, [...ours.keys()]);
    return foreign;
  }

  /** Folders that held files of ours and are empty now. */
  private async pruneDirs(root: string, paths: string[]): Promise<void> {
    const dirs = [...new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')).filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const d of dirs) await rmdir(join(root, ...d.split('/'))).catch(() => {});
  }

  /** One file of a version over a static listener, with the headers a published page needs. */
  async serveFile(req: IncomingMessage, res: ServerResponse, versionId: string, gate: Pick<Gate, 'segments' | 'dir'>, options: { cache: string; html?: (text: string, path: string) => string; extraHeaders?: Record<string, string>; formCsp?: boolean } ): Promise<void> {
    const manifest = await this.manifest(versionId).catch(() => null);
    if (!manifest) return refuseText(res, 404, 'Not found.');
    const joined = gate.segments.join('/');
    const candidates = gate.dir || !joined ? [joined ? `${joined}/index.html` : 'index.html'] : [joined, `${joined}.html`];
    const path = candidates.find((p) => manifest.files[p]);
    if (!path) return refuseText(res, 404, 'Not found.');
    const entry = manifest.files[path]!;
    const root = join(this.versionDir(versionId), 'site');
    const full = join(root, ...path.split('/'));
    const st = await lstat(full).catch(() => null);
    if (!st?.isFile() || !inside(root, full)) return refuseText(res, 404, 'Not found.');
    let bytes: Uint8Array = await readFile(full);
    if (sha256(bytes) !== entry.sha256) return refuseText(res, 500, 'This file changed on disk.');
    const type = typeOf(path);
    const isHtml = type.startsWith('text/html');
    let csp: string;
    if (entry.csp) csp = entry.csp;
    else if (isHtml) {
      const frames = Object.keys(manifest.files).some((p) => p.startsWith('frames/'));
      csp = ["default-src 'none'", "style-src 'self'", "img-src 'self'", "font-src 'self'", "media-src 'self'", ...(frames ? ["frame-src 'self'"] : []), "base-uri 'none'", options.formCsp ? "form-action 'self'" : "form-action 'none'", "frame-ancestors 'none'"].join('; ');
    } else csp = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    if (isHtml && options.html) bytes = Buffer.from(options.html(Buffer.from(bytes).toString('utf8'), path), 'utf8');
    res.writeHead(200, baseHeaders({
      'Content-Type': type, 'Content-Length': String(bytes.length), 'Content-Security-Policy': csp, 'Cache-Control': options.cache,
      ...(isHtml && !entry.csp ? { 'X-Frame-Options': 'DENY' } : {}), ...(entry.csp ? { 'X-Frame-Options': 'SAMEORIGIN' } : {}), ...options.extraHeaders,
    }));
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  /** The site listener: the one site sent there, and nothing else. */
  async handleSite(req: IncomingMessage, res: ServerResponse, gate: Gate): Promise<void> {
    const live = this.listenerSite();
    if (!live) return refuseText(res, 404, 'Nothing is published here.');
    return this.serveFile(req, res, live.version, gate, { cache: 'no-cache' });
  }

  /** For the editor: what there is, without a byte of the files. */
  overview(fileId?: string): { sites: (PublishSite & { fileName?: string })[]; requests: PublishRequest[] } {
    const sites = this.state.sites.filter((s) => !fileId || s.fileId === fileId).map((s) => ({ ...s, fileName: this.deps.fileName(s.fileId) }));
    const ids = new Set(sites.map((s) => s.id));
    return { sites, requests: this.state.requests.filter((r) => ids.has(r.siteId)) };
  }
}
