import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { COMMANDS, displayKey } from '../commands/registry.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';

/** Drawn straight from the registry that handles the keys, so that it can never be out of date. */
export function ShortcutsDialog() {
  const t = useT();
  const open = useEditor((s) => s.shortcutsOpen);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
    }
  }, [open]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, typeof COMMANDS>();
    for (const c of COMMANDS) {
      if (!c.keys?.length) continue;
      const hay = `${t(c.title)} ${t(c.group)} ${c.title} ${c.group} ${c.keys.map(displayKey).join(' ')}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      out.set(c.group, [...(out.get(c.group) ?? []), c]);
    }
    return [...out.entries()];
  }, [query, t]);
  if (!open) return null;
  const close = () => editor().set({ shortcutsOpen: false });
  return (
    <div className="dialog-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog" role="dialog" aria-label={t('Keyboard shortcuts')} data-testid="shortcuts-dialog">
        <header className="dialog-head">
          <Search size={14} />
          <input
            ref={inputRef}
            className="dialog-search"
            placeholder={t('Search shortcuts')}
            value={query}
            data-testid="shortcuts-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); close(); }
            }}
          />
          <IconButton icon={<X size={14} />} title={t('Close')} onClick={close} />
        </header>
        <div className="dialog-body">
          {!groups.length ? <div className="hint">{t('No shortcut matches "{query}".', { query })}</div> : null}
          {groups.map(([group, list]) => (
            <section key={group} className="shortcut-group">
              <h3>{t(group)}</h3>
              {list.map((c) => (
                <div key={c.id} className="shortcut-row" data-testid="shortcut-row">
                  <span>{t(c.title)}</span>
                  <span className="shortcut-keys">{c.keys!.slice(0, 2).map((k) => <kbd key={k}>{displayKey(k)}</kbd>)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
