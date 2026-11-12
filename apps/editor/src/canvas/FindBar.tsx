import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import { findText, replaceText, type TextSearch } from '@bogen/core';
import { useSnapVersion, useStructureVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { revealIfOffscreen } from '../ops/reveal.ts';
import { findLayers, parseLayerQuery } from '../panels/layer-filter.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { IconButton } from '../ui/controls.tsx';
import { rectOf } from './measure.ts';
import { useT } from '../i18n/react.ts';

interface Match { id: string; pageId: string }

function searchOf(find: ReturnType<typeof ui>['find']): TextSearch {
  return { query: find.query, caseSensitive: Boolean(find.matchCase), wholeWord: Boolean(find.wholeWord) };
}

/**
 * What matches. Finding goes by layer names and words on this page. With replace open it goes by the words
 * of text layers only, as those are what can be replaced, on this page or on every page.
 */
function matchesNow(find: ReturnType<typeof ui>['find'], pageId: string | null): Match[] {
  if (!pageId) return [];
  if (find.replace) {
    if (!find.query) return [];
    return findText(session().doc, searchOf(find), find.allPages ? {} : { pageId }).map((h) => ({ id: h.id, pageId: h.pageId }));
  }
  const q = parseLayerQuery(find.query);
  if (!q.words.length && q.kind === 'all') return [];
  return findLayers(session().snap, pageId, q, true).map((id) => ({ id, pageId }));
}

function useMatches(): Match[] {
  const find = useUi((s) => s.find);
  const pageId = useEditor((s) => s.pageId);
  const version = useStructureVersion();
  const snapVersion = useSnapVersion();
  return useMemo(() => matchesNow(find, pageId), [find.query, find.replace, find.matchCase, find.wholeWord, find.allPages, pageId, version, snapVersion]);
}

export function openFind(): void {
  const st = ui();
  if (st.find.open && !st.find.replace) {
    document.querySelector<HTMLInputElement>('[data-testid="find-input"]')?.select();
    return;
  }
  st.set({ find: { ...st.find, open: true, replace: false, index: 0 } });
}

/** Ctrl+H: find with a field to replace what is found. */
export function openFindReplace(): void {
  const st = ui();
  if (st.find.open && st.find.replace) {
    document.querySelector<HTMLInputElement>('[data-testid="replace-input"]')?.select();
    return;
  }
  st.set({ find: { ...st.find, open: true, replace: true, index: 0 } });
}

export function closeFind(): void {
  const st = ui();
  st.set({ find: { ...st.find, open: false } });
}

/** Find on canvas: Ctrl+F, Enter steps through what matches on this page and brings it into view. */
export function FindBar() {
  const open = useUi((s) => s.find.open);
  return open ? <FindBody /> : null;
}

function setFind(patch: Partial<ReturnType<typeof ui>['find']>): void {
  ui().set({ find: { ...ui().find, ...patch } });
}

function FindBody() {
  const t = useT();
  const find = useUi((s) => s.find);
  const matches = useMatches();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.select(), [find.replace]);
  const go = (index: number, list = matches) => {
    if (!list.length) return;
    const i = ((index % list.length) + list.length) % list.length;
    setFind({ index: i });
    const m = list[i]!;
    if (m.pageId !== editor().pageId) {
      jumpToLayers([m.id], m.pageId);
      return;
    }
    editor().set({ selection: [m.id] });
    revealIfOffscreen([m.id], false);
  };
  const close = () => closeFind();
  const shown = matches.length ? Math.min(find.index, matches.length - 1) + 1 : 0;
  const current = matches[Math.min(find.index, matches.length - 1)];
  const onCurrent = current !== undefined && editor().selection[0] === current.id;

  const replaceOne = () => {
    if (!current) return;
    if (!onCurrent) return go(find.index);
    const s = session();
    const out = s.tx(() => replaceText(s.doc, searchOf(find), find.with ?? '', { only: [current.id] }));
    if (out.skipped.length) editor().showToast(t('That layer is locked.'));
    // What was replaced no longer matches, so the same index is now the next match.
    const rest = matchesNow(ui().find, editor().pageId);
    if (rest.length) go(Math.min(find.index, rest.length - 1), rest);
  };
  const replaceAll = () => {
    const s = session();
    const pageId = editor().pageId;
    if (!pageId || !find.query) return;
    const out = s.tx(() => replaceText(s.doc, searchOf(find), find.with ?? '', find.allPages ? {} : { pageId }));
    const locked = out.skipped.length ? t.n(out.skipped.length, '{count} locked layer left alone', '{count} locked layers left alone') : '';
    if (out.replaced) {
      editor().showToast(locked
        ? t.n(out.layers.length, 'Replaced {replaced} in {count} layer, {locked}', 'Replaced {replaced} in {count} layers, {locked}', { replaced: out.replaced, locked })
        : t.n(out.layers.length, 'Replaced {replaced} in {count} layer', 'Replaced {replaced} in {count} layers', { replaced: out.replaced }));
    } else editor().showToast(locked ? t('Nothing replaced, {locked}', { locked }) : t('Nothing replaced'));
  };

  const keys = (e: React.KeyboardEvent<HTMLInputElement>, field: 'find' | 'replace') => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (field === 'replace') {
        if (e.ctrlKey || e.metaKey) replaceAll();
        else replaceOne();
        return;
      }
      go(onCurrent ? find.index + (e.shiftKey ? -1 : 1) : find.index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'F3') {
      e.preventDefault();
      go(find.index + (e.shiftKey ? -1 : 1));
    } else if (!((e.ctrlKey || e.metaKey) && ['f', 'h'].includes(e.key.toLowerCase()))) e.stopPropagation();
  };

  const findInput = (
    <input
      ref={inputRef}
      className="find-input"
      placeholder={find.replace ? (find.allPages ? t('Find text in this file') : t('Find text on this page')) : t('Find on this page')}
      value={find.query}
      spellCheck={false}
      data-testid="find-input"
      aria-label={find.replace ? t('Find text') : t('Find on this page')}
      onChange={(e) => setFind({ query: e.target.value, index: 0 })}
      onKeyDown={(e) => keys(e, 'find')}
    />
  );
  const nav = (
    <>
      <span className="find-count" role="status" data-testid="find-count">{find.query.trim() ? t('{current} of {total}', { current: shown, total: matches.length }) : ''}</span>
      <IconButton icon={<ChevronUp size={14} />} title={t('Previous match ({shortcut})', { shortcut: 'Shift+Enter' })} disabled={!matches.length} onClick={() => go(find.index - 1)} testId="find-prev" />
      <IconButton icon={<ChevronDown size={14} />} title={t('Next match ({shortcut})', { shortcut: 'Enter' })} disabled={!matches.length} onClick={() => go(find.index + 1)} testId="find-next" />
    </>
  );
  const toggle = <IconButton icon={<Replace size={14} />} title={find.replace ? t('Find only ({shortcut})', { shortcut: 'Ctrl+F' }) : t('Find and replace ({shortcut})', { shortcut: 'Ctrl+H' })} active={Boolean(find.replace)} onClick={() => setFind({ replace: !find.replace, index: 0 })} testId="find-toggle-replace" />;
  const closeBtn = <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} testId="find-close" />;

  if (!find.replace) {
    return (
      <div className="find-bar" data-ui role="search" aria-label={t('Find on canvas')} data-testid="find-bar">
        {findInput}
        {nav}
        {toggle}
        {closeBtn}
      </div>
    );
  }
  const option = (key: 'matchCase' | 'wholeWord' | 'allPages', label: string, title: string) => (
    <button type="button" className="find-option" aria-pressed={Boolean(find[key])} title={title} data-testid={`find-${key}`} onClick={() => setFind({ [key]: !find[key], index: 0 })}>{label}</button>
  );
  return (
    <div className="find-bar has-replace" data-ui role="search" aria-label={t('Find and replace')} data-testid="find-bar">
      <div className="find-row">
        {findInput}
        {nav}
        {toggle}
        {closeBtn}
      </div>
      <div className="find-row">
        <input
          className="find-input"
          placeholder={t('Replace with')}
          value={find.with ?? ''}
          spellCheck={false}
          data-testid="replace-input"
          aria-label={t('Replace with')}
          onChange={(e) => setFind({ with: e.target.value })}
          onKeyDown={(e) => keys(e, 'replace')}
        />
        <button type="button" className="find-action" disabled={!matches.length} title={t('Replace in the selected match, then go to the next ({shortcut})', { shortcut: 'Enter' })} data-testid="replace-one" onClick={replaceOne}>{t('Replace')}</button>
        <button type="button" className="find-action" disabled={!matches.length} title={t('Replace every match ({shortcut})', { shortcut: 'Ctrl+Enter' })} data-testid="replace-all" onClick={replaceAll}>{t('All')}</button>
      </div>
      <div className="find-row">
        {option('matchCase', 'Aa', t('Match case'))}
        {option('wholeWord', t('Word'), t('Whole words only'))}
        {option('allPages', t('All pages'), t('Every page of this file, not only this one'))}
      </div>
    </div>
  );
}

/** Every match on screen, positioned by the camera's CSS variables, so that panning renders nothing. */
export function FindHighlights() {
  const open = useUi((s) => s.find.open);
  return open ? <Highlights /> : null;
}

function Highlights() {
  const matches = useMatches();
  const pageId = useEditor((s) => s.pageId);
  const selection = useEditor((s) => s.selection);
  const [rects, setRects] = useState<{ id: string; x: number; y: number; w: number; h: number }[]>([]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setRects(matches.filter((m) => m.pageId === pageId).slice(0, 300).flatMap(({ id }) => {
        const r = rectOf(id);
        return r ? [{ id, ...r }] : [];
      }));
    });
    return () => cancelAnimationFrame(frame);
  }, [matches, pageId]);
  return (
    <>
      {rects.map((r) => (
        <div key={r.id} className={`ov-find${selection.includes(r.id) ? ' is-current' : ''}`} data-testid="find-highlight" style={{ '--wx': r.x, '--wy': r.y, '--ww': r.w, '--wh': r.h } as CSSProperties} />
      ))}
    </>
  );
}
