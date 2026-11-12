// What ships or runs with Bogen, from package-lock.json: the packages bundled into the CLI, the shader runtime and the
// editor, and the packages npm installs next to the published package. Tools that only build or test Bogen are left
// out. THIRD_PARTY_NOTICES.md (scripts/gen-third-party-notices.mjs) and the release's SBOM (scripts/release.mjs) are
// both made from this list, so they always agree.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where each group starts. The CLI bundle leaves puppeteer-core and esbuild external (packages/server/scripts/build.mjs),
 * and scripts/release-npm.mjs makes them and tailwindcss the published package's only dependencies.
 */
export const RUNTIME = ['puppeteer-core', 'esbuild', 'tailwindcss'];
export const ORDER = ['cli', 'shaders', 'editor', 'npm'];

export const nameOf = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
/** Packages made for one platform, such as @esbuild/linux-x64. npm installs only the one that fits. */
export const isPlatform = (entry) => Boolean(entry.os || entry.cpu || entry.libc);

/**
 * `{ packages, merged, label }`: `packages` is the lock file's table, and `merged` maps `name@version` to the lock path
 * of its first copy and the set of groups it ships in. Copies of one version at several places are one package.
 */
export function shippedPackages(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const packages = lock.packages;
  const serverDeps = Object.keys(packages['packages/server'].dependencies ?? {});
  const groups = [
    { key: 'cli', label: 'CLI', from: 'packages/server', roots: serverDeps.filter((n) => !RUNTIME.includes(n) && n !== '@bogen/core') },
    { key: 'cli', label: 'CLI', from: 'packages/core', roots: Object.keys(packages['packages/core'].dependencies ?? {}) },
    { key: 'shaders', label: 'Shader runtime', from: 'packages/server', roots: ['@paper-design/shaders-react', 'react', 'react-dom'] },
    { key: 'editor', label: 'Editor', from: 'apps/editor', roots: Object.keys(packages['apps/editor'].dependencies ?? {}).filter((n) => n !== '@bogen/core') },
    { key: 'npm', label: 'npm install', from: 'packages/server', roots: RUNTIME },
  ];

  /** Node's lookup: the nearest node_modules folder up from the package that asks. */
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut >= 0 ? base.slice(0, cut) : '';
    }
  };

  const found = new Map(); // lock path -> Set of group keys
  for (const group of groups) {
    const queue = group.roots.map((name) => [group.from, name]);
    while (queue.length) {
      const [from, name] = queue.shift();
      const path = resolve(from, name);
      // An optional dependency for another platform, or a peer that nothing installs: not part of what ships.
      if (!path) continue;
      const entry = packages[path];
      if (entry.link) continue;
      let seen = found.get(path);
      if (!seen) found.set(path, (seen = new Set()));
      if (seen.has(group.key)) continue;
      seen.add(group.key);
      for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) queue.push([path, dep]);
      // Peers count only where they are installed, which resolve() decides.
      for (const dep of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[dep]?.optional) queue.push([path, dep]);
    }
  }

  const merged = new Map();
  for (const [path, inGroups] of found) {
    const key = `${nameOf(path)}@${packages[path].version}`;
    const seen = merged.get(key);
    if (seen) for (const g of inGroups) seen.groups.add(g);
    else merged.set(key, { path, groups: new Set(inGroups) });
  }
  return { packages, merged, label: Object.fromEntries(groups.map((g) => [g.key, g.label])) };
}

export function licenseOf(root, path, entry) {
  if (entry.license) return entry.license;
  const pkg = join(root, path, 'package.json');
  if (!existsSync(pkg)) return 'UNKNOWN';
  const json = JSON.parse(readFileSync(pkg, 'utf8'));
  if (typeof json.license === 'string') return json.license;
  if (json.license?.type) return json.license.type;
  if (Array.isArray(json.licenses)) return json.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}

export function repoOf(root, path) {
  const pkg = join(root, path, 'package.json');
  if (!existsSync(pkg)) return '';
  const json = JSON.parse(readFileSync(pkg, 'utf8'));
  let url = typeof json.repository === 'string' ? json.repository : json.repository?.url ?? '';
  url = url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return /^https:\/\//.test(url) ? url : '';
}

/** Runtime-only shrinkwrap from the same reviewed lock that supplies notices and SBOM. No fresh resolution. */
export function runtimeShrinkwrap(root, manifest) {
  const source = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const packages = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, engines: manifest.engines } };
  const resolvePackage = (from, name) => {
    for (let base = from;;) {
      const path = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (source[path]) return path;
      if (!base) return null;
      const cut = base.lastIndexOf('/node_modules/'); base = cut >= 0 ? base.slice(0, cut) : '';
    }
  };
  const queue = Object.keys(manifest.dependencies).map((name) => ['', name, false]);
  while (queue.length) {
    const [from, name, optional] = queue.shift();
    const path = resolvePackage(from, name);
    if (!path) { if (optional) continue; throw new Error(`Missing locked runtime dependency ${name} from ${from}`); }
    if (!path.startsWith('node_modules/') || source[path].link) throw new Error(`Runtime dependency ${path} needs a portable lock path before release`);
    if (packages[path]) continue;
    const { dev, devOptional, ...entry } = source[path];
    packages[path] = entry;
    for (const [dep, version] of Object.entries(entry.dependencies ?? {})) queue.push([path, dep, false]);
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) queue.push([path, dep, true]);
    for (const dep of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[dep]?.optional) queue.push([path, dep, false]);
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) if (packages[`node_modules/${name}`]?.version !== version) throw new Error(`Runtime root ${name} differs from the reviewed lock`);
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
}
