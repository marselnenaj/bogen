import { existsSync, readFileSync } from 'node:fs';
import { setComplianceMark } from '@bogen/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';
import { FIXED, FLAWED } from './compliance-pages.ts';

describe('compliance_check', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let page: string;
  let flawed: string;
  let fixed: string;

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'checker');
    file = (await call(agent, 'file_create', { name: 'Shop' })).id;
    flawed = (await call(agent, 'artboard_create', { file_id: file, name: 'Checkout, flawed', width: 1200, background: '#ffffff' })).id;
    await call(agent, 'html_write', { file_id: file, target_id: flawed, html: FLAWED });
    fixed = (await call(agent, 'artboard_create', { file_id: file, name: 'Checkout, fixed', width: 1200, background: '#ffffff' })).id;
    await call(agent, 'html_write', { file_id: file, target_id: fixed, html: FIXED });
    const { doc } = await h.server.rooms.get(file);
    page = doc.pageOf(flawed)!;
    doc.updateFields(fixed, { attrs: { ...(doc.getNode(fixed)!.attrs ?? {}), lang: 'de-AT' } });
  }, 60_000);
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const keys = (list: { key: string }[]) => list.map((c) => c.key);

  it('fails the flawed page on what it shows, criterion by criterion, with layers', async () => {
    const r = await call(agent, 'compliance_check', { file_id: file, node_id: flawed, profile: 'wcag-2.2-aa', legal: true });
    expect(r.score.overall).toBe('fails');
    expect(r.engines.axe).toBe('4.14.0');
    const failed = keys(r.failed);
    for (const k of ['wcag:1.4.3', 'wcag:1.4.10', 'wcag:1.4.11', 'wcag:1.4.12', 'wcag:3.1.1', 'wcag:1.3.5', 'wcag:3.3.1', 'wcag:3.3.2']) expect(failed).toContain(k);
    const ev = (k: string) => r.failed.find((c: any) => c.key === k).evidence;
    expect(ev('wcag:1.4.3').some((e: any) => e.layer === 'Order' && /contrast/i.test(e.message))).toBe(true);
    expect(ev('wcag:1.4.10').some((e: any) => e.layer === 'Table' && e.fix === 'Replace width 900px with width:100% and a max-width.')).toBe(true);
    expect(ev('wcag:1.4.11').some((e: any) => e.layer === 'Email')).toBe(true);
    expect(ev('wcag:1.4.12').some((e: any) => e.layer === 'Fixed box')).toBe(true);
    expect(ev('wcag:1.3.5').some((e: any) => e.layer === 'Email' && /autocomplete="email"/.test(e.fix))).toBe(true);
    expect(r.score.automated.failed).toBeGreaterThan(3);
    expect(r.not_applicable.some((n: string) => n.startsWith('1.2.2'))).toBe(true);
    // Legal reminders, worded as things to look at.
    const legal = Object.fromEntries(r.legal.reminders.map((m: any) => [m.key, m]));
    expect(legal['legal:imprint'].state).toBe('look');
    expect(legal['legal:consent-reject'].state).toBe('look');
    expect(legal['legal:order-button'].layer).toBe('Order');
    expect(legal['legal:price-vat'].state).toBe('look');
    expect(legal['legal:discount'].message).toMatch(/30 days/);
    expect(legal['legal:urgency'].source).toMatch(/UWG Anhang Z 7/);
  }, 120_000);

  it('passes the fixed page on every automatic criterion, and still claims nothing while a person has to test', async () => {
    const r = await call(agent, 'compliance_check', { file_id: file, node_id: fixed, profile: 'wcag-2.2-aa', legal: true });
    expect(r.failed.map((c: any) => `${c.key}: ${c.evidence?.[0]?.layer} ${c.evidence?.[0]?.message}`)).toEqual([]);
    expect(r.score.overall).toBe('incomplete');
    expect(r.score.automated.pass_rate).toBe(100);
    expect(r.passed).toEqual(expect.arrayContaining(['1.4.3 Contrast (Minimum)', '1.4.10 Reflow', '1.4.12 Text Spacing', '3.1.1 Language of Page', '2.5.8 Target Size (Minimum)']));
    expect(r.needs_person.find((c: any) => c.key === 'wcag:2.1.1').test).toMatch(/keyboard|Tab/i);
    const legal = Object.fromEntries(r.legal.reminders.map((m: any) => [m.key, m]));
    expect(legal['legal:imprint'].state).toBe('found');
    expect(legal['legal:privacy'].state).toBe('found');
    expect(legal['legal:consent-reject'].state).toBe('found');
    expect(legal['legal:order-button'].state).toBe('found');
    expect(legal['legal:price-vat']).toBeUndefined();
  }, 120_000);

  it('counts a person\'s marks, and reaches "all criteria met" only when nothing is left open', async () => {
    const { doc } = await h.server.rooms.get(file);
    const before = await call(agent, 'compliance_check', { file_id: file, node_id: fixed, profile: 'wcag-2.2-aa' });
    for (const c of before.needs_person) setComplianceMark(doc, page, c.key, { result: 'pass', by: 'Tester', note: 'Checked in the built page' });
    const after = await call(agent, 'compliance_check', { file_id: file, node_id: fixed, profile: 'wcag-2.2-aa' });
    expect(after.needs_person).toEqual([]);
    expect(after.score.overall).toBe('all-criteria-met');
    expect(after.score.person.by).toEqual(['Tester']);
    expect(after.score.summary).toMatch(/not a certification/);
    // The flawed page keeps failing whatever is marked.
    const flawedNow = await call(agent, 'compliance_check', { file_id: file, node_id: flawed, profile: 'wcag-2.2-aa' });
    expect(flawedNow.score.overall).toBe('fails');
  }, 120_000);

  it('drafts the statement for the WZG, and exports the report as HTML and PDF', async () => {
    const s = await call(agent, 'compliance_statement', { file_id: file, page_id: page, profile: 'wzg', organisation: 'Stadt Muster' });
    expect(s.drafts.map((d: any) => d.language)).toEqual(['de', 'en']);
    expect(s.drafts[0].markdown).toContain('Beschwerdestelle der FFG');
    expect(s.drafts[0].open_fields).toContain('E-Mail-Adresse oder Formular für Rückmeldungen');
    const html = await call(agent, 'compliance_check', { file_id: file, node_id: flawed, profile: 'en-301-549', export: 'html' });
    expect(existsSync(html.exported)).toBe(true);
    const text = readFileSync(html.exported, 'utf8');
    expect(text).toContain('Accessibility check');
    expect(text).toContain('1.4.3 Contrast (Minimum)');
    expect(text).toContain('A technical aid, not legal advice');
    const pdf = await call(agent, 'compliance_check', { file_id: file, node_id: flawed, profile: 'en-301-549', export: 'pdf' });
    expect(readFileSync(pdf.exported).subarray(0, 5).toString()).toBe('%PDF-');
  }, 180_000);
});
