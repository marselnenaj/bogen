import { useEffect, useMemo, useRef, useState } from 'react';
import { Command as CommandIcon, FileText, Layers, Palette, Rows3 } from 'lucide-react';
import { COMMANDS, displayKeys } from '../commands/registry.ts';
import { session } from '../doc/session.ts';
import { api, type FileEntry } from '../lib/api.ts';
import { fuzzyMatch } from '../lib/fuzzy.ts';
import { setStyle } from '../ops/ops.ts';
import { goToLayer } from '../ops/reveal.ts';
import { editor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { copyText } from '../ui/controls.tsx';
import { t } from '../i18n/store.ts';
import { useT } from '../i18n/react.ts';

type Kind = 'command' | 'layer' | 'page' | 'file' | 'token';
interface Item { key: string; kind: Kind; title: string; hint?: string; keys?: string; score: number; indices: number[]; run: () => void }

const KIND_ICON = { command: CommandIcon, layer: Layers, page: Rows3, file: FileText, token: Palette };
const KIND_WEIGHT: Record<Kind, number> = { command: 12, page: 8, file: 4, token: 2, layer: 0 };
const PREFIXES: Record<string, Kind> = { '>': 'command', '@': 'layer', '#': 'token', '/': 'page', '~': 'file' };
const RECENT_KEY = 'bogen-palette-recent';
const LIMIT = 60;

function recentCommands(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, 8))); } catch { /* fine */ }
}

function applyToken(name: string, kind: string): void {
  const state = editor();
  const { snap } = session();
  const value = `var(--${name})`;
  if (kind === 'color' && state.selection.length) {
    const text = state.selection.filter((id) => snap.nodes.get(id)?.type === 'text');
    const rest = state.selection.filter((id) => snap.nodes.get(id)?.type !== 'text');
    if (text.length) setStyle(text, { color: value });
    if (rest.length) setStyle(rest, { backgroundColor: value, backgroundImage: null, background: null });
    state.showToast(t('Applied {name}', { name }));
    return;
  }
  void copyText(value).then(() => state.showToast(t('Copied {value}', { value })));
  state.set({ leftTab: 'tokens' });
}

function search(query: string, files: FileEntry[]): Item[] {
  const raw = query.trimStart();
  const only = PREFIXES[raw[0] ?? ''];
  const q = only ? raw.slice(1).trim() : raw.trim();
  const { snap } = session();
  const state = editor();
  const out: Item[] = [];
  const add = (kind: Kind, key: string, title: string, run: () => void, extra: { hint?: string; keys?: string; also?: string } = {}) => {
    if (only && only !== kind) return;
    const m = fuzzyMatch(q, title);
    const alt = !m && extra.also ? fuzzyMatch(q, extra.also) : null;
    if (!m && !alt) return;
    out.push({ key, kind, title, hint: extra.hint, keys: extra.keys, score: (m?.score ?? (alt!.score - 20)) + KIND_WEIGHT[kind], indices: m?.indices ?? [], run });
  };
  const hasSelection = state.selection.length > 0;
  for (const c of COMMANDS) {
    if ((c.needsSelection && !hasSelection) || (c.when && !c.when())) continue;
    add('command', `c:${c.id}`, t(c.title), () => { remember(c.id); c.run(); }, { hint: t(c.group), keys: displayKeys(c), also: t(c.group) });
  }
  if (q || only) {
    for (const p of snap.pages) add('page', `p:${p.id}`, p.name, () => state.set({ pageId: p.id, selection: [], hoverId: null }), { hint: t('Page') });
    for (const f of files) if (f.id !== state.fileId) add('file', `f:${f.id}`, f.name, () => { location.hash = `#/file/${f.id}`; }, { hint: t('File') });
    for (const t of snap.tokens) add('token', `t:${t.name}`, t.name, () => applyToken(t.name, t.kind), { hint: `${t.kind} ${t.value}`, also: t.value });
    const pageNames = new Map(snap.pages.map((p) => [p.id, p.name]));
    let scanned = 0;
    for (const n of snap.nodes.values()) {
      if (scanned++ > 30000) break;
      // Library copies are on no page and cannot be gone to.
      if (!snap.pageOf(n.id)) continue;
      const words = n.text && n.text !== n.name ? n.text.slice(0, 200) : undefined;
      add('layer', `l:${n.id}`, n.name || n.tag, () => goToLayer(n.id), { hint: pageNames.get(snap.pageOf(n.id) ?? '') ?? t('Layer'), also: words });
    }
  }
  if (!q) {
    const recent = recentCommands();
    const rank = (i: Item) => {
      const at = recent.indexOf(i.key.slice(2));
      return i.kind === 'command' && at >= 0 ? 100 - at : 0;
    };
    return out.sort((a, b) => rank(b) - rank(a)).slice(0, LIMIT);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, LIMIT);
}

function Marked({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const out: React.ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = (key: number) => {
    if (run) out.push(on ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  [...text].forEach((c, i) => {
    const m = set.has(i);
    if (m !== on) { flush(i); on = m; }
    run += c;
  });
  flush(text.length);
  return <>{out}</>;
}

/** Everything by name, from the keyboard. Ctrl+P; `>` commands, `@` layers, `#` tokens, `/` pages, `~` files. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <PaletteBody /> : null;
}

function PaletteBody() {
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    inputRef.current?.focus();
    api.files().then(setFiles).catch(() => {});
    return () => { if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus({ preventScroll: true }); };
  }, []);
  const items = useMemo(() => search(query, files), [query, files, t]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);
  const close = () => ui().set({ paletteOpen: false });
  const choose = (item: Item | undefined) => {
    if (!item) return;
    close();
    // Commands act on the canvas, not on the field that is going away.
    requestAnimationFrame(item.run);
  };
  return (
    <div className="dialog-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }} data-ui>
      <div className="dialog palette" role="dialog" aria-label={t('Command palette')} data-testid="palette">
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          placeholder={t('Search commands, layers, pages, files, tokens')}
          value={query}
          spellCheck={false}
          data-testid="palette-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.min(items.length - 1, a + 1)); return; }
            if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey && query)) { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.max(0, a - 1)); return; }
            if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); return; }
            if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(items.length - 1); return; }
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(items[active]); return; }
            if (!(e.ctrlKey && e.key.toLowerCase() === 'p')) e.stopPropagation();
          }}
        />
        <div ref={listRef} id="palette-list" className="palette-list" role="listbox" aria-label={t('Results')} data-testid="palette-list">
          {!items.length ? <div className="palette-empty" dir="auto">{t('Nothing matches "{query}".', { query })}</div> : null}
          {items.map((it, i) => {
            const Icon = KIND_ICON[it.kind];
            return (
              <div
                key={it.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                className={`palette-row${i === active ? ' is-active' : ''}`}
                data-testid="palette-row"
                data-kind={it.kind}
                onPointerMove={() => { if (i !== active) setActive(i); }}
                onPointerDown={(e) => { e.preventDefault(); choose(it); }}
              >
                <Icon size={14} className="palette-icon" aria-hidden="true" />
                <span className="palette-title" dir="auto"><Marked text={it.title} indices={it.indices} /></span>
                {it.hint ? <span className="palette-hint">{it.hint}</span> : null}
                {it.keys ? <kbd className="palette-keys">{it.keys}</kbd> : null}
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><span>{t('{key} runs', { key: 'Enter' })}</span><span>{t('{keys} moves', { keys: '↑↓' })}</span><span>{t('{prefix} commands', { prefix: '>' })}</span><span>{t('{prefix} layers', { prefix: '@' })}</span><span>{t('{prefix} tokens', { prefix: '#' })}</span><span>{t('{prefix} pages', { prefix: '/' })}</span><span>{t('{prefix} files', { prefix: '~' })}</span></div>
      </div>
    </div>
  );
}
