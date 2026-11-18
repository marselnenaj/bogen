import type { Y } from '@bogen/core';

/**
 * Where code outside the teams service gets a Yjs id for a private copy it will write back into a file: a team
 * file's changes must be written with ids derived from this device's key (envelope.ts, clientIdOf), or members
 * refuse them. For any other file (or with teams off) the copy keeps Yjs's random id, as before.
 */
let provider: ((file: string) => number | null) | null = null;

export function setWriterProvider(p: (file: string) => number | null): () => void {
  provider = p;
  // Clears only its own: a later service (tests run several in one process) keeps its provider.
  return () => {
    if (provider === p) provider = null;
  };
}

/** Gives `doc` a writer id for `file` when the file is a team file here; does nothing otherwise. */
export function assignWriter(file: string, doc: Y.Doc): void {
  const id = provider?.(file) ?? null;
  if (id !== null) doc.clientID = id;
}
