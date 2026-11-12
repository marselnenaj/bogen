import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tokensCss, type BogenDoc } from '@bogen/core';
import type { EventTopic } from '../file-events.ts';
import type { BogenServer } from '../http/server.ts';
import { FILE_ID } from '../storage.ts';
import type { Room } from '../sync.ts';
import { outline, type Session } from './kit.ts';
import { registerBrandResources } from './resources-brand.ts';

const SETTLE_MS = 150;
const LISTED_FILES = 12;
const URI = /^bogen:\/\/file\/([^/]+)\/(selection|tokens|tree|comments)$/;

const KINDS: { topic: EventTopic; title: string; mimeType: string; description: string; read: (room: Room) => string }[] = [
  {
    topic: 'selection', title: 'Selection', mimeType: 'application/json',
    description: 'What each person with this file open has selected, and the page they are on. Subscribe to follow along as they click around.',
    read: (room) => JSON.stringify({
      people: room.humans().map((h) => ({
        name: h.name, page_id: h.pageId,
        selection: h.selection.flatMap((id) => {
          const n = room.doc.getNode(id);
          return n ? [{ id, type: n.type, tag: n.tag, name: n.name, ...(n.text ? { text: n.text.slice(0, 200) } : {}) }] : [];
        }),
      })),
    }, null, 1),
  },
  {
    topic: 'tokens', title: 'Design tokens', mimeType: 'application/json',
    description: 'The tokens of the file, as a list and as CSS. Changes whenever someone edits a token.',
    read: ({ doc }) => JSON.stringify({ tokens: doc.getTokens(), css: tokensCss(doc) }, null, 1),
  },
  {
    topic: 'tree', title: 'Page tree', mimeType: 'text/plain',
    description: 'An outline of every page and its layers, in the format of layer_tree. Changes with any edit to the layers.',
    read: ({ doc }) => treeOf(doc),
  },
  {
    topic: 'comments', title: 'Comments', mimeType: 'application/json',
    description: 'All comment threads, with their messages and the layer each is pinned to.',
    read: ({ doc }) => JSON.stringify(doc.getComments().map((t) => ({ ...t, layerName: t.nodeId ? doc.getNode(t.nodeId)?.name : undefined })), null, 1),
  },
];

function treeOf(doc: BogenDoc): string {
  return doc.getPages().map((p) => {
    const roots = doc.getChildren(p.id).map((n) => n.id);
    return `Page "${p.name}" (${p.id})\n${roots.length ? outline(doc, roots, 6) : '(empty)'}`;
  }).join('\n\n');
}

/** Resources for the live state of a file, with subscriptions. Returns the teardown for this session. */
export function registerResources(server: McpServer, app: BogenServer, session: Session): () => void {
  for (const kind of KINDS) {
    const template = new ResourceTemplate(`bogen://file/{file_id}/${kind.topic}`, {
      // The session's file comes first, then what a person has open, then the most recent.
      list: () => {
        const files = app.storage.list();
        const first = new Set<string>();
        if (session.fileId) first.add(session.fileId);
        for (const room of app.rooms.loaded()) if (room.humans().length) first.add(room.id);
        for (const f of files) first.add(f.id);
        const names = new Map(files.map((f) => [f.id, f.name]));
        return {
          resources: [...first].filter((id) => names.has(id)).slice(0, LISTED_FILES).map((id) => ({
            uri: `bogen://file/${id}/${kind.topic}`, name: `${names.get(id)}: ${kind.title}`, description: kind.description, mimeType: kind.mimeType,
          })),
        };
      },
    });
    server.registerResource(kind.topic, template, { title: kind.title, description: kind.description, mimeType: kind.mimeType }, async (uri, variables) => {
      const fileId = String(variables.file_id);
      if (!FILE_ID.test(fileId) || !app.storage.get(fileId)) throw new McpError(ErrorCode.InvalidParams, `No file with id ${fileId}. See resources/list.`);
      return { contents: [{ uri: uri.href, mimeType: kind.mimeType, text: kind.read(await app.rooms.get(fileId)) }] };
    });
  }

  const subscribed = new Set<string>();
  const pending = new Map<string, NodeJS.Timeout>();
  const brandResources = registerBrandResources(server, app);
  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    if (brandResources.subscribe(request.params.uri)) return {};
    const match = URI.exec(request.params.uri);
    if (!match || !FILE_ID.test(match[1]!) || !app.storage.get(match[1]!)) throw new McpError(ErrorCode.InvalidParams, `There is nothing to subscribe to at ${request.params.uri}. See resources/list.`);
    subscribed.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    brandResources.unsubscribe(request.params.uri);
    subscribed.delete(request.params.uri);
    return {};
  });
  const offTopic = app.fileEvents.onTopic((fileId, topic) => {
    const uri = `bogen://file/${fileId}/${topic}`;
    if (!subscribed.has(uri) || pending.has(uri)) return;
    // A drag or a burst of tool calls is one update for the reader.
    const timer = setTimeout(() => {
      pending.delete(uri);
      void server.server.sendResourceUpdated({ uri }).catch(() => {});
    }, SETTLE_MS);
    timer.unref();
    pending.set(uri, timer);
  });
  return () => {
    brandResources.close();
    offTopic();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    subscribed.clear();
  };
}
