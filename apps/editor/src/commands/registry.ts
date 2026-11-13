import { cancelDrag, isDragging, isSpaceDown, pathEditKey, setSpaceDown } from '../canvas/pointer.ts';
import { nextZoomStop } from '../canvas/geometry.ts';
import { cancelPen, finishPen, penActive } from '../canvas/pen.ts';
import { armPasteMode, copyStyles, onCopy, onPaste, pasteFromSystem, pasteStyles, placeImagePlaceholder } from '../ops/clipboard.ts';
import * as ops from '../ops/ops.ts';
import { showSizes } from '../ops/breakpoints.ts';
import { currentChrome, openTab, showPanel } from '../panels/ChromePanels.tsx';
import { fitScreen } from '../ops/fit-view.ts';
import { detachSelection, goToMain, makeComponent } from '../ops/components.ts';
import { redoSelectedScreen, selectedScreen } from '../panels/redo-screen.ts';
import { camera } from '../state/camera.ts';
import { editor, type Tool } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { pickImage } from '../ops/images.ts';
import { rebuildAsLayers, startPrompt, toggleChat } from '../panels/prompt-actions.ts';
import { askForCommit, setStageView } from '../panels/history-state.ts';
import { openAppCompare, openAppScreenBeside } from '../panels/AppScreens.tsx';
import { pullRequestFromSelection } from '../panels/PullRequestDialog.tsx';
import { startTextEdit } from '../canvas/text-edit.ts';
import { session } from '../doc/session.ts';
import { api } from '../lib/api.ts';
import { CRAFT_COMMANDS, FIGMA_ALIASES } from './craft.ts';
import { gradientKey } from '../canvas/gradient-drag.ts';
import { openBulkRename } from '../panels/BulkRename.tsx';
import { msg } from '../i18n/core.ts';

export interface Command {
  id: string;
  /** English, marked with `msg()`; shown through `t(title)`. */
  title: string;
  /** English, marked with `msg()`; shown through `t(group)`. Also the key the shortcuts list groups by. */
  group: string;
  /** e.g. `mod+shift+g`. `mod` is ctrl or cmd. Letters and punctuation by their key, digits by position. */
  keys?: string[];
  run: () => void;
  needsSelection?: boolean;
  /** Runs even with focus in a text field. */
  inInput?: boolean;
  /** Does not call preventDefault, so that the browser fires its own event (copy, paste). */
  native?: boolean;
  repeat?: boolean;
  /** Whether it is offered at all, say only in a file linked to a repository. */
  when?: () => boolean;
}

const linked = () => !!session().doc.meta.get('codeProject');

function tool(t: Tool): () => void {
  return () => editor().setTool(t);
}

const sel = true;

export const COMMANDS: Command[] = [
  { id: 'tool.move', title: msg('Move'), group: msg('Tools'), keys: ['v'], run: tool('move') },
  { id: 'tool.hand', title: msg('Hand'), group: msg('Tools'), keys: ['h'], run: tool('hand') },
  { id: 'tool.frame', title: msg('Frame'), group: msg('Tools'), keys: ['f'], run: tool('frame') },
  { id: 'tool.rect', title: msg('Rectangle'), group: msg('Tools'), keys: ['r'], run: tool('rect') },
  { id: 'tool.ellipse', title: msg('Ellipse'), group: msg('Tools'), keys: ['o'], run: tool('ellipse') },
  { id: 'tool.line', title: msg('Line'), group: msg('Tools'), keys: ['l'], run: tool('line') },
  { id: 'tool.text', title: msg('Text'), group: msg('Tools'), keys: ['t'], run: tool('text') },
  { id: 'tool.pen', title: msg('Pen'), group: msg('Tools'), keys: ['p'], run: tool('pen') },
  { id: 'tool.pencil', title: msg('Pencil'), group: msg('Tools'), keys: ['shift+p'], run: tool('pencil') },
  { id: 'tool.image', title: msg('Place image'), group: msg('Tools'), keys: ['i'], run: () => pickImage() },
  { id: 'tool.imagePlaceholder', title: msg('Image placeholder'), group: msg('Tools'), run: () => { placeImagePlaceholder(); } },
  { id: 'tool.comment', title: msg('Comment'), group: msg('Tools'), keys: ['c'], run: tool('comment') },
  { id: 'tool.shader', title: msg('Shader'), group: msg('Tools'), keys: ['s'], run: tool('shader') },
  { id: 'tool.zoom', title: msg('Zoom tool'), group: msg('Tools'), keys: ['z'], run: tool('zoom') },

  { id: 'view.zoomIn', title: msg('Zoom in'), group: msg('View'), keys: ['=', '+', 'mod+='], run: () => camera.zoomAt(nextZoomStop(camera.value.z, 1)) },
  { id: 'view.zoomOut', title: msg('Zoom out'), group: msg('View'), keys: ['-', 'mod+-'], run: () => camera.zoomAt(nextZoomStop(camera.value.z, -1)) },
  { id: 'view.zoom100', title: msg('Zoom to 100%'), group: msg('View'), keys: ['shift+0', 'mod+0'], run: () => camera.zoomAt(1) },
  { id: 'view.zoomFit', title: msg('All screens: fit every artboard of the page'), group: msg('View'), keys: ['shift+1'], run: () => ops.fitAll() },
  { id: 'view.fitScreen', title: msg('Fit screen: the selected or current artboard, held while the window changes'), group: msg('View'), keys: ['shift+3'], run: () => fitScreen('screen') },
  { id: 'view.fitWidth', title: msg('Fit width: fill the canvas with the artboard\'s width'), group: msg('View'), keys: ['shift+4'], run: () => fitScreen('width') },
  { id: 'view.zoomSel', title: msg('Zoom to selection'), group: msg('View'), keys: ['shift+2'], run: () => ops.fitSelection() },
  { id: 'view.minimal', title: msg('Minimal UI'), group: msg('View'), keys: ['mod+\\'], inInput: true, run: () => editor().set({ minimal: !editor().minimal }) },
  { id: 'view.shortcuts', title: msg('Keyboard shortcuts'), group: msg('View'), keys: ['mod+/'], inInput: true, run: () => editor().set({ shortcutsOpen: !editor().shortcutsOpen }) },
  { id: 'file.appScreen', title: msg('Import an app screen'), group: msg('Edit'), run: openAppScreenBeside },
  { id: 'file.appCompare', title: msg('Design versus app'), group: msg('Edit'), run: openAppCompare },
  { id: 'help.welcome', title: msg('Welcome to Bogen'), group: msg('View'), run: () => void api.welcome().then(({ id }) => { location.hash = `#/file/${id}`; }) },
  { id: 'view.prompt', title: msg('Ask your agent'), group: msg('View'), keys: ['mod+k'], inInput: true, run: () => startPrompt() },
  { id: 'view.chatPanel', title: msg('Chat with your agent: show or hide'), group: msg('View'), keys: ['mod+alt+3'], inInput: true, run: () => toggleChat() },
  { id: 'view.sizes', title: msg('See the artboard at several widths'), group: msg('View'), run: () => showSizes() },
  { id: 'agent.redoScreen', title: msg('Redo this screen…'), group: msg('Layers'), needsSelection: sel, when: () => Boolean(selectedScreen()), run: redoSelectedScreen },
  { id: 'agent.rebuild', title: msg('Rebuild as layers'), group: msg('Layers'), needsSelection: sel, run: () => { const [id] = editor().selection; if (id) void rebuildAsLayers(id); } },
  { id: 'view.chat', title: msg('Cursor chat'), group: msg('View'), keys: ['/'], run: () => editor().set({ cursorChat: { open: true, text: '' } }) },
  { id: 'view.leftPanel', title: msg('Layers panel: show or hide'), group: msg('View'), keys: ['mod+alt+1'], run: () => showPanel('left', true) },
  { id: 'view.rightPanel', title: msg('Inspector: show or hide'), group: msg('View'), keys: ['mod+alt+2'], run: () => showPanel('right', true) },
  { id: 'view.layers', title: msg('Show layers'), group: msg('View'), keys: ['alt+1'], run: () => openTab('left', { leftTab: 'layers' }) },
  { id: 'view.tokens', title: msg('Show tokens'), group: msg('View'), keys: ['alt+2'], run: () => openTab('left', { leftTab: 'tokens' }) },
  { id: 'view.assets', title: msg('Show assets'), group: msg('View'), keys: ['alt+3'], run: () => openTab('left', { leftTab: 'assets' }) },
  { id: 'view.data', title: msg('Show data'), group: msg('View'), keys: ['alt+4'], run: () => openTab('left', { leftTab: 'data' }) },
  { id: 'view.code', title: msg('Show code'), group: msg('View'), keys: ['shift+c'], run: () => openTab('right', { rightTab: 'code' }) },
  { id: 'view.design', title: msg('Show design'), group: msg('View'), keys: ['shift+d'], run: () => openTab('right', { rightTab: 'design' }) },
  { id: 'view.checks', title: msg('Design checks'), group: msg('View'), run: () => ui().set({ checksOpen: true }) },
  { id: 'view.compliance', title: msg('Accessibility and legal check'), group: msg('View'), run: () => ui().set({ complianceOpen: true }) },
  { id: 'view.export', title: msg('Show export'), group: msg('View'), keys: ['shift+e'], run: () => openTab('right', { rightTab: 'export' }) },
  { id: 'view.drift', title: msg('Compare with the live site (Drift)'), group: msg('View'), run: () => openTab('right', { rightTab: 'drift' }) },
  { id: 'file.restyle', title: msg('Like this site, in a brand'), group: msg('View'), run: () => ui().set({ restyleOpen: true }) },

  { id: 'file.replay', title: msg('Replay how this page was built'), group: msg('View'), run: () => { const { fileId, pageId } = editor(); if (fileId && pageId) setStageView({ kind: 'replay', fileId, pageId }); } },
  { id: 'file.commit', title: msg('Commit where things stand'), group: msg('Edit'), keys: ['ctrl+alt+s', 'mod+alt+s'], inInput: true, run: () => { openTab('right', { rightTab: 'history' }); requestAnimationFrame(askForCommit); } },
  { id: 'edit.undo', title: msg('Undo'), group: msg('Edit'), keys: ['mod+z'], repeat: true, run: () => ops.undo() },
  { id: 'edit.redo', title: msg('Redo'), group: msg('Edit'), keys: ['mod+shift+z', 'mod+y'], repeat: true, run: () => ops.redo() },
  { id: 'edit.copy', title: msg('Copy'), group: msg('Edit'), keys: ['mod+c'], needsSelection: sel, native: true, run: () => void document.execCommand('copy') },
  { id: 'edit.cut', title: msg('Cut'), group: msg('Edit'), keys: ['mod+x'], needsSelection: sel, native: true, run: () => void document.execCommand('cut') },
  { id: 'edit.paste', title: msg('Paste'), group: msg('Edit'), keys: ['mod+v'], native: true, run: () => void pasteFromSystem('normal') },
  { id: 'edit.pasteOver', title: msg('Paste on top'), group: msg('Edit'), keys: ['mod+shift+v'], native: true, run: () => { armPasteMode('over'); void pasteFromSystem('over'); } },
  { id: 'edit.pasteReplace', title: msg('Paste to replace'), group: msg('Edit'), keys: ['mod+shift+r'], needsSelection: sel, run: () => void pasteFromSystem('replace') },
  { id: 'edit.copyStyles', title: msg('Copy styles'), group: msg('Edit'), keys: ['mod+alt+c'], needsSelection: sel, run: copyStyles },
  { id: 'edit.pasteStyles', title: msg('Paste styles'), group: msg('Edit'), keys: ['mod+alt+v'], needsSelection: sel, run: pasteStyles },
  { id: 'edit.duplicate', title: msg('Duplicate'), group: msg('Edit'), keys: ['mod+d'], needsSelection: sel, run: () => void ops.duplicateSelection() },
  { id: 'edit.delete', title: msg('Delete'), group: msg('Edit'), keys: ['delete', 'backspace'], needsSelection: sel, run: ops.deleteSelection },
  { id: 'edit.rename', title: msg('Rename layer'), group: msg('Edit'), keys: ['mod+r'], needsSelection: sel, run: () => openBulkRename() },

  { id: 'select.all', title: msg('Select all'), group: msg('Selection'), keys: ['mod+a'], run: ops.selectAll },
  { id: 'select.none', title: msg('Deselect'), group: msg('Selection'), keys: ['escape'], run: () => onEscape() },
  { id: 'select.next', title: msg('Next sibling'), group: msg('Selection'), keys: ['tab'], run: () => ops.selectSibling(1) },
  { id: 'select.prev', title: msg('Previous sibling'), group: msg('Selection'), keys: ['shift+tab'], run: () => ops.selectSibling(-1) },
  { id: 'select.child', title: msg('Select child or edit text'), group: msg('Selection'), keys: ['enter'], needsSelection: sel, run: () => onEnter() },
  { id: 'select.parent', title: msg('Select parent'), group: msg('Selection'), keys: ['shift+enter', '\\'], needsSelection: sel, run: ops.selectParent },

  { id: 'nudge.left', title: msg('Nudge left'), group: msg('Transform'), keys: ['arrowleft'], repeat: true, needsSelection: sel, run: () => ops.nudge(-1, 0) },
  { id: 'nudge.right', title: msg('Nudge right'), group: msg('Transform'), keys: ['arrowright'], repeat: true, needsSelection: sel, run: () => ops.nudge(1, 0) },
  { id: 'nudge.up', title: msg('Nudge up'), group: msg('Transform'), keys: ['arrowup'], repeat: true, needsSelection: sel, run: () => ops.nudge(0, -1) },
  { id: 'nudge.down', title: msg('Nudge down'), group: msg('Transform'), keys: ['arrowdown'], repeat: true, needsSelection: sel, run: () => ops.nudge(0, 1) },
  { id: 'nudge.left10', title: msg('Nudge left by 10'), group: msg('Transform'), keys: ['shift+arrowleft'], repeat: true, needsSelection: sel, run: () => ops.nudge(-10, 0) },
  { id: 'nudge.right10', title: msg('Nudge right by 10'), group: msg('Transform'), keys: ['shift+arrowright'], repeat: true, needsSelection: sel, run: () => ops.nudge(10, 0) },
  { id: 'nudge.up10', title: msg('Nudge up by 10'), group: msg('Transform'), keys: ['shift+arrowup'], repeat: true, needsSelection: sel, run: () => ops.nudge(0, -10) },
  { id: 'nudge.down10', title: msg('Nudge down by 10'), group: msg('Transform'), keys: ['shift+arrowdown'], repeat: true, needsSelection: sel, run: () => ops.nudge(0, 10) },
  { id: 'layer.flipX', title: msg('Flip horizontal'), group: msg('Transform'), keys: ['shift+h'], needsSelection: sel, run: () => ops.flip('x') },
  { id: 'layer.flipY', title: msg('Flip vertical'), group: msg('Transform'), keys: ['shift+v'], needsSelection: sel, run: () => ops.flip('y') },

  { id: 'component.create', title: msg('Make component'), group: msg('Layers'), keys: ['mod+alt+k'], needsSelection: sel, run: makeComponent },
  { id: 'component.detach', title: msg('Detach instance'), group: msg('Layers'), keys: ['mod+alt+b'], needsSelection: sel, run: detachSelection },
  { id: 'component.main', title: msg('Go to main component'), group: msg('Layers'), needsSelection: sel, run: () => goToMain() },
  { id: 'code.pullRequest', title: msg('Open a pull request'), group: msg('Code'), needsSelection: sel, when: linked, run: pullRequestFromSelection },
  { id: 'code.repoTokens', title: msg('Tokens and the repository'), group: msg('Code'), when: linked, run: () => ui().set({ repoTokensOpen: true }) },
  { id: 'layer.group', title: msg('Group'), group: msg('Layers'), keys: ['mod+g'], needsSelection: sel, run: ops.groupSelection },
  { id: 'layer.ungroup', title: msg('Ungroup'), group: msg('Layers'), keys: ['mod+shift+g'], needsSelection: sel, run: ops.ungroupSelection },
  { id: 'layer.wrap', title: msg('Wrap in frame'), group: msg('Layers'), keys: ['mod+alt+g'], needsSelection: sel, run: ops.wrapInFrame },
  { id: 'layer.flatten', title: msg('Flatten'), group: msg('Layers'), keys: ['mod+e'], needsSelection: sel, run: ops.flattenSelection },
  { id: 'layer.autoLayout', title: msg('Add flex layout'), group: msg('Layers'), keys: ['shift+a'], needsSelection: sel, run: ops.addAutoLayout },
  { id: 'layer.lock', title: msg('Lock or unlock'), group: msg('Layers'), keys: ['mod+shift+l'], needsSelection: sel, run: ops.toggleLock },
  { id: 'layer.hide', title: msg('Hide or show'), group: msg('Layers'), keys: ['mod+shift+h'], needsSelection: sel, run: ops.toggleHide },

  { id: 'arrange.forward', title: msg('Bring forward'), group: msg('Arrange'), keys: ['mod+]'], needsSelection: sel, run: () => ops.zOrder('forward') },
  { id: 'arrange.backward', title: msg('Send backward'), group: msg('Arrange'), keys: ['mod+['], needsSelection: sel, run: () => ops.zOrder('backward') },
  { id: 'arrange.front', title: msg('Bring to front'), group: msg('Arrange'), keys: ['mod+alt+]', ']'], needsSelection: sel, run: () => ops.zOrder('front') },
  { id: 'arrange.back', title: msg('Send to back'), group: msg('Arrange'), keys: ['mod+alt+[', '['], needsSelection: sel, run: () => ops.zOrder('back') },
  { id: 'align.left', title: msg('Align left'), group: msg('Arrange'), keys: ['alt+a'], needsSelection: sel, run: () => ops.align('left') },
  { id: 'align.hcenter', title: msg('Align horizontal centres'), group: msg('Arrange'), keys: ['alt+h'], needsSelection: sel, run: () => ops.align('hcenter') },
  { id: 'align.right', title: msg('Align right'), group: msg('Arrange'), keys: ['alt+d'], needsSelection: sel, run: () => ops.align('right') },
  { id: 'align.top', title: msg('Align top'), group: msg('Arrange'), keys: ['alt+w'], needsSelection: sel, run: () => ops.align('top') },
  { id: 'align.vcenter', title: msg('Align vertical centres'), group: msg('Arrange'), keys: ['alt+v'], needsSelection: sel, run: () => ops.align('vcenter') },
  { id: 'align.bottom', title: msg('Align bottom'), group: msg('Arrange'), keys: ['alt+s'], needsSelection: sel, run: () => ops.align('bottom') },
  { id: 'distribute.x', title: msg('Distribute horizontal'), group: msg('Arrange'), keys: ['alt+shift+h'], needsSelection: sel, run: () => ops.distribute('x') },
  { id: 'distribute.y', title: msg('Distribute vertical'), group: msg('Arrange'), keys: ['alt+shift+v'], needsSelection: sel, run: () => ops.distribute('y') },
  { id: 'arrange.tidy', title: msg('Tidy up'), group: msg('Arrange'), keys: ['ctrl+alt+t'], needsSelection: sel, run: ops.tidy },

  { id: 'type.bold', title: msg('Bold'), group: msg('Typography'), keys: ['mod+b'], needsSelection: sel, run: () => ops.toggleTextStyle('fontWeight', '700', '400') },
  { id: 'type.italic', title: msg('Italic'), group: msg('Typography'), keys: ['mod+i'], needsSelection: sel, run: () => ops.toggleTextStyle('fontStyle', 'italic', null) },
  { id: 'type.underline', title: msg('Underline'), group: msg('Typography'), keys: ['mod+u'], needsSelection: sel, run: () => ops.toggleTextStyle('textDecorationLine', 'underline', null) },
  { id: 'type.strike', title: msg('Strikethrough'), group: msg('Typography'), keys: ['mod+shift+x'], needsSelection: sel, run: () => ops.toggleTextStyle('textDecorationLine', 'line-through', null) },
  { id: 'type.alignLeft', title: msg('Text align left'), group: msg('Typography'), keys: ['mod+alt+l'], needsSelection: sel, run: () => ops.setStyle(editor().selection, { textAlign: 'left' }) },
  { id: 'type.alignCenter', title: msg('Text align centre'), group: msg('Typography'), keys: ['mod+alt+e'], needsSelection: sel, run: () => ops.setStyle(editor().selection, { textAlign: 'center' }) },
  { id: 'type.alignRight', title: msg('Text align right'), group: msg('Typography'), keys: ['mod+alt+r'], needsSelection: sel, run: () => ops.setStyle(editor().selection, { textAlign: 'right' }) },
  { id: 'type.alignJustify', title: msg('Text justify'), group: msg('Typography'), keys: ['mod+alt+j'], needsSelection: sel, run: () => ops.setStyle(editor().selection, { textAlign: 'justify' }) },
  { id: 'type.sizeUp', title: msg('Increase font size'), group: msg('Typography'), keys: ['mod+shift+.', 'mod+shift+>'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('fontSize', 1) },
  { id: 'type.sizeDown', title: msg('Decrease font size'), group: msg('Typography'), keys: ['mod+shift+,', 'mod+shift+<'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('fontSize', -1) },
  { id: 'type.weightUp', title: msg('Increase font weight'), group: msg('Typography'), keys: ['mod+alt+.'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('fontWeight', 100) },
  { id: 'type.weightDown', title: msg('Decrease font weight'), group: msg('Typography'), keys: ['mod+alt+,'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('fontWeight', -100) },
  { id: 'type.leadingUp', title: msg('Increase line height'), group: msg('Typography'), keys: ['alt+shift+.'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('lineHeight', 1) },
  { id: 'type.leadingDown', title: msg('Decrease line height'), group: msg('Typography'), keys: ['alt+shift+,'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('lineHeight', -1) },
  { id: 'type.trackingUp', title: msg('Increase tracking'), group: msg('Typography'), keys: ['alt+.'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('letterSpacing', 0.5) },
  { id: 'type.trackingDown', title: msg('Decrease tracking'), group: msg('Typography'), keys: ['alt+,'], repeat: true, needsSelection: sel, run: () => ops.adjustTextStyle('letterSpacing', -0.5) },
];

COMMANDS.push(...CRAFT_COMMANDS);
for (const c of COMMANDS) {
  const more = FIGMA_ALIASES[c.id];
  if (more) c.keys = [...(c.keys ?? []), ...more];
}

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function commandById(id: string): Command | undefined {
  return byId.get(id);
}

export function runCommand(id: string): void {
  byId.get(id)?.run();
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const KEY_LABELS: Record<string, string> = { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', escape: 'Esc', enter: 'Enter', tab: 'Tab', delete: 'Del', backspace: 'Backspace' };

export function displayKey(combo: string): string {
  return combo.split('+').filter(Boolean).map((part) => {
    if (part === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (part === 'ctrl') return 'Ctrl';
    if (part === 'alt') return isMac ? '⌥' : 'Alt';
    if (part === 'shift') return isMac ? '⇧' : 'Shift';
    return KEY_LABELS[part] ?? part.toUpperCase();
  }).join(isMac ? '' : '+') || (combo.endsWith('+') ? '+' : combo);
}

export function displayKeys(c: Command): string {
  return c.keys?.[0] ? displayKey(c.keys[0]) : '';
}

function comboOf(e: KeyboardEvent): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const prefix = parts.length ? `${parts.join('+')}+` : '';
  let key = e.key.toLowerCase();
  // Alt and shift change the character on many layouts. Fall back on the physical key.
  const codeKey = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code.startsWith('Digit') ? e.code.slice(5) : e.code === 'Period' ? '.' : e.code === 'Comma' ? ',' : e.code === 'Backslash' ? '\\' : e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']' : e.code === 'Slash' ? '/' : e.code === 'Equal' ? '=' : e.code === 'Minus' ? '-' : null;
  if (key === ' ') key = 'space';
  out.push(prefix + key);
  if (codeKey && codeKey !== key) out.push(prefix + codeKey);
  // Bare `+` is typed with shift on most layouts.
  if (key === '+' || key === '?' || key === '>' || key === '<') out.push((parts.filter((p) => p !== 'shift').length ? `${parts.filter((p) => p !== 'shift').join('+')}+` : '') + key);
  if (e.ctrlKey && !e.metaKey) out.push(prefix.replace('mod', 'ctrl') + (codeKey ?? key));
  return out;
}

const keymap = new Map<string, Command>();
for (const c of COMMANDS) for (const k of c.keys ?? []) keymap.set(k, c);

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onEscape(): void {
  const state = editor();
  if (penActive()) {
    cancelPen();
    state.setTool('move');
    return;
  }
  if (state.tool !== 'move') return state.setTool('move');
  if (state.pendingComment) return state.set({ pendingComment: null });
  // A chat over the canvas closes; one docked beside it stays, like the other panels.
  if (state.prompt.open && currentChrome().chat === 'drawer') return state.set({ prompt: { ...state.prompt, open: false } });
  if (state.followClientId !== null) return state.set({ followClientId: null });
  if (!state.selection.length) return;
  const { snap } = session();
  const first = state.selection[0]!;
  const parent = snap.nodes.get(first)?.parent;
  // Esc steps out of a nested selection first, then clears it.
  if (state.selection.length === 1 && parent && snap.nodes.has(parent)) state.set({ selection: [parent] });
  else state.set({ selection: [] });
}

function onEnter(): void {
  const state = editor();
  if (penActive()) return finishPen();
  const { snap } = session();
  const first = state.selection[0];
  const n = first ? snap.nodes.get(first) : undefined;
  if (state.selection.length === 1 && n?.type === 'text') startTextEdit(n.id, { selectAll: true });
  else ops.selectChild();
}

/**
 * With the keyboard in the chrome, the keys that move around there do just that: Tab, arrows, Enter and
 * Space act on the focused control, as anywhere else. A control focused by a click does not count, so that
 * after clicking a tool the shortcuts keep working. Esc goes back to the canvas.
 */
function keysBelongToFocus(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el?.matches || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (!el.matches(':focus-visible') || el === document.body) return false;
  if (!el.closest('.toolbar, .panel, .dialog, .popover, .find-bar, .text-bar') || el.isContentEditable || isTyping(el)) return false;
  if (e.key === 'Escape') {
    el.blur();
    e.preventDefault();
    return true;
  }
  return e.key === 'Tab' || e.key === 'Enter' || e.key === ' ' || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End';
}

/** Installs the one key handler the whole editor uses. Returns the teardown. */
export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (keysBelongToFocus(e)) return;
    const typing = isTyping(e.target);
    if (e.key === 'Alt') {
      e.preventDefault();
      if (!typing) editor().set({ altDown: true });
    }
    if (e.key === ' ' && !typing) {
      e.preventDefault();
      if (!isSpaceDown()) setSpaceDown(true);
      return;
    }
    if (!typing && (pathEditKey(e) || gradientKey(e))) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && isDragging()) {
      e.preventDefault();
      cancelDrag();
      return;
    }
    const combos = comboOf(e);
    let cmd: Command | undefined;
    for (const c of combos) {
      cmd = keymap.get(c);
      if (cmd) break;
    }
    if (!cmd) return;
    if (typing && !cmd.inInput) return;
    if (e.repeat && !cmd.repeat) {
      if (!cmd.native) e.preventDefault();
      return;
    }
    if (cmd.native) {
      if (cmd.id === 'edit.pasteOver') armPasteMode('over');
      // The browser now fires copy, cut or paste, which the listeners below handle.
      return;
    }
    e.preventDefault();
    if (cmd.needsSelection && !editor().selection.length) return;
    try {
      cmd.run();
    } catch (err) {
      // Such as a layer inside an instance refusing to move: say why instead of doing nothing.
      editor().showToast((err as Error).message);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt') {
      e.preventDefault();
      editor().set({ altDown: false });
    }
    if (e.key === ' ') setSpaceDown(false);
  };
  const onBlur = () => {
    setSpaceDown(false);
    editor().set({ altDown: false });
  };
  const copy = (e: ClipboardEvent) => { if (!isTyping(e.target)) onCopy(e, false); };
  const cut = (e: ClipboardEvent) => { if (!isTyping(e.target)) onCopy(e, true); };
  const paste = (e: ClipboardEvent) => { if (!isTyping(e.target)) onPaste(e); };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('copy', copy);
  document.addEventListener('cut', cut);
  document.addEventListener('paste', paste);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('copy', copy);
    document.removeEventListener('cut', cut);
    document.removeEventListener('paste', paste);
  };
}
