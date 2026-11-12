import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { language, languagesForPicker } from './registry.ts';
import { setLanguagePreference, useLanguagePreference } from './preference.ts';
import { useT } from './react.ts';

/**
 * The interface language of this device: Automatic, or one of Omarchy's 50, each under its own name. A choice
 * shows at once and is kept in this browser only; designs, chats and other devices are not touched.
 */
export function LanguageSelect({ testId = 'setting-language', className }: { testId?: string; className?: string }) {
  const t = useT();
  const { preference, automatic } = useLanguagePreference();
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => languagesForPicker(t.code), [t.code]);
  const auto = language(automatic);
  const choose = (value: string) => {
    setBusy(true);
    void setLanguagePreference(value).finally(() => setBusy(false));
  };
  return (
    <label className={`field field-select language-select${className ? ` ${className}` : ''}`}>
      <select
        className="field-input"
        data-testid={testId}
        value={preference}
        aria-label={t('Interface language')}
        aria-busy={busy || undefined}
        onChange={(e) => choose(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <option value="auto">{t('Automatic ({language})', { language: auto?.name ?? 'English' })}</option>
        {list.map((l) => (
          <option key={l.code} value={l.code} lang={l.formatLocale} dir={l.dir}>{l.name}</option>
        ))}
      </select>
      <ChevronDown size={12} className="field-chevron" />
    </label>
  );
}
