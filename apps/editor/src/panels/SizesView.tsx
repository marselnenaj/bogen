import { useEffect, useMemo, useRef, useState } from 'react';
import { escapeAttr, exportDocument, fontLinks, googleFontsHrefs, isWebPage, stressCopy, type BogenDoc } from '@bogen/core';
import { X } from 'lucide-react';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { resolveAsset } from '../lib/api.ts';
import { goToLayer } from '../ops/reveal.ts';
import { fileBreakpoints } from '../ops/breakpoints.ts';
import { ui, useUi } from '../state/ui.ts';
import { useT } from '../i18n/react.ts';

/**
 * One artboard at several widths side by side, from the same file: no copies, no extra pages. Each frame is the page
 * as it is exported, laid out by the browser at that width, so media queries, container queries, grids and native
 * popovers behave as they will on the web. Stress switches render a throwaway copy with harder content. Each width
 * reports what sticks out past it, and a click selects that layer.
 */

interface Overflow { id: string; name: string; by: number }
interface Stress { long: boolean; images: boolean; items: 'as-is' | 'empty' | 'full' }

/** The page for one frame: the export of the artboard, as wide as the frame, with ids to find layers by. */
function frameHtml(doc: BogenDoc, id: string): string {
  const fonts = fontLinks(doc).flatMap(googleFontsHrefs).map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join('');
  // A web page grows with the window up to its width; any other artboard is shown at the frame's width, the way the
  // canvas and responsive_check read its media queries.
  const fit = `<style>body>[data-bogen-id="${id}"]{position:static !important;left:auto !important;top:auto !important;${doc.getNode(id) && isWebPage(doc.getNode(id)!) ? '' : 'width:100% !important;max-width:none !important;'}}</style>`;
  return exportDocument(doc, [id], { ids: true, resolve: resolveAsset, fluidRoot: true, extraHead: fonts + fit, media: 'viewport' });
}

function measure(frame: HTMLIFrameElement, width: number, names: Map<string, string>): Overflow[] | null {
  const d = frame.contentDocument;
  if (!d?.body) return null;
  const out: Overflow[] = [];
  for (const el of d.querySelectorAll<HTMLElement>('[data-bogen-id]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || getComputedStyle(el).display === 'none') continue;
    const by = Math.round(r.right - width);
    if (by > 1) out.push({ id: el.dataset.bogenId!, name: names.get(el.dataset.bogenId!) ?? el.dataset.bogenId!, by });
  }
  // The outermost layer that sticks out says it; its children would only repeat it.
  return out.filter((o) => !out.some((p) => p !== o && p.by >= o.by && d.querySelector(`[data-bogen-id="${p.id}"]`)?.contains(d.querySelector(`[data-bogen-id="${o.id}"]`)))).slice(0, 8);
}

export function SizesView() {
  const id = useUi((s) => s.sizesOf);
  return id ? <Sizes id={id} /> : null;
}

function Sizes({ id }: { id: string }) {
  const t = useT();
  const version = useSnapVersion();
  const [settled, setSettled] = useState(version);
  const [stress, setStress] = useState<Stress>({ long: false, images: false, items: 'as-is' });
  const [results, setResults] = useState<Record<number, Overflow[] | null>>({});
  const frames = useRef(new Map<number, HTMLIFrameElement>());
  const { doc } = session();
  const node = doc.getNode(id);
  const design = parseFloat(node?.style.width ?? '') || 1440;
  // Breakpoint tokens can change while this is open: the widths follow them with the other edits.
  const widths = useMemo(() => [...new Set([Math.min(design, 1440), ...fileBreakpoints(doc).filter((w) => w < design)])].sort((a, b) => b - a).slice(0, 4), [doc, design, settled]);
  // Frames follow edits a moment after they settle, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSettled(version), 400);
    return () => clearTimeout(timer);
  }, [version]);
  const html = useMemo(() => {
    if (!doc.getNode(id)) return '';
    const stressed = stress.long || stress.images || stress.items !== 'as-is';
    if (!stressed) return frameHtml(doc, id);
    const copy = stressCopy(doc, id, { textFactor: stress.long ? 1.6 : 1, longWords: stress.long, missingImages: stress.images, ...(stress.items !== 'as-is' ? { emptyAndFull: stress.items } : {}) });
    try {
      return frameHtml(copy.doc, id);
    } finally {
      copy.doc.y.destroy();
    }
  }, [doc, id, settled, stress]);
  const names = useMemo(() => new Map([[id, node?.name ?? id], ...doc.descendants(id).map((n) => [n.id, n.name] as [string, string])]), [doc, id, settled]);
  const close = () => ui().set({ sizesOf: null });
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  if (!node) return null;
  const scale = (w: number) => Math.min(1, 360 / w);
  return (
    <div className="sizes" role="dialog" aria-label={t('{name} at several widths', { name: node.name })} data-ui data-testid="sizes-view">
      <header className="sizes-head">
        <strong dir="auto">{node.name}</strong>
        <span className="hint">{t('The same artboard as exported, at {widths} px. Edits show here a moment later.', { widths: widths.join(', ') })}</span>
        <div className="sizes-stress" role="group" aria-label={t('Harder content')}>
          <label className="check"><input type="checkbox" checked={stress.long} onChange={(e) => setStress({ ...stress, long: e.target.checked })} data-testid="sizes-stress-long" /> {t('Longer text')}</label>
          <label className="check"><input type="checkbox" checked={stress.images} onChange={(e) => setStress({ ...stress, images: e.target.checked })} data-testid="sizes-stress-images" /> {t('Missing images')}</label>
          <select className="field-input" value={stress.items} onChange={(e) => setStress({ ...stress, items: e.target.value as Stress['items'] })} data-testid="sizes-stress-items" aria-label={t('Repeated items')}>
            <option value="as-is">{t('Lists as they are')}</option>
            <option value="empty">{t('One item')}</option>
            <option value="full">{t('Twice as many')}</option>
          </select>
        </div>
        <button type="button" className="icon-btn" title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={close} data-testid="sizes-close"><X size={14} /></button>
      </header>
      <div className="sizes-row">
        {widths.map((w) => {
          const found = results[w];
          return (
            <section key={w} className="sizes-col" data-testid={`sizes-${w}`} data-width={w}>
              <div className="sizes-label">
                <span>{w} px</span>
                {found === undefined ? null : found === null ? <span className="hint">{t('not measured')}</span> : found.length ? <span className="sizes-over" data-testid={`sizes-over-${w}`}>{t.n(found.length, '{count} stick out', '{count} stick out')}</span> : <span className="sizes-ok" data-testid={`sizes-ok-${w}`}>{t('fits')}</span>}
              </div>
              <div className="sizes-frame" style={{ width: w * scale(w), height: 640 }}>
                <iframe
                  title={t('{name} at {width} px', { name: node.name, width: w })}
                  sandbox="allow-same-origin"
                  srcDoc={html}
                  ref={(el) => { if (el) frames.current.set(w, el); }}
                  style={{ width: w, height: 640 / scale(w), transform: `scale(${scale(w)})`, transformOrigin: '0 0' }}
                  onLoad={(e) => {
                    const el = e.currentTarget;
                    setTimeout(() => setResults((r) => ({ ...r, [w]: measure(el, w, names) })), 120);
                  }}
                />
              </div>
              {found?.length ? (
                <ul className="sizes-issues">
                  {found.map((o) => (
                    <li key={o.id}><button type="button" className="run-link" onClick={() => { close(); goToLayer(o.id, { fit: false }); }} data-testid={`sizes-issue-${w}`} title={t('Close this view and select the layer on the canvas')} dir="auto">{o.name}</button> <span className="hint">+{o.by} px</span></li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
