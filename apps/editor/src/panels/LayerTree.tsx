import { memo, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { BogenNode, NodeType } from '@bogen/core';
import { Component, Diamond, SquareDashed, ChevronDown, ChevronRight, Eye, EyeOff, Frame, Image as ImageIcon, Lock, LockOpen, PenTool, Search, Sparkles, Square, Circle, Type, Video, Minus, Globe, Rows3, Columns3, Grid3x3, Group, X } from 'lucide-react';
import { useChildren, useNode, useThrottledStructure } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { flowOf, measure } from '../canvas/measure.ts';
import { FLOW_PATCH, isContainer, placement, setFields } from '../ops/ops.ts';
import { editor, useEditor } from '../state/store.ts';
import { Empty, IconButton, SelectField } from '../ui/controls.tsx';
import { filteredRows, isEmptyQuery, LAYER_KINDS, parseLayerQuery, type LayerKind } from './layer-filter.ts';
import { useT } from '../i18n/react.ts';

const ROW = 26;
const INDENT = 14;

const TYPE_ICONS: Partial<Record<NodeType, typeof Frame>> = { text: Type, image: ImageIcon, svg: PenTool, shader: Sparkles, video: Video, embed: Globe };

function iconFor(n: BogenNode) {
  if (n.instanceOf !== undefined) return Diamond;
  if (n.component) return Component;
  if (n.slotName !== undefined) return SquareDashed;
  if (n.type !== 'frame') return TYPE_ICONS[n.type] ?? Square;
  if (/^Group\b/.test(n.name)) return Group;
  if (/^Line\b/.test(n.name)) return Minus;
  if (n.style.display === 'flex' || n.style.display === 'inline-flex') return (n.style.flexDirection ?? 'row').startsWith('column') ? Rows3 : Columns3;
  if (n.style.display === 'grid') return Grid3x3;
  if (n.style.borderRadius === '50%') return Circle;
  if (/^Rectangle\b/.test(n.name)) return Square;
  return Frame;
}

/** A row is a layer, or one of its pseudo-elements: then `id` is `<layer>::before` and `owner` the layer. */
interface FlatRow { id: string; depth: number; closed: boolean; dim?: boolean; owner?: string; pseudo?: string }

const rowLayer = (r: FlatRow): string => r.owner ?? r.id;

/** The pseudo-elements a layer draws, as they show in the list: ::before first among its children, ::after last. */
function pseudoRows(id: string): { before: boolean; after: boolean } {
  const rules = session().snap.nodes.get(id)?.rules;
  const has = (p: string) => Object.keys(rules ?? {}).some((k) => k.endsWith(p));
  return { before: has('::before'), after: has('::after') };
}

/** On a big page only the top two levels start open, so that the list reads as an outline. */
const BIG_DOCUMENT = 300;

/**
 * Stacked layers read like a design tool, top of the paint order first. Anything in document flow
 * reads like the page and its code: a header comes before its footer.
 */
function readsInDomOrder(parent: string): boolean {
  const { snap } = session();
  if (!snap.nodes.has(parent)) return false;
  return snap.children(parent).some((id) => snap.nodes.get(id)?.style.position !== 'absolute');
}

function inReadingOrder(parent: string, kids: readonly string[]): readonly string[] {
  return readsInDomOrder(parent) ? kids : [...kids].reverse();
}

function flatten(pageId: string, collapsed: Record<string, boolean>): FlatRow[] {
  const { snap } = session();
  const out: FlatRow[] = [];
  const big = snap.nodes.size > BIG_DOCUMENT;
  const walk = (parent: string, depth: number) => {
    for (const id of inReadingOrder(parent, snap.children(parent))) {
      // An instance is one thing until someone opens it, and a page can hold hundreds.
      const closed = collapsed[id] ?? ((big && depth >= 1) || snap.nodes.stored(id)?.instanceOf !== undefined || id.includes('/'));
      const hasKids = snap.children(id).length > 0;
      out.push({ id, depth, closed: closed && hasKids });
      if (closed && hasKids) continue;
      const pseudo = pseudoRows(id);
      if (pseudo.before) out.push({ id: `${id}::before`, owner: id, pseudo: '::before', depth: depth + 1, closed: false });
      if (hasKids) walk(id, depth + 1);
      if (pseudo.after) out.push({ id: `${id}::after`, owner: id, pseudo: '::after', depth: depth + 1, closed: false });
    }
  };
  walk(pageId, 0);
  return out;
}

let renameFromTree = false;

interface DropState { id: string; where: 'before' | 'after' | 'inside'; depth: number; top: number }

const Row = memo(function Row({ id, depth, closed: collapsed, dim, selected, isHover, onDown, dropInside, position, total }: { id: string; depth: number; closed: boolean; dim?: boolean; selected: boolean; isHover: boolean; onDown: (e: React.PointerEvent, id: string) => void; dropInside: boolean; position: number; total: number }) {
  const t = useT();
  const node = useNode(id);
  const kids = useChildren(id);
  const renaming = useEditor((s) => s.renamingLayerId === id);
  const { snap } = session();
  if (!node) return null;
  const Icon = iconFor(node);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const st = editor();
    st.set({ collapsed: { ...st.collapsed, [id]: !collapsed } });
  };
  const parentHidden = snap.isHidden(node.parent);
  return (
    <div
      id={`layer-${id}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={kids.length ? !collapsed : undefined}
      aria-posinset={position}
      aria-setsize={total}
      aria-label={node.name || node.tag}
      className={`layer-row${selected ? ' is-selected' : ''}${isHover ? ' is-hover' : ''}${node.hidden || parentHidden ? ' is-hidden' : ''}${node.locked ? ' is-locked' : ''}${dropInside ? ' drop-inside' : ''}${dim ? ' is-context' : ''}${node.component ? ' is-main' : ''}${node.instanceOf !== undefined ? ' is-instance' : ''}${node.virtual && node.virtual.path ? ' is-inside' : ''}${node.slotName !== undefined ? ' is-slot' : ''}`}
      style={{ paddingLeft: 4 + depth * INDENT, height: ROW }}
      onPointerDown={(e) => onDown(e, id)}
      onDoubleClick={() => editor().set({ renamingLayerId: id })}
      onMouseEnter={() => editor().set({ hoverId: id })}
      onMouseLeave={() => editor().set({ hoverId: null })}
      data-testid="layer-row"
      data-layer={id}
      data-name={node.name}
    >
      {kids.length ? (
        <button type="button" className="layer-toggle" onClick={toggle} onPointerDown={(e) => e.stopPropagation()} aria-label={collapsed ? t('Expand') : t('Collapse')} tabIndex={-1}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : <span className="layer-toggle" />}
      <Icon size={14} className="layer-icon" aria-hidden="true" />
      {renaming ? (
        <input
          autoFocus
          className="rename-input"
          defaultValue={node.name}
          data-testid="layer-rename"
          onFocus={(e) => e.currentTarget.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== node.name) setFields([id], { name: v });
            editor().set({ renamingLayerId: null });
            // A rename started from the keyboard goes back where it came from.
            if (renameFromTree) {
              renameFromTree = false;
              requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="layer-scroll"]')?.focus());
            }
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { e.currentTarget.value = node.name; e.currentTarget.blur(); }
          }}
        />
      ) : <span className="layer-name" dir="auto">{node.name || node.tag}</span>}
      <span className="layer-actions" onPointerDown={(e) => e.stopPropagation()}>
        <IconButton className={node.locked ? 'is-on' : ''} icon={node.locked ? <Lock size={13} /> : <LockOpen size={13} />} title={node.locked ? t('Unlock ({shortcut})', { shortcut: 'Ctrl+Shift+L' }) : t('Lock ({shortcut})', { shortcut: 'Ctrl+Shift+L' })} onClick={(e) => { e.stopPropagation(); setFields([id], { locked: node.locked ? undefined : true }); }} tabIndex={-1} testId="layer-lock" />
        <IconButton className={node.hidden ? 'is-on' : ''} icon={node.hidden ? <EyeOff size={13} /> : <Eye size={13} />} title={node.hidden ? t('Show ({shortcut})', { shortcut: 'Ctrl+Shift+H' }) : t('Hide ({shortcut})', { shortcut: 'Ctrl+Shift+H' })} onClick={(e) => { e.stopPropagation(); setFields([id], { hidden: node.hidden ? undefined : true }); }} tabIndex={-1} testId="layer-hide" />
      </span>
    </div>
  );
});

/** A pseudo-element of a layer. It is part of its layer, so a click selects the layer and the inspector shows its rules. */
const PseudoRow = memo(function PseudoRow({ owner, pseudo, depth, selected, onDown }: { owner: string; pseudo: string; depth: number; selected: boolean; onDown: (e: React.PointerEvent, id: string) => void }) {
  const t = useT();
  const node = useNode(owner);
  const content = node?.rules?.[pseudo]?.content;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-label={t('{pseudo} of {name}', { pseudo, name: node?.name ?? '' })}
      className={`layer-row is-pseudo${selected ? ' is-selected' : ''}`}
      style={{ paddingLeft: 4 + depth * INDENT, height: ROW }}
      onPointerDown={(e) => onDown(e, owner)}
      data-testid="layer-pseudo-row"
      data-layer={owner}
      data-pseudo={pseudo}
    >
      <span className="layer-toggle" />
      <span className="layer-pseudo">{pseudo}</span>
      {content && content !== '""' && content !== "''" ? <span className="layer-name">{content.length > 24 ? `${content.slice(0, 24)}…` : content}</span> : null}
    </div>
  );
});

/** Layer list, virtualized: only the rows in view exist, so 5,000 layers scroll like 50. */
export function LayerTree() {
  const t = useT();
  const pageId = useEditor((s) => s.pageId);
  const collapsed = useEditor((s) => s.collapsed);
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const version = useThrottledStructure();
  const [queryText, setQueryText] = useState('');
  const [kind, setKind] = useState<LayerKind>('all');
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const [drop, setDrop] = useState<DropState | null>(null);
  const anchorRef = useRef<string | null>(null);

  const query = useMemo(() => parseLayerQuery(queryText, kind), [queryText, kind]);
  const filtering = !isEmptyQuery(query);
  const rows = useMemo<FlatRow[]>(() => {
    if (!pageId) return [];
    if (!filtering) return flatten(pageId, collapsed);
    return filteredRows(session().snap, pageId, query, inReadingOrder).map((r) => ({ id: r.id, depth: r.depth, closed: false, dim: !r.match }));
  }, [pageId, collapsed, version, filtering, query]);
  const indexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const selected = useMemo(() => new Set(selection), [selection]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the selected layer in view, opening its parents when a click on the canvas selected it.
  const last = selection.at(-1);
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!last) {
      revealed.current = undefined;
      return;
    }
    const { snap } = session();
    const state = editor();
    // Only a newly selected layer opens its parents; collapsing one by hand has to stick.
    if (revealed.current !== last) {
      revealed.current = last;
      const big = snap.nodes.size > BIG_DOCUMENT;
      const closed = snap.ancestors(last).filter((a) => state.collapsed[a] || ((big || snap.nodes.stored(a)?.instanceOf !== undefined || a.includes('/')) && state.collapsed[a] === undefined));
      if (closed.length) {
        const next = { ...state.collapsed };
        for (const c of closed) next[c] = false;
        state.set({ collapsed: next });
        return;
      }
    }
    const i = indexById.get(last);
    const el = scroller.current;
    if (i === undefined || !el) return;
    const top = i * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [last, indexById]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const onDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const state = editor();
    const { snap } = session();
    const sel = state.selection;
    const startedSelected = sel.includes(id);
    if (e.shiftKey && anchorRef.current) {
      const a = rowsRef.current.findIndex((r) => r.id === anchorRef.current);
      const b = rowsRef.current.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        state.set({ selection: [...new Set(rowsRef.current.slice(Math.min(a, b), Math.max(a, b) + 1).map(rowLayer))] });
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      state.set({ selection: startedSelected ? sel.filter((x) => x !== id) : [...sel, id] });
      anchorRef.current = id;
      return;
    }
    anchorRef.current = id;
    if (!startedSelected) state.set({ selection: [id] });

    const startY = e.clientY;
    let dragging = false;
    let current: DropState | null = null;
    const moving = () => (editor().selection.includes(id) ? editor().selection : [id]);
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      const el = scroller.current!;
      const box = el.getBoundingClientRect();
      if (ev.clientY < box.top + 20) el.scrollTop -= 8;
      if (ev.clientY > box.bottom - 20) el.scrollTop += 8;
      const y = ev.clientY - box.top + el.scrollTop;
      const i = Math.max(0, Math.min(rowsRef.current.length - 1, Math.floor(y / ROW)));
      const row = rowsRef.current[i];
      if (!row || row.pseudo) return;
      const mv = moving();
      if (mv.includes(row.id) || snap.ancestors(row.id).some((a) => mv.includes(a))) {
        current = null;
        setDrop(null);
        return;
      }
      const frac = y / ROW - i;
      const node = snap.nodes.get(row.id);
      const canHold = node ? isContainer(node) : false;
      let where: DropState['where'];
      if (canHold && frac > 0.25 && frac < 0.75) where = 'inside';
      else where = frac < 0.5 ? 'before' : 'after';
      current = { id: row.id, where, depth: row.depth, top: (where === 'after' ? i + 1 : i) * ROW };
      setDrop(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrop(null);
      if (!dragging) {
        if (startedSelected && editor().selection.length > 1) editor().set({ selection: [id] });
        return;
      }
      if (current) {
        try {
          applyLayerDrop(moving(), current);
        } catch (err) {
          // Such as a layer inside an instance, which keeps its place there.
          editor().showToast((err as Error).message);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const onTreeKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const state = editor();
    const current = state.selection.at(-1);
    const i = current ? (indexById.get(current) ?? -1) : -1;
    const row = i >= 0 ? rows[i] : undefined;
    const select = (at: number) => {
      // A pseudo-element row has no selection of its own, so the keys step over it.
      const step = at < i ? -1 : 1;
      let k = Math.max(0, Math.min(rows.length - 1, at));
      while (rows[k]?.pseudo && rows[k + step]) k += step;
      const r = rows[k];
      if (r && !r.pseudo) state.set({ selection: [r.id] });
    };
    const setClosed = (id: string, closed: boolean) => state.set({ collapsed: { ...state.collapsed, [id]: closed } });
    const hasKids = row ? session().snap.children(row.id).length > 0 : false;
    switch (e.key) {
      case 'ArrowDown': select(i + 1); break;
      case 'ArrowUp': select(i < 0 ? rows.length - 1 : i - 1); break;
      case 'Home': select(0); break;
      case 'End': select(rows.length - 1); break;
      case 'ArrowRight':
        if (!row) break;
        if (hasKids && row.closed) setClosed(row.id, false);
        else if (hasKids) select(i + 1);
        break;
      case 'ArrowLeft':
        if (!row) break;
        if (hasKids && !row.closed) setClosed(row.id, true);
        else {
          const parent = session().snap.nodes.get(row.id)?.parent;
          if (parent && session().snap.nodes.has(parent)) state.set({ selection: [parent] });
        }
        break;
      case 'F2': case 'Enter':
        if (current) {
          renameFromTree = true;
          state.set({ renamingLayerId: current });
        }
        break;
      case 'Escape':
        (e.currentTarget as HTMLElement).blur();
        break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const first = Math.max(0, Math.floor(scroll / ROW) - 8);
  const lastRow = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 8);
  const visible = rows.slice(first, lastRow);

  return (
    <div className="layers" data-testid="layers">
      <div className="layer-search">
        <label className="layer-search-field">
          <Search size={13} aria-hidden="true" />
          <input
            value={queryText}
            placeholder={t('Search layers')}
            aria-label={t('Search layers by name, text or type')}
            spellCheck={false}
            data-testid="layer-search"
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') { setQueryText(''); e.currentTarget.blur(); }
              if (e.key === 'ArrowDown') { e.preventDefault(); scroller.current?.focus(); if (rows[0]) editor().set({ selection: [rows.find((r) => !r.dim)?.id ?? rows[0].id] }); }
            }}
          />
          {queryText ? <button type="button" className="layer-search-clear" title={t('Clear search')} aria-label={t('Clear search')} onClick={() => setQueryText('')}><X size={12} /></button> : null}
        </label>
        <SelectField<LayerKind> className="layer-kind" value={kind} options={LAYER_KINDS.map((k) => ({ value: k.value, label: t(k.label) }))} onChange={setKind} title={t('Filter by type')} testId="layer-kind" />
      </div>
      <div
        ref={scroller}
        className="layer-scroll"
        role="tree"
        tabIndex={0}
        aria-label={t('Layers')}
        aria-multiselectable="true"
        aria-activedescendant={last && indexById.has(last) ? `layer-${last}` : undefined}
        onKeyDown={onTreeKey}
        onMouseDown={(e) => {
          // A click on a row selects; keys then still go to the canvas, as they do after a click there.
          if (e.target !== e.currentTarget) {
            e.preventDefault();
            if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
          }
        }}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        data-testid="layer-scroll"
      >
        {rows.length === 0 ? (filtering ? <Empty title={t('Nothing matches')} hint={t('Try other words, or another type.')} /> : <Empty title={t('No layers yet')} hint={t('What you draw or paste shows up here.')} />) : null}
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {visible.map((r, i) => (
            <div key={r.id} className="layer-slot" style={{ top: (first + i) * ROW }}>
              {r.pseudo
                ? <PseudoRow owner={r.owner!} pseudo={r.pseudo} depth={r.depth} selected={selected.has(r.owner!)} onDown={onDown} />
                : <Row id={r.id} depth={r.depth} closed={r.closed} dim={r.dim} position={first + i + 1} total={rows.length} selected={selected.has(r.id)} isHover={hoverId === r.id} onDown={onDown} dropInside={drop?.id === r.id && drop.where === 'inside'} />}
            </div>
          ))}
          {drop && drop.where !== 'inside' ? <div className="layer-drop-line" style={{ top: drop.top - 1, left: 8 + drop.depth * INDENT }} data-testid="layer-drop-line" /> : null}
        </div>
      </div>
    </div>
  );
}

/** Dropping in the list reparents and reorders, in whichever direction this parent's list reads. */
function applyLayerDrop(ids: string[], drop: DropState): void {
  const s = session();
  const { snap, doc } = s;
  const target = snap.nodes.get(drop.id);
  if (!target) return;
  const parent = drop.where === 'inside' ? drop.id : target.parent;
  const sibs = snap.children(parent);
  let index: number;
  if (drop.where === 'inside') index = sibs.length;
  else {
    const at = sibs.indexOf(drop.id);
    const afterInDoc = readsInDomOrder(parent) ? drop.where === 'after' : drop.where === 'before';
    index = afterInDoc ? at + 1 : at;
  }
  const destFlow = snap.nodes.has(parent) ? flowOf(parent).kind === 'flow' : false;
  const ordered = [...ids].sort((a, b) => {
    const pa = snap.children(snap.nodes.get(a)!.parent).indexOf(a);
    const pb = snap.children(snap.nodes.get(b)!.parent).indexOf(b);
    return pa - pb;
  });
  const patches = new Map<string, Record<string, string | null>>();
  for (const id of ordered) {
    const n = snap.nodes.get(id);
    if (!n) continue;
    const same = n.parent === parent;
    if (destFlow) {
      if (!same) patches.set(id, FLOW_PATCH);
    } else if (!same && measure(id)) patches.set(id, placement(id, parent));
  }
  s.tx(() => {
    if (!destFlow && snap.nodes.has(parent) && !snap.nodes.get(parent)!.style.position) doc.updateStyle(parent, { position: 'relative' });
    for (const [id, p] of patches) doc.updateStyle(id, p);
    doc.move(ordered, parent, index);
  });
}
