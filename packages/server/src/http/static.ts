import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/** In a build the editor sits next to the bundle. In the repo it sits in `apps/editor/dist`. */
export function editorRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.BOGEN_EDITOR_DIR, join(here, 'editor'), join(here, '..', '..', '..', '..', 'apps', 'editor', 'dist'), join(here, '..', '..', '..', 'apps', 'editor', 'dist')];
  for (const dir of candidates) if (dir && existsSync(join(dir, 'index.html'))) return dir;
  return null;
}

const MISSING = '<!doctype html><meta charset="utf-8"><title>Bogen</title><body style="font:16px system-ui;margin:48px;max-width:560px"><h1 style="font-size:20px">The editor is not built</h1><p>The server is running, and MCP works. Run <code>npm run build</code> in the repository to build the canvas.</p>';

/** On the phone listener: which computer this app is, so that two of them on one Home Screen can be told apart. */
export interface PhoneShell { host: string }

const escapeAttr = (text: string) => text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The app shell as the phone listener serves it: marked as the phone's, and named after this computer. */
export function phoneShell(html: string, shell: PhoneShell): string {
  const name = escapeAttr(shell.host.slice(0, 60));
  return html
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/?>/, `<meta name="apple-mobile-web-app-title" content="Bogen ${name}" />`)
    .replace('<head>', `<head>\n    <meta name="bogen-listener" content="phone" />\n    <meta name="bogen-host" content="${name}" />`);
}

/** The manifest as the phone listener serves it, with this computer's name. */
export function phoneManifest(json: string, shell: PhoneShell): string {
  const manifest = JSON.parse(json) as Record<string, unknown>;
  const name = shell.host.slice(0, 60);
  return JSON.stringify({ ...manifest, name: `Bogen on ${name}`, short_name: `Bogen ${name}` });
}

export async function serveEditor(pathname: string, res: ServerResponse, phone?: PhoneShell): Promise<void> {
  const root = editorRoot();
  res.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!root) {
    if (extname(pathname)) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    else res.writeHead(200, { 'Content-Type': TYPES['.html']! }).end(MISSING);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const rootPrefix = resolve(root) + sep;
  const path = resolve(root, `.${decoded}`);
  const inside = path.startsWith(rootPrefix) && !decoded.includes('\0');
  const isFile = inside && existsSync(path) && statSync(path).isFile();
  // Client-side routes have no extension. Missing files with one are real 404s.
  const target = isFile ? path : !extname(decoded) ? join(root, 'index.html') : null;
  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const hashed = isFile && decoded.startsWith('/static/');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (phone && target.endsWith('index.html')) return void res.end(phoneShell(await readFile(target, 'utf8'), phone));
  if (phone && target.endsWith('manifest.webmanifest')) return void res.end(phoneManifest(await readFile(target, 'utf8'), phone));
  res.end(await readFile(target));
}
