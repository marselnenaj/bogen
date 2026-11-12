import { clipSpec, importHtml, libraryClip, nodeToHtml, pasteLibraryClip, type LibraryClip, type NewNode } from '@bogen/core';
import { flushSync } from 'react-dom';
import { contains, freeSpot, unionRects, type Vec } from '../canvas/geometry.ts';
import { flowOf, rectOf, toParentLocal } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { api, resolveAsset } from '../lib/api.ts';
import { fmtPx, px } from '../lib/css-values.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { revealIfOffscreen } from './reveal.ts';
import { deleteSelection, ensurePositioned, isContainer, pageId, POSITION_KEYS, SIZE_KEYS, topLevelOf, visibleCentre } from './ops.ts';
import { t } from '../i18n/store.ts';

const MARK = 'bogen-clip:';

/** `libraries`: the library copies the nodes show, so that a paste into another file stays linked. */
interface ClipData { nodes: NewNode[]; origin: { x: number; y: number; w: number; h: number } | null; libraries?: LibraryClip[] }

function encode(data: ClipData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decode(text: string): ClipData | null {
  try {
    const bin = atob(text);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as ClipData;
  } catch {
    return null;
  }
}

function plainTextOf(ids: string[]): string {
  const s = session();
  const out: string[] = [];
  const walk = (id: string) => {
    const n = s.snap.nodes.get(id);
    if (!n) return;
    if (n.text) out.push(n.text);
    s.snap.children(id).forEach(walk);
  };
  ids.forEach(walk);
  return out.join('\n');
}

export function selectionClip(): { html: string; plain: string } | null {
  const s = session();
  const ids = topLevelOf(editor().selection, true);
  if (!ids.length) return null;
  const origin = unionRects(ids.flatMap((id) => rectOf(id) ?? []));
  const nodes = ids.map((id) => {
    const spec = clipSpec(s.doc, id);
    const r = rectOf(id);
    // Remember where each root sits in the world, so that pasting elsewhere keeps their layout.
    return { ...spec, attrs: { ...(spec.attrs ?? {}), ...(r ? { 'data-bogen-x': String(r.x), 'data-bogen-y': String(r.y) } : {}) } };
  });
  const libraries = libraryClip(s.doc, ids);
  const html = `<!--${MARK}${encode({ nodes, origin, ...(libraries.length ? { libraries } : {}) })}-->` + ids.map((id) => nodeToHtml(s.doc, id, { resolve: (src) => new URL(resolveAsset(src), location.href).href, stripRootPosition: true })).join('');
  return { html, plain: plainTextOf(ids) || ids.map((id) => s.snap.nodes.get(id)?.name ?? '').join('\n') };
}

/** Handles the `copy` and `cut` events. */
export function onCopy(e: ClipboardEvent, cut: boolean): void {
  const clip = selectionClip();
  if (!clip || !e.clipboardData) return;
  e.clipboardData.setData('text/html', clip.html);
  e.clipboardData.setData('text/plain', clip.plain);
  lastCopy = clip;
  e.preventDefault();
  if (cut) deleteSelection();
}

/** The last copy made here. `navigator.clipboard.read` sanitizes the marker away. */
let lastCopy: { html: string; plain: string } | null = null;

export type PasteMode = 'normal' | 'over' | 'replace';
let nextPasteMode: PasteMode = 'normal';

export function armPasteMode(mode: PasteMode): void {
  nextPasteMode = mode;
}

/** For shortcuts that have to ask for the clipboard themselves, such as paste over selection. */
export async function pasteFromSystem(mode: PasteMode): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/plain') && lastCopy) {
        const plain = await (await item.getType('text/plain')).text();
        if (plain === lastCopy.plain) return pasteHtml(lastCopy.html, mode);
      }
      if (item.types.includes('text/html')) {
        const text = await (await item.getType('text/html')).text();
        return pasteHtml(text, mode);
      }
      const image = item.types.find((t) => t.startsWith('image/'));
      if (image) return void (await pasteImage(await item.getType(image)));
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        return pasteText(text, mode);
      }
    }
  } catch {
    if (lastCopy) return pasteHtml(lastCopy.html, mode);
    editor().showToast(t('The browser did not allow reading the clipboard. Allow it for this site, then try again.'));
  }
}

export function onPaste(e: ClipboardEvent): void {
  const data = e.clipboardData;
  if (!data) return;
  e.preventDefault();
  const mode = nextPasteMode;
  nextPasteMode = 'normal';
  const html = data.getData('text/html');
  const plain = data.getData('text/plain');
  const file = [...data.files].find((f) => f.type.startsWith('image/'));
  if (html && (html.includes(MARK) || !file)) return pasteHtml(html, mode);
  if (file) return void pasteImage(file);
  if (plain) pasteText(plain, mode);
}

export function pasteText(text: string, mode: PasteMode = 'normal'): void {
  const t = text.trim();
  if (!t) return;
  if (/^<\?xml|^<svg[\s>]/i.test(t) || /^<!doctype html|^<[a-z][\w-]*[\s>/]/i.test(t)) return pasteHtml(t, mode);
  insertNodes([{ type: 'text', tag: 'p', name: t.slice(0, 40), text, style: defaultTextStyle() }], null, mode);
}

export function defaultTextStyle(): Record<string, string> {
  return { fontFamily: 'Inter, sans-serif', fontSize: '16px', lineHeight: '1.4', color: '#111111' };
}

export function pasteHtml(html: string, mode: PasteMode = 'normal'): void {
  const mark = html.indexOf(MARK);
  if (mark >= 0) {
    const end = html.indexOf('-->', mark);
    const clip = decode(html.slice(mark + MARK.length, end));
    if (clip) return insertNodes(clip.nodes, clip.origin, mode, clip.libraries);
  }
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const imported = importHtml(clean);
  if (!imported.nodes.length) {
    const text = clean.replace(/<[^>]+>/g, ' ').trim();
    if (text) pasteText(text, mode);
    return;
  }
  if (imported.keyframes.length) {
    const s = session();
    const existing = s.doc.meta.get('keyframes');
    s.tx(() => s.doc.meta.set('keyframes', [...(Array.isArray(existing) ? existing : []), ...imported.keyframes]));
  }
  const nodes = imported.nodes.map(normalizeImported);
  insertNodes(nodes, null, mode);
}

/** SVG markup fills its layer, so that resizing the layer resizes the drawing. */
export function normalizeSvgMarkup(svg: string): { svg: string; width?: string; height?: string } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return { svg };
  const w = root.getAttribute('width');
  const h = root.getAttribute('height');
  if (w && w !== '100%' && h && h !== '100%' && !root.getAttribute('viewBox') && !Number.isNaN(parseFloat(w)) && !Number.isNaN(parseFloat(h))) {
    root.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
  }
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(parseFloat);
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  const out: { svg: string; width?: string; height?: string } = { svg: new XMLSerializer().serializeToString(root) };
  const pxw = w && w !== '100%' ? parseFloat(w) : vb[2];
  const pxh = h && h !== '100%' ? parseFloat(h) : vb[3];
  if (pxw && !Number.isNaN(pxw)) out.width = `${pxw}px`;
  if (pxh && !Number.isNaN(pxh)) out.height = `${pxh}px`;
  return out;
}

function normalizeImported(spec: NewNode): NewNode {
  if (spec.type === 'svg' && spec.svg) {
    const norm = normalizeSvgMarkup(spec.svg);
    return { ...spec, svg: norm.svg, style: { ...(norm.width ? { width: norm.width } : {}), ...(norm.height ? { height: norm.height } : {}), ...spec.style } };
  }
  if (spec.children?.length) return { ...spec, children: spec.children.map(normalizeImported) };
  return spec;
}

export async function pasteImage(file: Blob, at?: Vec): Promise<void> {
  try {
    const asset = await api.upload(file);
    await placeImage(asset.src, at);
  } catch (err) {
    editor().showToast(t('Could not add the image. {error}', { error: (err as Error).message }));
  }
}

export function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = resolveAsset(src);
  });
}

export async function placeImage(src: string, at?: Vec): Promise<string> {
  const size = await imageSize(src);
  const scale = Math.min(1, 800 / Math.max(size.w, size.h));
  const w = Math.round(size.w * scale);
  const h = Math.round(size.h * scale);
  const c = at ?? visibleCentre();
  const id = insertTopLevel({ type: 'image', tag: 'img', name: 'Image', src, style: { width: `${w}px`, height: `${h}px` } }, { x: c.x - w / 2, y: c.y - h / 2 });
  editor().set({ selection: [id], tool: 'move' });
  return id;
}

/** An image with no src yet: a frame of its size for a draft, filled later with Replace image or an agent's upload. */
export function placeImagePlaceholder(): string {
  const c = visibleCentre();
  const id = insertTopLevel({ type: 'image', tag: 'img', name: 'Image placeholder', style: { width: '400px', height: '300px' } }, { x: c.x - 200, y: c.y - 150 });
  editor().set({ selection: [id], tool: 'move' });
  return id;
}

function targetParent(): string {
  const s = session();
  const sel = topLevelOf(editor().selection);
  if (sel.length === 1) {
    const n = s.snap.nodes.get(sel[0]!)!;
    if (isContainer(n) && (n.artboard || flowOf(n.id).kind === 'flow' || s.snap.children(n.id).length)) return n.id;
  }
  if (sel.length) {
    const parent = s.snap.nodes.get(sel[0]!)!.parent;
    // A layer inside an instance has no room next to it: what is pasted goes next to the instance.
    const up = s.snap.nodes.get(parent);
    return up?.virtual && !isContainer(up) ? s.snap.nodes.get(up.virtual.owner)?.parent ?? pageId() : parent;
  }
  return pageId();
}

function insertTopLevel(spec: NewNode, world: Vec): string {
  const s = session();
  const parent = pageId();
  let id = '';
  flushSync(() => {
    s.tx(() => {
      id = s.doc.insert(parent, { ...spec, style: { position: 'absolute', left: fmtPx(world.x), top: fmtPx(world.y), ...spec.style } });
    });
  });
  return id;
}

function stripClipAttrs(spec: NewNode): { spec: NewNode; x: number | null; y: number | null } {
  const attrs = { ...(spec.attrs ?? {}) };
  const x = attrs['data-bogen-x'] !== undefined ? Number(attrs['data-bogen-x']) : null;
  const y = attrs['data-bogen-y'] !== undefined ? Number(attrs['data-bogen-y']) : null;
  delete attrs['data-bogen-x'];
  delete attrs['data-bogen-y'];
  const { attrs: _drop, ...rest } = spec;
  return { spec: { ...rest, ...(Object.keys(attrs).length ? { attrs } : {}) }, x, y };
}

/**
 * Puts layers on the canvas. A copy whose origin is still on screen lands next to it; anything else
 * lands in the middle of the view. `over` keeps the exact position, `replace` takes the place of the
 * selected layer.
 */
function insertNodes(nodes: NewNode[], origin: ClipData['origin'], mode: PasteMode, libraries?: LibraryClip[]): void {
  const s = session();
  const { snap, doc } = s;
  const prepared = nodes.map(stripClipAttrs);
  const rawSpecs = prepared.map((p) => p.spec);
  // Several loose imported roots become one frame, so that they keep flowing as they did on the page.
  const anyPositioned = rawSpecs.some((n) => n.style?.position === 'absolute');
  const specs: NewNode[] = !origin && rawSpecs.length > 1 && !anyPositioned
    ? [{ type: 'frame', name: 'Pasted', style: { display: 'flex', flexDirection: 'column', width: 'fit-content' }, children: rawSpecs }]
    : rawSpecs;

  let parent = mode === 'replace' ? (snap.nodes.get(editor().selection[0] ?? '')?.parent ?? pageId()) : targetParent();
  const flow = snap.nodes.has(parent) && flowOf(parent).kind === 'flow';

  let base: Vec;
  const replaced = mode === 'replace' ? topLevelOf(editor().selection) : [];
  let index: number | undefined;
  if (replaced.length) {
    const r = unionRects(replaced.flatMap((id) => rectOf(id) ?? []));
    base = r ? { x: r.x, y: r.y } : visibleCentre();
    index = snap.children(parent).indexOf(replaced[0]!);
  } else if (origin && mode === 'over') {
    base = { x: origin.x, y: origin.y };
  } else if (origin && contains(camera.visibleWorld(), origin) && parent === pageId()) {
    base = { x: origin.x + 16, y: origin.y + 16 };
  } else if (snap.nodes.has(parent)) {
    const r = rectOf(parent);
    const w = origin?.w ?? 0;
    const h = origin?.h ?? 0;
    base = r ? { x: r.x + Math.max(0, (r.w - w) / 2), y: r.y + Math.max(0, (r.h - h) / 2) } : visibleCentre();
  } else {
    const c = visibleCentre();
    base = { x: c.x - (origin?.w ?? 0) / 2, y: c.y - (origin?.h ?? 0) / 2 };
  }

  const out: string[] = [];
  s.beginGesture();
  flushSync(() => {
    s.tx(() => {
      // Library copies first, so that instances from a library land linked instead of as plain layers.
      if (libraries?.length) pasteLibraryClip(doc, libraries);
      if (!flow && snap.nodes.has(parent)) ensurePositioned(parent);
      const localBase = toParentLocal(parent, base);
      specs.forEach((spec, i) => {
        const p = prepared[i];
        const style: Record<string, string> = { ...spec.style };
        if (flow) {
          for (const k of POSITION_KEYS) delete style[k];
        } else {
          const offX = origin && p?.x !== null && p?.x !== undefined ? p.x - origin.x : 0;
          const offY = origin && p?.y !== null && p?.y !== undefined ? p.y - origin.y : 0;
          style.position = 'absolute';
          style.left = fmtPx(localBase.x + offX);
          style.top = fmtPx(localBase.y + offY);
          delete style.right;
          delete style.bottom;
        }
        out.push(doc.insert(parent, { ...spec, style }, index === undefined ? undefined : index + i));
      });
      if (replaced.length) {
        doc.delete(replaced);
        if (!snap.nodes.has(parent) && !snap.pages.some((pg) => pg.id === parent)) parent = pageId();
      }
    });
  });
  // Without an origin the size was unknown until now. Centre what landed in the middle of the view.
  if (!origin && !replaced.length && parent === pageId()) {
    const box = unionRects(out.flatMap((id) => rectOf(id) ?? []));
    if (box) {
      flushSync(() => {
        s.tx(() => {
          for (const id of out) {
            const n = snap.nodes.get(id);
            if (n) doc.updateStyle(id, { left: fmtPx(Math.round(px(n.style.left) - box.w / 2)), top: fmtPx(Math.round(px(n.style.top) - box.h / 2)) });
          }
        });
      });
    }
  }
  // Roots on the page stay clear of what is already there, earlier pastes and the original included.
  if (parent === pageId() && !replaced.length && mode === 'normal') {
    const box = unionRects(out.flatMap((id) => rectOf(id) ?? []));
    if (box) {
      const others = snap.children(parent).filter((id) => !out.includes(id)).flatMap((id) => rectOf(id) ?? []);
      const artboards = out.some((id) => snap.nodes.get(id)?.artboard);
      const spot = freeSpot(box, others, artboards ? 80 : 16);
      if (spot.x !== box.x) {
        flushSync(() => {
          s.tx(() => {
            for (const id of out) {
              const n = snap.nodes.get(id);
              if (n) doc.updateStyle(id, { left: fmtPx(px(n.style.left) + spot.x - box.x) });
            }
          });
        });
      }
    }
    revealIfOffscreen(out, out.some((id) => snap.nodes.get(id)?.artboard));
  }
  s.endGesture();
  editor().set({ selection: out, tool: 'move' });
}

let styleClip: Record<string, string> | null = null;

export function copyStyles(): void {
  const s = session();
  const first = editor().selection[0];
  const n = first ? s.snap.nodes.get(first) : null;
  if (!n) return;
  const out: Record<string, string> = {};
  const skip = new Set<string>([...POSITION_KEYS, ...SIZE_KEYS]);
  for (const [k, v] of Object.entries(n.style)) if (!skip.has(k)) out[k] = v;
  styleClip = out;
  editor().showToast(t('Styles copied'));
}

export function pasteStyles(): void {
  const s = session();
  if (!styleClip) {
    editor().showToast(t('Copy styles from a layer first'));
    return;
  }
  const clip = styleClip;
  s.tx(() => {
    for (const id of topLevelOf(editor().selection)) {
      const n = s.snap.nodes.get(id);
      if (!n) continue;
      const patch: Record<string, string | null> = {};
      const skip = new Set<string>([...POSITION_KEYS, ...SIZE_KEYS]);
      for (const k of Object.keys(n.style)) if (!skip.has(k)) patch[k] = null;
      s.doc.updateStyle(id, { ...patch, ...clip });
    }
  });
}

