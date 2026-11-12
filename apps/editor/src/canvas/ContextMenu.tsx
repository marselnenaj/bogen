import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { commandById, displayKeys, runCommand } from '../commands/registry.ts';
import { camera } from '../state/camera.ts';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { useSettings } from '../state/settings.ts';
import { useT } from '../i18n/react.ts';
import { hitAt, resolveTarget } from './pointer.ts';

const useMenu = create<{ at: { x: number; y: number } | null; set: (at: { x: number; y: number } | null) => void }>((set) => ({ at: null, set: (at) => set({ at }) }));

export function openContextMenu(clientX: number, clientY: number): void {
  const hit = hitAt(clientX, clientY);
  if (hit) {
    const target = resolveTarget(hit, false);
    if (!editor().selection.includes(target)) editor().set({ selection: [target] });
  }
  useMenu.getState().set({ x: clientX - camera.left, y: clientY - camera.top });
}

/** Shown only when it applies: rebuilding needs one image with something in it. */
const IMAGE_ITEMS: (string | null)[] = ['agent.rebuild', null];

function oneImage(): boolean {
  const { selection } = editor();
  const node = selection.length === 1 ? session().snap.nodes.get(selection[0]!) : undefined;
  return node?.type === 'image' && Boolean(node.src);
}

const ITEMS: (string | null)[] = ['agent.redoScreen', null, 'edit.copy', 'edit.cut', 'edit.pasteOver', 'edit.pasteReplace', 'edit.copyStyles', 'edit.pasteStyles', null, 'arrange.front', 'arrange.forward', 'arrange.backward', 'arrange.back', null, 'layer.group', 'layer.wrap', 'layer.ungroup', 'layer.flatten', 'layer.autoLayout', 'vector.toPath', 'layer.renameFromContent', 'layer.renameBulk', 'select.matching', null, 'component.create', 'component.main', 'component.detach', 'code.pullRequest', null, 'layer.flipX', 'layer.flipY', 'layer.lock', 'layer.hide', null, 'edit.duplicate', 'edit.delete'];

export function ContextMenu() {
  const t = useT();
  const at = useMenu((s) => s.at);
  const set = useMenu((s) => s.set);
  const [, force] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const scale = useSettings((s) => s.uiScale);
  // The menu's real size on screen, measured once it is drawn, so that it fits however many items it has.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!at || !ref.current) { setSize(null); return; }
    const r = ref.current.getBoundingClientRect();
    setSize({ w: r.width, h: r.height });
  }, [at, scale]);
  useEffect(() => {
    if (!at) return;
    force((n) => n + 1);
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) set(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        set(null);
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [at, set]);
  if (!at) return null;
  const hasSelection = editor().selection.length > 0;
  const image = oneImage();
  // Kept inside the canvas: near the bottom or right edge it opens up or to the left. Taller than the canvas, it scrolls.
  // It is zoomed with the interface size, and a zoomed element's left, top and max height are in zoomed pixels.
  const w = size?.w ?? 224 * scale;
  const h = Math.min(size?.h ?? 0, camera.height - 16);
  const left = Math.max(8, Math.min(at.x, camera.width - w - 8));
  const top = Math.max(8, Math.min(at.y, camera.height - h - 8));
  return (
    <div ref={ref} className="menu" data-ui data-testid="context-menu" style={{ zoom: scale, left: left / scale, top: top / scale, maxHeight: (camera.height - 16) / scale, overflowY: 'auto', visibility: size ? 'visible' : 'hidden' }} role="menu">
      {(image ? [...IMAGE_ITEMS, ...ITEMS] : ITEMS).map((id, i) => {
        if (!id) return <div key={i} className="menu-sep" />;
        const c = commandById(id);
        if (!c || (c.when && !c.when())) return null;
        const disabled = !hasSelection && c.needsSelection;
        return (
          <button key={id} role="menuitem" className="menu-item" disabled={disabled} onClick={() => { set(null); runCommand(id); }}>
            <span>{t(c.title)}</span>
            <span className="menu-keys">{displayKeys(c)}</span>
          </button>
        );
      })}
    </div>
  );
}
