import { randomBytes } from 'node:crypto';
import { contentLanguageOf, confirmed, type BogenDoc } from '@bogen/core';
import { critique, critiqueStatus, CRITIQUE_MISSING, type CritiqueOutcome, type CritiqueRequest, type CritiqueStepName, type ReviewerChoice, type ReviewerRun } from './design-critique.ts';
import { lintIssues } from './mcp/lint.ts';
import { editionReviewPurpose } from './brand-edition.ts';
import type { BogenServer } from './http/server.ts';
import type { Room } from './sync.ts';

export type CritiqueStep = CritiqueStepName | 'queued';
/**
 * A review as the editor follows it: the stage the server is really in, when each began, how many pictures are
 * rendered and, while the reviewer writes, how many findings it has written so far. Nothing here is estimated.
 */
export interface CritiqueJob {
  id: string;
  fileId: string;
  state: 'running' | 'done' | 'failed' | 'stopped';
  step?: CritiqueStep;
  /** When each stage began. */
  stepAt?: Partial<Record<CritiqueStep, number>>;
  reviewer?: string;
  screens: number;
  /** The artboards in the order the reviewer sees them. */
  screenIds: string[];
  /** Pictures rendered so far; each is at `/api/critique/<job>/screens/<n>`, 1-based. */
  rendered: number;
  /** Pictures' sizes in pixels, as rendered. */
  sizes: { width: number; height: number }[];
  /** Rule check findings handed to the reviewer. */
  ruleFindings?: number;
  /** Findings in the reviewer's answer so far, while it writes. */
  written?: { defects: number; taste: number };
  startedAt: number;
  endedAt?: number;
  recordId?: string;
  score?: number;
  defects?: number;
  next?: string;
  note?: string;
  error?: string;
}

export interface CritiqueOptions {
  screens?: string[];
  pageId?: string;
  flow?: boolean;
  reviewer?: ReviewerChoice;
  makerModel?: string;
  until?: number;
  maxRounds?: number;
  series?: string;
  purpose?: string;
  replyLanguage?: string;
}

/** The artboards a review covers: the ones named, or every artboard on the page in canvas order. */
export function critiqueScreens(doc: BogenDoc, opts: { screens?: string[]; pageId?: string }): string[] {
  if (opts.screens?.length) {
    // A layer inside an artboard stands for the artboard it sits in.
    const out: string[] = [];
    for (const id of opts.screens) {
      if (!doc.getNode(id)) throw new Error(`No layer with id ${id}.`);
      const board = [id, ...doc.ancestors(id)].find((a) => doc.getNode(a)?.artboard) ?? id;
      if (!out.includes(board)) out.push(board);
    }
    return out;
  }
  const pageId = opts.pageId ?? doc.getPages()[0]?.id;
  if (!pageId) throw new Error('The file has no page.');
  return doc.getChildren(pageId).filter((n) => n.artboard && !n.hidden).map((n) => n.id);
}

const KEEP_MS = 30 * 60_000;

/** Reviews queue in arrival order: one reviewer at a time per server on the person's plan. */
export class CritiqueJobs {
  private jobs = new Map<string, { job: CritiqueJob; cancel: { cancelled: boolean; run?: ReviewerRun }; done: Promise<CritiqueJob>; pictures: { mime: string; data: Buffer }[] }>();

  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly app: BogenServer, private readonly command?: string) {}

  status() { return critiqueStatus(this.command ?? 'claude'); }

  get(id: string): CritiqueJob | undefined { this.sweep(); return this.jobs.get(id)?.job; }
  /** A screen's picture, as the reviewer got it, while the job is kept. `n` is 1-based. */
  picture(id: string, n: number): { mime: string; data: Buffer } | undefined { return this.jobs.get(id)?.pictures[n - 1]; }
  wait(id: string): Promise<CritiqueJob> | undefined { return this.jobs.get(id)?.done; }
  cancel(id: string): void {
    const j = this.jobs.get(id);
    if (!j || j.job.state !== 'running') return;
    j.cancel.cancelled = true;
    if (j.job.step === 'queued') { j.job.state = 'stopped'; j.job.endedAt = Date.now(); }
    j.cancel.run?.cancel();
  }
  cancelAll(): void { for (const id of this.jobs.keys()) this.cancel(id); }

  async start(room: Room, opts: CritiqueOptions): Promise<CritiqueJob> {
    if ((await this.status()).state !== 'ready') throw new Error(CRITIQUE_MISSING);
    this.sweep();
    const doc = room.doc;
    const screens = critiqueScreens(doc, opts);
    if (!screens.length) throw new Error('There is no artboard to review on that page.');
    const job: CritiqueJob = { id: randomBytes(8).toString('hex'), fileId: room.id, state: 'running', step: 'queued', screens: screens.length, screenIds: screens, rendered: 0, sizes: [], startedAt: Date.now(), stepAt: {} };
    const pictures: { mime: string; data: Buffer }[] = [];
    const cancel: { cancelled: boolean; run?: ReviewerRun } = { cancelled: false };
    const done = this.queue.then(async () => {
      if (cancel.cancelled) throw new Error('Stopped.');
      const brand = await this.app.brands.forRoom(room).catch(() => null);
      if (cancel.cancelled) throw new Error('Stopped.');
      const avoid = brand?.data ? confirmed(brand.data.words).filter((w) => w.use === 'avoid').map((w) => ({ word: w.word, ...(w.instead ? { instead: w.instead } : {}) })) : [];
      const language = contentLanguageOf(doc) ?? (brand?.data?.fields.language || 'en');
      // Edition files always get the studio-guidelines brief, including while queued.
      const edition = editionReviewPurpose(doc, opts.purpose);
      const purpose = edition ?? opts.purpose;
      const req: CritiqueRequest = {
        doc, screens, ...(opts.pageId ? { pageId: opts.pageId } : {}), flow: opts.flow ?? (!edition && screens.length > 1),
        reviewer: opts.reviewer ?? 'auto', ...(opts.makerModel ? { makerModel: opts.makerModel } : {}),
        ...(opts.until !== undefined ? { until: opts.until } : {}), maxRounds: opts.maxRounds ?? 1,
        ...(opts.series ? { series: opts.series } : {}), ...(purpose ? { purpose } : {}),
        language, brand: brand?.data ?? null, ...(opts.replyLanguage ? { replyLanguage: opts.replyLanguage } : {}),
        onStep: (step, detail) => {
          if (job.step !== step) job.stepAt = { ...job.stepAt, [step]: Date.now() };
          job.step = step;
          if (detail) job.reviewer = detail;
          if (step === 'reviewer') delete job.written;
        },
        onPicture: (index, picture) => {
          pictures[index] = { mime: picture.mime, data: picture.data };
          job.sizes[index] = { width: picture.width, height: picture.height };
          job.rendered = pictures.filter(Boolean).length;
        },
        onWritten: (counts) => { job.written = counts; },
      };
      return critique(req, {
        renderer: this.app.renderer,
        lint: async (nodes, target) => {
          const fileName = this.app.storage.get(room.id)?.name;
          const issues = await lintIssues(doc, this.app.renderer, target, nodes, { avoid, ...(brand?.data ? { brand: brand.data, contentLanguage: language } : {}), ...(fileName ? { fileName } : {}) });
          job.ruleFindings = issues.filter((i) => i.severity === 'hard' || i.rule === 'consistency').length;
          return issues;
        },
        write: (change) => change(room.doc),
        ...(this.command ? { command: this.command } : {}),
      }, cancel);
    }).then((out: CritiqueOutcome) => {
      Object.assign(job, { state: 'done', recordId: out.record.id, score: out.record.score, defects: out.record.defects.length, next: out.next, reviewer: out.record.reviewer, ...(out.reviewerNote ? { note: out.reviewerNote } : {}) });
      return job;
    }, (e: Error) => {
      Object.assign(job, cancel.cancelled ? { state: 'stopped' } : { state: 'failed', error: e.message });
      return job;
    }).finally(() => { job.endedAt = Date.now(); });
    this.queue = done.then(() => {});
    this.jobs.set(job.id, { job, cancel, done, pictures });
    return job;
  }

  private shots = new Map<string, { at: number; made: Promise<{ mime: string; data: Buffer }> }>();
  /**
   * A small picture of one artboard for the results of a review whose own pictures are gone (it ended over half an
   * hour ago, or the server restarted). Kept two minutes, the last 48, so scrolling the results renders each once.
   */
  shot(room: Room, nodeId: string): Promise<{ mime: string; data: Buffer }> {
    if (!room.doc.getNode(nodeId)) return Promise.reject(new Error(`No layer with id ${nodeId}.`));
    const key = `${room.id}:${nodeId}`;
    const kept = this.shots.get(key);
    if (kept && Date.now() - kept.at < 120_000) return kept.made;
    const made = this.app.renderer.screenshot(room.doc, { nodeIds: [nodeId] }, { format: 'webp', scale: 1, quality: 75, maxDimension: 768 })
      .then((s) => ({ mime: s.mime, data: Buffer.from(s.bytes) }));
    made.catch(() => this.shots.delete(key));
    this.shots.delete(key);
    this.shots.set(key, { at: Date.now(), made });
    while (this.shots.size > 48) this.shots.delete(this.shots.keys().next().value!);
    return made;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.job.endedAt && now - j.job.endedAt > KEEP_MS) this.jobs.delete(id);
  }
}
