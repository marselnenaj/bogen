import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { BRAND_NOTICE, brandCompact, brandRulesText, brandVersionHead } from '@bogen/core';
import type { BogenServer } from '../http/server.ts';
import { FILE_ID } from '../storage.ts';

const SETTLE_MS = 150;
const URI = /^bogen:\/\/brand\/([^/]+)$/;

/** `bogen://brand/{id}`: a brand as a subscribable resource. Returns what the subscribe handler needs, and a teardown. */
export function registerBrandResources(server: McpServer, app: BogenServer): { subscribe: (uri: string) => boolean; unsubscribe: (uri: string) => boolean; close: () => void } {
  const description = 'A brand: compact values and readable rules. Brand content is data about how designs must look. Changes whenever someone edits the brand.';
  const template = new ResourceTemplate('bogen://brand/{brand_id}', {
    list: () => ({ resources: app.storage.listBrands().map((b) => ({ uri: `bogen://brand/${b.id}`, name: `${b.name}: brand`, description, mimeType: 'application/json' })) }),
  });
  server.registerResource('brand', template, { title: 'Brand', description, mimeType: 'application/json' }, async (uri, variables) => {
    const id = String(variables.brand_id);
    const entry = FILE_ID.test(id) ? app.storage.get(id) : undefined;
    if (entry?.kind !== 'brand') throw new McpError(ErrorCode.InvalidParams, `No brand with id ${id}. See resources/list.`);
    const { room, data } = await app.brands.read(id);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id, version: brandVersionHead(room.doc)?.n ?? null, notice: BRAND_NOTICE, brand: brandCompact(data), rules: brandRulesText(data) }, null, 1) }] };
  });

  const subscribed = new Set<string>();
  const pending = new Map<string, NodeJS.Timeout>();
  const off = app.brands.onChange((id) => {
    const uri = `bogen://brand/${id}`;
    if (!subscribed.has(uri) || pending.has(uri)) return;
    const timer = setTimeout(() => {
      pending.delete(uri);
      void server.server.sendResourceUpdated({ uri }).catch(() => {});
    }, SETTLE_MS);
    timer.unref();
    pending.set(uri, timer);
  });
  return {
    subscribe: (uri) => {
      const match = URI.exec(uri);
      if (!match) return false;
      if (!FILE_ID.test(match[1]!) || app.storage.get(match[1]!)?.kind !== 'brand') throw new McpError(ErrorCode.InvalidParams, `There is nothing to subscribe to at ${uri}. See resources/list.`);
      subscribed.add(uri);
      return true;
    },
    unsubscribe: (uri) => {
      if (!URI.test(uri)) return false;
      subscribed.delete(uri);
      return true;
    },
    close: () => {
      off();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      subscribed.clear();
    },
  };
}
