import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { BogenServer } from '../http/server.ts';
import { HttpError } from '../util.ts';
import { VERSION } from '../version.ts';
import { INSTRUCTIONS } from './guide.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerAllTools } from './tools.ts';
import { releaseSession, type Session } from './kit.ts';
import { modeInstructions, parseToolMode, parseToolProfile, PROFILE_HEADER, TOOLS_HEADER } from './tool-modes.ts';

const SESSION_TTL_MS = 24 * 3600_000;
const MAX_SESSIONS = 256;

function cleanAgentName(raw: string | undefined): string {
  return (raw ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'agent';
}

interface Live {
  session: Session;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

/** Streamable HTTP at `/mcp`, with one MCP server per client session. */
export class McpGateway {
  private live = new Map<string, Live>();
  private fileList: string | null = null;

  constructor(private readonly app: BogenServer) {
    // The set of files decides what resources exist. Content changes also say `files`, so this compares.
    app.hub.tap((event) => {
      if (event.t !== 'files') return;
      const list = app.storage.list().map((f) => f.id).sort().join();
      const changed = this.fileList !== null && list !== this.fileList;
      this.fileList = list;
      if (!changed) return;
      for (const live of this.live.values()) void live.server.sendResourceListChanged();
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: () => Promise<Buffer>): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    const known = typeof sessionId === 'string' ? this.live.get(sessionId) : undefined;

    if (req.method === 'POST') {
      const raw = await body();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return this.rpcError(res, 400, -32700, 'The body is not valid JSON.');
      }
      if (known) {
        if (!this.runStillGoing(known.session)) return this.endRun(res, known);
        known.lastSeen = Date.now();
        return known.transport.handleRequest(req, res, parsed);
      }
      if (sessionId) return this.rpcError(res, 404, -32001, 'This session has ended. Start a new one.');
      if (!isInitializeRequest(parsed)) return this.rpcError(res, 400, -32000, 'Send initialize first.');
      return this.open(req, res, parsed);
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId) throw new HttpError(400, 'An Mcp-Session-Id header is required.');
      if (!known) return this.rpcError(res, 404, -32001, 'This session has ended. Start a new one.');
      if (!this.runStillGoing(known.session)) return this.endRun(res, known);
      known.lastSeen = Date.now();
      return known.transport.handleRequest(req, res);
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  private rpcError(res: ServerResponse, status: number, code: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
  }

  /** False for a session of a run that is no longer going. A session without a run is not affected. */
  private runStillGoing(session: Session): boolean {
    return !session.runId || Boolean(this.app.runs.bindingOf(session.runId));
  }

  private endRun(res: ServerResponse, live: Live): void {
    releaseSession(live.session);
    void live.server.close();
    this.rpcError(res, 403, -32003, 'This run has ended, and its tools with it.');
  }

  /**
   * Closes every session of a run that ended, and lets go of the branches it was writing on at once, before the
   * close goes through. A CLI left behind cannot reconnect under it either: see `open`.
   */
  revokeRun(runId: string): void {
    for (const live of this.live.values()) {
      if (live.session.runId !== runId) continue;
      releaseSession(live.session);
      void live.server.close();
    }
  }

  private async open(req: IncomingMessage, res: ServerResponse, initialize: unknown): Promise<void> {
    this.evict();
    this.fileList ??= this.app.storage.list().map((f) => f.id).sort().join();
    const fileHeader = req.headers['x-bogen-file'];
    const agentHeader = req.headers['x-bogen-agent'];
    const runHeader = req.headers['x-bogen-run'];
    // A session that names a run is that run's, or nothing: an id of a run that is not going now, or one for
    // another file or under another name, is refused, never opened as a session without a run.
    let runId: string | undefined;
    let runAgent: string | undefined;
    let runFile: string | undefined;
    if (runHeader !== undefined && runHeader !== '') {
      const id = typeof runHeader === 'string' ? runHeader : undefined;
      const bound = id && /^\w{1,40}$/.test(id) ? this.app.runs.bindingOf(id) : undefined;
      if (!bound) return this.rpcError(res, 403, -32003, 'That run is not going. A run\'s tools are only for the run while it goes.');
      // A header that is there must say what the run is. One left out takes the run's own (its tools find the run's file).
      const otherFile = fileHeader !== undefined && fileHeader !== bound.fileId;
      const otherName = agentHeader !== undefined && bound.agent !== undefined && agentHeader !== bound.agent;
      if (otherFile || otherName) return this.rpcError(res, 403, -32003, 'That run works on another file, or under another name.');
      runId = id;
      runAgent = bound.agent;
      runFile = bound.fileId;
    }
    // The tool list's size and profile: a header from `bogen mcp`, or ?tools=…&profile=… on the URL for a client that
    // connects over HTTP. A profile only ever takes tools away, so a client may pick it; a run's own scope still wins.
    const query = new URL(req.url ?? '/mcp', 'http://local').searchParams;
    const pick = (header: string, param: string) => {
      const h = req.headers[header];
      return (typeof h === 'string' ? h : undefined) ?? query.get(param) ?? undefined;
    };
    const { mode, warning: modeWarning } = parseToolMode(pick(TOOLS_HEADER, 'tools'));
    const { profile, warning: profileWarning } = parseToolProfile(pick(PROFILE_HEADER, 'profile'));
    for (const w of [modeWarning, profileWarning]) if (w) console.warn(`bogen: ${w}`);
    const note = modeInstructions(mode, profile);
    const server = new McpServer({ name: 'bogen', version: VERSION }, { instructions: note ? `${INSTRUCTIONS}\n\n${note}` : INSTRUCTIONS });
    const session: Session = {
      // A run's session is on the run's file, also when the CLI left the header out.
      fileId: typeof fileHeader === 'string' ? fileHeader : runFile,
      pageByFile: new Map(),
      agent: () => cleanAgentName(typeof agentHeader === 'string' ? agentHeader : runAgent ?? server.server.getClientVersion()?.name),
      ...(runId ? { runId } : {}),
    };
    // A run's tools are decided by the run, here on the server, whatever the CLI was told.
    const scope = session.runId ? this.app.runs.scopeOf(session.runId) : undefined;
    if (scope) session.scope = scope;
    if (profile === 'reviewer') session.scope = 'critique';
    registerAllTools(server, this.app, session, { mode });
    registerPrompts(server);
    const stopResources = registerResources(server, this.app, session);
    // What this server really does: its tools and prompts are fixed, and its resources change with the files.
    server.server.registerCapabilities({ tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: true, listChanged: true } });
    const entry = {} as Live;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        this.live.set(id, entry);
      },
    });
    Object.assign(entry, { session, transport, server, lastSeen: Date.now() });
    transport.onclose = () => {
      // A session that ended is no longer working on a branch of anyone's file.
      releaseSession(session);
      stopResources();
      if (transport.sessionId) this.live.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, initialize);
  }

  /** Clients must be able to come back after a long pause, so only old or excess sessions go. */
  private evict(): void {
    const now = Date.now();
    for (const live of this.live.values()) if (now - live.lastSeen > SESSION_TTL_MS) void live.server.close();
    if (this.live.size >= MAX_SESSIONS) {
      const oldest = [...this.live.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      void oldest?.server.close();
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.live.values()].map((live) => live.server.close().catch(() => {})));
    this.live.clear();
  }
}
