import type { SyncConflict } from '../lib/agent-api.ts';
import { session } from '../doc/session.ts';

/**
 * A conflict note's value that was not kept, set again. It is an ordinary edit, which undo can take back. Used by
 * the Sync section on the desktop and by the note on the phone.
 */
export function useOther(conflict: SyncConflict): void {
  const s = session();
  const value = conflict.kept === 'theirs' ? conflict.ours : conflict.theirs;
  const texts = conflict.texts;
  s.tx(() => {
    if (texts && conflict.nodeId) {
      // The whole text, with its ranges: the note shows only the start of a long one.
      const other = conflict.kept === 'theirs' ? texts.ours : texts.theirs;
      s.doc.updateFields(conflict.nodeId, { text: other.text, spans: other.spans ?? [] });
    } else if (conflict.kind === 'token') {
      const token = s.doc.getTokens().find((t) => t.name === conflict.name);
      if (token) s.doc.setToken(token.name, token.kind, value);
    } else if (conflict.nodeId && conflict.field.startsWith('style.')) {
      s.doc.updateStyle(conflict.nodeId, { [conflict.field.slice(6)]: value });
    } else if (conflict.nodeId && ['name', 'text', 'tag', 'src'].includes(conflict.field)) {
      s.doc.updateFields(conflict.nodeId, { [conflict.field]: value });
    }
  });
}

export function canUseOther(c: SyncConflict): boolean {
  return c.kind === 'token' || c.field.startsWith('style.') || ['name', 'text', 'tag', 'src'].includes(c.field);
}

/** A field as a person says it: `style.backgroundColor` is "background color". */
export function fieldWords(field: string): string {
  return field.replace(/^style\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}
