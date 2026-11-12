import type { IncomingMessage, ServerResponse } from 'node:http';
import type { History, CommitInfo } from './history.ts';
import type { Storage } from './storage.ts';
import type { ChangeEntry, Timeline } from './timeline.ts';
import { HttpError } from './util.ts';

/**
 * Timeline and commits between devices, over the paired peer connection. Change logs are append-only
 * per device, so each side asks for what comes after the number it holds, and a third device gets a
 * log through any other. Commits are named by id and checked by hash on arrival. A device that does not
 * speak this answers 404, and the rest of sync carries on.
 */
const MAX_PAGE = 500;
const MAX_COMMIT_BYTES = 128 * 1024 * 1024;
const FILE_ID = /^[0-9a-z]{4,40}$/;

export interface TimelinePeerDeps {
  storage: Storage;
  timeline: Timeline;
  commits: History;
  /** A file got something new, so open panels can look again. */
  changed: (fileId: string) => void;
}

export interface TimelineManifest { files: Record<string, { logs: Record<string, number>; commits: string[] }> }

export class TimelineSync {
  constructor(private readonly deps: TimelinePeerDeps) {}

  async manifest(only?: string): Promise<TimelineManifest> {
    const out: TimelineManifest = { files: {} };
    const entry = only ? this.deps.storage.get(only) : undefined;
    for (const file of only ? (entry ? [entry] : []) : this.deps.storage.listAll()) {
      const logs = await this.deps.timeline.cursors(file.id);
      const commits = (await this.deps.commits.shareable(file.id)).map((c) => c.id);
      if (Object.keys(logs).length || commits.length) out.files[file.id] = { logs, commits };
    }
    return out;
  }

  /** Answers a peer's request. `parts` is what comes after `/api/peer/timeline`. */
  async serve(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], send: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
    const [fileId, what, id] = parts;
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    if (!fileId) return send(res, 200, await this.manifest(url.searchParams.get('file') ?? undefined));
    if (!FILE_ID.test(fileId) || !this.deps.storage.get(fileId)) throw new HttpError(404, 'No such file.');
    if (what === 'changes') {
      const device = url.searchParams.get('device') ?? '';
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      return send(res, 200, { entries: await this.deps.timeline.entriesAfter(fileId, device, after, MAX_PAGE) });
    }
    if (what === 'commit' && id) {
      const info = (await this.deps.commits.shareable(fileId)).find((c) => c.id === id);
      const packed = info ? await this.deps.commits.readPacked(fileId, id) : null;
      if (!info || !packed) throw new HttpError(404, 'No such commit.');
      return send(res, 200, { info, packed: packed.toString('base64') });
    }
    throw new HttpError(404, 'No such route.');
  }

  /** Fetches what this device does not have yet. `fetchBytes` is the peer link's authenticated GET. */
  async pull(fetchBytes: (path: string, limit: number) => Promise<Buffer>, only?: string): Promise<{ changes: number; commits: number }> {
    let changes = 0;
    let commits = 0;
    let manifest: TimelineManifest;
    try {
      manifest = JSON.parse((await fetchBytes(`/api/peer/timeline${only ? `?file=${encodeURIComponent(only)}` : ''}`, 32 * 1024 * 1024)).toString('utf8')) as TimelineManifest;
    } catch {
      return { changes, commits };
    }
    for (const [fileId, remote] of Object.entries(manifest.files ?? {})) {
      if (!FILE_ID.test(fileId) || !this.deps.storage.get(fileId)) continue;
      let got = 0;
      try {
        const mine = await this.deps.timeline.cursors(fileId);
        for (const [device, last] of Object.entries(remote.logs ?? {})) {
          let cursor = mine[device] ?? 0;
          while (cursor < last) {
            const page = JSON.parse((await fetchBytes(`/api/peer/timeline/${fileId}/changes?device=${encodeURIComponent(device)}&after=${cursor}`, 64 * 1024 * 1024)).toString('utf8')) as { entries: ChangeEntry[] };
            if (!page.entries?.length) break;
            got += await this.deps.timeline.receive(fileId, device, page.entries);
            const next = Math.max(...page.entries.map((e) => e.seq));
            if (next <= cursor) break;
            cursor = next;
          }
        }
        const known = new Set((await this.deps.commits.list(fileId)).map((c) => c.id));
        for (const id of remote.commits ?? []) {
          if (known.has(id)) continue;
          const answer = JSON.parse((await fetchBytes(`/api/peer/timeline/${fileId}/commit/${id}`, MAX_COMMIT_BYTES)).toString('utf8')) as { info: CommitInfo; packed: string };
          if (answer.info?.id === id && await this.deps.commits.receive(fileId, answer.info, Buffer.from(answer.packed, 'base64'))) {
            commits++;
            got++;
          }
        }
      } catch {
        // The next catch-up tries again. A file's history is not worth failing the sync for.
      }
      changes += got;
      if (got) this.deps.changed(fileId);
    }
    return { changes, commits };
  }
}
