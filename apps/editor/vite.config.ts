import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { precacheFiles } from './src/pwa/sw-rules.ts';

const target = process.env.BOGEN_API ?? 'http://127.0.0.1:29990';
const proxied = { target, changeOrigin: false };

function filesIn(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name), root) : [`/${relative(root, join(dir, entry.name))}`]));
}

/**
 * Builds src/pwa/sw.ts into /sw.js, with this build's id and the files the phone keeps for offline use. The id
 * comes from what was built, so the worker's bytes change exactly when the build does, and the browser updates it.
 */
function pwaPlugin(): Plugin {
  const publicDir = resolve(import.meta.dirname, 'public');
  return {
    name: 'bogen-pwa',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: resolve(import.meta.dirname, 'src/pwa/sw.ts'), fileName: 'sw.js' });
    },
    generateBundle(_options, bundle) {
      const sw = bundle['sw.js'];
      if (!sw || sw.type !== 'chunk') return this.error('sw.js was not built.');
      if (sw.imports.length || /^\s*(import|export)\b/m.test(sw.code)) return this.error('sw.js must stand alone: keep what it imports out of the app.');
      // A language's catalog is cached when the phone first uses it (sw-rules.ts), not with every build.
      const built = Object.keys(bundle).filter((name) => name !== 'sw.js' && !name.endsWith('.map')).sort();
      const precached = precacheFiles(built);
      const hash = createHash('sha256');
      for (const name of built) {
        const item = bundle[name]!;
        hash.update(name).update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      const files = [...new Set(['/index.html', ...precached.map((name) => `/${name}`), ...filesIn(publicDir)])];
      sw.code = `const __BOGEN_BUILD__ = ${JSON.stringify({ id: hash.digest('hex').slice(0, 16), files })};\n${sw.code}`;
    },
  };
}

export default defineConfig({
  plugins: [react(), pwaPlugin()],
  resolve: { dedupe: ['yjs', 'react', 'react-dom', 'y-protocols', 'lib0'] },
  server: {
    port: 5173,
    proxy: {
      '/api': proxied,
      '/assets': proxied,
      '/mcp': proxied,
      '/sync': { ...proxied, ws: true },
      '/events': { ...proxied, ws: true },
    },
  },
  // Not `assets`: on the server that path belongs to uploaded design assets.
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    assetsDir: 'static',
    rollupOptions: {
      output: {
        // Each language's catalog is a chunk of its own with a recognisable name, for the service worker.
        chunkFileNames: (chunk) => (chunk.facadeModuleId && /\/src\/i18n\/locales\/[\w-]+\.json$/.test(chunk.facadeModuleId) ? 'static/locale-[name]-[hash].js' : 'static/[name]-[hash].js'),
      },
    },
  },
});
