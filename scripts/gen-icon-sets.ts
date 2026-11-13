/**
 * Makes packages/core/src/icon-sets/<set>.json from the published icon packages, one style per set, so that
 * icon_search and icon_insert reach more than Lucide. The packages are not dependencies of Bogen: fetch them into a
 * folder of their own and pass it, such as
 *
 *   mkdir -p /tmp/icon-packages && cd /tmp/icon-packages
 *   npm pack @phosphor-icons/core@2.1.1 @tabler/icons@3.51.0 heroicons@2.2.0 @material-symbols/svg-400@0.49.0
 *   for f in *.tgz; do mkdir "${f%.tgz}" && tar xzf "$f" -C "${f%.tgz}"; done
 *   npx tsx scripts/gen-icon-sets.ts /tmp/icon-packages
 *
 * Logos of other companies are left out (Phosphor's `*-logo`, Tabler's `brand-*`): they are those companies'
 * trademarks, which no icon licence grants. Each file keeps the inner markup of every icon, with what the set puts on every icon left out (Tabler's empty
 * bounding box, the root element), and the root's attributes once: its viewBox and whether it strokes or fills.
 * Remix Icon is not here: its own licence (Remix Icon License v1.0) forbids using the icons as a logo and in a
 * competing icon library, which a design tool cannot promise for what people draw with it. See docs/guide/licences.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const from = resolve(process.argv[2] ?? join(root, 'node_modules'));
const out = join(root, 'packages/core/src/icon-sets');

interface SetSpec {
  id: string;
  name: string;
  license: string;
  url: string;
  /** The folder of the unpacked package, found by its name in `from`. */
  pkg: string;
  dir: string;
  viewBox: string;
  kind: 'stroke' | 'fill';
  strokeWidth?: number;
  skip?: (file: string) => boolean;
  clean?: (inner: string) => string;
}

const SETS: SetSpec[] = [
  { id: 'phosphor', name: 'Phosphor (regular)', license: 'MIT', url: 'https://phosphoricons.com', pkg: 'phosphor-icons-core', dir: 'assets/regular', viewBox: '0 0 256 256', kind: 'fill', skip: (f) => f.endsWith('-logo.svg') },
  {
    id: 'tabler', name: 'Tabler Icons (outline)', license: 'MIT', url: 'https://tabler.io/icons', pkg: 'tabler-icons', dir: 'icons/outline', viewBox: '0 0 24 24', kind: 'stroke', strokeWidth: 2, skip: (f) => f.startsWith('brand-'),
    clean: (inner) => inner.replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/g, ''),
  },
  { id: 'heroicons', name: 'Heroicons (outline)', license: 'MIT', url: 'https://heroicons.com', pkg: 'heroicons', dir: '24/outline', viewBox: '0 0 24 24', kind: 'stroke', strokeWidth: 1.5 },
  { id: 'heroicons-solid', name: 'Heroicons (solid)', license: 'MIT', url: 'https://heroicons.com', pkg: 'heroicons', dir: '24/solid', viewBox: '0 0 24 24', kind: 'fill' },
  { id: 'material-symbols', name: 'Material Symbols (outlined)', license: 'Apache-2.0', url: 'https://fonts.google.com/icons', pkg: 'material-symbols-svg-400', dir: 'outlined', viewBox: '0 -960 960 960', kind: 'fill', skip: (f) => f.endsWith('-fill.svg') },
];

/** The unpacked package: `<from>/<pkg>-<version>/package` from npm pack, or `<from>/<scope>/<name>` from node_modules. */
function packageDir(spec: SetSpec): string {
  const packed = readdirSync(from).find((d) => d.startsWith(`${spec.pkg}-`) && existsSync(join(from, d, 'package')));
  if (packed) return join(from, packed, 'package');
  const installed = { 'phosphor-icons-core': '@phosphor-icons/core', 'tabler-icons': '@tabler/icons', heroicons: 'heroicons', 'material-symbols-svg-400': '@material-symbols/svg-400' }[spec.pkg]!;
  if (existsSync(join(from, installed))) return join(from, installed);
  throw new Error(`No ${spec.pkg} in ${from}. See the comment at the top of this script.`);
}

for (const spec of SETS) {
  const dir = packageDir(spec);
  const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
  const icons: Record<string, string> = {};
  for (const file of readdirSync(join(dir, spec.dir)).filter((f) => f.endsWith('.svg') && !spec.skip?.(f)).sort()) {
    const svg = readFileSync(join(dir, spec.dir, file), 'utf8');
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1];
    if (!inner) throw new Error(`${spec.id}: ${file} is not one svg element.`);
    const tidy = (spec.clean ? spec.clean(inner) : inner).replace(/\s*\n\s*/g, '').replace(/\s+\/>/g, '/>').replace(/>\s+</g, '><').trim();
    if (/<(script|foreignObject|image|use)\b|\son\w+=/i.test(tidy)) throw new Error(`${spec.id}: ${file} has markup an icon does not need.`);
    icons[file.slice(0, -4)] = tidy;
  }
  const data = { id: spec.id, name: spec.name, source: `${spec.pkg} ${version}`, license: spec.license, url: spec.url, viewBox: spec.viewBox, kind: spec.kind, ...(spec.strokeWidth ? { strokeWidth: spec.strokeWidth } : {}), icons };
  const text = `${JSON.stringify(data)}\n`;
  writeFileSync(join(out, `${spec.id}.json`), text);
  console.log(`${spec.id}: ${Object.keys(icons).length} icons, ${text.length} bytes`);
}
