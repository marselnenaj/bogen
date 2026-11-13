import { acceptLibraryUpdates, libraryLinks, linkLibrary, publishLibrary, unlinkLibrary, writeKitTokens, type KitTokenValue, type LibraryInfo, type PublishedComponent } from '@bogen/core';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** Shared libraries from the editor. The server only says what exists; every change is a transaction here, so Ctrl+Z takes it back. */

export interface LibrarySummary { id: string; name: string; kind: 'file' | 'brand'; fileName: string; version: number; publishedAt: number; components: { main: string; name: string; version: number }[]; brand?: boolean }
export interface LibraryStatus {
  library?: { name: string; version: number; unpublished: { main: string; name: string; status: string }[] };
  linked: { id: string; name: string; missing: boolean }[];
  available: LibrarySummary[];
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.status === 404 ? t('That library is not on this device, or publishes nothing.') : t('GET {path} failed with {status}', { path, status: res.status }));
  return (await res.json()) as T;
}

export const libraryApi = {
  status: (fileId: string) => json<LibraryStatus>(`/api/files/${fileId}/libraries`),
  get: (id: string) => json<{ summary: LibrarySummary; published: PublishedComponent[]; info?: LibraryInfo }>(`/api/libraries/${id}`),
};

export async function linkHere(id: string): Promise<void> {
  try {
    const { summary, published, info } = await libraryApi.get(id);
    const s = session();
    s.tx(() => linkLibrary(s.doc, { id: summary.id, name: summary.name, kind: summary.kind, ...(info?.renames?.length ? { renamesAt: info.renames.at(-1)!.at } : {}) }, published));
    editor().showToast(t('Linked {name}. Its components are in Assets.', { name: summary.name }));
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

export function unlinkHere(id: string): void {
  const s = session();
  const name = libraryLinks(s.doc).find((l) => l.id === id)?.name;
  const out = s.tx(() => unlinkLibrary(s.doc, id));
  if (name === undefined) {
    editor().showToast(out.kept ? t.n(out.kept, 'Unlinked the library. {count} component(s) stay for the instances that use them.', 'Unlinked the library. {count} component(s) stay for the instances that use them.') : t('Unlinked the library.'));
  } else {
    editor().showToast(out.kept ? t.n(out.kept, 'Unlinked {name}. {count} component(s) stay for the instances that use them.', 'Unlinked {name}. {count} component(s) stay for the instances that use them.', { name }) : t('Unlinked {name}.', { name }));
  }
}

/** Takes a library's updates, all or some, with what they show inside. One undo step. */
export async function acceptHere(id: string, only?: string[]): Promise<void> {
  try {
    const { summary, published, info } = await libraryApi.get(id);
    const s = session();
    const out = s.tx(() => acceptLibraryUpdates(s.doc, id, published, only, undefined, info));
    editor().showToast(out.overrides.kept
      ? t.n(out.accepted.length, 'Updated {count} component(s) from {name}. Overrides kept: {kept}.', 'Updated {count} component(s) from {name}. Overrides kept: {kept}.', { name: summary.name, kept: out.overrides.kept })
      : t.n(out.accepted.length, 'Updated {count} component(s) from {name}.', 'Updated {count} component(s) from {name}.', { name: summary.name }));
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}

export function publishHere(name?: string): void {
  const s = session();
  let out: ReturnType<typeof publishLibrary>;
  try {
    out = s.tx(() => publishLibrary(s.doc, { name: name ?? editor().fileName ?? undefined, by: 'editor' }));
  } catch (err) {
    editor().showToast((err as Error).message);
    return;
  }
  const n = out.changed.length + out.removed.length;
  editor().showToast(n ? t.n(n, 'Published {count} change(s) as {name}. Files that link it can accept them now.', 'Published {count} change(s) as {name}. Files that link it can accept them now.', { name: out.info.name }) : t('{name} is up to date.', { name: out.info.name }));
}

/** A component kit, as the server's registry lists it. See the server's kits/. */
export interface KitInfo {
  id: string;
  name: string;
  description: string;
  platform: 'web' | 'android' | 'ios-like';
  library: { name: string; package: string; license: string; url: string };
  design?: { name: string; license: string; url: string };
  components: { name: string; group: string }[];
  tokenValues: KitTokenValue[];
}

export const kitApi = {
  list: () => json<KitInfo[]>('/api/kits'),
};

/**
 * Uses a kit here: the server makes its library file once per device; linking it and writing its tokens with a
 * dark mode is one transaction of this editor, so one Ctrl+Z takes the kit back out.
 */
export async function useKitHere(kit: KitInfo): Promise<void> {
  try {
    const res = await fetch(`/api/kits/${encodeURIComponent(kit.id)}/library`, { method: 'POST' });
    const body = await res.json().catch(() => ({})) as { fileId?: string; error?: string };
    if (!res.ok || !body.fileId) throw new Error(body.error ?? t('Making the {name} library failed with {status}.', { name: kit.name, status: res.status }));
    const s = session();
    if (body.fileId === s.fileId) throw new Error(t('This is the kit\'s own file. Use the kit from another file.'));
    const { summary, published } = await libraryApi.get(body.fileId);
    s.tx(() => {
      if (!libraryLinks(s.doc).some((l) => l.id === summary.id)) linkLibrary(s.doc, { id: summary.id, name: summary.name, kind: summary.kind }, published);
      writeKitTokens(s.doc, kit.tokenValues);
    });
    editor().showToast(t('{name} is linked, with its tokens and dark mode. Its components are in Assets.', { name: kit.name }));
  } catch (err) {
    editor().showToast((err as Error).message);
  }
}
