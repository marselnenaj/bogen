import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Languages } from 'lucide-react';
import { brandLinkOf, contentLanguageOf, languageName, normalizeLanguageTag, resolveContentLanguage, setContentLanguage, type ContentLanguageMode, type RunLanguageChoice } from '@bogen/core';
import { maybeSession, session } from '../doc/session.ts';
import { brandApi } from '../lib/brand-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { LANGUAGES } from '../i18n/registry.ts';
import { useT } from '../i18n/react.ts';
import { currentLanguage, t } from '../i18n/store.ts';
import { Popover, SelectField } from '../ui/controls.tsx';
import '../styles/content-language.css';

/**
 * The design content language in the prompt bar: the language of the words inside the design, never Bogen's own
 * interface language and never the operating system's. The file's default lives in the document (and syncs); a
 * choice for one request overrides it and goes with that request only. Choosing either starts nothing: only Send does.
 */

const FILE = '';

/** The file's design language, live: it follows sync, undo and a switch of branch. */
export function useFileLanguage(): string | null {
  const s = maybeSession();
  // After any transaction: a checkout of a branch replaces the live design's meta, and only the value is compared.
  const subscribe = useCallback((notify: () => void) => {
    if (!s) return () => {};
    s.y.on('afterTransaction', notify);
    return () => s.y.off('afterTransaction', notify);
  }, [s]);
  return useSyncExternalStore(subscribe, () => (s ? contentLanguageOf(s.doc) : null));
}

/**
 * The brand's voice language, the soft default. Asked when the prompt opens on a file, again when the file's own
 * brand link changes (it syncs in the document) and when the server says the linked brand changed (its `brand`
 * event, for that brand only). No polling. Null when there is none or the server is older.
 */
export function useBrandVoice(fileId: string | null): string | null {
  const s = maybeSession();
  const subscribe = useCallback((notify: () => void) => {
    if (!s) return () => {};
    s.y.on('afterTransaction', notify);
    return () => s.y.off('afterTransaction', notify);
  }, [s]);
  const linked = useSyncExternalStore(subscribe, () => (s ? brandLinkOf(s.doc)?.id ?? null : null));
  const [voice, setVoice] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!fileId || !linked) return;
    return onServerEvent((e) => { if (e.t === 'brand' && e.id === linked) setAsked((n) => n + 1); });
  }, [fileId, linked]);
  useEffect(() => {
    if (!fileId || !linked) return void setVoice(null);
    let live = true;
    brandApi.ofFile(fileId).then((b) => { if (live) setVoice(b.language ?? null); }, () => {});
    return () => { live = false; };
  }, [fileId, linked, asked]);
  return voice;
}

/** A language's name in the interface language, with its own name where that differs: "German · Deutsch". */
export function languageLabel(tag: string): string {
  const local = languageName(tag, currentLanguage());
  const own = languageName(tag, tag);
  return own && own.toLowerCase() !== local.toLowerCase() ? `${local} · ${own}` : local;
}

export function languageOptions(extra: (string | null | undefined)[]): { value: string; label: string }[] {
  const tags = new Set<string>(LANGUAGES.map((l) => l.code));
  for (const tag of extra) if (tag) tags.add(tag);
  return [...tags].map((tag) => ({ value: tag, label: languageLabel(tag) })).sort((a, b) => a.label.localeCompare(b.label, currentLanguage()));
}

function setFileLanguage(tag: string | null): void {
  const s = session();
  s.tx(() => setContentLanguage(s.doc, tag));
}

export interface LanguageChoiceProps {
  /** This request's choice; empty means the file's language and plain writing. */
  value: RunLanguageChoice;
  onChange: (next: RunLanguageChoice) => void;
  /** Whether the run can hold a language version: only Change it can, as a branch of the whole design. */
  canAdd: boolean;
  /** Whether layers are selected, for the wording of quick instructions. */
  selection: boolean;
  /** Puts a quick instruction into the message, for the person to edit and send. */
  onInstruction: (text: string) => void;
  /** The brand's voice language, the soft default (useBrandVoice). */
  brand: string | null;
}

/** What a request will do with the language, for the line under the message and the button's name. */
export function effectiveLanguage(value: RunLanguageChoice, file: string | null, brand: string | null) {
  return resolveContentLanguage({ run: value, file, brand });
}

/** The compact button next to Send, and its popover. */
export function LanguageChoice({ value, onChange, canAdd, selection, onInstruction, brand }: LanguageChoiceProps) {
  const t = useT();
  const file = useFileLanguage();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const lang = effectiveLanguage(value, file, brand);
  const mode: ContentLanguageMode = value.mode ?? 'write';
  const name = lang ? languageName(lang.tag, currentLanguage()) : '';
  const title = lang ? t('Design language: {language}', { language: name }) : t('Design language: not set');
  const runOptions = [
    { value: FILE, label: file ? t("The file's language ({language})", { language: languageName(file, currentLanguage()) }) : brand ? t("The brand's voice ({language})", { language: languageName(brand, currentLanguage()) }) : t('Not set') },
    ...languageOptions([value.tag, file]),
  ];
  // A tag typed for this request can be chosen as the default too; picking it for the request alone never saves it.
  const fileOptions = [{ value: FILE, label: t('Not set') }, ...languageOptions([file, value.tag])];
  const pick = (tag: string) => onChange({ ...(tag ? { tag } : {}), ...(value.mode && value.mode !== 'write' ? { mode: value.mode } : {}) });
  const applyCustom = () => {
    const tag = normalizeLanguageTag(custom);
    if (!tag) return setProblem(t('Not a language tag such as fr-CA or pt-BR.'));
    setProblem(null);
    setCustom('');
    pick(tag);
  };
  const instruction = !lang ? null
    : mode === 'translate' ? (selection ? t('Translate the selection into {language}.', { language: name }) : t('Translate this page into {language}.', { language: name }))
    : mode === 'add' ? t('Add a {language} version of this design.', { language: name })
    : null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`content-lang-btn${value.tag || (value.mode && value.mode !== 'write') ? ' is-chosen' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="prompt-language"
        data-language={lang?.tag ?? ''}
        data-source={lang?.source ?? ''}
      >
        <Languages size={13} aria-hidden="true" />
        {lang ? <span className="content-lang-code">{lang.tag}</span> : null}
      </button>
      {open ? (
        <Popover anchor={button.current} onClose={() => setOpen(false)} width={300} side="below" focus className="content-lang-pop">
          <div role="dialog" aria-label={t('Design language')} className="content-lang" data-testid="prompt-language-pop">
            <div className="content-lang-title">{t('Design language')}</div>
            <p className="content-lang-note">{t('The language of the words in the design, not of Bogen or of your message.')}</p>
            <SelectField<string> className="content-lang-select" label={t('This request')} value={value.tag ?? FILE} options={runOptions} onChange={pick} testId="prompt-language-run" />
            <div className="content-lang-custom">
              <input
                className="field-input"
                value={custom}
                placeholder={t('Other language tag')}
                aria-label={t('Other language tag')}
                maxLength={20}
                spellCheck={false}
                onChange={(e) => { setCustom(e.target.value); setProblem(null); }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
                }}
                data-testid="prompt-language-custom"
              />
              <button type="button" className="run-link" onClick={applyCustom} disabled={!custom.trim()}>{t('Use')}</button>
            </div>
            {problem ? <p className="content-lang-problem" role="alert">{problem}</p> : null}
            {lang ? (
              <fieldset className="content-lang-modes">
                <legend className="content-lang-legend">{t('What to do with it')}</legend>
                {([
                  ['write', t('Write new text in it'), t('New and changed copy is written in it. Other text stays as it is.')],
                  ['translate', t('Translate in place'), t('Same screens, layers and styles: only the words change.')],
                  ['add', t('Add a language version'), canAdd ? t('A branch inside this file, named after the language. The original stays as it is.') : t('Needs Change it: the version is a branch of the whole design.')],
                ] as const).map(([m, label, hint]) => (
                  <label key={m} className={`content-lang-mode${mode === m ? ' is-on' : ''}${m === 'add' && !canAdd ? ' is-disabled' : ''}`}>
                    <input
                      type="radio"
                      name="content-lang-mode"
                      value={m}
                      checked={mode === m}
                      disabled={m === 'add' && !canAdd}
                      onChange={() => onChange({ ...(value.tag ? { tag: value.tag } : {}), ...(m !== 'write' ? { mode: m } : {}) })}
                      onKeyDown={(e) => e.stopPropagation()}
                      data-testid={`prompt-language-${m}`}
                    />
                    <span className="content-lang-mode-text">
                      <span className="content-lang-mode-name">{label}</span>
                      <span className="content-lang-mode-hint">{hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {instruction ? (
              <button type="button" className="content-lang-quick" onClick={() => { onInstruction(instruction); setOpen(false); }} data-testid="prompt-language-quick" dir="auto">{instruction}</button>
            ) : null}
            <div className="content-lang-file">
              <SelectField<string> className="content-lang-select" label={t('File default')} value={file ?? FILE} options={fileOptions} onChange={(tag) => setFileLanguage(tag || null)} testId="prompt-language-file" />
              <p className="content-lang-note">
                {!file && brand ? `${t("The brand's voice ({language}) applies while the file sets none.", { language: languageName(brand, currentLanguage()) })} ` : ''}
                {t('Kept in this file and synced. Choosing it starts nothing.')}
              </p>
            </div>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** The line under the message when this request does something with the language beyond the file's default. */
export function languageNote(value: RunLanguageChoice, lang: ReturnType<typeof effectiveLanguage>): string | null {
  if (!lang) return null;
  const language = languageName(lang.tag, currentLanguage());
  if (lang.mode === 'translate') return t('Translates into {language} in place.', { language });
  if (lang.mode === 'add') return t('Adds a {language} version as a branch; the original stays as it is.', { language });
  if (value.tag) return t('Writes in {language}, for this request.', { language });
  return null;
}
