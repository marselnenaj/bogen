import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * The tools a live site run has, and all it has: reading, searching and editing files in one folder. Everything here
 * is decided by this code and not by the CLI's own settings, so both CLIs have the same limits, and they can be tested.
 */

const READ_LIMIT = 256 * 1024;
const WRITE_LIMIT = 2 * 1024 * 1024;
const LIST_LIMIT = 1000;
const SEARCH_MATCHES = 200;
const SEARCH_FILE_LIMIT = 1024 * 1024;

/** Skipped when listing, and refused when named: they are not source, and some are secrets. */
const NEVER = /^(?:\.git|node_modules|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa.*|id_ed25519.*|.*\.pem|.*\.key|.*\.p12|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
/** Readable, but what runs code later: a dev server restarts itself on these, so writing one would be a shell by another name. */
const NOT_WRITABLE = /^(?:.*\.config\.[cm]?[jt]s|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.claude|\.codex|\.github|\.husky|\.vscode|\.mcp\.json|makefile|justfile|dockerfile|.*\.(?:sh|bash|zsh|ps1|bat|cmd|exe))$/i;
const SKIP_DIRS = /^(?:dist|build|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|coverage|target|vendor)$/;

export class FileRoot {
  private real: string | null = null;
  readonly written = new Set<string>();

  constructor(readonly root: string) {}

  private async realRoot(): Promise<string> {
    this.real ??= await realpath(this.root);
    return this.real;
  }

  /** The path, checked piece by piece and through symlinks. Whatever it says, the result is in the folder. */
  async inside(path: string, mode: 'read' | 'write'): Promise<string> {
    const root = await this.realRoot();
    if (typeof path !== 'string' || path.includes('\0')) throw new Error('That is not a path.');
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} is outside the project folder, and this run can only work inside it.`);
    for (const part of rel.split(sep).filter(Boolean)) {
      if (NEVER.test(part)) throw new Error(`${part} is off limits to this run.`);
      if (mode === 'write' && NOT_WRITABLE.test(part)) throw new Error(`${part} is not source. It can run code or change what runs, so a person has to edit it.`);
    }
    // The nearest part that exists decides where this really goes.
    let existing = full;
    for (;;) {
      try {
        const real = await realpath(existing);
        if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} leads outside the project folder through a link.`);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const parent = dirname(existing);
        if (parent === existing) throw e;
        // A link pointing nowhere has no real path either, and may still point outside.
        const link = await lstat(existing).catch(() => null);
        if (link?.isSymbolicLink()) throw new Error(`${path} is a link that points nowhere.`);
        existing = parent;
      }
    }
    return full;
  }

  relative(full: string): string {
    return relative(this.real ?? this.root, full) || '.';
  }

  async read(path: string, offset = 0, limit = READ_LIMIT): Promise<{ content: string; size: number; truncated: boolean }> {
    const full = await this.inside(path, 'read');
    const info = await stat(full);
    if (!info.isFile()) throw new Error(`${path} is not a file.`);
    const bytes = await readFile(full);
    const slice = bytes.subarray(offset, offset + Math.min(limit, READ_LIMIT));
    return { content: slice.toString('utf8'), size: bytes.length, truncated: offset + slice.length < bytes.length };
  }

  async list(path = '.'): Promise<string[]> {
    const full = await this.inside(path, 'read');
    const entries = await readdir(full, { withFileTypes: true });
    return entries.filter((e) => !NEVER.test(e.name)).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).sort().slice(0, LIST_LIMIT);
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (NEVER.test(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.test(entry.name)) yield* this.walk(full);
      } else if (entry.isFile()) yield full;
    }
  }

  async find(glob: string): Promise<string[]> {
    const root = await this.realRoot();
    // Only * and ** and ?, turned into a plain pattern with no way to take exponential time.
    const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:[^/]+/)*').replace(/\u0001/g, '[^\\n]*')}$`);
    const out: string[] = [];
    for await (const full of this.walk(root)) {
      const rel = relative(root, full);
      if (pattern.test(rel) || pattern.test(rel.split(sep).at(-1)!)) out.push(rel);
      if (out.length >= LIST_LIMIT) break;
    }
    return out;
  }

  /** A plain substring, on purpose. A regular expression from a model could hang this server. */
  async search(text: string, path = '.', ignoreCase = false): Promise<{ file: string; line: number; text: string }[]> {
    const root = await this.realRoot();
    const from = await this.inside(path, 'read');
    const needle = ignoreCase ? text.toLowerCase() : text;
    const out: { file: string; line: number; text: string }[] = [];
    for await (const full of this.walk(from)) {
      const info = await stat(full).catch(() => null);
      if (!info || info.size > SEARCH_FILE_LIMIT) continue;
      const body = await readFile(full, 'utf8').catch(() => '');
      if (body.includes('\0')) continue;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if ((ignoreCase ? line.toLowerCase() : line).includes(needle)) {
          out.push({ file: relative(root, full), line: i + 1, text: line.slice(0, 300) });
          if (out.length >= SEARCH_MATCHES) return out;
        }
      }
    }
    return out;
  }

  async write(path: string, content: string): Promise<void> {
    const full = await this.inside(path, 'write');
    if (Buffer.byteLength(content) > WRITE_LIMIT) throw new Error('That is more than this run may write to one file.');
    const existing = await lstat(full).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error(`${path} is a link. Edit what it points to.`);
    if (existing && !existing.isFile()) throw new Error(`${path} is not a file.`);
    await mkdir(dirname(full), { recursive: true });
    await this.inside(path, 'write');
    await atomicWrite(full, content, existing ? existing.mode & 0o777 : 0o644);
    this.written.add(this.relative(full));
  }

  async edit(path: string, oldText: string, newText: string, all = false): Promise<number> {
    const { content, truncated } = await this.read(path);
    if (truncated) throw new Error(`${path} is too large to edit here.`);
    if (!oldText) throw new Error('Say which text to replace.');
    const count = content.split(oldText).length - 1;
    if (!count) throw new Error(`That text is not in ${path}. Read the file again.`);
    if (count > 1 && !all) throw new Error(`That text occurs ${count} times in ${path}. Give more of it around, or pass all.`);
    await this.write(path, all ? content.split(oldText).join(newText) : content.replace(oldText, () => newText));
    return count;
  }
}

/** Registers the tools on a server of their own. */
export function registerLiveFileTools(server: McpServer, files: FileRoot, onChange?: () => void, onCall?: (call: { tool: string; args: unknown; startedAt: number; result: string; error: boolean }) => void): void {
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly = true) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } }, (async (args: z.infer<z.ZodObject<S>>) => {
      const startedAt = Date.now();
      let text = '';
      let error = false;
      try {
        const out = await run(args);
        text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
        return { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        text = errorMessage(e);
        error = true;
        return { isError: true, content: [{ type: 'text' as const, text }] };
      } finally {
        onCall?.({ tool: name, args, startedAt, result: text, error });
      }
    }) as never);
  };
  tool('read_file', 'Read a text file in the project folder. Paths are relative to the folder.', {
    path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).optional(),
  }, ({ path, offset, limit }) => files.read(path, offset, limit));
  tool('list_dir', 'List a folder in the project.', { path: z.string().default('.') }, ({ path }) => files.list(path));
  tool('find_files', 'Find files by name, such as "**/*.tsx" or "Button*". Skips build output and dependencies.', { pattern: z.string().max(200) }, ({ pattern }) => files.find(pattern));
  tool('search', 'Find text in the project. It is a plain substring, not a regular expression.', {
    text: z.string().min(1).max(500), path: z.string().default('.'), ignore_case: z.boolean().default(false),
  }, ({ text, path, ignore_case }) => files.search(text, path, ignore_case));
  tool('edit_file', 'Replace exact text in a source file. The dev server picks the change up by itself.', {
    path: z.string(), old_text: z.string(), new_text: z.string(), all: z.boolean().default(false),
  }, async ({ path, old_text, new_text, all }) => {
    const replaced = await files.edit(path, old_text, new_text, all);
    onChange?.();
    return { path, replaced };
  }, false);
  tool('write_file', 'Create a source file, or replace a whole one. Prefer edit_file for changes.', {
    path: z.string(), content: z.string(),
  }, async ({ path, content }) => {
    await files.write(path, content);
    onChange?.();
    return { path, written: Buffer.byteLength(content) };
  }, false);
}
