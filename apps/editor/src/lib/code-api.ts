import { useEffect, useState } from 'react';
import type { CodePropValue } from '@bogen/core';
import { session } from '../doc/session.ts';
import { t } from '../i18n/store.ts';

/** Code components from the person's own repository: what the server found in a linked project. */

export type CodePropType = 'string' | 'number' | 'boolean' | 'enum' | 'node' | 'json';
export interface CodePropInfo { name: string; type: CodePropType; options?: string[]; default?: CodePropValue; required?: boolean; description?: string }
export interface CodeComponentInfo { file: string; name: string; display: string; import: string; props: CodePropInfo[] }
export interface LinkedProject { id: string; name: string }

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? t('The server answered {status}.', { status: res.status }));
  return body;
}

const lists = new Map<string, Promise<CodeComponentInfo[]>>();

export function codeComponents(projectId: string, fresh = false): Promise<CodeComponentInfo[]> {
  let list = fresh ? undefined : lists.get(projectId);
  if (!list) {
    list = fetch(`/api/code/${projectId}/components`).then((r) => json<{ components: CodeComponentInfo[] }>(r)).then((b) => b.components);
    list.catch(() => lists.delete(projectId));
    lists.set(projectId, list);
  }
  return list;
}

export async function linkCodeProject(dir: string, fileId: string): Promise<LinkedProject> {
  const res = await fetch('/api/code/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, fileId }) });
  return json<LinkedProject>(res);
}

export async function measureCodeComponent(projectId: string, file: string, name: string, props: Record<string, CodePropValue>): Promise<{ width: number; height: number }> {
  const res = await fetch(`/api/code/${projectId}/measure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, name, props }) });
  return json<{ width: number; height: number }>(res);
}

function readLink(): LinkedProject | null {
  const v = session().doc.meta.get('codeProject') as { id?: unknown; name?: unknown } | undefined;
  return v && typeof v.id === 'string' ? { id: v.id, name: typeof v.name === 'string' ? v.name : v.id } : null;
}

/** The project this file's code components come from, kept up to date. */
export function useLinkedProject(): LinkedProject | null {
  const [link, setLink] = useState(readLink);
  useEffect(() => {
    const meta = session().doc.meta;
    const update = () => setLink(readLink());
    meta.observe(update);
    update();
    return () => meta.unobserve(update);
  }, []);
  return link;
}

/** One component's props as the source declares them, or null while loading or if it is not found. */
export function useCodeComponent(projectId: string, file: string, name: string): CodeComponentInfo | null {
  const [info, setInfo] = useState<CodeComponentInfo | null>(null);
  useEffect(() => {
    let live = true;
    codeComponents(projectId).then((list) => { if (live) setInfo(list.find((c) => c.file === file && c.name === name) ?? null); }, () => { if (live) setInfo(null); });
    return () => { live = false; };
  }, [projectId, file, name]);
  return info;
}

// ---------------------------------------------------------------- Storybook, the repository's tokens, pull requests

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface StoryImportReport {
  page: string;
  components: { set: string; frame: string; component: string; stories: { name: string; id: string; status: 'added' | 'updated' | 'same' | 'removed' | 'kept' }[] }[];
  problems: { file: string; problem: string }[];
  changed: boolean;
}

export async function importStories(projectId: string, fileId: string): Promise<StoryImportReport> {
  return json<StoryImportReport>(await fetch(`/api/code/${projectId}/stories/import`, post({ fileId })));
}

export type TokenDiffStatus = 'same' | 'changed' | 'file' | 'repo';
export interface TokenDiffRow { name: string; kind: string; status: TokenDiffStatus; file?: string; repo?: string; source?: string; modes?: { mode: string; file?: string; repo?: string }[] }
export interface RepoTokenSource { file: string; format: 'css' | 'tailwind' | 'tailwind3' | 'dtcg'; count: number; writable: boolean }
export interface RepoTokensAnswer { sources: RepoTokenSource[]; rows: TokenDiffRow[]; unclassified: { file: string; name: string; value: string }[] }

export async function repoTokens(projectId: string, fileId: string): Promise<RepoTokensAnswer> {
  return json<RepoTokensAnswer>(await fetch(`/api/code/${projectId}/tokens?fileId=${encodeURIComponent(fileId)}`));
}

export async function pullRepoTokens(projectId: string, fileId: string, names: string[]): Promise<string[]> {
  return (await json<{ pulled: string[] }>(await fetch(`/api/code/${projectId}/tokens/pull`, post({ fileId, names })))).pulled;
}

export type DesignSource =
  | { kind: 'proposal'; nodeId: string }
  | { kind: 'versions'; from: string; to: string; nodeIds?: string[] }
  | { kind: 'selection'; nodeIds: string[]; since?: string };
export type PullStatus = 'running' | 'ready' | 'opening' | 'opened' | 'failed';
export interface ChangedFile { path: string; status: string; additions: number | null; deletions: number | null }
export interface PullDraft {
  id: string; kind: 'design' | 'tokens'; fileId: string; fileName: string; project: { id: string; name: string }; status: PullStatus;
  createdAt: number; title: string; body: string; branch: string; base: string; remote: string | null; remoteUrl: string | null;
  version: { id: string; url: string }; what: string; pictures: { before?: string; after?: string }; runner?: string; runId?: string;
  commit?: string; files: ChangedFile[]; diffTruncated?: boolean; digest?: string; url?: string; error?: string;
  tokens?: { target: string; format: string; names: string[] };
}

export const pullApi = {
  async list(fileId: string): Promise<{ drafts: PullDraft[]; gh: boolean }> {
    return json(await fetch(`/api/code/pulls?fileId=${encodeURIComponent(fileId)}`));
  },
  async get(id: string): Promise<PullDraft & { diff: string }> {
    return json(await fetch(`/api/code/pulls/${id}`));
  },
  async startDesign(body: { fileId: string; source: DesignSource; runner: string; title?: string; base?: string; docsDir?: string }): Promise<PullDraft> {
    return json(await fetch('/api/code/pulls', post(body)));
  },
  async startTokens(body: { fileId: string; names: string[]; target?: string }): Promise<PullDraft> {
    return json(await fetch('/api/code/pulls/tokens', post(body)));
  },
  async update(id: string, patch: { title?: string; body?: string }): Promise<PullDraft> {
    return json(await fetch(`/api/code/pulls/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }));
  },
  /** Pushes and opens it, with the digest of the draft the person was shown. */
  async open(id: string, digest: string): Promise<PullDraft> {
    return json(await fetch(`/api/code/pulls/${id}/open`, post({ digest })));
  },
  async discard(id: string): Promise<void> {
    await json(await fetch(`/api/code/pulls/${id}`, { method: 'DELETE' }));
  },
  picture(id: string, which: 'before' | 'after', commit: string): string {
    return `/api/code/pulls/${id}/picture/${which}?v=${commit.slice(0, 12)}`;
  },
};
