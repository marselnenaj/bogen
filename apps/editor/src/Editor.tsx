import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { WifiOff } from 'lucide-react';
import { Canvas } from './canvas/Canvas.tsx';
import { installShortcuts } from './commands/registry.ts';
import { startPresence } from './doc/presence.ts';
import { maybeSession, Session, setSession } from './doc/session.ts';
import { api } from './lib/api.ts';
import { phoneOrigin, useReachable } from './lib/phone.ts';
import { usePhoneSync } from './doc/phone-link.ts';
import { PhoneSyncLine } from './phone/PhoneSync.tsx';
import { ensureFont } from './lib/fonts.ts';
import { LeftPanel } from './panels/LeftPanel.tsx';
import { ProposalBars } from './canvas/ProposalBars.tsx';
import { AwayBanner, startFileTitle } from './panels/FileBanners.tsx';
import { LibraryBanner } from './panels/LibraryBanner.tsx';
import { ProjectKindBanner } from './panels/ProjectKind.tsx';
import { rememberedTool } from './state/tool-preference.ts';
import { OmarchyThemeBanner, OmarchyThemeDialog } from './panels/OmarchyTheme.tsx';
import { SizesView } from './panels/SizesView.tsx';
import { PanelHost, useChrome, useChromeUpkeep } from './panels/ChromePanels.tsx';
import { startAutoFit } from './ops/fit-view.ts';
import { HistoryStage } from './panels/HistoryStage.tsx';
import { RecentChanges } from './panels/RecentChanges.tsx';
import { AppScreens } from './panels/AppScreens.tsx';
import { setStageView } from './panels/history-state.ts';
import { history } from './lib/history-api.ts';
import { PullRequestDialog } from './panels/PullRequestDialog.tsx';
import { RepoTokensDialog } from './panels/RepoTokensDialog.tsx';
import { ChatHost } from './panels/ChatPanel.tsx';
import { chatOpenFor } from './panels/chat-state.ts';
import { startAgentEvents } from './panels/prompt-actions.ts';
import { startBrandEvents } from './panels/brand-state.ts';
import { RightPanel } from './panels/RightPanel.tsx';
import { ShortcutsDialog } from './panels/ShortcutsDialog.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { camera } from './state/camera.ts';
import { fitSelection } from './ops/ops.ts';
import { installViews } from './state/view.ts';
import { CommandPalette } from './panels/CommandPalette.tsx';
import { Lightbox } from './ui/Lightbox.tsx';
import { SettingsDialog } from './panels/SettingsDialog.tsx';
import { ExtensionApproval } from './panels/BrowserExtension.tsx';
import { BulkRenameDialog } from './panels/BulkRename.tsx';
import { PublishDialogs } from './panels/PublishDialogs.tsx';
import { RestyleDialog } from './panels/RestyleDialog.tsx';
import { useSettings } from './state/settings.ts';
import { useUi } from './state/ui.ts';
const ChecksDialog = lazy(() => import('./panels/ChecksDialog.tsx'));
const ComplianceDialog = lazy(() => import('./panels/ComplianceDialog.tsx'));
import { editor, useEditor } from './state/store.ts';
import { stopTextEdit } from './canvas/text-edit.ts';
import { unionRects, type Rect } from './canvas/geometry.ts';
import { installWebMcp } from './lib/webmcp-editor.ts';
import { useT } from './i18n/react.ts';
import { t } from './i18n/store.ts';

/**
 * A link such as `#/file/<id>?version=<commit>`, from a pull request's description, opens that version on the
 * stage, with the History panel next to it.
 */
function showLinkedVersion(fileId: string): void {
  const id = /[?&]version=([\w-]{1,40})/.exec(location.hash)?.[1];
  if (!id) return;
  editor().set({ rightTab: 'history', minimal: false });
  history.content(fileId, id).then((content) => {
    if (editor().fileId === fileId) setStageView({ kind: 'preview', id, label: t('Version {id}', { id }), content });
  }, (e: Error) => editor().showToast(t('That version is not here: {error}', { error: e.message })));
}

/**
 * A link such as `#/file/<id>?select=<layer>`, from the brand's page, opens the file with those layers selected on
 * their page, in view.
 */
function showLinkedSelection(s: Session): void {
  const linkedPage = /[?&]page=([\w-]{1,80})/.exec(location.hash)?.[1];
  if (linkedPage && s.snap.pages.some(p => p.id === linkedPage)) editor().set({ pageId: linkedPage, selection: [] });
  const ids = /[?&]select=([\w,-]{1,800})/.exec(location.hash)?.[1]?.split(',').filter((id) => s.doc.getNode(id)) ?? [];
  const layer = linkedLayer(s, /[?&]layer=([^&]{1,400})/.exec(location.hash)?.[1]);
  if (layer) ids.unshift(layer);
  if (!ids.length) return;
  const pageId = s.doc.pageOf(ids[0]!);
  editor().set({ ...(pageId ? { pageId } : {}), selection: ids.filter((id) => s.doc.pageOf(id) === pageId) });
  window.setTimeout(() => fitSelection(), 200);
}

/**
 * The layer a link such as `#/file/<id>?layer=<id or name>` means, from `bogen open <file>#<layer>` or a link an agent
 * printed: the layer with that id, else the first with that name (any case), on the page in view before the others.
 */
function linkedLayer(s: Session, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let wanted: string;
  try { wanted = decodeURIComponent(raw).trim(); } catch { return undefined; }
  if (!wanted) return undefined;
  if (s.doc.getNode(wanted) && s.doc.pageOf(wanted)) return wanted;
  const name = wanted.toLowerCase();
  const current = editor().pageId;
  const pages = [...s.snap.pages].sort((a, b) => Number(b.id === current) - Number(a.id === current));
  for (const page of pages) {
    const hit = s.doc.descendants(page.id).find((n) => n.name.trim().toLowerCase() === name);
    if (hit) return hit.id;
  }
  return undefined;
}

function pageKey(fileId: string): string {
  return `bogen-page-${fileId}`;
}

function Resizer({ side }: { side: 'left' | 'right' }) {
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const st = editor();
    const startX = e.clientX;
    const start = side === 'left' ? st.leftWidth : st.rightWidth;
    const uiScale = useSettings.getState().uiScale;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - startX) / uiScale;
      const w = Math.round(Math.max(200, Math.min(480, side === 'left' ? start + d : start - d)));
      editor().set(side === 'left' ? { leftWidth: w } : { rightWidth: w });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      camera.measureViewport();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return <div className={`resizer resizer-${side}`} onPointerDown={onDown} data-testid={`resizer-${side}`} />;
}

function ConnectionBanner() {
  const t = useT();
  const connection = useEditor((s) => s.connection);
  const ever = useEditor((s) => s.everConnected);
  if (phoneOrigin) return <PhoneConnectionBanner connection={connection} />;
  if (connection === 'connected' || !ever) return null;
  return (
    <div className="banner" role="status" data-testid="connection-banner">
      <WifiOff size={14} />
      <span>{t('Connection lost. You can keep working; your edits sync when it returns.')}</span>
    </div>
  );
}

/** On the phone a file can open from its stored copy without ever reaching the computer. The line says what waits. */
function PhoneConnectionBanner({ connection }: { connection: string }) {
  const sync = usePhoneSync();
  const reachable = useReachable();
  if (!sync.sending && (sync.live || (reachable !== false && connection !== 'disconnected'))) return null;
  return (
    <div className="banner" role="status" data-testid="connection-banner">
      <WifiOff size={14} />
      <PhoneSyncLine />
    </div>
  );
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  return toast ? <div className="toast" role="status" data-testid="toast">{toast}</div> : null;
}

/**
 * One open file. `bare` is the canvas alone, for the phone, which puts its own controls on top as `children`;
 * everything else (the session, presence, agents, offline copy) is the same.
 */
export function Editor({ fileId, layout = 'full', children }: { fileId: string; layout?: 'full' | 'bare'; children?: ReactNode }) {
  const t = useT();
  const [ready, setReady] = useState(false);
  /** On the phone: whether this file had a stored copy. Null until that is known. */
  const [stored, setStored] = useState<boolean | null>(null);
  const connection = useEditor((s) => s.connection);
  const checksOpen = useUi((s) => s.checksOpen);
  const complianceOpen = useUi((s) => s.complianceOpen);
  const minimal = useEditor((s) => s.minimal);
  const pageId = useEditor((s) => s.pageId);
  const lay = useChrome();
  useChromeUpkeep(lay, minimal);
  // A fit (Fit screen, Fit width) holds while the window and panels change, once the canvas is there.
  useEffect(() => (ready && pageId && layout === 'full' ? startAutoFit() : undefined), [ready, pageId, layout]);
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    const s = new Session(fileId);
    sessionRef.current = s;
    setSession(s);
    editor().set({ fileId, ready: false, connection: 'connecting', everConnected: false, pageId: null, selection: [], hoverId: null, editingTextId: null, editingPathId: null, tool: rememberedTool(), gesture: {}, peers: [], activity: [], activeAgents: {}, activeThreadId: null, threadRuns: {}, pendingComment: null, followClientId: null, prompt: { open: chatOpenFor(fileId), runId: null, running: false, messages: [], nodeIds: [] } });
    camera.value = { x: 0, y: 0, z: 1 };

    api.files().then((files) => {
      const f = files.find((x) => x.id === fileId);
      if (f) {
        s.offline?.setName(f.name);
        editor().set({ fileName: f.name });
        document.title = `${f.name} - Bogen`;
      }
    }).catch(() => {});

    // Agents may already be at work on comments in this file.
    api.commentRuns(fileId).then((runs) => {
      if (editor().fileId === fileId) editor().set({ threadRuns: Object.fromEntries(runs.map((r) => [r.threadId, r])) });
    }).catch(() => {});

    const choosePage = () => {
      const pages = s.snap.pages;
      if (!pages.length) return false;
      const state = editor();
      if (state.pageId && pages.some((p) => p.id === state.pageId)) return true;
      let saved: string | null = null;
      try { saved = localStorage.getItem(pageKey(fileId)); } catch { /* fine */ }
      state.set({ pageId: pages.find((p) => p.id === saved)?.id ?? pages[0]!.id, selection: [] });
      return true;
    };

    // Pages come from the server. Until they arrive, the editor shows that it is waiting.
    const offSnap = s.snap.subscribe(() => {
      if (!choosePage()) return;
    });

    let fitted = false;
    let offViews: (() => void) | null = null;
    const onSync = (synced: boolean) => {
      if (!synced) return;
      choosePage();
      if (!fitted && editor().pageId) {
        fitted = true;
        setReady(true);
        editor().set({ ready: true });
        offViews = installViews(fileId);
        showLinkedVersion(fileId);
        showLinkedSelection(s);
      }
    };
    s.provider.on('sync', onSync);
    // A stored copy with pages opens at once, before the server answers, or when it never does.
    void s.offline?.loaded.then((had) => {
      if (sessionRef.current !== s) return;
      setStored(had);
      if (had) onSync(true);
    });
    const onStatus = ({ status }: { status: string }) => {
      const st = editor();
      if (status === 'connected') st.set({ connection: 'connected', everConnected: true });
      else if (status === 'disconnected') st.set({ connection: 'disconnected' });
      else st.set({ connection: 'connecting' });
    };
    s.provider.on('status', onStatus);

    const offPresence = startPresence(s);
    const offEvents = startAgentEvents();
    const offTitle = startFileTitle(fileId);
    const offBrand = startBrandEvents();
    const offKeys = installShortcuts();
    // An agent in the browser gets the same tools as one over MCP, for this file.

    // An agent highlight lasts a moment after its last activity.
    const fade = window.setInterval(() => {
      const st = editor();
      const now = Date.now();
      const entries = Object.entries(st.activeAgents);
      if (!entries.length) return;
      const kept = entries.filter(([, a]) => now - a.at < 3000);
      if (kept.length !== entries.length) st.set({ activeAgents: Object.fromEntries(kept) });
    }, 500);

    // Undo restores the selection that was active when the step was made.
    const onAdd = ({ stackItem }: { stackItem: { meta: Map<string, unknown> } }) => {
      stackItem.meta.set('selection', editor().selection);
    };
    const onPop = ({ stackItem }: { stackItem: { meta: Map<string, unknown> } }) => {
      const sel = stackItem.meta.get('selection') as string[] | undefined;
      if (!sel) return;
      queueMicrotask(() => editor().set({ selection: sel.filter((id) => s.snap.nodes.has(id)) }));
    };
    s.undo.on('stack-item-added', onAdd as never);
    s.undo.on('stack-item-popped', onPop as never);

    // A deleted layer cannot stay selected, whoever deleted it.
    const offSel = s.snap.subscribeStructure(() => {
      const st = editor();
      const kept = st.selection.filter((id) => s.snap.nodes.has(id));
      if (kept.length !== st.selection.length) st.set({ selection: kept });
    });

    const offPage = useEditor.subscribe((st, prev) => {
      if (st.pageId !== prev.pageId && st.pageId) {
        try { localStorage.setItem(pageKey(fileId), st.pageId); } catch { /* fine */ }
      }
    });

    // A layer link opened while its file is already open selects and shows the layer too, without a reload.
    let lastHash = location.hash;
    const onHash = () => {
      if (location.hash === lastHash) return;
      lastHash = location.hash;
      if (fitted && /^#\/file\/([\w-]+)/.exec(location.hash)?.[1] === fileId) showLinkedSelection(s);
    };
    window.addEventListener('hashchange', onHash);

    for (const n of s.snap.nodes.values()) ensureFont(n.style.fontFamily);

    // A narrow door for performance measurements in tests. Nothing in the app uses it.
    (window as unknown as { __bogenTest?: unknown }).__bogenTest = {
      setStyle: (patch: Record<string, string>) => {
        const id = editor().selection[0]!;
        s.tx(() => s.doc.updateStyle(id, patch));
        return id;
      },
    };

    return () => {
      stopTextEdit();
      offViews?.();
      clearInterval(fade);
      offSnap();
      offPresence();
      offEvents();
      offTitle();
      offBrand();
      offKeys();
      offSel();
      offPage();
      window.removeEventListener('hashchange', onHash);
      s.provider.off('sync', onSync);
      s.provider.off('status', onStatus);
      // React runs this before the cleanups of the panels inside, which still read the session as they let go of it,
      // and, when the hash moves straight to another file, before the next file's editor sets its own. So the session
      // goes after those cleanups, and the global one is cleared only if no other file's session took its place.
      queueMicrotask(() => {
        if (maybeSession() === s) setSession(null);
        s.destroy();
      });
      sessionRef.current = null;
      setReady(false);
      // Opening this file again must not find it ready before its new session is.
      if (editor().fileId === fileId) editor().set({ ready: false });
      document.title = 'Bogen';
    };
  }, [fileId]);
  useEffect(() => ready && layout === 'full' ? installWebMcp(fileId) : undefined, [fileId, layout, ready]);

  if (!ready || !pageId) {
    const missing = phoneOrigin && stored === false && connection === 'disconnected';
    return (
      <div className="loading" data-testid="loading">
        <span>{missing ? t('This file is not on this phone, and the computer cannot be reached. It opens when the computer is back.') : t('Opening the file')}</span>
      </div>
    );
  }

  if (layout === 'bare') {
    return (
      <div className="editor is-bare" data-testid="editor">
        <ConnectionBanner />
        <RecentChanges />
        <main className="stage" aria-label={t('Canvas')}>
          <Canvas />
          <ProposalBars />
          {children}
        </main>
        <Lightbox />
        <Toast />
      </div>
    );
  }

  // Docked panels sit beside the canvas at the width the layout gives them; the others open as drawers over it.
  const leftDocked = !minimal && lay.left === 'docked';
  const rightDocked = !minimal && lay.right === 'docked';
  const chatDocked = !minimal && lay.chat === 'docked';
  const style = {
    gridTemplateColumns: [leftDocked ? `${lay.leftPx}px` : '', 'minmax(0, 1fr)', chatDocked ? `${lay.chatPx}px` : '', rightDocked ? `${lay.rightPx}px` : ''].filter(Boolean).join(' '),
  };

  return (
    <div className={`editor${minimal ? ' is-minimal' : ''}`} data-testid="editor" data-chrome={lay.mode} data-toolbar={lay.toolbar} data-short={lay.short ? '' : undefined}>
      {!minimal ? <Toolbar /> : null}
      {!minimal ? <RecentChanges /> : null}
      <ConnectionBanner />
      <AwayBanner />
      <LibraryBanner />
      <ProjectKindBanner />
      <OmarchyThemeBanner />
      <div className="workspace" style={style}>
        {/* One host per panel for the editor's life: docked, a drawer or stowed, the panel inside keeps its state. */}
        <PanelHost side="left" lay={lay} minimal={minimal} resizer={<Resizer side="left" />}><LeftPanel /></PanelHost>
        <main className="stage" aria-label={t('Canvas')}>
          <Canvas />
          <ProposalBars />
          <HistoryStage />
          <AppScreens />
          {children}
          {minimal ? <button type="button" className="minimal-exit" onClick={() => editor().set({ minimal: false })} data-testid="minimal-exit">{t('Show panels ({shortcut})', { shortcut: 'Ctrl+\\' })}</button> : null}
        </main>
        <ChatHost lay={lay} minimal={minimal} />
        <PanelHost side="right" lay={lay} minimal={minimal} resizer={<Resizer side="right" />}><RightPanel /></PanelHost>
      </div>
      <ShortcutsDialog />
      <CommandPalette />
      <Lightbox />
      <SettingsDialog />
      <ExtensionApproval />
      <BulkRenameDialog />
      <PullRequestDialog />
      <RepoTokensDialog />
      <PublishDialogs />
      <RestyleDialog />
      <OmarchyThemeDialog />
      <SizesView />
      {checksOpen ? <Suspense fallback={null}><ChecksDialog /></Suspense> : null}
      {complianceOpen ? <Suspense fallback={null}><ComplianceDialog /></Suspense> : null}
      <Toast />
    </div>
  );
}

export type { Rect };
export { unionRects };
