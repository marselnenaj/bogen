import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { startServer, type Harness } from './helpers.ts';

/**
 * The Claude API checks every tool's input schema against JSON Schema draft 2020-12 and refuses the whole request
 * when one fails (issue #7: an unescaped `[` in a pattern, and draft-07 tuples written as `items: [...]`).
 */
async function tools(base: string, query: string): Promise<Tool[]> {
  const client = new McpClient({ name: 'schema-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`)));
  const { tools: list } = await client.listTools();
  await client.close();
  return list;
}

function bracketInClass(pattern: string): boolean {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (!inClass && c === '[') { inClass = true; if (pattern[i + 1] === '^') i++; if (pattern[i + 1] === ']') i++; continue; }
    if (inClass && c === '[') return true;
    if (inClass && c === ']') inClass = false;
  }
  return false;
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (!node || typeof node !== 'object') return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node)) walk(v, visit);
}

describe('tool input schemas', () => {
  let h: Harness;
  beforeAll(async () => { h = await startServer(); });
  afterAll(async () => { await h.server.close(); });

  for (const mode of ['', '?tools=compact', '?tools=grouped']) {
    it(`are valid JSON Schema draft 2020-12, with patterns a strict engine accepts${mode ? ` (${mode.slice(1)})` : ''}`, async () => {
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const bad: string[] = [];
      for (const tool of await tools(h.base, mode)) {
        const { $schema: _declared, ...schema } = tool.inputSchema as Record<string, unknown>;
        if (!ajv.validateSchema(schema)) bad.push(`${tool.name}: ${ajv.errorsText(ajv.errors)}`);
        walk(tool.inputSchema, (n) => {
          // Draft 2020-12 has prefixItems; an array under items is draft-07 and is refused.
          if (Array.isArray(n.items)) bad.push(`${tool.name}: items is an array (a draft-07 tuple)`);
          // A pattern must compile as a Unicode regex and must not hold an unescaped [ inside a character class, which
          // JavaScript forgives and the API's schema check does not.
          if (typeof n.pattern === 'string') {
            try { new RegExp(n.pattern, 'u'); } catch (e) { bad.push(`${tool.name}: pattern ${n.pattern}: ${(e as Error).message}`); }
            if (bracketInClass(n.pattern)) bad.push(`${tool.name}: pattern ${n.pattern}: unescaped [ inside a character class`);
          }
        });
      }
      expect(bad).toEqual([]);
    });
  }
});
