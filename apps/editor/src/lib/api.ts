import type { RunLanguageChoice as RunLanguage } from '@bogen/core';
/** REST client for the server contract in docs/SPEC.md. */
import type { RunnerId, RecentEdit } from '@bogen/core';
import { phoneOrigin } from './phone.ts';
import { t } from '../i18n/store.ts';

export interface FileProject { type: string; platforms?: string[]; source: 'person' | 'file' | 'unknown' }
/** A theme project's compact record in the file index: its identity and its branches, never its content. */
export interface FileTheme { name: string; slug: string | null; from?: string; target: 'desktop' | 'mobile'; profile?: string; project?: string; branch: string; branchName?: string; branches: { id: string; name: string }[]; /** Brought into another theme project as a branch (the server's consolidation): a kept copy, not a project of its own. */ consolidatedInto?: { fileId: string; branchId: string; at: number; changed: boolean } }
export interface FileEntry { id: string; name: string; updatedAt: number | string; lastEdit?: RecentEdit; createdAt?: number | string; folder?: string; thumbnail?: string; project?: FileProject; theme?: FileTheme; /** Set on the client: copies brought into this theme project, kept as files. */ keptCopies?: FileEntry[] }
/**
 * An agent CLI as the server lists it. `reason` says why it cannot run here; `checked` whether the CLI itself was
 * asked yet (the newer runners are only looked up on PATH until someone picks one); `installed` that a runner Bogen
 * does not run itself is there all the same, for `bogen install`.
 */
export interface Runner { id: string; available: boolean; version?: string; reason?: string; checked?: boolean; installed?: boolean }
export interface Theme { name?: string; mode?: 'dark' | 'light'; vars: Record<string, string>; font?: string }
export interface StatusAgent { name: string; fileId: string; fileName?: string; status: 'working' | 'idle'; lastTool?: string; at?: number }
export interface PeerInfo { id: string; name: string; state: 'connected' | 'offline'; lastSyncAt: number | null; pending: number; error?: string; version?: string; versionMismatch?: boolean; here?: { fileId: string; people: { name: string; selection: number }[] }[] }
/** A newer release, when the server's daily check found one and checks are on. */
export interface UpdateNote { version: string; current: string; notes?: string; how: string }
export interface Status { version: string; port: number; files: number; agents: StatusAgent[]; peers?: PeerInfo[]; update?: UpdateNote | null }
export interface UploadedAsset { name: string; src: string; url: string }
export interface ConversationSummary { id: string; title: string; startedAt: number; updatedAt: number; turns: number; runners: string[]; running: boolean }
export interface ConversationTurn { runId: string; at: number; runner: string; message: string; reply?: string; layers: string[]; status: 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'; review?: string; nudged?: boolean }
export interface ExampleEntry { id: string; kind: string; name: string; description: string; brand: string; parts: { key: string; name: string; size: string }[]; colors: string[]; fonts: string[] }
export interface FontEntry { family: string; source: 'google' | 'local' | 'file'; /** A font made in this file. */ made?: boolean; category?: string; weights?: number[]; variable?: boolean; axes?: { tag: string; min: number; max: number }[] }

const FILES_KEY = 'bogen-phone-files';

/**
 * The file list, kept on the phone so that the home screen still shows it offline. Only on the phone
 * listener's origin; the desktop always asks.
 */
async function fileList(): Promise<FileEntry[]> {
  if (!phoneOrigin) return json<FileEntry[]>('/api/files');
  try {
    const list = await json<FileEntry[]>('/api/files');
    try { localStorage.setItem(FILES_KEY, JSON.stringify(list)); } catch { /* full: it is only a convenience */ }
    return list;
  } catch (e) {
    const kept = localStorage.getItem(FILES_KEY);
    if (kept && (e instanceof TypeError || !navigator.onLine)) return JSON.parse(kept) as FileEntry[];
    throw e;
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(t('{method} {path} failed with {status}', { method: init?.method ?? 'GET', path, status: res.status }));
  return (await res.json()) as T;
}

const body = (data: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export type ThreadRunStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';
export interface ThreadRun { threadId: string; runner: string; status: ThreadRunStatus; runId?: string; tool?: string; queueId?: string; steps?: { tool: string; at: number }[]; reason?: string }

export interface CommentTarget { runner: RunnerId; model: string; effort: string; at: number }
export interface CommentSent { threadId: string; messageId: string; started: string[]; refused?: string; target?: CommentTarget & { how: 'mention' | 'chosen' | 'inherited' } }

export interface GlyphFontBuilt { family: string; glyphs: number; kerning: number; otf: string; woff2: string; notes: string[]; glyphNotes: { name: string; notes: string[] }[]; empty: string[] }

export const api = {
  status: () => json<Status>('/api/status'),
  files: fileList,
  createFile: (name?: string) => json<{ id: string; name: string }>('/api/files', body({ name })),
  renameFile: async (id: string, name: string) => {
    const res = await fetch(`/api/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error(t('Rename failed with {status}', { status: res.status }));
  },
  deleteFile: async (id: string) => {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(t('Delete failed with {status}', { status: res.status }));
  },
  /** The welcome file, made again if it was deleted. */
  welcome: () => json<{ id: string; created: boolean }>('/api/welcome', body({})),
  examples: () => json<ExampleEntry[]>('/api/examples'),
  useExample: (id: string) => json<{ file_id: string }>(`/api/examples/${encodeURIComponent(id)}`, body({})),
  duplicateFile: (id: string) => json<{ id: string; name: string }>(`/api/files/${id}/duplicate`, { method: 'POST' }),
  folders: () => json<string[]>('/api/folders'),
  addFolder: (path: string) => json<{ path: string }>('/api/folders', body({ path })),
  renameFolder: (from: string, to: string) => json<{ path: string }>('/api/folders', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) }),
  deleteFolder: (path: string) => json<{ ok: boolean }>('/api/folders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }),
  /** What a file is a design for, as the person says it; null forgets their answer. */
  setProject: (id: string, project: { type: string; platforms?: string[] } | null) => json<{ id: string; project: FileProject | null }>(`/api/files/${id}/project`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project ?? { type: null }) }),
  moveFile: (id: string, folder: string) => json<{ id: string }>(`/api/files/${id}/folder`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) }),
  upload: async (data: Blob, type?: string): Promise<UploadedAsset> => {
    const res = await fetch('/api/assets', { method: 'POST', headers: { 'Content-Type': type || data.type || 'application/octet-stream' }, body: data });
    if (!res.ok) throw new Error(t('Upload failed with {status}', { status: res.status }));
    return (await res.json()) as UploadedAsset;
  },
  exportNodes: async (req: { fileId: string; nodeIds: string[]; format: string; scale?: number }): Promise<Blob> => {
    const res = await fetch('/api/export', body(req));
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || t('Export failed with {status}', { status: res.status }));
    return res.blob();
  },
  undoAgent: async (fileId: string, agent: string) => {
    const res = await fetch('/api/agents/undo', body({ fileId, agent }));
    if (!res.ok) throw new Error(t('Undo failed with {status}', { status: res.status }));
  },
  runners: () => json<Runner[]>('/api/runners'),
  startRun: (req: { fileId: string; pageId?: string; nodeIds: string[]; prompt: string; title?: string; runner: string; model?: string; effort?: string; review?: string; intent?: 'edit' | 'revise' | 'new_page'; conversationId?: string; device?: string; images?: string[]; language?: RunLanguage }) => json<{ runId: string }>('/api/runs', body(req)),
  /** The turns of a chat the server keeps, so that one opened again after a reload shows what was said. */
  conversation: (fileId: string, id: string) => json<{ id: string; turns: ConversationTurn[] }>(`/api/runs/conversations/${encodeURIComponent(id)}?fileId=${encodeURIComponent(fileId)}`),
  /** The chats of a file, the one talked in last first, for the chat panel's list of earlier chats. */
  conversations: (fileId: string) => json<ConversationSummary[]>(`/api/runs/conversations?fileId=${encodeURIComponent(fileId)}`),
  stopRun: async (id: string) => { await fetch(`/api/runs/${id}/stop`, { method: 'POST' }); },
  /** A comment that asks for an agent. The server writes it, and starts the agent only for a person on its own device. */
  postComment: (req: { fileId: string; text: string; author: string; threadId?: string; pageId?: string; nodeId?: string; x?: number; y?: number; attachments?: { src: string; name?: string; width?: number; height?: number }[]; to?: RunnerId | 'comment'; model?: string; effort?: string }) => json<CommentSent>('/api/comments', body(req)),
  commentRuns: (fileId: string) => json<ThreadRun[]>(`/api/comments/runs?fileId=${encodeURIComponent(fileId)}`),
  /** Where each thread's next reply goes: the agent, model and effort of its last request, as the server recorded it. */
  commentTargets: (fileId: string) => json<Record<string, CommentTarget>>(`/api/comments/targets?fileId=${encodeURIComponent(fileId)}`),
  theme: () => json<Theme | null>('/api/theme'),
  /** Builds a font made in the file. A refusal comes back with the server's reason, which the Font panel shows. */
  buildGlyphFont: async (fileId: string, fontId: string): Promise<GlyphFontBuilt> => {
    const res = await fetch(`/api/files/${encodeURIComponent(fileId)}/glyph-fonts/${encodeURIComponent(fontId)}/build`, { method: 'POST' });
    const out = (await res.json().catch(() => ({}))) as GlyphFontBuilt & { error?: string };
    if (!res.ok) throw new Error(out.error ?? t('The font could not be built.'));
    return out;
  },
  /** Not in the contract yet; callers fall back to the bundled list when this fails. */
  fonts: async (query = ''): Promise<FontEntry[]> => {
    const raw = await json<unknown>(`/api/fonts${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    return normalizeFonts(raw);
  },
};

function normalizeFonts(raw: unknown): FontEntry[] {
  const out: FontEntry[] = [];
  const push = (v: unknown, source: 'google' | 'local') => {
    if (typeof v === 'string') out.push({ family: v, source });
    else if (v && typeof v === 'object' && 'family' in v) out.push({ source, ...(v as Omit<FontEntry, 'source'>) });
  };
  if (Array.isArray(raw)) raw.forEach((v) => push(v, 'google'));
  else if (raw && typeof raw === 'object') {
    const r = raw as { google?: unknown[]; local?: unknown[] };
    r.google?.forEach((v) => push(v, 'google'));
    r.local?.forEach((v) => push(v, 'local'));
  }
  return out;
}

export function resolveAsset(src: string): string {
  return src.startsWith('bogen-asset:') ? `/assets/${src.slice('bogen-asset:'.length)}` : src;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
