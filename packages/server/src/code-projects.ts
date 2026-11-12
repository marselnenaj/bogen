import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isProjectPath } from '@bogen/core';
import { checkFolder } from './live-site.ts';
import { scanModule, type CodePropInfo } from './code-scan.ts';
import { atomicWrite, HttpError } from './util.ts';

/**
 * Projects linked on this device for code components: a folder of a person's own repository, by id. The id is
 * a hash of the folder, so the same checkout at the same path has the same id on every device. A document
 * names a project only by id; which folder that is stays here, in `code-projects.json`.
 */

export interface CodeProject { id: string; dir: string; name: string; linkedAt: number }
export interface SourceFile { rel: string; abs: string; size: number; mtimeMs: number }
export interface CodeComponentInfo { file: string; name: string; display: string; import: string; props: CodePropInfo[] }
export interface PathAlias { prefix: string; target: string }

/** Folders that hold what is built, fetched or private, never source. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'storybook-static', 'vendor', 'tmp', 'temp']);
const MAX_FILES = 6000;
const MAX_DEPTH = 14;
const COMPONENT_FILE = /\.(tsx|jsx)$/;
const NOT_COMPONENTS = /(\.(test|spec|stories|story|d)\.[jt]sx?$)|(^|\/)(__tests__|__mocks__|test|tests|e2e)\//;
const WALK_TTL_MS = 1500;

export function projectId(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 16);
}

/** JSON with comments and trailing commas, as tsconfig files are. */
export function looseJson(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Whether a path is one a build of this project may read: inside it, inside its workspace, or inside a node_modules above it. */
export function readablePath(path: string, bounds: string[]): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  if (bounds.some((b) => real === b || real.startsWith(b + sep))) return true;
  const at = real.indexOf(`${sep}node_modules${sep}`);
  if (at < 0) return false;
  const owner = real.slice(0, at) || sep;
  return bounds.some((b) => b === owner || b.startsWith(owner + sep));
}

export class CodeProjects {
  private projects: CodeProject[] = [];
  private walks = new Map<string, { at: number; files: Promise<SourceFile[]> }>();
  private scans = new Map<string, { key: string; components: Promise<CodeComponentInfo[]> }>();
  private hashes = new Map<string, { stamp: string; hash: string }>();

  constructor(private readonly home: string) {}

  private get path(): string {
    return join(this.home, 'code-projects.json');
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as { projects?: CodeProject[] };
      this.projects = (data.projects ?? []).filter((p) => typeof p.id === 'string' && typeof p.dir === 'string' && p.id === projectId(p.dir));
    } catch {
      this.projects = [];
    }
  }

  list(): CodeProject[] {
    return this.projects.map((p) => ({ ...p }));
  }

  get(id: string): CodeProject | undefined {
    return this.projects.find((p) => p.id === id);
  }

  require(id: string): CodeProject {
    const p = this.get(id);
    if (!p) throw new HttpError(404, `No project ${id} is linked on this device. Link its folder with code_project_link.`);
    return p;
  }

  /** Links a folder, or returns the link it already has. Only ever from this machine: the caller checks. */
  async link(rawDir: string): Promise<CodeProject> {
    const dir = checkFolder(rawDir);
    if (!existsSync(join(dir, 'package.json'))) throw new HttpError(400, `${dir} has no package.json. Link the folder of a JavaScript project.`);
    const id = projectId(dir);
    const known = this.get(id);
    if (known) return { ...known };
    let name = basename(dir);
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof pkg.name === 'string' && pkg.name) name = pkg.name.slice(0, 120);
    } catch {
      // The folder name will do.
    }
    const project = { id, dir, name, linkedAt: Date.now() };
    this.projects.push(project);
    await this.save();
    return { ...project };
  }

  async unlink(id: string): Promise<boolean> {
    const before = this.projects.length;
    this.projects = this.projects.filter((p) => p.id !== id);
    if (this.projects.length === before) return false;
    this.walks.delete(id);
    this.scans.delete(id);
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.path, JSON.stringify({ projects: this.projects }, null, 1), 0o600);
  }

  /** What a build may read: the project, and the workspace it belongs to if any. */
  bounds(project: CodeProject): string[] {
    const out = [project.dir];
    let dir = dirname(project.dir);
    for (let i = 0; i < 4 && dir !== dirname(dir); i++, dir = dirname(dir)) {
      try {
        const pkg = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown } : null;
        if (pkg?.workspaces || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
          out.push(dir);
          break;
        }
      } catch {
        // Not a workspace root.
      }
    }
    return out;
  }

  /** The project's own files, not what is built or installed. Hidden folders are skipped too. */
  files(project: CodeProject): Promise<SourceFile[]> {
    const cached = this.walks.get(project.id);
    if (cached && Date.now() - cached.at < WALK_TTL_MS) return cached.files;
    const files = walk(project.dir);
    this.walks.set(project.id, { at: Date.now(), files });
    files.catch(() => this.walks.delete(project.id));
    return files;
  }

  /** A content hash of one file, read again only when its size or time changed. */
  async hashOf(file: SourceFile): Promise<string> {
    const stamp = `${file.size}:${file.mtimeMs}`;
    const known = this.hashes.get(file.abs);
    if (known?.stamp === stamp) return known.hash;
    // Large files are media, not source: their size and time stand in for their content.
    if (file.size > 4 * 1024 * 1024) return `large:${stamp}`;
    const hash = createHash('sha256').update(await readFile(file.abs)).digest('hex');
    if (this.hashes.size > 50_000) this.hashes.clear();
    this.hashes.set(file.abs, { stamp, hash });
    return hash;
  }

  /** One hash over every source file's path and content. */
  async contentKey(project: CodeProject, extra: string): Promise<string> {
    const files = await this.files(project);
    const h = createHash('sha256').update(extra);
    for (const f of files) h.update(`${f.rel}\0${await this.hashOf(f)}\0`);
    return h.digest('hex').slice(0, 32);
  }

  /** Path aliases from tsconfig files, such as `@/` for `src/`. */
  aliases(project: CodeProject): PathAlias[] {
    const out: PathAlias[] = [];
    const seen = new Set<string>();
    const read = (path: string, depth: number) => {
      if (depth > 4 || seen.has(path) || !existsSync(path) || !readablePath(path, [project.dir])) return;
      seen.add(path);
      let config: { extends?: unknown; references?: { path?: unknown }[]; compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } };
      try {
        config = looseJson(readFileSync(path, 'utf8')) as typeof config;
      } catch {
        return;
      }
      const here = dirname(path);
      if (typeof config.extends === 'string' && config.extends.startsWith('.')) read(resolve(here, config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`), depth + 1);
      const base = resolve(here, typeof config.compilerOptions?.baseUrl === 'string' ? config.compilerOptions.baseUrl : '.');
      for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
        const target = Array.isArray(targets) ? targets[0] : undefined;
        if (typeof target !== 'string' || !pattern.endsWith('/*') || !target.endsWith('/*')) continue;
        const prefix = pattern.slice(0, -1);
        const dir = resolve(base, target.slice(0, -2));
        if (!out.some((a) => a.prefix === prefix) && readablePath(dir, [project.dir])) out.push({ prefix, target: dir });
      }
      for (const ref of config.references ?? []) {
        if (typeof ref?.path !== 'string') continue;
        const p = resolve(here, ref.path);
        read(p.endsWith('.json') ? p : join(p, 'tsconfig.json'), depth + 1);
      }
    };
    for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) read(join(project.dir, name), 0);
    return out;
  }

  /** How code imports a module of the project: through an alias if one covers it. */
  importPath(project: CodeProject, file: string): string {
    const abs = join(project.dir, file);
    const bare = (p: string) => p.replace(/\.(tsx|ts|jsx|js|mjs)$/, '').replace(/\/index$/, '');
    for (const alias of this.aliases(project)) {
      if (abs.startsWith(alias.target + sep)) return bare(alias.prefix + relative(alias.target, abs).split(sep).join('/'));
    }
    return `./${bare(file)}`;
  }

  /** Components found in the project, with their props as far as the source says. */
  async components(project: CodeProject): Promise<CodeComponentInfo[]> {
    const files = (await this.files(project)).filter((f) => COMPONENT_FILE.test(f.rel) && !NOT_COMPONENTS.test(f.rel) && f.size < 400_000);
    const key = files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join('|');
    const cached = this.scans.get(project.id);
    if (cached?.key === key) return cached.components;
    const components = (async () => {
      const out: CodeComponentInfo[] = [];
      for (const f of files) {
        const src = await readFile(f.abs, 'utf8').catch(() => '');
        for (const c of scanModule(src)) out.push({ file: f.rel, name: c.name, display: c.display, import: this.importPath(project, f.rel), props: c.props });
      }
      return out;
    })();
    this.scans.set(project.id, { key, components });
    return components;
  }

  /** The absolute path of a module in the project, checked to stay inside it. */
  modulePath(project: CodeProject, file: string): string {
    if (!isProjectPath(file)) throw new HttpError(400, `"${file}" is not a path inside the project.`);
    // A module, not a data file or anything hidden, whatever a document asks for.
    if (!/\.(tsx|jsx|ts|js|mjs)$/.test(file) || file.split('/').some((part) => part.startsWith('.'))) throw new HttpError(400, `${file} is not a JavaScript or TypeScript module.`);
    const abs = join(project.dir, file);
    if (!existsSync(abs)) throw new HttpError(404, `${file} is not in ${project.name}.`);
    if (!readablePath(abs, [project.dir])) throw new HttpError(400, `${file} leads outside the project.`);
    return abs;
  }
}

async function walk(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) await visit(abs, depth + 1);
      } else if (e.isFile()) {
        const s = await stat(abs).catch(() => null);
        if (s) out.push({ rel: relative(root, abs).split(sep).join('/'), abs, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  };
  await visit(root, 0);
  return out;
}
