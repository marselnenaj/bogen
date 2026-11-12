import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, FilePlus2, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { brandApi, type BrandListItem } from '../lib/brand-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { Popover } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { BrandTemplates } from './BrandTemplates.tsx';

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
  const facts = [
    brand.isDefault ? t('Default for new files') : '',
    brand.linkedFiles ? t.n(brand.linkedFiles, '{count} file', '{count} files') : t('No files'),
    brand.version ? (brand.draft ? t('Version {version}, edited since', { version: brand.version }) : t('Version {version}', { version: brand.version })) : '',
    brand.suggestions ? t.n(brand.suggestions, '{count} to confirm', '{count} to confirm') : '',
  ].filter(Boolean).join('. ');
  return (
    <div className="brand-row" data-testid="brand-row" data-brand-id={brand.id} data-brand-name={brand.name}>
      <button type="button" className="brand-swatches" onClick={open} aria-label={t('Open {name}', { name: brand.name })} data-testid="brand-open">
        {brand.colors.length ? brand.colors.slice(0, 6).map((c) => <span key={c} style={{ background: c }} />) : <span className="brand-swatch-empty" />}
      </button>
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
      ) : <button type="button" className="brand-name" onClick={open} title={brand.name} dir="auto">{brand.name}</button>}
      <span className="brand-facts" data-testid="brand-facts">{making ? t('Laying out a new file…') : failed ?? facts}</span>
      <button ref={menuRef} type="button" className="icon-btn" title={t('More')} aria-label={t('More')} onClick={() => setMenu(!menu)} data-testid="brand-menu"><MoreHorizontal size={14} /></button>
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

/** The brands on this device, above the files. Takes no room when there are none, beyond one quiet line. */
export function BrandsSection() {
  const t = useT();
  const [brands, setBrands] = useState<BrandListItem[] | null>(null);
  const load = useCallback(() => {
    brandApi.list().then(setBrands).catch(() => setBrands([]));
  }, []);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'files' || e.t === 'brand') load(); });
  }, [load]);
  const create = async () => {
    const brand = await brandApi.create('New brand');
    location.hash = `#/brand/${brand.id}`;
  };
  if (!brands) return null;
  return (
    <section className="brands" data-testid="brands">
      <div className="brands-head">
        <span className="brands-title">{t('Brands')}</span>
        <button type="button" className="btn btn-quiet" onClick={() => void create()} data-testid="brand-new"><Plus size={14} /> {t('New brand')}</button>
      </div>
      {!brands.length ? <div className="hint">{t('A brand keeps your logos, colours, type and rules in one place, so that your agents stay within them. One per client works well.')}</div> : null}
      <div className="brand-list">
        {brands.map((b) => <BrandRow key={b.id} brand={b} onChanged={load} />)}
      </div>
    </section>
  );
}
