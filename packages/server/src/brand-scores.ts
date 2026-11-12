import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BogenDoc } from '@bogen/core';
import type { BrandReport, BrandViolation } from './brand-check.ts';
import { atomicWrite, errorMessage } from './util.ts';

/**
 * Brand scores over time, per brand, on this device: one entry each time a whole linked file is checked (by a person,
 * an agent, the end of a run or a drift check), and a summary each time all linked files are checked at once. Kept in
 * `brand-scores/<brandId>.json` in the data folder. Scores and counts only: no layer text, no names of people. It does
 * not sync, since each device checks with its own renderer and fonts.
 */

export interface ScorePoint { at: number; score: number; hard: number; soft: number; layers: number; by: string }
export interface SummaryPoint { at: number; score: number; files: number; hard: number; soft: number }
interface Book { files: Record<string, ScorePoint[]>; summary: SummaryPoint[] }

const KEY = /^[0-9a-z]{1,64}$/;
const MAX_POINTS = 200;
/** Checks of an unchanged file close together are one point, so that a person pressing Check again does not fill the history. */
const SAME_WITHIN_MS = 60_000;

export class ScoreHistory {
  private books = new Map<string, Promise<Book>>();
  private writes = new Map<string, Promise<void>>();

  constructor(private readonly home: string) {}

  private path(brandId: string): string {
    if (!KEY.test(brandId)) throw new Error('Not a brand id.');
    return join(this.home, 'brand-scores', `${brandId}.json`);
  }

  private book(brandId: string): Promise<Book> {
    let book = this.books.get(brandId);
    if (!book) {
      book = readFile(this.path(brandId), 'utf8').then((raw) => {
        const parsed = JSON.parse(raw) as Partial<Book>;
        const files: Record<string, ScorePoint[]> = {};
        for (const [id, list] of Object.entries(parsed.files ?? {})) if (KEY.test(id) && Array.isArray(list)) files[id] = list.filter((p) => p && typeof p.at === 'number' && typeof p.score === 'number').slice(-MAX_POINTS);
        return { files, summary: Array.isArray(parsed.summary) ? parsed.summary.filter((p) => p && typeof p.at === 'number' && typeof p.score === 'number').slice(-MAX_POINTS) : [] };
      }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') console.error(`bogen: brand scores of ${brandId} were unreadable, starting again: ${errorMessage(e)}`);
        return { files: {}, summary: [] };
      });
      this.books.set(brandId, book);
    }
    return book;
  }

  private save(brandId: string, book: Book): Promise<void> {
    const body = `${JSON.stringify(book)}\n`;
    const write = (this.writes.get(brandId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(dirname(this.path(brandId)), { recursive: true });
      await atomicWrite(this.path(brandId), body, 0o600);
    });
    this.writes.set(brandId, write);
    return write;
  }

  /** A whole-file check. Nothing drawn is no score, so it is not recorded. */
  async record(brandId: string, fileId: string, report: BrandReport, by: string, at = Date.now()): Promise<void> {
    if (report.score.nothing_checked || !KEY.test(fileId)) return;
    const book = await this.book(brandId);
    const list = book.files[fileId] ?? [];
    const point: ScorePoint = { at, score: report.score.value, hard: report.counts.hard, soft: report.counts.soft, layers: report.counts.layers, by: by.slice(0, 40) };
    const last = list.at(-1);
    if (last && at - last.at < SAME_WITHIN_MS && last.score === point.score && last.hard === point.hard && last.soft === point.soft) list[list.length - 1] = point;
    else list.push(point);
    book.files[fileId] = list.slice(-MAX_POINTS);
    await this.save(brandId, book);
  }

  async recordSummary(brandId: string, point: SummaryPoint): Promise<void> {
    const book = await this.book(brandId);
    book.summary = [...book.summary, point].slice(-MAX_POINTS);
    await this.save(brandId, book);
  }

  async read(brandId: string): Promise<Book> {
    const book = await this.book(brandId);
    return { files: Object.fromEntries(Object.entries(book.files).map(([id, list]) => [id, [...list]])), summary: [...book.summary] };
  }

  async forget(brandId: string, fileId: string): Promise<void> {
    const book = await this.book(brandId);
    if (!book.files[fileId]) return;
    delete book.files[fileId];
    await this.save(brandId, book);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()].map((w) => w.catch(() => {})));
  }
}

export interface WorstLayer { node_id: string; layer: string; page: string; hard: number; soft: number; rules: string[]; first: string }

/** The layers that break the brand most in one file, hard problems weighing three times a soft one. */
export function worstLayers(doc: BogenDoc, violations: BrandViolation[], limit = 5): WorstLayer[] {
  const by = new Map<string, BrandViolation[]>();
  for (const v of violations) if (v.node_id) by.set(v.node_id, [...(by.get(v.node_id) ?? []), v]);
  const pageName = (id: string) => {
    const page = doc.pageOf(id);
    return page ? doc.getPages().find((p) => p.id === page)?.name ?? '' : '';
  };
  return [...by].map(([id, list]) => {
    const hard = list.filter((v) => v.severity === 'hard').length;
    return { node_id: id, layer: list[0]!.layer, page: pageName(id), hard, soft: list.length - hard, rules: [...new Set(list.map((v) => v.rule))].slice(0, 6), first: (list.find((v) => v.severity === 'hard') ?? list[0]!).message };
  }).sort((a, b) => b.hard * 3 + b.soft - (a.hard * 3 + a.soft)).slice(0, limit);
}

/** How a series moved: the last value against the one before it and against the first. */
export function trendOf(points: { at: number; score: number }[]): { last: number; previous?: number; first?: number; change?: number; since?: number } | null {
  const last = points.at(-1);
  if (!last) return null;
  const previous = points.at(-2);
  return { last: last.score, ...(previous ? { previous: previous.score, change: last.score - previous.score, first: points[0]!.score, since: points[0]!.at } : {}) };
}
