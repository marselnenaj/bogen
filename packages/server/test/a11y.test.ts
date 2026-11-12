import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, connectAgent, startServer, type Harness } from './helpers.ts';

/** The accessibility audit, through MCP as an agent runs it, on a page with one of each problem. */
describe('a11y_audit', () => {
  let h: Harness;
  let agent: Client;
  let file: string;
  let board: string;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    h = await startServer();
    agent = await connectAgent(h.base, 'auditor');
    file = (await call(agent, 'file_create', { name: 'Audit' })).id;
    board = (await call(agent, 'artboard_create', { file_id: file, name: 'Page', width: 1200, background: '#ffffff' })).id;
    const written = await call(agent, 'html_write', { file_id: file, target_id: board, html: `
      <nav data-name="Top nav" style="display:flex;gap:16px;padding:16px"><a href="/" style="display:block;padding:12px">Home</a><a href="/docs" style="display:block;padding:12px">Docs</a></nav>
      <h2 data-name="Intro">An intro that should be the h1</h2>
      <h4 data-name="Skipped">A heading that skips a level</h4>
      <p data-name="Body" style="font-size:16px">Some words about the page, enough to be a page with content in it.</p>
      <p data-name="Body 2" style="font-size:16px">More words, so that it reads like a page.</p>
      <a data-name="Vague" href="/pricing" style="display:inline-block;padding:12px">Click here</a>
      <button data-name="Icon button" style="width:40px;height:40px"><svg data-name="Icon: search" viewBox="0 0 24 24" width="20" height="20"><circle cx="11" cy="11" r="7" fill="none" stroke="#111" stroke-width="2"/></svg></button>
      <button data-name="Tiny" style="width:16px;height:16px;padding:0;font-size:10px">x</button>
      <button data-name="No ring" style="padding:12px 20px;outline:none;background:#111111;color:#ffffff">Save</button>
      <input data-name="Email" placeholder="Your email" style="padding:12px">
      <img data-name="Photo" src="" style="width:200px;height:120px">
      <img data-name="Named file" alt="IMG_2041.jpg" style="width:200px;height:120px">
      <img data-name="Prefixed" alt="Image of a red bicycle by a wall" style="width:200px;height:120px">
      <div data-name="Spinner" style="width:40px;height:40px;transition:transform 300ms ease">Spinning</div>
      <nav data-name="Footer nav" style="display:flex;gap:16px;padding:16px"><a href="/legal" style="display:block;padding:12px">Legal</a></nav>` });
    const { doc } = await h.server.rooms.get(file);
    for (const n of doc.descendants(board)) id[n.name] = n.id;
    id.Page = board;
    // A board drawn as a plain frame, as html_write and paste make them: artboard_create makes a main.
    doc.updateFields(board, { tag: 'div' });
    expect(written.ids.length).toBeGreaterThan(5);
  }, 60_000);
  afterAll(async () => {
    await agent.close();
    await h.cleanup();
  });

  const issuesOf = (report: any, name: string) => report.layers.find((l: any) => l.node_id === id[name])?.issues ?? [];

  it('reports each problem per layer, with its success criterion and a fix', async () => {
    const report = await call(agent, 'a11y_audit', { file_id: file, node_id: board });
    expect(report.ok).toBe(false);
    expect(report.checked.boards).toBe(1);
    // Headings: no h1, and h4 after h2.
    expect(issuesOf(report, 'Intro')[0]).toMatchObject({ rule: 'heading-order', wcag: '1.3.1 Info and Relationships', fix: { tag: 'h1', safe: false } });
    expect(issuesOf(report, 'Skipped')[0].message).toBe('"A heading that skips a level" is an h4 after an h2: level 3 is skipped, so a screen reader\'s outline has a gap.');
    // Landmarks: no main, and two navs without names.
    expect(issuesOf(report, 'Page').find((i: any) => i.rule === 'landmarks')).toMatchObject({ severity: 'error', fix: { safe: true, tag: 'main' } });
    expect(issuesOf(report, 'Top nav')[0]).toMatchObject({ rule: 'landmarks', severity: 'warning' });
    expect(issuesOf(report, 'Footer nav')[0]).toMatchObject({ rule: 'landmarks' });
    // Names: an icon button, and a field named only by its placeholder.
    expect(issuesOf(report, 'Icon button').find((i: any) => i.rule === 'name')).toMatchObject({ severity: 'error', wcag: '4.1.2 Name, Role, Value', fix: { attrs: { 'aria-label': 'search' } } });
    expect(issuesOf(report, 'Email').find((i: any) => i.rule === 'name')).toMatchObject({ severity: 'warning', fix: { safe: true, attrs: { 'aria-label': 'Your email' } } });
    // Link text, target size, focus, alt text and motion.
    expect(issuesOf(report, 'Vague').find((i: any) => i.rule === 'link-text').message).toContain('The link says "Click here"');
    expect(issuesOf(report, 'Tiny').find((i: any) => i.rule === 'target-size').message).toBe('This button is 16x16px, under 24x24px that people can reliably hit.');
    const ring = issuesOf(report, 'No ring').find((i: any) => i.rule === 'focus-visible');
    expect(ring).toMatchObject({ severity: 'error', wcag: '2.4.7 Focus Visible', fix: { safe: true, block: ':focus-visible', style: { outline: '2px solid #111111', outlineOffset: '2px' } } });
    expect(issuesOf(report, 'Photo').find((i: any) => i.rule === 'alt').severity).toBe('error');
    expect(issuesOf(report, 'Named file').find((i: any) => i.rule === 'alt').message).toContain('is a file name');
    expect(issuesOf(report, 'Prefixed').find((i: any) => i.rule === 'alt').fix).toEqual({ description: 'Say "A red bicycle by a wall".', safe: true, attrs: { alt: 'A red bicycle by a wall' } });
    expect(issuesOf(report, 'Spinner').find((i: any) => i.rule === 'reduced-motion').fix).toEqual({ description: 'Add a @media (prefers-reduced-motion: reduce) block that stops it. Nothing changes for anyone else.', safe: true, block: '@media (prefers-reduced-motion: reduce)', style: { transition: 'none' } });
    for (const rule of ['heading-order', 'landmarks', 'name', 'alt', 'link-text', 'target-size', 'focus-visible', 'reduced-motion']) expect(report.counts[rule]).toBeGreaterThan(0);
    // Errors first.
    expect(report.layers[0].issues[0].severity).toBe('error');
  });

  it('fix true applies only the safe fixes, as one undo step, and they hold', async () => {
    const out = await call(agent, 'a11y_audit', { file_id: file, node_id: board, fix: true });
    const fixedRules = out.fixed.map((f: any) => f.rule).sort();
    expect(fixedRules).toEqual(['alt', 'focus-visible', 'landmarks', 'name', 'reduced-motion']);
    const { doc } = await h.server.rooms.get(file);
    expect(doc.getNode(board)!.tag).toBe('main');
    expect(doc.getNode(id['No ring']!)!.rules?.[':focus-visible']).toEqual({ outline: '2px solid #111111', outlineOffset: '2px' });
    expect(doc.getNode(id.Spinner!)!.rules?.['@media (prefers-reduced-motion: reduce)']).toEqual({ transition: 'none' });
    expect(doc.getNode(id.Prefixed!)!.attrs?.alt).toBe('A red bicycle by a wall');
    expect(doc.getNode(id.Email!)!.attrs).toMatchObject({ placeholder: 'Your email', 'aria-label': 'Your email' });
    // What needs words or a look stays open.
    expect(out.counts['heading-order']).toBeGreaterThan(0);
    expect(out.counts['focus-visible']).toBe(0);
    expect(out.counts['reduced-motion']).toBe(0);
    const undo = await call(agent, 'agent_undo', { file_id: file });
    expect(undo.undone).toBe(true);
    expect(doc.getNode(board)!.tag).not.toBe('main');
    expect(doc.getNode(id.Spinner!)!.rules).toBeUndefined();
  });

  it('a focus ring that is there but faint, and motion that already stops, are judged as they are', async () => {
    await call(agent, 'layer_style', { file_id: file, node_ids: [id['No ring']!], when: ':focus-visible', style: { outline: '1px solid #f4f4f4' } });
    await call(agent, 'layer_style', { file_id: file, node_ids: [id.Spinner!], when: '@media (prefers-reduced-motion: reduce)', style: { transition: 'none' } });
    const report = await call(agent, 'a11y_audit', { file_id: file, node_id: board });
    const ring = issuesOf(report, 'No ring').filter((i: any) => i.rule === 'focus-visible');
    expect(ring.map((i: any) => i.wcag).sort()).toEqual(['1.4.11 Non-text Contrast', '2.4.13 Focus Appearance']);
    expect(ring.find((i: any) => i.wcag.startsWith('1.4.11')).fix).toMatchObject({ safe: true, block: ':focus-visible', style: { outlineColor: '#111111' } });
    expect(issuesOf(report, 'Spinner')).toEqual([]);
  });

  it('a clean page passes, and the saved check builtin:a11y runs the same audit', async () => {
    const clean = (await call(agent, 'artboard_create', { file_id: file, name: 'Clean', width: 800, background: '#ffffff' })).id;
    await call(agent, 'html_write', { file_id: file, target_id: clean, html: `
      <header style="padding:16px"><nav aria-label="Main" style="display:flex;gap:16px"><a href="/" style="display:block;padding:12px">Home</a><a href="/pricing" style="display:block;padding:12px">Pricing</a></nav></header>
      <div style="padding:16px"><h1>Plain pricing</h1><p>One plan, paid by the month.</p><h2>What it costs</h2><p>Twelve euros a month.</p><img alt="A receipt on a desk" src="" style="width:200px;height:100px"><a href="/pricing/details" style="display:inline-block;padding:12px">Read the pricing details</a></div>
      <footer style="padding:16px"><p>Copyright 2026</p></footer>` });
    const report = await call(agent, 'a11y_audit', { file_id: file, node_id: clean });
    expect(report.layers).toEqual([]);
    expect(report.ok).toBe(true);
    const run = await call(agent, 'check_run', { file_id: file, node_id: board, check_ids: ['builtin:a11y'] });
    expect(run.reports[0].findings.some((f: any) => f.rule === 'a11y:link-text')).toBe(true);
    expect(run.reports[0].ok).toBe(false);
    const list = await call(agent, 'check_list', { file_id: file });
    expect(list.builtins.map((c: any) => c.id)).toContain('builtin:a11y');
  });
});
