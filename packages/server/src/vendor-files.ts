import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Libraries that stay out of cli.js, as files of their own: Mermaid's browser bundle, which diagram_insert loads into
 * a render page, and pdf.js, which pdf_import runs in Node and again in a render page for its pictures (the same
 * legacy build in both, so that both read a PDF to the same operator list). The build copies them to dist/vendor/,
 * next to cli.js (packages/server/scripts/build.mjs), and they are read the first time a diagram or a PDF needs them.
 * Places, in order: $BOGEN_VENDOR_DIR, dist/vendor/ next to the bundle, and the package in node_modules when running
 * from source.
 */
export const VENDOR_FILES = {
  mermaid: { file: 'mermaid.min.js', module: 'mermaid/dist/mermaid.min.js', for: 'Mermaid diagrams (diagram_insert)' },
  pdf: { file: 'pdf.min.mjs', module: 'pdfjs-dist/legacy/build/pdf.min.mjs', for: 'PDF import (pdf_import and a PDF dropped on the canvas)' },
  pdfWorker: { file: 'pdf.worker.min.mjs', module: 'pdfjs-dist/legacy/build/pdf.worker.min.mjs', for: 'PDF import (pdf_import and a PDF dropped on the canvas)' },
} as const;
export type VendorFile = keyof typeof VENDOR_FILES;

export function vendorDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [...(env.BOGEN_VENDOR_DIR ? [env.BOGEN_VENDOR_DIR] : []), join(here, 'vendor')];
}

/** The path of a vendored file, or an error that names the file, where it was looked for and what needs it. */
export function vendorPath(name: VendorFile, env: NodeJS.ProcessEnv = process.env): string {
  const entry = VENDOR_FILES[name];
  const dirs = vendorDirs(env);
  for (const dir of dirs) {
    const path = join(dir, entry.file);
    if (existsSync(path)) return path;
  }
  try {
    return createRequire(import.meta.url).resolve(entry.module);
  } catch {
    // Not running from source either.
  }
  throw new Error(`The file ${entry.file}, which ${entry.for} needs, is missing: it is not in ${dirs.join(' or ')}, and ${entry.module} is not installed. This installation of Bogen is incomplete; install it again, or set BOGEN_VENDOR_DIR to a folder that has it.`);
}
