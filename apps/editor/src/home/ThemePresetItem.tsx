import { useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { presetThumb, startTheme, type CollectionPreset, type ThemeCandidate } from '../lib/theme-library.ts';
import { useT } from '../i18n/react.ts';
import { Popover } from '../ui/controls.tsx';
import { ChooseTheme } from './OmarchyThemesSection.tsx';

/** A bundled starting point uses the same grid/list card as a saved design, without making a file just to list it. */
export function ThemePresetItem({ preset, folder, hasProject, view, selecting }: { preset: CollectionPreset; folder: string | null; hasProject: boolean; view: 'grid' | 'list'; selecting: boolean }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{ candidates: ThemeCandidate[]; message?: string } | null>(null);
  const open = async (separate = false) => {
    setBusy(true); setFailed(null);
    try {
      const out = await startTheme({ preset: preset.id, ...(separate ? { new_project: true } : {}) });
      if ('choose' in out) { setChoosing({ candidates: out.choose, ...(out.message ? { message: out.message } : {}) }); return; }
      // Only a newly started project goes into the chosen folder. Reusing a project never moves it.
      if (!out.reused && folder) await api.moveFile(out.file_id, folder);
      location.hash = `#/file/${out.file_id}`;
    } catch (e) { setFailed((e as Error).message); }
    finally { setBusy(false); }
  };
  const kind = t('{kind}: {platforms}', { kind: t('Theme'), platforms: 'Omarchy Desktop' });
  return (
    <div className="file file-preset" role="listitem" data-testid="theme-preset" data-preset={preset.id} data-platform="desktop">
      <button ref={anchor} type="button" className="file-thumb" disabled={busy || selecting} onClick={() => void open()} aria-label={t('Open {name}', { name: preset.name })} data-testid="theme-preset-start">
        <img src={presetThumb(preset.id, 'landscape')} alt="" loading="lazy" decoding="async" draggable={false} />
      </button>
      <div className="file-info">
        <button type="button" className="file-title" onClick={() => void open()} disabled={busy || selecting} title={preset.description} tabIndex={-1} dir="auto">{preset.name}</button>
        <span className="file-time">{busy ? t('Starting') : hasProject ? t('Your project') : t('Template')}</span>
        <span className="file-kind" data-testid="file-kind">{kind}</span>
        {view === 'list' ? <span className="file-folder" dir="auto">{folder ?? ''}</span> : null}
      </div>
      {failed ? <div className="examples-error" role="alert">{failed}</div> : null}
      {choosing ? <Popover anchor={anchor.current} side="below" width={360} onClose={() => setChoosing(null)} focus>
        <div className="preset-project-choice"><ChooseTheme candidates={choosing.candidates} message={choosing.message} busy={busy} onOpen={(id) => { location.hash = `#/file/${id}`; }} onNew={() => void open(true)} onCancel={() => setChoosing(null)} /></div>
      </Popover> : null}
    </div>
  );
}
