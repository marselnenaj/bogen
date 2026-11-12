import type { QueueRow, RunSummary, UndoRunAnswer } from '../lib/collab-api.ts';
import { stepWords } from '../phone/ask-state.ts';
import { msg } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';

/** The words under agents at work and after: steps, undo, layers. Kept apart from the views, so they are tested. */

/** Tools the phone's word list leaves to their names. */
const MORE_WORDS: Record<string, string> = {
  layer_style: msg('Changed styles'), layer_text: msg('Changed text'), layer_rename: msg('Renamed a layer'), layer_get: msg('Read a layer'), layer_find: msg('Looked for layers'),
  layer_move: msg('Moved layers'), layer_duplicate: msg('Duplicated layers'), layer_attrs: msg('Changed attributes'), comment_resolve: msg('Tried to resolve the thread; only you can'), comment_add: msg('Left a comment'),
  layer_styles_computed: msg('Measured styles'), visual_diff: msg('Compared pictures'), asset_upload: msg('Stored an image'), icon_insert: msg('Placed an icon'), component_list: msg('Read the components'),
};

/** A tool as a person would say what happened. */
export function toolWords(tool: string): string {
  const words = MORE_WORDS[tool.replace(/^mcp__bogen__/, '')];
  return words ? t(words) : stepWords(tool);
}

/** The steps of a run in words, oldest first, the same ones on the phone and here. Repeats of one tool fold into a count. */
export function stepLines(steps: { tool: string }[], max = 8): { text: string; count: number }[] {
  const out: { text: string; count: number }[] = [];
  for (const step of steps) {
    const text = toolWords(step.tool);
    const last = out.at(-1);
    if (last?.text === text) last.count++;
    else out.push({ text, count: 1 });
  }
  return out.slice(-max);
}

/** How the result of an undo reads: all of it back, or what stayed because someone changed it since. */
export function undoWords(answer: UndoRunAnswer): string {
  if (answer.clean) return t('Taken back.');
  const kept = answer.conflicts.length;
  if (!answer.reverted) return t.n(kept, 'Nothing could be taken back: one value was changed since.', 'Nothing could be taken back: {count} values were changed since.');
  const list = answer.conflicts.slice(0, 3).map((c) => c.what + (c.field ? ` ${c.field.replace(/^style\./, '')}` : '')).join(', ');
  if (kept > 3) return t('Taken back, except {count} values someone changed since: {list} and more.', { count: kept, list });
  return t.n(kept, 'Taken back, except one value someone changed since: {list}.', 'Taken back, except {count} values someone changed since: {list}.', { list });
}

/** The layers in a reply: the first few by name, then how many more. */
export function layerChips(layers: RunSummary['layers'], max = 6): { shown: RunSummary['layers']; more: number } {
  return { shown: layers.slice(0, max), more: Math.max(0, layers.length - max) };
}

/** The waiting comments, which are the rows that can move, in queue order. */
export function movable(rows: QueueRow[]): string[] {
  return rows.filter((r) => r.kind === 'comment').map((r) => r.id);
}

/** Files a comment can carry besides images. An agent asked in the thread reads them as text. */
const DOC_TYPES: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json' };
export const ATTACH_ACCEPT = `image/*,${[...new Set(Object.values(DOC_TYPES))].join(',')},${Object.keys(DOC_TYPES).map((e) => `.${e}`).join(',')}`;

/** The type to store a file as: what the browser says, or for a document what its name says. Null for what cannot be attached. */
export function attachType(file: { type: string; name?: string }): string | null {
  if (file.type.startsWith('image/')) return file.type;
  const byName = DOC_TYPES[(file.name ?? '').split('.').pop()?.toLowerCase() ?? ''];
  if (Object.values(DOC_TYPES).includes(file.type)) return file.type;
  return byName ?? null;
}

/** Whether an attachment is a picture, by the type in its stored name. */
export function isImageAttachment(src: string): boolean {
  return /^bogen-asset:[a-f0-9]{64}\.(png|jpg|webp|gif|avif|svg|heic|heif)$/.test(src);
}
