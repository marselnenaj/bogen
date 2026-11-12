import { createMode, getModes, setTokenMode } from './design-system.ts';
import type { BogenDoc, TokenKind } from './doc.ts';

/** A kit's token: its own CSS variable name, and its values in light and, where it has one, dark. */
export interface KitTokenValue { name: string; kind: TokenKind; light: string; dark?: string }

/**
 * Writes a component kit's tokens into a file with a dark mode, adding only those the file lacks unless told to
 * replace. Here in core so that the editor writes them in its own transaction, as one undo step with the link.
 */
export function writeKitTokens(doc: BogenDoc, tokens: KitTokenValue[], replace = false): string[] {
  const added: string[] = [];
  if (tokens.some((t) => t.dark !== undefined) && !getModes(doc).some((m) => m.name === 'dark')) createMode(doc, 'dark', { baseName: 'light' });
  const darkIsBase = getModes(doc).find((m) => m.base)?.name === 'dark';
  for (const t of tokens) {
    if (!replace && doc.tokens.has(t.name)) continue;
    doc.setToken(t.name, t.kind, darkIsBase ? t.dark ?? t.light : t.light);
    if (t.dark !== undefined) setTokenMode(doc, t.name, darkIsBase ? 'light' : 'dark', darkIsBase ? t.light : t.dark);
    added.push(t.name);
  }
  return added;
}
