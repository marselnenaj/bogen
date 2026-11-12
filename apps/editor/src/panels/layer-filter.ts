import type { BogenNode } from '@bogen/core';
import { msg } from '../i18n/core.ts';

/** What the layer panel's search and the find bar look for. Pure, so that it can be tested. */
export type LayerKind = 'all' | 'frame' | 'text' | 'image' | 'vector' | 'shader' | 'media' | 'artboard' | 'hidden' | 'locked';

export const LAYER_KINDS: { value: LayerKind; label: string }[] = [
  { value: 'all', label: msg('All types') }, { value: 'frame', label: msg('Frames') }, { value: 'text', label: msg('Text') }, { value: 'image', label: msg('Images') },
  { value: 'vector', label: msg('Vectors') }, { value: 'shader', label: msg('Shaders') }, { value: 'media', label: msg('Video and embeds') }, { value: 'artboard', label: msg('Artboards') }, { value: 'hidden', label: msg('Hidden') }, { value: 'locked', label: msg('Locked') },
];

export interface LayerQuery { words: string[]; kind: LayerKind }

const KIND_WORDS: Record<string, LayerKind> = { frame: 'frame', frames: 'frame', text: 'text', image: 'image', img: 'image', images: 'image', vector: 'vector', svg: 'vector', shader: 'shader', video: 'media', embed: 'media', artboard: 'artboard', hidden: 'hidden', locked: 'locked' };

/** `type:text pricing` narrows by type in the search field as well as in the menu. */
export function parseLayerQuery(text: string, kind: LayerKind = 'all'): LayerQuery {
  let k = kind;
  const words: string[] = [];
  for (const part of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = /^(?:type|is):(\w+)$/.exec(part);
    const named = m ? KIND_WORDS[m[1]!] : undefined;
    if (named) k = named;
    else words.push(part);
  }
  return { words, kind: k };
}

export function matchesKind(n: BogenNode, kind: LayerKind): boolean {
  switch (kind) {
    case 'all': return true;
    case 'frame': return n.type === 'frame';
    case 'text': return n.type === 'text';
    case 'image': return n.type === 'image';
    case 'vector': return n.type === 'svg';
    case 'shader': return n.type === 'shader';
    case 'media': return n.type === 'video' || n.type === 'embed';
    case 'artboard': return Boolean(n.artboard);
    case 'hidden': return Boolean(n.hidden);
    case 'locked': return Boolean(n.locked);
  }
}

export function isEmptyQuery(q: LayerQuery): boolean {
  return !q.words.length && q.kind === 'all';
}

export function matchesQuery(n: BogenNode, q: LayerQuery): boolean {
  if (!matchesKind(n, q.kind)) return false;
  if (!q.words.length) return true;
  const hay = `${n.name}\n${n.text ?? ''}\n${n.tag}\n${n.attrs?.alt ?? ''}\n${n.attrs?.['aria-label'] ?? ''}`.toLowerCase();
  return q.words.every((w) => hay.includes(w));
}

export interface TreeLike {
  nodes: { get: (id: string) => BogenNode | undefined };
  children: (id: string) => readonly string[];
}

/** Layers on a page that match, top of the tree first, in the order the panel reads them. */
export function findLayers(tree: TreeLike, pageId: string, q: LayerQuery, skipHidden = false): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const id of tree.children(parent)) {
      const n = tree.nodes.get(id);
      if (!n) continue;
      if (skipHidden && n.hidden) continue;
      if (matchesQuery(n, q)) out.push(id);
      walk(id);
    }
  };
  walk(pageId);
  return out;
}

export interface FilterRow { id: string; depth: number; match: boolean }

/** The tree cut down to what matches, each match keeping its parents for context. */
export function filteredRows(tree: TreeLike, pageId: string, q: LayerQuery, order: (parent: string, kids: readonly string[]) => readonly string[]): FilterRow[] {
  const keep = new Map<string, boolean>();
  const visit = (id: string): boolean => {
    const n = tree.nodes.get(id);
    if (!n) return false;
    let any = false;
    for (const c of tree.children(id)) if (visit(c)) any = true;
    const match = matchesQuery(n, q);
    if (match || any) keep.set(id, match);
    return match || any;
  };
  for (const id of tree.children(pageId)) visit(id);
  const rows: FilterRow[] = [];
  const walk = (parent: string, depth: number) => {
    for (const id of order(parent, tree.children(parent))) {
      const match = keep.get(id);
      if (match === undefined) continue;
      rows.push({ id, depth, match });
      walk(id, depth + 1);
    }
  };
  walk(pageId, 0);
  return rows;
}
