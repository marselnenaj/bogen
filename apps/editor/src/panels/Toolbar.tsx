import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Ellipsis, EllipsisVertical, GitBranch, Shapes, ListChecks, BookOpen, Circle, CircleHelp, Eye, Frame, Hand, Play, Settings2, Image as ImageIcon, Smartphone, History, DoorOpen, Keyboard, MessageCircle, Minus, MousePointer2, Pen, Pencil, Redo2, SlidersHorizontal, Sparkles, Square, Type, Undo2, ZoomIn, ArrowLeft } from 'lucide-react';
import { COMMANDS, displayKeys, runCommand } from '../commands/registry.ts';
import { setLocalName, stopFollowing } from '../doc/presence.ts';
import { session } from '../doc/session.ts';
import { api } from '../lib/api.ts';
import { pickColor, saveUser } from '../lib/user.ts';
import { fitAll, fitSelection, redo, undo } from '../ops/ops.ts';
import { pickImage } from '../ops/images.ts';
import { openAppScreenBeside } from './AppScreens.tsx';
import { camera } from '../state/camera.ts';
import { editor, useEditor, type Tool } from '../state/store.ts';
import { toggleChat } from './prompt-actions.ts';
import { ui, useUi } from '../state/ui.ts';
import { fitScreen } from '../ops/fit-view.ts';
import { fitToolbar, PEERS_SHOWN, useWindowSize, type ChromeLayout, type ToolbarLevel } from '../state/chrome-layout.ts';
import { useSettings } from '../state/settings.ts';
import { openTab, PanelMenuItem, PanelToggle, useChrome } from './ChromePanels.tsx';
import { IconButton, Popover } from '../ui/controls.tsx';
import { SyncStatus, useSyncPeers } from './SyncStatus.tsx';
import { nextZoomStop } from '../canvas/geometry.ts';
import { readableOn } from '../lib/readable.ts';
import { IconPicker } from './IconPicker.tsx';
import { BranchMenu } from './BranchMenu.tsx';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

const TOOLS: { tool: Tool; icon: typeof Hand; title: string; cmd: string }[] = [
  { tool: 'move', icon: MousePointer2, title: msg('Move'), cmd: 'tool.move' },
  { tool: 'hand', icon: Hand, title: msg('Hand'), cmd: 'tool.hand' },
  { tool: 'frame', icon: Frame, title: msg('Frame'), cmd: 'tool.frame' },
  { tool: 'rect', icon: Square, title: msg('Rectangle'), cmd: 'tool.rect' },
  { tool: 'ellipse', icon: Circle, title: msg('Ellipse'), cmd: 'tool.ellipse' },
  { tool: 'line', icon: Minus, title: msg('Line'), cmd: 'tool.line' },
  { tool: 'text', icon: Type, title: msg('Text'), cmd: 'tool.text' },
  { tool: 'pen', icon: Pen, title: msg('Pen'), cmd: 'tool.pen' },
  { tool: 'pencil', icon: Pencil, title: msg('Pencil'), cmd: 'tool.pencil' },
];

const TOOLS2: { tool: Tool; icon: typeof Hand; title: string; cmd: string }[] = [
  { tool: 'comment', icon: MessageCircle, title: msg('Comment'), cmd: 'tool.comment' },
  { tool: 'shader', icon: Sparkles, title: msg('Shader'), cmd: 'tool.shader' },
  { tool: 'zoom', icon: ZoomIn, title: msg('Zoom'), cmd: 'tool.zoom' },
];

function keyOf(cmd: string): string {
  const c = COMMANDS.find((x) => x.id === cmd);
  return c ? displayKeys(c) : '';
}

function ZoomControl() {
  const t = useT();
  const z = useSyncExternalStore((fn) => camera.subscribe(fn), () => camera.value.z);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const held = useUi((s) => s.autoFit);
  const items: { label: string; keys: string; run: () => void; id: string }[] = [
    { id: 'fit-screen', label: t('Fit screen'), keys: 'Shift+3', run: () => fitScreen('screen') },
    { id: 'fit-width', label: t('Fit width'), keys: 'Shift+4', run: () => fitScreen('width') },
    { id: 'zoom-100', label: '100%', keys: 'Shift+0', run: () => camera.zoomAt(1) },
    { id: 'fit-selection', label: t('Fit selection'), keys: 'Shift+2', run: fitSelection },
    { id: 'fit-all', label: t('All screens'), keys: 'Shift+1', run: fitAll },
    { id: 'zoom-in', label: t('Zoom in'), keys: '+', run: () => camera.zoomAt(nextZoomStop(camera.value.z, 1)) },
    { id: 'zoom-out', label: t('Zoom out'), keys: '-', run: () => camera.zoomAt(nextZoomStop(camera.value.z, -1)) },
  ];
  return (
    <>
      <button ref={ref} type="button" className={`zoom-btn${held ? ' is-holding' : ''}`} onClick={() => setOpen(!open)} data-testid="zoom-level" data-autofit={held?.mode} title={held ? (held.mode === 'width' ? t('Holding the width in view while the window changes; pan or zoom to stop') : t('Holding the whole artboard in view while the window changes; pan or zoom to stop')) : t('Zoom and fit')} aria-label={t('Zoom and fit')} aria-haspopup="menu" aria-expanded={open}>{Math.round(z * 100)}%</button>
      {open ? (
        <Popover anchor={ref.current} side="below" width={180} onClose={() => setOpen(false)} focus>
          <div role="menu" aria-label={t('Zoom and fit')}>
            {items.map((it) => (
              <button key={it.id} type="button" role="menuitem" className={`menu-item${held && it.id === `fit-${held.mode}` ? ' is-current' : ''}`} onClick={() => { it.run(); setOpen(false); }} data-testid={`zoom-${it.id}`}>
                <span>{it.label}</span><span className="menu-keys">{it.keys}</span>
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** Help: the shortcuts, the welcome file (made again if it was deleted) and the guide. */
function HelpMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const welcome = () => {
    setOpen(false);
    void api.welcome().then(({ id }) => { location.hash = `#/file/${id}`; });
  };
  return (
    <>
      <button ref={ref} type="button" className={`icon-btn${open ? ' is-active' : ''}`} title={t('Help and keyboard shortcuts ({shortcut})', { shortcut: 'Ctrl+/' })} aria-label={t('Help')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="shortcuts-open"><CircleHelp size={15} /></button>
      {open ? (
        <Popover anchor={ref.current} side="below" width={220} onClose={() => setOpen(false)} focus>
          <div role="menu" aria-label={t('Help')} data-testid="help-menu">
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); editor().set({ shortcutsOpen: true }); }} data-testid="help-shortcuts"><span className="menu-with-icon"><Keyboard size={13} /> {t('Keyboard shortcuts')}</span><span className="menu-keys">{keyOf('view.shortcuts')}</span></button>
            <button type="button" role="menuitem" className="menu-item" onClick={welcome} data-testid="help-welcome"><span className="menu-with-icon"><DoorOpen size={13} /> {t('Welcome to Bogen')}</span></button>
            <a role="menuitem" className="menu-item" href="https://github.com/marselnenaj/bogen/blob/main/docs/guide/README.md" target="_blank" rel="noreferrer" onClick={() => setOpen(false)} data-testid="help-docs"><span className="menu-with-icon"><BookOpen size={13} /> {t('Documentation')}</span></a>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function Peers({ max = 6 }: { max?: number }) {
  const t = useT();
  const peers = useEditor((s) => s.peers);
  const following = useEditor((s) => s.followClientId);
  const shown = peers.slice(0, max);
  return (
    <div className="peers" data-testid="peers">
      {shown.map((p) => (
        <button
          key={p.clientId}
          type="button"
          className={`peer${following === p.clientId ? ' is-following' : ''}`}
          style={{ background: p.user.color, color: readableOn(p.user.color) }}
          title={following === p.clientId
            ? (p.user.device ? t('Stop following {name} on {device}', { name: p.user.name, device: p.user.device }) : t('Stop following {name}', { name: p.user.name }))
            : (p.user.device ? t('Follow {name} on {device}', { name: p.user.name, device: p.user.device }) : t('Follow {name}', { name: p.user.name }))}
          data-testid="peer"
          onClick={() => (following === p.clientId ? stopFollowing() : editor().set({ followClientId: p.clientId }))}
        >{p.user.name.trim()[0]?.toUpperCase() ?? '?'}</button>
      ))}
      {peers.length > shown.length ? <span className="peer-more">+{peers.length - shown.length}</span> : null}
    </div>
  );
}

function Me() {
  const t = useT();
  const s = session();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className="peer is-me" style={{ background: s.user.color, color: readableOn(s.user.color) }} onClick={() => setOpen(!open)} title={t('You are {name}', { name: s.user.name })} aria-label={t('You are {name}', { name: s.user.name })} aria-haspopup="dialog" aria-expanded={open} data-testid="me">{s.user.name.trim()[0]?.toUpperCase()}</button>
      {open ? <MeEditor anchor={ref.current} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Your name and colour, as others see them: from your own button, or from More when the toolbar has no room for it. */
function MeEditor({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const t = useT();
  const s = session();
  const [name, setName] = useState(s.user.name);
  const save = () => {
    const n = name.trim() || s.user.name;
    s.user.name = n;
    saveUser(s.user);
    setLocalName(n, s.user.color);
  };
  return (
    <Popover anchor={anchor} side="below" width={220} onClose={() => { save(); onClose(); }} focus>
      <label className="stack me-form">
        <span className="param-label">{t('Your name, shown to others')}</span>
        <input className="token-input" dir="auto" value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { save(); onClose(); } }} />
      </label>
      <div className="me-colors">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
          const c = pickColor(i);
          return <button key={c} type="button" aria-label={t('Use colour {colour}', { colour: c })} className={`me-color${c === s.user.color ? ' is-active' : ''}`} style={{ background: c }} onClick={() => { s.user.color = c; saveUser(s.user); setLocalName(s.user.name, c); onClose(); }} />;
        })}
      </div>
    </Popover>
  );
}

function FileName() {
  const t = useT();
  const name = useEditor((s) => s.fileName);
  const fileId = useEditor((s) => s.fileId);
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        autoFocus
        dir="auto"
        className="file-rename"
        defaultValue={name}
        data-testid="file-rename"
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          setEditing(false);
          if (v && v !== name && fileId) {
            editor().set({ fileName: v });
            void api.renameFile(fileId, v);
            document.title = `${v} - Bogen`;
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { e.currentTarget.value = name; e.currentTarget.blur(); }
        }}
      />
    );
  }
  return <button type="button" className="file-name" onClick={() => setEditing(true)} title={t('Rename file')} dir="auto" data-testid="file-name">{name || t('Untitled')}</button>;
}

function UndoRedo() {
  const t = useT();
  const [, force] = useState(0);
  const s = session();
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    s.undo.on('stack-item-added', bump);
    s.undo.on('stack-item-popped', bump);
    // A switch of branch empties the stack (doc/branch-watch.ts).
    s.undo.on('stack-cleared', bump);
    return () => {
      s.undo.off('stack-cleared', bump);
      s.undo.off('stack-item-added', bump);
      s.undo.off('stack-item-popped', bump);
    };
  }, [s]);
  return (
    <>
      <IconButton icon={<Undo2 size={15} />} title={t('Undo ({shortcut})', { shortcut: 'Ctrl+Z' })} onClick={undo} disabled={!s.undo.canUndo()} testId="undo" />
      <IconButton icon={<Redo2 size={15} />} title={t('Redo ({shortcut})', { shortcut: 'Ctrl+Shift+Z' })} onClick={redo} disabled={!s.undo.canRedo()} testId="redo" />
    </>
  );
}

/** Tools that stay in the toolbar at each level; the rest are in More tools. */
const PRIMARY: Record<ToolbarLevel, Set<string> | null> = {
  full: null,
  tight: null,
  compact: new Set(['move', 'hand', 'frame', 'rect', 'text', 'pen', 'comment']),
  mini: new Set(['move', 'text', 'comment']),
  // The active tool shows on the More tools button itself.
  micro: new Set(),
};

interface ToolItem { id: string; icon: typeof Hand; title: string; keys: string; active: boolean; run: () => void }

function toolItems(tool: Tool): ToolItem[] {
  const pick = (t: (typeof TOOLS)[number]): ToolItem => ({ id: t.tool, icon: t.icon, title: t.title, keys: keyOf(t.cmd), active: tool === t.tool, run: () => editor().setTool(t.tool) });
  return [
    ...TOOLS.map(pick),
    { id: 'image', icon: ImageIcon, title: msg('Place image'), keys: keyOf('tool.image'), active: false, run: () => pickImage() },
    { id: 'app-screen', icon: Smartphone, title: msg('Import an app screen from Tomacco'), keys: '', active: false, run: openAppScreenBeside },
    { id: 'icons', icon: Shapes, title: msg('Icons'), keys: '', active: false, run: () => ui().set({ iconsOpen: true }) },
    ...TOOLS2.map(pick),
  ];
}

/** The tools the toolbar has no room for, in one menu, with their shortcuts. */
function MoreTools({ items }: { items: ToolItem[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const active = items.find((i) => i.active);
  const Icon = active?.icon ?? Ellipsis;
  return (
    <>
      <button ref={ref} type="button" className={`icon-btn${active || open ? ' is-active' : ''}`} title={active ? t('{tool}, and more tools', { tool: t(active.title) }) : t('More tools')} aria-label={t('More tools')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="tools-more">
        <Icon size={16} />
      </button>
      {open ? (
        <Popover anchor={ref.current} side="below" width={220} onClose={() => setOpen(false)} focus>
          <div role="menu" aria-label={t('More tools')} data-testid="tools-more-menu">
            {items.map((it) => (
              <button key={it.id} type="button" role="menuitem" className={`menu-item${it.active ? ' is-current' : ''}`} onClick={() => { setOpen(false); it.run(); }} data-testid={`tools-more-${it.id}`}>
                <span className="menu-with-icon"><it.icon size={13} /> {t(it.title)}</span><span className="menu-keys">{it.keys}</span>
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** What the toolbar's right side has no room for: the file, view and help commands, as one menu. */
function MoreMenu({ level, lay, branch, followed }: { level: ToolbarLevel; lay: ChromeLayout; branch: string | null; /** Someone followed while the toolbar has no room for its pill. */ followed: { name: string; color: string } | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const name = useEditor((s) => s.fileName);
  const people = useEditor((s) => s.peers);
  const followClientId = useEditor((s) => s.followClientId);
  const close = (run: () => void) => () => { setOpen(false); run(); };
  const zoom = level === 'mini' || level === 'micro';
  const micro = level === 'micro';
  const history = micro;
  return (
    <>
      <button ref={ref} type="button" className={`icon-btn${open ? ' is-active' : ''}${followed ? ' is-following' : ''}`} style={followed ? { color: followed.color } : undefined} title={t('More: preview, checks, settings, history, help')} aria-label={t('More')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="toolbar-more">
        <EllipsisVertical size={15} />
      </button>
      {open ? (
        <Popover anchor={ref.current} side="below" width={250} onClose={() => setOpen(false)} focus>
          <div role="menu" aria-label={t('More')} data-testid="toolbar-more-menu">
            <div className="menu-file" title={name} dir="auto" data-testid="toolbar-more-file">
              {name || t('Untitled')}
              {branch ? <span className="menu-branch" dir="auto" data-testid="toolbar-more-branch"><GitBranch size={12} aria-hidden="true" /> {branch}</span> : null}
            </div>
            {followed ? (
              <button type="button" role="menuitem" className="menu-item" onClick={close(stopFollowing)} data-testid="more-stop-following"><span className="menu-with-icon" style={{ color: followed.color }}><Eye size={13} /> {t('Stop following {name}', { name: followed.name })}</span></button>
            ) : null}
            {micro ? (
              <>
                <PanelMenuItem side="left" lay={lay} onDone={() => setOpen(false)} />
                <PanelMenuItem side="right" lay={lay} onDone={() => setOpen(false)} />
                {people.filter((p) => !followed || p.clientId !== followClientId).map((p) => (
                  <button key={p.clientId} type="button" role="menuitem" className="menu-item" onClick={close(() => editor().set({ followClientId: p.clientId }))} data-testid="more-follow"><span className="menu-with-icon"><span className="menu-me" style={{ background: p.user.color }} aria-hidden="true" /> {p.user.device ? t('Follow {name} on {device}', { name: p.user.name, device: p.user.device }) : t('Follow {name}', { name: p.user.name })}</span></button>
                ))}
                <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); setMe(true); }} data-testid="more-me"><span className="menu-with-icon"><span className="menu-me" style={{ background: session().user.color }} aria-hidden="true" /> {t('Your name, shown to others')}</span></button>
                <div className="menu-sep" />
              </>
            ) : null}
            {history ? (
              <>
                <button type="button" role="menuitem" className="menu-item" onClick={close(undo)} data-testid="more-undo"><span className="menu-with-icon"><Undo2 size={13} /> {t('Undo')}</span><span className="menu-keys">Ctrl+Z</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={close(redo)} data-testid="more-redo"><span className="menu-with-icon"><Redo2 size={13} /> {t('Redo')}</span><span className="menu-keys">Ctrl+Shift+Z</span></button>
                <div className="menu-sep" />
              </>
            ) : null}
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => runCommand('view.preview'))} data-testid="more-preview"><span className="menu-with-icon"><Play size={13} /> {t('Preview')}</span><span className="menu-keys">{keyOf('view.preview')}</span></button>
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => runCommand('view.checks'))} data-testid="more-checks"><span className="menu-with-icon"><ListChecks size={13} /> {t('Design checks')}</span></button>
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => openTab('right', { rightTab: 'history' }))} data-testid="more-history"><span className="menu-with-icon"><History size={13} /> {t('History and commits')}</span></button>
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => editor().set({ minimal: !editor().minimal }))} data-testid="more-minimal"><span className="menu-with-icon"><SlidersHorizontal size={13} /> {t('Hide panels')}</span><span className="menu-keys">{keyOf('view.minimal')}</span></button>
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => runCommand('view.settings'))} data-testid="more-settings"><span className="menu-with-icon"><Settings2 size={13} /> {t('Settings')}</span><span className="menu-keys">{keyOf('view.settings')}</span></button>
            {zoom ? (
              <>
                <div className="menu-sep" />
                <button type="button" role="menuitem" className="menu-item" onClick={close(() => fitScreen('screen'))} data-testid="more-fit-screen"><span>{t('Fit screen')}</span><span className="menu-keys">Shift+3</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={close(() => fitScreen('width'))} data-testid="more-fit-width"><span>{t('Fit width')}</span><span className="menu-keys">Shift+4</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={close(() => camera.zoomAt(1))} data-testid="more-zoom-100"><span>100%</span><span className="menu-keys">Shift+0</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={close(() => camera.zoomAt(nextZoomStop(camera.value.z, 1)))} data-testid="more-zoom-in"><span>{t('Zoom in')}</span><span className="menu-keys">+</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={close(() => camera.zoomAt(nextZoomStop(camera.value.z, -1)))} data-testid="more-zoom-out"><span>{t('Zoom out')}</span><span className="menu-keys">-</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={close(fitAll)} data-testid="more-fit"><span>{t('All screens')}</span><span className="menu-keys">Shift+1</span></button>
              </>
            ) : null}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => editor().set({ shortcutsOpen: true }))} data-testid="more-shortcuts"><span className="menu-with-icon"><Keyboard size={13} /> {t('Keyboard shortcuts')}</span><span className="menu-keys">{keyOf('view.shortcuts')}</span></button>
            <button type="button" role="menuitem" className="menu-item" onClick={close(() => void api.welcome().then(({ id }) => { location.hash = `#/file/${id}`; }))} data-testid="more-welcome"><span className="menu-with-icon"><DoorOpen size={13} /> {t('Welcome to Bogen')}</span></button>
            <a role="menuitem" className="menu-item" href="https://github.com/marselnenaj/bogen/blob/main/docs/guide/README.md" target="_blank" rel="noreferrer" onClick={() => setOpen(false)} data-testid="more-docs"><span className="menu-with-icon"><BookOpen size={13} /> {t('Documentation')}</span></a>
          </div>
        </Popover>
      ) : null}
      {me ? <MeEditor anchor={ref.current} onClose={() => setMe(false)} /> : null}
    </>
  );
}

/** The toolbar's content that decides its room: data the editor has anyway, never a measured width. */
function useToolbarLevel(lay: ChromeLayout, named: boolean, sync: boolean): ToolbarLevel {
  const { width } = useWindowSize();
  const scale = useSettings((s) => s.uiScale) || 1;
  const peers = useEditor((s) => s.peers.length);
  const following = useEditor((s) => s.peers.some((p) => p.clientId === s.followClientId));
  return fitToolbar(width / scale, { leftDrawer: lay.left === 'drawer', rightDrawer: lay.right === 'drawer', sync, peers, following, branchNamed: named }, lay.toolbar);
}

export function Toolbar() {
  const t = useT();
  const tool = useEditor((s) => s.tool);
  const prompt = useEditor((s) => s.prompt.open);
  const following = useEditor((s) => s.followClientId);
  const peers = useEditor((s) => s.peers);
  const followed = peers.find((p) => p.clientId === following);
  const lay = useChrome();
  const devices = useSyncPeers();
  const [branch, setBranch] = useState<{ named: boolean; name: string }>({ named: false, name: '' });
  const onBranch = useCallback((named: boolean, name: string) => setBranch((b) => (b.named === named && b.name === name ? b : { named, name })), []);
  const level = useToolbarLevel(lay, branch.named, devices.length > 0);
  const primary = PRIMARY[level];
  const items = toolItems(tool);
  const shown = primary ? items.filter((i) => primary.has(i.id)) : items;
  const overflow = primary ? items.filter((i) => !primary.has(i.id)) : [];
  const wide = level === 'full';
  const micro = level === 'micro';
  return (
    <header className="toolbar" data-testid="toolbar" data-level={level}>
      <div className="toolbar-left">
        <a className="icon-btn" href="#/" title={t('All files')} aria-label={t('All files')} data-testid="home-link"><ArrowLeft size={15} /></a>
        {micro ? null : <PanelToggle side="left" lay={lay} />}
        <FileName />
        <BranchMenu compact={level !== 'full' && level !== 'tight'} onLabel={onBranch} />
      </div>
      <div className="toolbar-center" role="toolbar" aria-label={t('Tools')}>
        {shown.map((it) => (it.id === 'icons'
          ? <IconPicker key="icons" />
          : <IconButton key={it.id} icon={<it.icon size={16} />} title={it.keys ? `${t(it.title)} (${it.keys})` : t(it.title)} active={it.active} onClick={it.run} testId={`tool-${it.id}`} />))}
        {overflow.length ? <MoreTools items={overflow} /> : null}
        {overflow.some((it) => it.id === 'icons') ? <IconPicker inline={false} /> : null}
      </div>
      <div className="toolbar-right">
        {followed && !micro ? (
          <button type="button" className="follow-pill" onClick={stopFollowing} title={t('Stop following {name}', { name: followed.user.name })} data-testid="follow-pill" style={{ color: followed.user.color }}><Eye size={13} /> <span className="follow-name">{t('Following {name}', { name: followed.user.name })}</span></button>
        ) : null}
        <SyncStatus peers={devices} />
        <Peers max={PEERS_SHOWN[level]} />
        {micro ? null : <Me />}
        {micro ? null : <span className="toolbar-sep" />}
        {micro ? null : <UndoRedo />}
        <IconButton icon={<Sparkles size={15} />} title={prompt ? t('Hide the chat ({shortcut})', { shortcut: 'Ctrl+Alt+3' }) : t('Chat with your agent ({shortcut})', { shortcut: 'Ctrl+K' })} active={prompt} onClick={toggleChat} testId="prompt-toggle" />
        {wide ? (
          <>
            <IconButton icon={<SlidersHorizontal size={15} />} title={t('Hide panels ({shortcut})', { shortcut: 'Ctrl+\\' })} onClick={() => editor().set({ minimal: !editor().minimal })} testId="minimal-toggle" />
            <IconButton icon={<Play size={15} />} title={t('Preview ({shortcut})', { shortcut: 'Ctrl+Alt+Enter' })} onClick={() => runCommand('view.preview')} testId="preview-open" />
            <IconButton icon={<ListChecks size={15} />} title={t('Design checks')} onClick={() => runCommand('view.checks')} testId="checks-open" />
            <IconButton icon={<Settings2 size={15} />} title={t('Settings ({shortcut})', { shortcut: 'Ctrl+,' })} onClick={() => runCommand('view.settings')} testId="settings-open" />
            <IconButton icon={<History size={15} />} title={t('History: changes and commits ({shortcut} to commit)', { shortcut: 'Ctrl+Alt+S' })} onClick={() => openTab('right', { rightTab: 'history' })} testId="toolbar-history" />
            <HelpMenu />
          </>
        ) : null}
        {micro ? null : <PanelToggle side="right" lay={lay} />}
        {wide ? null : <MoreMenu level={level} lay={lay} branch={branch.named && level !== 'tight' ? branch.name : null} followed={followed && micro ? { name: followed.user.name, color: followed.user.color } : null} />}
        {level === 'mini' || level === 'micro' ? null : <ZoomControl />}
      </div>
    </header>
  );
}
