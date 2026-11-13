import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { libraryLinks, libraryTokenRenames, libraryUpdates, type LibraryInfo, type LibraryUpdate, type PublishedComponent } from '@bogen/core';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { onServerEvent } from '../lib/events.ts';
import { acceptHere, libraryApi } from '../ops/library.ts';
import { useEditor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { formatList } from '../i18n/format.ts';

/** What the libraries this file links have published since, as the file's own copies tell. */
export function useLibraryUpdates(): { updates: LibraryUpdate[]; names: Map<string, string>; renames: { lib: string; from: string; to: string }[] } {
  const fileId = useEditor((s) => s.fileId);
  const connection = useEditor((s) => s.connection);
  const version = useSnapVersion();
  const { doc } = session();
  const linkKey = useMemo(() => libraryLinks(doc).map((l) => l.id).join(','), [doc, version]);
  const [published, setPublished] = useState(new Map<string, { name: string; published: PublishedComponent[]; info?: LibraryInfo }>());
  const [tick, setTick] = useState(0);
  useEffect(() => onServerEvent((e) => {
    if (e.t === 'library' || e.t === 'files') setTick((t) => t + 1);
  }), []);
  useEffect(() => {
    if (!fileId || connection !== 'connected' || !linkKey) {
      setPublished(new Map());
      return;
    }
    let live = true;
    void Promise.all(linkKey.split(',').map((id) => libraryApi.get(id).then((r) => [id, { name: r.summary.name, published: r.published, ...(r.info ? { info: r.info } : {}) }] as const, () => null))).then((rows) => {
      if (live) setPublished(new Map(rows.filter((r): r is NonNullable<typeof r> => r !== null)));
    });
    return () => { live = false; };
  }, [fileId, connection, linkKey, tick]);
  return useMemo(() => {
    const names = new Map<string, string>();
    const updates: LibraryUpdate[] = [];
    const renames: { lib: string; from: string; to: string }[] = [];
    for (const [id, p] of published) {
      names.set(id, p.name);
      updates.push(...libraryUpdates(doc, id, p.published));
      renames.push(...libraryTokenRenames(doc, id, p.info).map((r) => ({ lib: id, ...r })));
    }
    return { updates, names, renames };
  }, [doc, published, version]);
}

/** Says when a linked library has published changes, and takes them on request. Nothing changes before that. */
export function LibraryBanner() {
  const t = useT();
  const { updates, names, renames } = useLibraryUpdates();
  const [dismissed, setDismissed] = useState('');
  const key = [...updates.map((u) => `${u.id}:${u.to ?? 'x'}`), ...renames.map((r) => `${r.from}>${r.to}`)].join(',');
  if ((!updates.length && !renames.length) || dismissed === key) return null;
  const libs = [...new Set([...updates.map((u) => u.lib), ...renames.map((r) => r.lib)])];
  const items = [...updates.map((u) => u.name), ...renames.map((r) => t('--{from} renamed to --{to}', { from: r.from, to: r.to }))];
  const first = items.slice(0, 3).join(', ');
  const what = items.length > 3 ? t.n(items.length - 3, '{names} and {count} more', '{names} and {count} more', { names: first }) : first;
  const from = formatList(libs.map((id) => names.get(id) ?? t('A library')));
  return (
    <div className="banner banner-info" role="status" data-testid="library-banner">
      <span dir="auto">{t.n(libs.length, '{libraries} has updates: {what}.', '{libraries} have updates: {what}.', { libraries: from, what })}</span>
      <button type="button" className="btn" data-testid="library-accept" onClick={() => { for (const id of libs) void acceptHere(id); }}>{t('Accept')}</button>
      <button type="button" className="banner-close" title={t('Not now')} onClick={() => setDismissed(key)} data-testid="library-dismiss"><X size={13} /></button>
    </div>
  );
}
