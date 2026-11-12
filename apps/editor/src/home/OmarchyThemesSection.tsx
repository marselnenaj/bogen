import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Plus } from 'lucide-react';
import { agentApi, type InstalledTheme } from '../lib/agent-api.ts';
import { onServerEvent } from '../lib/events.ts';
import {
  branchCount, candidatesFor, fetchLibrary, groupCopies, inPlatform, installedRows, libraryRows, startTheme,
  type LibraryRow, type StartTheme, type ThemeCandidate, type ThemeLibrary, type ThemeProject, type ThemeStatus,
} from '../lib/theme-library.ts';
import { t } from '../i18n/store.ts';
import { useT } from '../i18n/react.ts';
import { formatDate } from '../i18n/format.ts';
import { ConsolidateCopies, ConsolidatedNotice } from './ConsolidateCopies.tsx';
import type { ConsolidatedNote } from '../lib/theme-consolidate.ts';
import '../styles/theme-library.css';

const OPEN_KEY = 'bogen-home-omarchy';
/** Rows shown before "Show all": the theme in use and the person's own come first. */
const FEW = 6;
/** The swatches of a new theme: Bogen's default palette, as the server starts it. */
const NEW_SWATCHES = ['#17151a', '#e6e0d6', '#e8a85c', '#e0685f', '#e8c15c', '#a3c26b', '#7aa5d8'];

function storedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function storeOpen(open: boolean): void {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* for this visit */ }
}

function facts(theme: InstalledTheme): string {
  const vars = { mode: theme.mode === 'dark' ? t('dark') : t('light') };
  const n = theme.backgrounds;
  if (theme.source === 'stock') return t.n(n, 'Stock, {mode}, {count} background', 'Stock, {mode}, {count} backgrounds', vars);
  if (theme.source === 'overlay') return t.n(n, 'Yours, over the stock one, {mode}, {count} background', 'Yours, over the stock one, {mode}, {count} backgrounds', vars);
  if (theme.fromRepo) return t.n(n, 'Installed from a repository, {mode}, {count} background', 'Installed from a repository, {mode}, {count} backgrounds', vars);
  return t.n(n, 'Yours, {mode}, {count} background', 'Yours, {mode}, {count} backgrounds', vars);
}

const openFile = (id: string) => { location.hash = `#/file/${id}`; };

function targetWord(target: 'desktop' | 'mobile'): string {
  return target === 'mobile' ? t('Mobile') : t('Desktop');
}

/** Target and branches of a project, in a few words. */
function projectFacts(p: ThemeProject): string {
  const parts = [targetWord(p.target)];
  const n = branchCount(p);
  if (p.branch.current !== 'main') parts.push(t('On {branch}', { branch: p.branch.current_name ?? p.branch.current }));
  if (n) parts.push(t.n(n, '{count} branch', '{count} branches'));
  return parts.join(' · ');
}

function Swatches({ colors }: { colors?: string[] }) {
  return (
    <span className="brand-swatches" aria-hidden="true">
      {colors?.length ? colors.map((c, i) => <span key={i} style={{ background: c }} />) : <span className="brand-swatch-empty" />}
    </span>
  );
}

/** The picture of a project: its installed theme's colours when it has one, else its saved preview, never a render. */
function ProjectMark({ project, colors }: { project: ThemeProject; colors?: string[] }) {
  if (colors?.length) return <Swatches colors={colors} />;
  if (project.thumbnail) return <span className="brand-swatches tl-thumb" aria-hidden="true"><img src={project.thumbnail} alt="" loading="lazy" decoding="async" draggable={false} /></span>;
  return <Swatches />;
}

function StatusChip({ status }: { status: ThemeStatus }) {
  const t = useT();
  return <span className={`tl-chip is-${status}`} data-testid="theme-status" data-status={status}>{status === 'in-use' ? t('In use') : status === 'installed' ? t('Installed') : t('Draft')}</span>;
}

/** Several of the person's themes could be the one asked for: they pick one, or start a separate new theme on purpose. */
export function ChooseTheme({ candidates, message, busy, onOpen, onNew, onCancel }: { candidates: ThemeCandidate[]; message?: string; busy: boolean; onOpen: (id: string) => void; onNew: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="tl-choose" role="group" aria-label={t('Choose a theme to open')} data-testid="theme-choose">
      <p className="tl-note" dir="auto">{message || t('Several of your themes could be this one. Open the one to continue, or start a separate new theme.')}</p>
      <ul className="tl-choose-list">
        {candidates.map((c) => (
          <li key={c.file_id} className="tl-choose-row" data-testid="theme-candidate" data-file-id={c.file_id}>
            <span className="tl-name" dir="auto">{c.name}</span>
            <span className="brand-facts">{[targetWord(c.target), c.folder, formatDate(c.updatedAt, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</span>
            <button type="button" className="btn" onClick={() => onOpen(c.file_id)} disabled={busy} data-testid="theme-candidate-open">{t('Open')}</button>
          </li>
        ))}
      </ul>
      <div className="tl-choose-actions">
        <button type="button" className="btn btn-quiet" onClick={onNew} disabled={busy} data-testid="theme-new-separate"><Plus size={13} /> {t('New separate theme')}</button>
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

/**
 * A theme. A known project opens directly. Copies of one theme that are not consolidated yet open none by themselves:
 * the row unfolds them, each with its own Open, since none is the canonical one until the person consolidates them.
 */
function ProjectRow({ row, colors, expanded, onToggle, allCopies, onConsolidated }: { row: LibraryRow; colors?: string[]; expanded: boolean; onToggle: () => void; allCopies: ThemeProject[]; onConsolidated: (done: ConsolidatedNote) => void }) {
  const t = useT();
  const copiesId = useId();
  const [bringing, setBringing] = useState(false);
  const { lead, group } = row;
  if (!group) {
    return (
      <div role="listitem" className="tl-item" data-testid="theme-project" data-file-id={lead.file_id} data-copies={1}>
        <div className="tl-row">
          <button type="button" className="tl-open" onClick={() => openFile(lead.file_id)} title={lead.file_name} data-testid="theme-project-open">
            <ProjectMark project={lead} colors={colors} />
            <span className="tl-name" dir="auto">{lead.name}</span>
            <StatusChip status={row.status} />
            <span className="brand-facts">{projectFacts(lead)}</span>
          </button>
        </div>
        {lead.merged_copies?.length ? (
          <>
            {/* The original copies stay files of their own, kept quietly under the theme until someone asks for them. */}
            <button type="button" className="btn btn-quiet tl-bring" onClick={onToggle} aria-expanded={expanded} aria-controls={copiesId} data-testid="theme-kept-copies-toggle">
              <span className="tl-expand" aria-hidden="true">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              {t.n(lead.merged_copies.length, '{count} copy kept', '{count} copies kept')}
              {lead.merged_copies.some((c) => c.changed_after) ? <span className="tl-chip is-copies">{t('Changed since')}</span> : null}
            </button>
            {expanded ? (
              <div id={copiesId} className="tl-copies" role="group" aria-label={t('Copies kept for {name}', { name: lead.name })} data-testid="theme-kept-copies">
                <p className="tl-note" data-testid="theme-merged-copies">
                  {t.n(lead.merged_copies.length, '{count} copy brought in as a branch; the file is kept.', '{count} copies brought in as branches; the files are kept.')}
                  {lead.merged_copies.some((c) => c.changed_after) ? ` ${t.n(lead.merged_copies.filter((c) => c.changed_after).length, '{count} of them changed after it was brought in: bring it in again to keep that work.', '{count} of them changed after they were brought in: bring them in again to keep that work.')}` : null}
                </p>
                {lead.merged_copies.map((c) => (
                  <div key={c.file_id} className="tl-copy" data-testid="theme-kept-copy" data-file-id={c.file_id}>
                    <span className="tl-name" dir="auto">{c.name}</span>
                    {c.changed_after ? <span className="tl-chip is-copies">{t('Changed since')}</span> : null}
                    <button type="button" className="btn btn-quiet" onClick={() => openFile(c.file_id)} aria-label={t('Open the kept copy {name}', { name: c.name })} data-testid="theme-kept-copy-open">{t('Open')}</button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }
  const label = group.label || lead.name;
  return (
    <div role="listitem" className="tl-item" data-testid="theme-project" data-group={group.key} data-copies={row.copies.length}>
      <div className="tl-row">
        <button type="button" className="tl-open" onClick={onToggle} aria-expanded={expanded} aria-controls={copiesId} title={expanded ? t('Hide the copies of {name}', { name: label }) : t('Show the copies of {name}', { name: label })} data-testid="theme-copies-toggle">
          <ProjectMark project={lead} colors={colors} />
          <span className="tl-name" dir="auto">{t.n(row.copies.length, '{name} · {count} copy', '{name} · {count} copies', { name: label })}</span>
          <span className="tl-chip is-copies">{t('Not consolidated')}</span>
          <span className="brand-facts">{targetWord(lead.target)}</span>
          <span className="tl-expand" aria-hidden="true">{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        </button>
      </div>
      {expanded ? (
        <div id={copiesId} className="tl-copies" role="group" aria-label={t('Copies of {name}', { name: label })} data-testid="theme-copies">
          <p className="tl-note">{t('These files are copies of one theme. None of them counts as the theme itself until you bring them together into one theme with branches; all of them are kept until then.')}</p>
          {bringing ? <ConsolidateCopies copies={allCopies} onDone={onConsolidated} onClose={() => setBringing(false)} /> : row.copies.map((c) => (
            <div key={c.file_id} className="tl-copy" data-testid="theme-copy" data-file-id={c.file_id}>
              <span className="tl-name" dir="auto">{c.file_name || c.name}</span>
              <StatusChip status={c.status} />
              <span className="brand-facts" dir="auto">{[projectFacts(c), c.folder, formatDate(c.updatedAt, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}</span>
              <button type="button" className="btn" onClick={() => openFile(c.file_id)} aria-label={t('Open {name}', { name: c.file_name || c.name })} data-testid="theme-copy-open">{t('Open')}</button>
            </div>
          ))}
          {!bringing && allCopies.length > 1 ? <button type="button" className="btn btn-quiet tl-bring" onClick={() => setBringing(true)} data-testid="theme-consolidate-start">{t('Bring these together…')}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  /** Home's chosen folder, null for all files. */
  folder?: string | null;
  /** Home's search. */
  query?: string;
  /** Home's kind platform for themes: 'desktop' or 'mobile', null for both. */
  platform?: string | null;
}

/**
 * Themes on Home: the person's Bogen theme projects, drafts included, one row per logical theme with its branches;
 * then the themes installed on this computer to start from. One request per visit and per change of the file list.
 * The theme on disk is only read.
 */
export function OmarchyThemesSection({ folder = null, query = '', platform = null }: Props) {
  // undefined: not answered yet; null: a server without the library.
  const [lib, setLib] = useState<ThemeLibrary | null | undefined>(undefined);
  const load = useCallback(() => {
    fetchLibrary().then(setLib).catch(() => setLib((l) => l ?? null));
  }, []);
  useEffect(() => {
    load();
    let timer = 0;
    const off = onServerEvent((e) => {
      if (e.t !== 'files') return;
      clearTimeout(timer);
      timer = window.setTimeout(load, 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);
  if (lib === undefined) return null;
  if (lib === null) return <InstalledOnly />;
  return <ThemeLibrarySection lib={lib} folder={folder} query={query} platform={platform} onChanged={load} />;
}

function ThemeLibrarySection({ lib, folder, query, platform, onChanged }: { lib: ThemeLibrary; folder: string | null; query: string; platform: string | null; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(storedOpen);
  const [allProjects, setAllProjects] = useState(false);
  const [allInstalled, setAllInstalled] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{ theme: string; candidates: ThemeCandidate[]; message?: string } | null>(null);
  const [consolidated, setConsolidated] = useState<ConsolidatedNote | null>(null);
  const rows = useMemo(() => libraryRows(lib, folder, query, platform), [lib, folder, query, platform]);
  const installed = useMemo(() => installedRows(lib.installed, query, platform), [lib.installed, query, platform]);
  const desktop = inPlatform('desktop', platform);
  const mobile = inPlatform('mobile', platform);
  const colorsOf = useMemo(() => new Map(lib.installed.map((i) => [i.name, i.swatches])), [lib.installed]);
  // Off Omarchy (a Mac, say) nothing here installs; the person's theme projects still open like any file.
  if (!lib.onOmarchy && !lib.projects.length) return null;
  const toggle = () => {
    setOpen(!open);
    storeOpen(!open);
  };
  const start = async (key: string, body: StartTheme) => {
    setBusy(key);
    setFailed(null);
    try {
      const out = await startTheme(body);
      if ('choose' in out) setChoosing({ theme: body.from ?? '', candidates: out.choose, ...(out.message ? { message: out.message } : {}) });
      else openFile(out.file_id);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const fromInstalled = (theme: ThemeLibrary['installed'][number]) => {
    setChoosing(null);
    if (theme.project_file_ids.length === 1) return openFile(theme.project_file_ids[0]!);
    if (theme.project_file_ids.length > 1) {
      const candidates = candidatesFor(lib.projects, theme.project_file_ids);
      if (candidates.length) return setChoosing({ theme: theme.name, candidates });
    }
    void start(theme.name, { from: theme.name, target: 'desktop' });
    return undefined;
  };
  const shownRows = allProjects ? rows : rows.slice(0, FEW);
  const shownInstalled = allInstalled ? installed : installed.slice(0, FEW);
  const screens = lib.screens.map((s) => `${s.width} × ${s.height}`).join(', ');
  const narrowed = folder !== null || Boolean(query.trim()) || Boolean(platform);
  return (
    <section className="examples omarchy-themes theme-library" data-testid="omarchy-themes" aria-label={t('Themes')}>
      <div className="brands-head tl-head">
        <button type="button" className="examples-toggle" onClick={toggle} aria-expanded={open} data-testid="omarchy-themes-toggle">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="brands-title">{t('Themes')}</span>
        </button>
        {lib.onOmarchy ? (
          <div className="tl-actions">
            {open && desktop ? <button type="button" className="btn btn-quiet" onClick={() => void start('new', { target: 'desktop', new_project: true })} disabled={busy !== null} data-testid="omarchy-theme-new" title={t('A palette of its own, backgrounds still to design')}>
              <Plus size={13} /> {busy === 'new' ? t('Laying out the previews…') : t('New theme')}
            </button> : null}
            {open && mobile ? <button type="button" className="btn btn-quiet" onClick={() => void start('mobile', { target: 'mobile', new_project: true })} disabled={busy !== null} data-testid="omarchy-theme-new-mobile" title={t('A theme for a phone running Omarchy Mobile, exported as a package with its own installer')}>
              <Plus size={13} /> {busy === 'mobile' ? t('Laying out the phone screens…') : t('New mobile theme')}
            </button> : null}
          </div>
        ) : null}
      </div>
      {failed ? <div className="examples-error" role="alert" data-testid="theme-error" dir="auto">{failed}</div> : null}
      {open ? (
        <>
          {consolidated ? <ConsolidatedNotice done={consolidated} onClose={() => setConsolidated(null)} /> : null}
          <div className="tl-sub" role="heading" aria-level={3}>{t('Your themes')}{rows.length ? <span className="tl-count">{rows.length}</span> : null}</div>
          {rows.length ? (
            <div className="example-list tl-list" role="list" aria-label={t('Your themes')} data-testid="theme-projects">
              {shownRows.map((row) => <ProjectRow key={row.key} row={row} colors={row.lead.slug ? colorsOf.get(row.lead.slug) : undefined} expanded={Boolean(expanded[row.key])} onToggle={() => setExpanded((x) => ({ ...x, [row.key]: !x[row.key] }))} allCopies={row.group ? groupCopies(lib.projects, row.group) : row.copies} onConsolidated={(done) => { setConsolidated(done); onChanged(); }} />)}
            </div>
          ) : (
            <p className="tl-note" data-testid="theme-projects-empty">{narrowed ? t('No theme of yours here.') : t('No theme projects yet. Start one from an installed theme below, or with New theme.')}</p>
          )}
          {rows.length > FEW ? <button type="button" className="omarchy-more" onClick={() => setAllProjects(!allProjects)} data-testid="theme-projects-all">{allProjects ? t('Show fewer') : t('Show all {count} themes', { count: rows.length })}</button> : null}
          {lib.onOmarchy && desktop ? (
            <>
              <div className="tl-sub" role="heading" aria-level={3}>
                {t('Start from an installed theme')}
                {screens ? <span className="omarchy-themes-hint">{t('Backgrounds at {screens}, from your screens', { screens })}</span> : null}
              </div>
              <div className="example-list tl-list" role="list" aria-label={t('Installed themes')} data-testid="theme-installed">
                {shownInstalled.map((theme) => (
                  <div key={theme.name} role="listitem" className="tl-item">
                    <button type="button" className="tl-open" onClick={() => fromInstalled(theme)} disabled={busy !== null} title={theme.project_file_ids.length ? t('{theme}: opens your Bogen project of it', { theme: theme.title }) : t('{theme}: starts a project from its colours, backgrounds and portrait compositions', { theme: theme.title })} data-testid="omarchy-theme-from" data-theme={theme.name}>
                      <Swatches colors={theme.swatches} />
                      <span className="tl-name" dir="auto">{theme.title}</span>
                      {theme.current ? <span className="omarchy-in-use">{t('In use')}</span> : null}
                      <span className="brand-facts">{busy === theme.name ? t('Copying its colours and backgrounds…') : facts(theme)}</span>
                      {theme.project_file_ids.length ? <span className="tl-has" title={t('Has a Bogen project')}><GitBranch size={12} aria-hidden="true" /> {t('Your project')}</span> : null}
                    </button>
                    {choosing?.theme === theme.name ? (
                      <ChooseTheme
                        candidates={choosing.candidates}
                        {...(choosing.message ? { message: choosing.message } : {})}
                        busy={busy !== null}
                        onOpen={openFile}
                        onNew={() => void start(theme.name, { from: theme.name, target: 'desktop', new_project: true })}
                        onCancel={() => setChoosing(null)}
                      />
                    ) : null}
                  </div>
                ))}
                {!installed.length ? <p className="tl-note">{t('No installed theme matches.')}</p> : null}
              </div>
              {installed.length > FEW ? <button type="button" className="omarchy-more" onClick={() => setAllInstalled(!allInstalled)} data-testid="omarchy-themes-all">{allInstalled ? t('Show fewer') : t('Show all {count} themes', { count: installed.length })}</button> : null}
            </>
          ) : null}
          {choosing && choosing.theme === '' ? (
            <ChooseTheme candidates={choosing.candidates} {...(choosing.message ? { message: choosing.message } : {})} busy={busy !== null} onOpen={openFile} onNew={() => void start('new', { target: 'desktop', new_project: true })} onCancel={() => setChoosing(null)} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * A server without the theme library: the installed themes only, as before. An installed theme made in Bogen opens
 * its own file again rather than a copy; any other starts a new file from its colours, backgrounds and verified
 * portrait compositions.
 */
function InstalledOnly() {
  const t = useT();
  const [data, setData] = useState<Awaited<ReturnType<typeof agentApi.omarchyThemes>> | null>(null);
  const [open, setOpen] = useState(storedOpen);
  const [all, setAll] = useState(false);
  const [making, setMaking] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    agentApi.omarchyThemes().then(setData).catch(() => setData(null));
  }, []);
  if (!data?.onOmarchy) return null;
  const toggle = () => {
    setOpen(!open);
    storeOpen(!open);
  };
  const make = (from: string | null, target: 'desktop' | 'mobile' = 'desktop') => {
    setMaking(target === 'mobile' ? 'mobile' : from ?? '');
    setFailed(null);
    void agentApi.createTheme({ ...(from ? { from } : {}), target }).then((out) => { location.hash = `#/file/${out.file_id}`; }).catch((e: Error) => setFailed(e.message)).finally(() => setMaking(null));
  };
  const themes = [...data.themes].sort((a, b) => Number(b.current) - Number(a.current) || Number(b.source !== 'stock') - Number(a.source !== 'stock') || a.title.localeCompare(b.title));
  const shown = all ? themes : themes.slice(0, FEW);
  const screens = data.screens.map((s) => `${s.width} × ${s.height}`).join(' and ');
  return (
    <section className="examples omarchy-themes" data-testid="omarchy-themes" aria-label={t('Design an Omarchy theme')}>
      <div className="brands-head">
        <button type="button" className="examples-toggle" onClick={toggle} aria-expanded={open} data-testid="omarchy-themes-toggle">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="brands-title">{t('Design an Omarchy theme')}</span>
        </button>
        {failed ? <span className="examples-error" role="alert">{failed}</span> : open && screens ? <span className="omarchy-themes-hint">{t('Backgrounds at {screens}, from your screens', { screens })}</span> : null}
      </div>
      {open ? (
        <>
          <div className="example-list" role="list">
            <button type="button" role="listitem" className="example-row is-new" onClick={() => make(null)} disabled={making !== null} data-testid="omarchy-theme-new">
              <span className="brand-swatches" aria-hidden="true">{NEW_SWATCHES.map((c) => <span key={c} style={{ background: c }} />)}</span>
              <span className="example-kind">{t('New theme')}</span>
              <span className="brand-facts">{making === '' ? t('Laying out the previews…') : t('A palette of its own, backgrounds still to design')}</span>
            </button>
            <button type="button" role="listitem" className="example-row is-new" onClick={() => make(null, 'mobile')} disabled={making !== null} data-testid="omarchy-theme-new-mobile" title={t('A theme for a phone running Omarchy Mobile, exported as a package with its own installer')}>
              <span className="brand-swatches" aria-hidden="true">{NEW_SWATCHES.map((c) => <span key={c} style={{ background: c }} />)}</span>
              <span className="example-kind">{t('New mobile theme')}</span>
              <span className="brand-facts">{making === 'mobile' ? t('Laying out the phone screens…') : t('{device}: lock, home, drawer, quick settings, {size}', { device: 'Pixel 9 Pro XL', size: '420 × 935' })}</span>
            </button>
            {shown.map((theme) => (
              <button key={theme.name} type="button" role="listitem" className="example-row" onClick={() => make(theme.name)} disabled={making !== null} title={t('{theme}: opens its Bogen file when it was made in Bogen, otherwise a new file from its colours, backgrounds and portrait compositions', { theme: theme.title })} data-testid="omarchy-theme-from" data-theme={theme.name}>
                <span className="brand-swatches" aria-hidden="true">{theme.swatches.map((c, i) => <span key={i} style={{ background: c }} />)}</span>
                <span className="example-kind">{theme.title}</span>
                <span className="brand-facts">{making === theme.name ? t('Copying its colours and backgrounds…') : facts(theme)}</span>
                {theme.current ? <span className="omarchy-in-use">{t('In use')}</span> : null}
              </button>
            ))}
          </div>
          {themes.length > FEW ? <button type="button" className="omarchy-more" onClick={() => setAll(!all)} data-testid="omarchy-themes-all">{all ? t('Show fewer') : t('Show all {count} themes', { count: themes.length })}</button> : null}
        </>
      ) : null}
    </section>
  );
}
