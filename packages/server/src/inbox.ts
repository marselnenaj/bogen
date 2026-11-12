import { acceptProposal, discardProposal, listProposals } from '@bogen/core';
import type { BogenServer } from './http/server.ts';
import { HttpError } from './util.ts';

/**
 * What waits for the person, over recent files: open proposals, open comment threads, and agent runs that
 * finished lately. The phone shows it as its inbox. It only reads; nothing here changes a file.
 */

export type InboxItem =
  | { kind: 'proposal'; id: string; fileId: string; fileName: string; at: number; of: string; by: string; note?: string; name: string; ofName: string; pageId?: string; pageName?: string; directions: number }
  | { kind: 'comment'; id: string; fileId: string; fileName: string; at: number; text: string; author: string; lastAuthor: string; lastText: string; replies: number; nodeId?: string; pageId: string }
  | { kind: 'run'; id: string; fileId: string; fileName: string; at: number; runner: string; prompt: string; status: string; result?: string; error?: string; layers: number };

const RECENT_FILES = 12;
const FILE_DAYS = 14;
const RUN_DAYS = 3;
const LIMIT = 40;

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

export async function inbox(app: BogenServer, now = Date.now()): Promise<{ items: InboxItem[] }> {
  const files = app.storage.list()
    .filter((f) => !f.brandId && now - Number(new Date(f.updatedAt)) < FILE_DAYS * 86_400_000)
    .sort((a, b) => Number(new Date(b.updatedAt)) - Number(new Date(a.updatedAt)))
    .slice(0, RECENT_FILES);
  const items: InboxItem[] = [];
  for (const file of files) {
    const room = await app.rooms.get(file.id);
    const { doc } = room;
    const pages = new Map(doc.getPages().map((p) => [p.id, p.name]));
    const groups = new Set<string>();
    const proposals = listProposals(doc).filter((p) => p.sourceExists);
    for (const p of proposals) {
      // Directions made together are one decision.
      if (p.group && groups.has(p.group)) continue;
      if (p.group) groups.add(p.group);
      const directions = p.group ? proposals.filter((q) => q.group === p.group).length : 1;
      const ofName = String(doc.nodes.get(p.of)?.get('name') ?? '');
      items.push({ kind: 'proposal', id: p.id, fileId: file.id, fileName: file.name, at: p.at, of: p.of, by: p.by, ...(p.note ? { note: clip(p.note, 400) } : {}), name: p.name, ofName, ...(p.pageId ? { pageId: p.pageId, pageName: pages.get(p.pageId) } : {}), directions });
    }
    for (const thread of doc.getComments()) {
      const first = thread.messages[0];
      const last = thread.messages.at(-1);
      if (thread.resolved || !first || !last) continue;
      items.push({ kind: 'comment', id: thread.id, fileId: file.id, fileName: file.name, at: last.at, text: clip(first.text, 200), author: first.author, lastAuthor: last.author, lastText: clip(last.text, 200), replies: thread.messages.length - 1, ...(thread.nodeId ? { nodeId: thread.nodeId } : {}), pageId: thread.pageId });
    }
  }
  const names = new Map(app.storage.list().map((f) => [f.id, f.name]));
  for (const run of await app.history.recent(files.map((f) => f.id), 30)) {
    const ended = run.endedAt ?? 0;
    if (!ended || now - ended > RUN_DAYS * 86_400_000 || run.status === 'running') continue;
    items.push({ kind: 'run', id: run.id, fileId: run.fileId, fileName: names.get(run.fileId) ?? '', at: ended, runner: run.runner, prompt: clip(run.title ?? run.prompt, 300), status: run.status, ...(run.result ? { result: clip(run.result, 400) } : {}), ...(run.error ? { error: clip(run.error, 300) } : {}), layers: run.layers.length });
  }
  return { items: items.sort((a, b) => b.at - a.at).slice(0, LIMIT) };
}

/** Accepting or discarding is the person's call: from this machine, or from a paired phone. */
export async function decideProposal(app: BogenServer, fileId: string, proposalId: string, decision: 'accept' | 'discard', who: string): Promise<{ nodeId?: string; discarded: string[] }> {
  app.requireFile(fileId);
  const room = await app.rooms.get(fileId);
  if (!listProposals(room.doc).some((p) => p.id === proposalId)) throw new HttpError(404, 'That proposal is gone: accepted, discarded, or never there.');
  const origin = `person:${who}`;
  app.memory.refresh(fileId);
  if (decision === 'accept') {
    const result = room.doc.transact(() => acceptProposal(room.doc, proposalId), origin);
    return { nodeId: result.sourceId, discarded: result.discarded };
  }
  return { discarded: room.doc.transact(() => discardProposal(room.doc, proposalId, { group: true }), origin) };
}
