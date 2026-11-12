import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { agentMentions, isRunnerId, RUNNER_IDS, runnerLabel as coreRunnerLabel, type CommentAttachment, type CommentMessage, type CommentThread, type RunnerId } from '@bogen/core';
import { formatList } from '../i18n/format.ts';
import { t } from '../i18n/store.ts';

/**
 * Comment threads as conversations: who a reply goes to, what the person was writing in each one, and which have
 * news. Shared by the Comments tab on the desktop and the comment sheet on the phone. The server decides where a
 * request really goes (see `comment-runs.ts`); this only shows the same answer and sends what the person chose.
 */

export type Runner = RunnerId;
/** Where a reply goes when the person names no agent: the agent, model and effort of the thread's last request. */
export interface ReplyTarget { runner: Runner; model: string; effort: string; at: number }
export type SendTo = Runner | 'comment';
/** `default` is the CLI's own choice. */
export const CLI_DEFAULT = 'default';

/** What the person is writing in one thread, and who it goes to if they changed that for this message. */
export interface Draft { text: string; files: CommentAttachment[]; to?: SendTo; model?: string; effort?: string }

export type Route =
  | { kind: 'mention'; runners: Runner[]; model?: string; effort?: string }
  | { kind: 'agent'; runner: Runner; model?: string; effort?: string; how: 'inherited' | 'chosen' }
  | { kind: 'comment'; why: 'chosen' | 'no-agent' };

/**
 * Who a message goes to, as the composer shows it and the send uses it. A mention in the text wins; then the
 * person's choice for this message; then the thread's last target. Without any, it is a comment.
 */
export function chosenRoute(text: string, draft: Partial<Draft> | undefined, inherited: ReplyTarget | undefined): Route {
  const runners = agentMentions(text);
  const keep = (runner: Runner) => (inherited?.runner === runner ? { model: inherited.model, effort: inherited.effort } : {});
  if (runners.length) {
    const own = runners.length === 1 ? { ...keep(runners[0]!), ...(draft?.model ? { model: draft.model } : {}), ...(draft?.effort ? { effort: draft.effort } : {}) } : {};
    return { kind: 'mention', runners, ...own };
  }
  if (draft?.to === 'comment') return { kind: 'comment', why: 'chosen' };
  const runner = draft?.to ?? inherited?.runner;
  if (!runner) return { kind: 'comment', why: 'no-agent' };
  const changed = Boolean(draft?.to || draft?.model || draft?.effort);
  const model = draft?.model ?? keep(runner).model;
  const effort = draft?.effort ?? keep(runner).effort;
  return { kind: 'agent', runner, ...(model ? { model } : {}), ...(effort ? { effort } : {}), how: changed ? 'chosen' : 'inherited' };
}

/**
 * What a send adds to the request for the server, or null for a plain comment, which is written into the document
 * directly as before. An inherited target is left to the server, which keeps it; a choice is sent as made.
 */
export function sendFields(route: Route): { to?: Runner; model?: string; effort?: string } | null {
  if (route.kind === 'comment') return null;
  if (route.kind === 'mention') return { ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}) };
  if (route.how === 'inherited') return {};
  return { to: route.runner, ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Short names in the composer: "Claude" and "Codex" as before, the proper name of the others from the registry. */
export const runnerLabel = (runner: string) => (runner === 'claude' ? 'Claude' : runner === 'codex' ? 'Codex' : isRunnerId(runner) ? coreRunnerLabel(runner) : cap(runner));

/** "Claude · Opus · High", "Codex · CLI default". `models` maps ids to the names the CLI gives them. */
export function targetLabel(target: { runner: string; model?: string; effort?: string } | undefined, models: Record<string, string> = {}): string {
  if (!target) return t('Comment only');
  const model = !target.model || target.model === CLI_DEFAULT ? t('CLI default') : models[target.model] ?? cap(target.model);
  const effort = target.effort && target.effort !== CLI_DEFAULT ? ` · ${cap(target.effort)}` : '';
  return `${runnerLabel(target.runner)} · ${model}${effort}`;
}

/** What the composer says about where this message goes. */
export function routeLabel(route: Route, models: Record<string, string> = {}): string {
  if (route.kind === 'comment') return route.why === 'chosen' ? t('Comment only: no agent runs for this message.') : t('Comment: no agent was asked in this conversation yet. Choose one, or mention @claude or @codex.');
  if (route.kind === 'mention') {
    if (route.runners.length > 1) return t('Asks {agents}, as mentioned.', { agents: formatList(route.runners.map(runnerLabel)) });
    const runner = route.runners[0]!;
    if (!route.model) return t('Asks {agent} with the model set for comments, as mentioned.', { agent: runnerLabel(runner) });
    return t('Asks {target}, as mentioned.', { target: targetLabel({ runner, model: route.model, ...(route.effort ? { effort: route.effort } : {}) }, models) });
  }
  return route.how === 'inherited' ? t('Goes to {target}, like the last request here.', { target: targetLabel(route, models) }) : t('Goes to {target}, as chosen for this message.', { target: targetLabel(route, models) });
}

// Text of threads, for compact headers.

const MENTION = new RegExp(`(^|[\\s([{,;:'"])@(${RUNNER_IDS.join('|')})(?![\\w-]|\\.\\w)`, 'gi');

function plain(m: CommentMessage | undefined): string {
  if (!m) return '';
  const text = m.text.replace(/\s+/g, ' ').trim();
  if (text) return text;
  const files = m.attachments ?? [];
  if (files.some((f) => f.kind === 'audio')) return t('Voice note');
  return files.length ? (files.length === 1 ? t('Attachment') : t.n(files.length, '{count} attachment', '{count} attachments')) : '';
}

/** A conversation's name: its first words, without the agent mentions that only call someone. */
export function conversationTitle(thread: Pick<CommentThread, 'messages'>, max = 80): string {
  const first = thread.messages[0];
  const words = plain(first).replace(MENTION, '$1').replace(/\s+/g, ' ').trim() || plain(first) || t('Comment');
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

/** The newest message, for the line under the title. */
export function lastPreview(thread: Pick<CommentThread, 'messages'>, max = 120): { author: string; text: string; at: number } | null {
  const last = thread.messages.at(-1);
  if (!last) return null;
  const text = plain(last);
  return { author: last.author, text: text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text, at: last.at };
}

export type ThreadFilter = 'open' | 'resolved' | 'page' | 'all';

/**
 * The conversations a list shows: by filter and search, newest first. The open one (a pin, the queue or a
 * notification opened it) always shows, at the top and marked `outside`, when the filter or search would hide it:
 * the person's own filter stays as they set it.
 */
export function visibleThreads<T extends Pick<CommentThread, 'id' | 'messages' | 'resolved' | 'pageId'>>(threads: T[], o: { query: string; filter: ThreadFilter; pageId: string | null; active: string | null }): { thread: T; outside: boolean }[] {
  const q = o.query.trim().toLowerCase();
  const shown = threads
    .filter((t) => (o.filter === 'open' ? !t.resolved : o.filter === 'resolved' ? t.resolved : o.filter === 'page' ? t.pageId === o.pageId : true))
    .filter((t) => !q || t.messages.some((m) => m.text.toLowerCase().includes(q) || m.author.toLowerCase().includes(q)))
    .sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
  const out = shown.map((thread) => ({ thread, outside: false }));
  const active = o.active ? threads.find((t) => t.id === o.active) : undefined;
  if (active && !shown.includes(active)) out.unshift({ thread: active, outside: true });
  return out;
}

/** A long conversation shows its newest messages, with the rest one click away. */
export function visibleMessages<T>(messages: T[], showAll: boolean, keep = 6): { hidden: number; shown: T[] } {
  if (showAll || messages.length <= keep + 1) return { hidden: 0, shown: messages };
  return { hidden: messages.length - keep, shown: messages.slice(-keep) };
}

/** Whether there is news in a thread: a message from someone else since the person last looked. */
export function isUnread(thread: Pick<CommentThread, 'messages'>, me: string, seenAt: number | undefined): boolean {
  const last = thread.messages.at(-1);
  if (!last || last.author === me) return false;
  return seenAt !== undefined && last.at > seenAt;
}

// Drafts: kept per file and thread while the editor is open, through collapsing, switching and resizing.

// Each draft is replaced, never changed in place, so a draft is its own snapshot: a thread re-renders only when
// its own draft changes, not while the person types in another one.
const drafts = new Map<string, Draft>();
const draftListeners = new Map<string, Set<() => void>>();
const draftChanged = (key: string) => {
  for (const fn of draftListeners.get(key) ?? []) fn();
};

export const draftKey = (fileId: string, threadId: string) => `${fileId}\u0000${threadId}`;

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}

/** Changes a draft. One with nothing written and nothing chosen is gone. */
export function setDraft(key: string, patch: Partial<Draft>): void {
  const next: Draft = { text: '', files: [], ...drafts.get(key), ...patch };
  for (const k of ['to', 'model', 'effort'] as const) if (next[k] === undefined) delete next[k];
  const empty = !next.text.trim() && !next.files.length && !next.to && !next.model && !next.effort;
  const before = drafts.get(key);
  if (empty) {
    if (!before) return;
    drafts.delete(key);
  } else drafts.set(key, next);
  draftChanged(key);
}

export function clearDraft(key: string): void {
  if (drafts.delete(key)) draftChanged(key);
}

/** Hears about one draft. */
export function subscribeDraft(key: string, fn: () => void): () => void {
  let set = draftListeners.get(key);
  if (!set) draftListeners.set(key, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) draftListeners.delete(key);
  };
}

/** Whether something unsent was written in a thread: the header says so. */
export function hasDraftText(key: string): boolean {
  const d = drafts.get(key);
  return Boolean(d && (d.text.trim() || d.files.length));
}

export function useDraft(key: string): Draft | undefined {
  const subscribe = useCallback((fn: () => void) => subscribeDraft(key, fn), [key]);
  return useSyncExternalStore(subscribe, () => drafts.get(key));
}

// Reply targets, as the server keeps them. Fetched per file, and again when a request starts or ends.

let targets: { fileId: string; map: Record<string, ReplyTarget> } = { fileId: '', map: {} };
const targetListeners = new Set<() => void>();
const targetsChanged = () => {
  for (const fn of targetListeners) fn();
};

export function setTargets(fileId: string, map: Record<string, ReplyTarget>): void {
  targets = { fileId, map };
  targetsChanged();
}

/** What a send just told: the thread's next reply goes there. */
export function noteTarget(fileId: string, threadId: string, target: ReplyTarget): void {
  if (targets.fileId !== fileId) targets = { fileId, map: {} };
  targets = { fileId, map: { ...targets.map, [threadId]: target } };
  targetsChanged();
}

export function useTargets(fileId: string | null, load?: (fileId: string) => Promise<Record<string, ReplyTarget>>, refreshOn?: (fn: () => void) => () => void): Record<string, ReplyTarget> {
  const snapshot = useSyncExternalStore((fn) => {
    targetListeners.add(fn);
    return () => targetListeners.delete(fn);
  }, () => targets);
  useEffect(() => {
    if (!fileId || !load) return;
    let live = true;
    const fetchNow = () => void load(fileId).then((map) => { if (live) setTargets(fileId, map); }).catch(() => {});
    fetchNow();
    const off = refreshOn?.(fetchNow);
    return () => {
      live = false;
      off?.();
    };
  }, [fileId, load, refreshOn]);
  return snapshot.fileId === fileId ? snapshot.map : {};
}

// What the person has seen, per file, in this browser. Without storage there is simply no unread mark.

const SEEN_PREFIX = 'bogen.conversations.seen.';

function readSeen(fileId: string): { since: number; threads: Record<string, number> } | null {
  try {
    const raw = localStorage.getItem(SEEN_PREFIX + fileId);
    if (raw) {
      const parsed = JSON.parse(raw) as { since?: unknown; threads?: unknown };
      if (typeof parsed.since === 'number' && parsed.threads && typeof parsed.threads === 'object') return { since: parsed.since, threads: parsed.threads as Record<string, number> };
    }
    // The first visit marks everything up to now as seen, so that old threads do not all shout at once.
    const fresh = { since: Date.now(), threads: {} };
    localStorage.setItem(SEEN_PREFIX + fileId, JSON.stringify(fresh));
    return fresh;
  } catch {
    return null;
  }
}

export function seenAt(fileId: string, threadId: string): number | undefined {
  const seen = readSeen(fileId);
  return seen ? seen.threads[threadId] ?? seen.since : undefined;
}

export function markSeen(fileId: string, threadId: string, at = Date.now()): void {
  const seen = readSeen(fileId);
  if (!seen) return;
  seen.threads[threadId] = at;
  try {
    localStorage.setItem(SEEN_PREFIX + fileId, JSON.stringify(seen));
  } catch {
    // Storage full or blocked: the mark is only a convenience.
  }
}
