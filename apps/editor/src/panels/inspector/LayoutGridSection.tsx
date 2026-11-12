import { useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Minus, Plus } from 'lucide-react';
import { defaultLayoutGrid, MAX_LAYOUT_GRIDS, type BogenNode, type LayoutGrid, type LayoutGridAlign, type LayoutGridKind } from '@bogen/core';
import { rectOf } from '../../canvas/measure.ts';
import { session } from '../../doc/session.ts';
import { useSettings } from '../../state/settings.ts';
import { ColorField } from '../../ui/ColorPicker.tsx';
import { IconButton, NumberField, Row, Section, SelectField } from '../../ui/controls.tsx';
import { type Translate, ctx, msg } from '../../i18n/core.ts';
import { useT } from '../../i18n/react.ts';

const KINDS: { value: LayoutGridKind; label: string }[] = [{ value: 'columns', label: msg('Columns') }, { value: 'rows', label: msg('Rows') }, { value: 'grid', label: msg('Grid') }];
const ALIGNS: { value: LayoutGridAlign; label: string }[] = [{ value: 'stretch', label: msg('Stretch') }, { value: 'start', label: ctx('alignment', 'Start') }, { value: 'center', label: msg('Centre') }, { value: 'end', label: msg('End') }];

/** A grid in words, as `describeLayoutGrid` of @bogen/core says it in English. The alignment stays its CSS value. */
function describeGrid(t: Translate, grid: LayoutGrid): string {
  if (grid.kind === 'grid') return t('Grid {size}', { size: grid.size ?? 8 });
  const count = grid.count ?? 12;
  const gutter = grid.gutter ?? 0;
  const align = grid.align ?? 'stretch';
  if (grid.kind === 'columns') {
    return align === 'stretch'
      ? t.n(count, '{count} column, gutter {gutter}, margin {margin}', '{count} columns, gutter {gutter}, margin {margin}', { gutter, margin: grid.margin ?? 0 })
      : t.n(count, '{count} column, gutter {gutter}, {align}, size {size}', '{count} columns, gutter {gutter}, {align}, size {size}', { gutter, align, size: grid.size ?? 80 });
  }
  return align === 'stretch'
    ? t.n(count, '{count} row, gutter {gutter}, margin {margin}', '{count} rows, gutter {gutter}, margin {margin}', { gutter, margin: grid.margin ?? 0 })
    : t.n(count, '{count} row, gutter {gutter}, {align}, size {size}', '{count} rows, gutter {gutter}, {align}, size {size}', { gutter, align, size: grid.size ?? 80 });
}

/**
 * Layout grids of one frame: columns, rows or a square grid over it on the canvas, to place things on and snap
 * to. Each change is one undo step and syncs with the file. Ctrl+Shift+4 shows and hides all of them.
 */
export function LayoutGridSection({ node }: { node: BogenNode }) {
  const t = useT();
  const grids = node.layoutGrids ?? [];
  const shown = useSettings((s) => s.layoutGrids);
  const write = (next: LayoutGrid[]) => {
    const s = session();
    s.tx(() => s.doc.updateFields(node.id, { layoutGrids: next }));
    if (!shown) useSettings.getState().update({ layoutGrids: true });
  };
  const width = rectOf(node.id)?.w ?? 1440;
  const add = () => write([...grids, defaultLayoutGrid(grids.some((g) => g.kind === 'columns') ? 'rows' : 'columns', width)]);
  return (
    <Section
      title={t('Layout grid')}
      empty={!grids.length}
      note={grids.length && !shown ? t('Hidden on the canvas ({shortcut})', { shortcut: 'Ctrl+Shift+4' }) : undefined}
      actions={grids.length < MAX_LAYOUT_GRIDS ? <IconButton icon={<Plus size={14} />} title={t('Add layout grid')} onClick={add} testId="grid-add" /> : null}
    >
      {grids.length ? (
        <div className="stack">
          {grids.map((g, i) => (
            <GridRow
              key={i}
              grid={g}
              index={i}
              width={width}
              onChange={(next) => write(grids.map((x, j) => (j === i ? next : x)))}
              onRemove={() => write(grids.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function GridRow({ grid, index, width, onChange, onRemove }: { grid: LayoutGrid; index: number; width: number; onChange: (g: LayoutGrid) => void; onRemove: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<LayoutGrid>) => onChange({ ...grid, ...patch });
  return (
    <div>
      <div className="list-row grid-row">
        <button type="button" className="disclosure" onClick={() => setOpen(!open)} aria-expanded={open} title={t('Show values')} data-testid={`grid-toggle-${index}`}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <SelectField<LayoutGridKind>
          className="list-row-grow"
          value={grid.kind}
          options={KINDS.map((o) => ({ ...o, label: t(o.label) }))}
          title={t('Kind of grid')}
          testId={`grid-kind-${index}`}
          // A new kind starts from what suits the frame, keeping the colour and whether it shows.
          onChange={(kind) => onChange({ ...defaultLayoutGrid(kind, width), ...(grid.color ? { color: grid.color } : {}), ...(grid.hidden ? { hidden: true } : {}) })}
        />
        <IconButton icon={grid.hidden ? <EyeOff size={14} /> : <Eye size={14} />} title={grid.hidden ? t('Show this grid') : t('Hide this grid')} onClick={() => set({ hidden: grid.hidden ? undefined : true })} testId={`grid-visible-${index}`} />
        <IconButton icon={<Minus size={14} />} title={t('Remove layout grid')} onClick={onRemove} testId={`grid-remove-${index}`} />
      </div>
      {!open ? <div className="list-row-text grid-values" data-testid={`grid-summary-${index}`}>{describeGrid(t, grid)}</div> : (
        <div className="stack grid-values">
          {grid.kind === 'grid' ? (
            <NumberField label={t('Size')} value={grid.size ?? 8} min={1} max={2000} testId={`grid-size-${index}`} onChange={(size) => set({ size })} />
          ) : (
            <>
              <Row>
                <NumberField label={t('Count')} value={grid.count ?? 12} min={1} max={200} precision={0} testId={`grid-count-${index}`} onChange={(count) => set({ count })} />
                <NumberField label={t('Gutter')} value={grid.gutter ?? 0} min={0} testId={`grid-gutter-${index}`} onChange={(gutter) => set({ gutter })} />
              </Row>
              <Row>
                <SelectField<LayoutGridAlign> value={grid.align ?? 'stretch'} options={ALIGNS.map((o) => ({ ...o, label: t(o.label) }))} title={t('Where the tracks sit')} testId={`grid-align-${index}`} onChange={(align) => set({ align, ...(align !== 'stretch' && !grid.size ? { size: 80 } : {}) })} />
                {(grid.align ?? 'stretch') === 'stretch'
                  ? <NumberField label={t('Margin')} value={grid.margin ?? 0} testId={`grid-margin-${index}`} onChange={(margin) => set({ margin })} />
                  : <NumberField label={grid.kind === 'columns' ? t('Width') : t('Height')} value={grid.size ?? 80} min={1} testId={`grid-track-size-${index}`} onChange={(size) => set({ size })} />}
              </Row>
              {(grid.align ?? 'stretch') !== 'stretch' && grid.align !== 'center' ? <NumberField label={t('Offset')} value={grid.margin ?? 0} testId={`grid-offset-${index}`} onChange={(margin) => set({ margin })} /> : null}
            </>
          )}
          <ColorField value={grid.color ?? ''} placeholder={t('Default')} onChange={(color) => set({ color: color || undefined })} testId={`grid-color-${index}`} />
        </div>
      )}
    </div>
  );
}
