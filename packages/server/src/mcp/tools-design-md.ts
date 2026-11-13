import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { brandLinkOf, type BogenDoc } from '@bogen/core';
import { z } from 'zod';
import { brandDesignMd, DESIGN_MD_FILE, DESIGN_MD_TO_BRAND_CHECK, docDesignMd, importDesignMdBrand, importDesignMdTokens, parseDesignMd, type DesignMd } from '../design-md.ts';
import { readLocalImage } from '../images.ts';
import { fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';
import { exportLocation } from './tools-design.ts';

const MAX_DESIGN_MD = 1024 * 1024;
const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);

/** The file's tokens and text styles as a DESIGN.md, with the prose of the brand it links to, or what the tokens say. */
export async function fileDesignMd(ctx: ToolContext, doc: BogenDoc, fileName: string): Promise<string> {
  const linked = brandLinkOf(doc);
  const brand = linked && ctx.app.storage.get(linked.id)?.kind === 'brand' ? (await ctx.app.brands.read(linked.id)).data : null;
  return docDesignMd(doc, fileName, brand);
}

/** Where a DESIGN.md goes: the path given (a file or a folder), or a free name in the export folder. */
async function designMdTarget(ctx: ToolContext, given: string | undefined, overwrite: boolean, hidden: boolean): Promise<string> {
  const exportRoot = ctx.app.exportDir ?? process.env.BOGEN_EXPORT_DIR ?? join(homedir(), 'Downloads', 'Bogen');
  const free = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    for (let i = 1; ; i++) {
      const path = join(dir, i === 1 ? DESIGN_MD_FILE : `DESIGN-${i}.md`);
      if (!(await stat(path).then(() => true, () => false))) return path;
    }
  };
  if (!given) return free(exportRoot);
  const location = await exportLocation(given, { exportRoot, dataDir: ctx.app.storage.home, hidden });
  if (/[/\\]$/.test(given) || (await stat(location).then((s) => s.isDirectory(), () => false))) {
    const path = join(location, DESIGN_MD_FILE);
    if (!overwrite && (await stat(path).then(() => true, () => false))) return free(location);
    await mkdir(location, { recursive: true });
    return path;
  }
  if (!/\.md$/i.test(location)) throw new Error('Nothing was exported. The path needs to end in .md, or be a folder ending in /.');
  if (!overwrite && (await stat(location).then(() => true, () => false))) throw new Error(`Nothing was exported. ${location} already exists. Pass overwrite true to replace it, or choose another name.`);
  await mkdir(dirname(location), { recursive: true });
  return location;
}

/** Writes a brand's DESIGN.md, for brand_export with format design-md. */
export async function writeBrandDesignMd(ctx: ToolContext, brandId: string, options: { path?: string; overwrite: boolean; allow_hidden: boolean }) {
  if (ctx.dryRun) throw new Error('Exporting writes a file, so it does not run in a dry run.');
  const { entry, data } = await ctx.app.brands.read(brandId);
  const text = brandDesignMd(entry.name, data);
  const path = await designMdTarget(ctx, options.path, options.overwrite, options.allow_hidden);
  await writeFile(path, text, { flag: options.overwrite ? 'w' : 'wx' });
  const lint = parseDesignMd(text).findings.filter((f) => f.severity !== 'info');
  return { path, bytes: Buffer.byteLength(text), format: 'design-md', ...(lint.length ? { lint } : {}), note: 'Only what binds is written: suggestions stay out, and draft chapters are marked as drafts.' };
}

function summary(md: DesignMd) {
  return { name: md.name ?? null, colors: Object.keys(md.colors).length, typography: Object.keys(md.typography).length, rounded: Object.keys(md.rounded).length, spacing: Object.keys(md.spacing).length, components: Object.keys(md.components).length, sections: md.sections.map((s) => s.heading) };
}

export function registerDesignMdTools(define: ToolDefiner): void {
  define('design_md_import', { description: `Read a DESIGN.md (the open format of YAML tokens up front and prose sections below) into this file's tokens, its brand, or both. Tokens: colors, rounded and spacing become tokens of their kind by name, {colors.x} becomes var(--x), typography levels become text styles, and Bogen's x-bogen key brings back theme mode values and other token kinds, so a DESIGN.md that tokens_export wrote reads back the same. One undo step. Brand: everything goes in as suggestions through the review a brand_extract goes through, never binding: colours, families, the type scale, spacing, radius, each Do and Don't as a rule, component colour pairs as allowed pairs, the positioning, and the Overview, Colors, Typography, Layout and Components prose as draft brandbook chapters where a chapter is still empty. The person confirms in the Brand panel or tells you to brand_confirm. Returns the format's lint (broken references, missing primary, component contrast under 4.5:1, section order, duplicate keys and sections) with the brand_check rule each part maps onto. dry_run reads and lints without changing anything.` }, {
    text: z.string().min(1).max(MAX_DESIGN_MD).optional().describe('The DESIGN.md itself.'),
    path: z.string().min(1).max(4096).optional().describe('Or a DESIGN.md on this computer, as an absolute path (~/ works), under the home or temp folder.'),
    into: z.enum(['tokens', 'brand', 'both']).default('tokens').describe('tokens: this file\'s tokens and text styles. brand: suggestions in the brand the file links to, or brand_id. both: the two.'),
    brand_id: z.string().optional().describe('With into brand or both: this brand instead of the linked one.'),
    text_styles: z.boolean().default(true).describe('With tokens: typography levels as text styles.'),
    dry_run: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ text, path, into, brand_id, text_styles, dry_run, file_id }, ctx) => {
    if (Boolean(text) === Boolean(path)) throw new Error('Give either text or path.');
    let source = 'DESIGN.md';
    if (path) {
      if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('path works only on a server that listens on this machine alone. Send the file as text.');
      text = (await readLocalImage(path, MAX_DESIGN_MD)).toString('utf8');
      source = `DESIGN.md:${basename(path)}`;
    }
    const md = parseDesignMd(text!);
    const errors = md.findings.filter((f) => f.severity === 'error');
    const result: Record<string, unknown> = { read: summary(md), lint: md.findings, maps_onto_brand_check: DESIGN_MD_TO_BRAND_CHECK };
    // A file the format rejects is read no further, as the format asks.
    if (errors.some((e) => e.rule === 'duplicate-key' || e.rule === 'duplicate-section' || e.rule === 'yaml' || e.rule === 'too-large')) {
      return { ...result, applied: false, next: 'The format rejects this file. Fix the errors in lint and import it again.' };
    }
    if (dry_run || ctx.dryRun) return { ...result, applied: false };
    if (into === 'tokens' || into === 'both') {
      const room = await ctx.room(file_id);
      const done = ctx.write(room, () => importDesignMdTokens(room.doc, md, { textStyles: text_styles }));
      result.tokens = done;
    }
    if (into === 'brand' || into === 'both') {
      let id = brand_id;
      if (!id) {
        const room = await ctx.room(file_id);
        id = brandLinkOf(room.doc)?.id;
      }
      if (!id) throw new Error(`${result.tokens ? 'The tokens were imported. ' : ''}The file links to no brand, so there is nowhere to put the suggestions. Pass brand_id, or into tokens.`);
      ctx.app.brands.requireBrand(id);
      const brandRoom = await ctx.app.brands.room(id);
      const done = ctx.write(brandRoom, () => importDesignMdBrand(brandRoom.doc, md, source, ctx.agent, `agent:${ctx.agent}`));
      result.brand = { brand_id: id, ...done };
      result.next = 'The brand values are suggestions. Show them to the person; they confirm them in the Brand panel, or tell you to call brand_confirm.';
    }
    return { ...result, applied: true };
  });
}
