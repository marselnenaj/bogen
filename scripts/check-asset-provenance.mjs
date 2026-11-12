// Verify the delivered original-art catalog against its generation inventory, without opening theme integrations.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), folder = join(root, 'packages/server/assets/omarchy-collection');
const manifest = JSON.parse(readFileSync(join(folder, 'provenance.json'), 'utf8'));
const generated = JSON.parse(readFileSync(join(root, 'docs/design/collection-art-20261109.json'), 'utf8'));
const expected = new Map(generated.map(r => [`${r.id}/${r.orientation}.jpg`, r.sha256]));
const seen = new Set();
for (const entry of manifest.assets) {
  if (!/^[a-z0-9-]+\/(?:landscape|portrait)\.jpg$|^[a-z0-9-]+\/thumb-(?:landscape|portrait)\.webp$/.test(entry.path) || seen.has(entry.path)) throw new Error('Invalid or duplicate provenance path');
  if (!['master', 'thumbnail'].includes(entry.kind) || (entry.kind === 'master') !== entry.path.endsWith('.jpg')) throw new Error('Invalid provenance asset kind');
  if (entry.kind === 'thumbnail' && entry.derivedFrom !== entry.path.replace('/thumb-', '/').replace(/\.webp$/, '.jpg')) throw new Error('Incorrect thumbnail relationship');
  seen.add(entry.path);
  const actual = createHash('sha256').update(readFileSync(join(folder, entry.path))).digest('hex');
  if (actual !== entry.sha256 || (entry.kind === 'master' && expected.get(entry.path) !== actual)) throw new Error(`Asset provenance mismatch: ${entry.path}`);
  if (entry.kind === 'thumbnail' && !expected.has(entry.derivedFrom)) throw new Error(`Missing thumbnail origin: ${entry.path}`);
}
const files = readdirSync(folder, { withFileTypes: true }).filter(f => f.isDirectory()).flatMap(d => readdirSync(join(folder, d.name)).filter(f => /\.(?:jpg|webp)$/.test(f)).map(f => `${d.name}/${f}`));
if (expected.size !== 40 || seen.size !== 80 || files.some(f => !seen.has(f)) || [...expected.keys()].some(f => !seen.has(f))) throw new Error('Incomplete art provenance coverage');
console.log('Asset provenance verified: 40 generated masters, 40 derived thumbnails; complete local hash coverage. Not a legal clearance.');
