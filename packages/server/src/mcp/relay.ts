import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../util.ts';

export interface RelayOptions {
  url: string;
  token?: string;
  /** Sent with every request, such as the tool list's mode and profile. */
  headers?: Record<string, string>;
  /** Starts the server if it has gone away. */
  ensureServer: () => Promise<void>;
}

const REPLAY_ID = '__bogen_relay_init__';
const RESUBSCRIBE_ID = '__bogen_relay_subscribe__';

type WithId = JSONRPCMessage & { id?: string | number; method?: string; params?: { uri?: string }; result?: { protocolVersion?: string } };

/**
 * Connects a stdio MCP client to the server's HTTP endpoint. Survives the server restarting: on a lost
 * connection or an ended session it starts the server if needed, repeats the client's handshake, and
 * sends the failed message again. The client notices nothing.
 */
export async function runRelay(options: RelayOptions): Promise<void> {
  const stdio = new StdioServerTransport();
  let initialize: WithId | null = null;
  let handshaken = false;
  let reconnecting: Promise<void> | null = null;
  let replayDone: ((version?: string) => void) | null = null;
  // A new session on the server knows nothing of the client's subscriptions, so they are repeated.
  const subscriptions = new Set<string>();
  // The session exists once the answer to initialize has come back. A client may write its next
  // messages without waiting for that, and the server refuses them until then, so they wait here.
  let session: Promise<unknown> = Promise.resolve();
  // Sends in flight per transport. A replaced transport is closed only once it has none, since closing
  // aborts its requests, and a slow call that was going fine would come back as "aborted".
  const inFlight = new Map<StreamableHTTPClientTransport, number>();
  const retired = new Set<StreamableHTTPClientTransport>();
  const ended = new WeakSet<StreamableHTTPClientTransport>();
  let closing = false;
  const end = (transport: StreamableHTTPClientTransport) => {
    ended.add(transport);
    return transport.close().catch(() => {});
  };
  const settle = (transport: StreamableHTTPClientTransport) => {
    const left = (inFlight.get(transport) ?? 1) - 1;
    if (left > 0) return inFlight.set(transport, left);
    inFlight.delete(transport);
    if (retired.delete(transport)) void end(transport);
  };
  const send = async (message: JSONRPCMessage): Promise<void> => {
    const transport = http;
    inFlight.set(transport, (inFlight.get(transport) ?? 0) + 1);
    try {
      await transport.send(message);
    } finally {
      settle(transport);
    }
  };
  // What closing a transport does to its own requests and streams is not an error worth reporting.
  const isAbort = (e: unknown) => (e as { name?: string } | undefined)?.name === 'AbortError' || /AbortError|operation was aborted/.test(errorMessage(e));
  // A session the server no longer knows, as after it restarted: the next message starts a new one and nothing is lost.
  // Its open event stream and the message that found out both say so, and neither is news to the person.
  const isSessionGone = (e: unknown) => (e instanceof StreamableHTTPError && e.code === 404) || /\bNot Found\b|session has ended/i.test(errorMessage(e));

  const connect = async (): Promise<StreamableHTTPClientTransport> => {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.token || options.headers ? { headers: { ...options.headers, ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) } } : undefined,
    });
    transport.onmessage = (message) => {
      const m = message as WithId;
      if (m.id === REPLAY_ID) {
        replayDone?.(m.result?.protocolVersion);
        return;
      }
      if (m.id === RESUBSCRIBE_ID) return;
      if (initialize && m.id === initialize.id && m.result?.protocolVersion) {
        handshaken = true;
        transport.setProtocolVersion(m.result.protocolVersion);
      }
      void stdio.send(message);
    };
    transport.onerror = (e) => {
      // A replaced transport only finishes what it had going; the session behind it is gone or going.
      if (retired.has(transport) || (isAbort(e) && (closing || ended.has(transport)))) return;
      if (handshaken && isSessionGone(e)) return;
      process.stderr.write(`bogen relay: ${errorMessage(e)}\n`);
    };
    await transport.start();
    return transport;
  };

  let http = await connect();

  const reconnect = (): Promise<void> => {
    reconnecting ??= (async () => {
      await options.ensureServer();
      const previous = http;
      http = await connect();
      if (inFlight.has(previous)) retired.add(previous);
      else void end(previous);
      if (handshaken) {
        const done = new Promise<string | undefined>((resolve) => {
          replayDone = resolve;
        });
        await send({ ...initialize!, id: REPLAY_ID } as JSONRPCMessage);
        const version = await done;
        if (version) http.setProtocolVersion(version);
        await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        for (const uri of subscriptions) await send({ jsonrpc: '2.0', id: RESUBSCRIBE_ID, method: 'resources/subscribe', params: { uri } });
      }
    })().finally(() => {
      reconnecting = null;
    });
    return reconnecting;
  };

  const isTimeout = (e: unknown) => /UND_ERR_(HEADERS|BODY)_TIMEOUT/.test(String((e as { cause?: { code?: unknown } }).cause?.code));
  const isRecoverable = (e: unknown): boolean => {
    if (e instanceof StreamableHTTPError) return e.code === 404;
    // A call that takes long is still running on the server: sending it again would do it twice.
    if (isTimeout(e)) return false;
    return /fetch failed|ECONNREFUSED|ECONNRESET|socket|terminated|other side closed/i.test(`${errorMessage(e)} ${errorMessage((e as { cause?: unknown }).cause)}`);
  };

  const failRequest = (message: WithId, e: unknown) => {
    if (message.id === undefined || !message.method || closing) return;
    const text = isTimeout(e) ? 'The Bogen server took too long to answer. The call may still finish there: check before repeating it.' : `Bogen server is not reachable: ${errorMessage(e)}`;
    void stdio.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } });
  };

  const forward = async (message: WithId): Promise<void> => {
    if (message.method === 'resources/subscribe' && message.params?.uri) subscriptions.add(message.params.uri);
    if (message.method === 'resources/unsubscribe' && message.params?.uri) subscriptions.delete(message.params.uri);
    try {
      if (message.method === 'initialize') {
        initialize = message;
        const sent = send(message);
        session = sent.catch(() => {});
        await sent;
      } else {
        await session;
        if (reconnecting) await reconnecting;
        await send(message);
      }
    } catch (first) {
      if (!isRecoverable(first)) return failRequest(message, first);
      try {
        await reconnect();
        // The replay already sent this one.
        if (message.method !== 'notifications/initialized') await send(message);
      } catch (second) {
        failRequest(message, second);
      }
    }
  };

  // Answers still on their way are delivered before the relay exits when the client closes its input.
  const pending = new Set<Promise<void>>();
  stdio.onmessage = (message) => {
    const done = forward(message as WithId);
    pending.add(done);
    void done.finally(() => pending.delete(done));
  };
  stdio.onerror = (e) => process.stderr.write(`bogen relay: ${errorMessage(e)}\n`);

  let ending = false;
  const shutdown = async (drain: boolean) => {
    if (ending) return;
    ending = true;
    while (drain && pending.size) await Promise.allSettled([...pending]);
    closing = true;
    await http.terminateSession().catch(() => {});
    await http.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown(true));
  process.stdin.on('close', () => void shutdown(true));
  process.on('SIGINT', () => void shutdown(false));
  process.on('SIGTERM', () => void shutdown(false));

  await stdio.start();
}
