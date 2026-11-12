/**
 * WebMCP: Bogen's MCP tools for an agent that runs in the browser, such as one built into it.
 *
 * Written against the WebMCP Draft Community Group Report of 2 November 2026
 * (https://webmachinelearning.github.io/webmcp/, commit 6cd745a): `document.modelContext.registerTool(tool,
 * { signal })`, where aborting the signal unregisters the tool, and `execute(input, { signal })`. The earlier
 * drafts' `navigator.modelContext`, with `unregisterTool(name)` or an object with `unregister()` back from
 * `registerTool`, and `agent.requestUserInteraction` on `execute`, work as well.
 *
 * Every tool is the MCP server's own, reached through `/mcp` from this page with the person's own sign-in:
 * the same list, the same schemas, the same checks on the server (critique scope, brand rules, locked layers,
 * the origin rule), undo per agent under the name `webmcp`. Tools the server marks destructive or open world
 * ask the person in a dialog of the browser before every call; a page cannot click those.
 */
import { t } from '../i18n/store.ts';

/** The MCP server's description of a tool, as `tools/list` gives it. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface CallResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** A tool as WebMCP takes it. */
export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  outputSchema?: object;
  execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal; requestUserInteraction?: <T>(cb: () => Promise<T> | T) => Promise<T> }) => Promise<unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean; consequentialHint?: boolean };
}

/** What the drafts have in common. */
export interface ModelContextLike {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
}

export const WEBMCP_AGENT = 'webmcp';

/** The page's model context, under the current draft's name or the older one, or null without WebMCP. */
export function findModelContext(doc: unknown = typeof document === 'undefined' ? undefined : document, nav: unknown = typeof navigator === 'undefined' ? undefined : navigator): ModelContextLike | null {
  for (const holder of [doc, nav]) {
    const mc = (holder as { modelContext?: unknown } | undefined)?.modelContext as ModelContextLike | undefined;
    if (mc && typeof mc.registerTool === 'function') return mc;
  }
  return null;
}

/** Whether a call of this tool waits for the person's yes: it removes something, or reaches past Bogen's files. */
export function needsConsent(tool: McpTool): boolean {
  return Boolean(tool.annotations?.destructiveHint || tool.annotations?.openWorldHint);
}

/** The words the person reads before saying yes, with the arguments cut short. */
export function consentText(tool: McpTool, input: Record<string, unknown>): string {
  let args = JSON.stringify(input);
  if (args.length > 400) args = `${args.slice(0, 400)}...`;
  return tool.annotations?.destructiveHint
    ? t('An agent in this browser wants to run the Bogen tool {tool}. It removes or replaces something.\n\nArguments: {args}\n\nAllow it this once?', { tool: tool.name, args })
    : t('An agent in this browser wants to run the Bogen tool {tool}. It reaches past this file: the network, a folder or program on this computer, or another person.\n\nArguments: {args}\n\nAllow it this once?', { tool: tool.name, args });
}

/** The WebMCP tool for one MCP tool. */
export function toModelContextTool(tool: McpTool, call: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<CallResult>, confirm: (text: string) => boolean | Promise<boolean>): ModelContextTool {
  const consent = needsConsent(tool);
  const title = tool.title ?? tool.annotations?.title;
  return {
    name: tool.name,
    ...(title ? { title } : {}),
    description: tool.description || tool.name,
    // The draft takes JSON Schema as MCP gives it. Without one, a tool takes an empty object.
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: { readOnlyHint: Boolean(tool.annotations?.readOnlyHint), consequentialHint: consent, untrustedContentHint: false },
    execute: async (input, options) => {
      const args = input && typeof input === 'object' ? input : {};
      if (consent) {
        const ask = () => confirm(consentText(tool, args));
        // Older drafts let the page ask through the agent; the current one leaves the asking to the page.
        const yes = options?.requestUserInteraction ? await options.requestUserInteraction(ask) : await ask();
        if (!yes) return { isError: true, content: [{ type: 'text', text: `The person declined ${tool.name}. Do not call it again unless they ask you to.` }] };
      }
      const result = await call(tool.name, args, options?.signal);
      // With an output schema, the structured result is what the schema describes.
      if (tool.outputSchema && !result.isError && result.structuredContent !== undefined) return result.structuredContent;
      return result;
    },
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A small MCP client over Streamable HTTP with JSON answers, which is how `/mcp` answers. */
export class McpHttpClient {
  private sessionId: string | null = null;
  private protocol = '2025-06-18';
  private next = 1;
  private opening: Promise<void> | null = null;

  constructor(private readonly url: string, private readonly headers: Record<string, string>, private readonly fetcher: Fetch = (i, init) => fetch(i, init)) {}

  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = this.protocol;
    }
    return this.fetcher(this.url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', ...(signal ? { signal } : {}) });
  }

  private async open(): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', id: this.next++, method: 'initialize', params: { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: WEBMCP_AGENT, version: '1' } } });
    const answer = await this.answer(res);
    this.sessionId = res.headers.get('mcp-session-id');
    const version = (answer as { protocolVersion?: string }).protocolVersion;
    if (version) this.protocol = version;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private async answer(res: Response): Promise<unknown> {
    const text = await res.text();
    let msg: { result?: unknown; error?: { message?: string } } = {};
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      throw new Error(`Bogen's MCP endpoint answered ${res.status} with something that is not JSON.`);
    }
    if (msg.error) throw Object.assign(new Error(msg.error.message ?? 'MCP error'), { status: res.status });
    if (!res.ok) throw Object.assign(new Error(`Bogen's MCP endpoint answered ${res.status}.`), { status: res.status });
    return msg.result;
  }

  private ensure(): Promise<void> {
    this.opening ??= this.open().catch((e: unknown) => {
      this.opening = null;
      throw e;
    });
    return this.opening;
  }

  /** One request. A session the server ended (a restart, or a day without use) is opened again once. */
  async request<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    await this.ensure();
    const send = async () => this.answer(await this.post({ jsonrpc: '2.0', id: this.next++, method, params }, signal)) as Promise<T>;
    try {
      return await send();
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      this.sessionId = null;
      this.opening = null;
      await this.ensure();
      return send();
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{ tools: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult> {
    return this.request<CallResult>('tools/call', { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const headers = { ...this.headers, 'mcp-session-id': this.sessionId, 'mcp-protocol-version': this.protocol };
    this.sessionId = null;
    this.opening = null;
    await this.fetcher(this.url, { method: 'DELETE', headers, credentials: 'same-origin' }).catch(() => {});
  }
}

export interface WebMcpOptions {
  fileId: string;
  modelContext: ModelContextLike;
  url?: string;
  fetch?: Fetch;
  confirm?: (text: string) => boolean | Promise<boolean>;
}

export interface WebMcpHandle {
  /** The names registered, once registration has finished. */
  ready: Promise<string[]>;
  stop: () => Promise<void>;
}

/** Registers every MCP tool of this server with the page's model context, for one file. */
export function startWebMcp(options: WebMcpOptions): WebMcpHandle {
  const client = new McpHttpClient(options.url ?? '/mcp', { 'x-bogen-file': options.fileId, 'x-bogen-agent': WEBMCP_AGENT }, options.fetch);
  const confirm = options.confirm ?? ((text: string) => window.confirm(text));
  const controller = new AbortController();
  const handles: { name: string; unregister?: () => unknown }[] = [];
  let stopped = false;

  const ready = (async () => {
    const tools = await client.listTools();
    for (const tool of tools) {
      if (stopped) break;
      const wrapped = toModelContextTool(tool, (name, args, signal) => client.callTool(name, args, signal), confirm);
      let back: unknown;
      try {
        back = options.modelContext.registerTool(wrapped, { signal: controller.signal });
      } catch (e) {
        // A tool of that name from somewhere else on the page: leave theirs alone.
        console.warn(`bogen: WebMCP did not take ${tool.name}: ${(e as Error).message}`);
        continue;
      }
      // The current draft resolves when registered and rejects when the signal unregisters it.
      if (back instanceof Promise) back.catch(() => {});
      const unregister = (back as { unregister?: () => unknown } | undefined)?.unregister;
      handles.push({ name: tool.name, ...(typeof unregister === 'function' ? { unregister: () => unregister.call(back) } : {}) });
    }
    return handles.map((h) => h.name);
  })();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await ready.catch(() => {});
    controller.abort();
    for (const h of handles) {
      try {
        if (h.unregister) h.unregister();
        else options.modelContext.unregisterTool?.(h.name);
      } catch { /* already gone */ }
    }
    await client.close();
  };
  return { ready, stop };
}
