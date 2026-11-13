import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureIconSets } from '@bogen/core/icon-sets';

/**
 * The icon sets beyond Lucide are data files, not part of the CLI bundle: the build copies
 * packages/core/src/icon-sets/ to dist/icon-sets/, next to cli.js, and a set is read the first time a search or an
 * insert asks for it. Places, in order: $BOGEN_ICON_SETS_DIR, next to the bundle, and the source tree.
 */
export function iconSetDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    ...(env.BOGEN_ICON_SETS_DIR ? [env.BOGEN_ICON_SETS_DIR] : []),
    join(here, 'icon-sets'),
    join(here, '..', '..', 'core', 'src', 'icon-sets'),
  ];
}

export async function readIconSetFile(file: string, dirs = iconSetDirs()): Promise<string> {
  if (!/^[a-z][a-z-]*\.json$/.test(file)) throw new Error(`"${file}" is not an icon set file.`);
  for (const dir of dirs) {
    try {
      return await readFile(join(dir, file), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`The icon set file ${file} is missing: it is not in ${dirs.join(', ')}. This installation of Bogen is incomplete; install it again, or set BOGEN_ICON_SETS_DIR to a folder that has it. Lucide icons still work.`);
}

let configured = false;

/** Points core's icon sets at these files, once. */
export function useIconSetFiles(): void {
  if (configured) return;
  configured = true;
  configureIconSets((file) => readIconSetFile(file));
}
