import { randomBytes } from 'node:crypto';
import {
  addFontFaces, BRAND_BOOK_PAGE, brandEditionFileOf, getCritiques, brandEditionParts, brandLanguages, changedEditionParts, EDITION_PART_NAMES, getFontFaces,
  languageName, PROJECT_META_KEY, readBrandEdition, setBrandEditionFile, writeBrandEdition,
  type BogenDoc, type BrandData, type BrandEditionRecord, type EditionPart, type NewNode, type RunnerId,
} from '@bogen/core';
import type { RunEnd } from './agents.ts';
import type { BogenServer } from './http/server.ts';
import { resolveImages } from './images.ts';
import { errorMessage, HttpError } from './util.ts';

/**
 * A designed edition of a brand book: a new file "<Brand> · Brand book" that links the brand, holds the generated book
 * as a reference page, and has an agent art-direct the guidelines as editable 1280x800 pages, with independent
 * an independent review (design_critique: one round by default, up to four when the person asks for a loop). The run is on the person's own plan,
 * with the agent and model they chose. The file records what the brand held, so the brand page can say what changed
 * since, and a refresh run can redo the pages that show those parts.
 *
 * Why: one template for every brand plateaued at about 7 of 10 with studio reviewers. What a studio adds is per brand:
 * applications from the brand's own world, fewer and fuller pages, and the brand's quirks on show.
 */

const ORIGIN = 'server:brand-edition';
export const EDITION_DISCIPLINE = 'brand-guidelines';
/**
 * The review an edition gets before the agent may call it done: one round by default, as each round is a reviewer
 * session on the person's plan; up to four when the person asks for a loop.
 */
export const EDITION_UNTIL = 7.5;
export const EDITION_ROUNDS = 1;
export const EDITION_MAX_ROUNDS = 4;
export function editionRounds(asked?: number): number {
  return Math.min(EDITION_MAX_ROUNDS, Math.max(1, Math.floor(asked ?? EDITION_ROUNDS)));
}
export const EDITION_PAGES = { min: 10, max: 14 } as const;
const BOOK_PAGE = 'Brand book';
const REFERENCE_PAGE = 'Generated book (reference)';
const COLUMNS = 4;

export interface EditionStart { runner: RunnerId; model?: string; effort?: string; by?: string; /** Review rounds, 1 by default. */ rounds?: number }
export interface EditionStarted { file_id: string; file_name: string; page_id: string; reference_page_id?: string; run_id?: string; conversation_id?: string; brief?: string }
export interface EditionStatus {
  file_id: string; file_name: string; page_id: string; at: number;
  /** The brand's parts as the edition shows them; a client compares them with the brand it has open. */
  parts: Record<EditionPart, string>;
  /** The parts that changed since, as the server reads the brand now. */
  changed: EditionPart[];
  running: boolean; run_id?: string;
  /** A refresh going on, or one that did not finish. */
  refreshing?: boolean;
}

/** What the reviewer is told the pages are, on top of its studio brief. */
export function editionPurpose(brandName: string): string {
  return `A studio brand guidelines book for "${brandName}", landscape pages in reading order. Judge it as brand guidelines from Pentagram, Koto or Collins: one argument across the book, one idea per page, layouts that fit their content, applications from this brand's own world, its quirks shown, nothing invented (missing facts left out or marked as open questions), and studio finish.`;
}

/** The purpose a review of an edition file gets, ahead of whatever the agent said: null for any other file. */
export function editionReviewPurpose(doc: BogenDoc, asked?: string): string | null {
  const record = readBrandEdition(doc);
  if (!record) return null;
  const own = editionPurpose(record.brandName || 'the brand');
  return asked?.trim() ? `${own} ${asked.trim()}`.slice(0, 600) : own;
}

/**
 * A review asked for from inside a run on an edition is the book's loop, whatever the call says: every page of the
 * book, the default reviewer (never the maker's model, never a cheaper one picked to pass), the target and the
 * rounds of an edition, and the run's own series, so that the rounds count up to the cap instead of starting over.
 */
export function editionLoop(doc: BogenDoc, runStartedAt: number): { pageId: string; series?: string; until: number; maxRounds: number } | null {
  const record = readBrandEdition(doc);
  if (!record || !doc.pages.has(record.pageId)) return null;
  const last = getCritiques(doc).filter((r) => r.pageId === record.pageId && r.at >= runStartedAt).at(-1);
  return { pageId: record.pageId, until: EDITION_UNTIL, maxRounds: editionRounds(record.rounds), ...(last ? { series: last.series } : {}) };
}

function newConversation(): string {
  return `c${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

/** A layer tree out of one document, as a spec another can insert. */
function specOf(doc: BogenDoc, id: string): NewNode {
  const spec = doc.toSpec(id);
  const children = doc.getChildren(id).map((c) => specOf(doc, c.id));
  if (children.length) spec.children = children;
  return spec;
}

/** The brief of the run that makes the edition. The working method is in the brand-guidelines skill the run gets. */
export function editionBrief(input: {
  brandId: string; brandName: string; fileId: string; pageId: string; referencePageId: string;
  reference: { id: string; name: string }[]; language: string | null; examples: number; assets: number; extra?: string; rounds?: number;
}): string {
  const rounds = editionRounds(input.rounds);
  const lang = input.language ? `${languageName(input.language)} (${input.language})` : null;
  return [
    `Art-direct a studio edition of the brand guidelines of "${input.brandName}" (brand_id ${input.brandId}) in this file: editable artboards of ${BRAND_BOOK_PAGE.width}x${BRAND_BOOK_PAGE.height}, landscape pages, the book Pentagram, Koto or Collins would hand this client. Not the generated template again: a book with one argument, fewer and fuller pages, applications from this brand's own world, and its quirks on show.`,
    '',
    'What is here:',
    `- Page "${BOOK_PAGE}" (page_id ${input.pageId}) is empty. The book goes there, nowhere else.`,
    `- Page "${REFERENCE_PAGE}" (page_id ${input.referencePageId}) holds the ${input.reference.length} pages Bogen generates from the brand's data, locked: ${input.reference.map((r) => `"${r.name}" ${r.id}`).join(', ')}. They are your reference for what the brand holds and its values, not a layout to copy: look at them with canvas_screenshot rather than reading their layers. Do not change, move or delete them.`,
    `- The file links the brand, so its tokens and fonts are here. The brand has ${input.examples} example artboard${input.examples === 1 ? '' : 's'} and ${input.assets} asset${input.assets === 1 ? '' : 's'}.`,
    '',
    'How:',
    `1. Read everything first: brand_get, brand_book_get and every chapter that has text, brand_asset_list, brand_example_get for each example, and design_knowledge action recipes discipline ${EDITION_DISCIPLINE} for the book's arc and applications by kind of business. Look at a few reference pages with canvas_screenshot (cover, colour, voice, applications).`,
    `2. Before drawing, write the direction in your reply: who reads this book and what they make with it; the book's idea in one sentence from the brand's world; the page list, ${EDITION_PAGES.min} to ${EDITION_PAGES.max} pages in order, each with its one claim as the headline you will set; the type and colour system taken from the brand; the brand's quirks you will show; and the applications you will draw, each with where it comes from (an example, an asset, a chapter, its site). If the brand holds little, make a shorter book; never pad it.`,
    `3. Build one artboard per page on page ${input.pageId}, ${BRAND_BOOK_PAGE.width}x${BRAND_BOOK_PAGE.height}, named "01 Cover", "02 …" in reading order, one html_write per page and a canvas_screenshot after each. Place logos with brand_asset_use; use the brand's tokens, families and colours only. Arrange the pages in reading order with canvas_plan_set: one section for the book, lanes for its acts.`,
    `4. Facts only from the brand, its chapters, assets and examples. Anything missing is left out, or set as a visible open question; never invent a value, claim, client, figure, licence or quote. A sample figure in an application mock is labelled sample. Do not change the brand itself (no brand_update or brand_book_update): the person decides what it holds.${lang ? ` Write the book in ${lang}, the brand's language.` : ''}`,
    rounds === 1
      ? `5. When every page is built and checked, call design_critique once with page_id ${input.pageId}, flow false, until ${EDITION_UNTIL} and max_rounds 1: a fresh reviewer, another model than you, judges the whole book as studio guidelines. It takes a few minutes; while it says state reviewing, call it again with the same arguments, which waits for the same review. Fix every objective defect it finds and the taste notes you agree with. Do not ask for another round: each is a session on the person's plan.`
      : `5. When every page is built and checked, call design_critique with page_id ${input.pageId}, flow false, until ${EDITION_UNTIL} and max_rounds ${rounds}. Each round a fresh reviewer, another model than you, judges the whole book as studio guidelines; while it says state reviewing, call it again with the same arguments. Fix every objective defect and the taste notes you agree with, then call it again with the series it returns. Bogen keeps it to one loop over every page. Stop when it says done, or after round ${rounds}.`,
    `6. After the last edit, design_verify each page with discipline ${EDITION_DISCIPLINE}.`,
    '7. Reply in a few sentences: the book\'s idea, its pages, the last review score and round, and the open questions the person should answer.',
    ...(input.extra?.trim() ? ['', `The person adds: ${input.extra.trim()}`] : []),
  ].join('\n');
}

/** The brief of a run that brings an edition up to date with what changed in the brand. */
export function refreshBrief(input: { brandId: string; brandName: string; pageId: string; changed: EditionPart[]; rounds?: number }): string {
  const names = input.changed.map((p) => EDITION_PART_NAMES[p]);
  return [
    `The brand "${input.brandName}" (brand_id ${input.brandId}) changed since this designed edition of its guidelines was made, in: ${names.join(', ')}.`,
    `Read those parts of the brand now with brand_get and brand_book_get, find the pages on page ${input.pageId} that show them, and bring those pages up to date in place: values, copy, applications and rules. Leave every other page as it is. Facts only from the brand; what is missing stays out or is marked as an open question.`,
    `Then call design_critique with page_id ${input.pageId}, flow false, until ${EDITION_UNTIL} and max_rounds ${editionRounds(input.rounds)} (while it says state reviewing, call it again with the same arguments), fix every objective defect, and design_verify each page you changed with discipline ${EDITION_DISCIPLINE}.`,
    'Reply in a few sentences: which pages changed, and the last review score.',
  ].join('\n');
}

export class BrandEditions {
  /** Brands whose edition is being made right now, so that two clicks make one file. */
  private making = new Set<string>();

  constructor(private readonly app: BogenServer) {}

  /** The newest designed edition of a brand, or null when it has none or its file is gone. */
  async status(brandId: string): Promise<EditionStatus | null> {
    const { room: brandRoom, data } = await this.app.brands.read(brandId);
    const fileId = brandEditionFileOf(brandRoom.doc);
    const entry = fileId ? this.app.storage.get(fileId) : undefined;
    if (!fileId || !entry || entry.kind === 'brand') return null;
    const room = await this.app.rooms.get(fileId);
    const record = readBrandEdition(room.doc);
    if (!record || record.brandId !== brandId) return null;
    const runId = this.app.runs.activeFor(fileId);
    return {
      file_id: fileId, file_name: entry.name, page_id: record.pageId, at: record.at, parts: record.parts, changed: changedEditionParts(record, data),
      running: Boolean(runId), ...(runId ? { run_id: runId } : {}), ...(record.pending && runId === record.pending.runId ? { refreshing: true } : {}),
    };
  }

  /**
   * Makes the edition's file and, with `start`, the run that designs it. Without `start` the file is ready and the
   * brief comes back, for an agent that does the work in its own session.
   */
  async create(brandId: string, opts: EditionStart & { start: boolean; extra?: string }): Promise<EditionStarted> {
    if (this.making.has(brandId)) throw new HttpError(429, 'This brand book is being set up already.');
    const before = await this.status(brandId);
    if (before?.running) throw new HttpError(409, 'An agent is working on this brand\'s designed edition already. Wait for it, or stop it.');
    this.making.add(brandId);
    try {
      return await this.make(brandId, opts);
    } finally {
      this.making.delete(brandId);
    }
  }

  private async make(brandId: string, opts: EditionStart & { start: boolean; extra?: string }): Promise<EditionStarted> {
    const app = this.app;
    const { entry: brandEntry, room: brandRoom, data } = await app.brands.read(brandId);
    const brandName = (data.fields.name || brandEntry.name).trim() || 'Brand';
    // The run is checked before anything is made: a CLI that is missing leaves no empty file behind.
    const choice = opts.start ? await this.choice(opts) : {};
    if (opts.start) {
      const refused = (await app.runs.runners()).find((r) => r.id === opts.runner);
      if (refused && !refused.available) throw new HttpError(409, refused.reason ?? `The ${opts.runner} CLI is not available on this computer.`);
    }
    const entry = app.createFile(`${brandName} · Brand book`);
    const origin = `person:${opts.by?.trim() || 'editor'}`;
    try {
      const book = await app.brands.sheetDoc(data, brandRoom.doc, 'pages');
      let specs: NewNode[];
      let faces;
      try {
        specs = book.pageIds.map((id) => specOf(book.doc, id));
        faces = getFontFaces(book.doc);
      } finally {
        book.doc.y.destroy();
      }
      // The examples come as pictures in data: addresses; stored as assets they do not weigh on the document.
      await resolveImages(app.storage, specs);
      await app.brands.link(entry.id, brandId, origin);
      const room = await app.rooms.get(entry.id);
      const { doc } = room;
      const reference: { id: string; name: string }[] = [];
      let pageId = '';
      let referencePageId = '';
      doc.transact(() => {
        doc.ensureFirstPage(BOOK_PAGE);
        pageId = doc.getPages()[0]!.id;
        doc.renamePage(pageId, BOOK_PAGE);
        referencePageId = doc.createPage(REFERENCE_PAGE);
        if (faces.length) addFontFaces(doc, faces);
        specs.forEach((spec, i) => {
          const left = (i % COLUMNS) * (BRAND_BOOK_PAGE.width + 80);
          const top = Math.floor(i / COLUMNS) * (BRAND_BOOK_PAGE.height + 120);
          const id = doc.insert(referencePageId, { ...spec, artboard: true, style: { ...spec.style, position: 'absolute', left: `${left}px`, top: `${top}px` } });
          doc.updateFields(id, { locked: true });
          reference.push({ id, name: doc.getNode(id)?.name ?? `Page ${i + 1}` });
        });
        doc.meta.set(PROJECT_META_KEY, { type: 'brand' });
      }, ORIGIN);
      const record: BrandEditionRecord = { brandId, brandName, at: Date.now(), parts: brandEditionParts(data), pageId, referencePageId, rounds: editionRounds(opts.rounds) };
      writeBrandEdition(doc, record, ORIGIN);
      const brief = editionBrief({
        brandId, brandName, fileId: entry.id, pageId, referencePageId, reference, language: brandLanguages(data).primary,
        examples: data.artboards.length, assets: data.assets.length, rounds: editionRounds(opts.rounds), ...(opts.extra ? { extra: opts.extra } : {}),
      });
      const out: EditionStarted = { file_id: entry.id, file_name: entry.name, page_id: pageId, reference_page_id: referencePageId };
      if (opts.start) {
        const conversationId = newConversation();
        const runId = await app.runs.start({
          fileId: entry.id, fileName: entry.name, pageId, nodeIds: [], prompt: brief, title: `Design the ${brandName} brand book`,
          runner: opts.runner, ...choice, intent: 'edit', discipline: EDITION_DISCIPLINE, conversationId, allowedFiles: [entry.id],
        });
        writeBrandEdition(doc, { ...record, runId }, ORIGIN);
        Object.assign(out, { run_id: runId, conversation_id: conversationId });
      } else {
        out.brief = brief;
      }
      setBrandEditionFile(brandRoom.doc, entry.id, ORIGIN);
      app.hub.broadcast({ t: 'brand', id: brandId });
      return out;
    } catch (e) {
      // Nothing half made stays: the file goes again, and the brand keeps pointing at its earlier edition.
      await app.deleteFile(entry.id).catch(() => undefined);
      throw e instanceof HttpError ? e : new HttpError(409, errorMessage(e));
    }
  }

  /** Starts a run that brings the pages showing the changed parts up to date. */
  async refresh(brandId: string, opts: EditionStart): Promise<{ file_id: string; run_id: string; conversation_id: string; changed: EditionPart[] }> {
    const status = await this.status(brandId);
    if (!status) throw new HttpError(404, 'This brand has no designed edition. Make one first.');
    if (status.running) throw new HttpError(409, 'An agent is working on this brand\'s designed edition already. Wait for it, or stop it.');
    if (!status.changed.length) throw new HttpError(400, 'Nothing in the brand changed since the edition was made.');
    const app = this.app;
    const { data, entry: brandEntry } = await app.brands.read(brandId);
    const room = await app.rooms.get(status.file_id);
    const record = readBrandEdition(room.doc)!;
    const brandName = (data.fields.name || brandEntry.name).trim() || 'Brand';
    const choice = await this.choice(opts);
    const conversationId = newConversation();
    const parts = brandEditionParts(data);
    let runId: string;
    try {
      runId = await app.runs.start({
        fileId: status.file_id, fileName: status.file_name, pageId: record.pageId, nodeIds: [], prompt: refreshBrief({ brandId, brandName, pageId: record.pageId, changed: status.changed, rounds: editionRounds(opts.rounds) }),
        title: `Refresh the ${brandName} brand book: ${status.changed.map((p) => EDITION_PART_NAMES[p]).join(', ')}`,
        runner: opts.runner, ...choice, intent: 'edit', discipline: EDITION_DISCIPLINE, conversationId, allowedFiles: [status.file_id],
      });
    } catch (e) {
      throw new HttpError(409, errorMessage(e));
    }
    writeBrandEdition(room.doc, { ...record, runId, rounds: editionRounds(opts.rounds), pending: { runId, parts, at: Date.now() } }, ORIGIN);
    app.hub.broadcast({ t: 'brand', id: brandId });
    return { file_id: status.file_id, run_id: runId, conversation_id: conversationId, changed: status.changed };
  }

  /** The model and effort the person chose for this agent, or the ones asked for here. */
  private async choice(opts: EditionStart) {
    try {
      return await this.app.runSettings.resolve(opts.runner, 'prompt', { ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}) });
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
  }

  /** A run on an edition ended: a refresh that finished counts, one that did not is forgotten. The brand page hears of it. */
  runEnded(end: RunEnd): void {
    const room = this.app.rooms.peek(end.fileId);
    const record = room ? readBrandEdition(room.doc) : null;
    if (!room || !record) return;
    if (record.pending?.runId === end.runId) {
      const { pending, ...rest } = record;
      writeBrandEdition(room.doc, end.status === 'done' ? { ...rest, parts: pending.parts, at: pending.at } : rest, ORIGIN);
    }
    this.app.hub.broadcast({ t: 'brand', id: record.brandId });
  }
}
