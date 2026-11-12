import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChildren, useNode, useTokens } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { useEditor } from '../state/store.ts';
import { ArtboardLoader, canDeferArtboard, estimatedArtboardHeight, registerArtboardRequest, usesArtboardLoading } from './artboard-loading.ts';
import { tickOverlay } from './overlay-tick.ts';
import { useT } from '../i18n/react.ts';
import { useScreenPreviews, type ScreenPreview } from './screen-previews.ts';
import { ScreenPaint, waitForScreenPaint } from './ScreenPaint.tsx';
import { NodeView } from './NodeView.tsx';

const PageArtboard = memo(function PageArtboard({ id, loader, tokens, pinned, heights, preview, previewRoot }: { id: string; loader: ArtboardLoader; tokens: ReadonlyMap<string, string>; pinned: boolean; heights: Map<string, number>; preview?: ScreenPreview; previewRoot: HTMLElement | null }) {
  const node = useNode(id);
  const t = useT();
  const estimate = estimatedArtboardHeight(node, tokens);
  const deferred = canDeferArtboard(node, tokens) || estimate !== undefined;
  const [naturalHeight, setNaturalHeight] = useState<number | undefined>(() => heights.get(id));
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [settled, setSettled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [large, setLarge] = useState(false);
  const [requested, setRequested] = useState(false);
  const timer = useRef(0);
  const stop = useRef<(() => void) | null>(null);
  const observe = useCallback((el: HTMLElement | null) => {
    stop.current?.();
    setElement(el);
    stop.current = el && deferred ? loader.observe(el, (live, large) => { setVisible(live); setLarge(large); }, preview?.layers ?? 1500) : null;
  }, [loader, deferred, preview?.layers]);
  useLayoutEffect(() => {
    const unregister = registerArtboardRequest(id, () => {
      setRequested(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setRequested(false), 1000);
    });
    return () => { unregister(); clearTimeout(timer.current); };
  }, [id]);
  const live = !deferred || visible || pinned || requested;
  useLayoutEffect(() => {
    const el = element;
    if (!live || estimate === undefined || !el) return;
    const measure = () => {
      const height = el.offsetHeight;
      if (height > 0 && Math.abs(height - (heights.get(id) ?? 0)) > 1) { heights.set(id, height); setNaturalHeight(height); tickOverlay(); }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(el); return () => observer.disconnect();
  }, [live, estimate, id, heights, element]);
  useLayoutEffect(() => { if (!live && preview?.height) tickOverlay(); }, [live, preview?.height]);
  useLayoutEffect(() => {
    setSettled(false);
    if (live && element) return waitForScreenPaint(element, () => setSettled(true));
  }, [live, element]);
  return <>
    <NodeView id={id} onElement={observe} renderChildren={live} {...(!live ? { deferredHint: preview?.src ? undefined : t('Loading'), ...(estimate === undefined ? {} : { deferredHeight: preview?.state === 'ready' ? (preview.height ?? naturalHeight ?? estimate) : (naturalHeight ?? preview?.height ?? estimate) }) } : {})} />
    {deferred && <ScreenPaint key={preview?.scope ?? 'initial'} id={id} src={large ? preview?.src : preview?.smallSrc} visible={!live || !settled} element={element} node={node} target={previewRoot} />}
  </>;
});

/** Keep every screen's outer box measurable; only nearby screens need their full editable DOM. */
export function PageLayers({ pageId, previewRoot }: { pageId: string; previewRoot: HTMLElement | null }) {
  const kids = useChildren(pageId);
  const { snap } = session();
  const selection = useEditor((s) => s.selection);
  const editingText = useEditor((s) => s.editingTextId);
  const editingPath = useEditor((s) => s.editingPathId);
  const threadId = useEditor((s) => s.activeThreadId);
  const tokens = useTokens();
  const values = useMemo(() => new Map(tokens.map((t) => [t.name, t.value])), [tokens]);
  const enabled = usesArtboardLoading(kids.length, snap.nodes.size);
  const previews = useScreenPreviews(pageId, enabled);
  const heights = useMemo(() => new Map<string, number>(), []);
  const loader = useMemo(() => new ArtboardLoader(), []);
  // Selecting whole screens (including Select all) needs their boxes, not every offscreen child.
  const pinned = new Set([...selection, editingText, editingPath, snap.comments.find((t) => t.id === threadId)?.nodeId].filter((id): id is string => Boolean(id)).flatMap((id) => {
    const root = snap.ancestors(id).at(-1);
    return root ? [root] : selection.length === 1 && snap.nodes.get(id)?.artboard ? [id] : [];
  }));
  if (!enabled || typeof IntersectionObserver === 'undefined') return <>{kids.map((id) => <NodeView key={id} id={id} />)}</>;
  return <>{kids.map((id) => <PageArtboard key={id} id={id} loader={loader} tokens={values} pinned={pinned.has(id)} heights={heights} preview={previews.get(id)} previewRoot={previewRoot} />)}</>;
}
