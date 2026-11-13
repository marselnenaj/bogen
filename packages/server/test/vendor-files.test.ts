import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VENDOR_FILES, vendorPath } from '../src/vendor-files.ts';

describe('vendored files', () => {
  it('finds pdf.js and Mermaid in BOGEN_VENDOR_DIR first, then in node_modules when running from source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-vendor-'));
    try {
      writeFileSync(join(dir, 'pdf.min.mjs'), '');
      expect(vendorPath('pdf', { BOGEN_VENDOR_DIR: dir })).toBe(join(dir, 'pdf.min.mjs'));
      expect(vendorPath('mermaid', { BOGEN_VENDOR_DIR: dir })).toMatch(/node_modules\/mermaid\/dist\/mermaid\.min\.js$/);
      for (const name of Object.keys(VENDOR_FILES) as (keyof typeof VENDOR_FILES)[]) expect(vendorPath(name, {})).toContain('node_modules');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the missing file, where it looked and what needs it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bogen-vendor-'));
    mkdirSync(join(dir, 'vendor'));
    // A copy of the module outside the source tree stands for an installed package, which has no node_modules of these.
    const copy = join(dir, 'vendor-files.mjs');
    const { build } = await import('esbuild');
    await build({ entryPoints: [join(import.meta.dirname, '../src/vendor-files.ts')], outfile: copy, format: 'esm', platform: 'node', logLevel: 'silent' });
    try {
      const mod = (await import(copy)) as typeof import('../src/vendor-files.ts');
      expect(() => mod.vendorPath('pdfWorker', {})).toThrow(/The file pdf\.worker\.min\.mjs, which PDF import \(pdf_import and a PDF dropped on the canvas\) needs, is missing: it is not in .*vendor.*install it again, or set BOGEN_VENDOR_DIR/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
