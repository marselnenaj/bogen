/**
 * The Accessibility and legal check in a real browser against a real server from source, in a temp BOGEN_HOME: a
 * deliberately flawed checkout and the same checkout fixed, a mark a person makes, the statement draft, and the PDF.
 * Run: BOGEN_EDITOR_DIR=<built editor> npx tsx apps/editor/test/e2e/compliance.ts [screenshot folder]
 * The browser is ~/.local/bin/secure-chromium with its sandbox on (craft-harness.ts launch()).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from 'puppeteer-core';
import { FIXED, FLAWED } from '../../../../packages/server/test/compliance-pages.ts';
import { freshPage, launch, sleep, startRealServer } from './craft-harness.ts';
import { watchErrors } from './harness.ts';

const OUT = process.argv[2] ?? join(process.env.TMPDIR ?? tmpdir(), 'bogen-compliance-e2e');
mkdirSync(OUT, { recursive: true });
let passed = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++;
  else failures.push(`${name}: ${JSON.stringify(detail)?.slice(0, 300)}`);
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)?.slice(0, 300)}`}`);
};
const until = async (fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};

async function tool(agent: Client, name: string, args: Record<string, unknown>) {
  const r = await agent.callTool({ name, arguments: args });
  const text = (r.content as { text?: string }[])[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function clickText(page: Page, selector: string, text: string) {
  const ok = await page.evaluate((sel: string, want: string) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim().startsWith(want));
    el?.click();
    return Boolean(el);
  }, selector, text);
  if (!ok) throw new Error(`No ${selector} saying ${text}.`);
  await sleep(150);
}

async function runFor(page: Page, artboard: string) {
  await page.select('.compliance-head label:nth-of-type(2) select', artboard);
  await page.click('[data-testid="compliance-run"]');
  await until(async () => Boolean(await page.$('[data-testid="compliance-status"]')) && !(await page.$eval('[data-testid="compliance-run"]', (b) => (b as HTMLButtonElement).disabled)));
  return page.$eval('[data-testid="compliance-status"]', (el) => el.getAttribute('data-overall'));
}

async function main(): Promise<void> {
  const server = await startRealServer({ editorDir: process.env.BOGEN_EDITOR_DIR });
  const browser = await launch(server.port);
  const agent = new Client({ name: 'e2e', version: '1.0.0' });
  try {
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`)));
    const file = (await tool(agent, 'file_create', { name: 'Shop' })).id as string;
    const flawed = (await tool(agent, 'artboard_create', { file_id: file, name: 'Checkout, flawed', width: 1200, background: '#ffffff' })).id as string;
    await tool(agent, 'html_write', { file_id: file, target_id: flawed, html: FLAWED });
    const fixed = (await tool(agent, 'artboard_create', { file_id: file, name: 'Checkout, fixed', width: 1200, background: '#ffffff' })).id as string;
    await tool(agent, 'html_write', { file_id: file, target_id: fixed, html: FIXED });
    await tool(agent, 'layer_attrs', { file_id: file, node_id: fixed, attrs: { lang: 'de-AT' } });

    const page = await freshPage(browser);
    const errors: string[] = [];
    watchErrors(page, errors);
    await page.goto(`${server.base}/#/file/${file}`);
    await page.waitForSelector('[data-testid="canvas"]', { timeout: 30_000 });
    await sleep(500);
    await page.keyboard.down('Control');
    await page.keyboard.press('p');
    await page.keyboard.up('Control');
    await page.waitForSelector('[data-testid="palette-input"]');
    await page.keyboard.type('Accessibility and legal');
    await sleep(150);
    await page.keyboard.press('Enter');
    check('the palette opens the check', Boolean(await page.waitForSelector('[data-testid="compliance-dialog"]', { timeout: 10_000 }).catch(() => null)));

    // The flawed page fails, with layers.
    const bad = await runFor(page, flawed);
    check('the flawed page does not meet the profile', bad === 'fails', bad);
    const failedText = await page.$eval('[data-testid="compliance-main"]', (el) => el.textContent ?? '');
    for (const want of ['Contrast (Minimum)', 'Reflow', 'Text Spacing', 'Language of Page', 'Non-text Contrast']) check(`the summary lists ${want} as failed`, failedText.includes(want), failedText.slice(0, 200));
    await page.screenshot({ path: join(OUT, '1-flawed-summary.png') });

    // A person marks a criterion; it is stored in the file with their name.
    await clickText(page, '.compliance-nav > button', 'Needs a person');
    const row = '[data-testid="criterion-wcag:2.1.1"]';
    await page.waitForSelector(row);
    await page.type(`${row} input`, 'Tab through the built checkout in Firefox');
    await clickText(page, `${row} .compliance-results button`, 'Pass');
    await clickText(page, '.compliance-filter button', 'Done');
    const marked = await until(async () => /Pass · .+ · /.test(await page.$eval(row, (el) => el.textContent ?? '')), 5000);
    check('the mark shows who and when', marked);
    await page.screenshot({ path: join(OUT, '2-flawed-checklist.png') });
    const viaAgent = await tool(agent, 'compliance_check', { file_id: file, node_id: flawed, profile: 'en-301-549' });
    const kb = [...viaAgent.needs_person, ...viaAgent.failed].find((c: { key: string }) => c.key === 'wcag:2.1.1');
    check('an agent sees nothing open for 2.1.1 once the person marked it', !kb, kb);
    const stale = await page.$('.compliance-stale');
    check('the dialog says the score needs a new run after a mark', Boolean(stale));

    await clickText(page, '.compliance-nav > button', 'Legal reminders');
    const legal = await page.$eval('[data-testid="compliance-main"]', (el) => el.textContent ?? '');
    check('legal reminders name the order button and the consent banner', /Order button/.test(legal) && /Consent banner/.test(legal), legal.slice(0, 300));
    await page.screenshot({ path: join(OUT, '3-flawed-legal.png') });

    // The fixed page has no failure, and still claims nothing while a person has to test.
    await clickText(page, '.compliance-nav > button', 'Summary');
    const good = await runFor(page, fixed);
    check('the fixed page is not decided yet, with nothing failed', good === 'incomplete', good);
    const failedCount = await page.$eval('.compliance-nav > button:nth-child(2) span', (el) => el.textContent);
    check('the fixed page has no failed criterion', failedCount === '0', failedCount);
    await page.screenshot({ path: join(OUT, '4-fixed-summary.png') });

    await clickText(page, '.compliance-nav > button', 'Accessibility statement');
    await page.waitForSelector('[data-testid="compliance-statement"]', { timeout: 60_000 });
    const statement = await page.$eval('[data-testid="compliance-statement"]', (el) => el.textContent ?? '');
    check('the statement draft is in German with marked fields', statement.includes('Erklärung zur Barrierefreiheit') && statement.includes('[Ausfüllen:'), statement.slice(0, 200));
    await page.screenshot({ path: join(OUT, '5-fixed-statement.png') });

    // The report as PDF, through the same route as the Export PDF button.
    const firstPage = (await tool(agent, 'file_open', { file_id: file })).pages[0].id as string;
    const pdf = await fetch(`${server.base}/api/files/${file}/compliance/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: firstPage, nodeId: flawed, profile: 'wzg', legal: true, format: 'pdf', statement: true, language: 'de' }) });
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    writeFileSync(join(OUT, 'report-flawed.pdf'), bytes);
    check('the PDF report downloads', pdf.ok && Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-', pdf.status);
    const html = await fetch(`${server.base}/api/files/${file}/compliance/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId: firstPage, nodeId: flawed, profile: 'wzg', legal: true, format: 'html', statement: true, language: 'de' }) });
    const report = await html.text();
    writeFileSync(join(OUT, 'report-flawed.html'), report);
    check('the HTML report has the failures and the draft statement', report.includes('1.4.3 Contrast (Minimum)') && report.includes('Erklärung zur Barrierefreiheit'));
    const shot = await freshPage(browser);
    await shot.setViewport({ width: 940, height: 1400 });
    await shot.setContent(report, { waitUntil: 'load' });
    await shot.screenshot({ path: join(OUT, '6-report-flawed.png'), fullPage: false });
    await shot.close();
    check('no errors in the page', errors.length === 0, errors);
  } finally {
    console.log(`\n${passed}/${passed + failures.length} checks passed. Screenshots in ${OUT}`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    await agent.close().catch(() => {});
    await browser.close();
    await server.close();
    process.exit(failures.length ? 1 : 0);
  }
}

void main();
