import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXACT_COMMIT } from '@bogen/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

/** The experimental Exact target through MCP: code_get's format and export_file's folder. */
describe('Exact export over MCP', () => {
  let h: Harness;
  let agent: Client;
  let board: string;
  let asset: { src: string };

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'exact-agent');
    await call(agent, 'file_create', { name: 'Exact' });
    asset = await h.server.storage.putAsset(PNG, 'image/png');
    board = (await call(agent, 'artboard_create', { name: 'Ticket screen', width: 390, height: 600, background: '#ffffff' })).id;
    await call(agent, 'html_write', {
      target_id: board,
      html: `<div data-name="Body" style="display:flex;flex-direction:column;gap:12px;padding:24px">
        <h1 data-name="Title" style="font-size:28px;margin:0">Night train to Venice</h1>
        <img data-name="Map" src="${asset.src}" alt="Route map" style="width:100%;height:120px;object-fit:cover">
        <button data-name="Book" style="padding:12px;border-radius:8px;background-color:#c2410c;color:#fff;transition:opacity .2s">Book a berth</button>
      </div>`,
    });
  }, 60_000);

  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  it('code_get gives the app\'s files and what was left out, and keeps the other formats', async () => {
    const code = await call<string>(agent, 'code_get', { node_id: board, format: 'exact' });
    expect(code).toContain(`written against Exact ${EXACT_COMMIT.slice(0, 12)}`);
    expect(code).toContain('// ---- app.contract');
    expect(code).toContain('component TicketScreen');
    expect(code).toMatch(/text "Night train to Venice" testId="title"/);
    expect(code).toMatch(/image "assets\/[\w.-]+\.png" testId="map"/);
    expect(code).toMatch(/\/\/ assets\/[\w.-]+\.png from http:\/\/127\.0\.0\.1:\d+\/assets\//);
    expect(code).toContain('// ---- app.test.contract');
    expect(code).toMatch(/left out \(\d+\)[\s\S]*transition/);
    expect(await call<string>(agent, 'code_get', { node_id: board })).toContain('<div');
  });

  it('export_file writes a folder an Exact app can start from, pictures included', async () => {
    const res = await call(agent, 'export_file', { format: 'exact', node_ids: [board] });
    expect(res.exact_commit).toBe(EXACT_COMMIT);
    const folder = res.paths[0] as string;
    expect(folder).toBe(join(h.home, 'exports', 'ticket-screen'));
    for (const f of ['app.contract', 'app.ts', 'app.json', 'app.test.contract']) expect(existsSync(join(folder, f))).toBe(true);
    const contract = readFileSync(join(folder, 'app.contract'), 'utf8');
    const picture = /image "(assets\/[\w.-]+)"/.exec(contract)![1]!;
    expect(readFileSync(join(folder, picture))).toEqual(PNG);
    expect(JSON.parse(readFileSync(join(folder, 'app.json'), 'utf8')).app.id).toBe('com.example.ticketscreen');
    expect(res.apps[0].dropped.some((d: { what: string }) => d.what === 'transition')).toBe(true);
    // A second export does not replace the first.
    const again = await call(agent, 'export_file', { format: 'exact', node_ids: [board] });
    expect(again.paths[0]).toBe(`${folder}-2`);
  }, 30_000);

  it('refuses a file path for a folder export', async () => {
    const res = await callRaw(agent, 'export_file', { format: 'exact', node_ids: [board], path: join(h.home, 'exports', 'app.contract') });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('An exact export is a folder');
  });
});
