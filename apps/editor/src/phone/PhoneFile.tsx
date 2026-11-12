import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import { Editor } from '../Editor.tsx';
import { zoomAt } from '../canvas/geometry.ts';
import { elOf, rectOf } from '../canvas/measure.ts';
import { hitAt, resolveTarget } from '../canvas/pointer.ts';
import { useChildren, useFrameVersion, usePages } from '../doc/hooks.ts';
import { useStoredFiles } from '../doc/offline.ts';
import { maybeSession, session } from '../doc/session.ts';
import { redo, undo } from '../ops/ops.ts';
import { getDragMode, onDragMode, setDragMode } from '../canvas/touch.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { askAbout } from './ask-state.ts';
import { animateCamera, measureBoards, openSheet, rememberedBoard, showBoard, stopCameraAnimation } from './board-view.ts';
import { AskSheet } from './AskSheet.tsx';
import { CommentSheet } from './CommentSheet.tsx';
import { EditSheet } from './EditSheet.tsx';
import { boardAt, classifySwipe, keyboardInset, phoneFile, resizePhoneCamera, stepBoard, toggleSheet, TOOLS, usePhoneFile, type SheetKind } from './file-state.ts';
import { LayersSheet, PagesSheet } from './FileSheets.tsx';
import { ConflictNotes } from './PhoneSync.tsx';
import { PhotoSheet } from './PhotoSheet.tsx';
import { backTarget, OpenThread } from './PhoneCanvas.tsx';
import { useT } from '../i18n/react.ts';
import { WorkspaceView } from './WorkspaceView.tsx';
import { setPhoneWorkspaceView, usePhoneWorkspaceView, type PhoneWorkspaceView } from './workspace-view.ts';

/**
 * D1: a file on the phone. A bar with the way back, the file and its page; the canvas, with touch to zoom
 * and pan, comment pins, − and +, and where you are; the tools at the bottom, each with a sheet over the
 * canvas. See the Phone page of the Bogen Brand System file, row D.
 */
export function PhoneFile({ fileId, threadId, forceFull = false }: { fileId: string; threadId?: string; forceFull?: boolean }) {
  const view = usePhoneWorkspaceView();
  const full = forceFull || view === 'full';
  // The canvas owns the session: the parts around it wait for this file's to be there.
  // The store can still say ready for this file from the last time it was open, before its new session exists.
  const live = useEditor((s) => s.ready && s.fileId === fileId && Boolean(s.pageId)) && maybeSession()?.fileId === fileId;
  const sheet = usePhoneFile((s) => s.sheet);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  useKeyboardViewport(root);
  useSwipeSteps(canvas, !full);
  useEffect(() => { if (forceFull) setPhoneWorkspaceView('full'); }, [forceFull]);
  const changeView = (next: PhoneWorkspaceView) => {
    setPhoneWorkspaceView(next);
    if (forceFull) location.hash = `#/file/${fileId}`;
  };
  useEffect(() => {
    phoneFile().set({ sheet: null, boards: [], boardId: null });
    return () => phoneFile().set({ sheet: null, boards: [], boardId: null });
  }, [fileId]);

  return (
    <div ref={root} className={`pf${full ? ' pf-full-workspace' : sheet ? ` has-sheet is-${sheet}` : ''}`} data-testid="phone-file" data-view={full ? 'full' : 'touch'}>
      <TopBar fileId={fileId} live={live} full={full} onViewChange={changeView} />
      {live ? <ConflictNotes fileId={fileId} /> : null}
      <div className="pf-middle">
        <div ref={canvas} className="pf-canvas" data-testid="phone-canvas">
          <Editor fileId={fileId} layout={full ? 'full' : 'bare'}>
            {threadId ? <OpenThread threadId={threadId} /> : null}
            {!full ? <><BoardTracker fileId={fileId} fitOnOpen={!threadId} /><SheetBridge /><KeepInView /><CanvasChrome /></> : null}
          </Editor>
        </div>
        {/* Keep the sheet mounted while using the full workspace, including unsent text and attachments. */}
        <div style={{ display: full ? 'none' : 'contents' }}>
          {live && sheet ? <SheetFor kind={sheet} fileId={fileId} /> : null}
        </div>
      </div>
      {!full ? <ToolBar live={live} /> : null}
    </div>
  );
}

function SheetFor({ kind, fileId }: { kind: SheetKind; fileId: string }) {
  const close = () => openSheet(null);
  switch (kind) {
    case 'pages': return <PagesSheet fileId={fileId} onClose={close} />;
    case 'layers': return <LayersSheet onClose={close} />;
    case 'edit': return <EditSheet onClose={close} />;
    case 'comment': return <CommentSheet onClose={close} />;
    case 'ask': return <AskSheet fileId={fileId} onClose={close} />;
    case 'photo': return <PhotoSheet onClose={close} />;
  }
}

function TopBar({ fileId, live, full, onViewChange }: { fileId: string; live: boolean; full: boolean; onViewChange: (view: PhoneWorkspaceView) => void }) {
  const t = useT();
  const name = useEditor((s) => (s.fileId === fileId ? s.fileName : ''));
  const stored = useStoredFiles().get(fileId)?.name;
  const sheet = usePhoneFile((s) => s.sheet);
  const back = backTarget();
  return (
    <header className="pf-top">
      <button type="button" className="pf-back" onClick={() => {
        if (back.label === 'Thread') askAbout(fileId);
        location.hash = back.hash;
      }} data-testid="phone-back">‹ {t(back.label)}</button>
      <span className="pf-title" data-testid="pf-title" dir="auto">{name || stored || ''}</span>
      <WorkspaceView full={full} onChange={onViewChange} />
      {full ? null : sheet === 'edit' ? <button type="button" className="pf-right" onClick={() => openSheet(null)} data-testid="pf-done">{t('Done')}</button>
        : live ? <PageButton /> : <span className="pf-right" />}
    </header>
  );
}

function PageButton() {
  const pages = usePages();
  const pageId = useEditor((s) => s.pageId);
  const sheet = usePhoneFile((s) => s.sheet);
  const open = sheet === 'pages';
  return (
    <button type="button" className="pf-right pf-page" aria-expanded={open} onClick={() => openSheet(toggleSheet(sheet, 'pages'))} data-testid="pf-page">
      <span className="pf-page-name" dir="auto">{pages.find((p) => p.id === pageId)?.name ?? ''}</span>
      <span className="pf-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
  );
}

function ToolBar({ live }: { live: boolean }) {
  const t = useT();
  const sheet = usePhoneFile((s) => s.sheet);
  return (
    <nav className="pf-tools" aria-label={t('Tools')}>
      {TOOLS.map((tool) => (
        <button key={tool.id} type="button" className={`pf-tool${sheet === tool.id ? ' is-active' : ''}`} aria-pressed={sheet === tool.id} disabled={!live} onClick={() => openSheet(toggleSheet(sheet, tool.id))} data-testid={`pf-tool-${tool.id}`}>
          {t(tool.label)}
        </button>
      ))}
    </nav>
  );
}

/** The boards of the page and the one in view, and a board on the screen when a page opens. */
function BoardTracker({ fileId, fitOnOpen }: { fileId: string; fitOnOpen: boolean }) {
  const pageId = useEditor((s) => s.pageId)!;
  const kids = useChildren(pageId);
  const version = useFrameVersion();
  useEffect(() => {
    const f = requestAnimationFrame(() => phoneFile().set({ boards: measureBoards(pageId) }));
    return () => cancelAnimationFrame(f);
  }, [pageId, kids, version]);

  useEffect(() => {
    let f = 0;
    const update = () => {
      f = 0;
      const { boards, boardId } = phoneFile();
      const id = boardAt(boards, camera.visibleWorld());
      if (id !== boardId) phoneFile().set({ boardId: id });
    };
    const offCamera = camera.subscribe(() => { if (!f) f = requestAnimationFrame(update); });
    const offBoards = usePhoneFile.subscribe((s, p) => { if (s.boards !== p.boards) update(); });
    return () => { offCamera(); offBoards(); cancelAnimationFrame(f); };
  }, []);

  const first = useRef(true);
  useEffect(() => {
    const skip = first.current && !fitOnOpen;
    first.current = false;
    if (skip) return;
    let f = 0;
    let tries = 0;
    const step = () => {
      camera.measureViewport();
      const s = maybeSession();
      const mounted = Boolean(s) && camera.width > 0 && editor().pageId === pageId && s!.snap.children(pageId).every((id) => elOf(id));
      if (!mounted && tries++ < 240) {
        f = requestAnimationFrame(step);
        return;
      }
      // A frame after the page's own remembered view is put back, so that the board wins.
      f = requestAnimationFrame(() => {
        const boards = measureBoards(pageId);
        phoneFile().set({ boards });
        const saved = rememberedBoard(fileId, pageId);
        const target = boards.find((b) => b.id === saved) ?? boards[0];
        if (target) showBoard(target.id, false);
      });
    };
    f = requestAnimationFrame(step);
    return () => cancelAnimationFrame(f);
  }, [pageId, fileId, fitOnOpen]);
  return null;
}

/** A pin tapped, or a spot to comment on: the comment sheet shows it. */
function SheetBridge() {
  const active = useEditor((s) => s.activeThreadId);
  const pending = useEditor((s) => s.pendingComment);
  useEffect(() => {
    if ((active || pending) && phoneFile().sheet !== 'comment') phoneFile().set({ sheet: 'comment' });
  }, [active, pending]);
  return null;
}

/** Resize the existing camera, never the document/session or the sheet holding an unsent draft. */
function KeepInView() {
  useEffect(() => {
    const viewport = camera.viewport;
    if (!viewport) return;
    const initial = viewport.getBoundingClientRect();
    let before = { width: initial.width, height: initial.height }, frame = 0;
    const changed = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = viewport.getBoundingClientRect(), after = { width: box.width, height: box.height };
        if (!after.width || !after.height || (Math.abs(after.width - before.width) < 1 && Math.abs(after.height - before.height) < 1)) return;
        camera.measureViewport();
        const id = editor().selection[0], selection = id ? rectOf(id) : null;
        const board = phoneFile().boards.find(b => b.id === phoneFile().boardId);
        // A newly requested zoom can already use the new bounds while this resize is still queued.
        // Finish that intent in its own coordinate space instead of canceling the user's command.
        const moving = stopCameraAnimation();
        const next = resizePhoneCamera(moving?.target ?? camera.value, moving?.viewport ?? before, after, board, selection);
        before = after;
        camera.set(next, false);
      });
    };
    const observer = new ResizeObserver(changed);
    observer.observe(viewport);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return null;
}

function useZoomPercent(): number {
  return useSyncExternalStore((fn) => camera.subscribe(fn), () => Math.round(camera.value.z * 100));
}

function zoomBy(dir: 1 | -1): void {
  camera.measureViewport();
  const c = camera.value;
  const z = dir > 0 ? Math.min(256, c.z * 1.5) : Math.max(0.02, c.z / 1.5);
  animateCamera(zoomAt(c, z, { x: camera.width / 2, y: camera.height / 2 }), 160);
}

/** Over the canvas: undo and redo, the board steps and where you are, and − and +. */
function CanvasChrome() {
  const t = useT();
  const pages = usePages();
  const pageId = useEditor((s) => s.pageId);
  const boards = usePhoneFile((s) => s.boards);
  const boardId = usePhoneFile((s) => s.boardId);
  const zoom = useZoomPercent();
  const board = boards.find((b) => b.id === boardId);
  const prev = stepBoard(boards, boardId, -1);
  const next = stepBoard(boards, boardId, 1);
  const where = [pages.find((p) => p.id === pageId)?.name, board?.name, `${zoom}%`].filter(Boolean).join(' · ');
  return (
    <>
      <DragSwitch />
      <UndoRedo />
      <div className="pf-chrome" data-ui>
        <div className="pf-steps">
          <button type="button" className="pf-step" disabled={!prev || boards.length < 2} onClick={() => prev && showBoard(prev)} aria-label={t('The board before')} data-testid="pf-prev">‹</button>
          <span className="pf-where" data-testid="pf-where" dir="auto">{where}</span>
          <button type="button" className="pf-step" disabled={!next || boards.length < 2} onClick={() => next && showBoard(next)} aria-label={t('The next board')} data-testid="pf-next">›</button>
        </div>
        <div className="pf-zoom">
          <button type="button" className="pf-sq" onClick={() => zoomBy(-1)} aria-label={t('Zoom out')} data-testid="pf-zoom-out">−</button>
          <button type="button" className="pf-sq" onClick={() => zoomBy(1)} aria-label={t('Zoom in')} data-testid="pf-zoom-in">+</button>
        </div>
      </div>
    </>
  );
}

/** What one finger does on the canvas: look around, or pick up layers. */
function DragSwitch() {
  const t = useT();
  const mode = useSyncExternalStore(onDragMode, getDragMode);
  return (
    <div className="pf-drag" role="radiogroup" aria-label={t('One finger')} data-ui data-testid="pf-drag">
      {(['view', 'move'] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-on' : ''} onClick={() => setDragMode(m)} data-testid={`pf-drag-${m}`}>
          {m === 'view' ? t('View') : t('Move')}
        </button>
      ))}
    </div>
  );
}

/** This person's own undo, as on the computer: what agents and others did stays. */
function UndoRedo() {
  const t = useT();
  const s = session();
  const [can, setCan] = useState({ undo: s.undo.canUndo(), redo: s.undo.canRedo() });
  useEffect(() => {
    const update = () => setCan({ undo: s.undo.canUndo(), redo: s.undo.canRedo() });
    const events = ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const;
    for (const e of events) s.undo.on(e, update as never);
    update();
    return () => { for (const e of events) s.undo.off(e, update as never); };
  }, [s]);
  if (!can.undo && !can.redo) return null;
  return (
    <div className="pf-history" data-ui>
      <button type="button" className="pf-sq" disabled={!can.undo} onClick={undo} aria-label={t('Undo')} data-testid="pf-undo"><Undo2 size={20} strokeWidth={2.4} /></button>
      <button type="button" className="pf-sq" disabled={!can.redo} onClick={redo} aria-label={t('Redo')} data-testid="pf-redo"><Redo2 size={20} strokeWidth={2.4} /></button>
    </div>
  );
}

/**
 * The screen follows `visualViewport` while the keyboard is up, so that the foot of a sheet, with its
 * field, sits right above the keyboard instead of under it. iOS does not shrink the page for the keyboard.
 */
function useKeyboardViewport(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    const apply = () => {
      const inset = keyboardInset(window.innerHeight, vv);
      if (inset) {
        el.style.setProperty('--pf-top', `${vv.offsetTop}px`);
        el.style.setProperty('--pf-h', `${vv.height}px`);
        el.classList.add('is-keyboard');
      } else if (el.classList.contains('is-keyboard')) {
        el.style.removeProperty('--pf-top');
        el.style.removeProperty('--pf-h');
        el.classList.remove('is-keyboard');
        // iOS leaves the page scrolled to where the field was.
        window.scrollTo(0, 0);
      }
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, [ref]);
}

/**
 * A quick sideways flick of one finger goes to the next or the previous board, while the board fits across
 * the screen. Zoomed in, a sideways drag only pans, as before. The canvas pans under the finger either way
 * (canvas/touch.ts); this only listens.
 */
function useSwipeSteps(ref: RefObject<HTMLDivElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let fingers = 0;
    let multi = false;
    let start: { id: number; x: number; y: number; t: number; board: string | null; skip: boolean } | null = null;
    const onSelection = (e: PointerEvent) => {
      const sel = editor().selection;
      if (!sel.length) return false;
      const hit = hitAt(e.clientX, e.clientY);
      return Boolean(hit && sel.includes(resolveTarget(hit, false)));
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fingers++;
      if (fingers > 1) {
        multi = true;
        return;
      }
      multi = false;
      stopCameraAnimation();
      const t = e.target as HTMLElement;
      const tool = editor().tool;
      const skip = !t.closest('.canvas') || Boolean(t.closest('[data-ui],[data-handle],[data-rotate],[data-pin],[data-frame-label],[data-gap],[data-padding]'))
        || (tool !== 'move' && tool !== 'comment') || Boolean(editor().editingTextId) || onSelection(e);
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), board: phoneFile().boardId, skip };
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fingers = Math.max(0, fingers - 1);
      const s0 = start;
      if (!s0 || s0.id !== e.pointerId) {
        if (!fingers) start = null;
        return;
      }
      start = null;
      if (multi || s0.skip || e.type === 'pointercancel') return;
      const dir = classifySwipe({ dx: e.clientX - s0.x, dy: e.clientY - s0.y, ms: performance.now() - s0.t });
      if (!dir) return;
      const { boards } = phoneFile();
      const current = boards.find((b) => b.id === s0.board);
      if (!current || current.w * camera.value.z > camera.width + 2) return;
      showBoard(stepBoard(boards, current.id, dir) ?? current.id);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }, [ref, enabled]);
}
