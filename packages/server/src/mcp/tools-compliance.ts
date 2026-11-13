import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PROFILE_IDS, type ProfileId } from '../compliance/criteria.ts';
import { exportReport } from '../compliance/report.ts';
import { compactReport, complianceCheck } from '../compliance/run.ts';
import { statementDraft } from '../compliance/statement.ts';
import { fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';
import { freePath } from './tools-design.ts';

const profileArg = z.enum(PROFILE_IDS as [ProfileId, ...ProfileId[]]).default('en-301-549').describe('en-301-549: chapter 9 of EN 301 549 V3.2.1, the version the Official Journal cites (WCAG 2.1 A and AA). wcag-2.2-aa or wcag-2.1-aa: the WCAG criteria alone. eaa-bafg: products and services under the European Accessibility Act and the Austrian BaFG. wzg: Austrian public bodies under the Web-Zugänglichkeits-Gesetz, with the accessibility statement and feedback mechanism.');

export function registerComplianceTools(define: ToolDefiner): void {
  define('compliance_check', { description: 'Check a page against an accessibility profile and score it, criterion by criterion: every WCAG A and AA success criterion (and EN 301 549 clause) comes back failed (with layers and fixes), passed, not applicable, or needing a person (with a short test). It renders the artboards and runs axe-core, a11y_audit, text and non-text contrast, reflow at 320 CSS px, the text spacing override, language of page and parts, and form labels, errors and autocomplete. A failure found by a check cannot be marked away; a criterion only a person can decide stays open until the person marks it in the editor (Accessibility and legal check), and marks travel with the file. The overall status never says conformant while anything failed or is open; the automated pass rate is separate. legal true adds reminders of other Austrian and EU duties a design can show (Impressum, privacy link, consent banner, order button, prices, discounts, urgency, ads and AI labels, remote Google Fonts, unknown licences), with sources. export html or pdf writes the report to the Bogen export folder. A technical aid, not legal advice or a certification.', readOnly: true }, {
    profile: profileArg,
    page_id: pageIdArg,
    node_id: z.string().optional().describe('Check this artboard alone. Leave out for every artboard of the page.'),
    legal: z.boolean().default(false).describe('Add legal reminders for websites, shops, ads and e-mails.'),
    export: z.enum(['html', 'pdf']).optional().describe('Also write the report as a file, and return its path.'),
    file_id: fileIdArg,
  }, async ({ profile, page_id, node_id, legal, export: format, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    if (node_id && !doc.getNode(node_id)) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
    const pageId = node_id ? doc.pageOf(node_id) ?? ctx.page(room, page_id) : ctx.page(room, page_id);
    if (node_id) ctx.touch([node_id]);
    const report = await complianceCheck(doc, ctx.app.renderer, { pageId, ...(node_id ? { nodeId: node_id } : {}) }, profile, { legal });
    const out = compactReport(report);
    if (format) {
      const file = await exportReport(report, ctx.app.renderer, ctx.app.storage, format);
      const dir = ctx.app.exportDir ?? process.env.BOGEN_EXPORT_DIR ?? join(homedir(), 'Downloads', 'Bogen');
      await mkdir(dir, { recursive: true });
      const path = await freePath(dir, `Accessibility check ${report.scope.page}`.replace(/[\\/:*?"<>|]+/g, ' ').trim(), file.ext);
      await writeFile(path, file.bytes, { flag: 'wx' });
      return { ...out, exported: path };
    }
    return out;
  });

  define('compliance_statement', { description: 'Draft an accessibility statement (Erklärung zur Barrierefreiheit) from a compliance check, in German, English or both, in the sections of the EU model (Implementing Decision (EU) 2018/1523): compliance status, non-accessible content with reasons, date and method, feedback and contact, and the enforcement procedure (for the WZG the complaint body of the FFG; for the BaFG the Sozialministeriumservice). Status is never better than the check allows, and what Bogen cannot know is left as a field marked [Ausfüllen: ...] or [Fill in: ...], listed in open_fields. Give organisation, website and contact when the person told you them; never invent them. A draft for the person to check and publish, not legal advice.', readOnly: true }, {
    profile: profileArg,
    page_id: pageIdArg,
    language: z.enum(['de', 'en', 'both']).default('both'),
    organisation: z.string().max(200).optional(),
    website: z.string().max(300).optional(),
    contact: z.string().max(300).optional().describe('An e-mail address or a form for feedback.'),
    law: z.enum(['wzg', 'bafg', 'none']).optional().describe('Which enforcement procedure to name. Default from the profile.'),
    file_id: fileIdArg,
  }, async ({ profile, page_id, language, organisation, website, contact, law, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const report = await complianceCheck(room.doc, ctx.app.renderer, { pageId: ctx.page(room, page_id) }, profile);
    const fields = { organisation, website, contact, ...(law ? { law } : {}) };
    const langs = language === 'both' ? (['de', 'en'] as const) : [language];
    const drafts = langs.map((l) => statementDraft(report, l, fields));
    return { status: report.score.overall, summary: report.score.summary, drafts: drafts.map((d) => ({ language: d.language, markdown: d.markdown, open_fields: d.open_fields })), note: 'Publish only after the person has checked it and filled in the marked fields.' };
  });
}
