import { checkPublishedSite, currentBranchId, languageVersions, translationStatus, type BogenDoc, type PublishCheckReport, type PublishFinding } from '@bogen/core';
import { auditA11y } from './a11y.ts';
import { checkRendered } from './brand-check.ts';
import { complianceCheck } from './compliance/run.ts';
import type { BogenServer } from './http/server.ts';
import { imageSize } from './image-raster.ts';
import { buildSite, siteRoots, type SiteFile } from './publish-export.ts';
import { HttpError, errorMessage } from './util.ts';
import { checkWidths } from './width-check.ts';

/**
 * The check before publishing (publish_check, and the gate in the Publish dialog): the site's files through
 * `checkPublishedSite`, then short summaries of the checks a person would run anyway on the same artboards: a11y_audit,
 * responsive_check and brand_check, and compliance_check when asked. Everything runs on this machine. A design not
 * yet frozen into a version is built for the check without the network: Google Fonts and pictures by address are then
 * left out of what is checked, and the report says so.
 */

export interface PublishCheckInput {
  fileId: string;
  pageId?: string;
  nodeId?: string;
  /** Check this version's files as they would be sent. Otherwise the design as it is now. */
  versionId?: string;
  /** a11y, responsive and brand summaries. On by default; they render, so they take a few seconds. */
  summaries?: boolean;
  /** Also the accessibility profile check (axe-core and more). Off by default: it is the slowest. */
  compliance?: boolean;
}

export interface CheckSummaries {
  a11y?: { issues: number; errors: number; top: string[] } | { skipped: string };
  responsive?: { ok: boolean; widths: { width: number; overflow: number; clipped_text: number }[]; boards: number } | { skipped: string };
  brand?: { brand: string; score: number; hard: number; soft: number } | { skipped: string };
  compliance?: { overall: string; failed: number; needs_person: number; summary: string } | { skipped: string };
}

export interface FullPublishCheck extends PublishCheckReport {
  checked: { version: string | null; file_id: string; page_id: string; node_id: string | null; offline_build: boolean; notes: string[] };
  summaries: CheckSummaries;
  /** One line a person reads in the dialog. */
  headline: string;
  next?: string;
}

const RESPONSIVE_WIDTHS = [1440, 768, 390];

async function filesFor(app: BogenServer, input: PublishCheckInput, doc: BogenDoc, pageId: string): Promise<{ files: SiteFile[]; notes: string[]; offline: boolean; version: string | null }> {
  if (input.versionId) {
    const files = await app.publisher.files(input.versionId).catch((e) => {
      throw e instanceof HttpError ? e : new HttpError(404, 'No such version.');
    });
    return { files: [...files].map(([path, bytes]) => ({ path, bytes, type: '' })), notes: [], offline: false, version: input.versionId };
  }
  // No fetch: the check reaches nothing outside this machine.
  const built = await buildSite(doc, { pageId, ...(input.nodeId ? { nodeId: input.nodeId } : {}) }, { storage: app.storage, renderer: app.renderer, codeBuilder: app.codeBuilder });
  return { files: built.files, notes: built.notes, offline: true, version: null };
}

async function summarize(app: BogenServer, fileId: string, doc: BogenDoc, pageId: string, roots: string[], compliance: boolean): Promise<CheckSummaries> {
  const out: CheckSummaries = {};
  try {
    let issues = 0;
    let errors = 0;
    const top: string[] = [];
    for (const root of roots) {
      const report = await auditA11y(doc, app.renderer, { nodeId: root });
      for (const layer of report.layers) for (const issue of layer.issues) {
        issues++;
        if (issue.severity === 'error') errors++;
        if (top.length < 3) top.push(`${issue.message} (${layer.layer || issue.node_id})`);
      }
    }
    out.a11y = { issues, errors, top };
  } catch (e) {
    out.a11y = { skipped: errorMessage(e) };
  }
  try {
    const boards = roots.filter((r) => doc.getNode(r)?.artboard);
    const widths = new Map<number, { width: number; overflow: number; clipped_text: number }>();
    for (const root of boards) {
      const { report } = await checkWidths(doc, app.renderer, root, RESPONSIVE_WIDTHS);
      for (const w of report.widths) {
        const row = widths.get(w.width) ?? { width: w.width, overflow: 0, clipped_text: 0 };
        row.overflow += w.overflow.length + (w.content_wider_by > 1 && !w.overflow.length ? 1 : 0);
        row.clipped_text += w.clipped_text.length;
        widths.set(w.width, row);
      }
    }
    const rows = [...widths.values()];
    out.responsive = boards.length ? { ok: rows.every((r) => !r.overflow && !r.clipped_text), widths: rows, boards: boards.length } : { skipped: 'No artboard to lay out at other widths.' };
  } catch (e) {
    out.responsive = { skipped: errorMessage(e) };
  }
  try {
    const room = await app.rooms.get(fileId);
    const found = await app.brands.forRoom(room);
    if (!found?.data) out.brand = { skipped: 'The file links no brand.' };
    else {
      let score = 0;
      let hard = 0;
      let soft = 0;
      for (const root of roots) {
        const report = await checkRendered(doc, found.data, app.renderer, { nodeId: root });
        score += report.score.value;
        hard += report.counts.hard;
        soft += report.counts.soft;
      }
      out.brand = { brand: found.data.fields.name, score: Math.round(score / Math.max(1, roots.length)), hard, soft };
    }
  } catch (e) {
    out.brand = { skipped: errorMessage(e) };
  }
  if (compliance) {
    try {
      const report = await complianceCheck(doc, app.renderer, { pageId, ...(roots.length === 1 ? { nodeId: roots[0]! } : {}) }, 'en-301-549');
      out.compliance = { overall: report.score.overall, failed: report.score.counts.failed, needs_person: report.score.counts.needs_person, summary: report.score.summary };
    } catch (e) {
      out.compliance = { skipped: errorMessage(e) };
    }
  }
  return out;
}

function headline(report: PublishCheckReport): string {
  const { errors, warnings } = report.counts;
  if (!errors && !warnings) return 'Nothing to fix before publishing.';
  const parts = [errors ? `${errors} ${errors === 1 ? 'problem' : 'problems'}` : '', warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''].filter(Boolean);
  return `${parts.join(', ')}. Publishing works anyway; problems are things that are broken on the published site.`;
}

/** Runs the whole check. Never changes the file and never reaches the network. */
export async function runPublishCheck(app: BogenServer, input: PublishCheckInput): Promise<FullPublishCheck> {
  let { fileId, pageId, nodeId } = input;
  if (input.versionId) {
    const site = app.publisher.sites().find((s) => s.versions.some((v) => v.id === input.versionId));
    if (!site) throw new HttpError(404, 'No such version.');
    fileId = site.fileId;
    pageId = site.pageId;
    nodeId = site.nodeId;
  }
  app.requireFile(fileId);
  const room = await app.rooms.get(fileId);
  const doc = room.doc;
  const page = pageId ?? (nodeId ? doc.pageOf(nodeId) : undefined) ?? doc.getPages()[0]?.id;
  if (!page) throw new HttpError(400, 'That page or layer does not exist.');
  let roots: string[];
  try {
    roots = siteRoots(doc, { pageId: page, ...(nodeId ? { nodeId } : {}) });
  } catch (e) {
    if (!input.versionId) throw new HttpError(400, errorMessage(e));
    roots = [];
  }
  const { files, notes, offline, version } = await filesFor(app, { ...input, fileId, pageId: page, ...(nodeId ? { nodeId } : {}) }, doc, page);
  const report = checkPublishedSite(files, { imageSize });
  const findings: PublishFinding[] = [...report.findings];
  if (offline && notes.some((n) => /could not be made part of the site/.test(n))) {
    findings.push({ level: 'note', check: 'offline', message: 'Checked without the network: fonts from Google Fonts and pictures by web address are not part of this check. A version made in the Publish dialog has them.' });
  }
  // A language version: hidden ones are not meant to go out, and untranslated text shows the original's words.
  const lang = languageVersions(doc).find((v) => v.branch.id === currentBranchId(doc));
  if (lang && !input.versionId) {
    if (lang.status === 'hidden') findings.push({ level: 'warning', check: 'translation', message: `This is the ${lang.name} version, which is set to hidden.`, fix: 'Publish another version, or include the language (translation_rules_set).' });
    else if (lang.status === 'include') {
      const needed = translationStatus(doc, lang.branch.id).needed.length;
      if (needed) findings.push({ level: 'warning', check: 'translation', message: `${needed} ${needed === 1 ? 'text of this version is' : 'texts of this version are'} not translated into ${lang.name} yet and show the original's words.`, fix: `translation_status language "${lang.tag}", then translation_apply.` });
    }
  }
  const order = { error: 0, warning: 1, note: 2 } as const;
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const counts = { errors: 0, warnings: 0, notes: 0 };
  for (const f of findings) counts[f.level === 'error' ? 'errors' : f.level === 'warning' ? 'warnings' : 'notes']++;
  const summaries = input.summaries === false || !roots.length ? {} : await summarize(app, fileId, doc, page, roots, Boolean(input.compliance));
  const full: FullPublishCheck = {
    ...report, findings, counts, ok: counts.errors === 0,
    checked: { version, file_id: fileId, page_id: page, node_id: nodeId ?? null, offline_build: offline, notes },
    summaries, headline: headline({ ...report, counts }),
  };
  if (counts.errors || counts.warnings) full.next = 'Fix what you can with web_page_set (title, description, lang, canonical, og_image, favicon), layer_attrs (ids and image sizes) and asset_upload, then run publish_check again. The person decides whether to publish anyway.';
  return full;
}
