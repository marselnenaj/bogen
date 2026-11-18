import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, FilePlus2, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { brandApi, type BrandListItem } from '../lib/brand-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { Popover } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { BrandTemplates } from './BrandTemplates.tsx';
import { FromWebsite } from './Composer.tsx';

function BrandRow({ brand, onChanged }: { brand: BrandListItem; onChanged: () => void }) {
  const t = useT();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const open = () => { location.hash = `#/brand/${brand.id}`; };
  const [making, setMaking] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [templates, setTemplates] = useState(false);
  // A new file laid out from the brand, opened right away: the start of a brand system, a page or share images.
  const make = (template: 'brand-system' | 'landing-page' | 'social-images') => {
    setMenu(false);
    setMaking(template);
    setFailed(null);
    void brandApi.useTemplate(brand.id, template).then((out) => { location.hash = `#/file/${out.file_id}`; }).catch((e: Error) => setFailed(e.message)).finally(() => setMaking(null));
  };
  // Two short lines on the card: what uses the brand and where it stands, then what waits for the person.
  const changes = brand.changes ?? (brand.draft ? 1 : 0);
  const state = !brand.version ? t('Not published yet')
    : changes ? t.n(changes, '{count} change since version {version}', '{count} changes since version {version}', { version: brand.version })
    : t('Version {version}', { version: brand.version });
  const facts = [
    brand.isDefault ? t('Default for new files') : '',
    brand.linkedFiles ? t.n(brand.linkedFiles, '{count} file', '{count} files') : t('No files'),
    state,
  ].filter(Boolean).join(' · ');
  return (
    // One click target for the whole card: the name's button stretches over it (home.css), and the menu and the
    // rename field sit above that, so nothing interactive is nested in anything else.
    <div className="brand-row" role="listitem" data-testid="brand-row" data-brand-id={brand.id} data-brand-name={brand.name}>
      <span className="brand-swatches" aria-hidden="true">
        {brand.colors.length ? brand.colors.slice(0, 6).map((c) => <span key={c} style={{ background: c }} />) : <span className="brand-swatch-empty" />}
      </span>
      <div className="brand-card-head">
      {renaming ? (
        <input
          autoFocus
          className="rename-input"
          defaultValue={brand.name}
          data-testid="brand-rename-input"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            setRenaming(false);
            if (v && v !== brand.name) void brandApi.rename(brand.id, v).then(onChanged);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { e.currentTarget.value = brand.name; e.currentTarget.blur(); }
          }}
        />
      ) : <button type="button" className="brand-name brand-open" onClick={open} data-title-if-cut="" aria-label={t('Open {name}', { name: brand.name })} dir="auto" data-testid="brand-open">{brand.name}</button>}
        <button ref={menuRef} type="button" className="icon-btn" title={t('More')} aria-label={t('More for {name}', { name: brand.name })} onClick={() => setMenu(!menu)} data-testid="brand-menu"><MoreHorizontal size={14} /></button>
      </div>
      <span className="brand-facts" data-testid="brand-facts">{making ? t('Laying out a new file…') : failed ?? facts}</span>
      {brand.suggestions && !making && !failed ? <span className="brand-todo" data-testid="brand-todo">{t.n(brand.suggestions, '{count} suggestion to confirm', '{count} suggestions to confirm')}</span> : null}
      {templates ? <BrandTemplates brandId={brand.id} onClose={() => setTemplates(false)} /> : null}
      {menu ? (
        <Popover anchor={menuRef.current} side="below" width={208} onClose={() => { setMenu(false); setConfirming(false); }}>
          <button type="button" className="menu-item" data-testid="brand-action-default" onClick={() => { setMenu(false); void brandApi.setDefault(brand.isDefault ? null : brand.id).then(onChanged); }}><span className="menu-with-icon"><Check size={13} /> {brand.isDefault ? t('Stop being the default') : t('Default for new files')}</span></button>
          <button type="button" className="menu-item" data-testid="brand-action-rename" onClick={() => { setMenu(false); setRenaming(true); }}><span className="menu-with-icon"><Pencil size={13} /> {t('Rename')}</span></button>
          <button type="button" className="menu-item" data-testid="brand-action-duplicate" onClick={() => { setMenu(false); void brandApi.duplicate(brand.id).then(onChanged); }}><span className="menu-with-icon"><Copy size={13} /> {t('Duplicate')}</span></button>
          <div className="menu-sep" />
          <button type="button" className="menu-item" data-testid="brand-action-templates" onClick={() => { setMenu(false); setTemplates(true); }}><span className="menu-with-icon"><FilePlus2 size={13} /> {t('Templates')}</span></button>
          <button type="button" className="menu-item" data-testid="brand-action-template-system" onClick={() => make('brand-system')}><span className="menu-with-icon"><FilePlus2 size={13} /> {t('New brand system file')}</span></button>
          <button type="button" className="menu-item" data-testid="brand-action-template-landing" onClick={() => make('landing-page')}><span className="menu-with-icon"><FilePlus2 size={13} /> {t('New landing page file')}</span></button>
          <button type="button" className="menu-item" data-testid="brand-action-template-social" onClick={() => make('social-images')}><span className="menu-with-icon"><FilePlus2 size={13} /> {t('New social images file')}</span></button>
          <div className="menu-sep" />
          {confirming ? (
            <button type="button" className="menu-item is-danger" data-testid="brand-action-delete-confirm" onClick={() => { setMenu(false); void brandApi.remove(brand.id).then(onChanged); }}><span className="menu-with-icon"><Trash2 size={13} /> {t('Delete for good')}</span></button>
          ) : (
            <button type="button" className="menu-item" data-testid="brand-action-delete" onClick={() => setConfirming(true)}><span className="menu-with-icon"><Trash2 size={13} /> {t('Delete')}</span></button>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

/** The narrowest a brand card gets, and the gap between cards (home.css). */
const CARD = 232;
const CARD_GAP = 12;

/** The brands on this device, above the files. Takes no room when there are none, beyond one quiet line. */
export function BrandsSection({ place = false }: { /** The Brands place (#/brands): every brand, and taking one from a website. */ place?: boolean } = {}) {
  const t = useT();
  const [brands, setBrands] = useState<BrandListItem[] | null>(null);
  const all = place;
  // Two full rows of cards at the width there is; the rest is one click away.
  const listRef = useRef<HTMLDivElement>(null);
  const [few, setFew] = useState(8);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setFew((place ? 2 : 1) * Math.max(1, Math.floor((el.clientWidth + CARD_GAP) / (CARD + CARD_GAP))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [brands !== null]);
  const load = useCallback(() => {
    // The ones worked on last come first, so the two rows that show are the ones in use.
    brandApi.list().then((list) => setBrands([...list].sort((a, b) => b.updatedAt - a.updatedAt))).catch(() => setBrands([]));
  }, []);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'files' || e.t === 'brand') load(); });
  }, [load]);
  const create = async () => {
    const brand = await brandApi.create('New brand');
    // An empty brand has no book to show yet: it opens where it is filled in.
    location.hash = `#/brand/${brand.id}/identity`;
  };
  if (!brands) return null;
  const Title = place ? 'h1' : 'h2';
  return (
    <section className={`brands${place ? ' is-place' : ''}`} data-testid="brands" aria-labelledby="home-brands-title">
      <div className="brands-head">
        <Title className="brands-title" id="home-brands-title">{t('Brands')}{brands.length ? <span className="home-count">{brands.length}</span> : null}</Title>
        <button type="button" className="btn btn-quiet" onClick={() => void create()} data-testid="brand-new"><Plus size={14} /> {t('New brand')}</button>
      </div>
      {place ? <section className="composer-box brands-from-website" aria-label={t('Brand from a website')}><FromWebsite brands={brands} onDone={load} /></section> : null}
      {!brands.length ? <div className="hint">{t('A brand keeps your logos, colours, type and rules in one place, so that your agents stay within them. One per client works well.')}</div> : null}
      <div ref={listRef} className="brand-list" role="list" aria-labelledby="home-brands-title">
        {(all ? brands : brands.slice(0, few)).map((b) => <BrandRow key={b.id} brand={b} onChanged={load} />)}
      </div>
      {!place && brands.length > few ? <a className="home-more" href="#/brands" data-testid="brands-all">{t('All {count} brands', { count: brands.length })}</a> : null}
    </section>
  );
}
