import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { preferenceLabel } from '@bogen/core';
import { useT } from '../i18n/react.ts';
import { formatDate } from '../i18n/format.ts';
import { IconButton } from '../ui/controls.tsx';
import { setSoundsOn, soundsOn } from './call-sounds.ts';
import { setAgentCalls, useIncoming } from './incoming.ts';
import { callLanguagesOf, forgetPreference, installHearing, installTalkModel, loadPreferences, setCallLanguage, setFollow, setHear, setMode, setTalk, setVoice, useCall, type TalkChoice } from './call-session.ts';
import { closeCallSettings, useCallSettingsOpen } from './CallStrip.tsx';

/**
 * Call settings: everything about a call that is not needed while talking. The voice and who words it, how the call
 * hears, how the microphone listens, whether the call moves with the file, its sounds, whether agents may ring, and
 * what the call remembers. Opened from More in the call; one dialog, drawn by the dock.
 */

function megabytes(bytes: number): string { return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`; }

/** A select in the editor's own look: the native list, without the native box, with the editor's chevron. */
function Select({ label, value, onChange, disabled, testId, title, children }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; testId: string; title?: string; children: React.ReactNode }) {
  return (
    <label className="call-field"><span>{label}</span>
      <span className="call-select">
        <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={testId} title={title}>{children}</select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </label>
  );
}

/** An on/off switch with its words: the whole row is the target. */
function Switch({ on, onChange, label, note, testId }: { on: boolean; onChange: (on: boolean) => void; label: string; note?: string; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="call-switch" onClick={() => onChange(!on)} data-testid={testId}>
      <span className="call-switch-words"><span>{label}</span>{note ? <span className="call-switch-note">{note}</span> : null}</span>
      <span className="call-switch-track" aria-hidden="true"><span className="call-switch-knob" /></span>
    </button>
  );
}

/** What the call keeps for every later call, with a way to forget each, or all. */
function Remembered() {
  const t = useT();
  const items = useCall((x) => x.preferences);
  const language = useCall((x) => x.language);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { if (!items) void loadPreferences(); }, [items]);
  const forget = (id?: string) => { setProblem(null); void forgetPreference(id).catch((err: Error) => setProblem(err.message)); };
  const day = (at: number) => formatDate(at, { day: 'numeric', month: 'short' });
  return (
    <div className="call-remembered" data-testid="call-remembered">
      {items?.length ? (
        <>
          <ul>
            {items.map((p) => (
              <li key={p.id}>
                <span dir="auto">{preferenceLabel(p, language)}</span>
                <span className="call-remembered-when">{t('said {day}', { day: day(p.at) })}</span>
                <button type="button" className="call-btn" onClick={() => forget(p.id)} aria-label={t('Forget “{what}”', { what: preferenceLabel(p, language) })}>{t('Forget')}</button>
              </li>
            ))}
          </ul>
          <div><button type="button" className="call-btn" onClick={() => forget()} data-testid="call-forget-all">{t('Forget all')}</button></div>
        </>
      ) : <p className="call-note">{t('Nothing yet. Say “keep it short”, “call me …” or “from now on, always ask before you start” in a call and it stays.')}</p>}
      {problem ? <p className="call-error" role="alert">{problem}</p> : null}
    </div>
  );
}

function SettingsBody() {
  const t = useT();
  const s = useCall((x) => x);
  const talk = s.status?.talk;
  const model = talk?.models.find((m) => m.recommended);
  const languageVoices = s.status?.voices.filter((v) => v.language === s.language) ?? [];
  const chosen = languageVoices.find((v) => v.id === s.voices[s.language]);
  const preferred = languageVoices.find((v) => v.preferred);
  const currentVoice = chosen ?? (preferred?.installed ? preferred : languageVoices.find((v) => v.installed) ?? preferred);
  const parakeet = s.status?.listen.parakeet;
  const canChooseHearing = Boolean(parakeet?.installed && s.status?.listen.whisper?.installed && s.status.listen.whisper.gpu);
  const talker = s.talk === 'auto' ? talk?.auto : s.talk;
  const talkerWords = talker === 'local' ? t('on this computer ({model})', { model: talk?.models.find((m) => m.installed && m.recommended)?.label ?? talk?.models.find((m) => m.installed)?.label ?? 'Qwen3' })
    : talker?.startsWith('claude') ? t('with Claude Code on your plan') : t('with simple rules');
  const languages = callLanguagesOf(s.status);
  const [sounds, setSounds] = useState(soundsOn);
  const settings = useIncoming((x) => x.settings);
  const [problem, setProblem] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const change = (patch: Parameters<typeof setAgentCalls>[0]) => void setAgentCalls(patch).then(setProblem);
  const quiet = Boolean(settings?.quietFrom && settings.quietTo);
  return (
    <div className="call-settings-body">
      {s.status ? (
        <section className="call-settings-sec" aria-labelledby="call-set-voice">
          <h3 id="call-set-voice">{t('Voice')}</h3>
          {languages.length > 1 ? (
            <Select label={t('Call language')} value={s.language} onChange={(v) => setCallLanguage(v as typeof s.language)} testId="call-language">
              {languages.map((l) => <option key={l} value={l}>{l === 'de' ? 'Deutsch' : 'English'}</option>)}
            </Select>
          ) : null}
          <Select label={t('Voice')} value={currentVoice?.id ?? ''} disabled={s.installing} onChange={(v) => void setVoice(s.language, v)} testId="call-voice" title={currentVoice?.attribution ?? currentVoice?.licence}>
            {languageVoices.map((v) => <option key={v.id} value={v.id}>{v.installed ? v.name : t('{voice}, download {size}', { voice: v.name, size: megabytes(v.bytes) })}</option>)}
          </Select>
          <p className="call-note">{t('The voice talks {how}; the details are in the chat.', { how: talkerWords })}</p>
          <button type="button" className="call-disclosure" aria-expanded={advanced} aria-controls="call-set-advanced" onClick={() => setAdvanced(!advanced)} data-testid="call-advanced">
            {advanced ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{t('Advanced')}
          </button>
          {advanced ? (
            <div className="call-advanced" id="call-set-advanced">
              <Select label={t('Voice model')} value={s.talk} onChange={(v) => setTalk(v as TalkChoice)} testId="call-talk">
                <option value="auto">{t('Automatic')}</option>
                <option value="local" disabled={!talk?.models.some((m) => m.installed)}>{t('This computer')}</option>
                <option value="claude" disabled={!talk?.claude}>{t('Claude Code')}</option>
                {(['opus', 'sonnet'] as const).map((m) => <option key={m} value={`claude-${m}`} disabled={!talk?.claude}>{`${t('Claude Code')} · ${m.charAt(0).toUpperCase()}${m.slice(1)}`}</option>)}
                <option value="rules">{t('Simple')}</option>
              </Select>
              {canChooseHearing ? (
                <Select label={t('Speech recognition')} value={s.hear} onChange={(v) => setHear(v as 'auto' | 'whisper')} testId="call-hear">
                  <option value="auto">{t('On this computer (Parakeet)')}</option><option value="whisper">{t('Whisper on the graphics card')}</option>
                </Select>
              ) : null}
              {model && !model.installed && talker !== 'local' ? <button type="button" className="call-btn" disabled={s.installing} title={model.label} onClick={() => void installTalkModel()}>{s.installing ? t('Downloading…') : t('Download a voice model for this computer ({size})', { size: megabytes(model.bytes) })}</button> : null}
              {parakeet && !parakeet.installed && s.status.listen.engine !== 'parakeet' ? <button type="button" className="call-btn" disabled={s.installing} onClick={() => void installHearing()} data-testid="call-install-hearing" title={parakeet.attribution}>{s.installing ? t('Downloading…') : t('Hear better with Parakeet ({size})', { size: megabytes(parakeet.bytes) })}</button> : null}
              {s.latencyMs != null ? <p className="call-note">{t('The last answer started {seconds} s after you stopped speaking.', { seconds: (s.latencyMs / 1000).toFixed(1) })}</p> : null}
            </div>
          ) : null}
        </section>
      ) : null}
      <section className="call-settings-sec" aria-labelledby="call-set-during" data-testid="call-prefs">
        <h3 id="call-set-during">{t('During a call')}</h3>
        <Switch on={s.follow} onChange={setFollow} label={t('Move with the file you open')} note={t('Off: the call stays in its file until you name another.')} testId="call-follow" />
        <Switch on={s.mode === 'hold'} onChange={(on) => setMode(on ? 'hold' : 'open')} label={t('Hold to talk')} note={t('The microphone only listens while you hold the button.')} testId="call-hold-mode" />
        <Switch on={sounds} onChange={(on) => { setSoundsOn(on); setSounds(on); }} label={t('Call sounds')} note={t('A soft tone when a call connects, ends or rings. Never over the voice.')} testId="call-sounds" />
        {settings ? <Switch on={settings.enabled} onChange={(on) => change({ enabled: on })} label={t('Agents may call you when they need your answer')} note={t('Only for requests you made, one call at a time. It rings for 30 seconds, then the question waits in the chat.')} testId="agent-calls" /> : null}
        {settings?.enabled ? (
          <div className="call-quiet-hours" role="group" aria-label={t('Quiet hours')}>
            <Switch on={quiet} onChange={(on) => change(on ? { quietFrom: '22:00', quietTo: '08:00' } : { quietFrom: null, quietTo: null })} label={t('Quiet hours')} testId="agent-calls-quiet" />
            {quiet ? (
              <div className="call-quiet-times">
                <label>{t('From')} <input type="time" value={settings.quietFrom ?? ''} onChange={(e) => e.target.value && change({ quietFrom: e.target.value })} /></label>
                <label>{t('To')} <input type="time" value={settings.quietTo ?? ''} onChange={(e) => e.target.value && change({ quietTo: e.target.value })} /></label>
              </div>
            ) : null}
          </div>
        ) : null}
        {problem ? <p className="call-error" role="alert">{problem}</p> : null}
      </section>
      <section className="call-settings-sec" aria-labelledby="call-set-memory">
        <h3 id="call-set-memory">{t('Remembered for every call')}</h3>
        <p className="call-note">{t('Things you asked for in a call, such as “keep it short”. Forget one and the next call no longer knows it.')}</p>
        <Remembered />
      </section>
    </div>
  );
}

/** The dialog itself, in the page's body: the dock it opens from is transformed, which would carry a fixed layer. */
export function CallSettingsHost() {
  const t = useT();
  const open = useCallSettingsOpen();
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement;
    ref.current?.querySelector<HTMLElement>('button, select, input')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeCallSettings(); } };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (back.current instanceof HTMLElement && back.current.isConnected) back.current.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="dialog-scrim call-settings-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) closeCallSettings(); }}>
      <div ref={ref} className="dialog call-settings" role="dialog" aria-modal="true" aria-labelledby="call-settings-title" data-testid="call-settings">
        <header className="dialog-head"><h2 className="dialog-title" id="call-settings-title">{t('Call settings')}</h2><IconButton icon={<X size={16} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={closeCallSettings} testId="call-settings-close" /></header>
        <SettingsBody />
      </div>
    </div>,
    document.body,
  );
}
