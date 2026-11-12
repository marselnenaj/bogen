import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Shapes, X } from 'lucide-react';
import { readProject } from '@bogen/core';
import { useFrameVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { ProjectMenu, oneOf } from '../home/ProjectFilters.tsx';

export function ProjectKindControl() {
  const t = useT(); const id = useEditor(s => s.fileId); const name = useEditor(s => s.fileName);
  const version = useFrameVersion(); const { doc } = session(); const project = readProject(doc);
  const anchor = useRef<HTMLButtonElement>(null); const [open, setOpen] = useState(false); const [, refresh] = useState(0);
  void version;
  if (!id) return null;
  return <>
    <button ref={anchor} type="button" className="project-kind-control" aria-label={t('Kind')} title={`${t('Kind')}: ${oneOf(project.type)}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="editor-project-kind"><Shapes size={14} aria-hidden="true" /><span>{project.source === 'unknown' ? t('Kind') : oneOf(project.type)}</span><ChevronDown size={11} aria-hidden="true" /></button>
    {open ? <ProjectMenu key={id} file={{ id, name: name || t('Untitled'), updatedAt: 0, project }} anchor={anchor.current} onClose={() => setOpen(false)} onChanged={() => refresh(v => v + 1)} /> : null}
  </>;
}

/** Ask about the project, never infer an operating-system theme merely from its palette. */
export function ProjectKindBanner() {
  const t = useT(); const id = useEditor(s => s.fileId); const { doc } = session(); useFrameVersion();
  const project = readProject(doc); const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(Boolean(id && sessionStorage.getItem(`bogen-project-question:${id}`))); }, [id]);
  if (!id || project.source !== 'unknown' || dismissed) return null;
  return <div className="banner project-question" role="status" data-testid="project-kind-question">
    <span>{t('What are you designing?')}</span><ProjectKindControl />
    <IconButton icon={<X size={13} />} title={t('Close')} onClick={() => { sessionStorage.setItem(`bogen-project-question:${id}`, '1'); setDismissed(true); }} testId="project-kind-later" />
  </div>;
}
