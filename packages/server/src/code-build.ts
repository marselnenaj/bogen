import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { CodeProject, CodeProjects } from './code-projects.ts';
import { readablePath } from './code-projects.ts';
import { errorMessage } from './util.ts';

/**
 * Builds a module of a linked project for a sandboxed frame: esbuild bundles it with the project's React,
 * Bogen's own Tailwind compiles the project's CSS, and the result is one HTML page with everything inline.
 *
 * The project's code never runs here. esbuild and Tailwind only read files; Tailwind plugins and JS configs,
 * which would have to run, are skipped with a warning, and so is the project's own Vite config. The page is
 * served with a CSP that sandboxes it to an opaque origin, allows only its own inline script, and no network.
 */

/** Changes when what a build makes changes, so that cached builds of an older Bogen are not used. */
const BUILD_VERSION = 'code-build-1';
const MAX_OUTPUT = 24 * 1024 * 1024;
const MEMORY_ENTRIES = 24;
const CSS_SOURCE = /\.(tsx|jsx|ts|js|mjs|mdx|html|vue|svelte|astro)$/;
const TAILWIND_CSS = /@import\s+(['"])tailwindcss(\/[\w.-]+)?\1|@tailwind\b|@theme\b|@apply\b|@utility\b|@custom-variant\b|@plugin\b|@source\b|@config\b/;
const LOADERS = { '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.gif': 'dataurl', '.webp': 'dataurl', '.avif': 'dataurl', '.svg': 'dataurl', '.ico': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl', '.mp4': 'dataurl', '.webm': 'dataurl', '.json': 'json', '.txt': 'text', '.md': 'text' } as const;

export interface CodeBuild { key: string; js: string; css: string; warnings: string[]; error?: string }
export interface FrameResponse { status: number; headers: Record<string, string>; body: string }

/** Runs in the frame. `react` and `react-dom` resolve to the project's own copies. */
const RUNTIME = `
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

class Guard extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? notice(String((this.state.error && this.state.error.message) || this.state.error)) : this.props.children; }
}

function notice(text) {
  return React.createElement('pre', { style: { margin: 0, padding: 8, font: '12px/1.4 ui-monospace, monospace', color: '#b42318', background: '#fff5f5', whiteSpace: 'pre-wrap' } }, text);
}

export function mount(mod) {
  const query = new URLSearchParams(location.search);
  const name = query.get('name') || 'default';
  const Component = Object.prototype.hasOwnProperty.call(mod, name) ? mod[name] : undefined;
  const host = document.getElementById('bogen-root');
  if (query.has('measure')) host.style.width = 'max-content';
  const root = createRoot(host);
  const props = () => {
    try {
      const value = JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  let sent = 0;
  const ready = () => {
    const turn = ++sent;
    const send = () => {
      if (turn !== sent) return;
      const box = host.getBoundingClientRect();
      parent.postMessage({ bogenCode: 'ready', width: Math.ceil(box.width), height: Math.ceil(box.height) }, '*');
    };
    Promise.resolve(document.fonts && document.fonts.ready).then(() => requestAnimationFrame(() => requestAnimationFrame(send)));
  };
  const render = () => {
    const usable = typeof Component === 'function' || (Component && typeof Component === 'object' && Component.$$typeof);
    const element = usable ? React.createElement(Component, props()) : notice('No component "' + name + '" is exported here.');
    flushSync(() => root.render(React.createElement(Guard, { key: location.hash }, element)));
    ready();
  };
  render();
  addEventListener('hashchange', render);
}
`;

function tailwindDir(): string {
  return dirname(createRequire(import.meta.url).resolve('tailwindcss/package.json'));
}

/** Words of a source file that could be Tailwind classes. Tailwind drops what is not one. */
export function candidates(text: string, into: Set<string>): void {
  for (const token of text.split(/[\s"'`]+/)) {
    if (!token || token.length > 120) continue;
    into.add(token);
    for (const part of token.split(/[{}();,=]+/)) if (part && part !== token) into.add(part);
  }
}

function escapeScript(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function escapeStyle(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('base64');
}

function csp(scriptHash: string): string {
  return [
    "default-src 'none'", `script-src 'sha256-${scriptHash}'`, "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:', 'media-src data: blob:',
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts',
  ].join('; ');
}

const READY_SCRIPT = "parent.postMessage({bogenCode:'ready',width:document.body.scrollWidth,height:document.body.scrollHeight},'*')";

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A frame that says why there is no component, still sized and still reporting that it is ready. */
export function noticeFrame(title: string, detail: string): FrameResponse {
  const body = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{box-sizing:border-box;padding:8px;font:12px/1.4 system-ui,sans-serif;color:#555;background:repeating-linear-gradient(135deg,#f6f6f6 0 8px,#efefef 8px 16px);border:1px dashed #bbb;overflow:hidden}b{display:block;color:#222;margin-bottom:2px}pre{margin:4px 0 0;white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace;color:#b42318}</style></head><body><b>${escapeHtml(title)}</b>${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}<script>${READY_SCRIPT}</script></body></html>`;
  return { status: 200, headers: frameHeaders(sha256(READY_SCRIPT)), body };
}

function frameHeaders(scriptHash: string): Record<string, string> {
  return { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp(scriptHash), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
}

export class CodeBuilder {
  private memory = new Map<string, CodeBuild>();
  private running = new Map<string, Promise<CodeBuild>>();

  constructor(private readonly projects: CodeProjects, private readonly cacheDir: string) {}

  /** The page of one component. `etag` is what the caller has, which may save sending it again. */
  async frame(projectId: string, file: string, name: string, options: { etag?: string } = {}): Promise<FrameResponse> {
    const project = this.projects.get(projectId);
    const label = `${name === 'default' ? file.split('/').at(-1) : name}`;
    if (!project) return noticeFrame(label, 'Its project is not linked on this device. Link the folder with code_project_link, or in the Assets panel.');
    let build: CodeBuild;
    try {
      this.projects.modulePath(project, file);
      build = await this.build(project, file);
    } catch (e) {
      return noticeFrame(label, errorMessage(e));
    }
    if (build.error) return noticeFrame(`${label} did not build`, build.error);
    const etag = `"${build.key}"`;
    if (options.etag === etag) return { status: 304, headers: { ETag: etag }, body: '' };
    const script = escapeScript(build.js);
    const body = `<!doctype html><html><head><meta charset="utf-8"><style>${escapeStyle(build.css)}</style><style>html,body{margin:0!important;padding:0!important;background:transparent!important;min-height:0!important}#bogen-root{display:flow-root}</style></head><body><div id="bogen-root"></div><script>${script}</script></body></html>`;
    return { status: 200, headers: { ...frameHeaders(sha256(script)), ETag: etag }, body };
  }

  /** A build of one module, from memory, from disk, or made now. Keyed by the content of every source file. */
  async build(project: CodeProject, file: string): Promise<CodeBuild> {
    const key = await this.projects.contentKey(project, `${BUILD_VERSION}\0${file}\0`);
    const known = this.memory.get(key);
    if (known) return known;
    let pending = this.running.get(key);
    if (!pending) {
      pending = this.load(key).then((cached) => cached ?? this.make(project, file, key)).finally(() => this.running.delete(key));
      this.running.set(key, pending);
    }
    const build = await pending;
    this.memory.delete(key);
    this.memory.set(key, build);
    while (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
    return build;
  }

  private async load(key: string): Promise<CodeBuild | null> {
    try {
      const data = JSON.parse(await readFile(join(this.cacheDir, `${key}.json`), 'utf8')) as CodeBuild;
      return data.key === key ? data : null;
    } catch {
      return null;
    }
  }

  private async make(project: CodeProject, file: string, key: string): Promise<CodeBuild> {
    let build: CodeBuild;
    try {
      build = { key, ...(await bundle(this.projects, project, file)) };
    } catch (e) {
      build = { key, js: '', css: '', warnings: [], error: errorMessage(e).slice(0, 4000) };
    }
    // A failed build is not kept on disk: it may be the machine, not the code.
    if (!build.error) {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(join(this.cacheDir, `${key}.json`), JSON.stringify(build), { mode: 0o600 }).catch(() => {});
    }
    return build;
  }
}

/** CSS files the app's entry imports: the global styles a component expects around it. */
export function globalStyles(dir: string): string[] {
  const entries: string[] = [];
  const html = join(dir, 'index.html');
  if (existsSync(html)) {
    for (const m of readFileSync(html, 'utf8').matchAll(/<script[^>]*type=["']module["'][^>]*src=["']\/?([^"']+)["']/g)) entries.push(join(dir, m[1]!));
  }
  for (const guess of ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx', 'app/layout.tsx', 'src/app/layout.tsx']) entries.push(join(dir, guess));
  const out: string[] = [];
  for (const entry of entries) {
    if (!existsSync(entry) || !readablePath(entry, [dir])) continue;
    for (const m of readFileSync(entry, 'utf8').matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm)) {
      const spec = m[1]!;
      const path = spec.startsWith('.') ? resolve(dirname(entry), spec) : spec.startsWith('@/') ? join(dir, 'src', spec.slice(2)) : null;
      if (path && existsSync(path) && !out.includes(path)) out.push(path);
    }
    if (out.length) return out;
  }
  for (const guess of ['src/index.css', 'src/globals.css', 'src/styles/globals.css', 'src/app/globals.css', 'app/globals.css', 'src/styles.css', 'src/App.css']) {
    if (existsSync(join(dir, guess))) return [join(dir, guess)];
  }
  return out;
}

async function bundle(projects: CodeProjects, project: CodeProject, file: string): Promise<Omit<CodeBuild, 'key'>> {
  const esbuild = await import('esbuild');
  const root = project.dir;
  const bounds = projects.bounds(project);
  const aliases = projects.aliases(project);
  const warnings: string[] = [];
  const entry = projects.modulePath(project, file);
  const styles = globalStyles(root);
  let words: Set<string> | null = null;
  const sourceWords = async () => {
    if (words) return words;
    words = new Set<string>();
    for (const f of await projects.files(project)) {
      if (CSS_SOURCE.test(f.rel) && f.size < 1_000_000) candidates(await readFile(f.abs, 'utf8').catch(() => ''), words);
    }
    return words;
  };

  const contents = [
    ...styles.map((s) => `import ${JSON.stringify(s)};`),
    `import * as mod from ${JSON.stringify(entry)};`,
    "import { mount } from 'bogen:runtime';",
    'mount(mod);',
  ].join('\n');

  const result = await esbuild.build({
    stdin: { contents, resolveDir: root, sourcefile: 'bogen-entry.js', loader: 'js' },
    absWorkingDir: root,
    outfile: join(root, 'bogen-frame.js'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome115', 'firefox115', 'safari16'],
    minify: true,
    jsx: 'automatic',
    legalComments: 'none',
    logLevel: 'silent',
    loader: { ...LOADERS },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({ MODE: 'production', DEV: false, PROD: true, SSR: false, BASE_URL: '/' }),
    },
    banner: { js: 'var process=globalThis.process||{env:{NODE_ENV:"production"}};var global=globalThis;' },
    plugins: [{
      name: 'bogen-code',
      setup(build) {
        build.onResolve({ filter: /^bogen:runtime$/ }, () => ({ path: 'runtime', namespace: 'bogen' }));
        build.onLoad({ filter: /.*/, namespace: 'bogen' }, () => ({ contents: RUNTIME, resolveDir: root, loader: 'js' }));
        // Aliases from tsconfig, which esbuild does not follow through references.
        build.onResolve({ filter: /.*/ }, async (args) => {
          if (args.pluginData?.bogen) return undefined;
          let path = args.path;
          const alias = aliases.find((a) => path.startsWith(a.prefix));
          if (alias) path = join(alias.target, path.slice(alias.prefix.length));
          else if (path.startsWith('@/') && existsSync(join(root, 'src'))) path = join(root, 'src', path.slice(2));
          const found = await build.resolve(path, { kind: args.kind, resolveDir: args.resolveDir || root, importer: args.importer, pluginData: { bogen: true } });
          if (found.errors.length) return { errors: found.errors };
          if (found.external || found.namespace !== 'file') return found;
          // The project, its workspace and installed packages, and nothing else on the disk.
          if (!readablePath(found.path, bounds)) return { errors: [{ text: `${args.path} leads outside the project, so it was not read.` }] };
          return found;
        });
        build.onLoad({ filter: /\.css$/ }, async (args) => {
          const text = await readFile(args.path, 'utf8');
          if (!TAILWIND_CSS.test(text)) return undefined;
          const css = await tailwind(text, args.path, bounds, await sourceWords(), warnings);
          return { contents: css, loader: 'css', resolveDir: dirname(args.path) };
        });
      },
    }],
  });
  for (const w of result.warnings.slice(0, 5)) warnings.push(w.text);
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  if (js.length + css.length > MAX_OUTPUT) throw new Error(`The build of ${file} is larger than ${MAX_OUTPUT / 1024 / 1024} MB.`);
  return { js, css, warnings };
}

/** Compiles Tailwind 4 CSS with Bogen's own Tailwind. Plugins and JS configs would run project code, so they are left out. */
async function tailwind(css: string, path: string, bounds: string[], words: Set<string>, warnings: string[]): Promise<string> {
  const { compile } = await import('tailwindcss');
  const own = tailwindDir();
  const compiler = await compile(css, {
    base: dirname(path),
    from: path,
    loadStylesheet: async (id: string, base: string) => {
      let file: string | null = null;
      const tw = /^tailwindcss(?:\/(index|preflight|theme|utilities)(?:\.css)?)?$/.exec(id);
      if (tw) file = join(own, `${tw[1] ?? 'index'}.css`);
      else if (id.startsWith('.') || isAbsolute(id)) file = resolve(base, id);
      else file = packageStyle(id, base);
      if (!file || !existsSync(file)) throw new Error(`The style sheet ${id} was not found.`);
      if (!tw && !readablePath(file, bounds)) throw new Error(`The style sheet ${id} is outside the project.`);
      return { path: file, base: dirname(file), content: await readFile(file, 'utf8') };
    },
    loadModule: async (id: string, base: string, kind: 'plugin' | 'config') => {
      warnings.push(`Tailwind ${kind} ${id} was left out: Bogen does not run the project's code outside the sandbox.`);
      return { path: id, base, module: kind === 'plugin' ? { handler: () => {} } : {} } as never;
    },
  } as never);
  return compiler.build([...words]);
}

/** The CSS of a package such as `tw-animate-css`, found in a node_modules above `base`. */
function packageStyle(id: string, base: string): string | null {
  const parts = id.split('/');
  const name = id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  const sub = parts.slice(id.startsWith('@') ? 2 : 1).join('/');
  for (let dir = base; ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', name);
    if (existsSync(join(pkgDir, 'package.json'))) {
      if (sub) return join(pkgDir, extname(sub) ? sub : `${sub}.css`);
      try {
        const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { style?: unknown; exports?: Record<string, unknown> };
        const dot = pkg.exports?.['.'];
        const style = typeof pkg.style === 'string' ? pkg.style : dot && typeof dot === 'object' && typeof (dot as Record<string, unknown>).style === 'string' ? (dot as Record<string, string>).style : typeof dot === 'string' && dot.endsWith('.css') ? dot : 'index.css';
        return join(pkgDir, style!);
      } catch {
        return join(pkgDir, 'index.css');
      }
    }
    if (dir === dirname(dir)) return null;
  }
}
