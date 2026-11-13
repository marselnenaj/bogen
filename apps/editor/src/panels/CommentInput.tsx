import { useEffect, useRef, useState } from 'react';
import { FileText, Mic, Paperclip, Send, X } from 'lucide-react';
import { RUNNABLE_IDS, type CommentAttachment } from '@bogen/core';
import { api, resolveAsset } from '../lib/api.ts';
import { imageSize } from '../ops/clipboard.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { session } from '../doc/session.ts';
import { mentionAt } from './mention.ts';
import { ATTACH_ACCEPT, attachType, isImageAttachment } from './collab-words.ts';
import { getDraft, setDraft } from './conversation-state.ts';
import { useT } from '../i18n/react.ts';
import { dropRecording } from '../phone/voice.ts';
import { clockOf } from '../ui/VoiceNote.tsx';
import { MicButton, useVoice, VoiceNotice, VoiceRecording } from '../ui/VoiceInput.tsx';
import { joinWords } from '../ui/voice-state.ts';

export { isImageAttachment };

export interface Mentionable { name: string; kind: 'person' | 'agent' }

function pickFile(onPicked: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ATTACH_ACCEPT;
  input.multiple = true;
  input.onchange = () => [...(input.files ?? [])].forEach(onPicked);
  input.click();
}

/** People here, agents that can be asked, and those who already took part in this file. */
export function mentionables(): Mentionable[] {
  const seen = new Map<string, Mentionable>();
  const add = (name: string, kind: Mentionable['kind']) => {
    const handle = name.trim().replace(/\s+/g, '-');
    if (handle && !seen.has(handle.toLowerCase())) seen.set(handle.toLowerCase(), { name: handle, kind });
  };
  // Only the agents Bogen runs itself are offered: a mention of the others would only be refused.
  for (const a of RUNNABLE_IDS) add(a, 'agent');
  const st = editor();
  for (const p of st.peers) add(p.user.name, p.user.agent ? 'agent' : 'person');
  for (const a of st.activity) add(a.agent, 'agent');
  const s = session();
  for (const t of s.snap.comments) for (const m of t.messages) if (m.author !== s.user.name) add(m.author, 'person');
  return [...seen.values()];
}

/**
 * Where comments are written: with images by button, paste or drop, and @ completing names from the
 * keyboard. Enter sends, Shift+Enter is a new line, Esc leaves. With `draftKey`, what is written stays for that
 * thread while the editor is open: collapsing it, opening another or resizing the panel loses nothing.
 */
export function CommentInput({ placeholder, rows = 1, autoFocus, testId, sendTestId, onSubmit, onCancel, focusKey, onText, draftKey }: { placeholder: string; rows?: number; autoFocus?: boolean; testId: string; sendTestId?: string; onSubmit: (text: string, attachments: CommentAttachment[]) => Promise<void> | void; onCancel?: () => void; focusKey?: unknown; onText?: (text: string) => void; draftKey?: string }) {
  const t = useT();
  const [text, setText] = useState(() => (draftKey ? getDraft(draftKey)?.text ?? '' : ''));
  const [files, setFiles] = useState<CommentAttachment[]>(() => (draftKey ? getDraft(draftKey)?.files ?? [] : []));
  useEffect(() => { if (draftKey) setDraft(draftKey, { text, files }); }, [draftKey, text, files]);
  const [uploading, setUploading] = useState(0);
  const [mention, setMention] = useState<{ start: number; query: string; active: number } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEditor((s) => s.peers);
  useEffect(() => { if (focusKey !== undefined) areaRef.current?.focus(); }, [focusKey]);
  useEffect(() => onText?.(text), [text]);
  // Speaking: the words go into the field to be checked; without a local model the recording is a voice note.
  const voice = useVoice({
    use: 'comment',
    onText: (words) => setText((current) => joinWords(current, words)),
    onAttach: (file) => setFiles((list) => [...list, file]),
    onDone: () => requestAnimationFrame(() => areaRef.current?.focus()),
  });

  const options = mention ? mentionables().filter((o) => o.name.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [];
  const upload = async (blob: File | Blob) => {
    const name = 'name' in blob ? (blob as File).name : undefined;
    const type = attachType({ type: blob.type, ...(name ? { name } : {}) });
    if (!type) return void editor().showToast(name ? t('{file} cannot be attached. Images, PDF, text, Markdown, CSV and JSON can.', { file: name }) : t('That file cannot be attached. Images, PDF, text, Markdown, CSV and JSON can.'));
    setUploading((n) => n + 1);
    try {
      const asset = await api.upload(blob, type);
      if (type.startsWith('image/')) {
        const size = await imageSize(asset.src);
        setFiles((list) => [...list, { src: asset.src, width: size.w, height: size.h, ...(name ? { name } : {}) }]);
      } else setFiles((list) => [...list, { src: asset.src, ...(name ? { name } : {}) }]);
    } catch (err) {
      editor().showToast(name ? t('Could not add {file}. {error}', { file: name, error: (err as Error).message }) : t('Could not add the file. {error}', { error: (err as Error).message }));
    } finally {
      setUploading((n) => n - 1);
    }
  };
  const send = async () => {
    // A voice note on its own still says what it is, as on the phone.
    const body = text.trim() || (files.some((f) => f.kind === 'audio') ? 'Voice note' : '');
    if ((!body && !files.length) || uploading || voice.phase !== 'idle') return;
    try {
      await onSubmit(body, files);
      voice.dismiss();
      setText('');
      setFiles([]);
      setMention(null);
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const accept = (o: Mentionable) => {
    if (!mention) return;
    const el = areaRef.current!;
    const caret = el.selectionStart;
    const next = `${text.slice(0, mention.start)}@${o.name} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const at = mention.start + o.name.length + 2;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at, at); });
  };
  const read = (el: HTMLTextAreaElement) => {
    const m = mentionAt(el.value, el.selectionStart);
    setMention((cur) => (m ? { ...m, active: cur && cur.start === m.start ? cur.active : 0 } : null));
  };
  return (
    <div
      className="comment-input"
      onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); } }}
      onDrop={(e) => {
        const dropped = [...e.dataTransfer.files].filter((f) => attachType(f));
        if (!dropped.length) return;
        e.preventDefault();
        e.stopPropagation();
        dropped.forEach((f) => void upload(f));
      }}
    >
      {mention && options.length ? (
        <div className="mention-list" role="listbox" aria-label={t('Mention')} data-testid="mention-list">
          {options.map((o, i) => (
            <div key={o.name} role="option" aria-selected={i === mention.active} className={`mention-row${i === mention.active ? ' is-active' : ''}`} data-testid="mention-row" onPointerDown={(e) => { e.preventDefault(); accept(o); }}>
              <span dir="auto">@{o.name}</span><span className="mention-kind">{o.kind === 'agent' ? t('Agent') : t('Person')}</span>
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        ref={areaRef}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        spellCheck
        dir="auto"
        aria-label={placeholder}
        data-testid={testId}
        onChange={(e) => { setText(e.target.value); read(e.target); }}
        onSelect={(e) => read(e.currentTarget)}
        onPaste={(e) => {
          const images = [...e.clipboardData.files].filter((f) => attachType(f));
          if (!images.length) return;
          e.preventDefault();
          e.stopPropagation();
          images.forEach((f) => void upload(f));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (mention && options.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setMention({ ...mention, active: (mention.active + 1) % options.length }); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setMention({ ...mention, active: (mention.active - 1 + options.length) % options.length }); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(options[mention.active] ?? options[0]!); return; }
            if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape') onCancel?.();
        }}
      />
      {files.length || uploading ? (
        <div className="comment-files" data-testid="comment-files">
          {files.map((f, i) => (
            f.kind === 'audio' ? (
              <div key={f.src + i} className="comment-file is-doc is-voice" data-testid="comment-voice">
                <span className="comment-doc"><Mic size={13} /><span>{f.duration !== undefined ? t('Voice note, {duration}', { duration: clockOf(f.duration) }) : t('Voice note')}</span></span>
                <button type="button" aria-label={t('Remove the voice note')} title={t('Remove')} onClick={() => { dropRecording(f); setFiles((list) => list.filter((_, j) => j !== i)); }}><X size={10} /></button>
              </div>
            ) : (
              <div key={f.src + i} className={`comment-file${isImageAttachment(f.src) ? '' : ' is-doc'}`} data-testid="comment-file">
                {isImageAttachment(f.src) ? <img src={resolveAsset(f.src)} alt={f.name ?? t('Attached image')} /> : <span className="comment-doc" title={f.name}><FileText size={13} /><span dir="auto">{f.name ?? t('File')}</span></span>}
                <button type="button" aria-label={f.name ? t('Remove {file}', { file: f.name }) : t('Remove the file')} title={t('Remove')} onClick={() => setFiles((list) => list.filter((_, j) => j !== i))}><X size={10} /></button>
              </div>
            )
          ))}
          {uploading ? <div className="comment-file is-busy" role="status" aria-label={t('Uploading')} /> : null}
        </div>
      ) : null}
      {voice.phase === 'recording' ? <VoiceRecording voice={voice} testId={`${testId}-mic`} /> : (
        <div className="comment-actions">
          <IconButton icon={<Paperclip size={13} />} title={t('Attach an image or a file (PDF, text, Markdown, CSV, JSON), or paste or drop one here. An agent asked in the thread gets them too.')} onClick={() => pickFile((f) => void upload(f))} testId={`${testId}-attach`} />
          <MicButton voice={voice} testId={`${testId}-mic`} size={13} />
          <IconButton icon={<Send size={13} />} title={t('Send ({shortcut})', { shortcut: 'Enter' })} onClick={() => void send()} disabled={(!text.trim() && !files.length) || uploading > 0 || voice.phase !== 'idle'} testId={sendTestId ?? `${testId}-send`} />
        </div>
      )}
      {voice.phase !== 'idle' || voice.problem || voice.note ? <div className="comment-voice"><VoiceNotice voice={voice} testId={testId} /></div> : null}
    </div>
  );
}
