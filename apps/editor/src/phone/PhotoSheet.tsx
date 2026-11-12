import { useState } from 'react';
import { Camera, ImagePlus } from 'lucide-react';
import { session } from '../doc/session.ts';
import { phoneHost, useReachable } from '../lib/phone.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { showLayer } from './board-view.ts';
import { phoneFile, usePhoneFile } from './file-state.ts';
import { photoWords, pickPhoto, sendPhoto, type Photo } from './photo.ts';
import { Sheet } from './Sheet.tsx';
import { useT } from '../i18n/react.ts';

/** A photo as an image layer on the board in view: in its flow when the board lays out its children, else in the middle. */
export function placePhoto(photo: Pick<Photo, 'src' | 'width' | 'height'>): string {
  const s = session();
  const { boards, boardId } = phoneFile();
  const board = boards.find((b) => b.id === boardId);
  const node = board ? s.snap.nodes.get(board.id) : undefined;
  let id = '';
  s.tx(() => {
    if (board && node) {
      const scale = Math.min(1, (board.w * 0.8) / photo.width);
      const w = Math.round(photo.width * scale);
      const h = Math.round(photo.height * scale);
      const flow = /flex|grid/.test(String(node.style.display ?? ''));
      // In the middle of what is in view, kept inside the board.
      const v = camera.visibleWorld();
      const cy = Math.min(Math.max(v.y + v.h / 2, board.y + h / 2), board.y + board.h - h / 2);
      const style: Record<string, string> = flow
        ? { width: `${w}px`, height: `${h}px`, maxWidth: '100%', objectFit: 'cover' }
        : { position: 'absolute', left: `${Math.round((board.w - w) / 2)}px`, top: `${Math.max(0, Math.round(cy - board.y - h / 2))}px`, width: `${w}px`, height: `${h}px`, objectFit: 'cover' };
      id = s.doc.insert(board.id, { type: 'image', tag: 'img', name: 'Photo', src: photo.src, style });
    } else {
      const v = camera.visibleWorld();
      const scale = Math.min(1, 800 / Math.max(photo.width, photo.height));
      const w = Math.round(photo.width * scale);
      const h = Math.round(photo.height * scale);
      id = s.doc.insert(editor().pageId!, { type: 'image', tag: 'img', name: 'Photo', src: photo.src, style: { position: 'absolute', left: `${Math.round(v.x + v.w / 2 - w / 2)}px`, top: `${Math.round(v.y + v.h / 2 - h / 2)}px`, width: `${w}px`, height: `${h}px` } });
    }
  });
  editor().set({ selection: [id] });
  requestAnimationFrame(() => showLayer(id));
  return id;
}

/** Takes or picks a photo and stores it on the computer: for the Photo sheet and the attach buttons. */
export function usePhotoPicker(onPhoto: (photo: Photo) => void): { busy: boolean; error: string; pick: (fromCamera: boolean) => void; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = (fromCamera: boolean) => {
    if (busy) return;
    setError('');
    pickPhoto(fromCamera, (file) => {
      setBusy(true);
      void sendPhoto(file).then(onPhoto, (e: Error) => setError(e.message)).finally(() => setBusy(false));
    });
  };
  return { busy, error, pick, clear: () => setError('') };
}

/** D7: a photo from the phone on the board in view. Attaching one to Ask or a comment is in their sheets. */
export function PhotoSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const boards = usePhoneFile((s) => s.boards);
  const boardId = usePhoneFile((s) => s.boardId);
  const board = boards.find((b) => b.id === boardId);
  const reachable = useReachable();
  const host = phoneHost();
  const { busy, error, pick } = usePhotoPicker((photo) => {
    placePhoto(photo);
    editor().showToast(photo.reencoded ? t('Placed, {details}. Location and camera data were left out.', { details: photoWords(photo) }) : t('Placed, {details}.', { details: photoWords(photo) }));
    onClose();
  });
  const away = reachable === false;
  return (
    <Sheet title={t('Photo')} aside={<span className="pf-aside-text" dir="auto">{board ? t('On {board}', { board: board.name }) : t('On the page')}</span>} onClose={onClose} testId="pf-photo">
      <p className="pf-hint">{away ? t('Photos are kept on {host}, which cannot be reached right now.', { host }) : board ? t('Take or pick a photo. It goes on {board} as an image layer.', { board: board.name }) : t('Take or pick a photo. It goes on the page as an image layer.')}</p>
      <div className="pf-photo-actions">
        <button type="button" className="phone-btn is-ink" disabled={busy || away} onClick={() => pick(true)} data-testid="pf-photo-camera"><Camera size={20} strokeWidth={2.4} /> {t('Take a photo')}</button>
        <button type="button" className="phone-btn is-outline" disabled={busy || away} onClick={() => pick(false)} data-testid="pf-photo-library"><ImagePlus size={20} strokeWidth={2.4} /> {t('Choose a photo')}</button>
      </div>
      <p className="pf-dim pf-photo-note" role="status" data-testid="pf-photo-status">
        {busy ? t('Making it smaller and sending it to {host}.', { host }) : error || t('Photos are scaled to {size} on the long side and sent to {host} only. JPEG and HEIC photos lose camera and location data; small PNG, WebP and GIF files keep their original data.', { size: '2048 px', host })}
      </p>
    </Sheet>
  );
}

/** A photo attached to a message, before it is sent: a small picture, its size, and a way to take it off. */
export function PhotoChip({ photo, onRemove, testId }: { photo: Photo; onRemove: () => void; testId: string }) {
  const t = useT();
  return (
    <div className="pf-photo-chip" data-testid={testId}>
      <img src={photo.url} alt="" />
      <span>{t('Photo, {details}', { details: photoWords(photo) })}</span>
      <button type="button" onClick={onRemove} aria-label={t('Remove the photo')}>×</button>
    </div>
  );
}
