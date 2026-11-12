import { useEffect, useMemo, useRef, useState } from 'react';
import { Shapes } from 'lucide-react';
import { insertIcon } from '../ops/components.ts';
import { editor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton, Popover } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';

type Icons = typeof import('@bogen/core/icons');

let loading: Promise<Icons> | null = null;
/** The set is 400 KB, so it arrives the first time someone asks for it. */
function loadIcons(): Promise<Icons> {
  loading ??= import('@bogen/core/icons');
  return loading;
}

const COLUMNS = 8;
const PAGE = COLUMNS * 12;

/**
 * The icon picker. In the toolbar it has its own button; when the toolbar has no room for it (`inline` false), it
 * opens from the More tools menu and hangs under that menu's button.
 */
export function IconPicker({ inline = true }: { inline?: boolean }) {
  const t = useT();
  const open = useUi((s) => s.iconsOpen);
  const setOpen = (v: boolean) => ui().set({ iconsOpen: v });
  const [query, setQuery] = useState('');
  const [icons, setIcons] = useState<Icons | null>(null);
  const [shown, setShown] = useState(PAGE);
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (open && !icons) void loadIcons().then(setIcons);
  }, [open, icons]);
  useEffect(() => setShown(PAGE), [query]);
  const names = useMemo(() => (icons ? icons.searchIcons(query, 3000) : []), [icons, query]);
  const place = (name: string) => {
    if (!icons) return;
    try {
      insertIcon(icons.iconSpec(name));
      setOpen(false);
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const at = inline ? anchor.current : document.querySelector<HTMLElement>('[data-testid="tools-more"]');
  return (
    <span ref={anchor}>
      {inline ? <IconButton icon={<Shapes size={16} />} title={t('Icons')} active={open} onClick={() => setOpen(!open)} testId="tool-icons" /> : null}
      {open ? (
        <Popover anchor={at} side="below" width={296} onClose={() => setOpen(false)} className="icon-popover">
          <input
            autoFocus
            className="font-search"
            placeholder={t('Search Lucide icons')}
            value={query}
            data-testid="icon-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && names[0]) place(names[0]);
            }}
          />
          <div
            className="icon-grid"
            data-testid="icon-grid"
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) setShown((n) => n + PAGE);
            }}
          >
            {names.slice(0, shown).map((name) => (
              <button
                key={name}
                type="button"
                className="icon-cell"
                title={name}
                aria-label={name}
                data-testid="icon-cell"
                data-icon={name}
                onClick={() => place(name)}
                dangerouslySetInnerHTML={{ __html: icons!.iconSvg(name) }}
              />
            ))}
            {icons && !names.length ? <div className="hint icon-none">{t('No icon matches.')}</div> : null}
          </div>
        </Popover>
      ) : null}
    </span>
  );
}
