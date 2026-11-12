import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, '../../core/test/fixtures');

let h: Harness;
let agent: Client;
let fileId: string;

beforeAll(async () => {
  h = await startServer();
  agent = await connectAgent(h.base, 'claude');
  fileId = (await call(agent, 'file_create', { name: 'Prototype tools' })).id;
});

afterAll(async () => {
  await agent.close();
  await h.cleanup();
});

/** A fixture page in an artboard of its own, as an agent would write it. */
async function fixture(name: string, x: number): Promise<string> {
  const board = await call(agent, 'artboard_create', { name, width: 1440, x });
  await call(agent, 'html_write', { target_id: board.id, html: readFileSync(join(FIXTURES, `${name}.html`), 'utf8') });
  return board.id;
}

describe('responsive variants over MCP', () => {
  it('makes a 1440 landing page and an app screen fit 768 and 390 with media rules', async () => {
    for (const [name, x] of [['responsive-landing', 0], ['responsive-app', 3000]] as const) {
      const board = await fixture(name, x);
      // Before: the page sticks out at a phone's width.
      const before = JSON.parse((await callRaw(agent, 'responsive_check', { node_id: board, widths: [390] })).content[0]!.text!);
      expect(before.ok, `${name} should not fit 390 before`).toBe(false);
      const out = await call(agent, 'responsive_variant', { node_id: board });
      expect(out.method).toBe('rules');
      expect(out.widths.map((w: { width: number }) => w.width)).toEqual([768, 390]);
      const phone = out.check.find((r: { width: number }) => r.width === 390);
      expect(phone.overflow, `${name} at 390: ${JSON.stringify(phone.overflow)}`).toEqual([]);
      expect(phone.content_wider_by).toBe(0);
      // What responsive_check says afterwards agrees.
      const after = JSON.parse((await callRaw(agent, 'responsive_check', { node_id: board, widths: [390] })).content[0]!.text!);
      expect(after.widths[0].overflow).toEqual([]);
      // The editor's responsive section asks the same over HTTP.
      const res = await fetch(`${h.base}/api/responsive-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileId, nodeId: board, widths: [768, 390] }) });
      expect(res.status).toBe(200);
      expect((await res.json()).widths.map((w: { width: number; overflow: unknown[] }) => [w.width, w.overflow])).toEqual([[768, []], [390, []]]);
    }
  }, 60_000);

  it('makes linked artboards too, and says what it made', async () => {
    const board = await fixture('responsive-landing', 6000);
    const out = await call(agent, 'responsive_variant', { node_id: board, method: 'artboards', widths: [390] });
    expect(out.artboards).toHaveLength(1);
    expect(out.check[0]).toMatchObject({ width: 390, artboard: out.artboards[0].id });
    expect(out.check[0].overflow).toEqual([]);
    const again = await call(agent, 'responsive_variant', { node_id: board, method: 'artboards', widths: [390], check: false });
    expect(again.artboards[0]).toMatchObject({ id: out.artboards[0].id, updated: true });
    expect(again.check).toBeUndefined();
  }, 60_000);
});

describe('prototypes over MCP', () => {
  let home: string;
  let done: string;
  let button: string;
  let badge: string;
  let field: string;
  let form: string;

  beforeAll(async () => {
    await call(agent, 'page_create', { name: 'Prototype' });
    home = (await call(agent, 'artboard_create', { name: 'Home', width: 390, x: 0 })).id;
    done = (await call(agent, 'artboard_create', { name: 'Done', width: 390, x: 500 })).id;
    await call(agent, 'html_write', { target_id: home, html: '<button data-name="Add" style="padding:12px">Add</button><span data-name="Badge" style="display:inline-block">0</span><form data-name="Form" style="display:flex;gap:8px"><input data-name="Email" type="email" style="width:200px"><button type="submit">Send</button></form>' });
    await call(agent, 'html_write', { target_id: done, html: '<p data-name="Thanks">Thanks</p>' });
    const find = async (name: string): Promise<string> => (await call(agent, 'layer_find', { name, within: home })).layers[0].id;
    button = await find('Add');
    badge = await find('Badge');
    field = await find('Email');
    form = await find('Form');
  });

  it('keeps variables and interactions, and says what is wrong with them', async () => {
    await call(agent, 'variable_set', { name: 'count', type: 'number', value: 0 });
    await call(agent, 'variable_set', { name: 'email', value: '' });
    const vars = (await call(agent, 'variable_set', { name: 'open', value: false })).variables;
    expect(vars.map((v: { name: string; type: string }) => [v.name, v.type])).toEqual([['count', 'number'], ['email', 'text'], ['open', 'boolean']]);
    await call(agent, 'interaction_set', { node_id: button, interactions: [{ trigger: 'click', actions: [{ type: 'increment', variable: 'count' }] }] });
    await call(agent, 'interaction_set', { node_id: badge, show_when: { variable: 'count', op: 'gt', value: 0 }, text_from: 'count' });
    await call(agent, 'interaction_set', { node_id: field, bind: 'email' });
    await call(agent, 'interaction_set', { node_id: form, interactions: [{ trigger: 'submit', actions: [{ type: 'navigate', to: done, transition: 'slide-left' }] }] });
    const wrong = await call(agent, 'interaction_set', { node_id: badge, interactions: [{ trigger: 'click', actions: [{ type: 'set', variable: 'missing', value: 1 }] }] });
    expect(wrong.warnings.join(' ')).toContain('missing');
    await call(agent, 'interaction_set', { node_id: badge, interactions: null });
    const proto = await call(agent, 'prototype_get', {});
    expect(proto.variables).toHaveLength(3);
    expect(proto.layers.map((l: { name: string }) => l.name).sort()).toEqual(['Add', 'Badge', 'Email', 'Form']);
    expect(proto.layers.every((l: { problems?: string[] }) => !l.problems)).toBe(true);
  });

  it('exports a static page that runs on one script and asks no network', async () => {
    const out = await call(agent, 'export_file', { format: 'prototype', node_ids: [home] });
    expect(out.paths).toHaveLength(1);
    expect(out.reports[0].notes[0]).toMatch(/2 screens, 3 variables/);
    const html = readFileSync(out.paths[0], 'utf8');
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|import\(/);
    expect(html).toContain("connect-src 'none'");
    // It reaches the screen the form leads to.
    expect(html).toContain(`data-bogen-id="${done}"`);

    const requests: string[] = [];
    await h.server.renderer.withBrowser(async (browser) => {
      const page = await browser.newPage();
      try {
        // The fonts the page links come as style sheets, as in an html export; the script itself asks for nothing.
        page.on('request', (r) => { if (!['stylesheet', 'font', 'image', 'document'].includes(r.resourceType())) requests.push(`${r.resourceType()} ${r.url()}`); });
        await page.setContent(html, { waitUntil: 'load' });
        const shown = (id: string) => page.$eval(`[data-bogen-id="${id}"]`, (el) => getComputedStyle(el).display !== 'none');
        expect(await shown(badge)).toBe(false);
        await page.click(`[data-bogen-id="${button}"]`);
        await page.click(`[data-bogen-id="${button}"]`);
        expect(await shown(badge)).toBe(true);
        expect(await page.$eval(`[data-bogen-id="${badge}"]`, (el) => el.textContent)).toBe('2');
        await page.type(`[data-bogen-id="${field}"]`, 'a@b.example');
        await page.$eval(`[data-bogen-id="${form}"]`, (el) => (el as HTMLFormElement).requestSubmit());
        expect(await shown(done)).toBe(true);
        expect(await shown(home)).toBe(false);
      } finally {
        await page.close();
      }
    });
    expect(requests).toEqual([]);
    // A layer inside an artboard exports its artboard.
    const inner = await call(agent, 'export_file', { format: 'prototype', node_ids: [button] });
    expect(inner.reports[0].notes[0]).toMatch(/^2 screens/);
  }, 30_000);
});

describe('motion in code_get', () => {
  it('writes clean CSS by default and Framer Motion for React', async () => {
    await call(agent, 'keyframes_set', { name: 'rise', css: 'from { opacity: 0; translate: 0 12px } to { opacity: 1; translate: 0 0 }' });
    const board = (await call(agent, 'artboard_create', { name: 'Motion', width: 400, x: 9000 })).id;
    await call(agent, 'html_write', { target_id: board, html: '<h1 data-name="Title" style="animation: rise 600ms ease-out both">Hello</h1>' });
    const css = await call(agent, 'code_get', { node_id: board });
    expect(css).toContain('@keyframes rise');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(css).toContain('class="motion-title"');
    const framer = await call(agent, 'code_get', { node_id: board, format: 'react-inline', motion: 'framer' });
    expect(framer).toContain("import { motion, MotionConfig } from 'framer-motion';");
    expect(framer).toContain('<motion.h1');
    expect(framer).toContain('reducedMotion="user"');
    expect((await callRaw(agent, 'code_get', { node_id: board, motion: 'framer' })).isError).toBe(true);
  });
});
