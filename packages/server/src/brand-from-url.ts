import { newId, readBrand, upsertBrandItem } from '@bogen/core';
import { applyExtraction, extractFromDoc, type Extraction } from './brand-extract.ts';
import type { BogenServer } from './http/server.ts';

/**
 * A brand from a website address, for a person on Home: the page is captured onto the brand's Reference page, read
 * for what it really uses, and everything goes into the brand as suggestions, which bind nobody until the person
 * confirms them in the review. Bogen does this itself, without an agent; brand_extract is the same for agents.
 *
 * It runs in the background as a job the editor asks about. A failure before anything was read removes the brand it
 * made for this, so nothing is left behind; a failure while reading keeps the capture and says what is missing.
 */

export type UrlJobState = 'running' | 'ready' | 'partial' | 'failed' | 'cancelled';
export type UrlJobStep = 'capture' | 'read' | 'save';
export interface UrlJob {
  id: string;
  url: string;
  brandId: string;
  brandName: string;
  /** The brand was made for this job, and goes again if the job fails or is cancelled. */
  madeBrand: boolean;
  state: UrlJobState;
  step: UrlJobStep;
  startedAt: number;
  endedAt?: number;
  found?: { colors: number; families: number; typeSteps: number; spacing: number; radius: number; logos: number; families_named: string[] };
  added?: number;
  notes: string[];
  error?: string;
}

const ORIGIN = 'person:editor';
const KEEP = 30 * 60_000;

export class BrandsFromUrl {
  private jobs = new Map<string, UrlJob & { cancel?: boolean }>();
  constructor(private readonly app: BogenServer) {}

  get(id: string): UrlJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const { cancel: _cancel, ...out } = job;
    return out;
  }

  async start(url: string, into?: string, allowLocal = false): Promise<UrlJob> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('That is not a website address.'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https addresses can be read.');
    const host = parsed.hostname.replace(/^www\./, '');
    let brandId = into;
    let madeBrand = false;
    if (brandId) this.app.brands.requireBrand(brandId);
    else {
      brandId = (await this.app.brands.create(host, 'editor')).id;
      madeBrand = true;
    }
    const entry = this.app.brands.requireBrand(brandId);
    const job: UrlJob & { cancel?: boolean } = { id: newId(), url: parsed.href, brandId, brandName: entry.name, madeBrand, state: 'running', step: 'capture', startedAt: Date.now(), notes: [] };
    this.jobs.set(job.id, job);
    for (const [id, old] of this.jobs) if (old.endedAt && Date.now() - old.endedAt > KEEP) this.jobs.delete(id);
    void this.run(job, allowLocal);
    return this.get(job.id)!;
  }

  cancel(id: string): UrlJob | undefined {
    const job = this.jobs.get(id);
    if (job && job.state === 'running') job.cancel = true;
    return this.get(id);
  }

  private async end(job: UrlJob & { cancel?: boolean }, state: UrlJobState, error?: string) {
    job.state = state;
    job.endedAt = Date.now();
    if (error) job.error = error;
    if ((state === 'failed' || state === 'cancelled') && job.madeBrand) {
      await this.app.brands.delete(job.brandId).catch(() => {});
    }
  }

  private async run(job: UrlJob & { cancel?: boolean }, allowLocal: boolean) {
    let placed: { nodeId: string; title: string };
    try {
      placed = await this.app.capturePageInto(job.brandId, { url: job.url, width: 1440, height: 900, allowLocal, pageName: 'Reference' }, ORIGIN);
    } catch (e) {
      return this.end(job, 'failed', (e as Error).message);
    }
    if (job.cancel) return this.end(job, 'cancelled');
    job.step = 'read';
    const room = await this.app.brands.room(job.brandId);
    const doc = room.doc;
    let extraction: Extraction;
    try {
      const node = doc.getNode(placed.nodeId)!;
      extraction = await extractFromDoc(doc, this.app.renderer, { nodeIds: [placed.nodeId] }, [node, ...doc.descendants(placed.nodeId)], `capture:${job.url}`);
    } catch (e) {
      // The capture stays: the person can look at it, retry, or bring the brand in another way.
      job.notes.push(`Reading the rendered page did not work: ${(e as Error).message}`);
      return this.end(job, 'partial');
    }
    if (job.cancel) return this.end(job, 'cancelled');
    job.step = 'save';
    const result = doc.transact(() => {
      upsertBrandItem(doc, 'artboards', { nodeId: placed.nodeId, name: placed.title || job.url, verdict: 'good', suggested: true, source: `capture:${job.url}` });
      return applyExtraction(doc, extraction, ORIGIN);
    }, ORIGIN);
    job.added = Object.values(result.added).reduce((s, n) => s + n, 0);
    job.found = {
      colors: extraction.colors.length, families: extraction.families.length, typeSteps: extraction.typeScale.length,
      spacing: extraction.spacing.length, radius: extraction.radius.length, logos: extraction.logos.length,
      families_named: extraction.families.map((f) => f.family).slice(0, 4),
    };
    job.notes.push(...extraction.notes);
    if (!extraction.logos.length) job.notes.push('No logo candidates were found on the page.');
    // A brand that came out with neither colours nor fonts is partial: say so rather than call it done.
    const data = readBrand(doc);
    await this.end(job, !data.colors.length || !data.families.length || !extraction.logos.length ? 'partial' : 'ready');
  }
}
