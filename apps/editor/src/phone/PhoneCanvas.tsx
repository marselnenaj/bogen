import { useEffect } from 'react';
import { Editor } from '../Editor.tsx';
import { unionRects } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { maybeSession } from '../doc/session.ts';
import { onServerEvent } from '../lib/events.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { msg } from '../i18n/core.ts';

/** Where the back pill leads, set by the screen that opened the canvas. `label` is also compared, so it is English: show it with `t(label)`. */
export function backTarget(): { hash: string; label: string } {
  const from = sessionStorage.getItem('bogen-phone-back') ?? '#/ask';
  return { hash: from, label: from.startsWith('#/files') ? msg('Files') : from === '#/' || from === '#/inbox' || from === '' ? msg('Inbox') : msg('Thread') };
}

export function openCanvas(fileId: string, from: string, threadId?: string): void {
  try { sessionStorage.setItem('bogen-phone-back', from); } catch { /* fine */ }
  location.hash = `#/file/${fileId}${threadId ? `/thread/${threadId}` : ''}`;
}

/** Keeps the layers an agent works on in view, without selecting them. */
function FollowAgent({ fileId }: { fileId: string }) {
  const ready = useEditor((s) => s.ready);
  useEffect(() => {
    if (!ready) return;
    return onServerEvent((e) => {
      if (e.t !== 'activity' || e.fileId !== fileId) return;
      const s = maybeSession();
      if (!s) return;
      // The artboard around a change, so that the whole screen it belongs to shows.
      const roots = e.nodeIds.filter((id) => s.snap.nodes.has(id)).map((id) => {
        let top = id;
        for (let p = s.snap.nodes.get(top)?.parent; p && s.snap.nodes.has(p); p = s.snap.nodes.get(p)?.parent) top = p;
        return top;
      });
      const page = roots[0] ? s.doc.pageOf(roots[0]) : null;
      if (page && page !== editor().pageId) editor().set({ pageId: page });
      requestAnimationFrame(() => {
        const box = unionRects(roots.flatMap((id) => rectOf(id) ?? []));
        if (box) camera.fit(box, 2, 12);
      });
    });
  }, [ready, fileId]);
  return null;
}

/** Opens a comment thread once the file is there: its page, its layer in view. */
export function OpenThread({ threadId }: { threadId: string }) {
  const ready = useEditor((s) => s.ready);
  useEffect(() => {
    if (!ready) return;
    const s = maybeSession();
    const thread = s?.doc.getComments().find((t) => t.id === threadId);
    if (!s || !thread) return;
    if (thread.nodeId && jumpToLayers([thread.nodeId], thread.pageId)) editor().set({ selection: [] });
    else if (thread.pageId !== editor().pageId) editor().set({ pageId: thread.pageId });
    editor().set({ activeThreadId: threadId });
  }, [ready, threadId]);
  return null;
}

/** The canvas for watching an agent: no controls, the agent's layers kept in view. */
export function WatchCanvas({ fileId }: { fileId: string }) {
  return (
    <div className="phone-watch-canvas">
      <Editor fileId={fileId} layout="bare"><FollowAgent fileId={fileId} /></Editor>
    </div>
  );
}
