import { useState } from 'react';
import type { CommentAttachment } from '@bogen/core';
import { useT } from '../i18n/react.ts';

const VOICE_SRC = /^bogen-voice:([a-f0-9]{24}\.(m4a|aac|webm|ogg|mp3|wav))$/;

/** Voice notes among a message's attachments. Only names of the shape this server writes are ever loaded. */
export function voiceNotesOf(files: CommentAttachment[] | undefined): { name: string; file: CommentAttachment }[] {
  return (files ?? []).flatMap((file) => {
    const m = typeof file?.src === 'string' ? VOICE_SRC.exec(file.src) : null;
    return m ? [{ name: m[1]!, file }] : [];
  });
}

/** 0:07, 1:32. */
export function clockOf(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function VoiceNote({ name, file, className }: { name: string; file: CommentAttachment; className: string }) {
  const t = useT();
  const [missing, setMissing] = useState(false);
  const length = clockOf(file.duration);
  return (
    <div className={className} data-testid="message-voice">
      <span className={`${className}-name`}>{length ? t('Voice note, {length}', { length }) : t('Voice note')}</span>
      {missing
        ? <span className={`${className}-away`}>{file.device ? t('The recording is kept on {device}, and plays only there.', { device: file.device }) : t('The recording is kept on the computer that took it, and plays only there.')}</span>
        : <audio controls preload="metadata" src={`/api/voice/${name}`} onError={() => setMissing(true)} />}
    </div>
  );
}

export function VoiceNotes({ files, className = 'message-voice' }: { files: CommentAttachment[] | undefined; className?: string }) {
  const notes = voiceNotesOf(files);
  if (!notes.length) return null;
  return <>{notes.map((n) => <VoiceNote key={n.name} name={n.name} file={n.file} className={className} />)}</>;
}
