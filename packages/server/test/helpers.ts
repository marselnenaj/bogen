import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BogenServer, type ServerOptions } from '../src/http/server.ts';

export interface Harness {
  server: BogenServer;
  home: string;
  base: string;
  cleanup: () => Promise<void>;
}

export async function startServer(options: Partial<ServerOptions> = {}, home = mkdtempSync(join(tmpdir(), 'bogen-test-'))): Promise<Harness> {
  const server = new BogenServer({ home, port: 0, exportDir: join(home, 'exports'), ...options });
  await server.listen();
  return {
    server, home,
    base: server.localUrl(),
    cleanup: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * For tests of the run path with stand-in CLIs, which change layers without design_verify: the design completion
 * check would fail those runs or start repair turns. It is covered with real measurement in design-quality.test.ts.
 */
export function withoutDesignReview<T extends BogenServer>(server: T): T {
  server.runs.beforeFinish = async () => ({ ok: true, message: 'Run path fixture; design review is tested separately.' });
  return server;
}

export async function connectAgent(base: string, name: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

export type ToolContent = { type: string; text?: string; data?: string; mimeType?: string }[];

/** Calls a tool, failing the test on a tool error. JSON results come back parsed. */
export async function call<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as ToolContent;
  if (result.isError) throw new Error(`${name}: ${content[0]?.text}`);
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; content: ToolContent }> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), content: result.content as ToolContent };
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for a condition.');
}

/** Decodes a PNG far enough to learn its colours, using the browser-free inflate in zlib. */
export async function pngStats(bytes: Uint8Array): Promise<{ width: number; height: number; distinctColors: number }> {
  const { inflateSync } = await import('node:zlib');
  const buf = Buffer.from(bytes);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not a PNG.');
  let offset = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const colors = new Set<string>();
  let prior = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start]!;
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = prior[i]!;
      const corner = i >= channels ? prior[i - channels]! : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[i] = (line[i]! + add) & 255;
    }
    prior = line;
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 64))) colors.add(line.subarray(x * channels, x * channels + channels).toString('hex'));
  }
  return { width, height, distinctColors: colors.size };
}

