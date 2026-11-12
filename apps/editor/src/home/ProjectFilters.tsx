import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { inScope, PLATFORMS, PROJECT_TYPES, type ProjectType } from '@bogen/core';
import { api, type FileEntry } from '../lib/api.ts';
import { unrepresentedPresets, type CollectionPreset } from '../lib/theme-library.ts';
import { Popover } from '../ui/controls.tsx';
import { msg } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';
import { useT } from '../i18n/react.ts';

/**
 * Kinds of files beside the folders: what a file is a design for. Folders, kinds, search and sort work together; the
 * counts include the files the folder and search leave, plus the available theme cards shown by that scope. A file's kind is what the person said, or what the file itself
 * records (an Omarchy theme and its target, web pages); everything else is Other designs until someone says.
 */

export interface KindScope { kind: ProjectType | null; platform: string | null }

/** The words of `PROJECT_TYPES` and `PLATFORMS` (in @bogen/core), marked here so they are translated where shown. */
const KIND_WORDS: Partial<Record<string, { label: string; one: string; empty: string; emptyFor?: string }>> = {
  website: { label: msg('Websites'), one: msg('Website'), empty: msg('No websites here') },
  app: { label: msg('Apps'), one: msg('App'), empty: msg('No apps here'), emptyFor: msg('No apps here for {platform}') },
  'omarchy-theme': { label: msg('Themes'), one: msg('Theme'), empty: msg('No themes here'), emptyFor: msg('No themes here for {platform}') },
  'omarchy-plugin': { label: msg('Omarchy plugins'), one: msg('Omarchy plugin'), empty: msg('No omarchy plugins here') },
  'omasidebar-widget': { label: msg('Omasidebar widgets'), one: msg('Omasidebar widget'), empty: msg('No omasidebar widgets here') },
  brand: { label: msg('Brand systems'), one: msg('Brand system'), empty: msg('No brand systems here') },
  design: { label: msg('Other designs'), one: msg('Design'), empty: msg('No other designs here') },
};
/** Platform labels that are words; `iOS`, `Android` and the Omarchy ones are names and stay as they are. */
const PLATFORM_WORDS = new Set<string>([msg('Desktop')]);

export const labelOf = (type: string | null | undefined) => t(KIND_WORDS[type ?? '']?.label ?? PROJECT_TYPES.find((k) => k.type === type)?.label ?? 'Other designs');
export const oneOf = (type: string | null | undefined) => t(KIND_WORDS[type ?? '']?.one ?? PROJECT_TYPES.find((k) => k.type === type)?.one ?? 'Design');
export const platformLabel = (type: string, id: string) => {
  const label = PLATFORMS[type as ProjectType]?.find((p) => p.id === id)?.label;
  return label ? (PLATFORM_WORDS.has(label) ? t(label) : label) : id;
};
/** The empty state of Home when a kind (and platform) shows no files. */
export function emptyKindTitle(type: string, platform: string | null): string {
  const words = KIND_WORDS[type];
  if (platform) {
    const name = platformLabel(type, platform);
    return words?.emptyFor ? t(words.emptyFor, { platform: name }) : t('No {kind} here for {platform}', { kind: labelOf(type).toLowerCase(), platform: name });
  }
  return words ? t(words.empty) : t('No {kind} here', { kind: labelOf(type).toLowerCase() });
}

/** The files of a scope, among those the folder and search already chose. */
export function filesOfKind<T extends Pick<FileEntry, 'project'>>(files: T[], scope: KindScope): T[] {
  return scope.kind ? files.filter((f) => inScope(f.project as never, scope.kind, scope.platform)) : files;
}

/** The kinds list in Home's side bar. */
export function KindList({ files, scope, presets, query, themeFolder, onScope }: { files: FileEntry[]; scope: KindScope; presets: readonly CollectionPreset[]; query: string; themeFolder: boolean; onScope: (s: KindScope) => void }) {
  const t = useT();
  const count = (kind: ProjectType | null, platform: string | null = null) => {
    const matching = filesOfKind(files, { kind, platform });
    const templates = kind === 'omarchy-theme' || (!kind && themeFolder)
      ? unrepresentedPresets(presets, matching, query, platform).length : 0;
    return matching.length + templates;
  };
  const row = (kind: ProjectType | null, platform: string | null, label: string, depth: number) => {
    const active = scope.kind === kind && scope.platform === platform;
    const n = count(kind, platform);
    return (
      <div key={`${kind}-${platform}`} className={`folder-row kind-row${active ? ' is-active' : ''}`} role="treeitem" aria-selected={active} aria-level={depth + 1} style={{ paddingLeft: 4 + depth * 12 }} data-testid="kind-row" data-kind={kind ?? ''} data-platform={platform ?? ''}>
        <span className="layer-toggle" />
        <button type="button" className="folder-open" onClick={() => onScope({ kind, platform })}><span className="folder-name">{label}</span></button>
        {n ? <span className="folder-count">{n}</span> : null}
      </div>
    );
  };
  return (
    <div role="tree" aria-label={t('Kinds')} className="home-tree home-kinds" data-testid="home-kinds">
      {row(null, null, t('All kinds'), 0)}
      {PROJECT_TYPES.flatMap((k) => [
        row(k.type, null, t(k.label), 0),
        ...(PLATFORMS[k.type] ?? []).map((p) => row(k.type, p.id, t(p.label), 1)),
      ])}
    </div>
  );
}

/** What is shown, said once above the files, with one way back to everything. */
export function ScopeLine({ folder, query, scope, shown, templates = 0, onClear }: { folder: string | null; query: string; scope: KindScope; shown: number; templates?: number; onClear: () => void }) {
  const t = useT();
  if (!scope.kind && !query.trim()) return null;
  const kind = scope.kind ? (scope.platform ? t('{kind}, {platform}', { kind: labelOf(scope.kind), platform: platformLabel(scope.kind, scope.platform) }) : labelOf(scope.kind)) : t('All kinds');
  const q = query.trim();
  const line = q
    ? t.n(shown, '{count} file: {kind} matching “{query}”', '{count} files: {kind} matching “{query}”', { kind, query: q })
    : folder
      ? t.n(shown, '{count} file: {kind} in {folder}', '{count} files: {kind} in {folder}', { kind, folder })
      : t.n(shown, '{count} file: {kind} in all folders', '{count} files: {kind} in all folders', { kind });
  return (
    <div className="home-scope" role="status" data-testid="home-scope">
      <span dir="auto">{line}</span>
      {templates ? <span data-testid="theme-template-count">{t('Template')}: {templates}</span> : null}
      <button type="button" className="btn btn-quiet home-scope-clear" onClick={onClear} data-testid="home-scope-clear"><X size={13} /> {t('Show all')}</button>
    </div>
  );
}

/** Saying what a file is a design for: one kind, and for apps and themes the platforms. */
export function ProjectMenu({ file, anchor, onClose, onChanged }: { file: FileEntry; anchor: HTMLElement | null; onClose: () => void; onChanged: () => void }) {
  const current = file.project;
  const t = useT();
  const [type, setType] = useState<string>(current?.type ?? 'design');
  const [platforms, setPlatforms] = useState<string[]>(current?.platforms ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = PLATFORMS[type as ProjectType] ?? [];
  const save = async (forget = false) => {
    setSaving(true);
    setError(null);
    try {
      await api.setProject(file.id, forget ? null : { type, platforms: platforms.filter((p) => options.some((o) => o.id === p)) });
      onChanged();
      onClose();
    } catch (e) {
      // The menu stays open with the choice as it was, to try again.
      setError((e as Error).message ? t('Not saved: {error}. Try again.', { error: (e as Error).message }) : t('Not saved: the computer did not answer. Try again.'));
    } finally {
      setSaving(false);
    }
  };
  const from = current?.source === 'person' ? t('You set this.') : current?.source === 'file' ? t('Read from the file itself. Change it if it is wrong.') : t('Not known yet. Bogen does not guess from names.');
  return (
    <Popover anchor={anchor} side="below" width={240} onClose={onClose}>
      <div className="project-menu" data-testid="project-menu">
        <div className="hint project-from">{from}</div>
        <div role="radiogroup" aria-label={t('Kind')}>
          {PROJECT_TYPES.map((k) => (
            <button key={k.type} type="button" role="radio" aria-checked={type === k.type} className="menu-item" onClick={() => setType(k.type)} data-testid={`project-type-${k.type}`}>
              <span className="menu-with-icon">{type === k.type ? <Check size={13} /> : <span style={{ width: 13 }} />} {t(k.label)}</span>
            </button>
          ))}
        </div>
        {options.length ? (
          <fieldset className="project-platforms" data-testid="project-platforms">
            <legend className="hint">{type === 'app' ? t('Platforms: one file can be for several') : t('For')}</legend>
            {options.map((o) => (
              <label key={o.id} className="check">
                <input type="checkbox" checked={platforms.includes(o.id)} onChange={(e) => setPlatforms((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))} data-testid={`project-platform-${o.id}`} /> {t(o.label)}
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <div className="error project-error" role="alert" data-testid="project-error">{error}</div> : null}
        <div className="project-actions">
          {current?.source === 'person' ? <button type="button" className="btn btn-quiet" disabled={saving} onClick={() => void save(true)} data-testid="project-forget">{t('Let Bogen read it')}</button> : <span />}
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()} data-testid="project-save">{t('Save')}</button>
        </div>
      </div>
    </Popover>
  );
}
