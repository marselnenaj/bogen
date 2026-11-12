import { useEffect, useState } from 'react';
import { usePages, useStructureVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { boardCount, openSheet, showBoard, showLayer } from './board-view.ts';
import { layerGlyph, layerRows, openFor, usePhoneFile, type BoardBox } from './file-state.ts';
import { layerPicture } from './phone-api.ts';
import { Sheet } from './Sheet.tsx';
import { useT } from '../i18n/react.ts';
import { WorkspaceView } from './WorkspaceView.tsx';
import { editDate, recentByPage, useRecentEdits } from '../lib/recent-edits.ts';

const PREVIEW_H = 96;

/** A board as a small picture from the computer's renderer; offline, a plain box of its shape. */
function BoardPreview({ fileId, board, current, onPick }: { fileId: string; board: BoardBox; current: boolean; onPick: () => void }) {
  const t = useT();
  const [src, setSrc] = useState('');
  useEffect(() => {
    let gone = false;
    const scale = Math.round(Math.min(1, Math.max(0.1, (PREVIEW_H * 2) / board.h)) * 100) / 100;
    void layerPicture(fileId, board.id, scale).then((url) => { if (!gone) setSrc(url); }, () => {});
    return () => { gone = true; };
  }, [fileId, board.id, board.h]);
  const width = Math.round(Math.min(150, Math.max(44, (PREVIEW_H * board.w) / Math.max(1, board.h))));
  return (
    <button type="button" className={`pf-board${current ? ' is-current' : ''}`} onClick={onPick} aria-label={t('{name}, {width} wide', { name: board.name, width: Math.round(board.w) })} aria-current={current || undefined} data-testid="pf-board" data-board-id={board.id}>
      <span className="pf-board-pic" style={{ width, height: PREVIEW_H }}>{src ? <img src={src} alt="" draggable={false} /> : null}</span>
      <span className="pf-board-w">{Math.round(board.w)}</span>
    </button>
  );
}

/** D5: every page with its boards, the current one in ink, and the boards of the current page to go to. */
export function PagesSheet({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const t = useT();
  const recent = recentByPage(useRecentEdits());
  const pages = usePages();
  const pageId = useEditor((s) => s.pageId);
  const boards = usePhoneFile((s) => s.boards);
  const boardId = usePhoneFile((s) => s.boardId);
  useStructureVersion();
  const page = pages.find((p) => p.id === pageId);
  return (
    <Sheet full onClose={onClose} testId="pf-pages">
      <p className="pf-kicker">{t('Pages')}</p>
      <div className="pf-page-list">
        {pages.map((p) => {
          const n = boardCount(p.id);
          return (
            <button key={p.id} type="button" className={`pf-page-row${p.id === pageId ? ' is-current' : ''}`} aria-current={p.id === pageId || undefined} onClick={() => { if (p.id !== pageId) editor().set({ pageId: p.id, selection: [] }); }} data-testid="pf-page-row" data-page-id={p.id}>
              <span className="pf-page-row-name" dir="auto">{p.name}</span>
              {recent.has(p.id) ? <span className="page-edit-time" title={recent.get(p.id)!.summary} data-testid="pf-page-last-edit">{t('Last edited {date}', { date: editDate(recent.get(p.id)!.at) })}</span> : null}
              <span className="pf-count">{t.n(n, '{count} board', '{count} boards')}</span>
            </button>
          );
        })}
      </div>
      <p className="pf-kicker is-ruled">{page ? t('Boards on {page}', { page: page.name }) : t('Boards on this page')}</p>
      <div className="pf-boards" data-testid="pf-boards">
        {boards.map((b) => <BoardPreview key={b.id} fileId={fileId} board={b} current={b.id === boardId} onPick={() => { showBoard(b.id); onClose(); }} />)}
        {!boards.length ? <p className="pf-empty">{t('Nothing on this page yet.')}</p> : null}
      </div>
      <div className="pf-hatch"><WorkspaceView /></div>
    </Sheet>
  );
}

/** The top layer a layer is in: its board. */
function boardOf(id: string): string {
  const { snap } = session();
  let top = id;
  for (let p = snap.nodes.get(top)?.parent; p && snap.nodes.has(p); p = snap.nodes.get(p)?.parent) top = p;
  return top;
}

/** D2: the layers of the board, 44 px rows. A tap selects and shows the layer; Edit goes on to D3. */
export function LayersSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const pages = usePages();
  const pageId = useEditor((s) => s.pageId);
  const selection = useEditor((s) => s.selection);
  const boardId = usePhoneFile((s) => s.boardId);
  useStructureVersion();
  const { snap } = session();
  const selected = selection[0] && snap.nodes.has(selection[0]) ? selection[0] : null;
  const root = selected ? boardOf(selected) : boardId;
  const rows = root && snap.nodes.has(root) ? layerRows(root, (id) => snap.nodes.get(id), (id) => snap.children(id), openFor(selected, (id) => snap.nodes.get(id)?.parent, root)) : [];
  const where = [pages.find((p) => p.id === pageId)?.name, root ? snap.nodes.get(root)?.name : undefined].filter(Boolean).join(' · ');
  const pick = (id: string, board: boolean) => {
    editor().set({ selection: [id] });
    requestAnimationFrame(() => (board ? showBoard(id) : showLayer(id)));
  };
  return (
    <Sheet title={t('Layers')} aside={<span className="pf-aside-text" dir="auto">{where}</span>} onClose={onClose} testId="pf-layers">
      <div className="pf-layer-list" role="list">
        {rows.map((r) => {
          const on = r.id === selected;
          const hidden = snap.nodes.get(r.id)?.hidden;
          return (
            <div key={r.id} role="listitem" className={`pf-layer${on ? ' is-selected' : ''}${r.board ? ' is-board' : ''}${hidden ? ' is-hidden' : ''}`} data-testid="pf-layer" data-layer-id={r.id}>
              <button type="button" className="pf-layer-pick" style={{ paddingLeft: 20 + r.depth * 22 }} onClick={() => pick(r.id, r.board)} aria-pressed={on}>
                <span className="pf-layer-glyph" aria-hidden="true">{layerGlyph(r)}</span>
                <span className="pf-layer-name" dir="auto">{r.name}</span>
              </button>
              {on ? <button type="button" className="pf-layer-edit" onClick={() => openSheet('edit')} data-testid="pf-layer-edit">{t('Edit ›')}</button> : null}
            </div>
          );
        })}
        {!rows.length ? <p className="pf-empty">{t('No board in view. Step to one with ‹ and ›, or pick one in the pages.')}</p> : null}
      </div>
    </Sheet>
  );
}
