import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EllipsisVertical, Settings2, Shapes, Check, ChevronDown, ChevronRight, Copy, Download, Folder, FolderInput, FolderPlus, Layers, LayoutGrid, List, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, X } from 'lucide-react';
import { api, type FileEntry, type UpdateNote } from '../lib/api.ts';
import { phoneOrigin, useReachable } from '../lib/phone.ts';
import { setKept, useStoredFiles, type StoredFile } from '../doc/offline.ts';
import { onServerEvent } from '../lib/events.ts';
import { BrandsSection } from './BrandsSection.tsx';
import { ExamplesSection } from './ExamplesSection.tsx';
import { OmarchyThemesSection } from './OmarchyThemesSection.tsx';
import { ThemePresetItem } from './ThemePresetItem.tsx';
import '../styles/theme-library.css';
import { DropZone, FigmaDialog, importBogenFile, importResult, type Imported } from './HomeImport.tsx';
import { editor } from '../state/store.ts';
import { filesIn, folderTree, joinPath, nextSelection, parentOf, SORTS, sortFiles, type FolderNode, type SortKey } from './folders.ts';
import { canonicalFiles, fetchCollection, presetSource, unrepresentedPresets, type Collection, type CollectionPreset } from '../lib/theme-library.ts';
import { homeHeadLevel, textWidth } from './head-fit.ts';
import { useWindowSize } from '../state/chrome-layout.ts';
import { useSettings } from '../state/settings.ts';
import { IconButton, Popover, Segmented, SelectField } from '../ui/controls.tsx';
import { SettingsDialog } from '../panels/SettingsDialog.tsx';
import { ExtensionApproval } from '../panels/BrowserExtension.tsx';
import type { ProjectType } from '@bogen/core';
import { emptyKindTitle, filesOfKind, KindList, oneOf, platformLabel, ProjectMenu, ScopeLine, type KindScope } from './ProjectFilters.tsx';
import { ui } from '../state/ui.ts';
import { t } from '../i18n/store.ts';
import { useT } from '../i18n/react.ts';
import { formatDate } from '../i18n/format.ts';
import { editLink, locationName } from '../lib/recent-edits.ts';
import '../styles/recent-edits.css';

function when(at: number | string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('Just now');
  if (min < 60) return t.n(min, '{count} min ago', '{count} min ago');
  const hours = Math.floor(min / 60);
  if (hours < 24) return t.n(hours, '{count} h ago', '{count} h ago');
  const days = Math.floor(hours / 24);
  if (days < 7) return t.n(days, '{count} d ago', '{count} d ago');
  return formatDate(d, { year: 'numeric', month: 'short', day: 'numeric' });
}

type ViewMode = 'grid' | 'list';
interface HomePrefs { view: ViewMode; sort: SortKey; folder: string | null; kind: ProjectType | null; platform: string | null }

function loadPrefs(): HomePrefs {
  try {
    return { view: 'grid', sort: 'edited', folder: null, kind: null, platform: null, ...(JSON.parse(localStorage.getItem('bogen-home') ?? '{}') as Partial<HomePrefs>) };
  } catch {
    return { view: 'grid', sort: 'edited', folder: null, kind: null, platform: null };
  }
}

/** The menu of folders something can move to. */
function MoveMenu({ anchor, folders, onPick, onClose }: { anchor: HTMLElement | null; folders: string[]; onPick: (folder: string) => void; onClose: () => void }) {
  const t = useT();
  return (
    <Popover anchor={anchor} side="below" width={220} onClose={onClose}>
      <div data-testid="move-menu">
        <button type="button" className="menu-item" onClick={() => onPick('')} data-testid="move-to-root"><span className="menu-with-icon"><Layers size={13} /> {t('No folder')}</span></button>
        {folders.map((f) => (
          <button key={f} type="button" className="menu-item" onClick={() => onPick(f)} data-testid="move-to" data-folder-target={f} style={{ paddingLeft: 8 + (f.split('/').length - 1) * 12 }}>
            <span className="menu-with-icon" dir="auto"><Folder size={13} /> {f.split('/').at(-1)}</span>
          </button>
        ))}
        {!folders.length ? <div className="hint home-menu-hint">{t('No folders yet. Add one on the left.')}</div> : null}
      </div>
    </Popover>
  );
}

interface FileProps {
  file: FileEntry;
  view: ViewMode;
  selected: boolean;
  selecting: boolean;
  folders: string[];
  onChanged: () => void;
  onSelect: (id: string, range: boolean) => void;
  onDragStart: (e: React.PointerEvent, id: string) => void;
  /** On the phone: its stored copy, if any, and whether the computer is out of reach. */
  stored?: StoredFile;
  away?: boolean;
}

/** A theme project in the file grid: marked as one, with its branches, so that a theme reads as one project. */
function FileThemeLine({ theme, kept, badge }: { theme: NonNullable<FileEntry['theme']>; kept?: FileEntry[]; /** Only when the card does not already say its kind. */ badge: boolean }) {
  const t = useT();
  const n = theme.branches.filter((b) => b.id !== 'main').length;
  const on = theme.branch && theme.branch !== 'main' ? theme.branchName ?? theme.branch : null;
  if (!badge && !n && !kept?.length) return null;
  return (
    <span className="file-theme" data-testid="file-theme">
      {badge ? <span className="file-theme-badge">{t('Theme')}</span> : null}
      {n ? <span className="file-theme-branches" dir="auto" data-testid="file-theme-branches">{on ? t.n(n, 'On {branch}, {count} branch', 'On {branch}, {count} branches', { branch: on }) : t.n(n, '{count} branch', '{count} branches')}</span> : null}
      {kept?.length ? <span className="file-theme-branches" data-testid="file-theme-kept" title={kept.map((k) => k.name).join(', ')}>{t.n(kept.length, '{count} copy kept', '{count} copies kept')}</span> : null}
    </span>
  );
}

function FileItem({ file, view, selected, selecting, folders, onChanged, onSelect, onDragStart, stored, away }: FileProps) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [kindOpen, setKindOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const open = () => { location.hash = `#/file/${file.id}`; };
  const kind = file.project && file.project.type !== 'design' ? (file.project.platforms?.length ? t('{kind}: {platforms}', { kind: oneOf(file.project.type), platforms: file.project.platforms.map((p) => platformLabel(file.project!.type, p)).join(', ') }) : oneOf(file.project.type)) : null;
  const remove = async () => {
    await api.deleteFile(file.id);
    onChanged();
  };
  const press = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || selecting) {
      e.preventDefault();
      onSelect(file.id, e.shiftKey);
      return;
    }
    open();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      onSelect(file.id, e.shiftKey);
    }
  };
  return (
    <div className={`file${selected ? ' is-selected' : ''}${away && !stored ? ' is-away' : ''}`} title={away && !stored ? t('Not on this phone. It opens when the computer is back.') : undefined} role="listitem" data-theme-project={file.theme ? '' : undefined} data-testid="file" data-file-id={file.id} data-file-name={file.name} onPointerDown={(e) => onDragStart(e, file.id)} onKeyDown={onKey}>
      <button type="button" className={`file-check${selected ? ' is-on' : ''}`} role="checkbox" aria-checked={selected} aria-label={t('Select {name}', { name: file.name })} data-testid="file-check" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onSelect(file.id, e.shiftKey); }} />
      <button type="button" className="file-thumb" onClick={press} aria-label={t('Open {name}', { name: file.name })} data-testid="file-open">
        {file.thumbnail ? <img src={file.thumbnail} alt="" draggable={false} data-testid="file-thumbnail" /> : <span className="file-thumb-empty"><svg width={view === 'list' ? 14 : 28} height={view === 'list' ? 14 : 28} viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14C2 7.4 7.4 2 14 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></span>}
      </button>
      <div className="file-info">
        {renaming ? (
          <input
            autoFocus
            className="rename-input"
            defaultValue={file.name}
            data-testid="file-rename-input"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              setRenaming(false);
              if (v && v !== file.name) void api.renameFile(file.id, v).then(onChanged);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { e.currentTarget.value = file.name; e.currentTarget.blur(); }
            }}
          />
        ) : (
          <button type="button" className="file-title" onClick={press} title={file.name} tabIndex={-1} dir="auto">{file.name}</button>
        )}
        <span className="file-time">{stored?.kept ? t('On this phone · {time}', { time: when(file.updatedAt) }) : when(file.updatedAt)}</span>
        {file.lastEdit ? file.lastEdit.locations[0] ? <a className="file-recent" href={editLink(file.id, file.lastEdit.locations[0])} title={`${file.lastEdit.actor} · ${file.lastEdit.summary}`} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} data-testid="file-recent">{locationName(file.lastEdit.locations[0])}</a> : <span className="file-recent" title={file.lastEdit.actor} data-testid="file-recent">{file.lastEdit.summary}</span> : null}
        {kind ? <span className="file-kind" data-testid="file-kind" title={file.project?.source === 'person' ? t('You set this') : t('Read from the file')}>{kind}</span> : null}
        {file.theme ? <FileThemeLine theme={file.theme} badge={!kind} {...(file.keptCopies ? { kept: file.keptCopies } : {})} /> : null}
        {view === 'list' ? <span className="file-folder" dir="auto">{file.folder ?? ''}</span> : null}
        <button ref={menuRef} type="button" className="icon-btn file-more" title={t('More')} aria-label={t('More for {name}', { name: file.name })} onClick={() => setMenu(!menu)} data-testid="file-menu"><MoreHorizontal size={14} /></button>
      </div>
      {menu ? (
        <Popover anchor={menuRef.current} side="below" width={168} onClose={() => { setMenu(false); setConfirming(false); }}>
          <button type="button" className="menu-item" data-testid="file-action-rename" onClick={() => { setMenu(false); setRenaming(true); }}><span className="menu-with-icon"><Pencil size={13} /> {t('Rename')}</span></button>
          <a className="menu-item" href={`/api/files/${file.id}/download`} download data-testid="file-action-download" onClick={() => setMenu(false)}><span className="menu-with-icon"><Download size={13} /> {t('Download {extension}', { extension: '.bogen' })}</span></a>
          <button type="button" className="menu-item" data-testid="file-action-duplicate" onClick={() => { setMenu(false); void api.duplicateFile(file.id).then(onChanged); }}><span className="menu-with-icon"><Copy size={13} /> {t('Duplicate')}</span></button>
          <button type="button" className="menu-item" data-testid="file-action-move" onClick={() => { setMenu(false); setMoving(true); }}><span className="menu-with-icon"><FolderInput size={13} /> {t('Move to')}</span></button>
          <button type="button" className="menu-item" data-testid="file-action-kind" onClick={() => { setMenu(false); setKindOpen(true); }}><span className="menu-with-icon"><Shapes size={13} /> {t('Kind and platforms')}</span></button>
          {phoneOrigin ? <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked={Boolean(stored?.kept)} data-testid="file-action-keep" title={t('Kept files and their images open without the computer')} onClick={() => { setMenu(false); void setKept(file.id, !stored?.kept, file.name); }}><span className="menu-with-icon">{stored?.kept ? <Check size={13} /> : <span style={{ width: 13 }} />} {t('Keep on this phone')}</span></button> : null}
          <div className="menu-sep" />
          {confirming ? (
            <button type="button" className="menu-item is-danger" data-testid="file-action-delete-confirm" onClick={() => { setMenu(false); void remove(); }}><span className="menu-with-icon"><Trash2 size={13} /> {t('Delete for good')}</span></button>
          ) : (
            <button type="button" className="menu-item" data-testid="file-action-delete" onClick={() => setConfirming(true)}><span className="menu-with-icon"><Trash2 size={13} /> {t('Delete')}</span></button>
          )}
        </Popover>
      ) : null}
      {moving ? <MoveMenu anchor={menuRef.current} folders={folders} onClose={() => setMoving(false)} onPick={(f) => { setMoving(false); void api.moveFile(file.id, f).then(onChanged); }} /> : null}
      {kindOpen ? <ProjectMenu file={file} anchor={menuRef.current} onClose={() => setKindOpen(false)} onChanged={onChanged} /> : null}
    </div>
  );
}

function FolderRow({ node, depth, current, open, dropping, templateCounts, onOpen, onToggle, onChanged, onRequestNew }: { templateCounts: ReadonlyMap<string, number>; node: FolderNode; depth: number; current: string | null; open: Record<string, boolean>; dropping: string | null; onOpen: (path: string) => void; onToggle: (path: string) => void; onChanged: () => void; onRequestNew: (parent: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const isOpen = open[node.path] ?? false;
  const templates = templateCounts.get(node.path) ?? 0;
  const t = useT();
  return (
    <>
      <div className={`folder-row${current === node.path ? ' is-active' : ''}${dropping === node.path ? ' is-drop' : ''}`} role="treeitem" aria-selected={current === node.path} aria-level={depth + 1} aria-expanded={node.children.length ? isOpen : undefined} data-testid="folder-row" data-folder={node.path} style={{ paddingLeft: 4 + depth * 12 }}>
        {node.children.length ? <button type="button" className="layer-toggle" aria-label={isOpen ? t('Collapse') : t('Expand')} tabIndex={-1} onClick={() => onToggle(node.path)}>{isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="layer-toggle" />}
        {renaming ? (
          <input
            autoFocus
            className="rename-input"
            defaultValue={node.name}
            data-testid="folder-rename-input"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              setRenaming(false);
              const v = e.currentTarget.value.trim();
              if (v && v !== node.name) void api.renameFolder(node.path, joinPath(parentOf(node.path), v)).then(onChanged);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { e.currentTarget.value = node.name; e.currentTarget.blur(); }
            }}
          />
        ) : (
          <button type="button" className="folder-open" onClick={() => onOpen(node.path)}><Folder size={13} aria-hidden="true" /><span className="folder-name" dir="auto">{node.name}</span></button>
        )}
        {node.count + templates ? <span className="folder-count" title={templates ? `${t.n(node.count, '{count} file', '{count} files')} · ${t('Template')}: ${templates}` : undefined}>{node.count + templates}</span> : null}
        <button ref={ref} type="button" className="icon-btn folder-more" title={t('More')} aria-label={t('More for {name}', { name: node.name })} data-testid="folder-menu" onClick={() => setMenu(!menu)}><MoreHorizontal size={13} /></button>
      </div>
      {menu ? (
        <Popover anchor={ref.current} side="below" width={168} onClose={() => setMenu(false)}>
          <button type="button" className="menu-item" onClick={() => { setMenu(false); onRequestNew(node.path); }} data-testid="folder-action-new"><span className="menu-with-icon"><FolderPlus size={13} /> {t('New folder inside')}</span></button>
          <button type="button" className="menu-item" onClick={() => { setMenu(false); setRenaming(true); }} data-testid="folder-action-rename"><span className="menu-with-icon"><Pencil size={13} /> {t('Rename')}</span></button>
          <div className="menu-sep" />
          <button type="button" className="menu-item" onClick={() => { setMenu(false); void api.deleteFolder(node.path).then(onChanged); }} title={t('What is inside moves up one level')} data-testid="folder-action-delete"><span className="menu-with-icon"><Trash2 size={13} /> {t('Remove folder')}</span></button>
        </Popover>
      ) : null}
      {isOpen ? node.children.map((c) => <FolderRow key={c.path} node={c} depth={depth + 1} current={current} open={open} dropping={dropping} templateCounts={templateCounts} onOpen={onOpen} onToggle={onToggle} onChanged={onChanged} onRequestNew={onRequestNew} />) : null}
    </>
  );
}

/**
 * Home's header. Live site, the imports and the update note move into a More menu when the window (at the UI scale)
 * has no room for their labels in this language, and the new-file button becomes its icon after them.
 */
function HomeHead({ update, searchRef, query, setQuery, onFigma, onOpen, onCreate }: { update: UpdateNote | null; searchRef: React.RefObject<HTMLInputElement | null>; query: string; setQuery: (q: string) => void; onFigma: () => void; onOpen: () => void; onCreate: () => void }) {
  const t = useT();
  const { width } = useWindowSize();
  const scale = useSettings((s) => s.uiScale) || 1;
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const labels = {
    live: t('Live site'),
    figma: t('Import from Figma'),
    open: t('Open'),
    newFile: t('New file'),
    update: update ? t('Bogen {version} is available', { version: update.version }) : '',
  };
  const level = useMemo(() => homeHeadLevel(width / scale, {
    brand: textWidth('Bogen', 13, 600),
    live: textWidth(labels.live, 12.5),
    figma: textWidth(labels.figma, 13, 500),
    open: textWidth(labels.open, 13, 500),
    newFile: textWidth(labels.newFile, 13, 500),
    update: textWidth(labels.update, 13),
  }), [width, scale, labels.live, labels.figma, labels.open, labels.newFile, labels.update]);
  const full = level === 'full';
  const updateTitle = update ? t('This is {current}. Update with: {command}', { current: update.current, command: update.how }) : '';
  return (
    <header className="home-head" data-level={level} data-testid="home-head">
      <div className="home-brand"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14C2 7.4 7.4 2 14 2" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>{level === 'tight' ? <span className="visually-hidden">Bogen</span> : ' Bogen'}</div>
      {full && update ? <a className="home-update" data-testid="home-update" href={update.notes} target="_blank" rel="noreferrer" title={updateTitle}>{labels.update}</a> : null}
      {full ? <a className="home-live" href="#/live" data-testid="home-live" title={t('Open your dev server here, pick an element, and have your own agent edit the source')}>{labels.live}</a> : null}
      <label className="home-search">
        <Search size={14} />
        <input ref={searchRef} placeholder={t('Search files')} aria-label={t('Search files')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="home-search" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
      </label>
      {full ? <button type="button" className="btn btn-quiet" onClick={onFigma} data-testid="home-figma">{labels.figma}</button> : null}
      {full ? <button type="button" className="btn btn-quiet" onClick={onOpen} data-testid="home-open" title={t('Open a {extension} file', { extension: '.bogen' })}><Upload size={14} /> {labels.open}</button> : null}
      <button type="button" className={`btn btn-primary${level === 'tight' ? ' home-new-icon' : ''}`} onClick={onCreate} data-testid="home-new" title={t('New file ({shortcut})', { shortcut: 'N' })} aria-label={level === 'tight' ? labels.newFile : undefined}><Plus size={14} />{level === 'tight' ? null : ` ${labels.newFile}`}</button>
      {full ? null : (
        <>
          <button ref={moreRef} type="button" className={`icon-btn${more ? ' is-active' : ''}`} title={t('More')} aria-label={t('More')} aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)} data-testid="home-more"><EllipsisVertical size={15} /></button>
          {more ? (
            <Popover anchor={moreRef.current} side="below" width={250} onClose={() => setMore(false)} focus>
              <div role="menu" aria-label={t('More')} data-testid="home-more-menu">
                <a role="menuitem" className="menu-item" href="#/live" onClick={() => setMore(false)} title={t('Open your dev server here, pick an element, and have your own agent edit the source')} data-testid="home-more-live"><span>{labels.live}</span></a>
                <button type="button" role="menuitem" className="menu-item" onClick={() => { setMore(false); onFigma(); }} data-testid="home-more-figma"><span>{labels.figma}</span></button>
                <button type="button" role="menuitem" className="menu-item" onClick={() => { setMore(false); onOpen(); }} title={t('Open a {extension} file', { extension: '.bogen' })} data-testid="home-more-open"><span className="menu-with-icon"><Upload size={13} /> {labels.open}</span></button>
                {update ? <a role="menuitem" className="menu-item" href={update.notes} target="_blank" rel="noreferrer" title={updateTitle} onClick={() => setMore(false)} data-testid="home-more-update"><span>{labels.update}</span></a> : null}
              </div>
            </Popover>
          ) : null}
        </>
      )}
      <IconButton icon={<Settings2 size={15} />} title={t('Settings ({shortcut})', { shortcut: 'Ctrl+,' })} onClick={() => ui().set({ settingsOpen: true })} testId="home-settings" />
    </header>
  );
}

export function Home() {
  const t = useT();
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const openRef = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState<{ text: string; href: string } | null>(null);
  const openFiles = async (list: File[]) => {
    setImportError(null);
    setImportNote(null);
    const bogen = list.filter((f) => /\.bogen$/i.test(f.name));
    if (!bogen.length) {
      setImportError(list[0]?.name ? t('Only .bogen files open here, and {file} is not one.', { file: list[0].name }) : t('Only .bogen files open here, and that is not one.'));
      return;
    }
    let last: Imported | null = null;
    const notes: string[] = [];
    for (const file of bogen) {
      try {
        last = await importBogenFile(file);
        const { text } = importResult(last);
        if (text) notes.push(text);
      } catch (e) {
        setImportError((e as Error).message);
      }
    }
    if (!last) return;
    const result = importResult(last);
    if (bogen.length === 1 && !result.stay) {
      if (result.text) editor().showToast(result.text);
      location.hash = result.href;
    } else if (notes.length) setImportNote({ text: notes.join(' '), href: result.href });
  };
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [collection, setCollection] = useState<Collection | null>(null);
  const stored = useStoredFiles();
  const reachable = useReachable();
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<HomePrefs>(loadPrefs);
  const [selection, setSelection] = useState<string[]>([]);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [newIn, setNewIn] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ ids: string[]; x: number; y: number; over: string | null } | null>(null);
  const [moving, setMoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const suppressClick = useRef(false);
  const setPref = (patch: Partial<HomePrefs>) => setPrefs((p) => {
    const next = { ...p, ...patch };
    try { localStorage.setItem('bogen-home', JSON.stringify(next)); } catch { /* for this visit */ }
    return next;
  });

  const load = useCallback(() => {
    api.files().then((list) => {
      setFiles(list);
      setError(null);
    }).catch((err: Error) => setError(err.message));
    // A server without folders still shows files.
    api.folders().then((list) => { setFolders(list); setFoldersLoaded(true); }).catch(() => setFolders([]));
  }, []);

  // Quiet on purpose: one line in the header, only when the server's own check found a newer release.
  const [update, setUpdate] = useState<UpdateNote | null>(null);
  useEffect(() => {
    void api.status().then((st) => setUpdate(st.update ?? null), () => {});
  }, []);

  useEffect(() => {
    load();
    document.title = 'Bogen';
    return onServerEvent((e) => { if (e.t === 'files') load(); });
  }, [load]);

  const openWelcome = async () => {
    const { id } = await api.welcome();
    location.hash = `#/file/${id}`;
  };
  const create = async () => {
    const file = await api.createFile();
    const folder = loadPrefs().folder;
    if (folder) await api.moveFile(file.id, folder).catch(() => {});
    location.hash = `#/file/${file.id}`;
  };

  // A theme copy brought into another project lists with that project, not as a file of its own (theme-library.ts).
  const listed = useMemo(() => (files ? canonicalFiles(files) : null), [files]);
  const tree = useMemo(() => folderTree(folders, listed ?? []), [folders, listed]);
  // Folder and search first, then the kind: the kinds list counts what the folder and search leave.
  const inFolder = useMemo(() => filesIn(listed ?? [], prefs.folder, query), [listed, prefs.folder, query]);
  const scope: KindScope = { kind: prefs.kind ?? null, platform: prefs.platform ?? null };
  const visible = useMemo(() => sortFiles(filesOfKind(inFolder, scope), prefs.sort), [inFolder, prefs.kind, prefs.platform, prefs.sort]);
  /** A folder, a kind or a search is chosen: the files are what the person is looking for. */
  const narrowed = prefs.folder !== null || Boolean(scope.kind) || Boolean(query.trim());
  // Presets remain available in folders that contain theme projects, even with All kinds selected.
  const themeFolder = useMemo(() => prefs.folder !== null && filesIn(listed ?? [], prefs.folder, '').some((f) => f.theme || f.project?.type === 'omarchy-theme'), [listed, prefs.folder]);
  const showThemes = !narrowed || scope.kind === 'omarchy-theme' || (!scope.kind && themeFolder);
  const themeGrid = scope.kind === 'omarchy-theme' || (!scope.kind && themeFolder);
  const desktopPresets = themeGrid && scope.platform !== 'mobile';
  useEffect(() => {
    let live = true;
    fetchCollection().then((data) => { if (live) setCollection(data); }).catch(() => { if (live) setCollection(null); });
    return () => { live = false; };
  }, []);
  const availablePresets = collection?.available ? collection.presets : [];
  // Folder badges include the same starting points shown by a theme folder. Saved projects replace their presets.
  const folderTemplates = useMemo(() => {
    const result = new Map<string, number>();
    const themeFolders = new Set((listed ?? []).filter((f) => f.folder && (f.theme || f.project?.type === 'omarchy-theme')).map((f) => f.folder!));
    for (const path of themeFolders) {
      const inside = (listed ?? []).filter((f) => f.folder === path || f.folder?.startsWith(path + '/'));
      result.set(path, unrepresentedPresets(availablePresets, inside, '', null).length);
    }
    return result;
  }, [listed, collection]);
  const presets = useMemo(() => desktopPresets && collection?.available ? unrepresentedPresets(collection.presets, visible, query, scope.platform) : [], [desktopPresets, collection, visible, query, scope.platform]);
  const presetProjects = useMemo(() => new Set((listed ?? []).filter((f) => f.theme?.target === 'desktop').map((f) => f.theme?.from)), [listed]);
  const gridItems = useMemo(() => {
    type Item = { id: string; name: string; updatedAt: number | string; createdAt?: number | string } & ({ kind: 'file'; file: FileEntry } | { kind: 'preset'; preset: CollectionPreset });
    return sortFiles<Item>([
      ...visible.map((file): Item => ({ ...file, kind: 'file', file })),
      ...presets.map((preset): Item => ({ id: presetSource(preset.id), name: preset.name, updatedAt: 0, kind: 'preset', preset })),
    ], prefs.sort);
  }, [visible, presets, prefs.sort]);
  // A folder that went away, here or elsewhere, leaves nobody looking at nothing.
  useEffect(() => {
    if (prefs.folder && files && foldersLoaded && !tree.length && !folders.includes(prefs.folder)) setPref({ folder: null });
  }, [tree, folders, foldersLoaded, prefs.folder, files]);
  useEffect(() => {
    setSelection((s) => {
      const known = s.filter((id) => files?.some((f) => f.id === id));
      return known.length === s.length ? s : known;
    });
  }, [files]);

  const select = useCallback((id: string, range: boolean) => {
    if (suppressClick.current) return;
    setSelection((s) => nextSelection(visible.map((f) => f.id), s, id, anchor.current, range));
    anchor.current = id;
    setConfirmDelete(false);
  }, [visible]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      // Settings are this device's, not a file's: they open here as in the editor.
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        ui().set({ settingsOpen: true });
        return;
      }
      if ((e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === 'k')) && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'n' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        void create();
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        setSelection(visible.map((f) => f.id));
      }
      if (e.key === 'Escape') {
        setSelection([]);
        setConfirmDelete(false);
      }
      if (/^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        const buttons = [...document.querySelectorAll<HTMLElement>('[data-testid="file-open"]')];
        const at = buttons.indexOf(document.activeElement as HTMLElement);
        if (!buttons.length) return;
        const grid = document.querySelector('.file-grid');
        const perRow = prefs.view === 'list' ? 1 : Math.max(1, grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1);
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? perRow : -perRow;
        const next = buttons[at < 0 ? 0 : Math.max(0, Math.min(buttons.length - 1, at + step))];
        e.preventDefault();
        next?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, prefs.view]);

  // Files drag onto folders with the pointer, so that it works the same for one file or many.
  const onDragStart = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('input, .file-more, .file-check')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let over: string | null = null;
    const ids = selection.includes(id) ? selection : [id];
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      active = true;
      suppressClick.current = true;
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-folder]');
      over = row ? row.dataset.folder ?? '' : null;
      setDrag({ ids, x: ev.clientX, y: ev.clientY, over });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      if (active && over !== null) void Promise.all(ids.map((f) => api.moveFile(f, over!))).then(load);
      // The click that ends a drag opens nothing.
      setTimeout(() => { suppressClick.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [selection, load]);

  const addFolder = (name: string, parent: string) => {
    setNewIn(null);
    if (!name.trim()) return;
    const path = joinPath(parent, name);
    if (parent) setOpenFolders((o) => ({ ...o, [parent]: true }));
    void api.addFolder(path).then(load).catch((err: Error) => setError(err.message));
  };
  const bulkMove = (folder: string) => {
    setMoving(false);
    void Promise.all(selection.map((id) => api.moveFile(id, folder))).then(() => { setSelection([]); load(); });
  };
  const bulkDuplicate = () => void Promise.all(selection.map((id) => api.duplicateFile(id))).then(load);
  const bulkDelete = () => {
    if (!confirmDelete) return setConfirmDelete(true);
    setConfirmDelete(false);
    void Promise.all(selection.map((id) => api.deleteFile(id))).then(() => { setSelection([]); load(); });
    return undefined;
  };
  const crumbs = prefs.folder ? prefs.folder.split('/') : [];
  const selecting = selection.length > 0;
  const away = phoneOrigin && reachable === false;

  return (
    <div className={`home${drag ? ' is-dragging-files' : ''}`} data-testid="home" onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}>
      <HomeHead
        update={update}
        searchRef={searchRef}
        query={query}
        setQuery={setQuery}
        onFigma={() => setFigmaOpen(true)}
        onOpen={() => openRef.current?.click()}
        onCreate={() => void create()}
      />
      <input ref={openRef} type="file" accept=".bogen" multiple hidden data-testid="home-open-input" onChange={(e) => { const list = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; void openFiles(list); }} />
      <SettingsDialog />
      <ExtensionApproval />
      {away ? <div className="banner" role="status" data-testid="home-offline">{stored.size ? t.n(stored.size, 'Offline. {count} file is on this phone and open without the computer.', 'Offline. {count} files are on this phone and open without the computer.') : t('Offline. No files are on this phone yet.')}</div> : null}
      <div className="home-split">
        <nav className="home-side" aria-label={t('Folders')}>
          <div className="home-side-head">
            <span className="panel-title">{t('Folders')}</span>
            <IconButton icon={<FolderPlus size={14} />} title={t('New folder')} onClick={() => setNewIn(prefs.folder ?? '')} testId="folder-new" />
          </div>
          <div role="tree" aria-label={t('Folders')} className="home-tree">
            <div className={`folder-row${prefs.folder === null ? ' is-active' : ''}${drag?.over === '' ? ' is-drop' : ''}`} role="treeitem" aria-selected={prefs.folder === null} data-testid="folder-all" data-folder="" style={{ paddingLeft: 4 }}>
              <span className="layer-toggle" />
              <button type="button" className="folder-open" onClick={() => setPref({ folder: null })}><Layers size={13} aria-hidden="true" /><span className="folder-name">{t('All files')}</span></button>
              {listed?.length ? <span className="folder-count">{listed.length}</span> : null}
            </div>
            {tree.map((n) => <FolderRow key={n.path} node={n} depth={0} current={prefs.folder} open={openFolders} dropping={drag?.over ?? null} templateCounts={folderTemplates} onOpen={(path) => { setPref({ folder: path }); setSelection([]); }} onToggle={(path) => setOpenFolders((o) => ({ ...o, [path]: !o[path] }))} onChanged={load} onRequestNew={setNewIn} />)}
            {newIn !== null ? (
              <input
                autoFocus
                className="folder-new-input"
                placeholder={newIn ? t('New folder in {folder}', { folder: newIn.split('/').at(-1) ?? '' }) : t('New folder')}
                data-testid="folder-new-input"
                onBlur={(e) => addFolder(e.currentTarget.value, newIn)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur(); }
                }}
              />
            ) : null}
          </div>
          <div className="home-side-head home-kinds-head"><span className="panel-title">{t('Kinds')}</span></div>
          <KindList files={inFolder} scope={scope} presets={availablePresets} query={query} themeFolder={themeFolder} onScope={(s) => { setPref({ kind: s.kind, platform: s.platform }); setSelection([]); }} />
        </nav>
        <main className="home-body">
        <DropZone onFiles={(list) => void openFiles(list)}>
        {importError ? <div className="error" data-testid="home-import-error">{importError}</div> : null}
        {importNote ? (
          <div className="home-import-note" role="status" data-testid="home-import-note">
            <span dir="auto">{importNote.text}</span>
            <a className="btn" href={importNote.href} onClick={() => setImportNote(null)} data-testid="home-import-open">{t('Open')}</a>
            <IconButton icon={<X size={13} />} title={t('Close')} onClick={() => setImportNote(null)} />
          </div>
        ) : null}
          {/* Examples and brands introduce an unfiltered Home. Theme starts also stay visible in a theme scope. */}
          {!error && files && !narrowed ? <ExamplesSection fileCount={listed?.length ?? 0} /> : null}
          {!error && files && !narrowed ? <BrandsSection /> : null}
          {!error && files && showThemes && !themeGrid ? <OmarchyThemesSection folder={prefs.folder} query={query} platform={null} /> : null}
          <div className="home-tools">
            {selecting ? (
              <div className="bulk-bar" role="toolbar" aria-label={t('Selected files')} data-testid="bulk-bar">
                <IconButton icon={<X size={14} />} title={t('Clear the selection ({shortcut})', { shortcut: 'Esc' })} onClick={() => { setSelection([]); setConfirmDelete(false); }} testId="bulk-clear" />
                <span className="bulk-count" data-testid="bulk-count">{t.n(selection.length, '{count} selected', '{count} selected')}</span>
                <button ref={moveRef} type="button" className="btn btn-quiet" onClick={() => setMoving(true)} data-testid="bulk-move"><FolderInput size={14} /> {t('Move to')}</button>
                <button type="button" className="btn btn-quiet" onClick={bulkDuplicate} data-testid="bulk-duplicate"><Copy size={14} /> {t('Duplicate')}</button>
                <button type="button" className={`btn btn-quiet${confirmDelete ? ' is-danger' : ''}`} onClick={bulkDelete} data-testid="bulk-delete"><Trash2 size={14} /> {confirmDelete ? t.n(selection.length, 'Delete {count} for good', 'Delete {count} for good') : t('Delete')}</button>
                {moving ? <MoveMenu anchor={moveRef.current} folders={folders} onClose={() => setMoving(false)} onPick={bulkMove} /> : null}
              </div>
            ) : (
              <nav className="home-crumbs" aria-label={t('Where you are')} data-testid="home-crumbs">
                <button type="button" onClick={() => setPref({ folder: null })}>{t('All files')}</button>
                {crumbs.map((part, i) => (
                  <span key={i}><ChevronRight size={12} aria-hidden="true" /><button type="button" onClick={() => setPref({ folder: crumbs.slice(0, i + 1).join('/') })} dir="auto">{part}</button></span>
                ))}
              </nav>
            )}
            <span className="home-tools-gap" />
            <SelectField<SortKey> value={prefs.sort} options={SORTS.map((s) => ({ value: s.value, label: t(s.label) }))} onChange={(sort) => setPref({ sort })} title={t('Sort')} testId="home-sort" className="home-sort" />
            <div className="home-view"><Segmented<ViewMode> value={prefs.view} onChange={(view) => setPref({ view })} testId="home-view" options={[{ value: 'grid', icon: <LayoutGrid size={14} />, title: t('Grid') }, { value: 'list', icon: <List size={14} />, title: t('List') }]} /></div>
          </div>
          <ScopeLine folder={prefs.folder} query={query} scope={scope} shown={visible.length} templates={presets.length} onClear={() => { setPref({ kind: null, platform: null }); setQuery(''); }} />
          {error ? (
            <div className="home-empty">
              <div className="empty-title">{t('The server is not answering')}</div>
              <div className="empty-hint">{t.rich('Start it with {command}, then this page picks it up. {error}', { command: <code>bogen serve</code>, error })}</div>
              <button type="button" className="btn" onClick={load}>{t('Try again')}</button>
            </div>
          ) : null}
          {!error && files && !files.length && !presets.length ? (
            <div className="home-empty">
              <div className="empty-title">{t('No files yet')}</div>
              <div className="empty-hint">{t('Files live on this computer. Start one here, start from an example above, or ask your agent to draw something. The welcome file says how to connect it.')}</div>
              <div className="home-empty-actions">
                <button type="button" className="btn btn-primary" onClick={() => void create()}><Plus size={14} /> {t('New file')}</button>
                <button type="button" className="btn" onClick={() => void openWelcome()} data-testid="home-welcome">{t('Welcome to Bogen')}</button>
              </div>
            </div>
          ) : null}
          {!error && files && files.length > 0 && !gridItems.length ? (
            scope.kind && inFolder.length ? (
              <div className="home-empty" data-testid="home-kind-empty">
                <div className="empty-title">{emptyKindTitle(scope.kind, scope.platform)}</div>
                <div className="empty-hint">{scope.kind === 'brand'
                  ? t('Design files you mark as Brand system with More, Kind and platforms show here. Brands made with Bogen\'s brand tools are records of their own: they are in Brands below.')
                  : t('A file counts once you set its kind with More, Kind and platforms, or when it records it itself, as an Omarchy theme or a web page does.')}</div>
                <button type="button" className="btn" onClick={() => setPref({ kind: null, platform: null })}>{t('Show all kinds')}</button>
              </div>
            ) : query ? (
              <div className="home-empty">
                <div className="empty-title">{t('Nothing called "{query}"', { query })}</div>
                <button type="button" className="btn" onClick={() => setQuery('')}>{t('Clear the search')}</button>
              </div>
            ) : <div className="home-empty"><div className="empty-title">{t('This folder is empty')}</div><div className="empty-hint">{t('Drag files onto it from All files, or use Move to.')}</div></div>
          ) : null}
          <div className={prefs.view === 'list' ? 'file-list' : 'file-grid'} role="list" aria-label={t('Files')} data-testid="file-list">
            {gridItems.map((item) => item.kind === 'preset'
              ? <ThemePresetItem key={item.id} preset={item.preset} folder={prefs.folder} hasProject={presetProjects.has(presetSource(item.preset.id))} view={prefs.view} selecting={selecting} />
              : <FileItem key={item.id} file={item.file} view={prefs.view} selected={selection.includes(item.id)} selecting={selecting} folders={folders} onChanged={load} onSelect={select} onDragStart={onDragStart} stored={stored.get(item.id)} away={away} />)}
          </div>
          {!error && files && themeGrid ? <OmarchyThemesSection folder={prefs.folder} query={query} platform={scope.platform} /> : null}
          {/* Narrowed to brand systems, the records follow the files. Theme starts stay above the file list. */}
          {!error && files && narrowed && scope.kind === 'brand' ? <BrandsSection /> : null}
        </DropZone>
        </main>
        {figmaOpen ? <FigmaDialog onClose={() => setFigmaOpen(false)} onOpened={(id) => { setFigmaOpen(false); location.hash = `#/file/${id}`; }} /> : null}
      </div>
      {drag ? <div className="file-drag" style={{ left: drag.x + 10, top: drag.y + 10 }} data-testid="file-drag">{drag.ids.length === 1 ? files?.find((f) => f.id === drag.ids[0])?.name : t.n(drag.ids.length, '{count} file', '{count} files')}</div> : null}
    </div>
  );
}

export { IconButton };
