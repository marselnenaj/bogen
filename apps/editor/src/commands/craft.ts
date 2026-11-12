import { openTab } from '../panels/ChromePanels.tsx';
import { openFind } from '../canvas/FindBar.tsx';
import { renameFromContent } from '../ops/names.ts';
import { simplifyStyles } from '../ops/simplify.ts';
import { toggleAllMotion } from '../ops/motion.ts';
import { makeResponsiveFromSelection } from '../ops/responsive.ts';
import { booleanOp, shapeToPath } from '../ops/vector.ts';
import { session } from '../doc/session.ts';
import { revealIfOffscreen } from '../ops/reveal.ts';
import { editor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { openOmarchyTheme } from '../panels/OmarchyTheme.tsx';
import { FRAME_PRESETS } from '@bogen/core';
import { openFindReplace } from '../canvas/FindBar.tsx';
import { addLayoutGrid, removeLayoutGrids, toggleLayoutGridsShown } from '../ops/layout-grids.ts';
import { selectMatching, swapOrientation } from '../ops/frames.ts';
import { openBulkRename } from '../panels/BulkRename.tsx';
import { addArtboard } from '../ops/ops.ts';
import { msg } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';

/** Commands for the newer surfaces. Same shape as the ones in the registry, which adds them to its list. */
interface CraftCommand { id: string; title: string; group: string; keys?: string[]; run: () => void; needsSelection?: boolean; inInput?: boolean; repeat?: boolean }

export const CRAFT_COMMANDS: CraftCommand[] = [
  { id: 'view.palette', title: msg('Command palette'), group: msg('View'), keys: ['mod+p'], inInput: true, run: () => ui().set({ paletteOpen: !ui().paletteOpen }) },
  { id: 'view.find', title: msg('Find on canvas'), group: msg('View'), keys: ['mod+f'], inInput: true, run: openFind },
  { id: 'vector.union', title: msg('Union selection'), group: msg('Vector'), keys: ['mod+alt+u'], needsSelection: true, run: () => void booleanOp('union') },
  { id: 'vector.subtract', title: msg('Subtract selection'), group: msg('Vector'), keys: ['mod+alt+shift+s'], needsSelection: true, run: () => void booleanOp('subtract') },
  { id: 'vector.intersect', title: msg('Intersect selection'), group: msg('Vector'), keys: ['mod+alt+i'], needsSelection: true, run: () => void booleanOp('intersect') },
  { id: 'vector.exclude', title: msg('Exclude selection'), group: msg('Vector'), keys: ['mod+alt+x'], needsSelection: true, run: () => void booleanOp('exclude') },
  { id: 'vector.toPath', title: msg('Shape to path'), group: msg('Vector'), keys: ['mod+shift+o'], needsSelection: true, run: () => void shapeToPath() },
  { id: 'view.preview', title: msg('Preview'), group: msg('View'), keys: ['mod+alt+enter'], inInput: true, run: openPreview },
  { id: 'view.motion', title: msg('Show motion'), group: msg('View'), keys: ['alt+m'], run: () => openTab('right', { rightTab: 'motion' }) },
  { id: 'motion.toggle', title: msg('Play or pause all motion'), group: msg('View'), keys: ['alt+p'], run: toggleAllMotion },
  { id: 'view.settings', title: msg('Settings'), group: msg('View'), keys: ['mod+,'], inInput: true, run: () => ui().set({ settingsOpen: !ui().settingsOpen }) },
  { id: 'file.publish', title: msg('Publish as a website'), group: msg('File'), run: () => ui().set({ publishDialog: 'publish' }) },
  { id: 'file.share', title: msg('Share for review'), group: msg('File'), run: () => ui().set({ publishDialog: 'share' }) },
  { id: 'file.omarchyTheme', title: msg('Omarchy theme: export, install, apply'), group: msg('View'), run: openOmarchyTheme },
  { id: 'view.comments', title: msg('Show comments'), group: msg('View'), keys: ['alt+c'], run: () => openTab('right', { rightTab: 'comments' }) },
  { id: 'view.nextRegion', title: msg('Next area of the window'), group: msg('View'), keys: ['f6'], inInput: true, run: () => cycleRegion(1) },
  { id: 'view.prevRegion', title: msg('Previous area of the window'), group: msg('View'), keys: ['shift+f6'], inInput: true, run: () => cycleRegion(-1) },
  { id: 'select.nextFrame', title: msg('Next frame'), group: msg('Selection'), keys: ['n'], run: () => stepFrame(1) },
  { id: 'select.prevFrame', title: msg('Previous frame'), group: msg('Selection'), keys: ['shift+n'], run: () => stepFrame(-1) },
  { id: 'tool.arrow', title: msg('Arrow'), group: msg('Tools'), keys: ['shift+l'], run: () => { ui().set({ arrowLine: true }); editor().setTool('line'); } },
  { id: 'layer.renameFromContent', title: msg('Rename from content'), group: msg('Layers'), run: renameFromContent },
  { id: 'style.simplify', title: msg('Simplify styles'), group: msg('Layers'), run: () => void simplifyStyles() },
  { id: 'layout.responsive', title: msg('Make responsive variants, 768 and 390'), group: msg('Layers'), needsSelection: true, run: makeResponsiveFromSelection },
  { id: 'layer.collapseAll', title: msg('Collapse all layers'), group: msg('Layers'), keys: ['alt+l'], run: collapseAll },
  { id: 'view.findReplace', title: msg('Find and replace text'), group: msg('View'), keys: ['mod+h', 'mod+alt+f'], inInput: true, run: openFindReplace },
  { id: 'view.layoutGrids', title: msg('Show or hide layout grids'), group: msg('View'), keys: ['mod+shift+4'], run: toggleLayoutGridsShown },
  { id: 'layer.gridColumns', title: msg('Add layout grid: columns'), group: msg('Layers'), needsSelection: true, run: () => addLayoutGrid('columns') },
  { id: 'layer.gridRows', title: msg('Add layout grid: rows'), group: msg('Layers'), needsSelection: true, run: () => addLayoutGrid('rows') },
  { id: 'layer.gridSquare', title: msg('Add layout grid: square grid'), group: msg('Layers'), needsSelection: true, run: () => addLayoutGrid('grid') },
  { id: 'layer.gridRemove', title: msg('Remove layout grids'), group: msg('Layers'), needsSelection: true, run: () => removeLayoutGrids() },
  { id: 'select.matching', title: msg('Select matching layers'), group: msg('Selection'), keys: ['mod+alt+a'], needsSelection: true, run: selectMatching },
  { id: 'layer.renameBulk', title: msg('Rename layers in bulk'), group: msg('Layers'), needsSelection: true, run: () => openBulkRename() },
  { id: 'frame.swap', title: msg('Swap width and height'), group: msg('Transform'), needsSelection: true, run: () => swapOrientation() },
  { id: 'arrange.spacingX', title: msg('Set horizontal spacing between layers'), group: msg('Arrange'), needsSelection: true, run: () => focusField('insp-spacing-x') },
  { id: 'arrange.spacingY', title: msg('Set vertical spacing between layers'), group: msg('Arrange'), needsSelection: true, run: () => focusField('insp-spacing-y') },
  ...FRAME_PRESETS.map((p) => ({ id: `frame.new.${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, get title() { return t('New artboard: {name}, {width} × {height}', { name: p.name, width: p.w, height: p.h }); }, group: msg('Frames'), run: () => { addArtboard(p.name, p.w, p.h); } })),
];

/** Puts the keyboard in an inspector field, opening the Design tab first. Says so when the selection has none. */
function focusField(testId: string): void {
  editor().set({ rightTab: 'design' });
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    if (el) el.select();
    else editor().showToast(t('Select two or more layers side by side, outside a flex or grid layout.'));
  });
}

/** Keys that do the same as in Figma, for hands that already know them. Added to the commands that have the job. */
export const FIGMA_ALIASES: Record<string, string[]> = {
  'tool.frame': ['a'],
  'tool.image': ['mod+shift+k'],
  'view.export': ['mod+shift+e'],
  'view.design': ['alt+8'],
  'view.minimal': ['mod+.'],
  'view.zoomFit': ['mod+shift+1'],
  'view.zoomSel': ['mod+shift+2'],
  'arrange.front': ['mod+shift+]'],
  'arrange.back': ['mod+shift+['],
  'layer.wrap': ['mod+shift+alt+g'],
};

const REGIONS = ['.toolbar', '.layer-scroll', '.canvas', '.panel-right'];
let regionAt = 2;

/** F6 goes around the window: toolbar, layers, canvas, inspector. Tab then moves inside one. */
function cycleRegion(step: 1 | -1): void {
  const present = REGIONS.filter((sel) => document.querySelector(sel));
  regionAt = (regionAt + step + present.length) % present.length;
  const el = document.querySelector<HTMLElement>(present[regionAt]!);
  if (!el) return;
  const target = el.matches('[tabindex]') ? el : el.querySelector<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]') ?? el;
  if (!target.hasAttribute('tabindex') && !target.matches('button, a, input, select, textarea')) target.tabIndex = -1;
  target.focus();
}

/** N and Shift+N: through the artboards of the page, bringing each into view. */
function stepFrame(step: 1 | -1): void {
  const state = editor();
  const { snap } = session();
  if (!state.pageId) return;
  const frames = snap.children(state.pageId).filter((id) => snap.nodes.get(id)?.artboard);
  if (!frames.length) return;
  const first = state.selection[0];
  const here = first ? snap.ancestors(first).at(-1) ?? first : null;
  const i = here ? frames.indexOf(here) : -1;
  const next = frames[(i + step + frames.length) % frames.length]!;
  state.set({ selection: [next] });
  revealIfOffscreen([next], true);
}

/** The artboard around the selection, or the page's first, in its own view. */
function openPreview(): void {
  const state = editor();
  const { snap } = session();
  const first = state.selection[0];
  const top = first ? (snap.ancestors(first).at(-1) ?? first) : state.pageId ? snap.children(state.pageId).find((id) => snap.nodes.get(id)?.artboard) ?? snap.children(state.pageId)[0] : undefined;
  location.hash = `#/file/${state.fileId}/preview${top ? `/${top}` : ''}`;
}

function collapseAll(): void {
  const { snap } = session();
  const next: Record<string, boolean> = {};
  for (const id of snap.nodes.keys()) if (snap.children(id).length) next[id] = true;
  editor().set({ collapsed: next, selection: [] });
}
