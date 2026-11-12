import { useEditor } from '../state/store.ts';
import { session } from '../doc/session.ts';
import { useFrameVersion, useStructureVersion } from '../doc/hooks.ts';
import { useT } from '../i18n/react.ts';
import { redoSelectedScreen, selectedScreen } from './redo-screen.ts';

export function RedoScreenAction() {
  const t = useT();
  useFrameVersion();
  useStructureVersion();
  useEditor(s => s.selection);
  const running = useEditor(s => s.prompt.running);
  const screen = selectedScreen();
  if (!screen) return null;
  const selected = session().doc.meta.get('canvasCover') === screen.id;
  const toggleCover = () => {
    const s = session();
    s.tx(() => {
      if (s.doc.meta.get('canvasCover') === screen.id) s.doc.meta.delete('canvasCover');
      else s.doc.meta.set('canvasCover', screen.id);
    });
  };
  return <div className="redo-screen-action">
    <button type="button" className="btn btn-quiet" disabled={running} onClick={redoSelectedScreen} data-testid="redo-screen-selected">{t('Redo this screen…')}</button>
    <button type="button" className={`btn btn-quiet${selected ? ' is-active' : ''}`} aria-pressed={selected} onClick={toggleCover} data-testid="screen-cover">{t('Cover')}</button>
  </div>;
}
