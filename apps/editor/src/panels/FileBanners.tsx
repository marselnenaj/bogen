import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { agentApi, type AwayNote } from '../lib/agent-api.ts';
import { api } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { editor, useEditor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { formatList } from '../i18n/format.ts';

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.round(s / 60), '{count} min ago', '{count} min ago');
  if (s < 86400) return t.n(Math.round(s / 3600), '{count} h ago', '{count} h ago');
  return t.n(Math.round(s / 86400), '{count} d ago', '{count} d ago');
}

/** Keeps the name in the title bar and the tab current, also when another device renamed the file. */
export function startFileTitle(fileId: string): () => void {
  const apply = () => {
    void api.files().then((files) => {
      const f = files.find((x) => x.id === fileId);
      if (!f || editor().fileId !== fileId) return;
      if (editor().fileName !== f.name) editor().set({ fileName: f.name });
      const title = `${f.name} - Bogen`;
      if (document.title !== title) document.title = title;
    }, () => {});
  };
  return onServerEvent((e) => {
    if (e.t === 'files') apply();
  });
}

/** Says once what happened to the file while nobody had it open, also after a laptop slept through it. */
export function AwayBanner() {
  useT();
  const fileId = useEditor((s) => s.fileId);
  const connection = useEditor((s) => s.connection);
  const [note, setNote] = useState<AwayNote | null>(null);
  const [texts, setTexts] = useState(0);
  useEffect(() => {
    if (!fileId || connection !== 'connected') return;
    let live = true;
    void agentApi.away(fileId).then(({ away }) => {
      if (live && away) setNote(away);
      // A text both devices edited while apart keeps one side's words: say so here too, since the note is out of sight.
      if (live && away) void agentApi.conflicts(fileId).then((list) => { if (live) setTexts(list.filter((c) => c.texts && c.at >= away.firstAt).length); }, () => {});
    }, () => {});
    return () => { live = false; };
  }, [fileId, connection]);
  if (!note) return null;
  const who = formatList(Object.keys(note.from));
  const when = ago(note.lastAt);
  return (
    <div className="banner banner-info" role="status" data-testid="away-banner">
      <span>{texts ? t.n(texts, '{who} changed this file while nobody had it open, the last time {ago}. One text was edited on both devices while apart, and one side\'s words were kept: Sync in the Agents tab has both.', '{who} changed this file while nobody had it open, the last time {ago}. {count} texts were edited on both devices while apart, and one side\'s words were kept: Sync in the Agents tab has both.', { who, ago: when }) : t('{who} changed this file while nobody had it open, the last time {ago}.', { who, ago: when })}</span>
      <button type="button" className="banner-close" title={t('Dismiss')} onClick={() => setNote(null)} data-testid="away-dismiss"><X size={13} /></button>
    </div>
  );
}
