import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, callRaw, connectAgent, startServer, type Harness } from './helpers.ts';

const rule = { id: 'button-height', kind: 'geometry', selector: 'button', property: 'height', operator: 'min', value: 44, severity: 'error', message: 'Buttons need a 44px hit area.' };
describe('custom checks through MCP and the editor route', () => {
  let h: Harness, agent: Client, file: string, board: string, small: string;
  beforeAll(async () => {
    h = await startServer(); agent = await connectAgent(h.base, 'custom-check-author');
    file = (await call(agent, 'file_create', { name: 'Custom checks' })).id;
    board = (await call(agent, 'artboard_create', { file_id: file, name: 'Buttons', width: 600 })).id;
    const [row] = (await call(agent, 'html_write', { file_id: file, target_id: board, html: '<div><button aria-label="" style="height:20px;width:100px">Small</button><button aria-label="" style="height:48px;width:100px">Big</button><img alt="" style="width:20px;height:20px"></div>' })).ids;
    small = (await call(agent, 'layer_get', { file_id: file, node_id: row })).children[0].id;
  });
  afterAll(async () => { await agent.close(); await h.cleanup(); });
  it('lets an agent create, discover and run declarative rules also used by the editor', async () => {
    await call(agent, 'check_set', { file_id: file, definition: { id: 'touch', name: 'Touch targets', widths: [600], rules: [rule,
      { id: 'buttons', kind: 'count', selector: 'button', operator: 'equals', value: 2 },
      { id: 'label', kind: 'attribute', selector: 'button', property: 'aria-label', operator: 'equals', value: '' },
      { id: 'css', kind: 'style', selector: 'button', property: 'position', operator: 'equals', value: 'static' },
    ] } });
    const list = await call(agent, 'check_list', { file_id: file });
    expect(list.builtins.map((c: any) => c.id)).toContain('builtin:mobile');
    expect(list.checks[0].name).toBe('Touch targets');
    const out = await call(agent, 'check_run', { file_id: file, node_id: board });
    expect(out.ok).toBe(false); expect(out.reports[0].total).toBe(1);
    expect(out.reports[0].findings[0]).toMatchObject({ id: small, actual: 20, expected: 44, severity: 'error', width: 600 });
    const response = await fetch(`${h.base}/api/files/${file}/checks/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: board, check_ids: ['touch'], expected: { touch: JSON.stringify(list.checks[0]) } }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(out);
    await call(agent, 'layer_style', { file_id: file, node_ids: [small], style: { height: '44px' } });
    expect((await call(agent, 'check_run', { file_id: file, node_id: board })).ok).toBe(true);
  });
  it('extends, disables and undoes a rule without changing or auto-fixing the design', async () => {
    await call(agent, 'check_set', { file_id: file, definition: { id: 'derived', name: 'Stricter', extends: 'touch', rules: [{ ...rule, value: 60 }] } });
    expect((await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['derived'] })).ok).toBe(false);
    await call(agent, 'check_set', { file_id: file, definition: { id: 'derived', name: 'Disabled height', extends: 'touch', rules: [{ ...rule, enabled: false }] } });
    expect((await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['derived'] })).ok).toBe(true);
    await call(agent, 'agent_undo', { file_id: file });
    expect((await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['derived'] })).ok).toBe(false);
    expect((await call(agent, 'layer_get', { file_id: file, node_id: small })).style.height).toBe('44px');
    expect((await callRaw(agent, 'check_delete', { file_id: file, check_id: 'touch' })).isError).toBe(true);
    await call(agent, 'check_delete', { file_id: file, check_id: 'derived' });
    expect((await call(agent, 'check_list', { file_id: file })).checks).toHaveLength(1);
  });
  it('reports invalid selectors, missing elements and disabled checks explicitly', async () => {
    await call(agent, 'check_set', { file_id: file, definition: { id: 'bad-selector', name: 'Bad selector', widths: [600], rules: [{ ...rule, selector: '[' }] } });
    const invalid = await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['bad-selector'] });
    expect(invalid.ok).toBe(false); expect(invalid.reports[0].findings[0].message).toContain('Invalid CSS selector');
    await call(agent, 'check_set', { file_id: file, definition: { id: 'missing', name: 'Missing', widths: [600], rules: [{ ...rule, selector: '.missing' }] } });
    expect((await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['missing'] })).ok).toBe(false);
    await call(agent, 'check_set', { file_id: file, definition: { id: 'off', name: 'Off', enabled: false, rules: [rule] } });
    expect((await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['off'] })).reports[0].skipped).toBe(true);
    expect((await callRaw(agent, 'check_set', { file_id: file, definition: { id: 'code', name: 'Code', script: 'return true' } })).isError).toBe(true);
  });
  it('lets users extend the mobile check and choose their own tolerance while keeping sticky', async () => {
    const mobile = (await call(agent, 'artboard_create', { file_id: file, name: 'Mobile', width: 390 })).id;
    const [card] = (await call(agent, 'html_write', { file_id: file, target_id: mobile, html: '<section style="position:sticky;top:0;min-height:100svh">Card</section>' })).ids;
    await call(agent, 'check_set', { file_id: file, definition: { id: 'mobile', name: 'My mobile check', extends: 'builtin:mobile', tolerance: 1 } });
    const strict = await call(agent, 'check_run', { file_id: file, node_id: mobile, check_ids: ['mobile'] });
    expect(strict.reports[0].results.responsive.viewport_stability.stable).toBe(false);
    await call(agent, 'check_set', { file_id: file, definition: { id: 'mobile', name: 'My mobile check', extends: 'builtin:mobile', tolerance: 100 } });
    const tolerant = await call(agent, 'check_run', { file_id: file, node_id: mobile, check_ids: ['mobile'] });
    expect(tolerant.reports[0].results.responsive.viewport_stability.stable).toBe(true);
    expect(tolerant.ok).toBe(true);
    expect((await call(agent, 'layer_get', { file_id: file, node_id: card })).style.position).toBe('sticky');
  });
});
