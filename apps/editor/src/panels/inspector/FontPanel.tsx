import { useEffect, useMemo, useState } from 'react';
import {
  cellAdvance, cellOutlineD, getFontFaces, getGlyphFonts, glyphCells, glyphFontHash, glyphFontOfPage, glyphFontStack, GUIDE_COLORS, observeGlyphFonts,
  type GlyphFont,
} from '@bogen/core';
import { session } from '../../doc/session.ts';
import { useEditor } from '../../state/store.ts';
import { api, resolveAsset } from '../../lib/api.ts';
import { jumpToLayers } from '../../ops/jump.ts';
import { useT } from '../../i18n/react.ts';
import { formatDateTime, formatTime } from '../../i18n/format.ts';
import { Section } from '../../ui/controls.tsx';

/**
 * The Font panel of a glyph page: the font's names and metrics, Build font, a line typed in the current build,
 * and every glyph at a glance. A page is a glyph page when a font made in the file lives on it.
 */

interface FontView {
  font: GlyphFont;
  cells: { id: string; name: string; label: string; advance: number; d: string }[];
  /** The glyphs changed since the last build. */
  stale: boolean;
}

function readView(pageId: string | null): FontView | null {
  if (!pageId) return null;
  const { doc } = session();
  const font = glyphFontOfPage(doc, pageId);
  if (!font) return null;
  const cells = glyphCells(doc, font).map((c) => {
    const ch = c.unicodes[0] !== undefined ? String.fromCodePoint(c.unicodes[0]) : '';
    return { id: c.id, name: c.name, label: ch.trim() ? ch : c.name, advance: cellAdvance(doc, font, c.id), d: cellOutlineD(doc, font, c.id) };
  });
  return { font, cells, stale: !font.build || font.build.hash !== glyphFontHash(doc, font) };
}

/** The font of the page in view, read again when the record or the page changes, at most every 250 ms. */
export function useGlyphFont(): FontView | null {
  const pageId = useEditor((s) => s.pageId);
  const [view, setView] = useState<FontView | null>(() => readView(pageId));
  useEffect(() => {
    const { doc } = session();
    let timer = 0;
    const later = () => {
      if (!timer) timer = window.setTimeout(() => { timer = 0; setView(readView(pageId)); }, 250);
    };
    setView(readView(pageId));
    const off = observeGlyphFonts(doc, later);
    doc.y.on('update', later);
    return () => { off(); doc.y.off('update', later); clearTimeout(timer); };
  }, [pageId]);
  return view;
}

/** Is the page in view a glyph page? Cheap: only reads the font records. */
export function useIsGlyphPage(): boolean {
  const pageId = useEditor((s) => s.pageId);
  const [is, setIs] = useState(() => Boolean(pageId && glyphFontOfPage(session().doc, pageId)));
  useEffect(() => {
    const { doc } = session();
    const read = () => setIs(Boolean(pageId && glyphFontOfPage(doc, pageId)));
    read();
    return observeGlyphFonts(doc, read);
  }, [pageId]);
  return is;
}

function useBuild(view: FontView | null) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error?: string; notes: string[] } | null>(null);
  const build = async () => {
    if (!view || busy) return;
    const { fileId } = session();
    setBusy(true);
    setResult(null);
    try {
      const out = await api.buildGlyphFont(fileId, view.font.id);
      setResult({ notes: [...out.notes, ...out.glyphNotes.map((g) => `${g.name}: ${g.notes.join(' ')}`)] });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : t('The font could not be built.'), notes: [] });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, build };
}

/** A time today, a date and time before. */
function builtAt(at: number): string {
  return new Date(at).toDateString() === new Date().toDateString() ? formatTime(at) : formatDateTime(at);
}

function BuildBlock({ view }: { view: FontView }) {
  const t = useT();
  const { busy, result, build } = useBuild(view);
  const { font, stale } = view;
  const drawn = view.cells.filter((c) => c.d).length;
  const file = `${font.family}-${font.style}`.replace(/[^\p{L}\p{N}-]+/gu, '');
  return (
    <div className="font-build">
      <button type="button" className="btn btn-primary" onClick={() => void build()} disabled={busy || !drawn} data-testid="font-build">
        {busy ? t.n(view.cells.length, 'Building {count} glyph', 'Building {count} glyphs') : t('Build font')}
      </button>
      {result?.error ? <p className="font-error" role="alert" dir="auto">{result.error}</p> : null}
      {!drawn ? <p className="hint">{t('No glyph has an outline yet. Draw one with the pen inside a cell, or ask an agent to.')}</p> : null}
      {font.build ? (
        <>
          <p className="font-status" data-testid="font-status">
            {t('Built {when}: {glyphs} glyphs, {pairs} kerning pairs.', { when: builtAt(font.build.at), glyphs: font.build.glyphs, pairs: font.build.kerning })}
          </p>
          {stale ? <p className="hint">{t('The glyphs changed since then. Build again to use them.')}</p> : null}
          <div className="font-files">
            <a href={resolveAsset(font.build.otf)} download={`${file}.otf`}>{t('Download OTF')}</a>
            <a href={resolveAsset(font.build.woff2)} download={`${file}.woff2`}>{t('Download WOFF2')}</a>
          </div>
        </>
      ) : drawn ? <p className="hint">{t('Text in this file can use it as soon as it is built.')}</p> : null}
      {result?.notes.length ? (
        <ul className="font-notes">{result.notes.slice(0, 8).map((n) => <li key={n} dir="auto">{n}</li>)}</ul>
      ) : null}
    </div>
  );
}

/** On a glyph page with a layer selected: Build font above the layer's sections. */
export function FontBuildSection() {
  const t = useT();
  const view = useGlyphFont();
  if (!view) return null;
  return (
    <Section title={t('Font')} note={view.font.family}>
      <BuildBlock view={view} />
    </Section>
  );
}

export function FontPanel() {
  const t = useT();
  const view = useGlyphFont();
  const [preview, setPreview] = useState('');
  const [size, setSize] = useState(28);
  const sample = useMemo(() => {
    if (!view) return '';
    const chars = view.cells.map((c) => c.label).filter((c) => [...c].length === 1);
    return chars.some((c) => /[a-z]/.test(c)) ? view.font.family : view.font.family.toUpperCase();
  }, [view]);
  if (!view) return null;
  const { font } = view;
  const m = font.metrics;
  const origin = font.origin.kind === 'derived'
    ? t('Made in this file from {source}, under its licence.', { source: font.origin.from ?? '' })
    : t('Made in this file.');
  const metrics: [string, number, string][] = [
    [t('Ascender'), m.ascender, GUIDE_COLORS.ascender], [t('Cap height'), m.capHeight, GUIDE_COLORS.capHeight], [t('x-height'), m.xHeight, GUIDE_COLORS.xHeight],
    [t('Baseline'), 0, GUIDE_COLORS.baseline], [t('Descender'), m.descender, GUIDE_COLORS.descender],
  ];
  const missing = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((c) => !view.cells.some((cell) => cell.label === c));
  const emH = m.ascender - m.descender;
  return (
    <div className="font-panel" data-testid="font-panel">
      <header className="font-head">
        <h2 dir="auto">{font.family}</h2>
        <p className="hint">{t('{style}, {weight}.', { style: font.style, weight: font.weight })} {origin}</p>
      </header>
      <BuildBlock view={view} />
      <Section title={t('Preview')}>
        <input className="font-preview-input" value={preview} placeholder={sample} onChange={(e) => setPreview(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label={t('Text to preview')} data-testid="font-preview-input" dir="auto" />
        <div className="font-preview" style={{ fontFamily: font.build ? glyphFontStack(font) : undefined, fontSize: `${size}px` }} data-testid="font-preview" dir="auto">
          {font.build ? preview || sample : <span className="hint">{t('Build the font to type with it.')}</span>}
        </div>
        <label className="font-size-row">
          <span className="hint">{t('Size')}</span>
          <input type="range" min={12} max={120} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label={t('Preview size')} />
          <span className="hint">{size} px</span>
        </label>
      </Section>
      <Section title={t('Metrics')} note={t('{units} units per em', { units: m.unitsPerEm })}>
        <div className="font-metrics">
          {metrics.map(([label, value, color]) => (
            <div key={label} className="font-metric"><span className="font-swatch" style={{ background: color }} /><span>{label}</span><span>{value}</span></div>
          ))}
        </div>
      </Section>
      <Section title={t('Glyphs')} note={missing.length ? t('{count} of A to Z missing', { count: missing.length }) : t.n(view.cells.length, '{count} glyph', '{count} glyphs')}>
        <div className="font-glyphs" data-testid="font-glyphs">
          {view.cells.map((c) => (
            <button key={c.id} type="button" className={`font-glyph${c.d ? '' : ' is-empty'}`} title={t('{name}, advance {advance}', { name: c.name, advance: c.advance })} aria-label={c.name} onClick={() => jumpToLayers([c.id], font.pageId)}>
              <svg viewBox={`0 0 ${Math.max(c.advance, 1)} ${emH}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d={c.d} /></svg>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

/** Families the file holds, for the font list: those made here first, then captured or uploaded ones. */
export function fileFamilies(): { family: string; made: boolean }[] {
  const { doc } = session();
  const made = new Set(getGlyphFonts(doc).filter((f) => f.build).map((f) => f.family));
  const all = new Set([...made, ...getFontFaces(doc).filter((f) => f.src).map((f) => f.family)]);
  return [...all].map((family) => ({ family, made: made.has(family) })).sort((a, b) => Number(b.made) - Number(a.made) || a.family.localeCompare(b.family));
}
