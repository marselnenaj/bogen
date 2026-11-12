/** Dashboard folders and how files are listed in them. Pure. */
import { msg } from '../i18n/core.ts';

export interface Listable { id: string; name: string; updatedAt: number | string; createdAt?: number | string; folder?: string }

export type SortKey = 'edited' | 'oldest' | 'name' | 'name-desc' | 'created';

export const SORTS: { value: SortKey; label: string }[] = [
  { value: 'edited', label: msg('Last edited') }, { value: 'oldest', label: msg('Oldest edit') }, { value: 'name', label: msg('Name, A to Z') }, { value: 'name-desc', label: msg('Name, Z to A') }, { value: 'created', label: msg('Newest') },
];

const time = (v: number | string | undefined) => (v === undefined ? 0 : new Date(v).getTime() || 0);

export function sortFiles<T extends Listable>(files: T[], key: SortKey): T[] {
  const list = [...files];
  switch (key) {
    case 'edited': return list.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
    case 'oldest': return list.sort((a, b) => time(a.updatedAt) - time(b.updatedAt));
    case 'name': return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    case 'name-desc': return list.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    case 'created': return list.sort((a, b) => time(b.createdAt) - time(a.createdAt));
  }
}

export interface FolderNode { path: string; name: string; children: FolderNode[]; count: number }

/** The folders as a tree, with how many files sit in each, counting what is further down. */
export function folderTree(paths: string[], files: Listable[]): FolderNode[] {
  const root: FolderNode = { path: '', name: '', children: [], count: 0 };
  const index = new Map<string, FolderNode>([['', root]]);
  const add = (path: string): FolderNode => {
    const found = index.get(path);
    if (found) return found;
    const at = path.lastIndexOf('/');
    const parent = add(at < 0 ? '' : path.slice(0, at));
    const node: FolderNode = { path, name: path.slice(at + 1), children: [], count: 0 };
    parent.children.push(node);
    index.set(path, node);
    return node;
  };
  for (const p of paths) if (p) add(p);
  for (const f of files) {
    if (!f.folder) continue;
    let node: FolderNode | undefined = add(f.folder);
    let path = f.folder;
    while (node) {
      node.count++;
      if (!path) break;
      const at: number = path.lastIndexOf('/');
      path = at < 0 ? '' : path.slice(0, at);
      node = path ? index.get(path) : undefined;
    }
  }
  const order = (n: FolderNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.children.forEach(order);
  };
  order(root);
  return root.children;
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** What shows in a folder. `null` means all files; search looks everywhere. */
export function filesIn<T extends Listable>(files: T[], folder: string | null, query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q) return files.filter((f) => f.name.toLowerCase().includes(q));
  if (folder === null) return files;
  return files.filter((f) => (f.folder ?? '') === folder);
}

export function joinPath(parent: string, name: string): string {
  const clean = name.trim().replace(/\//g, '-');
  return parent ? `${parent}/${clean}` : clean;
}

/** Selection after a click, with shift taking the range from the last one clicked. */
export function nextSelection(order: string[], current: string[], id: string, anchor: string | null, range: boolean): string[] {
  if (range && anchor) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a >= 0 && b >= 0) return [...new Set([...current, ...order.slice(Math.min(a, b), Math.max(a, b) + 1)])];
  }
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}
