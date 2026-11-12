# Interface languages

Bogen's editor, Home and phone app speak Omarchy's 50 languages. This folder holds everything about it:

| File | What it is |
| --- | --- |
| `registry.ts` | The 50 languages, copied from Omarchy's `locales.json` (codes, native names, formatting locale, direction). |
| `resolve.ts` | Which registry language a browser or system locale tag means (`nb` → `no`, `zh-Hant-HK` → `zh-TW`, ...). |
| `core.ts` | The translator: lookup, `{placeholders}`, plurals through `Intl.PluralRules`, rich text. |
| `store.ts` | The language in use, lazy catalog loading (one chunk per language), the plain `t` for code outside React. |
| `preference.ts` | This device's choice, or Automatic: Omarchy's language on this computer, else the browser's, else English. |
| `react.ts` | `useT()`, the hook components use. |
| `format.ts` | Dates, times, numbers and lists in the language's formatting locale. |
| `LanguageSelect.tsx` | The picker in Settings and on the phone. |
| `locales/<code>.json` | One catalog per language except English, keyed by the English text. |
| `source.json` | The English inventory, written by `node scripts/i18n/audit.ts --write-source`. |

## Writing interface text

The key of a message is its exact English text. Missing translations show the English, never a key.

```tsx
import { useT } from '../i18n/react.ts';

function Panel({ name, count }: Props) {
  const t = useT();                                   // in every component that renders words
  return (
    <section aria-label={t('Layers')}>
      <h2>{t('Rename {name}', { name })}</h2>          // placeholders, never string concatenation
      <p>{t.n(count, '{count} layer', '{count} layers')}</p>   // plurals: English one/other, key = other
      <p>{t.rich('Press {key} to search', { key: <kbd>Ctrl+K</kbd> })}</p>
      <button title={t('Settings ({shortcut})', { shortcut: 'Ctrl+,' })}>…</button>
    </section>
  );
}
```

Outside components (toasts, commands, ops), import the plain `t` from `i18n/store.ts`; it uses the language at
the moment it runs. A component that shows words must still call `useT()` so it re-renders on a switch.

Lists defined at module level mark their labels with `msg('…')` and translate where they render: `t(item.label)`.

### Rules

- One message per sentence or self-contained phrase. Never build a sentence from translated pieces.
- Keep the English exactly as it was: tests read it.
- Not translated, and passed through placeholders instead: names and text of the person's documents, layers,
  files, chats, comments and agents' answers; errors that come from the server; CSS properties and values, code,
  keyboard shortcuts (`Ctrl+K`), MCP tool names, CLI commands, file extensions, URLs; product names such as Bogen,
  Omarchy, Claude, Codex, Figma, GitHub.
- Strings compared in logic, `data-testid`, class names, storage keys and protocol values stay as they are.
- `dir="auto"` on elements that show text a person or an agent wrote, so it keeps its own direction.
- Dates and numbers through `format.ts`, not `toLocaleString(undefined)`.
- The service worker (`pwa/`) and WebMCP tool descriptions (`lib/webmcp*.ts`, for agents) stay English.

## Checking

```sh
node scripts/i18n/audit.ts                       # coverage per language and what is left
node scripts/i18n/audit.ts --candidates <file>   # English literals in a file that are not wrapped yet
node scripts/i18n/audit.ts --missing de          # messages German lacks
```

`apps/editor/test/i18n-*.test.ts` keep the registry, resolution, plurals, loading and every catalog's keys,
placeholders and plural forms in order. Translations are machine-made by a language model and have not been
reviewed by native speakers; corrections are welcome as edits to `locales/<code>.json`.
