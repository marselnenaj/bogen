#!/usr/bin/env node
// Checks every relative link and anchor in tracked Markdown: that the file or folder exists, and that an
// anchor names a heading (as GitHub makes its id) or an id in that file. Web addresses are not fetched.
//
//   node scripts/check-doc-links.mjs                       # release inputs only
//   node scripts/check-doc-links.mjs --include-untracked   # also inspect local drafts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(a => a !== '--include-untracked')) {
  console.error('Usage: node scripts/check-doc-links.mjs [--include-untracked]');
  process.exit(2);
}
const files = execFileSync('git', ['ls-files', '--cached', ...(args.includes('--include-untracked') ? ['--others', '--exclude-standard'] : []), '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.includes('node_modules/') && existsSync(join(root, f)));

/** Text outside fenced code blocks and inline code, where links are not links. */
function prose(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push('');
      continue;
    }
    if (m) {
      fence = m[1];
      out.push('');
      continue;
    }
    out.push(line.replace(/(`+)[^`]*?\1/g, ''));
  }
  return out.join('\n');
}

/** GitHub's heading ids: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchorsOf(text) {
  const ids = new Set();
  const counts = new Map();
  for (const line of prose(text).split('\n')) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const plain = h[1]
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/[*_~]/g, (c) => (c === '_' ? '_' : ''));
      const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      ids.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) ids.add(m[1]);
  }
  // Headings written inside inline code still count, so read them again from the raw text.
  for (const line of text.split('\n')) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (h && h[1].includes('`')) {
      const base = h[1].replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      ids.add(base);
    }
  }
  return ids;
}

const anchorCache = new Map();
function anchors(path) {
  if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(readFileSync(path, 'utf8')));
  return anchorCache.get(path);
}

function linksOf(text) {
  const body = prose(text);
  const found = [];
  for (const m of body.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) found.push(m[1]);
  for (const m of body.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)) found.push(m[1].split(/\s+/)[0]);
  for (const m of body.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) found.push(m[1]);
  return found;
}

const problems = [];
let checked = 0;
for (const file of files) {
  const full = join(root, file);
  for (const href of linksOf(readFileSync(full, 'utf8'))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
    checked++;
    const [pathPart, hash] = href.split('#');
    const target = pathPart ? resolve(dirname(full), decodeURIComponent(pathPart)) : full;
    if (!target.startsWith(root)) {
      problems.push(`${file}: ${href} leaves the repository`);
      continue;
    }
    if (!existsSync(target)) {
      problems.push(`${file}: ${href} does not exist`);
      continue;
    }
    if (hash !== undefined && hash !== '') {
      if (statSync(target).isDirectory() || !target.endsWith('.md')) continue;
      if (!anchors(target).has(decodeURIComponent(hash))) problems.push(`${file}: ${href} has no heading "#${hash}" in ${relative(root, target)}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`${problems.length} of ${checked} relative links in ${files.length} files do not resolve.`);
  process.exit(1);
}
console.log(`All ${checked} relative links in ${files.length} Markdown files resolve.`);
