/**
 * Makes packages/core/src/icons-data.json from the installed lucide-react, so that the server and the
 * editor share one icon set without either depending on React for it.
 * Run: npx tsx scripts/gen-icons.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'node_modules/lucide-react/dist/esm/icons');
const pkg = JSON.parse(readFileSync(resolve(root, 'node_modules/lucide-react/package.json'), 'utf8')) as { version: string };

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const icons: Record<string, string> = {};
for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(resolve(dir, file)) as { __iconData?: { name: string; node: [string, Record<string, string>][] } };
  const data = mod.__iconData;
  if (!data) continue;
  icons[data.name] = data.node.map(([tag, attrs]) => {
    const parts = Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${escape(String(v))}"`);
    return `<${tag} ${parts.join(' ')}/>`;
  }).join('');
}
const out = { source: `lucide-react ${pkg.version}`, license: 'ISC', icons };
writeFileSync(resolve(root, 'packages/core/src/icons-data.json'), `${JSON.stringify(out)}\n`);
console.log(`${Object.keys(icons).length} icons`);
