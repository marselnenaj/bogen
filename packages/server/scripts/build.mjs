#!/usr/bin/env node
// Bundles the CLI and the shader runtime into dist/, and copies the built editor next to them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Tests and deployments may build elsewhere, and leave the repository's own dist alone.
const dist = process.env.BOGEN_DIST_DIR || join(root, 'dist');
const editor = join(root, '..', '..', 'apps', 'editor', 'dist');

/** Tells two builds of one version apart: the commit, and a hash of what was not committed yet. */
function buildId() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const dirty = git('status', '--porcelain', '--', '.', '../core', '../../apps/editor', '../../integrations');
    if (!dirty) return git('rev-parse', '--short', 'HEAD');
    const diff = git('diff', 'HEAD', '--', '.', '../core', '../../apps/editor', '../../integrations');
    return `${git('rev-parse', '--short', 'HEAD')}.${createHash('sha256').update(dirty + diff).digest('hex').slice(0, 6)}`;
  } catch {
    return `d${Date.now().toString(36)}`;
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(dist, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // puppeteer-core reaches for many optional modules at runtime, so it stays an npm dependency.
  // esbuild has a native binary: it bundles code components at runtime, and the shader runtime in development.
  // Mermaid and pdf.js are files of their own in dist/vendor/, loaded on first use (src/vendor-files.ts): bundled,
  // pdf.js alone would be most of cli.js and its start time.
  external: ['puppeteer-core', 'esbuild', 'mermaid', 'mermaid/*', 'pdfjs-dist', 'pdfjs-dist/*'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __bogenRequire } from 'node:module';",
      'const require = __bogenRequire(import.meta.url);',
      // A dependency probes for localStorage, and Node warns on any such access. Noise on a CLI's stderr.
      "const __bogenWarn = process.emitWarning; process.emitWarning = (w, ...a) => (String(w).includes('localStorage') ? undefined : __bogenWarn.call(process, w, ...a));",
    ].join('\n'),
  },
  logLevel: 'warning',
  minifySyntax: true,
  legalComments: 'none',
  define: { __BOGEN_BUILD__: JSON.stringify(buildId()) },
});
chmodSync(join(dist, 'cli.js'), 0o755);

await build({
  entryPoints: [join(root, 'src/shader-runtime.ts')],
  outfile: join(dist, 'shader-runtime.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome110',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});

// Vectorizing runs in a worker thread, which loads a file of its own.
await build({
  entryPoints: [join(root, 'src/vectorize-worker.ts')],
  outfile: join(dist, 'vectorize-worker.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  minifySyntax: true,
  legalComments: 'none',
});

// script_run's sandbox: a worker thread with QuickJS, whose WebAssembly ships as a file of its own (src/script-sandbox.ts).
await build({
  entryPoints: [join(root, 'src/script-worker.ts')],
  outfile: join(dist, 'script-worker.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __bogenRequire } from 'node:module';\nconst require = __bogenRequire(import.meta.url);" },
  logLevel: 'warning',
  minifySyntax: true,
  legalComments: 'none',
});
const quickjsWasm = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-asyncify/wasm');
mkdirSync(join(dist, 'quickjs'), { recursive: true });
cpSync(quickjsWasm, join(dist, 'quickjs', 'quickjs-asyncify.wasm'));

// The Bogen collection's art (src/omarchy-collection.ts) sits next to the bundle, so a packaged CLI finds it offline.
const collection = join(root, 'assets', 'omarchy-collection');
if (existsSync(collection)) cpSync(collection, join(dist, 'omarchy-collection'), { recursive: true });

// The icon sets beyond Lucide are data, read on first use (src/icon-set-files.ts), so they stay out of cli.js.
const iconSets = join(root, '..', 'core', 'src', 'icon-sets');
if (!existsSync(join(iconSets, 'tabler.json'))) throw new Error(`No icon sets in ${iconSets}. Run scripts/gen-icon-sets.ts.`);
cpSync(iconSets, join(dist, 'icon-sets'), { recursive: true });

// Mermaid's browser bundle (diagram_insert, in a render page) and pdf.js (pdf_import, in Node and in a render page) go
// next to cli.js in dist/vendor/, where src/vendor-files.ts looks for them. pdf.js is its legacy build, which runs in
// Node and in the browser alike, so that both read a PDF to the same operator list.
const require = createRequire(import.meta.url);
const vendor = join(dist, 'vendor');
mkdirSync(vendor, { recursive: true });
for (const [module, file] of [
  ['mermaid/dist/mermaid.min.js', 'mermaid.min.js'],
  ['pdfjs-dist/legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
]) cpSync(require.resolve(module), join(vendor, file));

if (existsSync(join(editor, 'index.html'))) {
  cpSync(editor, join(dist, 'editor'), { recursive: true });
  console.log('Bundled dist/cli.js, dist/shader-runtime.js and the editor.');
} else {
  console.log('Bundled dist/cli.js and dist/shader-runtime.js. The editor is not built, so it was left out.');
}
