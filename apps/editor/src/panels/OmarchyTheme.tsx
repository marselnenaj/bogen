import { Fragment, useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Palette, Undo2, X } from 'lucide-react';
import { agentApi, type ThemeInfo } from '../lib/agent-api.ts';
import { downloadBlob } from '../lib/api.ts';
import { readProject } from '@bogen/core';
import { session } from '../doc/session.ts';
import { useFrameVersion, useTokens } from '../doc/hooks.ts';
import { onServerEvent } from '../lib/events.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, Segmented, TextField } from '../ui/controls.tsx';
import { isWallpaperProblem, OmarchyDisplays } from './OmarchyDisplays.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

const ICON_THEMES = ['Yaru', 'Yaru-blue', 'Yaru-magenta', 'Yaru-olive', 'Yaru-prussiangreen', 'Yaru-purple', 'Yaru-red', 'Yaru-sage', 'Yaru-wartybrown', 'Yaru-yellow'];

/** The banner, the Tokens tab button and the dialog each ask the server; a change made in one tells the others. */
const changed = new Set<() => void>();
const announce = () => { for (const fn of changed) fn(); };

/**
 * What the server knows about the open file as an Omarchy theme, refreshed when its tokens or the theme in use change.
 * Undefined until the server has answered, null for a file that is not a theme.
 */
function useThemeInfo(fileId: string | null): [ThemeInfo | null | undefined, () => void, boolean] {
  const [info, setInfo] = useState<ThemeInfo | null | undefined>(undefined);
  const [candidate, setCandidate] = useState(false);
  const [tick, setTick] = useState(0);
  // A token change reaches the server through sync a moment later, and colors.toml follows the tokens: ask again then.
  const tokens = useTokens();
  const [settled, setSettled] = useState(tokens);
  useEffect(() => {
    const t = setTimeout(() => setSettled(tokens), 600);
    return () => clearTimeout(t);
  }, [tokens]);
  useEffect(() => {
    if (!fileId) return setInfo(null);
    let live = true;
    void agentApi.themeInfo(fileId).then((r) => {
      if (!live) return;
      setInfo(r.theme);
      setCandidate(Boolean(r.candidate));
    }, () => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [fileId, tick, settled]);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    changed.add(bump);
    const off = onServerEvent((e) => { if (e.t === 'theme') bump(); });
    return () => { changed.delete(bump); off(); };
  }, []);
  return [info, announce, candidate];
}

/** A quiet line over the canvas of a theme file, with the way to export, install and apply it. */
export function OmarchyThemeBanner() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const fileName = useEditor((s) => s.fileName);
  const open = useUi((s) => s.omarchyThemeOpen);
  useFrameVersion();
  const project = readProject(session().doc);
  const [info, refresh, candidate] = useThemeInfo(project.type === 'omarchy-theme' ? fileId : null);
  const [busy, setBusy] = useState(false);
  if (project.type !== 'omarchy-theme') return null;
  if (!info && candidate && fileId && project.source === 'person') {
    // The palette alone does not say what the file is for: the person says it, once.
    const adopt = (target: 'desktop' | 'mobile') => {
      setBusy(true);
      void agentApi.adoptTheme(fileId, { name: (fileName || 'Theme').replace(/ · .*$/, '').slice(0, 64), target }).then(refresh, (e: Error) => editor().showToast(e.message)).finally(() => setBusy(false));
    };
    return (
      <div className="banner banner-info omarchy-banner" role="status" data-testid="omarchy-theme-candidate">
        <Palette size={13} />
        <span>{t('Theme')}: {fileName}</span>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => adopt('desktop')} data-testid="omarchy-adopt-desktop">{t('Make it a desktop theme')}</button>
        <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => adopt('mobile')} data-testid="omarchy-adopt-mobile">{t('Make it a mobile theme')}</button>
      </div>
    );
  }
  if (!info) return null;
  const what = info.target === 'mobile' ? (info.profile?.device ? t('Mobile theme for {device}', { device: info.profile.device }) : t('Mobile theme for a phone')) : t('Omarchy theme');
  return (
    <div className="banner banner-info omarchy-banner" role="status" data-testid="omarchy-theme-banner" data-target={info.target}>
      <Palette size={13} />
      <span>{t.rich(info.target === info.host && info.installed ? (info.apply.current === info.slug ? '{what} {name}, installed, in use' : '{what} {name}, installed') : info.target === info.host && info.apply.current === info.slug ? '{what} {name}, in use' : '{what} {name}', { what, name: <b>{info.name}</b> })}</span>
      <button type="button" className="btn btn-quiet" onClick={() => ui().set({ omarchyThemeOpen: !open })} data-testid="omarchy-theme-open">{info.target === info.host ? t('Export, install, apply') : t('Export the phone package')}</button>
    </div>
  );
}

export function OmarchyThemeDialog() {
  const open = useUi((s) => s.omarchyThemeOpen);
  return open ? <Body /> : null;
}

type Busy = null | 'tar' | 'pick' | 'folder' | 'install' | 'apply' | 'undo';

/** The browser writes into a folder the person picks, where it can. Chromium can; the Bogen window is Chromium. */
const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function writeIntoPicked(slug: string, files: { path: string; data: string }[]): Promise<string> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  const parent = await picker({ id: 'omarchy-theme', mode: 'readwrite' });
  const root = await parent.getDirectoryHandle(slug, { create: true });
  for await (const _ of (root as unknown as { keys: () => AsyncIterable<string> }).keys()) throw new Error(t('{folder} has files in it already. Pick another folder: an export never writes over other files.', { folder: `${parent.name}/${slug}` }));
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(parts.at(-1)!, { create: true });
    const out = await handle.createWritable();
    await out.write(Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
    await out.close();
  }
  return `${parent.name}/${slug}`;
}

function Body() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [info, refresh] = useThemeInfo(fileId);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [dir, setDir] = useState('');
  const [dirTouched, setDirTouched] = useState(false);
  const [git, setGit] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const close = () => ui().set({ omarchyThemeOpen: false });
  const loaded = info !== undefined;
  useEffect(() => { if (loaded) ref.current?.querySelector<HTMLElement>('input, button')?.focus(); }, [loaded]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', key, true);
    const toRestore = back.current;
    return () => {
      window.removeEventListener('keydown', key, true);
      if (toRestore instanceof HTMLElement && toRestore.isConnected) toRestore.focus();
    };
  }, []);
  // The folder follows the theme's name until the person types one: omarchy-<name>-theme is what `omarchy theme install` expects of a repository.
  useEffect(() => { if (info?.slug && !dirTouched) setDir(`~/omarchy-${info.slug}-theme`); }, [info?.slug]);

  const run = async (what: Busy, fn: () => Promise<string | void>) => {
    if (!fileId) return;
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const said = await fn();
      if (said) setNote(said);
      refresh();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const patch = (p: { name?: string; mode?: 'dark' | 'light'; icons?: string | null }) => run(null, async () => { await agentApi.updateTheme(fileId!, p); });

  if (info === undefined) return null;
  if (!info) {
    return (
      <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div ref={ref} className="dialog settings omarchy-dialog" role="dialog" aria-modal="true" aria-label={t('Omarchy theme')} data-testid="omarchy-theme-dialog">
          <header className="dialog-head settings-head"><span className="settings-title">{t('Omarchy theme')}</span><IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} /></header>
          <div className="settings-body"><p className="settings-hint omarchy-pad">{t('This file is not an Omarchy theme. Make one from the home screen, under Design an Omarchy theme, or import your palette in the Tokens tab.')}</p></div>
        </div>
      </div>
    );
  }

  const slug = info.slug ?? '';
  const mobile = info.target === 'mobile';
  const here = info.target === info.host;
  const archive = mobile ? `${slug}-mobile.tar.gz` : `${slug}.tar.gz`;
  const applied = info.apply.applied === slug && info.apply.current === slug;
  const canUndo = Boolean(info.apply.applied && info.apply.previous && info.apply.current === info.apply.applied);
  const sizes = [...new Set(info.backgrounds.map((b) => (b.kept ? t('as loaded') : `${b.width} × ${b.height}`)))].join(', ');

  const install = (overwrite: boolean) => run('install', async () => {
    const out = await agentApi.installTheme(fileId!, overwrite);
    setConfirm(false);
    const said = out.replaced ? t('Replaced in {dir}.', { dir: out.dir }) : t('Installed in {dir}.', { dir: out.dir });
    return out.overStock ? `${said} ${t('It goes over the stock {theme}, whose own files stay where this one has none.', { theme: out.name })}` : said;
  });

  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} className="dialog settings omarchy-dialog" role="dialog" aria-modal="true" aria-label={t('Omarchy theme')} data-testid="omarchy-theme-dialog">
        <header className="dialog-head settings-head">
          <span className="settings-title">{t('Omarchy theme')}</span>
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="omarchy-theme-close" />
        </header>
        <div className="settings-body">
          <div className="settings-row">
            <div><div className="settings-name">{t('Name')}</div><div className="settings-hint">{info.from ? t.rich('Its folder is {folder}, started from {from}', { folder: <code>{slug || t('not a valid name')}</code>, from: info.from }) : t.rich('Its folder is {folder}', { folder: <code>{slug || t('not a valid name')}</code> })}</div></div>
            <div className="settings-control"><TextField value={info.name} onChange={(name) => void patch({ name })} testId="omarchy-theme-name" /></div>
          </div>
          <div className="settings-row">
            <div><div className="settings-name">{t('Mode')}</div><div className="settings-hint">{t('Light or dark, for apps that ask')}</div></div>
            <div className="settings-control"><Segmented<'dark' | 'light'> value={info.mode} onChange={(mode) => void patch({ mode })} testId="omarchy-theme-mode" options={[{ value: 'dark', label: t('Dark'), title: t('A dark theme') }, { value: 'light', label: t('Light'), title: t('A light theme') }]} /></div>
          </div>
          <div className="settings-row">
            <div><div className="settings-name">{t('Icons')}</div><div className="settings-hint">{info.iconsFollowAccent ? t('Follows the accent') : t('Chosen by hand')}</div></div>
            <div className="settings-control">
              <label className="field field-select">
                <select className="field-input" value={info.iconsFollowAccent ? '' : info.icons} data-testid="omarchy-theme-icons" onChange={(e) => void patch({ icons: e.target.value || null })} onKeyDown={(e) => e.stopPropagation()}>
                  <option value="">{info.iconsFollowAccent ? info.icons : t('Follow the accent')}</option>
                  {ICON_THEMES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
          </div>

          {!mobile && fileId ? <OmarchyDisplays fileId={fileId} info={info} onChanged={refresh} /> : null}

          <section className="omarchy-section" data-testid="omarchy-theme-files">
            <div className="settings-name">{t('What the folder holds')}</div>
            <dl className="omarchy-files">
              <dt>colors.toml</dt><dd>{t.n(info.keys, '{count} keys, {mode}', '{count} keys, {mode}', { mode: info.mode === 'dark' ? t('dark') : t('light') })}</dd>
              <dt>backgrounds/</dt><dd>{info.backgrounds.length ? `${info.backgrounds.length}: ${sizes}` : t('none yet')}</dd>
              <dt>preview.png</dt><dd>{info.previews.desktop ? t('for the theme picker, {width} wide', { width: 1800 }) : t('none')}</dd>
              <dt>unlock.png, preview-unlock.png</dt><dd>{info.previews.unlock ? t('the boot unlock screen') : t('none')}</dd>
              <dt>icons.theme, README.md</dt><dd>{info.icons}</dd>
              {!mobile && (info.displays.length > 1 || info.wallpapers.length) ? <><dt>displays/</dt><dd>{t('{displays}, {compositions}; not used by Omarchy', { displays: t.n(info.displays.length - 1, '{count} more display preview', '{count} more display previews'), compositions: t.n(info.wallpapers.length, '{count} composition', '{count} compositions') })}</dd></> : null}
              <dt>shell.toml</dt><dd>{info.shellRoles ? t.n(info.shellRoles, '{count} shell surfaces', '{count} shell surfaces') : t('none: this file is from before shell surfaces')}</dd>
              {info.videos.length ? <><dt>{t('videos')}</dt><dd>{t('{intro} intro, {loop} looping', { intro: info.videos.filter((v) => v.kind === 'intro').length, loop: info.videos.filter((v) => v.kind === 'loop').length })}</dd></> : null}
            </dl>
            <div className="settings-hint">{t.n(Math.max(0, info.generated.length - 2), 'Omarchy writes {files} and {count} more from colors.toml when the theme is applied.', 'Omarchy writes {files} and {count} more from colors.toml when the theme is applied.', { files: info.generated.slice(0, 2).join(', ') })}</div>
            {/* The Displays section shows each wallpaper's state, so its problems are not repeated here. */}
            {info.problems.filter((p) => mobile || !isWallpaperProblem(p)).map((p) => <div key={p} className="error">{p}</div>)}
          </section>


          {info.videos.length ? (
            <section className="omarchy-section" data-testid="omarchy-theme-videos">
              <div className="settings-name">{t('Videos')}</div>
              <ul className="omarchy-list">
                {info.videos.map((v) => (
                  <li key={v.name}>
                    <code>{v.name}</code> {v.kind === 'intro' ? (v.still ? t('intro for {still}', { still: v.still.replace(/^Background \d+ · /, '') }) : t('intro, no still')) : t('looping wallpaper')}
                    {v.durationS !== undefined ? `, ${t('{seconds} s', { seconds: v.durationS })}` : ''}{v.hasAudio ? `, ${t('has sound')}` : ''}
                    {v.advice.map((a) => <div key={a} className="settings-hint">{a}</div>)}
                  </li>
                ))}
              </ul>
              <div className="settings-hint">{t('Shown as their still here; Omarchy plays an intro when the theme is switched to.')}</div>
            </section>
          ) : null}

          {mobile && info.coverage ? (
            <section className="omarchy-section" data-testid="omarchy-theme-coverage">
              <div className="settings-name">{t('On the phone · {device}, {size}', { device: info.profile?.device ?? '', size: info.profile?.logical ?? '' })}</div>
              <dl className="omarchy-files">
                {info.coverage.map((c) => (
                  <Fragment key={c.surface}>
                    <dt>{c.surface}</dt>
                    <dd className={`coverage-${c.status}`}>{c.status === 'themed' ? t('Themed') : c.status === 'generated' ? t('Written when applied') : c.status === 'unverified' ? t('Carried, not verified') : t('A theme cannot change this')} · {c.via}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ) : null}

          <section className="omarchy-section">
            <div className="settings-name">{t('Export')}</div>
            <div className="omarchy-actions">
              <button type="button" className="btn" disabled={busy !== null || !slug} data-testid="omarchy-export-tar" onClick={() => void run('tar', async () => {
                downloadBlob(await agentApi.exportThemeTar(fileId!), archive);
                return mobile ? t('Downloaded {archive}. On the phone: {extract}, then {dryRun} inside it.', { archive, extract: `tar -xzf ${archive}`, dryRun: './install.sh --dry-run' }) : t('Downloaded {archive}.', { archive });
              })}><Download size={14} /> {busy === 'tar' ? t('Rendering') : mobile ? t('Download the phone package') : t('Download {ext}', { ext: '.tar.gz' })}</button>
              {canPickFolder ? <button type="button" className="btn" disabled={busy !== null || !slug} data-testid="omarchy-export-pick" onClick={() => void run('pick', async () => {
                const out = await agentApi.exportThemeFiles(fileId!);
                const where = await writeIntoPicked(out.slug, out.files);
                return t.n(out.files.length, 'Wrote {count} files to {dir}.', 'Wrote {count} files to {dir}.', { dir: where });
              })}><FolderOpen size={14} /> {busy === 'pick' ? t('Rendering') : t('Choose a folder…')}</button> : null}
            </div>
            <div className="omarchy-folder">
              <TextField value={dir} onChange={(v) => { setDir(v); setDirTouched(true); }} live label={t('Folder')} testId="omarchy-export-dir" />
              <label className="omarchy-check"><input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} data-testid="omarchy-export-git" /> {t('Git repository')}</label>
              <button type="button" className="btn" disabled={busy !== null || !slug || !dir.trim()} data-testid="omarchy-export-folder" onClick={() => void run('folder', async () => {
                const out = await agentApi.exportThemeFolder(fileId!, dir.trim(), git);
                return out.git ? t.n(out.files.length, 'Wrote {count} files to {dir}, committed.', 'Wrote {count} files to {dir}, committed.', { dir: out.dir }) : t.n(out.files.length, 'Wrote {count} files to {dir}.', 'Wrote {count} files to {dir}.', { dir: out.dir });
              })}>{busy === 'folder' ? t('Rendering') : t('Export')}</button>
            </div>
            <div className="settings-hint">{t.rich('To share it, push that repository as {repo}. Others install it with {command} and its URL.', { repo: <code>omarchy-{slug}-theme</code>, command: <code>omarchy theme install</code> })}</div>
          </section>

          {!here ? (
            <section className="omarchy-section" data-testid="omarchy-theme-elsewhere">
              <div className="settings-name">{mobile ? t('Install it on the phone') : t('Not for this device')}</div>
              <div className="settings-hint">
                {mobile
                  ? t.rich('This computer does not install or apply a mobile theme. Copy the package to the phone, then run {dryRun}, {install} and {apply} there. {rollback} goes back.', { dryRun: <code>./install.sh --dry-run</code>, install: <code>./install.sh</code>, apply: <code>./install.sh --apply</code>, rollback: <code>./install.sh --rollback</code> })
                  : t('This is an Omarchy Mobile phone, and this is a desktop theme. Make a mobile theme for this phone instead.')}
              </div>
            </section>
          ) : null}
          {here ? <section className="omarchy-section">
            <div className="settings-name">{t('On this computer')}</div>
            <div className="omarchy-actions">
              <button type="button" className="btn" disabled={busy !== null || !slug} data-testid="omarchy-install" onClick={() => (info.installed ? setConfirm(true) : void install(false))}>
                {busy === 'install' ? t('Installing') : info.installed ? t('Install again') : t('Install')}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy !== null || !info.installed || applied} data-testid="omarchy-apply" title={info.installed ? t('Runs {command}', { command: `omarchy theme set ${slug}` }) : t('Install it first')} onClick={() => void run('apply', async () => {
                const out = await agentApi.applyTheme(slug);
                const said = t('Applied {theme}.', { theme: out.applied });
                return out.previous ? `${said} ${t('Undo goes back to {theme}.', { theme: out.previous })}` : said;
              })}>{busy === 'apply' ? t('Applying') : applied ? t('In use') : t('Apply')}</button>
              {canUndo ? <button type="button" className="btn btn-quiet" disabled={busy !== null} data-testid="omarchy-undo-apply" onClick={() => void run('undo', async () => t('Back to {theme}.', { theme: (await agentApi.undoApplyTheme()).restored }))}>
                <Undo2 size={14} /> {busy === 'undo' ? t('Going back') : t('Undo apply (back to {theme})', { theme: info.apply.previous ?? '' })}
              </button> : null}
            </div>
            {confirm ? (
              <div className="omarchy-confirm" role="alertdialog" aria-label={t('Replace the installed theme')} data-testid="omarchy-confirm">
                <span>{info.installedFromRepo ? t('{theme} is installed already, from a Git repository. Replace its files with this design?', { theme: slug }) : t('{theme} is installed already. Replace its files with this design?', { theme: slug })}</span>
                <span className="omarchy-actions">
                  <button type="button" className="btn btn-danger" onClick={() => void install(true)} data-testid="omarchy-confirm-replace">{t('Replace')}</button>
                  <button type="button" className="btn btn-quiet" onClick={() => setConfirm(false)} data-testid="omarchy-confirm-keep">{t('Keep it')}</button>
                </span>
              </div>
            ) : null}
            <div className="settings-hint">
              {info.overStock ? t.rich('Goes to {path}, over the stock theme of that name.', { path: <code>~/.config/omarchy/themes/{slug}</code> }) : t.rich('Goes to {path}.', { path: <code>~/.config/omarchy/themes/{slug}</code> })}{' '}
              {info.apply.current && !applied ? t.rich('Apply runs {command}; Undo goes back to {theme}.', { command: <code>omarchy theme set {slug}</code>, theme: info.apply.current }) : t.rich('Apply runs {command}.', { command: <code>omarchy theme set {slug}</code> })}
            </div>
          </section> : null}
          {note ? <div className="omarchy-note" role="status" data-testid="omarchy-note">{note}</div> : null}
          {error ? <div className="error" role="alert" data-testid="omarchy-error">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** Tokens tab: opens the dialog in a theme file. */
export function OmarchyThemeButton() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  useFrameVersion();
  const project = readProject(session().doc);
  const [info] = useThemeInfo(project.type === 'omarchy-theme' ? fileId : null);
  if (!info) return null;
  return <button type="button" className="btn btn-quiet" data-testid="token-omarchy-theme" onClick={() => ui().set({ omarchyThemeOpen: true })}><Palette size={14} /> {t('Export or install {name}', { name: info.name })}</button>;
}

/** For the command palette. */
export function openOmarchyTheme(): void {
  if (editor().fileId) ui().set({ omarchyThemeOpen: true });
}
